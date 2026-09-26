#!/usr/bin/env bash
set -euo pipefail

self_dir=$(cd "$(dirname "$0")" && pwd -P)
. "$self_dir/common.sh"

die(){ echo "ERROR: $1" >&2; exit "${2:-64}"; }
need(){ command -v "$1" >/dev/null 2>&1 || die "missing executable: $1" 69; }
need jq; need shasum; need find
mode=${1:-}; [ -n "$mode" ] || die 'mode required'; shift
root= adapter= node= baseline= phase= output= evidence_dir= challenge= verdict= run_id= work_item= state= workflow= to= defect_class=
refs=()
while [ $# -gt 0 ]; do
  case "$1" in
    --root) root=$2; shift 2;; --adapter) adapter=$2; shift 2;; --node) node=$2; shift 2;;
    --baseline) baseline=$2; shift 2;; --phase) phase=$2; shift 2;; --output) output=$2; shift 2;;
    --evidence-dir) evidence_dir=$2; shift 2;; --challenge) challenge=$2; shift 2;; --verdict) verdict=$2; shift 2;;
    --run-id) run_id=$2; shift 2;; --work-item) work_item=$2; shift 2;; --evidence-ref) refs+=("$2"); shift 2;;
    --state) state=$2; shift 2;; --workflow) workflow=$2; shift 2;; --to) to=$2; shift 2;; --defect-class) defect_class=$2; shift 2;;
    *) die "unknown argument: $1";;
  esac
