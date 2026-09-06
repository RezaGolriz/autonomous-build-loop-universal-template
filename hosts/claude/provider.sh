#!/usr/bin/env bash
set -euo pipefail

bin=${CLAUDE_BIN:-claude}
command -v "$bin" >/dev/null 2>&1 || { echo "Claude CLI not found: $bin" >&2; exit 69; }
tmp=$(mktemp -d "${TMPDIR:-/tmp}/claude-provider.XXXXXX")
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
brief=$tmp/brief.json
cat >"$brief"
phase=${LOOP_PHASE:-$(jq -er '.phase' "$brief")}
base=$(jq -er '.prompt' "$brief")
[[ $phase =~ ^(DEFINE|DESIGN|EXECUTE|REVIEW|VALIDATE|HANDOVER)$ ]] || { echo "invalid phase: $phase" >&2; exit 1; }

if [[ $phase == REVIEW ]]; then
  shape='{"schema_version":1,"verdict_id":"<id>","run_id":"<brief run_id>","work_item_id":"<brief work_item_id>","phase":"REVIEW","gate_id":"REVIEW","nonce":"<brief nonce>","result":"PASS"|"FAIL","reviewer":"<name>","independent":true,"revision":"<brief revision>","captured_at":"<date-time>","evidence_refs":["<brief refs>"],"findings":[{"severity":"BLOCKING"|"HIGH"|"MEDIUM"|"LOW","category":"requirement"|"design"|"artifact"|"safety","evidence":"<text>","disposition":"OPEN"|"DISMISSED"}]}'
  tools='Read,Glob,Grep'
else
  shape='{"schema_version":1,"status":"DONE"|"BLOCKED","defect_class":null|"requirement"|"design"|"artifact","blocker":null|"<text>","notes":"<text>"}'
  tools='Read,Edit,Write,Bash,Glob,Grep'
fi
prompt="$base

Finish your reply with exactly this required JSON shape, filled with valid values, inside a \`\`\`json fenced block, and put nothing after it:
$shape"

run_timed() {
  "$@" & pid=$!; start=$SECONDS
  while kill -0 "$pid" 2>/dev/null; do
    (( SECONDS - start < ${PROVIDER_TIMEOUT:-900} )) || { kill "$pid" 2>/dev/null || :; wait "$pid" 2>/dev/null || :; echo "provider timed out" >&2; return 124; }
    sleep 1
  done
  wait "$pid"
}

run_timed "$bin" -p "$prompt" --output-format json --permission-mode acceptEdits --allowedTools "$tools" >"$tmp/cli.json"
jq -er '.result' "$tmp/cli.json" >"$tmp/message.txt"

extract_json() {
  jq -Rrs '([scan("```json[ \\t]*\\r?\\n(.*?)\\r?\\n```"; "s") | .[0]] | last) //
    (split("\n") as $l | ([range(0; $l|length) | select($l[.]|startswith("{"))] | last) as $i | $l[$i:] | join("\n")) | fromjson' "$1"
}
extract_json "$tmp/message.txt" >"$tmp/result.json"
if [[ $phase == REVIEW ]]; then
  jq -e --slurpfile b "$brief" 'type=="object" and .schema_version==1 and .phase=="REVIEW" and .gate_id=="REVIEW" and .independent==true and
    .run_id==$b[0].run_id and .work_item_id==$b[0].work_item_id and .nonce==$b[0].nonce and .revision==$b[0].revision and .evidence_refs==$b[0].evidence_refs and
    has("verdict_id") and has("result") and has("reviewer") and has("captured_at") and has("findings")' "$tmp/result.json" >/dev/null
else
  jq -e 'keys==["blocker","defect_class","notes","schema_version","status"] and .schema_version==1 and (.status=="DONE" or .status=="BLOCKED") and
    (.defect_class as $d | $d==null or (["requirement","design","artifact"]|index($d))) and (.blocker==null or (.blocker|type)=="string") and (.notes|type)=="string"' "$tmp/result.json" >/dev/null
fi
jq -c . "$tmp/result.json"
