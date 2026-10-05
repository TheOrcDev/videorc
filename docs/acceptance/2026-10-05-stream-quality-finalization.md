# YouTube output quality and MP4 finalization — 2026-10-05

Implementation of [Plan 153](../../plans/153-youtube-4k-startup-split-quality-and-mp4-finalization.md), originally investigated as Plan 152. Baseline: `5fb14b33`. Branch: `fix/152-stream-quality-finalization`. This is an implementation/acceptance record, not a release approval.

## Changes

- Provider preparation resolves the effective target stream profile after topology settlement. Immediate and scheduled YouTube preparation share that resolution/orientation rule. Prepared settings carry through media start, partial continuation and start retry without renegotiating the provider profile.
- YouTube uses normal latency for 2160p (short side, including portrait); HD keeps low latency. Scheduled 4K events with incompatible or unconfirmed latency stop before creating ingest and explain how to correct the upcoming event in YouTube Studio.
- Preparation attempts persist sanitized profile, target, latency and failure-stage evidence before a recording session exists. Cleanup deletes only resources created by the failed immediate attempt, accounts for stream-delete quota, and records rollback outcomes.
- Livestream has its own quality selector and per-destination overrides. Recording controls remain separate; resolution buttons move standard recording bitrates with resolution while preserving custom bitrates. A rejected split encoder cannot silently turn the requested 4K recording into HD. Controls freeze during preparation and partial confirmation.
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
| Desktop tests | PASS: 307 files, 3342 tests; 1 existing skipped test |
| Node logic/analyzer/A/V tests | PASS: 1936 tests |
| Production build | PASS |
| JS and Rust dependency audits | PASS |
| Focused profile/race tests | PASS: independent HD, record-off, true 4K, stale Library completion |
| Lint / format | In progress |
| Rust suite / clippy / format | In progress |
| Real-app recording/device/latency/matrix/quota gates | In progress |
| Split-output / provider / 150-minute acceptance | In progress |

The split multistream endurance harness now supports `VIDEORC_SMOKE_SPLIT_4K=1`: local 3840×2160/30 at 30000 kbps, HD 1920×1080 destinations, periodic diagnostics, strict dimensions and MP4 completion checks. Its synthetic stress source is not a substitute for the real-source flash/click A/V baseline or live YouTube acceptance.

Real-source long acceptance uses the maintained `stream-av-sync-baseline.mjs --gate --skip-record-only --require-split-output-4k-record` with `VIDEORC_BASELINE_RECORDING_MS=9000000`. Provider acceptance requires two owner-approved unlisted tests: HD stream + 4K local, then true 4K/normal latency. Neither a loopback sink nor a mock proves Google acceptance.
