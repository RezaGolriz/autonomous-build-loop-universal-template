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
status=$(jq -r '.run_status' "$state"); current=$(jq -r '.phase' "$state"); wid=$(jq -r '.work_item_id // ""' "$state")
authfile=""; if [[ "$wid" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then authfile="$loop/work-items/$wid.authorization.json"; fi

# Authorization sidecars are read one file at a time, so Bash 3.2 needs no
# associative arrays. Whether an expiry has passed is decided by jq.
auth_state(){ # <file> -> READY | PAUSED | EXPIRED | NONE
  if [ ! -f "$1" ]; then printf NONE; return; fi
  s=$(jq -r '.state // "PAUSED"' "$1" 2>/dev/null || printf PAUSED)
  if [ "$s" != READY ]; then printf PAUSED; return; fi
  e=$(jq -r 'if (.expires_at|type)=="string" then (try ((.expires_at|fromdateiso8601) <= now) catch false) else false end' "$1" 2>/dev/null || printf false)
  if [ "$e" = true ]; then printf EXPIRED; else printf READY; fi
}
auth_field(){ if [ -f "$1" ]; then jq -r "$2 // \"not available\"" "$1" 2>/dev/null | esc; else printf 'not available'; fi; }
log_field(){ printf %s "$1" | tr ' ' '\n' | sed -n "s/^$2=//p" | head -1; }
{
cat <<'HTML'
<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Run dashboard</title><style>
body{margin:0;background:#f7f8fa;color:#17202a;font:15px system-ui,-apple-system,sans-serif}main{max-width:1050px;margin:auto;padding:20px}h1{margin:.2em 0}.card{background:white;border:1px solid #d8dee6;border-radius:10px;padding:16px;margin:14px 0;overflow:auto}.meta,.phases{display:flex;flex-wrap:wrap;gap:8px}.badge,.pill{padding:4px 9px;border-radius:999px;background:#e5e7eb}.RUNNING{background:#dbeafe;color:#1d4ed8}.WAITING_FOR_HUMAN{background:#fef3c7;color:#92400e}.BLOCKED,.FAILED{background:#fee2e2;color:#b91c1c}.COMPLETED,.PASSED{background:#dcfce7;color:#166534}.PAUSED,.CANCELLED,.PENDING{background:#e5e7eb;color:#4b5563}.NOT_APPLICABLE{background:repeating-linear-gradient(135deg,#eee,#eee 5px,#ddd 5px,#ddd 10px);color:#555}.current{outline:2px solid #111;outline-offset:2px}table{border-collapse:collapse;width:100%}th,td{text-align:left;border-bottom:1px solid #ddd;padding:7px;vertical-align:top}pre{white-space:pre-wrap;word-break:break-word}.open{color:#b91c1c}.resolved{color:#667085}ul{padding-left:22px}.READY{background:#dcfce7;color:#166534}.EXPIRED,.flag{background:#fef3c7;color:#92400e}.flag{padding:4px 9px;border-radius:999px;border:1px solid #d9a441}summary{cursor:pointer}.note{color:#667085}.card.hold{background:#fff1f2;border-color:#b91c1c;color:#7f1d1d}.card.hold h2{color:#b91c1c;margin-top:0}</style></head><body><main>
HTML
# A project-wide hold. While .loop/control/hold.json exists nothing automated
# runs in this project, whatever the run status says, so it is the first thing
# on the page. A record that cannot be read is still a hold.
holdfile="$loop/control/hold.json"
if [ -f "$holdfile" ]; then
  hreason=$(jq -r 'if type=="object" and (.reason|type)=="string" then .reason else "the hold record cannot be read" end' "$holdfile" 2>/dev/null || printf 'the hold record cannot be read')
  hat=$(jq -r 'if type=="object" then (.held_at // "not available") else "not available" end' "$holdfile" 2>/dev/null || printf 'not available')
  hby=$(jq -r 'if type=="object" then (.held_by // "not available") else "not available" end' "$holdfile" 2>/dev/null || printf 'not available')
  hitem=$(jq -r 'if type=="object" then (.item_id // "none recorded") else "none recorded" end' "$holdfile" 2>/dev/null || printf 'none recorded')
  printf '<section class="card hold"><h2>PROJECT ON HOLD</h2><p>%s</p><p>Held at %s · held by %s · work item %s</p><p>Start, run, resume, tick, task and scout are refused for every caller that is not a person at an interactive terminal. Reading, cancel and handover stay available. A person takes the hold off with release: the word RELEASE typed at an interactive terminal, or on the local confirmation page.</p></section>\n' \
    "$(printf %s "$hreason" | esc)" "$(printf %s "$hat" | esc)" "$(printf %s "$hby" | esc)" "$(printf %s "$hitem" | esc)"
fi
printf '<h1>Work item %s</h1><div class="card meta">' "$(val '.work_item_id')"
printf '<span class="badge %s">%s</span>' "$(printf %s "$status" | esc)" "$(printf %s "$status" | esc)"
printf '<span>Phase: %s</span><span>Round: %s/%s</span><span>Gate failures: %s/%s</span><span>Updated: %s</span><span>Generated: %s UTC</span></div>\n' "$(val '.phase')" "$(val '.round')" "$(val '.max_rounds')" "$(val '.gate_failures_here')" "$(val '.max_gate_failures')" "$(val '.updated_at')" "$(printf %s "$generated" | esc)"
# How the run executes: the bound copy of the current job, else the machine
# configuration. Chat-hosted execution is named, and so is a review that is not
# independently isolated.
execution_config=""
jobref="$loop/control/current-job.json"
if [ -f "$jobref" ]; then
  jid=$(jq -r '.job_id // ""' "$jobref" 2>/dev/null || true)
  if [[ "$jid" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] && [ -f "$loop/control/jobs/$jid.json" ]; then
    execution_config=$(jq -c '.bound_config // empty' "$loop/control/jobs/$jid.json" 2>/dev/null || true)
  fi
fi
if [ -z "$execution_config" ] && [ -f "$loop/host.local.json" ]; then execution_config=$(jq -c '.' "$loop/host.local.json" 2>/dev/null || true); fi
if [ -n "$execution_config" ]; then
  execution_line=$(printf '%s' "$execution_config" | jq -r 'select(type=="object" and (.host|type)=="string") | (.review_host // .host) as $r |
    if .host=="chat" then (if $r=="chat" then "Execution: chat-hosted (review not independently isolated)" else "Execution: chat-hosted · review: \($r)" end)
    else "Execution: separate CLI process (\(.host)) · review: \($r)" + (if $r=="chat" then " (chat-hosted, not independently isolated)" else "" end) end' 2>/dev/null || true)
  [ -z "$execution_line" ] || printf '<p class="card"><strong>%s</strong></p>\n' "$(printf %s "$execution_line" | esc)"
fi
printf '<section class="card"><h2>Phases</h2><div class="phases">'
for p in $phases; do s=$(jq -r --arg p "$p" '.gates[$p].status // "PENDING"' "$state"); se=$(printf %s "$s"|esc); c=""; [ "$p" != "$current" ] || c=' current'; printf '<span class="pill %s%s">%s · %s</span>' "$se" "$c" "$p" "$se"; done
printf '</div></section>\n<section class="card"><h2>Legal next steps</h2>'
trans=$(jq -r --arg p "$current" '[.green_transitions[]|select(.from==$p)|"green → "+.to], [.rework_transitions[]|select(.from==$p)|"rework → "+.to+" ("+.defect_class+")"]|add|.[]?' "$workflow")
if [ -n "$trans" ]; then printf '<ul>'; while IFS= read -r x; do printf '<li>%s</li>' "$(printf %s "$x" | esc)"; done <<EOF
$trans
EOF
printf '</ul>'; else printf '<p>not available</p>'; fi
printf '</section>\n<section class="card"><h2>Authorization of the current item</h2>'
astate=$(auth_state "$authfile")
if [ "$astate" = NONE ]; then
  printf '<p>not available</p>'
else
  case "$astate" in READY) abadge='<span class="badge READY">READY</span>';; EXPIRED) abadge='<span class="badge EXPIRED">READY · expired</span> <span class="flag">expired: a person has to authorize again</span>';; *) abadge='<span class="badge PAUSED">PAUSED</span>';; esac
  achannel=$(auth_field "$authfile" '.authorized_by')
  if [ "$achannel" = mcp-user ]; then achannel="$achannel <span class=\"flag\">authorized through a chat tool call</span>"; fi
  printf '<div class="meta">%s<span>Expires: %s</span><span>Budget: %s rounds / %s s wall clock</span><span>Stop on first failure: %s</span><span>Authorized by: %s</span><span>Authorized at: %s</span><span>Assurance: %s</span></div>' \
    "$abadge" "$(auth_field "$authfile" '.expires_at')" "$(auth_field "$authfile" '.budget.max_rounds')" "$(auth_field "$authfile" '.budget.max_wall_seconds')" "$(auth_field "$authfile" '.stop_on_first_failure|tostring')" "$achannel" "$(auth_field "$authfile" '.authorized_at')" "$(auth_field "$authfile" '.assurance')"
  printf '<p>Scope: allowed paths</p><ul>'
  paths=$(jq -r '.scope.allowed_paths // [] | .[0:128][]' "$authfile" 2>/dev/null || true)
  if [ -n "$paths" ]; then while IFS= read -r x; do printf '<li>%s</li>' "$(printf %s "$x" | esc)"; done <<EOF
$paths
EOF
  else printf '<li>not available</li>'; fi
  printf '</ul>'
fi
printf '<p class="note">READY means a person decided this item may start when its slot comes. It approves no result and widens no scope.</p>'
# The confirmation policy is written by hand, so it can be wrong. A file that
# does not say what spec/schemas/confirmation-policy.schema.json describes is
# named as an error here; while it is broken the project accepts only a word
# typed at an interactive terminal, and the page says so rather than showing the
# permissive default that is not in force.
cmode=tty-or-local-page; cerror=
if [ -f "$loop/control/policy.json" ]; then
  cerror=$(jq -r '
    if type!="object" then ".loop/control/policy.json must be a JSON object"
    elif ((keys - ["schema_version","human_confirmation","confirmation_page"]) | length) > 0 then ".loop/control/policy.json has unknown field(s): " + ((keys - ["schema_version","human_confirmation","confirmation_page"])|join(", "))
    elif .schema_version != 1 then ".loop/control/policy.json must be a version 1 record"
    elif (has("human_confirmation") and ((.human_confirmation|type) != "string")) then ".loop/control/policy.json human_confirmation must be one of tty-or-local-page, tty-only; remove the key to use the default"
    elif (has("human_confirmation") and ((.human_confirmation as $m | ["tty-or-local-page","tty-only"] | index($m)) == null)) then ".loop/control/policy.json human_confirmation must be one of tty-or-local-page, tty-only"
    elif (has("confirmation_page")|not) then ""
    else .confirmation_page as $p
      # Mirrors confirmationPageProblem in control/common.mjs (IPv6 is checked
      # by shape here; the control layer is authoritative).
      | def ip: test("^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])\\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])$") or (test(":") and test("^[0-9A-Fa-f:.]+$"));
        if ($p|type) != "object" then ".loop/control/policy.json confirmation_page must be an object with listen, advertise and port"
        elif (($p|keys) - ["listen","advertise","port"]|length) > 0 then ".loop/control/policy.json confirmation_page has unknown field(s): " + ((($p|keys) - ["listen","advertise","port"])|join(", "))
        elif (($p.listen|type) != "string") or (($p.listen|ip)|not) then ".loop/control/policy.json confirmation_page.listen must be an IPv4 or IPv6 address"
        elif ($p|has("advertise")) and ((($p.advertise|type) != "string") or (($p.advertise|length) > 253) or ((($p.advertise|ip) or ($p.advertise|test("^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$")))|not)) then ".loop/control/policy.json confirmation_page.advertise must be a host name or IP address without a scheme or a port"
        elif (($p|has("advertise"))|not) and ((($p.listen|test("^127\\.")) or $p.listen == "::1")|not) then ".loop/control/policy.json confirmation_page.advertise is required when listen is not a loopback address"
        elif ($p|has("port")) and ((($p.port|type) != "number") or ($p.port != ($p.port|floor)) or $p.port < 1024 or $p.port > 65535) then ".loop/control/policy.json confirmation_page.port must be an integer from 1024 to 65535"
        else "" end
    end' \
    "$loop/control/policy.json" 2>/dev/null || printf '.loop/control/policy.json cannot be read as a JSON object')
  if [ -n "$cerror" ]; then cmode=tty-only
  else cmode=$(jq -r '.human_confirmation // "tty-or-local-page"' "$loop/control/policy.json"); fi
fi
printf '<p class="note">Assurance local-user-action means a person acting on this machine typed the word, at the terminal or on the local confirmation page. It is not proof of who. Human confirmation mode: %s.</p>' "$(printf %s "$cmode" | esc)"
if [ -z "$cerror" ] && [ "$cmode" != tty-only ] && [ -f "$loop/control/policy.json" ]; then
  corigin=$(jq -r 'if .confirmation_page then .confirmation_page as $p | ($p.advertise // $p.listen) as $h | "http://" + (if ($h|test(":")) then "[" + $h + "]" else $h end) + ":" + (($p.port // "random-port")|tostring) else "" end' "$loop/control/policy.json" 2>/dev/null || :)
  [ -z "$corigin" ] || printf '<p class="note">Confirmation page links point to %s, so they can be opened from a phone inside the private network or VPN. Anyone who can reach that address and has a link can act on it.</p>' "$(printf %s "$corigin" | esc)"
fi
[ -z "$cerror" ] || printf '<p class="note"><span class="flag">INVALID_POLICY</span> %s. Until a person repairs it this project decides nothing through the local page.</p>' "$(printf %s "$cerror" | esc)"
printf '</section>\n<section class="card"><h2>Backlog</h2>'
backlog="$loop/backlog.json"
if [ -f "$backlog" ]; then
  jq -r '(.items // []) | .[0:100][] | [(.id//""),(.title//"not available"),(.work_kind//"not available")] | @tsv' "$backlog" > "$tmp/backlog.tsv" 2>/dev/null || : > "$tmp/backlog.tsv"
  : > "$tmp/backlog.html"; ready=0; paused=0; total=0
  while IFS="$(printf '\t')" read -r bid btitle bkind; do
    [ -n "$bid" ] || continue
    total=$((total+1)); bfile=""
    if [[ "$bid" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then bfile="$loop/work-items/$bid.authorization.json"; fi
    case "$(auth_state "$bfile")" in
      READY) ready=$((ready+1)); bbadge='<span class="badge READY">READY</span>';;
      EXPIRED) paused=$((paused+1)); bbadge='<span class="badge EXPIRED">PAUSED</span> <span class="flag">expired</span>';;
      *) paused=$((paused+1)); bbadge='<span class="badge PAUSED">PAUSED</span>';;
    esac
    printf '<tr><td>%s</td><td>%s</td><td>%s</td><td>%s</td><td>%s</td></tr>' "$(printf %s "$bid"|esc)" "$(printf %s "$btitle"|esc)" "$(printf %s "$bkind"|esc)" "$bbadge" "$(auth_field "$bfile" '.expires_at')" >> "$tmp/backlog.html"
  done < "$tmp/backlog.tsv"
  if [ "$total" -eq 0 ]; then printf '<p>The backlog is empty.</p>'; else
    printf '<p>%s READY · %s PAUSED · %s shown</p>' "$ready" "$paused" "$total"
    printf '<table><thead><tr><th>ID</th><th>Title</th><th>Work kind</th><th>Authorization</th><th>Expires</th></tr></thead><tbody>'
    cat "$tmp/backlog.html"; printf '</tbody></table>'
  fi
else printf '<p>not available</p>'; fi
printf '<p class="note">Queued work only. Nothing here starts on its own; a PAUSED item waits for a person.</p>'
printf '</section>\n<section class="card"><h2>Inbox</h2>'
inbox="$loop/inbox/index.json"
if [ -f "$inbox" ]; then
  count=$(jq -r '(.items // [])|length' "$inbox" 2>/dev/null || printf 0)
  printf '<p>%s proposal(s) waiting for a person</p>' "$(printf %s "$count" | esc)"
  if [ "$count" -gt 0 ]; then
    printf '<table><thead><tr><th>Proposal</th><th>Title</th><th>Created</th><th>Provider</th></tr></thead><tbody>'
    jq -r '(.items // []) | .[0:100][] | [(.id//""),(.title//"not available"),(.created_at//"not available"),(.provider//"not available")] | @tsv' "$inbox" |
    while IFS="$(printf '\t')" read -r pid ptitle pat pprov; do printf '<tr><td>%s</td><td>%s</td><td>%s</td><td>%s</td></tr>' "$(printf %s "$pid"|esc)" "$(printf %s "$ptitle"|esc)" "$(printf %s "$pat"|esc)" "$(printf %s "$pprov"|esc)"; done
    printf '</tbody></table>'
  fi
else printf '<p>not available</p>'; fi
printf '<p class="note">A proposal is inert. It becomes work only when a person promotes it into the backlog.</p>'
printf '</section>\n<section class="card"><h2>Last tick and last scout</h2>'
tickline=""; if [ -f "$loop/scheduler/tick.log" ]; then tickline=$(tail -n 1 "$loop/scheduler/tick.log" 2>/dev/null || true); fi
if [ -n "$tickline" ]; then
  printf '<p>Last tick: %s · action %s · reason %s · item %s · phase %s · run status %s</p>' \
    "$(printf %s "$tickline" | awk '{print $1}' | esc)" "$(log_field "$tickline" action | esc)" "$(log_field "$tickline" reason | esc)" \
    "$(log_field "$tickline" item | esc)" "$(log_field "$tickline" phase | esc)" "$(log_field "$tickline" run_status | esc)"
else printf '<p>Last tick: not available</p>'; fi
scoutline=""; if [ -f "$loop/scheduler/scout.log" ]; then scoutline=$(tail -n 1 "$loop/scheduler/scout.log" 2>/dev/null || true); fi
if [ -n "$scoutline" ]; then
  printf '<p>Last scout: %s</p>' "$(printf %s "$scoutline" | jq -r '"\(.at // "not available") · status \(.status // "not available") · \(.proposals // 0) proposal(s) · provider \(.provider // "not available") · profile \(.profile // "not available")"' 2>/dev/null | esc || printf 'not available')"
else printf '<p>Last scout: not available</p>'; fi
printf '<p class="note">These are log entries, not gate results. A tick may only do what a person authorized before.</p>'
printf '</section>\n<section class="card"><details><summary>Next-steps memory</summary>'
notes="$loop/notes/next-steps.md"
if [ -f "$notes" ]; then printf '<pre>'; esc < "$notes"; printf '</pre>'; else printf '<p>not available</p>'; fi
printf '<p class="note">Advisory only. The note is not an approval and it widens no scope.</p></details>'
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
wi="$loop/work-items/$wid.md"
if [[ "$wid" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] && [ -f "$wi" ]; then printf '<pre>'; esc < "$wi"; printf '</pre>'; else printf '<p>not available</p>'; fi
printf '</details></section></main></body></html>\n'
} > "$tmp/dashboard.html"
if [ "$output" = - ]; then cat "$tmp/dashboard.html"; else mv "$tmp/dashboard.html" "$output"; fi
