# Agent Instructions

These rules are load-bearing for Videorc work. Read this before changing code.

## Verification Gates

Use the smallest gate that proves the change, then run the broader gate before handing off risky work.

- TypeScript typecheck: `pnpm typecheck`
- Node logic tests: `pnpm test:scripts`
- Desktop unit tests: `pnpm --filter @videorc/desktop test`
- Desktop build: `pnpm build`
- Rust format: `cargo fmt --check --all`
- Rust tests: `cargo test -p videorc-backend`
- Rust lint: `cargo clippy -p videorc-backend -- -D warnings`
- Local smoke bundle: `pnpm smoke:local-gates`

CI covers Rust fmt, clippy, Rust tests, TS typecheck, and Node script tests. Device, preview, recording, and packaging smokes still need a local macOS environment with the right permissions.

## Native Preview Rules

- Production preview is the detached native CAMetalLayer path. MJPEG/JPEG preview routes are fallback or debug paths only.
- Do not silently downgrade a session that claims native preview. If native CAMetalLayer cannot run, surface the fallback reason in status, diagnostics, or health copy.
- Probe before merging preview changes. At minimum run the relevant native preview tests and use the smoke/probe command that exercises the touched path.
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
