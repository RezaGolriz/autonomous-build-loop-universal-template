#!/usr/bin/env bash

# Shared validation and snapshot primitives for the reference engine and the
# orchestrator. Callers are responsible for requiring jq, find, and shasum.

loop_validate_state() {
  jq -e 'type=="object" and ((keys-["schema_version","work_item_id","phase","run_status","step","round","max_rounds","gate_failures_here","max_gate_failures","started_epoch","paused_epoch","max_wall_seconds","autonomy","gates","last_result","next_action","updated_at"])|length==0) and .schema_version==1 and
    ((has("paused_epoch")|not) or (.paused_epoch|type=="number" and .>=0 and floor==.)) and (.run_status!="RUNNING" or (has("paused_epoch")|not)) and
    (.work_item_id|test("^[A-Za-z0-9][A-Za-z0-9._-]*$")) and (.phase as $p|["DEFINE","DESIGN","EXECUTE","REVIEW","VALIDATE","HANDOVER"]|index($p)!=null) and
    (.run_status as $s|["PAUSED","RUNNING","BLOCKED","WAITING_FOR_HUMAN","COMPLETED","CANCELLED"]|index($s)!=null) and
    all([.step,.next_action,.updated_at][];type=="string" and length>0) and (.last_result|type=="string") and
    all([.round,.max_rounds,.gate_failures_here,.max_gate_failures][];type=="number" and .>=0 and floor==.) and .max_rounds>=1 and .max_gate_failures>=1 and
    (if .run_status=="RUNNING" then (.started_epoch|type=="number" and .>=0 and floor==.) and (.max_wall_seconds|type=="number" and .>=1 and floor==.) else ((.started_epoch//0)|type=="number" and .>=0 and floor==.) and ((.max_wall_seconds//1)|type=="number" and .>=1 and floor==.) end) and
    (.autonomy as $a|["supervised","guarded","autonomous"]|index($a)!=null) and (.gates|type=="object" and (keys|sort)==(["DEFINE","DESIGN","EXECUTE","REVIEW","VALIDATE","HANDOVER"]|sort)) and
    all(.gates|to_entries[];.value|type=="object" and ((keys-["status","evidence_ids"])|length==0) and (.status as $x|["PENDING","PASSED","FAILED","NOT_APPLICABLE"]|index($x)!=null) and (.evidence_ids|type=="array" and length==(unique|length) and all(.[];type=="string" and length>0))) and .gates.REVIEW.status!="NOT_APPLICABLE"' "$1" >/dev/null
}

# Waiting for a person does not use up the wall-clock budget. When a run
# leaves RUNNING, paused_epoch records the moment; when it runs again,
# started_epoch moves forward by the time spent waiting. Apply this filter to
# every new state with the previous state as $old and the current epoch as $e.
LOOP_PAUSE_ACCOUNTING_JQ='
  if ($old.run_status=="RUNNING") and (.run_status!="RUNNING") and ((.started_epoch//0)>0) and (has("paused_epoch")|not) then .paused_epoch=$e
  elif (.run_status=="RUNNING") and has("paused_epoch") then .started_epoch=((.started_epoch//0)+([($e-.paused_epoch),0]|max))|del(.paused_epoch)
  else . end'

# Seconds of wall clock a run has used, excluding time spent waiting.
loop_elapsed_seconds() { # state-file
  jq -r --argjson e "$(date +%s)" '((.paused_epoch // $e) - (.started_epoch // 0))' "$1"
}

# Rewrite a new state file ($1) in place, applying pause accounting against the
# previous state file ($2).
loop_apply_pause_accounting() { # new-state old-state
  local tmp
  tmp=$(mktemp "$(dirname "$1")/.pause.XXXXXX")
  jq --slurpfile old "$2" --argjson e "$(date +%s)" "\$old[0] as \$old | $LOOP_PAUSE_ACCOUNTING_JQ" "$1" > "$tmp" || { rm -f "$tmp"; return 1; }
  mv "$tmp" "$1"
}

loop_stat_mode(){
  local snapshot_mode
  if stat -f '%Lp' "$1" >/dev/null 2>&1; then snapshot_mode=$(stat -f '%Lp' "$1")
  else snapshot_mode=$(stat -c '%a' "$1")
  fi
  case "$snapshot_mode" in
    [0-7]|[0-7][0-7]|[0-7][0-7][0-7]|[0-7][0-7][0-7][0-7]) printf '%04o\n' "0$snapshot_mode" ;;
    *) return 1 ;;
  esac
}

loop_snapshot_stream() {
  local snapshot_root=$1 snapshot_kind=$2
  (
    cd "$snapshot_root"
    if [ "$snapshot_kind" = source ]; then
      # .loop/scheduler holds cadence bookkeeping only (tick log, tick lock,
      # pending confirmations). It is never code and never an artifact, and a
      # cadence writes it while a node runs, so it is ignored like .loop/evidence.
      find . \( \
        -path './.git' -o -path './.git/*' -o \
        -path './.loop/evidence' -o -path './.loop/evidence/*' -o \
        -path './.loop/control' -o -path './.loop/control/*' -o \
        -path './.loop/scheduler' -o -path './.loop/scheduler/*' -o \
        -path './.loop/engine.lock' -o -path './.loop/engine.lock/*' -o \
        -path './.loop/orchestrator.lock' -o -path './.loop/orchestrator.lock/*' \
      \) -prune -o \( -type f -o -type l \) -print0
    else
      for snapshot_path in .loop/evidence .loop/control .loop/orchestrator.lock .loop/engine.lock; do
        [ -e "$snapshot_path" ] || continue
        find "$snapshot_path" \( -type f -o -type l \) -print0
      done
    fi | while IFS= read -r -d '' snapshot_path; do
      snapshot_path=${snapshot_path#./}
      case "$snapshot_path" in *$'\n'*|*$'\r'*) echo 'ERROR: newline in workspace path is unsupported' >&2; return 65;; esac
      if [ -L "$snapshot_path" ]; then
        snapshot_type=symlink
        snapshot_hash=$(printf 'LINK:%s' "$(readlink "$snapshot_path")" | shasum -a 256 | awk '{print $1}')
      else
        snapshot_type=file
        snapshot_hash=$(shasum -a 256 "$snapshot_path" | awk '{print $1}')
      fi
      snapshot_mode=$(loop_stat_mode "$snapshot_path")
      jq -cn --arg p "$snapshot_path" --arg k "$snapshot_type" --arg h "$snapshot_hash" --arg m "$snapshot_mode" '{path:$p,kind:$k,sha256:$h,mode:$m}'
    done
  )
}

loop_snapshot() {
  local snapshot_root=$1 snapshot_dest=$2 snapshot_kind=${3:-source} snapshot_tmp
  snapshot_tmp=$(mktemp "${TMPDIR:-/tmp}/loop-snapshot.XXXXXX")
  loop_snapshot_stream "$snapshot_root" "$snapshot_kind" | jq -s '{schema_version:1,files:(sort_by(.path))}' > "$snapshot_tmp"
  mkdir -p "$(dirname "$snapshot_dest")"
  mv "$snapshot_tmp" "$snapshot_dest"
}

loop_changed_paths() {
  jq -n -r --slurpfile b "$1" --slurpfile a "$2" '
    ((($b[0].files+$a[0].files)|map(.path)|unique)[]) as $p |
    (($b[0].files|map(select(.path==$p))|.[0])//null) as $x |
    (($a[0].files|map(select(.path==$p))|.[0])//null) as $y |
    select($x!=$y) | $p'
}
