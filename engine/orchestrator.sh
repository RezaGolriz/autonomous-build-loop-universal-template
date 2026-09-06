#!/usr/bin/env bash
# Orchestrator core: drives one bounded node per phase and delegates every gate
# decision to engine/reference-engine.sh. It never re-implements a gate.
set -euo pipefail

self_dir=$(cd "$(dirname "$0")" && pwd -P)
engine="$self_dir/reference-engine.sh"
repo_root=$(cd "$self_dir/.." && pwd -P)
die(){ echo "ERROR: $1" >&2; exit "${2:-64}"; }
need(){ command -v "$1" >/dev/null 2>&1 || die "missing executable: $1" 69; }
need jq; need git
[ -x "$engine" ] || die 'reference engine missing' 69

mode=${1:-}; [ -n "$mode" ] || die 'mode required'; shift
root= host= provider= max_nodes=1
while [ $# -gt 0 ]; do
  case "$1" in
    --root) root=$2; shift 2;; --host) host=$2; shift 2;; --provider) provider=$2; shift 2;;
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

now(){ date -u '+%Y-%m-%dT%H:%M:%SZ'; }
lower(){ printf '%s' "$1" | tr 'A-Z' 'a-z'; }
head_rev(){ git -C "$root" rev-parse HEAD 2>/dev/null || echo unversioned; }

# Copied verbatim from engine/reference-engine.sh so orchestrator writes cannot weaken it.
validate_state(){
  jq -e 'type=="object" and ((keys-["schema_version","work_item_id","phase","run_status","step","round","max_rounds","gate_failures_here","max_gate_failures","started_epoch","max_wall_seconds","autonomy","gates","last_result","next_action","updated_at"])|length==0) and .schema_version==1 and
    (.work_item_id|test("^[A-Za-z0-9][A-Za-z0-9._-]*$")) and (.phase as $p|["DEFINE","DESIGN","EXECUTE","REVIEW","VALIDATE","HANDOVER"]|index($p)!=null) and
    (.run_status as $s|["PAUSED","RUNNING","BLOCKED","WAITING_FOR_HUMAN","COMPLETED","CANCELLED"]|index($s)!=null) and
    all([.step,.next_action,.updated_at][];type=="string" and length>0) and (.last_result|type=="string") and
    all([.round,.max_rounds,.gate_failures_here,.max_gate_failures][];type=="number" and .>=0 and floor==.) and .max_rounds>=1 and .max_gate_failures>=1 and
    (if .run_status=="RUNNING" then (.started_epoch|type=="number" and .>=0 and floor==.) and (.max_wall_seconds|type=="number" and .>=1 and floor==.) else ((.started_epoch//0)|type=="number") and ((.max_wall_seconds//1)|type=="number") end) and
    (.autonomy as $a|["supervised","guarded","autonomous"]|index($a)!=null) and (.gates|type=="object" and (keys|sort)==(["DEFINE","DESIGN","EXECUTE","REVIEW","VALIDATE","HANDOVER"]|sort)) and
    all(.gates|to_entries[];.value|type=="object" and ((keys-["status","evidence_ids"])|length==0) and (.status as $x|["PENDING","PASSED","FAILED","NOT_APPLICABLE"]|index($x)!=null) and (.evidence_ids|type=="array" and length==(unique|length))) and .gates.REVIEW.status!="NOT_APPLICABLE"' "$1" >/dev/null
}

write_state(){
  tmp=$(mktemp "$loop/.state.XXXXXX")
  jq "$@" "$state" > "$tmp" || { rm -f "$tmp"; die 'state update failed'; }
  validate_state "$tmp" || { rm -f "$tmp"; die 'resulting state invalid'; }
  mv "$tmp" "$state"
}

open_blockers(){ [ -f "$loop/blockers.md" ] || { echo 0; return; }; awk 'index($0,"- [ ]"){c++} END{print c+0}' "$loop/blockers.md"; }

print_status(){
  jq -n --slurpfile s "$state" --slurpfile w "$workflow_file" --argjson ob "$(open_blockers)" '
    $s[0] as $st | (["DEFINE","DESIGN","EXECUTE","REVIEW","VALIDATE","HANDOVER"]|map(select($st.gates[.].status=="PASSED" or $st.gates[.].status=="FAILED"))|last) as $lp | {
      work_item_id:$st.work_item_id, phase:$st.phase, run_status:$st.run_status, round:$st.round,
      gate_failures_here:$st.gate_failures_here, gates:$st.gates,
      legal_next:{green:[$w[0].green_transitions[]|select(.from==$st.phase)|.to],
                  rework:[$w[0].rework_transitions[]|select(.from==$st.phase)|{to,defect_class}]},
      open_blockers:$ob,
      last_evidence_ids:(if $lp==null then [] else $st.gates[$lp].evidence_ids end)}'
}

phase_task(){ case "$1" in
  DEFINE) echo 'Write testable acceptance criteria and explicit exclusions into the work item.';;
  DESIGN) echo 'Write the design and the independently provable execution slices into the work item.';;
  EXECUTE) echo 'Produce the declared artifact for the current slice inside the allowed paths only.';;
  REVIEW) echo 'Review the exact durable change and the referenced evidence, then return a verdict.';;
  VALIDATE) echo 'Confirm acceptance and regression evidence for the work item.';;
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

