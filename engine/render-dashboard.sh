#!/usr/bin/env bash
set -euo pipefail

self_dir=$(cd "$(dirname "$0")" && pwd -P)
root=""; output=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --root) [ "$#" -ge 2 ] || { echo '--root needs a value' >&2; exit 64; }; root=$2; shift 2;;
    --output) [ "$#" -ge 2 ] || { echo '--output needs a value' >&2; exit 64; }; output=$2; shift 2;;
    *) echo "unknown argument: $1" >&2; exit 64;;
  esac
done
[ -n "$root" ] || { echo '--root is required' >&2; exit 64; }
loop="$root/.loop"; state="$loop/state.json"
[ -f "$state" ] || { echo "missing $state" >&2; exit 66; }
workflow="$loop/workflow.json"; [ -f "$workflow" ] || workflow="$self_dir/../core/workflow.json"
[ -f "$workflow" ] || { echo 'workflow not available' >&2; exit 66; }
[ -n "$output" ] || output="$loop/dashboard.html"
tmp=$(mktemp -d "${TMPDIR:-/tmp}/loop-dashboard.XXXXXX")
trap 'rm -rf "$tmp"' EXIT INT TERM

esc(){ sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g' -e "s/'/\&#39;/g"; }
val(){ jq -r "$1 // \"not available\"" "$state" | esc; }
phases='DEFINE DESIGN EXECUTE REVIEW VALIDATE HANDOVER'
evidence="$tmp/evidence.json"; set --
for f in "$loop"/evidence/*.json; do
  [ -f "$f" ] || continue
  [ "$(basename "$f")" = run-summary.json ] || set -- "$@" "$f"
done
if [ "$#" -gt 0 ]; then jq -s 'sort_by(.captured_at // "")|reverse' "$@" > "$evidence"; else printf '[]\n' > "$evidence"; fi
generated=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
status=$(jq -r '.run_status' "$state"); current=$(jq -r '.phase' "$state")
{
cat <<'HTML'
<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Run dashboard</title><style>
body{margin:0;background:#f7f8fa;color:#17202a;font:15px system-ui,-apple-system,sans-serif}main{max-width:1050px;margin:auto;padding:20px}h1{margin:.2em 0}.card{background:white;border:1px solid #d8dee6;border-radius:10px;padding:16px;margin:14px 0;overflow:auto}.meta,.phases{display:flex;flex-wrap:wrap;gap:8px}.badge,.pill{padding:4px 9px;border-radius:999px;background:#e5e7eb}.RUNNING{background:#dbeafe;color:#1d4ed8}.WAITING_FOR_HUMAN{background:#fef3c7;color:#92400e}.BLOCKED,.FAILED{background:#fee2e2;color:#b91c1c}.COMPLETED,.PASSED{background:#dcfce7;color:#166534}.PAUSED,.CANCELLED,.PENDING{background:#e5e7eb;color:#4b5563}.NOT_APPLICABLE{background:repeating-linear-gradient(135deg,#eee,#eee 5px,#ddd 5px,#ddd 10px);color:#555}.current{outline:2px solid #111;outline-offset:2px}table{border-collapse:collapse;width:100%}th,td{text-align:left;border-bottom:1px solid #ddd;padding:7px;vertical-align:top}pre{white-space:pre-wrap;word-break:break-word}.open{color:#b91c1c}.resolved{color:#667085}ul{padding-left:22px}</style></head><body><main>
HTML
printf '<h1>Work item %s</h1><div class="card meta">' "$(val '.work_item_id')"
printf '<span class="badge %s">%s</span>' "$(printf %s "$status" | esc)" "$(printf %s "$status" | esc)"
printf '<span>Phase: %s</span><span>Round: %s/%s</span><span>Gate failures: %s/%s</span><span>Updated: %s</span><span>Generated: %s UTC</span></div>\n' "$(val '.phase')" "$(val '.round')" "$(val '.max_rounds')" "$(val '.gate_failures_here')" "$(val '.max_gate_failures')" "$(val '.updated_at')" "$(printf %s "$generated" | esc)"
printf '<section class="card"><h2>Phases</h2><div class="phases">'
for p in $phases; do s=$(jq -r --arg p "$p" '.gates[$p].status // "PENDING"' "$state"); se=$(printf %s "$s"|esc); c=""; [ "$p" != "$current" ] || c=' current'; printf '<span class="pill %s%s">%s · %s</span>' "$se" "$c" "$p" "$se"; done
printf '</div></section>\n<section class="card"><h2>Legal next steps</h2>'
trans=$(jq -r --arg p "$current" '[.green_transitions[]|select(.from==$p)|"green → "+.to], [.rework_transitions[]|select(.from==$p)|"rework → "+.to+" ("+.defect_class+")"]|add|.[]?' "$workflow")
if [ -n "$trans" ]; then printf '<ul>'; while IFS= read -r x; do printf '<li>%s</li>' "$(printf %s "$x" | esc)"; done <<EOF
$trans
EOF
printf '</ul>'; else printf '<p>not available</p>'; fi
printf '</section>\n<section class="card"><h2>Blockers</h2>'
blockers="$loop/blockers.md"
if [ -f "$blockers" ]; then
  found=0
  for kind in open resolved; do while IFS= read -r line; do
    if { [ "$kind" = open ] && case "$line" in '- [ ]'*) true;; *) false;; esac; } || { [ "$kind" = resolved ] && case "$line" in '- [x]'*|'- [X]'*) true;; *) false;; esac; }; then found=1; printf '<div class="%s">%s</div>\n' "$kind" "$(printf %s "$line" | esc)"; fi
  done < "$blockers"; done
  [ "$found" -eq 1 ] || printf '<p>not available</p>'
else printf '<p>not available</p>'; fi
printf '</section>\n<section class="card"><h2>Evidence</h2>'
if [ "$(jq length "$evidence")" -eq 0 ]; then printf '<p>not available</p>'; else
  printf '<table><thead><tr><th>ID</th><th>Phase</th><th>Type</th><th>Result</th><th>Producer</th><th>Captured</th><th>Command details</th></tr></thead><tbody>'
  jq -r '.[]|[.evidence_id,.phase,.evidence_type,.result,.producer,.captured_at,(if .evidence_type=="command" then ((.details.command_id//"")+" / exit "+((.details.exit_code//"")|tostring)+" / "+((.details.duration_milliseconds//"")|tostring)+" ms") else "" end)]|@tsv' "$evidence" |
  while IFS="$(printf '\t')" read -r id p t r producer at details; do printf '<tr><td>%s</td><td>%s</td><td>%s</td><td><span class="badge %s">%s</span></td><td>%s</td><td>%s</td><td>%s</td></tr>' "$(printf %s "$id"|esc)" "$(printf %s "$p"|esc)" "$(printf %s "$t"|esc)" "$(printf %s "$r"|esc)" "$(printf %s "$r"|esc)" "$(printf %s "$producer"|esc)" "$(printf %s "$at"|esc)" "$(printf %s "$details"|esc)"; done
  printf '</tbody></table><p>'; jq -r 'group_by(.result)|map(.[0].result+": "+(length|tostring))|join(" · ")' "$evidence" | esc; printf '</p>'
fi
printf '</section>\n<section class="card"><h2>Gates</h2><table><thead><tr><th>Phase</th><th>Status</th><th>Evidence IDs</th></tr></thead><tbody>'
for p in $phases; do s=$(jq -r --arg p "$p" '.gates[$p].status // "not available"' "$state"); se=$(printf %s "$s"|esc); ids=$(jq -r --arg p "$p" '.gates[$p].evidence_ids // []|join(", ")|if .=="" then "not available" else . end' "$state"); printf '<tr><td>%s</td><td><span class="badge %s">%s</span></td><td>%s</td></tr>' "$p" "$se" "$se" "$(printf %s "$ids"|esc)"; done
printf '</tbody></table></section>\n<section class="card"><details><summary>Work item</summary>'
wid=$(jq -r '.work_item_id // ""' "$state"); wi="$loop/work-items/$wid.md"
if [[ "$wid" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] && [ -f "$wi" ]; then printf '<pre>'; esc < "$wi"; printf '</pre>'; else printf '<p>not available</p>'; fi
printf '</details></section></main></body></html>\n'
} > "$tmp/dashboard.html"
if [ "$output" = - ]; then cat "$tmp/dashboard.html"; else mv "$tmp/dashboard.html" "$output"; fi
