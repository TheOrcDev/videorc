# Plan 161: A dead stream destination is reported and reconnected

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update this plan's entry in
> `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat cdd2f942..HEAD -- crates/videorc-backend/src/recording.rs crates/videorc-backend/src/viewer_stats.rs crates/videorc-backend/src/youtube.rs apps/desktop/src/renderer/src/components/tabs/streaming-tab.tsx`
> If `recording.rs` changed around `append_bridge_copy_flv_output`,
> `parse_fifo_output_failure`, `looks_like_ffmpeg_health_event` or the stderr
> consumer loop (search `stream_url_positions`), compare the "Current state"
> excerpts below against the live code before proceeding; on a mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P0 (owner streamed to YouTube for 20+ minutes while YouTube
  had nothing; the app said On air the whole time)
- **Effort**: M, 5 slices
- **Risk**: HIGH (live FFmpeg argument change + stderr parser; recording
  studio gates required)
- **Depends on**: none. Builds on plan 087 (stream survives host overload)
  and plan 023 (per-target fifo legs).
- **Category**: bug
- **Planned at**: commit `cdd2f942` (origin/main), 2026-10-07
- **Executed**: 2026-10-07 on branch `fix/161-dead-stream-leg`; see "As built"
  at the end. The "Current state" line numbers below were read from a stale
  checkout; the as-built section names the real origin/main anchors.
- **Route**: Diagnose → Implementation, fit 9, model lane `fable-5`
  (multi-system: FFmpeg semantics, backend parser, platform polling, UI)

## Incident (2026-10-07, session `cf52b54a`, 20:49 CEST)

Record + stream, 1080p30 at 6000 kbps, four destinations. FFmpeg 8.1.1
(bundled). One FFmpeg process, five outputs, in this order:

| Output | What                                         |
| ------ | -------------------------------------------- |
| #0     | local MKV recording                          |
| #1     | YouTube, `rtmp://a.rtmp.youtube.com/live2/…` |
| #2     | Twitch                                       |
| #3     | Kick (rtmps)                                 |
| #4     | X (rtmps)                                    |

Each stream output is wrapped in FFmpeg's `fifo` muxer with
`-queue_size 512 -drop_pkts_on_overflow 1 -attempt_recovery 1 -recovery_wait_time 2`
(`append_bridge_copy_flv_output`, `recording.rs:15207`).

Timeline (UTC, from `health_events`, `session_logs`, `logs/backend.log`):

| Time              | Evidence                                                                                                                                                                                                          |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 18:49:38          | `stream-targets-configured`: 4 destinations                                                                                                                                                                       |
| 18:49:49          | `host-overloaded`: load 48 on 10 cores, 4.9 GB swap. Cause: another agent session's `cargo` build (`rustc` at 6.31 GB RSS, the screenshot the owner sent) plus a running recording smoke harness on the same Mac. |
| 18:49:47–18:50:01 | `stream-output-pressure`, `audio-output-stalled` ×2, `stream-output-stalled` (3 s), `stream-output-resumed`. Plan 087 behaved as designed.                                                                        |
| 18:57:52.526      | `[flv @ 0x702c4bc00] Failed to update header with correct duration.` / `…filesize.` — the FLV trailer of ONE output being closed.                                                                                 |
| 18:57:52.614      | `[aost#1:1/aac @ 0x703488900] Error submitting a packet to the muxer: End of file` — output #1 (YouTube). Logged to backend.log only; **not** a health event, **not** a target failure.                           |
| 19:00:11          | last `stream-viewers` sample that includes `youtube` (3 viewers). Every later sample lists only twitch/kick/x. Nobody acted on that.                                                                              |
| 21:18 local       | `lsof -p <ffmpeg>` shows exactly three ESTABLISHED sockets: Twitch :1935, Kick :443, X :443. No Google address. FFmpeg alive (7.7 % CPU), session `running`, Stream Manager "On air" for YouTube.                 |

The 6.31 GB `rustc` is not Videorc. Videorc's own processes totalled about
1.3 GB (renderer 635 MB, main 210 MB, backend 80 MB, FFmpeg 27 MB).

## Root causes