done
now(){ date -u '+%Y-%m-%dT%H:%M:%SZ'; }
safe_path(){ case "$1" in ''|/*|..|../*|*/..|*/../*|*[$'\n\r']*) return 1;; esac; }
physical_under_root(){ local phys; phys=$(cd "$1" 2>/dev/null&&pwd -P)||return 1; case "$phys/" in "$root/"*) printf '%s\n' "$phys";; *) return 1;; esac; }
no_symlink_prefix(){ rel=$1; cur=$root; oldifs=$IFS; IFS=/; set -- $rel; IFS=$oldifs; for part in "$@"; do case "$part" in *'*'*|*'?'*|*'['*) break;; esac; cur="$cur/$part"; [ ! -L "$cur" ]||return 1; done; }
lock_workspace(){ mkdir -p "$root/.loop"; lock="$root/.loop/engine.lock"; mkdir "$lock" 2>/dev/null||die 'workspace is already locked' 73; echo $$ > "$lock/pid"; }
unlock_workspace(){ [ -z "${lock:-}" ]||rm -f "$lock/pid" 2>/dev/null||:; [ -z "${lock:-}" ]||rmdir "$lock" 2>/dev/null||:; }

snapshot(){ loop_snapshot "$root" "$1" source; }
protected_snapshot(){ loop_snapshot "$root" "$1" supervisor; }
validate_evidence(){
  jq -e 'type=="object" and ((keys-["schema_version","evidence_id","work_item_id","phase","evidence_type","result","producer","revision","environment","captured_at","artifacts","details"])|length==0) and
    .schema_version==1 and (.evidence_id|test("^[A-Za-z0-9][A-Za-z0-9._-]*$")) and (.work_item_id|test("^[A-Za-z0-9][A-Za-z0-9._-]*$")) and
    (.phase as $p|["DEFINE","DESIGN","EXECUTE","REVIEW","VALIDATE","HANDOVER"]|index($p)!=null) and
    (.evidence_type as $t|["acceptance","command","artifact","behavior","contract","installation","package","documentation","link-check","independent-review"]|index($t)!=null) and
    (.result as $r|["PASSED","FAILED","BLOCKED"]|index($r)!=null) and all([.producer,.revision,.environment][];type=="string" and length>0) and (.captured_at|test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")) and
    (.artifacts|type=="array" and length==(unique|length) and all(.[];type=="string" and length>0)) and
    (.details|type=="object" and ((keys-["command_id","command_evidence_id","exit_code","verdict","finding_count","observation","criterion_ids","run_id","gate_id","argv","cwd","started_at","finished_at","duration_milliseconds","stdout_sha256","stderr_sha256","adapter_sha256","node_sha256","environment_names"])|length==0)) and
    (if .evidence_type=="command" then (.details|(["command_id","exit_code","run_id","gate_id","argv","cwd","started_at","finished_at","duration_milliseconds","stdout_sha256","stderr_sha256","adapter_sha256","node_sha256","environment_names"]-keys|length)==0 and
      (.argv|type=="array" and length>0) and (.exit_code|type=="number" and floor==.) and (.duration_milliseconds|type=="number" and .>=0 and floor==.) and
      all([.stdout_sha256,.stderr_sha256,.adapter_sha256,.node_sha256][];test("^[0-9a-f]{64}$")))
     elif .evidence_type=="independent-review" then (.phase=="REVIEW" and (.details.verdict=="PASS" or .details.verdict=="FAIL") and (.details.finding_count|type=="number" and .>=0))
     else (.details.observation|type=="string" and length>0) and (if .details.command_id then all([.details.command_id,.details.command_evidence_id,.details.run_id,.details.gate_id][];type=="string" and length>0) and all([.details.stdout_sha256,.details.stderr_sha256][];test("^[0-9a-f]{64}$")) else true end) end)' "$1" >/dev/null
}
validate_log_binding(){
  record=$1; base=$2; command_id=$(jq -r '.details.command_id // empty' "$record")
  [ -n "$command_id" ] || return 0
  [[ "$command_id" =~ ^[a-z][a-z0-9-]*$ ]] || return 1
  log_run=$(jq -r '.details.run_id // empty' "$record"); [[ "$log_run" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || return 1
  command_evidence_id=$(jq -r '.details.command_evidence_id // .evidence_id' "$record")
  [ "$command_evidence_id" = "$log_run-$command_id" ] || return 1
  for stream in stdout stderr; do
    log_file="$base/$log_run/logs/$command_id.$stream"; [ -f "$log_file" ] || return 1
    expected=$(jq -r ".details.${stream}_sha256 // empty" "$record"); actual=$(shasum -a 256 "$log_file"|awk '{print $1}')
    [ "$expected" = "$actual" ] || return 1
  done
}

if [ "$mode" = snapshot ] || [ "$mode" = protected-snapshot ]; then
  [ -d "$root" ] || die 'root missing'; [ -n "$output" ] || die 'output missing'; root=$(cd "$root"&&pwd -P)
  if [ "$mode" = snapshot ]; then snapshot "$output"; else protected_snapshot "$output"; fi
  exit
fi

if [ "$mode" = issue-review ]; then
  [[ "$run_id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || die 'bad run id'
  [[ "$work_item" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || die 'bad work item'
  [ -n "$output" ] && [ ${#refs[@]} -gt 0 ] && [ -d "$evidence_dir" ] || die 'output, evidence dir, and evidence refs required'
  rj=$(printf '%s\n' "${refs[@]}"|jq -Rsc 'split("\n")|map(select(length>0))')
  jq -e 'length==(unique|length) and all(.[];test("^[A-Za-z0-9][A-Za-z0-9._-]*$"))' <<<"$rj" >/dev/null || die 'bad evidence refs'
  digests='{}'; revision=
  for id in "${refs[@]}"; do
    f="$evidence_dir/$id.json"
    [ -f "$f" ] && validate_evidence "$f" && validate_log_binding "$f" "$evidence_dir" || die "invalid evidence: $id"
    jq -e --arg id "$id" --arg w "$work_item" --arg r "$run_id" '.evidence_id==$id and .work_item_id==$w and .details.run_id==$r' "$f" >/dev/null || die "stale evidence: $id"
    thisrev=$(jq -r .revision "$f"); [ -z "$revision" ]||[ "$revision" = "$thisrev" ]||die 'mixed evidence revisions'; revision=$thisrev
    h=$(shasum -a 256 "$f"|awk '{print $1}'); digests=$(jq -c --arg id "$id" --arg h "$h" '.+{($id):$h}' <<<"$digests")
  done
  nonce=$(printf '%s:%s:%s' "$$" "$(date +%s)" "$run_id"|shasum -a 256|awk '{print $1}')
  jq -n --arg r "$run_id" --arg w "$work_item" --arg n "$nonce" --arg rev "$revision" --arg at "$(now)" --argjson e "$rj" --argjson d "$digests" '{schema_version:1,run_id:$r,work_item_id:$w,gate_id:"REVIEW",nonce:$n,revision:$rev,created_at:$at,evidence_refs:$e,evidence_digests:$d}' > "$output"
  exit
fi

if [ "$mode" = validate-verdict ]; then
  [ -f "$challenge" ] && [ -f "$verdict" ] && [ -d "$evidence_dir" ] || die 'challenge, verdict, or evidence missing'
  jq -e 'type=="object" and ((keys-["schema_version","run_id","work_item_id","gate_id","nonce","revision","created_at","evidence_refs","evidence_digests"])|length==0) and .schema_version==1 and .gate_id=="REVIEW" and (.nonce|test("^[0-9a-f]{64}$")) and all([.run_id,.work_item_id,.revision,.created_at][];type=="string" and length>0) and (.evidence_refs|length>0 and length==(unique|length)) and (.evidence_digests|type=="object")' "$challenge" >/dev/null || die 'bad challenge'
  jq -e 'type=="object" and ((keys-["schema_version","verdict_id","run_id","work_item_id","phase","gate_id","nonce","result","reviewer","independent","revision","captured_at","evidence_refs","findings"])|length==0) and
    .schema_version==1 and .phase=="REVIEW" and .gate_id=="REVIEW" and (.result=="PASS" or .result=="FAIL") and .independent==true and
    (.verdict_id|type=="string" and length>0) and (.reviewer|type=="string" and length>0) and (.revision|type=="string" and length>0) and (.captured_at|test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")) and
    (.evidence_refs|length>0 and length==(unique|length)) and (.findings|type=="array" and all(.[];type=="object" and ((keys-["severity","category","evidence","disposition"])|length==0) and (.severity as $s|["BLOCKING","HIGH","MEDIUM","LOW"]|index($s)!=null) and (.category as $c|["requirement","design","artifact","safety"]|index($c)!=null) and (.disposition as $d|["OPEN","DISMISSED"]|index($d)!=null) and (.evidence|type=="string" and length>0)))' "$verdict" >/dev/null || die 'bad verdict schema'
  jq -e --slurpfile c "$challenge" '.run_id==$c[0].run_id and .work_item_id==$c[0].work_item_id and .gate_id==$c[0].gate_id and .nonce==$c[0].nonce and .revision==$c[0].revision and ((.evidence_refs|sort)==($c[0].evidence_refs|sort))' "$verdict" >/dev/null || die 'verdict challenge mismatch'
  good=1
  while IFS= read -r id; do
    f="$evidence_dir/$id.json"
    [ -f "$f" ] && validate_evidence "$f" && validate_log_binding "$f" "$evidence_dir" || die "missing or invalid evidence: $id"
    expected=$(jq -r --arg id "$id" '.evidence_digests[$id]' "$challenge"); actual=$(shasum -a 256 "$f"|awk '{print $1}'); [ "$expected" = "$actual" ]||die "evidence changed after challenge: $id"
    jq -e --arg id "$id" --slurpfile c "$challenge" '.evidence_id==$id and .result=="PASSED" and .work_item_id==$c[0].work_item_id and .revision==$c[0].revision and .details.run_id==$c[0].run_id' "$f" >/dev/null || good=0
  done < <(jq -r '.evidence_refs[]' "$challenge")
  open=$(jq '[.findings[]|select(.disposition=="OPEN" and (.severity=="BLOCKING" or .severity=="HIGH"))]|length' "$verdict")
  result=PASSED; [ "$(jq -r .result "$verdict")" = PASS ] && [ "$good" -eq 1 ] && [ "$open" -eq 0 ] || result=FAILED
  consumed="$challenge.consumed"; mkdir "$consumed" 2>/dev/null||die 'review challenge was already consumed'; trap 'rmdir "$consumed" 2>/dev/null||:' EXIT INT TERM
  id="review-$(jq -r .run_id "$verdict")"; dest=${output:-"$evidence_dir/$id.json"}
  jq -n --arg id "$id" --arg w "$(jq -r .work_item_id "$verdict")" --arg r "$result" --arg rev "$(jq -r .revision "$verdict")" --arg t "$(now)" --arg v "$(jq -r .result "$verdict")" --argjson c "$(jq '.findings|length' "$verdict")" '{schema_version:1,evidence_id:$id,work_item_id:$w,phase:"REVIEW",evidence_type:"independent-review",result:$r,producer:"reference-engine",revision:$rev,environment:"supervisor",captured_at:$t,artifacts:[],details:{verdict:$v,finding_count:$c}}' > "$dest"
  echo "$dest"; trap - EXIT INT TERM; [ "$result" = PASSED ] || exit 1; exit
fi

validate_state(){ loop_validate_state "$1"; }
validate_workflow(){
  jq -e 'type=="object" and ((keys-["schema_version","workflow_id","phases","green_transitions","rework_transitions","mandatory_independent_review"])|length==0) and .schema_version==1 and .workflow_id=="universal-v1" and .phases==["DEFINE","DESIGN","EXECUTE","REVIEW","VALIDATE","HANDOVER"] and .mandatory_independent_review==true and
    .green_transitions==[{"from":"DEFINE","to":"DESIGN"},{"from":"DESIGN","to":"EXECUTE"},{"from":"EXECUTE","to":"EXECUTE"},{"from":"EXECUTE","to":"REVIEW"},{"from":"REVIEW","to":"VALIDATE"},{"from":"VALIDATE","to":"HANDOVER"}] and
    .rework_transitions==[{"from":"DESIGN","to":"DEFINE","defect_class":"requirement"},{"from":"REVIEW","to":"DEFINE","defect_class":"requirement"},{"from":"REVIEW","to":"DESIGN","defect_class":"design"},{"from":"REVIEW","to":"EXECUTE","defect_class":"artifact"},{"from":"VALIDATE","to":"DEFINE","defect_class":"requirement"},{"from":"VALIDATE","to":"DESIGN","defect_class":"design"},{"from":"VALIDATE","to":"EXECUTE","defect_class":"artifact"}]' "$1" >/dev/null
}

mark_cap_blocked(){
  local cap_reason=$1 cap_tmp cap_action
  case "$cap_reason" in
    'round cap reached') cap_action='raise max_rounds or cancel the run' ;;
    'retry cap reached') cap_action='raise max_gate_failures or cancel the run' ;;
    'wall clock cap reached') cap_action='raise max_wall_seconds or cancel the run' ;;
    *) cap_action='repair the invalid run budget before resuming' ;;
  esac
  cap_tmp=$(mktemp "$(dirname "$state")/.state.XXXXXX")
  jq --arg reason "$cap_reason" --arg action "$cap_action" --arg at "$(now)" \
    '.run_status="BLOCKED"|.last_result=("blocked: "+$reason)|.next_action=$action|.updated_at=$at' "$state" > "$cap_tmp"
  loop_apply_pause_accounting "$cap_tmp" "$state" || { rm -f "$cap_tmp"; die 'capped state update failed'; }
  validate_state "$cap_tmp" || { rm -f "$cap_tmp"; die 'resulting capped state invalid'; }
  chmod --reference="$state" "$cap_tmp" 2>/dev/null || :
  mv "$cap_tmp" "$state"
  append_cap_blocker "$cap_reason"
  die "$cap_reason" 1
}

append_cap_blocker(){
  local cap_reason=$1 blockers cap_line
  blockers="$(dirname "$state")/blockers.md"
  [ -f "$blockers" ] || printf '# Blockers\n\n' > "$blockers"
  cap_line="- [ ] $(jq -r .phase "$state") cap: $cap_reason"
  grep -Fqx -- "$cap_line" "$blockers" 2>/dev/null || printf '%s\n' "$cap_line" >> "$blockers"
}

if [ "$mode" = transition ]; then
  [ -d "$root" ] && [ -f "$state" ] && [ -f "$workflow" ] && [ -f "$adapter" ] && [ -d "$evidence_dir" ] && [ ${#refs[@]} -gt 0 ] || die 'transition inputs missing'
  root=$(cd "$root"&&pwd -P); validate_state "$state"||die 'state validation failed'; validate_workflow "$workflow"||die 'workflow validation failed'
  jq -e 'type=="object" and ((keys-["schema_version","adapter_id","project_kind","target","artifacts","commands","validation","protected_paths","environment"])|length==0) and .schema_version==1 and (.validation|type=="object" and ((keys-["required_evidence"])|length==0) and (.required_evidence|type=="array" and length>0 and length==(unique|length))) and (.environment|type=="object" and ((keys-["allow_names"])|length==0))' "$adapter" >/dev/null||die 'adapter validation failed'
  [ "$(jq -r .run_status "$state")" = RUNNING ]||die 'state is not RUNNING'; current=$(jq -r .phase "$state")
  lock_workspace; trap 'unlock_workspace' EXIT INT TERM
  [ "$(jq -r .round "$state")" -lt "$(jq -r .max_rounds "$state")" ]||mark_cap_blocked 'round cap reached'
  [ "$(jq -r .gate_failures_here "$state")" -lt "$(jq -r .max_gate_failures "$state")" ]||mark_cap_blocked 'retry cap reached'
  started=$(jq -r .started_epoch "$state"); [ "$started" -gt 0 ]||mark_cap_blocked 'running state has no start time'
  [ "$(loop_elapsed_seconds "$state")" -le "$(jq -r .max_wall_seconds "$state")" ]||mark_cap_blocked 'wall clock cap reached'
  work=$(jq -r .work_item_id "$state"); revision=$(git -C "$root" rev-parse HEAD 2>/dev/null||echo unversioned); types='[]'; allpass=1
  for id in "${refs[@]}"; do f="$evidence_dir/$id.json"; [ -f "$f" ]&&validate_evidence "$f"&&validate_log_binding "$f" "$evidence_dir"||die "invalid transition evidence: $id"; jq -e --arg id "$id" --arg w "$work" --arg p "$current" --arg rev "$revision" '.evidence_id==$id and .work_item_id==$w and .phase==$p and .revision==$rev' "$f" >/dev/null||die "stale transition evidence: $id"; [ "$(jq -r .result "$f")" = PASSED ]||allpass=0; t=$(jq -r .evidence_type "$f"); types=$(jq -c --arg t "$t" '.+[$t]|unique'<<<"$types"); done
  case "$current" in
    VALIDATE) required=$(jq -c '.validation.required_evidence|sort' "$adapter") ;;
    REVIEW) required='["independent-review"]' ;;
    *) required='[]' ;;
  esac
  jq -e --argjson have "$types" --argjson req "$required" '$req-($have|unique)|length==0' <<<null >/dev/null||die 'required evidence types missing'
  [ "$current" != REVIEW ]||jq -e 'index("independent-review")!=null'<<<"$types" >/dev/null||die 'independent review evidence missing'
  if [ "$allpass" -eq 1 ]; then jq -e --arg f "$current" --arg t "$to" '.green_transitions|any(.from==$f and .to==$t)' "$workflow" >/dev/null||die 'illegal green transition'; gate=PASSED; failures=0; status=RUNNING
  else [ -n "$defect_class" ]||die 'failed gate requires defect class'; jq -e --arg f "$current" --arg t "$to" --arg d "$defect_class" '.rework_transitions|any(.from==$f and .to==$t and .defect_class==$d)' "$workflow" >/dev/null||die 'illegal rework transition'; gate=FAILED; failures=$(( $(jq -r .gate_failures_here "$state")+1 )); status=RUNNING; [ "$failures" -lt "$(jq -r .max_gate_failures "$state")" ]||status=BLOCKED; fi
  [ "$to" != HANDOVER ]||status=WAITING_FOR_HUMAN; idsjson=$(printf '%s\n' "${refs[@]}"|jq -Rsc 'split("\n")|map(select(length>0))'); tmp=$(mktemp "$(dirname "$state")/.state.XXXXXX")
  jq --arg phase "$to" --arg gate "$gate" --arg status "$status" --arg now "$(now)" --argjson failures "$failures" --argjson ids "$idsjson" '.gates[.phase]={status:$gate,evidence_ids:$ids}|.phase=$phase|.run_status=$status|.round+=1|.gate_failures_here=$failures|.last_result=("gate "+$gate)|.next_action=(if $status=="BLOCKED" then "raise max_gate_failures or cancel the run" else "continue "+$phase end)|.updated_at=$now' "$state" > "$tmp"
  loop_apply_pause_accounting "$tmp" "$state" || { rm -f "$tmp"; die 'state update failed'; }
  validate_state "$tmp"||{ rm -f "$tmp"; die 'resulting state invalid'; }; chmod --reference="$state" "$tmp" 2>/dev/null||:; mv "$tmp" "$state"
  [ "$status" != BLOCKED ] || append_cap_blocker 'retry cap reached'
  trap - EXIT INT TERM; unlock_workspace; exit
fi

[ "$mode" = verify ] || die 'unknown mode'
[ -d "$root" ] && [ -f "$adapter" ] && [ -f "$node" ] && [ -f "$baseline" ] || die 'verify input missing'
case "$phase" in EXECUTE|VALIDATE);; *) die 'phase must be EXECUTE or VALIDATE';; esac
root=$(cd "$root"&&pwd -P); evidence_dir=${evidence_dir:-"$root/.loop/evidence"}; evidence_rel=
case "$evidence_dir" in
  "$root"/*) evidence_rel=${evidence_dir#"$root"/}; safe_path "$evidence_rel" && no_symlink_prefix "$evidence_rel" || die 'unsafe evidence directory';;
esac

jq -e 'type=="object" and ((keys-["schema_version","adapter_id","project_kind","target","artifacts","commands","validation","protected_paths","environment"])|length==0) and .schema_version==1 and
  (.adapter_id|test("^[a-z][a-z0-9-]{1,63}$")) and (.project_kind|test("^[a-z][a-z0-9-]{1,63}$")) and
  (.target|type=="object" and ((keys-["languages","runtimes","platforms"])|length==0) and
    (.languages|type=="array" and length==(unique|length) and all(.[];type=="string" and length>0)) and
    (.runtimes|type=="array" and length==(unique|length) and all(.[];type=="string" and length>0)) and
    (.platforms|type=="array" and length>0 and length==(unique|length) and all(.[];type=="string" and length>0))) and
  (.artifacts|type=="array" and length>0 and all(.[];type=="object" and ((keys-["id","kind","paths"])|length==0) and
    (.id|test("^[a-z][a-z0-9-]*$")) and (.kind|test("^[a-z][a-z0-9-]*$")) and
    (.paths|type=="array" and length>0 and length==(unique|length) and all(.[];type=="string" and length>0)))) and
  (.commands|type=="array" and length>0 and ([.[].id]|length==(unique|length)) and all(.[];type=="object" and ((keys-["id","phase","cwd","argv","timeout_seconds","evidence_types"])|length==0) and (.id|test("^[a-z][a-z0-9-]*$")) and (.phase=="EXECUTE" or .phase=="VALIDATE") and (.cwd|type=="string" and length>0) and (.argv|type=="array" and length>0 and all(.[];type=="string" and length>0)) and (.timeout_seconds|type=="number" and .>=1 and .<=86400 and floor==.) and (.evidence_types|type=="array" and length>0 and length==(unique|length) and index("command")!=null and all(.[];. as $v|["acceptance","command","artifact","behavior","contract","installation","package","documentation","link-check"]|index($v)!=null)))) and
  (.validation|type=="object" and ((keys-["required_evidence"])|length==0) and
    (.required_evidence|type=="array" and length>0 and length==(unique|length) and all(.[];. as $v|["acceptance","command","artifact","behavior","contract","installation","package","documentation","link-check"]|index($v)!=null))) and
  (.protected_paths|type=="array" and length>0 and length==(unique|length) and all(.[];type=="string" and length>0)) and
  (.environment|type=="object" and ((keys-["allow_names"])|length==0) and (.allow_names|type=="array" and length>0 and length==(unique|length) and index("PATH")!=null and all(.[];type=="string" and test("^[A-Z_][A-Z0-9_]*$"))))' "$adapter" >/dev/null || die 'adapter validation failed'
  jq -e --arg p "$phase" 'type=="object" and ((keys-["schema_version","run_id","node_id","gate_id","work_item_id","phase","trigger","task","actor_capability","success_condition","verifier_ids","input_artifacts","output_artifacts","allowed_paths","frozen_paths","retry_cap","escalation_target"])|length==0) and
  .schema_version==1 and .phase==$p and (.run_id|test("^[A-Za-z0-9][A-Za-z0-9._-]*$")) and (.gate_id|test("^[A-Za-z0-9][A-Za-z0-9._-]*$")) and (.node_id|test("^[A-Za-z0-9][A-Za-z0-9._-]*$")) and (.work_item_id|test("^[A-Za-z0-9][A-Za-z0-9._-]*$")) and
  (all([.trigger,.task,.actor_capability,.success_condition][];type=="string" and length>0)) and
  (.verifier_ids|type=="array" and length>0 and length==(unique|length) and all(.[];type=="string" and length>0)) and
  (.input_artifacts|type=="array" and length==(unique|length) and all(.[];type=="string" and length>0)) and
  (.output_artifacts|type=="array" and length==(unique|length) and all(.[];type=="string" and length>0)) and
  (.allowed_paths|type=="array" and length>0 and length==(unique|length) and all(.[];type=="string" and length>0)) and
  (.frozen_paths|type=="array" and length==(unique|length) and all(.[];type=="string" and length>0)) and
  (.retry_cap|type=="number" and .>=1 and .<=20 and floor==.) and (.escalation_target as $e|["human","DEFINE","DESIGN","EXECUTE"]|index($e)!=null)' "$node" >/dev/null || die 'node validation failed'
jq -e '.schema_version==1 and (.files|type=="array") and all(.files[];
  type=="object" and keys==["kind","mode","path","sha256"] and (.path|type=="string" and length>0) and
  (.kind=="file" or .kind=="symlink") and (.mode|test("^[0-7]{3,4}$")) and (.sha256|test("^[0-9a-f]{64}$")))' "$baseline" >/dev/null || die 'baseline invalid'
while IFS= read -r p; do safe_path "$p" && no_symlink_prefix "$p" || die "unsafe policy path: $p"; done < <(jq -r '.protected_paths[]' "$adapter"; jq -r '.allowed_paths[],.frozen_paths[]' "$node")
[ -z "$(cd "$root"&&find . -path './.git' -prune -o -type l -print -quit)" ]||die 'workspace symlinks are not supported by the contained reference executor'

while IFS= read -r id; do
  c=$(jq -c --arg id "$id" --arg p "$phase" '.commands[]|select(.id==$id and .phase==$p)' "$adapter"); [ -n "$c" ] || die "unknown verifier: $id"
  cwd=$(jq -r .cwd <<<"$c"); safe_path "$cwd" && no_symlink_prefix "$cwd" && [ -d "$root/$cwd" ] && physical_under_root "$root/$cwd" >/dev/null || die "bad cwd: $cwd"; x=$(jq -r '.argv[0]' <<<"$c")
  case "$x" in */*) safe_path "$x" && no_symlink_prefix "$cwd/$x" && [ ! -L "$root/$cwd/$x" ] && [ -x "$root/$cwd/$x" ] || die "unsafe executable: $x";; *) need "$x";; esac
