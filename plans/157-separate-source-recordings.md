# Plan 157: Separate source recordings (screen ISO + camera ISO)

Optionally produce two independently editable local videos from one Record
session: a screen (or window) file with system audio, and a camera file with
microphone audio. The live preview can keep showing the composed layout
(camera-in-screen, side-by-side, freeform); the ISO files are clean source
takes for later NLE work.

## Status and scope

- **Status: EXECUTED, in review, 2026-10-06** on
  `feat/separate-source-recordings` (planned the same day as Plan 153 in a
  dirty checkout; renumbered 157 because 153-156 landed on main first).
  Slices 1-6 are implemented; Slice 7's packaged-app camera take and
  `pnpm smoke:separate-source-take` on it stay with the owner because the dev
  app has no camera TCC grant.
- **Implementation notes (PR behavior versus the specification below):**
  - PR #632 hardening is tracked in [Plan 158](158-harden-separate-source-recordings.md).
    Its production lifecycle and artifact gates supersede the original
    fixture-only acceptance below; acceptance remains in progress until
    that plan records the final results.
  - ISO video is a second and third compositor output
    (`CompositorSourceIsoOutput`, `source_iso_snapshot` in `compositor.rs`):
    one source forced visible and full-frame on the recording canvas, no
    bubble mask, chroma key or background; mirror preserved. Each leg has its
    own VideoToolbox encoder bridge and FFmpeg MKV muxer (`source_iso.rs`).
  - ISO audio comes from the bus ingredients (`source_audio_tap.rs`): the
    processed microphone chunk feeds the Camera tap, the gained system
    contribution feeds the Screen tap (silence while system audio is off).
    Taps drop instead of blocking; drops are counted and logged.
  - `keepCombined: false` is a reserved setting and is refused at start
    (`REFUSAL_DROP_COMBINED`), never a silent single-file fallback. The
    Combined file keeps its legacy name; ISO files insert `-screen` /
    `-camera` before `.mkv`.
  - Library rows use `take_id` + `recording_role` columns. Plan 158 reserves
    both ISO rows before capture and updates each role independently when
    it ends. Private capture paths and bound file identities support crash
    recovery and publication without replacing another file. Healthy roles
    run the ordinary MKV → MP4 finalization job. Audio tracks carry `title` and
    `handler_name` (Mix / System audio / Microphone) so the role survives the
    MP4 export; `scripts/smoke-separate-source-take.mjs` hard-fails a swapped
    pairing, a missing role file, off-canvas video or duration drift.
  - Slice 3/6 proof without a camera device: the backend fixture
    `compositor::scene_switch_tests::source_iso_artifact_fixture` renders a
    camera-in-screen scene with the ISO legs armed (CPU + Metal) and asserts
    per tick that the Screen leg has no camera inset and the Camera leg is the
    camera alone. `session_audio::mix_tests::source_iso_audio_artifact_fixture`
    runs the real bus (440 Hz microphone, 1 kHz system source) with the taps
    armed through `prepare_source_audio_taps` and reads each tap where
    `role_audio_fifo` points the role's muxer: Camera is the microphone alone,
    Screen is the system contribution alone (stereo kept), and the two sum to
    the Combined mix sample for sample. `pnpm smoke:separate-source-fixture`
    (in `smoke:recording-studio`) encodes those legs with that routed PCM into
    a real three-file take and runs the take gate, an audio source gate on the
    decoded samples, frame-exact comparison and the recording analyzer on each
    file, then proves a swapped title pairing and swapped samples under the
    right titles are both rejected.
  - The renderer only sends `separateSourceRecordings` when the toggle is on
    AND the scene is eligible, so a stale toggle never blocks Record; the
    Recording tab shows the exact ineligibility reason.
  - Not done in v1: per-role diagnostics counters in the status payload
    (ISO bridges report under the Recording role), delete-take vs delete-file
    Library actions, and the Windows D3D11 / raw-YUV paths (refused with
    `HEALTH_UNAVAILABLE`).
- **Source baseline:** locally available `origin/main` at `1f0fbbc3`
  (0.9.136-alpha.1 docs). Shared checkout may differ; implement against
  current main in an isolated worktree.
