#!/usr/bin/env bash

provider_pid=

provider_kill_group(){
  [ -n "${provider_pid:-}" ] || return 0
  kill -TERM -- "-$provider_pid" 2>/dev/null || kill -TERM "$provider_pid" 2>/dev/null || :
  sleep 0.2
  kill -KILL -- "-$provider_pid" 2>/dev/null || kill -KILL "$provider_pid" 2>/dev/null || :
  wait "$provider_pid" 2>/dev/null || :
  provider_pid=
}

provider_run_timed(){
  local timeout=${PROVIDER_TIMEOUT:-900} ticks elapsed rc
  [[ "$timeout" =~ ^[1-9][0-9]*$ ]] || { echo 'PROVIDER_TIMEOUT must be a positive integer' >&2; return 64; }
  command -v perl >/dev/null 2>&1 || { echo 'Perl is required for provider process isolation' >&2; return 69; }
  perl -MPOSIX -e 'POSIX::setpgid(0,0); exec @ARGV or exit 127' "$@" & provider_pid=$!
  ticks=$((timeout*10)); elapsed=0
  while kill -0 "$provider_pid" 2>/dev/null && [ "$elapsed" -lt "$ticks" ]; do
    sleep 0.1
    elapsed=$((elapsed+1))
  done
  if kill -0 "$provider_pid" 2>/dev/null; then
    provider_kill_group
    echo 'provider timed out' >&2
    return 124
  fi
  if wait "$provider_pid"; then rc=0; else rc=$?; fi
  if kill -0 -- "-$provider_pid" 2>/dev/null; then
    kill -TERM -- "-$provider_pid" 2>/dev/null || :
    sleep 0.2
    kill -KILL -- "-$provider_pid" 2>/dev/null || :
  fi
  provider_pid=
  return "$rc"
}

provider_write_schema(){
  local provider_phase=$1 provider_schema=$2
  if [ "$provider_phase" = REVIEW ]; then
    jq -n '{
      type:"object", additionalProperties:false,
      required:["schema_version","verdict_id","run_id","work_item_id","phase","gate_id","nonce","result","reviewer","independent","revision","captured_at","evidence_refs","findings"],
      properties:{
        schema_version:{type:"integer",const:1}, verdict_id:{type:"string"}, run_id:{type:"string"}, work_item_id:{type:"string"},
        phase:{type:"string",const:"REVIEW"}, gate_id:{type:"string",const:"REVIEW"}, nonce:{type:"string"}, result:{type:"string",enum:["PASS","FAIL"]},
        reviewer:{type:"string"}, independent:{type:"boolean",const:true}, revision:{type:"string"}, captured_at:{type:"string"},
        evidence_refs:{type:"array",items:{type:"string"}},
        findings:{type:"array",items:{type:"object",additionalProperties:false,required:["severity","category","evidence","disposition"],properties:{severity:{type:"string",enum:["BLOCKING","HIGH","MEDIUM","LOW"]},category:{type:"string",enum:["requirement","design","artifact","safety"]},evidence:{type:"string"},disposition:{type:"string",enum:["OPEN","DISMISSED"]}}}}
      }
    }' > "$provider_schema"
  else
    jq -n '{
      type:"object", additionalProperties:false, required:["schema_version","status","defect_class","blocker","notes"],
      properties:{schema_version:{type:"integer",const:1},status:{type:"string",enum:["DONE","BLOCKED"]},defect_class:{type:["null","string"],enum:[null,"requirement","design","artifact"]},blocker:{type:["null","string"]},notes:{type:"string"}}
    }' > "$provider_schema"
  fi
}

provider_extract_json(){
  jq -Rrs '([scan("(?s)```json[ \\t]*\\r?\\n(.*?)\\r?\\n```") | .[0]] | last) //
    (split("\n") as $l | ([range(0; $l|length) | select($l[.]|startswith("{"))] | last) as $i | $l[$i:] | join("\n")) | fromjson' "$1"
}
