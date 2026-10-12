# Plan 181: Replay buffer, so a hotkey saves the last 30 seconds as a clip

> **Executor instructions**: Follow this plan slice by slice, in order. Run
> every verification command and confirm the expected result before moving
> to the next slice. If anything in "STOP conditions" happens, stop and
> report. Do not improvise around a STOP. The owner's standing rule applies:
> write and commit every slice first, then run the Rust compile and tests and
> the e2e smokes once at the end of a phase. When done, fill "As built" and
> update this plan's entry in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 672b185c..origin/main -- crates/videorc-backend/src/recording.rs crates/videorc-backend/src/encoder_bridge.rs crates/videorc-backend/src/main.rs crates/videorc-backend/src/protocol.rs crates/videorc-backend/src/storage.rs crates/videorc-backend/src/clip_marks.rs apps/desktop/src/shared/backend.ts apps/desktop/src/shared/backend-rpc-contract.ts apps/desktop/src/shared/global-shortcuts.ts apps/desktop/src/shared/global-shortcut-bindings.ts apps/desktop/src/shared/clip-marks.ts apps/desktop/src/renderer/src/lib/global-shortcuts.ts apps/desktop/src/renderer/src/components/settings/shortcuts-settings.tsx apps/desktop/src/renderer/src/components/studio/session-panel.tsx apps/desktop/src/renderer/src/components/tabs/recording-tab.tsx apps/desktop/src/renderer/src/components/status-bar-session.tsx docs/remote-control.md CONTEXT.md`
> If `start_session`, the FFmpeg arg builders, or `StartSessionParams`
> changed, check "What exists today" against the live code first. Read code
> from `origin/main`. The shared checkout is often weeks out of date, so work
> in your own worktree.

## Status

- **Priority**: P1. A user asked for it on X on 2026-10-12, and the owner
  said: "this is useful feature". It is the standard gamer workflow (OBS
  Replay Buffer, ShadowPlay Instant Replay), and Videorc has no equivalent.
- **Effort**: L. Phase A has 7 slices (S0-S6), about 3-4 agent days plus
  owner checks. Phase B (S7-S8) is optional and comes after Phase A ships.
- **Risk**: MEDIUM-HIGH. The buffer runs the recording pipeline (compositor,
  encoder, audio bus, FFmpeg) with no file output, which is a session shape
  that does not exist today. Hard rule: **with the replay buffer off, nothing
  changes.** Every existing smoke must pass unchanged.
- **Depends on**: S0 decisions D1-D7. Phase B depends on Phase A being merged.
- **Category**: Feature. Covers recording output, global shortcuts and the
  Studio UI.
