# Plan 219: A hidden window pauses instead of going missing

> **Executor instructions**: one workstream, three slices in order, macOS
> only for S1 and S2's classifier (`cfg(target_os = "macos")`); Windows and
> Linux keep their capture paths. Gates run once at the end (owner rule).
> Anchors below are symbol names; find them again if lines moved.

## Status

- **Status:** BUILT 2026-11-06 on branch `fix/window-out-of-sight`
  (S1, S2, S3, the smoke step and the plan). Draft PR; not merged.
  - **Owed:** another desktop/Space (not probed: the window server lists a
    window on another Space without the on-screen mark, so it is expected to
    read as out of sight, but no probe ran); a separate-source take through
    the packaged app with a real camera (the dev app has no camera TCC
    grant, so the ISO preflight could not run end to end; the smoke proves
    the same refusal through `preview.screen.start`, which is the call the
    preflight makes); a mid-take minimize during an ISO take (S1 holds the
    shared screen generation, so the Screen file should keep its last frame
    and resume; unverified).

## The bug

A streamer with "Separate source recordings" on pressed Record and got:

```
Couldn't start recording — Selected Screen/Window could not be prepared for
separate recording (SourceMissing): ScreenCaptureKit window is missing:
window:screencapturekit:40696
```

The owner could not reproduce it with a visible window. The picked window
was minimized, hidden (⌘H) or on another desktop, or had been closed and
reopened.

## Cause (code on `origin/main` + Swift probes on this Mac, 2026-11-06)

1. Capture start and every restart discover content with
   `getShareableContentExcludingDesktopWindows(true, onScreenWindowsOnly: true)`
   (`preview_screen.rs` `load_shareable_content`). `select_content` then
   raises `SourceMissing("ScreenCaptureKit window is missing: …")` when the
   window is not in that list.
2. Probe results for a test NSWindow (`/tmp/sck-probe/*.swift`, out of
   tree):

   | Window state          | In the on-screen list | New stream from the full list | A stream already running                                                        |
   | --------------------- | --------------------- | ----------------------------- | ------------------------------------------------------------------------------- |
   | visible               | yes                   | frames flow                   | frames flow                                                                     |
   | minimized             | no                    | starts, 0 complete frames     | goes silent, no `didStopWithError`, resumes on restore (+90/+120 frames in 2 s) |
   | app hidden (⌘H)       | no                    | starts, 0 complete frames     | same as minimized                                                               |
   | closed                | no                    | n/a                           | goes silent, no `didStopWithError` within 3 s                                   |
   | another desktop/Space | not probed            |                               |                                                                                 |

   So widening the lookup to the full list is not a fix (0 frames, then a
   slow barrier timeout).

3. The window server distinguishes the two cases cheaply:
   `CGWindowListCopyWindowInfo(kCGWindowListOptionAll, kCGNullWindowID)`
   lists a minimized or hidden window without the `kCGWindowIsOnscreen`
   key, and does not list a destroyed one. `kCGWindowListOptionIncludingWindow`
   alone drops a minimized window too (probed), so the whole list is
   scanned (a few hundred small dictionaries, no ScreenCaptureKit round
   trip).
4. Capture health treats ScreenCaptureKit sources as authoritative
   (`capture_health.rs`): a silent window plus a compositor consuming it is
   a `ScreenDelivery` degraded transition → capture recovery restarts the
   source (`capture_recovery.rs`) → the restart hits step 1 and ends in
   `SourceMissing`. Nothing retried, and the source was marked missing.
