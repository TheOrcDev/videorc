# Plan 249 S21b: program replay Clips

Source implementation checkpoint; real app/provider/clock/artifact acceptance is
**not-run**. Production is **disabled/unqualified**. D8 remains deferred.

## Ownership and admission

`/api/cloud/shows/:id/clips` uses the existing owner account session. Guests,
program tokens, another show/account and arbitrary object keys cannot read it.
GET status, marked plans and selected bytes are account reads, surviving controller
transfer. POST explicit enable, PUT poll and DELETE disable use S24
`withControllerCommand`; desktop sends the existing controller header. No new
epoch, take, interval or recording grant is created. No route starts recording.

POST uses S21a's consent/orientation/requestId/expectedGeneration/byteCeiling/
costCeilingMicros contract. Enable before a separately requested Record. Existing
active recordings cannot acquire a live playlist by implicit restart. Native
Clips default enablement does not consent to cloud storage. The same ring is
shared with S21c: disabling removes references, not source recording objects.
UI explicitly warns that disabling also affects an archive using that buffer.

A process-owned poller continues only the already-consented generation and its
existing budget, including reconnect/restart when current ownership is confirmed.
No automatic renewal, quota increase, recording activation or native capture.
It stops on account/room/control loss, generation refusal or five-minute limit.

## Clock and extraction contract

GET `?generation=…&marker=…` derives a v1 immutable clip plan from the persisted
S19 mark; clients supply no start time, object key, provider ID or clock proof.
S19 receipts stay on `server-show-created-at`; voice source offsets and the S13a
native anchor are never substituted for this clock.

`ManagedReplayState.clipClockProof?` is server-owned `ClipClockProof`: measured
SegmentClockEvidence plus providerEgressId, validUntil and
independentAvSegments:true. It must bind the exact show origin, take, provider,
ring generation, segment IDs/media offsets/durations and contiguous coverage.
Uncertainty is finite, nonnegative and at most 50 ms. Expired/missing evidence,
missing segments, changed source, gaps and unbounded windows refuse extraction.
Current interval is not used to retimestamp a mark or infer a media range.

There is **no production measured proof supplier** today. No field is populated
from PDT, take start, room open, controller epoch or native monotonic origin.
The production policy remains `qualified:false, price:null`, so live enablement
is refused before credential/provider access. Measurement and reviewed proof
installation remain a prerequisite for enabling the implemented path; simulated
fixture proof is not managed qualification.

GET with `marker`, `generation`, `clip` (plan hash) and `segment` retrieves only
segments in that plan, through S21a's owner/source/expiry/hash/cost fences. The
plan carries SHA256/byte counts, exact requested window, relative trim start,
source take/provider identities, original marker interval association and an
expiry bounded by all selected segments. It contains no URLs or storage keys.

## Local worker and Library

`cloud.clips.status/enable/disable/save/jobs/cancel/discard` are typed RPCs.
Manual/remote/agent/consented host-voice clip marks reuse S19 creation and attempt
extraction only when an opted-in ring exists. Refusal preserves the marker.
Queued/interrupted/saved are distinct observations; a queue receipt is not a file.
GET/save of already-authorized media is not fenced by current controller epoch.

The configured recordings folder is authorized through the existing output-directory
capability on enablement and retained as one show-scoped local preference. No raw
renderer path or caller-selected FFmpeg is trusted.

One download/trim worker, at most 64 MiB/64 segments and 60 seconds per plan.
Each response is bounded; segment hashes are checked before writing. Staging is
limited to one retained unfinished job (192 MiB peak: 64 MiB source + 128 MiB
output). At most 16 job records; completed Library files have normal user-owned
retention. Explicit discard removes only journaled filesystem objects and keeps
completed Library files and durable provenance. Cloud source retention remains
7/30 days under S20; ring references remain 90 seconds and five minutes per arm.
Transfer expiry causes a refusal, never finalized-take polling.

The local HLS playlist contains generated basenames only. FFmpeg protocols are
restricted to `file`; both video and audio decode from an independent segment,
trim on the same relative timeline, reset PTS and re-encode to H.264/AAC MP4.
No keyframe stream-copy overshoot is claimed to be an exact trim. Output has a
128 MiB cap, each processing stage a 120-second deadline, probe a 12-second
deadline; cancellation kills/reaps the owned processing child. Full decode plus
100 ms duration tolerance precede publication. Actual PTS/pixels/audio acceptance
is maintained separately and has not run.

SQLite `cloud_program_clips` owns retry/cleanup/publication state;
`cloud_clip_sources` preserves show/marker/generation/take/provider/interval and
measured mapping provenance after job dismissal. Additive SQL only; no historical
start is rewritten. A verified clip becomes a completed `cloud-recording` mode
Library file with its own `cloud-clip_<hash>` session, no capture sources and no
fabricated provider take. Normal Play/export/Clean cut/noise cleanup reuse the
existing cloud-recording workflow. `cloud.clip.job` refreshes Library on completion.
Interrupted work requires explicit retry/discard; repeated marker deliveries do
not silently restart cancelled or interrupted work. Retry revalidates source
availability, re-downloads verified segments, and does not append unknown bytes.

## Deferred acquisition

`pnpm smoke:cloud-parity -- --case clips` now acquires the real program tab and
mixed audio through the maintained S21a runner, selects a non-keyframe 30-second
marked window through the actual web routes, drives real desktop download/trim/
Library publication, tests repeat-save/cancellation/retention/refused mapping,
and analyzes finished pixels (host/guests/overlay), mixed tones, duration, packet
DTS/PTS and independent video head. Its controlled local show-to-artifact clock
is explicitly **synthetic-local-fixture-only**; it cannot establish provider
clock uncertainty, latency, managed price or D8.

No smoke, real-page, device, provider, paid egress, heavy suite, desktop build or
full Rust compile was run. No real user DB, credentials or deployment touched.
