# Plan 106: Resolve audible PCM in the live source-loss silence gate

> Diagnosis-first fix plan, reconciled with offline topology evidence below. Planned at `05ff9188`, 2026-10-03, release 0.9.129. Drift check: `git diff --stat 05ff9188..HEAD -- scripts/smoke-live-source-switch-app.mjs scripts/lib/live-source-switch-gates.mjs crates/videorc-backend/src/session_audio.rs crates/videorc-backend/src/recording.rs crates/videorc-backend/src/live_source_switch.rs`.

Implementation should start from release 0.9.129 (`05ff9188`) or newer main in an isolated worktree. Preserve the original checkout's existing user changes, and perform the drift check before editing.

- Priority: P1
- Effort: M
- Risk: MED; distinguish real audio leakage from incorrect artifact time mapping
- Depends on: none
- Category: bug / tests / audio
- Confidence: HIGH that the maintained gate fails; analyzer topology cause reproduced offline during execution

## Observed failure

`pnpm smoke:live-source-switch` passed its recording leg but failed its stream leg with `received/source-loss: Intentional silence contains audible source PCM.` The stream was received by a local RTMP listener and decoded; this is final-artifact evidence, not playback judgment.

Evidence: `/tmp/videorc-qa-evidence-20261003/05-smoke-live-source-switch/artifacts/stream/live-source-switch-evidence.json` and adjacent `received.flv` (temporary, do not commit).

- Loss cursor: sample 119,520 at 48 kHz, generation 1.
- Stream timeline advance used by the analyzer: 130 ms.
- Measured silence window: 2.610–3.110 seconds.
- RMS: 0.03480737, above the maintained 0.005 silence ceiling; 440 Hz amplitude 0.01428678.
- Other microphone identity windows and explicit None windows passed; None windows measured zero RMS. One encoder and monotonic DTS checks passed.

This could be residual queued source audio, a delayed authoritative loss boundary, or an analyzer timeline mistake. Do not label it a sustained microphone leak without locating the boundary.

A second decode of the same artifact found the old tone above the 0.005 RMS ceiling through approximately 2.660 seconds (20 ms windows); 2.750–3.500 seconds were silent before replacement audio appeared. The failing 2.610-second measurement therefore straddles a short transition tail. This narrows the investigation to loss acknowledgement, queued audio and timeline alignment; it does not prove persistent capture after loss.

Three fresh isolated stream repetitions all failed the same source-loss assertion: RMS 0.03122783, 0.03824577 and 0.03477911 (ceiling 0.005), at 2.650/2.610/2.610-second window starts. Their initial and explicit None silence windows remained zero. Evidence: `/tmp/videorc-qa-evidence-extra-20261003/{13,14,15}/artifacts/live-source-switch-evidence.json`. A fresh combined record+stream run passed both local and received loss windows with zero RMS (`16/artifacts/live-source-switch-evidence.json`); its local profile is 640×360 while isolated stream output is 1920×1080. Preserve this mode/profile difference as an investigation lead. The repetition establishes stream-only repeatability, not the responsible clock/queue owner.

## Current state and reproduction

`scripts/smoke-live-source-switch-app.mjs` disconnects the real fixture producer via the debug audio seam, waits for microphone health=unavailable, records `snapshot.audio.sampleCursor`, tries a missing replacement, and allows a silence window before replacement B. Around lines 318–340 it maps the cursor using the stream advance plus a 250 ms codec exclusion window. `scripts/lib/live-source-switch-gates.mjs::measureSourceWindow` decodes 500 ms of PCM; `evaluateSourceIdentity` rejects silence RMS above 0.005.

Repeat the focused maintained path with `VIDEORC_SOURCE_SWITCH_MODE=stream VIDEORC_SMOKE_OUTPUT_DIR=/tmp/videorc-source-loss-repeat pnpm smoke:live-source-switch`. Use distinct output roots for repeats and record every result. Run combined and record legs after diagnosis. All servers/destinations must remain local; use the existing app-owned process ledger for teardown.

## Scope and ordered work

### Execution reconciliation — offline evidence, 2026-10-03

The original failed artifacts establish a topology-dependent analyzer error. Offline replay (no app launched) decoded all switch edges and packet PTS. For the original stream-only artifact, bus cuts at 1.450/3.660/4.830/6.000/7.170 seconds appear at 1.460/3.670/4.860/6.010/7.200 decoded seconds, consistent with neutral mapping plus AAC transition. The three failed repeat artifacts have the same neutral mapping (10–30 ms difference); none has the assumed −130 ms stream shift. All three source-loss windows at `lossCursor / 48000 + 0.250` have zero RMS with the existing 0.005 ceiling. The combined run's received cuts actually appear about 120 ms before the bus cursor, so its −130 ms mapping is correct. Evidence: `/tmp/videorc-source-loss-offline-diagnosis-20261003.json`; media remains outside the tree.

