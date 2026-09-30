# Installation — Universal Build Loop

Install from a source checkout you can access. This guide does not assume an npm release or a prebuilt download. If a maintainer supplies a built bundle, skip the build step.

Throughout this guide:

- **`/absolute/package-root`** — the Universal Build Loop checkout itself (contains `package.json`, `bin/`, `hosts/`, `docs/`, and `dist/` after building).
- **`/absolute/target`** — the project you want the loop to work on. An already-existing directory; for first use, choose a separate target or disposable demo.

The package provides the tools; `--root` and `project_root` select the project those tools operate on.

---

## 1. Prerequisites

**Control machine (where the loop runs):** macOS or Linux. Native Windows is **not supported**: the CLI and the MCP server stop at once with `PLATFORM_UNSUPPORTED`. On Windows, use WSL2 — see [Windows (WSL2)](#windows-wsl2). WSL2 support is experimental.

Required on the control machine:

- Node.js **22 or newer** and `npm` (for the one-time bundle build)
- `zip`
- `bash` **3.2 or newer**, `jq`, `git`, `perl`, and standard Unix tools (`sed`, `awk`, `grep`, `find`)

Verify:

```bash
node --version && npm --version && zip -v | head -1
bash --version | head -1 && jq --version && git --version && perl --version | head -2
```

**Choose a worker type.** An existing CLI worker needs a separate CLI install
and login. A managed API worker needs your own API key and an explicitly chosen
model; it starts no agent CLI. A mock dry run needs neither. Explicit chat
steps need a host that can delegate and a separately chosen reviewer. A Desktop
subscription does not supply API credentials or authenticate a CLI worker.

The workflow engine still needs the Unix tools above for every worker type.
Automatic native-only team supervision is not verified and refuses to start.
See [Teams](TEAMS.md) before choosing that execution policy.

---

## 2. Build the bundles (one time, from the checkout)

The package is dependency-free. No `npm install` is needed to build these bundles.

```bash
cd /absolute/package-root
npm run bundle
```

This produces:

- `/absolute/package-root/dist/codex` — the Codex plugin marketplace directory
- `/absolute/package-root/dist/build-loop.mcpb` — the Claude Desktop extension bundle

Re-run `npm run bundle` after **every** source update, then reinstall the affected bundle (Section 3 or 4). Hosts load a copy, not a live view of the checkout.

---

## 3. Install for Codex (plugin route)

```bash
codex plugin marketplace add /absolute/package-root/dist/codex
codex plugin add build-loop@build-loop-local
```

Then start a **new Codex task** whose project is `/absolute/target`. Plugins are picked up at task start; an already-running task will not see the install.

Verify the install:

```bash
codex plugin list
```

`build-loop@build-loop-local` must appear. Then, in the new task's chat, send exactly:

```
Inspect this project for Universal Build Loop; check prerequisites; show available loop kinds; do not execute target commands or initialize yet.
```

A correct install answers with an inspection summary, a prerequisite report, and the list of loop kinds — and changes nothing in the target project.

After a rebuild, refresh the installed copy:

```bash
codex plugin add build-loop@build-loop-local
```

---

## 4. Install for Claude Desktop (extension route)

The following GUI steps follow [Claude’s local MCP installation guide](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop).

In Claude Desktop:

1. Open **Settings**.
2. Go to **Extensions**.
3. Open **Advanced settings**.
4. Choose **Install Extension…**.
5. Select `/absolute/package-root/dist/build-loop.mcpb`.
6. In the extension's configuration, set **`project_root`** to `/absolute/target` — an absolute path to an existing directory.
7. For API agents, enter your keys in the optional sensitive **OpenAI API key** or **Anthropic API key** fields. Leave unused fields blank. Do not paste keys into chat or commit them. The team names `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`; the approved adapter must explicitly allow those names.
8. Restart Claude Desktop if the extension does not appear as connected.

These GUI steps follow the official Claude documentation linked above. They are documented, not independently validated in-product here; if the Desktop UI labels differ in your version, the official article is authoritative.

Claude Desktop supplies its own Node runtime for the extension, so Node is not required at runtime for this route. The control machine **still** needs `bash` 3.2+, `jq`, `git`, `perl`, and the Unix tools listed in Section 1 — the loop shells out to them.

After a rebuild, remove the extension in **Settings > Extensions** and install the newly built `dist/build-loop.mcpb` again, then re-enter `project_root`.

---

## 5. Direct MCP server (optional, separate route)

This route is an **alternative** to Sections 3 and 4, not an addition to them. Installing both the Codex plugin and an MCP entry is possible but is **never required** — pick one route per host and keep it.

For a client using `mcpServers` JSON, merge the following entry into its existing configuration without replacing other servers. In Claude Desktop, use Settings > Developer > Edit Config to open `claude_desktop_config.json`. Other clients may use another configuration format.

```json
{
  "mcpServers": {
    "build-loop": {
      "command": "/absolute/node",
      "args": [
        "/absolute/package-root/bin/build-loop-mcp.mjs",
        "--root",
        "/absolute/target"
      ]
    }
  }
}
```

Rules:

- `command` must be the **absolute path to the Node binary** (`command -v node` to find it). MCP clients frequently launch servers with a minimal `PATH`, so a bare `node` may not be found.
- `args` must use **absolute paths** for both the server script and `--root`.
- The root is **fixed at launch**. No tool call can override it. One target project per server entry; to work on a second project, add a second entry under a different name.

For Codex, the equivalent optional MCP registration is:

```bash
codex mcp add build-loop -- /absolute/node /absolute/package-root/bin/build-loop-mcp.mjs --root /absolute/target
```

---

## 6. Node CLI and original shell route

The CLI works regardless of which host route you chose, and remains supported:

```bash
node /absolute/package-root/bin/build-loop.mjs OP --root /absolute/target --json
```

Start with `inspect`, `doctor`, or `options`. Operations with arguments also require `--input /absolute/input.json`; see [the operation reference](ORCHESTRATOR.md). `dashboard` returns a local `dashboard_url`.

The original Bash interface remains supported:

```bash
cd /absolute/package-root
./bootstrap/check-prerequisites.sh
./engine/orchestrator.sh status --root /absolute/target
./engine/render-dashboard.sh --root /absolute/target
```

The last two commands require initialized state. See [the shell guide](SHELL-ORCHESTRATOR.md).

---

## 7. First run (identical in every host)

For Codex, Claude Desktop, another MCP client, or the Node CLI:

1. **`inspect`** — read the target project; no changes made.
2. **`doctor`** — verify prerequisites and worker CLI availability.
3. **`options`** — list available loop kinds and configuration choices.
4. **`prepare`** — write a paused candidate with the selected work kind, scope, verifier and negative control. No target commands run.
5. **`request-approval` / `loop_request_approval`** — return the separate `confirmation_url`. The human opens it and approves the exact proposal; the agent never follows or submits this form.
6. **`activate`** — launch approved positive and negative probes in a disposable copy. Inspect the returned job with `status`; continue only after successful activation. No Git commit is made.
7. **`start`** — request a bounded job with a unique request ID and `run_mode`.
8. **`dashboard`** — open the returned `dashboard_url` to monitor progress. It is read-only and cannot approve anything.

Do not skip `doctor`. Do not run `activate` before the browser approval.

See [LOOP-MODES.md](LOOP-MODES.md) for the loop kinds and [DASHBOARD.md](DASHBOARD.md) for the read-only monitoring UI.

---

## 8. Troubleshooting

**The host does not offer Build Loop tools / the skill is missing.**
Codex: confirm `codex plugin list` shows `build-loop@build-loop-local`, and confirm you are in a task started *after* the install. Claude Desktop: confirm the extension is listed and enabled in **Settings > Extensions**, then restart the app. In all cases, confirm `dist/` exists — if `npm run bundle` was never run, there is nothing to install.

**MCP server fails to start, or exits immediately.**
Check the connection log, runtime, arguments, and `PATH`. Replace `node` in `command` with the absolute Node path from `command -v node`, and use absolute paths in `args`. Confirm the command runs standalone:
`/absolute/node /absolute/package-root/bin/build-loop-mcp.mjs --root /absolute/target`
Also confirm the JSON is valid and the client was fully restarted.

**Wrong root: the loop reports the wrong project, or refuses to inspect.**
Check that `--root` / `project_root` is an **absolute path to an existing directory** and is `/absolute/target`, not `/absolute/package-root`. Relative paths, `~`, and symlinked shortcuts are common causes. For MCP, the root is fixed at launch — edit the config and restart the client; changing it in chat is not possible.

**Missing worker: `doctor` reports no usable worker.**
Install and authenticate the Codex CLI or Claude Code CLI yourself, then re-run `doctor`. Your Claude Desktop login is not worker credentials. Verify the worker binary is on the `PATH` of the process that launches the loop — a worker that works in your terminal may still be invisible to a GUI-launched host.

**Stale behaviour after editing the source.**
Re-run `npm run bundle` and reinstall the bundle. Hosts run the installed copy.

---

<a id="windows-wsl2"></a>

## Windows (WSL2)

**Status:** experimental. Tested on: <to be filled by the maintainer after a real WSL2 run>; until then treat Windows support as experimental.

WSL2 is a real Linux system that Microsoft builds into Windows. Build Loop runs inside it like on any Linux computer. Native Windows (PowerShell, Git Bash, MSYS) is not supported.

### Steps

1. **Install WSL2 with Ubuntu.** In PowerShell as administrator: `wsl --install`. Restart when asked, then open **Ubuntu** from the Start menu and create your Linux user.
2. **Install the tools inside WSL** (in the Ubuntu window):

   ```bash
   sudo apt update && sudo apt install -y git jq perl zip
   ```

   Then install Node 22 or newer inside WSL (for example with `nvm`, or from nodejs.org). The Windows copy of Node does not count.
3. **Clone into the Linux file system**, not onto a Windows drive:

   ```bash
   mkdir -p ~/projects && cd ~/projects
   git clone <repository-url> build-loop
   ```

   Keep your target projects there too, for example `~/projects/my-app`. Folders under `/mnt/c/...` are refused with `ROOT_ON_WINDOWS_DRIVE`: that drive type (DrvFs) does not keep the permission and link rules the loop relies on for safe locks and records, and it is slow.
4. **Check the prerequisites** from inside WSL:

   ```bash
   ~/projects/build-loop/bootstrap/check-prerequisites.sh ~/projects/my-app
   ```

   It prints `WSL2 detected` and ends with `PASS`, or names what is missing.
5. **Connect your app** (see the two setups below).
6. **Open the control page** in your Windows browser (see below).

### Setup A: Claude Desktop or Codex on Windows, loop inside WSL

The `.mcpb` extension does not install on Windows. Use the direct MCP route (Section 5) and let `wsl.exe` start the server inside WSL. Inside WSL, find the three absolute paths first:

```bash
command -v node          # e.g. /home/<user>/.nvm/versions/node/v22.x/bin/node
readlink -f ~/projects/build-loop/bin/build-loop-mcp.mjs
readlink -f ~/projects/my-app
```

Use the absolute Node path: `wsl.exe` starts the command without your shell setup, so a bare `node` is often not found. `wsl -l -v` in PowerShell shows the distribution name (here `Ubuntu`).

**Claude Desktop** (Settings > Developer > Edit Config, `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "build-loop": {
      "command": "wsl.exe",
      "args": [
        "-d",
        "Ubuntu",
        "--",
        "/home/<user>/.nvm/versions/node/v22.x/bin/node",
        "/home/<user>/projects/build-loop/bin/build-loop-mcp.mjs",
        "--root",
        "/home/<user>/projects/my-app"
      ]
    }
  }
}
```

**Codex** (in PowerShell on Windows):

```powershell
codex mcp add build-loop -- wsl.exe -d Ubuntu -- /home/<user>/.nvm/versions/node/v22.x/bin/node /home/<user>/projects/build-loop/bin/build-loop-mcp.mjs --root /home/<user>/projects/my-app
```

API keys for API workers must exist inside WSL. `wsl.exe` does not pass Windows environment variables through unless they are listed in `WSLENV`.

If the server was started on native Windows by mistake (a Windows `node` path), the app shows the `PLATFORM_UNSUPPORTED` message instead of tools.

### Setup B: everything inside WSL

Work in a WSL terminal, or in VS Code connected with **Remote - WSL**. Install and sign in to the Codex CLI or Claude Code CLI inside WSL, then follow Sections 3, 5 and 6 exactly as on Linux. This is the simplest setup.

### The control page from Windows

The control page listens on `127.0.0.1` inside WSL. WSL2 forwards local addresses to Windows, so the link opens in your Windows browser. Open it exactly as printed: the page only answers to the address in its link, so rewriting `127.0.0.1` to `localhost` gives `Invalid Host.`

**Phone access (optional).** The phone must reach Windows, and Windows must pass the port on to WSL. In `.loop/control/policy.json` set `listen` to `0.0.0.0`, `advertise` to the Windows computer's LAN address, and a fixed `port` (see [Configuration](CONFIGURATION.md)). Then, in PowerShell as administrator, forward that port to WSL (`hostname -I` inside WSL prints its address; it can change after a restart):

```powershell
netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=8765 connectaddress=<WSL-address> connectport=8765
```

You may also need a Windows firewall rule for that port. With WSL's mirrored networking mode (`networkingMode=mirrored` in `.wslconfig`) the forward is not needed. Keep the page on your private network or VPN only.

---

## Related documentation

- [Host integration notes](../hosts/README.md)
- [Loop modes](LOOP-MODES.md)
- [Dashboard](DASHBOARD.md)
- [Project overview](../README.md)
