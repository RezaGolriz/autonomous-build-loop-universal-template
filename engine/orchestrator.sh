#!/usr/bin/env bash
# Orchestrator core: drives one bounded node per phase and delegates every gate
# decision to engine/reference-engine.sh. It never re-implements a gate.
set -euo pipefail

self_dir=$(cd "$(dirname "$0")" && pwd -P)
engine="$self_dir/reference-engine.sh"
repo_root=$(cd "$self_dir/.." && pwd -P)
. "$self_dir/common.sh"
. "$self_dir/next-steps.sh"
die(){ echo "ERROR: $1" >&2; exit "${2:-64}"; }
need(){ command -v "$1" >/dev/null 2>&1 || die "missing executable: $1" 69; }
need jq; need git; need shasum
[ -x "$engine" ] || die 'reference engine missing' 69

mode=${1:-}; [ -n "$mode" ] || die 'mode required'; shift
root= host= provider= review_host= review_provider= max_nodes=1
while [ $# -gt 0 ]; do
  case "$1" in
    --root) root=$2; shift 2;; --host) host=$2; shift 2;; --provider) provider=$2; shift 2;;
    --review-host) review_host=$2; shift 2;; --review-provider) review_provider=$2; shift 2;;
    --max-nodes) max_nodes=$2; shift 2;; *) die "unknown argument: $1";;
  esac
done
[ -n "$root" ] || die '--root is required'
[ -d "$root" ] || die 'root directory missing' 65
root=$(cd "$root" && pwd -P)
loop="$root/.loop"; state="$loop/state.json"; adapter_file="$loop/project.adapter.json"
workflow_file="$loop/workflow.json"; [ -f "$workflow_file" ] || workflow_file="$repo_root/core/workflow.json"
evidence_dir="$loop/evidence"
prov_abs=$provider; case "$provider" in ''|/*) ;; *) prov_abs="$PWD/$provider";; esac
review_prov_abs=$review_provider; case "$review_provider" in ''|/*) ;; *) review_prov_abs="$PWD/$review_provider";; esac

now(){ date -u '+%Y-%m-%dT%H:%M:%SZ'; }
lower(){ printf '%s' "$1" | tr 'A-Z' 'a-z'; }
head_rev(){ git -C "$root" rev-parse HEAD 2>/dev/null || echo unversioned; }

validate_state(){ loop_validate_state "$1"; }

write_state(){
  local tmp
  tmp=$(mktemp "$loop/.state.XXXXXX")
  jq "$@" "$state" > "$tmp" || { rm -f "$tmp"; die 'state update failed'; }
  validate_state "$tmp" || { rm -f "$tmp"; die 'resulting state invalid'; }
  chmod --reference="$state" "$tmp" 2>/dev/null || :
  mv "$tmp" "$state"
}

acquire_orchestrator_lock(){
  [ ! -e "$loop/engine.lock" ] || die 'workspace is already locked' 73
  olock="$loop/orchestrator.lock"
  olock_operation=$1
  mkdir "$olock" 2>/dev/null || die 'another orchestrator or control mutation is active' 73
  jq -n --arg operation "$olock_operation" --argjson pid "$$" --arg at "$(now)" \
    '{schema_version:1,owner:"shell-orchestrator",operation:$operation,pid:$pid,acquired_at:$at}' > "$olock/owner.json"
  trap 'release_orchestrator_lock' EXIT INT TERM
}

release_orchestrator_lock(){
  [ -n "${olock:-}" ] || return 0
  rm -f "$olock/owner.json" 2>/dev/null || :
  rmdir "$olock" 2>/dev/null || :
  olock=
  olock_operation=
}

open_blockers(){ [ -f "$loop/blockers.md" ] || { echo 0; return; }; awk 'index($0,"- [ ]"){c++} END{print c+0}' "$loop/blockers.md"; }

cap_reason(){
  local started elapsed
  [ "$(jq -r .round "$state")" -lt "$(jq -r .max_rounds "$state")" ] || { echo 'round cap reached'; return; }
  [ "$(jq -r .gate_failures_here "$state")" -lt "$(jq -r .max_gate_failures "$state")" ] || { echo 'retry cap reached'; return; }
  started=$(jq -r '.started_epoch // 0' "$state")
  [ "$started" -gt 0 ] || { echo 'running state has no start time'; return; }
  elapsed=$(( $(date +%s) - started ))
  [ "$elapsed" -le "$(jq -r .max_wall_seconds "$state")" ] || { echo 'wall clock cap reached'; return; }
}

# RFC 3339 to epoch seconds, accepting exactly what the Node control layer
# accepts: an optional fractional second and either Z or a real numeric offset.
# jq's fromdateiso8601 understands neither, so Perl does the arithmetic. An
# invalid shape or an out-of-range component is rejected with a non-zero status,
# the same way Date.parse rejects it. Bash 3.2: no mapfile, no associative arrays.
iso_to_epoch(){ # <timestamp> -> epoch seconds on stdout
  perl -MTime::Local=timegm -e '
    my $v = $ARGV[0];
    $v =~ /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/ or exit 1;
    my ($Y,$M,$D,$h,$m,$s,$z) = ($1,$2,$3,$4,$5,$6,$7);
    exit 1 if $M < 1 || $M > 12 || $D < 1 || $m > 59 || $s > 59;
    my @len = (31,28,31,30,31,30,31,31,30,31,30,31);
    my $leap = ($Y % 4 == 0 && ($Y % 100 != 0 || $Y % 400 == 0)) ? 1 : 0;
    my $days = $len[$M-1] + ($M == 2 ? $leap : 0);
    exit 1 if $D > $days;
    exit 1 if $h > 24 || ($h == 24 && ($m || $s));
    my $t = timegm(0, 0, 0, $D, $M-1, $Y) + $h*3600 + $m*60 + $s;
    if ($z !~ /^[Zz]$/) {
      my ($sign,$oh,$om) = $z =~ /^([+-])(\d{2}):(\d{2})$/;
      exit 1 if $oh > 23 || $om > 59;
      my $off = $oh*3600 + $om*60;
      $t += ($sign eq "-" ? $off : -$off);
    }
    print "$t\n";
  ' -- "$1" 2>/dev/null
}

# The item a sidecar belongs to, taken from its file name. A decision is only
# ever about the item it names, so this is what the record has to agree with.
authorization_item_of(){ # <path>/<id>.authorization.json -> <id>
  local base
  base=${1##*/}
  printf '%s' "${base%.authorization.json}"
}

# The structural half of the authorization rules, exactly as the Node control
# layer validates them: version 1, no field the schema does not know, a state of
# READY or PAUSED, an item_id that is the item whose sidecar this is, a known
# human channel, RFC 3339 timestamps, a scope of safe relative paths, and integer
# budgets inside their documented ranges. A key the schema does not describe is a
# record somebody wrote by hand and got wrong, never a record with a harmless
# extra. Every record goes through this, whatever its state: a PAUSED record that
# does not validate is a broken record, not an inert one, and both layers have to
# see the same brokenness.
#
# Scope, budget, expiry and stop_on_first_failure are what a READY record needs
# in order to bound anything, so a READY record without them does not validate.
# In a PAUSED record they are optional, and each one that is there is still
# checked, because it is what bounds a run a person starts by hand.
authorization_structure_ok(){ # <sidecar> <expected-item-id>
  jq -e --arg id "$2" '
    def ts: type=="string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}[Tt][0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?([Zz]|[+-][0-9]{2}:[0-9]{2})$");
    def int(a;b): type=="number" and floor==. and .>=a and .<=b;
    def safepath: type=="string" and length>0 and length<=1024
      and (test("^/")|not) and (test("(^|[/\\\\])[.][.]([/\\\\]|$)")|not)
      and (test("[[:cntrl:]|`,;]")|not);
    type=="object"
      and ((keys - ["schema_version","item_id","state","scope","budget","expires_at","stop_on_first_failure","authorized_by","authorized_at","assurance","note"])|length)==0
      and .schema_version==1 and (.state=="READY" or .state=="PAUSED")
      and (.item_id|type=="string" and test("^[A-Za-z0-9][A-Za-z0-9._-]*$")) and .item_id==$id
      and (.authorized_by as $c|["interactive-tty","local-http-user","cli-input","mcp-user"]|index($c)!=null)
      and (.authorized_at|ts)
      and ((has("expires_at")|not) or (.expires_at|ts))
      and ((has("scope")|not) or ((.scope|type=="object") and ((.scope|keys)==["allowed_paths"])
        and (.scope.allowed_paths|type=="array" and length>0 and length<=128 and (unique|length)==length and all(.[];safepath))))
      and ((has("budget")|not) or ((.budget|type=="object") and ((.budget|keys)==["max_rounds","max_wall_seconds"])
        and (.budget.max_rounds|int(1;500)) and (.budget.max_wall_seconds|int(60;604800))))
      and ((has("stop_on_first_failure")|not) or (.stop_on_first_failure|type=="boolean"))
      and ((has("assurance")|not) or .assurance=="local-user-action")
      and ((has("note")|not) or (.note|type=="string" and length>0 and length<=20000))
      and (.state!="READY" or (has("scope") and has("budget") and has("expires_at") and has("stop_on_first_failure")))' "$1" >/dev/null 2>&1
}