host_card(){ for f in "$repo_root/hosts/$host/CLAUDE.md" "$repo_root/hosts/$host/AGENTS.md"; do [ -f "$f" ] && { cat "$f"; return 0; }; done; :; }

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
  slice_rows | awk -v row="$1" -v col="$2" 'NR==row { n=split($0, f, "|"); if (col+1 <= n) print f[col+1] }' | tr ',' '\n' | tr -d '`'
}
paths_json(){ printf '%s\n' "$1" | jq -Rsc 'split("\n")|map(gsub("^[ \t]+|[ \t]+$";""))|map(select(length>0))|unique'; }
current_slice(){ local st n; st=$(jq -r '.step' "$state"); n=$(slice_count); cur=1
  case "$st" in slice-[0-9]*) cur=${st#slice-};; esac
  [ "$cur" -ge 1 ] 2>/dev/null || cur=1; [ "$n" -eq 0 ] || [ "$cur" -le "$n" ] || cur=$n; echo "$cur"; }

build_brief(){
  local task succ cap vids outs ap fp card prompt
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
    ap=$(paths_json "$(slice_col "$cur" 2 || true)"); [ "$ap" != '[]' ] || ap='["src/**","tests/**"]'
    fp=$(paths_json "$(slice_col "$cur" 3 || true)"); [ "$fp" != '[]' ] || fp='["requirements/**"]'
    if [ "$slices" -gt 0 ]; then task="Slice $cur of $slices: $(slice_col "$cur" 1 | tr '\n' ' ' | sed 's/[[:space:]]*$//'). $task"; fi
  else
    ap='[".loop/work-items/**"]'; fp='["requirements/**"]'
  fi
  card=$(host_card)
  prompt=$(printf '%s\n\n# Work item %s (file: %s)\n\n%s\n\n# Current loop state\n\n%s\n\n# Node task (%s)\n\n%s\n\nSuccess condition: %s\n\n# Path policy for this node\n\nYou may change only these paths (glob patterns): %s\nFrozen for this node: %s\nEverything else must stay unchanged. For DEFINE, DESIGN and HANDOVER the work item file above is the only file to edit; the adapter protected_paths apply to product code, not to this edit.\n' \
    "$card" "$work" ".loop/work-items/$work.md" "$(cat "$wi")" "$(cat "$state")" "$phase" "$task" "$succ" "$(jq -r 'join(", ")' <<<"$ap")" "$(jq -r 'join(", ")' <<<"$fp")")
  jq -n --arg run "$run_id" --arg node "$(lower "$phase")-$round" --arg gate "$phase" --arg w "$work" \
    --arg p "$phase" --arg task "$task" --arg cap "$cap" --arg succ "$succ" --argjson v "$vids" \
    --argjson o "$outs" --argjson ap "$ap" --argjson fp "$fp" --argjson cap_n "$(jq -r .max_gate_failures "$state")" --arg prompt "$prompt" \
    '{schema_version:1,run_id:$run,node_id:$node,gate_id:$gate,work_item_id:$w,phase:$p,trigger:"orchestrator",
      task:$task,actor_capability:$cap,success_condition:$succ,verifier_ids:$v,input_artifacts:[],output_artifacts:$o,
      allowed_paths:$ap,frozen_paths:$fp,retry_cap:$cap_n,escalation_target:"human",prompt:$prompt}'
}

