# Linux Port Plan

Linux support is an incremental port, not a relabeling of the macOS or Windows
runtime. L1 established the native Rust gate. L1.5 adds a production-safe H.264
encoder contract, but does **not** claim that capture, preview, recording,
packaging, or release are supported yet.

## Support baseline

| Area | Alpha baseline | Current status |
| --- | --- | --- |
| Distribution | Ubuntu 24.04 LTS | Compile/test gate only |
| Architecture | x86_64 | CI runner architecture |
| Display session | Wayland first | Unsupported |
| Screen/window capture | `xdg-desktop-portal` backed by PipeWire | L4 |
| Camera | V4L2 | L3 |
| Audio | PipeWire | L2 |
| Preview | CPU composition and JPEG transport | L5 |
| H.264 encode | VAAPI hardware, OpenH264 software fallback | L1.5 implemented; hardware proof pending |
| Packaging | AppImage | L6 |

The Ubuntu 24.04 row is the packaging and support baseline that L6 must prove
on. The encoder contract in L1.5 is distribution-independent and is accepted
from any named physical Linux x64 box (see "Named tester boxes").

Wayland capture must go through the desktop portal rather than bypassing the
user-consent boundary. PipeWire is required for screen capture and audio; V4L2
owns the first camera path. Exact portal, PipeWire, VAAPI, and window-system
development packages should be added only when the phase that uses them proves
the dependency is necessary.

## Licensing and encoder constraint

Videorc ships an LGPL-only FFmpeg distribution. Linux must never select or
bundle `libx264`, because that would introduce GPL requirements incompatible
with the product's open-core distribution model.

The Linux encoder decision is:

- probe `/dev/dri/renderD*` with the exact staged FFmpeg binary and select VAAPI
  only when a real `h264_vaapi` encode succeeds; and
- use OpenH264 as a supported software fallback when automatic VAAPI probing
  fails.

`VIDEORC_LINUX_H264_ENCODER=auto|vaapi|openh264` controls the selection. `auto`
is the default. Forced `vaapi` fails session startup if the probe fails; forced
`openh264` chooses the software path directly. Automatic or explicit OpenH264
selection is logged and exposed in diagnostics without raising a health alert.

### Render-node policy on multi-GPU hosts

A VAAPI probe on the wrong GPU can hang the whole host (ogre, 2026-09-24: the
amdgpu node lost its command stack, firmware recovery failed, and the session
collapsed into an unclean reboot). The probe timeout cannot rescue a kernel
GPU hang, so the policy keeps the app from touching a bad node at all:

- `VIDEORC_LINUX_VAAPI_DEVICE=/dev/dri/renderDNNN` pins the probe to one
  node. With the pin set, `auto` and `vaapi` probe that node only; a value
  that is not an existing render node is a typed startup error.
- Before probing a node the backend writes
  `<app data>/linux-vaapi/probe-in-progress.json` (`node`, `driver`,
  `startedAt`, `ffmpegSha`) and deletes it when the probe returns, pass or
  fail. A file still present at the next backend start means the previous
  probe never returned: the node is appended to
  `<app data>/linux-vaapi/quarantined.json`, logged at `warn`, listed in
  diagnostics, and never probed again unless the pin names it explicitly.
- The backend probes once per lifetime per FFmpeg path and caches the
  decision; sessions do not re-probe. A forced `openh264` session does not
  invalidate the cached VAAPI decision.
- The probe runs the session's real encode arguments and filter chain at the
  session's resolution, not a 128x72 black clip, so a probe pass predicts a
  session pass.
- Diagnostics list every render node with its driver (the basename of
  `/sys/class/drm/<node>/device/driver`) and probe state: `probed-ok`,
  `rejected`, `quarantined`, or `skipped`.
- The driver is evidence, not policy. There is no amdgpu or other driver
  blocklist; most amdgpu boxes encode fine through VAAPI. The quarantine file
  is box-local state.

### Named tester boxes

| Box | Hardware | Distribution / session | Render nodes | Role |
| --- | --- | --- | --- | --- |
| ogre | T2 MacBook Pro, Intel UHD 630 (Coffee Lake) + Radeon Pro 555X, FaceTime HD camera | Omarchy 4.0.4 (Arch family), Hyprland / Wayland, PipeWire + `xdg-desktop-portal-hyprland` | `renderD128` i915, allowed; `renderD129` amdgpu, **quarantined** after the 2026-09-24 host hang | Named physical tester for L1.5 through L5 |

L6 still needs an Ubuntu 24.04 x64 machine for the AppImage and updater
evidence; ogre does not substitute for it.

The binary pin lives in `vendor/ffmpeg/linux-pin.json`. Run
`pnpm ffmpeg:fetch:linux` on Linux x64 to download and stage it. The fetch step
checks the SHA-256, executes the binary, and fails closed unless the build is
LGPL-only, enables VAAPI and OpenH264, disables x264/x265/fdk-aac, and exposes
both `h264_vaapi` and `libopenh264` encoders. Linux CI repeats this check.

Second ogre run (2026-09-24, on Plan 052): OpenH264 records in-app; the only
matrix gap was missing `color_primaries`/`color_transfer` in the OpenH264
bitstream, now closed by the SPS VUI rewrite. VAAPI on `renderD128` rejects
the standard argument set with "Failed to end picture encode issue: 24"
while a plain CLI encode passes. The probe therefore tries a compat set
(CBR, no B-frames, no level pin) after the standard set fails on the same
node; that compat set is provisional until the bisect on the box confirms
which argument the iHD driver rejects (Plan 053, S3).

