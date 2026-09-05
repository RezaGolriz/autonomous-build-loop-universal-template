#!/usr/bin/env bash
# Bounded, read-only project recommendation. Target content is never executed or sourced.
set -eo pipefail

die() { printf 'ERROR: %s\n' "$1" >&2; exit "${2:-64}"; }
command -v jq >/dev/null 2>&1 || die 'jq is required' 69
target=${1:-.}
[ -d "$target" ] || die 'target directory missing'
[ ! -L "$target" ] || die 'target must not be a symlink'
target=$(cd "$target" && pwd -P)
max_files=${RECOMMEND_MAX_FILES:-256}; max_depth=${RECOMMEND_MAX_DEPTH:-4}
[[ "$max_files" =~ ^[0-9]+$ ]] && [ "$max_files" -ge 1 ] && [ "$max_files" -le 4096 ] || die 'invalid scan bound'
[[ "$max_depth" =~ ^[0-9]+$ ]] && [ "$max_depth" -ge 1 ] && [ "$max_depth" -le 12 ] || die 'invalid depth bound'

# Bash 3 with `set -u` cannot safely expand a declared-but-empty array. Keep an
# internal empty sentinel and remove it at the JSON boundary; repository-relative
# paths and recommendation labels can never legitimately be empty.
files=(''); symlinks=(''); unsafe=(''); observed=0; truncated=false
scan_inventory=$(mktemp "${TMPDIR:-/tmp}/loop-recommend-inventory.XXXXXX")
scan_status=$(mktemp "${TMPDIR:-/tmp}/loop-recommend-status.XXXXXX")
trap 'rm -f "$scan_inventory" "$scan_status"' EXIT
if ! perl - "$target" "$max_depth" "$max_files" "$scan_status" > "$scan_inventory" <<'PERL'
use strict;
use warnings;
use Fcntl qw(:mode);

my ($root, $max_depth, $max_files, $status_path) = @ARGV;
my $inspected = 0;
binmode STDOUT;

sub emit_path {
    my ($path) = @_;
    print $path, "\0" or die "cannot write bounded inventory: $!\n";
}

sub stop_at_bound {
    open(my $status, q{>}, $status_path) or die "cannot record scan truncation: $!\n";
    print {$status} "truncated\n" or die "cannot record scan truncation: $!\n";
    close($status) or die "cannot record scan truncation: $!\n";
    die "__RECOMMEND_BOUND__\n";
}

sub walk {
    my ($directory, $depth) = @_;
    opendir(my $handle, $directory) or die "cannot read directory $directory: $!\n";
    while (defined(my $name = readdir($handle))) {
        next if $name eq q{.} || $name eq q{..};
        next if $depth == 0 && ($name eq q{.git} || $name eq q{.loop});
        $inspected++;
        stop_at_bound() if $inspected > $max_files;
        my $path = "$directory/$name";
        my @stat = lstat($path);
        @stat or die "cannot inspect path $path: $!\n";
        my $mode = $stat[2];
        if (S_ISREG($mode) || S_ISLNK($mode)) {
            emit_path($path);
        } elsif (S_ISDIR($mode) && $depth + 1 < $max_depth) {
            walk($path, $depth + 1);
        }
    }
    closedir($handle) or die "cannot close directory $directory: $!\n";
}

my $ok = eval { walk($root, 0); 1 };
if (!$ok) {
    my $error = $@;
    die $error unless $error eq "__RECOMMEND_BOUND__\n";
}
PERL
then
  die 'project inventory failed; recommendations would be incomplete' 69
fi
while IFS= read -r -d '' path; do
  observed=$((observed + 1))
  if [ "$observed" -gt "$max_files" ]; then truncated=true; break; fi
  rel=${path#"$target"/}
  case "$rel" in *[$'\001'-$'\037'$'\177']*) unsafe+=("$rel"); continue;; esac
  if [ -L "$path" ]; then symlinks+=("$rel"); else files+=("$rel"); fi
done < "$scan_inventory"
if [ -s "$scan_status" ]; then
  truncated=true
  observed=$((max_files + 1))
fi

array_json() { jq -cn '$ARGS.positional | map(select(length > 0))' --args -- "$@"; }
find_basename() { local wanted=$1 item; MATCH=; for item in "${files[@]}"; do [ "${item##*/}" = "$wanted" ] && { MATCH=$item; return 0; }; done; return 1; }
has_under() { local prefix=$1 item; for item in "${files[@]}"; do case "$item" in "$prefix"/*) return 0;; esac; done; return 1; }
first_under() { local prefix=$1 item; MATCH=; for item in "${files[@]}"; do case "$item" in "$prefix"/*) MATCH=$item; return 0;; esac; done; return 1; }
dirname_rel() { case "$1" in */*) printf '%s' "${1%/*}";; *) printf '.';; esac; }
join_rel() { [ "$1" = . ] && printf '%s' "$2" || printf '%s/%s' "$1" "$2"; }

kind=other; languages=(''); runtimes=(''); tools=(''); commands='[]'; artifact='null'; confidence=low; manifest=; project_root=.
add_commands() { local argv=$1 cwd=$2; commands=$(jq -cn --arg cwd "$cwd" --argjson argv "$argv" '[{id:"verify-execute",phase:"EXECUTE",cwd:$cwd,argv:$argv,timeout_seconds:900},{id:"verify-validate",phase:"VALIDATE",cwd:$cwd,argv:$argv,timeout_seconds:900}]'); }
set_artifact() { artifact=$(jq -cn --arg path "$1" --arg kind "$2" '{id:"primary-artifact",kind:$kind,paths:[$path]}'); }