call_provider(){ # brief out err
  local name; env_args=()
  while IFS= read -r name; do env_args+=("$name=${!name-}"); done < <(jq -r '.environment.allow_names[]' "$adapter_file")
  ( cd "$root" && env -i "${env_args[@]}" LOOP_ROOT="$root" LOOP_PHASE="$phase" LOOP_RUN_ID="$run_id" \
      LOOP_WORK_ITEM="$work" "$prov_abs" ) <"$1" >"$2" 2>"$3"
}

has_section(){ awk -v h="$1" '$0==h{f=1;next} /^## /{f=0} f&&NF{c++} END{exit c?0:1}' "$wi"; }

changed_paths(){ # baseline after
  jq -n -r --slurpfile b "$1" --slurpfile a "$2" '
    ((($b[0].files+$a[0].files)|map(.path)|unique)[]) as $p |
    (($b[0].files|map(select(.path==$p))|.[0])//null) as $x |
    (($a[0].files|map(select(.path==$p))|.[0])//null) as $y |
    select($x!=$y) | select(($p|startswith(".loop/evidence/"))|not) | select($p!=".loop/engine.lock") | select(($p|startswith(".loop/orchestrator.lock"))|not) | $p'
}

write_orch_evidence(){ # id type result observation
  jq -n --arg id "$1" --arg w "$work" --arg p "$phase" --arg t "$2" --arg r "$3" --arg rev "$rev" \
    --arg env "$(uname -srm)" --arg at "$(now)" --arg o "$4" \
    '{schema_version:1,evidence_id:$id,work_item_id:$w,phase:$p,evidence_type:$t,result:$r,producer:"orchestrator",
      revision:$rev,environment:$env,captured_at:$at,artifacts:[],details:{observation:$o}}' > "$evidence_dir/$1.json"
}

go_blocked(){ # text
  mkdir -p "$loop"
  [ -f "$loop/blockers.md" ] || printf '# Blockers\n\n' > "$loop/blockers.md"
  printf -- '- [ ] %s %s: %s\n' "$phase" "$run_id" "$1" >> "$loop/blockers.md"
  write_state --arg n "$(now)" '.run_status="BLOCKED"|.last_result="blocked"|.next_action="resolve blocker"|.updated_at=$n'
  print_status; exit 1
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
  if git -C "$root" rev-parse HEAD >/dev/null 2>&1; then git -C "$root" diff HEAD -- . ':(exclude).loop'; else git -C "$root" status --short; fi
  git -C "$root" ls-files --others --exclude-standard -- . ':(exclude).loop' | while IFS= read -r f; do
    [ -n "$f" ] || continue; git -C "$root" diff --no-index -- /dev/null "$f" || :
  done
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

case "$mode" in
start)
  require_files
  [ "$(jq -r .run_status "$state")" = PAUSED ] || die 'start requires run_status PAUSED' 65
  [ ! -e "$loop/engine.lock" ] || die 'workspace is already locked' 73
  write_state --arg n "$(now)" --argjson e "$(date +%s)" '.run_status="RUNNING"|.started_epoch=$e|.updated_at=$n'
  print_status; exit 0;;
status)
  require_files; print_status; exit 0;;
resume)
  require_files
  [ "$(jq -r .run_status "$state")" = BLOCKED ] || die 'resume requires run_status BLOCKED' 65
  [ "$(open_blockers)" -eq 0 ] || die 'open blockers remain' 65
  write_state --arg n "$(now)" --argjson e "$(date +%s)" '.run_status="RUNNING"|.started_epoch=$e|.last_result="resumed"|.next_action=("continue "+.phase)|.updated_at=$n'
  print_status; exit 0;;
loop)
  require_files
  [ -n "$max_nodes" ] || max_nodes=1
  i=0
  while [ "$i" -lt "$max_nodes" ]; do
    set +e; "$self_dir/orchestrator.sh" run --root "$root" --host "$host" --provider "$provider" >/dev/null; rc=$?; set -e
    [ "$rc" -le 1 ] || die "run failed with exit $rc" "$rc"
    i=$((i+1))
    should_continue || break
  done
  print_status
  [ "$(jq -r .run_status "$state")" != BLOCKED ] || exit 1
  exit 0;;
next|run) ;;
*) die "unknown mode: $mode";;
esac

require_files
[ -n "$host" ] || die '--host is required'
phase=$(jq -r .phase "$state"); round=$(jq -r .round "$state")
run_id="run-$work-$round-$(lower "$phase")"
rev=$(head_rev)