# Whether a sidecar is a record at all: structurally valid and carrying
# timestamps that name real moments. It says nothing about what the record
# allows; a valid PAUSED record allows nothing by itself.
authorization_valid(){ # <sidecar>
  local expiry
  [ -f "$1" ] && [ ! -L "$1" ] || return 1
  authorization_structure_ok "$1" "$(authorization_item_of "$1")" || return 1
  iso_to_epoch "$(jq -r '.authorized_at' "$1" 2>/dev/null)" >/dev/null || return 1
  expiry=$(jq -r '.expires_at // empty' "$1" 2>/dev/null) || return 1
  [ -z "$expiry" ] || iso_to_epoch "$expiry" >/dev/null || return 1
  return 0
}

# READY or PAUSED for one authorization sidecar, under exactly the rules the
# Node control layer applies. A record that cannot be read, does not validate,
# names another item, or whose timestamps cannot be parsed or whose expiry has
# passed is PAUSED, never READY. Both timestamps go through the same calendar
# check, so an impossible date such as 2099-02-30 is refused in either layer.
authorization_state(){
  local epoch
  authorization_valid "$1" || { echo PAUSED; return; }
  jq -e '.state=="READY"' "$1" >/dev/null 2>&1 || { echo PAUSED; return; }
  epoch=$(iso_to_epoch "$(jq -r '.expires_at' "$1" 2>/dev/null)") || { echo PAUSED; return; }
  [ -n "$epoch" ] || { echo PAUSED; return; }
  if [ "$epoch" -gt "$(date +%s)" ]; then echo READY; else echo PAUSED; fi
}

# Backlog counts, read from the same files the Node control layer uses so both
# layers report the same numbers.
backlog_counts(){
  local file="$loop/backlog.json" sidecar id st ready=0 paused=0 total=0
  if [ -f "$file" ]; then
    while IFS= read -r id; do
      [ -n "$id" ] || continue
      total=$((total + 1))
      st=PAUSED
      sidecar="$loop/work-items/$id.authorization.json"
      if [ -f "$sidecar" ]; then st=$(authorization_state "$sidecar"); fi
      if [ "$st" = READY ]; then ready=$((ready + 1)); else paused=$((paused + 1)); fi
    done <<EOF
$(jq -r '(.items // [])[]? | .id // empty' "$file" 2>/dev/null || :)
EOF
  fi
  jq -n --argjson r "$ready" --argjson p "$paused" --argjson t "$total" '{ready:$r,paused:$p,total:$t}'
}

# The authorization sidecar of the current work item, or null when there is none.
current_authorization(){
  local id sidecar
  id=$(jq -r '.work_item_id // empty' "$state" 2>/dev/null || :)
  [ -n "$id" ] || { echo null; return; }
  sidecar="$loop/work-items/$id.authorization.json"
  if [ -f "$sidecar" ] && jq -e 'type=="object"' "$sidecar" >/dev/null 2>&1; then cat "$sidecar"; else echo null; fi
}

# The authorization boundary for this node, captured once before the provider
# runs and kept in variables for the checks after it. Capturing it up front is
# what makes the boundary honest: an expiry that passes, or a record that is
# edited, while the node runs can no longer turn the check off.
#
# auth_kind is one of:
#   none    no sidecar exists; the run is human-driven and the slice table is
#           the only path boundary, exactly as before authorizations existed.
#   paused  a valid PAUSED record: a decision that was withdrawn or never given.
#           It grants nothing, so only a person may run under it; whatever scope
#           and budget it does carry stay the outer boundary of that run.
#   ready   a valid READY record whose expiry is still in the future; its
#           allowed paths are the outer boundary for this node.
#   error   anything else: unreadable, invalid, or a READY record that has
#           expired or whose expiry cannot be parsed. The node does not run.
auth_kind=none
auth_scope=
auth_item=

# The budget a person agreed to is a cap on the run, not a number that sits in
# the sidecar unread. The effective limits are the smaller of what the state
# records and what the decision allows, and when the decision is the smaller one
# it is written into state.json — exactly as the Node control layer does — so
# every later check, this orchestrator's own cap checks included, uses the
# authorized limit. Rounds already used and time already spent are never reset:
# only the caps change, and they can only ever move down.
apply_authorized_caps(){ # <sidecar>
  local ar aw sr sw er ew
  ar=$(jq -r '.budget.max_rounds' "$1" 2>/dev/null || :)
  aw=$(jq -r '.budget.max_wall_seconds' "$1" 2>/dev/null || :)
  case "$ar$aw" in ''|*[!0-9]*) return 0;; esac
  sr=$(jq -r '.max_rounds' "$state"); sw=$(jq -r '.max_wall_seconds' "$state")
  er=$sr; ew=$sw
  if [ "$ar" -lt "$er" ]; then er=$ar; fi
  if [ "$aw" -lt "$ew" ]; then ew=$aw; fi
  if [ "$er" != "$sr" ] || [ "$ew" != "$sw" ]; then
    write_state --argjson r "$er" --argjson w "$ew" --arg n "$(now)" '.max_rounds=$r|.max_wall_seconds=$w|.updated_at=$n'
  fi
}

capture_authorization(){
  local sidecar st
  auth_kind=none; auth_scope=; auth_item=
  auth_item=$(jq -r '.work_item_id // empty' "$state" 2>/dev/null || :)
  [ -n "$auth_item" ] || return 0
  sidecar="$loop/work-items/$auth_item.authorization.json"
  [ -e "$sidecar" ] || return 0
  # Every record is validated in full, whatever state it claims. A PAUSED record
  # that does not validate is a broken record, and a broken record is never a
  # shortcut past the checks a whole one would have to pass.
  authorization_valid "$sidecar" || { auth_kind=error; return 0; }
  st=$(jq -r '.state // empty' "$sidecar" 2>/dev/null || :)
  if [ "$st" = PAUSED ]; then
    auth_kind=paused
    # A withdrawn decision still says what a person once agreed to. It permits
    # nothing on its own, but for the run a person starts by hand it is the
    # outer boundary: its paths are enforced and its budget only ever narrows.
    auth_scope=$(jq -r '.scope.allowed_paths[]?' "$sidecar" 2>/dev/null || :)
    apply_authorized_caps "$sidecar"
    return 0
  fi
  [ "$st" = READY ] || { auth_kind=error; return 0; }
  if [ "$(authorization_state "$sidecar")" = READY ]; then
    auth_kind=ready
    auth_scope=$(jq -r '.scope.allowed_paths[]?' "$sidecar" 2>/dev/null || :)
    if [ -n "$auth_scope" ]; then apply_authorized_caps "$sidecar"; else auth_kind=error; fi
  else
    auth_kind=error
  fi
}

# Is a person doing this? Only two things count. Standard input is a terminal,
# which is somebody sitting at a shell; or the managed job that invoked this
# orchestrator was itself started through a human channel, which the control
# layer records in .loop/control/current-job.json under the runner-owned control
# directory that a provider may never write.
#
# BUILD_LOOP_HUMAN_TTY=1 is a documented override for test suites and headless
# terminals that cannot give the orchestrator a pseudo-terminal. It is refused
# whenever a managed job is in play, so the Node worker can never use it; the
# worker also removes the name from the environment it passes down.
human_entry_present(){
  local current
  if [ -n "${LOOP_JOB_ID:-}" ]; then
    current="$loop/control/current-job.json"
    [ -f "$current" ] && [ ! -L "$current" ] || return 1
    jq -e --arg job "$LOOP_JOB_ID" --arg id "$auth_item" \
      '.job_id==$job and (.human_entry|type=="object") and .human_entry.item_id==$id and .human_entry.channel=="interactive-tty"' \
      "$current" >/dev/null 2>&1 || return 1
    return 0
  fi
  [ -t 0 ] && return 0
  [ "${BUILD_LOOP_HUMAN_TTY:-}" = 1 ] && return 0
  return 1
}

