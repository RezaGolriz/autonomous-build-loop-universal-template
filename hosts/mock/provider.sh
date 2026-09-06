#!/usr/bin/env bash
# Deterministic test provider. MOCK_SCRIPT points at a JSON object mapping
# phase -> action. It never decides a gate; it only produces node output.
set -euo pipefail

tmp=$(mktemp -d "${TMPDIR:-/tmp}/mock-provider.XXXXXX")
trap 'rm -rf "$tmp"' EXIT INT TERM
brief="$tmp/brief.json"; cat > "$brief"
phase=$(jq -r '.phase' "$brief"); work=$(jq -r '.work_item_id' "$brief")
root=${LOOP_ROOT:-$PWD}; wi="$root/.loop/work-items/$work.md"

action=""
if [ -n "${MOCK_SCRIPT:-}" ] && [ -f "${MOCK_SCRIPT:-}" ]; then
  action=$(jq -r --arg p "$phase" '.[$p] // empty' "$MOCK_SCRIPT")
fi
if [ -z "$action" ]; then case "$phase" in REVIEW) action=pass;; *) action=done;; esac; fi

done_json(){ printf '{"schema_version":1,"status":"DONE","defect_class":null,"blocker":null,"notes":"mock"}\n'; }
blocked_json(){ printf '{"schema_version":1,"status":"BLOCKED","defect_class":null,"blocker":"decision needed: mock","notes":"mock"}\n'; }

add_under(){ # heading content
  awk -v h="$1" -v c="$2" '
    $0==h { f=1; ins=0; print; next }
    f && /^## / { print c; print ""; f=0; ins=1 }
    { print }
    END { if (f && !ins) print c }' "$wi" > "$wi.mock" && mv "$wi.mock" "$wi"
}

if [ "$phase" = REVIEW ]; then
  [ -z "${MOCK_DUMP:-}" ] || cp "$brief" "$MOCK_DUMP"
  result=PASS; findings='[]'
  case "$action" in
    fail:*) result=FAIL
      cat=${action#fail:}
      findings=$(jq -nc --arg c "$cat" '[{severity:"BLOCKING",category:$c,evidence:"mock finding",disposition:"OPEN"}]');;
  esac
  jq -n --slurpfile b "$brief" --arg at "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" --arg r "$result" --argjson f "$findings" \
    '$b[0] as $x | {schema_version:1,verdict_id:("verdict-"+$x.run_id),run_id:$x.run_id,work_item_id:$x.work_item_id,
      phase:"REVIEW",gate_id:"REVIEW",nonce:$x.nonce,result:$r,reviewer:"mock",independent:true,revision:$x.revision,
      captured_at:$at,evidence_refs:$x.evidence_refs,findings:$f}'
  exit 0
fi

if [ "$action" = block ]; then blocked_json; exit 0; fi

case "$phase" in
  DEFINE)
    add_under '## Acceptance criteria' '- AC-1: Given the CLI, when greeting() is called, then it returns Hello, World!'
    add_under '## Out of scope' '- Nothing else';;
  DESIGN)
    add_under '## Design' '- Single function in src/greet.py'
    add_under '## Execution slices' '| 1 | src/** | requirements/** | test | tests pass |'
    add_under '## Execution slices' '| 2 | `tests/**` | `src/**`, requirements/** | test | tests pass |';;
  HANDOVER)
    add_under '## Handover' '- Revision and evidence recorded';;
  EXECUTE)
    case "$(jq -r '.task' "$brief")" in "Slice 2 of"*) printf '# touched by slice 2\n' >> "$root/tests/notes.txt"; done_json; exit 0;; esac
    mkdir -p "$root/src"
    case "$action" in
      fail) printf 'def greeting(name: str) -> str:\n    return f"Goodbye, {name}!"\n\n' > "$root/src/greet.py";;
      *) printf '# implemented by mock provider\ndef greeting(name: str) -> str:\n    return f"Hello, {name}!"\n' > "$root/src/greet.py";;
    esac
    if [ "$action" = add-file ]; then printf 'VALUE = 1\n' > "$root/src/extra_module.py"; fi
    if [ "$action" = touch-frozen ]; then mkdir -p "$root/requirements"; printf 'frozen\n' > "$root/requirements/frozen.md"; fi;;
  VALIDATE) : ;;
esac
done_json
