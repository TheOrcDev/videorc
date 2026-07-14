# ADR 0001: OBS-Parity Native Capture Architecture

Status: Accepted

Date: 2026-05-31

## Context

Videorc began as an Electron, React, Rust, and FFmpeg technical spike. The spike proved the product shape, but the capture path is now carrying too much responsibility through FFmpeg:

- microphone capture has shown scrambled, choppy, and cutoff speech failure modes,
- preview can feel late,
- screen, camera, composition, preview, recording, and muxing are coupled through large FFmpeg commands,
- the UI needs OBS-style source, mixer, transform, recording, and diagnostics behavior.

OBS Studio is the behavior reference for the next architecture pass. OBS already separates source capture, scene rendering, preview, encoding, muxing, and stats. Videorc should follow those architectural boundaries while remaining an independent implementation.

## Decision

Videorc will build an independent OBS-inspired capture architecture for v1.

We will not embed, link, vendor, or copy OBS Studio GPL source code into Videorc unless the product deliberately adopts a GPL-compatible licensing path later.

OBS source files may be used as behavioral and architectural references only:

- understand how OBS models source capture,
- understand timing, device, preview, recording, and diagnostics semantics,
- write new Videorc code independently in this repository.

The implementation direction is:

- Rust remains the backend coordinator and primary implementation language.
- Use maintained Rust/macOS crates first.
- Add tiny Objective-C FFI only when required macOS APIs or timing behavior are blocked from Rust.
- Native capture sources replace FFmpeg as the primary capture path:
  - CoreAudio for microphones,
  - ScreenCaptureKit for display/window capture,
  - AVFoundation for cameras.
- A backend-owned scene graph becomes the shared source of truth for preview and recording composition.
- Preview behaves like OBS: a native rendered view of the scene graph. Electron hosts and controls it; raw frames do not cross Electron IPC.
- FFmpeg stays as the first downstream encoder/muxer backend, fed by Videorc-owned capture/render output.
- Recordings remain MKV-first, with optional MP4 remux after stop.

### Current platform implementation note

As of 2026-07-14, macOS implements the native preview decision with the
detached CAMetalLayer presenter. The Windows alpha has an explicit, temporary
platform exception: its supported presenter is the uncompressed, latest-wins
BMP Electron proof surface described in `docs/windows-port-plan.md`. A healthy
Windows proof presenter may be live at the product-lifecycle level only after
its first-frame and source-liveness contracts pass, but it must continue to
report `electron-proof-surface` / `electron-browser-window` and must never be
counted as native-rendered OBS-parity evidence. A future Windows-native host can
replace this exception without changing the lifecycle contract.

## Source References

The OBS source references used for behavior mapping live in [OBS parity source map](../obs-parity-source-map.md).

The planning source of truth lives in the Obsidian note:

`/Users/orcdev/Documents/Obsidian Vault/plans/planned/2026-05-31 - Videorc OBS Studio Capture Parity Plan.md`

## Consequences

Positive:

- Capture bugs can be fixed at the source/timing layer instead of through FFmpeg filter tuning.
- Preview and recording can share composition without sharing one fragile process.
- Recording can survive preview slowness.
- The UI can grow toward OBS-style source, mixer, transform, and diagnostics behavior without copying OBS internals.
- Videorc keeps its current Electron/Rust product direction.

Tradeoffs:

- Native macOS capture adds platform-specific implementation work.
- Some Rust crates may not expose enough of CoreAudio, ScreenCaptureKit, or AVFoundation, requiring small FFI boundaries.
- Scene graph and native preview work is larger than continuing to tune FFmpeg commands.
- The team must keep the licensing boundary explicit during all OBS research.

## Non-Goals

- Full OBS plugin compatibility.
- Embedding libobs.
- Copying OBS GPL code.
- Full OBS settings UI.
- Studio Mode/program-preview split.
- Audio monitoring in v1.
- System audio capture in the first native capture pass.
- App capture in the first ScreenCaptureKit pass.

## Phase Order

1. Phase 0: this ADR and source-map docs.
2. Phase 1: OBS-style microphone capture with native CoreAudio, 48 kHz float32 internal audio, a backend ring buffer, fake PCM tests, and a minimal mixer row.
3. Phase 2: OBS-style display/window capture with ScreenCaptureKit.
4. Phase 3: OBS-style camera capture with AVFoundation.
5. Phase 4: backend scene graph and native preview surface.
6. Phase 5: split recording pipeline with FFmpeg downstream encoding/muxing.
7. Phase 6: Diagnostics tab stats and structured-ish session logs.
8. Phase 7: shadcn UI parity layer over sources, mixer, transforms, diagnostics, and outputs.

## Acceptance

- This ADR exists in the repo.
- OBS references are centralized in repo docs.
- The no-copied-OBS-source licensing boundary is explicit.
- Rust-first plus minimal Objective-C FFI is explicit.
- FFmpeg is declared downstream-first for the OBS-parity architecture.
