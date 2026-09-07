# Example: a small embedded project on an ESP32

Goal: firmware for an ESP32 board that reads a temperature sensor every
minute and sends the value over Wi-Fi to an MQTT broker. The loop must prove
that the firmware compiles for the real chip and that the logic (parsing,
averaging, retry rules) is correct, without needing a board plugged in for
every step.

This illustrative recipe uses PlatformIO with the Arduino framework and Unity
for unit tests. Confirm board identifiers, package versions, and commands for
your project; this page is not a runnable fixture.

Choose [Chat variant](#chat-variant) or [Shell variant](#shell-variant).

## Chat variant

Use this route in Codex with the build-loop skill, or in Claude Desktop with
the project-bound MCP integration. Follow the [shared chat setup](README.md#chat-variant-common-setup)
first. These are prompts to send in separate turns, not a transcript of a tested
run. The assistant performs the control calls; you do not need to paste JSON or
shell commands. The numbered shell recipe below remains available separately.

### 1. Inspect the target

```text
Inspect this firmware repository for the Universal Build Loop and check its
prerequisites. Identify the actual board, PlatformIO environments, host-testable
logic, toolchain, tests, and build output. Do not download a toolchain, compile,
flash a board, contact MQTT, or initialize the loop yet.
```

If starting from an empty folder, use the shared guide's **baseline setup**
prompt before proceeding. The loop needs passing baseline checks; inspection
and preparation do not scaffold an application or install its dependencies.

### 2. Prepare this scenario

```text
Prepare the first work item: core::Average uses a fixed-size buffer for the
last N readings (default 10), rejects a reading more than 15 degrees Celsius
from the current average, counts outliers, and returns the mean of accepted
readings. Specify empty-buffer behavior before implementation. Cover empty,
partial, full, wrap-around, and outlier cases with host-side tests. The firmware
must still compile for the confirmed board.

Use the other profile as a starting point. Allow lib/core/, src/, the actual
build output, and a dedicated new test folder. Protect platformio.ini,
partitions, dependencies, and existing test files. Do not protect all of test/
if the new test folder must be editable: show a non-overlapping path policy
before approval. A work-item allowlist cannot override a protected path.

Run compile and host tests during EXECUTE; include host behavior, firmware
artifact, and size checks during VALIDATE. No flashing, OTA updates, Wi-Fi or
MQTT changes, new libraries, or dynamic allocation in core logic. Include exact
commands, timeouts, environment names, and a known-failing host behavior probe.
Prepare a paused candidate and show the approval summary. Do not activate.
```

Confirm the board instead of assuming esp32dev. Downloading a toolchain is
separate baseline setup; compiling for a chip is not proof of on-device behavior.
Hardware-in-the-loop checks are optional and require a separately scoped human
decision for a dedicated test device. The chat recipe here never authorizes
flashing.

### 3. Approve, activate, and start

Use the shared guide's [human approval and activation flow](README.md#human-approval-and-activation).
After activation is confirmed successful, send:

```text
Start the prepared work item with a budget of 12 nodes. Generate a new
project-unique request ID for this tempnode run and show the returned job ID.
Stop on a blocker or at handover; do not create a duplicate first work item.
```

Twelve nodes is a budget, not a promise that the task will finish. Use the
shared [status and continuation prompts](README.md#status-blockers-and-handover)
if the budget ends or the conversation reconnects.

### 4. Review the result

```text
Inspect the handover evidence for host tests, target compilation, firmware
artifact, and size. Clearly distinguish host simulation from real-device
behavior. Do not flash any board, update a fleet, or change credentials.
```

Acknowledge handover only after reviewing the evidence, using the shared guide.

## Shell variant

The following commands and configuration tables are an alternative setup route
and technical reference. Do not also run the initializer after the chat flow
has already activated this target. Review version-specific commands for the
actual project; the tables do not override the approved chat proposal.

### 1. Project skeleton

```bash
mkdir tempnode && cd tempnode && git init
pip install platformio
pio project init --board esp32dev
```

Edit `platformio.ini` so there is one environment for the chip and one for
host-side tests:

```ini
[env:esp32dev]
platform = espressif32
board = esp32dev
framework = arduino
lib_deps = knolleary/PubSubClient

[env:native]
platform = native
test_framework = unity
build_flags = -std=c++17
```

Put pure logic (no hardware calls) into `lib/core/` so it can be tested on
the host: for example `lib/core/average.h` with a rolling average. Put the
board code into `src/main.cpp`. Create `test/test_core/test_average.cpp` with
one Unity test.

Run these by hand once:

```bash
pio run -e esp32dev          # compiles for the chip, needs no board
pio test -e native           # runs the unit tests on your computer
```

Commit. Add `.pio/` to `.gitignore`.

### 2. Initializer answers

| Question | Answer |
|---|---|
| Adapter id | `tempnode` |
| Project shape | `other` |
| Languages | `C++` |
| Runtime | `Arduino framework on ESP32 (espressif32 platform)` |
| Tools | `platformio, unity` |
| Platforms | `esp32dev, native-host-tests` |
| Artifact 1 | id `firmware`, kind `firmware-image`, paths `.pio/build/esp32dev/firmware.bin` |
| Protected paths | `.loop/state.json, .loop/workflow.json, .loop/project.adapter.json, .loop/evidence/**, platformio.ini, partitions.csv, test/**` |
| Environment names | `PATH, HOME, LANG, LC_ALL, TMPDIR, PLATFORMIO_CORE_DIR` |
| EXECUTE verifier | id `build`, cwd `.`, argv `["pio","run","-e","esp32dev"]`, timeout `900`, evidence `command,artifact` |
| VALIDATE verifier | id `unit`, cwd `.`, argv `["pio","test","-e","native"]`, timeout `600`, evidence `command,acceptance,behavior,artifact` |
| Required VALIDATE evidence | `acceptance,command,behavior,artifact` |
| Max wall-clock seconds | `7200` |
| Negative control | `["pio","run","-e","does-not-exist"]` |

Then edit `.loop/candidate/project.adapter.json` so that EXECUTE also runs
the host tests after every slice, and so the EXECUTE commands cover every
required evidence type:

```json
{
  "commands": [
  {"id":"build","phase":"EXECUTE","cwd":".","argv":["pio","run","-e","esp32dev"],"timeout_seconds":900,"evidence_types":["command","artifact"]},
  {"id":"unit-fast","phase":"EXECUTE","cwd":".","argv":["pio","test","-e","native"],"timeout_seconds":600,"evidence_types":["command","acceptance","behavior"]},
  {"id":"unit","phase":"VALIDATE","cwd":".","argv":["pio","test","-e","native"],"timeout_seconds":600,"evidence_types":["command","acceptance","behavior","artifact"]},
  {"id":"size","phase":"VALIDATE","cwd":".","argv":["pio","run","-e","esp32dev","-t","size"],"timeout_seconds":900,"evidence_types":["command","artifact"]}
  ]
}
```

Why these choices:

- The firmware image is the artifact. If the build breaks, the file is
  missing and the step fails even if the agent claims success.
- `test/**` is protected: the agent may add tests, but only in a new folder
  the human allows in a work item, never by editing existing ones.
- `partitions.csv` and `platformio.ini` are protected because a wrong flash
  layout can brick a board. Changing them is a human decision.
- The `size` target records flash and RAM usage in the evidence logs, so you
  can see if a change made the firmware grow.

### 3. Optional: hardware in the loop

If a board is permanently attached to the machine that runs the loop, you can
add a VALIDATE command that flashes it and runs the on-device tests:

```json
{"id":"on-device","phase":"VALIDATE","cwd":".","argv":["pio","test","-e","esp32dev","--upload-port","/dev/ttyUSB0"],"timeout_seconds":900,"evidence_types":["command","behavior"]}
```

Treat this like any external action: only for a dedicated test board, never
for a device in the field. Flashing production hardware stays a human step
after HANDOVER.

### 4. Prepare and activate

Follow the [common setup](README.md#common-setup). Review the board target,
output paths, and every PlatformIO command in the confirmation view.
The first `pio run` downloads the toolchain into `PLATFORMIO_CORE_DIR`
(default `~/.platformio`). Run it by hand once so the download does not eat
the timeout of the first loop step.

### 5. First work item

```markdown
# WI-001: Rolling average with outlier rejection

Kind: feature

## Outcome

`core::Average` keeps the last N readings (N configurable, default 10),
ignores a reading that differs from the current average by more than 15 °C
(counts it as an outlier), and returns the mean of the kept readings. The
main loop uses it before publishing. Unit tests on the host cover: empty,
fewer than N readings, exactly N, wrap-around, and outlier rejection. The
firmware still compiles for `esp32dev`.

## Acceptance criteria

## Out of scope

## Constraints and invariants

- No dynamic memory allocation in `lib/core/` (fixed-size buffer).
- No new library dependencies.
- Only `lib/core/**`, `src/**`, `test/test_core/**`, and `.pio/**` (build
  output) may change during EXECUTE.
- Wi-Fi and MQTT behavior are out of scope for this item.

## Design

## Execution slices

| Slice | Allowed paths | Frozen paths | Verifier IDs | Proof |
|---|---|---|---|---|

## Independent review

## Validation

## Handover

Handover is not authorization to merge, publish, release or deploy.
```

The `test/**` protection above takes precedence over the work item: merely
allowing `test/test_core/**` does not make it editable. Before approval, either
keep all tests frozen, or narrow protection to the existing test paths and
choose a separate editable folder for new tests in both the adapter and work
item. Never weaken protected tests during execution.

### 6. Run

From Codex or Claude Desktop, ask the connected build-loop interface to create
the work item and start a bounded job. Installing the desktop interface does not
install PlatformIO or authenticate the selected worker.

The equivalent shell path is:

```bash
./engine/orchestrator.sh start --root /path/to/tempnode
./engine/orchestrator.sh loop --root /path/to/tempnode \
  --host codex --provider hosts/codex/provider.sh \
  --review-host claude --review-provider hosts/claude/provider.sh --max-nodes 12
./engine/render-dashboard.sh --root /path/to/tempnode
```

### 7. After handover

Flashing a device, updating a fleet over the air, or changing Wi-Fi
credentials are human actions. Credentials never belong in the project;
keep them in a header that is in `.gitignore` and outside every allowed path.

### Pitfalls specific to embedded projects

- Compiling for the chip takes long the first time. Set timeouts generously
  (15 minutes is fine) and run the build once by hand before activating.
- Keep hardware-only code thin and testable logic in `lib/core/`, otherwise
  the loop can only prove "it compiles", not "it works".
- The referee compares every file before and after a step, and the build
  writes to `.pio/`. That folder must be in the allowed paths of every slice,
  and it is `.gitignore`d, so the reviewer's diff never contains it.

### Running it as a backlog, on a cadence, or with a scout

The recipe above is a [goal loop](loops/goal.md). Firmware work benefits from
the other kinds because the build is slow and the feedback is coarse.

- **Backlog.** Sensor filter, then the calibration table, then the fault
  handling. Write them down with `backlog_add`; accepting one promotes the next.
  See [the backlog walkthrough](loops/backlog.md).
- **Cadence.** A firmware build takes minutes, so a timer suits it better than
  sitting and waiting. [The cadence walkthrough](loops/cadence.md) uses this
  recipe, including what the PlatformIO toolchain needs on a `cron` `PATH`.
- **Scout.** On an embedded project a scout mostly finds **logic that only the
  hardware ever exercises**: code in `src/` that no host test in `test/` covers,
  so the loop can prove "it compiles" but not "it works". Those proposals are
  usually worth promoting. See [the scout walkthrough](loops/scout.md).

Flashing a device is never part of any loop. It stays a human action after
handover, in all four kinds.
