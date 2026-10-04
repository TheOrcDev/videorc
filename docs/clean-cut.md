# Clean cut

Clean cut is the second power of the Orcle tab (plan 119): "Stop recording,
and the edited version is already there." After a recording finishes,
Videorc makes an edited copy next to it, with the dead air, the "um"s, the
false starts and the retakes taken out. The original is never touched.

It needs a signed-in Videorc Premium account and Cloud AI consent. The wire
contract with videorc-web is `docs/clean-cut-contract.md`; an identical copy
lives in the web repo, and the two must change together.

## Two modes

- **Clean** keeps the whole recording and removes what nobody wants to watch:
  the wait before the first word and after the last one, long silences,
  fillers, and the takes you said again.
- **Condensed** keeps a target length (10, 15, 20 or 30 minutes, default 15)
  of a long recording or stream: the cloud picks the beats worth keeping,
  always the opening hook and the close, and every "clip that" mark and chat
  peak from the Orcle report. The Clean removals still apply inside what is
  kept. The renderer offers it for recordings of at least 25 minutes.

Each mode makes its own derived session:

| Mode      | File                              | Title                          |
| --------- | --------------------------------- | ------------------------------ |
| Clean     | `"<source stem> (Clean cut).mp4"` | `"<source title> (Clean cut)"` |
| Condensed | `"<source stem> (Condensed).mp4"` | `"<source title> (Condensed)"` |

Each file gets a re-timed `.srt` beside it whenever there is speech to
caption.

## Where you use it

- **The Clean cut card** in the Orcle tab (⌘9). "Make a clean cut of every
  recording" is the opt-in switch for running it after every Stop; it asks
  for sign-in, Premium and Cloud AI consent the same way Orcle Live does. The
  card shows the latest recording's status (waiting, transcribing, cutting,
  ready with the old and new length, or failed with Retry), "Make a clean
  cut" for any eligible recording, and the minutes left this month.
- **The review.** A player on top previews the cut by skipping every removal
  that is on. The transcript below strikes through what is removed, coloured
  by kind. Chips per kind (Silences, Ums, Retakes, Start and end) turn a whole
  kind on or off, a click on a span restores or removes it, and Orcle report
  moments show as pins. "Save changes" sends the edit and renders again.
  Space plays, ← and → seek, Enter toggles the selected span.
- **Library.** A recording's row menu has "Clean cut". A derived copy wears a
  badge and "· cut from {source}".
- **The ready toast.** "Your clean cut is ready (42:10 → 31:05)", with a
  Review action, once per job and edit.

Auto-run starts `cleanCut.start` once per recording when the recording just
finalized with an MP4, its mode is `record` or `record+stream`, it is neither
imported nor derived, the switch is on (`localStorage['videorc.cleanCutAuto']`)
and consent, Premium and the server's `cleanCut.available` all hold. A bounded
ledger (`videorc.cleanCutAttempted`, 50 ids) keeps it to once per recording.

## Who can use it

`cleanCut.start` refuses, in this order:

1. `not-eligible`: the recording is not a finished Videorc recording with an
   MP4 on disk (status `completed`, mode `record` or `record+stream`, at least
   10 s), or it is imported, or it is itself a Clean cut or Noise Cleaned copy.
