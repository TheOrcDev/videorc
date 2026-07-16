# Agent Instructions

These rules are load-bearing for Videorc work. Read this before changing code.

## Verification Gates

Use the smallest gate that proves the change, then run the broader gate before handing off risky work.

- TypeScript typecheck: `pnpm typecheck`
- TypeScript lint: `pnpm lint`
- TypeScript format check: `pnpm format:check`
- JS production advisory audit: `pnpm audit:js`
- Node logic tests: `pnpm test:scripts`
- Desktop unit tests: `pnpm --filter @videorc/desktop test`
- Desktop build: `pnpm build`
- Preview lifecycle probe: `pnpm probe:preview-lifecycle`
- Rust format: `cargo fmt --check --all`
- Rust advisory audit: `pnpm audit:rust` (requires `cargo install cargo-audit --locked` locally)
- Rust tests: `cargo test -p videorc-backend`
- Rust lint: `cargo clippy -p videorc-backend -- -D warnings`
- Combined dependency advisory audit: `pnpm audit:deps`
- Local smoke bundle: `pnpm smoke:local-gates`

CI covers Rust advisory audit, Rust fmt, clippy, Rust tests, JS production advisory audit, TS format, TS lint, TS typecheck, desktop unit tests, and Node script tests. Device, preview, recording, and packaging smokes still need a local macOS environment with the right permissions.

## Recording Studio Regression Rules

- Run `pnpm smoke:recording-studio` before handing off changes that touch capture selection, preview, layout composition, recording output, FFmpeg/video encoding, audio capture, or audio sync.
- The recording-studio gate must cover desktop capture/session params, Node artifact analyzer and A/V sync tests, backend live layout/scene/recording/audio tests, the dev-app all-layout recording smoke, imported screen recording smoke, and the real ScreenCaptureKit screen recording smoke.
- It must also cover the maintained preview reliability smokes: layout/source preview liveness, backend-owned scene commits, main pump diagnostics, click/focus continuity, detached lifecycle, and detached native preview surface reattach.
- The dev-app all-layout recording smoke must inspect the finished recording artifacts with ffprobe/ffmpeg. A file-size-only recording smoke is not enough.
- Run `pnpm smoke:recording-matrix` for changes that touch encoding profiles, colorimetry, container/export, or fps handling: it records every shipping recording profile (1080p/1440p/4K × 30/60, vertical twins, the 640×360 floor) through the real app and hard-fails on missing BT.709/video-range color tags, under-spec H.264 levels, broken keyframe cadence, wrong dimensions/fps, or an unbounded A/V stop tail. Its second pass re-records 4K30 and 1080p60 with `VIDEORC_SYNTHETIC_HARD_CONTENT=1` (per-frame noise, real encoder cost) and asserts the compositor keeps rendering DURING the recording — easy synthetic content is not accepted as bridge-pressure evidence. It is part of `smoke:local-gates`.
- For native preview, source compatibility, layout liveness, or real-device capture changes, run `pnpm smoke:recording-studio:devices` when the local macOS host has the required screen/camera/mic permissions. If that cannot run, say why and run the closest focused native-preview probe or smoke.
- For audio sync changes, keep `pnpm test:scripts` and a final-artifact A/V analysis in the verification set. Do not rely on manual playback alone.
- Do not hand off recording-studio work with only typecheck/lint unless the change is docs-only or the relevant smoke is explicitly blocked.

## Native Preview Rules

- Production macOS preview is the detached native CAMetalLayer path. MJPEG/JPEG preview routes are fallback or debug paths only.
- The current Windows production presenter is the uncompressed, latest-wins BMP Electron proof surface documented in `docs/windows-port-plan.md`. It may report a healthy lifecycle only after its first-frame and source-liveness contracts pass, and it must remain identified as `electron-proof-surface` / `electron-browser-window`; it must never claim native CAMetalLayer transport or backing. Production PNG requests remain a transport bug.
- Do not silently downgrade a session that claims native preview. If native CAMetalLayer cannot run on macOS, surface the fallback reason in status, diagnostics, or health copy. On Windows, surface proof-presenter startup and source stalls without mislabeling the supported proof transport as native.
- Probe before merging preview changes. At minimum run the relevant native preview tests and use the smoke/probe command that exercises the touched path.
- For detached preview window lifecycle, toggle, close/reopen, placement ownership, frame-polling suppression, or proof-surface teardown changes, run `pnpm probe:preview-lifecycle`; add `pnpm probe:preview-window` when placement or move/resize behavior is touched.
- `PreviewSurfaceBounds` has mirrors in Rust protocol, shared TS types, native host/helper protocol, and normalization/comparison code. Any field change must preserve all mirrors and must include a regression test proving fields survive normalization and helper serialization.
- Stacking fields (`orderAboveWindowId`, `elevated`) are required for detached preview-window ordering. Dropping them reintroduces the preview-over-everything bug.

## Process And Script Rules

- Do not use broad process scans such as `pgrep -f` to clean up app children. Only reap app-owned PIDs recorded by Videorc.
- Keep scratch probes out of the committed tree unless they are promoted into maintained smoke/probe scripts. If a temporary script is useful, put it under `scripts/` with a clear name, testable assumptions, and a package script.
- Do not commit secrets, local tokens, app data, recordings, or generated media evidence unless a doc explicitly asks for a tiny fixture.
- The worktree may contain user changes. Stage only files you intentionally changed for the current slice.

## Style

- Match existing TypeScript and Rust style. Prefer small pure helpers for behavior that needs tests.
- Keep frontend controls dense and work-focused. Use the existing component system and icon set.
- Prefer explicit status and diagnostics over silent fallbacks.
