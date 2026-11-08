# Overlays: highlight card, captions and the Buddy

Three things are drawn over your picture during a session: the highlighted
comment card, the caption bar and the Buddy (plan 164, Phase B and C). Each
is an **overlay item** with a place per orientation and two switches, **Show
on stream** and **Show in recording**. Placement has one home, the Live
Scene canvas; the Stream Manager's corner menu is a shortcut that writes the
same place.

## The three items

| Item      | What it is                                                                          | Default place       | Default switches (stream / recording)                                    |
| --------- | ----------------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------ |
| Highlight | The highlighted comment card ("show on stream" in Stream Manager, voice, auto-show) | Bottom left corner  | on / on                                                                  |
| Captions  | The live caption bar; its width is the rect, style and size stay in Captions        | Bottom, centred     | off / off (captions off burn nothing; the switches replace `burnTarget`) |
| Buddy     | Your Buddy and its speech bubble ([buddy.md](buddy.md))                             | Bottom right corner | off / off (opt-in)                                                       |

A place is a normalized rect, `x y w h` in canvas units (0 to 1), one for
the horizontal picture and one for the vertical one. The smallest side a
rect may have is 0.02. Default sizes: highlight 0.60 × 0.26 horizontal and
0.78 × 0.20 vertical; captions 0.92 × 0.16 and 0.76 × 0.14; the Buddy a
square in pixels, 0.18 wide horizontal and 0.32 wide vertical. Snaps keep a
4% margin on a landscape canvas and the portrait safe area (8% top, 22%
bottom, plan 077) on a vertical one.

The renderer rasterizes each item to its rect's width; the bitmap keeps its
pixel size and is placed inside the rect by a gravity rule: a rect whose
centre is in the lower half hugs its bottom edge (a caption bar grows
upward, a corner card keeps its margin), and its horizontal content hugs
the left, the centre or the right by where the rect's centre sits. A
bitmap wider than the rect is centre-cropped. So the three old placements
(left corner, centred bar, right corner) fall out of the rect alone.

## The Preview shows the program

The program is what goes out: every layer at least one running output
carries. While nothing runs, it is every layer with a switch on. Hidden
banners and items with both switches off are never drawn. Clips keeps what
a recording would, using each item's **Show in recording** switch.

| What runs                         | The Preview draws the item when | The primary leg burns it when |
| --------------------------------- | ------------------------------- | ----------------------------- |
| Nothing (Clips off)               | either switch                   | either switch (no output)     |
| Clips only                        | either switch                   | Show in recording             |
| Record only                       | Show in recording               | Show in recording             |
| Stream only                       | Show on stream                  | Show on stream                |
| Record + stream, one shared leg   | either switch                   | either switch                 |
| Record + stream, split stream leg | either switch                   | Show in recording             |
| Record + vertical stream          | either switch (horizontal)      | either switch                 |

The Preview shows the program in every row. On macOS, the native Preview
presents the primary leg's IOSurface whenever that leg is the program. In
the two rows where it is not (Clips at idle, and a split record + stream)
and some item is in the program but not on the primary leg, the run
composes the Preview's own picture, the **program leg**, after the encoded
legs in the same tick: the same snapshot (the Scene editor's draft and
chrome included), the same sources, the same live background frame and
the program's items, at the primary's canvas, so every prepared bitmap is
the one the legs already hold. The Preview lease and the pixel oracle
present that picture while it is current; the ring, the recording and the
stream are untouched. While the primary leg is the program nothing extra
runs on the GPU. `compositor.status.framePipeline.previewProgramLeg` says
when the program leg is on; `VIDEORC_PREVIEW_PROGRAM_LEG=0` keeps the
Preview on the primary leg (a measurement and support switch, said in
the log). The pure trigger is `preview_needs_program_leg` in
`compositor.rs`. The verdict travels with the run: a Clips arm in place
carries it on `CompositorArmParams`, and a run the ring starts for itself
(a cold launch arms the ring before the Preview's run exists, logged as
`recording-compositor-restarted`) carries it on `CompositorStartParams`
with `replay_only`, so that run plans the program idle too.

## Placing them: the Live Scene canvas