# A withdrawn or never-given decision means a person has to act. Starting,
# resuming or running an item whose sidecar says PAUSED is refused for every
# automated entry point; a person at a terminal may still do it, under the scope
# and budget the record carries. This is the same rule the Node control layer
# applies at start, run and resume.
require_authorized_entry(){
  [ "$auth_kind" = paused ] || return 0
  human_entry_present && return 0
  die "AUTHORIZATION_REVOKED: the authorization for ${auth_item:-the current work item} is PAUSED, so a person has to act: authorize the item again, or start it from an interactive terminal" 77
}

# A project-wide hold. One file under the runner-owned control directory means
# "stop everything in this project": every automated entry point is refused,
# whatever the work item is called, so writing a fresh work item is no way out.
# The same rule as require_authorized_entry decides who may still work here: a
# person at a terminal, or a managed job the control layer recorded a human
# entry for. Even then the hold is printed, because a person should know that
# the project they are working in is stopped.
#
# A hold record that cannot be read is still a hold. Reading, cancelling and
# acknowledging a handover stay available; only a person removes the file, with
# the release operation.
project_hold_reason(){
  local file="$loop/control/hold.json"
  [ -f "$file" ] && [ ! -L "$file" ] || return 1
  jq -r 'if type=="object" and (.reason|type)=="string" and (.reason|length)>0 then .reason else "the hold record cannot be read as a hold reason" end' "$file" 2>/dev/null \
    || printf '%s' 'the hold record cannot be read as a hold reason'
  return 0
}

require_no_project_hold(){
  local reason
  reason=$(project_hold_reason) || return 0
  if human_entry_present; then
    echo "WARNING: this project is on hold ($reason). You are continuing as a person; nothing automated may run here until the hold is released." >&2
    return 0
  fi
  die "PROJECT_ON_HOLD: this project is on hold ($reason). A person releases it with the word RELEASE, at an interactive terminal or on the local confirmation page; cancel and handover stay available." 77
}

# Fail closed. A node never runs under a decision that cannot be read, does not
# validate, or has run out; the run goes BLOCKED so a person looks at it.
require_usable_authorization(){
  [ "$auth_kind" = error ] || return 0
  go_blocked "authorization invalid or expired for ${auth_item:-the current work item}" \
    'repair or renew the authorization sidecar, then resume'
}

# The boundary as it was captured before the node. Used after the node too, so
# an authorization that expires mid-node is still enforced for what that node
# did — and require_usable_authorization then blocks anything further.
authorized_scope(){ printf '%s' "$auth_scope"; }

