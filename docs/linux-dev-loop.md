# Linux dev loop

How to develop and verify Videorc on a Linux box. First run on real hardware
2026-09-24 (ogre: T2 MacBook Pro, Omarchy 4.0.4, Hyprland/Wayland, Intel UHD
630 plus Radeon Pro 555X).

Linux is an incremental port (`linux-port-plan.md`). L1 (compile gate) and
L1.5 (encoder policy) exist; audio, camera, portal screen capture, preview,
and packaging do not. A dev run on Linux proves the encoder bridge and the
shared session machinery, nothing more. Nothing in this document is release
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
pnpm dev   # electron-vite + cargo run of the backend (first run compiles Rust)
```

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