- **Ownership:** one implementation owner for capture/encode/finalization/
  Library contracts; UI/Product Design review for Recording-tab and Library
  take grouping. Cross-system correctness (clocks, stop/finalize, encoder
  headroom) is the main risk.
- **Entitlements (owner confirmed 2026-10-06):** **Free** — no Premium gate.
  Product cost to Videorc is ~zero (no cloud/AI). Runtime cost is on the
  user's machine (extra encoders, disk, finalize time); that is handled by
  preflight/fallback, not by locking the feature behind Premium.
- **Prerequisites:** current recording finalization, split-output encoder
  bridge, native audio mixer (mic + system), Library derivative/session
  model, and record-latency gates must remain green. Plans 151/152 are not
  dependencies.

Implementation must read `AGENTS.md`, preserve unrelated worktree changes,
and leave default single-file recording behavior unchanged when the option
is off.

## What exists and what must change

| Current main | Consequence for this plan |
| --- | --- |
| One `start_session` → one composed compositor leg → one recording MKV → MP4 Library row (`recording.rs`, `pipeline.rs`). | ISO mode needs additional local writers without starting a second capture session. |
| Split-output (Plan 006) encodes recording vs stream at different sizes from the **same composition**. | Reuse multi-writer/bridge patterns; do **not** treat ISO as another composed scale factor. |
| Dual-orientation `simulcast` publishes a second **composed** leg (H + V). | Same fan-out idea, different inputs: source stores, not a second scene composition. |
| Compositor already consumes separate camera/screen `FrameStore`s before composing (`compositor.rs`, `frame_store.rs`, preview camera/screen). | ISO video should encode from those source stores (or a dedicated full-frame ISO store), not from the burned PiP. |
| Native audio mixer sums mic + system into one recording FIFO (`audio.rs`, system-audio graph). | ISO needs per-leg audio taps (system → screen file, mic → camera file) without breaking the composed/stream mix. |
| Library has noise-cleanup **derivatives** with `sourceSessionId` / `processingKind`. | Prefer a first-class **take group** / sibling session model over pretending ISOs are post-processing derivatives. |
| Captions can produce a non-destructive `(captioned)` copy after finalize. | Different lifecycle (post vs live). ISO writers must run during capture. |
| Record latency, recording-matrix, and recording-studio smokes assume one primary artifact. | Gates must learn multi-artifact takes without weakening single-file coverage. |

Relevant areas: `crates/videorc-backend/src/{recording,recording_finalization,encoder_bridge,compositor,audio,pipeline,storage,protocol}.rs`, `apps/desktop/src/shared/backend.ts`, `lib/session-params.ts`, Recording tab, Library tab, `scripts` smoke/analyzer paths.

## Product behavior

### User-facing promise

When **Separate source recordings** is on, one Record/Stop cycle yields two
finished Library videos that can be edited apart and remixed elsewhere:

| File | Video | Audio |
| --- | --- | --- |
| Screen ISO | Full selected display or window, no camera overlay | System audio when selected; otherwise silent (explicit status) |
| Camera ISO | Full selected camera framing (no screen underlay) | Microphone when selected; otherwise silent (explicit status) |

Default remains today's single composed recording. ISO mode is opt-in and
locked for the next session once Record starts (same as other Output
settings).

### Confirmed v1 defaults (owner 2026-10-06)

1. **Keep Combined when ISO is on** (`keepCombined: true`): three local
   files — Combined (preview/layout), Screen, Camera. If encoder headroom
   forces a cut, drop Combined first and keep the two ISOs (document in
   status).
2. **Free** — no Premium / entitlement gate. (See cost note under
   Entitlements above.)
3. **ISO raster** = recording-profile canvas, source fit/contain.
4. **Window capture** counts as the Screen ISO role.
5. **ISO while dual-orientation streaming** is allowed; ISOs stay
   local-only. Refuse only on proven encoder exhaustion.
6. **Preview and livestream stay composed.** ISO is a local-recording
   sidechannel. Stream legs, captions burn-in, and phone remote keep
   current contracts.
7. **Eligibility:** screen or window **and** camera must be selected.
   Disable or refuse ISO with a clear reason when either is missing.
   Microphone / system-audio absence is a warning + silent track, not a
   hard block.