2. `already-running`: a job for the same recording and mode is still working.
3. `consent-required`: `consentToUploadAudio` is not `true`.
4. `signed-out`: no Videorc session token is stored.
5. `premium-required`: the entitlements deny Cloud AI.
6. `unavailable`: the server's capabilities say Clean cut is off, used up or
   not offered (the plain message carries the server's `reasonCode`).

Only the last step makes a network call, so a refused start never reaches
the cloud. Starting again after a failure creates a new job that reuses
every transcript chunk already done; a cut list that is waiting to render is
returned as it is.

## How a clean cut is made

One durable job per recording and mode moves through
`queued → transcribing → analyzing → ready → rendering → validating →
completed`, or ends `failed` or `cancelled`. `ready` is the short stop while
a built cut list waits for the render slot; there is no user step. The
`step` field says what is happening (`quality-check`, `extract-audio`,
`probe`, `upload`, `stitch`, `analyze`, `cut-list`, `render`, `validate`) and
`progress` runs from 0 to 1.

1. **Wait for the recording to settle.** The post-recording quality check
   waits 30 s after Stop and may repair the MP4 in place, so the job waits
   for it (step `quality-check`, at most 30 minutes) before it binds the
   file's identity: path, size and modification time.
2. **Extract the audio.** The first audio track becomes 16 kHz mono PCM WAV
   (`audio-16k.wav`).
3. **Transcribe word for word.** The audio is cut into chunks of at most
   120 s. Each chunk ends at the quietest 50 ms frame in the last 10 s of its
   window and overlaps the next by 1 s. Chunks go to
   `POST /api/ai/transcripts/chunks`, two at a time, three attempts each for
   network or server failures. The server answers with timed words, fillers
   kept and tagged. Each chunk is saved as it lands, so a crash, a quit or a
   used-up allowance resumes at the first missing chunk. The chunks are
   stitched by splitting each overlap at its midpoint into
   `transcript.words.json`.
4. **Find the sentences.** Words are grouped into sentences `s1, s2, ...`:
   after `.`, `?`, `!` or `…`, at a pause of 700 ms or more, or at 40 words.
5. **Ask the cloud for retakes.** The sentences go to one
   `post-recording-clean-cut` analysis job (`POST /api/ai/jobs`, client
   request id `cleancut:<sessionId>:<mode>:<hash>`), which returns retakes and
   false starts by sentence id, and for Condensed the kept ranges. The job is
   polled every 3 s, slowing to every 20 s, for at most 90 minutes. Polling
   needs no render slot.
6. **Build the cut list.** The local rules below run on the words and the
   audio, the cloud's drops are mapped from sentence ids to time, everything
   is merged, and every boundary is snapped to the source's frame grid
   (`r_frame_rate`). The result is the EDL, `edl_json` version 1:
   `{version, sourceIdentity, frameRate, durationMs, removals[], stats}`.
   Every removal keeps its `kind` (`head`, `tail`, `silence`, `gap`,
   `filler`, `retake`, `false_start`, `condensed`, `manual`), a plain
   `reason`, its `confidence` and whether it is `enabled`. With no speech at
   all, only the head and tail are trimmed, by the audio; a fully silent
   recording fails with "No speech found, nothing to cut."
7. **Render, validate, publish.** One FFmpeg pass renders what is kept (see
   below). The output is checked with ffprobe before anything is published,
   then renamed over its final name and recorded as a derived session.

### The cut rules (decision 16)

Every number lives in `crates/videorc-backend/src/clean_cut/rules.rs` and
nowhere else. These are the defaults until the owner's S0 calibration:

| Rule                                                                              | Constant                                        | Default         |
| --------------------------------------------------------------------------------- | ----------------------------------------------- | --------------- |
| Head: cut until this long before the first kept word                              | `HEAD_LEAD_MS`                                  | 300 ms          |
| Tail: cut from this long after the last kept word                                 | `TAIL_TRAIL_MS`                                 | 600 ms          |
| A silent pause with no words longer than this ...                                 | `SILENCE_MIN_GAP_MS`                            | 1.0 s           |
| ... shrinks to this, keeping half on each side                                    | `SILENCE_KEEP_MS`                               | 0.4 s           |
| A pause that is not silent (music, game sound, typing) shrinks only past this ... | `NOISY_GAP_MIN_MS`                              | 4 s             |
| ... and then to this                                                              | `NOISY_GAP_KEEP_MS`                             | 1.5 s           |
| Padding around a filler, clamped to the neighbouring words                        | `FILLER_PAD_MS`                                 | 30 ms           |
| Retakes and false starts at or above this confidence are on                       | `DROP_CONFIDENCE_ON`                            | 0.6             |
| A kept sliver shorter than this between two cuts is absorbed                      | `SLIVER_MAX_MS`                                 | 250 ms          |
| Silence is below the lower of this floor and 18 dB under the speech               | `SILENCE_FLOOR_DBFS`, `SILENCE_BELOW_SPEECH_DB` | -45 dBFS, 18 dB |
| Share of a pause's 50 ms frames that must be below it to call it silent           | `SILENCE_GAP_PERCENTILE`                        | 0.9             |
| Audio fade at each internal join; video cuts are hard                             | `JOIN_FADE_MS`                                  | 10 ms           |

Fillers are the words the server tags, plus the English v1 lexicon the
desktop checks again: `um`, `uh`, `uhm`, `umm`, `erm`, `er`, `ah`, `hmm`,
`mm` (lowercased, punctuation stripped). Retakes and false starts under the
confidence bar are kept as switched-off suggestions. Silences, the head, the
tail and retakes work in any language; filler removal is English only in v1.

### The render (decision 17)

- **What stays.** The kept ranges are the complement of the enabled removals,
  in frames. Each range is `trim=start_frame:end_frame` on a `split` of the
  video and `atrim=start_sample:end_sample` on an `asplit` of every audio
  track, then one `concat`. Audio cut points come from the same frame
  indices, and each segment's length is the difference of the cumulative
  kept-frame boundaries, so the audio never drifts however many cuts there
  are. One pass carries at most 2,000 kept ranges; a graph over 4 KB goes to
  a script file (`-/filter_complex`).
- **Encoders.** macOS `h264_videotoolbox`; Windows `h264_mf`, then
  `libopenh264`; Linux `h264_vaapi` when the recording path's render-node
  probe accepted a device, then `libopenh264`. A later encoder is tried when
  an earlier one fails.
- **Quality.** The source's bitrate (never under 2,000 kbps), the same size
  and frame rate, BT.709 video-range tags, `+faststart`, AAC at each track's
  sample rate (at most 192 kbps).
- **Room.** The render refuses up front with less than 1.2 times the source
  size free next to it.
- **Validation.** Same frame rate, same size, same number of audio tracks,
  and the video and every audio track within one frame of the kept
  duration. Anything else fails the job and deletes the partial file.
- **Captions.** The `.srt` is the source's live-caption cues mapped through
  the kept ranges, or, when the recording has none, cues built from the kept
  words (at most 7 s and 42 characters, split at 700 ms pauses). Removed
  words never reach a caption.

The bundled FFmpeg must offer `split`, `trim`, `setpts`, `asplit`, `atrim`,
`asetpts`, `afade`, `concat` and `format` (and `hwupload` for VAAPI), plus
`aac` and one encoder of the chain. The job fails with `ffmpeg-unsupported`
naming the gap otherwise, and every platform's package gate requires the
filters (`scripts/lib/clean-cut-ffmpeg-filters.mjs`).

### The derived session

- A first render inserts a `sessions` row that copies the source's sources,
  layout and output settings, with `derived_from_session_id` set and
  **`processing_kind` NULL**. A new `processing_kind` value would make older
  apps reject the whole Library (decision 12).
- The link is `clean_cut_jobs.output_session_id`. `sessions.list` exposes it
  through a join as `cleanCutOfSessionId` and `cleanCutMode`, on derived rows
  only.
- Rendering again, after an edit or from a later job for the same recording
  and mode, replaces the same file and updates the same row: the
  `outputSessionId` never changes.
- Deleting the derived session leaves the recording alone, and the job
  forgets its output (`ON DELETE SET NULL`). Deleting the recording deletes
  its jobs.

## Privacy and consent

Clean cut uses the same Cloud AI consent as Orcle Live, with one home in the
Orcle tab (`videorc.aiConsent`). Its copy names what Clean cut sends:

- **The recording's audio**, in chunks of at most two minutes, for
  word-by-word transcription. The server passes each chunk to the
  transcription provider and keeps nothing about it: not the audio, not the
  words. Only the metered seconds are kept, for the monthly allowance.
- **The sentences**, as text, to Videorc's cloud AI to find retakes. The job
  keeps them only while it may still run: the write that completes, finally
  fails or cancels the job replaces them with a count. Its results name
  sentence ids only.

What stays on this computer, under `<Artifacts>/<sessionId>/clean-cut/`
(beside the Videorc database): the extracted audio, the chunk plan and each
transcribed chunk, and the stitched `transcript.words.json`. The cut list and
the job state live in the local database (`clean_cut_jobs`). The edited video
and its captions sit next to the recording.

Nothing uploads without consent: the renderer sends `consentToUploadAudio`,
and `cleanCut.start` refuses before any network call when it is missing.

## Quotas and server settings

These live on videorc-web; see its `docs/ai-gateway.md` for the full list.

- `VIDEORC_AI_CLEAN_CUT_DISABLED`: the Clean cut kill switch (the chunk
  route, the capability flag and the analysis job). `VIDEORC_AI_DISABLED`
  turns it off too.
- `VIDEORC_AI_CLEAN_CUT_MONTHLY_MINUTES`: the Premium allowance of
  transcribed audio per UTC month, default 1,200 (decision 11; the owner sets
  the final number after S0). Seconds are reserved atomically in the
  `cleancut-quota-YYYY-MM` bucket, apart from caption and listening minutes.
- `VIDEORC_AI_CLEAN_CUT_DAILY_JOBS`: analysis jobs per UTC day, default 20,
  on top of the shared monthly job cap.
- `VIDEORC_AI_VERBATIM_TRANSCRIPTION_PROVIDER` (`deepgram`, the default, or
  `gateway`), `VIDEORC_AI_VERBATIM_TRANSCRIPTION_MODEL` (default `nova-3`),
  `VIDEORC_AI_VERBATIM_TRANSCRIPTION_TIMEOUT_MS` (default 45 s) and
  `VIDEORC_AI_VERBATIM_TRANSCRIPTIONS_URL`. Deepgram is asked for
  `filler_words=true` and `punctuate=true`. The key is `DEEPGRAM_API_KEY`;
  adding it to the Vercel environment is an owner action.
- `VIDEORC_AI_CLEAN_CUT_TEXT_MODEL`, `VIDEORC_AI_CLEAN_CUT_FALLBACK_TEXT_MODELS`
  and `VIDEORC_AI_CLEAN_CUT_PROVIDER_ORDER` choose the analysis model;
  `VIDEORC_AI_CLEAN_CUT_REQUEST_TIMEOUT_MS`,
  `VIDEORC_AI_CLEAN_CUT_MAX_OUTPUT_TOKENS` and
  `VIDEORC_AI_CLEAN_CUT_RUN_BUDGET_MS` bound each window and each run.

The server advertises Clean cut in `GET /api/ai/capabilities`:
`features.cleanCutEnabled` and a `cleanCut` block with `available`,
`reasonCode`, the chunk limits, `monthlySecondsLimit` and `remainingSeconds`.
A server without the block means Clean cut is not offered.

Running out of minutes, the kill switch and a lost sign-in each fail the job
with the server's code (`clean-cut-monthly-quota-exhausted`,
`clean-cut-disabled`, `signed-out`, and so on) and a plain message. Starting
again later resumes at the first chunk not yet transcribed.

