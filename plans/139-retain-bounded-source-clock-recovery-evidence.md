# Plan 139: Retain bounded source-clock recovery evidence

> **Executor instructions**: Follow the steps and preserve every original failure. Root maintains the index. This plan improves attribution of a failed required Windows gate; it does not authorize a speculative production audio fix.
>
> **Drift check**: `git diff --stat 26b296add983f9badd3724f2d7e1dcdb46c141f5..HEAD -- crates/videorc-backend/src/session_audio.rs`. Compare changed code before proceeding. Use an isolated worktree and preserve existing user changes.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: [126](126-diagnose-windows-audio-mixer-stability-failures.md)
- **Category**: tests
- **Planned at**: `26b296add983f9badd3724f2d7e1dcdb46c141f5`, 2026-10-04
- **State**: Test-only diagnostic merged in PR 593 (`f0fa05bc`); original source-clock failure remains unassigned.

## Why this matters

The required Windows source stability gate fails on pass 22 at `a_source_clock_jump_re_anchors_and_recovers_without_retiring`. Its recovery window contains 480 zero frames where the unchanged assertion requires 96,000 correctly placed frames. The existing diagnostic preserves counters and extrema but discards individual delivery and completed-write timelines, so it cannot correlate this gap with a particular delivery or placement transition. Capture that bounded evidence before choosing a repair.

## Current state

- Actual Windows job `111388490245`, run `37186191998`, reviewed source `5e87566109eb7593d734ded8442bab5e59c669c6`, fails `session_audio` on stability pass 22: 67 pass, 1 fail. Downstream full-suite and static/audit steps are unexecuted. Prior successful runs do not close this failure.
- Raw private evidence: `/tmp/videorc-fix138-windows-source-job-111388490245-20261004/windows-source-job-111388490245.raw.log`, SHA-256 `cc5308abf73f6374796a7eb89b89841189535e4d4c14812e2b82d439a02bd24f`, 45,631,730 bytes. Failure context is lines 657678–657700. Do not commit this log or generated media.
- `crates/videorc-backend/src/session_audio.rs:7945` owns the case. It adds 5,000,000 microseconds to microphone packet timestamps after packet 200, uses the original 50 ms playout, inspects `[288000,384000)`, and requires exactly 96,000 frames at 0.2. The actual assertion at line 7986 sees 95,520.
- The recorded window has 480 zero frames in each channel, no missing frames or altered nonzero samples, microphone overlap delta 480, and zero stale-written frames. Whole-producer maximum send lateness is 58,072 microseconds; maximum bus lateness is 46,276 microseconds. These extrema do not locate the individual late delivery or establish the gap's cause.
- The whole file and exact failing case are unchanged across reviewed source 126, 137 and 138. Source 138 changes a JavaScript receipt helper and its tests, not this mixer.
- `MixTestObservation` at line 2470 currently retains summaries. `delivered` records counts and maxima; `completed` records first/last/window snapshots. `value` explicitly reports `individualChunkTimelineRetained: false` and `individualDeliveryTimelineRetained: false`.
- `timed_source_observed` at line 7124 uses the real producer channel, original packet pacing, and existing owner cleanup. Its delivery hook runs after sending. Preserve those operations and identify the observed timestamp's boundary accurately.
- `signal_packets` at lines 7547–7573 keeps `captured_at` in the original wall-clock frame domain. This fixture changes only `timestamp_micros` by five seconds. Select delivery records by `captured_at`/intended end-frame, and retain the numeric device timestamp separately; selecting by the jumped device timestamp would record the wrong window.
- The delivery hook samples its instant after `sender.send` and before taking the observation lock. It is a post-send observation, not an ingestion or placement acknowledgement. The completed-write hook at line 4871 runs after writing, tap/accounting and status publication; it is a publication checkpoint, not a physical FIFO-return timestamp.
- `report_mix_evidence` at line 7803 runs after `bus.finish()` and never changes acceptance. Follow this convention. Preserve lock order `AudioShared -> observation`; producer observation must not acquire `AudioShared`.

## Scope

**In scope:** `crates/videorc-backend/src/session_audio.rs`, limited to `#[cfg(test)]` observation types, existing observation hooks, collector tests, and an opt-in configuration for the existing source-clock recovery fixture. Documentation under `plans/` may record actual results.

