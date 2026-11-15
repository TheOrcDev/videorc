# Plan 236: Buddy becomes Sidekick

The owner's call (2026-11-14): "let's go with sidekick, put it in plan to
rename everywhere including web."

Why: speech to text hears "Buddy" as "body". In quick American speech the
"dd" is a light tap, so the two words sound almost the same. The owner's own
request for plan 235 came back as "live stream and body". On stream that
breaks twice:

- Captions show "body".
- A voice command is missed. The desktop wake detector knows "buddy" and
  "bodhi" (`cohost_command.rs` `WAKE_WORDS`) but not "body".

"Sidekick" was picked from a shortlist for these reasons:

- It says what the feature is.
- No common word sounds like it.
- Speech to text knows the word, so captions spell it right.
- Streamers rarely say it for any other reason.

The Orcle years taught the last two: invented names come back as real words
("oracle", "orca").

This is the second rename. Plan 171 (2026-10-09) turned Golem into Buddy
across about 9,800 lines in 294 desktop files and 3,000 lines in 146 web
files, wire names included. That was safe then because nothing Golem-named
had shipped. Buddy has shipped (0.25.2 in the field), so this rename keeps
every name a program reads and changes every word a person reads or says
(D1).

## Status and scope

- **Status: EXECUTING 2026-11-14** (owner: "execute the entire plan and
  create a PR for each"), with the recommended D1–D7 answers. Web facts
  are from `videorcweb` `origin/main` `acc7c54d`.
  - **D8 (S0) not run:** the captions check needs the owner's voice and
    the owner-only AI Gateway key. The wake detector takes every form
    D2 lists, so a mishearing among those still wakes it. The owner can
    run S0 any time before the desktop PR merges.
  - **The Rust UI pass waits for S3.10 (D7 a).** S3.10d and S3.10e were
    still open on 2026-11-14.
- Repos and PRs, in deploy order:
  1. **Web** (`TheOrcDev/videorcweb`, `~/projects/videorcweb`): one PR,
     **deployed first**. It holds the new pages and URLs, redirects from
     every old URL, and AI prompts that understand both names.
  2. **Desktop** (`TheOrcDev/videorc`): one PR after the web deploy. It
     covers the app, the backend's words, the wake word, the phone remote,
     the Stream Deck plugin's labels, docs and skills.
  3. **Rust UI** (`videorc-rust`, private): one copy pass after its Buddy
     lane (S3.10) lands (D7).
- Size today:
  - Desktop: "Buddy" appears on 1,407 renderer lines, 104 in main, 263 in
    shared, 1,464 in the backend crates (about 600 inside string literals)
    and 390 in docs. Most renderer and backend hits are identifiers and
    comments, which stay (D1).
  - Web: 870 lines in 170 files.
  - Rust UI: 4,913 lines in 555 files.
- **Plan 235** labels the sidebar row from `BUDDY_TAB_LABEL`, so this plan
  changes one constant there. Its new icon slot is `BuddyPageIcon`, a
  machine name that stays. Whichever plan lands second rebases.

## Decisions for the owner

- **D1. What gets renamed.**
  - **a (recommended): every word a person reads or says.** Names a
    program reads stay. Renamed:
    - every UI string: sidebar, page, ⌘K, menus, toasts, errors, the
      Stream Manager, onboarding, Premium locks, the phone remote, the
      Stream Deck action names
    - every web page, URL, OG image and email
    - the AI prompts' name for it
    - the default name, the wake word and the slash command
    - docs, skills, `CONTEXT.md`, and release notes from now on
  - Kept:
    - wire and API names: `/api/buddy/*`, the `cohost.buddy*` RPCs and
      events, `buddy-*` error codes, `videorc://buddy`
    - saved settings keys and values, and database tables and migrations
      (`buddy_library`)
    - storage env (`VIDEORC_BUDDY_STORAGE_*`)
    - MCP tool names (`buddy_say`) and the catalog's `buddy` mark
    - Stream Deck action UUIDs
    - code identifiers, file names, comments and test ids
    - the `ai` tab id, and script names (`smoke:buddy-act`)
    - history: `plans/`, `changelog/`, `docs/releases/`,
      `docs/acceptance/` (plan 171 D6)
  - Why: apps already in the field call `/api/buddy/*` and read saved
    `buddy` values, so renaming those breaks them. Renaming identifiers is
    thousands of lines that no streamer sees, and it would collide with
    every open lane (plans 231, 233, 234, 235 and the Rust lanes).
  - b: also rename code identifiers, files and comments, but never wire,
    saved or database names. That roughly triples the diff for no visible
    change.
- **D2. What wakes it.**
  - **a (recommended):**
    - "sidekick" becomes the word that always works. The detector also
      takes the two-word form "side kick", the hyphenated "side-kick", and
      "sidekick's" and "sidekicks". It matches single tokens today
      (`is_any_wake_word`), so the two-word form is new code: a two-word
      match.
    - "buddy" and "bodhi" stay as hidden old names for two releases, like
      the Orcle aliases did. Commands still need their phrase after the
      word, as today.
    - The Orcle aliases were marked "remove after 0.9.140" and the app is
      at 0.25.2, so they go now.
    - "body" is never added: it is an everyday word.
  - b: "sidekick" only, with no old names. Habit breaks on day one.
- **D3. Existing Buddies called "Buddy".** The default persona name is
  `COHOST_DEFAULT_PERSONA_NAME = "Buddy"`. A streamer can already rename
  theirs (1–24 characters), and that name also wakes it.
  - **a (recommended):** on upgrade, a persona named exactly "Buddy"
    becomes "Sidekick", once, as a version-gated settings migration. The
    same rename runs for web library rows named exactly "Buddy", in one
    SQL migration. Any other name is the streamer's choice and stays.
    Someone who really wants "Buddy" can rename it back.
  - b: only new installs get "Sidekick", and existing ones keep "Buddy".
    The STT problem stays for exactly the people who have it today.
- **D4. The words.**
  - Use the capitalized name like "Buddy" today: "Sidekick" (singular)
    and "Sidekicks" (plural): "My Sidekicks", "official Sidekicks", "the
    Sidekick library".
  - Compounds follow: "Sidekick Live", "Sidekick talks in its bubble", "Ask
    your Sidekick".
  - The slash command becomes `/sidekick [words]`, and `/buddy` stays a
    silent alias for two releases.
  - Recommended as written. The owner can change any word.
- **D5. Web URLs** (recommended as written):
  - `/sidekick`, `/sidekick/create` and `/account/sidekicks` are the pages.
  - The blog post becomes `/blog/sidekick-live-chat-moderation`.
  - 308 redirects from `/buddy`, `/buddy/:path*`, `/account/buddies` and
    the old blog slug.
  - The existing `/orcle*` and `/golem*` redirects point straight at
    `/sidekick`, so there are no chains.
  - The anchor becomes `#talk-to-sidekick`, keeping the `talk-to-buddy` and
    `talk-to-orcle` alias spans.
  - API routes stay (D1).
- **D6. Privacy policy and terms.**
  - **a (recommended):** change the words ("Sidekicks you create…") and the
    "last updated" date. Nothing else changes in substance.
  - b: the owner reviews the legal text first and the web PR waits.
- **D7. When the Rust UI repo renames.**
  - **a (recommended):** one copy pass after its Buddy lane (S3.10) lands.
    Until then that lane keeps its current words, so the two never
    conflict.
  - b: now, in parallel. That conflicts with S3.10 in flight.
- **D8. Check "Sidekick" against the real captions first (S0).**
  - **a (recommended):** before the desktop PR, the owner reads 10 short
    lines ("Sidekick, clip that", "thanks sidekick", "my side kick is
    asleep") through `pnpm probe:caption-stt`, the owner-only real-model
    probe. It needs `AI_GATEWAY_API_KEY` in the shell and costs a few cents.
  - It confirms the spelling captions show and which token forms the
    detector must take (D2). If "Sidekick" comes back wrong as often as
    "Buddy" did, the rename stops there, before any code changes.
  - b: skip it, and ship on the word's reputation.

## Slices

### S0: the captions check (D8 a)

- Run `pnpm probe:caption-stt` on the owner's lines.
- Write down how often each form comes back: "sidekick", "side kick",
  "side-kick" and anything else.
- Done when: at least 9 of 10 come back as a form D2 matches, and the
  table is in this plan.

### Web PR (deploy first)

Owner route: Implementation (fit 8). Model lane: `opus-5.5`, because the
web copy is user-facing. Work in a fresh worktree of `videorcweb` from
`origin/main`.

- **W1. Prompts and evals take both names.**
  - `lib/ai/cohost-command.ts:195`: the assistant is "Sidekick, or the name
    the streamer gave it". It is "often transcribed as side kick or
    side-kick". It "was called Buddy before and still answers to it, often
    transcribed as body, buddie or bud". The Orcle sentence goes (D2).
  - `lib/ai/buddy-act.ts:237`: "You are the planner for Sidekick…". The
    unknown line reads "Sidekick can't do that."
  - `lib/ai/cohost.ts` persona prompts: the default name.
  - `lib/agents-guide.ts:154` ("Sidekick, switch to BRB", `/sidekick`).
  - Eval fixtures:
    - `tests/fixtures/cohost-command-eval.ts`: Sidekick cases, the
      two-word and hyphenated forms, Buddy as old-name cases, and "my
      sidekick" as chatter
    - `buddy-act-eval.ts`
    - `cohost-memory-eval.ts`
  - Done when: `pnpm eval:cohost-command` and `pnpm eval:buddy-act` hold
    plan 171's numbers (intent 99 %, target recall ≥ 79 %, ends as
    labelled 96 %). The `--dry-run` passes in CI. The paid runs need the
    owner's go, because AI Gateway credit ran out twice this month.
- **W2. Pages, URLs and copy.**
  - Move `app/buddy/*` (page, create, OG and Twitter images) to
    `app/sidekick/*`, and `app/account/buddies` to `app/account/sidekicks`.
  - `next.config.ts` redirects per D5.
  - Change the words in `components/buddy/*` and
    `components/account/buddy-library.tsx` (file names stay, D1).
  - Also: Premium, pricing, agents, search and metadata copy, and the
    official catalog's display strings (`public/buddy/official/` stays as
    a path).
  - Extend `tests/name-guards.test.ts` so "Buddy" in page copy fails
    outside an allow-list of machine names and history. Update the surface
    tests that pin words: premium, pricing, search, metadata and blog.
  - Done when: every old URL answers 308 to its new page on a preview
    deploy, and the guard is green.