## Never while you capture (decision 18)

- The extraction, every upload, the analysis job's creation and the render
  run only in the idle maintenance slot: never while a capture runs or waits
  to start, or while a recording finalizes or exports, and one maintenance
  job at a time (quality checks, posters, Noise Cleanup and Clean cut take
  turns). Polling the analysis needs no slot.
- Starting a capture preempts the job: the upload or render stops, the job
  goes back to `queued`, and it carries on when the slot is free again. A
  render in progress is killed and its partial file removed.
- Nothing uploads while a capture is live.
- While a job is working on a recording (any state from `queued` to
  `validating`), delete, duplicate, remux and repair of that recording are
  refused.

## Crash recovery

Each job is a row in `clean_cut_jobs`; every step's result is on disk or in
the row before the next step starts:

- the chunk plan and every finished chunk (resume at the first missing one);
- `analysis_json`: the server job id, then its result (polling resumes; the
  idempotent `clientRequestId` makes a repeated create return the same job);
- `edl_json` with its `edl_revision`;
- `render_json`: the staging and final paths of a render in progress.

At startup, every job a dead process owned goes back to `queued`, and a
`ready` job is picked up to render. Stray partial files
(`.<stem>.<job id>.videorc-partial.mp4` and their filter-graph scripts) are
removed first. On shutdown, workers stop and leave their rows active, so the
next launch picks them up. A recording that changed after its cut list was
built (`source-changed`) starts over from the transcript.

