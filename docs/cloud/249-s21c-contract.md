# Plan 249 S21c archive contract

S21c consumes the published S21a source; it never starts/stops a recording,
changes destinations, allocates a take/interval/controller or widens credentials.
Production availability remains gated by S21a's server-owned qualification and
price policy. Explicit local enablement arms a bounded ring; Record stays a
separate user action. Archive copies require network and cloud egress, and are
not an independent offline backup.

## Web

Owner-session `/api/cloud/shows/:id/archive`: POST uses S21a consent, orientation,
request ID and budget body; PUT polls; GET snapshots or retrieves `?segment=N`.
DELETE closes only the archive-owned ring generation, leaving recording running.
Availability returns the current generation for explicit, fenced re-arming.
All except initial POST/status require the exact ring generation. Existing
ring quotas, TTL, CSRF, owner authorization and credential injection apply.
No new provider output, grant, ISO folder or concurrency reservation.

Version 1 snapshot carries showId, generation, ownerKey (SHA256 account id),
expiresAt, qualified, recordingActive, recordingComplete, recording, segments.
Recording ID is canonical `recordingIdFor(takePrefix + index.m3u8)`; takeId is
S20's existing tk\_ id. Recording timestamps come from existing take metadata.
No segment clock is inferred from the current live interval. Segment hashes,
sequence, byte count and media-relative bounds must agree across retries.

## Desktop

New `cloud_archive.rs` and separate archive recovery journal own only their
UUID staging directory and explicitly journaled files. Limits: one worker,
256 MiB, 512 segments, five-minute generation; no implicit renewal/cost increase.
Restart requires explicit resume and the same authorized account/show/generation.
Stop/cancel affect only the local archive, never recording or pending End/Close.

Only verified complete coverage of the finalized canonical take enters S20's
`prepare_cloud_recording_file` / `recover_cloud_recording_file` workflow. Existing
local canonical files win; no duplicate sessions. Partial/corrupt/cancelled jobs
remain explicit and are not registered as complete Library takes. S22 confirms it adds only the pure `cloud_source_iso.rs` module, not a SQLite
table. Its source objects use the `iso/` prefix; no storage journal collision.
Neither slice edits the other's metadata or deletes source recording objects.

S24 agrees archive is an account read and survives controller transfer. It is
not fenced by controller epoch and never changes pending End/Close or recording
ownership. Account/show/take/ring-generation fences remain mandatory.
The native S20 downloader and archive finalizer share `claim_take_file(id)`
to serialize canonical Library publication, with no ISO table changes.
Maintained acquisition/artifact acceptance will be provided but not executed.

After confirmed completion of the matching canonical take, S21c can drain at
most four final segments from the same live-playlist key, with existing quotas
and lease fencing. This requires prior live acquisition and ENDLIST. Ordinary
replay still refuses finalized playlists; no completed-take index is polled as
a rolling source. An unavailable final tail remains partial/unconfirmed.

Peak staging includes up to 256 MiB of source bytes plus the remux copy. At most
16 journaled jobs are retained; users explicitly discard staging to free slots.
Native runtime, filesystem crash windows, final media and provider feasibility
remain unverified until the deferred acceptance is actually executed.
