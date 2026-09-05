#!/usr/bin/env sh
set -eu
test -s docs/guide.md
grep -q '^# ' docs/guide.md
grep -q '\[Read this guide\](guide.md)' docs/guide.md
test -f docs/guide.md
