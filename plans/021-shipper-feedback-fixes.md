# Plan 021: Fix the first external-tester feedback batch (preview vanish, nudge d-pad, silent mic)

> **Executor instructions**: Three field reports from an external tester
> (martinzokov on Discord, 2026-07-06, testing a downloaded build — likely
> 0.9.12). Each slice is independently shippable. F1 and F3 are Diagnose-route
> work: reproduce before fixing, and prefer explicit diagnostics over silent
> fallbacks. F2 is a scoped UI fix. Recording-studio and native-preview changes
> are NOT done with typecheck/lint alone — run the matching smoke/probe from
> `AGENTS.md`.
>
> **Drift check (run first)**: `git status --short --branch`; inspect
> `apps/desktop/src/main/native-preview-first-frame.ts`,
> `apps/desktop/src/renderer/src/components/tabs/layout-tab.tsx`, and
> `crates/videorc-backend/src/recording.rs` if they changed since
> `a7e3d4b5` (2026-07-06).

## Status

- **Priority**: P0 (F3 silent mic, F1 preview vanish) / P2 (F2 arrows, F4)
- **Effort**: M overall (F1 M, F2 S, F3 M, F4 S)
- **Depends on**: reporter's app version + support bundle for F3 (owner asks
  on Discord; Plan 018 diagnostics export exists for exactly this)
- **Category**: native preview, recording, UI polish
- **Planned at**: commit `a7e3d4b5`, 2026-07-06
- **Execution**: EXECUTED 2026-07-06 (F1 `754ca0cb`, F2 `65a8b788`, F3
  `da643ee4`, F4 `d9996408` on main; gates PASS incl. preview-lifecycle
  probe, preview-surface + real-launch smokes, recording-studio gates,
  cargo tests/clippy, desktop tests ×438). Notes vs the plan:
  - F1 shipped the continuous presenting contract + teardown hardening; a
    LIVE stall was not reproduced locally (unit tests + probes pin the
    ladder instead), so root-cause attribution on the reporter's machine
    rides the new `[preview-watch]` log lines in their next report.
  - F4's ghost text root-caused to the transparent window showing OTHER
    APPS through the translucent coat when the wallpaper underlay is
    unavailable (Automation denied on fresh machines) — degraded glass is
    now a solid theme base.
  - Discovered while running `smoke:local-gates`: the backend-resilience
    smoke had drifted (probed a "Status" text prefix that died in the
    0.9.7 session-panel declutter — failing on clean main independent of
    this batch) — repaired in `853881c9` with a data hook + explicit exit.
  - PENDING owner: F0 Discord ask (version, support bundle, floating-
    while-recording, mic device) + by-eye on the next shipped build.

## Reports

1. **Preview vanish** (17:58): floating preview window shows the "Waiting for
   preview" placeholder; clicking the window brings frames back, "but after a
   bit it stops" again. Screenshot shows the detached window with the hint.
2. **Nudge arrows layout** (18:01): in the Scene tab source inspector, the ←
   button sits far left of the ↑/↓/→ cluster; reporter assumed it belongs
   adjacent. Screenshot also shows two discovered items (see F4).
3. **Silent mic** (18:11): "gave it mic permissions but it's not recording
   audio for me" — mic permission granted, recorded file has no audio.

## Investigation Findings (2026-07-06, current main)

- **F1** — the placeholder is main's fallback HTML behind the native
  CAMetalLayer (`index.ts` ~2099). The first-frame contract
  (`native-preview-first-frame.ts`) owes a frame / heal / declared fallback
  **only at window open**; once the first frame lands, NOTHING watches for a
  mid-session presenting stall. A stalled present pump shows the placeholder
  (or a frozen frame) with no healing and no truthful reason. Click →
  focus/placement path effectively "present-kicks", matching "click brings it
  back". Candidate stall causes to instrument, in rank order:
  1. main-process present pump's backend WebSocket drops and the renderer
     fallback pump doesn't engage (pump-mode handoff race, `index.ts` ~5041);
  2. macOS suspends the helper or compositing when the window is
     unfocused/occluded (`disable-backgrounding-occluded-windows` covers
     Chromium windows, NOT the `native_preview_host_helper` process — App
     Nap on the helper is untested);
  3. the 3-slot IOSurface target ring / helper import cache wedges after a
     scene change while detached (see [videorc-preview-res-tearing-plan]).