# Conservative coverage test: a path is inside the scope when it matches a
# pattern, or when a pattern names a directory prefix of it.
path_in_scope(){ # path scope-text
  local p=$1 patterns=$2 pat prefix
  while IFS= read -r pat; do
    [ -n "$pat" ] || continue
    [ "$p" = "$pat" ] && return 0
    # A pattern that names a directory, with or without a trailing glob, covers
    # everything under it. The suffixes are matched literally, not as globs.
    prefix=$pat
    case "$pat" in
      *"/**") prefix=${pat%"/**"} ;;
      *"/*") prefix=${pat%"/*"} ;;
      *"/") prefix=${pat%"/"} ;;
    esac
    [ "$p" = "$prefix" ] && return 0
    case "$p" in "$prefix"/*) return 0;; esac
    # Otherwise the pattern has to match the path itself.
    [[ "$p" == $pat ]] && return 0
  done <<EOF
$patterns
EOF
  return 1
}

# Every path the slice table declares has to be covered by the authorization.
# A slice that reaches outside it fails the DESIGN gate instead of being run.
slice_paths_outside_scope(){ # scope-text
  local patterns=$1 n i p outside=""
  n=$(slice_count)
  i=1
  while [ "$i" -le "$n" ]; do
    while IFS= read -r p; do
      p=$(printf '%s' "$p" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
      [ -n "$p" ] || continue
      path_in_scope "$p" "$patterns" || outside="$outside $p"
    done <<EOF
$(slice_col "$i" 2 || true)
EOF
    i=$((i+1))
  done
  printf '%s' "$(printf '%s' "$outside" | sed 's/^ //')"
}

# After a node that may change files: every changed path outside .loop must be
# covered by the authorization. The runner-owned .loop paths are checked by the
# protected snapshot instead.
enforce_authorized_change_scope(){
  local patterns=$1 p outside=""
  [ -n "$patterns" ] || return 0
  "$engine" snapshot --root "$root" --output "$tmp/scope-after.json"
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    case "$p" in .loop/*) continue;; esac
    path_in_scope "$p" "$patterns" || { outside=$p; break; }
  done < <(changed_paths "$tmp/baseline.json" "$tmp/scope-after.json")
  [ -z "$outside" ] || {
    write_orch_evidence "$run_id-scope" artifact FAILED "Changed path outside authorized scope: $outside"
    ev_ids="$ev_ids $run_id-scope"
    go_blocked "changed path outside authorized scope: $outside" 'widen the authorized scope or revert the change'
  }
}

# The classification the Node control layer reports next to the raw record:
# READY, PAUSED, INVALID, EXPIRED, or none when the item has no sidecar at all.
current_authorization_state(){
  local id sidecar
  id=$(jq -r '.work_item_id // empty' "$state" 2>/dev/null || :)
  [ -n "$id" ] || { echo none; return; }
  sidecar="$loop/work-items/$id.authorization.json"
  [ -e "$sidecar" ] || { echo none; return; }
  authorization_valid "$sidecar" || { echo INVALID; return; }
  case "$(jq -r '.state // empty' "$sidecar" 2>/dev/null || :)" in
    PAUSED) echo PAUSED;;
    READY) if [ "$(authorization_state "$sidecar")" = READY ]; then echo READY; else echo EXPIRED; fi;;
    *) echo INVALID;;
  esac
}

# The project hold as JSON, or null. Same file the control layer writes.
current_hold(){
  local file="$loop/control/hold.json"
  if [ -f "$file" ] && [ ! -L "$file" ] && jq -e 'type=="object"' "$file" >/dev/null 2>&1; then
    jq -c '{held:true,held_at:(.held_at//null),held_by:(.held_by//null),reason:(.reason//null),item_id:(.item_id//null)}' "$file"
  elif [ -e "$file" ]; then
    jq -nc '{held:true,held_at:null,held_by:null,reason:"the hold record cannot be read",item_id:null}'
  else
    echo null
  fi
}

print_status(){
  jq -n --slurpfile s "$state" --slurpfile w "$workflow_file" --argjson ob "$(open_blockers)" \
    --argjson backlog "$(backlog_counts)" --argjson authorization "$(current_authorization)" \
    --arg authorization_state "$(current_authorization_state)" --argjson hold "$(current_hold)" '
    $s[0] as $st | (["DEFINE","DESIGN","EXECUTE","REVIEW","VALIDATE","HANDOVER"]|map(select($st.gates[.].status=="PASSED" or $st.gates[.].status=="FAILED"))|last) as $lp | {
      work_item_id:$st.work_item_id, phase:$st.phase, run_status:$st.run_status, round:$st.round,
      gate_failures_here:$st.gate_failures_here, gates:$st.gates,
      legal_next:{green:[$w[0].green_transitions[]|select(.from==$st.phase)|.to],
                  rework:[$w[0].rework_transitions[]|select(.from==$st.phase)|{to,defect_class}]},
      open_blockers:$ob, backlog:$backlog, authorization:$authorization,
      authorization_state:$authorization_state, hold:$hold,
      last_evidence_ids:(if $lp==null then [] else $st.gates[$lp].evidence_ids end)}'
}

phase_task(){ case "$1" in
  DEFINE) echo 'Write testable acceptance criteria and explicit exclusions into the work item.';;
  DESIGN) echo 'Write the design and the independently provable execution slices into the work item.';;
  EXECUTE) echo 'Produce the declared artifact for the current slice inside the allowed paths only.';;
  REVIEW) echo 'Review the exact durable change and the referenced evidence, then return a verdict.';;
  VALIDATE) echo 'Run the configured verification commands and confirm acceptance and regression behaviour. This node is READ-ONLY: change no file at all (not even the work item); the engine records the evidence and rejects any change in this phase.';;
  HANDOVER) echo 'Record revision, evidence, limitations and the next human decision in the work item.';;
esac; }
phase_success(){ case "$1" in
  DEFINE) echo 'Acceptance criteria and out-of-scope sections are non-empty and independently verifiable.';;
  DESIGN) echo 'Design and execution slices sections are non-empty and every slice names a deterministic proof.';;
  EXECUTE) echo 'Configured verifier commands pass and no frozen or protected path changed.';;
  REVIEW) echo 'An independent verdict passes with no open blocking or high finding.';;
  VALIDATE) echo 'Every required evidence type is present and passing.';;
  HANDOVER) echo 'The handover section is non-empty and the run stops for a human decision.';;
esac; }

host_card(){ local card_host=${use_host:-$host}; for f in "$repo_root/hosts/$card_host/CLAUDE.md" "$repo_root/hosts/$card_host/AGENTS.md"; do [ -f "$f" ] && { cat "$f"; return 0; }; done; :; }

# Rows of the work item "## Execution slices" table (header and rule rows skipped).
slice_rows(){
  awk '
    /^## / { insec = ($0 ~ /^## Execution slices/); next }
    !insec { next }
    /^[ \t]*\|/ { n=split($0, f, "|"); if (n < 3) next; v=f[2]; gsub(/^[ \t]+|[ \t]+$/, "", v);
      if (v=="" || v ~ /^-+$/ || v=="Slice") next; print $0 }' "$wi"
}
slice_count(){ slice_rows | awk 'END{print NR}'; }
# Column COL of slice row N; commas separate entries, backticks and blanks are stripped.
slice_col(){ # row col
  slice_rows | awk -v row="$1" -v col="$2" 'NR==row { n=split($0, f, "|"); if (col+1 <= n) print f[col+1] }' | tr ',;' '\n\n' | tr -d '`'
}
paths_json(){ printf '%s\n' "$1" | jq -Rsc 'split("\n")|map(gsub("^[ \t]+|[ \t]+$";""))|map(select(length>0))|unique'; }
current_slice(){ local st n; st=$(jq -r '.step' "$state"); n=$(slice_count); cur=1
  case "$st" in slice-[0-9]*) cur=${st#slice-};; esac
  [ "$cur" -ge 1 ] 2>/dev/null || cur=1; [ "$n" -eq 0 ] || [ "$cur" -le "$n" ] || cur=$n; echo "$cur"; }

# The advisory note the previous cycle left, for the phase that plans the next
# one. It carries no authority: it never widens scope and never approves a thing.
notes_section(){
  local notes_file="$loop/notes/next-steps.md"
  [ "$phase" = DEFINE ] || return 0
  [ -f "$notes_file" ] && [ -s "$notes_file" ] || return 0
  printf '\n# Previous cycle notes (advisory)\n\nThe previous cycle left this note under .loop/notes/next-steps.md. It is advisory: it is not an approval and it does not widen this node'"'"'s scope.\n\n%s\n' "$(cat "$notes_file")"
}

build_brief(){
  local task succ cap vids outs ap fp card prompt answers answer_section notes
  task=$(phase_task "$phase"); succ=$(phase_success "$phase")
  cap=executor; [ "$phase" != REVIEW ] || cap=reviewer
  vids='["orchestrator"]'; outs='[]'
  if [ "$phase" = EXECUTE ] || [ "$phase" = VALIDATE ]; then
    vids=$(jq -c --arg p "$phase" '[.commands[]|select(.phase==$p)|.id]|unique' "$adapter_file")
    outs=$(jq -c '[.artifacts[].paths[]]|unique' "$adapter_file")
    [ "$vids" != '[]' ] || { vids='["orchestrator"]'; outs='[]'; }
  fi
  if [ "$phase" = EXECUTE ]; then
    slices=$(slice_count); cur=$(current_slice)
    [ "$slices" -gt 0 ] || die 'EXECUTE requires a declared execution slice'
    ap=$(paths_json "$(slice_col "$cur" 2 || true)"); [ "$ap" != '[]' ] || die "execution slice $cur has no allowed paths"
    fp=$(paths_json "$(slice_col "$cur" 3 || true)")
    task="Slice $cur of $slices: $(slice_col "$cur" 1 | tr '\n' ' ' | sed 's/[[:space:]]*$//'). $task"
  elif [ "$phase" = VALIDATE ]; then
    # Verification commands may write build or test output; allow every slice's paths, the agent itself changes nothing.
    ap=$(paths_json "$(printf '%s\n' ".loop/work-items/**"; n=$(slice_count); i=1; while [ "$i" -le "$n" ]; do slice_col "$i" 2 || true; i=$((i+1)); done)")
    fp='["requirements/**"]'
  else
    ap='[".loop/work-items/**"]'; fp='["requirements/**"]'
  fi
  card=$(host_card)
  answers=$(human_blocker_answers)
  answer_section=
  [ "$answers" = '[]' ] || answer_section=$(printf '\n# Human blocker answers\n\nThe following read-only control records are human decisions for this work item and phase:\n\n%s\n' "$(jq . <<<"$answers")")
  notes=$(notes_section)
  prompt=$(printf '%s\n\n# Work item %s (file: %s)\n\n%s\n\n# Current loop state\n\n%s\n%s\n%s\n# Node task (%s)\n\n%s\n\nSuccess condition: %s\n\n# Path policy for this node\n\nYou may change only these paths (glob patterns): %s\nFrozen for this node: %s\nEverything else must stay unchanged. For DEFINE, DESIGN and HANDOVER the work item file above is the only file to edit; the adapter protected_paths apply to product code, not to this edit. VALIDATE and REVIEW change nothing. The .loop/control directory is runner-owned and read-only to you. Do not create cache or build files outside the allowed paths (run python with -B).\n' \
    "$card" "$work" ".loop/work-items/$work.md" "$(cat "$wi")" "$(cat "$state")" "$answer_section" "$notes" "$phase" "$task" "$succ" "$(jq -r 'join(", ")' <<<"$ap")" "$(jq -r 'join(", ")' <<<"$fp")")
  jq -n --arg run "$run_id" --arg node "$(lower "$phase")-$round" --arg gate "$phase" --arg w "$work" \
    --arg p "$phase" --arg task "$task" --arg cap "$cap" --arg succ "$succ" --argjson v "$vids" \
    --argjson o "$outs" --argjson ap "$ap" --argjson fp "$fp" --argjson cap_n "$(jq -r .max_gate_failures "$state")" --arg prompt "$prompt" \
    '{schema_version:1,run_id:$run,node_id:$node,gate_id:$gate,work_item_id:$w,phase:$p,trigger:"orchestrator",
      task:$task,actor_capability:$cap,success_condition:$succ,verifier_ids:$v,input_artifacts:[],output_artifacts:$o,
      allowed_paths:$ap,frozen_paths:$fp,retry_cap:$cap_n,escalation_target:"human",prompt:$prompt}'
}

human_blocker_answers(){
  local answer_dir="$loop/control/answers" answer_file answer_id answer expected actual
  [ -d "$answer_dir" ] || { printf '[]\n'; return; }
  for answer_file in "$answer_dir"/*.json; do
    [ -e "$answer_file" ] || continue
    # Answers recorded for another work item or an earlier phase belong to that
    # blocker only; they are kept on disk but are not part of this node.
    jq -e --arg work "$work" --arg phase "$phase" '.work_item_id==$work and .phase==$phase' "$answer_file" >/dev/null 2>&1 || {
      jq -e 'type=="object"' "$answer_file" >/dev/null 2>&1 || die "invalid blocker answer: ${answer_file##*/}"
      continue
    }
    jq -e --arg work "$work" --arg phase "$phase" '
      type=="object" and keys==["answer","answer_id","answer_sha256","blocker_id","phase","recorded_at","schema_version","work_item_id"] and
      .schema_version==1 and .work_item_id==$work and .phase==$phase and
      (.answer_id|test("^[A-Za-z0-9][A-Za-z0-9._-]*$")) and (.blocker_id|test("^[A-Za-z0-9][A-Za-z0-9._-]*$")) and
      (.answer|type=="string" and length>0) and (.recorded_at|test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")) and
      (.answer_sha256|test("^[0-9a-f]{64}$"))' "$answer_file" >/dev/null || die "invalid blocker answer: ${answer_file##*/}"
    answer_id=$(jq -r .answer_id "$answer_file")
    [ "${answer_file##*/}" = "$answer_id.json" ] || die "blocker answer filename mismatch: ${answer_file##*/}"
    answer=$(jq -r .answer "$answer_file"); expected=$(jq -r .answer_sha256 "$answer_file")
    actual=$(printf '%s' "$answer" | shasum -a 256 | awk '{print $1}')
    [ "$actual" = "$expected" ] || die "blocker answer digest mismatch: ${answer_file##*/}"
    jq -c '{answer_id,blocker_id,work_item_id,phase,answer,recorded_at,answer_sha256}' "$answer_file"
  done | jq -s 'sort_by(.recorded_at,.answer_id)'
}

