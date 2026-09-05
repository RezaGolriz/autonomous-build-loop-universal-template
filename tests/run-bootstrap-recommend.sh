#!/usr/bin/env bash
set -euo pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
passes=0
test_root=$(mktemp -d "${TMPDIR:-/tmp}/loop-recommend-suite.XXXXXX")
cleanup() { rm -rf "$test_root"; }
trap cleanup EXIT
new_tmp() { mktemp -d "$test_root/case.XXXXXX"; }
pass() { passes=$((passes + 1)); printf 'PASS: %s\n' "$1"; }
assert_jq() { local name=$1 file=$2 expression=$3; jq -e "$expression" "$file" >/dev/null || { printf 'FAIL: %s\n' "$name" >&2; exit 1; }; pass "$name"; }

# Filename-only Python discovery must not interpret either source or manifest content.
python_target=$(new_tmp)
mkdir -p "$python_target/src" "$python_target/tests"
printf '%s\n' '$(touch SHOULD_NOT_EXIST)' > "$python_target/pyproject.toml"
printf '%s\n' 'raise SystemExit("must not run")' > "$python_target/src/main.py"
printf '%s\n' 'open("SHOULD_NOT_EXIST", "w").close()' > "$python_target/tests/test_attack.py"
before=$(find -P "$python_target" -type f -print | LC_ALL=C sort | xargs shasum -a 256)
"$repo/bootstrap/recommend.sh" "$python_target" > "$python_target.recommendation.json"
after=$(find -P "$python_target" -type f -print | LC_ALL=C sort | xargs shasum -a 256)
[ "$before" = "$after" ] && [ ! -e "$python_target/SHOULD_NOT_EXIST" ] || { echo 'FAIL: recommendation mutated or executed target content' >&2; exit 1; }
pass 'recommendation is read-only and never executes Python/manifest content'
assert_jq 'Python CLI recommendation is evidence-labeled' "$python_target.recommendation.json" '.label == "RECOMMENDATION_ONLY" and .scan.read_only and .scan.nul_safe and .recommendation.project_kind == "cli" and .recommendation.languages == ["Python"] and (.recommendation.commands | map(.argv) | all(. == ["python3","-m","pytest"])) and .evidence.basis == "NUL-safe filenames and allowlisted package.json fields only"'
assert_jq 'target platform is manual and wall cap is conservative' "$python_target.recommendation.json" '.recommendation.platforms == [] and .recommendation.max_wall_seconds == 1800 and (.recommendation.platform_note | contains("manual"))'

empty_target=$(new_tmp)
"$repo/bootstrap/recommend.sh" "$empty_target" > "$empty_target.recommendation.json"
assert_jq 'unknown project does not invent platform or artifact identity' "$empty_target.recommendation.json" '.recommendation.project_kind == "other" and .recommendation.platforms == [] and .recommendation.artifact == null and (.recommendation.commands | length) == 0'

decoy_target=$(new_tmp)
decoy_name=$'decoy\npackage.json'
printf '%s\n' '{"scripts":{"test":"touch DECOY_RAN"}}' > "$decoy_target/$decoy_name"
"$repo/bootstrap/recommend.sh" "$decoy_target" > "$decoy_target.recommendation.json"
assert_jq 'newline decoy cannot fabricate a recognized basename' "$decoy_target.recommendation.json" '.recommendation.languages == [] and .recommendation.artifact == null and (.recommendation.commands|length)==0 and (.scan.unsafe_names_skipped|length)==1 and (.scan.files_considered|length)==0'
[ ! -e "$decoy_target/DECOY_RAN" ] || { echo 'FAIL: newline decoy executed' >&2; exit 1; }

# Only the allowlisted package.json shape is parsed; the script string is data, never shell input.
node_target=$(new_tmp)
printf '%s\n' '{"scripts":{"test":"touch PACKAGE_SCRIPT_RAN"},"postinstall":"touch POSTINSTALL_RAN"}' > "$node_target/package.json"
"$repo/bootstrap/recommend.sh" "$node_target" > "$node_target.recommendation.json"
[ ! -e "$node_target/PACKAGE_SCRIPT_RAN" ] && [ ! -e "$node_target/POSTINSTALL_RAN" ] || { echo 'FAIL: package manifest content executed' >&2; exit 1; }
assert_jq 'allowlisted package manifest yields argv without executing scripts' "$node_target.recommendation.json" '.recommendation.languages == ["JavaScript"] and (.recommendation.commands | map(.argv) | all(. == ["npm","test"]))'

nested_target=$(new_tmp)
mkdir -p "$nested_target/components/tool"
printf '%s\n' '{"scripts":{"test":"exit 0"}}' > "$nested_target/components/tool/package.json"
"$repo/bootstrap/recommend.sh" "$nested_target" > "$nested_target.recommendation.json"
assert_jq 'nested manifest binds actual artifact path and command cwd' "$nested_target.recommendation.json" '.recommendation.artifact.paths == ["components/tool/package.json"] and (.recommendation.commands | length)==2 and (.recommendation.commands | all(.cwd == "components/tool"))'

