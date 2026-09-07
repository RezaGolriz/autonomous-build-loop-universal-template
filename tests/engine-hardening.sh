#!/usr/bin/env bash
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd -P)
orch="$repo/engine/orchestrator.sh"
engine="$repo/engine/reference-engine.sh"
mock="$repo/hosts/mock/provider.sh"
n=0
ok(){ n=$((n+1)); echo "ok $n - $1"; }
bad(){ echo "not ok - $1" >&2; exit 1; }

fixture(){
  d=$(mktemp -d "${TMPDIR:-/tmp}/loop-hardening.XXXXXX")
  cp -R "$repo/tests/fixtures/python-cli/." "$d/"
  chmod +x "$d"/tests/*.sh
  mkdir -p "$d/.loop/work-items" "$d/.loop/evidence"
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

set_state(){ jq "$2" "$1/.loop/state.json" > "$1/state.new" && mv "$1/state.new" "$1/.loop/state.json"; }
external_provider(){
  p=$(mktemp "${TMPDIR:-/tmp}/loop-provider.XXXXXX")
  printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail' 'cat >/dev/null' "$1" > "$p"
  chmod +x "$p"; echo "$p"
}

d=$(fixture); mkdir "$d/.loop/orchestrator.lock"
set +e; "$orch" start --root "$d" >/dev/null 2>&1; rc=$?; set -e
[ "$rc" -eq 73 ] || bad "start ignored shared lock (exit $rc)"
[ "$(jq -r .run_status "$d/.loop/state.json")" = PAUSED ] || bad 'locked start changed state'
ok 'start participates in the shared orchestrator lock'

d=$(fixture); mkdir -p "$d/.loop/control/job.lock"
jq -n '{pid:12345,created_at:"2026-09-06T00:00:00Z",request_id:"request-1",job_id:"job-1",lock_id:"lock-1"}' > "$d/.loop/control/job.lock/owner.json"
set +e; "$orch" start --root "$d" >/dev/null 2>&1; rc=$?; set -e
[ "$rc" -eq 73 ] && [ "$(jq -r .run_status "$d/.loop/state.json")" = PAUSED ] || bad 'raw shell entered a managed job'
set +e; LOOP_JOB_ID=job-1 LOOP_JOB_LOCK_ID=wrong "$orch" start --root "$d" >/dev/null 2>&1; rc=$?; set -e
[ "$rc" -eq 73 ] || bad 'wrong managed lock fence was accepted'
LOOP_JOB_ID=job-1 LOOP_JOB_LOCK_ID=lock-1 "$orch" start --root "$d" >/dev/null || bad 'matching managed worker was refused'
[ "$(jq -r .run_status "$d/.loop/state.json")" = RUNNING ] || bad 'matching managed worker did not start'
ok 'managed job ownership excludes raw shell concurrency'

d=$(fixture); prior=$(( $(date +%s)-5 )); set_state "$d" ".started_epoch=$prior"
"$orch" start --root "$d" >/dev/null
[ "$(jq -r .started_epoch "$d/.loop/state.json")" -eq "$prior" ] || bad 'start reset an existing time budget'
ok 'start preserves an existing wall-clock origin'

d=$(fixture); set_state "$d" '.run_status="BLOCKED"|.started_epoch=1|.max_wall_seconds=1'; printf '# Blockers\n\n' > "$d/.loop/blockers.md"
set +e; "$orch" resume --root "$d" >/dev/null 2>&1; rc=$?; set -e
[ "$rc" -eq 1 ] || bad "expired resume returned $rc"
[ "$(jq -r .run_status "$d/.loop/state.json")" = BLOCKED ] || bad 'expired resume was not durably blocked'
[ "$(jq -r .started_epoch "$d/.loop/state.json")" -eq 1 ] || bad 'resume reset the time budget'
ok 'resume preserves time and durably blocks an exhausted budget'

d=$(fixture); "$orch" start --root "$d" >/dev/null; set_state "$d" '.round=.max_rounds'; marker=$(mktemp -u "${TMPDIR:-/tmp}/loop-provider-called.XXXXXX")
p=$(external_provider "printf called > '$marker'; printf '%s\\n' '{\"schema_version\":1,\"status\":\"DONE\",\"defect_class\":null,\"blocker\":null,\"notes\":\"done\"}'")
set +e; "$orch" run --root "$d" --host test --provider "$p" >/dev/null 2>&1; rc=$?; set -e
[ "$rc" -eq 1 ] && [ ! -e "$marker" ] || bad 'provider ran after round cap exhaustion'
[ "$(jq -r .run_status "$d/.loop/state.json")" = BLOCKED ] || bad 'round cap was not durable'
[ "$(jq -r .next_action "$d/.loop/state.json")" = 'raise max_rounds or cancel the run' ] || bad 'round cap did not name the required repair'
set_state "$d" '.run_status="RUNNING"'; set +e; "$orch" run --root "$d" --host test --provider "$p" >/dev/null 2>&1; set -e
[ "$(grep -Fxc -- '- [ ] DEFINE run-TEST-1-40-define: round cap reached' "$d/.loop/blockers.md")" -eq 1 ] || bad 'round cap duplicated an open blocker'
ok 'round cap blocks before provider work'

d=$(fixture); now_epoch=$(date +%s); set_state "$d" ".phase=\"EXECUTE\"|.run_status=\"RUNNING\"|.started_epoch=$now_epoch"; marker=$(mktemp -u "${TMPDIR:-/tmp}/loop-provider-called.XXXXXX")
p=$(external_provider "printf called > '$marker'; printf '%s\\n' '{\"schema_version\":1,\"status\":\"DONE\",\"defect_class\":null,\"blocker\":null,\"notes\":\"done\"}'")
set +e; "$orch" run --root "$d" --host test --provider "$p" >/dev/null 2>&1; rc=$?; set -e
[ "$rc" -eq 1 ] && [ ! -e "$marker" ] || bad 'implicit EXECUTE scope reached the provider'
[ "$(jq -r .run_status "$d/.loop/state.json")" = BLOCKED ] || bad 'missing slice was not blocked'
ok 'EXECUTE fails closed when DESIGN declared no slice scope'

d=$(fixture); mkdir -p "$d/.loop/control/answers"; answer='Use the bounded local adapter.'; answer_sha=$(printf '%s' "$answer" | shasum -a 256 | awk '{print $1}')
jq -n --arg answer "$answer" --arg sha "$answer_sha" '{schema_version:1,answer_id:"answer-1",blocker_id:"blocker-1",work_item_id:"TEST-1",phase:"DEFINE",answer:$answer,recorded_at:"2026-09-06T00:00:00Z",answer_sha256:$sha}' > "$d/.loop/control/answers/answer-1.json"
brief=$("$orch" next --root "$d" --host mock)
jq -e --arg answer "$answer" '.prompt|contains("# Human blocker answers") and contains($answer)' <<<"$brief" >/dev/null || bad 'answer absent from next brief'
ok 'validated human blocker answers appear in the next node brief'

d=$(fixture); "$orch" start --root "$d" >/dev/null; mkdir -p "$d/.loop/control"
p=$(external_provider 'printf tampered > "$LOOP_ROOT/.loop/control/worker-write"; printf '\''%s\n'\'' '\''{"schema_version":1,"status":"DONE","defect_class":null,"blocker":null,"notes":"done"}'\''')
set +e; "$orch" run --root "$d" --host test --provider "$p" >/dev/null 2>&1; rc=$?; set -e
[ "$rc" -eq 1 ] && [ "$(jq -r .run_status "$d/.loop/state.json")" = BLOCKED ] || bad 'control metadata tamper escaped'
[ -f "$d/.loop/quarantine.json" ] || bad 'control metadata tamper was not quarantined'
sed 's/- \[ \]/- [x]/' "$d/.loop/blockers.md" > "$d/blockers.new" && mv "$d/blockers.new" "$d/.loop/blockers.md"
set +e; "$orch" resume --root "$d" >/dev/null 2>&1; rc=$?; set -e
[ "$rc" -eq 73 ] && [ "$(jq -r .run_status "$d/.loop/state.json")" = BLOCKED ] || bad 'resume accepted surviving forged metadata'
rm "$d/.loop/control/worker-write"
"$orch" resume --root "$d" >/dev/null || bad 'exact metadata restoration did not release quarantine'
[ ! -e "$d/.loop/quarantine.json" ] || bad 'restored quarantine was not cleared'
ok 'provider metadata tamper remains quarantined until exact restoration'

d=$(fixture); "$orch" start --root "$d" >/dev/null
p=$(external_provider 'jq '\''.pid=999999'\'' "$LOOP_ROOT/.loop/orchestrator.lock/owner.json" > "$LOOP_ROOT/.loop/orchestrator.lock/.owner.tmp"; mv "$LOOP_ROOT/.loop/orchestrator.lock/.owner.tmp" "$LOOP_ROOT/.loop/orchestrator.lock/owner.json"; printf '\''%s\n'\'' '\''{"schema_version":1,"status":"DONE","defect_class":null,"blocker":null,"notes":"done"}'\''')
set +e; "$orch" run --root "$d" --host test --provider "$p" >/dev/null 2>&1; rc=$?; set -e
[ "$rc" -eq 1 ] && [ -f "$d/.loop/quarantine.json" ] || bad 'orchestrator owner tamper was not quarantined'
jq -e '.changed_paths|index(".loop/orchestrator.lock/owner.json")!=null' "$d/.loop/quarantine.json" >/dev/null || bad 'owner tamper missing from quarantine'
sed 's/- \[ \]/- [x]/' "$d/.loop/blockers.md" > "$d/blockers.new" && mv "$d/blockers.new" "$d/.loop/blockers.md"
"$orch" resume --root "$d" >/dev/null || bad 'fresh supervisor lock could not recover prior owner tamper'
[ ! -e "$d/.loop/quarantine.json" ] && [ "$(jq -r .run_status "$d/.loop/state.json")" = RUNNING ] || bad 'fresh lock recovery did not clear quarantine'
ok 'quarantine revalidates a newly acquired orchestrator owner without trusting its prior PID'

d=$(fixture); "$orch" start --root "$d" >/dev/null; mkdir -p "$d/.loop/control"; printf stable > "$d/.loop/control/protected-script"; chmod 600 "$d/.loop/control/protected-script"
p=$(external_provider 'chmod 700 "$LOOP_ROOT/.loop/control/protected-script"; printf '\''%s\n'\'' '\''{"schema_version":1,"status":"DONE","defect_class":null,"blocker":null,"notes":"done"}'\''')
set +e; "$orch" run --root "$d" --host test --provider "$p" >/dev/null 2>&1; rc=$?; set -e
[ "$rc" -eq 1 ] && [ "$(jq -r .run_status "$d/.loop/state.json")" = BLOCKED ] || bad 'control mode change escaped'
ok 'protected snapshots detect permission-only provider changes'

d=$(fixture); mkdir -p "$d/.loop/control"; printf stable > "$d/.loop/control/four-digit-mode"; chmod 755 "$d/.loop/control/four-digit-mode"; ln -s four-digit-mode "$d/.loop/control/stable-link"
protected=$(mktemp); "$engine" protected-snapshot --root "$d" --output "$protected"
link_hash=$(printf 'LINK:%s' four-digit-mode | shasum -a 256 | awk '{print $1}')
jq -e --arg hash "$link_hash" '
  (.files|map(select(.path==".loop/control/four-digit-mode"))|.[0].mode)=="0755" and
  (.files|map(select(.path==".loop/control/stable-link"))|.[0]) as $link|
  $link.kind=="symlink" and $link.sha256==$hash and ($link.mode|test("^[0-7]{3,4}$")) and
  ($link|keys)==["kind","mode","path","sha256"]' "$protected" >/dev/null || bad 'protected snapshot lost mode or literal symlink target binding'
short_mode=$(bash -c 'stat(){ printf "4\n"; }; . "$1"; loop_stat_mode ignored' _ "$repo/engine/common.sh")
[ "$short_mode" = 0004 ] || bad "short stat mode was not normalized ($short_mode)"
ok 'protected snapshots bind four-digit modes and literal symlink targets'

d=$(fixture); before=$(mktemp); after=$(mktemp); protected_before=$(mktemp); protected_after=$(mktemp)
"$engine" snapshot --root "$d" --output "$before"; "$engine" protected-snapshot --root "$d" --output "$protected_before"
mkdir -p "$d/.loop/control"; printf stable > "$d/.loop/control/status.json"
"$engine" snapshot --root "$d" --output "$after"; "$engine" protected-snapshot --root "$d" --output "$protected_after"
cmp -s "$before" "$after" || bad 'control metadata polluted source snapshot'
cmp -s "$protected_before" "$protected_after" && bad 'protected snapshot hid control metadata'
ok 'source snapshots exclude control metadata while protected snapshots cover it'

d=$(fixture); odd="$d/src/line
break.py"; printf odd > "$odd"
set +e; "$engine" snapshot --root "$d" --output "$d.snapshot" >/dev/null 2>&1; rc=$?; set -e
[ "$rc" -eq 65 ] || bad "newline path was not rejected (exit $rc)"
ok 'source snapshot rejects newline paths before line-based policy checks'

d=$(fixture); "$orch" start --root "$d" >/dev/null; MOCK_SCRIPT= "$orch" loop --root "$d" --host mock --provider "$mock" --max-nodes 4 >/dev/null
[ "$(jq -r .phase "$d/.loop/state.json")" = REVIEW ] || bad 'fixture did not reach review'
p=$(external_provider 'brief=$(mktemp); cat > "$brief"; printf changed > "$LOOP_ROOT/reviewer-write"; jq -n --slurpfile b "$brief" --arg at "2026-09-06T00:00:00Z" '\''$b[0] as $x|{schema_version:1,verdict_id:"review-test",run_id:$x.run_id,work_item_id:$x.work_item_id,phase:"REVIEW",gate_id:"REVIEW",nonce:$x.nonce,result:"PASS",reviewer:"test",independent:true,revision:$x.revision,captured_at:$at,evidence_refs:$x.evidence_refs,findings:[]}'\''')
set +e; "$orch" run --root "$d" --host test --provider "$p" >/dev/null 2>&1; rc=$?; set -e
[ "$rc" -eq 1 ] && [ "$(jq -r .run_status "$d/.loop/state.json")" = BLOCKED ] || bad 'review write escaped'
ok 'REVIEW rejects provider workspace writes before accepting a verdict'

d=$(fixture); git_dir=$(mktemp -d "${TMPDIR:-/tmp}/loop-detached-git.XXXXXX"); mv "$d/.git" "$git_dir/repository.git"
"$orch" start --root "$d" >/dev/null; review_dump=$(mktemp)
MOCK_DUMP="$review_dump" "$orch" loop --root "$d" --host mock --provider "$mock" --max-nodes 5 >/dev/null
[ "$(jq -r .phase "$d/.loop/state.json")" = VALIDATE ] || bad 'unversioned review did not advance'
jq -e '.prompt|contains("src/greet.py")' "$review_dump" >/dev/null || bad 'unversioned review inventory omitted target files'
ok 'unversioned projects receive a deterministic no-index review inventory'

d=$(fixture); digest=$(printf 'a%.0s' {1..64}); mkdir -p "$d/.loop/control/setup-evidence"
jq -n --arg digest "$digest" '{schema_version:1,setup_digest:$digest,approval_id:"approval-1",status:"PASSED",target_unchanged:true,positive:[],negative:{}}' > "$d/.loop/control/setup-evidence/$digest.json"
adapter_sha=$(shasum -a 256 "$d/.loop/project.adapter.json" | awk '{print $1}'); workflow_sha=$(shasum -a 256 "$d/.loop/workflow.json" | awk '{print $1}')
jq -n --arg digest "$digest" --arg asha "$adapter_sha" --arg wsha "$workflow_sha" --arg evidence ".loop/control/setup-evidence/$digest.json" '{schema_version:1,setup_digest:$digest,activated_at:"2026-09-06T00:00:00Z",distribution:{},adapter_sha256:$asha,workflow_sha256:$wsha,adapter_file_sha256:$asha,workflow_file_sha256:$wsha,setup_evidence:$evidence}' > "$d/.loop/control/activation.json"
"$orch" start --root "$d" >/dev/null || bad 'valid managed activation was rejected'
ok 'managed activation binds raw shell start to exact active configuration'

d=$(fixture); digest=$(printf 'b%.0s' {1..64}); mkdir -p "$d/.loop/control/setup-evidence"
jq -n --arg digest "$digest" '{schema_version:1,setup_digest:$digest,approval_id:"approval-2",status:"PASSED",target_unchanged:true}' > "$d/.loop/control/setup-evidence/$digest.json"
adapter_sha=$(shasum -a 256 "$d/.loop/project.adapter.json" | awk '{print $1}'); workflow_sha=$(shasum -a 256 "$d/.loop/workflow.json" | awk '{print $1}')
jq -n --arg digest "$digest" --arg asha "$adapter_sha" --arg wsha "$workflow_sha" --arg evidence ".loop/control/setup-evidence/$digest.json" '{schema_version:1,setup_digest:$digest,activated_at:"2026-09-06T00:00:00Z",distribution:{},adapter_file_sha256:$asha,workflow_file_sha256:$wsha,setup_evidence:$evidence}' > "$d/.loop/control/activation.json"
printf '\n' >> "$d/.loop/project.adapter.json"
set +e; "$orch" start --root "$d" >/dev/null 2>&1; rc=$?; set -e
[ "$rc" -eq 65 ] && [ "$(jq -r .run_status "$d/.loop/state.json")" = PAUSED ] || bad 'tampered managed config started'
ok 'managed activation rejects changed active configuration'

d=$(fixture); "$orch" start --root "$d" >/dev/null; started=$(jq -r .started_epoch "$d/.loop/state.json"); mkdir -p "$d/.loop/control"
jq -n '{schema_version:1,job_id:"job-1",request_id:"request-1",desired_status:"PAUSED",requested_at:"2026-09-06T00:00:00Z"}' > "$d/.loop/control/intent.json"
marker=$(mktemp -u "${TMPDIR:-/tmp}/loop-provider-called.XXXXXX"); p=$(external_provider "printf called > '$marker'")
LOOP_JOB_ID=job-1 "$orch" run --root "$d" --host test --provider "$p" >/dev/null
[ "$(jq -r .run_status "$d/.loop/state.json")" = PAUSED ] && [ "$(jq -r .started_epoch "$d/.loop/state.json")" -eq "$started" ] && [ ! -e "$marker" ] || bad 'pause intent did not stop before node'
ok 'matching pause intent stops between nodes without resetting budget'

d=$(fixture); "$orch" start --root "$d" >/dev/null; mkdir -p "$d/.loop/control"
jq -n '{schema_version:1,job_id:"job-other",request_id:"request-2",desired_status:"PAUSED",requested_at:"2026-09-06T00:00:00Z"}' > "$d/.loop/control/intent.json"
set +e; LOOP_JOB_ID=job-1 "$orch" run --root "$d" --host test --provider "$mock" >/dev/null 2>&1; rc=$?; set -e
[ "$rc" -eq 65 ] && [ "$(jq -r .run_status "$d/.loop/state.json")" = RUNNING ] || bad 'mismatched intent changed state'
ok 'mismatched job intent fails closed'

for status_and_desired in 'COMPLETED CANCELLED' 'CANCELLED PAUSED' 'BLOCKED PAUSED' 'PAUSED PAUSED'; do
  set -- $status_and_desired; original=$1; desired=$2; d=$(fixture); set_state "$d" ".run_status=\"$original\""; mkdir -p "$d/.loop/control"
  jq -n --arg desired "$desired" '{schema_version:1,job_id:"job-safe",request_id:"request-safe",desired_status:$desired,requested_at:"2026-09-06T00:00:00Z"}' > "$d/.loop/control/intent.json"
  LOOP_JOB_ID=job-safe "$orch" run --root "$d" --host mock >/dev/null
  [ "$(jq -r .run_status "$d/.loop/state.json")" = "$original" ] || bad "intent rewrote $original to $desired"
done
ok 'control intents preserve terminal, blocked, and already-desired states'

d=$(fixture); linger_marker=$(mktemp -u "${TMPDIR:-/tmp}/loop-verifier-descendant.XXXXXX"); linger_script=$(mktemp "${TMPDIR:-/tmp}/loop-verifier-parent.XXXXXX")
cat > "$linger_script" <<EOF
use strict; use warnings;
my \$pid = fork(); die "fork" unless defined \$pid;
if (\$pid == 0) { sleep 2; open my \$fh, '>', '$linger_marker' or die \$!; print {\$fh} "escaped"; close \$fh; exit 0; }
exit 0;
EOF
jq --arg script "$linger_script" '.commands |= map(if .id=="test" then .argv=["perl",$script]|.timeout_seconds=1 else . end)' "$d/project.adapter.json" > "$d/adapter.linger.json"
linger_baseline=$(mktemp "${TMPDIR:-/tmp}/loop-verifier-baseline.XXXXXX")
"$engine" snapshot --root "$d" --output "$linger_baseline"
"$engine" verify --root "$d" --adapter "$d/adapter.linger.json" --node "$d/node.json" --baseline "$linger_baseline" --phase VALIDATE --evidence-dir "$d/.loop/evidence" >/dev/null || bad 'successful verifier with lingering helper was reported as timed out'
sleep 2
[ ! -e "$linger_marker" ] || bad 'successful verifier left a helper process alive'
ok 'verifier returns main status and cleans its lingering process group'

d=$(fixture); "$orch" start --root "$d" >/dev/null; capture=$(mktemp)
p=$(external_provider 'if [ -n "${SECRET_SHOULD_NOT_LEAK-}" ]; then printf leaked > "$MOCK_DUMP"; else printf clean > "$MOCK_DUMP"; fi; printf '\''%s\n'\'' '\''{"schema_version":1,"status":"BLOCKED","defect_class":null,"blocker":"test stop","notes":"env checked"}'\''')
set +e; SECRET_SHOULD_NOT_LEAK=secret MOCK_DUMP="$capture" "$orch" run --root "$d" --host test --provider "$p" >/dev/null 2>&1; set -e
[ "$(cat "$capture")" = clean ] || bad 'undeclared secret reached provider'
ok 'provider environment excludes undeclared secrets while retaining explicit adapter values'

echo "1..$n"