**RC1 — the fifo wrapper does not retry an EOF.** `libavformat/fifo.c`
`is_recoverable()` returns 0 for `AVERROR(EINVAL)`, `AVERROR(ENOSYS)`,
`AVERROR_EOF`, `AVERROR_EXIT`, `AVERROR_PATCHWELCOME` unless
`recover_any_error=1`. YouTube's ingest closed the TCP connection (an RTMP
server-side close surfaces as `AVERROR_EOF` on write). The fifo consumer
thread gave up, wrote the FLV trailer (the two "Failed to update header"
warnings), and set the error on its queue. We never set `recover_any_error`
and never set `restart_with_keyframe`.

**RC2 — FFmpeg finishes that one output quietly.** `fftools/ffmpeg_mux.c`:
`write_packet()` logs "Error submitting a packet to the muxer: End of file"
at ERROR and returns `AVERROR_EOF`; `muxer_thread()` treats `AVERROR_EOF`
without `stream_eof` as "Muxer returned EOF" (VERBOSE), sets `ret = 0`, and
exits that output's thread. The process, the other four outputs, and the
`-progress` clock keep going. So the global 30 s `OUTPUT_WEDGED_TIMEOUT`
from plan 087 never fires and `stream-output-failed` is never emitted.

**RC3 — the backend only recognises an initial connect failure.**
`parse_fifo_output_failure` (`recording.rs:18722`) matches
`[fifo @ 0x..] Error opening <url>: <reason>` and attributes by URL
(`stream_url_positions`). A mid-stream death is reported as
`[aost#N:M/…]` / `[vost#N:M/…] Error submitting a packet to the muxer: <err>`
or `[out#N/fifo @ …] Error muxing a packet` — no URL, no `[fifo @` tag.
`looks_like_ffmpeg_health_event` matches only dropped/overload/permission/
failed/connection, so "End of file" is not even an `ffmpeg-warning`.

**RC4 — recovery is invisible when it does happen.** All fifo recovery
outcomes are INFO (`Recovery successful`, `Recovery failed: %s`) or VERBOSE
(`Recovery attempt #n`); the live FFmpeg runs `-loglevel warning`
(`bridge_ffmpeg_base_args`, `recording.rs:15013`). A leg that is
reconnecting every 2 s looks identical to a healthy one.

**RC5 — no platform-side truth while live.** `get_youtube_stream_status`
(`youtube.rs:489`, `liveStreams.list part=status`, 1 quota unit) is only
called at go-live (`activatePreparedYouTubeBroadcasts`, `use-studio.tsx:9941`,
8 attempts). The viewer poll (`viewer_stats.rs`) already learns that YouTube
went offline (`concurrentViewers` absent, Twitch `data` empty) and silently
drops the platform from the sample instead of raising it.

## Design

Three independent layers, so no single parser is load-bearing:

1. **Reconnect** (RC1): the fifo leg retries any error, restarts on a
   keyframe, retries forever. A closed ingest connection is a transient.
2. **Report from FFmpeg** (RC2–RC4): parse the mid-stream mux failure by
   output index, and parse fifo recovery lines by routing FFmpeg's log
   level explicitly (`-loglevel level+info`), so the per-target snapshot
   flips to `failed` / `reconnecting` / back to `live`.
3. **Report from the platform** (RC5): while live, the viewer/status poll
   marks a target `warning` after two consecutive "offline" answers and
   clears it when the platform sees data again. YouTube additionally uses
   `liveStreams.list part=status` every 60 s (60 units/hour).

The renderer already has everything needed to show this:
`streaming-tab.tsx:198-215` collects `failed`/`not-configured` targets into
the "Some destinations aren't live" banner with Stop all / Continue, and
`runtimeBadge` maps `failed` → **Stopped**, `connecting` → **Connecting**.
Only a `reconnecting` presentation and the global Live chip need new work.

## Current state (excerpts, verified at `cdd2f942`)

`recording.rs:15230-15246` (fifo args):

```rust
args.extend([
    "-f".to_string(), "fifo".to_string(),
    "-fifo_format".to_string(), "flv".to_string(),
    "-queue_size".to_string(), "512".to_string(),
    "-drop_pkts_on_overflow".to_string(), "1".to_string(),
    "-attempt_recovery".to_string(), "1".to_string(),
    "-recovery_wait_time".to_string(), "2".to_string(),
    target.url.clone(),
]);
```

