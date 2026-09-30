#!/usr/bin/env bash
# Read-only bootstrap preflight for the Bash+jq reference engine.
# Usage: check-prerequisites.sh [PROJECT_ROOT]   (default: the current folder)
set -euo pipefail

package_root=$(cd "$(dirname "$0")/.." && pwd -P)
project_root=${1:-$PWD}

failed=0
for tool in bash jq git shasum find awk grep perl head sort wc tr sed basename dirname; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf 'missing prerequisite: %s\n' "$tool" >&2
    failed=1
  fi
done
if [ "$failed" -ne 0 ]; then
  if grep -qi microsoft /proc/version 2>/dev/null || [ -n "${WSL_DISTRO_NAME:-}" ]; then
    printf 'WSL2 detected: install the missing tools inside WSL, for example: sudo apt install jq perl git\n' >&2
  fi
  exit 69
fi

case ${BASH_VERSINFO[0]:-0} in
  0|1|2) printf 'Bash 3 or newer is required.\n' >&2; exit 69 ;;
esac

# Platform: native Windows is refused; under WSL2 neither this package nor the
# project may sit on a Windows drive (/mnt/c/...). The rule lives in one place,
# control/platform.mjs, shared with the CLI and the MCP server.
if command -v node >/dev/null 2>&1; then
  node "$package_root/control/platform.mjs" check "$package_root" "$project_root" || exit 69
elif grep -qi microsoft /proc/version 2>/dev/null || [ -n "${WSL_DISTRO_NAME:-}" ]; then
  printf 'WSL2 detected, but node is missing: install Node 22 inside WSL (see docs/INSTALLATION.md#windows-wsl2).\n' >&2
  exit 69
fi

printf 'reference engine prerequisites: PASS\n'
