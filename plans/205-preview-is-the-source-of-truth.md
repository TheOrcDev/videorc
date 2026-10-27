# Plan 205: the preview is the source of truth

> **Executor instructions**: Follow this plan slice by slice, in order. Run
> every "Done when" check before moving on. If anything in "STOP
> conditions" happens, stop and report; do not improvise. When a phase is
> done, update this plan's row in `plans/README.md` and fill in "As built".
> Gates run once at the end of each phase (owner rule): write and commit
> the phase's slices first, then run its gate slice.
>
> **Drift check (run first)**:
> `git diff --stat 11e1ab9a..origin/main -- crates/videorc-backend/src/overlay_layout.rs crates/videorc-backend/src/banners.rs crates/videorc-backend/src/compositor.rs crates/videorc-backend/src/recording.rs crates/videorc-backend/src/preview_surface.rs crates/videorc-backend/src/replay_buffer.rs crates/videorc-backend/src/windows_d3d11_session.rs crates/videorc-backend/src/compositor_preview_frame_lease.rs crates/videorc-backend/src/metal_compositor.rs crates/videorc-native-preview-addon apps/desktop/src/main/preview-surface-banners.ts apps/desktop/src/main/index.ts apps/desktop/src/renderer/src/lib/overlay-layout.ts apps/desktop/src/renderer/src/components/scene apps/desktop/src/renderer/src/components/tabs/layout-tab.tsx docs/overlays.md docs/banners.md docs/buddy.md`
> If an anchor quoted below has moved, re-find it by the symbol name. If a
> _behaviour_ changed (not just a line number), that is a STOP condition.

## Status

- **Status:** IN PROGRESS 2026-10-27. The owner answered D1 to D6 the
  same day (see "Owner decisions"). D2 and D3 differ from the first
  recommendations: clips follow "Show in recording", and a banner you add
  shows. So the owner's Buddy report (Clips on, Buddy stream only) is fixed
  by Phase 2's program leg, not by Phase 1.
- **Priority:** P1. Owner request, 2026-10-27: "We need to have a source of
  truth for our preview inside of our preview video currently when we put
  in some banner, it is not visible in our preview and if we put buddy,
  buddy is also not visible in preview. Our preview window should actually
  be the source of truth. Plan it out properly."
- **Size:** L, in three phases that each ship on their own.
  - Phase 1 (one rule everywhere, plus the words): S1 to S4. It fixes
    the banner report, the idle Preview without Clips, and the selected
    Buddy.
  - Phase 2 (macOS, the Preview's own picture whenever the primary leg
    can't be the program: Clips at idle, and a split record + stream):
    S5 to S7. It fixes the Buddy report.
  - Phase 3 (Windows and Linux): S8 to S10.
- **Risk:** MEDIUM in Phase 1. It changes what the idle preview and Clips
  draw, but never what a recording or a stream carries. HIGH in Phase 2:
  it touches what the native preview presents. MEDIUM in Phase 3: Windows
  needs a tester pass.
- **Planned against:** Videorc `origin/main` `11e1ab9a`, in
  `~/projects/videorc-wt-205` (branch `plan-205-preview-source-of-truth`).
  The shared checkout is weeks behind on `feat/windows-owner-waiver`, so
  work in a fresh worktree from `origin/main`. Plan 204 is reserved by
  another session (`~/projects/videorc-wt-204`, Studio chat).
- **Owner route:** Orchestrator, fit 10. The work spans the backend overlay
  plan, Clips, the compositor, the native preview, the Windows media
  session, the Electron proof surface and the Scene page. Lanes per slice
  below, from `CLAUDE.md`.

## Goal

What the Preview shows is what goes out: the docked live canvas, the
floating Preview window, and the proof surface on Windows and Linux. That
includes every showing banner, and Buddy whenever it is on for an output,
in the place it will appear. It holds from the first frame, with Clips on
or off, while nothing runs and while recording or streaming.

Two things are always true of the Preview:

- Nothing that goes out is missing from it.
- Nothing that goes nowhere is drawn in it.

When something is placed but goes nowhere (a hidden banner, or Buddy off
for both outputs), the Scene page says so in words you can see next to the
picture, with the one click that fixes it.

## What's wrong today (verified at `11e1ab9a` and on the owner's profile)

Backend paths are under `crates/videorc-backend/src/`. Renderer paths are
under `apps/desktop/src/renderer/src/`.

The owner's profile, read only on 2026-10-27 (`videorc.sqlite3`,
`backend.log`):

- **The banner:** one banner, `logo-color-600`.
  - It is placed bottom right (x 0.866, y 0.764), with both "Appears in"
    switches on.
  - It is **hidden** (`shown = 0`), last updated 2026-10-26 21:38.
- **Buddy:** `showOnStream: true`, `showInRecording: false` (saved
  2026-10-26 21:25).
- **Captions:** recording only. **Highlight:** both.
- **Clips:** running. The log shows "Armed the live preview compositor in
  place … 3840x2160 @ 30 fps" for buffer-only sessions at 11:26.

These facts explain both of the owner's reports exactly.

1. **Clips turns the idle preview into a recording.**
   - `normalize_replay_only_params` (`recording.rs:3671`) raises
     `record_enabled` for a buffer-only session.
   - The overlay shape built from it (`recording.rs:4974-4980`) is
     therefore record-only.
   - The in-place arm (`recording.rs:5213-5235`) and
     `set_banner_session_shape` (`recording.rs:5331`) then plan every item
     by "Show in recording" alone.
   - Clips is on by default on every platform with a hardware encoder
     (`capture.ts:1451`, `use-studio.tsx:8219-8227`). It is refused only
     on software encoders (`replay_buffer.rs:1127-1143`).
   - Result: while Clips runs, which is nearly always, the macOS preview
     drops every item set to stream only.
   - **This is the owner's Buddy report.** Their Buddy is stream only.