The canvas (Studio → Scene) draws the three items as labelled dashed rects
over the sources, the Buddy with its still in the square its pet fills
(dimmed while both switches are off). Drag or resize one like a source; a
released gesture is one save, and the item stays where it was dropped
until that save lands. On the live canvas (macOS, the preview docked into
the Scene tab) the idle picture draws Buddy whenever either output switch is
on, with Clips off. Selecting or dragging an off Buddy never draws it. The
highlight card and the caption bar have nothing to draw until a session;
their frame shows the zone. With the preview floating in its own window,
the canvas is the schematic and that window follows each drag. Click one
to open its inspector on the right:

- **Show on stream** and **Show in recording** switches.
- **Snap** for the orientation on the stage: Top left, Top right, Bottom
  left, Bottom right, Bottom centre. A snap writes the item's default size at
  that position.
- For captions, style and size stay in the Captions panel; the panel points
  here under "Placement and output".

When the switches differ, the item's label carries a **stream only** or
**recording only** badge. The docked native preview shows the program, so
a stream-only item appears there during a split and under Clips at idle
(the program leg above), in the place it will appear on the stream.

When a vertical destination is armed (dual-orientation streaming), an
**Overlays on** control above the stage switches between Horizontal and
Vertical. Vertical shows the derived vertical scene with the vertical rects
editable. Sources have no per-orientation layout; only overlay rects do.

The Stream Manager's corner menu for the highlight card is a **snap**: it
writes the highlight rect on both orientations and the layout re-sends a
live card. The old `highlightAnchor` pref is migrated once, on the first
launch after the update, into the layout (only when nobody has placed the
highlight yet), and then deleted.

The Buddy pane in Stream Manager has its own **Show on stream** switch; it
writes the same layout.

## Which output carries an item

A session composites at most two program legs: the **primary** (the
recording, and every horizontal stream destination) and one **auxiliary**
(either a split horizontal stream leg beside a clean recording, or the
vertical leg of a dual-orientation stream). The auxiliary leg is decided by
the encoder topology, never by an overlay. One pure function,
`overlay_leg_plan(record, stream, aux_leg, show_on_stream,
show_in_recording)`, says where each item burns (D12):

| Session         | Auxiliary leg         | Primary burns when                  | Auxiliary burns when | Needs a split |
| --------------- | --------------------- | ----------------------------------- | -------------------- | ------------- |
| Idle            | any                   | never                               | never                | no            |
| Record only     | any                   | `showInRecording`                   | never                | no            |
| Stream only     | none or split         | `showOnStream`                      | never                | no            |
| Stream only     | vertical simulcast    | `showOnStream`                      | `showOnStream`       | no            |
| Record + stream | none, switches agree  | the shared value                    | never                | no            |
| Record + stream | none, switches differ | `showInRecording`                   | `showOnStream`       | **yes**       |
| Record + stream | split stream leg      | `showInRecording`                   | `showOnStream`       | no            |
| Record + stream | vertical simulcast    | `showInRecording` or `showOnStream` | `showOnStream`       | no            |

Why the last row: the recording and the horizontal stream share the primary
leg's pixels, so the primary burns if either switch wants it.

A split (a second encode, "Recording" plus "Stream") is forced only by
captions with a stream-only burn, exactly as plan 077 shipped it
(`force_same_profile_split`). For the highlight card and the Buddy a
"needs a split" row is logged (`overlay leg plan`, `needs_split`) and then
resolved by the fallback below: whatever either switch wanted lands on the
one shared leg. A session that already runs a split (for captions or a
different stream profile) honours both switches of every item.

A third encoded leg is never started.

## When both switches cannot be honoured (D13)

Every impossible pair is decided before start and shown in the Go Live
sheet under the destinations, with the item's name, never silently. The
same sentence is written to the session's health log (`overlay-start-notice`,
info) when the session starts. The sentences, word for word:

| Session                            | Switches                                  | Sentence                                                                                                                    |
| ---------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Record + stream, one shared encode | stream on, recording off (or the reverse) | "Both the stream and the recording will include highlights: this computer shares one encode for them."                      |
| Record + stream, one shared encode | same, for the Buddy                       | "Both the stream and the recording will include the Buddy: this computer shares one encode for them."                       |
| Record + dual-orientation stream   | stream on, recording off                  | "Recording will include highlights while streaming vertical." (also "... captions ..." and "... the Buddy ...")             |
| Record + dual-orientation stream   | recording on, stream off                  | "The horizontal stream will include highlights while streaming vertical." (also "... captions ..." and "... the Buddy ...") |