docs_target=$(new_tmp)
mkdir -p "$docs_target/docs" "$docs_target/tests"
printf '%s\n' '# Guide' > "$docs_target/docs/guide.md"
printf '%s\n' '#!/usr/bin/env sh' 'touch DOC_CHECK_RAN' > "$docs_target/tests/check-docs.sh"
chmod +x "$docs_target/tests/check-docs.sh"
"$repo/bootstrap/recommend.sh" "$docs_target" > "$docs_target.recommendation.json"
[ ! -e "$docs_target/DOC_CHECK_RAN" ] || { echo 'FAIL: docs checker executed during discovery' >&2; exit 1; }
assert_jq 'docs recommendation keeps validation evidence documentation-specific' "$docs_target.recommendation.json" '.recommendation.project_kind == "docs" and .recommendation.required_evidence == ["documentation","link-check"] and (.recommendation.commands | map(.argv) | all(. == ["tests/check-docs.sh"]))'

# Symlinks are reported and skipped, including manifests pointing outside the target.
outside=$(new_tmp); linked_target=$(new_tmp)
printf '%s\n' '{"scripts":{"test":"touch ESCAPED"}}' > "$outside/package.json"
ln -s "$outside/package.json" "$linked_target/package.json"
"$repo/bootstrap/recommend.sh" "$linked_target" > "$linked_target.recommendation.json"
assert_jq 'symlinked manifest is skipped, not followed' "$linked_target.recommendation.json" '(.scan.symlinks_skipped | index("package.json")) != null and (.recommendation.commands | length) == 0'
[ ! -e "$outside/ESCAPED" ] || { echo 'FAIL: symlink target content executed' >&2; exit 1; }
root_link="$linked_target-link"; ln -s "$linked_target" "$root_link"
if "$repo/bootstrap/recommend.sh" "$root_link" >/dev/null 2>&1; then echo 'FAIL: symlink root accepted' >&2; exit 1; fi
pass 'symlinked target root is rejected'

# The scan must stop considering entries at its configured bound and disclose truncation.
bounded_target=$(new_tmp)
for n in 1 2 3 4 5; do printf '%s\n' "$n" > "$bounded_target/file-$n"; done
RECOMMEND_MAX_FILES=2 "$repo/bootstrap/recommend.sh" "$bounded_target" > "$bounded_target.recommendation.json"
assert_jq 'bounded traversal discloses truncation at one-entry lookahead' "$bounded_target.recommendation.json" '.scan.max_files == 2 and .scan.truncated == true and (.scan.files_considered | length) == 2 and .scan.entries_observed == 3 and .scan.total_discovered == null'
if RECOMMEND_MAX_DEPTH=99 "$repo/bootstrap/recommend.sh" "$bounded_target" >/dev/null 2>&1; then echo 'FAIL: unbounded depth accepted' >&2; exit 1; fi
pass 'depth bound is fail-closed'

directory_budget_target=$(new_tmp)
mkdir -p "$directory_budget_target/one" "$directory_budget_target/two" "$directory_budget_target/three" "$directory_budget_target/four"
RECOMMEND_MAX_FILES=2 "$repo/bootstrap/recommend.sh" "$directory_budget_target" > "$directory_budget_target.recommendation.json"
assert_jq 'directory entries consume the same global scan budget' "$directory_budget_target.recommendation.json" '.scan.truncated == true and .scan.entries_observed == 3 and .scan.total_discovered == null and (.scan.files_considered | length) == 0'

unreadable_target=$(new_tmp)
mkdir -p "$unreadable_target/closed"
printf '%s\n' 'module invalid.example/hidden' > "$unreadable_target/closed/go.mod"
chmod 000 "$unreadable_target/closed"
if "$repo/bootstrap/recommend.sh" "$unreadable_target" >/dev/null 2>&1; then
  chmod 700 "$unreadable_target/closed"
  echo 'FAIL: inventory read error was presented as a complete recommendation' >&2
  exit 1
fi
chmod 700 "$unreadable_target/closed"
pass 'filesystem inventory errors fail closed'

# Exercise init from a committed template checkout so the pin provenance is independently testable.
template_checkout=$(new_tmp)
mkdir -p "$template_checkout/bootstrap" "$template_checkout/engine"
cp "$repo/bootstrap/init.sh" "$repo/bootstrap/recommend.sh" "$template_checkout/bootstrap/"
cp "$repo/engine/reference-engine.sh" "$template_checkout/engine/"
chmod +x "$template_checkout/bootstrap/init.sh" "$template_checkout/bootstrap/recommend.sh"
git -C "$template_checkout" init -q
git -C "$template_checkout" add bootstrap engine/reference-engine.sh
git -C "$template_checkout" -c user.name=Test -c user.email=test@example.invalid commit -qm 'test template revision'
template_head=$(git -C "$template_checkout" rev-parse HEAD)

