# YouTube output quality and MP4 finalization — 2026-10-05

Implementation of [Plan 153](../../plans/153-youtube-4k-startup-split-quality-and-mp4-finalization.md), originally investigated as Plan 152. Baseline: `5fb14b33`. Branch: `fix/152-stream-quality-finalization`. This is an implementation/acceptance record, not a release approval.

## Changes

- Provider preparation resolves the effective target stream profile after topology settlement. Immediate and scheduled YouTube preparation share that resolution/orientation rule. Prepared settings carry through media start, partial continuation and start retry without renegotiating the provider profile.
- YouTube uses normal latency for 2160p (short side, including portrait); HD keeps low latency. Scheduled 4K events with incompatible or unconfirmed latency stop before creating ingest and explain how to correct the upcoming event in YouTube Studio.
- Preparation attempts persist sanitized profile, target, latency and failure-stage evidence before a recording session exists. Cleanup deletes only resources created by the failed immediate attempt, accounts for stream-delete quota, and records rollback outcomes.
- Livestream has its own quality selector and per-destination overrides. Recording controls remain separate; resolution buttons move standard recording bitrates with resolution while preserving custom bitrates. A rejected split encoder cannot silently turn the requested 4K recording into HD. Controls freeze during preparation and partial confirmation.
- Portrait dimensions survive settings normalization. The vertical simulcast encoder resolves its own common stream profile instead of inheriting recording quality. Combinations requiring a third encoder are refused before provider preparation. A recording-only horizontal primary is no longer mistaken for a true 4K stream by backend validation.
- Background MP4 saving has persistent progress and ready/retry actions outside Library. Reconnect reconciles pending notices with database rows. Source reveal is labeled as the original while MP4 is saving. A request-scoped event journal protects Library snapshots from newer finalization events.
- Export diagnostics measure queue, probe, FFmpeg, file sync, publication and metadata commit. FFmpeg stderr is drained concurrently with a bounded, redacted tail. Capture remains MKV; video remains stream-copy; existing durability, ownership, recovery and quit behavior remains in place.

## Deterministic reproduction

Before the fixes, two actual StudioProvider cases (record enabled/disabled) advertised 3840×2160 at 30000 kbps to YouTube despite the effective HD stream. The backend HTTP request test sent `low` for 2160p instead of `normal`. Those tests failed before the corresponding fixes.

The provider fixture models YouTube's documented 4K/normal-latency constraint. It does not prove the exact cause of the owner's `liveBroadcastBindingNotAllowed` responses. The original long recording was already a valid MP4 four minutes after Stop; no personal recording was modified.

## Validation

Local evidence is under `/tmp/videorc-152-evidence`; recordings, credentials and raw app data are excluded from this PR.

| Check | Result |
| --- | --- |
| TypeScript typecheck | PASS |
| Desktop tests | PASS: 307 files, 3349 tests; 1 existing skipped test |
| Node logic/analyzer/A/V tests | PASS: 1936 tests |
| Production build | PASS |
| JS and Rust dependency audits | PASS |
| Focused profile/race tests | PASS: independent HD, record-off, true 4K, stale Library completion |
| Lint / format | PASS; one pre-existing `captureConfig` hook dependency warning |
| Rust suite / clippy / format | PASS: 3209 tests, 13 ignored; includes the vertical follow-up regression |
| Recording matrix | PASS: 18/18 combinations, including hard-content 4K30/1080p60 and transient FIFO pressure |
| YouTube quota drill | PASS against the local fake provider; initial launch timed out during a competing rebuild, warm rerun passed |
| Recording/device/latency gates | Focused artifact, device, native preview, layout, shutdown and latency checks PASS; aggregate studio command not green (see reruns and remaining system-audio failure below) |
| Multistream | PASS: three healthy RTMP targets, failed leg isolated, local MP4 analyzed |
| System audio | FAIL on two runs: unwanted 1 kHz energy in on/self-exclusion/record+stream cases; off and toggle cases PASS |
| Horizontal and vertical split stress | PASS: HD stream, 4K local recording, network/FFmpeg stalls, final MP4 artifacts |
| Live provider acceptance | Deferred: owner requested local testing only |
| Real-source / 150-minute 4K acceptance | BLOCKED before encoding: selected ScreenCaptureKit display is 3024×1964; gate requires a native source at least 3840×2160 |

The split multistream endurance harness now supports `VIDEORC_SMOKE_SPLIT_4K=1`: local 3840×2160/30 at 30000 kbps, HD 1920×1080 destinations, periodic diagnostics, strict dimensions and MP4 completion checks. Its synthetic stress source is not a substitute for the real-source flash/click A/V baseline or live YouTube acceptance.