8. **Layout changes mid-session:** if Camera Off or Screen Off removes a
   required source, stop that ISO writer cleanly, keep the other writers,
   and surface a health/status line. Do not invent black filler as success.
9. **Naming:** UI copy **Separate source recordings**; code/docs may say
   `iso` / `source_recording`. File names should be stable and sortable,
   e.g. `videorc-session-<id>-combined.mp4`, `…-screen.mp4`, `…-camera.mp4`.
10. **Library:** one take group — expandable parent or linked siblings
    sharing `takeId` / `sessionId`, with role badges (Combined / Screen /
    Camera). Delete/export actions must be explicit about one file vs
    whole take.
11. **Clocks:** all files share the session timeline epoch so external
    editors can align them at t≈0. Document A/V stop-tail budgets per file.

### Non-goals for v1

- In-app multi-cam timeline editor / mixer that stitches ISOs back together.
- Arbitrary N ISO tracks (extra cameras, browser sources, assets).
- Per-ISO resolution/fps independent of the recording profile (v1: same
  fps as recording; ISO raster = source-native letterboxed/cropped to the
  recording profile canvas **or** native source size — pick one in Slice 1
  and stick to it; recommendation: **recording-profile canvas, source
  fit/contain**, so Library/player behavior stays consistent).
- Windows/Linux ship gate before macOS acceptance (implement with
  platform seams; mark non-macOS as follow-up if capture paths differ).
- Replacing OBS multitrack/mkv chapter hacks; Videorc ships separate MP4s.

## Architecture direction

Do **not** run two `start_session` calls. One capture graph, multiple
local encode/mux writers.

```
screen capture ──► screen FrameStore ──┬──► compositor ──► Combined writer (+ mixed audio)
                                       └──► Screen ISO writer (+ system-audio tap)

camera capture ──► camera FrameStore ──┬──► compositor
                                       └──► Camera ISO writer (+ mic tap)

native audio sources ──► mixer ──► Combined/stream FIFO
                      ├─ system tap ──► Screen ISO audio FIFO
                      └─ mic tap ──► Camera ISO audio FIFO
```

### Protocol / settings

Extend output / capture config (Rust + TS mirrors) with something like:

```ts
separateSourceRecordings: {
  enabled: boolean
  // v1 fixed roles; keep room for later without a rewrite
  keepCombined: boolean // default true
}
```

Wire through `buildStartSessionParams` → `OutputSettings` (or a sibling
field on `StartSessionParams`). Validate at session start; reject illegal
combos with stable reason codes (missing camera, record disabled, etc.).

### Encode / finalize

- Reuse encoder-bridge multi-writer patterns from split-output; give each
  ISO role its own encoded FIFO + muxer path and diagnostics counters.
- Finalization must wait for **all** armed writers (Combined + ISOs), then
  export each MKV→MP4 with the existing repair/color/A-V gates.
- Quit-during-finalize, instant-record Library rows, and recovery must
  know about multi-file takes (partial success is allowed only with
  explicit per-role status — never claim a missing ISO succeeded).

### Library / storage

- Introduce a durable take identity (`take_id` = primary `session_id` is
  fine) and per-artifact `recording_role`: `combined` | `screen` | `camera`.
- List/filter APIs return grouped takes; players open one file at a time.
- Markers/clip marks (Plan 151) attach to the take timeline; v1 playback
  seeks the Combined file when present, else Screen.

### Performance guardrails

- Extra VideoToolbox (or platform) encoders compete with Combined + stream.
- Preflight: if ISO + Combined + stream (+ simulcast) exceeds a measured
  budget, refuse Combined keep, lower ISO raster, or refuse ISO with a
  clear message — never silent quality collapse.
- Record-latency cold/warm budgets remain owned by Combined start/stop;
  ISO arming must not push click→recording past calibrated gates without
  an explicit budget revision doc.

## Owner decisions (locked 2026-10-06)

