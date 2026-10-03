#!/usr/bin/env bash
set -euo pipefail

provider_dir=$(cd "$(dirname "$0")/../.." && pwd -P)
. "$provider_dir/engine/provider-runtime.sh"

bin=${CODEX_BIN:-codex}
command -v "$bin" >/dev/null 2>&1 || { echo "Codex CLI not found: $bin" >&2; exit 69; }
tmp=$(mktemp -d "${TMPDIR:-/tmp}/codex-provider.XXXXXX")
trap 'provider_kill_group; rm -rf "$tmp"' EXIT HUP INT TERM
brief=$tmp/brief.json
cat >"$brief"
phase=${LOOP_PHASE:-$(jq -er '.phase' "$brief")}
base=$(jq -er '.prompt' "$brief")
[[ $phase =~ ^(DEFINE|DESIGN|EXECUTE|REVIEW|VALIDATE|HANDOVER|SCOUT)$ ]] || { echo "invalid phase: $phase" >&2; exit 1; }

if [[ $phase == SCOUT ]]; then
  # Scouting only reads. It proposes work; it never performs any.
  shape='{"schema_version":1,"status":"OK"|"BLOCKED","proposals":[{"title":"<text>","outcome":"<text>","constraints":["<text>"],"evidence":["<text>"]}]}'
  mode=(--sandbox read-only -c approval_policy=never)
elif [[ $phase == REVIEW || $phase == VALIDATE ]]; then
  shape='{"schema_version":1,"verdict_id":"<id>","run_id":"<brief run_id>","work_item_id":"<brief work_item_id>","phase":"REVIEW","gate_id":"REVIEW","nonce":"<brief nonce>","result":"PASS"|"FAIL","reviewer":"<name>","independent":true,"revision":"<brief revision>","captured_at":"<date-time>","evidence_refs":["<brief refs>"],"findings":[{"severity":"BLOCKING"|"HIGH"|"MEDIUM"|"LOW","category":"requirement"|"design"|"artifact"|"safety","evidence":"<text>","disposition":"OPEN"|"DISMISSED"}]}'
  mode=(--sandbox read-only -c approval_policy=never)
  if [[ $phase == VALIDATE ]]; then
    shape='{"schema_version":1,"status":"DONE"|"BLOCKED","defect_class":null|"requirement"|"design"|"artifact","blocker":null|"<text>","notes":"<text>"}'
  fi
else
  shape='{"schema_version":1,"status":"DONE"|"BLOCKED","defect_class":null|"requirement"|"design"|"artifact","blocker":null|"<text>","notes":"<text>"}'
  mode=(--sandbox workspace-write -c approval_policy=never)
fi
prompt="$base

Finish your reply with exactly this required JSON shape, filled with valid values, inside a \`\`\`json fenced block, and put nothing after it:
$shape"

provider_write_schema "$phase" "$tmp/schema.json"
# A phase-specific model (CODEX_MODEL_REVIEW, ...) wins over CODEX_MODEL.
phase_model_var="CODEX_MODEL_$phase"
model=${!phase_model_var:-${CODEX_MODEL:-}}
run_codex(){
  if [ -n "$model" ]; then provider_run_timed "$bin" --model "$model" "$@"
  else provider_run_timed "$bin" "$@"
  fi
}
printf '%s' "$prompt" >"$tmp/prompt.txt"
export PROVIDER_STDIN=$tmp/prompt.txt
set +e
if "$bin" exec --help 2>&1 | grep -q -- '--output-schema'; then
  run_codex exec "${mode[@]}" --skip-git-repo-check --output-schema "$tmp/schema.json" -o "$tmp/last.txt" - 1>&2
  rc=$?
else
  run_codex exec "${mode[@]}" --skip-git-repo-check -o "$tmp/last.txt" - 1>&2
  rc=$?
fi
set -e
if [ "$rc" -ne 0 ] || [ ! -s "$tmp/last.txt" ]; then echo "codex CLI failed (exit $rc) or produced no final message" >&2; exit 1; fi

provider_extract_json "$tmp/last.txt" >"$tmp/result.json" || { echo "no JSON result in agent reply; reply follows" >&2; cat "$tmp/last.txt" >&2; exit 1; }
if [[ $phase == SCOUT ]]; then
  jq -e 'type=="object" and .schema_version==1 and (.status=="OK" or .status=="BLOCKED") and (.proposals|type)=="array" and
    (.proposals|length)<=5 and all(.proposals[]; (.title|type)=="string" and (.outcome|type)=="string")' "$tmp/result.json" >/dev/null \
    || { echo "scout result does not match the provider contract; result follows" >&2; cat "$tmp/result.json" >&2; exit 1; }
elif [[ $phase == REVIEW ]]; then
  jq -e --slurpfile b "$brief" 'type=="object" and .schema_version==1 and .phase=="REVIEW" and .gate_id=="REVIEW" and .independent==true and
    .run_id==$b[0].run_id and .work_item_id==$b[0].work_item_id and .nonce==$b[0].nonce and .revision==$b[0].revision and .evidence_refs==$b[0].evidence_refs and
    has("verdict_id") and has("result") and has("reviewer") and has("captured_at") and has("findings")' "$tmp/result.json" >/dev/null \
    || { echo "verdict does not echo the challenge or lacks required fields; verdict follows" >&2; cat "$tmp/result.json" >&2; exit 1; }
else
  jq -e 'keys==["blocker","defect_class","notes","schema_version","status"] and .schema_version==1 and (.status=="DONE" or .status=="BLOCKED") and
    (.defect_class as $d | $d==null or (["requirement","design","artifact"]|index($d))) and (.blocker==null or (.blocker|type)=="string") and (.notes|type)=="string"' "$tmp/result.json" >/dev/null \
    || { echo "result does not match the provider contract; result follows" >&2; cat "$tmp/result.json" >&2; exit 1; }
fi
jq -c . "$tmp/result.json"