Source confirmation: `bridge_compositor_ffmpeg_args_with_encoder` passes `advance_audio: false` to `append_bridge_copy_flv_output` for copy fanout, including stream-only. `bridge_compositor_split_output_ffmpeg_args` passes true for auxiliary/split stream legs. The smoke currently subtracts the global 130 ms constant for **every** received leg. It therefore samples valid transition audio too early only in neutral copy-fanout mode. The valid loss tail ends within the unchanged 250 ms exclusion when mapped correctly.

Implementation now targets actual per-leg output timing ownership rather than production audio changes. Add a maintained, non-sensitive way for the smoke to obtain the applied audio shift from the actual output topology/arguments, with a failing-before neutral-vs-advanced regression. Do not infer shift from "received" or merely from record+stream flags; topology can differ. Include neutral stream-only, advanced split, local recording, and missing/ambiguous mapping rejection. Scope may include a minimal debug-only timing projection at the existing backend audio debug seam if necessary, explicitly preserving protocol security and excluding URLs/keys/paths. Preserve the full 250 ms codec exclusion and 0.005 ceiling. Offline edge evidence is diagnosis; the three fresh stream repetitions and full real-app gates still run at batch end.

In scope: the existing source-switch smoke/analyzer, relevant producer-loss/cursor handling in `session_audio.rs`, stream audio time mapping in `recording.rs`, and minimal source-switch status ownership if indicated by evidence. Out of scope: general audio gain/mute UI, new encoders, real-provider broadcasting, and changing thresholds without an artifact-level justification.

1. Minimize and repeat the failure. Inspect short decoded PCM windows around loss and record producer close, final accepted input sample, bus render cursor, FIFO/mux timestamp and receiver timestamp. Keep diagnostics in maintained seams or temporary files outside the tree. Verify the same source identity and exact transition can be located in the final artifact.
2. State a falsifiable cause. If buffered frames are valid pre-loss captured audio, establish the authoritative output boundary before measuring intentional silence. If post-loss frames are stale/incorrect, retire the owner and replace only the invalid range with silence, preserving valid queued speech. If mapping is wrong, pin actual receiver/audio PTS instead of adding a guessed delay. Add a regression that fails for the demonstrated cause.
3. Fix only the identified boundary. Keep the 0.005 ceiling and bounded codec exclusion unless measurements prove those contracts wrong. Run focused session-audio/source-switch tests, then record, stream and combined maintained legs. Verify A/V timing and all final artifacts.

## Done criteria and verification

- [x] Root cause is documented with sample/PTS-aligned evidence and a failing-before regression.
- [x] Source loss produces intentional silence at the acknowledged output boundary; replacements and explicit None retain their correct identities.
- [x] At least three focused stream runs and the complete `pnpm smoke:live-source-switch` pass.
- [ ] `pnpm test:scripts`, backend tests/fmt/clippy, `pnpm smoke:recording-studio`, `pnpm smoke:record-latency:gate`, and final-artifact A/V analysis pass.
- [x] No thresholds or measured windows were broadened merely to turn the gate green.

## STOP and maintenance

Stop if the test cannot establish a bounded receiver timeline or producer-loss boundary; report an evidence-gap fix before modifying audio behavior. Future latency/delay changes must update sample-to-artifact mapping with actual packet evidence.

## Fresh execution drift review

At merged main `fd0f31aa1712e834bb2a15e39b2511869acfcdaa`, the scoped drift from `05ff9188` is limited to Plan 109's explicit visual selection transaction in `live_source_switch.rs`, Plan 103's test constructor visibility default, and Plan 097's exact caption retirement ID in `recording.rs`. The source-switch smoke, PCM analyzer, session-audio producer and output argument builders are unchanged. Preserve these merged repairs. The copy-fanout calls still pass `advance_audio: false`, while split calls pass true; the smoke still reads the global constant and shifts every received leg.

The timing projection must represent the settings/arguments actually applied to each output, including offset clamping and any bus-input offset, rather than recomputing topology from recording/streaming flags. Keep its owner and logical output identity bounded; publish only timing evidence through an existing authenticated debug seam. Do not retain/project argument vectors, URLs, keys or file paths. Refuse absent or ambiguous per-leg evidence instead of assuming zero or 130 ms. Document the concrete projection owner before a broader protocol/state change; no PCM, producer, encoder or capture ordering changes are supported by this diagnosis.

## Approved concrete diagnostic owner

Inspect final FFmpeg arguments transiently immediately after the existing output builder returns. Retain only a debug-only bounded projection on that exact `ActiveRecording`, fenced by its session ID and PID, and return it with the existing authenticated `audio.test.disconnect` result. No new RPC, event, LAN route, public protocol field, argument retention, target ID, URL, key or file path is approved. A reduced leg carries logical local/stream role, numeric output ordinal, bus-input timestamp offset and applied audio-filter shift in milliseconds. Bound both inspected argument work and retained legs explicitly.

