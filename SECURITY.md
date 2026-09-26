# Security and privacy

The build loop captures checks and rejects unauthorized file changes. It is not
an operating-system sandbox. A worker, verifier, or user with unrestricted local
permissions can access resources outside the project. Use a restricted account,
container, or host sandbox when running code you do not trust.

## Trust boundaries

- The engine owns evidence and workflow transitions. Skills and MCP transport do
  not certify success.
- The MCP server controls one folder selected in host configuration. It exposes
  named operations, not a general shell tool.
- Discovery reads project metadata. It does not run package scripts or install
  dependencies.
- Setup approval must come from a human using the runner's local review view or
  an interactive terminal. Agents must never submit that view on the user's
  behalf. A model-supplied boolean is not approval.
- A local confirmation page does not provide protection from a compromised OS
  account or an unrestricted agent controlling the same browser. It is served on
  loopback, so an agent with shell access on the same machine could in principle
  open the link and type the confirmation word; the recorded assurance is
  `local-user-action` and nothing stronger. When `confirmation_page` in that
  policy file makes the page listen on a private network or VPN address, anyone
  who can reach that address and has the link can act on it; the page is plain
  HTTP and must never be exposed on a public interface. The agent host must enforce the
  human-interaction boundary. A project that needs a hard guarantee sets
  `human_confirmation` to `tty-only` in `.loop/control/policy.json`, written by
  hand; accept, authorize and promote are then refused from every transport
  except a word typed at an interactive terminal.
- Probes use a disposable copy, but this alone does not prevent network access
  or writes outside that copy. Review the commands and use host isolation.
- Independent review requires a fresh restricted context. A second vendor is
  optional; a separate review context is mandatory.

## Data handling

The control service does not send telemetry. A configured Claude or Codex worker
may send project content to its model provider under that provider's settings.
Local execution does not mean model processing is offline.

Keep credentials out of project JSON, prompts, work items, and command arguments.
Machine-local provider settings and runtime output must not be committed. Logs
can contain project content even when no credential was intentionally passed.
Inspect files before sharing a dashboard, diff, evidence folder, or archive.

The public audit script reports locations and categories without printing matched
values. Its results are heuristic. A clean pattern scan is not proof that every
secret or personal detail is absent. Audit both the tree and reachable history;
review remote refs, forks, caches, and LFS objects separately when applicable.

## Reporting a problem

Do not put live secrets or private project data in a public issue. Use the
repository host's private vulnerability reporting if enabled, or contact the
maintainer privately. Rotate exposed credentials before attempting Git cleanup.
Never rewrite shared history without the owner's approval and a private backup.

## Local approval trust

Approval receipts are authenticated with a per-user key stored outside the
project in `~/.local/state/universal-build-loop/approval-key`. The directory is
private (0700) and the key is private (0600). A receipt copied into a repository
cannot authorize activation on another host or under another project root.
The signature binds the root, setup digest, decision, channel, and approval ID.

`BUILD_LOOP_APPROVAL_STORE` may select another private directory in trusted host
launch configuration. It must be outside the controlled project. Never include
this directory or key in a project archive, backup intended for sharing, or
prompt. Losing the key requires fresh human approval. This protects against
planted repository receipts; it does not protect against an attacker already
running as the same operating-system user.

Host configuration uses the same host key with a separate signature domain.
`doctor` rejects planted or changed configuration before running built-in login
status checks. Custom authentication commands are not executed. Standard CLI
status checks may update the CLI's local cache; `doctor` is not a pure file read.

Managed pause and cancel requests use a private per-user runtime directory
outside the project, with job-specific fencing. They do not signal a process
based only on a stored PID. An orphaned active lock requires explicit recovery;
the runner does not guess that an old process has stopped.

Preparation and host configuration create `.loop/.gitignore` when it is absent
to exclude machine-local settings, control records, candidates, evidence, locks,
quarantine records, snapshots, and dashboards. Existing ignore policy is kept.
Canonical adapters, work items, blockers, and state may still be versioned;
review their contents before sharing a target repository.

Setup probes exclude Git and loop-control directories. Relative symlinks are
preserved only when they resolve within the copied project inputs. Absolute or
escaping links are rejected. Other project files, including local dependencies
and untracked files, are part of the approved copy; review them for secrets.
Large dependency directories increase preparation and copying time. This copy
policy is not a credential or operating-system sandbox.
