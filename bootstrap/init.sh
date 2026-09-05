#!/usr/bin/env bash
# Supervised candidate generator. It never activates a project adapter.
set -euo pipefail

die() { printf 'ERROR: %s\n' "$1" >&2; exit "${2:-64}"; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing prerequisite: $1" 69; }
need jq

target=${1:-.}
[ -d "$target" ] || die "target directory does not exist: $target"
[ ! -L "$target" ] || die "target directory must not be a symlink: $target"
target=$(cd "$target" && pwd -P)
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
recommend_script="$script_dir/recommend.sh"
[ -x "$recommend_script" ] || die "recommendation helper is missing or not executable: $recommend_script" 69
template_root=$(git -C "$script_dir" rev-parse --show-toplevel 2>/dev/null) || die 'template checkout has no Git repository; cannot create immutable engine pin' 69
engine_pin=$(git -C "$template_root" rev-parse --verify HEAD 2>/dev/null) || die 'template checkout has no committed revision; cannot create immutable engine pin' 69
[[ "$engine_pin" =~ ^[0-9a-f]{40,64}$ ]] || die 'template Git revision is not an immutable object id' 69
[ -z "$(git -C "$template_root" status --porcelain --untracked-files=all)" ] || die 'template checkout must be entirely clean before pinning' 69
for bound_file in "$script_dir/init.sh" "$script_dir/recommend.sh" "$template_root/engine/reference-engine.sh"; do
  [ -f "$bound_file" ] && [ ! -L "$bound_file" ] || die "required engine component is missing or symlinked: $bound_file" 69
  case "$bound_file" in "$template_root"/*) bound_rel=${bound_file#"$template_root"/};; *) die "engine component escapes template checkout: $bound_file" 69;; esac
  git -C "$template_root" ls-files --error-unmatch -- "$bound_rel" >/dev/null 2>&1 || die "engine component is not tracked: $bound_rel" 69
  git -C "$template_root" diff --quiet HEAD -- "$bound_rel" || die "engine component is not bound to template HEAD: $bound_rel" 69
done
recommendation=$("$recommend_script" "$target") || die 'safe project recommendation failed' 69
jq -e '.label == "RECOMMENDATION_ONLY" and .scan.read_only == true' <<<"$recommendation" >/dev/null || die 'invalid recommendation output' 69
answer_trace=$(mktemp "${TMPDIR:-/tmp}/loop-init-answers.XXXXXX")
trap 'rm -f "$answer_trace"' EXIT
[ ! -L "$target/.loop" ] || die "refusing symlinked control directory: $target/.loop"
if [ -d "$target/.loop" ]; then
  loop_physical=$(cd "$target/.loop" && pwd -P)
  case "$loop_physical/" in "$target/.loop/") ;; *) die "control directory escapes target: $target/.loop" ;; esac
fi
candidate_dir="$target/.loop/candidate"
[ ! -e "$candidate_dir/project.adapter.json" ] || die "candidate already exists: $candidate_dir/project.adapter.json"
[ ! -e "$candidate_dir/state.json" ] || die "candidate already exists: $candidate_dir/state.json"

ask() {
  label=$1 value=
  while [ -z "$value" ]; do
    printf '%s: ' "$label" >&2
    IFS= read -r value || die "input ended before initialization was complete"
  done
  printf '%s' "$value"
}

ask_default() {
  label=$1 default=$2 key=${3:-unspecified} value= source=manual-override
  printf '%s [recommended: %s; press Enter to accept]: ' "$label" "$default" >&2
  IFS= read -r value || die "input ended before initialization was complete"
  if [ -z "$value" ]; then value=$default; source=accepted-default; fi
  printf '%s\t%s\n' "$key" "$source" >> "$answer_trace"
  printf '%s' "$value"
}

answer_source() { awk -F '\t' -v key="$1" '$1 == key {source=$2} END {print source}' "$answer_trace"; }

json_csv() { jq -r 'if length == 0 then "none" else join(",") end' <<<"$1"; }

csv_json() {
  jq -cn --arg value "$1" '$value | split(",") | map(gsub("^[[:space:]]+|[[:space:]]+$"; "")) | map(select(length > 0)) | unique'
}

relative_paths_json() {
  values=$(csv_json "$1")
  [ "$(jq 'length' <<<"$values")" -gt 0 ] || die "at least one relative path is required"
  while IFS= read -r path; do
    case "$path" in ''|/*|..|../*|*/..|*/../*) die "unsafe path: $path" ;; esac
  done < <(jq -r '.[]' <<<"$values")
  printf '%s' "$values"
}

argv_json() {
  value=$1
  jq -ce 'type == "array" and length > 0 and all(.[]; type == "string" and length > 0)' <<<"$value" >/dev/null \
    || die 'argv must be a JSON array of non-empty strings, for example ["tool","test"]'
  jq -c . <<<"$value"
}

command_json() {
  phase=$1 default_id=$2 recommended_command=$3 default_evidence=$4
  printf '\n%s verifier (exit 0 means pass)\n' "$phase" >&2
  id=$(ask_default 'Command id' "$default_id" "command-$phase-id")
  [[ "$id" =~ ^[a-z][a-z0-9-]*$ ]] || die "invalid command id: $id"
  recommended_cwd=$(jq -r '.cwd // "."' <<<"$recommended_command")
  cwd=$(ask_default 'Relative working directory' "$recommended_cwd" "command-$phase-cwd")
  case "$cwd" in /*|..|../*|*/..|*/../*) die "unsafe working directory: $cwd" ;; esac
  [ -d "$target/$cwd" ] || die "working directory does not exist: $cwd"
  printf '%s\n' 'Command argv requires an explicit choice; Enter alone is rejected.' >&2
  if jq -e '.argv | type == "array" and length > 0' <<<"$recommended_command" >/dev/null; then
    printf 'Recommended argv (inferred, never executed during discovery): %s\n' "$(jq -c '.argv' <<<"$recommended_command")" >&2
  else
    printf '%s\n' "No defensible $phase command recommendation is available." >&2
  fi
  argv_choice=$(ask 'Type USE-RECOMMENDED or enter exact manual argv JSON')
  if [ "$argv_choice" = USE-RECOMMENDED ]; then
    jq -e '.argv | type == "array" and length > 0' <<<"$recommended_command" >/dev/null \
      || die "no defensible $phase command was inferred; enter manual argv JSON"
    argv=$(argv_json "$(jq -c '.argv' <<<"$recommended_command")")
    argv_source=explicit-use-recommended
  else
    argv=$(argv_json "$argv_choice")
    argv_source=manual-json
  fi
  recommended_timeout=$(jq -r '.timeout_seconds // 900' <<<"$recommended_command")
  timeout=$(ask_default 'Timeout in seconds' "$recommended_timeout" "command-$phase-timeout")
  [[ "$timeout" =~ ^[0-9]+$ ]] && [ "$timeout" -ge 1 ] && [ "$timeout" -le 86400 ] \
    || die "timeout must be an integer from 1 to 86400"
  evidence_types=$(csv_json "$(ask_default 'Evidence kinds this command actually proves, comma-separated' "$default_evidence" "command-$phase-evidence")")
  [ "$(jq 'length' <<<"$evidence_types")" -gt 0 ] || die "at least one command evidence kind is required"
  jq -e 'index("command") != null' <<<"$evidence_types" >/dev/null || die "every executable verifier must declare command evidence"
  while IFS= read -r evidence_kind; do
    case "$evidence_kind" in acceptance|command|artifact|behavior|contract|installation|package|documentation|link-check) ;;
      *) die "unsupported command evidence kind: $evidence_kind" ;;
    esac
  done < <(jq -r '.[]' <<<"$evidence_types")
  jq -cn --arg id "$id" --arg phase "$phase" --arg cwd "$cwd" --arg source "$argv_source" --argjson argv "$argv" --argjson timeout "$timeout" --argjson evidence "$evidence_types" \
    '{command:{id:$id,phase:$phase,cwd:$cwd,argv:$argv,timeout_seconds:$timeout,evidence_types:$evidence},argv_source:$source}'
}

printf '%s\n' 'Universal build-loop supervised initialization' >&2
printf '%s\n' 'Recommendations below are evidence-labeled suggestions, never executed project content.' >&2
printf '%s\n' 'Inferred command argv require the literal USE-RECOMMENDED; ordinary Enter defaults do not authorize them.' >&2
printf '%s\n' '--- SAFE RECOMMENDATION SUMMARY ---' >&2
jq -r '"Project kind: \(.recommendation.project_kind)\nLanguages: \(if (.recommendation.languages|length)==0 then "none" else (.recommendation.languages|join(", ")) end)\nRuntimes: \(if (.recommendation.runtimes|length)==0 then "none" else (.recommendation.runtimes|join(", ")) end)\nTools: \(if (.recommendation.tools|length)==0 then "none" else (.recommendation.tools|join(", ")) end)\nConfidence: \(.evidence.confidence)\nBasis: \(.evidence.basis)\nFiles considered: \(.scan.files_considered|length)\nSymlinks skipped: \(.scan.symlinks_skipped|length)"' <<<"$recommendation" >&2
jq -e '.scan.truncated == true' <<<"$recommendation" >/dev/null && printf '%s\n' 'Warning: the bounded scan was truncated; treat suggestions as incomplete.' >&2 || :
printf '%s\n' 'Every suggestion can be replaced. Supported platforms always require manual input.' >&2
printf '%s\n' '--- END RECOMMENDATION SUMMARY ---' >&2

adapter_default=$(basename "$target" | tr '[:upper:]_' '[:lower:]-' | sed 's/[^a-z0-9-]/-/g; s/^[^a-z]*//; s/-*$//')
[ "${#adapter_default}" -ge 2 ] || adapter_default=project-adapter
adapter_id=$(ask_default 'Adapter id (lowercase letters, digits, hyphens)' "$adapter_default" adapter_id)
[[ "$adapter_id" =~ ^[a-z][a-z0-9-]{1,63}$ ]] || die "invalid adapter id: $adapter_id"

printf '%s\n' 'Shapes: cli, api, library, docs, desktop, service, automation, data-ai, other' >&2
project_kind=$(ask_default 'Project shape' "$(jq -r '.recommendation.project_kind' <<<"$recommendation")" project_kind)
[[ "$project_kind" =~ ^[a-z][a-z0-9-]*$ ]] || die "invalid project shape: $project_kind"

languages_raw=$(ask_default 'Programming language(s), comma-separated; enter none when none applies' "$(json_csv "$(jq -c '.recommendation.languages' <<<"$recommendation")")" languages)
if [ "$languages_raw" = none ]; then languages='[]'; else languages=$(csv_json "$languages_raw"); fi
runtimes_raw=$(ask_default 'Runtime/compiler/interpreter and version constraint(s), comma-separated; enter none when none applies' "$(json_csv "$(jq -c '.recommendation.runtimes' <<<"$recommendation")")" runtimes)
if [ "$runtimes_raw" = none ]; then runtimes='[]'; else runtimes=$(csv_json "$runtimes_raw"); fi
tools_raw=$(ask_default 'Authoritative dependency/build/package tools, comma-separated; enter none when none applies' "$(json_csv "$(jq -c '.recommendation.tools' <<<"$recommendation")")" tools)
platforms=$(csv_json "$(ask 'Supported platform/environment identifiers, comma-separated (manual; scanner host is not target evidence)')")
[ "$(jq 'length' <<<"$platforms")" -gt 0 ] || die "at least one platform is required"

artifact_count=$(ask_default 'Number of produced artifact declarations' 1 artifact_count)
[[ "$artifact_count" =~ ^[0-9]+$ ]] && [ "$artifact_count" -ge 1 ] || die "artifact count must be a positive integer"
artifacts='[]'
artifact_index=1
while [ "$artifact_index" -le "$artifact_count" ]; do
  rec_artifact=$(if [ "$artifact_index" -eq 1 ]; then jq -c '.recommendation.artifact' <<<"$recommendation"; else printf 'null'; fi)
  if [ "$rec_artifact" = null ]; then artifact_id=$(ask "Artifact $artifact_index id (manual; no defensible recommendation)"); else artifact_id=$(ask_default "Artifact $artifact_index id" "$(jq -r '.id' <<<"$rec_artifact")" "artifact-$artifact_index-id"); fi
  [[ "$artifact_id" =~ ^[a-z][a-z0-9-]*$ ]] || die "invalid artifact id: $artifact_id"
  if [ "$rec_artifact" = null ]; then artifact_kind=$(ask "Artifact $artifact_index kind (manual lowercase identifier)"); else artifact_kind=$(ask_default "Artifact $artifact_index kind (lowercase identifier, e.g. executable, service, package, document-set)" "$(jq -r '.kind' <<<"$rec_artifact")" "artifact-$artifact_index-kind"); fi
  [[ "$artifact_kind" =~ ^[a-z][a-z0-9-]*$ ]] || die "invalid artifact kind: $artifact_kind"
  if [ "$rec_artifact" = null ]; then
    artifact_paths=$(relative_paths_json "$(ask "Artifact $artifact_index path(s), comma-separated and repository-relative (manual; no defensible recommendation)")")
  else
    rec_artifact_paths=$(json_csv "$(jq -c '.paths' <<<"$rec_artifact")")
    artifact_paths=$(relative_paths_json "$(ask_default "Artifact $artifact_index path(s), comma-separated and repository-relative" "$rec_artifact_paths" "artifact-$artifact_index-paths")")
  fi
  artifact=$(jq -cn --arg id "$artifact_id" --arg kind "$artifact_kind" --argjson paths "$artifact_paths" '{id:$id,kind:$kind,paths:$paths}')
  artifacts=$(jq -cn --argjson current "$artifacts" --argjson artifact "$artifact" '$current + [$artifact]')
  artifact_index=$((artifact_index + 1))
done
jq -e 'map(.id) | length == (unique | length)' <<<"$artifacts" >/dev/null || die "artifact ids must be unique"
protected_paths=$(relative_paths_json "$(ask_default 'Protected path/glob(s), comma-separated; include .loop/** and toolchain/test policy' "$(json_csv "$(jq -c '.recommendation.protected_paths' <<<"$recommendation")")" protected_paths)")

env_raw=$(ask_default 'Environment variable names commands may inherit, comma-separated; values are never requested' "$(json_csv "$(jq -c '.recommendation.environment_names' <<<"$recommendation")")" environment_names)
environment_names=$(csv_json "$env_raw")
[ "$(jq 'length' <<<"$environment_names")" -gt 0 ] || die "at least one environment variable name is required"
jq -e 'index("PATH") != null' <<<"$environment_names" >/dev/null || die "PATH must be explicitly allowed for the v1 reference engine"
while IFS= read -r name; do
  [[ "$name" =~ ^[A-Z_][A-Z0-9_]*$ ]] || die "invalid environment variable name: $name"
done < <(jq -r '.[]' <<<"$environment_names")

default_evidence=$(json_csv "$(jq -c '.recommendation.required_evidence | if index("command") then . else . + ["command"] end | unique' <<<"$recommendation")")
execute_recommendation=$(jq -c '.recommendation.commands[]? | select(.phase == "EXECUTE")' <<<"$recommendation" | head -n 1)
validate_recommendation=$(jq -c '.recommendation.commands[]? | select(.phase == "VALIDATE")' <<<"$recommendation" | head -n 1)
execute_recommendation=${execute_recommendation:-'{}'}
validate_recommendation=${validate_recommendation:-'{}'}
execute_result=$(command_json EXECUTE verify-execute "$execute_recommendation" "$default_evidence")
validate_result=$(command_json VALIDATE verify-validate "$validate_recommendation" "$default_evidence")
execute_command=$(jq -c '.command' <<<"$execute_result"); execute_argv_source=$(jq -r '.argv_source' <<<"$execute_result")
validate_command=$(jq -c '.command' <<<"$validate_result"); validate_argv_source=$(jq -r '.argv_source' <<<"$validate_result")
commands=$(jq -cn --argjson execute "$execute_command" --argjson validate "$validate_command" '[$execute,$validate]')
jq -e 'map(.id) | length == (unique | length)' <<<"$commands" >/dev/null || die "command ids must be unique"

case "$project_kind" in
  cli|desktop) recommended='acceptance,command,behavior,installation' ;;
  api) recommended='acceptance,command,behavior,contract' ;;
  library) recommended='acceptance,command,package,installation' ;;
  docs) recommended='acceptance,documentation,link-check' ;;
  service) recommended='acceptance,command,behavior,artifact' ;;
  automation) recommended='acceptance,command,behavior' ;;
  data-ai) recommended='acceptance,command,artifact,behavior' ;;
  *) recommended='acceptance,command,artifact' ;;