call_provider(){ # brief out err
  local name; env_args=(); env_seen='{}'
  while IFS= read -r name; do
    env_args+=("$name=${!name-}")
    env_seen=$(jq -c --arg name "$name" '.+{($name):true}' <<<"$env_seen")
  done < <(jq -r '.environment.allow_names[]' "$adapter_file")
  for name in HOME USER LOGNAME SHELL CODEX_HOME CLAUDE_CONFIG_DIR CODEX_BIN CLAUDE_BIN CODEX_MODEL CLAUDE_MODEL PROVIDER_TIMEOUT; do
    [ -n "${!name+x}" ] || continue
    jq -e --arg name "$name" 'has($name)' <<<"$env_seen" >/dev/null && continue
    env_args+=("$name=${!name}"); env_seen=$(jq -c --arg name "$name" '.+{($name):true}' <<<"$env_seen")
  done
  ( cd "$root" && env -i "${env_args[@]}" LOOP_ROOT="$root" LOOP_PHASE="$phase" LOOP_RUN_ID="$run_id" \
      LOOP_WORK_ITEM="$work" "$use_prov" ) <"$1" >"$2" 2>"$3"
}

has_section(){ awk -v h="$1" '$0==h{f=1;next} /^## /{f=0} f&&NF{c++} END{exit c?0:1}' "$wi"; }

changed_paths(){ # baseline after
  loop_changed_paths "$1" "$2"
}

write_orch_evidence(){ # id type result observation
  jq -n --arg id "$1" --arg w "$work" --arg p "$phase" --arg t "$2" --arg r "$3" --arg rev "$rev" \
    --arg env "$(uname -srm)" --arg at "$(now)" --arg o "$4" \
    '{schema_version:1,evidence_id:$id,work_item_id:$w,phase:$p,evidence_type:$t,result:$r,producer:"orchestrator",
      revision:$rev,environment:$env,captured_at:$at,artifacts:[],details:{observation:$o}}' > "$evidence_dir/$1.json"
}

go_blocked(){ # text
  local message=$1 action=${2:-resolve blocker} blocker_line
  mkdir -p "$loop"
  [ -f "$loop/blockers.md" ] || printf '# Blockers\n\n' > "$loop/blockers.md"
  blocker_line="- [ ] $phase $run_id: $message"
  grep -Fqx -- "$blocker_line" "$loop/blockers.md" 2>/dev/null || printf '%s\n' "$blocker_line" >> "$loop/blockers.md"
  persist_provider_stderr
  write_state --arg n "$(now)" --arg action "$action" '.run_status="BLOCKED"|.last_result="blocked"|.next_action=$action|.updated_at=$n'
  print_status; exit 1
}

enforce_caps(){
  local reason action
  reason=$(cap_reason)
  [ -z "$reason" ] && return 0
  case "$reason" in
    'round cap reached') action='raise max_rounds or cancel the run' ;;
    'retry cap reached') action='raise max_gate_failures or cancel the run' ;;
    'wall clock cap reached') action='raise max_wall_seconds or cancel the run' ;;
    *) action='repair the invalid run budget before resuming' ;;
  esac
  go_blocked "$reason" "$action"
}

persist_provider_stderr(){
  [ -n "${perr:-}" ] && [ -f "$perr" ] && [ -n "${run_id:-}" ] || return 0
  mkdir -p "$evidence_dir/$run_id/logs"
  cp "$perr" "$evidence_dir/$run_id/logs/provider.stderr" 2>/dev/null || :
}

record_supervisor_quarantine(){
  local changed=$1 paths_json quarantine_tmp
  paths_json=$(printf '%s\n' "$changed" | jq -Rsc 'split("\n")|map(select(length>0))|unique')
  quarantine_tmp=$(mktemp "$loop/.quarantine.XXXXXX")
  jq -n --arg work "$work" --arg phase "$phase" --arg run "$run_id" --arg at "$(now)" \
    --argjson paths "$paths_json" --slurpfile before "$tmp/protected-before.json" '
      {schema_version:1,work_item_id:$work,phase:$phase,run_id:$run,detected_at:$at,changed_paths:$paths,
       expected:[$paths[] as $path|{path:$path,record:(($before[0].files|map(select(.path==$path))|.[0])//null)}]}' \
    > "$quarantine_tmp"
  chmod 600 "$quarantine_tmp" 2>/dev/null || :
  mv "$quarantine_tmp" "$loop/quarantine.json"
}

check_supervisor_quarantine(){
  local quarantine="$loop/quarantine.json" current
  [ -e "$quarantine" ] || return 0
  [ -f "$quarantine" ] && [ ! -L "$quarantine" ] || die 'runner metadata quarantine is unsafe' 73
  jq -e '. as $quarantine|type=="object" and keys==["changed_paths","detected_at","expected","phase","run_id","schema_version","work_item_id"] and
    .schema_version==1 and all([.work_item_id,.phase,.run_id,.detected_at][];type=="string" and length>0) and
    (.changed_paths|type=="array" and length>0 and length==(unique|length) and all(.[];type=="string" and
      (.==".loop/control" or startswith(".loop/control/") or .==".loop/evidence" or startswith(".loop/evidence/") or
       .==".loop/engine.lock" or startswith(".loop/engine.lock/") or .==".loop/orchestrator.lock" or startswith(".loop/orchestrator.lock/")))) and
    (.expected|type=="array" and length==($quarantine.changed_paths|length) and ([.[].path]|sort)==($quarantine.changed_paths|sort) and
      all(.[];. as $entry|type=="object" and keys==["path","record"] and (.path|type=="string") and
        (.record==null or (.record|type=="object" and keys==["kind","mode","path","sha256"] and .path==$entry.path and
          (.kind=="file" or .kind=="symlink") and (.mode|test("^[0-7]{3,4}$")) and (.sha256|test("^[0-9a-f]{64}$"))))))' \
    "$quarantine" >/dev/null 2>&1 || die 'runner metadata quarantine is invalid' 73
  current=$(mktemp "${TMPDIR:-/tmp}/loop-quarantine-current.XXXXXX")
  "$engine" protected-snapshot --root "$root" --output "$current"
  # The prior owner record identifies the lock instance in which tampering was
  # detected. A later recovery necessarily runs under a freshly acquired lock,
  # so accept that one transient record only when it is the exact lock this
  # process just acquired. Every other quarantined record remains byte-, type-,
  # and mode-bound to the pre-provider snapshot.
  if jq -e '.changed_paths|index(".loop/orchestrator.lock/owner.json")!=null' "$quarantine" >/dev/null; then
    jq -e --arg operation "${olock_operation:-}" --argjson pid "$$" '
      type=="object" and keys==["acquired_at","operation","owner","pid","schema_version"] and
      .schema_version==1 and .owner=="shell-orchestrator" and .operation==$operation and .pid==$pid and
      (.acquired_at|type=="string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))' \
      "$olock/owner.json" >/dev/null 2>&1 || { rm -f "$current"; die 'runner metadata quarantine has no valid current lock owner' 73; }
  fi
  if jq -e --slurpfile current "$current" '
      all(.expected[]; . as $expected |
        ($expected.path==".loop/orchestrator.lock/owner.json" or
         ((($current[0].files|map(select(.path==$expected.path))|.[0])//null)==$expected.record)))' "$quarantine" >/dev/null; then
    rm -f "$current" "$quarantine"
    return 0
  fi
  rm -f "$current"
  die 'runner-owned metadata is quarantined; restore it or re-answer through trusted control' 73
}

assert_provider_preserved_supervisor_state(){
  local changed
  "$engine" protected-snapshot --root "$root" --output "$tmp/protected-after.json"
  changed=$(loop_changed_paths "$tmp/protected-before.json" "$tmp/protected-after.json")
  [ -z "$changed" ] || { record_supervisor_quarantine "$changed"; go_blocked "provider changed runner-owned metadata: $(printf '%s' "$changed" | tr '\n' ' ')"; }
}

assert_read_only_provider(){
  local changed
  "$engine" snapshot --root "$root" --output "$tmp/provider-after.json"
  changed=$(changed_paths "$tmp/baseline.json" "$tmp/provider-after.json")
  [ -z "$changed" ] || go_blocked "$phase provider changed the workspace: $(printf '%s' "$changed" | tr '\n' ' ')"
}

do_transition(){ # to [defect_class]
  local id; targs=(--root "$root" --state "$state" --workflow "$workflow_file" --adapter "$adapter_file" --evidence-dir "$evidence_dir")
  for id in $ev_ids; do targs+=(--evidence-ref "$id"); done
  targs+=(--to "$1"); [ -z "${2:-}" ] || targs+=(--defect-class "$2")
  "$engine" transition "${targs[@]}"
}

green_target(){ case "$1" in DEFINE) echo DESIGN;; DESIGN) echo EXECUTE;; EXECUTE) echo REVIEW;; REVIEW) echo VALIDATE;; VALIDATE) echo HANDOVER;; *) echo '';; esac; }
rework_target(){ case "$1" in requirement) echo DEFINE;; design) echo DESIGN;; *) echo EXECUTE;; esac; }

