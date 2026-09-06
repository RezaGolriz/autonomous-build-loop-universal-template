#!/usr/bin/env bash
# Creates a tiny, already ACTIVATED Python project for trial runs of the
# orchestrator with a real provider. Trial use only: real projects go through
# bootstrap/init.sh and the activation checklist.
set -euo pipefail
die(){ echo "ERROR: $1" >&2; exit "${2:-64}"; }
target=${1:-}; [ -n "$target" ] || die 'usage: make-trial-project.sh DIR'
[ ! -e "$target" ] || die "target exists: $target"
repo=$(cd "$(dirname "$0")/.." && pwd -P)
mkdir -p "$target/src/textkit" "$target/tests" "$target/.loop/work-items" "$target/.loop/evidence"
target=$(cd "$target" && pwd -P)

cat > "$target/README.md" <<'EOF'
# textkit (trial project)

A tiny Python package used to try the universal build loop with a real agent.
Run the tests with `python3 -m unittest discover -s tests -q`.
EOF
cat > "$target/src/textkit/__init__.py" <<'EOF'
"""textkit: small text helpers."""


def word_count(text: str) -> int:
    """Return the number of whitespace-separated words in text."""
    return len(text.split())
EOF
cat > "$target/tests/test_textkit.py" <<'EOF'
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
import textkit  # noqa: E402


class WordCountTest(unittest.TestCase):
    def test_counts_words(self):
        self.assertEqual(textkit.word_count("one two  three"), 3)


if __name__ == "__main__":
    unittest.main()
EOF
printf '__pycache__/\n*.pyc\n.loop/evidence/\n.loop/*.lock/\n.loop/dashboard.html\n' > "$target/.gitignore"

jq -n '{schema_version:1,adapter_id:"textkit-trial",project_kind:"library",
  target:{languages:["Python"],runtimes:["python3"],platforms:["macos-arm64","linux-arm64"]},
  artifacts:[{id:"package",kind:"package",paths:["src/textkit/__init__.py"]}],
  commands:[
    {id:"build-check",phase:"EXECUTE",cwd:".",argv:["python3","-B","-m","unittest","discover","-s","tests","-q"],timeout_seconds:120,evidence_types:["command","behavior"]},
    {id:"test",phase:"VALIDATE",cwd:".",argv:["python3","-B","-m","unittest","discover","-s","tests","-q"],timeout_seconds:120,evidence_types:["command","behavior"]}],
  validation:{required_evidence:["command","behavior"]},
  protected_paths:[".loop/**",".gitignore"],
  environment:{allow_names:["PATH","HOME","USER","SHELL","TERM","LANG","LC_ALL","TMPDIR","CLAUDE_BIN","CODEX_BIN","PROVIDER_TIMEOUT"]}}' > "$target/.loop/project.adapter.json"
cp "$repo/core/workflow.json" "$target/.loop/workflow.json"
jq -n --arg n "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" '{schema_version:1,work_item_id:"WI-001",phase:"DEFINE",run_status:"PAUSED",step:"trial",round:0,max_rounds:20,gate_failures_here:0,max_gate_failures:3,autonomy:"supervised",started_epoch:0,max_wall_seconds:7200,
  gates:{DEFINE:{status:"PENDING",evidence_ids:[]},DESIGN:{status:"PENDING",evidence_ids:[]},EXECUTE:{status:"PENDING",evidence_ids:[]},REVIEW:{status:"PENDING",evidence_ids:[]},VALIDATE:{status:"PENDING",evidence_ids:[]},HANDOVER:{status:"PENDING",evidence_ids:[]}},
  last_result:"Trial project generated; activated for trial use only.",next_action:"orchestrator start",updated_at:$n}' > "$target/.loop/state.json"
printf '# Blockers\n\n' > "$target/.loop/blockers.md"
cat > "$target/.loop/work-items/WI-001.md" <<'EOF'
# WI-001: Add slugify() to textkit

Kind: feature

## Outcome

`textkit.slugify(text)` turns any string into a URL-friendly slug: lowercase,
words separated by single hyphens, only `a-z`, `0-9` and `-` remain, no leading
or trailing hyphen. Example: `slugify("Hello, World!  Again")` returns
`hello-world-again`. Unit tests in `tests/test_textkit.py` cover it. The
existing `word_count` keeps working.

## Acceptance criteria

## Out of scope

## Constraints and invariants

- Standard library only; no new dependencies.
- Only `src/**` and `tests/**` may change during EXECUTE.

## Design

## Execution slices

| Slice | Allowed paths | Frozen paths | Verifier IDs | Proof |
|---|---|---|---|---|

## Independent review

## Validation

## Handover

Handover is not authorization to merge, publish, release or deploy.
EOF
(cd "$target" && git init -q && git add -A && git -c user.name=Trial -c user.email=trial@example.invalid commit -qm 'trial project')
echo "$target"
