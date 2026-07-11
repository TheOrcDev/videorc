# Live captions reliability and styles — acceptance, 2026-07-11

Scope: the desktop/backend work in `videorc` plus the authenticated readiness and
canary work in `videorcweb`, following the Obsidian plan
`2026-07-11 - Videorc Live Captions Reliability And Styles Plan`.

This note separates deterministic proof completed before review from the
real-account, destination, and platform passes that must happen during staged
rollout. It intentionally contains no bearer, Gateway key, realtime client
secret, WebSocket URL, transcript text, provider response body, or user data.

## Recovery and deployment proof

| Check                                                                         | Result              | Evidence                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Live Vercel project has scoped caption Gateway auth in Preview and Production | PASS                | Configuration restored on 2026-07-11; one active scoped key, monthly spend cap configured.                                                                                                                                                                                                                        |
| Realtime voice safety decision                                                | KILL-SWITCHED       | A redacted live-provider protocol probe showed that the voice model auto-created assistant responses despite transcription-only configuration. A direct desktop-to-provider socket also cannot be authoritatively metered by the server. Realtime remains configured for diagnosis but is unavailable to clients. |
| Quota-aware protected-preview readiness                                       | PASS                | Authenticated readiness reported `preferredTransport: chunked`, `ready-chunked-realtime-disabled`, realtime configured + disabled + unavailable, chunked available, and a positive server-metered allowance.                                                                                                      |
| Protected-preview realtime token route                                        | PASS — FAILS CLOSED | Authenticated request returned the expected safe `503`; no client secret or provider URL was minted.                                                                                                                                                                                                              |
| Protected-preview chunk transcription and metering                            | PASS                | A canonical deterministic spoken WAV returned HTTP `200`, non-empty transcription, model `xai/grok-stt`, and a three-second server-derived charge. A post-request capabilities read proved the per-user/month reservation persisted; transcript text and provider bodies are omitted.                             |
| Realtime configuration default                                                | PASS — FAILS CLOSED | Missing, blank, true, or malformed `VIDEORC_AI_CAPTIONS_REALTIME_DISABLED` values keep direct provider sockets disabled. Only an explicit false value can enable an isolated experiment.                                                                                                                          |
| Monthly allowance concurrency and rollover                                    | PASS                | Canonical PCM duration is conditionally reserved before provider work on one server-derived row per user and UTC month. Concurrent requests serialize on the unique row; older per-session rows still count during migration, and a reused client ID cannot escape the next month.                                |

Protected preview verified from deployment
`dpl_DQEWFxLKfE2nvpNq3vnBNCkieArM`
(`https://videorc-rj23qmg6h-orc-dev.vercel.app`). The production-safe transport
is therefore the server-metered approximately three-second chunk path. The UI
must describe its higher delay truthfully; this evidence does not authorize
re-enabling the realtime voice transport.

## Deterministic desktop/backend proof

| Contract                              | Result | Evidence                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP + realtime Gateway wire contract | PASS   | `pnpm smoke:captions-contract`; an owned debug backend proves exact config/audio, partial/final upsert, assistant-response rejection, bounded retry, and both assistant-safety and unavailable-service chunk fallback without renderer intent races.                                                                                            |
| Mic-to-pixels live stream path        | PASS   | `pnpm smoke:captions-live`; post-controls PCM → exact realtime kill-switch response → credential-free fake chunk route → `captions.update` → real renderer PNG → compositor → local RTMP → ffprobe/ffmpeg analysis.                                                                                                                             |
| Live artifact                         | PASS   | 640×360 H.264 at 30 fps; clean MP4 13.733 s/412 frames, RTMP FLV 13.487 s/405 frames, and captioned copy 13.733 s/412 frames. Stream analysis found 35 clean baseline frames followed by 46 consecutive caption frames; the captioned copy found 18 baseline plus 54 caption frames. Five chunks, including the final remainder, were uploaded. |
| Runtime truth and teardown            | PASS   | Ready/Starting/Listening/Reconnecting/Degraded/Blocked/Error state model; backend-owned stop/block/sign-out clearing; renderer and detached-reader reset event. The safe deployed path reports chunked transport and higher delay instead of claiming realtime listening.                                                                       |
| Privacy                               | PASS   | Caption tap is after live mute/gain; sign-out joins the task and purges audio tap, transcript state, pending cue work, and both overlay slots.                                                                                                                                                                                                  |
| Transport continuity                  | PASS   | One sequence and capture-relative timeline survive realtime→chunk fallback and off/on mid-session.                                                                                                                                                                                                                                              |
| Split outputs                         | PASS   | Primary/auxiliary overlays are revisioned independently; 4K recording and 1080p stream dimensions remain distinct. Split-only FFmpeg probing is bounded to 4,096 bytes so sequential stream-info discovery cannot starve the sibling FIFO before its reader thread starts.                                                                      |
| Recording semantics                   | PASS   | Original stays clean; Recording selection controls the non-destructive `(captioned)` copy; stream captions force a clean-recording split when needed.                                                                                                                                                                                           |
| Overlay coexistence                   | PASS   | Captions reserve comment-highlight safe area on the same top/bottom edge in 16:9 and 9:16 CPU/Metal layout tests.                                                                                                                                                                                                                               |