esac
required_evidence_default=$(json_csv "$(jq -c '.recommendation.required_evidence' <<<"$recommendation")")
required_evidence=$(csv_json "$(ask_default 'Required VALIDATE evidence kinds, comma-separated' "$required_evidence_default" required_evidence)")
[ "$(jq 'length' <<<"$required_evidence")" -gt 0 ] || die "at least one validation evidence kind is required"
while IFS= read -r evidence_kind; do
  case "$evidence_kind" in acceptance|command|artifact|behavior|contract|installation|package|documentation|link-check) ;;
    *) die "unsupported validation evidence kind: $evidence_kind" ;;
  esac
done < <(jq -r '.[]' <<<"$required_evidence")

max_wall_seconds=$(ask_default 'Maximum wall-clock seconds per activated run' "$(jq -r '.recommendation.max_wall_seconds' <<<"$recommendation")" max_wall_seconds)
[[ "$max_wall_seconds" =~ ^[0-9]+$ ]] && [ "$max_wall_seconds" -ge 1 ] || die "wall-clock cap must be a positive integer"
negative_control=$(argv_json "$(ask 'Known-failing negative-control argv as JSON array (record only; not executed now)')")

adapter=$(jq -cn \
  --arg id "$adapter_id" --arg kind "$project_kind" \
  --argjson languages "$languages" --argjson runtimes "$runtimes" --argjson platforms "$platforms" \
  --argjson artifacts "$artifacts" \
  --argjson commands "$commands" --argjson evidence "$required_evidence" --argjson protected "$protected_paths" \
  --argjson env_names "$environment_names" \
  '{schema_version:1,adapter_id:$id,project_kind:$kind,target:{languages:$languages,runtimes:$runtimes,platforms:$platforms},artifacts:$artifacts,commands:$commands,validation:{required_evidence:$evidence},protected_paths:$protected,environment:{allow_names:$env_names}}')

