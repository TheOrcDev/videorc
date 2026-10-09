# Plan 169: One-click Golem look in the house style, and a "Test your Golem" modal

> **Executor instructions**: Follow this plan one phase at a time; each
> phase is a commit series on the plan 164 PR branch (`plan-164-golem-b`,
> desktop PR #647) or the web PR branch (`plan-164-golem-web`, PR #75).
> Run every verification command in the phase. If anything in "STOP
> conditions" happens, stop and report. Owner-overridable choices are
> marked ⚑.

## Status

- **Priority**: P1 (the owner wants the Golem ready for people to see the
  final product)
- **Effort**: L, 5 phases
- **Risk**: MEDIUM (a web contract change in an unmerged PR, image cost per
  user, the Still panel replaced)
- **Depends on**: plan 164 (Still avatar, avatar generation route) and plan
  168 (Alive creator, living preview), both in PR #647 / #75, unmerged
- **Planned at**: desktop `f4ba5d9f` (`plan-164-golem-b`), web `8fc58296`
  (`plan-164-golem-web`), 2026-10-09
- **Route**: Orchestrator. Phase A (web) Implementation, fit 9; B
  (desktop backend) Implementation, fit 8; C and D UI/Product Design, fit 9
  (`.claude/skills/videorc-design/SKILL.md`); E orchestrator. Model lane:
  `opus` (Fable credits are out; owner may top up).

| Phase                                            | Where        | Status  |
| ------------------------------------------------ | ------------ | ------- |
| A: House look + one-call set route               | web #75      | PLANNED |
| B: Create / redo / keep / discard in the backend | desktop #647 | PLANNED |
| C: The "Your Golem's look" panel                 | desktop #647 | PLANNED |
| D: "Test your Golem" modal                       | desktop #647 | PLANNED |
| E: Gates, captures, docs, push                   | both         | PLANNED |

## The owner's ask (2026-10-09)

1. "Instead of having users upload one image at a time and generate one
   image at a time, we need to make that a one-time action. We want to
   generate all states at once. The user should define or give an image as
   context of what he wants."
2. "We need to use those skills that we have so we have some kind of
   standard of how our avatar is looking."
3. "We also need some 'test sidekick' feature where we can open some modal
   and there we can see different states on clicking."

Owner answers to the planning questions (2026-10-09):

- **Standard**: house style + page-pet rules. Every avatar is drawn in our
  golem's look (soft 3D cartoon render) and follows page-pet's structural
  rules (full body, transparent background, same size and foot baseline,
  the same character in every state).
- **Image input**: inspire a new character. A picture (a pet photo, a logo,
  a sketch, a face) is redrawn as a full-body character in the house style;
  all states are made from that character.
- **Fixing**: redo one state. No per-tile Upload or Generate any more.
- **Alive**: same character, next step. After the look is kept, "Make it
  Alive" opens the Alive creator with that character as its reference.

## Evidence (probe, 2026-10-09)

Three real generations through the Vercel AI Gateway with
`openai/gpt-image-2.5-sunburst` (the owner's `VIDEORC_AI_AVATAR_IMAGE_MODEL`),
1024 × 1024, transparent background requested:

1. **Description + our golem as a style reference** (`/v1/images/edits`,
   image 1 = the golem master, prompt says "image 1 is the art style only,
   draw a new character: a grumpy goblin merchant with a huge floppy hat"):
   a new character in the same soft matte 3D look as our golem. 62 %
   transparent pixels.
2. **Same description, no style reference** (`/v1/images/generations`):
   a more detailed, more realistic render; a different look from our golem.
3. **A flat cartoon goblin as inspiration + our golem as style reference**:
   the same creature (ears, fang, sly eyes, posture) redrawn in our 3D
   look. 70 % transparent.

Earlier the same day the default golem's talk, laugh and think were made
as image edits of its idle (commit `f4ba5d9f`): same character, same size
and baseline, only the face and arms changed.

**Conclusion (D2):** the house style is anchored by sending our golem art
as a style reference image with every new character; the states are image
edits of that character's idle.

## What exists today

- **Web** `POST /api/ai/cohost/avatar` (`lib/ai/cohost-avatar.ts`,
  `cohost-avatar-route.ts`, `cohost-avatar-usage.ts`): one image per call,
  `{ prompt, style: cartoon|pixel|painted|sticker, state, baseImage? }`;
  "chest up" framing; daily cap 24 images (`VIDEORC_AI_COHOST_DAILY_AVATAR_LIMIT`),
  metered `cohost-avatar`; capabilities `cohost.avatar { enabled,
remainingToday, dailyLimit }`. Pet routes have their own prompts in
  `lib/ai/cohost-pet-prompts.ts`.
- **Desktop** (`plan-164-golem-b`): the Still panel in
  `components/golem-persona-section.tsx` has a Describe input, a style
  `Select`, Generate all (⌘↵) and four tiles each with Upload (U) and
  Generate (`GolemStateTile`). Generation goes through
  `hooks/use-golem-avatar.ts` (`generateOne`, `generateAll`) to the RPC
  `cohost.avatar.generate` (`crates/videorc-backend/src/cohost_avatar.rs`,
  accept + event `cohost.avatar.generated`), which writes
  `<golemRoot>/<persona>/<state>.png` and the renderer patches
  `persona.images`. Uploads use main's `golem-assets:import-image`.
  `shared/golem-assets.ts` `parseGolemAssetPath` allows only
  `<persona>/(idle|talk|laugh|think).(png|webp|jpg)`.
- **Alive creator** (`components/golem-pet-creator.tsx`): its Reference
  step accepts `{ kind: 'persona-idle' }`; it opens from
  `lib/golem-pet-creator-nav.ts` `openGolemPetCreator()` (no arguments).
- **Previews**: `LazyGolemPetPreview` (living preview, Still or Alive,
  handle `react(id)`), `GolemBubbleSample` (bubble rasterizer sample), the
  Avatar section's zoom dialog.
- **Default Golem**: four bundled pictures (`assets/golem/default/`), masters
  in `assets/brand/golem/`.

## Decisions (⚑ = owner may override)

**The standard**

- D1. **The house look** is one module on the web, `lib/ai/golem-look.ts`,
  used by every avatar and pet prompt: the style text ("a stylised 3D
  cartoon character render: soft rounded chunky forms, smooth matte
  materials with subtle surface texture, warm soft studio lighting, gentle
  ambient occlusion, a clean readable silhouette, big friendly expressive
  eyes, sturdy proportions with a large head") and page-pet's structural
  rules ("one single character, full body from head to feet, standing
  upright, facing the viewer, centred, about 80 % of the frame height, feet
  on one baseline near the bottom, fully transparent background, no floor,
  no shadow, no frame, no text"). `GOLEM_LOOK_VERSION = 1` is recorded in
  usage metadata.
- D2. **Style anchor**: every new character is an image edit with our
  golem as image 1, labelled in the prompt as "art style only, not the
  character". The anchor file ships with the web app
  (`lib/ai/golem-look/style-reference.png`, the master trimmed to 768 px,
  included in the serverless bundle with `outputFileTracingIncludes`).
- D3. **The style menu goes away** (Cartoon, Pixel, Painted, Sticker). One
  look. ⚑ (owner chose house style over a menu.)

**Generation**

- D4. **One call makes the whole set**: `POST /api/ai/cohost/avatar/set`.
  Body `{ description?: string (1-600), inspiration?: base64 PNG/JPEG/WebP
≤ 4 MB decoded }`, at least one of the two. The server makes the idle
  (edit with `[styleAnchor, inspiration?]`), then talk, laugh and think in
  parallel as edits of that idle (the default golem's prompts: keep the
  character, full body, same size and baseline, change only the face and
  arms). Response `{ images: { idle, talk?, laugh?, think? }, failed:
{ <state>: { code, message } } }`, each image `{ pngBase64, opaque }`. A
  failed idle fails the call (no character, nothing to edit).
- D5. **Redo one state**: the same route with `{ redo: 'talk' | 'laugh' |
'think', base: <the draft idle PNG> }` makes that state only. Idle has no
  Redo; "Try again" makes a new character (all four).
- D6. **Allowance**: the existing daily image cap counts each delivered
  image (a set = 4, a redo = 1). Reservation before the model calls, released
  for failures, so a failed state costs nothing. The Still panel says
  "N images left today" from capabilities. The old per-state route and its
  `style` field are removed (nothing shipped uses them; #75 is unmerged).
- D7. **Timing**: one set is about 30 to 45 s for the idle plus 30 to 45 s
  for the three parallel edits. The route's `maxDuration` is 180 s; the
  desktop client waits 190 s and shows per-state progress from the
  backend's events (D9).

**Desktop**

- D8. **Drafts, then Keep**: a new look never overwrites the current one
  until the user keeps it. The backend writes the set to
  `<golemRoot>/<persona>/drafts/<requestId>/<state>.png`; **Keep this look**
  moves it into `<persona>/<state>.png` and patches `persona.images` and
  `persona.source = 'generated'`; **Discard** deletes the draft. One draft
  per persona; a new Create replaces it. Main's asset allow-list gains the
  draft path.
- D9. **RPCs** (accept + event, the 10 s mutation lane rule):
  `cohost.avatar.create { description?, inspirationBase64? }` →
  `{ requestId }`, events `cohost.avatar.progress { requestId, state,
phase: 'working' | 'done' | 'failed', path?, error? }` and
  `cohost.avatar.draft { requestId, images, failed }`;
  `cohost.avatar.redo { requestId, state }`; `cohost.avatar.keep
{ requestId }` → settings; `cohost.avatar.discard { requestId }`.
  `cohost.avatar.generate`, its event and the per-state hook paths are
  deleted. The backend keeps one generation at a time per process
  (existing `cohost-avatar-busy`).
- D10. **No manual uploads** in the Still panel (owner answer 3). Existing
  personas keep their uploaded pictures and see them in the tiles; "Start
  over" still resets to the default Golem. `golem-assets:import-image` is
  removed if nothing else uses it.
- D11. **Make it Alive**: after Keep, a button opens the Alive creator with
  `openGolemPetCreator({ reference: 'persona-idle', notes: description })`;
  the creator skips straight to identity notes and the pilot.
- D12. **Consent copy**: the Cloud AI line becomes "Golem's look: your
  description and any picture you add go to Videorc's cloud AI; the
  pictures are kept on this computer."

**The panel (C), follows the design skill**

- D13. "Your Golem's look" replaces "State images":
  - **Input**: a Describe `Textarea` (placeholder "A grumpy stone golem with
    a mossy back…") and a picture drop zone ("Add a picture for inspiration:
    a pet, a logo, a sketch"; PNG, JPEG or WebP up to 10 MB, downscaled to
    1536 px and re-encoded as PNG in the renderer before sending). One
    primary action, **Create my Golem** (⌘↵), disabled until there is a
    description or a picture; a tertiary line with the allowance and "Uses
    4 images".
  - **Working**: four tiles with skeletons and per-state status; idle first,
    then the three together.
  - **Draft**: four result tiles, each talk/laugh/think with **Redo** (R
    when focused), the living preview playing the draft, and **Keep this
    look**, **Try again**, **Discard**.
  - **Current look** (no draft): four view-only tiles, the "Default" badge
    on bundled pictures, and **Make it Alive** once the look is the user's.
  - Gates: Premium + Cloud AI consent + `cohost.avatar.enabled`, each with
    its existing hint.

**The test modal (D)**

- D14. **Test your Golem** (button in the Avatar section, `T` when focused):
  a large `Dialog` (glass panel) that works for Still and Alive.
  - Left: the Golem on a 16:9 mock stream frame (neutral dark gradient with
    a few placeholder blocks), placed at the persona's real overlay rect for
    the chosen orientation (Horizontal / Vertical toggle), drawn by the
    living preview with the comic bubble above it from the bubble
    rasterizer. A zoom toggle shows it large instead.
  - Right: **States** (Idle, Talking, Laughing, Thinking: hold that frame),
    **Reactions** (every reaction the pack has, plus Hop), **Events**
    (Follow, Sub, Gift, Tip, Raid, Watch streak, Redemption: each plays the
    persona's mapped reaction and shows the matching greeting template with
    a sample name, so the user sees exactly what viewers get), **Say** (a
    line in the bubble, ↵ talks, ⌘↵ laughs), and the bubble style toggle.
    Motion slider and Sleep now live for the session (not saved).
  - Nothing here touches the stream or chat; it is a sandbox in the
    renderer, using the same preview, motion model and rasterizer as the
    real thing.

## Phase A: House look + one-call set route (web #75)

1. `lib/ai/golem-look.ts` (D1) and the style anchor file (D2) with its
   tracing include; a unit test that the anchor is present and decodes.
2. `POST /api/ai/cohost/avatar/set` (D4 to D7): create and redo, Zod strict,
   the same gate ladder as the avatar route, reservation per image, the
   gateway client's `images/edits` with several images (extend the client:
   `baseImages: [...]`). Prompts: create (anchor + description), inspire
   (anchor + picture + optional description), state edit (the default
   golem prompts, now in `golem-look.ts`).
3. Pet prompts (`lib/ai/cohost-pet-prompts.ts`) take the house style text
   from `golem-look.ts`, so an Alive pet matches its Still look.
4. Delete the per-state `/avatar` route and the `style` enum; update
   capabilities and docs (`docs/ai-gateway.md`).
5. Tests with a mocked gateway: create from description, from a picture,
   both; idle failure fails the call; one state failing returns the other
   two and releases its slot; redo; the cap (a set needs 4 left, else
   429 with the reset time); unknown fields; the anchor is sent as image 1.
6. A probe script `scripts/golem-look-probe.ts` (owner's key) that makes one
   full set from a description and one from a picture and reports alpha,
   timing and cost.

Gates: `pnpm typecheck`, `pnpm lint`, `pnpm test`, the probe documented.

## Phase B: Create / redo / keep / discard in the backend (desktop #647)

1. `cohost_avatar.rs`: the four RPCs and two events of D9; drafts per D8;
   `videorc_api::post_cohost_avatar_set` (190 s, 40 MB response cap);
   delete `cohost.avatar.generate`.
2. Main: draft paths in `shared/golem-assets.ts` and `golem-assets:read`;
   remove `golem-assets:import-image` if unused (grep first).
3. TS contract blocks, runtime schemas, fixtures; `AiCapabilities.cohost.avatar`
   unchanged.
4. Tests with a fake web: a set lands as a draft and keep moves it; discard
   leaves nothing; redo replaces one draft state; a second create replaces
   the draft; a failed idle leaves no draft; restart with a draft on disk
   shows it again.

Gates: TS + Rust gates, `cargo test -p videorc-backend cohost_avatar`.

## Phase C: The "Your Golem's look" panel (desktop #647)

Per D10 to D13. New `components/golem-look-section.tsx` replacing the Still
panel's tiles in `golem-persona-section.tsx`; the old `GolemStateTile`
Upload/Generate, the style `Select` and `use-golem-avatar.ts` per-state code
are removed. `openGolemPetCreator` gains the optional reference argument and
the creator honours it. Tests: Create disabled until input; picture
downscaled before sending; draft tiles with Redo only on talk/laugh/think;
Keep / Try again / Discard; Make it Alive opens the creator with the
reference.

## Phase D: "Test your Golem" modal (desktop #647)

Per D14: `components/golem-test-dialog.tsx` (lazy chunk), the mock stream
frame, states, reactions, events with greeting text, Say, bubble style,
orientation and zoom. The preview gets a `pose(state)` path for holding a
Still state (it already has `pose`). Tests: each control drives the preview
handle; events show the persona's greeting for that kind; nothing calls a
backend chat or stream RPC.

## Phase E: Gates, captures, docs, push

`pnpm typecheck && pnpm lint && pnpm format:check && pnpm --filter @videorc/desktop test`,
Rust gates for touched modules, `pnpm build`, `pnpm check:renderer-assets`,
captures of the look panel (input, working, draft, current) and the test
modal in both themes, `docs/golem.md` updated, push to #647 and #75.

## STOP conditions

- A set can overwrite the user's current look without Keep.
- The allowance can be exceeded, or a failed image is metered.
- The style anchor is missing from the deployed bundle (the route must 503
  with a named code, never silently drop the anchor).
- The test modal sends anything to chat, the stream or the web.

## Out of scope

- Generating the Alive pet in the same click (owner answer 4: a next step).
- Per-user style choices (owner answer 1).
- Moderating user pictures beyond the model provider's own policy.

## Open questions for the owner

1. D13: is "Create my Golem" the right button name?
2. D14: should the test modal also be reachable from the Stream Manager's
   Golem pane?
