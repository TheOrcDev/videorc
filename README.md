# Videorc

Videorc is an AI-native desktop studio for creator recording and livestreaming workflows.

This repository currently contains the technical spike:

- Electron + React/TypeScript desktop shell
- Rust backend process launched by Electron
- Authenticated localhost WebSocket protocol
- SQLite-backed local session library
- Device discovery stubs with FFmpeg-backed macOS device probing
- Source, layout, output, RTMP preset, and health event settings
- FFmpeg-backed capture sessions that can record MKV, stream RTMP, or do both through one shared output pipeline
- Native detached CAMetalLayer scene preview driven by the Rust backend, with authenticated localhost fallback/debug preview routes
- Tutorial preset composition that scales to 1440p when available and falls back to the captured resolution
- Optional MP4 remux after MKV recording
- Post-recording AI workflow for local audio extraction, optional cloud transcription, title/description suggestions, summaries, and chapters

Raw media frames do not move through Electron IPC. Electron receives backend connection details, state updates, device metadata, recording status, and logs.

## Prerequisites

- Node.js 24+
- pnpm 11+
- Rust stable via rustup
- FFmpeg available on `PATH` for development

Packaged macOS builds stage an LGPL-compatible FFmpeg executable from source and include it as an app resource. The Settings FFmpeg path override still works for development, debugging, and power users.

## Development

```sh
pnpm install
pnpm dev
```

The desktop app launches the Rust backend automatically. Recordings default to:

```text
~/Movies/Videorc/Recordings
```

Session metadata is stored in:

```text
~/Library/Application Support/Videorc/videorc.sqlite3
```

Run the development app smoke test:

```sh
pnpm smoke:dev
```

The smoke test launches `pnpm dev`, waits for the Electron-launched backend, and records a short test-pattern MKV for each layout preset (screen + camera, screen only, camera only, and side-by-side) through the authenticated backend protocol, stopping each session and verifying every file was written. It does not require camera, microphone, or screen permissions.

Run the local multi-platform streaming smoke test:

```sh
pnpm smoke:multistream
```

This proves the simulcast `tee` fan-out end to end without any external services. It stands up one local FFmpeg RTMP listener per destination, drives a real record + stream session that fans a single encode out to all of them, and verifies that bytes arrive at **every** target while the local recording still finalizes. It also adds one deliberately-offline destination and asserts the failure-handling guarantee (M5): the healthy legs keep receiving bytes while the backend reports the offline leg `failed` in its per-target status snapshot. Set `VIDEORC_SMOKE_TARGETS` (1–4) to change how many healthy destinations are exercised, or `VIDEORC_SMOKE_NO_BAD_TARGET=1` to drop the offline leg. Like `smoke:dev`, it uses the test pattern and needs no camera, microphone, or screen permissions.

## Packaging

Create a local unsigned macOS app bundle with the Rust backend included:

```sh
pnpm package:desktop
```

Packaging builds or reuses the local macOS FFmpeg bundle first:

```sh
pnpm ffmpeg:build:macos
```

Create the configured Electron Builder distribution target:

```sh
pnpm dist:desktop
```

Run the packaged-app recording smoke test:

```sh
pnpm smoke:packaged
```

Force the packaged smoke test to require bundled FFmpeg:

```sh
pnpm smoke:packaged:bundled
```

See [distribution notes](docs/distribution.md) for signing, notarization, and FFmpeg distribution details.

## Architecture Docs

- [Active native 4K media engine refactor](docs/native-4k-media-engine-refactor.md)
- [ADR 0001: OBS-Parity Native Capture Architecture](docs/adr/0001-obs-parity-native-capture-architecture.md)
- [OBS parity source map](docs/obs-parity-source-map.md)
- [Layout presets manual test checklist](docs/layout-presets-manual-checklist.md)

## Current State

The technical spike, capture foundation, reliable recording preview path, first post-recording AI workflow, and first creator polish slice are implemented:

- screen/window, camera, and microphone selection
- four layout presets: screen + camera, screen only, camera only, and side-by-side
- draggable camera positioning, plus corner, size, shape, and margin settings
- side-by-side split presets (50/50, 60/40, 70/30) with selectable camera side
- local recording, RTMP streaming, or record while streaming
- selectable output presets for 1080p30, 1440p30, and 1080p60 with bitrate controls
- manual RTMP presets for YouTube, Twitch, X, and Custom
- live output health readout for FPS, speed, and dropped frames when FFmpeg reports progress
- detached native CAMetalLayer preview window generated from the same selected-source/layout path; MJPEG/JPEG routes remain fallback/debug transports
- tutorial-first 30 FPS composition with camera overlay and circle camera masking
- dedicated named microphone audio tracks in local MKV recordings when a microphone is selected
- deterministic health events surfaced in the UI
- local session library with MKV to MP4 remux
- post-recording AI artifacts attached to local sessions
- advanced creator intelligence for highlights, smart zoom notes, noise cleanup, silence-removal suggestions, and health explanations
- expandable publish-pack viewer and Markdown export
- setup checklist with backend, FFmpeg, source, output, stream, and mic readiness
- first-run onboarding for workflow choice, readiness checks, privacy defaults, and tab handoff
- one-shot FFmpeg microphone level check
- camera framing controls for fit/fill crop, mirror, zoom, and pan
- recording timer and first hotkeys for session toggle and preview refresh
- Electron Builder packaging foundation with the Rust backend included as an app resource
- packaged macOS builds that include an LGPL-compatible FFmpeg executable resource
- signed/notarized macOS release workflow scaffolding and dev/packaged smoke scripts

Next planned slice: clean-machine signed/notarized release validation.

## AI Workflow

The AI workflow is explicit-consent and post-recording only:

- Audio is extracted locally from the session recording into app support storage.
- No upload happens unless the user enables cloud AI consent in the UI and runs AI for a session.
- Cloud transcription uses `OPENAI_API_KEY` when present.
- Generated transcript, title/description, summary, chapters, highlights, smart zoom notes, cleanup suggestions, and health explanations are stored as local SQLite artifacts.
- Publish packs can be exported as local Markdown files beside the session's AI artifacts.
- Single-upload transcription currently fails fast when the extracted audio is over 25 MB; chunking is a later slice.

Optional model overrides:

```sh
export OPENAI_API_KEY=...
export VIDEORC_OPENAI_TRANSCRIPTION_MODEL=gpt-4o-mini-transcribe
export VIDEORC_OPENAI_TEXT_MODEL=gpt-5-mini
```

## Verification

Pushes to `main` and pull requests run the same non-packaged local acceptance checks in GitHub Actions.

Run the full non-packaged local acceptance gate:

```sh
pnpm smoke:local-gates
```

That aggregate runs typecheck, build, backend tests/clippy, OAuth guard coverage, source persistence/start-label checks, streaming secret checks, platform lifecycle checks, Screens switching, multistream, dev-app smoke, and redacted provider readiness.

For a smaller development loop:

```sh
pnpm typecheck
pnpm build
pnpm smoke:dev
cargo fmt --check
cargo test
cargo clippy -- -D warnings
```
