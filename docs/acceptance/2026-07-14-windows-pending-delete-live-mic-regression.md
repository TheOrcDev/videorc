# Windows Pending Delete And Live Microphone Regression Acceptance

Date: 2026-07-14

Branch: `codex/fix-windows-delete-live-mic`

Status: implemented; automated and macOS device gates passed. Final physical
DirectShow acceptance is blocked until this branch is run on a Windows host with
the tester's microphone.

## Scope

This change addresses the two errors recorded in
`Videorc_QsSAXDj3CE.mp4` and the follow-up record-only error captured in
`CleanShot 2026-07-14 at 17.50.03@2x.png`:

1. `backend.sessions.delete.pending.result[0].blockedPathCount must be a known field.`
2. The live microphone state could not be confirmed even though the user did
   not change gain or mute.
3. Clicking Record raised `Reconnect Twitch before starting an OAuth
   livestream.` even though the requested output had streaming disabled.

The pending-delete schema failure and the later FFmpeg/audio failure are kept as
independent defects. Fixing the renderer contract does not mask capture-process
failure.

## Accepted implementation

### Pending deletion

- `sessions.delete` and `sessions.delete.pending` now share one strict opaque
  deletion-handle schema.
- Non-empty pending results accept `pathCount` and `blockedPathCount`.
- Private `paths` and `blockedPaths` remain rejected at the renderer trust
  boundary.
- The real backend smoke inspects pending handles before resolve/complete and
  proves that no path is returned.

### Record-only platform isolation

- Saved livestream destinations remain available for a later Go Live, but a
  record-only start performs no OAuth validation or platform activation.
- Record-only `session.start` forces `streamEnabled: false` and omits the
  streaming snapshot entirely.
- Record-only Stop performs no YouTube/X lifecycle cleanup, even if saved
  destination state is stale or previously marked live.
- The backend independently treats `output.streamEnabled` as authoritative, so
  older clients that still send saved streaming settings cannot turn a local
  recording into an OAuth validation failure or attach live chat.
- The confirmed Go Live flow retains its explicit streaming override,
  validation, activation, and cleanup behavior.

### Live microphone lifecycle

- The renderer associates the exact audio snapshot sent in `session.start` with
  the returned session ID.
- An untouched start sends zero redundant `audio.processing.update` requests.
- An edit made while the session is Starting becomes one latest-wins update
  after the session is active.
- Session termination drops queued updates and suppresses the secondary
  microphone warning; a still-live but unconfirmed command remains fail-closed.
- The backend confirms identical settings locally only while the command lane is
  healthy.
- FFmpeg command readiness, dispatch, acknowledgement, and terminal state now
  have separate bounded lifecycle signals. A readiness timeout cannot dispatch
  a late orphan command.
- Stop remains independent of the acknowledgement lane and returns
  `session-ended` for a command interrupted by capture termination.

### Windows DirectShow input

- DirectShow uses the device's supported/default input shape instead of forcing
  every microphone to 48 kHz stereo before input negotiation.
- Product output is normalized after capture with
  `aformat=sample_rates=48000:channel_layouts=stereo`.
- The named live volume filter remains after normalization, so gain and mute
  target the same stable graph.
- Structured diagnostics expose sanitized input shape, command readiness,
  post-flush dispatch, terminal state, and categorical first-fatal-line evidence
  without credentials or output paths.

### Physical Windows gate

`pnpm smoke:windows-live-audio-controls` drives the packaged renderer and requires
a physical DirectShow microphone/camera plus a real Windows screen source. It
covers:

- untouched record-only startup for at least 10 seconds with zero live-audio
  mutations and zero warnings;
- +6 dB, mute, unmute, and rapid latest-wins updates;
- record-only, stream-only, and record+stream graph ownership;
- stop after proven post-flush command dispatch;
- final record/stream artifact duration, amplitude windows, mute/restore, and
  A/V analysis;
- support-bundle export on pass, failure, or block.

The Windows aggregate gate preserves a device absence as `BLOCKED` with its
reason instead of converting it to `FAILED` or silently skipping it.

## Verification evidence

Green gates:

- `pnpm typecheck`
- `pnpm lint`
- `pnpm format:check`
- `pnpm test:scripts` — 636/636
- `pnpm --filter @videorc/desktop test` — 1,078 passed, 1 skipped
- `pnpm build`
- `cargo fmt --check --all`
- `cargo test -p videorc-backend` — native helper 53 passed; backend 1,291
  passed and 8 ignored; integration 1 passed
- `cargo clippy -p videorc-backend -- -D warnings`
- `pnpm smoke:session-ops`
- `pnpm probe:live-audio-controls` — record and record+stream both showed the
  expected +6 dB, mute, and restore windows
- `pnpm smoke:local-gates:windows -- --dry-run`
- Preview scene commit, pump diagnostics, click/focus, interaction stress,
  100-cycle lifecycle, window placement, and native surface gates
- macOS device interaction stress — 59.066-second analyzed artifact
- real ScreenCaptureKit live-layout record and record+stream artifacts
- native preview recording — analyzed artifact, 7 ms A/V skew

After the record-only isolation fix, `pnpm smoke:recording-studio` again passed
its provider integration contract, backend recording/audio, caption,
noise-cleanup, all-layout record-only artifacts, imported-screen, first-frame,
layout/source, and active-layout record/stream rows before stopping at the
pre-existing comment-highlight split record/stream failure. The rerun reproduced
zero highlight pixels. This branch does not touch the highlight/caption
compositor.

The remaining rows were run individually. Two real-source baseline rows fail on
the base branch as well: the smoke labels the step `preview.surface.create`, but
then calls admin-only `preview.surface.take_native_host_commands` with the
renderer token. The correct future fix is a bounded Electron-main-owned drain;
this regression PR does not widen backend authority.

## Blocked physical acceptance

The physical Windows command was invoked on the current host and correctly
refused to claim acceptance because the host is `darwin/arm64`.

Run on the Windows tester machine:

```powershell
pnpm smoke:local-gates:windows
```

Required setup: packaged Videorc app, physical DirectShow camera and microphone,
real DXGI/gdigrab screen source, Screen + Cam at 1280x720/30, and a steady
unclipped tone. Preserve the generated manifest, analyzed artifacts, and support
bundle. Until that row passes, this document does not claim that the original
Logitech device has been physically accepted.
