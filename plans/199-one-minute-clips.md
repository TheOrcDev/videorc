# Plan 199: A 1-minute clip beside the 30-second clip

> **Executor instructions**: Follow this plan slice by slice, in order. Run
> every verification command and confirm the expected result before moving
> to the next slice. If anything in "STOP conditions" happens, stop and
> report. Do not improvise around a STOP. The owner's standing rule applies:
> write and commit every slice first, then run the Rust compile and tests and
> the e2e smokes once at the end (S6). When done, fill "As built" and update
> this plan's entry in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 61a045ce..origin/main -- crates/videorc-backend/src/replay_buffer.rs crates/videorc-backend/src/clip_marks.rs crates/videorc-backend/src/moments.rs crates/videorc-backend/src/remote_control.rs crates/videorc-backend/src/protocol.rs crates/videorc-backend/src/storage.rs apps/desktop/src/shared/backend.ts apps/desktop/src/shared/backend-rpc-contract.ts apps/desktop/src/shared/session-markers.ts apps/desktop/src/shared/clip-marks.ts apps/desktop/src/shared/global-shortcuts.ts apps/desktop/src/shared/global-shortcut-bindings.ts apps/desktop/src/shared/electron-ipc-contract.ts apps/desktop/src/renderer/src/hooks/use-studio.tsx apps/desktop/src/renderer/src/lib/replay-buffer.ts apps/desktop/src/renderer/src/lib/replay-buffer-reconcile.ts apps/desktop/src/renderer/src/lib/capture.ts apps/desktop/src/renderer/src/lib/session-params.ts apps/desktop/src/renderer/src/lib/remote-surface.ts apps/desktop/src/renderer/src/lib/global-shortcuts.ts apps/desktop/src/renderer/src/components/tabs/recording-tab.tsx apps/desktop/src/renderer/src/components/command-palette.tsx apps/desktop/src/renderer/src/components/settings/shortcuts-settings.tsx apps/desktop/src/renderer/src/components/stream-manager apps/desktop/src/renderer/comments/main.tsx scripts/smoke-replay-buffer-app.mjs docs/replay-buffer.md docs/remote-control.md CONTEXT.md`
> Two open PRs touch the same files: **#817** (`use-studio.tsx`,
> `replay-buffer-reconcile.ts`, `check-renderer-asset-budget.mjs`) and
> **#819** (the ring's audio). **Plan 198** is a peer hotfix candidate
> (`fix/198-screen-iso-startup`, worktree `../videorc-wt-198`). It changes
> the Clips buffer-only start and the renderer's failed-start counting in
> `use-studio.tsx`, the reconcile and the replay-only arm in the backend.
> Let 198 land first, then rebase this branch onto it. If any of these has
> merged, re-read those files before S1 and S4. Read code from `origin/main`. The shared checkout is often weeks
> out of date, so work in your own worktree (`../videorc-wt-199`, branch
> `plan-199-clip-length`, already created off `61a045ce`).

## Status

- **Status**: EXECUTING 2026-10-25 on branch `plan-199-clip-length`. S0
  is done: the owner said "Execute the entire plan and create a PR", so
  D1–D9 take their recommendations.
- **Priority**: P2. Owner request, 2026-10-25: "We currently have a
  30-second clip. Let's also add a 60-second clip."
- **Effort**: M. Seven slices (S0–S6), about one agent day plus the owner's
  by-eye check.
- **Risk**: LOW-MEDIUM. The encode, the ring's muxer and the save path stay
  as they are. Only two things change: how many seconds a save takes, and
  how many seconds the ring keeps. The risk is in the wire. Five strict
  contracts change (an RPC's params, an RPC result, an IPC command, the
  marker context, a remote intent), and every smoke runs with the ring on.
- **Depends on**: S0. Plan 181 (Clips), merged as #694 `c5033f62` and
  shipped in 0.9.147.
- **Category**: Feature. It covers the recording output (the ring), global
  shortcuts, the Stream Manager, voice, and the Output page.
- **Planned at**: commit `61a045ce` (origin/main), 2026-10-25.
- **Route**: The orchestrator planned it, fit 10. The execution owner is
  Implementation, fit 9. Model lanes:
  - S1–S4 and S6: `fable-5`. These slices change the wire contracts in Rust
    and TS, the ring that rides every recording, and the voice matcher.
  - S5 (UI): `opus-4.8`. It must read
    `.claude/skills/videorc-design/SKILL.md` first and use shadcn
    components only.

## Goal

Today every clip press saves the same length. It is 30 s by default, and
Output → Clips → **Length** changes it for every press (15 s, 30 s, 1 min,
2 min, 5 min). The owner wants a 60-second clip **in addition to** the
30-second one: two lengths, chosen at the moment of the press.

Done means:

1. The Clip action has two lengths: **30 s** (today's Clip, unchanged) and
   **1 min**. Both work at any moment the ring holds frames. No setting has
   to change between them.
2. Every place that saves a clip offers both lengths:
   - the Stream Manager's Clip button and its ⋯ menu
   - a global shortcut for each length
   - ⌘K
   - `/clip` in the Stream Manager composer
   - the voice phrases
   - the remote `clipMark` intent
3. A 1-min clip passes ffprobe, has video and audio, lasts 60 to 62.5 s,
   and is in Library. A 30-s clip is exactly what it is today, 30 to
   32.5 s.
4. A 1-min press during a recording also keeps a mark. Buddy's report then
   shows that moment as the minute, not 30 s.
5. The ring stays bounded on disk. The bound now follows the 1-min length:
   33 segment files, up from 18.
6. With Clips off, nothing changes from today. An existing `/clip`, the
   Save a clip key and "clip that" still save 30 s.

## What exists today (origin/main `61a045ce`)

**The ring.** It is plan 181, as the owner redesigned it. See
`docs/replay-buffer.md`.

- The ring is one more `-f segment` output (2 s MPEG-TS segments) on the
  FFmpeg child of every session. A buffer-only session runs it whenever
  Videorc is open, on by default.
- How many seconds the ring keeps comes from `StartSessionParams.replay.seconds`
  (`protocol.rs:1251` `ReplayParams`). The renderer fills it from
  `captureConfig.replayBuffer.seconds` (`lib/session-params.ts:94-98`).
- Pruning keeps `keep_count(N) = ceil(N/2) + 2` listed segments
  (`replay_buffer.rs:118`). `segments.csv` is the truth.
- The ring directory belongs to one session (`ring_dir`, `replay_buffer.rs:469`).
  It is deleted when that session ends, so **the ring restarts empty at
  every Record, Go Live and Stop**.
- The backend accepts any ring length from 5 to 600 s (`MIN_SECONDS`,
  `MAX_SECONDS`, `clamp_seconds`). `DEFAULT_SECONDS = 30`.

**Saving.**

- `request_save(state, source)` (`replay_buffer.rs:905`) answers at once
  with `ReplaySaveAccepted { saveId, sessionId, queued }`. A press during a
  save queues one more, and a third press joins the queued one
  (`queued_save: Option<(String, Option<ClipMarkSource>)>`).
- `perform_save` (`1166`) waits for the segment boundary, then calls
  `select_segments(&listed, snapshot.seconds)` (`166`).
  `snapshot.seconds` **is the ring's length**. That is the one number that
  becomes per-press.
- `ReplaySavedEvent.seconds` is documented as "the requested length"
  (`protocol.rs:1311`). The file goes to `Clips/Clip YYYY-MM-DD HH-MM-SS.mp4`
  with a Library row titled "Clip".

**The one clip action.**

- `clip.mark` takes no params. It is dispatched at `main.rs:13478` and goes
  to `clip_marks::mark_manual(state)` (`clip_marks.rs:439`) →
  `record_mark` → `replay_buffer::request_save(state, Some(source))`. While
  a recording runs, it also stores a `ClipMark`.
- `replay.save` takes no params (`main.rs:13483`).
- **Voice.** `CLIP_PHRASES` (`clip_marks.rs:24`) holds "clip that", "clip
  it", "clip this", "that's a clip" and "make a clip". `TAIL_WORDS = 2`,
  because the longest phrase has 3 words. `note_transcript_final` →
  `record_mark(... Voice ...)`. A voice match within
  `CLIP_MARK_DEDUPE_SECONDS = 10` of the previous mark counts as the same
  moment.
- **Marks become moments.** `moments.rs:28` sets
  `CLIP_MARK_LOOKBACK_MS = 30_000`, so a moment is `[mark − 30 s, mark]`,
  capped at `CLIP_MAX_LENGTH_MS = 90_000`. Marks are stored in the
  `clip_marks` table (`storage.rs:7954`). New columns go in through
  `ensure_column` (`storage.rs:7982`, `9447`).

**Renderer.**

- `markClip()` (`hooks/use-studio.tsx:15446`) sends `clip.mark`. Callers:
  - the global action `clip-mark` (`lib/global-shortcuts.ts:61`)
  - ⌘K "Save clip" (`command-palette.tsx:249-261`)
  - the remote intent `clipMark` (`lib/remote-surface.ts:514`)
  - the Stream Manager relay
- **Stream Manager relay.** The window calls
  `markClipFromCommentsWindow({ requestId })` (`comments/main.tsx:127-135`).
  Main relays it as `comments-window:clip-mark-request` (`ClipMarkCommand
{ requestId }`, `shared/backend.ts:3623`). The main window then runs
  `clip.mark` (`use-studio.tsx:3149`).
- **Stream Manager UI.**
  - The status bar has one **Clip** button with a hint, and a ⋯ menu item
    below 640 px (`stream-manager-status-bar.tsx:178-181, 400-406, 519-524`).
  - The composer has `/clip` (`shared/session-markers.ts:265`, classifier
    `{ kind: 'clip' }`; completions and help at `chat-pane.tsx:688, 865-880, 1138`).
- **The clip facts.** The main window pushes the marker context with `clip:
ClipContext { available, seconds, shortcutLabel?, off? }`
  (`shared/session-markers.ts:79`, built at `use-studio.tsx:4137`).
  `seconds` is `replayState.seconds`, the ring's length.
- **Settings.**
  - `captureConfig.replayBuffer { seconds, enabled, explicit }`
    (`lib/capture.ts:148-180`).
  - `REPLAY_BUFFER_LENGTH_OPTIONS = [15, 30, 60, 120, 300]`, default 30.
  - Output → Clips (`tabs/recording-tab.tsx:96-205`) holds the switch,
    **Length**, Disk use, the Save a clip recorder and Where clips go.
- **Global actions.**
  - The list is `GLOBAL_SHORTCUT_ACTIONS` (`shared/global-shortcuts.ts:3`).
  - Config keys are `ACTION_CONFIG_KEYS` (`global-shortcut-bindings.ts:8`).
  - `GlobalShortcutsConfig` is at `shared/backend.ts:4615`.
  - The rows are `GLOBAL_ACTION_ROWS` (`shortcuts-settings.tsx:23`).
  - Labels are at `lib/global-shortcuts.ts:93`.
  - `clipMark` is unbound by default.
- **Copy helpers.** `lib/replay-buffer.ts` has `replayLengthLabel` ("30 s",
  "1 min"), `replayClock` ("0:30"), `estimatedReplayDiskBytes` and the
  toasts. `shared/clip-marks.ts` has `clipLengthWords` ("30 seconds", "1
  minute") and `clipSavingToast`.
- **Remote.**
  - `RemoteIntent::ClipMark` is a unit variant (`remote_control.rs:126`),
    in debounce bucket `clip`.
  - The Stream Deck plugin has **no** clip action. The phone remote page
    has **no** clip button.
  - `docs/remote-control.md:107` documents `clipMark`.

**Gates that see this.**

- `pnpm smoke:replay-buffer` saves through `clip.mark` and the remote
  `clipMark`. It asserts `saved.seconds === --seconds`, which defaults to 30.
- `smoke:multistream` with `VIDEORC_SMOKE_REPLAY_SECONDS=15` starts a
  15-s ring through the backend's own params.
- `probe:comments-window` checks that the Stream Manager status bar fits
  without clipping.
- The eager renderer budget is 395,000 gzip
  (`scripts/check-renderer-asset-budget.mjs`). `use-studio.tsx` and
  `shared/global-shortcuts.ts` are eager.

## Design

**One ring, two lengths.**

- The ring always keeps **60 s** (`REPLAY_RING_SECONDS = 60` in the
  renderer, sent as `ReplayParams.seconds`).
- A press says how much it wants: 30 or 60. No `seconds` means 30, so
  every existing caller (an old deck script, the voice "clip that",
  `/clip`) keeps today's 30-second clip.
- The encode and the segment muxer are unchanged. The ring just keeps 32
  listed segments instead of 17.

**Backend.**

- `pub const CLIP_LENGTHS: [u32; 2] = [30, 60]` and
  `DEFAULT_CLIP_SECONDS = 30` in `replay_buffer.rs`.
- `clip_seconds(requested: Option<u32>, ring_seconds: u32) -> Result<u32, SaveRefusal>`:
  - `None` means 30.
  - A value that is not in `CLIP_LENGTHS` is refused with
    `invalid-clip-length`: "A clip is 30 seconds or 1 minute."
  - The result is clamped to the ring's length. A smoke's 15-s ring saves
    15 s, and the event says so.
- `request_save(state, source, seconds: Option<u32>)`.
  - `ReplaySaveAccepted` gains `seconds: u32`, the length this save will
    take.
  - The queue keeps `(id, source, seconds)`. A press that joins a queued
    save raises its length to the longer of the two, so nobody loses
    footage. The joining press gets that id and that length back.
- `SaveSnapshot.seconds` becomes the press's length. `select_segments`,
  `ReplaySavedEvent.seconds` and the probe check all follow it. The ring's
  `keep_count` and the prune use the ring's length.
- `clip.mark` and `replay.save` take optional params `{ seconds?: 30 | 60 }`.
  Absent or `null` params mean `{}`.
- `RemoteIntent::ClipMark { seconds: Option<u32> }` uses
  `#[serde(default, skip_serializing_if = "Option::is_none")]`, so
  `{"kind":"clipMark"}` still parses. It stays in the `clip` debounce
  bucket.
- **Voice.** The phrases carry a length. "clip that" and the others stay
  30 s. D7 adds the 1-min phrases. The matcher reports the matched length,
  and `TAIL_WORDS` becomes `longest phrase − 1`.
- **Marks.**
  - `ClipMark` gains `lookback_seconds: Option<u32>`, with `serde(default,
skip_serializing_if)` on the wire.
  - The table gains a nullable `lookback_seconds INTEGER` through
    `ensure_column`. NULL reads as 30 s, which is every mark made before
    this plan.
  - `mark_moments` uses the mark's lookback, still capped by
    `CLIP_MAX_LENGTH_MS`.

**Renderer.**

- `markClip(seconds?: ClipLength)`, where `type ClipLength = 30 | 60`.
- A new global action `clip-mark-long` (config `clipMarkLong`), unbound by
  default. The existing `clip-mark` key stays the 30-s clip, so
  everybody's binding keeps its meaning.
- `ClipContext` changes:
  - `seconds` becomes the 30-s length, no longer the ring's length.
  - It gains `longSeconds` and `longShortcutLabel?`.
- `ClipMarkCommand` gains `seconds?`. The relay passes it to `clip.mark`.
- `/clip` means 30 s and `/clip 60` means 1 min (D6). The classifier
  returns `{ kind: 'clip'; seconds: ClipLength }`.
- The **Length** select goes away (D2). Saved `replayBuffer.seconds`
  values are ignored, and the normalizer drops the field.
- The chip reads the ring's fill up to "Clip · 1:00".

## Decisions (S0: the owner, or the executor at the recommendation)

| #   | Question                           | Recommended                                                                                                                                                                                                                                                         | Alternatives                                                                                                                                                                                |
| --- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | What "also a 60-second clip" means | **A second clip action beside today's.** 30 s and 1 min both work at any moment.                                                                                                                                                                                    | No code: set Output → Clips → Length to 1 min, which exists today. Every press is then 1 min and there is no 30 s.                                                                          |
| D2  | What happens to the Length setting | **Remove it.** The ring always keeps 1 min, and the two clips are fixed at 30 s and 1 min. One less setting, and both buttons always mean what they say. A saved 15 s / 2 min / 5 min choice is dropped. Say so in the release notes.                               | (a) Keep Length as the _long_ clip's length (1 / 2 / 5 min, default 1 min), with the short clip fixed at 30 s. The second button then reads "Clip 2 min" and so on. (b) Two Length selects. |
| D3  | Disk use doubles                   | **Accept it.** See the table under this one. CPU and GPU do not change: the encode is the same, and only the files kept change.                                                                                                                                     | Keep 30 s on disk and make the 1-min clip only from a recording. That cannot work when nothing records, which is the main case.                                                             |
| D4  | Words                              | Stream Manager: **"Clip 30 s"** and **"1 min"** in one group. ⌘K and the shortcut rows: **"Save a 30-second clip"** and **"Save a 1-minute clip"**. Toasts keep their shape ("Clip saved · Last 1:00"). Library title **"Clip"** for both, with the same file name. | "Clip" + "Long clip". A title of "Clip (1 min)" in Library.                                                                                                                                 |
| D5  | Shortcut                           | **A second global action, unbound by default.** It never steals a game's key (plan 181 D5). The existing Save a clip key stays 30 s.                                                                                                                                | One key: tap for 30 s, double-tap for 1 min. Hidden, and it adds lag to every 30-s press.                                                                                                   |
| D6  | Chat command                       | **`/clip` = 30 s (unchanged), `/clip 60` = 1 min.** `/clip 30` is also accepted. Anything else gives the error line "A clip is 30 seconds or 1 minute: /clip or /clip 60."                                                                                          | `/clip long`, or `/clip 1m`.                                                                                                                                                                |
| D7  | Voice                              | **"clip the last minute" and "long clip"** save 1 min. "clip that" and the others stay 30 s.                                                                                                                                                                        | No voice for the minute.                                                                                                                                                                    |
| D8  | A 1-min press while recording      | **The mark remembers its length** (`lookback_seconds`). Buddy's report and Clean cut's moment for that press then span the minute.                                                                                                                                  | Every mark stays a 30-s moment: no new column, and the report understates the 1-min press.                                                                                                  |
| D9  | Stream Manager layout              | **Two `StatusBarAction`s side by side** ("Clip 30 s" and "1 min"), each with its own hint and key. The status bar already builds its buttons from `StatusBarAction`, and the repo has no shadcn `ButtonGroup`. Below 640 px they become two items in the ⋯ menu.    | One Clip split button with a chevron menu for 1 min. This hides the minute behind a second click.                                                                                           |

Disk use for D3. The ring holds 33 two-second files (66 s), up from 18
(36 s). Arming is refused under 4 × N × bitrate of free space.

| Video bitrate | Ring now (30 s) | Ring at 1 min | Free space needed to arm |
| ------------- | --------------- | ------------- | ------------------------ |
| 8 Mbps        | 37 MB           | 68 MB         | 246 MB (was 123 MB)      |
| 40 Mbps (4K)  | 181 MB          | 332 MB        | 1.2 GB (was 603 MB)      |

**Not a decision: Free.** Clips are local, and recording is free
(`entitlements.rs` doctrine). Add no `FeatureId`.

**S0 outcomes (owner, 2026-10-25):** "Execute the entire plan and create a
PR". Every row D1–D9 takes the **Recommended** column as written above:

- D1: a second clip action.
- D2: Length is removed.
- D3: double disk use is accepted.
- D4: the words are as given.
- D5: a second key, unbound by default.
- D6: `/clip 60`.
- D7: "clip the last minute" and "long clip".
- D8: marks store `lookback_seconds`.
- D9: two `StatusBarAction`s.

Plan 198 had not landed when execution started. This branch builds on
origin/main and rebases onto 198 once it merges.

## Slices

### S0: Record the decisions

1. Write the D1–D9 outcomes into this plan. Each one is either the owner's
   answer or "executor default".
2. If D1 comes back "no code", stop here. Tell the owner that Length → 1
   min already exists, and close the plan.
3. If D2 comes back (a), read "If D2 = (a)" at the end of this plan before
   S1.

**Done when:** every D row has a recorded outcome.

### S1: Backend: a press chooses its length

Files: `replay_buffer.rs`, `protocol.rs`, `main.rs`, `clip_marks.rs`
(signature only), `remote_control.rs`.

1. Add `CLIP_LENGTHS`, `DEFAULT_CLIP_SECONDS` and `clip_seconds(requested,
ring)`, as in Design. Keep `DEFAULT_SECONDS` (the ring's fallback for
   `snapshot()` when off) and move it to 60.
2. `request_save(state, source, seconds)`:
   - Validate `seconds` and clamp it to `runtime.seconds` under the lock.
   - Queue `(id, source, seconds)`. A joining press takes the max.
   - Return `seconds` in `ReplaySaveAccepted`.
3. `SaveSnapshot.seconds` becomes the press's length. `save_snapshot`
   takes it as an argument, and `run_saves` carries it through the queue.
4. `protocol.rs`:
   - Add `ClipMarkParams { seconds: Option<u32> }` and `ReplaySaveParams {
seconds: Option<u32> }`, both with `#[serde(default,
skip_serializing_if = "Option::is_none")]`.
   - Add `ReplaySaveAccepted.seconds: u32`.
5. `main.rs`: parse the optional params for `clip.mark` and `replay.save`.
   Treat `Value::Null` as `{}`. Follow how other optional-param methods do
   it in this file. Bad params get `invalid-params`. A refused length gets
   `invalid-clip-length`.
6. `clip_marks::mark_manual(state, seconds)` → `record_mark(..., seconds)`
   → `request_save(state, Some(source), seconds)`. For now, voice passes
   `None`. S2 gives it a length.
7. `RemoteIntent::ClipMark { seconds }`. Update the parse test at
   `remote_control.rs:408` and add a `{"kind":"clipMark","seconds":60}`
   case.
8. Unit tests:
   - `clip_seconds`: None → 30; 30 and 60 pass; 45 is refused; a 15-s ring
     clamps 30 to 15 and 60 to 15.
   - `select_segments` over a 60-s list with 30 and 60 gives 15 and 30
     segments.
   - The queue join takes the max.
   - The ring's `keep_count(60) == 32` and `max_segment_files(60) == 33`.
   - `ReplaySaveAccepted` serializes `seconds`.

**Done when:** `cargo test -p videorc-backend -- replay clip_marks
remote_control` passes (run it in S6, per the standing rule), and the new
tests are in the commit.

### S2: Backend: voice for the minute, and marks that remember their length

Files: `clip_marks.rs`, `moments.rs`, `storage.rs`, `protocol.rs`.

1. Phrases carry a length:
   `CLIP_PHRASES: &[(&[&str], u32)]`, or a second `LONG_CLIP_PHRASES`
   table.
   - Add D7's phrases: `["clip","the","last","minute"]` and
     `["long","clip"]`.
   - Set `TAIL_WORDS` from the longest phrase (3 now). Add a
     `const _: () = assert!(...)`, or a test, that ties it to the table.
   - `PhraseMatch` gains `seconds`.
   - `note_transcript_final` passes it to `record_mark`.
2. Matching order stays "earliest start wins". Add table cases:
   - "okay long clip that" → 60 s, matched once
   - "clip the last minute" split across two finals → 60 s
   - "clip that" → 30 s
   - "that was a long clip" → 60 s. This is accepted, like "clip that"
     today.
   - The 10-s dedupe still swallows a second phrase of either length.
3. `ClipMark.lookback_seconds: Option<u32>` (wire: `lookbackSeconds`,
   skip when None).
   - Add `ensure_column(clip_marks, lookback_seconds, "lookback_seconds
INTEGER")`.
   - Update the insert and select in `storage.rs:5994-6015`.
   - `record_mark` stores the press's length: `Some(60)` for a 1-min press
     and `Some(30)` for a 30-s press. Older rows stay NULL.
4. `moments.rs`:
   - `mark_moments` uses `mark.lookback_seconds.unwrap_or(30) * 1000`.
   - Clamp it to `CLIP_MAX_LENGTH_MS`, and keep `CLIP_MIN_LENGTH_MS`.
   - Test: a 60-s mark at 200 s → `[140 s, 200 s]` before snapping to
     cues. A NULL mark keeps `[170 s, 200 s]`.

**Done when:** the phrase table, storage round-trip and moments tests pass
in S6. The `clip_marks_persist_per_session_in_file_time_order_and_follow_deletes`
test still passes, and it reads a NULL `lookback_seconds` as `None`.

### S3: The wire, both sides

Files: `shared/backend.ts`, `shared/backend-rpc-contract.ts`,
`shared/session-markers.ts`, `shared/electron-ipc-contract.ts`,
`protocol-fixtures/high-risk-contracts.json` (if it holds any of these),
and `lib/remote-surface.ts`.

1. Types:
   - `type ClipLength = 30 | 60`, `CLIP_LENGTHS`, and
     `DEFAULT_CLIP_SECONDS` in `shared/clip-marks.ts`. Mirror the Rust
     constants and say so in a comment on both sides.
   - `ClipMarkParams`, `ReplaySaveParams`, `ReplaySaveAccepted.seconds`,
     `ClipMark.lookbackSeconds?`.
2. `backend-rpc-contract.ts`:
   - `'clip.mark'` params change from `undefinedSchema` to an optional
     object `{ seconds?: 30 | 60 }`. Find the existing pattern for
     optional params in this file and use it.
   - The `replay.save` params change the same way.
   - `ReplaySaveAccepted` gets the required `seconds`.
   - `clipMarkSchema` gets the optional `lookbackSeconds`.
3. IPC (strict):
   - `ClipMarkCommand.seconds?`.
   - `ClipContext.longSeconds` and `longShortcutLabel?` in the marker
     context schema.
   - Update `electron-ipc-contract.test.ts`.
4. The remote intent arrives in `lib/remote-surface.ts` as an untyped
   record (`intent.messageId as string | undefined`). Read
   `intent.seconds` the same way, and accept only `undefined`, 30 or 60
   (S4 step 4). Update `remote-surface.test.ts`.
5. Contract tests:
   - Old payloads still parse: `clip.mark` with no params, and a
     `ClipMark` without `lookbackSeconds`.
   - New payloads parse.
   - `seconds: 45` fails the schema.

**Done when:** `pnpm typecheck` passes, and the contract, IPC and remote
vitest files pass.

### S4: Renderer model

Files: `lib/capture.ts`, `lib/session-params.ts`,
`lib/replay-buffer-reconcile.ts`, `lib/replay-buffer.ts`,
`hooks/use-studio.tsx`, `lib/global-shortcuts.ts`,
`shared/global-shortcuts.ts`, `shared/global-shortcut-bindings.ts`,
`lib/remote-surface.ts`, `shared/session-markers.ts`, `shared/clip-marks.ts`.

1. Set `REPLAY_RING_SECONDS = 60`.
   - `session-params.ts` sends it as `replay.seconds`.
   - `ReplayBufferSettings` loses `seconds`, and `normalizeReplayBufferSettings`
     drops a stored one.
   - The reconcile's "the ring's shape changed" check now compares the
     ring to the constant. A ring armed at 30 before an update restarts
     once at 60 on the first launch, which is expected.
2. `markClip(seconds?: ClipLength)` sends `clip.mark` with `{ seconds }`
   only when one was given.
3. The global action `clip-mark-long`:
   - Add it to `GLOBAL_SHORTCUT_ACTIONS` and `globalShortcutEntries`.
   - Add the config key `clipMarkLong` and the label "Save a 1-minute
     clip". `clip-mark` becomes "Save a 30-second clip".
   - The executor case is `context.markClip?.(60)`.
   - Check main's registration and the IPC schema for the config. Both go
     through `isGlobalShortcutConfigKey`, so check they pick it up with no
     other edit.
4. `remote-surface.ts`: `clipMark` passes `intent.seconds` to
   `context.markClip(seconds)`. An unknown length is refused with the
   backend's sentence.
5. The marker context (`use-studio.tsx:4137`):
   - `clip.seconds = DEFAULT_CLIP_SECONDS`. **Not** `replayState.seconds`,
     which is now 60. If you miss this, the 30-s button says "the last
     1:00".
   - Add `longSeconds: 60` and `longShortcutLabel`.
   - Add `settings.globalShortcuts?.clipMarkLong` to the effect's deps.
6. The Stream Manager relay (`use-studio.tsx:3149`) passes
   `command.seconds`.
7. `classifyComposerDraft`:
   - `/^\/clip(?:\s+(\d+))?\s*$/i`. No number or 30 → 30. 60 → 60.
     Anything else → `{ kind: 'error', message: … }` (D6).
   - Tests in `session-markers.test.ts`.
8. Copy helpers:
   - `clipSavingToast(event, seconds)` reads the accepted or saved
     length, not the ring's.
   - The Stream Manager's `saveClip(seconds)` passes the length it asked
     for.
9. **Eager budget.** Run `pnpm build && pnpm check:renderer-assets`
   before and after this slice, and write both numbers here. Put the new
   copy and the second recorder in the lazy `lib/replay-buffer.ts` or the
   lazy Output section, never in `use-studio.tsx`.

**Done when:**

- typecheck passes.
- The desktop vitest suite passes for every file this slice touches:
  capture, session-params, replay-buffer-reconcile, global-shortcuts,
  remote-surface, session-markers and clip-marks.
- The eager gzip delta is written down, and it is under the ceiling
  without raising it.

### S5: UI (`opus-4.8`, design skill first)

Read `.claude/skills/videorc-design/SKILL.md`. Use shadcn components only.
Toasts colour their icon only.

1. **Output → Clips** (`recording-tab.tsx`):
   - Delete the Length row (D2).
   - The description: "Videorc keeps the last minute of your screen and
     microphone while it is open, so one key saves the last 30 seconds or
     the whole minute as a clip. …"
   - Disk use is computed at 60 s.
   - Two `ShortcutRecorderField`s: "Save a 30-second clip" (the existing
     `clip-mark`) and "Save a 1-minute clip" (`clip-mark-long`).
2. **Settings → Shortcuts**: add `clip-mark-long` to `GLOBAL_ACTION_ROWS`,
   right after `clip-mark`.
3. **⌘K** (`command-palette.tsx`): replace "Save clip" with two items,
   "Save a 30-second clip" and "Save a 1-minute clip". Each shows its key.
   Keep the keywords (`clip`, `replay`, `marker`, `moment`, plus `minute`
   and `60`) and the visibility rule (`live || ring on`).
4. **Stream Manager status bar** (`stream-manager-status-bar.tsx`):
   - Two `StatusBarAction`s sit side by side (`:400-406` today): "Clip
     30 s" with `ClipIcon`, then "1 min". Each button's hint names its
     length, its key and its spoken phrase.
   - Do not add a shadcn component for this.
   - The ⋯ menu below 640 px gets two items with `DropdownMenuShortcut`.
   - `onMarkClip` becomes `onMarkClip(seconds)`.
5. **Composer** (`chat-pane.tsx`):
   - Completions: `/clip · Save the last 30 seconds as a clip` and
     `/clip 60 · Save the last minute as a clip`.
   - The help line names both.
   - The notice: "Saving the last 1:00 as a clip…".
6. **Toasts**: "Clip saved · Last 1:00" comes from the event's `seconds`
   and `coveredSeconds`, so it should need no change. Check it.

**Done when:**

- `pnpm typecheck`, `pnpm lint` and `pnpm format:check` pass, and the
  desktop vitest suite passes.
- Screenshots in **light and dark** show:
  - Output → Clips
  - Settings → Shortcuts
  - ⌘K with both items
  - the Stream Manager status bar at full width and below 640 px (the ⋯
    menu)
  - `/cl` completions
  - the "Clip saved · Last 1:00" toast

### S6: Smoke, docs, gates, As built

1. `scripts/smoke-replay-buffer-app.mjs`:
   - The ring defaults to 60. Keep `--seconds` for the ring, so an
     investigative run can still shorten it.
   - Seed `replayBuffer` without `seconds`.
   - Assert the default ring reads 60.
   - Save `clip.mark` with no params (30.00 s, `accepted.seconds === 30`)
     and `clip.mark { seconds: 60 }` (60.00 s, in [60, 62.5]).
   - Send a remote `clipMark` with `seconds: 60`.
   - Mid-recording, send one 60-s `clip.mark`. It saves a clip and keeps a
     mark with `lookbackSeconds: 60` in `clip.marks.list`.
   - Send `clip.mark { seconds: 45 }`. It is refused with
     `invalid-clip-length`, and no file is written.
   - Disk bound: ≤ 33 files. Watch until the ring is full, plus 30 s,
     instead of 3 × N, so the smoke grows by about 1 minute rather than 3.
2. `smoke:multistream` with `VIDEORC_SMOKE_REPLAY_SECONDS=15`: unchanged.
   Its press with no length clamps to the 15-s ring and reports 15. This
   is the clamp's proof.
3. Docs:
   - `docs/replay-buffer.md`: the two lengths, the 1-min ring, the disk
     table, and voice.
   - `CONTEXT.md`: the Clip action has two lengths.
   - `docs/remote-control.md`: the `clipMark` row gets `seconds?: 30 | 60`.
4. Gates. Run them once, here.

| Gate                                                                                                          | Expect                                                                                             |
| ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `cargo fmt --check --all`                                                                                     | pass                                                                                               |
| `cargo clippy -p videorc-backend -- -D warnings`                                                              | pass                                                                                               |
| `cargo test -p videorc-backend -- replay clip_marks moments remote_control shared_high_risk_contract_fixture` | pass                                                                                               |
| `cargo test -p videorc-backend real_ffmpeg_ring_saves -- --include-ignored`                                   | pass (the real FFmpeg save)                                                                        |
| `pnpm typecheck && pnpm lint && pnpm format:check`                                                            | pass                                                                                               |
| `pnpm --filter @videorc/desktop test`                                                                         | pass                                                                                               |
| `pnpm test:scripts`                                                                                           | pass                                                                                               |
| `pnpm build && pnpm check:renderer-assets`                                                                    | pass at the current ceilings; write down the delta                                                 |
| `pnpm smoke:replay-buffer`                                                                                    | pass, with both lengths                                                                            |
| `pnpm smoke:remote-control`                                                                                   | pass                                                                                               |
| `VIDEORC_SMOKE_REPLAY_SECONDS=15 pnpm smoke:multistream`                                                      | pass                                                                                               |
| `pnpm probe:comments-window`                                                                                  | the status bar fits at every width (the Copy link clipboard check is a known host flake, plan 181) |
| `pnpm smoke:record-latency:gate`                                                                              | pass in enforce mode (the ring is now 60 s on every Record)                                        |
| `pnpm smoke:recording-studio`                                                                                 | pass (AGENTS.md: the ring is a recording output on every session)                                  |

5. Write "As built", and update the `plans/README.md` entry.

## STOP conditions

- With no `seconds` anywhere, a press saves anything other than today's
  30 s.
- Any existing clip file or Library row changes shape: the name, the
  folder, the title or `processing_kind`.
- A new wire `Option` without `skip_serializing_if`. Three outages have
  come from this trap (`serde null → contract`).
- A new status, event or result field that is not in
  `backend-rpc-contract.ts`. Main retires its pump on a strict-schema miss.
- The disk bound fails: more than 33 segment files at 60 s.
- A 1-min clip fails ffprobe, lasts outside [60, 62.5], or fails the
  analyzer.
- The eager renderer budget needs a higher ceiling.
- `smoke:record-latency:gate` breaks budget with the 60-s ring when it
  passed at 30 s.

## Known limit (not in scope)

The ring restarts empty at every Record, Go Live and Stop, because each
session owns its ring directory. So a 1-min press within the first minute
after one of those saves only what was kept since, and the toast says "the
buffer was still filling". The same is true for 30 s today, but the minute
makes it twice as visible. Carrying the ring across the handover is its own
plan. It means one ring directory that outlives the session, with the
segment index continuing.

## Out of scope

- A Stream Deck Clip key (none exists today) and a phone-remote Clip button.
  The `seconds` field on `clipMark` is ready for both.
- Lengths other than 30 s and 1 min, unless D2 = (a).
- Frame-exact trimming. Clips stay keyframe-aligned, N to N + 2 s.
- A "Clips" filter in Library.

## If D2 = (a): Length sets the long clip

- `replayBuffer.seconds` stays, with the options `[60, 120, 300]`
  (default 60). A stored 15 or 30 becomes 60.
- `REPLAY_RING_SECONDS` becomes `captureConfig.replayBuffer.seconds`.
- `CLIP_LENGTHS` becomes "30, or the ring's length". The backend accepts
  `seconds ∈ {30, ring}`.
- The long button reads `Clip ${replayLengthLabel(ring)}`.
- `/clip 60` becomes `/clip long`.
- The voice phrase for the long length becomes "long clip" only, since "the
  last minute" would be false at 2 min.
- The disk table scales with the choice: 5 min at 40 Mbps is about 1.5 GB
  of ring.

## As built

(Empty until executed.)