done < <(jq -r '.verifier_ids[]' "$node")

declared_types=$(jq -c --arg p "$phase" --argjson ids "$(jq '.verifier_ids' "$node")" '[.commands[]|select(.phase==$p and (.id as $id|$ids|index($id)!=null))|.evidence_types[]]|unique' "$adapter")
jq -e --argjson have "$declared_types" '.validation.required_evidence-($have|unique)|length==0' "$adapter" >/dev/null || die 'selected verifier commands do not declare every required evidence type'

need perl; lock_workspace
work=$(mktemp -d "${TMPDIR:-/tmp}/loop-evidence.XXXXXX"); trap 'unlock_workspace; rm -rf "$work"' EXIT INT TERM
snapshot "$work/pre"
protected_snapshot "$work/protected-pre"
rid=$(jq -r .run_id "$node"); rev=$(git -C "$root" rev-parse HEAD 2>/dev/null||echo unversioned); host_env=$(uname -srm); failed=0; ids="$work/ids"; : > "$ids"
adapter_sha=$(shasum -a 256 "$adapter"|awk '{print $1}'); node_sha=$(shasum -a 256 "$node"|awk '{print $1}')
env_args=(); env_names=(); while IFS= read -r name; do env_names+=("$name"); value=${!name-}; env_args+=("$name=$value"); done < <(jq -r '.environment.allow_names[]' "$adapter")
env_names_json=$(printf '%s\n' "${env_names[@]}"|jq -Rsc 'split("\n")|map(select(length>0))')
timed(){
  sec=$1 out=$2 err=$3; shift 3
  env -i "${env_args[@]}" perl -MPOSIX -e 'POSIX::setpgid(0,0); exec @ARGV or exit 127' "$@" >"$out" 2>"$err" & pid=$!
  ticks=$((sec*10)); i=0
  while kill -0 "$pid" 2>/dev/null && [ "$i" -lt "$ticks" ]; do sleep 0.1; i=$((i+1)); done
  if kill -0 "$pid" 2>/dev/null; then
    kill -TERM -- "-$pid" 2>/dev/null||kill -TERM "$pid" 2>/dev/null||:; sleep 0.2; kill -KILL -- "-$pid" 2>/dev/null||kill -KILL "$pid" 2>/dev/null||:
    wait "$pid" 2>/dev/null || :; return 124
  fi
  if wait "$pid"; then rc=0; else rc=$?; fi
  if kill -0 -- "-$pid" 2>/dev/null; then
    kill -TERM -- "-$pid" 2>/dev/null || :; sleep 0.2; kill -KILL -- "-$pid" 2>/dev/null || :
  fi
  return "$rc"
}
while IFS= read -r id; do
  c=$(jq -c --arg id "$id" '.commands[]|select(.id==$id)' "$adapter"); cwd=$(jq -r .cwd <<<"$c"); sec=$(jq -r .timeout_seconds <<<"$c"); a=(); while IFS= read -r -d '' v; do a+=("$v"); done < <(jq -j '.argv[]|.,"\u0000"' <<<"$c")
  started=$(now); start_ms=$(perl -MTime::HiRes=time -e 'printf "%.0f\n",time()*1000'); set +e
  (cd "$root/$cwd"&&timed "$sec" "$work/$id.stdout" "$work/$id.stderr" "${a[@]}"); rc=$?; set -e
  end_ms=$(perl -MTime::HiRes=time -e 'printf "%.0f\n",time()*1000'); finished=$(now); res=PASSED; [ "$rc" -eq 0 ]||{ res=FAILED; failed=1; }
  stdout_sha=$(shasum -a 256 "$work/$id.stdout"|awk '{print $1}'); stderr_sha=$(shasum -a 256 "$work/$id.stderr"|awk '{print $1}'); argv_json=$(jq '.argv' <<<"$c")
  if jq -e '.evidence_types|index("command")!=null' <<<"$c" >/dev/null; then
    eid="$rid-$id"; echo "$eid" >> "$ids"; jq -n --arg id "$eid" --arg w "$(jq -r .work_item_id "$node")" --arg p "$phase" --arg r "$res" --arg rev "$rev" --arg env "$host_env" --arg t "$finished" --arg c "$id" --argjson x "$rc" --arg run "$rid" --arg gate "$(jq -r .gate_id "$node")" --argjson argv "$argv_json" --arg cwd "$cwd" --arg started "$started" --arg finished "$finished" --argjson duration "$((end_ms-start_ms))" --arg outsha "$stdout_sha" --arg errsha "$stderr_sha" --arg asha "$adapter_sha" --arg nsha "$node_sha" --argjson names "$env_names_json" '{schema_version:1,evidence_id:$id,work_item_id:$w,phase:$p,evidence_type:"command",result:$r,producer:"reference-engine",revision:$rev,environment:$env,captured_at:$t,artifacts:[],details:{command_id:$c,exit_code:$x,run_id:$run,gate_id:$gate,argv:$argv,cwd:$cwd,started_at:$started,finished_at:$finished,duration_milliseconds:$duration,stdout_sha256:$outsha,stderr_sha256:$errsha,adapter_sha256:$asha,node_sha256:$nsha,environment_names:$names}}' > "$work/$eid.json"
  fi
  while IFS= read -r evidence_type; do
    [ "$evidence_type" = command ] && continue
    typed_id="$rid-$id-$evidence_type"; echo "$typed_id" >> "$ids"
    jq -n --arg id "$typed_id" --arg w "$(jq -r .work_item_id "$node")" --arg p "$phase" --arg type "$evidence_type" --arg r "$res" --arg rev "$rev" --arg env "$host_env" --arg t "$finished" --arg c "$id" --arg command_evidence_id "$rid-$id" --arg run "$rid" --arg gate "$(jq -r .gate_id "$node")" --arg outsha "$stdout_sha" --arg errsha "$stderr_sha" --arg observation "Command $id is explicitly configured to prove $evidence_type; inspect its captured output and logs." '{schema_version:1,evidence_id:$id,work_item_id:$w,phase:$p,evidence_type:$type,result:$r,producer:"reference-engine",revision:$rev,environment:$env,captured_at:$t,artifacts:[],details:{command_id:$c,command_evidence_id:$command_evidence_id,run_id:$run,gate_id:$gate,stdout_sha256:$outsha,stderr_sha256:$errsha,observation:$observation}}' > "$work/$typed_id.json"
  done < <(jq -r '.evidence_types[]' <<<"$c")
