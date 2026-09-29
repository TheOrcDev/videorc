# Plan 077: Live captions on both legs of a dual-orientation stream

**Status:** IMPLEMENTED 2026-09-29 on `fix/077-captions-simulcast` (S1 to S4);
owner acceptance on a real dual stream owed.
**Priority:** P1. **Size:** M.
**Planned against:** `origin/main` `4d37c42a` (0.9.122).
**Owner route:** Implementation + UI/Product Design (fit 9). **Model lane:** `fable-5`.
**Sibling:** [plan 074](074-comment-highlight-on-dual-orientation-streams.md)
fixed the same topology trap for the comment highlight card.

## Owner report

Stream 2026-09-28 (session `453bf8f5`, record+stream, five horizontal
destinations plus YouTube Vertical): "captions were not working". Owner
decision 2026-09-29: "definitely burn captions on both streams, we just need
to make sure that it's looking good".

## Evidence (verified, do not re-derive)

- Captions were **off at Go Live**: the caption task started listen-only
  ("Orcle listens through chunked transcription"); a presenting start logs
  "Streaming captions connected". The `.srt` beside the recording came from
  the post-recording transcription job 3 minutes after stop.
- Captions on at start with burn target Stream would have been refused:
  `validate_caption_output_policy` bails "Live caption burn-in and
  dual-orientation streaming cannot run together yet".
- That check runs only when captions are enabled at start. A captions-off
  session still pre-arms an eligible burn target
  (`caption_live_burn_output_eligible`, which never looks at simulcast). The
  record+stream plan puts the bar on the AUX leg only, and with a vertical
  leg the aux IS the vertical leg, whose compositor path drops captions
  (`caption_overlay: None` when `composes_simulcast_scene`). Captions turned
  on mid-stream therefore rendered in the app and reached no video.
- The renderer's own readiness (`captionSessionOutputReadiness`) and raster
  plan (`captionOverlayTargetPlan`) do not know about the vertical leg either.

## Product decisions

- **Burn on both streams.** With a vertical leg, horizontal viewers share the
  recording's encode, so the horizontal bar is burned on the PRIMARY leg, and
  the vertical leg gets its own portrait raster on the AUX leg.
- **The recording carries the captions** in that shape (it shares pixels with
  the horizontal stream). Burn target Both is then satisfied by the recording
  itself, so no second "captioned copy" is rendered (it would double-burn).
  The Captions UI says so while a vertical destination is armed.
- **Looks good on a phone.** Portrait canvases (the vertical leg and vertical
  scenes) keep overlays out of the platform UI: TikTok, Shorts and Reels put
  the caption/username/music text across the bottom fifth and action buttons
  on the right. Portrait overlays use a larger bottom and top safe margin and
  a narrower caption bar; caption text sizes off the canvas long edge so a
  1080x1920 bar reads like its 1920x1080 twin.

## Slices

### S1: Backend routes captions to both legs

- `caption_leg_plan`: with a simulcast leg and a stream-burning target, plan
  `(primary: true, aux: true, force_same_profile_split: false,
captioned_copy: false)`.
- `validate_caption_output_policy`: drop the simulcast refusal; keep the
  30 fps limit and apply it to the vertical leg; skip the horizontal
  distinct-profile check (simulcast already forces one horizontal encode).
- `caption_live_burn_output_eligible`: include the vertical leg's fps.
- Compositor: the simulcast aux takes the Auxiliary caption raster.

**Done when:** unit tests cover the plan, validation and eligibility for
simulcast; the old refusal test becomes an acceptance test.

### S2: Portrait safe area and portrait caption bar

- One layout oracle (`caption_overlay_layout_with_inset`) applies portrait
  margins for both captions and the highlight card; the renderer's
  `captionBarFramePosition` mirrors it for captioned copies.
- `captionBarMetrics` sizes text off the long edge and narrows the bar on
  portrait canvases.
- Renderer raster plan: with a vertical leg armed, rasterize primary at the
  session canvas and auxiliary at the vertical canvas.

**Done when:** the caption style contact sheet at 1080x1920 is judged by eye
for all four styles, top and bottom, over light, dark and motion.

### S3: Honest UI

- Captions controls say that captions also land in the recording while a
  vertical destination is armed.

### S4: Proof

- New `smoke:captions-dual-orientation` (the long `smoke:captions-live`
  asserts a clean recording and a captioned copy, which is not this shape):
  the High Contrast plate must appear on the horizontal received stream, the
  720x1280 vertical received stream and the recording, the auxiliary raster
  must be the portrait bar, and no second captioned copy is rendered.
- Frames from both received streams are checked by eye.

## Verification gates

- `cargo fmt --check --all`; targeted `cargo test -p videorc-backend
caption`, `overlay`, `simulcast`, `highlight`; `cargo clippy -p
videorc-backend -- -D warnings`
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`,
  `pnpm --filter @videorc/desktop test`, `pnpm test:scripts`
- `pnpm build` + `pnpm check:renderer-assets` (505 bytes of eager headroom
  on `4d37c42a`)
- `pnpm smoke:captions-dual-orientation`, `pnpm smoke:captions-live`,
  `pnpm smoke:comment-highlight-stream` (its portrait analyzer band moved to
  the safe area)

## Out of scope

- A clean recording beside a captioned horizontal stream while a vertical
  leg is armed (needs a third encode).
- Per-platform safe areas (one conservative portrait safe area for all).
