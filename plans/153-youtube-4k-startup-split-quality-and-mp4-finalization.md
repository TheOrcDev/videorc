# Plan 153: Fix YouTube startup, expose HD stream + 4K recording, clarify MP4 completion

## Status and execution baseline

- **Priority:** P0 for YouTube startup; P1 for independent quality controls and finalization UX.
- **Status:** IMPLEMENTED; acceptance in progress, 2026-10-05. No release performed. See [execution evidence](../docs/acceptance/2026-10-05-stream-quality-finalization.md).
- **Numbering:** originally investigated as Plan 152; renumbered because current main already assigns 152 to named recording markers.
- **Implementation baseline:** `5fb14b33` on isolated branch `fix/152-stream-quality-finalization`.
- **Source inspected:** `origin/main` at `f9da9cbc3ccd7452a88e3f7531ffe114ce10b6a0`, release record for installed macOS **0.9.132**.
- **Shared checkout:** `15206746`, considerably older than the installed app. Implement from current main in an isolated branch; do not apply this plan blindly to the shared checkout. Compare the named symbols against current source first.
- **Scope:** YouTube OAuth setup and profile selection, independent recording/stream quality controls, MP4 completion visibility and recovery verification. Keep the existing capture/encoder architecture unless reproduction proves a deeper defect.
- **Product interpretation:** “HD streaming” means 1920×1080; “4K local recording” means 3840×2160. Start with 30 fps; preserve existing supported 60 fps choices and their validation.

The owner reported an initial YouTube failure with 4K selected, an immediate failure on retry, and an MKV after a stream longer than two hours. This plan separates established facts from conclusions that still need a real-provider check.

## Investigation findings

### A. The two YouTube failures happened during broadcast setup

Read-only evidence came from `~/Library/Application Support/Videorc/logs/backend.log.1`, the session database, current release source, and the public channel. Times below are **Europe/Madrid (UTC+2)** on 2026-10-05.

| Time | Evidence | Meaning |
| --- | --- | --- |
| 17:31:51 | Output preflight: recording `3840×2160 @30 / 6000 kbps`, stream `1920×1080 @30 / 6000 kbps`, VideoToolbox MPEG-TS | Split output was selected before the first failure. |
| 17:32:03 | `[youtube-prepare] failed: YouTube broadcast bind failed (403 Forbidden): liveBroadcastBindingNotAllowed: The binding is not allowed` | YouTube failed before media transmission to that destination. |
| 17:32:10–17:36:35 | Session `6bfdf419…` configured Twitch, Kick and X; **YouTube was absent** | The other destinations continued after partial setup failure. |
| 17:37:16 | The same YouTube bind rejection on retry | Matches the owner's immediate-repeat report. |
| 17:37:26 | Output preflight now reports recording **and** stream at 1080p | The recording profile changed before setup succeeded. |
| 17:37:39–17:37:41 | Short YouTube-only session `c8bf2617…` | Setup succeeded at HD; this is distinct from the two bind failures. |
| 17:38:05–19:46:36 | Session `35851c63…`, all four destinations, recording and stream at 1080p | The sustained successful session. |