review_diff(){ # tracked changes plus every untracked file, so the reviewer sees the whole durable change
  local f
  (
    cd "$root"
    if git rev-parse HEAD >/dev/null 2>&1; then
      git diff HEAD -- . ':(exclude).loop'
      git ls-files -z --others --exclude-standard -- . ':(exclude).loop' | while IFS= read -r -d '' f; do
        [ -n "$f" ] || continue; git diff --no-index -- /dev/null "./$f" || :
      done
    else
      "$engine" snapshot --root "$root" --output "$tmp/review-current.json"
      while IFS= read -r f; do
        [ -n "$f" ] && [ -f "$f" ] || continue
        git diff --no-index -- /dev/null "./$f" || :
      done < <(jq -r '.files[].path|select(startswith(".loop/")|not)' "$tmp/review-current.json")
    fi
  )
}
handover_pending(){ [ "$(jq -r .run_status "$state")" = WAITING_FOR_HUMAN ] && [ "$(jq -r .phase "$state")" = HANDOVER ] && [ "$(jq -r .gates.HANDOVER.status "$state")" = PENDING ]; }
should_continue(){ [ "$(jq -r .run_status "$state")" = RUNNING ] || handover_pending; }

require_files(){
  [ ! -L "$loop" ] || die 'refusing symlinked control directory' 65
  if [ -d "$loop" ]; then case "$(cd "$loop" && pwd -P)/" in "$root/.loop/") ;; *) die 'control directory escapes root' 65;; esac; fi
  [ -f "$state" ] || die '.loop/state.json missing' 65
  [ -f "$adapter_file" ] || die '.loop/project.adapter.json missing' 65
  [ -f "$loop/workflow.json" ] || die '.loop/workflow.json missing' 65
  work=$(jq -r '.work_item_id // empty' "$state") || die 'unreadable state' 65
  wi="$loop/work-items/$work.md"
  [ -f "$wi" ] || die "work item missing: $wi" 65
}

validate_managed_activation(){
  local activation="$loop/control/activation.json" setup_path setup_digest expected actual setup_phys
  [ -e "$activation" ] || return 0
  [ -f "$activation" ] && [ ! -L "$activation" ] || die 'managed activation record is unsafe' 65
  jq -e '
    type=="object" and .schema_version==1 and
    (.setup_digest|type=="string" and test("^[0-9a-f]{64}$")) and
    (.activated_at|type=="string" and length>0) and (.distribution|type=="object") and
    (.adapter_file_sha256|type=="string" and test("^[0-9a-f]{64}$")) and
    (.workflow_file_sha256|type=="string" and test("^[0-9a-f]{64}$")) and
    (.setup_evidence|type=="string")' "$activation" >/dev/null || die 'managed activation record is invalid' 65
  expected=$(jq -r .adapter_file_sha256 "$activation"); actual=$(shasum -a 256 "$adapter_file" | awk '{print $1}')
  [ "$expected" = "$actual" ] || die 'active adapter does not match managed activation' 65
  expected=$(jq -r .workflow_file_sha256 "$activation"); actual=$(shasum -a 256 "$loop/workflow.json" | awk '{print $1}')
  [ "$expected" = "$actual" ] || die 'active workflow does not match managed activation' 65
  setup_digest=$(jq -r .setup_digest "$activation"); setup_path=$(jq -r .setup_evidence "$activation")
  [ "$setup_path" = ".loop/control/setup-evidence/$setup_digest.json" ] || die 'managed setup evidence path does not match activation' 65
  [ -f "$root/$setup_path" ] && [ ! -L "$root/$setup_path" ] || die 'managed setup evidence is missing or unsafe' 65
  setup_phys=$(cd "$(dirname "$root/$setup_path")" 2>/dev/null && pwd -P) || die 'managed setup evidence parent is unsafe' 65
  [ "$setup_phys" = "$loop/control/setup-evidence" ] || die 'managed setup evidence escapes control directory' 65
  jq -e --arg digest "$setup_digest" '
    type=="object" and .schema_version==1 and .setup_digest==$digest and
    (.approval_id|type=="string" and length>0) and .status=="PASSED" and .target_unchanged==true' \
    "$root/$setup_path" >/dev/null || die 'managed setup evidence is not a passing bound approval' 65
}

validate_job_ownership(){
  local job_lock="$loop/control/job.lock" owner expected_job expected_lock
  [ -e "$job_lock" ] || return 0
  [ -d "$job_lock" ] && [ ! -L "$job_lock" ] || die 'managed job lock is unsafe' 73
  owner="$job_lock/owner.json"
  [ -f "$owner" ] && [ ! -L "$owner" ] || die 'managed job lock owner is unsafe' 73
  jq -e 'type=="object" and keys==["created_at","job_id","lock_id","pid","request_id"] and
    (.pid|type=="number" and .>=1 and floor==.) and
    all([.created_at,.request_id,.job_id,.lock_id][];type=="string" and length>0)' "$owner" >/dev/null \
    || die 'managed job lock owner is invalid' 73
  expected_job=$(jq -r .job_id "$owner"); expected_lock=$(jq -r .lock_id "$owner")
  [ -n "${LOOP_JOB_ID:-}" ] && [ "$LOOP_JOB_ID" = "$expected_job" ] &&
    [ -n "${LOOP_JOB_LOCK_ID:-}" ] && [ "$LOOP_JOB_LOCK_ID" = "$expected_lock" ] ||
    die 'workspace is owned by another managed job' 73
}

honor_control_intent(){
  local intent="$loop/control/intent.json" intent_job desired current_status
  [ -e "$intent" ] || return 0
  [ -f "$intent" ] && [ ! -L "$intent" ] || die 'control intent is unsafe' 65
  jq -e 'type=="object" and keys==["desired_status","job_id","request_id","requested_at","schema_version"] and
    .schema_version==1 and (.job_id|type=="string" and length>0) and (.request_id|type=="string" and length>0) and
    (.desired_status as $s|["RUNNING","PAUSED","CANCELLED"]|index($s)!=null) and (.requested_at|type=="string" and length>0)' "$intent" >/dev/null \
    || die 'control intent is invalid' 65
  intent_job=$(jq -r .job_id "$intent")
  [ -n "${LOOP_JOB_ID:-}" ] && [ "$intent_job" = "$LOOP_JOB_ID" ] || die 'control intent does not match the active job' 65
  desired=$(jq -r .desired_status "$intent")
  [ "$desired" != RUNNING ] || return 0
  acquire_orchestrator_lock intent
  validate_job_ownership
  require_files; validate_state "$state" || die 'state validation failed' 65
  current_status=$(jq -r .run_status "$state")
  if [ "$current_status" != "$desired" ] && [ "$current_status" != COMPLETED ] && [ "$current_status" != CANCELLED ] && \
     { [ "$desired" != PAUSED ] || [ "$current_status" != BLOCKED ]; }; then
    write_state --arg status "$desired" --arg at "$(now)" \
      '.run_status=$status|.last_result=(if $status=="PAUSED" then "paused by control" else "cancelled by control" end)|.next_action=(if $status=="PAUSED" then "resume when ready" else "cancelled" end)|.updated_at=$at'
  fi
  release_orchestrator_lock
  trap - EXIT INT TERM
}