Clean cut deliberately does not use the shared `session_file_operations`
journal that Library imports, duplicates and Noise Cleanup use. That
journal's startup reconcile ignores the entry's kind, deletes the `sessions`
row of any entry without a bound identity, and assumes a publish never
replaces a file. An older Videorc meeting a Clean cut re-render entry there
would delete the existing derived session. Keeping the render's paths on
Clean cut's own row means older apps never see them (decision 12).

## For developers

RPCs (renderer role), with their wire types in
`crates/videorc-backend/src/protocol.rs`, `apps/desktop/src/shared/backend.ts`
and the closed validators in `apps/desktop/src/shared/backend-rpc-contract.ts`:

- `cleanCut.start {sessionId, mode, consentToUploadAudio, targetDurationSeconds?}`
  returns the job. `targetDurationSeconds` is Condensed only (120 to 3,600,
  default 900).
- `cleanCut.get {sessionId}` returns `{sessionId, jobs[{job, edl?, condensedKeeps?}]}`,
  the newest job per mode.
- `cleanCut.list` returns active jobs first, then the newest finished job per
  recording and mode.
- `cleanCut.cancel {jobId}`.
- `cleanCut.updateEdl {jobId, revision, removals[{id, enabled}], addManual[{startMs, endMs}], removeManual[id]}`
  is optimistic on `revision` and allowed in `ready`, `completed` and
  `failed`. It returns `{job, edl}` with the revision bumped.