- **F2** — `layout-tab.tsx` ~478: the d-pad grid is
  `grid-cols-[1fr_auto_1fr]`; the ← button starts at the left edge of a
  stretched `1fr` column while ↓/→ hug the center `auto` column. Pure layout
  bug; the click targets are correct.
- **F3** — mic path: `capture.ts` picks/remembers `microphoneId`,
  `microphoneMuted` defaults false; backend `recording.rs`/`audio.rs` write
  the track. Candidate causes for a third-party machine:
  1. TCC: backend spawned before the user granted mic → the grant needs a
     backend restart; FX1 (0.9.9) fixed the Settings *Enable dialog* path,
     but recording started straight after onboarding may still hold a
     pre-grant device handle;
  2. no device actually selected (`microphoneId` stale/missing after
     remembered-source reconciliation on first run);
  3. the audio writer errors and the session degrades to video-only
     SILENTLY — nothing in Studio or the finished-recording toast says "no
     audio track". Whatever the root cause is, this silence is the product
     bug: the user found out by playing the file.
- **F4 (discovered from screenshot 2, unreported)**:
  1. Ghost monospace text "Opening browser for sign in..." + a "TRY AGAIN"
     button renders faintly INSIDE the Screen capture inspector panel — some
     sign-in surface (OAuth connect flow?) is bleeding into the Scene tab,
     wrong z/opacity or an unmounted overlay leaving artifacts.
  2. Stage source chips overlap ("Screen capture" chip drawn over the
     "Camera" chip label) in the side-by-side layout.

## Decisions

1. **F1 is fixed as a contract extension, not a one-off patch**: promote the
   first-frame contract to a *continuous presenting contract*. The pure
   decision core already models snapshots + healing ladder; feed it
   mid-session ticks so ANY stall (whatever the cause) heals with the same
   ladder and, failing that, declares a truthful reason in the hint. Root
   cause still gets diagnosed (the ladder logs which action healed it), but
   the user-facing guarantee comes first.
2. **F3 ships a truthful audio health signal regardless of root cause**: if
   the mic is enabled and the writer has produced ~0 audio frames N seconds
   into a session, surface it in the Studio health chips (like the
   preview-closed "Blocked" fix) and in session diagnostics; the
   finished-recording toast must say when a file has no audio track. Silent
   video-only fallback is the deputized bug even if the reporter's TCC state
   caused it.
3. F2 is cosmetic-lane work (opus-4.8 per model defaults); F1/F3 are
   diagnose-heavy release-critical paths (fable-5 lane).
4. Ask the reporter for version + support bundle FIRST (owner, Discord), but
   do not block F1/F2 on the reply — only F3's root-cause confirmation.

## Slices

### F0 — Owner ask (no code)

Owner replies to martinzokov asking for: app version (Settings → About),
the support-bundle/diagnostics export (Settings → Diagnostics), whether the
preview was floating while a recording/stream was running, and which mic
device. Unblocks F3 attribution; F1/F2 proceed regardless.

**Done when**: ask posted; answers (or non-answer after a day) noted here.

### F1 — Preview presenting contract (Diagnose)

1. Reproduce: packaged-style run with the preview detached; unfocus/occlude
   the window, change scenes, idle minutes; also kill the backend event
   socket mid-session (dev hook) to force the pump-handoff race. Watch for
   the placeholder with `probe:preview-lifecycle` extended to sample
   `framesRendered` advancement while detached (the probe currently proves
   open/dock transitions, not steady-state presenting).
2. Instrument the ranked causes (pump handoff, helper App Nap, target ring)
   with tagged debug logs; identify which one matches "click revives it".