- **Planned at**: commit `672b185c` (origin/main), 2026-10-12
- **Executed**: 2026-10-12, branch `plan-181-replay-buffer` (S0 decisions below; Phase A and Phase B in one PR at the owner's request)
- **Route**: The orchestrator planned it, fit 10. Execution owner is
  Implementation, fit 9: recording output and FFmpeg trigger the
  recording-studio gates. Model lane `fable-5` (multi-system,
  recording behavior, ships to all three platforms). S5 (UI) can run on
  `opus-4.8`, and must read `.claude/skills/videorc-design/SKILL.md` first.

## Goal

The user request on X (@halo3br, 2026-10-12):

> Like the recording has a buffer and always records the last 30 seconds,
> for example. Then click a hotkey to save the last 30 seconds of gameplay.

Done means:

1. The user turns on **Replay buffer** in Studio. Videorc then keeps the
   last N seconds (default 30) of the composed program, video plus the same
   audio mix a recording gets. It saves nothing permanent, makes no Library
   row, and does not say "Recording" or "On air".
2. Pressing the **Save replay** global hotkey writes those N seconds to an
   MP4 in a Replays folder within ~3 s, even while a game has focus. The
   same action is available from the Studio button, the command palette and
   a Stream Deck/remote intent. A toast confirms the save and offers to show
   the file.
3. The saved MP4 passes ffprobe, has video and audio, lasts N to N+2.5 s,
   and stays in A/V sync. It shows up in Library.
4. Disk use stays bounded at about N seconds × bitrate, however long the
   buffer runs. Buffer files are deleted when the buffer turns off, when the
   app quits, and on the next launch after a crash.
5. Record and Go Live still work while the buffer is on. In Phase A the
   buffer pauses during the session and resumes after it. In Phase B it
   keeps running through the session.
6. Works on macOS, Windows and Linux. All three use the same FFmpeg muxing
   path; only macOS can be verified locally. The plan says exactly what was
   proven on each platform.

## What exists today (origin/main `672b185c`)

**Nearest feature: Mark clip.** It places a timestamp; it does not save a
file.
- The global action `clip-mark` (`shared/global-shortcuts.ts:3-33`,
  `global-shortcut-bindings.ts:8-19`) calls renderer `markClip`
  (`renderer/src/hooks/use-studio.tsx:14716-14734`), which calls the
  backend RPC `clip.mark` (dispatch at `main.rs:12707-12724`), which calls
  `clip_marks::mark_manual` (`clip_marks.rs:439-509`).
- It stamps recording-file time. Without a file output it returns
  `saved:false, reason:"recording-off"`, and the toast says "Recording is
  off, so this clip can't be saved." (`shared/clip-marks.ts:24-40`). That
  is the gap this plan fills.
- `plans/068-orcle-listens.md:63,366` notes there is "no replay buffer"
  and puts one out of scope.

**Recording pipeline.**
- `start_session` (`recording.rs:3056`) builds the frame stores (4350). On
  macOS it arms the preview compositor in place (4381) and spawns FFmpeg
  (args 4636-4685, child 4751). It then starts encoder bridges (5142-5300,
  `start_synthetic_recording_bridge` at `encoder_bridge.rs:2705`, which is
  the production function despite its name).
- Encoded paths:
  - macOS: VideoToolbox, then our `MpegTsH264Writer`, then a FIFO, then
    FFmpeg with `-c:v copy`.
  - Windows: Media Foundation or D3D11, then MPEG-TS, then FFmpeg with
    copy.
  - Linux and the Windows fallback: raw YUV goes to FFmpeg, which encodes
    with VAAPI, OpenH264, QSV or MF (`ffmpeg_h264_encoder`,
    `recording.rs:12689`).
  - Legacy all-in-FFmpeg path for 4K60 (`ffmpeg_args_with_encoder`,
    `recording.rs:17995`; eligibility at 14121).
- **FFmpeg is the muxer on every platform and path.** An extra FFmpeg
  output therefore works the same everywhere.
- GOP is always 2 s with no B-frames: VideoToolbox `fps*2`
  (`encoder_bridge.rs:4936`), Media Foundation (`windows_media_foundation_encoder.rs:3039-3069`),
  FFmpeg `-g fps*2 -force_key_frames` (`recording.rs:13683-13686`). So
  stream-copied segments cut cleanly on 2 s keyframes.
- File output:
  - Plain Matroska `videorc-session-…mkv` (`recording.rs:2910`).
  - Audio is `pcm_s16le` for record-only and AAC 160k when streaming
    (18535).
  - After stop it is remuxed to MP4 with `+faststart` (`mp4_export_args`,
    6874).
  - Shared-encode sessions put the file and the RTMP legs in one tee
    (17296-17390).
  - Split sessions read two FIFOs in one FFmpeg
    (`bridge_compositor_split_output_ffmpeg_args`, 17419).
- Audio: the in-process bus (`session_audio.rs`) mixes mic and system audio
  and writes f32le 48 kHz to a FIFO that FFmpeg reads
  (`capture_input.rs:218`). There is **no encoded audio in-process**, so the
  FFmpeg child has to encode the buffer's audio.
- `video_epoch` is set at the bridge's first frame
  (`encoder_bridge.rs:3594/4043/6463`). The bus trims pre-roll to it
  (`session_audio.rs:4447`).
- When idle, no encoder or FFmpeg runs. The preview compositor runs at
  preview-window size, not canvas size (`preview_surface.rs:645,2054`).
- **Only one session at a time**: `"A capture session is already running"`
  (`recording.rs:3125`).
- No segment muxer, HLS output or encoded-packet ring exists anywhere.

**Bundled FFmpeg.**
- `vendor/ffmpeg/current/bin/ffmpeg` on macOS has the `segment` and
  `mpegts` muxers, the `concat` demuxer and the `aac_adtstoasc` bsf
  (checked 2026-10-12).
- The Windows `--disable-everything` build (`scripts/ffmpeg-capture-windows.mjs`)
  is only the audio capture worker, not the main FFmpeg.
- The Windows and Linux main FFmpeg builds have not been checked; S1 checks
  them.

**Derived files.**
- `create_completed_session` (`storage.rs:1615`) inserts a finished
  Library row. It is used by noise cleanup (`noise_cleanup.rs:1822`) and
  Clean cut (`clean_cut/mod.rs:1208`).
- Clean cut's staging, rename and ffprobe check (`clean_cut/render.rs:76,804,906`)
  is the model for writing a derived file.
- Trap: keep `processing_kind` NULL. A new value breaks older apps
  (`docs/clean-cut.md:183-197`).
- Reveal only works for files with a `sessions` row (`main/index.ts:13411-13432`).

**Shortcuts, settings, UI.**
- Adding a global action touches:
  - `shared/global-shortcuts.ts`
  - `global-shortcut-bindings.ts`
  - `GlobalShortcutsConfig` (`shared/backend.ts:4283-4294`)
  - the labels and executor in `renderer/src/lib/global-shortcuts.ts`
    (39-61, 87-95)
  - `GLOBAL_ACTION_ROWS` (`shortcuts-settings.tsx:23-31`)
  - the intent table in `docs/remote-control.md:61-75`
- Shortcuts are stored in renderer settings (`capture.ts:62,511-518`).
  `clipMark` is unbound by default.
- Renderer capture config (`CaptureConfig`, `capture.ts:94-135`) needs
  three things for each new field: an optional field, a default, and a
  typeof guard in `loadCaptureConfig` (1376-1420).
- Studio:
  - `SessionTransport` (`studio/session-panel.tsx:67-170`) holds Record and
    Go Live… at the top of the inspector (owner rule: never in toolbar
    corners).
  - Space toggles Record (`studio-tab.tsx:113-131`).
  - The status bar dot and words come from `status-bar-session.tsx:22-45`
    and `lib/studio-session-view.ts:207-241`. CONTEXT.md:33-72 fixes
    "Recording" and "On air".
- Output page: `tabs/recording-tab.tsx`, with the "Local recording" and
  "Where recordings go" sections.
- Toasts go through `lib/toast.ts`. The type colours the icon only.
  `lib/finalization-toast.ts` ("MP4 ready" with a reveal action) is the
  pattern to copy.
- Budgets:
  - Eager renderer JS has ~5 KB headroom
    (`scripts/check-renderer-asset-budget.mjs:38-43`), so new UI is lazy.
  - The recording performance gate allows `maxActiveFfmpegProcesses: 2`
    (`scripts/smoke-recording-performance-app.mjs:41-48`).
  - Record latency: warm start p95 350 ms, stop p95 300 ms
    (`scripts/lib/record-latency-gate.mjs:16-23`).
- Monetisation doctrine (`entitlements.rs:11-18`): recording and streaming
  are free. Premium covers only features Videorc pays to serve.

## Design (Phase A)

The replay buffer is **a session whose only output is a rolling set of
segment files**. It reuses `start_session` end to end: the same compositor,
encoder, audio bus and FFmpeg child as a recording. The FFmpeg child gets a
segment output in place of a Matroska file:

```
-map <video> -map <audio> -c:v copy|<encoder> -c:a aac -b:a 192k
-f segment -segment_format mpegts -segment_time 2 -reset_timestamps 0
-segment_list <dir>/segments.csv -segment_list_type csv
-segment_list_size <K> -segment_list_flags +live  <dir>/seg-%06d.ts
```

- **Buffer dir.** It lives under the backend's app-data cache, mode 0700,
  one dir per arm. Use the existing managed-temp helper if there is one.
- **Pruning.** A backend task trims the dir once a second to the newest
  `K = ceil(N / 2) + 2` complete segments, using `segments.csv` (complete
  segments only) as the truth. The segment being written is never touched.
- **Free space.** Arming is refused when free space is under
  `4 × N × bitrate`.
- **Saving.** `replay.save` notes the press time and waits for the segment
  that contains it to close (≤ 2 s; timeout 4 s, then save what is
  complete). It then hard-links (or copies) the newest segments covering N
  seconds into a staging dir. Next it runs
  `ffmpeg -f concat -safe 0 -i list.txt -c copy -movflags +faststart` to a
  `.partial` file beside the target, checks the result with ffprobe, and
  renames it. Finally it inserts a Library row via
  `create_completed_session`, with `processing_kind` NULL.
- **Clip length.** The start is keyframe-aligned (D3), so a 30 s replay
  is 30-32 s long and needs no re-encode.
- **No session side effects.** A buffer-only session creates **no** session
  DB row, runs no finalization or MP4 export, stores no clip marks or
  captions, and emits no "Recording" or "On air" state. `session.stop` on a
  buffer-only session kills FFmpeg after a flush and deletes the buffer dir.
- **Renderer state.** The renderer sees a separate `replay.state` event
  (`off | starting | on | paused | error`, target seconds, buffered
  seconds, optional reason). It never sees a buffer-only session as
  "Recording".
- **Handover (Phase A).** Record or Go Live while the buffer is on: the
  renderer stops the buffer session (fast path: no finalization), starts
  the real session, and re-arms the buffer when that session ends. The
  buffer state reads `paused` in between.
- **Where it is configured.** The buffer uses the Output page's recording
  quality (D2). `StartSessionParams` gains an optional
  `replay?: { seconds }`. A buffer-only start sends
  `output.recordEnabled: false`, no streaming, and `replay`.

## Decisions (S0: owner, or executor at the recommendation)

| # | Question | Recommended | Alternatives |
| --- | --- | --- | --- |
| D1 | Free or Premium | **Free.** It is fully local, and the doctrine says recording is free. No `FeatureId`. | Premium: it would need a new `FeatureId` in both enums. |
| D2 | Buffer quality | **Same as the Output page recording settings** (one source of truth). The Output page shows estimated disk use. | Its own quality setting, or a cap at 1080p60: more UI, and a second canvas to keep in step. |
| D3 | Clip start | **Keyframe-aligned:** N to N+2 s long, instant, no re-encode. | Frame-exact trim: re-encodes the first GOP. Slower and needs a fallback encoder chain. |
| D4 | Save replay during a Phase A session (buffer paused) | **Recording on:** place a clip mark, with the toast "Replay buffer pauses while you record, so this moment was marked in your recording." **Stream-only:** a warning toast. Phase B removes the gap. | Refuse silently. Or block Record while the buffer is on (bad). |
| D5 | Default hotkey | **Unbound** (like Mark clip; never steal a game's key). The Replay section shows an inline "Set shortcut" field when unbound. | A default such as ⌥⇧S / Alt+Shift+S: it can collide with game binds. |
| D6 | Turn on at launch | **Setting "Turn on when Videorc opens", default off.** Arming is explicit, and the status bar always shows it is on (privacy: screen and mic are being written to disk). | Always remember the last state. |
| D7 | Where replays go | **`<recordings folder>/Replays/Replay YYYY-MM-DD HH-MM-SS.mp4`**, plus a Library row. | Flat in the recordings folder. Or no Library row (then Reveal does not work, see `main/index.ts:13411`). |

**S0 outcomes (owner, 2026-10-12: "I agree with everything, execute the
entire plan and create a pr"):**

| # | Outcome |
| --- | --- |
| D1 | **Free.** No `FeatureId`. The Output page's recording limits still apply, because the buffer composes at the Output quality. |
| D2 | **The Output page recording quality.** One canvas, one bitrate; the Output page shows the estimated disk use. |
| D3 | **Keyframe-aligned start.** A replay is N to N+2 s long, stream-copied, no re-encode. |
| D4 | **Mark-or-warn while the buffer is not on.** Recording on: the press places a clip mark and the toast says so. Stream-only or no session: a warning toast. With S7 in this PR the buffer rides along every session, so this only covers the restart gap at a session boundary. |
| D5 | **Unbound by default.** The Studio row and the Output section show an inline "Set shortcut" recorder while it is unbound. |
| D6 | **"Turn on when Videorc opens", default off.** Arming is explicit. |
| D7 | **`<recordings folder>/Replays/Replay YYYY-MM-DD HH-MM-SS.mp4`** plus a Library row (title "Replay", `processing_kind` NULL). |
| S7 | **In scope for this PR.** The segment output rides every session's FFmpeg child. Record or Go Live while the buffer is on restarts the buffer inside the new session (the backend stops the buffer-only session and starts the real one in `session.start`); when that session ends, the renderer re-arms a buffer-only session. Arming during a session attaches at the next session start. |
| S8 | **Approved.** With recording off and the buffer on, `clip.mark` (button, hotkey, voice "clip that") saves a replay instead of the "Recording is off" warning. |

Length options: 15 s, 30 s, 1 min, 2 min, 5 min. Default 30 s.

**Words** (S6 adds them to CONTEXT.md):
- **Replay buffer**: the feature and its switch.
- **Save replay**: the action.
- **replay**: the saved file.

Never call the saved file a "clip". *Clip* already means a clip mark.

## Slices: Phase A

### S0: Record decisions

1. Write the D1-D7 outcomes into this plan, either the owner's answers or
   "executor default" for each.
2. Confirm the words in CONTEXT.md terms with the owner if they change.

**Done when:** every D row has an outcome recorded.

### S1: FFmpeg capability check and pure replay logic (backend, no I/O)

1. Check the main FFmpeg on macOS, Windows and Linux for the `segment`
   and `mpegts` muxers, the `concat` demuxer and `aac_adtstoasc`:
   - macOS: run it locally.
   - Windows and Linux: check the pinned build manifests and scripts
     (`scripts/lib/ffmpeg-linux-pin.mjs`, the Windows FFmpeg pin), and add
     an `-muxers`/`-demuxers` assertion to the existing FFmpeg verification
     tests where a binary is available in CI.
2. New module `crates/videorc-backend/src/replay_buffer.rs` with pure
   functions and unit tests:
   - Parse `segments.csv` (`filename,start,end`).
   - `segments_to_prune(list, keep)`.
   - `select_segments(list, seconds, press_time) -> Selection`. It covers N
     seconds ending at the segment that contains the press, and reports the
     actual covered duration when the buffer holds less.
   - `segment_output_args(dir, seconds, video_mode)`: copy for the encoded
     bridges, inherit the encoder for the raw/legacy paths.
   - `concat_list(selection)` and `save_args(list, partial_path)`.
   - `replay_file_name(now)` and `required_free_bytes(seconds, bitrate)`.

**Done when:** `cargo test -p videorc-backend replay_buffer` is green, the
FFmpeg capability results are written into this plan, and the clippy gate
is clean.

### S2: Buffer-only session (backend)

1. `StartSessionParams.replay: Option<ReplayParams { seconds }>` in Rust
   and TS:
   - Add `#[serde(default, skip_serializing_if = "Option::is_none")]`,
     paired with `optionalSchema`.
   - Add a fixture to `protocol-fixtures/high-risk-contracts.json`.
2. `start_session` accepts a session with no file and no stream targets
   only when `replay` is set.
   - It builds the segment output with S1 args on every FFmpeg arg builder:
     encoded bridge, raw, and legacy.
   - Audio is encoded to AAC in the FFmpeg child.
3. Buffer-only sessions skip:
   - `create_session` (no DB row)
   - captions and clip-mark registration
   - finalization and MP4 export
   - "Recording"/"On air" session-status words

   Audit every `state.recording.is_some()` consumer and list in this plan
   the ones that needed a guard.
4. Lifecycle:
   - Clean `replay-buffer/` on backend start (crash leftovers).
   - Prune task as in Design.
   - On `session.stop`, kill FFmpeg after a flush and delete the dir.
   - Delete the dir on app quit.
5. Event `replay.state`, emitted on every change and once a second with
   `bufferedSeconds` while `on`. Add it to `BackendEventMap` and
   `runtimeEventSchemas`. Arming with too little free space fails with a
   clear message.

**Done when:**
- Cargo unit tests cover the args for each path, pruning, and "no DB row".
- A headless backend test using the test-pattern source arms for 40 s and
  sees only `K` segments on disk and no `sessions` row.
- The contract tests pass both the TS and Rust fixtures.

### S3: Save replay (backend)

1. Add `replay.save` RPC (a Mutation in `websocket_method_execution_policy`).
   It returns `{ path, seconds, sessionId }` or a typed reason (`off`,
   `empty`, `paused`).
2. Save flow as in Design: wait for the boundary, hard-link or copy to
   staging, concat-copy to `.partial`, ffprobe check, rename, then a
   `create_completed_session` row (title "Replay", `processing_kind` NULL).
3. Emit a `replay.saved` event. Saves are serialized: a second press during
   a save queues one more save and never runs FFmpeg twice at once.
4. Delete staging on success and on failure. A failed save never touches
   the live buffer.

**Done when:**
- A backend test arms with the test pattern and a sine tone, waits 40 s,
  and saves.
- ffprobe reports h264 + aac and a duration in [30, 32.5].
- The A/V analysis of the file (the analysis `test:scripts` already uses
  for sync) is within its existing threshold.
- The Library row exists, and Reveal resolves the file.

### S4: Handover with Record and Go Live (renderer and backend)

1. Renderer helper: when the buffer is on, Record or Go Live first stops
   the buffer session (fast path), then starts the requested session. When
   that session ends, re-arm the buffer if it is still enabled.
   `replay.state` reads `paused` in between.
2. Space, the command palette, remote intents and the global Record and
   Stream shortcuts all go through the same helper. No path may hit
   `"A capture session is already running"`.
3. D4 behaviour for Save replay while paused.
4. A buffer that fails to start never blocks Record or Go Live.

**Done when:**
- `pnpm smoke:record-latency:gate` passes with the buffer on (warm start
  p95 ≤ 350 ms) and with it off. Report both numbers.
- A vitest covers the helper's ordering and its re-arm after stop and after
  a failed start.

### S5: UI, shortcut, palette, remote intent (renderer, lazy-loaded)

Read `.claude/skills/videorc-design/SKILL.md` first. Use shadcn components
only.

1. **Studio `SessionTransport`.** A compact row under Record and Go Live…:
   - A **Replay buffer** switch.
   - When on: buffered/target time ("0:30") and a **Save replay** button
     with its shortcut hint.
   - The switch's only home is here. The Output page holds settings only.
2. **Output page section "Replay buffer"**:
   - Length (15 s to 5 min).
   - "Turn on when Videorc opens" (D6).
   - Estimated disk use at the current quality.
   - The Save replay shortcut field, with the inline "Set shortcut" field
     when unbound.
   - Where replays go (D7).
3. **Status bar**: "Replay · 0:30" with a neutral dot while on, and
   "Replay paused" during a session. Never "Recording" or "On air".
4. **Global action** `replay-save` → `replaySave`:
   - Wire every file listed under "What exists today → Shortcuts".
   - Command palette "Save replay".
   - Remote intent `replaySave` (`remote-surface.ts`, `remote_control.rs`,
     `docs/remote-control.md`).
5. **Toasts** via `lib/toast.ts`, copying the `finalization-toast.ts`
   pattern:

   | Case | Toast |
   | --- | --- |
   | Saved | "Replay saved", description "Last 0:30", action **Show in Finder** / **Show in folder** |
   | Buffer still filling | "Replay saved", description "Last 0:12, the buffer was still filling" |
   | Buffer off | Warning "Replay buffer is off", action **Turn on** |
   | Save failed | Error toast with the backend reason |

6. **Settings persistence.** `replayBuffer: { seconds, startOnLaunch }` in
   `CaptureConfig`, with a default and a typeof guard.

**Done when:**
- typecheck, lint, format and the desktop vitest suite are green.
- The renderer asset budget does not move: the UI is lazy, and any eager
  growth is a STOP.
- The owner checks by eye in **light and dark**: the Studio row, the Output
  section, the status bar and the toasts.

### S6: Smoke, docs, acceptance

1. New `pnpm smoke:replay-buffer` (package script, maintained, not a
   scratch probe). It runs the packaged dev app with the test pattern and
   fake audio, and:
   - Arms and waits N+10 s.
   - Saves via the global-shortcut path.
   - Asserts the ffprobe streams, the duration window and A/V sync.
   - Asserts the disk bound: the buffer dir stays ≤ `(K+1)` segments over
     3 × N.
   - Disarms, then asserts the dir is gone.
   - Covers Record while armed: buffer paused, recording correct, buffer
     re-armed after stop.
2. Extend `pnpm smoke:remote-control` with `replaySave`.
3. Docs:
   - Add the Words to CONTEXT.md.
   - Add a row to `docs/remote-control.md`.
   - Write `docs/replay-buffer.md`: design, disk and CPU cost, and the
     platform notes. Windows exclusive-fullscreen games may capture black
     through DXGI duplication, so recommend borderless windowed. Game audio
     needs system audio on in Sources.
4. Run the whole gate list in "Verification" and record the results here.

**Done when:** every Phase A row in Verification has its result written in
"As built".

## Slices: Phase B (after Phase A ships)

### S7: The buffer keeps running during Record and Go Live

1. When the buffer is on, every session (record, stream, both,
   dual-orientation) adds the segment output to its own FFmpeg child. Add
   it as a separate output with `-c:v copy` and its own AAC encoder, not
   inside the tee, so the record-only `pcm_s16le` stays. This removes the
   S4 handover: arming during a session attaches at the next session start.
2. Save replay works mid-session, including stream-only sessions, which
   covers plan 068's "stream-only clipping".
3. Same FFmpeg process count, so `maxActiveFfmpegProcesses: 2` holds,
   apart from the short concat during a save.

**Done when:**
- `smoke:recording-studio`, `smoke:recording-matrix`,
  `smoke:record-latency:gate` and `smoke:replay-buffer` pass, plus a
  stream smoke with the buffer on.
- The recording file is byte-for-byte unaffected in ffprobe stream layout.

### S8: Mark clip and "clip that" save a replay when there is no file (owner call)

When recording is off and the buffer is on, `clip.mark` (button, hotkey or
the voice "clip that") saves a replay instead of the "Recording is off"
warning. This needs an owner yes first, because it changes what a voice
command does.

## Verification

| Slice | Proof |
| --- | --- |
| S1 | `cargo test -p videorc-backend replay_buffer`, `cargo clippy -p videorc-backend -- -D warnings`, FFmpeg capability table |
| S2 | cargo tests (args per path, prune, no DB row); `pnpm --filter @videorc/desktop test` (contracts); protocol fixture tests in both languages |
| S3 | backend save test: ffprobe h264+aac, duration [N, N+2.5], A/V within the existing threshold, Library row + Reveal |
| S4 | `pnpm smoke:record-latency:gate` with the buffer on and off; helper vitest |
| S5 | `pnpm typecheck && pnpm lint && pnpm format:check`, desktop vitest, renderer asset budget unchanged, owner by-eye in light and dark |
| S6 | `pnpm smoke:replay-buffer`, `pnpm smoke:remote-control`, `pnpm smoke:recording-studio` (buffer off: unchanged), `pnpm smoke:recording-matrix`, `pnpm probe:preview-lifecycle`, `pnpm build`, `cargo fmt --check --all` |
| Owner | A real game on macOS: arm, play, press the hotkey while the game has focus, watch the replay. Then the same on Windows with a borderless game. |

Cost checks:
- Run `smoke:recording-performance` against a buffer-only session to get
  CPU/GPU and RSS numbers. Report them.
- No CPU budget exists yet, so nothing gates here.

Not provable locally: Windows and Linux runtime. CI covers compile and unit
tests only. State this plainly in the handoff and never claim them.

## Out of scope

- Game capture hooks (Windows exclusive-fullscreen injection, the OBS
  game-capture equivalent), and window capture as a default (macOS F-013).
- In-memory buffering. The disk ring is simpler, survives backpressure,
  and its size is bounded.
- Frame-exact trimming (D3 alternative).
- A Library "Replays" filter.
- Posting replays to X or YouTube.
- Separate source (ISO) replays.
- A tray or menu-bar indicator. None exists today.

## STOP conditions

- Any platform's main FFmpeg lacks `segment`, `mpegts`, `concat` or
  `aac_adtstoasc`. Do not rebuild or swap FFmpeg without the owner.
- With the buffer **off**, any existing smoke or gate changes result.
- A buffer-only session creates a `sessions` row, runs finalization, or
  shows "Recording" or "On air" anywhere.
- `smoke:record-latency:gate` breaks budget with the buffer on, and the
  handover cannot fix it inside S4.
- A saved replay fails ffprobe, or its A/V sync is outside the existing
  threshold.
- The disk bound fails: the buffer dir grows past `K+1` segments.
- The eager renderer budget moves.
- A new `processing_kind` value seems needed, or a new wire `Option` is
  added without `skip_serializing_if`.
- Two VideoToolbox sessions are needed at once in Phase A. The design keeps
  one, and plan 006 records stalls with two.

## As built

### S1: FFmpeg capability check

| Platform | Binary | `segment` | `mpegts` (mux+demux) | `concat` | `aac_adtstoasc` | How |
| --- | --- | --- | --- | --- | --- | --- |
| macOS | `vendor/ffmpeg/current/bin/ffmpeg` 8.1.1 (own build, 2026-10-12) | yes | yes | yes | yes | run locally: `-muxers`, `-demuxers`, `-bsfs` |
| Windows | BtbN `ffmpeg-n8.1.2-34-g9b6c8969e0-win64-lgpl-8.1` (`vendor/ffmpeg/windows-pin.json`) | expected | expected | expected | expected | BtbN LGPL autobuilds enable every core muxer/demuxer/bsf; `scripts/preflight-windows-package.mjs` now runs `-muxers`/`-demuxers`/`-bsfs` on the Windows host and refuses to package without them (`scripts/lib/windows-ffmpeg-capabilities.mjs`) |
| Linux | BtbN `ffmpeg-n8.1.2-34-g9b6c8969e0-linux64-lgpl-8.1` (`vendor/ffmpeg/linux-pin.json`) | expected | expected | expected | expected | same build family; `scripts/fetch-ffmpeg-linux.mjs` and `scripts/validate-linux-release-artifact.mjs` now fail closed without the three listings (`scripts/lib/ffmpeg-linux-pin.mjs`) |

"expected" is not "verified": the Windows and Linux binaries cannot run on
this Mac. Their package and release gates are the verification, and they
fail closed.

`crates/videorc-backend/src/replay_buffer.rs` holds the pure half: the CSV
list parser, `keep_count` (`ceil(N/2)+2`), `segments_to_prune`,
`select_segments`, the concat script, the segment-muxer and save argument
tails, `replay_file_name`, `required_free_bytes` and the `split` rewrite
for the raw and legacy encoder graphs. `cargo test -p videorc-backend
replay_buffer`: 13 passed.
