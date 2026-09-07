#!/usr/bin/env bash

# Memory between cycles, Bash side. Writes `.loop/notes/next-steps.md` from the
# files the run already left behind: state, evidence, blockers, backlog and the
# work item. Same note, same sections, as control/notes.mjs writes on the Node
# side. It is advisory: it is never an approval and it authorizes nothing.
#
# Bash 3.2 compatible: no mapfile, no associative arrays. Requires jq.

loop_next_steps_phases='["DEFINE","DESIGN","EXECUTE","REVIEW","VALIDATE","HANDOVER"]'

# First readable sentence of a work item section, without list or quote markers.
loop_next_steps_section_lead(){ # file heading
  [ -f "$1" ] || return 0
  awk -v heading="## $2" '
    $0==heading { insec=1; next }
    /^## / { insec=0 }
    !insec { next }
    { line=$0; sub(/^[-*>[:space:]]+/, "", line); sub(/[[:space:]]+$/, "", line)
      if (line=="" || substr(line,1,1)=="|") next
      print substr(line, 1, 200); exit }' "$1"
}

loop_next_steps_open_blockers(){ # blockers file
  [ -f "$1" ] || { echo 0; return; }
  awk 'index($0,"- [ ]"){c++} END{print c+0}' "$1"
}

# Every evidence id referenced by a gate, in phase order.
loop_next_steps_gate_evidence(){ # state
  jq -r --argjson phases "$loop_next_steps_phases" '. as $st|$phases[]|($st.gates[.].evidence_ids // [])[]?' "$1" 2>/dev/null || :
}

loop_next_steps_content(){ # root
  local root=$1 loop state evidence item round max_rounds gates rework blockers verdict
  local run_ids last_ids next_item handover_lead decision_lead id value wi
  loop="$root/.loop"; state="$loop/state.json"; evidence="$loop/evidence"
  [ -f "$state" ] || return 1
  item=$(jq -r '.work_item_id // empty' "$state" 2>/dev/null) || return 1
  [ -n "$item" ] || return 1
  case "$item" in *[!A-Za-z0-9._-]*|'') return 1;; esac
  wi="$loop/work-items/$item.md"
  round=$(jq -r '.round // 0' "$state"); max_rounds=$(jq -r '.max_rounds // 0' "$state")
  gates=$(jq -r --argjson phases "$loop_next_steps_phases" '. as $st|$phases|map(.+" "+($st.gates[.].status // "PENDING"))|join(", ")' "$state")
  rework=$(jq -r --argjson phases "$loop_next_steps_phases" '. as $st|[$phases[]|select($st.gates[.].status=="FAILED")]|length' "$state")
  blockers=$(loop_next_steps_open_blockers "$loop/blockers.md")

  # Run ids: what the gate evidence records say they came from.
  run_ids=""
  while IFS= read -r id; do
    [ -n "$id" ] || continue
    case "$id" in *[!A-Za-z0-9._-]*) continue;; esac
    [ -f "$evidence/$id.json" ] || continue
    value=$(jq -r '.details.run_id // empty' "$evidence/$id.json" 2>/dev/null || :)
    [ -n "$value" ] || continue
    run_ids="$run_ids$value
"
  done <<EOF
$(loop_next_steps_gate_evidence "$state")
EOF
  run_ids=$(printf '%s' "$run_ids" | awk 'NF' | sort -u | awk 'NR>1{printf ", "}{printf "%s", $0} END{if (NR) printf "\n"}')
  [ -n "$run_ids" ] || run_ids='none recorded'

  # Review verdict: the last REVIEW evidence record that carries one.
  verdict='none recorded'
  while IFS= read -r id; do
    [ -n "$id" ] || continue
    case "$id" in *[!A-Za-z0-9._-]*) continue;; esac
    [ -f "$evidence/$id.json" ] || continue
    value=$(jq -r '.details.verdict // empty' "$evidence/$id.json" 2>/dev/null || :)
    case "$value" in PASS|FAIL) verdict=$value;; esac
  done <<EOF