Validate the exact native-bus input, one unambiguous audio map per output, emitted atrim/asetpts/adelay chain, actual clamping and output boundaries. Optional evidence parsing must never reject or alter a real recording start; unsupported shapes produce absent evidence and the smoke refuses them. For nonzero input offsets, prove composition with the actual filter chain or explicitly refuse the unsupported mapping rather than adding offsets speculatively. Cover actual record, neutral copy-fanout (including same-profile combined), advanced split, missing/ambiguous shape and session/PID refusal at the real debug response seam. Approved files include private recording constructors/diagnostic owner in `recording.rs`, the existing debug seam/tests in `main.rs`, and the maintained Node helper/tests/smoke. No producer, PCM, native capture, encoder behavior or scheduling changes are supported.

The executor independently reran the actual run 14 received artifact against the unchanged maintained PCM gate and current 130 ms mapping: sample 119,520 maps to 2.610 seconds, RMS 0.0382457659, and the expected-silence assertion exits 1. Log: `/tmp/videorc-fix106-exec-offline-red.log`. No app was launched. Retain this RED evidence alongside the earlier packet/edge diagnosis and new focused regressions.

Root independently decoded that same run 14 received artifact with the maintained analyzer: the old 2.610-second window has RMS 0.03824576589777041 and 440 Hz amplitude 0.01724801963317398; the neutral 2.740-second window has zero RMS and marker amplitudes. The old expected-silence assertion exits 1, while the corrected window passes the unchanged 0.005 ceiling and 500 ms measurement. Log: `/tmp/videorc-fix106-root-offline-red-corrected.log`. An earlier root attempt failed with `ENOBUFS` while loading Git source text and is instrumentation failure, not RED evidence. These artifact replays do not establish fresh runtime ownership or final app acceptance.

## Implementation and focused verification

Source `e33c20302a14069512a1929cbce6bd475df5cab8`, [PR 560](https://github.com/TheOrcDev/videorc/pull/560), is merged to main `ffa834583dc5b37de247e3d6119506cfb5221036`. Final arguments are inspected transiently within 1,024 arguments, 256 KiB and eight output legs. The private debug-only recording owner retains only role, output ordinal and proven applied timing. Unsupported timestamp shifts, unknown positional/output options, ambiguous bus/map/filter evidence and unsupported chains produce absent evidence without changing startup. The existing admin disconnect returns timing fenced to its exact session and PID; the smoke refuses absent or ambiguous ownership. No producer, PCM, encoder, timing threshold, public protocol or LAN behavior changed.

Root reviewed the entire five-file diff and independently reran **34 unique Rust cases** (20 actual audio/builder cases, including three new timing regressions; 12 source-switch cases; one real lost-owner case; one actual debug RPC owner case), **eight Node analyzer cases** and **10 desktop permission cases**. Rust format, direct script format, all three syntax checks and diff checks pass. Shadscan remains 37 immediately before commit. Logs: `/tmp/videorc-fix106-root-{timing,system-audio,source-switch,loss-owner,debug-rpc,node,security,rust-format-final,direct-format}.log`.

The executor's additional offline reference replay passes 30 artifact windows with monotonic DTS and zero RMS in all five loss windows. It is historical artifact diagnosis, not fresh app acceptance. An intermediate debug test expected the wrong existing denial code (`admin-only` instead of `forbidden-method`); its stale compiled assertion failure is preserved separately and is not RED evidence or a production bug. The corrected actual debug-response test passes. Three fresh stream repetitions, all maintained modes, final artifact A/V analysis and the full broad/recording-studio/latency gates remain pending until batch end.


## Final fresh source-switch artifacts — merged main 6f9995eb

The maintained all-mode app command passes recording, stream-only and combined, followed by two additional isolated stream-only invocations (three fresh stream legs total). Every artifact uses its exact applied output owner/timing: recording and stream-only are neutral, combined local is neutral and combined received applies −130 ms. The three stream loss windows start at 2.76 / 2.91 / 2.75 s respectively, each 500 ms long with zero RMS under the unchanged 0.005 ceiling; explicit None windows also have zero RMS. Both microphone identities, acknowledgements, duplicate fencing, one encoder and monotonic DTS pass. Combined local/received loss windows start at 2.47 / 2.34 s and both have zero RMS.

Logs: `/tmp/videorc-fixes-final-live-source-switch.log`, `/tmp/videorc-fixes-final-live-source-switch-stream-{2,3}.log`. Reports: `/tmp/videorc-fixes-final-evidence-20261003/live-source-switch-all-modes/{record,stream,combined}/live-source-switch-evidence.json` and `/tmp/videorc-fixes-final-evidence-20261003/live-source-switch-stream-{2,3}/live-source-switch-evidence.json`. Reduced projection: `/tmp/videorc-fixes-final-evidence-20261003/source-switch-final-repetition-projection.json`. All calls are isolated local fixtures; no physical-microphone/provider-broadcast acceptance is implied. The report deliberately keeps `completePlanAcceptance: false`; full recording-studio/latency/A/V gates are still pending. Full Node/Rust/static/build gates pass independently on this same merged source.
