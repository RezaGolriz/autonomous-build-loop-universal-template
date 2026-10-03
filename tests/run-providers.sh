#!/usr/bin/env bash
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd -P)
claude_provider="$repo/hosts/claude/provider.sh"
codex_provider="$repo/hosts/codex/provider.sh"
n=0
ok(){ n=$((n+1)); echo "ok $n - $1"; }
bad(){ echo "not ok - $1" >&2; exit 1; }

tmp=$(mktemp -d "${TMPDIR:-/tmp}/loop-provider-tests.XXXXXX")
trap 'rm -rf "$tmp"' EXIT INT TERM

jq -n '{phase:"EXECUTE",prompt:"implement bounded change"}' > "$tmp/execute.json"
jq -n '{phase:"VALIDATE",prompt:"inspect validation state"}' > "$tmp/validate.json"
jq -n '{phase:"SCOUT",read_only:true,profile:"docs",prompt:"scout the project for work"}' > "$tmp/scout.json"
jq -n '{phase:"REVIEW",prompt:"review exact diff",run_id:"run-1",work_item_id:"TEST-1",nonce:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",revision:"rev-1",evidence_refs:["evidence-1"]}' > "$tmp/review.json"

printf '%s\n' '#!/usr/bin/env bash' \
  'if [ "${1:-}" = --help ]; then echo "--json-schema"; exit 0; fi' \
  'printf "%s\n" "$@" > "$FAKE_ARGS"' \
  'cat > "$FAKE_ARGS.stdin"' \
  'if [ "$LOOP_PHASE" = REVIEW ]; then' \
  '  jq -nc '\''{is_error:false,structured_output:{schema_version:1,verdict_id:"verdict-1",run_id:"run-1",work_item_id:"TEST-1",phase:"REVIEW",gate_id:"REVIEW",nonce:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",result:"PASS",reviewer:"fake-claude",independent:true,revision:"rev-1",captured_at:"2026-09-06T00:00:00Z",evidence_refs:["evidence-1"],findings:[]}}'\''' \
  'elif [ "$LOOP_PHASE" = SCOUT ]; then' \
  '  jq -nc '\''{is_error:false,structured_output:{schema_version:1,status:"OK",proposals:[{title:"fake finding",outcome:"a bounded improvement",constraints:["change nothing else"],evidence:["docs/guide.md"]}]}}'\''' \
  'else jq -nc '\''{is_error:false,structured_output:{schema_version:1,status:"DONE",defect_class:null,blocker:null,notes:"fake"}}'\''; fi' > "$tmp/fake-claude"
chmod +x "$tmp/fake-claude"

FAKE_ARGS="$tmp/claude-exec.args" CLAUDE_BIN="$tmp/fake-claude" CLAUDE_MODEL=fable LOOP_PHASE=EXECUTE "$claude_provider" < "$tmp/execute.json" > "$tmp/out.json"
jq -e '.status=="DONE"' "$tmp/out.json" >/dev/null || bad 'Claude structured execute output failed'
grep -Fx -- '--json-schema' "$tmp/claude-exec.args" >/dev/null || bad 'Claude schema flag missing'
grep -Fx -- '--permission-mode' "$tmp/claude-exec.args" >/dev/null || bad 'Claude permission mode missing'
grep -Fx -- 'fable' "$tmp/claude-exec.args" >/dev/null || bad 'Claude model override missing'
grep -F 'implement bounded change' "$tmp/claude-exec.args" >/dev/null && bad 'Claude prompt must not appear on the command line'
grep -F 'implement bounded change' "$tmp/claude-exec.args.stdin" >/dev/null || bad 'Claude prompt must arrive on stdin'
ok 'Claude uses native structured output for mutable nodes'

FAKE_ARGS="$tmp/claude-phase.args" CLAUDE_BIN="$tmp/fake-claude" CLAUDE_MODEL=fable CLAUDE_MODEL_EXECUTE=sonnet CLAUDE_MODEL_REVIEW=opus LOOP_PHASE=EXECUTE "$claude_provider" < "$tmp/execute.json" > "$tmp/out.json"
grep -Fx -- 'sonnet' "$tmp/claude-phase.args" >/dev/null || bad 'Claude phase model missing'
grep -Fx -- 'fable' "$tmp/claude-phase.args" >/dev/null && bad 'Claude phase model did not win over CLAUDE_MODEL'
grep -Fx -- 'opus' "$tmp/claude-phase.args" >/dev/null && bad 'Claude used another phase model'
ok 'Claude phase model wins over the default model'

FAKE_ARGS="$tmp/claude-review.args" CLAUDE_BIN="$tmp/fake-claude" LOOP_PHASE=REVIEW "$claude_provider" < "$tmp/review.json" > "$tmp/out.json"
jq -e '.result=="PASS" and .independent==true' "$tmp/out.json" >/dev/null || bad 'Claude review output failed'
grep -Fx -- '--restricted' "$tmp/claude-review.args" >/dev/null || bad 'Claude review lacks restricted mode'
grep -Fx -- '--safe-mode' "$tmp/claude-review.args" >/dev/null || bad 'Claude review loads customization'
grep -Fx -- '--disallowedTools' "$tmp/claude-review.args" >/dev/null || bad 'Claude review lacks explicit denied tools'
grep -Fx -- 'Bash,Edit,Write,NotebookEdit,WebFetch' "$tmp/claude-review.args" >/dev/null || bad 'Claude review deny list incomplete'
ok 'Claude review combines restricted mode with explicit tool denial'

FAKE_ARGS="$tmp/claude-validate.args" CLAUDE_BIN="$tmp/fake-claude" LOOP_PHASE=VALIDATE "$claude_provider" < "$tmp/validate.json" > "$tmp/out.json"
jq -e '.status=="DONE"' "$tmp/out.json" >/dev/null || bad 'Claude validate output failed'
grep -Fx -- '--restricted' "$tmp/claude-validate.args" >/dev/null || bad 'Claude validate is not read-only'
ok 'Claude validation agent is read-only while the engine owns commands'

FAKE_ARGS="$tmp/claude-scout.args" CLAUDE_BIN="$tmp/fake-claude" LOOP_PHASE=SCOUT "$claude_provider" < "$tmp/scout.json" > "$tmp/out.json"
jq -e '.status=="OK" and (.proposals|length)==1 and .proposals[0].title=="fake finding"' "$tmp/out.json" >/dev/null || bad 'Claude scout output failed'
grep -Fx -- '--restricted' "$tmp/claude-scout.args" >/dev/null || bad 'Claude scout is not restricted'
grep -Fx -- 'Read,Glob,Grep' "$tmp/claude-scout.args" >/dev/null || bad 'Claude scout tools are not read-only'
grep -Fx -- 'Bash,Edit,Write,NotebookEdit,WebFetch' "$tmp/claude-scout.args" >/dev/null || bad 'Claude scout deny list incomplete'
ok 'Claude scouting reads with read-only tooling'

printf '%s\n' '#!/usr/bin/env bash' \
  'if [ "${1:-}" = exec ] && [ "${2:-}" = --help ]; then echo "--output-schema"; exit 0; fi' \
  'printf "%s\n" "$@" > "$FAKE_ARGS"' \
  'out=""; schema=""; previous=""' \
  'for arg in "$@"; do [ "$previous" != -o ] || out=$arg; [ "$previous" != --output-schema ] || schema=$arg; previous=$arg; done' \
  '[ -n "$schema" ] && jq -e '\''.type=="object" and .additionalProperties==false and ([..|objects|select(has("properties"))|.properties[]|has("type")]|all) and ([..|objects|select(has("uniqueItems") or has("minLength") or has("minItems") or has("pattern"))]|length==0)'\'' "$schema" >/dev/null && printf valid > "$FAKE_SCHEMA"' \
  'if [ "$LOOP_PHASE" = REVIEW ]; then' \
  '  jq -nc '\''{schema_version:1,verdict_id:"verdict-1",run_id:"run-1",work_item_id:"TEST-1",phase:"REVIEW",gate_id:"REVIEW",nonce:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",result:"PASS",reviewer:"fake-codex",independent:true,revision:"rev-1",captured_at:"2026-09-06T00:00:00Z",evidence_refs:["evidence-1"],findings:[]}'\'' > "$out"' \
  'elif [ "$LOOP_PHASE" = SCOUT ]; then' \
  '  jq -nc '\''{schema_version:1,status:"OK",proposals:[{title:"fake finding",outcome:"a bounded improvement",constraints:["change nothing else"],evidence:["docs/guide.md"]}]}'\'' > "$out"' \
  'else jq -nc '\''{schema_version:1,status:"DONE",defect_class:null,blocker:null,notes:"fake"}'\'' > "$out"; fi' > "$tmp/fake-codex"
chmod +x "$tmp/fake-codex"

FAKE_ARGS="$tmp/codex-exec.args" FAKE_SCHEMA="$tmp/codex-exec.schema" CODEX_BIN="$tmp/fake-codex" CODEX_MODEL=gpt-5.6-sol LOOP_PHASE=EXECUTE "$codex_provider" < "$tmp/execute.json" > "$tmp/out.json"
jq -e '.status=="DONE"' "$tmp/out.json" >/dev/null || bad 'Codex structured execute output failed'
[ "$(cat "$tmp/codex-exec.schema")" = valid ] || bad 'Codex schema was not valid at invocation'
grep -Fx -- '--output-schema' "$tmp/codex-exec.args" >/dev/null || bad 'Codex schema flag missing'
grep -Fx -- 'workspace-write' "$tmp/codex-exec.args" >/dev/null || bad 'Codex execute sandbox changed'
grep -Fx -- 'gpt-5.6-sol' "$tmp/codex-exec.args" >/dev/null || bad 'Codex model override missing'
ok 'Codex uses native output schema and preserves mutable-node sandbox'

FAKE_ARGS="$tmp/codex-phase.args" FAKE_SCHEMA="$tmp/codex-phase.schema" CODEX_BIN="$tmp/fake-codex" CODEX_MODEL=gpt-5.6-sol CODEX_MODEL_EXECUTE=gpt-5-codex LOOP_PHASE=EXECUTE "$codex_provider" < "$tmp/execute.json" > "$tmp/out.json"
grep -Fx -- 'gpt-5-codex' "$tmp/codex-phase.args" >/dev/null || bad 'Codex phase model missing'
grep -Fx -- 'gpt-5.6-sol' "$tmp/codex-phase.args" >/dev/null && bad 'Codex phase model did not win over CODEX_MODEL'
ok 'Codex phase model wins over the default model'

FAKE_ARGS="$tmp/codex-review.args" FAKE_SCHEMA="$tmp/codex-review.schema" CODEX_BIN="$tmp/fake-codex" LOOP_PHASE=REVIEW "$codex_provider" < "$tmp/review.json" > "$tmp/out.json"
jq -e '.result=="PASS" and .independent==true' "$tmp/out.json" >/dev/null || bad 'Codex review output failed'
[ "$(cat "$tmp/codex-review.schema")" = valid ] || bad 'Codex review schema was not valid at invocation'
grep -Fx -- 'read-only' "$tmp/codex-review.args" >/dev/null || bad 'Codex review sandbox not read-only'
ok 'Codex review stays read-only with structured verdicts'

FAKE_ARGS="$tmp/codex-validate.args" FAKE_SCHEMA="$tmp/codex-validate.schema" CODEX_BIN="$tmp/fake-codex" LOOP_PHASE=VALIDATE "$codex_provider" < "$tmp/validate.json" > "$tmp/out.json"
jq -e '.status=="DONE"' "$tmp/out.json" >/dev/null || bad 'Codex validate output failed'
grep -Fx -- 'read-only' "$tmp/codex-validate.args" >/dev/null || bad 'Codex validate sandbox not read-only'
ok 'Codex validation agent is read-only'

FAKE_ARGS="$tmp/codex-scout.args" FAKE_SCHEMA="$tmp/codex-scout.schema" CODEX_BIN="$tmp/fake-codex" LOOP_PHASE=SCOUT "$codex_provider" < "$tmp/scout.json" > "$tmp/out.json"
jq -e '.status=="OK" and (.proposals|length)==1 and .proposals[0].title=="fake finding"' "$tmp/out.json" >/dev/null || bad 'Codex scout output failed'
grep -Fx -- 'read-only' "$tmp/codex-scout.args" >/dev/null || bad 'Codex scout sandbox not read-only'
ok 'Codex scouting reads with a read-only sandbox'

printf '%s\n' '#!/usr/bin/env bash' \
  'if [ "${1:-}" = --help ]; then exit 0; fi' \
  'jq -nc --arg result '\''```json
{"schema_version":1,"status":"DONE","defect_class":null,"blocker":null,"notes":"legacy"}
```'\'' '\''{is_error:false,result:$result}'\''' > "$tmp/legacy-claude"
chmod +x "$tmp/legacy-claude"
CLAUDE_BIN="$tmp/legacy-claude" LOOP_PHASE=EXECUTE "$claude_provider" < "$tmp/execute.json" > "$tmp/out.json"
jq -e '.notes=="legacy"' "$tmp/out.json" >/dev/null || bad 'Claude legacy fenced output failed'
ok 'Claude fallback remains compatible when schema output is unavailable'

printf '%s\n' '#!/usr/bin/env bash' \
  'if [ "${1:-}" = exec ] && [ "${2:-}" = --help ]; then exit 0; fi' \
  'out=""; previous=""; for arg in "$@"; do [ "$previous" != -o ] || out=$arg; previous=$arg; done' \
  'printf '\''```json\n{"schema_version":1,"status":"DONE","defect_class":null,"blocker":null,"notes":"legacy"}\n```\n'\'' > "$out"' > "$tmp/legacy-codex"
chmod +x "$tmp/legacy-codex"
CODEX_BIN="$tmp/legacy-codex" LOOP_PHASE=EXECUTE "$codex_provider" < "$tmp/execute.json" > "$tmp/out.json"
jq -e '.notes=="legacy"' "$tmp/out.json" >/dev/null || bad 'Codex legacy fenced output failed'
ok 'Codex fallback remains compatible when output schemas are unavailable'

marker="$tmp/escaped-descendant"
printf '%s\n' '#!/usr/bin/env bash' \
  'if [ "${1:-}" = --help ]; then echo "--json-schema"; exit 0; fi' \
  '(sleep 2; printf escaped > "$DESCENDANT_MARKER") &' \
  'sleep 5' > "$tmp/hanging-claude"
chmod +x "$tmp/hanging-claude"
set +e; DESCENDANT_MARKER="$marker" PROVIDER_TIMEOUT=1 CLAUDE_BIN="$tmp/hanging-claude" LOOP_PHASE=EXECUTE "$claude_provider" < "$tmp/execute.json" >/dev/null 2>&1; rc=$?; set -e
[ "$rc" -ne 0 ] || bad 'timed-out provider returned success'
sleep 2
[ ! -e "$marker" ] || bad 'provider timeout left a descendant alive'
ok 'provider timeout terminates the isolated process group'

linger_marker="$tmp/lingering-provider-descendant"
cat > "$tmp/parent-exits.pl" <<'EOF'
use strict; use warnings;
my $pid = fork(); die "fork" unless defined $pid;
if ($pid == 0) { sleep 2; open my $fh, '>', $ENV{LINGER_MARKER} or die $!; print {$fh} "escaped"; close $fh; exit 0; }
exit 0;
EOF
set +e
LINGER_MARKER="$linger_marker" PROVIDER_TIMEOUT=1 bash -c '. "$1"; provider_run_timed perl "$2"' _ "$repo/engine/provider-runtime.sh" "$tmp/parent-exits.pl"
rc=$?
set -e
[ "$rc" -eq 0 ] || bad "successful provider main was treated as timeout (exit $rc)"
sleep 2
[ ! -e "$linger_marker" ] || bad 'successful provider left a helper process alive'
ok 'provider returns main status and cleans its lingering process group'

printf '%s\n' '#!/usr/bin/env bash' 'sleep 5' > "$tmp/slow-cmd"; chmod +x "$tmp/slow-cmd"
start=$(date +%s)
set +e
PROVIDER_TIMEOUT=5 PROVIDER_TIMEOUT_EXECUTE=1 LOOP_PHASE=EXECUTE bash -c '. "$1"; provider_run_timed "$2"' _ "$repo/engine/provider-runtime.sh" "$tmp/slow-cmd" >/dev/null 2>&1
rc=$?
set -e
elapsed=$(( $(date +%s) - start ))
[ "$rc" -eq 124 ] || bad "phase-specific timeout did not fire (exit $rc)"
[ "$elapsed" -le 3 ] || bad "PROVIDER_TIMEOUT_EXECUTE did not win over the longer plain PROVIDER_TIMEOUT ($elapsed s)"
ok 'a phase-specific PROVIDER_TIMEOUT_<PHASE> (as configure writes into the provider wrapper) wins over the plain PROVIDER_TIMEOUT'

set +e
PROVIDER_TIMEOUT_REVIEW=not-a-number LOOP_PHASE=REVIEW bash -c '. "$1"; provider_run_timed "$2"' _ "$repo/engine/provider-runtime.sh" "$tmp/slow-cmd" >/dev/null 2>"$tmp/bad-timeout.err"
rc=$?
set -e
[ "$rc" -eq 64 ] || bad "an invalid phase timeout returned $rc instead of 64"
grep -q 'PROVIDER_TIMEOUT must be a positive integer' "$tmp/bad-timeout.err" || bad 'an invalid phase timeout did not name PROVIDER_TIMEOUT in its error'
ok 'an invalid PROVIDER_TIMEOUT_<PHASE> is rejected the same way as an invalid plain PROVIDER_TIMEOUT'

echo "1..$n"