printf '%s\n' untracked > "$template_checkout/UNTRACKED"
dirty_target=$(new_tmp)
if "$template_checkout/bootstrap/init.sh" "$dirty_target" </dev/null >/dev/null 2>&1; then echo 'FAIL: untracked template content accepted for engine pin' >&2; exit 1; fi
rm "$template_checkout/UNTRACKED"
printf '%s\n' '# dirty' >> "$template_checkout/bootstrap/recommend.sh"
if "$template_checkout/bootstrap/init.sh" "$dirty_target" </dev/null >/dev/null 2>&1; then echo 'FAIL: dirty tracked engine component accepted for engine pin' >&2; exit 1; fi
git -C "$template_checkout" checkout -q -- bootstrap/recommend.sh
pass 'engine pin rejects dirty and untracked template checkouts'

init_target=$(new_tmp)
mkdir -p "$init_target/src" "$init_target/tests"
printf '%s\n' '[project]' > "$init_target/pyproject.toml"
printf '%s\n' 'print("fixture")' > "$init_target/src/main.py"
printf '%s\n' 'def test_fixture(): assert True' > "$init_target/tests/test_fixture.py"
git -C "$init_target" init -q
git -C "$init_target" add .
git -C "$init_target" -c user.name=Target -c user.email=target@example.invalid commit -qm 'target revision'
target_head=$(git -C "$init_target" rev-parse HEAD)
[ "$target_head" != "$template_head" ] || { echo 'FAIL: test revisions unexpectedly equal' >&2; exit 1; }

{ printf '\n%.0s' {1..5}; printf 'darwin\n'; printf '\n%.0s' {1..8}; printf 'USE-RECOMMENDED\n\n\n\n\nUSE-RECOMMENDED\n\n\n\n\n["false"]\nYES\n'; } | "$template_checkout/bootstrap/init.sh" "$init_target" >/dev/null
assert_jq 'init accepts ordinary defaults but explicit inferred commands' "$init_target/.loop/candidate/project.adapter.json" '.project_kind == "cli" and (.commands | length) == 2 and (.commands | map(.argv) | all(. == ["python3","-m","pytest"]))'
assert_jq 'candidate state remains PAUSED' "$init_target/.loop/candidate/state.json" '.run_status == "PAUSED" and .phase == "DEFINE" and .step == "bootstrap-confirmation"'
grep -qx "engine_pin=$template_head" "$init_target/.loop/candidate/initialization.answers" || { echo 'FAIL: engine pin is not template HEAD' >&2; exit 1; }
grep -qx 'engine_pin_source=template-git-HEAD' "$init_target/.loop/candidate/initialization.answers" || { echo 'FAIL: engine pin provenance absent' >&2; exit 1; }
grep -Fqx 'negative_control_argv=["false"]' "$init_target/.loop/candidate/initialization.answers" || { echo 'FAIL: negative control was not preserved manually' >&2; exit 1; }
pass 'engine pin comes only from template revision and negative control remains manual'
assert_jq 'structured provenance distinguishes manual and explicit recommendation choices' "$init_target/.loop/candidate/initialization.provenance.json" '.label == "SUPERVISED_INITIALIZATION_PROVENANCE" and .run_status == "PAUSED" and .engine_pin.source == "template-git-HEAD" and .selections.platforms.source == "manual-required" and .selections.artifacts.source == "accepted-default" and .selections.required_evidence.source == "accepted-default" and .selections.commands.EXECUTE.source == "explicit-use-recommended" and .selections.negative_control.source == "manual-json"'

equal_target=$(new_tmp)
mkdir -p "$equal_target/src" "$equal_target/tests"
printf '%s\n' '[project]' > "$equal_target/pyproject.toml"
printf '%s\n' 'print(1)' > "$equal_target/src/main.py"
printf '%s\n' 'def test_x(): pass' > "$equal_target/tests/test_x.py"
{ printf '\ncli\n\n\n\ndarwin\n'; printf '\n%.0s' {1..8}; printf 'USE-RECOMMENDED\n\n\n\n\nUSE-RECOMMENDED\n\n\n\n\n["false"]\nYES\n'; } | "$template_checkout/bootstrap/init.sh" "$equal_target" >/dev/null
assert_jq 'typing the suggested value is still a manual override' "$equal_target/.loop/candidate/initialization.provenance.json" '.selections.project_kind.value == "cli" and .selections.project_kind.source == "manual-override" and .selections.languages.source == "accepted-default"'

# Enter at an inferred command prompt is never an implicit acceptance and writes nothing.
reject_target=$(new_tmp)
mkdir -p "$reject_target/src" "$reject_target/tests"
printf '%s\n' '[project]' > "$reject_target/pyproject.toml"
printf '%s\n' 'print(1)' > "$reject_target/src/main.py"
printf '%s\n' 'def test_x(): pass' > "$reject_target/tests/test_x.py"
if { printf '\n%.0s' {1..5}; printf 'darwin\n'; printf '\n%.0s' {1..12}; } | "$template_checkout/bootstrap/init.sh" "$reject_target" >/dev/null 2>&1; then echo 'FAIL: blank inferred command accepted' >&2; exit 1; fi
[ ! -e "$reject_target/.loop/candidate/project.adapter.json" ] || { echo 'FAIL: rejected init wrote candidate' >&2; exit 1; }
pass 'blank input cannot authorize inferred command argv'

printf 'Bootstrap recommendation tests passed: %s\n' "$passes"
