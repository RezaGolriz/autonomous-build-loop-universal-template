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
echo "1..$n"
