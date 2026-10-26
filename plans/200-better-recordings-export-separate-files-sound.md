# Plan 200: Better recordings — exports, separate files and sound

> **Executor instructions**: Follow this plan group by group. The groups touch
> different files and run in parallel in their own worktrees (see "Execution
> layout"). Inside a group, go slice by slice. The owner's standing rule
> applies: write and commit every slice first, then run the Rust compile and
> tests and the smokes once at the end (slice E). If a STOP condition hits,
> stop that slice, write down why under "As built", and go on with the next
> slice. Do not improvise around a STOP. When done, fill "As built" and update
> this plan's entry in `plans/README.md`.
>
> **Drift check (run first)**: `git log --oneline 27f8f89e..origin/main --
> crates/videorc-backend/src apps/desktop/src/renderer/src/lib/separate-source-recordings-view.ts
> apps/desktop/src/renderer/src/components/tabs scripts/lib`. If a commit
> touches a file your group edits, read it before you start. Read code from
> `origin/main` in your own worktree. The shared checkout is often weeks out
> of date.

## Status

- **Status**: EXECUTING 2026-10-26. The owner said "execute the entire plan
  and create a PR", so every owner decision below takes its recommendation.
- **Priority**: P1. Owner request, 2026-10-25: "investigate how good our
  exporting of videos is with separate sources, sound, system audio etc.,
  investigate our performance, and create a plan to make it even better."
- **Effort**: L. Four groups and 19 slices. The groups run in parallel.
- **Risk**: MEDIUM. Most slices are small and local. The two risky ones are
  D1 (shedding the separate files under encoder pressure, in the encoder
  bridge) and D2 (the Camera file at the camera's own size, in the
  compositor). Both have STOP conditions that defer them without blocking
  the rest.
- **Category**: Quality and performance of recording output: export
  (MKV → MP4), separate source recordings (plan 157/158/198), the audio bus,
  Clips (plan 181/199), and repair hygiene.
- **Planned at**: commit `27f8f89e` (origin/main, release 0.12.0),
  2026-10-26.
- **Route**: The orchestrator planned it, fit 10. Owner route per group:
  - Group A (sound and Clips): Implementation, fit 9.
  - Group C (export and files): Implementation, fit 9.
  - Group D (separate files and picture): Diagnose + Implementation, fit 9.
  - Model lane: `fable-5` for all groups by the CLAUDE.md table. On
    2026-10-26 the session account's Fable weekly quota was used up (cswap:
    100% until 06:00), so every group runs on Opus 5.5. That is the strongest
    available model.

## How we found this

Four read-only investigations ran on 2026-10-25/26.

1. A code audit of the export/finalization pipeline.
2. A code audit of separate source recordings.
3. A code audit of the audio pipeline.
4. Measurements of the owner's real packaged-app files and logs. These were:
   - take `e4ad9e44` (Combined + Camera + the dead Screen stub);
   - 14 ordinary takes from 2026-10-25;
   - three Clips;
   - `backend.log` and `backend.log.1`;
   - the SQLite DB, read-only.

Tools: `ffprobe`, `ffmpeg` (`ebur128`, `silencedetect`, `freezedetect`), and
PCM cross-correlation.

### What is already good (keep it)

- **The separate files line up.** Combined and Camera of take `e4ad9e44`
  have sample-identical audio: 0 of 741,376 samples differ, the
  cross-correlation lag is 0, and the AAC bitstreams have the same MD5. They
  have identical video timestamps (464 frames each) and identical
  durations.
- **The export is crash-safe.** It uses private staging, a recovery record,
  fsync of the file and its folder, a no-replace rename, and a single export
  slot.
- **Colour tags are right.** Every MP4 is H.264 High tagged BT.709/BT.709/
  BT.709 limited range, has `moov` at the front, uses a 2 s GOP, and has
  video `start_time` 0.
- **Sound is clean.** No clipping (`audioMixClippedSamples` 0), no mid-file
  dropouts in 7 files, DC offset at 3–5e-6.
- **Short exports are fast.** From Stop to MP4 published: median 1.30 s
  (0.58–2.26 s) across 37 takes.

### What is wrong or weak (evidence)

| # | Finding | Evidence | Slice |
|---|---|---|---|
| F1 | **Clips squash one frame and ~33 ms of audio at every 2 s segment join.** The file says 31.5 s but holds 32.0 s. | Clip `18-38-26`: 15 frames with a 1-tick duration, and 30.48 fps by count. `segments.csv` stores the start of the last frame as the segment end. `concat_list` writes that as `duration` (`replay_buffer.rs:70`, `:222-231`). | B1 |
| F2 | **The mic's mono fold decides per sample whether a channel is "silent".** On a 2-input interface with the mic on input 1, input 2's noise (about −90 to −105 dBFS) flips each sample between the full mic and half the mic. That is roughly −11 dB of signal-dependent distortion. A true stereo mic gets a one-sample jump at every zero crossing. | `centered_voice_sample`, `audio.rs:1112-1124`. Tests cover exact zeros only. | A1 |
| F3 | **MP4 frame times sit on a millisecond grid.** Frame durations alternate 33/34 ms (in an MP4 at 1/16000: 528/544). Editors and MediaInfo read that as variable frame rate, which is the classic Premiere audio-drift trap. | The MKV time base is 1/1000. The export stream-copies it (`mp4_export_args`, `recording.rs:7925`). | C1 |
| F4 | **Videorc leaves hidden files behind.** 41 `.videorc-repair.*` temps (2.86 GB, June–Oct, 16 with no `moov`). 18 `.videorc-backups` copies (2.43 GB) that no DB row points at. Plus `.videorc-iso-*` leftovers. The disk is 98% full (19 GiB free). | Repair temps leak on quit, on timeout (ffmpeg is not killed), and on backup/rename errors. Nothing sweeps them (`repair.rs:1653`, `:1335`; `ffmpeg_work.rs:330`). Delete never removes a backup (`storage.rs:5565`). A stopped-early ISO export writes into the hidden folder (`recording.rs:7536`). | C6 |
| F5 | **A failed repair can silently re-encode the user's MP4 badly.** The repaired output drops faststart, `-map 0`, chapters and BT.709 tags, and re-encodes audio at 192k. | `build_repair_args`, `repair.rs`. | C7 |
| F6 | **Record+stream takes lose audio quality twice.** The MKV already holds AAC 160k, and the export re-encodes it to AAC 256k. | `recording.rs:20486-20490` vs `:7939`. | C2 |
| F7 | **Export forces the H.264 metadata filter and BT.709 tags onto any MKV,** including imports (HEVC/VP9/full-range). | `mp4_export_args`; `library-tab.tsx:1221`. | C2 |
| F8 | **In a take with separate files, Combined waits behind the separate files' exports.** | Take `e4ad9e44`: Camera was published at +1.065 s, Combined at +1.691 s after 556 ms in the queue. | C4 |
| F9 | **There is no free-space check before an export or a repair backup.** An 84-min record+stream MKV was 18.96 GB, and its export needs the same again. The only space check is a one-time "under 1 GB" notice at Record, which ignores separate files (3× the video). | `recording.rs:3922-3931`, `24802-24838`. | C5 |
| F10 | **The quality check times out on long recordings.** `quality assessment timed out after 900s` on both long takes (10-21, 10-24), after 38 min of decoding the whole file. Meanwhile it competes with the next take. | `backend.log`. | C8 |
| F11 | **With separate files at 4K, the Combined file can be damaged.** Three 4K30 hardware encodes get about 21 fps each on an M4. In the 4K runtime case Combined ended 0.9 s short. A writer that falls behind the 2-batch history gets a terminal error, and Combined is a batch member. | `plans/158:648-677`; `compositor_source_iso_batch.rs:155-160` → `encoder_bridge.rs:4460`. The performance check sends ISO as off (`performance_check.rs:660`). | D1, D4 |
| F12 | **The Camera file is drawn into the canvas.** A 1080p webcam on a 4K canvas is upscaled with **nearest-neighbour** sampling and encoded at the full 30 Mbps. A 4:3 or portrait camera is pillarboxed. | `source_iso.rs:762-777`; `compositor.rs:5490-5491`, `:11358-11366`; `metal_compositor.rs:1195-1209`. | D2, D3 |
| F13 | **Recording compositors point-sample every draw.** The camera inset in Combined (a 1080p/4K camera minified into a small bubble) is drawn with the nearest sampler, which shimmers on fine detail. | `compositor.rs:5483-5487` (smooth only for the native preview). | D3 |
| F14 | **The separate files carry nothing an editor can sync on:** no `creation_time`, no timecode, no chapters. Markers live only in SQLite. | `mp4_export_args`; plan 152 line 568. | C3 |
| F15 | **Nothing protects the mic from clipping.** Up to +24 dB of gain ends in a hard clamp at 0 dBFS. The peak limiter runs only while system audio or a sound is mixed. | `audio.rs:899`; `session_audio.rs:5747`. | A2 |
| F16 | **A mic whose macOS device runs at 44.1 kHz is never checked.** The AUHAL input asks for 48 kHz without reading the device rate. | `audio.rs:1251-1330`. | A3 |
| F17 | **The DB stores the MKV size as the published MP4's size** (12 of 14 numbered files). | `file_size_bytes` vs the files on disk. | C6 |
| F18 | **Clips never fsync before the rename,** and their `.partial` files are never cleaned up. | `replay_buffer.rs:284`, `:1376`. | B2 |

