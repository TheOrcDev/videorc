# S4 static avatar contract

Desktop worktree `/Users/orcdev/projects/videorc-wt-249-s4`, base S3 `a93168fc4`.
Web worktree `/Users/orcdev/projects/videorcweb-wt-249-s4`, base S3 `a68454e0`.
Both branches `feat/249-s4-cloud-parity`. Implementation reconciled onto these committed S3 tips. Uncommitted; coordinator publishes.

- `apps/desktop/src/shared/cloud-avatar.ts` mirrors web
  `lib/cloud/program/cloud-avatar.ts`: `AvatarSnapshot` version 1 with show,
  publisherSid (current host PA\_), monotonic revision, output stream/recording,
  orientation h/v, 30s bounded lease, at most two layers (`avatar`, `bubble`).
  Each layer has normalized rect, immutable PNG `{hash,png,width,height}` and
  nullable expiresAt (bubble must expire). 512KiB snapshot, 256KiB base64/asset,
  <=1024x1024 decoded size, SHA256 verification. No persona/private AI fields.
- `cloud-avatar-view.ts` shared DOM renderer uses `AvatarReceiver`: current host
  SID, latest revision, clear beating pending decode, lease/bubble expiration,
  resource release. Monitor and program use the same module. Local preview is
  explicitly separate from egress applied receipts.
- `AvatarCapability` extends existing S3 ConsumerCapability as optional `graphics`:
  `{version:1, output, orientation, applied?:{publisherSid,revision}}`.
  EG\_ only. Relay validates lane from page token/current egress, and host SID.
  No inference of graphics from v2. Guest capability/projection belongs to S6.
- `RoomAvatarPublisher` owns targeted byte streams on
  `videorc.presentation.avatar.v1`. Existing S3 server capability topic/receipts
  authorize consumers. `AvatarContent={h:AvatarLayer[],v:AvatarLayer[],stream,
recording}`; `set(content|null)`, `close()`. Per-room enablement defaults off.
- `TalkShowRoomSnapshot.avatar?:RoomAvatarStatus` exposes state
  off/preview/waiting/applied/failed, reason, revision, preview snapshot and
  per-egress observed revision/output/orientation; productionQualified:false.
- `renderCloudAvatar` in renderer `lib/buddy-overlay.ts` projects existing
  persona/state/public bubble and placement to static PNG layers. S4 only static
  pose; S5 owns full atlas animator/events and should extend this seam rather
  than add a competing registry. Private Sidekick remains desktop-only.
- S4 minimally adds a room-avatar opt-in button and shared raster layer to
  ProgramMonitor in `show-stage.tsx`; S6 owns broader room/guest/monitor layout
  parity and should preserve this layer, consent and truthful status.

No smoke, real-page, device, heavy build/suite or managed qualification runs.

## Downstream integration

S5 owns animation internals/events. Agreed additive integration: optional
`graphics.animation?: 1`, validated atlas metadata on the avatar layer, a
separate bounded motion topic, and an additive `createAvatarView.step()` player
hook. Static fallback remains for consumers without the animation capability.
Atlas bounds must be explicit; the S4 static asset limits must not silently grow.

S6 owns guest consent/projection and broader monitor geometry. `ProgramAvatar`
is a sibling inside the existing monitor frame. Guest delivery is currently
refused by both capability parsers, the publisher's EG-only targeting and the
relay. Extend the existing `graphics` capability/authorized lane and these
checks together; do not infer guest graphics from media v2. The shared receiver
and view are reusable. S6 also owns the stage beacon layout/stage-key fields.

`StageRoom.participantSidOf(identity)` reads the current remote participant map,
returning null between rooms. Each consumer fences snapshots against the current
`host:<show>` SID. `AvatarReceiver` arms its lease before awaiting paint, clears
failed paint, and invalidates all pending work on owner replacement or clear.

Output authorization is a signed page-token `output` claim plus the current
server egress identity/SID and token orientation. Legacy or shared-output tokens
retain health/audio behavior but cannot certify independent graphics. Each
snapshot targets one authorized EG consumer; no private Sidekick state, asset
paths or arbitrary URLs are sent. Public bubble words are rasterized locally.

The renderer-only `buddy.cloud.report` observation is refreshed immediately
when observations change and every five seconds, expires after fifteen seconds,
and is cleared on room loss. Bubble-only admission also requires an enabled
layout and a running applied output; local preview does not authorize AI spend.

Live/managed qualification is not-run. See `249-s4-handoff.md` for exact files,
focused verification and deferred acceptance gates.