updated=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
state=$(jq -cn --arg updated "$updated" --argjson wall "$max_wall_seconds" \
  '{schema_version:1,work_item_id:"WI-001",phase:"DEFINE",run_status:"PAUSED",step:"bootstrap-confirmation",round:0,max_rounds:40,gate_failures_here:0,max_gate_failures:3,autonomy:"supervised",started_epoch:0,max_wall_seconds:$wall,gates:{DEFINE:{status:"PENDING",evidence_ids:[]},DESIGN:{status:"PENDING",evidence_ids:[]},EXECUTE:{status:"PENDING",evidence_ids:[]},REVIEW:{status:"PENDING",evidence_ids:[]},VALIDATE:{status:"PENDING",evidence_ids:[]},HANDOVER:{status:"PENDING",evidence_ids:[]}},last_result:"Candidate generated; not activated.",next_action:"Human must validate the candidate, run the negative control, and explicitly activate it.",updated_at:$updated}')

printf '\nCandidate adapter:\n%s\n\nCandidate state:\n%s\n' "$(jq . <<<"$adapter")" "$(jq . <<<"$state")" >&2
confirm=$(ask 'Write these PAUSED candidate files? Type YES')
[ "$confirm" = YES ] || die "not confirmed; nothing written" 65

mkdir -p "$candidate_dir"
printf '%s\n' "$adapter" | jq . > "$candidate_dir/project.adapter.json"
printf '%s\n' "$state" | jq . > "$candidate_dir/state.json"
artifact_source=manual-required
if jq -e '.recommendation.artifact != null' <<<"$recommendation" >/dev/null; then
  artifact_source=accepted-default
  for artifact_key in artifact_count artifact-1-id artifact-1-kind artifact-1-paths; do [ "$(answer_source "$artifact_key")" = accepted-default ] || artifact_source=manual-override; done
