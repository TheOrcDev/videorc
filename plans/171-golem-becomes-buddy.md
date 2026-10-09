# Plan 171: Golem becomes Buddy, and the Buddy library stores on Neon

> **Executor instructions**: one agent per repo, a mechanical rename with the
> exceptions below. Wire names change together in Rust and TypeScript. No
> behaviour change except the storage settings (D8) and the wake word (D5).

## Status

- **Status**: EXECUTED 2026-10-09 in desktop #647 and web #79
- **Priority**: P1 (owner request, 2026-10-09)
- **Effort**: L (about 9,800 lines in 294 desktop files, 3,000 lines in 146
  web files)
- **Risk**: MEDIUM: a wide mechanical rename across wire names; nothing
  Golem-named has shipped, so there is no compatibility burden for it
- **Planned at**: desktop `f56c9b74` (`plan-164-golem-b`, #647), web
  `d449a35c` (`plan-170-golem-web`, #79)
- **Route**: Orchestrator; Implementation fit 8 per repo; model lane `opus`

## Execution (2026-10-09)

Done the same evening by one agent per repo.

- **Wire names** match on both sides: `/api/buddy/*`, the `buddy-*` error
  codes, `cohost.buddyLibrary` and `videorc://buddy`. The catalog fixture
  is byte-identical in both repos.
- **The command eval** (`typesafe-ai/jev`) still passes, with "buddy" as a
  plain word in chatter staying a non-command:

  | Prompt | Cases | Intent accuracy | Target recall | Ends as labelled |
  | ------ | ----- | --------------- | ------------- | ---------------- |
  | Golem  | 68    | 99 %            | 81 %          | 96 %             |
  | Buddy  | 69    | 99 %            | 79 %          | 96 %             |

- **Gates.**
  - Desktop: all TS gates, 3,818 tests, 1,951 script tests, fmt, clippy,
    587 targeted Rust tests, build, bundle budget.
  - Smokes: `smoke:buddy-commands`, `smoke:session-markers`,
    `smoke:cohost-fake`, `smoke:captions-contract`,
    `probe:comments-window`, `smoke:buddy-pet` and the full
    `smoke:recording-studio`, all green.
  - Web: typecheck, lint, 881 tests, build.
- **By eye**, in the dev app: the Buddy tab, My Buddies with "Buddy the
  Golem" first, using the official Orc, and onboarding step 1.
- **Extra wire renames** beyond the D3 list: the comments-window action
  kinds (`buddy-say`, `buddy-react`, `buddy-show-on-stream`), the pack
  sidecar `buddy.json`, the bundled pack id `bundled:buddy`, and two
  localStorage flags.
- **Dev-machine only:** a saved overlay layout with the old `golem` key
  resets to the default with a warning.

## The owner's ask (2026-10-09)

"Can we for this VIDEORC_GOLEM_STORAGE_PROVIDER just use our Neon storage?"
then "yes do it, you can also use Neon in my browser or CLI if easier. make it
like that to use Neon for that golem. Also let's change the name from Golem to
Buddy everywhere".

## Facts

- Nothing named Golem has shipped: the latest release (0.9.139) still says
  Orcle, and desktop #647 and web #75/#79 are unmerged. Only the web's
  Product Hunt post (live) mentions the name Golem.
- The Orcle values kept by plan 170 D22 (`orcle-voice`, the service-flags
  `orcle` key, `videorc.orcleTab`, `videorc.orcleListenPromptDismissed`, the
  old Settings tab id `orcle`, the hidden Orcle wake aliases) were shipped and
  stay exactly as they are.
- Neon (done by the orchestrator 2026-10-09): private bucket `buddy-avatars`
  on project `videorc-web-storage` (`wild-tree-18734555`, branch
  `br-shiny-dew-aw8dwo3v`, us-east-1); credential "videorc-web buddy-avatars
  (Vercel)" with `storage:read` + `storage:write`; endpoint
  `https://br-shiny-dew-aw8dwo3v.storage.c-12.us-east-1.aws.neon.tech`,
  region `us-east-1`, path-style, access key id = the credential's token id.
  A put, presigned get, delete and 404 were proven with `lib/s3-sigv4.ts`.
  Vercel production already has `VIDEORC_BUDDY_STORAGE_PROVIDER=s3` and
  `VIDEORC_BUDDY_STORAGE_S3_{BUCKET,REGION,ENDPOINT_URL,ACCESS_KEY_ID,SECRET_ACCESS_KEY}`.

## Decisions

- D1. **Every word a person reads says Buddy**: the app tab "Buddy", "Your
  Buddy", "My Buddies", "New Buddy", "Test your Buddy", "Make it Alive", the
  Stream Manager pane "Buddy", the onboarding ("Create your Buddy", "Create
  my Buddy", "Use as my Buddy", "Saved to your library."), web `/buddy`,
  `/buddy/create`, `/account/buddies`, nav and footer "Buddy", the copy
  document, privacy, terms, blog posts, `llms.txt`, metadata, structured
  data, OG and hero images (re-rendered where the picture shows the word),
  API error messages ("Sign in to use Buddy."), docs, the design skill,
  script output, comments and test names. Plural: "Buddies".
- D2. **The stone golem stays a golem creature.** Its official slug and id
  stay `golem` / `official:golem` (creature kinds: golem, orc, goblin,
  pirate, robot); its kind label stays "Golem"; its **name becomes "Buddy"**
  ("Buddy the Golem", like "Golmar the Orc"), and the default persona name
  becomes "Buddy". The onboarding lead keeps its creature list ("Create your
  own Golem, Orc, Goblin, Pirate, Robot, or anything you can describe").
- D3. **Code names follow**: `golem` to `buddy`, `Golem` to `Buddy`, `GOLEM`
  to `BUDDY` in identifiers, file and folder names (`git mv`), Rust modules
  (`golem_pet.rs` to `buddy_pet.rs`, `golem_motion.rs` to `buddy_motion.rs`,
  ...), types, constants, CSS and `data-` attributes, test names, package
  scripts (`smoke:golem-pet`, `smoke:golem-commands`, `golem:official` to
  the `buddy` forms, also inside `smoke:local-gates` and CI workflows),
  fixtures (`protocol-fixtures/golem-*.json` to `buddy-*.json`), docs
  (`docs/golem*.md` to `docs/buddy*.md`).
  Wire names change together (nothing shipped): RPCs `cohost.golem.state`,
  `cohost.golem.status`, `golem.overlay.set`, `golem.overlay.clear`; IPC
  channels `golem-assets:*`, `golem-pets:*`, `golem:deep-link`; serde
  strings; the deep link `videorc://golem` to `videorc://buddy`; the asset
  host `videorc-asset://golem/` to `buddy`; `VIDEORC_MANAGED_GOLEM_ROOTS`;
  the userData folder `golem-assets` to `buddy-assets` (main moves an
  existing `golem-assets` folder once at start when `buddy-assets` does not
  exist, for dev machines); the settings row `golemLibrarySync`; the
  capability key `cohost.golemLibrary` to `cohost.buddyLibrary`; web routes
  `/api/golem/*` to `/api/buddy/*`; web error codes `golem-*` to `buddy-*`;
  env vars `VIDEORC_GOLEM_*` to `VIDEORC_BUDDY_*`; migration
  `0019_add_golem_library.sql` to `0019_add_buddy_library.sql` with tables
  `buddy_avatars` and `buddy_profiles` (unmerged: edit in place).
  Unchanged: every `cohost` name, usage kinds `cohost-*`, migration 0018
  (`ai_cohost_pet_builds`), the D22 Orcle values.
- D4. **"golem" stays where it names the creature, not the feature**: the
  official slug/id, the kind label, the art master file names
  (`golem-master.png`, `golem-<state>-master.png`), the house-look words that
  describe the style anchor (our stone golem), example placeholders and
  chips that describe a golem character ("A grumpy stone golem with a mossy
  back and a lantern", "Deadpan stone golem"), and the creature list in the
  onboarding lead. Folders move to `buddy` (`assets/brand/buddy/`,
  `apps/desktop/src/renderer/src/assets/buddy/`, web `public/buddy/`); the
  feature emblem files become `buddy-emblem-*`.
- D5. **The wake word.** "buddy" replaces "golem" as the word that always
  wakes the Buddy, next to the persona's own name and the hidden Orcle
  aliases. Commands still need the structured phrase after it, so "thanks
  buddy" alone does nothing. The web command-parse prompt names "Buddy, or
  the name the streamer gave it" and its mishearings ("body", "buddie",
  "bud"), keeps the Oracle/orca non-commands, and the eval fixture's Golem
  cases become Buddy cases.
- D6. **History keeps its words**: `plans/` (164 to 170 still say Golem),
  `changelog/`, `docs/releases/`, `docs/acceptance/`. The Product Hunt
  post's line becomes "Early builds called it by another name. It is Buddy
  now."
- D7. **Web URLs**: `/orcle`, `/orcle/:path*`, `/golem` and `/golem/:path*`
  redirect (308) to `/buddy`; the blog post becomes
  `buddy-live-chat-moderation` with redirects from the `orcle-` slug; the
  anchor becomes `#talk-to-buddy` with the `talk-to-orcle` alias span kept.
- D8. **Storage settings**: the Buddy library's storage gets its own S3
  settings, `VIDEORC_BUDDY_STORAGE_S3_{BUCKET,REGION,ENDPOINT_URL,
ACCESS_KEY_ID,SECRET_ACCESS_KEY,SESSION_TOKEN,FORCE_PATH_STYLE}`, each
  falling back to its `VIDEORC_AI_OBJECT_S3_*` twin; an endpoint forces
  path-style; `VIDEORC_BUDDY_STORAGE_PROVIDER` works as before. Docs name
  the Neon bucket. Tests cover the new settings and the fallback.
- D9. **Guards**: the Orcle guards stay. New guards fail on "Golem" in copy
  sources (desktop renderer, docs and skills minus history; web `app/`,
  `components/`, `content/`, `lib/`, `public/llms.txt`) outside an
  allow-list of the D4 creature uses; an unused allow-list entry fails.

## STOP conditions

- A D22 Orcle value changes.
- A wire name changes on one side only (a strict schema or fixture
  mismatch).
- The official stone golem loses its `golem` slug or kind.
