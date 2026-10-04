# Plan 147: Diagnose shared record/stream stop failure

## Status

P1 OPEN. Observed during final acceptance on main `b3771763`. Current isolated controls and the complete matrix pass, but the original production cause is unassigned. No attributed repair is claimed.

## Frozen failure

The complete recording matrix returns **16/18**. Its `1080p30:shared-transient-fifo-pressure` session `e3c29d30-82f1-46bb-9218-544649f8e89b` produces no finished recording. The maintained gate exercises the real shared encoder, local RTMP receiver, and a 700 ms FIFO pause. The session reaches Running and media time 5.76 seconds, then takes 13.035 seconds to stop. FFmpeg needs TERM and SIGKILL, so the backend correctly preserves recovery media and reports failure instead of publishing a finished MP4.

The retained lifecycle trace identifies shared writer `f9007a95-b141-4f74-994d-084d7eeaf12d`: stop-signalled, FIFO exit, outer exit, and resource release all occur with zero live writer/encoder/FIFO/queued-access-unit counts. That narrows the stop boundary but does not prove which FFmpeg input or output blocks termination.

Private evidence: `/Users/orcdev/projects/videorc-qa-evidence-20261004/local-main-b377/tmp/videorc-recording-matrix-1791128664522/`, including results, isolated SQLite session logs, and media. Preserve the failure independently of Plan 146's legacy PCM recording truncation.

## Next steps

Reproduce with `VIDEORC_MATRIX_ONLY=1080p30` using the unchanged maintained smoke, isolated app data, and no competing media workload. Capture bounded evidence at the actual FFmpeg command/input/output stop boundaries. Rank falsifiable hypotheses before each probe and change one variable at a time. Do not extend stop deadlines, accept recovery media as finished output, remove pressure injection, relax quality checks, or hide the missing artifact. An attributable repair requires a regression at the real multi-output call site, followed by the complete matrix and relevant recording/latency gates.

## Fresh isolated controls

Three predeclared unchanged isolated trials on the merged PCM repair pass both ordinary and shared-pressure rows: **6/6** cases. Shared recordings are 6.066/6.033/6.066 seconds with 8/17/8 ms tail differences and no repeated-frame burst. Every original pressure/stream/artifact assertion passes; maintained controllers exit 0. Private evidence: `shared-pressure-isolated-1`, `shared-pressure-isolated-2`, and `shared-pressure-isolated-3` under the durable evidence root.

The legacy-only PCM correction does not alter this AAC bridge command. These positive controls bound the current reproduction rate; they do not identify the original stop cause. The complete unchanged matrix after [Plan 148](148-diagnose-legacy-recording-startup-admission.md)'s startup repair also passes all 18 cases, including both transient-pressure paths (`full-matrix-startup-fixed/`). The original forced-stop cohort remains retained and OPEN.

The previous renumbering accidentally copied Plan 146's body into this file. This update restores the actual shared-stop failure from committed Plan 141 (`c88f3ad4`) and preserves the subsequent controls. No source behavior changes.