2. **Without Clips, the idle preview never draws Buddy.**
   - Every preview run starts with every overlay flag off
     (`preview_surface.rs:1796-1808`, `1875-1885`, and the other
     `CompositorStartParams` sites in that file).
   - `overlay_leg_plan`'s idle row is "never" (`overlay_layout.rs:440`).
   - A layout saved while no session runs swaps nothing
     (`apply_overlay_layout_to_active_session`, `recording.rs:23390`,
     returns early).
   - Banners, by contrast, draw at idle when either switch is on
     (`banner_leg_carries(None, …)`, `banners.rs:1002-1004`). So the two
     items follow two different idle rules.
3. **Buddy shows only while it is selected.**
   - `buddy_on_primary = buddy_overlay_on_primary || buddy_edit.is_some()`
     (`compositor.rs:8737`). While the Scene editor holds Buddy, the pet
     draws, even with both switches off; deselecting removes it.
   - This was a 2026-10-27 call made without asking (#865).
   - The preview is wrong in both directions: Buddy appears when it goes
     nowhere, and vanishes when it goes to the stream.
4. **A placed banner can be hidden, and nothing on screen says so.**
   - On the live canvas (macOS, preview docked in the Scene tab), the SVG
     stage runs hit-only: every frame, label and badge is `invisible`
     (`scene-stage.tsx:153-162`, `1140-1180`).
   - The toolbar chips carry no badge either. A comment says "The
     stream-only or recording-only badge is on the stage itself"
     (`scene-stage.tsx:840`), but on the live canvas that badge is
     invisible.
   - The Scene list says "Click one to place it on the stage."
     (`banner-inspector.tsx:124`). So a click and a drag place a hidden
     banner without showing it.
   - The preview correctly draws nothing, and the owner sees nothing.
   - **This is the owner's banner report.**
5. **Recording and streaming at once on macOS, the preview shows the
   recording.**
   - The preview presents only the primary leg's IOSurface: the frame
     lease reads only `compositor.frame_store`
     (`compositor_preview_frame_lease.rs:31-48`). That is the same surface
     VideoToolbox encodes (`metal_compositor.rs:697-704`,
     `encoder_bridge.rs:7875`).
   - A record+stream session with a split stream leg composes the stream
     on its own `MetalSceneCompositor` (`compositor.rs:5531`). The preview
     never sees that leg (`compositor.rs:9364-9375`).
   - So every stream-only item is missing from the preview for the whole
     session.
   - The split needs the encoder bridge, VideoToolbox, and profiles inside
     `separate_provider_roles_fit_bridge_envelope`
     (`recording.rs:24032-24052`): any size at 30 fps, at most 1920×1080
     above 30 fps. The owner's 4K30 record+stream qualifies (inferred from
     the rule, not from a log line).
6. **Windows and Linux draw a different preview.** These are mostly
   Electron proof-surface paths.
   - **Windows idle and Linux always:** main draws the raw source frames,
     the background, the takeover and the banners.
     - The banner filter is "shown and either switch", whatever the
       session (`main/preview-surface-banners.ts:33-37`).
     - There is no Buddy layer at all (`index.ts:5083-5146`).
   - **Windows D3D11 media session:** the preview is its own `PreviewBgra`
     texture.
     - In record+stream it draws the stream leg's overlays and skips the
       recording leg's (`windows_d3d11_session.rs:1930-1957`, `1975-1993`,
       `2037-2043`). That is the mirror image of macOS.
     - Its Buddy and highlight switches apply only at the next start
       (`recording.rs:23447-23451`).
   - **With Clips on:** the Windows and Linux preview shows stream-only
     banners that the ring doesn't record.
7. **No gate reads the preview.**
   - `smoke:banners` and `smoke:buddy-pet` sample recorded artifacts. The
     preview smokes check status and timing.
   - Nothing compares the preview's pixels with what an output carries,
     and nothing checks overlays in Clips.

Found along the way (not fixed by this plan unless a slice says so):

- The `OverlayLayout::default` doc says "Buddy: bottom right, on both", but
  the code ships it off and off (`overlay_layout.rs:258`, `273`). S1 fixes
  the comment.
- Editor chrome (the selection frame and handles) burns into the primary
  frame during a buffer-only lease (`compositor.rs:1185-1194`,
  `7544-7577`). So a clip saved while you edit the Scene shows the
  selection frame. See "Out of scope".

## The rule

The **program** is the picture that goes out: every layer that at least
one running output carries. While nothing runs, it is every layer that has
at least one output switch on. **The Preview shows the program.**

Per item (the highlight card, captions, Buddy, each banner):

| What runs | The Preview draws the item when | The primary leg burns it when | Today's Preview (macOS) |
| --- | --- | --- | --- |
| Nothing (Clips off) | either switch | either switch (no output) | banners: either; Buddy: never |
| Clips only (the default idle) | either switch (program leg, Phase 2) | Show in recording (D2, unchanged) | recording switch only |
| Record only | Show in recording | Show in recording | same |
| Stream only | Show on stream | Show on stream | same |
| Record + stream, one shared leg | either switch | either switch (D13 fallback) | same |
| Record + stream, split stream leg | either switch (program leg, Phase 2) | Show in recording | recording switch only |
| Record + vertical stream | either switch (horizontal) | either switch | same |

"Program leg" means the Preview presents its own picture, composed from
the same tick, whenever the primary leg can't be the program. On macOS
that is a Clips ring at idle, or a split stream leg, with at least one
item that only the stream (or, at idle, only "Show on stream") carries.
Every other row presents the primary exactly as today.

Plus:

- A hidden banner, and an item with both switches off, are never drawn in
  the Preview (D3, D4).
- An item that only one running output carries is still drawn. The Scene
  chip says which output ("stream only").
- The vertical picture is never the Preview. The Scene stage's "Overlays
  on: Vertical" toggle stays the way to see it (out of scope).
- `overlay_leg_plan` keeps meaning "what each output carries". The program
  is a separate pure function, so captions' and the highlight's own plans
  (`captions.rs:683`, `736`) never change.
- Captions follow their own plan (plan 090 on one shared encode). Their
  program is "burned on any running leg", and captions exist only while a
  session runs.

## What the user will see

- **Buddy on stream, nothing running:** on the Scene page, turning on
  "Show on stream" for Buddy puts the pet in the picture where it sits, at
  once, with Clips on or off. It stays there after you click away. Turn
  both switches off and it leaves; its chip says "Off".
