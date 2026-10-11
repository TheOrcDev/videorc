# Plan 164: Golem — a user-named companion with an avatar, comic bubbles and automatic chat

> **Executor instructions**: Follow this plan one phase at a time. Each phase
> is a PR. Run every verification command in the phase and confirm the
> expected result before moving on. If anything in "STOP conditions" occurs,
> stop and report. Do not improvise on wire shapes or copy; owner-overridable
> decisions are marked ⚑. When a phase is merged, update this plan's entry in
> `plans/README.md` and the phase table below.
>
> **Drift check (run first, per phase)**:
> `git fetch origin main && git diff --stat 3fcc17e4..origin/main -- crates/videorc-backend/src/cohost.rs crates/videorc-backend/src/compositor.rs crates/videorc-backend/src/captions.rs crates/videorc-backend/src/comment_highlight.rs crates/videorc-backend/src/live_chat.rs crates/videorc-backend/src/cohost_command.rs apps/desktop/src/shared/backend.ts apps/desktop/src/shared/backend-rpc-contract.ts apps/desktop/src/renderer/src/components/tabs/orcle-tab.tsx apps/desktop/src/renderer/src/components/stream-manager apps/desktop/src/renderer/src/components/scene apps/desktop/src/renderer/src/lib/go-live-output.ts`
> If `captions.rs` changed around `caption_overlay_leg_plan` /
> `highlight_overlay_leg_plan`, or `compositor.rs` changed around
> `CompositorLoopConfig` / `publish_compositor_frame`, re-read "Current
> state" against the live code before touching Phase B or C.

## Status

- **Priority**: P2 (product feature, owner-requested 2026-10-08)
- **Effort**: XL, 5 phases, 22 slices. Each phase ships on its own.
- **Risk**: Phase A LOW, Phase B HIGH (output pipeline, three render paths,
  encode topology), Phase C MEDIUM (new overlay in three render paths),
  Phase D MEDIUM-HIGH (the app posts to viewers' chats on its own for the
  first time), Phase E LOW.
- **Depends on**: plan 119/150 (Orcle tab), plan 140 (voice commands, wake
  words), plan 055/074/095 (highlight card on both legs), plan 077
  (captions × simulcast, `force_same_profile_split`), plan 090 (shared-encode
  fallback), plan 156 (Activity auto-show), plan 162/163 (power-ups,
  redemptions, points name).
- **Category**: feature
- **Planned at**: desktop `3fcc17e4` (origin/main), web `b339c1fb`
  (videorcweb origin/main), 2026-10-08
- **Route**: Orchestrator → Implementation per phase. Phase A fit 8
  `opus-4.8` (UI and copy heavy, low risk). Phase B fit 9 `fable-5`
  (multi-path compositor, topology). Phase C fit 9 `fable-5`. Phase D fit 9
  `fable-5` (sends to real audiences, throttle correctness). Phase E fit 7
  `gpt-5.5`. All UI follows `.claude/skills/videorc-design/SKILL.md`.
- **Name**: the feature and tab are **Golem** (owner pick, 2026-10-08, from
  ten candidates). The user's creature has its own name. Code and wire names
  stay `cohost` (same rule as the Orcle rename, plan 119).

| Phase | PR | Status |
| --- | --- | --- |
| A — Golem tab, persona, avatar images | — | PLANNED |
| B — Overlays become placeable per-output items | — | PLANNED |
| C — Golem on stream: avatar states + comic bubble | — | PLANNED |
| D — Automatic chat: greetings, answers, banter | — | PLANNED |
| E — Docs, gates, acceptance | — | PLANNED |

## The owner's ask (2026-10-08, verbatim intent)

1. Rename the Orcle tab. The companion is no longer one fixed character;
   each user creates their own and names it (Orc, Goblin, anything).
2. Inside the tab: an avatar creation flow. Name it, give it a personality,
   and generate (or upload) images for its states: idle, talking, laughing,
   "and whatever is needed". No animation yet, state images only.
3. Everything that *operates* the companion moves to Stream Manager. The
   tab creates, Stream Manager runs it (owner pick, 2026-10-08).
4. Options to make it automatic. It should welcome all the activities, and
   every message is written by the user. Example: Twitch follow → "Welcome
   to the horde".
5. The same options exist for the chat bot behaviours (answers, jokes).
6. The user chooses where it renders on the live stream and whether it is
   in the recorded video. The same two controls for highlighted messages
   and captions.
7. No text to speech. The avatar "talks" through a comic bubble above it.

## What exists today (origin/main `3fcc17e4`)

**Orcle tab** (`components/tabs/orcle-tab.tsx`, sub-tabs in
`lib/orcle-tabs.ts`: `live | chat | voice | reports | clean-cut`). Settings
persist through `cohost.settings.get/set` into one SQLite `app_settings`
row `cohostSettings` (`cohost.rs:486-574` struct, `:586` load, `:7248` set;
TS at `backend.ts:4946-4995`; strict runtime schema in
`backend-rpc-contract.ts:2155-2189`, `allowUnknown: false`; fixture test
`shared/protocol-contract-fixtures.test.ts`). Tone, notes and rules travel
in every tick request body. Cloud consent is renderer localStorage
`videorc.aiConsent` (`use-studio.tsx:514`). Copy at `orcle-tab.tsx:352`,
`cohost-settings-section.tsx:277` and `docs/orcle-live.md:23-24` says
**"It never posts on its own."** That sentence is a product promise this
plan replaces with an explicit per-mode promise.

**Stream Manager** (`components/stream-manager/stream-manager.tsx`, a
separate window, code name `comments`). Panes: Chat, Activity, optional
Orcle pane (`cohost-pane.tsx`). Stats bar, status bar (always-on-top,
highlight corner `HighlightAnchorOptions`, Clear, Mark clip, Preview). The
window has **no backend socket**; every action relays through main to the
Studio renderer over `comments-window:*` channels
(`electron-ipc-contract.ts:143-183`). "Thank in chat" only pre-fills the
composer: *the composer is the one place a send starts* (plan 068 D8,
`stream-manager.tsx:684`). Auto-show (plan 156) is the precedent for a
per-stream automatic behaviour: pref in `userData/comments-window.json`,
policy in `lib/activity-auto-highlight.ts` (max 3 pending, 30 s max age).

**Activity events**. Wire union `LiveChatEventDetails` (`backend.ts:4686-4749`):
super-chat, super-sticker, membership, subscription (sub, resub, sub-gift,
community-sub-gift, gift-paid-upgrade, prime-paid-upgrade, pay-it-forward),
cheer, kicks, raid, announcement, follow, watch-streak, power-up,
redemption. Rust mirror `live_chat.rs:84,155,309`. UI kinds `ActivityKind`
(`lib/stream-activity.ts:18-32`). Producers: Twitch EventSub
(`twitch_chat.rs`), YouTube polling, Kick and X via the web relay. There is
no host, hype-train or poll event. Fake fixture: `fake_events()`
(`live_chat.rs:3601`), 16 rows asserted in
`scripts/lib/comments-totals-probe.mjs` and
`scripts/smoke-live-chat-fake-providers.mjs`.

**Chat send**. RPC `liveChat.send` → `send_live_chat_message`
(`live_chat.rs:2407`): UUID `operationId`, 1-200 chars, 8 s per-provider
timeout, fan-out to writable destinations or `destinationIds`. Per platform:
Twitch `user:write:chat` 200 chars; YouTube `youtube.force-ssl` 200 chars,
**50 quota units per send** behind the plan 094 breaker; Kick `chat:write`
500 graphemes; X OAuth1 **140 chars**. **No app-level rate limiter.** Every
send is the streamer's own account (`live_chat.rs:2139-2143`). No bot
account concept. `cohost_ack.rs:25-30` treats the streamer's own echo in
chat as "the streamer replied".

**AI**. The desktop never calls a model. `videorc_api.rs` posts to
videorcweb `/api/ai/cohost/{tick,spotlight,command}` and friends. Web uses
Vercel AI Gateway (`lib/ai-gateway/config.ts`), tick text model
`VIDEORC_AI_COHOST_TEXT_MODEL`, judge `typesafe-ai/jev`. **No image
generation exists in either repo.** Consent uses are listed in
`lib/orcle-tab-view.ts:54` (`CLOUD_AI_USES`).

**Voice**. Wake words are hard-coded `orcle`, `orkle` plus weak
`oracle`/`orca` in `cohost_command.rs:54-56`.

**Assets**. Two import patterns: backgrounds (main copies to
`userData/background-assets/<uuid>.<ext>`, registers roots with the backend,
renderer gets a managed protocol URL; `main/index.ts:13699-13725`) and
Stream Screens (backend-owned import, optimized PNG in `<db dir>/Screens/`,
`storage.rs:6184-6300`).