### Not in this plan (owner calls or bigger work)

- **Recording bitrates.** 4K30 is 24.6–30.5 Mbps (0.10–0.12 bits/pixel/
  frame, no B-frames), against YouTube's 35–45 Mbps for 2160p30. 1440p30 is
  8 Mbps. Raising them costs disk on a machine that is 98% full. That
  belongs in its own plan, with a by-eye A/B. (Owner decision D5.)
- **Multitrack Combined** (Mix / Mic / System as separate tracks). This is
  OBS parity and the Windows/Linux answer to separate files. M size, its own
  plan.
- **Screen file at native capture size** (a 5K Retina screen recorded into
  a 1080p canvas loses detail). The capture size is tied to the canvas. L.
- **Separate files on Windows and Linux.** L, high risk.
- **Orphaned `.videorc-backups` (2.43 GB).** They are not deleted
  automatically, because a backup can be the last pre-repair copy of a file
  the user renamed in Finder. 3,702 of 3,707 session paths are missing
  because files were renamed. A Storage view with "Delete backups" needs UI
  work. (D6.)
- **Mic in-process resampling for non-48 kHz devices.** A3 only makes the
  problem visible.
- **The live voice chain** (high-pass, noise gate, compressor), a LUFS
  meter, and loudness export. Measured loudness is −21 to −22 LUFS with true
  peak −4 to −7 dBTP: fine for raw footage.
- **The ~173 ms of digital zero at the start of the mic**, a cold-start pad.
  Low.

## Owner decisions (recommended defaults; execution starts on them)

| # | Question | Recommendation (taken) |
|---|---|---|
| D1 | Timecode + `creation_time` on every Videorc recording, or only on takes with separate files? | **Every recording.** One rule, and editors can sync with other cameras too. |
| D2 | Write markers into the MP4 as chapters? Plan 152 scoped this out. | **Yes.** The chapters are a snapshot at export; markers renamed later stay in the Library. |
| D3 | Separate files at 4K/60 on a Mac that can't keep up? | **Allow, but protect Combined.** The separate files stop first under encoder pressure, with a clear toast, and the Output row warns at 4K/60. Do not block. |
| D4 | Camera file size? | **The camera's own size, never larger than the canvas,** with bitrate scaled by pixel count. No upscale, no pillarbox. |
| D5 | Raise recording bitrates now? | **No.** It gets its own plan (disk). |
| D6 | Auto-delete orphaned backups? | **No.** Delete a backup only together with its recording. |
| D7 | Quality check on long recordings? | **Sampled above 20 min:** first 60 s, last 60 s, and 4 evenly spaced 30 s windows. No automatic repair above 20 min; issues are reported instead. |

## Execution layout

Three worktrees, all off `27f8f89e`:

| Group | Worktree | Branch | Files (owner) |
|---|---|---|---|
| A + B | `../videorc-wt-200-sound` | `plan-200-sound` | `audio.rs`, `session_audio.rs` (fold + limiter only), `replay_buffer.rs`, macOS mic open path |
| C | `../videorc-wt-200` | `plan-200-better-recordings` (the PR branch) | `recording.rs` export/finalization/disk notice, `recording_finalization.rs`, `repair.rs`, `repair_service.rs`, `storage.rs`, `source_iso.rs` (publish/export paths only), `main.rs` startup sweep, renderer Library bits |
| D | `../videorc-wt-200-iso` | `plan-200-iso` | `compositor.rs`, `metal_compositor.rs`, `compositor_source_iso_batch.rs`, `encoder_bridge.rs`, `source_iso.rs` (leg size/bitrate only), `performance_check.rs`, renderer Output row |

- **Rust builds are serialized across worktrees:** prefix every `cargo`
  command with `/tmp/claude-501/plan200-cargo.sh`, which holds one global
  lock. The disk had 19 GiB free when planned. If `df -g ~` shows less than
  6 GiB free, stop building and report.
- Groups A and D are merged into the PR branch at the end. Then slice E
  runs once on the merged tree.

---

## Group A: sound

### A1. The mic fold decides per block, not per sample

**Change** (`audio.rs`):
- Replace `centered_voice_sample` with a small stateful `VoiceFold` held by
  each mic stream (the CoreAudio callback path, the bus's mic path at
  `session_audio.rs:3939` and `:6089`, and the Windows/Linux worker path if
  it folds too).
- Per call block, take each channel's mean-square energy and smooth it with
  a one-pole of about 150 ms. Pick weights from the relative level of the
  two channels:
  - both within 20 dB: average them (0.5/0.5);
  - one channel more than 20 dB below the other: use the louder one alone
    (1/0). Return to averaging when the gap falls under 12 dB (hysteresis);
  - both under −110 dBFS: average them (keeps exact zeros at zero, and
    never gates).
- Crossfade the weights linearly across the block from the previous
  block's weights, so a mode change never clicks.
- `process_interleaved_f32` keeps its signature for callers that don't
  have state, using a one-shot fold. Every live mic path uses `VoiceFold`.

**Tests**:
- **Interface case:** a 440 Hz mic at −20 dBFS on channel 1 and Gaussian
  noise at σ=1e-5 on channel 2 give an output RMS within 0.1 dB of the
  input. Today it comes out about −6 dB, with distortion.
