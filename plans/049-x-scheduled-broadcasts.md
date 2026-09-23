# Plan 049: Schedule X broadcasts in the livestream scheduler

> Executor: implement the ordered slices below in an isolated worktree of
> current main. Read `AGENTS.md` first. Keep each slice independently testable.
> Planning authorizes no provider writes, implementation, release, or merge by
> itself. S0 is the only slice that touches a real X account, and it creates
> and deletes one private test schedule; it never publishes.

## Status and decisions

- Status: IMPLEMENTED 2026-09-23 on `feat/x-scheduled-broadcasts` (S1–S5 code
  and fixture gates). S0, the real-account spike, was not run by the
  implementing agent: the auto-mode permission classifier refused a live
  create/delete on the owner's X account. The throwaway script for it is
  described under S0; the owner runs it. Real-account acceptance (S5) is also
  the owner's step. Priority P1; effort L; risk MED–HIGH (provider lifecycle
  on an Enterprise-gated API, source ownership, go-live ordering).
- Implementation shape: `scheduled_streams.rs` (provider enum, X metadata
  block, `PreparedIngest`, `ScheduledIngest`, provider-worded errors),
  `scheduled_x.rs` (adapter + fixture tests), `scheduled_streams_service.rs`
  (`ProviderApi`, `execute_x`, X capabilities/candidates/preflight, X service
  tests), `x_live.rs` (crate-visible helpers, scheduled-source cleanup
  exclusion), renderer dialog/list/Go Live/`use-studio` routing,
  `scheduled-streams-fixture.mjs` X routes and an X leg in
  `smoke:scheduled-streams`.
- Assumptions pending S0: `source_id` is the source id (the OpenAPI example
  shape); `tweet_image` media ids are accepted as `thumbnail_media_id`; the
  go-live `broadcast_id` is readable through `GET /2/broadcasts/{id}`.
