# Plan 249 S11 frozen contract (sandboxed HTML banners in the cloud room)

Owner: S11 thread G1wkh. Desktop `/Users/orcdev/projects/videorc-wt-249-s11`,
web `/Users/orcdev/projects/videorcweb-wt-249-s11`, branch
`feat/249-s11-cloud-parity` in both, each stacked on S24's published tip
(`publish/249-s24-on-main`: desktop `7c2e0ed51`, web `db7ce88e5`).

S11 is **gated production wiring**, not runtime parity. S10's packed alpha
transport is unqualified (`docs/acceptance/249-s10-alpha-feasibility.md`), so
nothing here may be enabled or described as qualified. HTML keeps executing
only in the desktop's existing locked-down offscreen windows; the cloud never
runs user HTML and never plays its audio.

## 1. The gate (one authority: the web)

- Web `lib/cloud/program/html-layer.ts` exports
  `HTML_LAYER_PRODUCTION_QUALIFIED = false`. No environment variable can change
  it.
- The signed page token (`lib/cloud/media/page-token.ts`) gains an optional
  claim `layers: { html: 1 }`. `verifyPageToken` accepts exactly that shape or
  its absence. Production mint sites (`destinations.ts`, `recording.ts`) add
  it only through `htmlLayerTokenClaim()`, which returns nothing while the
  constant is false. Only a test or the loopback fixture mints it directly.
- The beacon route answers `htmlLayer: true` only when the token carries the
  claim **and** the token's `output` lane matches the beacon's. The program
  page builds its HTML layer consumer, advertises the capability and accepts
  manifests only while the newest answer says so.
- The capability relay strips `html` from a page's capability unless the same
  condition holds. The desktop publishes a sheet only to `EG_` pages whose
  relayed receipt carries `html` for that lane. With the constant false, no
  page is ever offered an HTML layer and the desktop publishes nothing.
- Desktop `HTML_LAYER_PRODUCTION_QUALIFIED = false` is reported in status
  only; the desktop never enables itself.

## 2. Names and limits (shared, mirrored in desktop and web)

Desktop `apps/desktop/src/shared/cloud-html-layer.ts`, web
`lib/cloud/program/html-layer.ts` (emitted as `html-layer.js`). Both import
S10's packing (`alphaDimensions`, `packedSize`, `ALPHA_LIMITS`); there is no
second transport.

| Name                     | Value                                                                    |
| ------------------------ | ------------------------------------------------------------------------ |
| `HTML_LAYER_ROLE`        | `videorc:html-layer:v1`                                                  |
| Track name               | `videorc:html-layer:v1:<h\|v>:<generation>`                              |
| `HTML_LAYER_TOPIC`       | `videorc.presentation.html.v1` (host → `EG_` pages, byte stream)         |
| Sheet (logical)          | H 640×360, V 360×640 (S10 limits; packed 1288×360, 728×640)              |
| `HTML_LAYER_LIMITS`      | 4 layers, 2 publications, 15 fps (≤ S10's 30), lease 30 s, renew 10 s, manifest ≤ 16 KiB, frame ≤ 1920×1080 BGRA |
| Publication              | `Track.Source.Camera`, VP8, no simulcast, ≤ 2.5 Mbps, ≤ 15 fps           |

The sheet is the whole stage at the sheet's logical size. A layer is a
normalized rect on it. Fidelity is S10's: full-resolution HTML needs fresh
measurement.

## 3. Capability, manifest and authority

Capability (page → relay → host), `EG_` only, inside media-v2's
`ConsumerCapability`:

```ts
html?: {
  version: 1
  output: 'stream' | 'recording'
  orientation: 'h' | 'v'
  applied?: { publisherSid: string; trackSid: string; generation: number; revision: number }
}
```

Manifest (host → one `EG_` page, on `HTML_LAYER_TOPIC`):

```ts
type HtmlLayerManifest = {
  version: 1
  role: 'videorc:html-layer:v1'
  show: string
  publisherSid: string // PA_…, the host participant
  trackSid: string // TR_…, the sheet publication
  generation: number // ≥ 1, fixed for the publication
  controllerEpoch: number // S24 epoch held when published; 0 = never claimed
  revision: number // grows with each layer-set change
  output: 'stream' | 'recording'
  orientation: 'h' | 'v'
  width: number; height: number // the orientation's sheet
  fps: number // ≤ 15
  packing: 'rgb-left-alpha-right'
  expiresAt: number // ≤ now + 30 s
  layers: Array<{ id: string; rect: { x: number; y: number; w: number; h: number } }> // 0..4
}
```

The page authorizes a manifest from **SFU facts**, never from its words or a
track name alone: the sender is `host:<show>` and its current participant SID
equals `publisherSid`; that participant has a CAMERA publication with
`trackSid` whose name is exactly the track name for `orientation` and
`generation`; the lane is the page's own; the page's gate is open; the lease is
current. `show`, `publisherSid`, `trackSid`, `generation` and
`controllerEpoch` never change within one consumer: any change, a host SID
change, the publication going away, an expired lease, a closed gate or a GPU
failure closes it. A new generation opens a new consumer.

The page draws only inside the manifest's layer rects (the sheet is cropped
per rect into a 2D canvas over the stage, in the S9 banner slot). Pixels
outside them, including another lane's layers, never reach its output.

