# Plan 083: YouTube thumbnail in Broadcast info (instant Go Live)

**Status:** PLANNED 2026-10-01. **Priority:** P2 (missing feature the owner
calls "really important"; nothing is broken). **Size:** M, 4 slices.
**Planned against:** `origin/main` `9f1a46a3` (0.9.125).
**Owner route:** UI/Product Design for S2, Implementation for S1/S3/S4 (fit 8).
**Model lane:** `opus-4.8` for S2, `gpt-5.5` for S1/S3/S4. Read
`.claude/skills/videorc-design/SKILL.md` before S2.

## Owner request

The Livestream tab's Broadcast info has title and description but no thumbnail.
A YouTube live stream started from Videorc should carry the thumbnail the
owner picked.

## Verdict: possible, and most of it is already built

### YouTube API (verified 2026-10-01)

Source: <https://developers.google.com/youtube/v3/docs/thumbnails/set>

- `POST https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=<id>&uploadType=media`,
  body = raw image bytes, `Content-Type: image/jpeg` or `image/png`.
- A live broadcast id **is** a video id, so `videoId = broadcast_id`. It works
  on a broadcast that is created/ready (before ingest) and on one that is live.
- Scope: `youtube.force-ssl` is accepted. That is the only scope Videorc
  requests (`oauth.rs:2911`), so **no new scope, no new Google review, no
  reconnect**.
- Quota: about 50 units per call.
- Errors: 400 `invalidImage`, 400 `mediaBodyRequired`, 403 `forbidden`
  ("can't be set for the specified video"), 404 `videoNotFound`, 429
  `uploadRateLimitExceeded` ("too many thumbnails recently").