- **True stereo:** equal-level L/R gives the average. A sine crossing zero
  on one channel never gives a one-sample jump.
- Exact silence stays silence.
- **No clicks:** the largest sample-to-sample step on a mode switch stays
  under the step at a steady state plus 1%.
- The golden `MIC_ONLY_GOLDEN_SHA256` (`session_audio.rs`) changes by
  design: the fixture's one-channel-silent stretches now crossfade. Recompute
  the pinned digest on macOS and say why in the comment. The byte-for-byte
  `reference_writer_bytes` comparison must still pass on every platform.

**STOP** if the Windows/Linux worker fold lives in FFmpeg args rather than
Rust (`aformat=…:stereo` upmix). Then that path keeps FFmpeg's fold; note it.

### A2. The mic-only path gets the peak limiter too

**Change** (`session_audio.rs`):
- Run `PeakLimiter` on every session, not only while mixing. Unity gain is
  exact, so a mic that stays under −1 dBFS is byte-identical.
- Count clipped samples on every path (`audioMixClippedSamples`).
- Keep the `+24 dB` gain range.

**Tests**:
- A mic-only fixture under the ceiling is byte-identical to the no-limiter
  output.
- A mic-only fixture at +12 dB that would clip comes out at or under the
  −1 dBFS ceiling, and the clipped counter rises.
- The soundboard and system-audio mix tests are unchanged.

### A3. A non-48 kHz mic on macOS is visible, not silent

**Change** (`audio.rs`, the macOS AUHAL open):
- Read the input device's nominal sample rate
  (`kAudioDevicePropertyNominalSampleRate`) before setting the client
  format. When it is not 48,000:
  - log it with the device name;
  - add a Health warning: "‹Mic› runs at 44.1 kHz. Set it to 48 kHz in
    Audio MIDI Setup for the best recording." Use the existing Health event
    plumbing.
- If the AUHAL refuses the 48 kHz client format on that device, surface
  that same message as the reason the mic did not open.

**Tests**: a unit test for the message builder and the rate check (a pure
function). There is no hardware test.

**STOP** if reading the property needs new unsafe FFI beyond the existing
CoreAudio bindings in the file. Then log only, and note it.

## Group B: Clips

### B1. Clips keep every frame at segment joins

**Change** (`replay_buffer.rs`):
- In `concat_list`, give each segment `duration = next.start − this.start`
  when a next segment exists. Give the **last** segment no `duration` line,
  so the concat demuxer reads it from the file.
- `select_segments` measures coverage the same way: a segment's length is
  the gap to the next start, and the last one is its listed span plus one
  frame (`1/fps`, or the median start gap when fps is unknown).

**Tests**:
- A `concat_list` unit test with three segments whose CSV ends are one
  frame short: the durations equal the start gaps, and the last segment has
  no `duration`.
- **Real-file test** (ignored by default, run in slice E): build a 3-segment
  ring with the bundled ffmpeg at 30 fps, save it, and assert
  `nb_frames == round(duration × 30)` and that every packet duration
  equals one frame.

### B2. Clips are durable and leave nothing behind

**Change** (`replay_buffer.rs`):
- `sync_all` the saved MP4 before the rename into `Clips/`.
- On ring start, delete `*.partial` files in the Clips folder that are
  older than the start and owned by no save in flight.

**Tests**: a unit test for the sweep's name filter. It never touches a
non-`.partial` file.

---

## Group C: export and files

### C1. Exported MP4s have exact frame times

**Change** (`recording.rs`, `mp4_export_args` and its callers):
- For Videorc-captured H.264 (Combined and the separate files), add
  `-bsf:v setts=time_base=1/<fps>:prescale=1:ts=round(PTS)` to the
  existing H.264 metadata filter chain. Here `<fps>` is the take's integer
  frame rate, from the probe's `r_frame_rate` or the session's video
  settings.
- This snaps every packet to its own frame tick. It keeps real gaps where
  they are and never re-indexes. It was proven on 2026-10-26 with the
  bundled ffmpeg 8.1.1: a 1/1000 MKV became a 30/1 MP4 with every frame
  exactly 512/15360.
- If ffmpeg fails with the filter (for example non-monotonic DTS from a
  VFR source), log it and retry the same export without `setts`, once.
- Do not add the filter for imports or a non-integer rate.

**Tests**:
- Arg-builder unit tests for 30, 60 and "no fps".
- **A real-file test with the bundled or system ffmpeg** (it skips with a
  log line when no ffmpeg is present): a synthetic 3 s 30 fps MKV muxed at
  1/1000 exports to an MP4 whose packet durations are all equal.

### C2. Export keeps audio that is already AAC, and only tags H.264

**Change**:
- The export probe already runs. Extend it to read the video `codec_name`
  and the audio `codec_name`.
- Audio already AAC (record+stream takes): `-c:a copy`. Otherwise AAC 256k
  as today.
- Video not `h264`: skip `h264_bt709_color_tag_args`,
  `h264_bt709_vui_rewrite_bsf_args` and `setts`.

**Tests**: arg-builder unit tests for PCM+H.264, AAC+H.264 and AAC+HEVC.

### C3. Editors can sync and navigate: creation time, timecode and chapters

**Change**:
- Every Videorc recording export adds:
  - `-metadata creation_time=<take start, UTC, RFC 3339>`;
  - `-timecode <HH:MM:SS:FF>`, the local time of day at the take's
    `started_at`, frames from the sub-second at the take's fps.
- The separate files are rows with `id = <take_id>-<role>`, and they copy
  `started_at` from Combined. All three files of a take therefore carry the
  same creation time and the same timecode.
- **Markers become chapters:** read the take's session markers (the
  Combined session id, for all three files) and write an ffmetadata file
  with `[CHAPTER]` entries. Each chapter starts at a marker, with a first
  chapter "Start" at 0 when the first marker is later than 0. Its title is
  the marker label, or "Marker N" when there is none. It ends at the next
  marker or at the file's duration. Map it with `-map_chapters 1`.
  - Never use `-map_metadata -1`: on 2026-10-26 it dropped the chapter
    titles.
- Write the ffmetadata file in the private staging folder, so it goes
  away with the staging.
- The timecode adds a `tmcd` data track, and chapters add a `text` data
  track. Every analyzer and gate that counts streams must keep working.
  Check `repair.rs` analysis, `scripts/lib/*analy*`, the separate-source
  take gates, the record-latency analyzer, the poster step and the noise
  cleanup input maps. They must select `v:0`/`a:0` rather than "the only
  streams". Fix any that break.

**Tests**:
- Unit tests for the timecode string: 30 and 60 fps, a midnight edge, and
  sub-second frames.