if find_basename pyproject.toml || find_basename requirements.txt; then
  manifest=$MATCH; project_root=$(dirname_rel "$manifest"); languages=(Python); runtimes=(python3); tools=(python3); confidence=medium
  find_basename uv.lock && [ "$(dirname_rel "$MATCH")" = "$project_root" ] && tools=(uv) || :
  tests_prefix=$(join_rel "$project_root" tests); has_under "$tests_prefix" && add_commands '["python3","-m","pytest"]' "$project_root" || :
  main_path=$(join_rel "$project_root" src/main.py); if [ -f "$target/$main_path" ] && [ ! -L "$target/$main_path" ]; then kind=cli; set_artifact "$main_path" project-file; else set_artifact "$manifest" manifest; fi
elif find_basename go.mod; then manifest=$MATCH; project_root=$(dirname_rel "$manifest"); languages=(Go); runtimes=(go); tools=(go); add_commands '["go","test","./..."]' "$project_root"; set_artifact "$manifest" manifest; confidence=high
elif find_basename Cargo.toml; then manifest=$MATCH; project_root=$(dirname_rel "$manifest"); languages=(Rust); runtimes=(cargo); tools=(cargo); add_commands '["cargo","test"]' "$project_root"; set_artifact "$manifest" manifest; confidence=high
elif find_basename pom.xml; then manifest=$MATCH; project_root=$(dirname_rel "$manifest"); languages=(Java); runtimes=(JVM); tools=(mvn); add_commands '["mvn","test"]' "$project_root"; set_artifact "$manifest" manifest; confidence=high
elif find_basename package.json; then
  manifest=$MATCH; project_root=$(dirname_rel "$manifest"); languages=(JavaScript); runtimes=(node); tools=(npm); set_artifact "$manifest" manifest; confidence=medium; manifest_abs="$target/$manifest"
  if [ -f "$manifest_abs" ] && [ ! -L "$manifest_abs" ] && [ "$(wc -c < "$manifest_abs")" -le 1048576 ] && jq -e 'type=="object" and (.scripts|type=="object") and (.scripts.test|type=="string")' "$manifest_abs" >/dev/null 2>&1; then add_commands '["npm","test"]' "$project_root"; fi
elif find_basename check-docs.sh; then
  checker=$MATCH
  case "$checker" in tests/check-docs.sh) project_root=.;; */tests/check-docs.sh) project_root=${checker%/tests/check-docs.sh};; *) project_root=__none__;; esac
  docs_prefix=$(join_rel "$project_root" docs)
  if [ "$project_root" != __none__ ] && first_under "$docs_prefix"; then kind=docs; languages=(); runtimes=(sh); tools=(sh); add_commands '["tests/check-docs.sh"]' "$project_root"; set_artifact "$MATCH" document; confidence=high; fi
fi

case "$kind" in docs) evidence='["documentation","link-check"]';; cli) evidence='["acceptance","command","behavior","installation"]';; *) evidence='["acceptance","command","artifact"]';; esac
protected='[".loop/**"]'; [ -n "$manifest" ] && protected=$(jq -cn --arg manifest "$manifest" '[".loop/**",$manifest] | unique')
files_json=$(if [ "${#files[@]}" -eq 0 ]; then printf '[]'; else array_json "${files[@]}"; fi)
links_json=$(if [ "${#symlinks[@]}" -eq 0 ]; then printf '[]'; else array_json "${symlinks[@]}"; fi)
unsafe_json=$(if [ "${#unsafe[@]}" -eq 0 ]; then printf '[]'; else array_json "${unsafe[@]}"; fi)
langs=$(if [ "${#languages[@]}" -eq 0 ]; then printf '[]'; else array_json "${languages[@]}"; fi)
runs=$(if [ "${#runtimes[@]}" -eq 0 ]; then printf '[]'; else array_json "${runtimes[@]}"; fi)
tool_json=$(if [ "${#tools[@]}" -eq 0 ]; then printf '[]'; else array_json "${tools[@]}"; fi)
jq -n --arg kind "$kind" --arg confidence "$confidence" --argjson files "$files_json" --argjson links "$links_json" --argjson unsafe "$unsafe_json" --argjson observed "$observed" --argjson max "$max_files" --argjson depth "$max_depth" --argjson truncated "$truncated" --argjson languages "$langs" --argjson runtimes "$runs" --argjson tools "$tool_json" --argjson commands "$commands" --argjson evidence "$evidence" --argjson protected "$protected" --argjson artifact "$artifact" '{schema_version:1,label:"RECOMMENDATION_ONLY",scan:{read_only:true,nul_safe:true,max_files:$max,max_depth:$depth,entries_observed:$observed,total_discovered:(if $truncated then null else $observed end),files_considered:$files,symlinks_skipped:$links,unsafe_names_skipped:$unsafe,truncated:$truncated},recommendation:{project_kind:$kind,languages:$languages,runtimes:$runtimes,tools:$tools,platforms:[],platform_note:"manual unless repository evidence explicitly declares support",environment_names:["PATH","LANG","LC_ALL","TMPDIR"],artifact:$artifact,protected_paths:$protected,commands:$commands,required_evidence:$evidence,max_wall_seconds:1800},evidence:{basis:"NUL-safe filenames and allowlisted package.json fields only",confidence:$confidence},acceptance:{ordinary_defaults:"Enter",inferred_command_argv:"USE-RECOMMENDED or manual JSON",unknown_artifact:"manual id, kind, and path",negative_control:"manual JSON only"}}'
