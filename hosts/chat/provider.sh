#!/usr/bin/env bash
# Chat-hosted provider. It calls no model. The orchestrator hands it one node
# brief exactly as it hands one to the Codex or Claude CLI provider; this
# provider writes that brief to .loop/scheduler/chat/<node_id>.<attempt_id>.brief.json
# and waits until the chat agent (through chat_submit) writes
# .loop/scheduler/chat/<node_id>.<attempt_id>.result.json. It prints the result
# JSON inside it and exits. Everything after that — verification, evidence,
# the review challenge, the transition — is the orchestrator and the reference
# engine, unchanged.
#
# No result in time: for a builder phase it prints a BLOCKED result, which the
# orchestrator turns into a blocked run; for REVIEW it exits non-zero, which the
# orchestrator treats as an invalid verdict and also blocks. A timed-out node
# never passes and never counts as a failed review.
#
# node_id is short and opaque: n-<first 12 hex of sha256(run_id|round|phase|slice)>.
# The readable name (the orchestrator's run id, plus -slice-<n> for an EXECUTE
# slice) travels beside it as `label`. Every wait gets a fresh random
# attempt_id, so a result meant for an earlier wait of the same node (after a
# timeout or a resume) is never taken for this one.
#
# Bash 3.2 compatible.
set -euo pipefail

root=${LOOP_ROOT:-$PWD}
timeout=${CHAT_PROVIDER_TIMEOUT_SECONDS:-${PROVIDER_TIMEOUT:-3600}}
case "$timeout" in ''|*[!0-9]*|0) echo 'CHAT_PROVIDER_TIMEOUT_SECONDS must be a positive integer' >&2; exit 64;; esac
command -v jq >/dev/null 2>&1 || { echo 'jq is required' >&2; exit 69; }

# The chat directory is .loop/scheduler/chat and nothing else: no component may
# be a symlink, and the resolved directory has to stay inside the project.
root_real=$(cd "$root" 2>/dev/null && pwd -P) || { echo 'LOOP_ROOT is not a directory' >&2; exit 64; }
dir="$root_real/.loop/scheduler/chat"
chat_dir_safe(){
  local part
  for part in "$root_real/.loop" "$root_real/.loop/scheduler" "$dir"; do
    if [ -L "$part" ]; then echo "refusing symlinked ${part#"$root_real"/}" >&2; return 1; fi
    if [ -e "$part" ] && [ ! -d "$part" ]; then echo "${part#"$root_real"/} is not a directory" >&2; return 1; fi
  done
  [ -d "$dir" ] || return 0
  [ "$(cd "$dir" && pwd -P)" = "$dir" ] || { echo 'the chat directory resolves outside the project' >&2; return 1; }
}
chat_dir_safe || exit 73
[ -d "$root_real/.loop" ] || { echo '.loop is missing' >&2; exit 73; }
(umask 077; mkdir -p "$root_real/.loop/scheduler" "$dir") || exit 73
chmod 700 "$dir" 2>/dev/null || :
chat_dir_safe || exit 73

sha256_hex(){ if command -v shasum >/dev/null 2>&1; then shasum -a 256; else sha256sum; fi | cut -c1-64; }
random_hex(){ od -An -N16 -tx1 /dev/urandom | tr -d ' \n'; }

brief_tmp=$(mktemp "$dir/.brief.XXXXXX")
pending_tmp=
node=
attempt=
cleanup(){
  rm -f "$brief_tmp" "$brief_tmp.w" 2>/dev/null || :
  [ -z "$pending_tmp" ] || rm -f "$pending_tmp" 2>/dev/null || :
  # Withdraw the pointer only when it still names this wait.
  if [ -n "$attempt" ] && [ ! -L "$dir/pending.json" ] && [ -f "$dir/pending.json" ] \
    && jq -e --arg a "$attempt" '.attempt_id==$a' "$dir/pending.json" >/dev/null 2>&1; then
    rm -f "$dir/pending.json"
  fi
}
trap cleanup EXIT INT TERM

cat > "$brief_tmp"
jq -e 'type=="object" and (.phase|type=="string") and (.work_item_id|type=="string")' "$brief_tmp" >/dev/null 2>&1 \
  || { echo 'chat provider received no valid node brief' >&2; exit 65; }
