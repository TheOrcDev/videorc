# Plan 239: Avatar and Sidekick

The owner's ask (2026-11-15): "Currently our sidekick is two things: a
moderator and control for stream manager, which is a really cool and very
sellable feature; the avatar that goes on live stream. I want to separate
those two."

Today one name covers both jobs. The character on stream and the helper
that works the chat share one page, one pane in Stream Manager, one
first-run flow and one web page. This plan makes them two products:

- **Avatar**: the character on the stream. It has the name, personality
  and look the streamer gave it, a bubble, reactions and its own greeting
  lines. Free, except making a look or an Alive pack with AI.
- **Sidekick**: the helper only the streamer sees. It reads chat, hears
  the streamer, catches questions, drafts replies, flags spam, removes
  comments, takes voice commands and writes the stream report. Premium
  with Cloud AI, as today.

One rule joins them: **Sidekick writes, the avatar says.**

## Status and scope

- **Status: EXECUTING 2026-11-15.** The owner answered the five questions
  of the suggestion (below), then D1–D7 (2026-11-15): "Go all choices
  recommended, execute the entire plan and create a pr." So every D takes
  its recommended answer, and the golem is **Flint** (D2). The desktop
  slices A, B and C land as commits of one PR.
- Facts are from `origin/main` of each repo on 2026-11-15: desktop
  `161fa472f` (0.26.0), web `a616a306`, Rust UI `dcf02d4f1`. Line numbers
  drift; search for the quoted name.
- Repos and PRs, in order:
  1. **Web** (`TheOrcDev/videorcweb`, `~/projects/videorcweb`): one PR,
     deployed first. New pages, redirects, copy, prompts.
  2. **Desktop** (`TheOrcDev/videorc`): one PR, merged after the web
     deploy, in three slices. A: the Avatar page. B: the Stream Manager's
     two blocks. C: the words everywhere else, the golem's name, the
     guards.
  3. **Rust UI** (`videorc-rust`, private): no work now. It takes plan 236
     and this plan in one port slice after its upstream merge.
- This is a product, page and copy change. The engine is already split
  this way:
  - Greetings and welcomes run with Sidekick Live off. `note_activity`
    (`cohost.rs:7760`) checks no Premium, no consent and not `enabled`;
    the test `ai_greetings_need_premium_consent_the_capability_and_the_switch`
    holds it.
  - The Say box, reactions and the viewers' `!link` lines check nothing
    either.
  - Questions, flags, drafts, removals, voice commands and reports never
    touch the avatar.
  - AI greetings, Answers and Banter need Premium, Sidekick Live and a
    consented tick session (`greet_ai_context` `cohost.rs:7842`,
    `prepare_tick` `:7568`, `prepare_banter` `:7947`).
- Size:
  - Desktop: "Sidekick" is on 734 renderer lines in 164 files, 42 in
    shared, 476 in the backend crates and 376 in docs. Most stay, because
    they are about the helper. The avatar side is the Profile tab's
    library, persona, look, reactions and motion sections, the Greetings
    section, the onboarding, the pet creator, the Test dialog, and about
    60 backend strings in 11 files.
  - Web: 606 lines in 104 files. `/sidekick/create`, `/account/sidekicks`,
    the onboarding copy module, about 35 library and creator error
    strings and the OG card are about the character. `/sidekick` is half
    and half.
  - Rust UI: no "Sidekick" anywhere yet. Its UI crates hold "Buddy" on 66
    `.slint` lines and 181 `.rs` lines inside strings.
- **The keep rule stands (plan 236 D1).** A name a program reads stays:
  `/api/buddy/*`, `cohost.*` RPCs and events, `cohostSettings` and its
  saved shape, database tables, storage keys, env names, MCP tool names
  (`buddy_say`, `set_buddy`), Stream Deck UUIDs, `videorc://buddy`, the
  page id `ai`, the tab id `live`, identifiers, test ids, script names and
  existing file names. New files may say `avatar`. History (`plans/`,
  `changelog/`, `docs/releases/`, `docs/acceptance/`) keeps its words.

## What the owner decided (2026-11-15)

1. The character is called the avatar. The helper keeps the name
   Sidekick, the wake word and the `/sidekick` command.
2. Sidekick works as before. It owns Answers, Banter and AI-written
   greetings, and they stay Premium with Cloud AI.
3. The Avatar page sits in the sidebar's Setup group. Sidekick stays in
   the Livestream group.
4. Pricing does not change.
5. The avatar's own name keeps waking voice commands ("Grum, put this one
   up"), but the app stops teaching it.