## 4. Desktop source and ownership

- **Targets without a fake recording.** The renderer calls
  `cloud.htmlLayers.want { showId, want }` while it has at least one current
  `html` receipt. The backend then adds the fixed room canvases (1920×1080 and
  1080×1920, S9's) to `HtmlOverlayView` while that show's managed room is
  active. No capture session, run id or recording starts. `want: false`, a
  room change or backend restart removes them.
- **Frames.** The renderer reads each layer's latest frame from the existing
  token-gated `/preview/html-overlay/latest.bmp` route, with one request in
  flight per layer, `afterSequence` (204 when unchanged), a size cap and at
  most the sheet's fps. Decoding is `createImageBitmap` (off the main thread).
  Opacity and the 200 ms fade are applied when the layer is drawn into the
  sheet. S10's `createAlphaGpu(…, 'pack')` packs the sheet, and
  `captureStream(0)` + `requestFrame()` publishes it.
- **Sheets.** One sheet per orientation and distinct layer set that a current
  receipt asks for; lanes with the same set share it. More than two sheets:
  the extra lanes are refused (`html-publication-limit`) and nothing else
  changes. A sheet with no layers is unpublished (hidden layers coalesce to
  nothing).
- **Ownership (S24).** The publisher lives inside `TalkShowRoomClient` like
  the S9 graphics publisher: it runs only while the client owns its room
  (`#owns`) and the desktop is not holding devices for another controller
  (`devicesHeld`). Its manifests carry the S24 `controllerEpoch`. Disconnect,
  reconnect, lost ownership (duplicate identity, removal) and an epoch change
  (which rejoins) close it: tracks unpublished, streams stopped, GPU objects
  released, `want: false` sent.
- **Sandbox unchanged.** HTML windows keep no preload, no network beyond their
  own scheme, muted audio and the same CSP. S11 adds no window option, IPC
  channel or preload.

## 5. Role readers (an HTML sheet is never a camera)

`isHtmlLayerTrackName(name)` marks the publication as an HTML sheet. Every
reader that classifies by CAMERA source excludes it:

- web program `source.ts` (`sourceOfPublication` → `"html-layer"`; `cameraOff`)
  and `stage.ts` (`stageWantsTrack` never wants it; only the consumer does);
- the guest page (`use-guest-connection.ts` subscriptions and remote camera);
- server `toManagedParticipant` (`livekit-api.ts`);
- the desktop's own local camera lookups in `talk-show-room.ts`.

S22's ISO roles (`lib/cloud/iso/roles.ts`, web PR #143) must exclude it the
same way before HTML layers can be qualified (see the handoff).

## 6. Acceptance (authored, not run)

`pnpm smoke:cloud-parity -- --case html` drives the real desktop app with
the existing `scripts/fixtures/html-overlay/animated-badge` fixture (opaque
magenta, half-alpha cyan, a hole that turns green if the network is reached,
yellow/blue alternation), the real web program page for H stream and H
recording over local LiveKit, and a fixture-minted page token with the
`html` claim. It checks the four blocks in the page's decoded output before
Show and after Hide, the hole staying transparent, denied network requests,
bounded publications (≤ 2), windows and frames, and cleanup on Hide, room
close and controller takeover. It never runs against a managed provider.