3. Extend `native-preview-first-frame.ts` into a continuous contract:
   steady-state ticks with `framesAdvancing`; stall > budget → same healing
   ladder (present-kick → resync-scene → reset-native-path) → truthful hint
   reason on exhaustion. Unit-test the decision core (it is electron-free).
4. Fix the root cause found in (2) (e.g. renderer-fallback engage on socket
   drop, `NSProcessInfo` activity to pin the helper awake, ring reset).

**Done when**: the stall repro from (1) self-heals within budget with the
placeholder never persisting; regression unit tests on the decision core;
`pnpm probe:preview-lifecycle` + studio gates PASS; the fix names the
confirmed cause in the commit message.

### F2 — Nudge d-pad layout (UI, videorc-design skill)

`layout-tab.tsx` arrow grid → a real d-pad: `w-fit` 3-column grid
(`grid-cols-[repeat(3,auto)]` or `grid-cols-3` with `justify-items-center`),
↑ centered on row 1, ← ↓ → adjacent on row 2, consistent `gap-2`. Read
`.claude/skills/videorc-design/SKILL.md` first (required for UI work).

**Done when**: cluster reads as a d-pad at all inspector widths; disabled
explanation rows unaffected; typecheck/lint/format PASS; screenshot in the
PR/commit body or acceptance note.

### F3 — Silent mic (Diagnose + truthful health)

1. From the support bundle (F0): confirm whether the session had a mic
   device, whether audio frames were written, and any writer errors.
2. Local repro attempts: fresh smoke-isolated profile → grant flow → record
   immediately (the TCC-restart hypothesis); record with `microphoneId`
   pointing at a vanished device; force the audio writer to error.
3. Fix the confirmed root cause (likely: recording start must verify the
   backend holds a POST-grant device handle, mirroring FX1's dialog fix; or
   remembered-source reconciliation must not leave `microphoneId` unset on
   first run).
4. Ship the health signal regardless: mic enabled + ~0 audio frames after N
   seconds → Studio health chip + session diagnostic; finalize toast says
   "no audio track" when true. Regression tests at the diagnostics seam;
   never block or abort the recording itself.

**Done when**: root cause reproduced-then-fixed (or explicitly attributed to
the reporter's environment with the bundle as evidence); the health signal
fires in a forced-silent test and in `smoke:recording-studio`-adjacent
coverage; cargo tests + relevant smokes PASS.

### F4 — Discovered polish (investigate, small)

1. Find what renders "Opening browser for sign in... / TRY AGAIN" inside the
   Scene tab (screenshot 2). Likely the OAuth-connect surface or a stale
   overlay; fix z-index/unmount so sign-in UI can never bleed into other
   tabs.
2. Stage chips: prevent source-label chip overlap in side-by-side (offset or
   collision-avoid like the camera-drag snap work).

**Done when**: sign-in surface only ever renders in its own window/overlay;
chips never overlap at default sizes; typecheck/lint PASS.

## Verification

- F1: `pnpm probe:preview-lifecycle`, `pnpm --filter @videorc/desktop test`,
  studio smoke gates; state exactly why if `smoke:screen-recording-real` is
  env-blocked.
- F2/F4: `pnpm typecheck && pnpm lint && pnpm format:check`, by-eye
  screenshots.
- F3: `cargo test -p videorc-backend`, `pnpm test:scripts` if scripts
  change, recording-studio smoke, plus the forced-silent repro.
- All: `pnpm smoke:local-gates` before calling the batch done.

## Acceptance Criteria

- Detached preview never sits on "Waiting for preview" without either
  self-healing or a truthful reason string; the reporter's click-to-revive
  loop is gone.
- Nudge arrows read as one d-pad cluster.
- A recording with an enabled-but-silent mic tells the user so, in-app,
  before they play the file; the reporter's scenario is root-caused or
  attributed with evidence.
- Sign-in UI cannot bleed into the Scene tab; stage chips don't overlap.
- Reporter confirms (or owner reproduces confirmation of) all three fixes on
  the next shipped build.
