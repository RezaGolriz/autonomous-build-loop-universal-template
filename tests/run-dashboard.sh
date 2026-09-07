#!/usr/bin/env bash
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd -P); render="$repo/engine/render-dashboard.sh"; orch="$repo/engine/orchestrator.sh"; mock="$repo/hosts/mock/provider.sh"
n=0; ok(){ n=$((n+1)); echo "ok $n - $1"; }; bad(){ echo "not ok - $1" >&2; exit 1; }
fixture(){
  d=$(mktemp -d "${TMPDIR:-/tmp}/loop-dashboard-fixture.XXXXXX")
  cp -R "$repo/tests/fixtures/python-cli/." "$d/"; chmod +x "$d"/tests/*.sh; mkdir -p "$d/.loop/work-items" "$d/.loop/evidence"
  jq '.commands += [(.commands[0]|.id="build-check"|.phase="EXECUTE")] | .environment.allow_names += ["MOCK_SCRIPT","MOCK_DUMP"]' "$repo/examples/adapters/python-cli.json" > "$d/.loop/project.adapter.json"
  cp "$d/.loop/project.adapter.json" "$d/project.adapter.json"; cp "$repo/template/.loop/workflow.json" "$d/.loop/workflow.json"
  jq '.work_item_id="TEST-1"|.run_status="PAUSED"|.max_rounds=40|.max_gate_failures=3|.max_wall_seconds=600' "$repo/template/.loop/state.example.json" > "$d/.loop/state.json"
  cp "$repo/template/work-items/WI-001-template.md" "$d/.loop/work-items/TEST-1.md"
  (cd "$d" && git init -q && git add -A && git -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm initial); echo "$d"
}
d=$(fixture); "$render" --root "$d"; out="$d/.loop/dashboard.html"
[ -f "$out" ] || bad 'dashboard file missing'; for x in TEST-1 PAUSED DEFINE DESIGN EXECUTE REVIEW VALIDATE HANDOVER 'not available'; do grep -q "$x" "$out" || bad "missing $x"; done; ok 'renders paused fixture'
"$orch" start --root "$d" >/dev/null; MOCK_SCRIPT= "$orch" loop --root "$d" --host mock --provider "$mock" --max-nodes 10 >/dev/null; "$render" --root "$d"
for x in WAITING_FOR_HUMAN independent-review reference-engine PASSED; do grep -q "$x" "$out" || bad "missing $x"; done; ok 'renders completed loop evidence'
printf '%s\n' '- [x] old' '- [ ] DESIGN x: decide' > "$d/.loop/blockers.md"; "$render" --root "$d"; a=$(grep -nF -- '- [ ] DESIGN x: decide' "$out"|cut -d: -f1); b=$(grep -nF -- '- [x] old' "$out"|cut -d: -f1); [ "$a" -lt "$b" ] || bad 'open blocker not first'; ok 'renders blockers open first'
d=$(fixture); text=$("$render" --root "$d" --output -); printf %s "$text" | grep -q '<!doctype html>' || bad 'stdout has no HTML'; [ ! -e "$d/.loop/dashboard.html" ] || bad 'stdout mode created file'; ok 'stdout mode creates no file'
printf '%s\n' '<script>alert(1)</script>' > "$d/.loop/work-items/TEST-1.md"; "$render" --root "$d"; grep -q '&lt;script&gt;alert(1)&lt;/script&gt;' "$d/.loop/dashboard.html" || bad 'script not escaped'; if grep -q '<script>alert(1)</script>' "$d/.loop/dashboard.html"; then bad 'raw script present'; fi; ok 'escapes work item HTML'

d=$(fixture); "$render" --root "$d"; out="$d/.loop/dashboard.html"
for x in 'Authorization of the current item' 'Backlog' 'Inbox' 'Last tick and last scout' 'Next-steps memory'; do grep -q "$x" "$out" || bad "missing section $x"; done
grep -q 'Last tick: not available' "$out" || bad 'tick tile does not say not available'; grep -q 'Last scout: not available' "$out" || bad 'scout tile does not say not available'
ok 'new tiles say not available while their files are missing'

future=$(jq -rn 'now + 3600 | todate'); past=$(jq -rn 'now - 3600 | todate')
mkdir -p "$d/.loop/control" "$d/.loop/scheduler" "$d/.loop/notes" "$d/.loop/inbox"
jq -n --arg f "$future" '{schema_version:1,item_id:"TEST-1",state:"READY",scope:{allowed_paths:["src/"]},budget:{max_rounds:12,max_wall_seconds:900},expires_at:$f,stop_on_first_failure:true,authorized_by:"mcp-user",assurance:"local-user-action",authorized_at:"2026-01-01T00:00:00Z"}' > "$d/.loop/work-items/TEST-1.authorization.json"
cp "$repo/template/work-items/WI-001-template.md" "$d/.loop/work-items/WI-100.md"; cp "$repo/template/work-items/WI-001-template.md" "$d/.loop/work-items/WI-101.md"
jq -n --arg f "$future" '{schema_version:1,item_id:"WI-100",state:"READY",scope:{allowed_paths:["src/"]},budget:{max_rounds:8,max_wall_seconds:600},expires_at:$f,stop_on_first_failure:true,authorized_by:"cli-input",authorized_at:"2026-01-01T00:00:00Z"}' > "$d/.loop/work-items/WI-100.authorization.json"
jq -n --arg p "$past" '{schema_version:1,item_id:"WI-101",state:"READY",scope:{allowed_paths:["docs/"]},budget:{max_rounds:4,max_wall_seconds:600},expires_at:$p,stop_on_first_failure:true,authorized_by:"cli-input",authorized_at:"2026-01-01T00:00:00Z"}' > "$d/.loop/work-items/WI-101.authorization.json"
jq -n '{schema_version:1,items:[{id:"WI-100",title:"<b>queued</b>",added_at:"2026-01-01T00:00:00Z",work_kind:"feature"},{id:"WI-101",title:"stale",added_at:"2026-01-01T00:00:00Z",work_kind:"defect"}]}' > "$d/.loop/backlog.json"
jq -n '{schema_version:1,items:[{id:"P-20260101T000000Z-1",title:"a proposal",created_at:"2026-01-01T00:00:00Z",provider:"mock",file:".loop/inbox/P-20260101T000000Z-1.md"}]}' > "$d/.loop/inbox/index.json"
printf '%s\n' '2026-01-01T00:00:00Z action=reported reason=older item=TEST-1 phase=DEFINE run_status=PAUSED' '2026-01-02T00:00:00Z action=ran-node reason=run-status-running item=TEST-1 phase=EXECUTE run_status=RUNNING' > "$d/.loop/scheduler/tick.log"
printf '%s\n' '{"at":"2026-01-02T00:00:00Z","event":"scout","provider":"mock","profile":"cli","status":"DONE","proposals":2}' > "$d/.loop/scheduler/scout.log"
printf '%s\n' '# Next steps' '' '- <i>keep going</i>' > "$d/.loop/notes/next-steps.md"
"$render" --root "$d"
grep -q 'badge READY' "$out" || bad 'no READY authorization badge'
grep -q 'authorized through a chat tool call' "$out" || bad 'mcp-user channel not highlighted'
grep -q '1 READY · 1 PAUSED · 2 shown' "$out" || bad 'backlog counts wrong'
grep -q 'flag">expired' "$out" || bad 'expired backlog authorization not flagged'
grep -q '&lt;b&gt;queued&lt;/b&gt;' "$out" || bad 'backlog title not escaped'
grep -q '1 proposal(s) waiting for a person' "$out" || bad 'inbox count missing'
grep -q 'P-20260101T000000Z-1' "$out" || bad 'inbox proposal missing'
grep -q 'action ran-node' "$out" || bad 'last tick action missing'
if grep -q 'action reported' "$out"; then bad 'tick tile shows an older line'; fi
grep -q '2 proposal(s) · provider mock' "$out" || bad 'last scout line missing'
grep -q '&lt;i&gt;keep going&lt;/i&gt;' "$out" || bad 'next-steps note not escaped or not shown'
grep -q 'Assurance: local-user-action' "$out" || bad 'assurance of the current authorization missing'
grep -q 'Human confirmation mode: tty-or-local-page' "$out" || bad 'default confirmation mode missing'
printf '%s\n' '{"schema_version":1,"human_confirmation":"tty-only"}' > "$d/.loop/control/policy.json"
"$render" --root "$d"
grep -q 'Human confirmation mode: tty-only' "$out" || bad 'tty-only confirmation mode not shown'
rm -f "$d/.loop/control/policy.json"
"$render" --root "$d"
ok 'renders backlog, inbox, authorization, tick, scout and memory tiles'
# A project-wide hold is the first thing on the page: while it is there nothing
# automated runs, whatever the run status says.
if grep -q 'PROJECT ON HOLD' "$out"; then bad 'a project without a hold shows the hold banner'; fi
mkdir -p "$d/.loop/control"
jq -n '{schema_version:1,held_at:"2026-01-01T00:00:00Z",held_by:"mcp-user",reason:"the authorization for <b>TEST-1</b> was withdrawn",item_id:"TEST-1"}' > "$d/.loop/control/hold.json"
"$render" --root "$d"
grep -q 'PROJECT ON HOLD' "$out" || bad 'the hold banner is missing'
grep -q 'the authorization for &lt;b&gt;TEST-1&lt;/b&gt; was withdrawn' "$out" || bad 'the hold reason is missing or not escaped'
grep -q 'held by mcp-user' "$out" || bad 'the hold channel is missing'
grep -q 'RELEASE' "$out" || bad 'the banner does not say how a person releases the hold'
banner=$(grep -n 'PROJECT ON HOLD' "$out" | head -1 | cut -d: -f1); heading=$(grep -n '<h1>Work item' "$out" | head -1 | cut -d: -f1)
[ "$banner" -lt "$heading" ] || bad 'the hold banner is not at the top of the page'
printf '%s\n' 'not a record' > "$d/.loop/control/hold.json"
"$render" --root "$d"
grep -q 'PROJECT ON HOLD' "$out" || bad 'an unreadable hold record does not show the banner'
rm -f "$d/.loop/control/hold.json"
ok 'renders the project hold banner, escaped, above everything else'

echo "1..$n"