case "$mode" in
start)
  require_files
  validate_state "$state" || die 'state validation failed' 65
  validate_managed_activation
  acquire_orchestrator_lock start
  validate_job_ownership
  require_files
  check_supervisor_quarantine
  validate_managed_activation
  [ "$(jq -r .run_status "$state")" = PAUSED ] || die 'start requires run_status PAUSED' 65
  # Whether this entry point may run at all is decided before anything is
  # written, so a refused start leaves the run exactly as it was.
  capture_authorization
  require_no_project_hold
  require_authorized_entry
  write_state --arg n "$(now)" --argjson e "$(date +%s)" '.run_status="RUNNING"|.started_epoch=(if (.started_epoch//0)>0 then .started_epoch else $e end)|.updated_at=$n'
  phase=$(jq -r .phase "$state"); work=$(jq -r .work_item_id "$state"); round=$(jq -r .round "$state"); run_id="run-$work-$round-$(lower "$phase")"
  # Starting is where the authorized budget takes effect: an unusable decision
  # stops the run here, and a smaller authorized cap becomes this run's cap.
  capture_authorization
  require_usable_authorization
  enforce_caps
  print_status; exit 0;;
status)
  require_files; validate_state "$state" || die 'state validation failed' 65; print_status; exit 0;;
resume)
  require_files
  validate_state "$state" || die 'state validation failed' 65
  validate_managed_activation
  acquire_orchestrator_lock resume
  validate_job_ownership
  require_files
  check_supervisor_quarantine
  validate_managed_activation
  [ "$(jq -r .run_status "$state")" = BLOCKED ] || die 'resume requires run_status BLOCKED' 65
  [ "$(open_blockers)" -eq 0 ] || die 'open blockers remain' 65
  capture_authorization
  require_no_project_hold
  require_authorized_entry
  write_state --arg n "$(now)" --argjson e "$(date +%s)" '.run_status="RUNNING"|.started_epoch=(if (.started_epoch//0)>0 then .started_epoch else $e end)|.last_result="resumed"|.next_action=("continue "+.phase)|.updated_at=$n'
  phase=$(jq -r .phase "$state"); work=$(jq -r .work_item_id "$state"); round=$(jq -r .round "$state"); run_id="run-$work-$round-$(lower "$phase")"
  # Resuming continues under the decision that is in force now, with its budget.
  capture_authorization
  require_usable_authorization
  enforce_caps
  print_status; exit 0;;
loop)
  require_files
  validate_state "$state" || die 'state validation failed' 65
  validate_managed_activation
  [[ "$max_nodes" =~ ^[1-9][0-9]*$ ]] || die '--max-nodes must be a positive integer' 64
  # Only the item id is needed here, to recognise a recorded human entry. The
  # full authorization is captured by each node this loop delegates to.
  auth_item=$(jq -r '.work_item_id // empty' "$state" 2>/dev/null || :)
  require_no_project_hold
  honor_control_intent
  i=0
  while [ "$i" -lt "$max_nodes" ] && should_continue; do
    set -- run --root "$root" --host "$host" --provider "$provider"
    [ -z "$review_host" ] || set -- "$@" --review-host "$review_host"
    [ -z "$review_provider" ] || set -- "$@" --review-provider "$review_provider"
    set +e; "$self_dir/orchestrator.sh" "$@" >/dev/null; rc=$?; set -e
    [ "$rc" -le 1 ] || die "run failed with exit $rc" "$rc"
    i=$((i+1))
    honor_control_intent
    should_continue || break
  done
  print_status
  [ "$(jq -r .run_status "$state")" != BLOCKED ] || exit 1
  exit 0;;
next|run) ;;
*) die "unknown mode: $mode";;
esac

require_files
validate_state "$state" || die 'state validation failed' 65
validate_managed_activation
[ -n "$host" ] || die '--host is required'
if [ "$mode" = run ] && [ -e "$loop/control/intent.json" ]; then
  honor_control_intent
  should_continue || { print_status; exit 0; }
fi
if [ "$mode" = next ]; then
  phase=$(jq -r .phase "$state"); round=$(jq -r .round "$state"); run_id="run-$work-$round-$(lower "$phase")"; rev=$(head_rev)
  build_brief; exit 0
fi

# ---- run ----
[ -n "$provider" ] || die '--provider is required'
acquire_orchestrator_lock run
validate_job_ownership
require_files
check_supervisor_quarantine
validate_state "$state" || die 'state validation failed' 65
validate_managed_activation
phase=$(jq -r .phase "$state"); round=$(jq -r .round "$state")
run_id="run-$work-$round-$(lower "$phase")"
rev=$(head_rev)
# Before any state is written: an item whose decision was withdrawn does not run
# from an automated entry point, and a refused node changes nothing at all.
capture_authorization
require_no_project_hold
require_authorized_entry
if [ "$(jq -r .run_status "$state")" != RUNNING ]; then
  handover_pending || die 'run requires run_status RUNNING' 65
  write_state --arg n "$(now)" --argjson e "$(date +%s)" '.run_status="RUNNING"|.started_epoch=(if (.started_epoch//0)>0 then .started_epoch else $e end)|.updated_at=$n'
fi
# The authorization boundary is captured here, before anything runs, and the
# checks after the node use exactly this captured copy. It comes before the cap
# check because an authorized budget that is smaller than the recorded one is
# the budget this run has: the caps are lowered first and then enforced.
capture_authorization
require_usable_authorization
enforce_caps
if [ "$phase" = EXECUTE ]; then
  slices=$(slice_count); [ "$slices" -gt 0 ] || go_blocked 'EXECUTE has no declared execution slice'
  cur=$(current_slice); [ "$(paths_json "$(slice_col "$cur" 2 || true)")" != '[]' ] || go_blocked "execution slice $cur has no allowed paths"
fi
use_prov=$prov_abs; use_host=$host
if [ "$phase" = REVIEW ]; then
  [ -z "$review_provider" ] || use_prov=$review_prov_abs
  [ -z "$review_host" ] || use_host=$review_host
fi
[ -x "$use_prov" ] || die "provider not executable: $use_prov" 69
tmp=$(mktemp -d "${TMPDIR:-/tmp}/loop-orch.XXXXXX")
trap 'rm -rf "$tmp"; release_orchestrator_lock' EXIT INT TERM
mkdir -p "$evidence_dir"
"$engine" snapshot --root "$root" --output "$tmp/baseline.json"
"$engine" protected-snapshot --root "$root" --output "$tmp/protected-before.json"
build_brief > "$tmp/brief.json"
jq 'del(.prompt)' "$tmp/brief.json" > "$tmp/node.json"
perr="$tmp/provider.stderr"
ev_ids=""; passed=1; defect=""

