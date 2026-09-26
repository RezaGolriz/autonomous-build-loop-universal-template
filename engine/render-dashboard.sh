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
body{margin:0;background:#f7f8fa;color:#17202a;font:15px system-ui,-apple-system,sans-serif}main{max-width:1050px;margin:auto;padding:20px}h1{margin:.2em 0}.card{background:white;border:1px solid #d8dee6;border-radius:10px;padding:16px;margin:14px 0;overflow:auto}.meta,.phases{display:flex;flex-wrap:wrap;gap:8px}.badge,.pill{padding:4px 9px;border-radius:999px;background:#e5e7eb}.RUNNING{background:#dbeafe;color:#1d4ed8}.WAITING_FOR_HUMAN{background:#fef3c7;color:#92400e}.BLOCKED,.FAILED{background:#fee2e2;color:#b91c1c}.COMPLETED,.PASSED{background:#dcfce7;color:#166534}.PAUSED,.CANCELLED,.PENDING{background:#e5e7eb;color:#4b5563}.NOT_APPLICABLE{background:repeating-linear-gradient(135deg,#eee,#eee 5px,#ddd 5px,#ddd 10px);color:#555}.current{outline:2px solid #111;outline-offset:2px}table{border-collapse:collapse;width:100%}th,td{text-align:left;border-bottom:1px solid #ddd;padding:7px;vertical-align:top}pre{white-space:pre-wrap;word-break:break-word}.open{color:#b91c1c}.resolved{color:#667085}ul{padding-left:22px}.READY{background:#dcfce7;color:#166534}.EXPIRED,.flag{background:#fef3c7;color:#92400e}.flag{padding:4px 9px;border-radius:999px;border:1px solid #d9a441}summary{cursor:pointer}.note{color:#667085}.card.hold{background:#fff1f2;border-color:#b91c1c;color:#7f1d1d}.card.hold h2{color:#b91c1c;margin-top:0}.bar{height:14px;border-radius:999px;background:#e5e7eb;overflow:hidden;margin:4px 0 10px}.bar .fill{height:100%;background:#16a34a}.progress tr.done td{color:#166534}.progress tr.now td{background:#eaf2fc;font-weight:600}.progress tr.queued td{color:#6b7280}.dots{display:inline-flex;gap:4px;margin-left:8px;vertical-align:middle}.dot{width:10px;height:10px;border-radius:50%;background:#cbd5e1;display:inline-block}.dot.passed{background:#16a34a}.dot.failed,.dot.blocked{background:#dc2626}</style></head><body><main>
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
# Project progress: done items from .loop/history/<item>-<timestamp>/, the
# current item from state.json, the queued backlog. Mirrors
# control/progress.mjs. Missing or broken inputs are left out, never guessed;
# symlinked inputs are ignored. Pure CSS, no script.
prog_obj(){ if [ -f "$1" ] && [ ! -L "$1" ]; then jq -cs 'if length==1 and (.[0]|type)=="object" then .[0] else {} end' "$1" 2>/dev/null || printf '{}'; else printf '{}'; fi; }
prog_title(){ # <work item file> <id> -> title or empty
  [ -f "$1" ] && [ ! -L "$1" ] || return 0
  t=$(grep -m1 '^#[[:space:]]' "$1" 2>/dev/null | sed -e 's/^#[[:space:]]*//' -e 's/[[:space:]]*$//' || true)
  case "$t" in "$2:"*) t=${t#"$2:"}; t=$(printf %s "$t" | sed 's/^[[:space:]]*//');; esac
  [ -n "$t" ] || t=$(grep -m1 '^Title:' "$1" 2>/dev/null | sed -e 's/^Title:[[:space:]]*//' -e 's/[[:space:]]*$//' || true)
  printf %s "$t" | cut -c1-200
}
prog_auth(){ # <file> <id> -> READY | PAUSED | INVALID | NONE
  if [ -L "$1" ]; then printf INVALID; return; fi
  if [ ! -e "$1" ]; then printf NONE; return; fi
  jq -r --arg id "$2" 'if type=="object" and .schema_version==1 and .item_id==$id and (.state=="READY" or .state=="PAUSED") then
      (if .state=="READY" and (.expires_at|type)=="string" and (try ((.expires_at|fromdateiso8601) > now) catch false) then "READY" else "PAUSED" end)
    else "INVALID" end' "$1" 2>/dev/null || printf INVALID
}
idre='^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
: > "$tmp/done.jsonl"
if [ -d "$loop/history" ] && [ ! -L "$loop/history" ]; then
  for h in "$loop"/history/*; do
    [ -d "$h" ] && [ ! -L "$h" ] || continue
    hname=$(basename "$h")
    hstamp=$(printf %s "$hname" | sed -n 's/^[A-Za-z0-9][A-Za-z0-9._-]*-\([0-9]\{8\}T[0-9]\{6\}Z\)$/\1/p')
    [ -n "$hstamp" ] || continue
    hid=${hname%-"$hstamp"}; hst=$(prog_obj "$h/state.json"); hacc=$(prog_obj "$h/acceptance.json")
    sid=$(printf %s "$hst" | jq -r '.work_item_id // "" | tostring' 2>/dev/null || true)
    if [[ "$sid" =~ $idre ]]; then hid=$sid; fi
    jq -cn --arg id "$hid" --arg stamp "$hstamp" --arg name "$hname" --arg title "$(prog_title "$h/$hid.md" "$hid")" --argjson s "$hst" --argjson a "$hacc" '{
      id:$id, stamp:$stamp, name:$name, title:(if $title=="" then null else $title end),
      accepted_at:(if ($a.accepted_at|type)=="string" then $a.accepted_at else ($stamp|"\(.[0:4])-\(.[4:6])-\(.[6:8])T\(.[9:11]):\(.[11:13]):\(.[13:15])Z") end),
      rounds:(if ($s.round|type)=="number" and $s.round==($s.round|floor) then $s.round else null end),
      gates:(if $s=={} then null else ([ "DEFINE","DESIGN","EXECUTE","REVIEW","VALIDATE","HANDOVER" ]|map({key:., value:($s.gates[.].status? // "PENDING" | if type=="string" then . else "PENDING" end)})|from_entries) end)}' >> "$tmp/done.jsonl" 2>/dev/null || true
  done
fi
cur_title=""; if [[ "$wid" =~ $idre ]]; then cur_title=$(prog_title "$loop/work-items/$wid.md" "$wid"); fi
: > "$tmp/queued.jsonl"
if [ -f "$loop/backlog.json" ] && [ ! -L "$loop/backlog.json" ]; then
  jq -r '(.items // []) | .[0:1000][] | [((.id // "")|tostring), (if (.title|type)=="string" then .title else "" end)] | @tsv' "$loop/backlog.json" 2>/dev/null > "$tmp/progress-backlog.tsv" || : > "$tmp/progress-backlog.tsv"
  while IFS="$(printf '\t')" read -r qid qtitle; do
    [[ "$qid" =~ $idre ]] || continue
    jq -cn --arg id "$qid" --arg title "$qtitle" --arg auth "$(prog_auth "$loop/work-items/$qid.authorization.json" "$qid")" '{id:$id, title:(if $title=="" then null else $title end), authorization:$auth}' >> "$tmp/queued.jsonl"
  done < "$tmp/progress-backlog.tsv"
fi
pinbox=0
if [ -d "$loop/inbox" ] && [ ! -L "$loop/inbox" ]; then
  if [ -f "$loop/inbox/index.json" ] && [ ! -L "$loop/inbox/index.json" ] && jq -e '(.items|type)=="array"' "$loop/inbox/index.json" >/dev/null 2>&1; then pinbox=$(jq '.items|length' "$loop/inbox/index.json")
  else pinbox=$(find "$loop/inbox" -maxdepth 1 -type f -name '*.md' | wc -l | tr -d ' '); fi
fi
jq -n --slurpfile done "$tmp/done.jsonl" --slurpfile queued "$tmp/queued.jsonl" --argjson s "$(prog_obj "$state")" --arg ctitle "$cur_title" --arg idre "$idre" --argjson inbox "$pinbox" '
  ($done|sort_by(.stamp, .name)|.[-1000:]|map(del(.stamp, .name))) as $d
  | ($d|map(.id)) as $ids
  | (if ($s.work_item_id|type)=="string" and ($s.work_item_id|test($idre)) and (($s.run_status=="COMPLETED" and ($ids|index($s.work_item_id)) != null)|not) then
      {id:$s.work_item_id, title:(if $ctitle=="" then null else $ctitle end), phase:(if ($s.phase|type)=="string" then $s.phase else null end),
       round:(if ($s.round|type)=="number" then $s.round else null end), max_rounds:(if ($s.max_rounds|type)=="number" then $s.max_rounds else null end),
       run_status:(if ($s.run_status|type)=="string" then $s.run_status else null end),
       gates:([ "DEFINE","DESIGN","EXECUTE","REVIEW","VALIDATE","HANDOVER" ]|map({key:., value:($s.gates[.].status? // "PENDING" | if type=="string" then . else "PENDING" end)})|from_entries)}
    else null end) as $c
  | ($queued|map(select(.id != ($c.id // "")))) as $q
  | {done:($d|length), in_progress:(if $c then 1 else 0 end), queued:($q|length)} as $t
  | ($t + {total:($t.done+$t.in_progress+$t.queued)}) as $t
  | {schema_version:1, totals:$t, percent:(if $t.total>0 then ($t.done*100/$t.total + 0.5|floor) else 0 end), done:$d, current:$c, queued:$q, inbox:$inbox}' > "$tmp/progress.json" 2>/dev/null || printf 'null\n' > "$tmp/progress.json"
jq -r '
  def na: if . == null then "not available" else tostring end | @html;
  def dots($g): "<span class=\"dots\">" + ([ "DEFINE","DESIGN","EXECUTE","REVIEW","VALIDATE","HANDOVER" ]|map(. as $p | ($g[$p] // "PENDING") as $st | "<span class=\"dot " + (if ($st|test("^(PASSED|FAILED|BLOCKED)$")) then ($st|ascii_downcase) else "pending" end) + "\" title=\"" + ($p|@html) + " · " + ($st|@html) + "\"></span>")|join("")) + "</span>";
  if . == null then "<section class=\"card progress\"><h2>Project progress</h2><p>not available</p></section>" else
  . as $p
  | ([ ($p.done[] | "<tr class=\"done\"><td>\(.id|na)</td><td>\(.title|na)</td><td><span class=\"badge PASSED\">DONE</span></td><td>accepted \(.accepted_at|if type=="string" then .[0:10] else null end|na) · \(if .rounds==null then "rounds not available" else "\(.rounds|na) round(s)" end)</td></tr>"),
       ($p.current // empty | "<tr class=\"now\"><td>\(.id|na)</td><td>\(.title|na)</td><td><span class=\"badge RUNNING\">IN PROGRESS</span></td><td>\(.phase|na) · round \(.round|na) \(dots(.gates))</td></tr>"),
       ($p.queued[] | "<tr class=\"queued\"><td>\(.id|na)</td><td>\(.title|na)</td><td><span class=\"badge \(if .authorization=="READY" then "READY" else "PAUSED" end)\">\(.authorization|na)</span></td><td>queued</td></tr>") ] | join("")) as $rows
  | "<section class=\"card progress\"><h2>Project progress</h2><div class=\"bar\"><div class=\"fill\" style=\"width:\($p.percent)%\"></div></div><p><strong>\($p.totals.done) of \($p.totals.total) items done</strong> · \($p.totals.in_progress) in progress · \($p.totals.queued) queued · \($p.percent)%" + (if $p.inbox > 0 then " · \($p.inbox) proposal(s) in the inbox" else "" end) + "</p>"
    + (if $rows == "" then "<p>not available</p>" else "<details><summary>Items</summary><table><thead><tr><th>ID</th><th>Title</th><th>State</th><th>Detail</th></tr></thead><tbody>" + $rows + "</tbody></table></details>" end) + "</section>" end' "$tmp/progress.json" 2>/dev/null || printf '<section class="card progress"><h2>Project progress</h2><p>not available</p></section>'
printf '\n'
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