done < <(jq -r '.verifier_ids[]' "$node")

artifact_present(){ pat=$1; safe_path "$pat" && no_symlink_prefix "$pat" || return 1; hit=$(cd "$root"&&find . -path "./$pat" -type f ! -type l -print -quit); [ -n "$hit" ]; }
while IFS= read -r pat; do artifact_present "$pat"||failed=1; done < <(jq -r '.output_artifacts[]' "$node"; jq -r '.artifacts[].paths[]' "$adapter")

snapshot "$work/after"
protected_snapshot "$work/protected-after"
loop_changed_paths "$baseline" "$work/after" > "$work/changed"
loop_changed_paths "$work/protected-pre" "$work/protected-after" >> "$work/changed"
match(){ q=$1 sel=$2 file=$3; while IFS= read -r pat; do [[ "$q" == $pat ]]&&return 0; done < <(jq -r "$sel[]" "$file"); return 1; }
while IFS= read -r p; do [ -n "$p" ]||continue; protected=0; match "$p" .protected_paths "$adapter"&&protected=1; case "$p" in .loop/*|core/*|spec/*|hosts/*|engine/*) protected=1;; esac; parent=$(dirname "$root/$p"); if [ -L "$root/$p" ]||! physical_under_root "$parent" >/dev/null||! no_symlink_prefix "$p"; then failed=1; elif [ "$protected" -eq 1 ]||match "$p" .frozen_paths "$node"||! match "$p" .allowed_paths "$node"; then failed=1; fi; done < "$work/changed"
[ "$failed" -eq 0 ] || for record in "$work"/$rid-*.json; do tmp="$record.tmp"; jq '.result="FAILED"' "$record" > "$tmp" && mv "$tmp" "$record"; done

mkdir -p "$evidence_dir/$rid/logs"; cp "$work"/*.json "$evidence_dir/$rid/"; cp "$work"/*.stdout "$work"/*.stderr "$evidence_dir/$rid/logs/" 2>/dev/null||:; cp "$ids" "$evidence_dir/$rid/evidence-ids.txt"
jq -n --arg id "$rid" --arg a "$(jq -r .adapter_id "$adapter")" --arg asha "$adapter_sha" --arg nsha "$node_sha" --arg w "$(jq -r .work_item_id "$node")" --arg gate "$(jq -r .gate_id "$node")" --arg rev "$rev" --arg p "$phase" --arg s "$([ "$failed" -eq 0 ]&&echo PASSED||echo FAILED)" --argjson e "$(jq -Rsc 'split("\n")|map(select(length>0))' "$ids")" '{schema_version:1,run_id:$id,work_item_id:$w,gate_id:$gate,revision:$rev,adapter_id:$a,adapter_sha256:$asha,node_sha256:$nsha,phase:$p,status:$s,evidence_ids:$e}' > "$evidence_dir/$rid/run-summary.json"
echo "$evidence_dir/$rid/run-summary.json"; [ "$failed" -eq 0 ]