**Overlay pipeline** (the facts Phase B and C stand on):

- The compositor renders at most **two** program legs per tick: primary
  (`frame_store`) and one auxiliary (`stream_frame_store`);
  `publish_compositor_frame` (`compositor.rs:7308`),
  `CompositorAuxiliaryOutput` (`:519`). Per-leg overlay flags already exist:
  `caption_overlay_on_{primary,aux}`, `highlight_overlay_on_{primary,aux}`
  on `CompositorStartParams` / `CompositorArmParams` /
  `CompositorLoopConfig` (`:502-575`, hot-swappable via `watch`, applied at
  `:5049`, today only set at arm time).
- Render paths: Metal `try_gpu_compose_with_chrome` (`:6193`, aux leg has
  its own `stream_gpu_compositor` `:4956`), CPU
  `render_compositor_yuv420p_frame` (`:7786`), Windows D3D11 unified pump
  (`windows_d3d11_session.rs`, per-layer output-target bitmask
  `WindowsD3d11SceneOutputTargets` `windows_d3d11_compositor.rs:142-190`).
  The legacy FFmpeg filter-graph path has no overlays and is not in scope.
- Encodes per session shape: record-only 1; stream-only 1; record+stream
  same profile 1 shared; record+stream with stream-only captions or a
  different profile 2 (Recording + Stream); record + dual-orientation 2
  (primary = recording **and** every horizontal destination, auxiliary =
  vertical). **A third encoded leg is refused**
  (`recording.rs:20555-20560`).
- Overlays are PNG bitmaps rasterized by the renderer into app-global slots:
  `caption_overlay` (`CaptionOverlaySlots {primary, auxiliary}`,
  `captions.rs:2449`), `highlight_overlay` and
  `simulcast_highlight_overlay`. Placement is fixed:
  `CommentHighlightAnchor` four corners (`comment_highlight.rs:71`, saved in
  comments-window prefs, same corner both orientations, plan 074 O2);
  captions `position: 'top'|'bottom'` centred (`backend.ts:1617`); pixel
  layout from `caption_overlay_layout_with_inset` (`compositor.rs:8641`),
  shared by D3D11 via `windows_d3d11_overlay_layer_geometry`
  (`windows_d3d11_session.rs:32`). `OverlayPlacement { vertical, horizontal }`
  (`captions.rs:2403`) is backend-only.
- Leg plans: `caption_overlay_leg_plan` (`captions.rs:643`, `:691`) and
  `highlight_overlay_leg_plan` (`:728`). Captions with `burnTarget: stream`
  during record+stream set `force_same_profile_split` → the stream is
  captioned on the auxiliary leg, the recording stays clean. Captions are
  the only overlay with real stream-vs-recording control today. The
  highlight card is clean in the recording only as a side effect of a split.
- Weak Windows (plan 090): when the probe's effective bridge is
  `raw-yuv420p`, `resolveStreamOutputTopologyRequest`
  (`lib/go-live-output.ts:87`) re-plans a single shared encode and
  **refuses** when captions need a clean recording (`needsCleanRecording`,
  `:110-114`), destinations disagree, simulcast is armed, or it would
  downgrade a 4K recording. Backend mirrors it
  (`recording.rs:20486`, `:20500`, `:20318-20325`).
- Post-recording caption burn (`run_caption_overlay_burn`,
  `captions.rs:1874`; ffconcat cue track through `overlay=eof_action=pass`,
  `:766`) re-encodes a finished file into a `(captioned)` copy. The original
  is untouched. It costs no live encode.
- Live Scene canvas: `components/scene/scene-stage.tsx` (SVG hit layer,
  one commit per gesture via `StageEdits.submit` `:509`), item model
  `Scene { sources, outputs }` (`backend.ts:693-733`). **Overlays are not
  scene sources.** Freeform transforms persist as
  `LayoutSettings.sourceTransformOverrides`. There is **no per-orientation
  freeform layout**: the vertical leg is derived by `simulcastLegLayout`
  (`lib/capture.ts:321`) with overrides cleared. The docked native preview
  shows the primary composite only.

## Decisions (⚑ = owner may override before the phase starts)

**Identity and naming**

- D1. The tab, sidebar entry, window titles and docs say **Golem**. The
  creature's own name (persona name) is what the Golem answers to in chat
  and in voice. Code, RPC names, SQLite keys, web routes stay `cohost`.
- D2 ⚑. Wake words become `golem` plus the persona name's word tokens
  (lowercased, ASCII-folded, 3+ letters). The `orcle`/`orkle`/`oracle`/`orca`
  list is removed. A name the STT cannot hear is the user's problem, but
  `golem` always works.
- D3 ⚑. Phase D posts **as the streamer's own account** on every platform.
  The consent dialog and the mode control say so in one sentence. A Twitch
  bot account (separate OAuth, `chat:write` as the bot, viewer-visible bot
  name) is a follow-up plan, not this one.

**Modes and the product promise**

- D4. "It never posts on its own" becomes: *"The Golem posts only in the
  modes you turn on. Everything is off by default."* The chat posting mode
  is one control with three values: **Off**, **Suggest** (a card in Stream
  Manager, one click sends), **Automatic** (sends within the throttle).
  Default Off. Suggest is the mode the consent dialog lands you in.
- D5. Three automatic behaviours, each with its own switch under the mode:
  **Greetings** (per-event templates written by the user, no AI),
  **Answers** (AI reply when a viewer addresses the Golem by name or when
  a question targets the stream and nobody answered, Premium + consent),
  **Banter** (AI, a joke or remark on dead air, Premium + consent, long
  cooldown, default off). ⚑ Banter may be dropped from Phase D if the owner
  wants a smaller first ship.
- D6 ⚑. Greetings and the avatar overlay with uploaded images are **free**.
  Answers, Banter and avatar image generation sit behind the existing
  `cohostGate` (Premium) plus `aiConsent`.
- D7. Utterance routing: every Golem utterance has a text and a state.
  If the overlay is on, it shows in the bubble. If the chat mode is
  Automatic, it is also sent to chat. In Suggest mode, the bubble shows
  only after the card is approved. Chat Off + overlay On is a valid
  "stream-only Golem". The owner's manual **Say** box in Stream Manager
  produces an utterance like any other.
- D8. Platform targeting: a greeting goes to the platform the event came
  from (`destinationIds` = that destination), never fanned out. Answers go
  to the platform of the message answered. Banter goes to every writable
  destination. Each text is clipped to the platform cap (X 140) by the
  existing `lib/chat-send.ts` caps; a template over the cap on any enabled
  platform shows an inline warning in the editor, not a silent cut.

**Throttle (Phase D, not negotiable)**