## Delivery phases

### L1 — Compile and CI gate

- Compile the backend natively on Ubuntu.
- Run clippy with warnings denied and the backend unit suite on every pull
  request and push to `main`; the main CI workflow owns platform-independent
  Rust formatting.
- Keep shared geometry and pixel conversion outside Apple-only modules.
- Return explicit unsupported results for runtime paths with no Linux backend.

The temporary Linux clippy allow list matches the documented Windows
cross-platform allow list: `dead_code`, `unused_imports`, `unused_variables`,
and `unused_mut`. Both platform gates should remove those allows together as
the shared warning wall is eliminated.

### L1.5 — Encoder policy and provisioning

- Pin and verify the Linux x64 LGPL FFmpeg bundle.
- Select a probed VAAPI render node per session, with OpenH264 as the named
  software fallback.
- Preserve BT.709/video-range tags, profile/level, keyframe cadence, bounded
  rate control, and truthful backend diagnostics.
- Keep `libx264`, GPL, and nonfree builds out of provisioning and runtime args.

The code and CI contract are implemented. A named physical Linux machine must
still prove both the VAAPI path and the software fallback before the release
can advance.

Run the hardware-only acceptance command on a named physical Linux x64 tester
box (the distribution is recorded in the evidence, not gated). It requires a
webcam, a VAAPI render node, and explicit tester/machine labels; it fetches
the pinned FFmpeg bundle, records 1080p30 through the real dev app once per
forced backend, checks the final artifacts and diagnostics, and writes
`linux-encoder-acceptance.json` beside the recordings. On a multi-GPU box set
`VIDEORC_LINUX_VAAPI_DEVICE` first; the pin is recorded too. Run the direct
matrix command from `linux-dev-loop.md` with the software backend before the
first acceptance attempt on a new box:

```bash
VIDEORC_LINUX_TESTER_NAME="<person>" \
VIDEORC_LINUX_TESTER_MACHINE="<specific box>" \
VIDEORC_LINUX_PHYSICAL_HARDWARE=1 \
pnpm smoke:linux-encoder-acceptance
```

`--backend=openh264` or `--backend=vaapi` may be used to diagnose one path,
but only the default two-backend run emits `complete: true` evidence and clears
the L1.5 hardware gate. CI runners and virtual machines are not substitutes.

### Hardware stop before L2

Do not start L2 until a named Linux tester and a specific physical Linux x64
machine are recorded in "Named tester boxes" and the L1.5 evidence is
`complete: true`. Virtual machines and CI runners do not satisfy this gate.
Each later phase must include dated real-device evidence before the next phase
starts.

### L2 — PipeWire audio

- Discover and ingest microphone audio through PipeWire.
- Preserve mute/gain, sample format, reconnect, and explicit unavailable-state
  behavior behind the shared source contracts.
- Prove the phase with deterministic tests and a real-device audio artifact.

### L3 — V4L2 camera

- Discover and capture cameras through V4L2.
- Preserve stable source identity, format negotiation, switching, reconnect,
  and explicit unavailable-state behavior.
- Camera access depends on `video` group membership (and `render` for the
  encoder node); a missing group must surface as an explicit permission
  state with the fix named, never as a silent "no camera".
- Prove a camera-only recording on the named tester hardware.

### L4 — Portal and PipeWire screen capture

- Implement Wayland-first screen/window capture through
  `xdg-desktop-portal` and PipeWire.
- Model portal consent, cancellation, revoked sessions, missing sources, and
  reconnects as explicit states and diagnostics.
- Prove source switching and lifecycle behavior on the real Linux desktop.
- Status (Plan 0006, 2026-09-25): first cut landed. `linux_portal_capture.rs`
  (state model, restore-token store, BGRA copy, device entries; unit-tested
  on every platform), `linux_portal_session.rs` (ashpd session runner) and
  `linux_pipewire_stream.rs` (pipewire reader) feed the shared screen frame
  store; `pnpm smoke:linux-portal-capture` is the box gate. Reconnect after
  revoke is a restart with the saved token, not an in-place reconnect, and
  DMA-BUF import is not done.

### L5 — CPU composition and JPEG preview

- Reuse shared scene geometry in a Linux CPU compositor.
- Add the maintained JPEG preview transport with first-frame, liveness,
  backpressure, detach/reattach, and truthful fallback diagnostics.
- Prove composed recording and preview behavior without claiming a GPU-native
  preview surface.

### L6 — AppImage, release lane, and acceptance

- Build an Ubuntu 24.04 x64 AppImage with the verified LGPL FFmpeg payload.
- Use an isolated Linux Alpha lane with candidate, pilot, then public
  promotion; never reuse or mutate the macOS Beta or Windows Alpha manifests.
- Add packaged-app device, recording, streaming, updater, and cleanup smokes.
- Publish Linux only after dated real-device evidence meets the same explicit
  quality and lifecycle bar as the other shipping platforms.

## Reference implementation and attribution

The `linux/phase0-compile` branch of
[`ForrestKnight/videorc-linux`](https://github.com/ForrestKnight/videorc-linux)
was used as a reference for identifying platform seams, including moving the
source-mask model out of the Metal implementation. Its stale branch is not
merged or cherry-picked: changes are re-derived against current Videorc code.
Its GPL `libx264` encoder choice is explicitly rejected by this plan.
Contributor coordination and DCO confirmation are tracked in
[`#247`](https://github.com/TheOrcDev/videorc/issues/247).
