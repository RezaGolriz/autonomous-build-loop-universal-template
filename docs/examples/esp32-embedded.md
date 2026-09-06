# Example: a small embedded project on an ESP32

Goal: firmware for an ESP32 board that reads a temperature sensor every
minute and sends the value over Wi-Fi to an MQTT broker. The loop must prove
that the firmware compiles for the real chip and that the logic (parsing,
averaging, retry rules) is correct, without needing a board plugged in for
every step.

This example uses PlatformIO with the Arduino framework and Unity for unit
tests. ESP-IDF works the same way; only the commands change.

## 1. Project skeleton

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

## 2. Initializer answers

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
"commands": [
  {"id":"build","phase":"EXECUTE","cwd":".","argv":["pio","run","-e","esp32dev"],"timeout_seconds":900,"evidence_types":["command","artifact"]},
  {"id":"unit-fast","phase":"EXECUTE","cwd":".","argv":["pio","test","-e","native"],"timeout_seconds":600,"evidence_types":["command","acceptance","behavior"]},
  {"id":"unit","phase":"VALIDATE","cwd":".","argv":["pio","test","-e","native"],"timeout_seconds":600,"evidence_types":["command","acceptance","behavior","artifact"]},
  {"id":"size","phase":"VALIDATE","cwd":".","argv":["pio","run","-e","esp32dev","-t","size"],"timeout_seconds":900,"evidence_types":["command","artifact"]}
]
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

## 3. Optional: hardware in the loop

If a board is permanently attached to the machine that runs the loop, you can
add a VALIDATE command that flashes it and runs the on-device tests:

```json
{"id":"on-device","phase":"VALIDATE","cwd":".","argv":["pio","test","-e","esp32dev","--upload-port","/dev/ttyUSB0"],"timeout_seconds":900,"evidence_types":["command","behavior"]}
```

Treat this like any external action: only for a dedicated test board, never
for a device in the field. Flashing production hardware stays a human step
after HANDOVER.

## 4. Activate

Follow the common steps in [README.md](README.md#the-seven-steps-every-example-follows).
The first `pio run` downloads the toolchain into `PLATFORMIO_CORE_DIR`
(default `~/.platformio`). Run it by hand once so the download does not eat
the timeout of the first loop step.

## 5. First work item

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

Because `test/**` is protected in the adapter, the work item explicitly allows
`test/test_core/**`; the agent may only write tests there. If you want the
agent never to touch tests, leave it out.

## 6. Run

```bash
./engine/orchestrator.sh start --root /path/to/tempnode
./engine/orchestrator.sh loop --root /path/to/tempnode \
  --host codex --provider hosts/codex/provider.sh \
  --review-host claude --review-provider hosts/claude/provider.sh --max-nodes 12
./engine/render-dashboard.sh --root /path/to/tempnode
```

## 7. After handover

Flashing a device, updating a fleet over the air, or changing Wi-Fi
credentials are human actions. Credentials never belong in the project;
keep them in a header that is in `.gitignore` and outside every allowed path.

## Pitfalls specific to embedded projects

- Compiling for the chip takes long the first time. Set timeouts generously
  (15 minutes is fine) and run the build once by hand before activating.
- Keep hardware-only code thin and testable logic in `lib/core/`, otherwise
  the loop can only prove "it compiles", not "it works".
- The referee compares every file before and after a step, and the build
  writes to `.pio/`. That folder must be in the allowed paths of every slice,
  and it is `.gitignore`d, so the reviewer's diff never contains it.