- **W3. Blog and legal.**
  - Live posts change their words.
  - `buddy-live-chat-moderation.mdx` moves to the new slug.
  - The Product Hunt launch post keeps its words, because it is a dated
    announcement, and gets one line: "Buddy is called Sidekick now."
  - `app/privacy` and `app/terms` follow D6.
- **W4. Data (D3 a):** one migration renames library rows whose name is
  exactly "Buddy". It is idempotent and touches no other column.
- **Gates:**
  - the web repo's typecheck, lint, tests and build
  - the eval dry runs
  - the redirect check on the preview
  - after deploy, a desktop at 0.25.2 still loads its library and avatars
    through `/api/buddy/*`, and its old links land on `/sidekick`

### Desktop PR (after the web deploy)

Owner route: Implementation (fit 8), with UI/Product Design for the copy.
Model lane: `opus-5.5`, or `fable-5.1` for D-2 if the two-word wake match
gets subtle. Read `.claude/skills/videorc-design/SKILL.md` and
`docs/ui-copy.md` first.

- **D-1. Copy.**
  - `BUDDY_TAB_LABEL` and the other label constants become "Sidekick".
  - Then every rendered string in `renderer/` (main window, Stream
    Manager, Captions and Notes windows), `main/` (menus, notifications,
    `watchdog-notify.ts`), `shared/` copy helpers and the phone remote
    (`crates/videorc-backend/remote_web/`).
  - In the backend, change only user-facing strings: status lines, errors
    and toasts that reach the UI, and the on-screen line "Sidekick can't
    do that". Rust identifiers and log tags stay.
  - The Stream Deck plugin's action names in
    `apps/streamdeck-plugin/manifest.json` and `plugin.ts` change, and the
    UUIDs stay.
  - Desktop links to the web point at the new URLs.
  - Done when: the extended guard below passes and a by-eye pass in light
    and dark finds no "Buddy" on any page, dialog, window or menu.