Also part of the suggestion the owner approved: Community, Reports and
Clean cut stay on the Sidekick page (the Premium showcase, owner call
2026-10-10).

## The two products

|                        | Avatar                                                                          | Sidekick                                                                          |
| ---------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| What it is             | The character on the stream                                                     | The helper that works the chat and the show with the streamer                     |
| Who sees it            | Viewers                                                                         | Only the streamer                                                                 |
| What it does           | Stands on stream, reacts to follows, subs and raids, greets, says the Say box   | Questions, drafted replies, flags, removals, voice commands, reports              |
| Free                   | Official avatars, own pictures, an imported Alive pack, greetings in own lines  | Community, manual "Remove from chat", `/marker`                                   |
| Premium with Cloud AI  | A look made by AI, creating an Alive avatar                                     | Sidekick Live, Answers, Banter, AI-written greetings, voice commands, memories    |
| Set up in              | The Avatar page (new, Setup group)                                              | The Sidekick page (Livestream group)                                              |
| Live in Stream Manager | The Avatar block of the pane                                                    | The Sidekick block of the pane                                                    |
| On switch              | "{name} on stream" and "Show in recording"                                      | Sidekick Live                                                                     |

How they meet:

- **Both on.** Sidekick's lines come out in the avatar's bubble, in the
  avatar's voice. The persona still rides the tick (`tick_persona`,
  `cohost.rs:3899`), so nothing changes on the wire.
- **Avatar only.** It greets with built-in lines or the streamer's own,
  reacts, waves at regulars and takes the Say box. This is the free
  product.
- **Sidekick only.** Questions, flags, drafts, removals, voice commands
  and reports work with no avatar. Its lines need somewhere to show: see
  D3.

## Decisions for the owner