- Size: the API doc now says max 50 MB (it was 2 MB for years). YouTube Help
  (<https://support.google.com/youtube/answer/72431>) says 50 MB on desktop,
  2 MB on mobile; JPG or PNG; 16:9; minimum width 640; a verified channel is
  required; there is a per-channel daily custom-thumbnail limit.
- Eligibility: custom thumbnails need a phone-verified channel. Live streaming
  needs the same verification, so a channel that can go live should already
  qualify. This is an inference, not a documented guarantee; handle 403.

### What already exists in the repo (do not rebuild)

Scheduled streams (plan 045) shipped the whole pipeline:

| Piece | Where |
| --- | --- |
| Native picker + import (magic-byte check, 2 MB cap, 20 MP cap, sha256 content id, write-once file) | `apps/desktop/src/main/scheduled-stream-thumbnail.ts`, `pickScheduledThumbnail()` in `apps/desktop/src/main/index.ts` (~L13104) |
| IPC `scheduled-streams:import-thumbnail` → `window.videorc.importScheduledThumbnail()` returns `{ id, previewUrl, width, height }` | `preload/index.ts:44`, `shared/electron-ipc-contract.ts`, `shared/renderer-security-policy.ts` |
| Managed root `userData/scheduled-thumbnails`, rehydrated into the backend at startup | `index.ts` `rehydrateScheduledThumbnails()` (~L13091), env `VIDEORC_MANAGED_THUMBNAIL_ROOT` |
| Preview URL `videorc-asset://scheduled-thumbnail/<id>` | `index.ts` (~L13039), `renderer/src/lib/scheduled-streams.ts` `scheduledThumbnailUrl` |
| Backend capability: `register_managed_thumbnail` / `resolve_managed_thumbnail` (root, content hash, object identity) | `crates/videorc-backend/src/resource_authority.rs` (~L234-L322) |
| The upload itself, with one 401 refresh-and-replay | `crates/videorc-backend/src/scheduled_youtube.rs` `YouTubeEvents::thumbnail` (~L291), `validate_thumbnail` (~L381) |
| API handle for an account | `scheduled_streams_service::youtube_api(state, account_id)` (~L101) |
| Thumbnail field UI (preview, Choose/Replace, Remove, hint) | `renderer/src/components/schedule-stream-dialog.tsx` (~L529-L567) |

### The gap

The instant Go Live path never references any of it:

- `StreamMetadataDraft` (`streaming.rs:291`, `shared/backend.ts:852`) has no
  thumbnail field.
- `MetadataEditor` (`components/tabs/streaming-tab.tsx:371`) has no thumbnail
  control.
- `prepare_youtube_stream_target` (`main.rs:2564`) →
  `youtube::prepare_youtube_broadcast` (`youtube.rs:281`) creates broadcast +
  stream + bind and never calls `thumbnails.set`.

A scheduled event started through Go Live (`prepareForGoLive`) already has its
thumbnail; that path is out of scope and must not change.

## Design

1. **Data.** One new optional field on the **global** draft:
   `StreamMetadataDraft.thumbnail_asset_id: Option<String>` /
   `thumbnailAssetId?: string`. Global, not per-platform, because it sits with
   title and description and an X instant thumbnail can reuse it later.
   It persists between streams like title and description do.
2. **UI.** A Thumbnail field directly under Description in Broadcast info,
   drawn only when a YouTube destination exists in Destinations. 16:9 preview,
   Choose/Replace, Remove.
3. **Upload.** After a successful instant prepare, the backend uploads the
   thumbnail to the new broadcast in a **spawned task**. Go Live never waits on
   it and never fails because of it.
4. **Result.** The backend emits `streamTargets.youtube.thumbnail`
   `{ targetId, broadcastId, state: "uploaded" | "error", code?, message? }`.
   On `error` the renderer shows one warning toast with a Retry action
   (user-actionable, so a toast is allowed; icon-only tint per the toast rule).
5. **Stream-key YouTube destinations** (manual key, including the vertical
   manual leg) have no API access. The field says so; nothing is uploaded.
6. **Two OAuth YouTube destinations** (horizontal + vertical): each prepare
   uploads to its own broadcast.

## Owner decisions (recommended defaults; execution does not wait)

- **D1: Field placement.** Recommended: global, under Description, visible only
  with a YouTube destination. Alternative: inside the YouTube accordion row
  (hidden while collapsed).
- **D2: Images over 2 MB.** Recommended: accept them and auto-fit to a
  1280×720-class JPEG under 2 MB on import (S4). Alternative: keep the hard
  "smaller than 2 MB" error. Raising our cap to YouTube's new 50 MB is not
  recommended until proven against the live API.
- **D3: Change the thumbnail while live.** Recommended: not in v1. The field is
  disabled during a session like the rest of Broadcast info. The S3 retry
  command makes this a small follow-up.

## Out of scope

- X instant-broadcast thumbnails (`x_live.rs` has no media upload for instant
  broadcasts; X scheduled already has one). Twitch and Kick have no thumbnail API
  for live.
- Thumbnail editor, cropping UI, or grabbing a frame from the preview.
- Any change to the scheduled-streams thumbnail behaviour, except the shared
  import in S4 and the shared field component in S2.
- Renaming the `scheduled-thumbnails` root, IPC channel, or capability kind.
- Garbage-collecting unused files in the managed root (pre-existing).

## Slices

Each slice leaves `main` shippable. S1 → S2 → S3 in order; S4 is independent.

### S1: Draft field, end to end, no upload (Implementation)

- `crates/videorc-backend/src/streaming.rs`: add to `StreamMetadataDraft`

  ```rust
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub thumbnail_asset_id: Option<String>,
  ```

  `skip_serializing_if` is mandatory: a serialized `null` has broken app load
  three times (serde null → contract trap). Set `None` in
  `default_stream_metadata_draft` and in every struct literal the compiler
  flags (`preflight.rs`, `scheduled_streams_service.rs` tests, `youtube.rs`
  tests, `main.rs`).
- `main.rs` `streamTargets.metadata.save` (~L10506): when the field is set,
  call `resource_authority::validate_asset_id` and
  `state.resource_authority.resolve_managed_thumbnail(id)`; reject the save with
  the resolver's message ("Thumbnail is unavailable. Pick it again.").
  `streamTargets.metadata.get` does not resolve (startup rehydration may not
  have run yet).
- `apps/desktop/src/shared/backend.ts`: `thumbnailAssetId?: string` on
  `StreamMetadataDraft`.

Done when:

- Rust unit tests in `streaming.rs`: a stored draft JSON without the field
  parses to `None`; a draft with `None` serializes with **no**
  `thumbnailAssetId` key; a draft with `Some` round-trips.
- Rust test: save with an unregistered id is rejected; save with `None` passes.
- `cargo test -p videorc-backend streaming`, `cargo clippy -p videorc-backend -- -D warnings`,
  `pnpm typecheck`.

### S2: Thumbnail field in Broadcast info (UI/Product Design)

- Extract the field from `schedule-stream-dialog.tsx` (~L529-L567) into
  `renderer/src/components/streaming/thumbnail-field.tsx`: props
  `assetId`, `disabled`, `removable`, `onChange(assetId | null)`, `onError`.
  It derives the preview from `scheduledThumbnailUrl(assetId)` and calls
  `window.videorc.importScheduledThumbnail()`. shadcn components only
  (`Field`, `FieldLabel`, `FieldDescription`, `Button`). The schedule dialog
  switches to the component with identical behaviour (its
  `schedule-stream-dialog.test.ts` must stay green unchanged in intent).
- `streaming-tab.tsx` `MetadataEditor`: render the field after Description when
  `targets.some(t => t.platform === 'youtube')`. `onChange` →
  `onPatchDraft({ thumbnailAssetId: id ?? undefined })`. Disabled with the same
  `disabled` flag as the other fields.
- Copy (sentence case, no em dashes):
  - Label: `Thumbnail`
  - Hint: `Shown on YouTube. JPEG or PNG, 16:9, 1280 × 720 or larger.`
  - When no YouTube destination is OAuth-connected (all are stream key):
    `Stream key destinations can't receive a thumbnail. Connect the YouTube account, or set it in YouTube Studio.`
  - Soft hint when the picked image is not 16:9 (from the returned
    `width`/`height`, tolerance 1%): `This image is not 16:9. YouTube will add bars.`
  - Buttons: `Choose thumbnail` / `Replace thumbnail` / `Remove thumbnail`.
- A broken preview (file gone from the managed root) shows the empty state and
  clears the field on the next save rather than a broken image.
- `renderer/src/lib/stream-metadata-summary.ts`: no change (the summary is per
  destination row).

Done when:

- `streaming-metadata.test.ts`: field renders with a YouTube destination,
  absent without one, stream-key copy shown when no YouTube target is OAuth.
- `pnpm --filter @videorc/desktop test`, `pnpm typecheck`, `pnpm lint`,
  `pnpm format:check`, `pnpm build && pnpm check:renderer-assets` (the eager
  renderer budget has roughly 400 B of headroom; the new component must stay in
  the lazily loaded Livestream chunk).
- By eye in the dev app: pick, replace, remove, save, relaunch → preview
  persists. Schedule dialog thumbnail still works.

### S3: Upload on instant Go Live (Implementation)

- `scheduled_youtube.rs` `YouTubeEvents::thumbnail`: on a non-success status,
  parse the body and keep the provider's bounded reason code (same
  alphanumeric/80-char filter as `request`) instead of the fixed
  `thumbnailUploadDenied`; fall back to that string when the body has none.