- A unit test for the ffmetadata builder: escaping `=`, `;`, `#`, `\` and
  newlines in labels; an empty marker list gives no chapters input.
- A real-file test (skips without ffmpeg): an export with two markers has
  two titled chapters plus "Start", a `tmcd` track, and the same timecode on
  two files of one take.

### C4. Combined exports first

**Change** (`recording_finalization.rs`, `recording.rs`, `source_iso.rs`):
- Replace the FIFO `export_slot` mutex with a slot that serves Combined (and
  ordinary single-file) exports before separate-file exports. Keep one
  export at a time.
- A separate-file job queued before its take's Combined job yields to it.
- Never starve: a separate-file job that has waited more than 60 s goes
  next.

**Tests**: a unit test that queues Camera, Screen, then Combined, and
asserts that Combined runs first; and the starvation bound.

### C5. Disk space is checked where it runs out

**Change**:
- **Before an export** (automatic or manual) and **before a repair
  backup**:
  - require free space ≥ input size × 1.05 + 512 MiB on the output volume;
  - if there isn't enough: do not start, keep the MKV, and fail the job
    with "Not enough disk space to finish the MP4 (needs ‹X›, ‹Y› free).
    Your recording is safe as MKV; free some space and use Export MP4."
- **The Record-time notice** becomes "minutes left". Estimate the bytes per
  minute from the video bitrate × (1 + the number of separate files), plus
  audio. Double it for the export peak. Show the notice when there is room
  for less than 20 minutes, while keeping today's 1 GB floor.

**Tests**: unit tests for the required-space math and the minutes-left
estimate (with and without separate files).

### C6. Videorc cleans up after itself

**Change**:
1. **Startup sweep, before the repair service starts.** In the default
   recordings folder and in every distinct parent folder of sessions from
   the last 90 days, delete files named `.<stem>.videorc-repair.<ext>`.
   - This is safe by construction: `safe_replace` keeps the original in
     place until the final rename, so a temp is never the only copy.
   - Log a count and a byte total.
2. **Repairs stop when they should.** A repair timeout and shutdown cancel
   the repair (the `is_cancelled` flag that `run_output_cancellable`
   already honours), so ffmpeg is killed. Quit and update wait for a
   cancelled repair to exit (`ffmpeg_work.rs` permit).
3. **Every error path deletes the temp:** a failed backup copy and a failed
   rename in `safe_replace` included.
4. **Deleting a recording also deletes its backup**
   (`.videorc-backups/<file name>`) in `storage.rs` delete.
5. **A stopped-early separate file's "Export MP4" publishes into the public
   recordings folder** beside Combined, with its `-screen`/`-camera` name,
   using the same no-replace publish. It no longer writes into the hidden
   `.videorc-iso-*` folder.
6. **The hidden `.videorc-iso-<uuid>/` folder is removed** when it is empty
   after a publish or an export, and when its row is deleted.
7. **Crash recovery:** an interrupted separate-file row
   (`status='failed'`, reason "partial media is available for recovery")
   offers Export MP4 when ownership verifies. Map that reason in
   `separate-source-recordings-view.ts` to "Stopped early".
8. **`file_size_bytes` is the published MP4's size** after an export.

**Tests**:
- **Sweep:** a temp dir with a repair temp, a normal MP4, a
  `.videorc-backups` file and a `.partial`. Only the repair temp goes.
- **`safe_replace`:** a failing rename leaves no temp.
- **Delete:** the backup goes with the recording.
- **Export publish path:** a stopped-early separate file lands beside
  Combined.
- **Empty-folder removal.**
- **Size:** after an export, `file_size_bytes` matches the MP4.
- **The renderer view test** for the interrupted reason.

### C7. A repair keeps the file whole

**Change** (`build_repair_args`):
- Add `-map 0` (with the filters when re-encoding) and `-map_chapters 0`.
- Add `-movflags +faststart` for MP4/MOV outputs.
- Add the BT.709 colour tags when the video is re-encoded.
- Encode audio at AAC 256k instead of 192k when it is re-encoded.

**Tests**: unit tests for the arg builder, for copy, CFR transcode and
interpolate plans.

### C8. Long recordings get a quick quality check, not a 15-minute decode

**Change** (where the quality gate starts, `recording.rs` ~`11664`, and
`repair.rs` analysis):
- When the duration is over 20 min:
  - analyze sampled windows: first 60 s, last 60 s, and 4 evenly spaced
    30 s windows, each with `-ss`/`-t`;
  - fold the issues into one report marked `sampled: true`;
  - never auto-repair: show the report;
  - the Library/Health copy says "Quick check (long recording)".
- Short recordings keep today's full check.

**Tests**:
- Unit tests for the window plan (60 min → 6 windows, 21 min, edges).
- "No auto-repair above 20 min" through the gate's decision function.

---

## Group D: separate files and picture

### D1. Combined is never the one that fails: the separate files shed first

**Change** (`encoder_bridge.rs`, `compositor_source_iso_batch.rs`,
`source_iso.rs`):
- When any batch member falls behind, the coordinator retires the Screen
  and Camera roles first. The trigger is a lag of more than one tick past
  the bounded history: today's "fell behind" error, or a bridge lag over
  250 ms.
- Retiring a role ends its file cleanly at that boundary. It is "Stopped
  early" with a 1 s or longer export allowed.
- The role reason is "Stopped to keep the main recording smooth".
- Combined then continues outside the batch (or as the only member), with
  no terminal error.
- Combined gets a terminal lag error only when it falls behind with no
  separate files left.
- One toast per take ("Separate files stopped so the main recording keeps
  up"), through the existing role-failure toast path.

**Tests**:
- A batch unit test: Combined lags past the history with Screen and Camera
  active. Screen and Camera retire, and Combined's next `select` returns a
  frame and not `Err`.
- The existing lockstep tests still pass.
- A runtime case in `smoke:separate-source-runtime` if the harness supports
  forcing lag (an env hook like `VIDEORC_SOURCE_ISO_RUNTIME_STALE_LATCH`).
  Otherwise note it.

**STOP** if Combined's frame selection cannot leave the batch without
restructuring the bridge read loop (more than ~300 lines). Then implement
only the "retire separate roles when any member lags" half, measure, and
write down what remains.

### D2. The Camera file is the camera's own size

**Change**:
- At arm time, fix the Camera leg's output size to the camera's current
  format, fitted inside the canvas. Never upscale, round to even, and keep
  the aspect ratio. Example: a 1920×1080 camera on a 3840×2160 canvas gives
  1920×1080. A 1280×960 camera on 1920×1080 gives 1280×960.
- The leg's compositor draws the camera to fill that size (aspect-exact, no
  bars). The encoder bridge and the muxer use that size.
- Bitrate = canvas bitrate × (leg pixels / canvas pixels), with a floor of
  4 Mbps at 1080p30-equivalent.
- If the camera's format changes mid-take, the leg keeps its arm-time size
  and scales, as today's canvas leg does.
- The Screen leg is unchanged (canvas size).

**Tests**:
- Unit tests for the size/bitrate function: 1080p on 4K, 4K on 1080p
  (capped at the canvas), 4:3, portrait, odd sizes.
- The separate-source fixture asserts the Camera file's dimensions match
  the camera fixture's size, and that there is no letterbox (its analyzer
  checks "no off-canvas video" today; extend it).

**STOP** if the ISO compositor leg cannot render at a size different from
the primary canvas without changing the shared frame store or the batch
leases. Then keep canvas size but apply D3's smooth sampling to the Camera
leg, and note it.

### D3. Scaled draws in recordings are smooth; 1:1 draws stay exact

**Change** (`compositor.rs`, `metal_compositor.rs`):
- In recording, stream and ISO compositors, a source draw whose destination
  size differs from its source crop by more than 0.5% uses
  `GpuSourceSampler::Linear`. 1:1 draws keep the nearest sampler, so a 1:1
  screen stays pixel-exact.
- The CPU compositor path must agree in kind. If it point-samples a scaled
  camera, give it bilinear for scaled draws. The camera mask paths
  (CPU/Metal/FFmpeg) must still agree: see memory `camera circle mask
  paths`.

**Tests**:
- A Metal unit test: a 2×2-checker texture minified 4:1 renders as uniform
  grey with linear sampling (it would alias with nearest).
- A 1:1 draw is bit-exact against the source.
- Existing goldens that change because a camera is now smoothed are
  re-pinned with a comment.

**STOP** if more than ~10 golden tests change, or the CPU/Metal parity
tests cannot be brought back within a small tolerance. Then apply linear to
the ISO Camera leg only, and note it.

### D4. The app says what separate files cost before Record

**Change**:
- `performance_check.rs` counts separate-file legs: it sends the real
  `separate_source_recordings` value, and the encoder budget counts Combined
  + Screen + Camera (at D2's size) + stream.
- The Output row (`recording-tab.tsx`, the Separate source recordings
  switch) shows a notice when the switch is on at 4K or 60 fps. Notice text:
  "Separate files at ‹profile› use about 3× the encoder. If your Mac falls
  behind, Videorc stops the separate files and keeps the main recording."
  Use shadcn only, following `.claude/skills/videorc-design/SKILL.md`, and
  check both themes.

**Tests**: a renderer unit test for when the notice shows, and a Rust unit
test that the performance check params carry the switch.

---

## E. Gates and acceptance (once, on the merged branch)

Run in this order and record the results under "As built":

1. **Rust:**
   - `cargo fmt --check --all`
   - `cargo clippy -p videorc-backend -- -D warnings`
   - targeted `cargo test -p videorc-backend` for: `audio`,
     `session_audio`, `replay_buffer`, `recording` (the export args / C*
     tests), `repair`, `storage`, `source_iso`,
     `compositor_source_iso_batch`, `metal_compositor`, `performance_check`
   - the ignored real-file tests from B1/C1/C3, with `--ignored`
2. **TS:** `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm
   test:scripts`, `pnpm --filter @videorc/desktop test`, `pnpm build`.
3. **Smokes:**
   - `pnpm smoke:separate-source-fixture`
   - `pnpm smoke:replay-buffer`, at the default 30 s
   - `pnpm smoke:soundboard-fixture`
   - `pnpm smoke:record-latency`
   - `pnpm smoke:recording-matrix`: export, container and fps changed
   - `pnpm smoke:separate-source-runtime`, if D1 shipped

   Report unrelated reds with a one-line reason; do not A/B them unless
   asked.
4. **Artifact proof:** ffprobe one exported Combined from the smoke output
   and show:
   - every packet duration is equal;
   - `r_frame_rate` 30/1;
   - a `tmcd` track and the chapters;
   - AAC copied on a record+stream take.

**Owed to the owner (cannot run here):**
- a packaged-app take with Separate source recordings on at 1440p30 and
  4K30, then `pnpm smoke:separate-source-take -- <combined>`;
- importing the three files into Resolve or Premiere and checking they line
  up by timecode, that Premiere reports constant frame rate, and that the
  chapters show;
- a 2-input interface mic by ear (A1);
- both-theme by-eye checks of the Output notice (D4).

## Risks

- **C1 `setts`.** A capture with a true timing glitch (two frames inside
  one tick) makes ffmpeg fail on non-monotonic DTS. The once-only retry
  without `setts` covers it. The Windows and Linux bundled ffmpeg pins must
  have `setts` (FFmpeg 4.4+): both pins are FFmpeg 8.1.2 (`vendor/ffmpeg/*-pin.json`), checked 2026-10-26.
- **C3 data tracks.** Tools that assume two streams can break. The C3
  checklist covers the in-repo ones. Old QuickTime ignores `tmcd` safely.
- **C6 sweep.** It deletes by an exact hidden-name pattern only, in folders
  Videorc recorded into. It never deletes backups.
- **D1/D2/D3** touch the per-frame recording path, hence the STOP
  conditions. The separate-source fixture and the recording matrix are the
  gates.

## As built

### Groups A and B (branch `plan-200-sound`)

- **A1 (per-block fold).** `VoiceFold` in `audio.rs` replaces
  `centered_voice_sample`: per-block mean-square per channel, a ~150 ms
  one-pole, average within 20 dB, the louder channel alone past 20 dB (back
  under 12 dB), average when both are under -110 dBFS, and a linear
  crossfade across the block on a mode change. The CoreAudio callback and the
  session bus (both write paths, planned once per chunk, reset on a ramp-in)
  keep a persistent fold; `process_interleaved_f32` is a one-shot fold.
  **The STOP did not trigger:** the Windows/Linux capture worker only
  normalizes to stereo in FFmpeg (`aformat=…:channel_layouts=stereo`); the
  voice fold is the bus's, in Rust, so those platforms get `VoiceFold` too.
  `MIC_ONLY_GOLDEN_SHA256` was re-pinned (its 100 ms one-channel-silent
  stretches are now averaged rather than switched per sample), with the
  reason in the comment.
- **A2 (limiter on every path).** The mic-only writer folds without the
  full-scale clamp and runs `PeakLimiter`, carrying its state across both
  write paths; clipped samples count on every path. The mixed sum also takes
  the unclamped microphone. The golden was re-pinned again: its +3 dB fixture
  peaks near 1.06 and is now limited, not clamped. A mic under the ceiling is
  byte-identical (unit test). Review follow-up: the Microphone ingredient
  (taps / separate Mic file, mic meter, echo reference, captions) is the
  clamped fold on both paths, so it no longer depends on whether system
  audio is attached; only the Combined output is limited.
- **A3 (non-48 kHz mic).** Deviation: the rate is read from the AUHAL's
  input-element input-scope stream format (fallback
  `kAudioUnitProperty_SampleRate`) through the existing safe coreaudio-rs
  `AudioUnit` methods, not `kAudioDevicePropertyNominalSampleRate`; no new
  `unsafe`, so the STOP did not trigger. The warning is logged with the
  device name and raised as Health `audio-input-sample-rate` at session
  start only (`prepare_native_audio_source`); a mid-session switch to such a
  mic logs but adds no Health event. A refused 48 kHz client format reports
  the warning followed by CoreAudio's own error in parentheses; a failed
  `start()` keeps its own message (review follow-up: it was wrongly blamed on
  the rate, hiding permission causes).
- **B1 (frame-exact joins).** `concat_list` writes `duration = next.start -
  this.start` and none for the last segment; `select_segments` and the ring
  fill count coverage the same way, the newest segment as its listed span
  plus one frame. Deviation: with no fps, one frame is the median gap between
  a segment's listed end and the next start (the spec's "median start gap"
  read literally would be ~2 s). The real-file test
  `real_ffmpeg_clip_keeps_every_frame_at_segment_joins` is `#[ignore]`d.
- **B2 (durable clips, `.partial` sweep).** The saved MP4 is `sync_all`ed,
  renamed and its folder flushed (Unix) in `spawn_blocking` (review
  follow-up; `F_FULLFSYNC` used to run on a runtime worker). On ring start the
  Clips folder is swept once for regular files named `Clip ….mp4.partial`,
  modified before the ring started and claimed by no running save.

### Group C (branches `plan-200-better-recordings` and `plan-200-export-b`)

Group C, slices C1, C2, C3, C7 and C8, below
(branch `plan-200-better-recordings`, 2026-10-26). C4, C5 and C6 ran in a
separate worktree (branch `plan-200-export-b`) and follow after C8.

### C1. Exact frame times (shipped, `33842ca8`)

- `mp4_export_args` now takes `Mp4ExportOptions`. For a Videorc capture with
  H.264 and a whole frame rate it appends
  `,setts=time_base=1/<fps>:prescale=1:ts=round(PTS)` to the single
  `h264_metadata` `-bsf:v` chain (two `-bsf:v` flags would keep only the
  last).
- The fps is the take's configured `output.video.fps`, else the probe's whole
  `r_frame_rate`. A non-integer probed rate (30000/1001) never snaps.
- "Videorc capture" is a new read, `Database::mp4_export_take_row`: any row
  that is not `mode = 'imported'` and has no `derived_from_session_id` or
  `processing_kind`. So imports, duplicates and processed copies get the
  plain remux.
- The export probe, `probe_mp4_export_input`, replaces
  `mp4_export_trim_seconds`. It reads `r_frame_rate`, stream durations and
  the format duration. The tracked export now gets its progress total from
  this probe and no longer runs a second `probe_duration_ms` ffprobe.
- On an FFmpeg failure with the snap, both exporters log, delete the partial
  `export.mp4` in the private staging folder, and retry once without
  `setts`. The tracked exporter skips the retry after a cancel.
- Tests:
  - unit tests for 30 fps, 60 fps, no fps, non-integer rate, import and
    retry options;
  - a real-file test, `plan200_real_export_has_equal_frame_durations`: a 3 s
    30 fps libx264 MKV at 1/1000 exports to 90 packets of one duration with
    `r_frame_rate` 30/1. It passes.
- The real-file test logs a skip line without ffmpeg/ffprobe on PATH.
- Not proven: the retry path against a real non-monotonic-DTS capture.

### C2. AAC copy, H.264-only tags (shipped, `b7395292`)

- The probe also reads the video and audio `codec_name`.
- AAC audio is exported with `-c:a copy`. Any other audio is encoded to AAC
  256k, as before.
- Video other than `h264` gets no colour tags, no `h264_metadata` and no
  `setts`. A failed probe keeps the old assumption that the video is H.264.
- Unit tests cover PCM+H.264, AAC+H.264 and AAC+HEVC.

### C3. Creation time, timecode and chapters (shipped, `b6371e92`, `92b7295e`)

- Every Videorc capture export adds:
  - `-metadata creation_time=<take start, UTC>`;
  - `-timecode HH:MM:SS:FF`.
- Separate-file rows copy `started_at` from Combined, so all files of one
  take get the same values.
- **Deviation:** `creation_time` is written in whole seconds. The MP4
  `mvhd` stores seconds only, so the real-file test read back `.000000Z` for
  a `.5` start.
- The timecode is the local time of day at the take start. Its frames come
  from the sub-second at the take's fps and never carry into the seconds:
  `23:59:59.999` gives `23:59:59:29` at 30 fps.
- Markers become chapters:
  - `Database::markers_for_export` (in `session_markers.rs`) reads the live
    markers of the Combined session (`take_id`, else the session itself).
  - `mp4_chapters_ffmetadata` writes `chapters.ffmetadata` beside
    `export.mp4` in the private staging folder. The existing
    `remove_dir_all` cleanup removes it with the staging folder.
  - The export maps it with `-f ffmetadata -i … -map_chapters 1`.
    `-map_metadata -1` is never used.
  - A first chapter "Start" is added when the first marker is later than 0.
  - A marker without a label is titled "Marker N".
  - Markers at or past the end of the file are dropped. Two markers on the
    same millisecond keep the first.
  - `=`, `;`, `#`, `\` and newlines are escaped, and CR is dropped.
  - No markers, or an unknown duration, means no chapters input at all.
- C3 checklist (tmcd and chapter `text` data tracks):
  - `repair.rs` analysis takes the first video stream and the audio
    streams, and maps `0:v:0` and `0:a:0`. OK.
  - `scripts/lib/recording-analyzer.mjs` and
    `scripts/lib/startup-resolution-analyzer.mjs` select by `codec_type`,
    `v:0` and `a:0`. OK.
  - `separate-source-take-gates.mjs` counts video and audio streams by
    `codec_type`, not all streams. OK.
  - The record-latency smoke uses those analyzers. OK.
  - `smoke-separate-source-runtime.mjs` maps `0:v:0` and `0:a:0`. OK.
  - The poster step writes one frame to JPEG, so only video is selected.
    OK.
  - Caption burn-in uses a `filter_complex` and copies audio. OK.
  - **Noise cleanup broke and is fixed.** `-map 0 -c copy` into MP4 failed
    with "Could not find tag for codec none" on the tmcd track. It now adds
    `-map -0:d`. Chapters still copy, and the muxer rebuilds tmcd from the
    video's `timecode` tag. This was checked by hand with ffmpeg 8.1.1 for
    MP4 and MKV outputs.
  - No `scripts/lib` JS changed, so `pnpm test:scripts` was not needed.
- Tests:
  - timecode unit tests: 30 and 60 fps, sub-second frames, both midnight
    edges and a leap second;
  - an ffmetadata builder test: escaping, Start, "Marker N", out-of-range
    markers and empty input;
  - a chapters-file test: no file without markers, and the file sits in
    the staging folder;
  - an args test: inputs order, `-map_chapters 1`, no `-map_metadata`, and
    no take metadata on imports;
  - a real-file test,
    `plan200_real_export_has_chapters_and_one_timecode_per_take`: two files
    of one take with two markers each have the chapters Start, Intro and
    Marker 2 at 0, 1 and 2 s, a `tmcd` track, the same `creation_time` and
    the same timecode. It passes.

### C7. A repair keeps the file whole (shipped, `d7429c20`)

- `build_repair_args` adds:
  - `-map 0 -map -0:d -map_chapters 0`;
  - `-movflags +faststart` for `.mp4`, `.mov` and `.m4v` outputs (case
    insensitive);
  - BT.709 video-range tags after the encoder args on a CFR or
    interpolation re-encode;
  - AAC at 256k instead of 192k.
- **Deviation:** `-map -0:d` is added. A plain `-map 0` copies the new
  tmcd and chapter text data tracks, which the MP4 muxer rejects (the same
  failure as noise cleanup).
- A by-hand ffmpeg 8.1.1 check confirmed a re-encode with these args keeps
  the chapters, rebuilds tmcd and tags BT.709/tv.
- Unit tests cover copy (MP4 and MKV), CFR transcode and interpolate plans.
- The ignored real repair tests (`gate_passes_a_clean_recording`,
  `gate_repairs_a_one_sided_recording`,
  `repairs_a_one_sided_recording_end_to_end`) pass.
- Note: the repair temp error paths are C6, which was not done here.

### C8. Quick check for long recordings (shipped, `d14aeccf`)

- `repair::quick_check_windows(duration)` returns `None` at 20 minutes or
  less, or for an unknown length. Above that it returns six windows:
  - the first 60 s;
  - the last 60 s;
  - four 30 s windows centred at 1/5 to 4/5 of the span between them.
- `assess_recording_after_capture_cancellable` probes the whole file once
  (cheap) and runs the existing passes per window: astats, audio gaps,
  freezedetect and framemd5.
  - The FFmpeg passes use `-ss`/`-t` input options.
  - The ffprobe audio-gap pass uses `-read_intervals start%+dur`.
- Folding the windows into one report:
  - Freezes are corroborated per window, then added together.
  - Gap and repeat counts are summed, and their maximums kept.
  - Audio is one-sided only when every window that names a silent channel
    names the same one.
  - The report is marked `QualityReport.sampled`.
- The full path, `analyze_recording_cancellable`, now shares the same
  `analyze_probed_recording` with one whole-file window and behaves as
  before. Manual Check quality still runs the full check.
- `GateStatus::Ready` and `NotHundredPercent` gained `sampled` (serde
  default false, not serialized when false), so old rows and support bundles
  read as before. Support-bundle redaction keeps the flag.
- Both post-recording gate paths (after a take, and resumed at boot) now go
  through `post_recording_gate_step`. A sampled `NotHundredPercent`
  completes and is reported, never auto-repaired.
- Copy:
  - Health: "Quick check (long recording): the sampled parts passed …" or
    "Quick check (long recording) found issues in the sampled parts: …".
  - Library chip, problem states only (as before): a sampled
    `not-hundred-percent` says "Quick check (long recording): some of the
    sampled parts aren't 100%. Choose Check quality in its menu for a full
    check."
  - A clean quick check shows no chip, which matches the existing
    "problem states only" chip rule.
- Tests:
  - window plan: 60 min gives 6 windows with exact centres; 21 min; exactly
    20 min, 30 s, 0, NaN and ∞;
  - `-ss`/`-t` args;
  - the one-sided fold;
  - GateStatus serde round trip and a legacy row;
  - `post_recording_gate_never_auto_repairs_a_quick_check`;
  - a renderer test in `library-view.test.ts`.
- Not run: a real long-file quick check against a 20+ minute recording.

### Group C verification (C1/C2/C3/C7/C8)

All cargo commands ran through `/tmp/claude-501/plan200-cargo.sh`.

| Gate | Result |
|---|---|
| `cargo fmt --all`, then `cargo fmt --check --all` | pass |
| `cargo check -p videorc-backend --tests` | pass. 5 dead-code warnings, all in files this group didn't touch (`buddy_motion.rs`, `linux_*`). |
| `cargo clippy -p videorc-backend -- -D warnings` | pass (run before and after the last commit) |
| `cargo test -p videorc-backend -- recording:: repair:: repair_service:: support_bundle:: noise_cleanup:: session_markers::` | 564 passed, 0 failed |
| `cargo test -p videorc-backend -- mp4_export mp4_chapters quick_check sampled_gate post_recording_gate repair_args exact_container_args storage::` | 157 passed, 0 failed |
| `cargo test -p videorc-backend -- --ignored plan200_real real_ffmpeg_export_creates_absent_child repair::tests::` | pass, with Homebrew ffmpeg 8.1.1 on PATH |
| `vitest run src/renderer/src/lib/library-view.test.ts` | 25 passed |
| prettier `--check` on the three TS files | pass |

On the ignored real-file tests: the first run failed on two assertions in the
new test itself, not in the export. One was the ffprobe chapter CSV shape and
the other was creation-time precision. Both were fixed in `92b7295e`, and the
rerun passes.

### C4. Combined exports first (branch `plan-200-export-b`)

- `recording_finalization.rs`: the FIFO `export_slot` mutex is now a
  class-aware slot (`ExportClass::Primary` / `SeparateFile { take_id }`, read
  from the `<take_id>-screen|camera` session id). One export at a time. Order:
  a separate file that has waited `SEPARATE_FILE_EXPORT_MAX_WAIT` (60 s) or
  longer, then the oldest Combined/single-file export, then the oldest
  separate file whose take has no pending Combined export. A dropped waiter
  leaves the queue.
- At Stop, `monitor_session` calls `expect_primary_export(take)` before
  `commit_finished_source_iso_roles` queues the separate files (they are
  spawned before the Combined job registers), so a separate file yields to
  its Combined even on a free slot. The mark clears when the Combined export
  leaves the slot, when the Combined job finishes without one
  (`registry.finish`), or right before the terminal status when no Combined
  job was created.
- Tests: Camera, Screen, then Combined queued → Combined runs first; a free
  slot waits for the take's expected Combined (another take's file is not held
  back); a Combined job that ends without export releases its files; the pure
  ordering function at 59 s / 60 s; a paused-clock test that a held-back file
  waits no more than 60 s.

### C5. Disk space is checked where it runs out

- New `disk_space.rs`: required space = input × 1.05 + 512 MiB
  (`required_copy_bytes`), decimal byte formatting, the plan's refusal copy
  verbatim, and the minutes-left estimate: (video kbps + 1536 kbps PCM audio)
  × (1 + separate files), doubled for the export peak.
- Export (automatic and Export MP4): `ensure_mp4_export_disk_space` runs before
  `export_completed_recording_to_mp4_tracked` in `finalize_recording_media`
  (inside the export slot, before FFmpeg) and at the start of
  `remux_session_with_exporter`. On refusal the job fails with the copy and the
  MKV stays. `mp4_export_args` is untouched. A failed size or free-space
  reading never blocks.
- Repair backup: `safe_replace` refuses the backup copy without room
  ("Not enough disk space to back up the original before the repair (needs X,
  Y free). The recording was left unchanged.") and deletes the temp.
- Record-time notice: `emit_disk_space_health_event` uses `statvfs`/
  `GetDiskFreeSpaceExW` (`noise_cleanup::available_space`) instead of `df`,
  and shows "About N minutes of recording[ with separate files] fit in the
  selected recording location (X free)." under 20 minutes; under 1 GB it always
  shows (same `disk-space-low` code).
- Tests: required-space math, the refusal copy, minutes left with and without
  separate files, the notice threshold and the 1 GB floor.

### C6. Videorc cleans up after itself

1. Startup sweep: `repair::sweep_repair_temps` deletes only regular files
   whose name is exactly `.<stem>.videorc-repair.<video ext>`
   (`is_repair_temp_name`), non-recursively, in the default recordings folder
   and the parents of every `output_path`/`mp4_path` of sessions started in the
   last 90 days (`Database::session_media_directories_since`).
   `repair_service::sweep_leftover_repair_temps` holds the maintenance permit
   while it runs and logs the count and bytes; `main.rs` runs it before
   `resume_pending_repair_jobs`.
2. `ffmpeg_work.rs`: a maintenance permit now has its own cancel flag;
   `MaintenanceCancelToken::cancel_on_drop()` cancels the job when a `timeout`
   drops the waiting future, so `run_output_cancellable` kills FFmpeg;
   `worker()` counts the blocking thread until it exits, and no new
   maintenance (or Library deletion) starts while one is counted.
   `cancel_maintenance_for_shutdown` (called when shutdown preparation starts
   and again in post-finalization cleanup) cancels running and later jobs;
   cleanup waits up to 5 s for the workers. Wired into `run_quality_assessment`,
   `run_quality_gate` and `repair_service` assess/repair. The quality-gate
   timeout code itself (C8's area) is unchanged.
3. `safe_replace` deletes the temp on every error path (invalid path, backup
   space, backup folder, backup copy, rename), via `safe_replace_with` with an
   injectable rename.
4. Deleting a recording quarantines and trashes its `.videorc-backups/<name>`
   copy with it (an extra path record, only when the backup exists). Orphaned
   backups are still never deleted (D6).
5. Export MP4 of a file still in `.videorc-iso-<uuid>/` publishes to
   `source_iso::public_mp4_output_path`: the public folder beside Combined,
   with its `-screen`/`-camera` name, through the same no-replace publish
   (staging also moves to the public folder).
6. `source_iso::remove_empty_capture_directory` removes the private folder
   (only a `.videorc-iso-*` parent, only when empty) after an automatic export
   that consumed the MKV, after Export MP4, and when the row's deletion
   completes. The existing publish-time removal is unchanged.
7. Crash recovery: `reconcile_orphaned_sessions` keeps an interrupted
   Screen/Camera row `completed` when its capture ownership is bound
   (`sourceIsoOwnership`), so the Library offers Export MP4; unverified rows
   stay `failed`. `separate-source-recordings-view.ts` maps "partial media is
   available for recovery" to "Stopped early" ("Videorc closed before this file
   finished."), exportable when the length is unknown or at least 1 s.
8. `finalize_session_with_diagnostics` stores the published MP4's size in
   `file_size_bytes` (stat taken before the DB lock).
- Tests: sweep (temp, MP4, MKV, a backup, a temp-named file inside
  `.videorc-backups`, `.partial`, a temp-named folder: only the temp goes);
  name filter; failing rename and failing backup leave no temp; delete takes
  the backup and not another recording's; a stopped-early file's Export MP4
  lands beside Combined (remux with a fake exporter); empty private folder
  removal (and never a non-private folder); `file_size_bytes` after export;
  timed-out/shutdown maintenance cancellation and the worker join; verified
  interrupted row stays `completed`; the renderer view test.

### C4–C6 gates run (worktree `videorc-wt-200-exportb`, before merge)

- `cargo fmt --check --all`: pass.
- `cargo check -p videorc-backend --tests`: pass (5 pre-existing dead-code
  warnings in unrelated Linux/buddy files).
- `cargo clippy -p videorc-backend -- -D warnings`: pass.
- `cargo test -p videorc-backend -- recording_finalization:: disk_space::
  repair:: repair_service:: storage:: source_iso:: ffmpeg_work::`: 263 passed,
  3 ignored. `cargo test -p videorc-backend -- recording::`: 446 passed,
  4 ignored. Both ran with `--config
  'profile.dev.package.videorc-backend.debug=0'`: with full debuginfo the
  opt-level-2 test build of the backend was SIGKILLed twice (memory pressure on
  the shared machine).
- `vitest run separate-source-recordings-view.test.ts`: 10 passed;
  `pnpm typecheck`: pass; prettier: pass.
- Not run here (slice E, on the merged branch): the smokes, and
  `pnpm smoke:record-latency` for the finalization-slot change.

### Group D (`plan-200-iso`)

**D3 — scaled draws read linear; 1:1 stays exact.** Shipped as specified, no
STOP. A Metal draw whose drawn size differs from its source crop by more than
0.5% (`SCALED_DRAW_TOLERANCE`, per axis) is promoted from the nearest scene
sampler to the linear one in recording, stream and ISO compositors, with a
half-texel crop clamp in the shader so a scaled crop never blends in removed
pixels. Preview compositors and explicit linear quads (the Buddy sprite) are
unchanged. The CPU compositor agrees in kind for the camera only (bilinear
with the same pixel-centre mapping and crop clamp); screens and images stay
point-sampled on CPU, the production path on Windows/Linux, to keep its
per-pixel budget (deviation, by design: unmeasured on weak Windows PCs for a
full-frame scaled camera). Camera masks are tested per destination pixel in
both paths; the FFmpeg path is untouched. No golden or CPU/Metal parity test
changed.

**D1 — the separate files shed first.** Shipped, no STOP: Combined's frame
selection did not need to leave the batch. Any member past the two-tick
history, or a bridge lag held above 250 ms for 500 ms, retires every
still-active separate member at its own last latched tick (each file closes
cleanly through the source-removal drain, outcome `shed`, reason "‹Role›
recording stopped to keep the main recording smooth."). Combined continues on
the rebased history and gets `FELL_BEHIND` only with no separate member left.
One health event per take (`separate-source-recordings-shed`) and one toast;
the copy names no roles ("The separate files keep what they recorded"), since
a file whose source was removed earlier is not shed. Shed or ended legs stop
rendering. One assertion of the existing history test was removed because the
behaviour it pinned (a separate member's terminal lag error) changed by
design. **Runtime case not covered:** there is no forced-lag hook in
`smoke:separate-source-runtime`; its manifest now records a `shed` interval
for any role whose outcome is `shed`, so a real shed on a slow 4K run is
judged on its explicit end instead of failing the duration spread.

**D2 — the Camera file is the camera's own size.** Shipped, no STOP: the ISO
legs already render through their own GPU compositors and frame stores; the
batch publish checks only the tick, so a smaller Camera raster needed no
frame-store or lease change. Size = the camera's frame fitted inside the
canvas, never upscaled, both sides rounded down to even; Fill when the live
frame is within 1% of that aspect, Fit (bars) after a mid-take format change.
Bitrate = canvas bitrate × pixel share, floor 4 Mbps at 1080p30 scaled by
pixel rate, never above the canvas bitrate. Arming starts a cold or
layout-retired selected camera first and waits up to 2 s for its first frame
(`arm_camera_format`); if it never reports, the leg keeps the canvas size and
the log says so. The bounded wait and the already-live path are unit-tested;
an end-to-end "camera not live at Record" case needs a real device and is not
covered.

**D4 — say what separate files cost.** The Output row notice ships as
specified (4K on the short side, or 60 fps and up, only when the next take
would arm the separate files). The performance check carries the switch, and
the verdict counts the budget. Deviation: a benchmark take records one test
pattern paced to real time, so neither it nor FFmpeg's `speed` (~1.0x) can
show encoder headroom, and the benchmark cannot arm the separate files (no
camera or screen). The measured encoder throughput is therefore the highest
single-encode pixel rate the ladder passed; a rung with the switch on fails
(`separate-files-over-encoder-budget`) when that rate over the rung's pixels,
divided by the take's load factor (Combined + Screen + Camera at a 1080p
camera's D2 size), is below the rung's fps. This is conservative: a passing
top rung proves only its own rate, so a 4K30 selection steps down until the
budget is proven. The saved verdict is keyed like any other check, so a
check run with the switch on stays conservative after the switch is turned
off until the check is re-run.

**Gates (Group D, 2026-10-26, on `plan-200-iso`):** `cargo fmt --check
--all` clean; `cargo clippy -p videorc-backend -- -D warnings` clean;
`cargo test -p videorc-backend -- source_iso:: compositor_source_iso_batch::
encoder_bridge:: metal_compositor:: compositor:: performance_check::` 48 +
440 passed, 0 failed; vitest on the four touched renderer test files 76
passed. Smokes (`smoke:separate-source-fixture`,
`smoke:separate-source-runtime`) run with slice E on the merged branch.