if [ "$phase" = REVIEW ]; then
  refs=$(jq -r '.gates.EXECUTE.evidence_ids[]?' "$state")
  [ -n "$refs" ] || die 'REVIEW requires EXECUTE gate evidence' 65
  rargs=(); first=""
  for id in $refs; do rargs+=(--evidence-ref "$id"); [ -n "$first" ] || first=$id; done
  exec_run=$(jq -r '.details.run_id // empty' "$evidence_dir/$first.json")
  [ -n "$exec_run" ] || die 'referenced evidence has no run id' 65
  "$engine" issue-review --run-id "$exec_run" --work-item "$work" --evidence-dir "$evidence_dir" "${rargs[@]}" --output "$tmp/challenge.json"
  ev_text=""
  for id in $refs; do ev_text=$(printf '%s\n## %s\n%s\n' "$ev_text" "$id" "$(cat "$evidence_dir/$id.json")"); done
  diff_text=$(review_diff)
  challenge_text=$(jq -r '"run_id: \(.run_id)\nwork_item_id: \(.work_item_id)\nnonce: \(.nonce)\nrevision: \(.revision)\nevidence_refs: \(.evidence_refs|join(", "))"' "$tmp/challenge.json")
  rprompt=$(printf '%s\n\n# Work item %s\n\n%s\n\n# Durable change\n\n```diff\n%s\n```\n\n# Referenced evidence\n%s\n\n# Review challenge (issued by the engine; copy these values verbatim into the verdict)\n\n%s\n\n# Instruction\n\n%s\nYou are the independent reviewer. Do not change any file. Return one verdict JSON whose run_id, work_item_id, nonce, revision and evidence_refs are exactly the challenge values above.\n' \
    "$(host_card)" "$work" "$(cat "$wi")" "$diff_text" "$ev_text" "$challenge_text" "$(phase_task REVIEW)")
  jq -n --slurpfile n "$tmp/node.json" --slurpfile c "$tmp/challenge.json" --arg prompt "$rprompt" --arg reviewer_host "$use_host" \
    '$n[0] + {run_id:$c[0].run_id, work_item_id:$c[0].work_item_id, nonce:$c[0].nonce, revision:$c[0].revision, evidence_refs:$c[0].evidence_refs, reviewer_host:$reviewer_host, prompt:$prompt}' > "$tmp/review-brief.json"
  set +e; call_provider "$tmp/review-brief.json" "$tmp/verdict.json" "$perr"; prc=$?; set -e
  assert_provider_preserved_supervisor_state
  assert_read_only_provider
  mkdir -p "$evidence_dir/$run_id/logs"
  cp "$tmp/verdict.json" "$evidence_dir/$run_id/logs/provider.stdout" 2>/dev/null || :
  if [ "$prc" -ne 0 ] || ! jq -e . "$tmp/verdict.json" >/dev/null 2>&1; then go_blocked 'invalid verdict'; fi
  set +e; "$engine" validate-verdict --challenge "$tmp/challenge.json" --verdict "$tmp/verdict.json" --evidence-dir "$evidence_dir" >/dev/null 2>>"$perr"; vrc=$?; set -e
  persist_provider_stderr
  [ "$vrc" -le 1 ] || go_blocked 'invalid verdict'
  ev_ids="review-$exec_run"
  [ "$vrc" -eq 0 ] || { passed=0; defect=$(jq -r '[.findings[]?|select(.disposition=="OPEN" and (.severity=="BLOCKING" or .severity=="HIGH"))][0].category // "artifact"' "$tmp/verdict.json"); }
else
  set +e; call_provider "$tmp/brief.json" "$tmp/result.json" "$perr"; prc=$?; set -e
  assert_provider_preserved_supervisor_state
  case "$phase" in REVIEW|VALIDATE) assert_read_only_provider;; esac
  mkdir -p "$evidence_dir/$run_id/logs"
  cp "$tmp/result.json" "$evidence_dir/$run_id/logs/provider.stdout" 2>/dev/null || :
  if [ "$prc" -ne 0 ] || ! jq -e 'type=="object"' "$tmp/result.json" >/dev/null 2>&1; then
    write_orch_evidence "$run_id-orchestrator" artifact FAILED "Provider failed or produced non-JSON output for $phase."
    ev_ids="$run_id-orchestrator"; passed=0; defect=artifact
  else
    jq -e '((keys-["schema_version","status","defect_class","blocker","notes"])|length==0) and .schema_version==1 and (.status=="DONE" or .status=="BLOCKED")' "$tmp/result.json" >/dev/null \
      || go_blocked 'provider result does not match the contract'
    if [ "$(jq -r .status "$tmp/result.json")" = BLOCKED ]; then go_blocked "$(jq -r '.blocker // "decision needed"' "$tmp/result.json")"; fi
    case "$phase" in
      EXECUTE|VALIDATE)
        if [ "$(jq -r '.verifier_ids[0]' "$tmp/node.json")" = orchestrator ]; then
          write_orch_evidence "$run_id-orchestrator" artifact PASSED "No adapter command is declared for $phase; the orchestrator recorded the produced artifact only."
          ev_ids="$run_id-orchestrator"
        else
          set +e
          summary=$("$engine" verify --root "$root" --adapter "$adapter_file" --node "$tmp/node.json" \
            --baseline "$tmp/baseline.json" --phase "$phase" --evidence-dir "$evidence_dir" 2>>"$perr")
          vrc=$?; set -e
          [ -n "$summary" ] && [ -f "$summary" ] || go_blocked "verifier could not run for $phase"
          [ "$vrc" -eq 0 ] || passed=0
          ev_ids=$(jq -r '.evidence_ids[]' "$summary")
          for id in $ev_ids; do cp "$evidence_dir/$run_id/$id.json" "$evidence_dir/$id.json"; done
          [ "$passed" -eq 1 ] || defect=artifact
        fi
        enforce_authorized_change_scope "$(authorized_scope)";;
      *)
        etype=contract; [ "$phase" != HANDOVER ] || etype=documentation
        obs="Required work item sections for $phase are present and every changed path is allowed."
        result=PASSED
        case "$phase" in
          DEFINE) has_section '## Acceptance criteria' && has_section '## Out of scope' || { result=FAILED; obs="DEFINE requires non-empty acceptance criteria and out-of-scope sections."; };;
          DESIGN) has_section '## Design' && has_section '## Execution slices' || { result=FAILED; obs="DESIGN requires non-empty design and execution slices sections."; }
            # The authorization is the outer boundary. A slice may narrow it; it
            # may never reach outside what the person actually authorized.
            if [ "$result" = PASSED ]; then
              scope_patterns=$(authorized_scope)
              if [ -n "$scope_patterns" ]; then
                outside_scope=$(slice_paths_outside_scope "$scope_patterns")
                [ -z "$outside_scope" ] || { result=FAILED; obs="slice path outside authorized scope: $outside_scope"; }
              fi
            fi;;
          HANDOVER) has_section '## Handover' || { result=FAILED; obs="HANDOVER requires a non-empty handover section."; };;
        esac
        "$engine" snapshot --root "$root" --output "$tmp/after.json"
        while IFS= read -r p; do
          [ -n "$p" ] || continue; okp=0
          while IFS= read -r pat; do [[ "$p" == $pat ]] && { okp=1; break; }; done < <(jq -r '.allowed_paths[]' "$tmp/node.json")
          [ "$okp" -eq 1 ] || { result=FAILED; obs="Path outside the allowed paths changed: $p"; break; }
        done < <(changed_paths "$tmp/baseline.json" "$tmp/after.json")
        write_orch_evidence "$run_id-orchestrator" "$etype" "$result" "$obs"
        ev_ids="$run_id-orchestrator"
        [ "$result" = PASSED ] || { passed=0; defect=artifact; };;
    esac
  fi
  persist_provider_stderr
fi

# The decision may have run out or been damaged while the node was running. The
# checks above still used the boundary captured before it; from here on nothing
# further may run, so the run stops for a person.
saved_auth_kind=$auth_kind
capture_authorization
if [ "$saved_auth_kind" != none ] && [ "$auth_kind" = error ]; then
  auth_kind=$saved_auth_kind
  go_blocked "authorization invalid or expired for ${auth_item:-the current work item}" \
    'repair or renew the authorization sidecar, then resume'
fi
auth_kind=$saved_auth_kind

if [ "$passed" -eq 1 ]; then
  if [ "$phase" = HANDOVER ]; then
    write_state --arg id "$ev_ids" --arg n "$(now)" \
      '.gates.HANDOVER={status:"PASSED",evidence_ids:[$id]}|.run_status="WAITING_FOR_HUMAN"|.round=(.round+1)|.last_result="gate PASSED"|.next_action="await human decision"|.updated_at=$n'
    # Cross-cycle memory. Written after the gate and its evidence are recorded,
    # so the note is never part of the change this node is judged on. Advisory.
    loop_write_next_steps "$root"
    print_status; exit 0
  fi
  if [ "$phase" = EXECUTE ]; then
    slices=$(slice_count); cur=$(current_slice)
    if [ "$slices" -gt 0 ] && [ "$cur" -lt "$slices" ]; then
      write_state --arg st "slice-$((cur+1))" --arg n "$(now)" '.step=$st|.updated_at=$n'
      do_transition EXECUTE; print_status; exit 0
    fi
  fi
  do_transition "$(green_target "$phase")"
  print_status; exit 0
fi

case "$phase" in
  REVIEW|VALIDATE) do_transition "$(rework_target "$defect")" "$defect"
    [ "$(jq -r .phase "$state")" != EXECUTE ] || write_state --arg n "$(now)" '.step="slice-1"|.updated_at=$n'
    print_status
    [ "$(jq -r .run_status "$state")" != BLOCKED ] || exit 1; exit 1;;
  *) go_blocked "gate failed (${defect:-artifact})${obs:+: $obs}";;
esac