- `main.rs` `prepare_youtube_stream_target`: after `let prepared = prepared?`
  and the account upsert, if `metadata.thumbnail_asset_id` is `Some`, spawn a
  task that:
  1. `state.resource_authority.resolve_managed_thumbnail(&asset_id)`
  2. `scheduled_streams_service::youtube_api(state, &account_id)`
  3. `api.thumbnail(&prepared.broadcast_id, &path, &asset_id)`
  4. emits `streamTargets.youtube.thumbnail` with `uploaded` or `error`.
  Log one line per outcome (`[youtube-thumbnail] uploaded` /
  `failed: <code>`), never the token, URL, or body. Clone `metadata` before the
  retry branch moves it.
- New command `streamTargets.youtube.thumbnail.retry`
  `{ accountId?, broadcastId, targetId? }`: same four steps, awaited, using the
  **current** draft's asset id. Refuse a broadcast id owned by a scheduled
  event (same guard as `transition_youtube_stream_target`, `main.rs:2652`). Add
  it to the command-lane list next to `streamTargets.youtube.prepare`
  (`main.rs:5110`).
- Error copy mapping (one pure function, unit-tested):

  | Code | Message |
  | --- | --- |
  | `forbidden` (403) | `YouTube refused the thumbnail. Check that custom thumbnails are enabled for this channel in YouTube Studio.` |
  | `uploadRateLimitExceeded` (429) | `YouTube's daily thumbnail limit is reached for this channel. The stream is live without it.` |
  | `invalidImage` (400) | `YouTube could not read this image. Choose another JPEG or PNG.` |
  | resolver failure | `Thumbnail is unavailable. Pick it again.` |
  | anything else | `The thumbnail was not set. The stream is not affected.` |