if [ "$mode" = next ]; then build_brief; exit 0; fi

# ---- run ----
[ -n "$provider" ] || die '--provider is required'
[ -x "$prov_abs" ] || die "provider not executable: $provider" 69
[ ! -e "$loop/engine.lock" ] || die 'workspace is already locked' 73
if [ "$(jq -r .run_status "$state")" != RUNNING ]; then
  handover_pending || die 'run requires run_status RUNNING' 65
  write_state --arg n "$(now)" --argjson e "$(date +%s)" '.run_status="RUNNING"|.started_epoch=(if (.started_epoch//0)>0 then .started_epoch else $e end)|.updated_at=$n'
fi

olock="$loop/orchestrator.lock"; mkdir "$olock" 2>/dev/null || die 'another orchestrator run is active' 73; echo $$ > "$olock/pid"
tmp=$(mktemp -d "${TMPDIR:-/tmp}/loop-orch.XXXXXX"); trap 'rm -rf "$tmp"; rm -f "$olock/pid"; rmdir "$olock" 2>/dev/null||:' EXIT INT TERM
mkdir -p "$evidence_dir" "$evidence_dir/$run_id/logs"
"$engine" snapshot --root "$root" --output "$tmp/baseline.json"
build_brief > "$tmp/brief.json"
jq 'del(.prompt)' "$tmp/brief.json" > "$tmp/node.json"
perr="$evidence_dir/$run_id/logs/provider.stderr"
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
  rprompt=$(printf '%s\n\n# Work item %s\n\n%s\n\n# Durable change\n\n```diff\n%s\n```\n\n# Referenced evidence\n%s\n\n# Instruction\n\n%s\nReturn one verdict JSON echoing run_id, work_item_id, nonce, revision and evidence_refs from this brief.\n' \
    "$(host_card)" "$work" "$(cat "$wi")" "$diff_text" "$ev_text" "$(phase_task REVIEW)")
  jq -n --slurpfile n "$tmp/node.json" --slurpfile c "$tmp/challenge.json" --arg prompt "$rprompt" \
    '$n[0] + {run_id:$c[0].run_id, work_item_id:$c[0].work_item_id, nonce:$c[0].nonce, revision:$c[0].revision, evidence_refs:$c[0].evidence_refs, prompt:$prompt}' > "$tmp/review-brief.json"
  set +e; call_provider "$tmp/review-brief.json" "$tmp/verdict.json" "$perr"; prc=$?; set -e
  if [ "$prc" -ne 0 ] || ! jq -e . "$tmp/verdict.json" >/dev/null 2>&1; then go_blocked 'invalid verdict'; fi
  set +e; "$engine" validate-verdict --challenge "$tmp/challenge.json" --verdict "$tmp/verdict.json" --evidence-dir "$evidence_dir" >/dev/null 2>>"$perr"; vrc=$?; set -e
  [ "$vrc" -le 1 ] || go_blocked 'invalid verdict'
  ev_ids="review-$exec_run"
  [ "$vrc" -eq 0 ] || { passed=0; defect=$(jq -r '[.findings[]?|select(.disposition=="OPEN" and (.severity=="BLOCKING" or .severity=="HIGH"))][0].category // "artifact"' "$tmp/verdict.json"); }
else
  set +e; call_provider "$tmp/brief.json" "$tmp/result.json" "$perr"; prc=$?; set -e
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
        fi;;
      *)
        etype=contract; [ "$phase" != HANDOVER ] || etype=documentation
        obs="Required work item sections for $phase are present and every changed path is allowed."
        result=PASSED
        case "$phase" in
          DEFINE) has_section '## Acceptance criteria' && has_section '## Out of scope' || { result=FAILED; obs="DEFINE requires non-empty acceptance criteria and out-of-scope sections."; };;
          DESIGN) has_section '## Design' && has_section '## Execution slices' || { result=FAILED; obs="DESIGN requires non-empty design and execution slices sections."; };;
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
fi

if [ "$passed" -eq 1 ]; then
  if [ "$phase" = HANDOVER ]; then
    write_state --arg id "$ev_ids" --arg n "$(now)" \
      '.gates.HANDOVER={status:"PASSED",evidence_ids:[$id]}|.run_status="WAITING_FOR_HUMAN"|.round=(.round+1)|.last_result="gate PASSED"|.next_action="await human decision"|.updated_at=$n'
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
  *) go_blocked "gate failed (${defect:-artifact})";;
esac