- **Add a banner:** it shows at once, in the picture and on whatever
  output its switches allow (D3). If four already show, or a running
  session can't take a new one, it is added hidden and the list says why.
- **Show and Hide a banner:** Show puts the banner in the picture and Hide
  fades it out. Selecting a hidden banner puts "Hidden" on its chip, with
  Show right there. The picture draws nothing for it.
- **Record:** items set to stream only leave the picture, because the
  recording won't have them, and their chips say "Stream only". Stop
  brings them back.
- **Go Live:** items set to recording only leave the picture.
- **Record and Go Live together:** everything that goes to either output
  is in the picture. On macOS this lands in Phase 2. Until then,
  stream-only items are missing while both run, and their chips say
  "Stream only".
- **Clips:** a clip holds what the recording would: each item's "Show in
  recording" switch decides (D2). So a stream-only Buddy is in the Preview
  but not in a clip saved while nothing runs. On macOS the Preview's half
  of this lands in Phase 2.
- **Windows and Linux:** banners follow the same rule after Phase 1.
  Buddy appears in the Preview after Phase 3.

## Owner decisions

**Answered by the owner, 2026-10-27:**

- **D1: the program** ("yes everything").
- **D2: clips follow "Show in recording"** (the alternative): "for
  captions, buddy etc we need to have option if it's going to end up in
  the recording". The ring keeps the recording plan it has today, and the
  idle Preview gets Phase 2's program leg on macOS. Windows and Linux need
  no extra path, because their idle Preview is the proof surface, which
  main draws from the program (S2, S9). Under Clips on Windows, S8 covers
  the D3D11 session.