- D9. Global: at most 6 automatic sends per minute per destination, and
  never two automatic sends within 5 s on one destination. Per kind: a
  cooldown per event kind (follow 10 s, subscription 5 s, cheer/kicks/
  super-chat 5 s, raid 60 s, watch-streak 15 s, power-up/redemption 10 s).
  Collapse: more than 3 same-kind events inside the cooldown window become
  one message using the `{names}` and `{others}` fields ("Welcome Ana, Bo
  and 4 others"). A community sub gift produces one message to the gifter;
  the individual gift rows inside it are skipped (same rule as auto-show).
  Dedupe: one greeting per (destination, viewer, kind) per session. YouTube:
  no automatic send while the plan 094 breaker is open, and automatic sends
  count against the same budget. Nothing automatic is sent while the
  destination is `failed` (plan 161).
- D10. Every automatic send carries a Golem-owned `operationId` and is
  recorded in a session-scoped set that `cohost_ack.rs` consults, so a
  Golem post never counts as "the streamer replied". Every automatic send
  is written to the local report (`cohost_reports`) with the trigger.

**Overlays (Phase B)**

- D11. Three overlay items: `highlight`, `captions`, `golem`. Each has a
  placement per orientation (`horizontal`, `vertical`: normalized rect
  x/y/w/h in canvas units) and two switches `showOnStream`,
  `showInRecording`. Stored backend-owned under a new `app_settings` key
  `overlayLayout` with RPCs `overlays.layout.get/set`. Placement lives on
  the Live Scene canvas and nowhere else (one-home law). The Stream Manager
  highlight corner menu stays as a **snap** that writes the same rect
  (top-left, top-right, bottom-left, bottom-right presets); the comments
  window pref `highlightAnchor` is migrated once into `overlayLayout` and
  then ignored.
- D12. Leg plan: one pure function
  `overlay_leg_plan(record, stream, aux_leg, show_on_stream, show_in_recording) -> {primary, aux, needs_split}`
  replaces `caption_overlay_leg_plan` and `highlight_overlay_leg_plan`.
  Semantics: record-only → primary = showInRecording; stream-only → primary
  (or the single leg) = showOnStream; record+stream shared leg → if the two
  switches agree, primary = that value; if they disagree, `needs_split` and
  primary = showInRecording, aux = showOnStream; vertical simulcast → aux
  (vertical) = showOnStream, primary = showInRecording OR showOnStream
  (recording and horizontal stream share pixels, see D13).
- D13. Impossible cases get a stated fallback, decided **before** start and
  shown in the Go Live sheet, never silently:
  - Recording while dual-orientation streaming, switches disagree: the
    primary leg burns if **either** switch is on, and the sheet says
    "Recording will include the Golem / highlights / captions while
    streaming vertical."
  - Shared-encode fallback (weak Windows, raw bridge) and switches
    disagree: for `highlight` and `golem`, burn on both and say so in the
    sheet. For `captions` keep today's block (plan 090 behaviour unchanged).
  - A post-recording "clean" or "burned" copy for highlight and golem via
    the ffconcat overlay track is a follow-up, listed in Out of scope.
- D14. Captions keep `CaptionsSessionParams.burnTarget` on the wire for
  one release; it is **derived** from the two switches
  (`stream` = on/off, `recording` = off/on, `both` = on/on, none = off/off)
  so the Rust caption path does not change shape in Phase B. The
  `position: 'top'|'bottom'` field is replaced by the rect; the caption
  bar's width is the rect's width, its height is content-driven as today.
- D15. The canvas shows overlay items as labelled dashed rects that drag
  and resize like sources, with an **Orientation** segmented control
  (Horizontal / Vertical) above the stage when a vertical leg is configured.
  Stream-only items do not appear in the docked native preview during a
  split (the preview is the primary composite); the canvas rect is the
  truth for placement and the item label carries a small "stream only"
  badge so nobody files that as a bug.

**Golem on stream (Phase C)**

- D16. States: `idle`, `talk`, `laugh`, `think`. `idle` is required; the
  others fall back to `idle` when missing. A state is an image per state in
  the persona's pack. No animation; the state image swaps.
- D17. The overlay PNG is rasterized by the renderer per target canvas
  (same pipeline as the highlight card, `lib/comment-highlight.ts`) from
  the state image plus the bubble, pushed to a new backend slot
  `golem_overlay` with primary/auxiliary targets like captions. The bubble
  has a tail pointing at the avatar's top, wraps to at most 4 lines at the
  rect's width, and stays for `max(2.5 s, 0.06 s × characters)`, capped at
  10 s. Bubble styles: `speech`, `thought`, `shout` ⚑. Text is primary
  colour on a porcelain bubble with a hairline ring in both themes (the
  stream is not themed; the bubble is always the light variant).
- D18. State machine in Rust (`cohost.rs`): `idle` → (`think` while an
  Answer is pending, optional) → `talk` or `laugh` while the bubble is up →
  `idle`. The state comes from the utterance (`state` field). Greeting
  templates carry a state each (default `talk`). The web tick returns a
  `mood` that maps to a state.
- D19. The avatar is visible whenever the item is enabled on that leg,
  bubble or not. Enabling the Golem overlay with no persona pack shows the
  bundled default pack.

**Avatar images (Phase A)**

- D20 ⚑. Storage follows the backgrounds pattern: main copies each file to
  `userData/golem-assets/<personaId>/<state>.<ext>`, registers the root
  with the backend as a managed asset root, the renderer gets a managed
  protocol URL. The persona record (in `cohostSettings.persona`) stores the
  relative paths. Max 4 MB per image, PNG or WebP with alpha, JPEG allowed
  for idle only (no alpha).
- D21. Generation runs on the web: `POST /api/ai/cohost/avatar` takes a
  prompt, a style preset and an optional base image, returns one PNG with
  alpha. The desktop generates the **idle** image first, then the other
  states as edits of the idle image ("the same character, laughing, same
  framing, transparent background") so the character stays consistent. The
  model id is a web env `VIDEORC_AI_AVATAR_IMAGE_MODEL`; S-A6 picks it with
  a probe and records the choice in `docs/ai-gateway.md`. Each generation
  is a quota line like clean-cut jobs. A failed state generation leaves the
  slot empty (falls back to idle), never blocks saving the persona.
- D22. One bundled default pack ships in
  `apps/desktop/src/renderer/src/assets/golem/default/{idle,talk,laugh,think}.png`
  (next to the Orcle emblem webp files; the renderer rasterizes, so a
  renderer-bundled asset is enough)
  (a small stone golem, owner-supplied or owner-approved art, under 200 KB
  each). It is what a fresh install shows and what the fake-activity smoke
  rasterizes.

## Wire shape

`cohostSettings` additions (Rust `CohostSettings` with `#[serde(default)]`,
TS `backend.ts`, runtime schema `backend-rpc-contract.ts`, fixtures):

```ts
persona: {
  id: string;                    // uuid, regenerated on "Start over"
  name: string;                  // 1-24 chars, the creature's name
  personality: string;           // 0-1200 chars, free text
  bubbleStyle: 'speech' | 'thought' | 'shout';
  images: Partial<Record<'idle' | 'talk' | 'laugh' | 'think', string>>; // relative asset paths
  source: 'default' | 'uploaded' | 'generated';
};
autoChat: {
  mode: 'off' | 'suggest' | 'auto';
  greetings: { enabled: boolean; templates: GreetingTemplate[] };
  answers: { enabled: boolean; cooldownSeconds: number };   // default 20
  banter: { enabled: boolean; cooldownSeconds: number };    // default 240
};
```

```ts
type GreetingTemplate = {
  id: string;
  kind: ActivityTemplateKind;    // see below
  platform?: 'twitch' | 'youtube' | 'kick' | 'x'; // omitted = any
  text: string;                  // 1-200 chars, fields in braces
  state: 'talk' | 'laugh' | 'think';
  enabled: boolean;
};
type ActivityTemplateKind =
  | 'follow' | 'sub' | 'resub' | 'sub-gift' | 'community-sub-gift'
  | 'membership' | 'cheer' | 'kicks' | 'super-chat' | 'super-sticker'
  | 'raid' | 'watch-streak' | 'power-up' | 'redemption';
```

Template fields, resolved in Rust by one pure function with tests:
`{name}` (display name), `{handle}` (`@`-prefixed where the platform uses
one, else name), `{platform}`, `{months}`, `{streak}`, `{count}` (gifts,
raid viewers), `{amount}` (formatted money/bits/kicks), `{reward}` (plan
163 points name or reward title), `{names}` and `{others}` (collapsed
events, D9). Unknown fields render literally and show an editor warning.

`overlayLayout` (new `app_settings` key, RPCs `overlays.layout.get/set`,
observation + mutation classification in `main.rs`):

```ts
type OverlayRect = { x: number; y: number; w: number; h: number }; // 0..1 of the canvas
type OverlayItemLayout = {
  horizontal: OverlayRect;
  vertical: OverlayRect;
  showOnStream: boolean;
  showInRecording: boolean;
};
type OverlayLayout = { highlight: OverlayItemLayout; captions: OverlayItemLayout; golem: OverlayItemLayout };
```

Defaults: highlight = today's `DEFAULT_COMMENT_HIGHLIGHT_ANCHOR` corner as
a rect sized from `comments.highlight.canvases`; captions = bottom bar
(w 0.9, centred, 8% / 22% portrait safe margins as today); golem = bottom
right, w 0.18 (horizontal) / 0.32 (vertical), square. The highlight defaults to
`showOnStream: true, showInRecording: true`; captions keep the existing
`burnTarget` default; **the Golem defaults to off/off** (opt-in: the
recording-studio smoke caught the placeholder golem burned into a default
recording when it shipped on/on).

Utterance (Rust-internal, surfaced to Stream Manager through the existing
`cohost-push` relay and to the renderer rasterizer):

```ts
type CohostUtterance = {
  id: string; text: string; state: 'talk' | 'laugh' | 'think';
  trigger: { kind: 'greeting' | 'answer' | 'banter' | 'manual'; eventId?: string; messageId?: string };
  destinationIds: string[];       // where a send would go
  status: 'proposed' | 'sent' | 'dismissed' | 'bubble-only';
};
```

**Phase A as built (2026-10-08, desktop `plan-164-golem`)**, for Phase B-D
executors:

- `persona.id` defaults to `"default"` (never a fresh uuid at load, so
  `CohostSettings::default()` stays deterministic); "Start over" writes a
  new uuid. `persona.images` is a struct of four optional strings
  (`CohostPersonaImages`), absent never null. Template kind, platform and
  bubble/avatar/utterance states are closed Rust enums (kebab-case).
- Validation lives in `cohost.rs::validate_persona` / `validate_auto_chat`
  (errors `cohost-persona-invalid`, `cohost-auto-chat-invalid`); answers
  and banter cooldowns are 1-3600 s.
- Generation is **accept + event**, not a blocking RPC: `cohost.avatar.generate
  {state, prompt, style}` returns `{requestId, state}` at once (the websocket
  mutation lane has a 10 s execution deadline) and `cohost.avatar.generated
  {requestId, state, path?, opaque, error?: {code, message}}` carries the
  outcome. The backend writes `<root>/<personaId>/<state>.png` into the first
  `VIDEORC_MANAGED_GOLEM_ROOTS` entry; the renderer then patches
  `persona.images[state]` through `cohost.settings.set` (one writer of the
  persona). One generation at a time per process (`cohost-avatar-busy`).
- Capabilities: `AiCapabilities.cohost?: { tick?: number, avatar?: { enabled,
  remainingToday, dailyLimit } }` (Rust `AiCapabilitiesCohost`). Phase D
  reads `cohost.tick === 4` before sending `persona` on a tick.
- Wake words (S-A7, owner answer 1): `cohost_command::wake_words(name)` =
  `["golem", <name tokens>, "orcle", "orkle", "orcel", "orkel", "orcl",
  "orcal"]`; the "orcle" spellings are hidden aliases to remove after
  0.9.140; "oracle"/"orca" are gone. The persona tokens live in a
  process-wide slot set by the engine on every settings change
  (`set_persona_wake_tokens`), read by the detector and the marker grammar.
- Uploads: main's `golem-assets:import-image(personaId, state)` /
  `golem-assets:remove(personaId)`; files served as
  `videorc-asset://golem/<personaId>/<state>.<ext>`.
- Mood → state for Phase D: amused → laugh, thinking → think, neutral → talk.

**Phase C as built (2026-10-08, desktop `plan-164-golem-b`)**, for Phase D
and E executors:

- The state machine is `crates/videorc-backend/src/golem_overlay.rs`, not
  `cohost.rs`: `GolemOverlayState { persona_id, state, bubble, generation }`
  with `think()`, `show_bubble(text, state, duration, now)`, `expire(generation,
  now)` and `clear()`, pure and clock-injected (`chrono::DateTime<Utc>`). The
  expiry is one tokio sleep per bubble keyed on its generation (a replaced
  bubble's timer is a no-op) rather than a 100 ms tick; same behaviour,
  cheaper.
- **The one way a bubble appears** is
  `golem_overlay::show_bubble(app: &AppState, text: &str, state: CohostUtteranceState) -> Result<GolemOverlaySnapshot, GolemSayError>`:
  it validates the text (trimmed, inner whitespace collapsed, 1-200 chars,
  error code `cohost-golem-say-invalid`), stamps `persona.id` from the
  current settings, computes `golem_bubble_duration(text)` =
  `max(2.5 s, 60 ms × chars)` capped at 10 s, runs the state machine, emits
  the event and schedules the end. Phase D calls it for greetings, answers
  and banter; `golem_overlay::think(app)` is the optional `idle → think`
  while an answer is pending (never interrupts a bubble);
  `golem_overlay::clear(app)` runs at every session start (the words never
  ride into a new video; the avatar does).
- RPCs (`backend.ts` / `backend-rpc-contract.ts`, block
  `// --- Golem overlay (plan 164) ---`; policy inventory in `main.rs`):
  - `cohost.golem.say { text, state: 'talk' | 'laugh' | 'think' }` (mutation)
    → `GolemOverlaySnapshot`.
  - `cohost.golem.status` (observation) → `GolemOverlaySnapshot`, loaded by
    the Studio on connect.
  - `golem.overlay.set { target: 'primary' | 'auxiliary', pngBase64, rect }`
    (mutation) → `OverlayTargetsInfo` (the captions slot info shape); the
    backend accepts a missing rect (Golem bottom-right snap) for smokes.
  - Event `cohost.golem.state`: `{ personaId, state: 'idle' | 'talk' | 'laugh' | 'think', bubble: { text, until } | null }`,
    `until` RFC 3339. The bubble is null or whole, never absent.
- Slot: `AppState.golem_overlay: CaptionOverlaySlots` (one raster per
  target, like captions, no style revision) and
  `AppState.golem_overlay_state`. Flags `golem_overlay_on_{primary,aux}` on
  `CompositorStartParams` / `ArmParams` / `LoopConfig` come from
  `OverlaySessionPlans.golem`; `compositor::update_overlay_flags(state, OverlayLegFlags { highlight_on_*, golem_on_* })`
  swaps them mid-session. The direct D3D11 recording path (no overlays) is
  never chosen when the Golem burns.
- Z order (owner answer 7): captions, then the Golem, then the highlight
  card, on CPU (`render_compositor_yuv420p_frame`), Metal (content namespace
  4) and D3D11 (`WindowsD3d11SceneSourceKind::GolemOverlay`, source ids 14/15,
  z 11 between captions 10 and the card 12). The parity fixture
  `cpu_and_metal_blit_the_same_overlay_rect` now has the Golem (green,
  rect 0.15/0.25/0.25/0.2) overlapping the card's bottom-right and asserts
  the card wins; the Windows mirror is
  `windows_overlay_frames_stack_the_golem_between_captions_and_the_card`
  (cfg windows, Windows CI).
- Renderer: `lib/golem-overlay.ts` (lazy; imports the default pack) lays
  out and paints; `lib/golem-overlay-targets.ts` (eager, asset-free) plans
  the targets (`golemOverlayTargetPlan`: the capture canvas, plus the
  stream leg while streaming) and keys the push. Text is 18 px at a 1920
  long edge, scaled by the long edge (portrait = its landscape twin), 4-line
  wrap at the rect's width, bubble width ≤ rect width; the avatar is
  "contained" in a square the rect's width, bottom-aligned, so the bitmap
  is taller than the rect when a bubble is up (the blit oracle keeps it on
  canvas). A persona's own file decodes from bytes through
  `golem-assets:read-image` (MAIN_ONLY); a missing or corrupt one warns
  once and the bundled pack's state image draws (D16/D19). The Studio pushes
  on every change of persona/images/state/bubble/placement/canvas, session
  or not (the slot is app-global, D19). Six paint-log snapshots in
  `lib/__snapshots__/golem-overlay.test.ts.snap`.
- Stream Manager: `CohostWindowState.golem?: { persona: { id, name, images, bubbleStyle, source }, state, bubble, showOnStream }`
  (absent from an older Studio); `cohost-pane.tsx` renders `GolemHeader`
  (32 px state image, name, the bubble while up, `Show on stream` Switch,
  Say Input: ↵ talk, ⌘↵ laugh; right side of the top row left free for the
  Phase D mode control) above every mode, including `disabled` and
  `upsell` (the overlay is free, D6). Relay: `CohostActionCommand` is now
  `CohostSessionActionCommand | CohostGolemActionCommand` with the kinds
  `golem-say { text, state }` and `golem-show-on-stream { showOnStream }`;
  main validates their shape and relays them WITHOUT the live-session
  assertion (they are not chat commands); Studio routes them to
  `cohost.golem.say` and `overlays.layout.set`. Phase D's
  `approve-utterance` should follow the session kinds (it sends to chat).
- ⚑ The Say box has no state chips yet (↵/⌘↵ only); `think` is reachable
  through the RPC, not the box.

Web (videorcweb): tick prompt **v4** adds `persona: { name, personality }`
to the request and `mood: 'neutral' | 'amused' | 'thinking'` to each
reply; zod schemas updated (unknown fields are rejected today, so this is
a coordinated deploy: web first, desktop sends v4 only when
`/capabilities` reports `tick: 4`). New route `/api/ai/cohost/avatar`.

**Phase D as built (2026-10-08, desktop `plan-164-golem`)**, for Phase C/E
executors and the web:

- `CohostUtterance` on the wire (`cohost.state.utterances[]`, oldest first,
  at most 20, omitted while empty; `cohost.state.autoChatSends` omitted
  while zero):
  `{ id, text, state: 'talk'|'laugh'|'think', trigger: { kind: 'greeting'|'answer'|'banter'|'manual', eventId?, messageId? }, destinationIds: string[], status: 'proposed'|'sent'|'dismissed'|'bubble-only'|'failed', at, expiresAt? }`.
  `failed` was added to the plan's four statuses (a send that reached no
  destination; the log says why); `expiresAt` rides a Suggest card (45 s).
  Empty `destinationIds` means every writable destination (banter, Say).
- The lane is engine-wide (`cohost_auto_chat.rs`), following the live-chat
  session, not the Premium tick session: greetings run free (D6). `off`
  produces nothing from any method (lane tests, engine tests, the smoke).
- Suggest and Auto both go through the throttle; a Suggest card is the same
  utterance with `status: proposed` (and `expiresAt`), approved through
  `cohost.utterance.approve`. The Say box (`cohost.utterance.say {sessionId,
  text, state?}`) sends only in Auto; otherwise it is `bubble-only` (Phase C
  shows it). Nothing renders a bubble yet.
- Every send is `live_chat::send_live_chat_message` with a Golem-owned
  `operationId` registered on the lane; `live_chat.rs` skips
  `note_own_send_delivered` for it (no question closes, nobody greeted) but
  still notes the echo (the account is the streamer's). The mode is re-read
  at send time; YouTube is dropped while the plan 094 breaker is open or the
  budget sheds sends; platforms whose stream target is `failed` are dropped;
  text is clipped to the strictest reached cap (X 140) with "…" and a log.
- Held greetings (a kind cooldown or the 6/min, 5 s limiter) wait in a
  bucket and a one-shot pump task releases them; more than 3 same-kind
  events collapse into one `{names}` message, 2–3 go out one per cooldown.
- Reports: `CohostSessionReport.posts[]` (`{id, at, trigger, text,
  destinations: platform[], result: 'sent'|'partial'|'failed'}`, cap 200,
  omitted while empty) written as each send lands through
  `Database::append_cohost_report_post` (a post-only report with
  `segments: 0` when the tick session never ran; `merged_with` unions by id).
- Tick v4: `COHOST_PROMPT_VERSION` stays 3; the ladder is `[4, 3, 2, 1]`; a
  session starts on 4 only when `web_tick_version >= 4` (set by the
  capability refresh via `cohost::set_tick_capability`). v4 adds `persona`
  and optional `intent` to the request; `addressed` and `mood` per question
  and `banter { text, mood }` to the response (`videorc_api.rs`). A
  `prompt-version-unsupported` answer steps 4 → 3 and the persona leaves.
- Answers: only a NEW question with `addressed: true` and a non-empty
  `suggestedReply` becomes a candidate, once; its destination is the first
  known message row's (`KnownMessage.destination_id`). Banter rides the
  tick lane (`in_flight` shared, `tick_seq` incremented) on a v4 session with
  a live microphone quiet for 20 s (`cohost_ack::banter_due`), gated by the
  lane's cooldown and the 60 s quiet-after-send rule.
- Stream Manager relay: `CohostWindowState.autoChat?` (the stored block),
  `CohostEnableCommand.autoChat?: { mode?, greetings?, answers?, banter? }`
  (Studio merges it into the stored block), `CohostActionKind` +
  `approve-utterance` | `dismiss-utterance` | `say-utterance` (with `text`
  and `state?` on the command). The pane's mode is the enable: Suggest/Auto
  saves `{enabled: true, listen: true}`, Off saves `{enabled: false}`; the
  Golem tab lost its switch and points at Stream Manager. The posting
  consent is remembered in the window's localStorage
  (`videorc.golemAutoChatConsent`); Auto confirms every time.
- The copy "Golem never acts on its own" became "The Golem posts only in
  the modes you turn on. Everything is off by default." everywhere.
- Not built: the ⚑ `golem` stats-bar stat (S-D6.3) and the fake-tick smoke
  rows for answers/banter (S-D3/S-D4 are covered by engine unit tests with a
  fake tick response instead; `smoke:cohost-fake` has no capabilities route,
  so the desktop keeps sending v3 there, exactly as before).

Web (videorcweb): tick prompt **v4** adds `persona: { name, personality }`
to the request and `mood: 'neutral' | 'amused' | 'thinking'` to each
reply; zod schemas updated (unknown fields are rejected today, so this is
a coordinated deploy: web first, desktop sends v4 only when
`/capabilities` reports `tick: 4`). New route `/api/ai/cohost/avatar`.

**Integration as built (2026-10-08, desktop `plan-164-golem-b`, Phases A+B+C+D
merged)**, for Phase E:

- D7/D18 glue lives in `golem_overlay.rs`: `utterance_bubbles(&utterance)`
  (status `sent` or `bubble-only`, or trigger `manual`) and
  `show_for_utterance(app, &utterance) -> Option<GolemOverlaySnapshot>`, which
  calls Phase C's `show_bubble` only when `overlay_enabled(app)`
  (`overlayLayout.golem.showOnStream || showInRecording`, read from the
  database per utterance; the compositor flags are untouched, the bubble is
  just skipped). `cohost.rs::send_automatic` calls it once the send lands as
  `sent`/`partial` (with the clipped text), skipping manual lines; an Answer
  on its way to chat calls `golem_overlay::think` first and
  `golem_overlay::settle` (new: `think` → `idle` unless a bubble is up) when
  it fails or is refused.
- The Say box is ONE utterance: `cohost.utterance.say { sessionId?, text,
  state? }`. `sessionId` is optional (`#[serde(default)]`, TS optional);
  empty = no live chat, the utterance is recorded `bubble-only` (also in Auto:
  nowhere to post, so no failed send); a named session must be the live one
  (`cohost-session-mismatch`). `say_utterance` shows the bubble at once
  through `show_for_utterance` and spawns the send only in Auto with a
  session. The Stream Manager's `golem-say` relay now carries `sessionId`
  when the window shows the live session; main validates it with
  `assertLiveCommentsCommandSession` (an Error, never a silent drop) and
  Studio routes `golem-say` to `cohost.utterance.say`. The `say-utterance`
  session kind still works (same RPC). `cohost.golem.say` is DELETED
  (contract, fixtures, main.rs, `GolemSayParams`/`say`); `cohost.golem.status`
  and `golem.overlay.set` stay.
- Rust tests: `golem_overlay::tests` (`sent_and_bubble_only_utterances_bubble_the_rest_do_not`,
  `both_output_switches_off_means_no_bubble`, `settle_ends_a_think_but_never_a_bubble`)
  and `cohost::tests::say_with_the_mode_off_and_the_overlay_on_is_a_bubble_never_a_send`.
- `smoke:captions-dual-orientation` was red on origin/main since #616
  (`simulcastStreamVideo` makes the vertical leg follow the YouTube target's
  preset; the smoke seeded `tutorial-1080p30`, so the renderer rasterized a
  1080x1920 bar, 792 px wide, for the 720x1280 leg the backend streamed);
  Phase B's `maxBarWidthPx` (floor(0.76 × 1080) = 820) equals the old
  fraction, so the raster was unchanged. Fix: the seed is `tutorial-720p30`
  and the invariant proves the portrait bar (≤ 76% + shadow pad, narrower and
  taller than the landscape bar); the bar stays content-sized as it always
  was (`wide: false`). Green run: auxiliary 531x158, primary 794x113.
- `pnpm test:scripts` (the recording-studio smoke's first step) failed on the
  merged tree: S-D2 moved `comments-totals-probe.mjs` to 17 rows / 8 chatters
  but left `comments-totals-probe.test.mjs` at 16; the fixture now carries
  the `fake-gif` row.
- Not built: nothing new; the ⚑ items from Phase C (Say box state chips) and
  Phase D (`golem` stat, fake-tick rows) stand.

## Phase A — Golem tab, persona, avatar images (PR 1)

Owner route Implementation, `opus-4.8`. No recording or preview path.

### S-A1 Rename the tab to Golem

1. `lib/orcle-tabs.ts`: keep ids, add `GOLEM_TAB_LABEL = 'Golem'`; the
   sidebar entry, window title fragments and `openOrcleTab` callers use it.
   Sub-tabs become `Golem | Chat | Voice | Reports | Clean cut` (the first
   sub-tab, formerly Live, is renamed `Golem` and becomes the creation
   screen; Live's switch moves to Stream Manager in S-D6, until then it
   stays at the bottom of the Golem sub-tab under "Joins my streams").
2. Copy sweep: every user-facing "Orcle" in `apps/desktop/src/renderer`,
   `apps/desktop/src/main` window titles, `docs/orcle-live.md` (renamed to
   `docs/golem.md` with a one-line stub left behind), release notes
   untouched. Keep `OrcleIcon` as the sidebar glyph for now ⚑ (plan 149
   emblem; a golem glyph is an owner art decision).
3. Tests that match "Orcle" copy (see memory: copy sweeps break
   case-sensitive matchers) are updated in the same commit.
4. **Done when**: `pnpm typecheck && pnpm lint && pnpm --filter @videorc/desktop test`
   green; `rg -n "Orcle" apps/desktop/src --glob '!**/icons.tsx'` returns
   only the icon registry name and the `videorc:navigate-workspace` ids.

### S-A2 Persona settings on the wire

1. Rust `CohostSettings` gains `persona` and `autoChat` (wire shape above),
   `#[serde(default)]`, defaults = default pack, `mode: 'off'`, all
   behaviours disabled, an empty template list. `CohostSettingsPatch`
   (`protocol.rs:4700`) accepts both as optional whole objects.
2. TS types in `backend.ts`, runtime schema in `backend-rpc-contract.ts`
   (both the settings object and the patch), fixture in
   `protocol-contract-fixtures.test.ts`.
3. Validation in Rust `set` handler: name 1-24 chars, personality ≤ 1200,
   templates ≤ 60, template text 1-200, unknown template kinds rejected
   with a named error.
4. **Done when**: `cargo test -p videorc-backend cohost::settings` passes a
   new round-trip test with persona + autoChat; `pnpm --filter @videorc/desktop test -- protocol-contract`
   green.

### S-A3 Avatar asset store

1. Main: `golem-assets:import-image` IPC (contract in
   `electron-ipc-contract.ts`, preload, `renderer-security-policy.ts`,
   `smoke-command-security.ts`), copying to
   `userData/golem-assets/<personaId>/<state>.<ext>` after a sniff
   (PNG/WebP/JPEG magic, ≤ 4 MB, decode succeeds). Root registered with the
   backend the same way as `VIDEORC_MANAGED_BACKGROUND_ROOTS` (new env
   `VIDEORC_MANAGED_GOLEM_ROOTS`), served through the managed asset
   protocol.
2. `golem-assets:remove` for "Start over" (deletes the persona folder;
   trash-first is not needed, these are app-owned copies).
3. Bundled default pack per D22, imported by the renderer like the Orcle
   emblem; `persona.source: 'default'` means "use the bundled pack".
4. **Done when**: a unit test imports a 1×1 PNG fixture and resolves a
   protocol URL; a rejected 5 MB file produces a named error; `pnpm build`
   green and the eager renderer budget check (CI) still passes (the pack
   must be lazy, not in the eager bundle).

### S-A4 Golem creation screen (Golem sub-tab)

Follows `videorc-design`. One glass panel, dense, keyboard-first.

1. **Header row**: avatar preview (current state image, 96 px, rounded
   square), name `Input` (placeholder "Name your Golem"), `Start over`
   ghost button with confirm `Dialog`.
2. **Personality** `Textarea` (1200 chars, counter in tertiary), with three
   example chips that fill it ("Grumpy old orc who secretly loves chat",
   "Cheerful goblin merchant", "Deadpan stone golem") ⚑ copy.
3. **Looks** section: four state tiles in a row (Idle, Talking, Laughing,
   Thinking). Each tile: image or empty hint, `Upload` ghost button
   (`Kbd` `U` when focused), `Generate` ghost button (Premium + consent;
   disabled with the gate tooltip otherwise). Above the tiles a
   `Describe it` input + style `Select` (Cartoon, Pixel, Painted, Sticker ⚑)
   and a primary `Generate all` text+kbd action (`⌘↵`). Generation shows a
   skeleton on each tile; failures show an inline tertiary line on the tile.
4. **Bubble** section: `speech | thought | shout` as a `ToggleGroup` with a
   live 2-line sample rendered by the Phase C rasterizer (in Phase A the
   sample is a static SVG; swap in S-C2).
5. **Joins my streams** (temporary home for the old Live switch, moved in
   S-D6) and the existing Cloud AI consent switch stay at the bottom.
6. Persist through `patchCohostSettings` on blur / tile change; no success
   toasts (design skill). Error toasts only.
7. **Done when**: screenshot review against the design skill by the owner;
   `pnpm typecheck && pnpm lint`; a renderer test covers "name required to
   save" and "Generate disabled without consent".

### S-A5 Web: avatar generation route

videorcweb, PR of its own, deploy **before** S-A6.

1. `app/api/ai/cohost/avatar/route.ts`: bearer auth as the other cohost
   routes, Premium check, body `{ prompt, style, state, baseImage?: base64 }`,
   returns `{ pngBase64 }`. Uses the Gateway image API with
   `VIDEORC_AI_AVATAR_IMAGE_MODEL`; for `state !== 'idle'` with a base image
   it calls the model's edit mode. Transparent background requested in the
   prompt; the route runs a server-side alpha check and, when the model
   returns an opaque image, applies a conservative white/near-white keyout
   only for `sticker` style ⚑, otherwise returns `opaque: true` so the
   desktop can tell the user.
2. Quota: a new counter `avatar` with a daily cap (⚑ 24 per account per
   day) in the same place as clean-cut jobs; `/api/ai/cohost/capabilities`
   reports `avatar: true` and the remaining count.
3. `docs/ai-gateway.md`: the env var, the model chosen, the probe result
   (four generations of one character, consistency judged by eye, attached
   as a tiny 256 px contact sheet in the PR, not committed).
4. **Done when**: route unit test with a mocked gateway; `pnpm lint` on the
   web repo (note: lint is broken on clean main there, see memory; run the
   file-scoped lint); deployed to production; a curl with a real token
   returns a PNG.

### S-A6 Desktop: generate flow

1. `videorc_api.rs`: `post_cohost_avatar` (same auth/timeout pattern as
   `post_cohost_tick`, 60 s timeout, 8 MB response cap).
2. RPC `cohost.avatar.generate { state, prompt, style }` (mutation): the
   backend calls the web, writes the PNG via the main asset importer path
   (backend returns bytes; main writes; or backend writes into the managed
   root directly ⚑ pick the one that matches S-A3), patches
   `persona.images[state]`, returns the asset path.
3. `Generate all` = idle first, then the three edits in sequence, surfacing
   per-tile progress through the existing `cohost-push`-style events.
4. **Done when**: with a real Premium account, `Generate all` fills four
   tiles in under 90 s on the owner's machine; `opaque: true` shows the
   inline hint "No transparency, upload a PNG with alpha for a clean cut".

### S-A7 Voice: wake word follows the name (D2)

1. `cohost_command.rs`: `wake_words(persona_name) -> Vec<String>` =
   `["golem"]` + name tokens; the hard-coded list is deleted. The parser
   reads the current name from `CohostSettings` on each utterance.
2. Tests: "golem mark that" matches; "grum mark that" matches when the
   persona is "Grum the Goblin"; "orcle mark that" no longer matches.
3. `docs/orcle-voice-commands.md` (or wherever plan 140 documented the
   grammar) updated.
4. **Done when**: `cargo test -p videorc-backend cohost_command` green.

### Phase A gates

`pnpm typecheck && pnpm lint && pnpm format:check && pnpm --filter @videorc/desktop test && cargo fmt --check --all && cargo clippy -p videorc-backend -- -D warnings && cargo test -p videorc-backend cohost` plus `pnpm build`.
No recording smoke: nothing in Phase A touches capture or output.

## Phase B — Overlays become placeable per-output items (PR 2)

Owner route Implementation, `fable-5`. This is the risky phase. It changes
the highlight card and captions **before** the Golem exists, so the Golem
phase is mostly UI and art.

### S-B1 `overlayLayout` store and RPCs

1. Rust: `overlay_layout.rs` with the types above, `load/save` through
   `Database::load_setting/save_setting` key `overlayLayout`, validation
   (rects inside 0..1, w/h ≥ 0.02), one-time migration from the comments
   window pref `highlightAnchor` (main sends it once through a new
   `overlays.layout.migrate_highlight_anchor` call on first launch after
   update; after success main deletes the pref key).
2. RPCs `overlays.layout.get` (observation) and `overlays.layout.set`
   (mutation, whole object), TS types + runtime schema + fixture.
3. **Done when**: Rust round-trip + migration tests; contract fixture test.

### S-B2 One leg plan for every overlay (D12)

1. `captions.rs`: `overlay_leg_plan(...)` pure function with the exhaustive
   table in D12 as a unit test. `caption_overlay_leg_plan`,
   `caption_overlay_leg_plan_with_vertical_leg` and
   `highlight_overlay_leg_plan` become thin wrappers that map
   `burnTarget` (captions) and `overlayLayout.highlight` switches onto it.
2. `force_same_profile_split` is raised when **any** item's plan says
   `needs_split`, not only captions. The renderer mirror
   (`needsCleanRecording` in `go-live-output.ts`) takes the item list.
3. The D13 fallbacks are computed by `overlay_start_notices(...)` returning
   a list of `{ item, notice }` the Go Live sheet renders verbatim.
4. **Done when**: `cargo test -p videorc-backend captions::overlay_leg_plan`
   covers all 5 session shapes × 4 switch combinations for one item; the
   plan 090 rejection tests still pass unchanged for captions.

### S-B3 Free rect placement in the three render paths

1. Replace `OverlayPlacement { vertical, horizontal }` with
   `OverlayRectPx { x, y, w, h }` per target, computed once per
   arm/update from the normalized rect × target canvas. The renderer still
   rasterizes to the target canvas; the rect is where the bitmap is
   blitted and the max width it wraps to.
2. CPU: `composite_caption_overlay` (`compositor.rs:8679`) takes the rect
   instead of `caption_overlay_layout_with_inset`. Metal:
   `push_caption_overlay_gpu_source` and the highlight quad take the rect.
   D3D11: `windows_d3d11_overlay_layer_geometry` takes the rect.
   `caption_overlay_layout_with_inset` is deleted when no caller remains.
3. `SetCaptionOverlayParams` and `SetCommentHighlightParams` carry the
   rect per target; the renderer computes the raster size from the rect
   (`captionOverlayTargetPlan`, `lib/comment-highlight.ts` canvases).
4. `CompositorLoopConfig` is updated live through the existing `watch`
   when `overlays.layout.set` lands mid-session (today it is only set at
   arm). Flags and rects both.
5. Parity fixture (new): a synthetic 1280×720 scene with a 200×100 red
   overlay at rect (0.1, 0.2, 0.25, 0.2) renders through CPU and Metal
   and the two readbacks match within ±2 per channel on every pixel of
   the overlay rect and its 2 px border; D3D11 gets the same fixture in
   the Windows CI job through `readback_bgra_for_parity_test`
   (`windows_d3d11_compositor.rs:1203`).
6. **Done when**: parity test green on macOS CI; `pnpm smoke:recording-studio`
   green (overlays are in the all-layout recording smoke; add an
   assertion that a highlight placed at (0.05, 0.05) appears in the
   top-left tile of the ffprobe'd frame via the existing analyzer's
   per-tile luma check).

### S-B4 Overlay items on the Live Scene canvas (D15)

Follows `videorc-design`.

1. `scene-stage.tsx`: a second item layer rendered after sources: three
   dashed-outline rects (hairline, white-28% in dark / black-25% in light)
   with a 12 px label chip (`Highlight`, `Captions`, `Golem`) and a
   "stream only" / "recording only" badge when the switches differ. Drag
   and resize reuse `stage-gesture.ts`; the commit goes to
   `overlays.layout.set` (not to the scene transaction policy) and is one
   commit per gesture.
2. **Orientation** `ToggleGroup` (Horizontal / Vertical) above the stage,
   visible only when `simulcast` is configured. Vertical shows the derived
   vertical scene as a greyed background with the vertical overlay rects
   editable.
3. Inspector for a selected overlay item: `Show on stream` and `Show in
   recording` `Switch`es, a `Snap` menu (four corners, centre bottom), and
   for captions the existing style/size controls moved here from the
   captions panel ⚑ (one home). Captions' `position` picker is deleted.
4. Stream Manager status bar: `HighlightAnchorOptions` becomes the same
   `Snap` menu writing `overlayLayout.highlight` (D11).
5. Go Live sheet: renders `overlay_start_notices` as tertiary lines under
   the destinations, with the item name in primary.
6. **Done when**: owner by-eye on both themes; `pnpm probe:preview-lifecycle`
   green (the stage changed); a renderer test asserts a drag on the
   Highlight rect calls `overlays.layout.set` once with a clamped rect.

### S-B5 Captions switches derive `burnTarget` (D14)

1. The captions session params builder maps `overlayLayout.captions`
   switches → `burnTarget`; the Captions settings UI loses its own
   burn-target control in favour of the inspector switches (S-B4.3), with
   a one-line pointer "Placement and output live in Scene".
2. **Done when**: `pnpm smoke:captions-contract`, `pnpm smoke:captions-live`
   and `pnpm smoke:captions-dual-orientation` are green; a unit test
   covers all four switch combinations → `burnTarget`.

### Phase B gates

TS + Rust gates as Phase A, plus `pnpm smoke:recording-studio`,
`pnpm smoke:recording-matrix` (encode topology touched),
`pnpm smoke:comment-highlight-stream`, the three captions smokes from
S-B5, `pnpm smoke:freeform-editor` (stage gestures) and
`pnpm probe:preview-lifecycle`. Windows CI must be green (D3D11
geometry). Memory [[feedback-gates-at-the-end]]: write all
Phase B slices first, then run the smokes once.

## Phase C — Golem on stream: avatar states + comic bubble (PR 3)

Owner route Implementation, `fable-5`.

### S-C1 `golem_overlay` slot and state machine

1. `cohost.rs`: `GolemOverlayState { persona_id, state, bubble: Option<{text, until}> }`
   owned by the backend; transitions per D18; a 100 ms tick drops expired
   bubbles. Events `cohost.golem.state` pushed to the renderer (and relayed
   to Stream Manager through `cohost-push`).
2. `SetGolemOverlayParams { target: primary|auxiliary, pngBase64, rect }`
   mirrors `SetCaptionOverlayParams`; slots `GolemOverlaySlots {primary, auxiliary}`;
   `golem_overlay_on_{primary,aux}` flags added next to the caption/highlight
   ones in `CompositorStartParams` / `ArmParams` / `LoopConfig`, fed by
   `overlay_leg_plan` from `overlayLayout.golem`.
3. **Done when**: Rust tests for the transitions (idle→talk→idle, think
   pre-empted by talk, laugh overrides talk, bubble expiry) and for the
   flag plumbing.

### S-C2 Renderer rasterizer

1. `lib/golem-overlay.ts`: `renderGolemOverlay({ image, state, bubble, style, canvas, rect })`
   → PNG per target, like `lib/comment-highlight.ts`. Layout: avatar fills
   the rect's width, bubble above with a tail, 4-line wrap at the rect's
   width, 14-18 px text scaled to canvas height. Light bubble always (D17).
   Re-render on state change or bubble change only.
2. The Phase A bubble sample in the Golem sub-tab uses this renderer.
3. Snapshot tests for the three bubble styles at 1920×1080 and 1080×1920.
4. **Done when**: snapshots committed (tiny, ≤ 30 KB each); `pnpm --filter @videorc/desktop test` green.

### S-C3 Three render paths blit the Golem

1. CPU, Metal, D3D11 take the `golem` overlay exactly as the highlight
   quad, after captions, before the highlight card (the highlight card is
   the most urgent thing on screen, it wins overlaps) ⚑.
2. The parity fixture from S-B3 gains the golem layer.
3. **Done when**: parity test green; `pnpm smoke:recording-studio` green
   with the fake-activity smoke extended to push one utterance and assert
   the recorded frame shows a non-background blob inside the golem rect.

### S-C4 Stream Manager: Golem pane

1. `cohost-pane.tsx` becomes the Golem pane: header shows the state image
   (32 px) + persona name + a `Show on stream` `Switch` bound to
   `overlayLayout.golem.showOnStream`; a **Say** `Input` (`↵` sends an
   utterance `{trigger: manual}`, `⌘↵` sends with state `laugh`) ⚑ chips
   for states.
2. Utterance list (proposed / sent / bubble-only) reusing the command
   card primitive.
3. **Done when**: owner by-eye; typing "Hello horde" + ↵ shows the bubble
   on the preview within 300 ms on the owner's machine.

### Phase C gates

As Phase B (smokes once at the end).

## Phase D — Automatic chat: greetings, answers, banter (PR 4)

Owner route Implementation, `fable-5`. First time the app posts on its own.

### S-D1 Greeting engine (templates, no AI)

1. `cohost_greetings.rs`: pure `resolve_template(template, event) -> Result<String, UnknownField>`
   with the field table from Wire shape; `pick_template(templates, event, rng)`
   (enabled, kind, platform match, random among variants);
   `collapse(events_in_window)` per D9.
2. Trigger: the existing `LiveChatMessage` ingestion in `cohost.rs` (the
   path auto-show rows already flow through) calls the engine for
   activity-only events when `autoChat.greetings.enabled` and
   `mode != off`.
3. Tests: every `ActivityTemplateKind` resolves against the matching
   fixture from `scripts/fixtures/stream-manager/*.json`; community gift
   collapses to one; `{reward}` uses the plan 163 points name; X text is
   clipped by the caller, not here.
4. **Done when**: `cargo test -p videorc-backend cohost_greetings` green.

### S-D2 Throttle and send path (D9, D10)

1. `cohost_throttle.rs`: token bucket per destination (6/min, 5 s gap),
   per-kind cooldowns, dedupe set per (destination, viewer, kind), YouTube
   breaker check, destination-failed check. Pure, clock-injected, tested
   with a fake clock across a 50-follow burst (expect: 1 message now, 1
   collapsed at +10 s, rest deduped).
2. `send_automatic(utterance)` wraps `send_live_chat_message` with a
   Golem-owned `operationId`, records it in the session set consulted by
   `cohost_ack.rs`, writes a `cohost_reports` row `{trigger, text, destinations, result}`.
3. Suggest mode: the utterance is pushed as `proposed`; approval from
   Stream Manager goes through a new `cohost-action` kind `approve-utterance`
   → the same `send_automatic`. Dismiss marks it `dismissed`. Proposed
   cards expire after 45 s ⚑.
4. **Done when**: throttle tests; a fake-provider smoke
   (`scripts/smoke-live-chat-fake-providers.mjs`, fake send behaviours at
   `live_chat.rs:1849`) runs in `auto` with 3 enabled templates and asserts
   exactly the expected sends land on the fake destinations in order, and
   zero when `mode: off`.

### S-D3 Answers (AI)

1. Web tick v4 (persona + mood) behind `/capabilities` `tick: 4`; the
   desktop sends `persona` only on v4. The tick's existing reply suggestion
   path gains a flag `addressed: boolean` (the viewer named the Golem or
   used `@<name>`).
2. Desktop: when `answers.enabled`, a tick reply with `addressed: true`
   becomes an utterance (state from mood) → Suggest card or automatic send
   per mode, under the throttle and the answers cooldown. Unaddressed
   question replies stay suggestions only ⚑ (safer first ship).
3. **Done when**: web route test for v4; desktop test that a v3 web
   (no `tick: 4`) never sends `persona`; fake tick fixture produces one
   automatic send in `auto` and one card in `suggest`.

### S-D4 Banter (AI, default off)

1. Reuse the dead-air nudge timer in `cohost_ack.rs` as the trigger; a
   tick request with `intent: 'banter'` (web v4) returns one short line
   (≤ 120 chars) and a mood. Cooldown `banter.cooldownSeconds`, never
   while a greeting or answer was sent in the last 60 s.
2. **Done when**: tests for the gating; fake tick smoke covers one banter
   line in `auto`.

### S-D5 Greeting templates editor (Golem tab → Chat sub-tab)

Follows `videorc-design`.

1. The Chat sub-tab gets a **Greetings** section above Replies: a sectioned
   list, one row per `ActivityTemplateKind` the connected platforms can
   produce (24 px platform icon when `platform` is set, kind title, the
   template text in secondary, a `Switch`). Enter on a row opens an inline
   editor: `Textarea` (200 chars, counter), state `ToggleGroup`
   (Talk / Laugh / Think), platform `Select` (Any / Twitch / YouTube /
   Kick / X), a **Fields** `Popover` listing the braces with one-click
   insert, a live preview rendered against the fixture event for that
   kind, and an inline tertiary warning when the text exceeds a cap on an
   enabled platform or uses an unknown field. `Add variant` (⌘N) adds a
   second row for the same kind.
2. Ship a starter set when the list is empty ⚑ copy: follow "Welcome,
   {name}!", sub/resub "{name} joined the ranks ({months} months)",
   cheer "{amount} from {name}, much obliged", raid "{name} brings {count}
   warriors. Welcome!", watch-streak "{name}, {streak} streams strong".
3. Replies section: `Answers` and `Banter` switches with their cooldown
   `Slider`s; both gated like the rest of Cloud AI.
4. **Done when**: owner by-eye; renderer tests for the cap warning and
   the unknown-field warning.

### S-D6 Stream Manager: mode control and consent

1. The Golem pane header (S-C4) gets the **Chat** mode as a three-value
   `ToggleGroup` `Off | Suggest | Auto`, plus three small `Switch`es
   `Greetings · Answers · Banter`. The old "Orcle joins my streams" switch
   is removed from the tab; the pane's enable is the mode (Off = disabled).
2. Turning the mode to Suggest or Auto the first time opens the consent
   `Dialog`: "The Golem posts to your chats as **you**, on the platforms
   you stream to, only in the modes you turn on. You can watch every
   message in Reports." Confirm lands in Suggest. Auto requires a second
   explicit click with the sentence "Automatic messages are sent without
   asking you first."
3. The stats bar gains a `golem` stat (sends this session) ⚑.
4. **Done when**: owner by-eye; a renderer test asserts Auto is not
   reachable without the second confirm.

### Phase D gates

TS + Rust gates, `pnpm smoke:remote-control` (Stream Manager relay
touched), `pnpm smoke:live-chat-fake-providers`, `pnpm smoke:cohost-fake`,
`pnpm smoke:orcle-commands` (wake words changed in S-A7), and a
**live acceptance** on the owner's
own channels with Suggest first, then Auto for ten minutes with Greetings
only. Record the acceptance in `docs/acceptance/2026-xx-xx-golem-auto-chat.md`.

## Phase E — Docs, gates, acceptance (PR 5)

- `docs/golem.md`: what it is, modes, the promise (D4), where things live
  (tab creates, Stream Manager operates, Scene places), what is Premium,
  what posts as you, platform caps, the throttle table.
- `docs/overlays.md`: the three items, the leg plan table, the D13
  fallbacks with the exact Go Live sentences, the weak-Windows behaviour.
- `plans/README.md` entries; `CLOUD_AI_USES` gains "Avatar images" and
  "Chat replies as you" lines.
- Extend `fake_events()` only if a new kind is added (none planned); the
  16-row count stays.
- Owner acceptance checklist (by eye): rename everywhere, create a Golem,
  generate four states, place it on both orientations, record+stream with
  `showInRecording: off` on macOS and confirm the MKV is clean while the
  stream shows it, trigger a fake follow and see the bubble + chat line.

## STOP conditions

- `publish_compositor_frame` or `CompositorLoopConfig` changed on
  origin/main since `3fcc17e4` in a way that moves the overlay flags.
- The plan 090 renderer or backend topology tests fail after S-B2 for
  **captions**: the caption block must stay exactly as shipped.
- The parity fixture differs between CPU and Metal by more than the keyer
  tolerance: do not "fix" by loosening the tolerance.
- Any automatic send path can run with `mode: off` in a test.
- The web zod rejects a v4 tick from a desktop that saw `tick: 4` in
  capabilities (deploy order broken).
- The encoder count during record + single-orientation stream exceeds 2,
  or any session tries a third leg.

## Out of scope

- A Twitch (or any) bot account; everything posts as the streamer (D3).
- Animation, rigs, lip sync, TTS. State images only.
- Post-recording "clean" or "burned" copies for highlight and golem (the
  ffconcat burn exists for captions and is the obvious follow-up).
- Per-orientation **source** layouts (the vertical leg stays derived);
  only overlay rects are per orientation.
- Hype train, polls, hosts: no event exists, so no template kind.
- Syncing persona or templates to the web account.
- Generating the sidebar glyph; `OrcleIcon` stays until the owner supplies
  art.

## Open questions for the owner

1. D2 wake words: drop `orcle` entirely, or keep it as a hidden alias for
   one release?
2. D5/S-D4: ship Banter in Phase D or hold it?
3. D6: are Greetings really free, or Premium like the rest of the Golem?
4. D13: for highlight/golem on weak Windows, "burn on both with a notice"
   (planned) versus blocking Go Live like captions?
5. D22: who makes the default golem pack? Four PNGs, transparent, ~512 px.
6. S-A5: daily avatar generation cap of 24, and which image model (the
   probe decides, but a preference helps).
7. S-C3: Golem under the highlight card on overlap, or above?

## Handoff (cold start)

- Goal: this plan, one phase per PR, in order A → B → C → D → E. D may
  start in parallel with B/C by a second agent (it touches `cohost*.rs`,
  `live_chat.rs` and Stream Manager; B/C touch the compositor, captions
  and the scene stage).
- Current state: nothing built. Desktop `3fcc17e4`, web `b339c1fb`.
- Route and lanes: see Status. Re-score if a phase grows.
- Work in a fresh worktree from origin/main per phase
  ([[feedback-shared-checkout-use-own-worktree]]); brief sub-agents with
  `git show origin/main:<path>` ([[feedback-subagents-read-origin-main]]).
- Gates: per phase above; smokes once at the end of a phase
  ([[feedback-gates-at-the-end]]).
- Blockers: S-A5/S-A6 need a Premium account and the web deploy; Phase D
  acceptance needs the owner's live channels; Windows CI covers D3D11.