`recording.rs:14778-14795` (output order in copy fan-out): MKV via
`append_bridge_copy_file_output` first, then one
`append_bridge_copy_flv_output` per `stream_targets` entry. Stream-only
sessions (no `output_path`) start the flv outputs at #0.

`recording.rs:4406` builds `(stream_runtime, slave_positions,
stream_url_positions)` from `&stream_targets` — same order as the outputs.

`recording.rs:4773-4812` (stderr consumer): only `parse_fifo_output_failure`
(by URL) and `parse_tee_slave_failure` (by slave index) reach
`publish_stream_target_failure_if_active`, which emits
`stream-target-failed` and broadcasts `stream.targets`.

`recording.rs:19098` `looks_like_ffmpeg_health_event`: dropped / overload /
permission / failed / connection.

## Slices

### S1 — fifo legs reconnect after any error, on a keyframe

Files: `crates/videorc-backend/src/recording.rs`
(`append_bridge_copy_flv_output`; also the tee-less single-stream path if it
builds a fifo leg — search `"-attempt_recovery"`; today only one site).

1. Add after `-recovery_wait_time 2`:
   `-recover_any_error 1`, `-restart_with_keyframe 1`,
   `-max_recovery_attempts 0` (explicit: unlimited).
2. Comment why: an RTMP server-side close is `AVERROR_EOF`, which the fifo
   refuses to retry by default; plan 161 incident.
3. Keep `-drop_pkts_on_overflow 1` and `-queue_size 512`.

Done when: `cargo test -p videorc-backend fifo` passes with an updated
argument-shape test (search the existing test that asserts
`"-attempt_recovery"`; add the three flags), and the Stop path stays within
budget while a leg is in its retry loop (S5 smoke).

STOP if: FFmpeg 8.1.1 rejects any flag (`ffmpeg -h muxer=fifo` lists all
three; they have existed since 2016, 2016 and 2016).

### S2 — a mid-stream output death is attributed to its destination

Files: `crates/videorc-backend/src/recording.rs`.

1. New parser next to `parse_fifo_output_failure`:
   `parse_ffmpeg_output_mux_failure(line) -> Option<OutputMuxFailure { output_index: usize, reason: String }>`
   matching, case-insensitively, lines whose context tag is
   `[aost#N:M/…]`, `[vost#N:M/…]` or `[out#N/…]` and whose message contains
   `Error submitting a packet to the muxer: <reason>` or
   `Error muxing a packet`. Reason = text after the last `: `, trimmed,
   trailing `.` removed; empty → "Stream connection closed".
2. `build_stream_runtime` returns a fourth value
   `output_positions: Vec<Option<usize>>` mapping FFmpeg output index →
   target position, offset by 1 when a local recording output precedes the
   stream legs (`output_path.is_some()` in the copy fan-out branch; stream-
   only → offset 0). Thread the flag from the arg builder, not re-derived.
3. In the stderr consumer, after the fifo/tee branches: on a match with a
   known position, call `publish_stream_target_failure_if_active` with
   reason `"<Platform> closed the connection (<reason>)"`.
4. Extend `looks_like_ffmpeg_health_event` with `"end of file"`,
   `"error submitting"`, `"error muxing"`, `"recovery"`, so these lines also
   persist as `ffmpeg-warning` health events.
5. Unit tests beside `parses_fifo_output_failure_lines`: the exact incident
   line `[aost#1:1/aac @ 0x703488900] Error submitting a packet to the muxer: End of file`
   → index 1, reason `End of file`; `[out#2/fifo @ 0x1] Error muxing a packet`
   → index 2; `[aost#0:1/aac @ 0x1] Error submitting…` with a recording
   output present → `None` position (recording is not a stream target).

Done when: `cargo test -p videorc-backend output_mux_failure` passes and
`cargo clippy -p videorc-backend -- -D warnings` is clean.