## Final-review regression closure

The named regressions and the final combined backend gate pass together.

| Regression                                                        | Result | Evidence                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Explicit opt-out discards queued audio                            | PASS   | `explicit_caption_opt_out_discards_audio_already_queued_for_transcription` proves stop takes task ownership and queued PCM is not consumed after privacy opt-out.                                                                                                                            |
| Chunk buffering and final remainder                               | PASS   | `chunk_buffer_drains_while_upload_is_pending_and_flushes_final_remainder` proves conversation continues entering a bounded queue while an upload is pending and the short final chunk is retained.                                                                                           |
| Reconnect exhaustion is bounded                                   | PASS   | `configuration_send_failures_exhaust_realtime_retry_budget` and `configuration_ack_then_close_still_exhausts_realtime_retry_budget` prove accepting-then-closing providers fall back rather than spin.                                                                                       |
| Off/on keeps unique sequence IDs                                  | PASS   | `caption_sequence_survives_off_on_runtime_restarts_until_capture_reset` and the realtime→chunk uniqueness test preserve one capture-owned monotonic namespace.                                                                                                                               |
| Stop, block, terminal failure, and sign-out clear authoritatively | PASS   | Backend lifecycle regressions assert both overlay slots clear and the renderer receives `captions.cleared`; capture-end presentation clears while artifact cues remain, and sign-out abort+join completes before credential removal.                                                         |
| Unapplied live audio controls stay truthful                       | PASS   | `live_audio_processing_update_requires_an_active_matching_session` plus the 10 `live-audio-processing` renderer tests prove `applied: false` is honored, stale responses cannot cross sessions, and unsupported live controls roll back to the last accepted values.                         |
| Finalization work is bounded and capture-owned                    | PASS   | Cue rendering uses a generation-serialized FIFO with independent progress watchdogs; sign-out and backend shutdown cancel and join the provider plus render/burn work, remove the microphone tap, purge frame caches, and keep artifact completion separate from live-presentation clearing. |
| Session output readiness fails closed                             | PASS   | Caption burn preflight blocks output profiles above 30 fps and mixed record/stream profiles; eligible captions-off sessions pre-arm the live leg for mid-session opt-in, while ineligible sessions report a one-session suppression instead of silently omitting captions.                   |

The final integrated live-smoke artifact report was generated at
`/var/folders/5b/08_snhzs2xb559qf1j6dth2r0000gn/T/videorc-captions-live-1783743593200/captions-live-artifact.json`.
That path is local evidence, not a committed fixture.

## UI and style proof

| Check                    | Result | Evidence                                                                                                                          |
| ------------------------ | ------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Dedicated Captions page  | PASS   | Sidebar, command palette, routing, `⌘6`, real-aspect sticky preview, shared controls.                                             |
| Livestream controls      | PASS   | The same `CaptionsControls` composition is reused; Studio remains a compact status/manage surface.                                |
| Presets                  | PASS   | Classic, Glass, Lower third, and High contrast share one registry across preview, live overlays, detached reader, and final copy. |
| Accessibility            | PASS   | Keyboard-labelled choices; partials are visual; only finalized cues enter `aria-live`; reader toggles with `⌘⇧C`.                 |
| App themes               | PASS   | Fresh-profile dark and light screenshot sweep for Captions and Livestream.                                                        |
| Output backgrounds/sizes | PASS   | Exact renderer contact sheets inspected over light/dark/motion at 1280×720, 1920×1080, 3840×2160, and 1080×1920.                  |

Local visual evidence:

- `/tmp/videorc-ui-captions-dark.png`
- `/tmp/videorc-ui-captions-light.png`
- `/tmp/videorc-ui-streaming-dark.png`
- `/tmp/videorc-ui-streaming-light.png`
- `/tmp/videorc-caption-style-sheets-final/`
- `/tmp/videorc-captions-live-pass-stream.png`
- `/tmp/videorc-captions-live-pass-copy.png`

These are generated QA artifacts and are intentionally not committed.

## Gate record

