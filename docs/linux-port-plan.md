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

The binary pin lives in `vendor/ffmpeg/linux-pin.json`. Run
`pnpm ffmpeg:fetch:linux` on Linux x64 to download and stage it. The fetch step
checks the SHA-256, executes the binary, and fails closed unless the build is
LGPL-only, enables VAAPI and OpenH264, disables x264/x265/fdk-aac, and exposes
both `h264_vaapi` and `libopenh264` encoders. Linux CI repeats this check.

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

The code and CI contract are implemented. A real Ubuntu machine must still
prove both the VAAPI path and the software fallback before the release can
advance.

### Hardware stop before L2

Do not start L2 until a named Linux tester and a specific Ubuntu 24.04 x64
machine are recorded. Virtual machines and CI runners do not satisfy this gate.
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
- Prove a camera-only recording on the named Ubuntu hardware.

### L4 — Portal and PipeWire screen capture

- Implement Wayland-first screen/window capture through
  `xdg-desktop-portal` and PipeWire.
- Model portal consent, cancellation, revoked sessions, missing sources, and
  reconnects as explicit states and diagnostics.
- Prove source switching and lifecycle behavior on the real Linux desktop.

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