Note: after S1 the EOF case no longer reaches this parser (the fifo
swallows it and retries), so S2 is the backstop for non-fifo paths and for
FFmpeg's "Maximal number of … recovery attempts reached" ERROR, not the
primary signal. S3 is the primary signal.

### S3 — fifo recovery is visible: level-tagged FFmpeg logging

Files: `crates/videorc-backend/src/recording.rs`
(`bridge_ffmpeg_base_args`, stderr consumer, parsers, tests).

1. Change the live-session base args from `-loglevel warning` to
   `-loglevel level+info`. Every av_log line now starts with `[info] `,
   `[warning] `, `[error] `, `[fatal] `. `-progress pipe:2` key=value lines
   are not av_log lines and stay unprefixed.
2. Add `strip_ffmpeg_level_prefix(line) -> (Option<FfmpegLogLevel>, &str)`
   and apply it once at the top of the consumer loop; every existing parser
   receives the stripped line (progress, stats, fifo, tee, fatal, filter
   command replies). **`-stats` lines are INFO av_log lines** — assert in a
   test that `parse_ffmpeg_stream_health` still parses a `[info] frame=…`
   line after stripping.
3. Routing: `[warning]`/`[error]`/`[fatal]` lines behave exactly as today
   (`stderr_tail.observe` + `emit_log("warn")`). `[info]` lines are
   `tracing::debug!` unless they match a recognised pattern below; the
   startup dump (`Input #0`, `Output #1, fifo, to '…'`, `Stream mapping`,
   `Stream #0:0 -> #1:0`) must not reach the bounded log ring or
   `classify_ffmpeg_fatal_line` (verify the fatal classifier's substrings
   — "could not open", "error opening input" — cannot match dump lines;
   add a test with a captured real startup dump).
4. New parsers:
   - `[fifo @ 0xPTR] Recovery failed: <err>` (INFO) → target state
     `reconnecting`, message `Reconnecting… (<err>)`, rate-limited to one
     snapshot broadcast per 10 s per target.
   - `[fifo @ 0xPTR] Recovery successful` (INFO) → target state `live`,
     health event `stream-target-resumed` ("Streaming to YouTube resumed").
   - `[fifo @ 0xPTR] Maximal number of N recovery attempts reached.` (ERROR)
     → `failed` (cannot happen with unlimited attempts; keep for safety).
5. Attribution of `0xPTR` → target: the fifo context pointer is stable per
   leg but never printed with a URL except on initial `Error opening <url>`.
   Pair it from the ERROR lines the inner protocol emits right before each
   `Recovery failed` on the same thread: `[tcp @ …] Connection to
tcp://<host>:<port> failed: …` and `[rtmp @ …] Cannot open connection
tcp://<host>:<port>`. Keep a `HashMap<ptr, position>` learned from the
   first host line that precedes a `Recovery failed` within 500 ms; host →
   position via the target URL's host (two targets on one host, e.g. dual-
   orientation YouTube, both get the state; say so in a comment). When the
   pointer is unknown, publish a session-level health event
   `stream-target-reconnecting` with no target and do NOT guess.
6. `StreamTargetState` gains `Reconnecting` (backend enum + the TS contract
   in `apps/desktop/src/shared/backend-rpc-contract.ts` + `lib/backend.ts`);
   `runtimeBadge` maps it to `{ tone: 'warning', label: 'Reconnecting' }`;
   `hasTargetNetworkProblem` in `stream-health-attribution.ts` already
   regex-matches "reconnecting" in the message — add the state too.

Done when: a unit test feeds the consumer a captured sequence
(`[error] [tcp @ …] Connection to tcp://a.rtmp.youtube.com:1935 failed: Connection refused`,
`[info] [fifo @ 0xA] Recovery failed: Connection refused`, …,
`[info] [fifo @ 0xA] Recovery successful`) and asserts the snapshot goes
live → reconnecting → live for position 0 only, with `stream-target-resumed`
emitted once. `pnpm smoke:multistream-endurance` still passes (it reads the
stderr tail and health events; level prefixes must not break its matchers —
grep `scripts/smoke-multistream-endurance-app.mjs` for stderr patterns).