| Gate                                                  | Result                | Notes                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop caption/UI regressions                        | PASS                  | Included in the 774-test desktop suite; focused caption, preflight, live-audio, reader, routing, and style cases are green.                                                                                                                                                                        |
| `pnpm typecheck` / `pnpm lint` / `pnpm format:check`  | PASS                  | Final integrated worktree.                                                                                                                                                                                                                                                                         |
| `pnpm --filter @videorc/desktop test`                 | PASS                  | 93 files, 774 tests.                                                                                                                                                                                                                                                                               |
| `pnpm test:scripts`                                   | PASS                  | 564 tests, including encoded caption/highlight artifact analyzers.                                                                                                                                                                                                                                 |
| Rust tests                                            | PASS                  | 48 native-helper tests, 996 backend tests (7 ignored by design), and the content-length wire test: 1,045 passed.                                                                                                                                                                                   |
| Rust fmt / clippy / advisory audit                    | PASS                  | `cargo fmt --check --all`, clippy with warnings denied, and `cargo audit`.                                                                                                                                                                                                                         |
| JS production advisory audit                          | PASS WITH NOTE        | Pinned pnpm 11 passes the configured high-severity gate; one moderate advisory remains. The repo wrapper selected an incompatible global pnpm, so the exact audit command was rerun directly under pnpm 11.                                                                                        |
| `pnpm build`                                          | PASS                  | Electron main, preload, captions reader, Captions page, and main renderer production bundles built.                                                                                                                                                                                                |
| `pnpm smoke:captions-contract`                        | PASS                  | Owned debug backend; exact realtime contract, repeated-completion upsert, unsafe assistant-response → immediate chunk fallback, disabled-realtime fallback, and first-frame→producer-stall truth.                                                                                                  |
| `pnpm smoke:captions-live`                            | PASS                  | Exact kill-switch code → server-metered chunk fallback → real renderer/compositor/local RTMP. Muted upload peak/RMS were zero; +6 dB produced a 1.996× amplitude ratio; stream had 35 baseline + 46 caption frames, original had zero caption frames, and captioned copy had 54 caption frames.    |
| `pnpm smoke:recording-studio`                         | PARTIAL / ENV BLOCKED | Steps 1–21 passed, including all-layout artifacts, split stream/highlight coexistence, native preview lifecycle/placement/interaction/surface gates. Step 22 stopped because ScreenCaptureKit discovery returned no native screen source on this host.                                             |
| Notes-window real-screen smoke                        | ENV BLOCKED           | Rerun separately; same missing ScreenCaptureKit source, before capture.                                                                                                                                                                                                                            |
| `pnpm smoke:recording-studio:devices`                 | ENV BLOCKED           | The required ScreenCaptureKit source is unavailable, so real-device parity cannot be asserted.                                                                                                                                                                                                     |
| Web typecheck / lint / build / targeted caption tests | PASS                  | 30 caption/readiness/canary tests; fail-closed realtime, canonical PCM validation, atomic monthly reservation, HTTPS/loopback validation, persisted canary metering, and redaction are green. Lint has one unrelated existing `<img>` warning; local and protected-preview production builds pass. |
| Web full test suite                                   | BASELINE FAIL         | 271/273 pass. The same two unrelated `contributors` metadata/`llms.txt` expectations fail on clean `origin/main`.                                                                                                                                                                                  |
| Web full format check                                 | BASELINE FAIL         | Existing unrelated formatting debt; every touched file is checked independently.                                                                                                                                                                                                                   |

## Staged acceptance still required

| Row                                                   | State   | Why / next proof                                                                                                                                                                               |
| ----------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Real Premium macOS microphone, 60-second conversation | BLOCKED | Run after review on an owner account with microphone permission; verify truthful chunked/higher-delay status, finalized cues, SRT timing, clean original, and captioned copy.                  |
| Unlisted/live external destination                    | BLOCKED | Requires intentionally publishing to a real destination; perform in the owner rollout.                                                                                                         |
| Windows capture path                                  | BLOCKED | No Windows host in this workspace. Unsupported paths fail closed; parity cannot be declared until the Windows device gate passes.                                                              |
| Realtime voice transport re-enable                    | BLOCKED | Requires an authoritative server-side relay/meter and a live provider contract that cannot create assistant responses; direct-client elapsed-time reports are not an acceptable quota control. |
| Owner → small Premium cohort → all Premium            | BLOCKED | Operational rollout follows merge and production deployment; watch chunk latency, error rate, quota, and cost metrics.                                                                         |
| Production canary from merged web commit              | BLOCKED | After the web PR reaches Production, run `VIDEORC_CAPTIONS_CANARY_ALLOW_CHUNKED_ONLY=true pnpm smoke:captions-production` with the authenticated deterministic WAV fixture.                    |

## Review verdict

The deterministic implementation is suitable for draft-PR review. The
deployable posture is chunked-only: server-metered captions with truthful
higher-delay status. This is not a declaration of realtime voice safety,
Windows parity, or full Premium rollout; the blocked rows are explicit
release-stage acceptance work, not silently waived checks.