### Completed media evidence and reproduced follow-up defects

- Horizontal split stress passed both maintained scenarios with 4K local recording and three HD RTMP sinks: repeated four-second network stalls plus a short FFmpeg freeze, then a six-second FFmpeg freeze. Both recordings finalized as valid MP4 with the required dimensions, color tags, H.264 level and bounded A/V tail. One sampled diagnostic reported 30.449 capture fps, 214 MB backend RSS and zero recording drops. This short synthetic sample does not establish sustained real-source performance.
- Background publication measurements from those two sessions: queue 0 ms; probe 149/219 ms; FFmpeg 185/203 ms; file sync 6/6 ms; publication 15/16 ms; metadata 36/37 ms. These short files do not predict a two-hour file's export time.
- The recording-studio/device gate passed the recording/audio tests, all-layout artifact smoke, imported screen recording, slow app-quit finalization (31-second hold), five record-latency cycles with artifact checks, live-layout artifacts, and preview liveness/scene/pump/click probes. It stopped at a preview-interaction command timeout. The focused preview-interaction rerun passed (41 rapid interactions, zero dropped samples, maximum stall 25 ms).
- Three portrait persistence tests reproduced axis-clamping corruption before the normalization fix. Actual StudioProvider coverage reproduced HD vertical preparation paired with a 4K vertical media encoder; the stream profile resolver now keeps those requests aligned.
- The real vertical split smoke then reproduced a separate backend rejection: `True 4K streaming requires the YouTube 4K30 stream profile`. A regression test reproduced the same failure with a recording-only 4K primary and an HD vertical auxiliary stream. After the fix, `VIDEORC_SMOKE_SPLIT_4K_VERTICAL=1` passed both stress scenarios: received 1080×1920 stream, preserved 3840×2160 recording, successful analyzed MP4 finalization.
- The final-source recording-studio/device rerun again passed all-layout artifacts, slow shutdown, enforced Record/Stop latency, microphone stall survival and dual-orientation stream overlays. It stopped at the Comments clipboard assertion (`copied=false`); the focused Comments rerun passed. Remaining steps ran individually: scene/pump/click, interaction stress, window placement, native reattach, real ScreenCaptureKit recording, Notes invisibility, real-device interaction artifacts, real live layout switching and source-complete native preview all passed. The lifecycle probe lost its main window at cycle 18; its isolated rerun passed 100 cycles with clean teardown. These reruns do not turn either failed aggregate invocation into a green result.
- System-audio acceptance remains unresolved: both the first pass and isolated rerun failed on/self-exclusion/record+stream checks. The second run measured the renderer-window 1 kHz band at −33.1 dBFS against a below −50 dBFS limit, plus extra tone regions outside the intended stimulus. Off and both live toggles passed. No causal link to this change or external-audio contamination has been established; do not dismiss the failures as environmental. Audio capture/exclusion code was not changed in this PR.
- A 60-second real-source split-output prerequisite run stopped before encoding because the only selected display is 3024×1964. The maintained gate requires an actual 4K source, so neither upscaling this screen nor running the synthetic stress source for 150 minutes would satisfy the plan. The same source prerequisite blocks native-source true-4K and mixed-4K A/V baselines. Long-run drift, real-content sustained performance, and a new two-hour MP4 publication remain release acceptance work on a suitable display.

## Handoff and release blockers

The implementation is in draft PR [#616](https://github.com/TheOrcDev/videorc/pull/616). S0–S3 are implemented; S4 is only partially verified. Before release, resolve the system-audio failures, complete native-source 4K and 150-minute acceptance on a suitable display, obtain fresh authorization for real YouTube testing, and finish platform CI. No release or live provider broadcast was performed.

CI exposed a platform assumption in the new vertical regression test: Linux correctly refuses to start a split without an encoded bridge. The test now verifies profile preservation on every platform and the supported/refused start contract per platform. Several other CI jobs were cancelled without acquiring a hosted runner (no test steps ran); the final push retriggers them.

Shadscan task baseline/floor: 37/37. Pre-commit checks for `fb0efca1` and `1e5cd8ad` both scored 37 using `pnpm dlx @shadscan/cli@next --json` from `apps/desktop`.

Real-source long acceptance uses the maintained `stream-av-sync-baseline.mjs --gate --skip-record-only --require-split-output-4k-record` with `VIDEORC_BASELINE_RECORDING_MS=9000000`. **The owner requested local tests only on 2026-10-05.** No live YouTube test is authorized or performed in this execution. Provider acceptance remains a separate release check: HD stream + 4K local, then true 4K/normal latency. Neither a loopback sink nor a mock proves Google acceptance.