- Baseline: merged main `92190364` (Plan 045, PR #386) plus later merges through
  `13139793` (PR #389). Plan storage checkout is `feat/windows-owner-waiver` at
  `15206746` with unrelated user changes; do not implement there. Use branch
  `feat/x-scheduled-broadcasts` in its own worktree.
- Goal: the Upcoming view schedules an X broadcast with title, description,
  thumbnail, start time and planned end, the event shows on X, and the user
  starts it manually from Videorc with the existing Go Live flow. Same product
  law as Plan 045: a scheduled time is metadata, never a timer.
- Reuse, do not fork: X becomes the second provider of the existing
  `scheduled_streams` backend service, storage, journal, thumbnail authority,
  Upcoming list and Schedule dialog. No parallel "X scheduler".
- X access: Videorc's consumer pair is already allow-listed for the Livestream
  API (Plans 028/029) and the app signs every Livestream call with the user's
  OAuth 1.0a token. The scheduling endpoints accept that same `UserToken`
  security scheme, so no new OAuth scope or flow is planned. Whether the
  scheduling endpoints are enabled for Videorc's app is unverified; S0 answers
  it before any code is written.
- Out of v1: recurring series (`recurrence`), `telecast_id`, `is_locked`,
  automatic publish (`manual_publish` is always `true`), chat-option and locale
  editing (defaults only), Twitch scheduling, any change to instant X Go Live.

## Platform facts (verified 2026-09-23)

Sources: [Livestream API introduction](https://docs.x.com/livestream-api/introduction),
[Livestream Scheduling API overview](https://docs.x.com/livestream-api/scheduled-broadcasts/overview),
[getting started](https://docs.x.com/livestream-api/getting-started),
[typical workflow](https://docs.x.com/livestream-api/typical-workflow), and the
official OpenAPI at `https://api.x.com/2/openapi.json` (parsed directly; the
schema names below are its names).

| Endpoint | Auth | Notes |
| --- | --- | --- |
| `POST /2/broadcasts/scheduled` | OAuth2 `broadcast.read`+`broadcast.write` or OAuth 1.0a user token | `CreateScheduledBroadcastRequest`; required `source_id`, `scheduled_start_ms`. Returns `broadcast_id` (alphanumeric, `^[a-zA-Z0-9]{1,13}$`, used in every path) and `scheduled_broadcast_id` (numeric, required in the update body). |
| `GET /2/broadcasts/scheduled` | read | Owned scheduled broadcasts; `max_results` 1–100, `oldest_start_time`, `newest_start_time`, `pagination_token`. |
| `GET /2/broadcasts/scheduled/{id}` | read | One schedule. |
| `PUT /2/broadcasts/scheduled/{id}` | write | **Full replacement.** Body requires `scheduled_broadcast_id`, `scheduled_start_ms` **and `scheduled_end_ms`**; omitted fields are dropped. `source_id` may be changed here. |
| `DELETE /2/broadcasts/scheduled/{id}` | write | Returns `{deleted: bool}`; optional `roll_forward` for series. |
| `POST /2/broadcasts/scheduled/{id}/live` | write | Only for `manual_publish: true`; the bound source must already be receiving RTMP. Response is the schedule object; it carries **no `media_key` or `share_url`**. |
| `GET /2/broadcasts/{id}` | read | `Broadcast` object: `media_key`, `share_url`, `state`, `tweet_id`, viewer counts. Used after go-live to obtain playback identity. Already used for viewer counts. |
| `POST /2/media/upload` | OAuth 1.0a allowed (`UserToken`) | `MediaUploadRequest`: multipart `media` + `media_category`; `tweet_image` is the only image category that fits. Response `data.id` (numeric) is the `thumbnail_media_id`. 5 MB image limit. |

Field facts that shape the design:

- Times are decimal strings of Unix epoch milliseconds (`^[0-9]{1,19}$`).
- `thumbnail_media_id`, `chat_option` and `telecast_id` are numeric strings.
- `source_id` is required at create time: a schedule is bound to an ingest
  before it exists. The OpenAPI describes it as the source id "(same as sources
  `rtmp_stream_key`)" while the example value has the source-id shape
  (`c47khpz1zuq9`). S0 settles which value X accepts.
- Scheduler `state` values: `Created`, `Scheduled`, `Running`, `Ended`, `Error`
  (the OpenAPI says "Created, Scheduled, Running, …"). Map to Videorc
  lifecycle: `Created|Scheduled` → `scheduled`, `Running` → `live`,
  `Ended` → `completed`, `Error` → `unknown` with a structured error,
  HTTP 404 on get → `missing`.
- No documented minimum lead time, horizon, or title/description limits. Do
  not invent limits; keep Plan 045's product caps (title 1–100, description
  5,000, thumbnail 2 MB) as adapter constants and let a provider rejection
  surface verbatim through the sanitized error path.
- Errors: 400 invalid input / unknown broadcast / manual-publish mismatch,
  401 token, 403 scope or access, 429 rate limit, 503 unavailable. Bodies use
  the standard `Problem` shape; `x_live::x_error_detail` already parses it.
- Enterprise plan is the documented tier for the whole Livestream API. Videorc
  already operates against it; the scheduling family may still need separate
  enablement by the X account team. Plan 045's table said help pages made
  scheduling Media-Studio-only; that is superseded by the official Scheduling
  API section above.

## Current code and the gaps to close

Read against `92190364`. Line numbers are approximate; re-grep before editing.

1. `crates/videorc-backend/src/scheduled_streams.rs` — `ScheduledStreamEvent`
   has a `provider: String` column and index already, but `draft()` hardcodes
   `"youtube"`, `EventMetadata` is YouTube-shaped (`privacy`, `made_for_kids`
   required, `deny_unknown_fields`), `Preparation.prepared` is typed
   `Option<youtube::PreparedYouTubeBroadcast>`, and `sanitized_error`
   downcasts only `scheduled_youtube::YouTubeRejection`.
2. `scheduled_streams_service.rs` — `api()` builds a `YouTubeEvents` client;
   `dispatch` returns a single-provider capabilities object
   (`{"provider":"youtube",...}`); draft creation requires a YouTube channel;
   `execute_provider`, `prepareForGoLive` (stream create + bind + secret),
   `activate` (ingest poll + `transition(live)`), `releasePreparation`/`complete`
   (`transition(complete)`), thumbnail upload, candidates and recovery are all
   YouTube calls. `settle_operation_result` decides "definite rejection" by
   downcasting `YouTubeRejection`. `resolve_preflight_metadata` (≈1823) reads
   YouTube lifecycle for the Go Live confirmation.
3. `scheduled_youtube.rs` — the provider adapter shape to mirror:
   `YouTubeEvents { request, get, candidates, create, update, delete,
   thumbnail, create_stream, stream, bind, transition }`, `lifecycle()`,
   `metadata_snapshot()`, `validate_thumbnail()`, local HTTP-fixture tests.
4. `x_live.rs` — everything scheduling needs for transport exists:
   `x_livestream_credentials()`, `send_x_request` (OAuth 1.0a signing, JSON
   bodies only, no multipart), `get_region`, `list/create/get/delete_source`,
   `create_broadcast`, `publish_broadcast`, `end_x_broadcast`,
   `fetch_broadcast_viewer_count` (already on `GET /2/broadcasts/{id}`),
   `x_native_live_capability`. Two gaps: no multipart upload helper, and
   `prepare_x_stream_source` deletes every idle source whose name equals
   `DEFAULT_SOURCE_NAME` ("Videorc Primary Encoder") or is in the retired list.
   A schedule's bound source must never be one of those.
5. `main.rs` ≈3240–3470 — `streamTargets.x.prepare|publish|end` RPCs; the
   `scheduledStreams.*` allowlist ≈4700–4805 is renderer-only. The X publish
   path is create-broadcast → wait `is_stream_active` → `PUBLISH` state. For a
   schedule, create+publish is replaced by `.../live`; the pre-publish HLS gate
   and `should_not_tweet` handling do not apply (there is no publish body).
6. `apps/desktop/src/shared/backend.ts` ≈4397–4480 — `provider: 'youtube'`,
   `ScheduledEventMetadata` with `privacy`/`madeForKids`,
   `ScheduledStreamCapabilities` single-provider, `ScheduledStreamCandidate`
   YouTube-shaped. `StreamTarget` ≈724 already carries `scheduledEventId`,
   `scheduledAttemptId`, `scheduledEventTitle`, `scheduledStartUtc`,
   `scheduledPrivacy`.
7. `renderer/src/lib/scheduled-streams.ts` — `selectScheduledStreamForTarget`
   throws unless `target.platform === 'youtube'`.
8. `renderer/src/hooks/use-studio.tsx` — `prepareOauthTargetsForGoLive` ≈11780
   dispatches scheduled targets only inside the YouTube branch; the X branch
   always calls `streamTargets.x.prepare`. Activation ≈10620 (YouTube ingest
   poll + `activate`) and X publish ≈10790 (`streamTargets.x.publish`) are
   separate paths; completion ≈11165 routes scheduled YouTube to
   `releasePreparation`; X end ≈10935 uses `streamTargets.x.end` keyed by
   `platformBroadcastId`. X chat (`x_chat.rs`, `XChatConfig.broadcast_id`) and
   viewer sampling key off the same `platformBroadcastId`/`mediaKey` fields the
   publish result sets, so a scheduled go-live must produce the same
   `XPublishResult` shape.
9. `components/schedule-stream-dialog.tsx` — "YouTube channel" select, copy
   "Your event appears on YouTube", privacy + made-for-kids fields, submit
   label "Schedule on YouTube". `components/scheduled-streams.tsx` — rows say
   "YouTube · label", Go Live picker filters `platform === 'youtube'`, cancel
   copy names YouTube. `components/go-live-dialog.tsx` ≈109–130 shows title,
   privacy and time for scheduled targets. The Upcoming UI is lazy-loaded
   (`streaming-tab.tsx:25`); the renderer eager-asset budget is within bytes of
   full (PR #389), so X additions must stay inside the lazy chunk.
10. `scripts/lib/scheduled-streams-fixture.mjs` + `scripts/smoke-scheduled-streams-app.mjs`
    (`pnpm smoke:scheduled-streams`) mock only YouTube routes behind
    `VIDEORC_SCHEDULED_STREAMS_SMOKE_URL`. `x_live.rs` already honors
    `VIDEORC_X_LIVESTREAM_API_BASE_URL` and env OAuth 1.0a tokens for smokes.

## Design

### Provider model

- `provider` becomes an enum (`youtube | x`) at the Rust and TS boundary,
  serialized exactly as today so existing rows load unchanged. Keep
  `schema_version` 1; every new field is `#[serde(default)]` and optional.
- `EventMetadata` gains a provider block instead of new top-level fields:
  `youtube: Option<{ privacy, made_for_kids }>` and
  `x: Option<{ planned_end_local, available_for_replay }>`. The existing
  top-level `privacy`/`made_for_kids` stay as the YouTube values for
  compatibility (drop `deny_unknown_fields` only if the migration needs it;
  prefer keeping it and adding the fields explicitly). Validation dispatches
  on provider: X rejects a planned end at or before start and ignores
  privacy/audience; YouTube keeps today's rules.
- `Preparation.prepared` becomes a tagged enum `PreparedIngest::Youtube(..)`
  / `PreparedIngest::X(PreparedXStreamSource)`; the public projection still
  strips it.
- Provider rejections: introduce `ProviderRejection { provider, status,
  reason }` (or a small trait) so `sanitized_error` and
  `settle_operation_result` treat an X 4xx exactly like a YouTube 4xx
  (definite, clears `create_uncertain`) and a 5xx/timeout as unknown.
- Capabilities RPC returns a list: `providers: [{ provider, available, reason,
  accounts, fields, audienceEditable }]`. X availability reuses
  `x_native_live_capability` for the selected account
  (`available` state, consumer present, user token present, account matches
  the token's user id). Its `fields` are `title, description, thumbnail, time,
  plannedEnd, replay`.

### X adapter (`scheduled_x.rs`)

`XScheduledBroadcasts` wraps `XLivestreamCredentials` + base URL and offers:
`create(event, source_id, thumbnail_media_id)`, `get(id)`, `list(window)`,
`update(event, current, source_id)`, `delete(id)`, `go_live(id)`,
`broadcast(id)` (the `/2/broadcasts/{id}` read), `source(id)`,
`create_source(name, region)`, `upload_thumbnail(path) -> media_id`.

Rules baked into the adapter, each with a fixture test:

- `manual_publish: true` on every create and update. Never omit it on update
  (full replacement would flip the schedule to auto-publish and make
  `.../live` fail with 400).
- Always send `scheduled_end_ms`. The form's planned end defaults to start +
  2 h and is editable; store it as a local wall time in the same zone as the
  start and resolve it with the existing `resolve_time` helper. Update requires
  it, so an open-ended create would make every later edit impossible.
- Update re-sends every mutable field from the last confirmed remote object
  merged with the edit (`title`, `description`, `thumbnail_media_id`,
  `chat_option`, `locale`, `available_for_replay`, `source_id`,
  `scheduled_broadcast_id`). Compare `metadata_snapshot(confirmed)` before
  sending, as Plan 045 does, and offer Reload on external change.
- Times: `start_utc` (RFC 3339) ↔ `scheduled_start_ms` string, tested both
  ways, including values past 2^53 handled as strings, never as f64.
- `chat_option` and `locale` come from `x_live::default_chat_option()` /
  `default_publish_locale()` as numeric string and string respectively.
- Thumbnail: reuse the managed-thumbnail authority and
  `scheduled_youtube::validate_thumbnail` (move it to `scheduled_streams.rs`),
  then multipart-upload with `media_category=tweet_image`. Add a signed
  multipart helper next to `send_x_request`; the OAuth 1.0a signature base
  string excludes the multipart body. Persist the returned `media_id` on the
  event (`thumbnail_media_id`) so a later update re-sends it without
  re-uploading; re-upload only when the asset id changes.
- Watch link: after create, read `GET /2/broadcasts/{id}`; use its
  `share_url` when present, else `https://x.com/i/broadcasts/{id}` (the same
  fallback `publish_x_broadcast` uses). Label it "Open on X".

### Source ownership

A schedule needs an ingest source at create time, and Plan 031 established
that a source's **first** broadcast is the only one that plays reliably.
Therefore:

- Each X scheduled event owns one dedicated source created at schedule time,
  named `Videorc Scheduled <first 8 chars of event id>` in the recommended
  region. Its id and stream-key secret ref (`platform:x:{uid}:{source}:stream-key`,
  existing format) live on the event's `preparation`/`retained_ingest`
  record; the key itself stays in the secret store.
- Source creation is journaled like YouTube's `creating-stream` phase
  (`creating-source` → `source-created` → `creating-event`), so a crash
  between source and schedule creation resumes with the same source and never
  double-creates a schedule.
- `x_source_cleanup_ids` must never return a scheduled source: add an explicit
  exclusion (name prefix `Videorc Scheduled` and every source id referenced by
  a non-terminal scheduled event), with a test that an instant-stream prepare
  on the same account leaves the scheduled source alone. The playback-health
  retirement list must also skip scheduled sources.
- Cancel deletes the schedule first, then the source (best effort, logged).
  Completed events delete their source after `Ended` is confirmed; a failed
  go-live keeps it for Retry. "Recreate ingest" recovery creates a fresh
  source and `PUT`s the schedule's `source_id`, restoring the first-broadcast
  guarantee after a hard failure.
- Rescheduling or editing never touches the source.

### Go Live for a saved X event

Same skeleton as the YouTube scheduled path, different provider calls:

1. `prepareForGoLive`: refresh the schedule; require lifecycle `scheduled` and
   the confirmation fingerprint; read the owned source; if `is_stream_active`
   is already true, stop with "another encoder is sending to this event";
   fetch/store the stream key; return a `PreparedXStreamSource` so the
   renderer's X branch patches `serverUrl`, `streamKeySecretRef`,
   `platformStreamId = sourceId`, `platformBroadcastId = region` exactly as
   the instant path does. No broadcast is created.
2. Encoder starts on the existing RTMPS leg. The renderer's X activation path,
   when `target.scheduledEventId` is set, calls `scheduledStreams.activate`
   instead of `streamTargets.x.publish`.
3. `activate`: verify the owning session as today; poll the source until
   `is_stream_active` (bounded, same cadence as `publish_x_broadcast`); call
   `POST /2/broadcasts/scheduled/{id}/live`; then `GET /2/broadcasts/{id}` to
   obtain `media_key`, `share_url`, `state`, `tweet_id`; return an
   `XPublishResult`-shaped result (`broadcastId`, `mediaKey`, `shareUrl`,
   `state`, `message: "Scheduled X broadcast is live."`). Chat relay, viewer
   sampling and the Comments window keep working unchanged because they key
   off those fields. A go-live timeout is reconciled by re-reading the
   schedule/broadcast state, never by calling `.../live` twice blindly.
4. Stop: `releasePreparation`/`complete` ends via the existing
   `end_x_broadcast` (END before encoder stop, Plan 031 order), confirms
   `ENDED`/`Ended` with a read, then marks `completed`. The renderer's X end
   path (`endPreparedXBroadcasts`) stays the single place that sends END; the
   scheduled completion only confirms and records.
5. Pre-live failure (encoder never active, `.../live` 400) releases the
   preparation and preserves the schedule for Retry. The Go Live dialog copy
   for X says the event starts now regardless of its scheduled time and does
   not promise an announcement post; S0 records what X actually posts.

### User experience

- Schedule dialog gains a first field "Platform" (YouTube / X) shown only when
  more than one provider is available; otherwise it is preselected. Account
  select label follows the provider ("YouTube channel" / "X account"). Copy:
  "Your broadcast appears on X. Start it manually from Videorc." Submit label
  "Schedule on X" / "Update broadcast".
- X fields: title, description, thumbnail (same picker, "16:9 recommended"),
  start date/time + zone (unchanged), planned end (default +2 h, must be after
  start, shown resolved like the start), "Keep replay available" switch
  (default on). Privacy and audience are hidden for X. Editing works for every
  X field except the platform and account.
- Upcoming rows read "X · @handle" with the X Phosphor glyph; actions Go Live…,
  Edit, Copy link, Open on X, Cancel broadcast. Cancel copy: "The scheduled
  broadcast will be deleted from X and its link will stop working."
- "Use saved event for Go Live" lists X OAuth destinations for an X event.
  Selection stores the local event id on the target, as today.
- Go Live confirmation shows platform, account, title and the scheduled start;
  the privacy line is YouTube-only.
- Reuse shadcn Select/Field/Switch and the Videorc design skill; both themes;
  keyboard flow unchanged. No new global shortcut. Everything lands inside the
  lazy Upcoming chunk; the eager bundle must not grow.

## Scope and slices

Allowed paths: backend `scheduled_streams.rs`, `scheduled_streams_service.rs`,
`scheduled_youtube.rs` (minimal generalization only), new `scheduled_x.rs`,
`x_live.rs` (multipart helper, cleanup exclusion, shared request plumbing),
`main.rs` (capability/dispatch wiring only), `storage.rs` only if a new index
is required (none expected); shared `backend.ts`; renderer
`lib/scheduled-streams.ts`, `hooks/use-scheduled-streams.ts`, `use-studio.tsx`
(scheduled X dispatch only), `schedule-stream-dialog.tsx`,
`scheduled-streams.tsx`, `go-live-dialog.tsx`, tests beside each;
`scripts/lib/scheduled-streams-fixture.mjs`, `scripts/smoke-scheduled-streams-app.mjs`;
`docs/acceptance/` for S0/S5 records; `plans/README.md`.

Out of scope: instant X Go Live behavior, X chat relay, viewer stats,
multistream orientation rules, Twitch scheduling, recurring series, automatic
publish, announcement-post authoring, Google gate, Windows-specific work.

### S0 — Real-account capability spike (owner-run, read-mostly)

With the owner's authorized X account and the release consumer pair, run a
throwaway script (scratchpad, not committed) that signs with the stored
OAuth 1.0a token and records, in
`docs/acceptance/2026-09-XX-x-scheduling-spike.md`:

1. `GET /2/broadcasts/scheduled` succeeds (proves access to the family).
2. `POST /2/users/{uid}/sources` (name `Videorc Scheduled Spike`) then
   `POST /2/broadcasts/scheduled` with `manual_publish: true`, start +30 min,
   end +90 min, using the source **id**; if 400, retry with
   `rtmp_stream_key` and record which one X accepts.
3. `GET /2/broadcasts/scheduled/{id}`, `GET /2/broadcasts/{id}` (does a
   `share_url` exist before live? what `state`?), and whether X posted anything
   to the timeline on creation.
4. `POST /2/media/upload` (multipart, `tweet_image`, a 1280×720 JPEG under
   2 MB) and `PUT` the schedule with `thumbnail_media_id` — confirm acceptance
   and that the schedule object echoes it.
5. `PUT` a title change without `scheduled_end_ms` to confirm the 400, then
   with it to confirm full replacement drops omitted fields.
6. `DELETE /2/broadcasts/scheduled/{id}` → `{deleted:true}`; `GET` → 404;
   delete the spike source.

No `.../live` call in S0 (it would publish). Record HTTP status and sanitized
bodies only; never paste tokens. If step 1 returns 403, stop: the plan is
blocked on X enablement and the owner contacts the X account team.

Done when: the record answers `source_id` semantics, pre-live share URL,
thumbnail acceptance, update replacement behavior and whether creation posts.

### S1 — Provider-neutral scheduling core (no behavior change)

Introduce the provider enum, provider metadata block, `PreparedIngest` enum,
`ProviderRejection`, provider-list capabilities and adapter dispatch seams in
`scheduled_streams.rs` / `scheduled_streams_service.rs`; move
`validate_thumbnail` and `lifecycle`-style helpers behind a small trait or
match. Mirror in `shared/backend.ts` (`provider: 'youtube' | 'x'`,
`ScheduledStreamCapabilities.providers[]`) and update the renderer hook and
components to read the list (YouTube preselected). All existing YouTube tests
and the fixture smoke must pass unchanged; existing rows must load.

Verify: `cargo test -p videorc-backend scheduled_streams`,
`cargo test -p videorc-backend youtube`, `cargo clippy -p videorc-backend -- -D warnings`,
`pnpm typecheck`, `pnpm --filter @videorc/desktop test -- scheduled`,
`pnpm smoke:scheduled-streams`.

### S2 — X scheduling adapter

Add `scheduled_x.rs` with the client above, epoch-ms conversion, state
mapping, full-replacement update builder, multipart thumbnail upload, and a
signed multipart helper in `x_live.rs`. Local HTTP-fixture tests cover: create
body exactness (`manual_publish` true, end always present, numeric strings),
update re-sends confirmed fields + `scheduled_broadcast_id`, 400/401/403/429
→ `ProviderRejection` with bounded reasons, 404 → missing, list pagination,
thumbnail upload → media id, go-live followed by broadcast read. Extend
`x_source_cleanup_ids` with the scheduled-source exclusion and test it.

Verify: `cargo test -p videorc-backend scheduled_x`,
`cargo test -p videorc-backend x_live`, clippy, `cargo fmt --check --all`.

### S3 — Service integration for X

Wire `schedule` (journaled source create → schedule create → thumbnail),
`update`, `cancel` (schedule delete → source delete), `refresh`, `duplicate`
(new draft, no remote ids, new source at schedule time), `recover`
(list-by-window candidates, explicit selection, ownership check),
`prepareForGoLive`, `activate`, `releasePreparation`/`complete` for
`provider == x`, plus `resolve_preflight_metadata` for X. Service tests with a
real temp DB replay Plan 045's failure matrix for X: crash after source
create, unknown create, thumbnail failure keeps the schedule, stale edit,
duplicate start/cancel, lost go-live reconciled by read, two events on one
account, one X schedule plus one YouTube schedule in one Go Live, late
callbacks from an old session rejected.

Verify: `cargo test -p videorc-backend scheduled_streams`,
`cargo test -p videorc-backend storage`, clippy, `pnpm typecheck`.

### S4 — Renderer: dialog, list, Go Live dispatch

Provider picker and X fields in the dialog; provider-aware copy, rows, cancel
and Go Live picker in the list; `selectScheduledStreamForTarget` matches
`target.platform === event.provider`; `prepareOauthTargetsForGoLive` routes a
scheduled X target to `prepareForGoLive`; the X activation path calls
`activate` when `scheduledEventId` is set and patches the same fields as the
publish result; completion confirms through `releasePreparation` after the
existing END; Go Live dialog hides privacy for X. Focused tests for the
selection helper, dialog validation (planned end after start, hidden YouTube
fields), and provider integration tests asserting no `streamTargets.x.publish`
call for a scheduled X target and identical `broadcastId`/`mediaKey` through
chat and end.

Verify: `pnpm --filter @videorc/desktop test`, `pnpm typecheck`, `pnpm lint`,
`pnpm format:check`, `pnpm build` (eager asset budget unchanged). Inspect both
themes, long handles, keyboard-only flow, 200% zoom.

### S5 — Smoke fixture and real acceptance

Extend `scheduled-streams-fixture.mjs` with X routes (`/2/region`, sources,
`/2/broadcasts/scheduled*`, `/2/broadcasts/{id}`, `/2/media/upload`) served
under `VIDEORC_X_LIVESTREAM_API_BASE_URL` with env OAuth 1.0a tokens, and add
an X leg to `smoke:scheduled-streams`: schedule → Go Live → activate →
chat/viewer identity → stop → completed → cancel of a second event. Then the
owner runs one real session on the authorized account: schedule from Videorc,
open the link on X, go live from Videorc, see chat and viewers, stop, confirm
`Ended` on X. Record it in `docs/acceptance/`. Do not release before this
record exists.

Verify: `pnpm smoke:scheduled-streams`, `pnpm smoke:local-gates`, and the
recording-studio bundle only if the encoder leg changed (it should not).

## Risks and open questions

- Scheduling endpoints may not be enabled for Videorc's app despite Livestream
  access (S0 gate). Blocked means blocked; no manual-RTMP fallback labeled as
  scheduling.
- `source_id` semantics (id vs stream key) are contradictory in the spec.
- Whether creating a schedule posts to the timeline, and whether `.../live`
  posts an announcement, is undocumented; the UI copy must follow S0 evidence.
- `.../live` returns no playback identity; the follow-up broadcast read is a
  second request that can fail independently. Treat "live confirmed, identity
  unknown" as a reconciliation state, not a failure.
- Update is full replacement with a required end time; any missed field
  silently erases remote data. The adapter test that diffs the update body
  against the confirmed object is mandatory.
- Renderer eager bundle is at budget; every X UI addition must remain lazy.
- Windows: no platform-specific code expected; the X path is pure HTTP.
