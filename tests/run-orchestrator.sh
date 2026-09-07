#!/usr/bin/env bash
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd -P)
orch="$repo/engine/orchestrator.sh"
mock="$repo/hosts/mock/provider.sh"
n=0
ok(){ n=$((n+1)); echo "ok $n - $1"; }
bad(){ echo "not ok - $1" >&2; exit 1; }
fails(){ name=$1; shift; if "$@" >/dev/null 2>&1; then bad "$name unexpectedly passed"; fi; ok "$name"; }

fixture(){
  d=$(mktemp -d "${TMPDIR:-/tmp}/loop-orch-fixture.XXXXXX")
  cp -R "$repo/tests/fixtures/python-cli/." "$d/"
  chmod +x "$d"/tests/*.sh
  mkdir -p "$d/.loop/work-items" "$d/.loop/evidence"
  # The published fixture adapter declares only a VALIDATE command and no
  # MOCK_SCRIPT passthrough; the orchestrator needs an EXECUTE verifier and the
  # mock needs its script name inside the minimal environment.
  jq '.commands += [(.commands[0]|.id="build-check"|.phase="EXECUTE")] | .environment.allow_names += ["MOCK_SCRIPT","MOCK_DUMP"]' \
    "$repo/examples/adapters/python-cli.json" > "$d/.loop/project.adapter.json"
  cp "$d/.loop/project.adapter.json" "$d/project.adapter.json"
  cp "$repo/template/.loop/workflow.json" "$d/.loop/workflow.json"
  jq '.work_item_id="TEST-1"|.run_status="PAUSED"|.max_rounds=40|.max_gate_failures=3|.max_wall_seconds=600' \
    "$repo/template/.loop/state.example.json" > "$d/.loop/state.json"
  cp "$repo/template/work-items/WI-001-template.md" "$d/.loop/work-items/TEST-1.md"
  (cd "$d" && git init -q && git add -A && git -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm initial)
  echo "$d"
}
script(){ printf '%s\n' "$2" > "$1/mock.json"; echo "$1/mock.json"; }
st(){ jq -r "$2" "$1/.loop/state.json"; }

d=$(fixture); rm "$d/.loop/state.json"
fails 'start refuses a missing state file' "$orch" start --root "$d"

d=$(fixture); jq '.run_status="RUNNING"|.started_epoch=1' "$d/.loop/state.json" > "$d/s"; mv "$d/s" "$d/.loop/state.json"
fails 'start refuses a run that is not PAUSED' "$orch" start --root "$d"

d=$(fixture); "$orch" start --root "$d" >/dev/null
MOCK_SCRIPT= "$orch" loop --root "$d" --host mock --provider "$mock" --max-nodes 10 >/dev/null
[ "$(st "$d" .run_status)" = WAITING_FOR_HUMAN ] || bad "happy path status $(st "$d" .run_status)"
[ "$(st "$d" .phase)" = HANDOVER ] || bad "happy path phase $(st "$d" .phase)"
jq -e '[.gates[].status]|all(.=="PASSED")' "$d/.loop/state.json" >/dev/null || bad 'not every gate passed'
rid=$(st "$d" '.gates.REVIEW.evidence_ids[0]')
jq -e '.evidence_type=="independent-review" and .producer=="reference-engine" and .result=="PASSED"' "$d/.loop/evidence/$rid.json" >/dev/null || bad 'review evidence missing'
cid=$(st "$d" '[.gates.EXECUTE.evidence_ids[]|select(endswith("-build-check"))][0]')
jq -e '.evidence_type=="command" and (.details.stdout_sha256|test("^[0-9a-f]{64}$"))' "$d/.loop/evidence/$cid.json" >/dev/null || bad 'execute command evidence missing'
ok 'happy path reaches HANDOVER with six passed gates and engine-owned evidence'
[ "$(st "$d" .round)" -eq 7 ] || bad "expected 7 rounds for two slices, got $(st "$d" .round)"
[ -f "$d/tests/notes.txt" ] || bad 'slice 2 did not run'
[ "$(st "$d" .step)" = slice-2 ] || bad "step should record the last slice, got $(st "$d" .step)"
ok 'two execution slices run in order with per-slice path policy (backticks stripped)'

d=$(fixture); "$orch" start --root "$d" >/dev/null
MOCK_SCRIPT=$(script "$d" '{"REVIEW":"fail:artifact"}') "$orch" loop --root "$d" --host mock --provider "$mock" --max-nodes 5 >/dev/null
[ "$(st "$d" .phase)" = EXECUTE ] || bad "review rework phase $(st "$d" .phase)"
[ "$(st "$d" .gate_failures_here)" = 1 ] || bad 'gate failure not counted'
[ "$(st "$d" '.gates.REVIEW.status')" = FAILED ] || bad 'review gate not FAILED'
ok 'failed independent review routes an artifact defect back to EXECUTE'

d=$(fixture); "$orch" start --root "$d" >/dev/null
MOCK_SCRIPT= "$orch" loop --root "$d" --host mock --provider "$mock" --max-nodes 4 >/dev/null
[ "$(st "$d" .phase)" = REVIEW ] || bad 'invalid-verdict fixture did not reach REVIEW'
bad_review=$(mktemp "${TMPDIR:-/tmp}/loop-bad-review.XXXXXX")
cat > "$bad_review" <<'EOF'
#!/usr/bin/env bash
brief=$(mktemp); cat > "$brief"
jq -n --slurpfile b "$brief" '$b[0] as $x|{schema_version:1,verdict_id:"bad-review",run_id:$x.run_id,work_item_id:$x.work_item_id,phase:"REVIEW",gate_id:"REVIEW",nonce:"0000000000000000000000000000000000000000000000000000000000000000",result:"PASS",reviewer:"fixture",independent:true,revision:$x.revision,captured_at:"2026-09-06T00:00:00Z",evidence_refs:$x.evidence_refs,findings:[]}'
EOF
chmod +x "$bad_review"
set +e; "$orch" run --root "$d" --host mock --provider "$mock" --review-host test --review-provider "$bad_review" >/dev/null 2>&1; rc=$?; set -e
[ "$rc" -eq 1 ] || bad "invalid verdict returned $rc"
review_run="run-TEST-1-$(st "$d" .round)-review"
grep -q 'verdict challenge mismatch' "$d/.loop/evidence/$review_run/logs/provider.stderr" || bad 'post-provider verdict error was absent from persisted stderr'
ok 'review evidence persists validator stderr appended after provider exit'

d=$(fixture); "$orch" start --root "$d" >/dev/null
s=$(script "$d" '{"DESIGN":"block"}')
set +e; MOCK_SCRIPT=$s "$orch" loop --root "$d" --host mock --provider "$mock" --max-nodes 5 >/dev/null; rc=$?; set -e
[ "$rc" -ne 0 ] || bad 'blocked loop returned zero'
[ "$(st "$d" .run_status)" = BLOCKED ] || bad "blocked status $(st "$d" .run_status)"
[ "$(grep -c -- '- \[ \]' "$d/.loop/blockers.md")" = 1 ] || bad 'expected exactly one open blocker'
fails 'resume refuses while a blocker is open' "$orch" resume --root "$d"
sed 's/- \[ \]/- [x]/' "$d/.loop/blockers.md" > "$d/b.md"; mv "$d/b.md" "$d/.loop/blockers.md"
"$orch" resume --root "$d" >/dev/null
[ "$(st "$d" .run_status)" = RUNNING ] && [ "$(st "$d" .phase)" = DESIGN ] || bad 'resume did not restore DESIGN'
ok 'a blocked decision stops the loop and resume needs a resolved blocker'

d=$(fixture); "$orch" start --root "$d" >/dev/null
s=$(script "$d" '{"EXECUTE":"touch-frozen"}')
set +e; MOCK_SCRIPT=$s "$orch" loop --root "$d" --host mock --provider "$mock" --max-nodes 3 >/dev/null; rc=$?; set -e
[ "$rc" -ne 0 ] || bad 'frozen path run returned zero'
[ "$(st "$d" .run_status)" = BLOCKED ] || bad "frozen path status $(st "$d" .run_status)"
ok 'a frozen path change fails the EXECUTE gate and blocks'

d=$(fixture); "$orch" start --root "$d" >/dev/null; mkdir -p "$d/.loop/engine.lock"
fails 'run refuses while the engine lock is held' "$orch" run --root "$d" --host mock --provider "$mock"
set +e; "$orch" run --root "$d" --host mock --provider "$mock" >/dev/null 2>&1; rc=$?; set -e
[ "$rc" -eq 73 ] || bad "expected exit 73, got $rc"
rmdir "$d/.loop/engine.lock"
ok 'the engine lock is reported with exit 73'

d=$(fixture); "$orch" start --root "$d" >/dev/null
s=$(script "$d" '{"EXECUTE":"fail"}')
set +e; MOCK_SCRIPT=$s "$orch" loop --root "$d" --host mock --provider "$mock" --max-nodes 3 >/dev/null; rc=$?; set -e
[ "$rc" -ne 0 ] || bad 'failing verifier returned zero'
[ "$(st "$d" .run_status)" = BLOCKED ] || bad "failing verifier status $(st "$d" .run_status)"
ok 'a failing verifier command blocks instead of advancing'

d=$(fixture); "$orch" start --root "$d" >/dev/null; mkdir -p "$d/.loop/orchestrator.lock"
set +e; "$orch" run --root "$d" --host mock --provider "$mock" >/dev/null 2>&1; rc=$?; set -e
[ "$rc" -eq 73 ] || bad "expected orchestrator lock exit 73, got $rc"; rmdir "$d/.loop/orchestrator.lock"
ok 'a second orchestrator run is refused while one is active'

d=$(fixture); "$orch" start --root "$d" >/dev/null
set +e; "$orch" loop --root "$d" --host mock --provider "$d/does-not-exist" --max-nodes 3 >/dev/null 2>&1; rc=$?; set -e
[ "$rc" -eq 69 ] || bad "loop should propagate the fatal exit 69, got $rc"
[ "$(st "$d" .run_status)" = RUNNING ] || bad 'fatal run must not change state'
ok 'loop propagates a fatal run failure instead of retrying'

d=$(fixture); "$orch" start --root "$d" >/dev/null
s=$(script "$d" '{"EXECUTE":"add-file"}')
review_dump=$(mktemp "${TMPDIR:-/tmp}/loop-review-brief.XXXXXX")
MOCK_SCRIPT=$s "$orch" loop --root "$d" --host mock --provider "$mock" --max-nodes 4 >/dev/null
[ "$(st "$d" .phase)" = REVIEW ] || bad 'review-diff fixture did not reach REVIEW'
git -C "$d" add src/greet.py
git -C "$d" diff --cached --quiet -- src/greet.py && bad 'review-diff fixture has no staged change'
printf '# unstaged tracked detail\n' >> "$d/src/greet.py"
MOCK_SCRIPT=$s MOCK_DUMP="$review_dump" "$orch" run --root "$d" --host mock --provider "$mock" >/dev/null
[ "$(st "$d" .phase)" = VALIDATE ] || bad "expected VALIDATE after review, got $(st "$d" .phase)"
grep -q 'src/extra_module.py' "$review_dump" || bad 'review brief does not show the untracked new file'
jq -e '.prompt|contains("Hello, {name}")' "$review_dump" >/dev/null || bad 'review brief does not show the tracked diff'
jq -e '.prompt|contains("unstaged tracked detail")' "$review_dump" >/dev/null || bad 'review brief does not show the unstaged tracked diff'
ok 'the review brief contains staged, unstaged, and untracked changes from the target cwd'

d=$(fixture); "$orch" start --root "$d" >/dev/null
calls=$(mktemp "${TMPDIR:-/tmp}/loop-review-calls.XXXXXX")
review_wrapper=$(mktemp "${TMPDIR:-/tmp}/loop-review-wrapper.XXXXXX")
printf '%s\n' '#!/usr/bin/env bash' "echo \"REVIEW-WRAPPER \$LOOP_PHASE\" >> \"$calls\"" "exec \"$mock\"" > "$review_wrapper"
chmod +x "$review_wrapper"
s=$(script "$d" '{"VALIDATE":"block"}')
if MOCK_SCRIPT=$s MOCK_DUMP="$review_dump" "$orch" loop --root "$d" --host mock --provider "$mock" --review-host mock --review-provider "$review_wrapper" --max-nodes 6 >/dev/null; then bad 'VALIDATE did not stop the review-provider test'; fi
[ "$(wc -l < "$calls" | tr -d ' ')" = 1 ] || bad 'review provider was not called exactly once'
[ "$(cat "$calls")" = 'REVIEW-WRAPPER REVIEW' ] || bad 'review provider was called outside REVIEW'
[ "$(st "$d" .phase)" = VALIDATE ] || bad "expected VALIDATE after review, got $(st "$d" .phase)"
[ "$(st "$d" '.gates.REVIEW.status')" = PASSED ] || bad 'review did not pass'
ok 'loop uses the separate review provider only for REVIEW'

echo "1..$n"
