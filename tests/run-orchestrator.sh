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
note="$d/.loop/notes/next-steps.md"
[ -f "$note" ] || bad 'handover did not write the next-steps note'
grep -q 'TEST-1' "$note" || bad 'the next-steps note does not name the work item'
grep -q 'Advisory only, never an approval' "$note" || bad 'the next-steps note does not say it is advisory'
grep -q '^## Priorities$' "$note" || bad 'the next-steps note has no priorities'
ok 'handover writes the advisory next-steps note for the work item'
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
set +e; MOCK_SCRIPT=$(script "$d" '{"REVIEW":"fail:safety"}') "$orch" loop --root "$d" --host mock --provider "$mock" --max-nodes 5 >/dev/null 2>"$d/stderr.txt"; set -e
grep -q 'illegal rework transition' "$d/stderr.txt" && bad 'an unknown review category stopped the engine'
[ "$(st "$d" .phase)" = EXECUTE ] || bad "unknown-category rework phase $(st "$d" .phase)"
[ "$(st "$d" '.gates.REVIEW.status')" = FAILED ] || bad 'review gate not FAILED for an unknown category'
ok 'a review finding with an unknown category goes back to EXECUTE instead of stopping the engine'

d=$(fixture); "$orch" start --root "$d" >/dev/null
dd="$(mktemp -d "${TMPDIR:-/tmp}/loop-design-dump.XXXXXX")/brief.json"; s=$(script "$d" '{"DESIGN":"block"}')
set +e; MOCK_SCRIPT=$s MOCK_DUMP="$dd" "$orch" loop --root "$d" --host mock --provider "$mock" --max-nodes 2 >/dev/null; set -e
jq -e '.task|test("fix after that test")' "$dd.DESIGN" >/dev/null || bad 'the DESIGN brief does not ask for repair paths in human-test slices'
ok 'the DESIGN brief asks human-test slices to allow the paths a repair needs'

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
grep -q 'gate failed (artifact): path check failed: .*requirements/frozen.md' "$d/.loop/blockers.md" || bad 'the blocker does not name the path that failed the check'
jq -e -s 'map(select(.phase=="EXECUTE" and .result=="FAILED" and ((.details.observation // "")|test("path check failed: .*requirements/frozen.md"))))|length>=1' \
  "$d"/.loop/evidence/*.json >/dev/null || bad 'no EXECUTE evidence records why the path check failed'
ok 'a failed path check names the path and the rule in the blocker and the evidence'

d=$(fixture); "$orch" start --root "$d" >/dev/null
s=$(script "$d" '{"EXECUTE":"many-out-of-scope"}')
set +e; MOCK_SCRIPT=$s "$orch" loop --root "$d" --host mock --provider "$mock" --max-nodes 3 >/dev/null; rc=$?; set -e
[ "$rc" -ne 0 ] || bad 'many-out-of-scope run returned zero'
[ "$(st "$d" .run_status)" = BLOCKED ] || bad "many-out-of-scope status $(st "$d" .run_status)"
ok 'seven out-of-scope paths still fail the EXECUTE gate and block'
# Regression: with more than 5 reasons, `head -5` used to close the pipe early
# and the resulting SIGPIPE from `printf`, combined with `pipefail`, aborted
# reference-engine.sh under `set -e` before it could record any reason at all.
grep -q 'gate failed (artifact): path check failed: .*scratch/file1.txt' "$d/.loop/blockers.md" || bad 'the blocker lost the path-check reasons with more than 5 violations'
grep -q 'and 2 more' "$d/.loop/blockers.md" || bad 'the blocker does not say how many further reasons were omitted'
jq -e -s 'map(select(.phase=="EXECUTE" and .result=="FAILED" and ((.details.observation // "")|test("path check failed: .*scratch/file1.txt.*and 2 more"))))|length>=1' \
  "$d"/.loop/evidence/*.json >/dev/null || bad 'EXECUTE evidence lost the path-check reasons with more than 5 violations'
ok 'more than 5 path-check reasons still reach the blocker and the evidence intact'

d=$(fixture); "$orch" start --root "$d" >/dev/null
s=$(script "$d" '{"DESIGN":"prose-table"}')
set +e; MOCK_SCRIPT=$s "$orch" loop --root "$d" --host mock --provider "$mock" --max-nodes 3 >/dev/null; rc=$?; set -e
[ "$rc" -ne 0 ] || bad 'a prose slice table did not stop the loop'
[ "$(st "$d" .phase)" = DESIGN ] || bad "prose slice table phase $(st "$d" .phase)"
grep -q "columns 2 and 3 must be 'Allowed paths' and 'Frozen paths'" "$d/.loop/blockers.md" || bad 'no blocker explains the slice table layout'
ok 'a slice table without path columns fails the DESIGN gate with the expected layout'

d=$(fixture); "$orch" start --root "$d" >/dev/null
design_dump="$(mktemp -d "${TMPDIR:-/tmp}/loop-design-dump.XXXXXX")/brief.json"; s=$(script "$d" '{"DESIGN":"block"}')
set +e; MOCK_SCRIPT=$s MOCK_DUMP="$design_dump" "$orch" loop --root "$d" --host mock --provider "$mock" --max-nodes 2 >/dev/null; set -e
jq -e '.task|test("\\| Slice \\| Allowed paths \\| Frozen paths \\| Verifier IDs \\| Proof \\|")' "$design_dump.DESIGN" >/dev/null || bad 'the DESIGN brief does not state the slice table layout'
ok 'the DESIGN brief states the exact slice table layout'

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

# ---- the authorization is an outer boundary on paths ----
authorize(){ # dir item scope-json
  jq -n --arg id "$2" --arg f "$(date -u -d '+1 hour' '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date -u -v+1H '+%Y-%m-%dT%H:%M:%SZ')" --argjson paths "$3" \
    '{schema_version:1,item_id:$id,state:"READY",scope:{allowed_paths:$paths},budget:{max_rounds:40,max_wall_seconds:600},
      expires_at:$f,stop_on_first_failure:true,authorized_by:"interactive-tty",authorized_at:"2026-01-01T00:00:00Z"}' \
    > "$1/.loop/work-items/$2.authorization.json"
}

d=$(fixture); authorize "$d" TEST-1 '["docs/**"]'; "$orch" start --root "$d" >/dev/null
set +e; MOCK_SCRIPT= "$orch" loop --root "$d" --host mock --provider "$mock" --max-nodes 3 >/dev/null; rc=$?; set -e
[ "$rc" -ne 0 ] || bad 'a slice outside the authorized scope did not stop the loop'
[ "$(st "$d" .run_status)" = BLOCKED ] || bad "out-of-scope slice status $(st "$d" .run_status)"
[ "$(st "$d" .phase)" = DESIGN ] || bad "out-of-scope slice phase $(st "$d" .phase)"
grep -q 'slice path outside authorized scope' "$d/.loop/blockers.md" || bad 'no blocker names the out-of-scope slice'
jq -e -s 'map(select(.phase=="DESIGN" and .result=="FAILED" and .producer=="orchestrator" and (.details.observation|test("slice path outside authorized scope"))))|length>=1' \
  "$d"/.loop/evidence/*-orchestrator.json >/dev/null || bad 'no DESIGN evidence records the out-of-scope slice'
ok 'a slice outside the authorized scope fails the DESIGN gate'

d=$(fixture); "$orch" start --root "$d" >/dev/null
s=$(script "$d" '{"EXECUTE":"add-file"}')
MOCK_SCRIPT=$s "$orch" loop --root "$d" --host mock --provider "$mock" --max-nodes 2 >/dev/null
[ "$(st "$d" .phase)" = EXECUTE ] || bad "scope fixture did not reach EXECUTE, got $(st "$d" .phase)"
authorize "$d" TEST-1 '["src/greet.py"]'
set +e; MOCK_SCRIPT=$s "$orch" run --root "$d" --host mock --provider "$mock" >/dev/null; rc=$?; set -e
[ "$rc" -ne 0 ] || bad 'a changed file outside the authorized scope did not block'
[ "$(st "$d" .run_status)" = BLOCKED ] || bad "out-of-scope change status $(st "$d" .run_status)"
grep -q 'changed path outside authorized scope: src/extra_module.py' "$d/.loop/blockers.md" || bad 'no blocker names the out-of-scope change'
jq -e -s 'map(select(.result=="FAILED" and .producer=="orchestrator" and (.details.observation|test("Changed path outside authorized scope"))))|length>=1' \
  "$d"/.loop/evidence/*-scope.json >/dev/null || bad 'no evidence records the out-of-scope change'
ok 'a changed file outside the authorized scope blocks the run with evidence'

# ---- both interfaces apply the same authorization rules ----
d=$(fixture)
future=$(date -u -d '+1 hour' '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date -u -v+1H '+%Y-%m-%dT%H:%M:%SZ')
for id in WI-100 WI-101 WI-102; do cp "$repo/template/work-items/WI-001-template.md" "$d/.loop/work-items/$id.md"; done
jq -n '{schema_version:1,items:[{id:"WI-100",title:"Expired",added_at:"2026-01-01T00:00:00Z",work_kind:"feature"},
  {id:"WI-101",title:"Live",added_at:"2026-01-01T00:00:00Z",work_kind:"feature"},
  {id:"WI-102",title:"Unparseable expiry",added_at:"2026-01-01T00:00:00Z",work_kind:"feature"}]}' > "$d/.loop/backlog.json"
authorize "$d" WI-101 '["src/**"]'
jq '.item_id="WI-100"|.expires_at="2000-01-01T00:00:00Z"' "$d/.loop/work-items/WI-101.authorization.json" > "$d/.loop/work-items/WI-100.authorization.json"
jq '.item_id="WI-102"|.expires_at="whenever"' "$d/.loop/work-items/WI-101.authorization.json" > "$d/.loop/work-items/WI-102.authorization.json"
shell_counts=$("$orch" status --root "$d" | jq -c '{ready:.backlog.ready,paused:.backlog.paused}')
node_counts=$(node "$repo/bin/build-loop.mjs" backlog_list --root "$d" | jq -c '{ready:.backlog.ready,paused:.backlog.paused}')
[ "$shell_counts" = '{"ready":1,"paused":2}' ] || bad "shell backlog counts $shell_counts"
[ "$shell_counts" = "$node_counts" ] || bad "shell $shell_counts and node $node_counts disagree about expired authorizations"
ok 'the shell and the control layer count an expired or unusable authorization the same way'

# ---- both interfaces accept and reject the same timestamps, budgets and channels ----
d=$(fixture)
cp "$repo/template/work-items/WI-001-template.md" "$d/.loop/work-items/WI-200.md"
cp "$repo/template/work-items/WI-001-template.md" "$d/.loop/work-items/WI-201.md"
cp "$repo/template/work-items/WI-001-template.md" "$d/.loop/work-items/WI-202.md"
cp "$repo/template/work-items/WI-001-template.md" "$d/.loop/work-items/WI-203.md"
cp "$repo/template/work-items/WI-001-template.md" "$d/.loop/work-items/WI-204.md"
jq -n '{schema_version:1,items:[{id:"WI-200",title:"Fractional Z",added_at:"2026-01-01T00:00:00Z",work_kind:"feature"},
  {id:"WI-201",title:"Positive offset",added_at:"2026-01-01T00:00:00Z",work_kind:"feature"},
  {id:"WI-202",title:"Negative offset in the past",added_at:"2026-01-01T00:00:00Z",work_kind:"feature"},
  {id:"WI-203",title:"Impossible date",added_at:"2026-01-01T00:00:00Z",work_kind:"feature"},
  {id:"WI-204",title:"Budget out of range",added_at:"2026-01-01T00:00:00Z",work_kind:"feature"}]}' > "$d/.loop/backlog.json"
sidecar(){ # id expires_at [jq-filter]
  jq -n --arg id "$1" --arg e "$2" \
    '{schema_version:1,item_id:$id,state:"READY",scope:{allowed_paths:["src/**"]},budget:{max_rounds:40,max_wall_seconds:600},
      expires_at:$e,stop_on_first_failure:true,authorized_by:"interactive-tty",assurance:"local-user-action",authorized_at:"2026-01-01T00:00:00.500Z"}' |
    jq "${3:-.}" > "$d/.loop/work-items/$1.authorization.json"
}
# A fraction of a second and a real numeric offset are valid RFC 3339 and Node
# accepts both; the shell has to agree, in the future and in the past.
future_frac=$(date -u -d '+1 hour' '+%Y-%m-%dT%H:%M:%S.250Z' 2>/dev/null || date -u -v+1H '+%Y-%m-%dT%H:%M:%S.250Z')
future_offset=$(date -u -d '+3 hour' '+%Y-%m-%dT%H:%M:%S+02:00' 2>/dev/null || date -u -v+3H '+%Y-%m-%dT%H:%M:%S+02:00')
sidecar WI-200 "$future_frac"
sidecar WI-201 "$future_offset"
sidecar WI-202 '2020-06-01T12:00:00.125-07:00'
sidecar WI-203 '2026-02-30T00:00:00Z'
sidecar WI-204 "$future_frac" '.budget.max_wall_seconds=5'
shell_counts=$("$orch" status --root "$d" | jq -c '{ready:.backlog.ready,paused:.backlog.paused}')
node_counts=$(node "$repo/bin/build-loop.mjs" backlog_list --root "$d" | jq -c '{ready:.backlog.ready,paused:.backlog.paused}')
[ "$shell_counts" = '{"ready":2,"paused":3}' ] || bad "shell timestamp counts $shell_counts"
[ "$shell_counts" = "$node_counts" ] || bad "shell $shell_counts and node $node_counts disagree about fractional or offset timestamps"
# An unknown decision channel is not a human channel in either interface.
sidecar WI-200 "$future_frac" '.authorized_by="robot"'
shell_counts=$("$orch" status --root "$d" | jq -c '{ready:.backlog.ready,paused:.backlog.paused}')
node_counts=$(node "$repo/bin/build-loop.mjs" backlog_list --root "$d" | jq -c '{ready:.backlog.ready,paused:.backlog.paused}')
[ "$shell_counts" = '{"ready":1,"paused":4}' ] || bad "shell channel counts $shell_counts"
[ "$shell_counts" = "$node_counts" ] || bad "shell $shell_counts and node $node_counts disagree about the decision channel"
ok 'both interfaces accept fractional and offset timestamps and reject the same budgets and channels'

# ---- the authorized budget is a cap the orchestrator itself enforces ----
# The person agreed to a budget, so that budget bounds the run wherever it is
# started. The caps can only ever move down: a wider decision never widens a run.
d=$(fixture); authorize "$d" TEST-1 '[".loop/work-items/**","src/**","tests/**"]'
jq '.budget.max_rounds=2|.budget.max_wall_seconds=120' "$d/.loop/work-items/TEST-1.authorization.json" > "$d/a"
mv "$d/a" "$d/.loop/work-items/TEST-1.authorization.json"
"$orch" start --root "$d" >/dev/null
[ "$(st "$d" .max_rounds)" -eq 2 ] || bad "start did not apply the authorized round cap, got $(st "$d" .max_rounds)"
[ "$(st "$d" .max_wall_seconds)" -eq 120 ] || bad "start did not apply the authorized wall cap, got $(st "$d" .max_wall_seconds)"
[ "$(st "$d" .round)" -eq 0 ] || bad 'the authorized budget rewrote the rounds already used'
# A decision that allows more than the run records leaves the run where it is.
jq '.budget.max_rounds=500|.budget.max_wall_seconds=604800' "$d/.loop/work-items/TEST-1.authorization.json" > "$d/a"
mv "$d/a" "$d/.loop/work-items/TEST-1.authorization.json"
set +e; MOCK_SCRIPT= "$orch" loop --root "$d" --host mock --provider "$mock" --max-nodes 6 >/dev/null; rc=$?; set -e
[ "$rc" -ne 0 ] || bad 'the authorized round cap did not stop the loop'
[ "$(st "$d" .max_rounds)" -eq 2 ] || bad "a wider authorization widened the run to $(st "$d" .max_rounds)"
[ "$(st "$d" .run_status)" = BLOCKED ] || bad "authorized cap status $(st "$d" .run_status)"
grep -q 'round cap reached' "$d/.loop/blockers.md" || bad 'no blocker names the round cap'
ok 'the authorized budget caps the run and a wider decision never widens it'

# ---- the shared authorization fixtures read the same way in both layers ----
# tests/fixtures/authorization holds one record per case plus expected.json, and
# tests/backlog.test.mjs reads exactly the same files. A record only one of the
# two layers accepts is a hole somebody can drive an unauthorized run through.
fixtures="$repo/tests/fixtures/authorization"
# An expiry written as @+SECONDS or @-SECONDS (with an optional fraction) becomes
# that many seconds from now, so a decision meant to be live is live.
resolve_stamp(){
  perl -e '
    my $v = $ARGV[0];
    if ($v =~ /^\@([+-])(\d+)(?:\.(\d+))?$/) {
      my @g = gmtime(time() + ($1 eq "-" ? -$2 : $2));
      printf "%04d-%02d-%02dT%02d:%02d:%02d%sZ", $g[5]+1900, $g[4]+1, $g[3], $g[2], $g[1], $g[0], (defined $3 ? ".$3" : "");
    } else { print $v; }
  ' -- "$1"
}
d=$(fixture)
cases=$(jq -r '.cases[] | [.case, .expected] | @tsv' "$fixtures/expected.json")
while IFS="$(printf '\t')" read -r case expected; do
  [ -n "$case" ] || continue
  cp "$repo/template/work-items/WI-001-template.md" "$d/.loop/work-items/$case.md"
  jq --arg e "$(resolve_stamp "$(jq -r '.expires_at // empty' "$fixtures/$case.json")")" \
     --arg a "$(resolve_stamp "$(jq -r '.authorized_at // empty' "$fixtures/$case.json")")" \
     '(if has("expires_at") then .expires_at=$e else . end) | (if has("authorized_at") then .authorized_at=$a else . end)' \
     "$fixtures/$case.json" > "$d/.loop/work-items/$case.authorization.json"
  jq -n --arg id "$case" '{schema_version:1,items:[{id:$id,title:"Fixture",added_at:"2026-01-01T00:00:00Z",work_kind:"feature"}]}' > "$d/.loop/backlog.json"
  want=0; [ "$expected" != READY ] || want=1
  shell_counts=$("$orch" status --root "$d" | jq -c '{ready:.backlog.ready,paused:.backlog.paused}')
  node_counts=$(node "$repo/bin/build-loop.mjs" backlog_list --root "$d" | jq -c '{ready:.backlog.ready,paused:.backlog.paused}')
  [ "$shell_counts" = "{\"ready\":$want,\"paused\":$((1-want))}" ] || bad "authorization fixture $case: shell says $shell_counts, expected $expected"
  [ "$shell_counts" = "$node_counts" ] || bad "authorization fixture $case: shell $shell_counts and node $node_counts disagree"
done <<EOF
$cases
EOF
ok 'the shell and the control layer agree on every shared authorization fixture'

# ---- a decision copied into another item's sidecar authorizes nothing ----
d=$(fixture); authorize "$d" TEST-1 '["src/**"]'
jq '.item_id="OTHER-1"' "$d/.loop/work-items/TEST-1.authorization.json" > "$d/a"; mv "$d/a" "$d/.loop/work-items/TEST-1.authorization.json"
"$orch" start --root "$d" >/dev/null 2>&1 && bad 'a swapped authorization sidecar did not stop the start'
[ "$(st "$d" .run_status)" = BLOCKED ] || bad "swapped sidecar status $(st "$d" .run_status)"
grep -q 'authorization invalid or expired' "$d/.loop/blockers.md" || bad 'no blocker names the swapped sidecar'
ok 'an authorization naming another work item blocks the run instead of authorizing it'

# ---- an unusable authorization fails closed before the node runs ----
d=$(fixture); authorize "$d" TEST-1 '["src/**"]'; "$orch" start --root "$d" >/dev/null
jq '.expires_at="2000-01-01T00:00:00Z"' "$d/.loop/work-items/TEST-1.authorization.json" > "$d/a"; mv "$d/a" "$d/.loop/work-items/TEST-1.authorization.json"
set +e; MOCK_SCRIPT= "$orch" run --root "$d" --host mock --provider "$mock" >/dev/null 2>&1; rc=$?; set -e
[ "$rc" -ne 0 ] || bad 'an expired authorization did not stop the node'
[ "$(st "$d" .run_status)" = BLOCKED ] || bad "expired authorization status $(st "$d" .run_status)"
[ "$(st "$d" '.gates.DEFINE.status')" = PENDING ] || bad 'the node ran under an expired authorization'
grep -q 'authorization invalid or expired' "$d/.loop/blockers.md" || bad 'no blocker names the unusable authorization'
ok 'an expired authorization blocks the run before the node runs'

d=$(fixture); authorize "$d" TEST-1 '["src/**"]'; "$orch" start --root "$d" >/dev/null
printf 'not json at all
' > "$d/.loop/work-items/TEST-1.authorization.json"
set +e; MOCK_SCRIPT= "$orch" run --root "$d" --host mock --provider "$mock" >/dev/null 2>&1; rc=$?; set -e
[ "$rc" -ne 0 ] || bad 'an unreadable authorization did not stop the node'
[ "$(st "$d" .run_status)" = BLOCKED ] || bad "unreadable authorization status $(st "$d" .run_status)"
[ "$(st "$d" '.gates.DEFINE.status')" = PENDING ] || bad 'the node ran under an unreadable authorization'
ok 'an unreadable authorization blocks the run before the node runs'

# A fractional, offset timestamp the shell used to reject is a usable decision.
d=$(fixture)
jq -n --arg f "$(date -u -d '+2 hour' '+%Y-%m-%dT%H:%M:%S.750+01:00' 2>/dev/null || date -u -v+2H '+%Y-%m-%dT%H:%M:%S.750+01:00')" \
  '{schema_version:1,item_id:"TEST-1",state:"READY",scope:{allowed_paths:[".loop/work-items/**","src/**","tests/**"]},
    budget:{max_rounds:40,max_wall_seconds:600},expires_at:$f,stop_on_first_failure:true,
    authorized_by:"local-http-user",assurance:"local-user-action",authorized_at:"2026-01-01T00:00:00Z"}' > "$d/.loop/work-items/TEST-1.authorization.json"
"$orch" start --root "$d" >/dev/null
MOCK_SCRIPT= "$orch" run --root "$d" --host mock --provider "$mock" >/dev/null
[ "$(st "$d" '.gates.DEFINE.status')" = PASSED ] || bad 'a fractional offset expiry blocked a valid decision'
ok 'a valid fractional offset expiry lets the node run'

# ---- a withdrawn decision stops every automated entry point ----
# A sidecar in state PAUSED is not "no decision": it is a decision that was
# withdrawn or never given, and it means a person has to act. Direct execution
# is refused on it; a person at a terminal may still run the item, and then the
# record's own scope and budget are the boundary of that run.
paused_sidecar(){ # dir item scope-json [jq-filter]
  authorize "$1" "$2" "$3"
  jq ".state=\"PAUSED\" | ${4:-.}" "$1/.loop/work-items/$2.authorization.json" > "$1/paused.json"
  mv "$1/paused.json" "$1/.loop/work-items/$2.authorization.json"
}

# A real terminal on standard input, which is what "a person is doing this"
# means to the orchestrator. util-linux and BSD `script` spell it differently;
# where neither can give us a pseudo-terminal the documented
# BUILD_LOOP_HUMAN_TTY override stands in for one.
# `command` is deliberate: this suite has a shell function called script.
tty_style=none
if command script -q /dev/null -c 'test -t 0' </dev/null >/dev/null 2>&1; then tty_style=gnu
elif command script -q /dev/null test -t 0 </dev/null >/dev/null 2>&1; then tty_style=bsd; fi
as_human(){
  case "$tty_style" in
    gnu) command script -q /dev/null -c "$(printf '%q ' "$@")" </dev/null >/dev/null 2>&1;;
    bsd) command script -q /dev/null "$@" </dev/null >/dev/null 2>&1;;
    *) BUILD_LOOP_HUMAN_TTY=1 "$@" </dev/null >/dev/null 2>&1;;
  esac
}

d=$(fixture); paused_sidecar "$d" TEST-1 '[".loop/work-items/**","src/**","tests/**"]'
set +e; "$orch" start --root "$d" </dev/null >/dev/null 2>"$d/refusal.txt"; rc=$?; set -e
[ "$rc" -eq 77 ] || bad "a withdrawn authorization did not refuse the start (exit $rc)"
grep -q AUTHORIZATION_REVOKED "$d/refusal.txt" || bad 'the refusal does not name AUTHORIZATION_REVOKED'
grep -q 'interactive terminal' "$d/refusal.txt" || bad 'the refusal does not say what a person can do'
[ "$(st "$d" .run_status)" = PAUSED ] || bad "the refused start changed the run to $(st "$d" .run_status)"
set +e; MOCK_SCRIPT= "$orch" run --root "$d" --host mock --provider "$mock" </dev/null >/dev/null 2>&1; rc=$?; set -e
[ "$rc" -eq 77 ] || bad "a withdrawn authorization did not refuse the node (exit $rc)"
[ "$(st "$d" '.gates.DEFINE.status')" = PENDING ] || bad 'a node ran under a withdrawn authorization'
ok 'a withdrawn authorization refuses start and run without a person'

# The person is still bound by what the record says: the budget only narrows,
# and a slice outside the recorded scope fails the DESIGN gate as always.
d=$(fixture); paused_sidecar "$d" TEST-1 '["docs/**"]' '.budget.max_rounds=3'
# `script` does not pass its child's exit status through, so what the run became
# is the assertion, not the status code.
as_human "$orch" start --root "$d" || :
[ "$(st "$d" .run_status)" = RUNNING ] || bad "a person at a terminal could not start a withdrawn item: $(st "$d" .run_status)"
[ "$(st "$d" .max_rounds)" -eq 3 ] || bad "the withdrawn budget did not cap the run, got $(st "$d" .max_rounds)"
set +e; as_human env MOCK_SCRIPT= "$orch" loop --root "$d" --host mock --provider "$mock" --max-nodes 3; set -e
[ "$(st "$d" .run_status)" = BLOCKED ] || bad "the human run ignored the recorded scope, status $(st "$d" .run_status)"
grep -q 'slice path outside authorized scope' "$d/.loop/blockers.md" || bad 'no blocker names the out-of-scope slice'
ok 'a person may run a withdrawn item, still inside its recorded scope and budget'

# The managed worker is not a person. It sets LOOP_JOB_ID, which disqualifies
# the test override outright, and it may only proceed when the control layer
# recorded a human entry for exactly this job and item.
d=$(fixture); paused_sidecar "$d" TEST-1 '["src/**"]'
mkdir -p "$d/.loop/control/job.lock"
jq -n '{pid:12345,created_at:"2026-09-06T00:00:00Z",request_id:"request-1",job_id:"job-1",lock_id:"lock-1"}' > "$d/.loop/control/job.lock/owner.json"
set +e; LOOP_JOB_ID=job-1 LOOP_JOB_LOCK_ID=lock-1 BUILD_LOOP_HUMAN_TTY=1 "$orch" start --root "$d" </dev/null >/dev/null 2>&1; rc=$?; set -e
[ "$rc" -eq 77 ] || bad "the test override let a managed job past a withdrawn authorization (exit $rc)"
[ "$(st "$d" .run_status)" = PAUSED ] || bad 'a managed job started under a withdrawn authorization'
jq -n '{schema_version:1,job_id:"job-1",human_entry:{item_id:"OTHER-1",channel:"interactive-tty",at:"2026-09-06T00:00:00Z"}}' > "$d/.loop/control/current-job.json"
set +e; LOOP_JOB_ID=job-1 LOOP_JOB_LOCK_ID=lock-1 "$orch" start --root "$d" </dev/null >/dev/null 2>&1; rc=$?; set -e
[ "$rc" -eq 77 ] || bad "a human entry for another item was accepted (exit $rc)"
jq '.human_entry.item_id="TEST-1"' "$d/.loop/control/current-job.json" > "$d/cj.json"; mv "$d/cj.json" "$d/.loop/control/current-job.json"
LOOP_JOB_ID=job-1 LOOP_JOB_LOCK_ID=lock-1 "$orch" start --root "$d" </dev/null >/dev/null || bad 'a recorded human entry was refused'
[ "$(st "$d" .run_status)" = RUNNING ] || bad 'the recorded human entry did not start the item'
ok 'a managed job may only pass a withdrawn authorization on a recorded human entry'

# Every sidecar is validated in full, whatever state it claims. A PAUSED record
# that does not validate is broken, not inert, and nobody runs on it.
d=$(fixture); paused_sidecar "$d" TEST-1 '["src/**"]' '.surprise="extra"'
# `script` does not pass the exit status of its child through, so what the run
# ended up as is the assertion here, not the status code.
as_human "$orch" start --root "$d" || :
[ "$(st "$d" .run_status)" = BLOCKED ] || bad "invalid PAUSED record status $(st "$d" .run_status)"
grep -q 'authorization invalid or expired' "$d/.loop/blockers.md" || bad 'no blocker names the invalid PAUSED record'
ok 'a PAUSED record that does not validate blocks the run in the same way as any other broken record'

# ---- a project-wide hold stops every automated entry point ----
# The hold is on the project, not on an item: a fresh work item does not escape
# it. A person at a terminal may still work, and is told that the project is on
# hold; anything without a terminal is refused with PROJECT_ON_HOLD.
d=$(fixture); mkdir -p "$d/.loop/control"
jq -n '{schema_version:1,held_at:"2026-09-06T00:00:00Z",held_by:"mcp-user",reason:"the authorization for TEST-1 was withdrawn",item_id:"TEST-1"}' > "$d/.loop/control/hold.json"
set +e; "$orch" start --root "$d" </dev/null >/dev/null 2>"$d/hold-refusal.txt"; rc=$?; set -e
[ "$rc" -eq 77 ] || bad "a project hold did not refuse the start (exit $rc)"
grep -q PROJECT_ON_HOLD "$d/hold-refusal.txt" || bad 'the refusal does not name PROJECT_ON_HOLD'
grep -q RELEASE "$d/hold-refusal.txt" || bad 'the refusal does not say how a person releases the hold'
[ "$(st "$d" .run_status)" = PAUSED ] || bad "the refused start changed the run to $(st "$d" .run_status)"
set +e; MOCK_SCRIPT= "$orch" run --root "$d" --host mock --provider "$mock" </dev/null >/dev/null 2>&1; rc=$?; set -e
[ "$rc" -eq 77 ] || bad "a project hold did not refuse the node (exit $rc)"
set +e; MOCK_SCRIPT= "$orch" loop --root "$d" --host mock --provider "$mock" --max-nodes 2 </dev/null >/dev/null 2>&1; rc=$?; set -e
[ "$rc" -eq 77 ] || bad "a project hold did not refuse the loop (exit $rc)"
[ "$(st "$d" '.gates.DEFINE.status')" = PENDING ] || bad 'a node ran while the project was on hold'
"$orch" status --root "$d" </dev/null > "$d/held-status.json"
jq -e '.hold.held==true and .hold.item_id=="TEST-1" and (.hold.reason|type=="string")' "$d/held-status.json" >/dev/null || bad 'status does not report the hold'
ok 'a project-wide hold refuses start, run and loop without a person'

# A person at a terminal may still work, and the orchestrator says so.
as_human "$orch" start --root "$d" || :
[ "$(st "$d" .run_status)" = RUNNING ] || bad "a person at a terminal could not start a held project: $(st "$d" .run_status)"
d=$(fixture); mkdir -p "$d/.loop/control"
jq -n '{schema_version:1,held_at:"2026-09-06T00:00:00Z",held_by:"mcp-user",reason:"stop everything",item_id:"TEST-1"}' > "$d/.loop/control/hold.json"
BUILD_LOOP_HUMAN_TTY=1 "$orch" start --root "$d" </dev/null >/dev/null 2>"$d/hold-warning.txt" || bad 'a person could not start a held project'
grep -q 'WARNING: this project is on hold' "$d/hold-warning.txt" || bad 'the person was not told the project is on hold'
ok 'a person may work in a held project and is told that it is on hold'

# ---- status reports the authorization state next to the raw record ----
d=$(fixture)
"$orch" status --root "$d" </dev/null > "$d/status-none.json"
jq -e '.authorization==null and .authorization_state=="none" and .hold==null' "$d/status-none.json" >/dev/null || bad 'status without a sidecar is wrong'
authorize "$d" TEST-1 '["src/**"]'
"$orch" status --root "$d" </dev/null > "$d/status-ready.json"
jq -e '.authorization_state=="READY"' "$d/status-ready.json" >/dev/null || bad 'status does not report READY'
jq '.expires_at="2000-01-01T00:00:00Z"' "$d/.loop/work-items/TEST-1.authorization.json" > "$d/a.json"; mv "$d/a.json" "$d/.loop/work-items/TEST-1.authorization.json"
"$orch" status --root "$d" </dev/null > "$d/status-expired.json"
jq -e '.authorization_state=="EXPIRED"' "$d/status-expired.json" >/dev/null || bad 'status does not report EXPIRED'
paused_sidecar "$d" TEST-1 '["src/**"]'
"$orch" status --root "$d" </dev/null > "$d/status-paused.json"
jq -e '.authorization_state=="PAUSED"' "$d/status-paused.json" >/dev/null || bad 'status does not report PAUSED'
jq '.surprise="extra"' "$d/.loop/work-items/TEST-1.authorization.json" > "$d/a.json"; mv "$d/a.json" "$d/.loop/work-items/TEST-1.authorization.json"
"$orch" status --root "$d" </dev/null > "$d/status-invalid.json"
jq -e '.authorization_state=="INVALID"' "$d/status-invalid.json" >/dev/null || bad 'status does not report INVALID'
ok 'status classifies the authorization as READY, PAUSED, EXPIRED, INVALID or none'

# The chat-hosted provider calls no model: it writes the brief and waits for the
# chat's result. With none in time the node blocks; it never passes.
chat="$repo/hosts/chat/provider.sh"
d=$(fixture); "$orch" start --root "$d" >/dev/null
set +e; CHAT_PROVIDER_TIMEOUT_SECONDS=1 "$orch" run --root "$d" --host chat --provider "$chat" </dev/null >/dev/null 2>&1; rc=$?; set -e
[ "$rc" -eq 1 ] || bad "chat provider timeout returned $rc"
[ "$(st "$d" .run_status)" = BLOCKED ] || bad "chat timeout status $(st "$d" .run_status)"
[ "$(st "$d" .gates.DEFINE.status)" = PENDING ] || bad 'chat timeout changed the DEFINE gate'
grep -q 'no chat result within timeout' "$d/.loop/blockers.md" || bad 'chat timeout blocker text missing'
chat_node="run-TEST-1-$(st "$d" .round)-define"
chat_brief=$(ls "$d/.loop/scheduler/chat/" | grep -E '^n-[0-9a-f]{12}\.[0-9a-f]{32}\.brief\.json$' | head -n 1)
[ -n "$chat_brief" ] || bad 'chat provider did not write the brief under an opaque node id and an attempt id'
chat_base=${chat_brief%.brief.json}
jq -e --arg l "$chat_node" --arg b "$chat_base" '.label==$l and (.node_id+"."+.attempt_id)==$b and .brief.phase=="DEFINE" and (.brief.prompt|length>0)' "$d/.loop/scheduler/chat/$chat_brief" >/dev/null || bad 'chat brief is not the node brief with its label and attempt'
[ -f "$d/.loop/scheduler/chat/$chat_base.expired.json" ] || bad 'chat provider did not record the expiry'
[ ! -e "$d/.loop/scheduler/chat/pending.json" ] || bad 'chat provider left its pending pointer'
jq -e '.host=="chat" and .outcome=="BLOCKED"' "$d/.loop/evidence/$chat_node/provenance.json" >/dev/null || bad 'chat provenance missing'
ok 'chat-hosted provider blocks the node when no chat result arrives in time'

# A result written for another attempt of the same node is never taken, and a
# symlinked chat directory is refused before anything is written through it.
d=$(fixture); "$orch" start --root "$d" >/dev/null
mkdir -p "$d/.loop/scheduler/chat"
(
  for _ in $(seq 1 100); do
    f=$(ls "$d/.loop/scheduler/chat/" 2>/dev/null | grep -E '\.brief\.json$' | head -n 1 || :)
    if [ -n "$f" ]; then
      node_id=${f%%.*}
      jq -n --arg n "$node_id" '{schema_version:1,node_id:$n,attempt_id:"00000000000000000000000000000000",result:{schema_version:1,status:"DONE",defect_class:null,blocker:null,notes:"wrong attempt"}}' > "$d/.loop/scheduler/chat/$node_id.00000000000000000000000000000000.result.json"
      break
    fi
    sleep 0.1
  done
) &
set +e; CHAT_PROVIDER_TIMEOUT_SECONDS=3 "$orch" run --root "$d" --host chat --provider "$chat" </dev/null >/dev/null 2>&1; rc=$?; set -e
wait
[ "$rc" -eq 1 ] && [ "$(st "$d" .run_status)" = BLOCKED ] || bad "a result for another attempt was taken (rc $rc, $(st "$d" .run_status))"
[ "$(st "$d" .gates.DEFINE.status)" = PENDING ] || bad 'a result for another attempt changed the DEFINE gate'
grep -q 'no chat result within timeout' "$d/.loop/blockers.md" || bad 'the node did not time out waiting for its own attempt'
ls "$d/.loop/scheduler/chat/" | grep -q '\.00000000000000000000000000000000\.result\.json$' || bad 'the wrong-attempt result was not left untouched'
! ls "$d/.loop/scheduler/chat/" | grep -q '\.consumed\.json$' || bad 'a wrong-attempt result was consumed'
ok 'chat-hosted provider takes only the result of its own attempt'

d=$(fixture); "$orch" start --root "$d" >/dev/null
elsewhere=$(mktemp -d)
mkdir -p "$d/.loop/scheduler"; ln -s "$elsewhere" "$d/.loop/scheduler/chat"
set +e; CHAT_PROVIDER_TIMEOUT_SECONDS=1 "$orch" run --root "$d" --host chat --provider "$chat" </dev/null >/dev/null 2>&1; rc=$?; set -e
[ "$rc" -ne 0 ] || bad 'a symlinked chat directory was used'
[ "$(st "$d" .gates.DEFINE.status)" = PENDING ] || bad 'a symlinked chat directory changed the DEFINE gate'
[ -z "$(ls -A "$elsewhere")" ] || bad 'the chat provider wrote through a symlinked directory'
rm -rf "$elsewhere"
ok 'chat-hosted provider refuses a symlinked chat directory'

echo "1..$n"