- **D3: a banner you add shows** (asked again, answered "Added banners
  show"): "it should be in the preview so user can see how his
  livestream / recording looks". A hidden banner is still never drawn,
  and its chip and inspector say so.
- **D4: stop drawing an off Buddy while it is selected** ("buddy should
  be enabled by user optionally, and there is option to display on
  recording or not").
- **D5: build Phase 2** ("build").
- **D6: as recommended** (Buddy's layer as a BGRA frame).

The original options follow, for the record.

- **D1. What the Preview shows.**
  - **Recommended:** the program: every layer at least one running output
    carries, and while nothing runs, every layer with a switch on. An item
    only one output carries is still drawn, and the Scene chip names that
    output.
  - Alternative A: the stream while live, the recording otherwise. Items
    for the other output vanish, for example the owner's recording-only
    captions while live.
  - Alternative B: a Preview picker (Program / Recording / Stream). This
    means more UI, and the owner's "simple actions" rule argues against it.
- **D2. What a clip saved while nothing runs contains.**
  - **Recommended:** the program, the same picture as the Preview.
    `CONTEXT.md` already says Clips "keeps the last minute of the
    program". This needs no extra layer at idle, and it also fixes the
    Windows and Linux mismatch (their Preview shows stream-only banners the
    ring doesn't record).
  - Consequence: a stream-only Buddy appears in idle clips. A clip saved
    while a recording or a stream runs is unchanged.
  - Alternative: clips follow "Show in recording". The idle Preview would
    then need Phase 2's program leg on macOS, plus a separate path on
    Windows and Linux, before the Buddy report is fixed.
- **D3. A hidden banner you are placing.**
  - **Recommended:** the Preview never draws it. Its chip says "Hidden",
    and the selected banner's inspector puts Show first, with the line
    "Hidden. Viewers don't see it."
  - The Scene list copy becomes "Your images on the picture. Click one to
    place it; Show puts it on the picture."
  - Alternative B: a hidden banner's first drag or snap shows it. This
    breaks pre-placing a sponsor banner to show later.
  - Alternative C: a dimmed ghost while selected. That is a lie on a
    surface that claims to be the truth, and on macOS it would also burn
    into Clips.
- **D4. Buddy held by the Scene editor while it is off for both outputs.**
  - **Recommended:** stop drawing it. This reverses the 2026-10-27 call,
    which was made without asking. The editor's drag still moves a Buddy
    that is on.
  - Alternative: keep the exception, so the Preview shows a Buddy no
    output carries while it is selected.
- **D5. Record + stream with a split stream leg (macOS).**
  - **Recommended:** a program leg for the Preview (Phase 2). It is drawn
    only while the program differs from the recording, so it costs nothing
    otherwise.
  - Alternative: accept the gap and rely on the "Stream only" chip words.
    Phase 2 is then dropped.
- **D6. Buddy on the Windows and Linux proof surface.**
  - **Recommended:** the backend serves Buddy's layer (pet and bubble) as
    one small BGRA frame per tick. Main draws it at its rect, with the same
    animator and the same bubble (Phase 3).
  - Alternative A: a still image of the persona in the rect.
  - Alternative B: a documented gap. Phase 3 is then S8 only.

## Slices

### Phase 1: one rule everywhere, and the words

#### Slice S1: the program rule in the backend (Rust)

**Route / lane:** Implementation, fit 9, `fable-5.1`. It spans recording,
Clips and the compositor, and preview parity is release-critical.

**Files:** `overlay_layout.rs`, `banners.rs`, `compositor.rs`,
`recording.rs`, `preview_surface.rs`, and their tests.

**Changes:**

1. **The program rule.** Add a pure
   `program_shows(shape: Option<OverlaySessionShape>, show_on_stream, show_in_recording) -> bool`
   in `overlay_layout.rs`, with a doc table that matches "The rule".
   - `None` means no output runs: either switch.
   - Otherwise: the union of the running outputs' plans.
   - Add an exhaustive table test next to
     `overlay_leg_plan_table_covers_every_session_shape_and_switch_pair`
     (`overlay_layout.rs:922`).
   - Leave `overlay_leg_plan` unchanged.
2. **Clips keeps the recording plan (D2, owner).** A buffer-only session
   keeps planning every item by "Show in recording", exactly as today
   (`recording.rs:4974-4980`, `5218-5233`, `5285-5316`, `5331`). No change
   here; Phase 2 gives the Preview its own picture while it runs. Add one
   test that pins it: a buffer-only session with a stream-only Buddy and a
   stream-only banner burns neither on the primary.
2b. **A banner you add shows (D3, owner).** In the `banners.importImage`
   handler (`main.rs`, after `import_banner` succeeds), call
   `banners::show_banner` with the same canvases and session gate the
   `banners.show` handler passes. If that refuses (four showing, the
   prepare budget, or a session that can't draw a new banner), keep the
   banner hidden and still answer `ok` with it; the list's existing
   `showLimitReason` explains why. One `on_banners_changed` after both.
   - `import_banner` itself keeps creating hidden rows (its tests pin
     the store); only the RPC shows.
   - Update the renderer comment at `use-studio.tsx:1744` ("Never shows
     the new banner") and `docs/banners.md`'s Import line.
   - Test: an import while nothing runs answers a shown banner; an import
     with four showing answers a hidden one.
3. **The idle Preview follows the layout.**
   - Preview runs start with highlight and Buddy flags from
     `program_shows(None, …)` over the stored layout, instead of `false`
     (every `CompositorStartParams` site in `preview_surface.rs`).
   - A layout saved while no session runs swaps the idle run's flags in
     place (`update_overlay_flags`).
   - `release_compositor_capture_lease` (`compositor.rs:3548`) restores
     the flags for the **current** layout, not the ones captured at arm
     time.
   - When Buddy joins the idle run, ask `state.buddy_sprite.prepare` for
     the preview canvas, so the pet's first frame is not late.
4. **No editor exception (D4).**
   - `buddy_on_primary` becomes `buddy_overlay_on_primary` alone.
     `buddy_edit.flatten()` still moves a Buddy that is on.
   - Update `a_buddy_draft_draws_the_pet_where_the_editor_drags_it`
     (`compositor.rs:20379`) to turn Buddy on.
   - Add the test `an_off_buddy_held_by_the_editor_draws_nothing`.
5. Fix the `OverlayLayout::default` doc comment (Buddy is off and off).

**Tests to update** (from the research; re-check each):

- `overlay_layout.rs:922`, idle and record-only rows: unchanged. The
  program is a new function.
- `banners.rs:2400` `banner_leg_plan_follows_the_overlay_table_and_the_idle_rule`:
  unchanged (D2 keeps the record plan for Clips).
- `recording.rs:34617` `buffer_only_session_never_arms_separate_source_recordings`:
  unchanged.
- `compositor.rs:21327` `install_banner_set_swaps_the_set_and_touches_nothing_else`.

**New tests:**

- A buffer-only lease with a stream-only Buddy has `buddy_on_primary`
  false, and a stream-only shown banner does not draw on its primary
  (D2: the ring is a recording).
- The idle run (no lease) with a stream-only Buddy has `buddy_on_primary`
  true.
- A layout saved at idle swaps the idle flags.
- A lease release restores the flags of the layout saved during the
  session.
- A record-only session still drops a stream-only Buddy.

**Verification:**

- `cargo test -p videorc-backend overlay_layout`
- `cargo test -p videorc-backend banners`
- `cargo test -p videorc-backend compositor::tests::` with filters for
  overlay, buddy, banner and lease
- `cargo test -p videorc-backend replay`
- `cargo clippy -p videorc-backend -- -D warnings`
- `cargo fmt --check --all`

**Done when:** the program table test passes; the idle run (no Clips)
with the owner's layout (Buddy stream only, a banner stream only) has both
on the primary; a buffer-only session and a record-only session still
have neither; an imported banner comes back shown.

#### Slice S2: the TypeScript twin and the proof surface's banner rule (main)

**Route / lane:** Implementation, fit 8, `gpt-6.1-sol`.

**Files:** `renderer/src/lib/overlay-layout.ts`, a new fixture
`protocol-fixtures/preview-program.json`, `main/preview-surface-banners.ts`
and its test, and `main/index.ts` (the `buildPreviewSurfaceScene` caller).

**Changes:**

1. `programShows(shape | null, showOnStream, showInRecording)` in
   `overlay-layout.ts`. The fixture
   `protocol-fixtures/preview-program.json` is reproduced exactly by Rust
   (a test in `overlay_layout.rs`) and TS, the same pattern as
   `banner-geometry.json`.
2. `previewSurfaceVisibleBanners` takes the running session's shape and
   filters with `programShows`.
   - Main reads the shape from the recording status it already holds. No
     session, or a buffer-only one, gives `null`: the Preview shows the
     program at idle even while the ring records only the recording plan
     (D2).
   - Today's idle behaviour is unchanged. A record-only session now drops
     a stream-only banner from the Windows and Linux Preview, as the
     recording does.
   - Update `preview-surface-banners.test.ts:100` and add session cases.

**Verification:** `pnpm --filter @videorc/desktop test -- overlay-layout preview-surface`,
`cargo test -p videorc-backend preview_program`, `pnpm typecheck`,
`pnpm lint`.

**Done when:** Rust and TS agree on every fixture row, and the proof
surface's banner list follows the session.

#### Slice S3: the words you can see (Scene page UI)

**Route / lane:** UI/Product Design, fit 9, `opus-5.5`. Load
`.claude/skills/videorc-design/SKILL.md` and the shadcn skill first.

**Files:** `components/scene/scene-stage.tsx`,
`components/scene/overlay-stage.ts`,
`components/scene/banner-inspector.tsx`, their tests,
`components/tabs/layout-tab.tsx`.

**Changes:**

1. **The chips carry the badge.** Every Buddy, highlight, captions and
   banner chip in the stage toolbar shows its state word: "Hidden", "Off",
   "Stream only" or "Recording only". Use the existing `StageItemBadge`
   from `overlayStageItems` and `bannerStageItems`, styled as a quiet
   suffix like a source name's, in the design system's muted tone.
   - Replace the comment at `scene-stage.tsx:840`.
   - On the live canvas the chip is the only visible place for this word.
   - The schematic keeps its own badge on the stage.
2. **The selected hidden banner (D3).**
   - The inspector's first row reads "Hidden. Viewers don't see it.",
     with the Show toggle beside it. It reads "Showing" with Hide when
     shown.
   - The Scene list description becomes "Your images on the picture.
     Click one to place it." (a banner you add already shows, S1 2b).
   - The Assets import's toast or row (if any) no longer says the new
     banner is hidden; check `use-studio.tsx` around `banners.importImage`
     and the Assets banner list.
3. **Buddy off (D4).** The selected Buddy's inspector, with both switches
   off, says "Off. Viewers don't see Buddy." above the two switches.
   - Keep the persona's name rule from `CONTEXT.md` ("Buddy", no
     article).
4. Light and dark both (owner rule). Copy goes to the owner for review in
   the PR body.

**Verification:** `pnpm --filter @videorc/desktop test -- overlay-stage banner-inspector scene-stage`,
`pnpm typecheck`, `pnpm lint`, `pnpm format:check`, plus a by-eye pass in
both themes on the docked live canvas and the schematic.

**Done when:** with the owner's state (hidden banner, Buddy stream only),
the live canvas's chips say "Hidden" and "Stream only", and the inspector
of the selected banner says it is hidden, next to Show.

#### Slice S4: a gate that reads the Preview, the docs, and Phase 1 gates

**Route / lane:** Implementation, fit 8, `gpt-6.1-sol`. Escalate to
`fable-5.1` if the IOSurface read misbehaves.

**Files:**

- Backend: a dev-only RPC in `main.rs` and `compositor.rs`
  (`compositor_preview_frame_lease.rs` for the frame).
- New `scripts/smoke-preview-truth-app.mjs`, plus a `smoke:preview-truth`
  entry in `package.json`.
- `docs/overlays.md`, `docs/banners.md`, `docs/buddy.md`, `CONTEXT.md`,
  `plans/README.md`.

**Changes:**

1. **The Preview oracle.** A new read-only RPC `preview.debug.sample`,
   with `{ rects: [{ x, y, w, h }] }` in canvas fractions.
   - It returns `{ frameId, width, height, samples: [{ r, g, b }] }`, the
     mean colour of the middle fifth of each rect.
   - It reads the very frame the Preview lease hands out: the IOSurface on
     Metal (lock read-only, BGRA), or the CPU yuv420p frame otherwise.
   - It is refused in packaged builds, like
     `VIDEORC_YOUTUBE_API_BASE_URL`. It is registered as read-only in the
     method policy table, so it never takes a mutation lane.
   - It is never added to the renderer's RPC contract. Only smokes call
     it, over `connectBackend`.
2. **`smoke:preview-truth`** (macOS dev app; reuse `smoke-banners-app.mjs`
   helpers and `scripts/lib/buddy-pet-fixture.mjs`).
   - **Fixtures:**
     - banner A: a magenta strip, stream only;
     - banner B: a cyan logo, recording only;
     - banner C: yellow, hidden;
     - Buddy wearing the fixture pet, stream only, placed apart from the
       banners.
   - **Cases:** for each, the oracle samples A, B, C and the pet box, and
     every artifact is sampled at the same rects with ffmpeg.
     1. Clips off, nothing running: A, B and Buddy are drawn; C is not.
     2. Clips on, nothing running: a saved 30-second clip has B only
        (D2: the ring follows "Show in recording"). The Preview half (A,
        B and Buddy drawn) is skipped with the reason "plan 205 Phase 2"
        until S6 lands; S7 unskips it.
     3. Record only: B only. The recording matches the Preview.
     4. Stream only, to the local RTMP listener from
        `smoke-comment-highlight-stream-app.mjs`: A and Buddy only. The
        received stream matches.
     5. Record + stream with one shared leg: A, B and Buddy, in both
        artifacts. A profile outside
        `separate_provider_roles_fit_bridge_envelope`
        (`recording.rs:24032`) gives one shared leg, for example 1440p60
        (above 30 fps and wider than 1920). Confirm it from the session's
        `overlay leg plan` log line (`aux=false`). Never disable the
        encoder bridge to get there: `VIDEORC_ENCODER_BRIDGE` changes the
        whole pipeline.
     6. Buddy off and selected (a held `overlay:buddy` draft): no pet.
     7. Show and hide while idle: C appears within 300 ms of Show (the
        200 ms fade), and A leaves within 300 ms of Hide.
     8. Add a banner while idle (`banners.importImage` of a fourth,
        green fixture): it answers shown, and the Preview draws it within
        300 ms (D3).
   - Case 9, record + stream with a split leg, is **skipped with a named
     reason** ("plan 205 Phase 2") until S7 adds it.
   - **Traps:**
     - unset `ELECTRON_RUN_AS_NODE`;
     - the dev app has no camera grant, so seed a test-pattern or
       image scene;
     - with a camera present, Clips refuses starts (see plan 193's notes).
3. **Docs.**
   - `docs/overlays.md`: add "The Preview shows the program", with the
     table from "The rule". Change the idle and Clips wording. Remove "a
     stream-only item does not appear there during a split" once Phase 2
     ships.
   - `docs/banners.md` and `docs/buddy.md`: change their preview
     sentences to match.
   - `CONTEXT.md`: a **Program** entry ("What goes out: every layer at
     least one running output carries, and while nothing runs, every layer
     with a switch on. The Preview shows the program; Clips keeps it.").
4. **Phase 1 gates, once at the end** (proportionate, per the owner):
   - all S1 and S2 unit tests;
   - `pnpm typecheck`, `pnpm lint`, `pnpm format:check`;
   - `pnpm --filter @videorc/desktop test`;
   - `cargo clippy -p videorc-backend -- -D warnings`;
   - `pnpm smoke:preview-truth`, `pnpm smoke:banners`,
     `pnpm smoke:scene-item-drag`, `pnpm smoke:buddy-pet`,
     `pnpm smoke:replay-buffer`;
   - `pnpm smoke:recording-studio`, because AGENTS.md requires it for
     layout composition and preview changes;
   - a quiet-host `pnpm smoke:preview-performance` with Buddy on, against
     a base worktree: the idle Preview now animates the pet every frame.
   - Note: the eager gzip budget (`videorc-renderer-budget-gzip-drift`)
     matters only if S3 grows the eager bundle.

**Done when:** the smoke passes cases 1 to 8 (case 2's Preview half
skipped by name) and the gates are green, or each red is shown to be the
same on `origin/main`.

### Phase 2: the Preview's own picture (macOS: Clips at idle, and a split record + stream)

#### Slice S5: measure, then choose the program leg's shape (spike, no product change)

**Route / lane:** Diagnose, fit 9, `fable-5.1`.

Two designs. Build the twin first and measure it against the bar below on
this Mac; prototype the plate (in a throwaway branch, never merged) only
if the twin fails the bar, since the plate can only win when the twin
fails. Two test sessions, each with a stream-only Buddy and banner:

- Clips at idle (the owner's default: the ring at the output size, 4K30);
- a 4K30 record + stream session to the local RTMP listener (split leg).

- **Program twin (default).** One more Metal composition of the same
  snapshot (the second at idle under Clips, the third in a split) at the
  Preview's drawable size and canvas aspect, or at the primary's size if
  that reuses every prepared bitmap and stays inside the bar. It draws the
  program's items: the stream-only items from the aux leg's bitmaps,
  scaled with the linear sampler that banners already use while a prepare
  is pending, and the recording items from the primary's. It is published
  as the Preview's frame (its own 3-slot IOSurface ring, its own frame
  store for the lease). The present path is unchanged: still one surface
  id. This is the Windows D3D11 design, where `PreviewBgra` is already a
  separate texture.
- **Plate.** A transparent premultiplied BGRA ring holding only the
  difference set, blended over the primary in the addon's present pass.
  This needs:
  - a new One/OneMinusSrcAlpha pipeline (the current blend is
    straight-alpha, `metal_compositor.rs:2635-2643`);
  - a second texture in `encode_texture_present`;
  - a separate import cache (each cache miss evicts entries of a
    different size: `lib.rs:275-276`);
  - new handoff fields across Rust, TS and the addon.

**Measure:**

- GPU time per tick, p50 and p95;
- encoder fps, and the primary's frame age;
- the extra IOSurface memory;
- the Preview's present fps (helper `--present-benchmark` baseline, about
  120 fps healthy);
- by eye: Buddy's edges and the bubble's text at the docked size.

**Done when:** the plan's "As built" records the numbers and the choice.
The twin is the choice unless it adds more than 2 ms p95 per tick, or
costs the encoder a frame, while the plate does not.

#### Slice S6: the program leg (backend, addon if the plate wins)

**Route / lane:** Implementation, fit 9, `fable-5.1`.

**Changes (twin):**

1. `preview_needs_program_leg(shape, layout, banners, caption plan)`, a
   pure function. It is true when some item is `program_shows` and not
   burned on the primary. On macOS that happens in two shapes:
   - a buffer-only (Clips) session at idle, whose primary burns by "Show
     in recording" while the program is "either switch" (D2);
   - a split stream leg.
   - Evaluate it at session start and at the Clips arm in place, and
     again whenever `apply_overlay_layout_to_active_session`, a banner
     change (show, hide, switches) or a captions change re-plans.
2. While it is true:
   - the run composes the twin after the primary, from the same snapshot,
     sources and `published_at`;
   - the live background is the primary's same-tick frame (plan 193's
     `shared_live_frame`);
   - banner prepares include the twin's canvas (`banner_canvases`);
   - Buddy gets a `BuddySpriteLeg` for the twin's canvas;
   - `preview.frameReady` and `preview.surface.frame.acquire` hand out the
     twin's IOSurface.
3. While it is false, the Preview presents the primary exactly as today,
   with no extra GPU work. Switching between the two never drops a
   presented frame: the lease keeps the last surface until the new one
   has published.
4. The first-frame contract and source liveness
   (`apps/desktop/src/main/native-preview-first-frame.ts`) read the twin's
   evidence fingerprint, which is the same sources.
5. Status: `frame_pipeline.preview_program_leg: bool`. Add it to
   `backend-rpc-contract.ts`; the strict-contract trap applies.

**If the plate wins:** the same trigger and the same items, but drawn into
the plate ring. Add the plate's id, width and height to
`CompositorFrameReady`, `CompositorMetalTargetHandoff`,
`NativePreviewMetalTargetHandoff`, `backend-rpc-contract.ts` and
`electron-ipc-contract.ts`, plus the addon napi `present_native_preview`.
The lease keeps the plate alive, and the addon gets a premultiplied blend
in `encode_texture_present`. `PreviewSurfaceBounds` needs no change.

**Verification:**

- unit tests for `preview_needs_program_leg` across the session table;
- compositor tests: a split session, and a buffer-only lease, each with a
  stream-only Buddy, publish a Preview frame that has the pet and a
  primary frame that does not;
- `cargo test`/`clippy` filters.

**Done when:** with Clips at idle and in a split session, the oracle sees
the stream-only Buddy in the Preview while the clip and the recording
artifact do not have it.

#### Slice S7: Phase 2 gates

**Route / lane:** Implementation, fit 8, `gpt-6.1-sol`.

- `smoke:preview-truth`: unskip case 2's Preview half (Clips at idle:
  the Preview has A, B and Buddy while the clip has B only) and case 9,
  record + stream with a split leg (the Preview has A, B and Buddy; the
  recording has B only; the stream has A and Buddy).
- `pnpm probe:preview-lifecycle` and `pnpm probe:preview-window`.
- `pnpm smoke:preview-surface`, `pnpm smoke:recording-native-preview`.
- `pnpm smoke:recording-studio`, and `pnpm smoke:record-latency:gate`
  (the session start path changes).
- `docs/overlays.md`: remove the split caveat.

**Done when:** all of the above are green, or each red is shown to be the
same on `origin/main`.

### Phase 3: Windows and Linux

#### Slice S8: the Windows media session's Preview draws the program

**Route / lane:** Implementation, fit 8, `fable-5.1`. Windows-only code
paths.

- In `windows_d3d11_session.rs` (`1930-1957`, `1975-1993`, `2037-2043`),
  the `PreviewBgra` composition takes every item `program_shows` for the
  session: the recording leg's items and the stream leg's. Today it takes
  only the aux leg's when one exists.
- Each encoded leg keeps its own plan.
- Tests: extend `windows_d3d11_session.rs:3787` and `4295`.
- The start-time-only Buddy and highlight switches
  (`recording.rs:23447-23451`) stay as they are, and stay stated in the
  log (out of scope).

**Verification:** Windows CI (`Windows source gates`), plus a Windows
tester pass in S10.

#### Slice S9: Buddy on the proof surface (D6)

**Route / lane:** Implementation, fit 8, `fable-5.1`.

- **Backend:**
  - while the program shows Buddy and the Preview is a proof surface (no
    native preview), render Buddy's layer (the pet's current cell and its
    bubble) into a small straight-alpha BGRA frame at its rect on the
    proof surface's canvas (`DEFAULT_PREVIEW_CANVAS`, 1280×720);
  - serve it at `/preview/buddy/latest.bmp`, beside the camera and screen
    routes (`main.rs:604-605`), with its rect and sequence;
  - use the same animator clock as the legs (`buddy_sprite.clock_seconds`).
- **Main:** `buildPreviewSurfaceScene` adds the layer in the program's z
  order: above banners and captions, under the highlight card
  (`docs/banners.md` z order).
- **Tests:**
  - the BGRA blit against the yuv blit for the same cell;
  - main's layer order;
  - a proof-surface `capturePage` case behind the smoke command server
    (Windows and Linux).

#### Slice S10: Windows and Linux acceptance (owner and tester)

- The Windows tester runs:
  - idle, with Clips on and off;
  - record only, stream only, and record + stream (D3D11 session);
  - Buddy stream only, and a banner stream only.
  Record by eye with screenshots. Write the waiver if needed (the owner's
  standing permission covers Windows waivers).
- The Linux box from `docs/linux-port-plan.md` runs the proof-surface
  smoke case.

## Verification summary

| Phase | Gate | Why |
| --- | --- | --- |
| 1 | S1 to S3 unit tests, `typecheck`, `lint`, `format:check`, desktop tests, clippy | logic and contracts |
| 1 | `smoke:preview-truth` cases 1 to 7 | the rule, read from the Preview itself |
| 1 | `smoke:banners`, `smoke:buddy-pet`, `smoke:scene-item-drag`, `smoke:replay-buffer` | nothing an output carries changed |
| 1 | `smoke:recording-studio`, quiet-host `smoke:preview-performance` A/B | AGENTS.md; the idle pet now animates |
| 2 | `smoke:preview-truth` cases 2 and 9, `probe:preview-lifecycle`, `probe:preview-window`, `smoke:preview-surface`, `smoke:recording-native-preview`, `smoke:record-latency:gate` | the native preview path changes |
| 3 | Windows CI, tester pass, Linux box | paths macOS can't run |

## Edge cases

- **Pressing Record while Clips runs.** The ring already follows the
  recording plan; the program leg turns off at the hand-over, because a
  record-only session's program is the recording. A stream-only Buddy
  leaves the Preview at the first recorded frame, which is truthful, and
  its chip says "Stream only".
- **A banner's timer hides it.** It fades out of the Preview like a Hide.
- **Four banners showing (the cap).** No change.
- **Clips refused on a software encoder.** No buffer-only session runs,
  so the idle rule applies: the same picture.
- **A takeover showing.** Banners stay above it. If plan 202's "Show on
  takeovers" lands, its gate applies to the program the same way.
- **The vertical stream.** The Preview shows the horizontal program. The
  stage's Vertical toggle shows the vertical one as a schematic.
- **Buddy's bubble at idle.** A Say while nothing runs shows in the
  Preview, and in idle clips only if Buddy is "Show in recording".
- **Highlight at idle.** Rare, but it follows the program like the rest.
- **The idle canvas size.** With no lease, the idle run is at the surface
  size; under Clips, it is at the output size. Buddy's atlas and the
  banner prepares follow `banner_canvases`, so both are covered.

## STOP conditions

- S1: any change to a buffer-only session's pipeline decisions (the
  encoder, the bridge, the frame consumer or the ISO arming). Only the
  idle run's overlay flags may change.
- S6: the program leg changes what the ring, a recording or a stream
  carries, or adds GPU work while `preview_needs_program_leg` is false.
- S1: any recording or stream artifact gains or loses an item in
  `smoke:banners` or `smoke:buddy-pet`.
- S4: the oracle cannot read the presented frame without taking the
  Preview lease from main. Report it; do not add a second lease holder.
- S5: neither design stays inside the measurement bar. Report the numbers
  and stop Phase 2; Phase 1 stands on its own.
- S6: switching between the twin and the primary drops or blanks a
  presented frame in `probe:preview-lifecycle`.
- S8: the Windows encoded legs change.

## Out of scope

- Editor chrome burning into Clips during a buffer-only lease (found along
  the way). A plate would fix it for free if S5 picks the plate; with the
  twin, it needs its own small plan.
- Mid-session Buddy and highlight switches on the Windows D3D11 session.
- A Preview picker for Recording or Stream (D1 alternative B).
- Showing the vertical picture in the Preview.
- Any change to what a recording, a stream or a clip saved during a
  session carries.

## Risks

- **Idle cost.** The idle Preview now draws an animated pet whenever Buddy
  is on for an output. Measure in S4 against a base worktree on a quiet
  host; host GPU load is uncontrolled (`videorc-smoke-ab-base-worktree`).
- **Idle Clips cost (D2).** With a stream-only item and Clips on (the
  owner's default), the Preview's program leg composes every tick at
  idle. S5's bar applies to that session too.
- **Added banners show (D3).** A banner added while live goes on air at
  once. The release notes must say so.
- **Phase 2 touches the Preview's frame source.** It is the most
  load-bearing path in the app (`videorc-native-preview-definitive-plan`).
  It is gated behind `preview_needs_program_leg`, so the common session
  shapes never take the new path.
- **The aux-leg trap.** Any new layer must reach every leg it belongs on.
  S6's twin draws from the same inputs; S7's case 9 proves the stream.

## As built

### Phase 2 (S5, S6, S7), 2026-10-27, uncommitted in `~/projects/videorc-wt-205`

**What was built (the twin, at the primary's size).** `preview_needs_program_leg`
(`compositor.rs`, pure, table-tested) is true when some item is in the
program and not on the primary leg: a buffer-only Clips lease at idle or a
split stream leg, with a stream-only highlight, Buddy, banner or an
aux-only caption bar. While it is true and a Preview surface is live, the
run composes the program leg last in the tick on its own lazily built
`GpuCompositor` and 3-slot IOSurface ring into `program_frame_store`:
the same snapshot (editor draft and chrome included), sources, sequence,
`captured_at`/`published_at`, the primary's same-tick live frame, the
program's items (`BannerLeg::Program`, the Buddy from the Primary atlas at
the primary's canvas, captions/bubble from the Primary raster or the
Auxiliary one), at the primary's canvas, so every prepared bitmap is
shared. `presented_frame_store` (the lease and the oracle) returns the
program store while its frame is current (this tick or the one before),
the primary's else; `preview.frameReady` carries the twin's handoff. The
first tick the trigger is false the twin's compositor is dropped and its
store emptied, so nothing runs on the GPU and the lease falls back to the
primary's surface without a dropped or blank frame. Status:
`framePipeline.previewProgramLeg` (left off the wire while false; TS type
updated; the contract test covers it inside the bounded payload).
`VIDEORC_PREVIEW_PROGRAM_LEG=0` keeps the primary leg, said once in the
log. The program verdict travels as `OverlayLegFlags::{highlight,buddy}_on_program`
(`for_session(shape, replay_only, layout)`), `CompositorLoopConfig` and
`CompositorArmParams`; a fresh run derives it as primary OR aux (the one
edge: a buffer-only session whose in-place arm was refused runs on a fresh
run and keeps the recording plan in the Preview, as before this plan).

**S5 numbers (this Mac, dev app, test-pattern scene, a stream-only Buddy and
a stream-only banner, 40 s samples, medians).** Whole tick = the loop's
render time per tick (`compositor.status.frameTimeP95Ms`); twin = the
program leg's own compose (`Preview program leg cost` log line, per 2 s
window); encoder = `encoderBridge*InputFps` / dropped frames.

| Session | Twin | Tick p50 | Tick p95 (max) | Twin p50 | Twin p95 | Primary GPU p95 | Encoder fps / dropped | Present fps | Frame age |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: |
| Clips 4K30 idle, run 1 | on | 3.63 | 7.59 (10.4) | 1.25 to 1.46 | 2.50 to 6.17 | 4.66 | 30.00 / 0 | 32.0 | 2 ms |
| Clips 4K30 idle, run 1 | off | 1.68 | 4.45 (9.0) | | | 5.12 | 29.99 / 0 | 31.0 | 1 ms |
| Clips 4K30 idle, run 2 (busier host) | on | 7.50 | 18.1 (25.2) | 1.42 to 5.88 | 7.5 to 12.7 | 8.92 | 29.98 / 0 | 31.0 | 9 ms |
| Clips 4K30 idle, run 2 | off | 1.61 | 7.66 (9.8) | | | 7.05 | 30.00 / 0 | 28.5 | 1 ms |
| Split 1080p30 record + stream | on | 3.65 | 7.06 (15.5) | 0.47 to 0.59 | 0.81 to 4.52 (typ. 1.0) | 5.24 | 30.00 + 30.00 / 0 | 32.0 | 2 ms |
| Split 1080p30 record + stream | off | 2.18 | 6.43 (27.5) | | | 4.54 | 29.99 + 30.00 / 0 | 28.5 | 3 ms |

Extra IOSurface memory: three slots at the primary's size, 99.5 MB at 4K
(`compositorMetalTargetRingSlotsLiveCount` 3 → 6), 24.9 MB at 1080p
(6 → 9). Host GPU load is uncontrolled (run 2 shows it); the encoder never
lost a frame in any run and the Preview's present rate did not move.

**Against the bar (+2 ms p95 per tick, no encoder frame).** The split
1080p30 session passes (+0.6 ms tick p95, twin p95 about 1 ms). Clips at
idle at 4K30, the owner's default, misses it on the quiet run (+3.1 ms tick
p95; the twin's own p95 2.5 to 6.2 ms, p50 1.3 ms) and by more on the busy
run, with the encoder untouched. The cost is the fill rate of one more 4K
target per tick (clear plus draw, then the command wait), so it does not
shrink without a smaller target.

**Decision as built: the twin at the primary's size, on in every row, with
the kill switch; the owner decides whether the 4K idle cost stands.** The
drawable-size twin (the plan's fallback) was not built because two things
make it more than a canvas change: the bubble, caption and highlight
rasters are made for the primary's canvas and `overlay_blit_layout` crops
a raster wider than its canvas rather than scaling it (a 4K bubble on a
1080p twin would be cut), so the Metal overlay placement needs a scaled
path; and a twin canvas that differs from the primary's needs its own Buddy
atlas slot whenever the primary draws the pet too (one slot per leg,
keyed by canvas), i.e. S9's `BuddySpriteLeg::Preview` or a fallback to the
primary's size in that case. Both are contained follow-ups (an estimate: a
1080p-class twin costs about what the split twin costs here, 0.5 ms p50).
The plate was not prototyped (addon blend pipeline, second texture, new
handoff fields across Rust, TS and the addon) for the same reason: it is
only worth building if the owner wants the last millisecond at 4K.

**Gates run (Phase 2):** see the handoff report; `cargo test` filters
`preview_program`, `program_leg`, `overlay`, `banner`, `buddy`, `lease`,
`replay`, `preview_debug`, `preview_surface`; clippy and rustfmt (the
other agent's files excluded); `pnpm typecheck` (blocked by the S9
agent's in-progress `main/index.ts` edit at the time), the contract
tests, `pnpm lint`, prettier; `pnpm smoke:preview-truth` (cases 1 to 4 and
6 to 9; 5 stays a named skip), `pnpm probe:preview-lifecycle`.

**Owner-owed:** by eye on the owner's profile (Clips on, Buddy stream only:
the pet is in the Preview and not in a saved clip; record + stream at 4K30
with a stream-only banner: the banner is in the Preview and the stream,
not the recording); the 4K idle cost call above; the packaged app with a
real camera.