- `cleanCut.render {jobId}` renders the current revision again (same states
  as `updateEdl`, and only with a cut list).
- `cleanCut.transcript {jobId}` returns `{jobId, language, words[], segments[]}`.
- The `cleanCut.status` event carries the job snapshot on every change. The
  renderer never infers completion from anything else.

Refusal codes: `not-eligible`, `already-running`, `consent-required`,
`signed-out`, `premium-required`, `unavailable`, `start-failed`, `not-found`,
`not-ready`, `edl-revision-conflict`, `invalid-params`, `update-failed`,
`render-failed`. Job error codes the desktop sets itself: `signed-out`,
`premium-required`, `network`, `file-missing`, `source-changed`, `no-audio`,
`no-speech`, `ffmpeg-failed`, `probe-failed`, `processing-failed`,
`analysis-failed`, `analysis-timeout`, `transcript-too-long`,
`ffmpeg-unsupported`, `insufficient-space`, `render-failed`,
`render-invalid`, `render-too-many-cuts`. Server codes are stored as they
come.

Code, under `crates/videorc-backend/src/clean_cut/`: `rules.rs` (every
number), `job.rs` (control, registry, codes), `silence.rs` (WAV, RMS frames,
chunk windows), `transcribe.rs` (chunks, resume, stitching), `edl.rs`
(sentences, rules, merge and snap), `analysis.rs` (the cloud job client),
`render.rs` (kept ranges, graph, encoders, validation, publish) and `srt.rs`
(re-timed captions). `mod.rs` holds the RPCs and the worker loop.