STOP if: `level+info` makes FFmpeg print per-packet lines in any bundled
build (it should not; INFO is not per-packet), or the stderr pipe backs up
(`ffmpeg-stderr-read-failed` in a smoke).

### S4 — the platform tells us when it stops receiving

Files: `crates/videorc-backend/src/viewer_stats.rs`, the viewer sampling
task that calls `merge_viewer_sample` (search `VIEWER_SAMPLE_LOG_CODE`),
`crates/videorc-backend/src/youtube.rs`, `main.rs` (no new RPC needed),
`stream_targets` snapshot helpers in `recording.rs`.

1. `merge_viewer_sample` keeps `None` counts instead of filtering them:
   add `offline: Vec<StreamPlatform>` to `ViewerSample` (serde default so
   old renderers ignore it). Twitch `data: []` and YouTube missing
   `concurrentViewers` both mean "the platform sees no live stream".
2. In the sampling task: per target, count consecutive offline samples.
   On the 2nd consecutive miss (≈4 min at the 120 s YouTube cadence; use
   the per-platform cadence already configured) → mark the target
   `warning` with message `"<Platform> isn't receiving the stream"` and emit
   health event `stream-target-offline` (Warn). On the next sample that
   has a count → clear to `live` and emit `stream-target-resumed` unless S3
   already did within 30 s.
3. YouTube, tighter: while a YouTube target is live, call
   `get_youtube_stream_status` every 60 s (reuse the client, the account's
   token refresh path, and `youtube_quota` accounting as `liveStreams.list`,
   1 unit). `streamStatus != "active"` or `healthStatus == "noData"` on two
   consecutive calls → same `warning` transition as above with the API's
   message. Respect the plan 094 quota breaker: if the breaker is open,
   skip the poll and rely on S3 only.
4. Do not touch Kick/X: their viewer polls return 0 while offline, which is
   indistinguishable from "nobody watching". Document that in a comment.

Done when: `cargo test -p videorc-backend viewer_stats` covers the two-miss
rule and the recovery; a `youtube` unit test with the existing axum mock
(`fetches_youtube_stream_status_for_active_ingest`, `youtube.rs:1578`)
returns `inactive` twice and asserts the `warning` transition. Daily quota
log (`youtube-api-usage`) shows +60 units/hour at most while live.

### S5 — the Stream Manager tells the truth, and the smoke proves it

Files: `apps/desktop/src/renderer/src/components/tabs/streaming-tab.tsx`,
the Stream Manager live chip (search `On air` and the 32 px stats bar from
plan 057 under `apps/desktop/src/renderer/src/components`), one new smoke.

Read `.claude/skills/videorc-design/SKILL.md` before touching UI.

1. Global chip: all targets `failed`/`warning`/`reconnecting` → **Not live**
   (destructive); some → **Partly live** (warning) with the count; the
   existing "Some destinations aren't live" banner also lists
   `reconnecting` and `warning` targets under "Reconnecting:" and
   "Not receiving:" lines, with Stop all / Continue streaming unchanged.
2. Toast once per transition per target, icon-tinted only
   (`feedback-toasts-never-tinted`): "YouTube stopped receiving your
   stream — reconnecting" / "YouTube is back".
3. New smoke `scripts/smoke-stream-leg-eof-app.mjs` wired as
   `pnpm smoke:stream-leg-eof`: start a local RTMP sink (reuse
   `spawnRtmpSink` from `scripts/stream-av-sync-baseline.mjs`, or the sink
   `smoke-multistream-endurance-app.mjs` uses) for two legs, go live, after
   20 s close ONE sink's accepted socket server-side (EOF, not SIGSTOP),
   assert within 10 s a `stream-target-reconnecting`/`stream-target-failed`
   health event for that leg only and `stream.targets` showing the other
   leg `live`; restart the sink, assert `stream-target-resumed` within 15 s
   and that the sink receives new FLV bytes with a keyframe first; then
   Stop and assert the stop latency budget from `smoke:record-latency:gate`
   still holds while a leg is mid-retry (kill the sink again just before
   Stop).