5. A separate-source take runs `prepare_source_iso_selected_capture`
   (`recording.rs`): it reuses the screen capture only when it is Live on
   that exact source; a camera-only layout has already retired it ("Idle
   layout retirement"), so the preflight starts it fresh and hits step 1.
   The error text was built with `({:?}): {}`, so the streamer read the
   enum and the id.
6. The device picker lists only on-screen windows, and the renderer
   refreshes `devices.list` only at launch, on Sources' Refresh and in
   permission flows. A closed-and-reopened window gets a new id; the saved
   selection kept the dead one.

## Slices

### S1 – A window that is only out of sight is never restarted (macOS)

- `screen_capture.rs`: `WindowPresence { OnScreen { name }, OffScreen { name }, Gone }`
  and `window_presence(window_id)` (one `CGWindowListCopyWindowInfo` pass;
  name = "App - Title" the way Sources lists it). The copy helpers live on
  the enum so S2 and the health notices share them.
- `capture_recovery.rs`: before the coordinator sees a `ScreenDelivery`
  stall whose scope is a ScreenCaptureKit window
  (`hold_out_of_sight_window`): OffScreen holds (no restart, no attempt
  spent, generation untouched, source never marked failed or missing), with
  ONE warn health event per episode, `screen-window-out-of-sight`:
  "<window> is minimized, hidden or on another desktop. The picture is
  paused until it's back." Gone and OnScreen keep today's restart. A watch
  task re-checks presence every 2 s while the episode is open; a window
  closed while out of sight hands the stall back to the normal restart
  (which ends in S2's "closed" copy). The normal `Recovered` edge clears
  the episode with no restart and says `screen-window-back` (info):
  "<window> is back. The picture is moving again." The renderer shows both
  on the existing screen-capture toast key.
- `handle_screen_stream_stop` (`preview_screen.rs`): unchanged. The probes
  show the system never stops a stream for a minimize, a hide or a close;
  when it does stop one, a restart is the right outcome and it now ends in
  S2's copy for a window that is out of sight or closed.
- Done when: unit tests cover the decision (OffScreen holds without a
  restart or a spent attempt, a second edge in the same episode adds no
  warn, Recovered clears it with no restart, Gone restarts, OnScreen
  unchanged), and the smoke's `out-of-sight` step shows a window minimized
  for ~15 s on the canvas coming back with the frame counter never reset,
  no recovery phase and no `source-missing`.

### S2 – Errors people can act on

- `select_content` (`preview_screen.rs`): a window missing from the
  on-screen list is classified with the presence check:
  - out of sight: "<window> is minimized, hidden or on another desktop.
    Bring it back, then try again."
  - gone: "The window you picked was closed. Pick it again in Sources."
    The state stays `SourceMissing`; the source id and the presence go to
    the log (`tracing::warn!`), as does every source-missing start.
- `prepare_source_iso_selected_capture` (`recording.rs`): the refusal the
  streamer reads is the capture's own sentence when it was written for
  people, or a plain fallback ("The screen or window you picked didn't
  start. Pick it again in Sources, then press Record." / "The camera didn't
  start. Try again. If it keeps happening, export a support bundle from
  Health."). Never `(SourceMissing)`, an enum, an engine name or
  `window:screencapturekit:N`; the state, ids and raw message are logged.
- Decision (made): a window out of sight at Record whose capture is not
  already Live is REFUSED with the out-of-sight copy. The take never waits
  for the window.
- Done when: unit tests assert both messages and that the refusal contains
  no enum, engine or id; the smoke step shows a start on a minimized window
  answering `source-missing` with the copy, and the same start live once
  the window is back.

### S3 – A closed-and-reopened window is picked up again (renderer)

- `lib/window-source-rebind.ts`: `shouldRefreshWindowListBeforeStart`
  (a native window pick whose screen capture is not Live on that id) and
  `rebindRememberedWindow` (windows only, `findRememberedSource`'s rules:
  exact id, then exact name; a match under a new id rebinds
  `windowId`/`windowName`; no match leaves the selection unchanged so S2's
  "closed" copy shows; never a display, never another app's window).
- `use-studio.tsx` `runStartSession`: one `devices.list` read before
  `session.start`, only when the capture is not Live on the picked window
  (the record-latency budget); a rebind also updates the working config and
  the device list so the reconcile keeps the new id.
- Why `devices.list` and not `sources.resolve_app_window` (plan 210): the
  resolver needs a bundle id the saved selection does not carry and may hand
  back a sibling window of the same app; the list reuses the backend's
  one-second content cache and the existing matching rules.
- Done when: renderer unit tests cover rebind-on-new-id,
  no-match-leaves-selection, never-a-screen, and no fetch when Live.

## Out of scope

What a normal (non-ISO) recording does with a minimized window beyond S1's
hold, the Windows/Linux capture paths, widening `onScreenWindowsOnly`, new
UI surfaces beyond the existing health/toast copy.

## Verification

- Rust: `cargo fmt --check --all`, `cargo clippy -p videorc-backend
--all-targets -- -D warnings`, targeted `cargo test -p videorc-backend`
  filters for `capture_recovery`, `screen_capture`, `recording` (never the
  full suite, owner directive; compositor/recovery filters under `timeout`).
- TS: `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, the touched
  vitest files, `node --test scripts/lib/smart-scenes-gate.test.mjs`.
- Smokes: `pnpm smoke:smart-scenes` (its new `out-of-sight` step is the
  real-app proof of S1 and S2; the fixture window minimizes and restores
  itself on SIGUSR2 because a T3 terminal has no Accessibility grant);
  `pnpm smoke:record-latency:gate` (S3 touches the start path).