- **D-2. Waking and commands (D2, D4).**
  - In `cohost_command.rs`:
    - `WAKE_WORDS` becomes sidekick plus the hidden buddy and bodhi.
    - The Orcle entries go.
    - The two-word match for "side kick" joins `detect`, `scan_commands`
      and `parse_wake`.
    - `wake_name_tokens` treats "sidekick" as taken.
  - `/sidekick` joins the composer commands, with `/buddy` kept. The help
    line in `chat-pane.tsx:1011` names `/sidekick`.
  - Tests:
    - every form wakes
    - "my sidekick is great" is talk, not a command
    - "buddy" still wakes for two releases (a test names the release that
      removes it)
    - the two-word form at the end of one caption and the start of the
      next (`NAME_CARRY_MAX_GAP`)
- **D-3. The default name (D3 a).**
  - `COHOST_DEFAULT_PERSONA_NAME = "Sidekick"`.
  - A one-time migration renames a saved persona named exactly "Buddy",
    gated on the settings version so it never runs twice.
  - Test: an exact "Buddy" becomes "Sidekick"; "Buddy Bot" and "buddy"
    stay; a second load changes nothing.
- **D-4. Words in the repo.**
  - `CONTEXT.md` gets a "Sidekick" entry ("Avoid: Buddy, buddy, co-host
    (in copy)").
  - Also `docs/ui-copy.md`, both copies of the videorc-design skill (owner
    calls, Icons, Where things live), and `AGENTS.md` prose (the command
    names stay).
  - Also `docs/agents-mcp.md`'s descriptions, and the MCP tool
    descriptions in `protocol-fixtures/agent-tools.json`. The tool names
    stay. Agents read the descriptions, and the catalog-equality smoke
    holds both sides.
- **D-5. The guard.** `renderer-buddy-name-guard.test.ts` adds "Buddy"
  next to "Orcle" and "Golem": the word may appear in rendered copy only
  on its allow-list (machine names that render, and the migration's own
  test). A small Rust test does the same for the backend's user-facing
  string tables.
- **Gates (once, at the end):**
  - `pnpm typecheck`, `pnpm lint`, `pnpm format:check`,
    `pnpm --filter @videorc/desktop test`, `pnpm test:scripts`
  - `cargo fmt --check --all`
  - targeted `cargo test -p videorc-backend` (cohost_command, cohost
    persona and settings migration) in one build-slot hold
  - `cargo clippy -p videorc-backend --all-targets -- -D warnings`
  - smokes whose spoken or typed words change: `smoke:buddy-commands`,
    `smoke:buddy-act`, `smoke:agent-mcp` (catalog descriptions),
    `smoke:remote-lan` (phone remote copy) and `smoke:buddy-pet`
  - by eye in both themes

### Rust UI pass (D7 a)

- After S3.10 lands in `videorc-rust`: the same copy pass over its Slint
  UI and its copy of the desktop renderer, with the same keep rule (D1).
- Its own gates per its build-loop rules: one cargo check per slice, and
  tests and clippy once at the end.

### Release

- The release notes say: "Buddy is now Sidekick. Say 'Sidekick, clip
  that'. 'Buddy' still works for two more releases." Also name the new
  slash command.
- A changelog entry in the R2 `changelog.json`, through the release skill.

## Also seen, not in this plan

- No STT vocabulary hint is sent with caption requests. If the provider
  takes one, "Sidekick" and the persona's own name could be boosted. That
  would help any custom name, but it is its own plan.

## Handoff

- Goal: Buddy reads and is heard as "Sidekick" everywhere a person meets
  it, with nothing in the field breaking.
- Order:
  1. S0, the owner's captions check
  2. the web PR, deployed
  3. the desktop PR
  4. the Rust UI pass after S3.10
  5. release notes
- Keep rule (D1): if a program reads it, it stays `buddy`. If a person
  reads it or says it, it becomes Sidekick.
- Out of scope: wire, API, database, saved-setting, MCP tool and identifier
  renames; plan 235's layout work; the STT vocabulary hint.