Captions on one shared encode get no sentence: they keep the plan 090
behaviour (below). A session with a split stream leg needs no sentence.

Sentences are built from the item's mid-sentence label: `highlights`,
`captions`, `the Buddy`. The renderer (`lib/overlay-layout.ts`) and the
backend (`overlay_layout.rs`) build them byte for byte the same; a test on
each side pins them.

## Banners (plan 186)

Banners ([banners.md](banners.md)) reuse this model: each banner has a
horizontal and a vertical rect and the two switches (labelled **Appears
in: Stream / Recording** on a banner, because a banner also has Show and
Hide), and each banner's legs come from the same `overlay_leg_plan` with
the same shared-leg fallback as the highlight card and Buddy. A showing
banner follows the program at idle, like Buddy. Banners are a list, stored
in their own `banners` table rather than in `overlayLayout`. All
showing banners count as one item in the Go Live sheet, labelled
`banners` ("Recording will include banners while streaming vertical.").

## Weak Windows (plan 090)

When the output check proves a machine cannot run two encodes (the probe's
effective bridge is `raw-yuv420p`), Go Live re-plans one shared encode for
the recording and the stream. Then:

- **Highlight and Buddy**: burn on both outputs when the switches differ,
  with the "shares one encode" sentence above in the Go Live sheet (owner
  answer 4). Go Live is never blocked for them.
- **Captions**: today's block, unchanged. Captions burned into the stream
  only need a clean recording beside a captioned stream, which one encode
  cannot give; the sheet says so and Go Live waits for you to change the
  captions switches. Captions that are off never block a start.

## Changing things mid-session

Saving the layout while a session runs (`overlays.layout.set`) re-plans the
highlight and Buddy legs for the running session and swaps the compositor
flags in place (`compositor::update_overlay_flags`); new rects travel with
the next push of each overlay, so a drag on the canvas moves a live card.
Captions keep their start-time plan: their burn target is a session
parameter, pre-armed with its leg. The Windows D3D11 pump keeps its
start-time overlay input; a mid-session change there is said in the log,
not hidden. A new session always reads the stored layout at start.

Captions keep `burnTarget` on the wire for one release (D14). It is derived
from the captions item's switches: on/on = `both`, on/off = `stream`,
off/on = `recording`, off/off = `off` (`lib/captions-output.ts`,
`burnTargetFromOverlaySwitches`). The first layout after the update is
seeded once from a saved target that was on, so nobody loses it. The old
`position: top | bottom` picker is gone; the rect is the position.

## How a rect reaches the picture

The rect rides with every overlay push:

- `comments.highlight.set {pngBase64, anchor, rect?, verticalPngBase64?,
verticalRect?}`: the card, rasterized by `lib/comment-highlight.ts` per
  canvas the session burns (`comments.highlight.canvases`).
- `captions.overlay.set {pngBase64, position, rect?, target, styleRevision}`:
  the bar, rasterized to at most the rect's width in pixels.
- `buddy.overlay.set {target, pngBase64, rect}`: the Buddy's bubble only,
  rasterized by `lib/buddy-overlay.ts` to the rect's width (plan 168). The
  backend draws the pet itself from a pre-scaled atlas
  (`buddy_sprite.rs`): a square the rect's width, centred on the rect and
  resting on its bottom edge (hanging from its top edge in the upper half),
  and anchors the bubble's bottom-centre above the pet's head
  (`buddy_bubble_blit_layout`). Without a pet frame (smokes, tests) the
  bubble blits inside its rect like any overlay; a missing rect falls back
  to the Buddy's bottom-right snap. `buddy.overlay.clear {target?}` drops it.

One oracle places a bitmap on a canvas for all three render paths:
`overlay_layout::overlay_blit_layout(overlay_w, overlay_h, canvas_w,
canvas_h, rect, safe_inset)` returns the source crop and the destination
pixel position. `safe_inset` lets a yielding overlay step inside its rect
(the caption bar above a card).

- **CPU** (`render_compositor_yuv420p_frame`): blits at the oracle's
  position.
- **Metal** (`try_gpu_compose_with_chrome`): places each overlay as a source
  quad at the oracle's position; the auxiliary leg has its own GPU
  compositor.
