# Plan 249 media v2 integration contract

Stable S3 contract for parallel S4, S7a and S16 implementation. S3 is uncommitted;
the coordinator will supply paired commit/PR revisions. Do not edit the S3
worktrees. Base dependent work on its own isolated S2 tree, then reconcile S3
before publishing a dependent PR. All live qualification is **not run**.

## Owned interfaces

Desktop sources (root `/Users/orcdev/projects/videorc-wt-249-s3`):

- `apps/desktop/src/renderer/src/lib/room-media-v2.ts`: exact role manifest,
  `ConsumerCapability`, `CapabilityReceipt`, parser and freshness predicate.
- `room-aux-publisher.ts` in that directory: `RoomAuxPublisher(room, enabled=false)`,
  `enabled`, `refresh()`, `close()`; owned by `TalkShowRoomClient` per room.
- `room-aux-sink.ts`: independent stereo soundboard Web Audio destination.
- `soundboard-store.ts`: `roomAux` status and `setRoomAuxEnabled(boolean)`.
  Consent defaults off per room; reconnect preserves consent, revalidates peers.

Web sources (root `/Users/orcdev/projects/videorcweb-wt-249-s3`):

- `lib/cloud/program/room-media-v2.ts`: same manifest/parser; mirrored JSON in
  desktop `protocol-fixtures/cloud-parity-media-v2.json` and web `tests/fixtures/`.
- `lib/cloud/room-media-relay.ts`: authenticated callers invoke
  `relayMediaCapability(relay, show, authorizedIdentity, capability, now)`.
- `StageRoom.consumer()` returns `{identity, participantSid}` or null;
  `StageRoom.auxiliarySid()` returns the current subscribed host aux SID or null.
- `StageTrackSource` adds `auxiliary`; `stageWantsTrack` routes it regardless of
  screen/stage selection. Guest `Remote.audio` is an array of
  `{sid, track, auxiliary}`, never one last-wins audio track.

## Pinned wire

`ROOM_MEDIA_VERSION = 2`. Exact auxiliary role:

```json
{
  "version": 2,
  "auxiliary": {
    "name": "videorc:v2:host-aux:stereo",
    "source": "screen_share_audio",
    "channels": 2,
    "speechProcessing": false
  },
  "productionQualified": false
}
```

Guest/program capability body:

```ts
{ v: 2; identity: string; participantSid: string;
  auxiliary?: { trackSid: string; rms: number; observedAt: number } }
```

V2 means the loaded page supports this auxiliary role. `auxiliary` above is an
optional fresh decoded-audio observation, not an enable flag. V2 alone does NOT
advertise avatar/graphics/PCM/provider support. Unknown fields are discarded.
S4 needs an independently validated graphics capability extension, with its own
explicit version/enablement. Coordinate that extension after S3; do not fork or
replace this negotiation or infer graphics support from v2.

Guest POST `/api/guest/[slug]/media`: `{show, capability}` with existing HttpOnly
cookie. Same-origin, own admitted guest/show/invite/current participant SID,
1024-byte bound, separate IP budget and 30/min participant relay budget.
Program capability rides the existing authenticated beacon; accepted boot/seq,
page-token orientation, current egress identity and participant SID must match.
No LiveKit grants change. Server-only topic `videorc.media-capability.v2`, targeted
at host, carries the sanitized capability plus server `at` timestamp.
Host rejects participant-originated data. Receipt TTL: 25 seconds.

Before aux publication, every active consumer must have a current v2 receipt.
Host permissions use current participant SIDs and explicit allowed track SIDs;
unknown/new sessions cannot receive aux. Missing/stale consumers stop the source
and unpublish. Old loaded pages stay incompatible after deployment until they
reload/rejoin. Program assets retain the existing `/cloud/program/v1/` URL;
loaded media capabilities, not URL/deployment version, establish support.

## Lifecycle and extension boundaries

- Backend sound voice IDs remain authoritative. One stereo aux publication,
  independent microphone and monitor. New epochs skip existing one-shots and
  join loops at phase. Async decode/publication is fenced before replacement.
- `roomAux`: `enabled`, `state` (`off|blocked|queued|published`), `reason`,
  `queuedVoices`, `trackSid`, `observed` per consumer, `productionQualified:false`.
  Native `onAir` is not fabricated. No RMS receipt means audibility unconfirmed.
- S4 owns graphics transport/rendering and independent graphics capability;
  S3 owns soundboard audio. Do not mix avatar speech into aux without a separately
  commissioned producer contract. Extend both parser copies/fixtures/relay and
  emitted modules together after reconciling S3.
- S7a owns the bounded native PCM microphone bridge. It must supply the separate
  microphone lane in `TalkShowRoomClient`; never capture speakers/system sound
  or reuse the soundboard sink. No PCM bridge interface is claimed by S3.
- S16 owns provider lifecycle. No provider/publisher capability is inferred from
  this media version or from a room receipt. Preserve consent/cost gates.
- S2 privacy gates/epochs/observations remain separate and unchanged. S8 owns
  deliberate speech/aux takeover routing; independent web PR #118 is not merged.
- All source/generated web modules must match via the maintained emitter.
  Smoke/real-page/device/heavy/managed qualification remains deferred.