| # | Question | Decision |
| --- | ---: | --- |
| D1 | Keep Combined when ISO is on? | **Yes** (`keepCombined: true`). |
| D2 | Free or Premium? | **Free** — no entitlement gate. Runtime cost is user-local (CPU/GPU/disk), not a Videorc billable cost. |
| D3 | ISO raster = profile canvas or native source pixels? | **Profile canvas**, contain/fit. |
| D4 | Window capture counts as “screen ISO”? | **Yes** — role stays `screen`. |
| D5 | ISO while streaming dual-orientation? | **Yes**; ISO remains local-only; refuse only on proven encoder exhaustion. |

## Battle order (slices)

1. Product contract + protocol mirrors + eligibility
2. Audio taps (mic / system) without breaking mixed recording
3. Screen + camera ISO video writers on the live capture graph
4. Finalization, Library take grouping, naming
5. Recording-tab / Library UI
6. Smokes, analyzer multi-artifact, latency/matrix interaction
7. Device acceptance + docs

Each slice leaves default single-file recording green.

---

## Slice 1 — Contract, protocol, eligibility

**Goal:** Represent the option end-to-end without encoding a second file.
**Depends on:** none
**Touches:** `protocol.rs`, `apps/desktop/src/shared/backend.ts`,
`lib/capture.ts` / `session-params.ts`, start-session validation in
`recording.rs`, focused serde/normalization tests.
**Steps:**
1. Add `separateSourceRecordings` (enabled + keepCombined) with defaults off/true.
2. Validate: requires `record_enabled`, camera + (screen|window); emit stable refusal codes.
3. Surface intended roles on session status/diagnostics even when writers are not armed yet.
**Done when:** unit/protocol tests round-trip the setting; start with ISO on and only camera (or only screen) refuses with the documented code; ISO off preserves today’s params byte-compatible for existing fields.
**Out of scope:** encoder writers, UI chrome beyond types if needed for compile.

## Slice 2 — Split audio taps for ISO legs

**Goal:** Mic-only and system-only FIFOs can feed ISO muxers while Combined still gets the mix.
**Depends on:** Slice 1
**Touches:** `audio.rs`, recording audio setup in `recording.rs`, audio health/diagnostics, Node/Rust audio tests.
**Steps:**
1. Add mixer taps (or parallel lightweight writers) for microphone and system-audio frames sharing the session epoch.
2. Preserve gain/mute semantics: muted mic silences Camera ISO audio; muted/disabled system silences Screen ISO audio.
3. Prove Combined/stream mix is unchanged when ISO taps are armed.
**Done when:** focused audio tests show three sinks (mix, mic tap, system tap) with correct mute/gain; existing mic/system recording tests stay green.
**Out of scope:** video ISO encoders.

## Slice 3 — Source ISO video writers

**Goal:** During an armed ISO session, encode Screen and Camera from source frames into separate MKVs.
**Depends on:** Slices 1–2
**Touches:** `compositor.rs` / source stores, `encoder_bridge.rs`, `recording.rs`, `pipeline.rs`, diagnostics counters.
**Steps:**
1. Arm Screen/Camera ISO bridge writers from source frame stores (not composed output).
2. Pair each with its audio tap; share session timeline epoch.
3. Honor `keepCombined` (skip Combined writer when false).
4. On mid-session source loss, finalize/fail that role explicitly.
**Done when:** backend/synthetic or fixture session produces two (or three) MKVs with distinct video content identities and correct audio pairing; diagnostics expose per-role encoder frame/byte counters.
**Out of scope:** Library grouping UI, MP4 export polish beyond reusing existing finalize hooks.

## Slice 4 — Finalization and Library take model

**Goal:** Stop yields finished MP4s grouped as one take in storage/API.
**Depends on:** Slice 3
**Touches:** `recording_finalization.rs`, `storage.rs`, Library DTOs, recovery/quit paths.
**Steps:**
1. Persist `take_id` + `recording_role` per artifact.
2. Finalize all armed roles; partial failure reports per role.
3. Instant-record / exporting Library rows list siblings; delete APIs support file vs take.
**Done when:** storage/API tests cover three-role success, camera-ISO-only failure with Combined+Screen success, and delete-take vs delete-one; quit-during-finalize does not orphan silent zero-byte successes.
**Out of scope:** polished Library table UI (Slice 5).