$(jq -r '(.gates.REVIEW.evidence_ids // [])[]?' "$state" 2>/dev/null || :)
EOF

  last_ids=$(jq -r --argjson phases "$loop_next_steps_phases" '
    . as $st|($phases|map(select($st.gates[.].status=="PASSED" or $st.gates[.].status=="FAILED"))|last) as $lp|
    if $lp==null or (($st.gates[$lp].evidence_ids // [])|length)==0 then "none recorded" else ($st.gates[$lp].evidence_ids|join(", ")) end' "$state")

  next_item='none queued'
  if [ -f "$loop/backlog.json" ]; then
    value=$(jq -r '((.items // [])[0]) as $i|if $i==null or ($i.id//"")=="" then "" else ($i.id+": "+(($i.title // $i.id)|tostring|gsub("[\r\n]+";" ")|.[0:200])) end' "$loop/backlog.json" 2>/dev/null || :)
    [ -z "$value" ] || next_item=$value
  fi

  handover_lead=$(loop_next_steps_section_lead "$wi" Handover)
  decision_lead=$(loop_next_steps_section_lead "$wi" 'Open decisions')

  # Priorities, in the order the evidence justifies them; the first three win.
  local priorities=() phase status
  for phase in DEFINE DESIGN EXECUTE REVIEW VALIDATE HANDOVER; do
    status=$(jq -r --arg p "$phase" '.gates[$p].status // "PENDING"' "$state")
    [ "$status" = FAILED ] || continue
    priorities+=("Harden $phase: that gate failed in this run, so read its evidence before taking the same route again.")
  done
  if [ "$blockers" -gt 0 ]; then
    if [ "$blockers" -eq 1 ]; then priorities+=("Resolve the 1 open blocker recorded in .loop/blockers.md.")
    else priorities+=("Resolve the $blockers open blockers recorded in .loop/blockers.md."); fi
  fi
  [ "$verdict" != FAIL ] || priorities+=('Re-read the review findings: the last recorded verdict was FAIL, so this run is not verified success.')
  [ -z "$handover_lead" ] || priorities+=("Review the handover notes: $handover_lead")
  [ -z "$decision_lead" ] || priorities+=("Add a follow-up work item for the open decision: $decision_lead")
  priorities+=('Review the handover notes in the work item before anything else starts.')
  priorities+=('Add a follow-up work item for whatever the handover left open.')
  priorities+=('Confirm that the next item is still the right one after this change.')

  printf '# Next steps after %s\n\n' "$item"
  printf -- '- Work item: %s\n' "$item"
  printf -- '- Run ids: %s\n' "$run_ids"
  printf -- '- Generated at: %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  printf -- '- Advisory only, never an approval: a person decides what happens next.\n\n'
  printf '## Summary\n\n'
  printf -- '- Rounds used: %s of %s\n' "$round" "$max_rounds"
  printf -- '- Gate results: %s\n' "$gates"
  printf -- '- Review verdict: %s\n' "$verdict"
  printf -- '- Rework loops: %s\n' "$rework"
  printf -- '- Open blockers: %s\n\n' "$blockers"
  printf '## Priorities\n\n'
  local printed=0 seen="" entry
  for entry in "${priorities[@]}"; do
    [ "$printed" -lt 3 ] || break
    case "$seen" in *"[$entry]"*) continue;; esac
    seen="$seen[$entry]"; printed=$((printed+1))
    printf -- '- %s\n' "$entry"
  done
  printf '\n## Suggested next item\n\n'
  printf -- '- %s\n\n' "$next_item"
  printf '## References\n\n'
  printf -- '- Evidence of the last round: %s\n' "$last_ids"
}

# Atomic write. A note that cannot be produced is never half-written, and a
# failure here never fails the run: the note is advisory.
loop_write_next_steps(){ # root
  local root=$1 dir tmp
  dir="$root/.loop/notes"
  mkdir -p "$dir" 2>/dev/null || return 0
  tmp=$(mktemp "$dir/.next-steps.XXXXXX") 2>/dev/null || return 0
  if loop_next_steps_content "$root" > "$tmp" 2>/dev/null; then
    chmod 600 "$tmp" 2>/dev/null || :
    mv "$tmp" "$dir/next-steps.md"
  else
    rm -f "$tmp"
  fi
  return 0
}