phase=$(jq -r .phase "$brief_tmp")
work=$(jq -r .work_item_id "$brief_tmp")
run=${LOOP_RUN_ID:-}
case "$run" in ''|*[!A-Za-z0-9._-]*) echo 'LOOP_RUN_ID is missing or invalid' >&2; exit 64;; esac
label=$run
slice=
if [ "$phase" = EXECUTE ]; then
  slice=$(jq -r '.task // ""' "$brief_tmp" | sed -n 's/^Slice \([0-9][0-9]*\) of .*/\1/p' | head -n 1)
  [ -z "$slice" ] || label="$run-slice-$slice"
fi
round=$(jq -r '.round // 0' "$root_real/.loop/state.json" 2>/dev/null || echo 0)
case "$round" in ''|*[!0-9]*) round=0;; esac
node="n-$(printf '%s|%s|%s|%s' "$run" "$round" "$phase" "$slice" | sha256_hex | cut -c1-12)"
attempt=$(random_hex)
case "$node" in n-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;; *) echo 'could not derive the node id' >&2; exit 70;; esac
case "$attempt" in *[!0-9a-f]*|'') echo 'could not draw an attempt id' >&2; exit 70;; esac
[ ${#attempt} -eq 32 ] || { echo 'could not draw an attempt id' >&2; exit 70; }
base="$dir/$node.$attempt"

jq -c --arg node "$node" --arg attempt "$attempt" --arg label "$label" --arg phase "$phase" \
  '{schema_version:1,node_id:$node,attempt_id:$attempt,label:$label,phase:$phase,brief:.}' "$brief_tmp" > "$brief_tmp.w"
chat_dir_safe || exit 73
mv "$brief_tmp.w" "$base.brief.json"
deadline=$(( $(date +%s) + timeout ))
pending_tmp=$(mktemp "$dir/.pending.XXXXXX")
jq -n --arg node "$node" --arg attempt "$attempt" --arg label "$label" --arg run "$run" --arg phase "$phase" --arg work "$work" --argjson round "$round" \
  --argjson pid "$$" --argjson deadline "$deadline" --arg at "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
  '{schema_version:1,node_id:$node,attempt_id:$attempt,label:$label,run_id:$run,phase:$phase,work_item_id:$work,round:$round,provider_pid:$pid,created_at:$at,deadline_epoch:$deadline}' > "$pending_tmp"
chat_dir_safe || exit 73
mv "$pending_tmp" "$dir/pending.json"; pending_tmp=

result="$base.result.json"
consumed="$base.consumed.json"
reason=
# Only this attempt's result file is taken, and only when it names this node
# and this attempt inside. Taking it is one rename, so a result that chat_submit
# withdraws at the same moment is either taken whole or not at all.
take(){
  [ -f "$result" ] && [ ! -L "$result" ] || return 1
  chat_dir_safe || return 1
  mv "$result" "$consumed" 2>/dev/null || return 1
  if jq -e --arg n "$node" --arg a "$attempt" '.node_id==$n and .attempt_id==$a and (.result|type=="object")' "$consumed" >/dev/null 2>&1; then
    jq -c .result "$consumed"
    return 0
  fi
  mv "$consumed" "$base.rejected.json" 2>/dev/null || :
  return 1
}
while :; do
  if [ -f "$result" ] && take; then exit 0; fi
  if [ -f "$base.abort" ]; then reason='chat node abandoned: pause or cancel was requested'; break; fi
  if [ "$(date +%s)" -ge "$deadline" ]; then reason='no chat result within timeout'; break; fi
  sleep 0.2
done
# Withdraw the pointer first, then look once more: a result that landed in the
# same moment is still taken, and after this no new submission is accepted.
rm -f "$dir/pending.json"
if take; then exit 0; fi
jq -n --arg r "$reason" --arg at "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" '{schema_version:1,reason:$r,at:$at}' > "$base.expired.json"
echo "$reason" >&2
if [ "$phase" = REVIEW ]; then exit 1; fi
jq -n --arg r "$reason" '{schema_version:1,status:"BLOCKED",defect_class:null,blocker:$r,notes:"chat-hosted provider"}'