fi
jq -n --arg engine_pin "$engine_pin" --arg execute_source "$execute_argv_source" --arg validate_source "$validate_argv_source" \
  --arg adapter_id_source "$(answer_source adapter_id)" --arg project_kind_source "$(answer_source project_kind)" --arg languages_source "$(answer_source languages)" --arg runtimes_source "$(answer_source runtimes)" --arg tools_source "$(answer_source tools)" --arg artifact_source "$artifact_source" --arg protected_source "$(answer_source protected_paths)" --arg environment_source "$(answer_source environment_names)" --arg evidence_source "$(answer_source required_evidence)" --arg wall_source "$(answer_source max_wall_seconds)" \
  --arg tools "$tools_raw" --argjson recommendation "$recommendation" --argjson adapter "$adapter" --argjson wall "$max_wall_seconds" \
  '{schema_version:1,label:"SUPERVISED_INITIALIZATION_PROVENANCE",engine_pin:{value:$engine_pin,source:"template-git-HEAD"},recommendation:$recommendation,selections:{adapter_id:{value:$adapter.adapter_id,source:$adapter_id_source},project_kind:{value:$adapter.project_kind,source:$project_kind_source},languages:{value:$adapter.target.languages,source:$languages_source},runtimes:{value:$adapter.target.runtimes,source:$runtimes_source},platforms:{value:$adapter.target.platforms,source:"manual-required"},tools:{value:$tools,source:$tools_source},artifacts:{value:$adapter.artifacts,source:$artifact_source},protected_paths:{value:$adapter.protected_paths,source:$protected_source},environment_names:{value:$adapter.environment.allow_names,source:$environment_source},commands:{EXECUTE:{argv:$adapter.commands[0].argv,source:$execute_source},VALIDATE:{argv:$adapter.commands[1].argv,source:$validate_source}},required_evidence:{value:$adapter.validation.required_evidence,source:$evidence_source},max_wall_seconds:{value:$wall,source:$wall_source},negative_control:{source:"manual-json",status:"PENDING"}},run_status:"PAUSED"}' \
  > "$candidate_dir/initialization.provenance.json"
{
  printf 'engine_pin=%s\n' "$engine_pin"
  printf 'engine_pin_source=template-git-HEAD\n'
  printf 'recommendation_label=RECOMMENDATION_ONLY\n'
  printf 'build_and_package_tools=%s\n' "$tools_raw"
  printf 'environment_variable_names=%s\n' "$(jq -r 'join(",")' <<<"$environment_names")"
  printf 'negative_control_argv=%s\n' "$(jq -c . <<<"$negative_control")"
  printf 'human_candidate_confirmation=YES\n'
  printf 'negative_control_result=PENDING\n'
  printf 'activation_authorization=PENDING\n'
} > "$candidate_dir/initialization.answers"

cat > "$candidate_dir/ACTIVATION-CHECKLIST.md" <<'EOF'
# Activation checklist

- [ ] Validate the candidate adapter and state against their pinned v1 schemas.
- [ ] Inspect every command argv, working directory, timeout, artifact and protected path.
- [ ] Confirm environment variable names; never store their values here.
- [ ] Run the recorded negative-control argv through the same command boundary and prove it fails.
- [ ] Run the conformance suite for the pinned engine version.
- [ ] Confirm the delivery boundary and every external-state action requiring human authority.
- [ ] Record explicit human activation authorization.
- [ ] Only then copy candidates to active `.loop/` names and keep `autonomy: supervised`.

Candidate generation itself is not activation.
EOF

printf 'Candidates written under %s\n' "$candidate_dir"
printf '%s\n' 'They remain PAUSED. Complete the activation checklist manually.'