- **Windows D3D11** (`windows_d3d11_overlay_layer_geometry` in
  `windows_d3d11_session.rs`): turns the oracle's pixels into the layer's
  normalized transform and crop. The direct D3D11 recording path (no
  overlays) is never chosen when an overlay burns.

Z order on every path: banners (over the scene and any takeover; plan 186),
then captions, then the Buddy (its pet, then its bubble),
then the highlight card. The pet is one turned, linearly sampled quad per
leg: a bilinear inverse-affine blit on the CPU, a key-addressed texture
(namespace 7) with corner vertices on Metal, and a `BuddySprite` layer
turned in `SceneVs` on D3D11 (clipped, never squashed, at the canvas edge);
`cpu_and_metal_draw_the_same_sprite` pins CPU and Metal parity.
The card is the most urgent thing on screen, so it wins an overlap (owner
answer 7). Parity fixtures pin it: `cpu_and_metal_blit_the_same_overlay_rect`
(the Buddy overlapping the card's bottom right, the card wins) and the
Windows mirror `windows_overlay_frames_stack_the_buddy_between_captions_and_the_card`
(Windows CI).

## For developers

- Store: `app_settings` row `overlayLayout`, backend-owned
  (`crates/videorc-backend/src/overlay_layout.rs`, `OverlayLayout {highlight,
captions, buddy}` of `OverlayItemLayout {horizontal, vertical,
showOnStream, showInRecording}`). An invalid stored layout falls back to the
  defaults with a warning. A sibling row `overlayLayoutMigration` records the
  one-time `highlightAnchor` migration, so the wire shape (strict,
  `allowUnknown: false`) never carries bookkeeping.
- RPCs: `overlays.layout.get` (observation), `overlays.layout.set` (mutation,
  the whole object, validated: finite, inside 0..1, sides ≥ 0.02) and
  `overlays.layout.migrate_highlight_anchor {anchor}` (mutation, idempotent;
  main calls it once and deletes its pref on success). Event
  `overlays.layout` carries the saved layout to every window.
- Session plumbing: `OverlaySessionShape {record_enabled, stream_enabled,
aux_leg}` → `overlay_session_plans` (highlight and Buddy, D13 fallback
  applied) feeds `highlight_overlay_on_{primary,aux}` and
  `buddy_overlay_on_{primary,aux}` on `CompositorStartParams` / `ArmParams`
  / `LoopConfig`; `overlay_layout_needs_split` is logged; `overlay_start_notices`
  is emitted at start and mirrored in the Go Live sheet
  (`overlayStartNotices` in `lib/overlay-layout.ts`, rendered by
  `go-live-dialog.tsx`). Captions go through
  `captions::caption_overlay_leg_plan_with_vertical_leg`, a thin wrapper over
  the same `overlay_leg_plan`, which keeps `force_same_profile_split` and
  the captioned-copy rule.
- Renderer: `lib/overlay-layout.ts` mirrors the defaults, snaps, the leg
  plan, the notices and the badge (`overlayItemOutputBadge`);
  `components/scene/overlay-stage.ts` turns gestures into one clamped
  `overlays.layout.set`; the inspector is `OverlayItemInspector` in
  `components/tabs/layout-tab.tsx`; `hooks/use-studio.tsx` holds the layout,
  derives `burnTarget` and snaps the Stream Manager corner.
- Tests: `cargo test -p videorc-backend overlay_layout` (the exhaustive leg
  plan table, snaps, the migration, the notices), `cargo test -p
videorc-backend captions` (the plan 090 rejections stay unchanged),
  `lib/overlay-layout.test.ts`, `components/scene/overlay-stage.test.ts`
  (a drag on the Highlight rect calls `overlays.layout.set` once with a
  clamped rect), and the shared contract fixture.
- Smokes: `pnpm smoke:recording-studio`, `pnpm smoke:recording-matrix`,
  `pnpm smoke:comment-highlight-stream`, `pnpm smoke:captions-contract`,
  `pnpm smoke:captions-live`, `pnpm smoke:captions-dual-orientation`,
  `pnpm smoke:freeform-editor`, `pnpm probe:preview-lifecycle`. Windows CI
  runs the D3D11 parity fixture.
- Out of scope, as follow-ups: a post-recording clean or burned copy for the
  highlight card and the Buddy (the ffconcat burn exists for captions only),
  and per-orientation source layouts.