- Renderer `use-studio.tsx`: subscribe to `streamTargets.youtube.thumbnail`;
  on `error`, one warning toast `Thumbnail not set on YouTube` + message, with
  a `Retry` action calling the retry command (no Retry for
  `uploadRateLimitExceeded`). Deduplicate per `broadcastId`. `uploaded` is
  silent.
- Types in `shared/backend.ts` for the event and the retry params.

Done when:

- Rust test with the local `TcpListener` fixture style already used in
  `youtube.rs` tests / the scheduled fixture router
  (`scheduled_streams_service.rs` ~L1773): prepare with a thumbnail issues
  exactly one `POST /upload/youtube/v3/thumbnails/set` with
  `videoId=<broadcast id>`, the right `Content-Type`, and the file bytes;
  prepare without a thumbnail issues none.
- Rust test: a 403 on the upload still returns a successful
  `PreparedYouTubeBroadcast` and emits the `error` event with `forbidden`.
- Rust test: retry refuses a scheduled-event broadcast id.
- Unit test for the copy mapping.
- `cargo test -p videorc-backend youtube`, `cargo test -p videorc-backend scheduled`,
  `cargo clippy -p videorc-backend -- -D warnings`, `cargo build --release -p videorc-backend`
  (release-build cfg gap), `pnpm typecheck`, `pnpm --filter @videorc/desktop test`,
  `pnpm smoke:scheduled-streams` (the shared upload function changed),
  `pnpm smoke:oauth-guards`.
- **Live acceptance (owner channel, Private):** set a thumbnail, Go Live to
  YouTube, confirm the thumbnail in YouTube Studio → Content → Live within
  ~10 s of the stream starting; stop. Repeat with a dual horizontal + vertical
  OAuth pair if both are connected. This is the only proof that `thumbnails.set`
  accepts a just-created `enableAutoStart` broadcast; unit fixtures cannot show
  it.

### S4: Auto-fit oversize images on import (Implementation, D2)

- `apps/desktop/src/main/scheduled-stream-thumbnail.ts`: raise the **source**
  read cap to 50 MB. If the source is over 2 MB, decode with the injected
  decoder, scale to fit 1280×720 keeping aspect (never upscale), encode JPEG at
  quality 90, step down to 80 then 70 if still over 2 MB, then run the existing
  `thumbnailFormat` + hash + write path on the re-encoded bytes. Files at or
  under 2 MB are stored byte-identical, as today. The 20 MP guard stays and is
  checked from the header before decode.
- `index.ts` `pickScheduledThumbnail`: pass a `fit` function built on
  `nativeImage` (`resize` + `toJPEG`); picker filter label becomes
  `JPEG or PNG`.
- The backend validators (`validate_thumbnail`, `validate_thumbnail_content`)
  keep the 2 MB cap: stored assets never exceed it.
- Field hint in S2's component drops "up to 2 MB" if it was carried over.

Done when:

- `scheduled-stream-thumbnail` unit tests: a 5 MB PNG fixture generated in the
  test imports to a JPEG under 2 MB with width ≤ 1280; a 1 MB JPEG is stored
  unchanged (same sha256 id); a 60 MB file and a 25 MP image are still refused.
- `pnpm --filter @videorc/desktop test`, `pnpm typecheck`, `pnpm lint`,
  `pnpm smoke:scheduled-streams`.

## Risks

- **Shared project quota.** `thumbnails.set` adds ~50 units per YouTube
  destination per Go Live, on top of the broadcast/stream/bind/transition
  calls. The Google Cloud project's daily quota is shared by every Videorc
  user. Before release, the owner checks current daily usage and the quota
  ceiling in Google Cloud Console → YouTube Data API v3 → Quotas. Not verified
  in this plan.
- **Eligibility 403.** Covered by copy; Go Live is unaffected.
- **Asset missing after a profile move or manual cleanup.** Save rejects it;
  prepare reports it through the event; neither blocks Go Live.
- **Upload lands after auto-start.** Acceptable: the API allows setting a
  thumbnail on a live video.

## Release note (when shipped)

"Livestream: choose a thumbnail in Broadcast info and Videorc sets it on your
YouTube stream when you go live."
