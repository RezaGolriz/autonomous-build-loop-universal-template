#!/usr/bin/env bash
# Managed API provider: runs one node for a member of the approved team over
# the OpenAI Responses or Anthropic Messages API (runtimes/api-runtime.mjs).
# It starts no agent CLI. Same contract as every provider: the node brief on
# stdin, one result JSON (or, for REVIEW, one verdict) on stdout, logs on
# stderr, nonzero exit on invocation or transport error. It never chooses a
# state transition; the orchestrator verifies and decides.
#
# Environment: node on PATH, the credential variable the approved team names
# (it has to be in the adapter's environment.allow_names to reach this
# process), and optionally API_TEAM_MEMBER to pick a member by id. The time,
# token and turn limits come from the approved team; PROVIDER_TIMEOUT (and
# PROVIDER_TIMEOUT_<PHASE>) still bound the whole process from outside.
set -euo pipefail

provider_dir=$(cd "$(dirname "$0")/../.." && pwd -P)
. "$provider_dir/engine/provider-runtime.sh"

node_bin=$(command -v node 2>/dev/null) || { echo 'node is required for the managed API provider' >&2; exit 69; }
tmp=$(mktemp -d "${TMPDIR:-/tmp}/api-provider.XXXXXX")
trap 'provider_kill_group; rm -rf "$tmp"' EXIT HUP INT TERM
brief=$tmp/brief.json
cat >"$brief"
phase=${LOOP_PHASE:-$(jq -er '.phase' "$brief")}
[[ $phase =~ ^(DEFINE|DESIGN|EXECUTE|REVIEW|VALIDATE|HANDOVER|SCOUT)$ ]] || { echo "invalid phase: $phase" >&2; exit 1; }
export LOOP_PHASE=$phase

set +e
provider_run_timed "$node_bin" "$provider_dir/runtimes/api-runtime.mjs" --brief "$brief" --result "$tmp/result.json" 1>&2
rc=$?
set -e
if [ "$rc" -ne 0 ] || [ ! -s "$tmp/result.json" ]; then echo "managed API runtime failed (exit $rc) or produced no result" >&2; exit 1; fi

if [[ $phase == SCOUT ]]; then
  jq -e 'type=="object" and .schema_version==1 and (.status=="OK" or .status=="BLOCKED") and (.proposals|type)=="array" and
    (.proposals|length)<=5 and all(.proposals[]; (.title|type)=="string" and (.outcome|type)=="string")' "$tmp/result.json" >/dev/null \
    || { echo "scout result does not match the provider contract" >&2; exit 1; }
elif [[ $phase == REVIEW ]]; then
  jq -e --slurpfile b "$brief" 'type=="object" and .schema_version==1 and .phase=="REVIEW" and .gate_id=="REVIEW" and .independent==true and
    .run_id==$b[0].run_id and .work_item_id==$b[0].work_item_id and .nonce==$b[0].nonce and .revision==$b[0].revision and .evidence_refs==$b[0].evidence_refs and
    has("verdict_id") and has("result") and has("reviewer") and has("captured_at") and has("findings")' "$tmp/result.json" >/dev/null \
    || { echo "verdict does not echo the challenge or lacks required fields" >&2; exit 1; }
else
  jq -e 'keys==["blocker","defect_class","notes","schema_version","status"] and .schema_version==1 and (.status=="DONE" or .status=="BLOCKED") and
    (.defect_class as $d | $d==null or (["requirement","design","artifact"]|index($d))) and (.blocker==null or (.blocker|type)=="string") and (.notes|type)=="string"' "$tmp/result.json" >/dev/null \
    || { echo "result does not match the provider contract" >&2; exit 1; }
fi
jq -c . "$tmp/result.json"