Done when: the smoke passes three times in a row on an idle Mac;
`pnpm typecheck && pnpm lint && pnpm format:check`;
`pnpm --filter @videorc/desktop test`; `cargo fmt --check --all`;
`cargo test -p videorc-backend`; `cargo clippy -p videorc-backend -- -D warnings`;
`pnpm smoke:recording-studio`; `pnpm smoke:multistream-endurance`;
`pnpm smoke:multistream`.

## Out of scope

- Restarting a stream leg in a separate FFmpeg process (stream legs share
  the recording's FFmpeg by design; plan 087 notes).
- Twitch/Kick/X API-side health beyond what the viewer poll already fetches.
- Stopping other agent sessions from building on the owner's Mac during a
  live session. That is operational: memory
  `videorc-stream-host-overload-plan-087` already says to use
  `taskpolicy -c utility nice -n 15 cargo … -j 4` and to check for a live
  `Videorc.app/…/ffmpeg` first. Consider a `scripts/guard-live-session.mjs`
  pre-step for every smoke as a follow-up.

## STOP conditions

- The incident lines in "Current state" do not match the live code.
- FFmpeg 8.1.1 `ffmpeg -h muxer=fifo` lacks `recover_any_error`,
  `restart_with_keyframe` or `max_recovery_attempts`.
- With `-loglevel level+info`, `pnpm smoke:recording-studio` or
  `pnpm smoke:multistream-endurance` fails on a stderr matcher.
- Stop latency exceeds the `smoke:record-latency:gate` budget while a leg
  is retrying (then bound the fifo retry at Stop instead of shipping).
- The YouTube quota breaker from plan 094 trips in local testing.

## Verification summary

| Gate                                                                                        | Why                                                                                                                                           |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `cargo test -p videorc-backend` + clippy `-D warnings`                                      | parsers, args, viewer rule                                                                                                                    |
| `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, desktop vitest                          | contract + UI                                                                                                                                 |
| `pnpm smoke:stream-leg-eof` (new)                                                           | the incident, reproduced and fixed                                                                                                            |
| `pnpm smoke:multistream-endurance`, `pnpm smoke:multistream`, `pnpm smoke:recording-studio` | nothing else regressed with level-tagged logs                                                                                                 |
| Owner acceptance                                                                            | go live to YouTube + Twitch, pull the Ethernet cable for 15 s: both show Reconnecting, both come back, YouTube Studio shows the stream resume |

## Model lane note

S1 and S2 are `gpt-5.5`-shaped (clear, mechanical, unit-tested). S3 and S4
are `fable-5` (FFmpeg log-level semantics, pointer attribution, quota
interplay). S5 UI copy is `opus-4.8` under `videorc-design`; the smoke is
`gpt-5.5`.

## As built (2026-10-07)

Executed on `fix/161-dead-stream-leg` off `cdd2f942`. The design held; these
are the places the build differs from the draft above, and why.

### Verified FFmpeg behaviour (bundled 8.1.1)

Reproduced with the bundled FFmpeg publishing to a local `ffmpeg -listen 1`
that was killed mid-stream and restarted, at `-loglevel level+info`:

```text
[flv @ 0xac4c1f200] [warning] Failed to update header with correct duration.
[tcp @ 0xac4c446e0] [error] Connection to tcp://127.0.0.1:19361?tcp_nodelay=0 failed: Connection refused
[rtmp @ 0xac4c20700] [error] Cannot open connection tcp://127.0.0.1:19361?tcp_nodelay=0
[fifo @ 0xac4c1c500] [error] Error opening rtmp://127.0.0.1:19361/live/k: Connection refused
[fifo @ 0xac4c1c500] [info] Recovery failed: Connection refused
… (one pair per retry)
[fifo @ 0xac4c1c500] [info] Recovery successful
```

- The level tag follows the context prefixes (`[fifo @ …] [info] …`); only
  context-free lines start with it (`[info] frame= …`).
- The fifo context pointer is stable for a leg's life, and `Error opening
<url>` carries it on every failed retry. That is exact attribution, so the
  draft's TCP-host pairing heuristic (S3 step 5) was not built.
- `max_recovery_attempts` already defaults to 0 (unlimited) and is not
  passed. Only `-recover_any_error 1 -restart_with_keyframe 1` were added.
- Command replies and `Enter command:` are plain `fprintf` writes, so level
  tagging never touches them. The stats line switches from `fprintf` to an
  INFO `av_log` and gains an `[info] ` tag, which the relay strips.

### Backend (`crates/videorc-backend/src`)

- `recording.rs` `append_bridge_copy_flv_output`: the two flags, plus the
  debug-only `source_switch_output_options_are_known` allowlist.
- `bridge_ffmpeg_base_args`: `-loglevel level+info` (only the encoder-bridge
  FFmpeg; legacy shapes keep `warning`).
- `relay_ffmpeg_stderr` + `strip_ffmpeg_log_levels`: tags are stripped per
  `\r` segment; a line whose most severe tag is INFO or lower, and that is
  not stats/progress noise, becomes the new `FfmpegStderrEvent::Info`. Every
  warning-level reader (stderr tail, fatal classifier, log ring, health
  events) sees the same text as before.
- `StreamLegMonitor` (pure) turns stripped lines into `StreamLegUpdate`s:
  `Error opening` and `Recovery failed` → Reconnecting, `Recovery successful`
  → Resumed, `Maximal number of … recovery attempts` and the per-output
  `Error submitting a packet to the muxer` / `Error muxing a packet` (mapped
  through the INFO startup dump `Output #N, fifo, to '<url>'`) → Failed. An
  unknown fifo is reported as an unattributed reconnect/resume, never
  guessed. S2 therefore depends on S3's log level.
- `StreamTargetState::Reconnecting` (`streaming.rs`). Transitions broadcast
  only on a state change; a retry with a new reason updates the snapshot
  silently. A `Failed` destination is terminal: FFmpeg reconnecting the
  socket never revives it.
- Health events: `stream-target-reconnecting`, `stream-target-resumed`,
  `stream-target-reconnected` (unattributed), `stream-target-not-receiving`.
- Publishing waits up to 10 × 50 ms for the recording slot instead of one
  `try_lock`, so a briefly busy slot does not lose a reconnect notice while
  the stop path's bounded join still wins.

### Platform watch (S4)

- YouTube omits `concurrentViewers` whenever a broadcast has zero viewers, so
  a missing viewer count can't mean "offline". The draft's change to
  `merge_viewer_sample` was not built.
- New `platform_stream_watch.rs`: per live YouTube broadcast, the bound
  stream's `liveStreams.list part=status` every 60 s and
  `liveBroadcasts.list part=status,contentDetails` on the first poll and
  every fifth (≈72 units/hour). It rides the plan 094 breaker and the
  `Viewers` budget step. `active` with `noData`, `inactive`, `ready`,
  `created`, `error` or `revoked` health is "not receiving"; a `complete` or
  `revoked` broadcast is "ended" and fails the destination.
- Twitch: the viewer poll's empty `data` list is now `CountFetch::Offline`.
- `PlatformLiveness`: "not receiving" only after the platform once said
  "receiving", and only after two answers in a row; repeated while it lasts.
- `recording::observe_platform_stream`: a platform only demotes a `live`
  destination to `warning` and only clears its own `warning`; FFmpeg's
  reconnect state wins.
- Kick and X are untouched (their polls cannot tell offline from idle
  reliably).

### Renderer (S5)

- Contract: `'reconnecting'` in `StreamTargetState` and the runtime schema.
- Streaming tab banner lists Reconnecting and Not receiving destinations and
  reappears for a new problem after "Continue streaming".
- Destination cards: Reconnecting / Not receiving badges.
- Stream Manager health stat: "YouTube reconnecting", "YouTube not
  receiving", "2 not live", ranked after failed and ahead of dropped frames.
- `lib/stream-target-notices.ts`: one keyed toast per destination for
  stopped, reconnecting, not receiving and back ("is back" replaces
  "is reconnecting" in place).
- Not built: the draft's ON AIR → "Not live / Partly live" chip. The session
  is still live (recording and other legs), and the health stat beside the
  chip now names the down destination in red.

### Smokes

- New `pnpm smoke:stream-leg-eof` (`scripts/smoke-stream-leg-eof-app.mjs`).
- `smoke:multistream` and `smoke:multistream-endurance` accept
  `reconnecting` for an unreachable leg.
