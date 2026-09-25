# Linux dev loop

How to develop and verify Videorc on a Linux box. First run on real hardware
2026-09-24 (ogre: T2 MacBook Pro, Omarchy 4.0.4, Hyprland/Wayland, Intel UHD
630 plus Radeon Pro 555X).

Linux is an incremental port (`linux-port-plan.md`). L1 through L6 packaging
exist as engineering paths. A private Linux Alpha candidate can be stored
from protected `main`; nothing in this document is public release
authorization.

## One-time setup

Prerequisites: Node 24.x (mise or nvm both work; `.node-version` names the
version CI uses), Rust stable via rustup, git, and a distribution with
PipeWire and `xdg-desktop-portal` plus its compositor backend
(`xdg-desktop-portal-hyprland`, `-gnome`, or `-kde`) running in the user
session. Corepack installs the repository's pinned pnpm 11.

```bash
corepack enable
corepack install
pnpm install
pnpm ffmpeg:fetch:linux   # pinned LGPL FFmpeg -> vendor/ffmpeg/linux-x64
```

The fetch step verifies the SHA-256, executes the binary, and fails closed
unless the build is LGPL-only with VAAPI and OpenH264 and without x264, x265,
or fdk-aac. Dev mode wires the vendored `ffmpeg`/`ffprobe` in automatically
(`resolvePackagedFfmpegBinDir` in `apps/desktop/src/main/index.ts`).

### Device access

Camera and render nodes are group-owned. The user must be in both groups, then
log out and back in:

```bash
sudo usermod -aG video,render "$USER"
```

If a camera still refuses to open before the next login, a temporary ACL is
the fallback (it does not survive a device re-plug; group membership is the
real fix):

```bash
sudo setfacl -m "u:$USER:rw" /dev/video0
```

Check that the portal and PipeWire are live before expecting any capture
path to work later:

```bash
systemctl --user status pipewire xdg-desktop-portal
```

## Safe GPU environment

On a multi-GPU host, pin VAAPI to one render node before the first launch.
Whichever node you pin is the only one the app probes; every other node is
listed in diagnostics as `skipped`. On ogre the Intel node is safe and the
AMD node hangs the whole host on VAAPI encode, so the pin is not optional
there:

```bash
export LIBVA_DRIVER_NAME=iHD
export LIBVA_DRIVERS_PATH=/usr/lib/dri
export LIBVA_DEVICE=/dev/dri/renderD128
export VIDEORC_LINUX_VAAPI_DEVICE=/dev/dri/renderD128
# Safe default while diagnosing the bridge: the software encoder only.
export VIDEORC_LINUX_H264_ENCODER=openh264
```

`VIDEORC_LINUX_H264_ENCODER=auto|vaapi|openh264` picks the encoder; `auto` is
the default. Find the driver behind each node with
`readlink /sys/class/drm/renderD128/device/driver` (i915, xe, amdgpu, …).

The backend remembers a probe that never returned. Before it probes a node it
writes `linux-vaapi/probe-in-progress.json` under the app data directory; if
that file is still there at the next start, the node moves to
`linux-vaapi/quarantined.json` and is never probed again unless
`VIDEORC_LINUX_VAAPI_DEVICE` names it explicitly. After a host hang, plant
the quarantine entry by hand before the next launch rather than letting the
app discover it a second time.

## Run the app

```bash
cargo build -p videorc-backend   # after every pull, before any smoke
pnpm dev   # electron-vite + cargo run of the backend (first run compiles Rust)
```

`pnpm dev` runs `cargo run --quiet`, which prints nothing while the debug
backend recompiles (5-7 min on ogre), so an in-app smoke launched on a stale
build used to time out at 90 s with misleading "GPU process launch failed"
noise from the SIGTERMed Electron. The smoke launcher now runs
`cargo build -p videorc-backend` itself before starting the launch clock
(bounded by `VIDEORC_SMOKE_PREBUILD_TIMEOUT_MS`, default 20 min; opt out
with `VIDEORC_SMOKE_SKIP_PREBUILD=1`) and prints `[smoke:prebuild] …`
lines; a timeout says "Backend still compiling" instead of GPU noise.

Make sure `WAYLAND_DISPLAY`, `DISPLAY`, and `DBUS_SESSION_BUS_ADDRESS` are set
when launching from a service or over SSH: `systemctl --user
show-environment` prints the session's values.

### Where things are

