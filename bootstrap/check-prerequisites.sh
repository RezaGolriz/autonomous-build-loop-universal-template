#!/usr/bin/env bash
# Read-only bootstrap preflight for the Bash+jq reference engine.
set -euo pipefail

failed=0
for tool in bash jq git shasum find awk grep perl head sort wc tr sed basename dirname; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf 'missing prerequisite: %s\n' "$tool" >&2
    failed=1
  fi
done
[ "$failed" -eq 0 ] || exit 69

case ${BASH_VERSINFO[0]:-0} in
  0|1|2) printf 'Bash 3 or newer is required.\n' >&2; exit 69 ;;
esac

printf 'reference engine prerequisites: PASS\n'