**Out of scope:** production timeline placement, source retirement, playout delay, capture/mixer scheduling, FIFO transport, readiness/cleanup handshakes, assertions, sleeps, test tolerances, encoder/container code, and changes to Windows workflows merely to obtain a green rerun. Do not relax the 96,000-frame assertion or convert a failure to a skip.

## Commands you will need

| Purpose | Command | Expected result |
| --- | --- | --- |
| Format | `cargo fmt --check --all` | Exit 0 |
| Focused mixer tests | `cargo test -p videorc-backend session_audio::mix_tests -- --nocapture` | All original assertions pass; actual bounded diagnostics retained privately |
| Full Rust suite | `cargo test -p videorc-backend` | Exit 0; record actual pass/ignore counts |
| Rust lint | `cargo clippy -p videorc-backend -- -D warnings` | Exit 0 on macOS |
| Recording regression | `pnpm smoke:recording-studio` | Exit 0 after all fixes, or retain the exact independently proven blocker |

The Windows workflow already runs every affected Rust filter 25 times and the full Rust suite three times through PowerShell 7. Inspect the exact job checkout/tree and raw per-case results; metadata success alone is insufficient.

## Git workflow

Use an isolated `codex/` branch. A separate executor prepares the complete diff and meaningful focused evidence for root review. After review and required focused gates, commit the logical diagnostic fix and push it to main through the normal protected PR workflow. Immediate complete-worktree Shadscan must meet the established score floor of 37. Do not publish private logs, tokens, recordings, or app data.

## Steps

### 1. Freeze the failure and observation boundary

Verify the raw hash, checked-out tree, assertion and diagnostic fields above. Preserve earlier Windows failures and successes as distinct cohorts. Locate the existing completed-write and delivery hooks and state which timestamp/counter boundaries they observe. If finer placement evidence needs a production-path change, stop and propose the exact separate change before implementing it.

**Verify:** compare the frozen source with the live in-scope file and parse the actual failed record; the 480-frame deficit and overlap delta must remain recorded without causal attribution.

### 2. Add opt-in bounded test evidence

Keep normal observation unchanged. For this fixture only, retain numeric and fixed-enum delivery records intersecting its original sample window, and completed-write snapshots intersecting that window, including necessary boundary records. Retain at most 256 delivery and 256 write records; count every omitted record and report incomplete coverage explicitly. Preserve before/after cursor and loss counters rather than implying that a chunk counter delta identifies a particular sample. Derive bounded zero-frame ranges from the finished original PCM window, with a maximum of 64 ranges and an omission count. Do not retain PCM, device names, paths, or arbitrary text in the new trace. Bound the emitted diagnostic and never replace an original result with a trace success.

Use the actual capture-end frame to select delivery records, retaining the raw numeric device timestamp independently. Label sampled post-send/publication instants by those boundaries; do not claim an enqueue/ingest acknowledgement or FIFO-return time. Preserve the preceding completed-after snapshot in the first intersecting write record, alongside its current before/after snapshots: microphone ingestion at line 4279 precedes `mix_before` at line 4626, so current before→after alone omits loss changes between writes. The existing collector's `preceding = self.last.unwrap_or(before)` establishes this boundary without a production placement hook.

Use an optional typed trace defaulting to `None`, configured and reserved before `start_bus_observed` launches workers. The 256-record caps include boundary records across both roles together; the 64 zero-range cap covers both channels together. Distinguish excluded records from omitted eligible records and an unavailable predecessor from an observed one. Preserve each producer's and the writer's order without claiming observation-lock acquisition creates a global causal order. Derive zero ranges from borrowed finished samples; unavailable PCM is missing data, never zero-filled evidence.

**Verify:** focused collector controls distinguish two different delivery times and write boundaries, preserve ordering and exact integer fields, prove caps/omission accounting, handle absent or partial windows, and preserve default non-retention. They must prove behavior, not only the existence of new JSON keys. Keep production behavior outside `#[cfg(test)]` byte-equivalent in purpose and operation.

Specifically cover deliveries with equal aggregate maximum lateness but different packet/time associations, a loss increment between the predecessor and current `before` snapshot, exact-cap/cap-plus-one and predecessor/successor intersections, and zero ranges that distinguish channels, merge contiguous samples, close at the window end and count overflow. Prove exact numeric serialization and the emitted size bound.

