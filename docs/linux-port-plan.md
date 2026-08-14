# Linux Port Plan

Linux support is an incremental port, not a relabeling of the macOS or Windows
runtime. The first milestone (L1) makes Linux a native Rust compile, lint, and
unit-test target. It does **not** claim that capture, preview, recording,
packaging, or release are supported yet.

## Proposed support baseline

| Area | Initial proposal | L1 status |
| --- | --- | --- |
| Distribution | Ubuntu 24.04 LTS | Compile/test gate only |
| Architecture | x86_64 | CI runner architecture |
| Display session | Wayland first, X11 considered later | Unsupported |
| Screen/window capture | `xdg-desktop-portal` session backed by PipeWire | Unsupported |
| Camera and audio | PipeWire required | Unsupported |
| Preview | Linux-native surface, transport to be selected | Unsupported |
| H.264 encode | VAAPI hardware, OpenH264 software fallback | Deferred to L5 |
| Packaging | Format and signing policy to be selected | Unsupported |

Wayland capture must go through the desktop portal rather than bypassing the
user-consent boundary. PipeWire is a required part of the proposed baseline,
not an optional fallback. Exact portal, PipeWire, VAAPI, and window-system
development packages should be added only when the phase that uses them proves
the dependency is necessary.

## Licensing constraint

Videorc ships an LGPL-only FFmpeg distribution. Linux must never select or
bundle `libx264`, because that would introduce GPL requirements that are
incompatible with the product's open-core distribution model.

The intended Linux encoder decision is:

- VAAPI for hardware H.264 encoding; and
- OpenH264 for a software fallback.

That encoder is intentionally **not implemented in L1**. The production Linux
encoder selector returns a typed unsupported error before a capture session can
create state. L5 owns the implementation and its capability/fallback contract.

## Delivery phases

### L1 — Compile and CI gate

- Compile the backend natively on Ubuntu.
- Run Rust format, `cargo check`, clippy with warnings denied, and the backend
  unit suite on every pull request and push to `main`.
- Keep shared geometry and pixel conversion outside Apple-only modules.
- Return explicit unsupported results for runtime paths with no Linux backend.

The temporary Linux clippy allow list matches the documented Windows
cross-platform allow list: `dead_code`, `unused_imports`, `unused_variables`,
and `unused_mut`. Both platform gates should remove those allows together as
the shared warning wall is eliminated.

### L2 — Desktop shell and platform affordances

- Launch the Electron/backend pair on Ubuntu 24.04 x64.
- Replace macOS-specific permission, shortcut, window-chrome, and system-link
  assumptions with platform-owned behavior.
- Add a no-device lifecycle smoke without claiming media support.

### L3 — Discovery and permissions

- Discover portal/PipeWire screens, windows, cameras, and microphones behind
  the existing source contracts.
- Model portal consent, revoked sessions, missing devices, and reconnects as
  explicit states and diagnostics.
- Add deterministic discovery and permission tests.

### L4 — Capture and preview

- Implement Wayland-first screen/window capture through
  `xdg-desktop-portal` and PipeWire.
- Implement PipeWire camera/audio ingestion and a Linux-native preview
  presenter with first-frame and source-liveness contracts.
- Qualify lifecycle, source switching, detach/reattach, and backpressure on a
  real Linux desktop.

### L5 — Record, encode, and stream

- Implement the VAAPI hardware encoder path and OpenH264 software fallback.
- Preserve the shared scene geometry, BT.709/video-range color tags, bounded
  queues, A/V stop-tail, and final-artifact analysis used by shipping ports.
- Prove recording and streaming profiles on representative Intel, AMD, and
  software-fallback hosts without adding `libx264`.

### L6 — Package, release, and acceptance

- Select the package format, update channel, signing/provenance policy, and
  supported GPU/desktop matrix.
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
