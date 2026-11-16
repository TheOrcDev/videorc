# Plan 249 S9 static graphics contract

Status: authored and focused-tested; real-page, managed and device qualification not-run. Reconciled onto published S6 desktop f27307cd97400b6933ac2324de3c6baffab5dfaf and web b615c28b13997128c50edecae5d03f583a7cb32f. S9 never implies S10 alpha transport, S5 animation or guest support.

## Negotiation and authorization

S3's existing consumer capability/receipt is the only negotiation. S4's optional `graphics` gains `static: {version: 1, applied?: {publisherSid, revision}}`. Version 2 alone or `graphics.version: 1` alone does not authorize static pixels. The server checks the actual token-authorized output (`stream`/`recording`) and orientation (`h`/`v`), current EG participant SID, beacon sequence and current host SID. Stale avatar and static applied observations are removed independently. Removing an avatar acknowledgement preserves other sanitized extension fields, including S5 animation after reconciliation.

The room graphics toggle defaults off, independently of avatar/audio. Delivery uses targeted LiveKit byte streams to current authorized EG consumers only. S9 has no static guest lane and adds no production grants. S6 separately supports opted-in avatar/bubble graphics on the guest stream/h lane; the relay removes static capability claims from guests and the S9 publisher independently rejects guest targeting. Private Sidekick state, raw chat history, paths and arbitrary URLs are never serialized. Curated public chat/card pixels and user-imported image banners are the sole sources. HTML banners return an explicit unsupported reason; no HTML executes in the cloud page.

## Snapshot and resources

Topic: `videorc.presentation.static.v1`. Snapshot fields are `version:1`, `show`, `publisherSid`, monotonic `revision`, `output`, `orientation`, absolute `expiresAt`, and `layers`. Each layer is `{id, kind, rect, asset, opacity, fade, expiresAt}`:

- `kind`: banner, chat or highlight. At most four banners, one chat and one highlight.
- `rect`: existing normalized OverlayRect `{x,y,w,h}` fractions. Native `banner_draw_rect` and `overlay_blit_layout` calculate pixel placement before normalizing. No competing geometry system.
- `asset`: immutable SHA256, inline static PNG, width and height. No URLs or APNG. At most 1 MiB base64 per image, maximum dimension 1920 and area 1920×1080. Whole wire message at most 6 MiB.
- `opacity`: native banner opacity, applied once over straight-alpha pixels. Chat/card opacity is one.
- `fade`: null or native banner `{at,from,to}` using the absolute 200 ms ease-out cubic. Late joins use the current phase instead of restarting a transition.
- Layer expiry is absolute; highlights require expiry. Snapshot leases are at most 30 seconds; refresh sends a new revision before expiry.

One decode batch and one latest pending snapshot are retained. Superseding snapshots release the older pending request; full clears bypass decoding and defeat stalled sets. Owner loss, lifecycle generation changes, lease expiry and paint failure clear resources/acknowledgements. Hashes and PNG dimensions are checked before browser decode; decode has a five-second deadline and paint acknowledgement has a three-second deadline. The page authenticates before reading, bounds reads to two regular streams plus one small clear, and limits normal arrival rate. Applied observations follow two frame callbacks and are independent for each egress lane. They do not certify encoded/managed output.

## Desktop adapter and output facts

Renderer-only `cloud.graphics.snapshot({showId,known?})` returns `{signature,content}`; unchanged signatures return null content. Local content carries H/V arrays and per-layer stream/recording booleans. The publisher strips those flags and excluded pixels before constructing each targeted lane snapshot. PNG encoding runs off the async executor. Polling is single-flight with event invalidation and one coalesced refresh; obsolete source results cannot replace newer state.

The source clones native banner state, chat raster slots, card slots and layout. It uses existing native geometry, fades, bitmap preparation and output flags. Highlights are fenced to the current room generation, public message eligibility, matching session and existing card-clear generation. Chat set/clear has an independent preparation generation. Cloud recording-only and live output facts activate chat painting and banner timers; open-only still permits graphic preview. Highlight target canvases are H 1920×1080 and V 1080×1920 while a room is open. A managed card uses the targeted static path, so hidden/record-only cards cannot leak through the legacy broadcast topic. Legacy node transport remains available.

## Layer ownership and downstream seams

The native order is banners, captions, chat, avatar, bubble, highlight; hold remains above the program. S9 owns the banner/chat/highlight roots. The Program preview uses sibling roots inside the aspect-video frame, with S4 avatar between chat and highlight. Captions remain their owner's layer; fixed highlight geometry continues to own its rect and does not yield to chat/banner overlaps. Caption integration must retain the existing native `overlay_collision_inset` rule; S9 does not introduce another collision policy.

S6 owns stage geometry, badges, applied stage key and guest policy. Its stage acknowledgement is not the static graphics acknowledgement. The reconciliation preserves S6 `programPreviewStage` header/badge and default-off guest-avatar opt-in. S5 owns atlas/motion internals and its additive animation capability; no S5 files are copied from an uncommitted worktree. S10's experimental GPU view may later attach at the banner root but remains disabled and separately qualified; static support never implies dynamic alpha.

## Maintained acceptance

`pnpm smoke:cloud-parity -- --case graphics` is a real acquisition path through the desktop RPC/publishers and four emitted H/V stream/recording pages. It imports authorized PNG fixtures, inspects alpha/opacity/reordering and native card placement, samples overlapping card pixels, observes native fade timing, runs record-only Hide after/Show every timers, paints fake local chat/emotes and milestone cards through the real painter, tests each output switch, reloads for late join and stalls decoding to test clear precedence. Phase screenshots are decoded with FFmpeg and finalized browser video artifacts must contain the marker. The harness does not build and uses local fixtures only. It has been syntax/pure-unit checked, never executed for this handoff. Managed/provider/device acceptance remains not-run.