## Slice 5 — Recording tab and Library UI

**Goal:** Users can enable the feature and understand the resulting files.
**Depends on:** Slice 4
**Touches:** `recording-tab.tsx`, Library tab/components, entitlement gating, copy; follow `.claude/skills/videorc-design/SKILL.md` (shadcn-only, dense Output section).
**Steps:**
1. Output section: Switch + short description; eligibility helper when sources missing; no Premium gate (D2 Free).
2. Library: group take rows with role badges; Play opens Combined by default; overflow actions for Screen/Camera.
3. Success toast only when async finalize finishes out of view (design toast discipline).
**Done when:** desktop unit/integration tests cover toggle lock while live, eligibility copy, and grouped Library rendering with mocked multi-role sessions; `pnpm typecheck` / lint / desktop tests for touched packages pass.
**Out of scope:** in-app ISO editor.

## Slice 6 — Smokes and analyzers

**Goal:** CI/local gates prove multi-artifact takes without regressing single-file recording.
**Depends on:** Slices 3–5
**Touches:** `scripts/` recording-studio / record-latency / analyzer helpers, package scripts.
**Steps:**
1. Extend artifact analyzer to accept a take manifest (combined/screen/camera paths).
2. Add a focused smoke: PiP (or side-by-side) scene + ISO on → assert Screen file has no face overlay identity if measurable, Camera file is camera-sized content, audio routing (system vs mic) via existing signal techniques where available.
3. Ensure default ISO-off paths in `smoke:recording-studio`, `smoke:record-latency`, `smoke:recording-matrix` remain single-artifact.
**Done when:** new smoke is wired as a package script and passes locally; ISO-off studio/latency gates still pass; analyzer hard-fails swapped audio or missing role files.
**Out of scope:** full device matrix on Windows/Linux.

## Slice 7 — Device acceptance and docs

**Goal:** Real macOS screen + camera + mic + system-audio acceptance; document the feature.
**Depends on:** Slice 6
**Touches:** device smoke notes, `docs/` short user/engineering note, changelog when shipping.
**Steps:**
1. Run `pnpm smoke:recording-studio:devices` (or closest ISO-extended device smoke) with permissions.
2. Manual acceptance: PiP record → three files open in Finder/Library; import Screen+Camera into an external editor and verify sync.
3. Document D1–D5 outcomes, encoder fallback behavior, and non-goals.
**Done when:** device evidence attached to the plan or acceptance doc; release notes drafted for the version that ships the flag.
**Out of scope:** marketing site copy beyond changelog.

## Verification (aggregate)

Minimum before handoff of the feature branch:

- `pnpm typecheck`, `pnpm lint`, `pnpm --filter @videorc/desktop test`
- `cargo test -p videorc-backend` (touched modules) + `cargo clippy -p videorc-backend -- -D warnings`
- `pnpm test:scripts` (analyzer/sync)
- `pnpm smoke:record-latency` (ISO off + one ISO-on warm cycle if armed)
- `pnpm smoke:recording-studio` (and devices when permissions allow)
- Explicit statement if any gate is permission-blocked

## Risks

| Risk | Mitigation |
| --- | --- |
| Encoder overload (Combined + 2 ISO + stream) | Preflight + keepCombined fallback; diagnostics per role |
| A/V drift across files | Shared session epoch; per-file analyzer budgets |
| Users think preview layout is baked into ISOs | Copy + Library role badges; never encode composed frames into ISO roles |
| Library delete confusion | Explicit take vs file destructive confirms |
| Mid-session Camera Off | Role-level finalize/fail, not silent black video |
| Scope creep into in-app editor | Hard non-goal for v1 |

## Handoff

- **Goal:** Optional separate Screen+system and Camera+mic recordings from one session, with clear Library grouping and unchanged default composed recording.
- **Owner route:** Implementation (fit 9); UI/Product Design (fit 9) for Slice 5; Diagnose if encoder/latency regressions appear. D1–D5 are locked.
- **Model lane:** `fable-5` for Slices 2–4/6; `opus-4.8` for Slice 5 copy/UI.
- **Out of scope:** in-app remix editor, N-source ISOs, silent quality downgrades.
