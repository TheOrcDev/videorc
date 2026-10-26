# Banners

A banner is your own image placed anywhere on the picture: a sponsor strip,
"Follow me @handle", a logo, or a full-frame frame with a transparent hole
(plan 186). Banners are free for everyone.

## Using them

- **Import** in Assets → Banners: "Import image…" takes a PNG, JPEG or
  WebP (up to 25 MB and 40 megapixels). Transparency is kept, so a PNG with
  a transparent background works best. Videorc stores a copy whose longest
  side is at most 3840 px and applies a photo's rotation. You can keep 24
  banners; animated images are refused.
- **Sharp sizes**, shown in the Assets description: wide banner 2400 × 400,
  logo 512 × 512, full frame 3840 × 2160. Each is sharp at its default place
  on a 4K recording.
- **Place** on the Scene page: drag or resize a banner on the canvas (its
  shape stays the image's), or use the snaps in its inspector (Top left, Top
  center, Top right, Bottom left, Bottom center, Bottom right, Full frame).
  A press anywhere on a banner's picture grabs it, except a banner that
  fills the canvas (a frame), which is picked by its label or its toolbar
  chip so the sources under it stay reachable. A drag snaps to the canvas,
  the sources and the other banners (never to the highlight, captions or
  Buddy zones); Alt drags without snapping.
  The inspector says how big the banner is drawn on your largest output and
  warns when your image is too small to stay sharp there ("it will look soft
  at this size. Use one at least 2304 × 384 px."). With a vertical
  destination armed, **Overlays on: Vertical** places the vertical stream's
  copy separately.
- **Show and Hide** from the Scene page's Banners section or the inspector,
  and while on air from Stream Manager's **Banners** menu, `/banner <name>`
  or `/banner off` in the chat composer, ⌘K, a Stream Deck **Banner** key,
  the phone remote, or Buddy ("show the sponsor banner", "hide the
  banners"). Up to four banners show at once. Show and Hide fade over
  200 ms (instant on 4K60 recordings).
- **Appears in**: each banner has **Stream** and **Recording** switches,
  both on by default. They follow the same rules as the highlight card and
  the Buddy ([overlays.md](overlays.md)); when a session cannot honor both,
  the Go Live sheet says so ("Recording will include banners while
  streaming vertical.").
- **Timing** (in the inspector, folded): **Hide after** 10 s to 5 min, and
  **Show every** 5 to 30 min, which repeats only while you're recording or
  live ("Shows for 30 s every 15 min"). Showing or hiding a banner by hand
  always wins and restarts its cycle.
- A banner that is showing stays when you switch scenes and after you
  restart Videorc. Banners stay over a takeover and under captions, the
  Buddy and the highlight card. Everything can be changed while recording or
  live except deleting a banner that is showing.

## For developers

### Store and wire

- Backend table `banners` (`storage.rs`), managed files `Banners/<id>.png`
  and `<id>.thumb.png` beside `Screens`; the renderer gets basenames only
  and shows them through `videorc-asset://banner/<file>`
  (`shared/banner-assets.ts`, main's `resolveManagedBannerFile`).
- `crates/videorc-backend/src/banners.rs`: import (sniff, animated refusal,
  limits, EXIF, premultiplied Lanczos3 downscale, atomic write, thumbnail),
  validation, `banner_default_places`, `banner_draw_rect` (the one geometry
  oracle), the leg plan per banner (`banner_leg_carries`), `show_banner`
  (cap, 160 MB prepared-bitmap budget, the after-start refusal) and
  `on_banners_changed`, where every mutation ends: install into the
  compositor, recompose the legacy overlay frame, emit `banners.changed`,
  wake the timers.
- RPCs `banners.list | importImage | update | reorder | delete | show |
hide` and the event `banners.changed`; `importImage` runs on the
  `AssetImport` lane, `show` and `hide` on `LiveControl`. Strict schemas in
  `shared/backend-rpc-contract.ts`; the wire example is
  `protocol-fixtures/high-risk-contracts.json` → `banner`.
- Geometry is pinned by `protocol-fixtures/banner-geometry.json`, which Rust
  (`banner_draw_rect`) and TS (`shared/banner-geometry.ts`,
  `bannerDrawRect`) both reproduce exactly.

### Drawing

- `CompositorRuntime.banners` is one `Arc<BannerSet>` at snapshot level,
  shared by the idle preview and both legs; `install_banner_set` swaps it
  and touches nothing else. `banner_draws_for_leg` derives each leg's draws
  per tick (leg plan, 200 ms ease-out fade, prepared bitmap).
- `banner_prepare.rs`: off-thread prepare to the exact contained pixel size
  per canvas, opacity baked, BGRA, in a 160 MB LRU cache; until a prepare
  lands the last bitmap is drawn.
- Metal: blended quads from key-addressed textures in namespace 9 (four
  slots), uploaded once per prepare (`push_banner_gpu_sources`). CPU:
  `composite_banners`, a true straight-alpha 1:1 blend. Windows D3D11
  media session: image layers at z 6 to 9 (`windows_d3d11_session.rs`).
  Legacy FFmpeg graph (4K60, bridge off): banners composed into the
  takeover's full-canvas RGBA FIFO frame (`legacy_overlay_frame`); a session
  without that FIFO, or the direct D3D11 recording, refuses a banner shown
  after it starts. Electron proof surface (Windows idle and Linux
  previews): `main/preview-surface-banners.ts`.
- Z order on every path: scene, takeover, banners, captions, Buddy,
  highlight card.
- Scene editor drafts with the stage id `banner:<id>` move the banner's
  picture live on the idle macOS preview.

### Controls

- Renderer state: `useStudioBanners()` (`hooks/use-studio.tsx`), refusal
  copy in `lib/banners.ts`, Assets section `components/banners-section.tsx`,
  Scene `components/scene/banner-inspector.tsx`, size advice
  `lib/banner-size.ts`, snaps `lib/banner-place.ts`, Go Live sentences
  `lib/banner-start-notices.ts` (Rust twin: `overlay_start_notices`),
  timing `lib/banner-timing.ts`.
- Stream Manager relays through main (`comments-window:banner*`); the
  composer grammar is `shared/banner-commands.ts`; ⌘K's Banners group is in
  `components/command-palette.tsx`.
- Remote intents `bannerShow`, `bannerHide`, `bannerToggle` with
  `describe.banners` ([remote-control.md](remote-control.md)); the phone and
  the Stream Deck use them.
- Timers: `banner_timers.rs` (a pure book plus one process task woken by
  every banner change).
- Voice: `cohost_command.rs`, banner phrases parsed before the highlight
  grammar ([buddy-commands-contract.md](buddy-commands-contract.md)).

### Tests and smokes

- `cargo test -p videorc-backend banner` (store, import, geometry, leg
  plan, fade, budget, timers, legacy frame, D3D11 layer geometry),
  `cpu_and_metal_draw_the_same_banner` and
  `metal_uploads_a_banner_once_across_120_ticks` (Metal-gated, run on a
  Mac), and the TS tests beside each file above.
- `pnpm smoke:banners` drives the dev app through recordings and a local
  stream with banners shown, moved and hidden, and checks the pixels in the
  artifacts; it is part of `pnpm smoke:recording-studio`.