- **D1. The words.**
  - **a (recommended):**
    - "Avatar" names the page, the sidebar row, the Stream Manager block
      and the web page. In a sentence it is a common noun, lower case:
      "your avatar", "My avatars", "New avatar…", "Create your avatar",
      "Use as my avatar", "official avatars", "the avatar library".
    - The character goes by its own name wherever one is at hand:
      "{name} on stream", "{name} talks" and "Say something as {name}"
      stay as they are.
    - "Sidekick", with no article, means the helper only: Sidekick Live,
      the Sidekick page, the Sidekick pane, "Sidekick, …", `/sidekick`,
      "Sidekick requires Videorc Premium."
    - The test for a sentence that says Sidekick today: if it is about
      the look, the bubble, reactions, motion, the picture, the library,
      creating one or being on the stream, it becomes the avatar. If it
      is about reading chat, hearing, writing lines, flagging, removing,
      commands, reports or Premium, it stays Sidekick.
    - Tabs. Avatar: **Profile**, **Greetings**. Sidekick: **Overview**
      (the id stays `live`), Chat, Community, Voice, Reports, Clean cut.
  - b: write it as a product name with a capital, like Sidekick ("My
    Avatars", "your Avatar").
  - The owner can change any word.
- **D2. The stone golem's name.** The official golem is named "Sidekick"
  (`protocol-fixtures/buddy-official-catalog.json`), and so is every new
  avatar (`COHOST_DEFAULT_PERSONA_NAME`, `cohost.rs:524`). After the
  split, a new install has an avatar called Sidekick beside a helper
  called Sidekick.
  - **a (recommended):** the golem gets a name of its own, like Golmar,
    Nib, Captain Barnacle and Bolt. Recommended: **Flint** ("Flint the
    Golem"). Others: Pebble, Boulder. The owner took Flint (2026-11-15).
    - Changes: the catalog in both repos, the default persona name, the
      name placeholder and the web's default persona prompts.
    - A saved avatar named exactly "Sidekick" is renamed once, only when
      it still wears the default look or the official golem. An avatar
      with the streamer's own pictures keeps its name. No web data
      changes: library rows are the streamer's own.
    - The new name becomes one more word that wakes commands for those
      streamers (decision 5). "Sidekick" always works.
  - b: the golem stays "Sidekick". No migration, and the default setup
    shows two things with one name.
- **D3. Sidekick's lines while the avatar is off the picture.** In Bubble
  today, greetings are skipped and counted `no-bubble`, an answer is
  skipped with a log line, and banter is never asked for. The pane
  already says so: "{name} isn't on stream. Viewers can't see its bubble,
  so Bubble says nothing." with "Show on stream"
  (`lib/buddy-output-notice.ts:49`).
  - **a (recommended):** the engine stays as it is. While Sidekick Live
    is on and Answers, Banter or AI greetings are on, that notice says
    Sidekick's lines have nowhere to show and gains a second action,
    "Use Suggest". It switches "{name} talks" to Suggest through the same
    "Let {name} post as you?" consent the control asks. Renderer only.
  - b: reroute by itself, so Sidekick's lines become Suggest cards
    whenever the avatar is off the picture. This is the behaviour the
    suggestion described. It is not recommended here:
    - It touches ten places: `route`, `greet`, `note_activity`, `drain`,
      `apply_greet_result`, `route_answer`, `banter_allowed` and
      `route_banter` in `cohost_auto_chat.rs`, and both send gates in
      `cohost.rs` (`:8034`, `:8627`), which refuse a card unless talk is
      Suggest.
    - The posting consent is asked only when Suggest is chosen
      (`buddy-chat-controls.tsx:71`) and lives only in the renderer. A
      rerouted card could post as the streamer with no consent ever
      asked.
    - Bubble would stop meaning one thing.
    - If the owner wants it, it is its own plan with
      `smoke:live-chat-fake-providers` scenarios.
- **D4. Where "About you" lives.** It is `cohostSettings.notes`, edited
  under Name and personality (`buddy-persona-section.tsx:128`). The
  library carries it per avatar: using one sets it, and edits go back to
  the account. The creator's step 3 asks for it. Answers and reply drafts
  read it.
  - **a (recommended):** it stays with the name and personality on the
    Avatar page: what the avatar knows about the streamer. Sidekick →
    Chat → Replies keeps its pointer to it. No data or contract change.
  - b: its home moves to Sidekick → Chat → Replies and the library stops
    carrying it. That changes the web library, the creator's step 3, Use
    and the sync, with 0.26.0 in the field.
- **D5. Web URLs** (recommended as written):
  - `/avatar` is the avatar's page, with `/avatar/create` and
    `/account/avatars`. `/sidekick` is the helper's page.
  - 308s: `/sidekick/create` → `/avatar/create`, `/account/sidekicks` →
    `/account/avatars`, and `/sidekick?use=<slug>` → `/avatar?use=<slug>`.
    The old `/buddy/create` and `/account/buddies` rules point straight
    at the new pages, so there are no chains.
  - `/buddy`, `/orcle*` and `/golem*` keep pointing at `/sidekick`.
  - The nav and footer get "Avatar" beside "Sidekick".
  - API routes, `public/buddy/*` and `videorc://buddy` stay.
- **D6. Shortcuts for ten pages.** Nine pages hold ⌘1–⌘9 down the
  sidebar (plan 235 D8). Avatar makes ten.
  - **a (recommended):** the rule stays, and Library takes ⌘0.

    | Page         | Shortcut | Today |
    | ------------ | -------- | ----- |
    | Studio       | ⌘1       | ⌘1    |
    | Sources      | ⌘2       | ⌘2    |
    | Scene        | ⌘3       | ⌘3    |
    | Assets       | ⌘4       | ⌘4    |
    | Captions     | ⌘5       | ⌘5    |
    | Avatar       | ⌘6       | new   |
    | Output       | ⌘7       | ⌘6    |
    | Destinations | ⌘8       | ⌘7    |
    | Sidekick     | ⌘9       | ⌘8    |
    | Library      | ⌘0       | ⌘9    |

    Four pages move by one, one release after plan 235 moved them.
  - b: Avatar has no digit, like Health; ⌘K and the sidebar reach it.
    Nothing moves, and one row in Setup has no chip.
- **D7. Sidekick's mark.** The design skill says the Sidekick mark is the
  owner's stone golem, always the real artwork (owner call 2026-10-04).
  `BuddyEmblem` shows the avatar's picture, else the golem. The sidebar
  row already wears a plain glyph, `BuddyPageIcon` (plan 235 D7).
  - **a (recommended):** the golem artwork goes with the golem avatar.
    Sidekick wears `BuddyPageIcon` wherever it needs a mark: its page's
    status row, the pane header, the ⌘K group and Premium locks. The
    avatar's picture shows only on avatar surfaces. On the web, the cast
    artwork and its OG card go to `/avatar`, and `/sidekick` gets a card
    from the Stream Manager screenshot it already shows.
  - b: the golem emblem stays Sidekick's brand mark, though the default
    avatar is the same golem.
  - Either way the skill's owner call is rewritten.

## Where everything goes

The Sidekick page today (`components/tabs/buddy-tab.tsx`):

| Today                                                                                          | After                                                                                     |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Profile: status row (`BuddyProfileStatus`): picture, name, status, Sidekick Live, Open Stream Manager | Sidekick → Overview keeps status, the switch and Open Stream Manager, under the glyph (D7) |
| Profile: the "{name} isn't on stream yet" note                                                 | Avatar → Profile, in its status row                                                       |
| Profile: My Sidekicks (`BuddyLibrarySection`)                                                  | Avatar → Profile, "My avatars"                                                            |
| Profile: Name and personality, About you, Bubble, Start over (`BuddyPersonaSection`)           | Avatar → Profile                                                                          |
| Profile: Avatar (Still or Alive, Test, Import moves…, Create), Reactions, Motion (`BuddyPetSettings`) | Avatar → Profile; the "Avatar" section becomes "Look"                               |
| Profile: Sidekick Live and listening, What Sidekick does, Cloud AI                             | Sidekick → Overview. Cloud AI keeps its one home                                          |
| Chat: Greetings (`BuddyGreetingsSection`)                                                      | Avatar → Greetings                                                                        |
| Chat: "Write greetings with AI" (inside Greetings)                                             | Sidekick → Chat → Replies, beside Answers and Banter: it needs Sidekick Live              |
| Chat: Replies, Moderation                                                                      | Stay                                                                                      |
| Community, Voice, Reports, Clean cut                                                           | Stay                                                                                      |
| The onboarding, the pet creator, the Test dialog                                               | Open from the Avatar page                                                                 |

The Sidekick pane in Stream Manager (`stream-manager.tsx`, `buddyPane`):

| Today                                                                                   | After                                                                              |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Header: the living preview, name and bubble (`BuddyIdentity`, `:1045`)                  | Avatar block                                                                       |
| Header: Alpha, listening, status, Sidekick Live                                         | Sidekick block header, led by the glyph and "Sidekick"                             |
| "{name} talks": Off, Bubble, Suggest, and the chips (`BuddyChatControls`, `:1078`)      | Avatar block. Greetings chip → Avatar → Greetings; Answers and Banter → Sidekick → Chat |
| Command strip, cards, the listening card, the triage list (`CohostPane`)                | Sidekick block, unchanged                                                          |
| Footer: Say box, reactions, "{name} on stream", the off-picture notice (`BuddySayFooter`, `:1249`) | Avatar block                                                            |

The pane keeps its tab, its name "Sidekick" and ⌘J. The Sidekick block is
on top and takes the height; the Avatar block sits at the foot under one
hairline. Nothing is shown twice.

The sidebar: Setup holds Sources, Scene, Assets, Captions, **Avatar**,
Output. Livestream holds Destinations and Sidekick.

## Slices

### Web PR (deploy first)

Owner route: Implementation (fit 8), with UI/Product Design for the two
landing pages. Model lane: `opus-5.5`. Work in a fresh worktree of
`videorcweb` from `origin/main`.

- **W1. Pages and URLs (D5).**
  - `app/avatar/page.tsx` takes the character sections of
    `app/sidekick/page.tsx`: the lead, "How it looks on stream", "What it
    does", "Start from one of ours" (L110–193) and the two character
    answers of the FAQ ("Can I make my own…", the picture question).
  - `app/sidekick/create` moves to `app/avatar/create`, and
    `app/account/sidekicks` to `app/account/avatars`.
  - `/sidekick` keeps L195–585, gets a hero about the helper, and its two
    creator buttons go. Its old anchors stay.
  - OG and Twitter images per D7 (`lib/og-image.tsx`).
  - `next.config.ts` holds every redirect; there is no middleware, and
    none is added. The `/sidekick?use=` rule needs a `has` query match.
  - `components/nav/nav.tsx:33`, `components/footer.tsx:19`, the account
    nav and menu labels, `lib/metadata.ts` (the `buddy` route entry and a
    new one), `lib/structured-data.ts:434`, `lib/llms-txt.ts`,
    `lib/llms-full.ts`.
  - Done when: on a preview deploy every old URL in D5 answers one 308 to
    its new page; `/sidekick` shows no creator and no gallery; `/avatar`
    speaks of reading chat only in the one line W2 gives it.
- **W2. Copy (D1).**
  - `lib/buddy-onboarding-copy.ts`, the same strings desktop A3 writes
    into `docs/buddy-onboarding-copy.md`:
    - Step titles: "Meet your avatar", "Describe it", "Give it a
      personality", "Create your avatar".
    - "Create my avatar", "Use as my avatar", "My avatars", "New
      avatar…", "Avatars you create show up here, on videorc.com and in
      the app.", "Sign in to create an avatar.", "Creating your own
      avatar is part of Videorc Premium.", "Your library is full
      ({limit} avatars). Delete one to make room."
    - The name placeholder is "Flint" (D2).
    - "What it does", line 2: "With Sidekick, answers viewers' questions
      from what you tell it". The other four lines stay.
    - The About you help line stays: "Sidekick answers viewers' questions
      from this."
  - `lib/buddy-guide.ts`: the character lines move to a new
    `lib/avatar-guide.ts`. The wake-word line (L100) drops "that name
    works too" (decision 5).
  - Error messages about the library, the look and Alive packs say
    avatar: `lib/buddy/library-route.ts`, `lib/buddy/alive-route.ts`,
    `lib/ai/cohost-avatar-route.ts` (338, 399, 709, 732),
    `lib/ai/buddy-look.ts:66`, `app/account/settings/actions.ts:286`. The
    helper's messages stay. A 0.26.0 app shows these under "My
    Sidekicks", and they still read right.
  - `app/privacy/page.tsx`: "Avatars you create." and "Avatars that
    move." (L257–280), and the date. The helper's sections stay.
  - `lib/agents-guide.ts:99–104`, `content/blog/restream-alternative.mdx`
    L57 with its FAQ copy in `lib/blog/posts.ts:504`, and the title of
    `public/buddy/official/README.md`. The Product Hunt post keeps its
    words.
- **W3. Prompts.**
  - The default persona in `lib/ai/cohost.ts:1118`,
    `lib/ai/cohost-greet.ts:195` and `lib/ai/cohost-memory.ts:266` is
    named "Flint" (D2).
  - `lib/ai/cohost-command.ts:195`: Sidekick is "their assistant"; the
    streamer may also call it by their avatar's name. It still knows
    "side kick" and "Buddy".
  - `lib/ai/buddy-act.ts:237`: "the planner for Sidekick, the streamer's
    assistant". The strip lines stay.
  - Done when: `pnpm eval:cohost-command` and `pnpm eval:buddy-act` dry
    runs pass in CI. The paid runs need the owner's go: AI Gateway credit
    ran out twice this month.
- **W4. The golem's name (D2 a).** `lib/buddy/official.ts:92`,
  `tests/fixtures/buddy-official-catalog.json:8`,
  `tests/name-guards.test.ts:359`, the OG alt text
  (`lib/og-image.tsx:17`) and `lib/llms-txt.ts:26`. Same content as the
  desktop fixture in C3.
- **W5. Tests and the guard.**
  - Update the tests that pin words and paths: `buddy-onboarding.test.ts`,
    `buddy.test.ts`, `blog.test.ts`, `metadata.test.ts`,
    `search-surfaces.test.ts`, and the required routes in
    `name-guards.test.ts` (L204–237).
  - New guard in `name-guards.test.ts`: page copy under `app/avatar`,
    `app/account/avatars`, the onboarding copy module and the library and
    Alive route messages may say "Sidekick" only on an allow-list (the
    cross-sell line, the About you help). An entry that matches nothing
    fails.
  - New test over `next.config.ts`: the D5 table, and no rule whose
    destination is another rule's source. No test covers the redirects
    today.
- **Gates:** the web repo's typecheck, lint, tests and build; the eval dry
  runs; the redirect check on the preview. After deploy, a desktop at
  0.26.0 still loads My Sidekicks and its pictures through
  `/api/buddy/*`, and its "New Sidekick…" link lands on `/avatar/create`.

### Desktop PR A: the Avatar page

Owner route: UI/Product Design (fit 9). Model lane: `opus-5.5`. Read
`.claude/skills/videorc-design/SKILL.md` and `docs/ui-copy.md` first.

- **A1. Navigation.**
  - `components/workspace-nav.tsx`: a page id `avatar` in `WorkspaceTab`
    and `WORKSPACE_TABS`, the Setup zone as sources, layouts, assets,
    captions, avatar, recording, and `WORKSPACE_SHORTCUTS` per D6. Main
    forwards only '1'–'9' today (`main/index.ts:3003`, `:3592`); it adds
    '0'. Nothing in main binds ⌘0 today; confirm it.
  - The icon: `docs/icon-set.md` counts 95 slots over 91 glyphs. Use a
    slot that already means it if there is one; else add
    `AvatarPageIcon` and write it into that doc.
  - `lib/avatar-tabs.ts`, shaped like `lib/buddy-tabs.ts`: ids `profile`
    and `greetings`, labels, a remembered tab under `videorc.avatarTab`.
    It sits in the eager chunk, so it holds no icons and no components.
  - `lib/workspace-navigation.ts`: `openWorkspaceTab('avatar', tab?)`.
  - ⌘K gets an "Avatar" group beside the Sidekick one
    (`components/command-palette.tsx:623`).
  - `videorc://buddy` opens the Avatar page, and `?alive=` the creator
    there (`main/buddy-deep-link.ts`, `showBuddyTab`).
  - `scripts/capture-ui-pages.mjs:86` gains the page with its two tabs.
    Sidekick still has six.
- **A2. The page.**
  - `components/tabs/avatar-tab.tsx`, a lazy chunk, built with `PageTabs`
    like Settings and Sidekick.
  - Profile: a status row, then `BuddyLibrarySection`,
    `BuddyPersonaSection` and `BuddyPetSettings` inside one
    `BuddyLookClientProvider`, with the pet creator over it as today.
  - The status row shows the living picture, the name, and whether the
    avatar is on the stream and in the recording, with a button to the
    Scene page. It holds no third copy of the on-stream switch: Stream
    Manager and the Scene canvas are its homes.
  - Greetings: `BuddyGreetingsSection`, without the AI switch, with one
    line that points to it.
  - `buddy-tab.tsx` loses those sections. `BUDDY_TABS` labels `live` as
    "Overview". `BuddyRepliesSection` gains "Write greetings with AI".
  - Every pointer at the old Profile tab follows: `BUDDY_LIVE_POWERS`,
    the Replies description (`cohost-settings-section.tsx:174`), the
    Voice tab's `onOpenLive`.
  - Done when: each row of the page table above shows in exactly one
    place; the Sidekick page shows no picture, look or library; signed
    out on a free account, everything on Avatar → Profile works except
    the two Premium actions; a saved `videorc.orcleTab` still opens its
    tab.
- **A3. Copy on what moved (D1).**
  - `docs/buddy-onboarding-copy.md` first, then
    `lib/buddy-onboarding-copy.ts`, word for word with the web (W2). The
    step-title test on each side follows.
  - The library, persona, look, reactions, motion and greetings
    sections, the pet creator, the Test dialog, the creating lines of
    the consent dialog and `CLOUD_AI_USES`.
  - Settings → General's Cloud AI row
    (`components/settings/general-settings.tsx:241`), the Scene page's
    item and inspector, and the fallback name in
    `lib/buddy-output-notice.ts`.
- **A4. The renderer budget.** The eager gzip ceiling is 485,000
  (`scripts/check-renderer-asset-budget.mjs:143`), and plan 236 merged
  about 400 bytes under it. The page must stay lazy; the nav row and
  `avatar-tabs.ts` are the only eager additions. If the budget trips,
  move something eager to lazy first. A raise needs the owner.
- **Gates:** `pnpm typecheck`, `pnpm lint`, `pnpm format:check`,
  `pnpm --filter @videorc/desktop test`, `pnpm test:scripts`,
  `pnpm build` (the budget). `pnpm smoke:buddy-pet` once, because it
  drives the page that moved. By eye in light and dark with
  `node scripts/capture-ui-pages.mjs --theme=light` and `--theme=dark`.

### Desktop PR B: the Stream Manager's two blocks

Owner route: UI/Product Design (fit 9). Model lane: `opus-5.5`.

- **B1. The Sidekick block.** The pane header starts with the glyph and
  "Sidekick" (D7); `BuddyIdentity` leaves it. Alpha, listening, the
  status and the switch stay.
- **B2. The Avatar block.** At the foot of the pane, under one hairline:
  the identity row (living preview, name, the bubble while one is up),
  "{name} talks" with its chips, the Say box, the reactions and
  "{name} on stream". No card inside a card. The pane still scrolls as a
  whole in a short window.
- **B3. The notice (D3 a).** `lib/buddy-output-notice.ts` returns a
  second action when Sidekick Live is on and one of Answers, Banter or
  AI greetings is on. It runs the control's own consent step
  (`buddyModeChangeStep`).
- **B4. The meanings.** The line under each talk value names who speaks:
  Bubble is the avatar on stream, Suggest is a card the streamer posts.
- Keys do not change: ⌘J, ↑ ↓, R, H, A, ⌫, ⇧⌫.
- Done when: the pane reads as two blocks at 1,040 px and wider and
  below it, in both themes; the notice has unit tests for one action,
  two actions and the consent path; `cohost-pane-buddy.test.ts` and
  `stream-manager.test.ts` pass.
- **Gates:** the TypeScript gates and the desktop tests. `pnpm
  smoke:buddy-commands` once, because it reads the pane's strip and
  cards.

### Desktop PR C: the words everywhere else, the golem's name, the guards

Owner route: Implementation (fit 8), with UI/Product Design for the
copy. Model lane: `opus-5.5`.

- **C1. Backend strings (D1).** Only text that reaches a person;
  identifiers and log tags stay.
  - `overlay_layout.rs` (141, 1368, 1386), `agent_chat.rs` (37, 390,
    417), `cohost_avatar.rs`, `cohost_library.rs`,
    `cohost_library/alive.rs`, `buddy_pet.rs`, `buddy_pet_create.rs`,
    `buddy_pet_store.rs`, `buddy_sprite.rs:920`.
  - In `cohost.rs`: "The Sidekick needs a name." (1055), the bubble and
    presence outcomes (9302, 9443, 9449, 9751). Where a name is at hand,
    use it: "{name} said hello in its bubble."
  - The helper's strings stay: `cohost_command.rs`, `buddy_act.rs`,
    `captions.rs`, `live_chat_moderation.rs`, the card and route errors.
- **C2. Agent tools.** In `protocol-fixtures/agent-tools.json`, the
  titles and descriptions of `buddy_say` (1631) and `set_buddy` (1675)
  say which half each part drives. Tool names and the `buddy` mark stay.
  `docs/agents-mcp.md:135–136` follows.
- **C3. The golem's name (D2 a).**
  - `protocol-fixtures/buddy-official-catalog.json`,
    `apps/desktop/src/shared/buddy-library.ts`, the bundled table
    (`cohost_library.rs:193`), `COHOST_DEFAULT_PERSONA_NAME`, the name
    fallbacks (`cohost_library.rs:964`, `alive.rs:1134`,
    `buddy_pet_create.rs:1984`) and the placeholder
    (`buddy-persona-section.tsx:278`).
  - A migration beside plan 236's (`cohost.rs:1341–1377`), gated on the
    settings version.
  - Tests: an exact "Sidekick" on the default look or `official:golem`
    becomes "Flint"; the same name on the streamer's own pictures
    stays; a second load changes nothing; "Flint" wakes a command.
- **C4. Stop teaching the avatar's name (decision 5).**
  - `buddyWakeWordsLine` (`lib/buddy-tab-view.ts:337`) always reads
    "Start with “Sidekick”."
  - The Name and personality description
    (`buddy-persona-section.tsx:103`) drops "and in voice".
  - `docs/buddy-commands.md` and the Wake words section of
    `docs/buddy.md` teach "Sidekick" alone.
  - `cohost_command.rs` and its tests do not change: the name still
    wakes it.
- **C5. Docs.**
  - A new `docs/avatar.md` takes what leaves `docs/buddy.md`: creating,
    the library, Still and Alive, reactions and motion, the avatar on
    stream, Test, the creator, the greeting lines. `docs/buddy.md` keeps
    its name and is Sidekick's. The Free and Premium table splits by
    product.
  - `docs/overlays.md`, `docs/ui-copy.md` (the names list at L29),
    `CONTEXT.md` (a new **Avatar** entry; **Sidekick** and
    **{name} talks** rewritten), `AGENTS.md` prose.
  - Both copies of the design skill (`.claude/skills/videorc-design/`
    and `.agents/skills/videorc-design/`): the sidebar and shortcut owner
    calls (L162, L397), the mark (L191, L942), Where things live (L549)
    and the pane (L710).
- **C6. The guards.**
  - `renderer-buddy-name-guard.test.ts` gets a list of avatar-side
    files. Their rendered text may say "Sidekick" only on an allow-list;
    an entry that matches nothing fails.
  - A Rust test beside `the_backend_copy_says_sidekick_not_buddy`
    (`buddy_act.rs`) holds the same for the modules in C1.
- **Gates (once, at the end):**
  - `pnpm typecheck`, `pnpm lint`, `pnpm format:check`,
    `pnpm --filter @videorc/desktop test`, `pnpm test:scripts`
  - `cargo fmt --check --all`
  - targeted `cargo test -p videorc-backend` (the persona migration, the
    wake tokens, the catalog, the new guard) and
    `cargo clippy -p videorc-backend --all-targets -- -D warnings`, in
    one build-slot hold
  - `pnpm smoke:agent-mcp` once, because it holds the catalog's
    descriptions on both sides

### Rust UI

- No work in `videorc-rust` now. Other sessions are building there, and
  it has not taken plan 235's sidebar or plan 236's rename yet.
- When its upstream merge (plan 220 S5.3a) reaches plan 236's and this
  plan's commits, one port slice takes the rename and the split
  together:
  - `crates/videorc-app-core/src/nav.rs`: `PageId`, the groups, the
    order, `WORKSPACE_SHORTCUTS`, `label()`
  - `crates/videorc-ui/ui/pages/buddy.slint` split into the two pages,
    and the two blocks in `ui/buddy-pane.slint`
  - `crates/videorc-app-core/src/buddy/copy.rs` and the words typed in
    the `.slint` files
  - the string tables (`pnpm strings:rust-ui` rebuilds
    `docs/rust-ui/strings/*.json` from the Electron copy)
  - `videorc-ui-lint`: `CAPITALIZED_NAMES` gains Sidekick, and the
    `buddy-name` rule gains Buddy
  - the baseline scripts that find controls by their visible names
    (`scripts/rust-ui-baseline.mjs:644`, `:730`, `:751`), and
    `CONTEXT.md:365`, which lists "sidekick" under Avoid
- Its owner is the Rust lanes. This plan hands them the tables above and
  a row for `scripts/lib/rust-upstream-drift.json`.

### Release

- All three desktop PRs are on main before the release is cut. A release
  between A and C ships half the words.
- The notes say: "Sidekick is now two things. Your avatar, the character
  on your stream, has its own page under Setup. Sidekick, the helper in
  Stream Manager, stays under Livestream. Everything you set up is still
  there." Then the moved shortcuts (D6) and the golem's name (D2).
- `the_old_buddy_wake_words_go_after_their_last_release` fails once the
  app passes 0.26.1. If this ships in that release, PR C drops "buddy"
  and "bodhi" from `WAKE_WORDS`.

## Also seen, not in this plan

- **"Show in recording" alone counts as visible.** `overlay_enabled`
  (`buddy_overlay.rs:457`) is true when either switch is on, whatever
  runs. In a stream-only session with only "Show in recording" on,
  Bubble lines are said to nobody. The compositor's own rule is
  `program_shows` (`overlay_layout.rs:622`).
- **The Say box takes a line nobody sees.** Off the picture it records
  the line, shows nothing and writes no report entry
  (`cohost.rs:8917`). The agent tool refuses with a reason; the Say box
  does not.
- **A skipped answer is never offered again.** The candidate is spent
  when it is built (`cohost.rs:4222`), so a question asked while the
  avatar was off the picture gets no answer later.
- **An AI greeting can be paid for and dropped.** When the avatar leaves
  the picture while the request is out, the line is recorded and never
  shown (`apply_greet_result`, `cohost_auto_chat.rs:778`).
- **`set_buddy` can choose Suggest with no posting consent**
  (`lib/studio-actions/buddy.ts:58`).
- **The Premium page never says that creating your own avatar is
  Premium.** Only the onboarding, the FAQ and the privacy page do.
- **New voice phrases.** "Sidekick, show up" and "go away" put the
  avatar on and off the stream. "Show my avatar" would say it better. It
  needs the phrase table and paid evals.
- **An Avatar block on every Stream Manager tab.** A free streamer
  reaches the Say box through the Sidekick tab, as today.
- **Web:** `docs/buddy-commands-contract.md:316` says the typed command
  is `/buddy`; the site says `/sidekick`.

## Handoff

- Goal: a streamer meets two products. The avatar is the character on
  the stream, with its own page, block, web page and words. Sidekick is
  the helper, and it works as it does today.
- Current state: PLANNED. Nothing is built. The plan is on branch
  `plan-239-avatar-and-sidekick` in `~/projects/videorc-wt-239`, a
  worktree that holds `plans/` only.
- Owner route for the plan: Orchestrator (fit 10), because it spans three
  repos and product words. Model lane: `fable-5.1`. Each PR's route and
  lane are in its slice.
- Order:
  1. the owner's answers to D1–D7 (the name in D2 above all)
  2. the web PR, deployed
  3. desktop PR A, then B, then C
  4. release notes
  5. the Rust UI port slice, when its upstream merge gets here
- Keep rule: if a program reads it, it stays. If a person reads it, the
  D1 test picks avatar or Sidekick.
- Out of scope: wire, API, database, saved-setting, MCP tool and
  identifier renames; any change to `cohost.rs`'s structure; moving
  Community, Reports or Clean cut; pricing; D3 b; everything under "Also
  seen".
- Known blockers:
  - The slices assume the recommended D1–D7.
  - The renderer budget has about 400 bytes of headroom (A4).
  - Paid evals need the owner's go (W3).
  - Rust compiles share two build slots; hold one slot for the whole of
    PR C's cargo gates.
  - Plan 238 (a calm Preview start) is being built in
    `~/projects/videorc-wt-238`. It touches the Preview stage, not these
    files; only `plans/README.md` can conflict.
