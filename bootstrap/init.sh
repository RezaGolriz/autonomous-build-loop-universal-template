#!/usr/bin/env bash
# Supervised candidate generator. It never activates a project adapter.
set -euo pipefail

die() { printf 'ERROR: %s\n' "$1" >&2; exit "${2:-64}"; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing prerequisite: $1" 69; }
need jq

target=${1:-.}
[ -d "$target" ] || die "target directory does not exist: $target"
target=$(cd "$target" && pwd -P)
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
  phase=$1 default_id=$2
  printf '\n%s verifier (exit 0 means pass)\n' "$phase" >&2
  id=$(ask "Command id [$default_id]")
  [ "$id" = "-" ] && id=$default_id
  [[ "$id" =~ ^[a-z][a-z0-9-]*$ ]] || die "invalid command id: $id"
  cwd=$(ask 'Relative working directory, use . for repository root')
  case "$cwd" in /*|..|../*|*/..|*/../*) die "unsafe working directory: $cwd" ;; esac
  [ -d "$target/$cwd" ] || die "working directory does not exist: $cwd"
  argv=$(argv_json "$(ask 'Exact argv as JSON array (no shell expression)')")
  timeout=$(ask 'Timeout in seconds')
  [[ "$timeout" =~ ^[0-9]+$ ]] && [ "$timeout" -ge 1 ] && [ "$timeout" -le 86400 ] \
    || die "timeout must be an integer from 1 to 86400"
  evidence_types=$(csv_json "$(ask 'Evidence kinds this command actually proves, comma-separated')")
  [ "$(jq 'length' <<<"$evidence_types")" -gt 0 ] || die "at least one command evidence kind is required"
  jq -e 'index("command") != null' <<<"$evidence_types" >/dev/null || die "every executable verifier must declare command evidence"
  while IFS= read -r evidence_kind; do
    case "$evidence_kind" in acceptance|command|artifact|behavior|contract|installation|package|documentation|link-check) ;;
      *) die "unsupported command evidence kind: $evidence_kind" ;;
    esac
  done < <(jq -r '.[]' <<<"$evidence_types")
  jq -cn --arg id "$id" --arg phase "$phase" --arg cwd "$cwd" --argjson argv "$argv" --argjson timeout "$timeout" --argjson evidence "$evidence_types" \
    '{id:$id,phase:$phase,cwd:$cwd,argv:$argv,timeout_seconds:$timeout,evidence_types:$evidence}'
}

printf '%s\n' 'Universal build-loop supervised initialization' >&2
printf '%s\n' 'Repository discovery may inform your answers, but this script does not infer or execute project commands.' >&2

adapter_id=$(ask 'Adapter id (lowercase letters, digits, hyphens)')
[[ "$adapter_id" =~ ^[a-z][a-z0-9-]{1,63}$ ]] || die "invalid adapter id: $adapter_id"

printf '%s\n' 'Shapes: cli, api, library, docs, desktop, service, automation, data-ai, other' >&2
project_kind=$(ask 'Project shape')
[[ "$project_kind" =~ ^[a-z][a-z0-9-]*$ ]] || die "invalid project shape: $project_kind"

languages_raw=$(ask 'Programming language(s), comma-separated; enter none when none applies')
if [ "$languages_raw" = none ]; then languages='[]'; else languages=$(csv_json "$languages_raw"); fi
runtimes_raw=$(ask 'Runtime/compiler/interpreter and version constraint(s), comma-separated; enter none when none applies')
if [ "$runtimes_raw" = none ]; then runtimes='[]'; else runtimes=$(csv_json "$runtimes_raw"); fi
tools_raw=$(ask 'Authoritative dependency/build/package tools, comma-separated; enter none when none applies')
platforms=$(csv_json "$(ask 'Supported platform/environment identifiers, comma-separated')")
[ "$(jq 'length' <<<"$platforms")" -gt 0 ] || die "at least one platform is required"

artifact_count=$(ask 'Number of produced artifact declarations')
[[ "$artifact_count" =~ ^[0-9]+$ ]] && [ "$artifact_count" -ge 1 ] || die "artifact count must be a positive integer"
artifacts='[]'
artifact_index=1
while [ "$artifact_index" -le "$artifact_count" ]; do
  artifact_id=$(ask "Artifact $artifact_index id")
  [[ "$artifact_id" =~ ^[a-z][a-z0-9-]*$ ]] || die "invalid artifact id: $artifact_id"
  artifact_kind=$(ask "Artifact $artifact_index kind (lowercase identifier, e.g. executable, service, package, document-set)")
  [[ "$artifact_kind" =~ ^[a-z][a-z0-9-]*$ ]] || die "invalid artifact kind: $artifact_kind"
  artifact_paths=$(relative_paths_json "$(ask "Artifact $artifact_index path(s), comma-separated and repository-relative")")
  artifact=$(jq -cn --arg id "$artifact_id" --arg kind "$artifact_kind" --argjson paths "$artifact_paths" '{id:$id,kind:$kind,paths:$paths}')
  artifacts=$(jq -cn --argjson current "$artifacts" --argjson artifact "$artifact" '$current + [$artifact]')
  artifact_index=$((artifact_index + 1))
done
jq -e 'map(.id) | length == (unique | length)' <<<"$artifacts" >/dev/null || die "artifact ids must be unique"
protected_paths=$(relative_paths_json "$(ask 'Protected path/glob(s), comma-separated; include .loop/** and toolchain/test policy')")

env_raw=$(ask 'Environment variable names commands may inherit, comma-separated; values are never requested (usually include PATH)')
environment_names=$(csv_json "$env_raw")
[ "$(jq 'length' <<<"$environment_names")" -gt 0 ] || die "at least one environment variable name is required"
jq -e 'index("PATH") != null' <<<"$environment_names" >/dev/null || die "PATH must be explicitly allowed for the v1 reference engine"
while IFS= read -r name; do
  [[ "$name" =~ ^[A-Z_][A-Z0-9_]*$ ]] || die "invalid environment variable name: $name"
done < <(jq -r '.[]' <<<"$environment_names")

execute_command=$(command_json EXECUTE verify-execute)
validate_command=$(command_json VALIDATE verify-validate)
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
required_evidence=$(csv_json "$(ask "Required VALIDATE evidence kinds, comma-separated [recommended: $recommended]")")
[ "$(jq 'length' <<<"$required_evidence")" -gt 0 ] || die "at least one validation evidence kind is required"
while IFS= read -r evidence_kind; do
  case "$evidence_kind" in acceptance|command|artifact|behavior|contract|installation|package|documentation|link-check) ;;
    *) die "unsupported validation evidence kind: $evidence_kind" ;;
  esac
done < <(jq -r '.[]' <<<"$required_evidence")

max_wall_seconds=$(ask 'Maximum wall-clock seconds per activated run')
[[ "$max_wall_seconds" =~ ^[0-9]+$ ]] && [ "$max_wall_seconds" -ge 1 ] || die "wall-clock cap must be a positive integer"
engine_pin=$(ask 'Immutable engine release or Git revision to pin')
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
{
  printf 'engine_pin=%s\n' "$engine_pin"
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