## The smoke

`pnpm smoke:clean-cut` (`scripts/smoke-clean-cut-app.mjs`) runs the whole
path on the debug backend against a local fake of the web
(`scripts/lib/fake-transcript-service.mjs`), with no real provider, account
or network. It takes about two minutes, a third of that being the quality
check's 30 s wait, and it builds the debug backend first.

1. It records a real `record` session: the test pattern, and the debug-only
   synthetic microphone (`VIDEORC_CAPTION_CONTRACT_TEST=1`) with a scripted
   take of speech bursts (an injected tone) and silences:
   `CLEAN_CUT_SMOKE_TIMELINE` in `scripts/lib/clean-cut-smoke.mjs`. The take
   has a long lead and tail, a retaken sentence followed by "let me say that
   again", three long pauses and an "um".
2. After Stop, it measures the speech in the MP4 and lays the script's words
   over it, so the fake transcription hears exactly that audio.
3. It checks that `cleanCut.start` without consent is refused before any
   cloud call, then starts the job, and that a second start is refused.
4. It checks the job waits for the quality check, then runs every state in
   order.
5. It checks the stitched transcript against the words the fake served, and
   the cut list against the rules read from `rules.rs`: exactly the head, the
   retake, the three silences, the filler and the tail, each within a frame.
6. It checks one chunk upload and one analysis job reached the fake, and the
   derived session sits in the Library with `cleanCutOfSessionId` and no
   `processingKind`.
7. It checks the file: the kept duration within a frame, every audio track
   within a frame of the video, the recording's stream counts and size, every
   kept frame, no frame repeated across a join, the recording analyzer's
   verdict, and the re-timed `.srt` (no retake, no "um", the last cue inside
   the file). The recording itself is unchanged.
8. It keeps the retake with `cleanCut.updateEdl` (a stale revision is
   refused) and renders again with `cleanCut.render`: the same session, no
   new upload or analysis, and a file longer by exactly the retake.

It runs on macOS only, because the synthetic microphone is CoreAudio's.
`ffmpeg` and `ffprobe` come from PATH unless `VIDEORC_SMOKE_FFMPEG_PATH`
names one, which then also becomes the backend's FFmpeg: run it with the
bundled build to prove a package can render a clean cut. Set
`VIDEORC_SMOKE_KEEP_ARTIFACTS=1` to keep the recording and the outputs; a
failure always keeps them, with `clean-cut-smoke-report.json` (the job's
states, the backend's warnings and the fake's counters). The pure helpers
are covered by `scripts/lib/clean-cut-smoke.test.mjs` in `pnpm test:scripts`,
which also fails when a retune of `rules.rs` would break the scripted take.

The smoke is not part of `pnpm smoke:local-gates` yet: add it once a green
run on the gate machine confirms it stays within the three-minute budget.

## Still owed

- **S0 calibration.** The owner runs Clean cut on three real recordings (a
  10-minute tutorial, a 30-minute talking head, a two-hour record and stream)
  and settles the numbers in `rules.rs`: silence thresholds, fade length and
  render speed. The retake prompt's precision is measured with
  `pnpm eval:clean-cut path/to/labelled.json` in videorc-web (target: at
  least 0.8 at confidence 0.6 or higher). Until then the decision 16 defaults
  above apply.
- **Acceptance A2 (Clean):** zero bad cuts on a 10-minute tutorial and at most
  two on a 30-minute video, audio and video within one frame at the end, and
  a 30-minute recording ready within 10 minutes of Stop on an idle machine.
- **Acceptance A3 (Condensed):** the owner would publish the 15-minute
  version of a real two-hour stream after at most three segment toggles.
- **Windows and Linux.** The encoder paths compile in CI; behaviour is
  checked on the named machines, or the gap is written down.