The failed prepares rolled back their newly created broadcast. The public [OrcDev Live archive](https://www.youtube.com/@orcdev/streams) shows [Tools That Feel Illegal To Be Free](https://www.youtube.com/watch?v=EshJZBgRcjE), approximately 2:08. It does not expose the private provider error or prove why bind failed. No public test broadcast was created during this investigation.

**Two concrete code defects are established:**

1. `prepareOauthTargetsForGoLive` in `apps/desktop/src/renderer/src/hooks/use-studio.tsx` (~12830–12916) sends `outputVideo` to the immediate horizontal `streamTargets.youtube.prepare` request. `GoLiveSessionOutput.video` is explicitly the **recording** profile. The vertical immediate branch uses `captureConfig.video`, also the recording profile. The scheduled branch already resolves a target's stream settings instead, so the paths disagree.
2. `prepare_youtube_broadcast` in `crates/videorc-backend/src/youtube.rs` (~495–590) hardcodes `contentDetails.latencyPreference = "low"`, then sets `cdn.resolution` from the supplied video's short side. The UI says YouTube 4K uses normal latency, but the request does not implement that rule.

A local, dependency-free request-expression replay loaded the release's actual `capture.ts` functions using Node's TypeScript stripper and evaluated the actual immediate-prepare `video` expression extracted from `use-studio.tsx`. It produced:

```text
recording=record-4k30      encoderStream=1920x1080 youtubePrepare=3840x2160 matches=false
recording=tutorial-1080p30 encoderStream=1920x1080 youtubePrepare=1920x1080 matches=true
Backend latencyPreference literal: low
```

This reproduces the **request mismatch**, not Google's rejection in a live test. Together with the two field failures and the HD success, it is the leading explanation. Google documents that [low and ultra-low latency do not support 4K](https://support.google.com/youtube/answer/7444635?hl=en). However, its [error reference](https://developers.google.com/youtube/v3/live/docs/errors) describes `liveBroadcastBindingNotAllowed` generically as a broadcast-state restriction. The raw request bodies and returned broadcast lifecycle states were not retained. **Do not label the exact Google-side cause proven until the corrected request is accepted or a controlled provider comparison distinguishes it.**

Ranked alternatives and falsification:

1. **Wrong advertised profile plus unsupported latency.** Prediction: 4K recording + HD stream prepares `1080p/30fps/low` after the fix, and actual 4K prepares `2160p/30fps/normal`; both bind successfully with fresh resources.
2. **Broadcast lifecycle/auto-start conflict.** Prediction: correctly matched profile/latency still fails and a bounded state read shows the broadcast left a bindable state. Record returned states before changing lifecycle behavior.
3. **Stale resource, permissions, or provider-side restriction.** Prediction: fresh requests with supported settings still fail independently of local recording resolution. Distinguish provider reason codes; do not reconnect accounts or blindly retry every 403.

Encoder overload/upload starvation cannot explain a bind failure before ingest. Later `invalidTransition` messages at 17:37:42–43 followed the short HD session stopping; cover that start/stop race separately rather than conflating it with 4K setup.

### B. HD stream + 4K recording already exists in the media engine

- `capture.ts`: `streamOutputVideoForTarget`, `resolveProviderStreamOutputPlan`, target overrides and stream defaults already exist.
- `go-live-output.ts`: `settleGoLiveSessionOutput` settles hardware capability and fallback behavior; `video` is recording, `streaming` holds destination settings.
- Backend recording/encoder bridge already support separate output encoders and bounded stream pressure independent of the local recording.
- Session `6bfdf419…` reports `encoderBridgeSeparateOutputEncodersActive=true`, local `3840×2160`, stream `1920×1080`, and zero recording queue drops. `ffprobe` confirms its local MP4 is H.264 **3840×2160, 30 fps, 264.1 seconds**. There is no retained remote artifact proving the received stream dimensions for this field session.
- The release's `components/streaming/go-live-panel.tsx` displays a Quality checklist and recording summary but offers no quality picker. Searches found no component control writing `defaultOutputPreset` or target `outputPreset`.
- Recording's resolution buttons call `patchVideo({width,height})`; `patchVideo` preserves bitrate and makes the profile custom. Thus today's 4K recording was configured at **6000 kbps**, rather than the existing `record-4k30` preset's 30000 kbps. Pixel dimensions alone are not a sufficient “4K quality” contract.

Reuse the engine and existing preset validation. Plans 006/023 explain its history, but their old blockers and implementation status are not the current baseline. The needed work is consistent output planning, usable controls and end-to-end proof.

### C. The two-hour recording successfully became MP4

Session `35851c63-3ff7-4cbb-8d05-6261883e7990`:

- Stop/MKV close: **19:46:36.88**.
- Background export began: **19:46:36.96**.
- `mp4-export-created`: **19:50:38.50**, about **4 minutes 2 seconds** after Stop.
- Database: `status=completed`, `finalization_state=finalized`, `finalization_error=NULL`, `keepOriginalMkv=false`, populated `mp4_path`.
- Existing file: `~/Movies/Videorc/Recordings/videorc-session-20261005-153805-35851c63-3ff7-4cbb-8d05-6261883e7990.mp4`.
- `ffprobe`: genuine MP4 container; H.264 **1920×1080**, ~30 fps, video **7711.333 s**, AAC audio **7711.296 s**, **5,964,957,862 bytes**. Matching track lengths are not a full lip-sync measurement.
- The MKV is no longer present. The database retains its historical `output_path` and `container=tee`; consumers must prefer `mp4_path` and the finalization state rather than treating those historical fields as the delivered format.

The file was **not permanently stranded as MKV**. Whether the owner saw the intermediate file in Finder or a stale in-app state is unconfirmed. The current source already has a Library `Saving MP4…` / progress badge, failure badge, retry action, background job registry, quit/update waiting, and interrupted-job recovery. Do not propose these as missing infrastructure.

`mp4_export_args` copies video, encodes audio to AAC 256 kbps, maps all tracks, and uses `+faststart`. A long file can therefore take noticeable time to finish. Phase durations were not logged, so audio encoding versus disk/faststart versus publication cost remains unmeasured. Do not promise an instant export or switch to direct MP4 capture to hide the delay. ADR 0001 preserves MKV-first capture for recovery.

### Additional observations to carry into acceptance

- The sustained HD stream accumulated **4984 stream queue drops** and **4931 pressure recoveries**, with zero recording queue drops. Establish rate, affected destinations and queue-age behavior under the same multistream topology. These totals do not establish a YouTube-specific network problem.
- The attached camera reported approximately **25 fps** for a requested 30 fps session. Keep this distinction in artifact/cadence results; do not mistake source cadence duplication for a new split-output defect.
- YouTube API budget notices occurred near the end of the long stream, not at the initial bind failures. They are not evidence that quota caused this incident.

## Required product behavior

1. **Record 4K locally and stream Full HD independently.** Selecting stream quality cannot lower the saved local recording profile. Selecting local quality cannot silently change a destination profile.
2. Show a concise pre-start summary: `Stream: Full HD · 30 fps` and `Recording: 4K · 30 fps`, with actual effective values. Keep encoder internals under Technical details.
3. True YouTube 4K is an explicit supported choice, with normal latency; other providers retain their supported profiles. Do not advertise 4K60 as newly supported.
4. A machine unable to preserve the requested split must explain the limitation and offer explicit alternatives. Existing shared-encode fallback must not silently turn a requested 4K recording into HD.
5. Stop returns promptly after capture is safe. An app-wide message remains discoverable until MP4 publication finishes: `Recording saved. Preparing MP4…`, then `MP4 ready` with open/reveal actions. The Library remains authoritative on reconnect.
6. Failed export retains the source and gives a useful reason and retry. Successful finalization switches actions to the MP4. Saving/queued/failed/ready states are distinct from capture idle.

## Ordered implementation slices

### S0 — Lock down the failing request contract (P0, small)

**Files:** `hooks/studio-provider.integration.test.ts`, `lib/go-live-output.test.ts`, `lib/capture.test.ts`, backend `youtube.rs` tests; existing fake-provider smoke fixtures.

- Add an integration test through actual Go Live with local 4K, HD YouTube target, and a successful split capability result. Assert the emitted prepare profile equals the **effective target stream** and `session.start` retains 4K recording. The current immediate branch must fail this assertion.
- Add the inverse (HD local, 4K YouTube where topology supports it), target overrides, record-off, mixed providers, and vertical/scheduled cases. Unsupported topology must produce an explicit refusal/choice, not a test that assumes extra encoders exist.
- Extend backend HTTP request tests to assert 1080p low latency and 2160p normal latency. Cover portrait dimensions using the short side. Current 4K requests must fail the new contract assertion.
- Existing fake bind handlers accept combinations Google rejects. Add a profile-aware contract fixture that rejects unsupported 4K latency, clearly labeled as a modeled provider constraint; do not claim the fixture proves Google's particular 403 cause.
- Preserve the incident summary above; keep secrets, raw database rows, recordings and credential-bearing URLs out of fixtures.

**Done:** deterministic failures at the real call sites, independent of live YouTube or a 2-hour session. This is the first implementation checkpoint.

### S1 — Fix YouTube profile and latency preparation (P0, medium)

**Files:** `hooks/use-studio.tsx`, `lib/go-live-output.ts` / `lib/capture.ts`, `youtube.rs`, `main.rs` prepare dispatch, relevant scheduled-stream service paths and protocol mirrors only if needed.

- Resolve one immutable effective per-destination output plan after topology settlement. Use it for immediate OAuth prepare, scheduled prepare, preflight summary, and media start. Do not merely substitute a different global default; target overrides and negotiated fallbacks must survive.
- Replace the immediate prepare's recording-derived horizontal and vertical profiles. Make both scheduled and immediate paths consume the same target resolution/orientation decision.
- Select latency in the backend from the actual YouTube stream profile: normal for 4K; retain low for supported HD. Do not trust UI copy or preset name alone to enforce this.
- Scheduled events: inspect the saved binding/latency before Go Live. A pre-created incompatible event needs an explicit supported reconciliation/error path; do not mutate a live event or erase scheduling metadata silently. Manual-key destinations should explain external latency requirements without pretending Videorc changed YouTube Studio.
- On prepare/bind failure, persist a sanitized attempt record even before a recording session exists: attempt ID, target ID, step, requested/effective profile, latency, HTTP status/reason, lifecycle state if known and rollback outcome. Bound any state inspection and account for API quota.
- Reuse owned-resource rollback and existing partial-start behavior. Do not retry configuration errors indefinitely, delete pre-existing scheduled resources, or restart the other live destinations.
- Use error copy such as `YouTube could not prepare this stream` with the actionable provider detail. Keep resolution mismatch, account failures, quota and transport failures distinguishable.
- Cover rapid Stop while transition is pending: a late completion cannot revive a stopped broadcast or cause a second cleanup operation.

**Done:** all S0 tests pass; a provider failure leaves no new orphaned resources; other destinations and the local recording keep their established isolation. Real-provider proof is completed in S4 before release.

### S2 — Independent quality controls with preserved recording quality (P1, medium)

**Files:** `components/streaming/go-live-panel.tsx`, destination settings components, `components/tabs/recording-tab.tsx`, studio setting actions, `capture.ts`, `go-live-output.ts`, existing persistence/normalization tests.

- Add a visible `Stream quality` control beside the pre-start quality summary, defaulting new configurations to Full HD 1080p30. Expose YouTube 4K30 when eligible; retain platform-safe defaults for mixed providers. Keep per-destination overrides in destination settings and show when a destination differs from the default.
- Keep `Recording quality` separate. Provide a clear existing-preset path for **4K30 at 30000 kbps** rather than only changing width/height on a 6000-kbps custom profile. Preserve intentional custom settings and show them as Custom; do not rewrite all saved configurations during migration.
- Reuse `StreamingSettings.defaultOutputPreset/defaultBitrateKbps` and target `outputPreset/outputBitrateKbps`; avoid a redundant “HD while 4K” boolean with conflicting sources of truth.
- Changing a default does not erase explicit target overrides. Changing a target does not alter recording. Test saving/reload, scene recall and new-session preparation.
- Invalidate stale preflight/prepare results after a profile change. Freeze each starting session's plan, and disable profile editing through prepare/start/live/stop so UI changes cannot race the accepted output request.
- Preserve existing capability negotiation. If split is unsupported, state `This computer cannot record 4K and stream HD together with these settings`, and offer explicit shared-HD or record-only choices. Do not globally regress the Windows low-power Go Live path.
- Use existing shadcn controls, field labels, alerts and badges within the Videorc dense glass layout. No new design system, large setup wizard or unrelated screen redesign.

**Acceptance:** choosing Full HD stream plus 4K recording persists separately; the prepare request, resolved topology, actual media outputs and visible summary agree. A requested 4K local file remains 4K after stream fallback unless the user explicitly selects another outcome.

### S3 — Make long-recording MP4 completion clear and diagnosable (P1, medium)

**Files:** `recording_finalization.rs`, `recording.rs` (`export_mp4_from_mkv_tracked`, publication pipeline), `protocol.rs` and shared TS mirrors if new phase fields are justified, `lib/session-finalization.ts`, `hooks/use-studio.tsx`, `components/tabs/library-tab.tsx`, existing quit/update/recovery tests.

- First reproduce the visible experience with a deliberately slow exporter while the user remains in Studio, navigates to Library, opens/reveals a recording, reconnects and restarts. Determine whether existing Library events refresh correctly before claiming a stale-row bug.
- Build on the registry/events already present. Surface a persistent, session-specific completion item outside Library; reconcile from database state after reconnect, and emit a deduplicated ready notification with final file actions.
- While processing, label any source-file reveal/open explicitly as the saved original; do not present an intermediate MKV as the final promised MP4. Do not block starting the next recording or hide the recoverable source.
- Keep progress honest while queued, encoding audio, doing faststart/publication or committing metadata. Media progress reaching 100% is not publication. If phases are exposed, preserve protocol mirrors and tests; do not manufacture an ETA.
- Instrument queue wait, probe, FFmpeg, sync/publication and metadata commit durations. Capture a bounded, redacted FFmpeg stderr tail (currently discarded by the tracked exporter) so disk-full, permission and mux failures have useful diagnostics.
- Test a stale session-list response racing a finalization event. If reproduced, merge by authoritative update/version or refresh after finalization; do not let a late snapshot permanently replace an MP4-ready row with an old MKV row.
- Reuse failed-export retry, interrupted-job recovery and quit/update waiting. Verify retry is single-flight, a cancelled/deleted job cannot publish late, and MKV cleanup occurs only after safe MP4 publication and metadata commit.
- Measure before optimizing the observed four-minute tail. Keep video stream-copy, all intended audio tracks, tail-trim policy, file ownership/no-clobber publication and MKV recovery semantics. Direct MP4 capture or lossy changes to the archival audio source are out of scope.

**Done:** slow success stays visibly “Preparing MP4” until ready; failure remains recoverable; final open/reveal uses the existing MP4 even though historical `output_path` still names MKV. Real long-file completion is verified in S4.

### S4 — Artifact, provider and endurance acceptance (release gate)

Extend maintained smokes rather than committing personal recordings or one-off probes. Use isolated app profiles, app-owned PIDs and test output directories. A local RTMP sink proves encoding/transport but **does not validate OAuth preparation or YouTube's acceptance**.

| Scenario | Required proof |
| --- | --- |
| HD local + HD YouTube | Prepare advertises HD/low; start, stop and immediate retry succeed. |
| 4K local + HD YouTube | Prepare advertises HD/low; local artifact is 3840×2160; received stream is 1920×1080; local bitrate/profile stays independent. |
| True 4K YouTube | Prepare advertises 2160p/normal; actual received output is 4K; repeated start/stop succeeds. |
| 4K local + HD multistream | All intended destinations are present; one slow/disconnected sink cannot degrade the local recording or leave failed provider state labeled Live. |
| Scheduled + portrait + explicit overrides | Correct target dimensions, frame rate and latency; schedule identity preserved; no recording-derived profile leaks. |
| Split capability unavailable | Explicit limitation/alternative; no silent 4K-to-HD local downgrade; existing supported Windows fallback remains usable. |
| More than 2 hours, then Stop | At least 150 minutes of realistic moving content and audible sync markers; both outputs remain live; local MP4 contains the whole expected timeline with bounded A/V tail and no unbounded queues/RSS. |
| Slow/failing/interrupted export | Progress stays truthful; final publication or recoverable failure occurs; quit/restart and updater coordination retain the source and correct Library state. |

Use existing analyzer thresholds for frame cadence, duplicate PTS, freezes, startup resolution, BT.709/video-range tags, H.264 level, GOP cadence, A/V sync and stop tail. Measure end-to-end sync near start, middle and end; stream/container duration alone is insufficient. Inspect encoder queue age/drop rates throughout the 150-minute run, including the field-observed pressure pattern. Retain small sanitized summaries outside the committed media tree.

Run, at the appropriate slice boundaries:

```sh
pnpm typecheck
pnpm lint
pnpm format:check
pnpm --filter @videorc/desktop test
pnpm test:scripts
cargo fmt --check --all
cargo test -p videorc-backend
cargo clippy -p videorc-backend -- -D warnings
pnpm build
pnpm baseline:stream:split-output-4k-record
pnpm baseline:stream:youtube-4k30
pnpm baseline:stream:youtube-4k30:mixed
pnpm smoke:multistream
pnpm smoke:multistream-endurance
pnpm smoke:app-quit-recording
pnpm smoke:record-latency
pnpm smoke:record-latency:gate
pnpm smoke:recording-matrix
pnpm smoke:recording-studio
pnpm smoke:recording-studio:devices
```

The endurance command must be configured/extended for the 150-minute scenario; its mere default invocation is not proof. Run the applicable preview lifecycle probes if implementation touches lifecycle or native surfaces. Before release, run broader `pnpm smoke:local-gates` and platform gates required by AGENTS.md. If Windows process tests change, run their affected filters 25 times and the Windows Rust suite three times from PowerShell 7.

Perform controlled **unlisted** real-YouTube acceptance in a release-equivalent packaged app after implementation, with the owner available and provider test scope authorized. Compare fresh HD/low and 4K/normal preparation and read back the actual resource settings. If bind still fails, collect the bounded lifecycle evidence and resolve that cause before claiming the incident fixed. Do not publish an unsolicited public stream as part of planning or a default smoke.

## Verification completed during this investigation

- Read-only session/health/log inspection and installed-version check.
- Actual-source request-expression replay reproduced 4K-record/HD-stream preparation mismatch and HD control agreement.
- `ffprobe` inspected both the 4K short recording and the long HD MP4; no media was modified.
- Public channel inspection confirmed the successful 2:08 broadcast.
- These existing Node test files passed on the inspected release source: `youtube-4k-stream-gate.test.mjs`, `split-output-4k-record-gate.test.mjs`, `final-recording-path.test.mjs`. They validate evidence evaluators/path selection, not real-provider setup or a long-running session.
- Full device/recording smokes, new regression tests and real-provider reproduction remain implementation acceptance work. No application code changed in this planning task.

## Delivery order and remaining uncertainty

Ship S0/S1 as the urgent focused fix once request tests and real-provider acceptance pass; S2 can then expose the already supported split clearly. S3 can proceed independently after its visible-state reproduction. S4 is required for the combined quality/finalization release.

Remaining questions are evidence checks, not reasons to defer the established fixes: the exact Google broadcast state at each failed bind; where the owner saw MKV; which export phase consumed the four minutes; and which stream destination or scheduling pressure produced the long session's queue drops. Capture these explicitly rather than turning assumptions into diagnoses.