### 3. Run and inspect actual Windows evidence

Run the unchanged affected filter 25 times and full Windows Rust suite three times through the existing PowerShell 7 gate after the reviewed diagnostic is merged. Retain complete per-case counts and all failures; do not stop at a green retry. Correlate a reproduced zero range with the actual retained delivery/write boundaries. If only summaries or successful runs are available, explicitly leave the original failure unassigned.

**Verify:** exact source/checkout correspondence, raw log hash, all required repetitions and complete diagnostics. A failed or truncated run cannot count as completed stability evidence.

### 4. Choose a repair only from attributable evidence

If the trace proves a concrete fixture or production defect, write its minimal repair plan immediately, obtain a deterministic meaningful regression, and execute the reviewed fix. Preserve the original output, thresholds and cleanup. If attribution remains unavailable, document that limit and keep this acceptance item open.

## Done criteria

- [ ] Original Windows failure and prior cohorts remain retained.
- [ ] New evidence is test-only, opt-in, bounded, ordered and explicitly reports omissions.
- [ ] Meaningful collector controls and focused/full Rust checks pass.
- [ ] The separate logical fix is committed and pushed to main through the normal PR workflow after review.
- [ ] All 25 affected Windows repetitions and three full Windows Rust runs are actually inspected, including failures/skips/ignores.
- [ ] Original source-clock recovery failure has an attributable repair and passing unchanged acceptance, or remains explicitly open with the precise missing evidence.
- [ ] Final recording-studio acceptance is run after all fixes; no aggregate PASS is inferred from a narrow diagnostic.
- [ ] Index status reflects actual progress.

## STOP conditions

Stop and report if source hashes drift, the original failure fields cannot be verified, trace collection changes production timing/control flow or lock order, a record cap silently drops data, the required fix needs an out-of-scope path, or Windows output lacks source provenance. A later green run does not permit deleting or reclassifying the pass-22 failure.

## Maintenance notes

Keep observation separate from acceptance. Timestamp ordering, counter boundaries, omissions and instrumentation overhead must remain visible. This plan does not resolve the distinct physical Windows recording-tail/freeze incident, the macOS system-audio gap, or the original source-ownership failure.

## Continuation evidence — 2026-10-04

PR 593 implements the bounded test-only diagnostic. Its Windows run `37191256736`, source job `111403746795`, fails on repetition 13 at a different existing FIFO case, `a_bursty_fifo_reader_never_drops_small_microphone_callbacks` (77 pass / 1 fail; captured 12,000, generated 20,640, discarded 11,296, dropped 0). The original source-clock case passes in this cohort, so its successful captured stdout does not provide a reproduced failure trace. Preserve both failure cohorts.

Current main `b3771763` completes Windows source job `111443059302`, run `37204593882`: all 26 Rust ownership filters run 25 times, and three full backend runs each pass 2,899 cases / 13 existing ignored cases plus one integration test. The affected Node caller cases each run 25 times; the full Node suite passes 1,910 / 10 existing skips. Complete raw logs are retained outside Git: failed diagnostic cohort SHA-256 `f67fa2a22686258fc6c40786b24f95eac51f25705794942a30a38fb9c0882915`, 74,368,276 bytes; current source SHA-256 `edc7f3ce00bc82d6521b5d84f25a556f5a0ff275406933eb20cd1afee9c38f83`, 93,884,150 bytes. The successful current run does not attribute or erase the earlier failures.

A fresh local 49-case mixer run passes and retains complete bounded source-clock delivery/write evidence with zero omissions, missing frames, changed samples, or zeros in the original window. Its post-send and post-publication timestamps remain observations, not a global causal ordering. Final local acceptance separately fails the expanded recording matrix (Plans 140/141); recording-studio acceptance remains incomplete.


The original pass-22 failure log is re-downloaded intact to `windows-original-clock-failure.log` in the durable private evidence directory: exactly 45,631,730 bytes and SHA-256 `cc5308abf73f6374796a7eb89b89841189535e4d4c14812e2b82d439a02bd24f`, matching the frozen original record. No earlier failure depends solely on the vanished temporary checkout.