- App data (owned-process ledger, `linux-vaapi/` probe files, settings):
  `$XDG_CONFIG_HOME/Videorc` (Electron's `appData` on Linux, usually
  `~/.config/Videorc`), or `VIDEORC_APP_DATA_DIR` when set.
- Backend and Electron logs: the terminal that runs `pnpm dev`. The ogre
  launcher (`~/.local/bin/videorc-dev`) tees them to
  `$XDG_RUNTIME_DIR/videorc-dev/pnpm-dev.log`.
- Recordings: the Library folder the app reports in Settings.

### One dev instance at a time

A running dev app and any smoke that launches the app share the global
owned-process ledger, so the second launch reaps the first backend. Stop the
dev app before running `pnpm smoke:backend-single-instance` or any
`smoke:*` command, or isolate the smoke with `VIDEORC_APP_DATA_DIR` and
`VIDEORC_USER_DATA_DIR` pointing at scratch directories.

## Release backend for pacing evidence

`pnpm dev` runs a DEBUG backend, and its pacing numbers (encoder bridge
input fps, CPU RGB→YUV conversion, repeated frames) are not evidence of the
shipped binary. Set `VIDEORC_DEV_BACKEND_PROFILE=release` to make `pnpm dev`
(and every smoke that launches it, including the launcher's prebuild) run
`cargo run --release` from `target/release`. Use it for any OpenH264 pacing
claim (Plan 0005); keep the debug default for everything else.

## Portal screen capture (L4)

Screen and window capture on Linux go through `org.freedesktop.portal.ScreenCast`
and PipeWire (Plan 0006). The device list carries exactly two entries,
`screen:portal:monitor` and `window:portal:window`; the compositor's own
picker chooses the real source on the first start, and the backend keeps the
portal restore token beside the database (`linux-portal/restore-tokens.json`)
so later starts are silent. A refused token drops back to the picker once.
The named states reach the renderer as the usual `preview.screen.status`:
`starting` while the picker is up, `live` (message names the portal and
PipeWire), `permission-needed` when the picker was cancelled,
`source-missing` when the compositor revoked the share or no portal backend
is reachable, with the fix named in the message.

```bash
pnpm smoke:linux-portal-capture   # first run: click Share in the picker
VIDEORC_PORTAL_EXPECT=any pnpm smoke:linux-portal-capture   # unattended: a truthful refusal passes
```

Frames are memcpy'd BGRA into the shared screen frame store; DMA-BUF import
is a follow-up. Hyprland needs `xdg-desktop-portal-hyprland`; GNOME and KDE
use their own portal backends.

## Preview (L5)

Linux has no native preview surface by design. The Preview window shows the
Electron proof surface (`electron-proof-surface` / `electron-browser-window`,
the same uncompressed latest-wins BMP presenter Windows ships as its
fallback), fed by the CPU compositor and the portal screen store. Status,
supervisor and health copy say "Linux CPU preview" and never claim
`native-surface` or a CAMetalLayer. Gate:

```bash
pnpm probe:preview-lifecycle:linux   # VIDEORC_EXPECT_LINUX_PROOF=1, asserts proof surface live, polling on, no native claim
```

Phase D (portal pixels on the proof surface): after a granted
`screen:portal:monitor` stream, apply ScreenOnly and confirm the Electron
BMP window is no longer synthetic.

```bash
pnpm smoke:portal-preview-proof   # first run: click Share in the picker
VIDEORC_PORTAL_EXPECT=any pnpm smoke:portal-preview-proof   # unattended: a truthful refusal passes
```

Success looks like `compositorState=live`, `sourcePixelsPresent=true`, and
`surfaceSource` of `screen` (never `synthetic`). Portal IDs stay non-native
(`isNative*` false); the proof path must remain `electron-proof-surface`.
Do not enable AMD VAAPI / renderD129 for this smoke.

## Packaged run (L6 / Plan 0008)

`pnpm package:desktop:linux` builds an unsigned x64 AppImage after `package:backend`, `ffmpeg:fetch:linux`, and `scripts/preflight-linux-package.mjs`. Ubuntu 24.04 remains the named packaging box; ogre can produce the artifact for smoke. Dispatch `release-linux-alpha.yml` from protected `main` to store a private candidate. Public updater promotion and the videorc-web download button are still owed.

## Verify gates that work on Linux

Cheap, no Electron (run these first):

```bash
pnpm typecheck
pnpm test:scripts
pnpm --filter @videorc/desktop test
cargo test -p videorc-backend
cargo clippy -p videorc-backend -- -D warnings
```

In-app encoder bridge, one backend at a time, without the acceptance host
gate. This is the first thing to run on a new box, software encoder first:

```bash
VIDEORC_LINUX_H264_ENCODER=openh264 \
VIDEORC_MATRIX_ONLY=1080p30 \
VIDEORC_MATRIX_PRINT_BRIDGE_DIAGNOSTICS=1 \
VIDEORC_SMOKE_FFMPEG_PATH=$PWD/vendor/ffmpeg/linux-x64/bin/ffmpeg \
node scripts/smoke-recording-matrix-app.mjs
```

Repeat with `VIDEORC_LINUX_H264_ENCODER=vaapi` and the device pin from above.
The printed bridge diagnostics carry the selected backend, the render node
list with drivers and probe states, and the FFmpeg stderr tail. A "Broken
pipe" on the raw video writer is the stop ladder killing FFmpeg after the
output progress timeout; the verdict is the stderr line before it.

Named-box L1.5 acceptance (both backends, writes
`linux-encoder-acceptance.json` next to the recordings):

```bash
VIDEORC_LINUX_TESTER_NAME="<person>" \
VIDEORC_LINUX_TESTER_MACHINE="<specific box>" \
VIDEORC_LINUX_PHYSICAL_HARDWARE=1 \
pnpm smoke:linux-encoder-acceptance
```

Any named physical Linux x64 box qualifies. The evidence records the
distribution, kernel, render nodes with their drivers, and the VAAPI pin.
Virtual machines and CI runners still do not count.

## Never do this

- Never run an encode probe, by hand or through the app, against a node the
  app has quarantined or that a previous run has shown to hang.
- Never run encode probes in parallel. One FFmpeg encode at a time on a box
  whose GPU behaviour is not yet known.
- Never run FFmpeg VAAPI by hand against a render node without the same
  device pin the app uses. A manual probe on the wrong node hung ogre for
  the whole session and forced an unclean reboot (2026-09-24).
- Do not treat a passing 128x72 probe as proof that a 1080p session works.
  The app probes with the session's real encode arguments for that reason.

## Colour tags on a recorded artifact

The matrix and the L1.5 acceptance require BT.709 video-range tags in the
H.264 stream itself. Check an artifact with:

```bash
ffprobe -v error -select_streams v:0 \
  -show_entries stream=color_space,color_primaries,color_transfer,color_range \
  -of default=nw=1 <file>
```

All four must read `bt709` / `bt709` / `bt709` / `tv`. Both Linux arms
stamp the raw frames with `setparams` before encoding AND rewrite the SPS
afterwards (`h264_metadata` bitstream filter): libopenh264 writes no VUI on
its own (Plan 053), and `h264_vaapi` on the bundled FFmpeg builds the VUI
from the frame properties and drops the context colour options for
primaries/transfer (ogre, Plan 0002). The VAAPI probe runs the same
stamped filter chain.

## The VAAPI probe command

Every VAAPI probe logs its exact FFmpeg command line at `info`
("VAAPI probe on renderD128 (standard profile): …"); the recording matrix
smoke forwards those lines to its own log unconditionally, and with
`VIDEORC_MATRIX_PRINT_BRIDGE_DIAGNOSTICS=1` its printed diagnostics line
carries `linuxVaapiArgProfile`, `linuxRenderNodes` and any named fallback
reason. The backend tries the
standard argument set first and, only if the same node rejects it, a compat
set (constant bitrate, no B-frames) as defence in depth. Both sets pin the
level in `h264_vaapi`'s own spelling (`-level 4`, not `-level 4.0`).

Finding from the ogre bisect (Plan 0001, 2026-09-24): Intel iHD's
"Failed to end picture encode issue: 24" was the `-level 4.0` spelling.
`h264_vaapi`'s `-level` is an integer option whose named constants are
`4`, `4.1`, `4.2`, `5`, … so `4.0` parses as `level_idc = 4`, an illegal
level the driver rejects at end-of-picture. Rate control and B-frames were
never the cause. Expect `linuxVaapiArgProfile: "standard"` in the bridge
diagnostics on a healthy node; a `compat` selection now means a real driver
rejection worth a bisect: copy the logged standard command and remove one
item at a time (`-rc_mode VBR` → `CBR`, add `-bf 0`, drop
`-flags +global_header`, drop `-force_key_frames`, 1080p → 720p) and record
the first passing set and every failing stderr in the test report.

`pnpm smoke:backend-single-instance` asserts the "after reaping … :<pid>"
log line; run it with no other dev instance sharing the app-data directory.
