# Plan 059: Broadcast info, one form (per-destination accordions and a self-healing draft)

> Executor: implement the ordered slices below in an isolated worktree of current
> main. Read AGENTS.md and `.claude/skills/videorc-design/SKILL.md` first. Keep
> each slice independently testable. Planning authorizes no merge or release.

## Status and decisions

- Status: **EXECUTED 2026-09-25** on `feat/broadcast-info-accordions` (S1 to
  S5 done; see "Execution notes" at the end). The owner asked for execution
  and a PR right after planning, then for the merge. Priority P1 (a shipped
  flow confuses users and shows a wrong title). Effort S to M: about 1.5
  agent-days over 5 slices. Risk LOW: one renderer section, one backend
  loader, one Twitch resolver; no capture, preview, wire or IPC change.
- Planned against `origin/main` `f4044b71` (0.9.108). Paths are relative to
  `apps/desktop/src/renderer/src/` unless they start with `crates/`,
  `scripts/` or `apps/`.
- Owner route: UI/Product Design (fit 9) owns the work. Model lanes: S1 and S2
  `gpt-5.5` (clear backend changes with tests), S3 `opus-4.8` (scoped UI),
  S4 `gpt-5.5`, S5 `fable-5` (Review route).
- Branch: `feat/broadcast-info-accordions`. Commits use
  `fix(livestream):` or `feat(livestream):`.
- Owner feedback, 2026-09-24, from a user's screen recording of the
  Livestream page: "multiple forms and youtube one not working", "why we have
  two forms?", "those forms should be in some accordions too". The owner could
  not reproduce it: their own app database has an empty override list (see
  P3), so they have only ever seen the global fields.

### Decisions (the recommendation is taken)

1. **One form.** The global Title, Description and Default privacy stay flat
   at the top of Broadcast info. Everything per destination moves into one
   shadcn `Accordion` below them, one item per connected native destination.
   Nothing per destination is drawn for a destination that is not in the
   Destinations list, and a Custom RTMP-only setup shows no accordion at all.
2. **Custom text is opt-in and hidden until chosen.** The per-destination
   Title, Description and Privacy inputs are not rendered while the switch is
   off. Today they render disabled with a placeholder, which is what made the
   page read as four stacked forms, and which shows a stale value when a user
   turns the switch off again (P2).
3. **Platform settings always apply.** Made for kids (YouTube), Category and
   Language (Twitch) and Announce (X) are shown in every open item, switch on
   or off, and the backend honours them regardless of the switch. Today Twitch
   category and language are ignored unless the switch is on, and turning it
   on forces the user to retype a title (validation requires a custom title).
   The switch is renamed from "Customize" to "Custom title and description"
   so it says exactly what it gates.
4. **The draft heals itself.** The backend backfills a default row for every
   platform missing from the stored override list, on load and on save. This
   repairs the owner's database on the next launch with no manual step and
   makes the shape impossible to break again from the wire.
5. **The accordion is the shadcn primitive already in the kit**
   (`components/ui/accordion.tsx`, currently unused). The Livestream tab is
   lazy (`app-shell.tsx:63`), so the primitive does not touch the eager
   renderer budget. Type `multiple`, so a user can compare two destinations.
   Items with a validation issue open by default; the rest start closed.

## Problem (measured on origin/main `f4044b71`)

### P1. The page reads as four forms

- `MetadataEditor` (`components/tabs/streaming-tab.tsx:1364`) draws the three
  global fields and then `draft.targetOverrides.map(...)` at line 1465, with
  no filter. The default draft always carries YouTube, Twitch and X rows
  (`crates/videorc-backend/src/streaming.rs:464`), so every install shows
  three per-destination sub-forms whether or not those destinations exist.
- Each `MetadataOverride` row (line 1503) always renders Title and
  Description inputs, disabled when the switch is off, plus the platform
  fields. On a 1040 px tall window the section is about 1,400 px of inputs.

### P2. A stale custom title shows after the switch is turned off

- The Title input renders `value={override.title}` (line 1570) regardless
  of `override.customize`. The stored text is never cleared, so after
  "Customize on, type, Customize off" the disabled input keeps the old text
  while its neighbours show the global placeholder. In the recording the
  YouTube row says "Testing Videorc" while Twitch follows the global title
  live. The user read this as "YouTube does not sync".
- The backend is right: `effective_youtube_metadata`
  (`crates/videorc-backend/src/youtube.rs:749`) uses the override only when
  `customize` is true. The stream would have gone out with the global title.

### P3. The owner's draft has no override rows and nothing can add them back

- The stored draft in the owner's `videorc.sqlite3` (`app_settings` key
  `streamMetadataDraft`) has `targetOverrides: []` with a fresh
  `updatedAt` (every Save and Go Live round-trips the loaded draft).
- The only code that ever sends an empty list is
  `scripts/smoke-oauth-guards-app.mjs:39`. The smoke was added on 2026-06-03
  and did not isolate its database until the state-isolation commits of
  2026-06-13 (`8d2fdda9`) and 2026-06-20 (`e149487b`). A run in that window
  wrote the empty list into the real database.
- `stream_metadata_draft()` (`crates/videorc-backend/src/storage.rs:5092`)
  falls back to the default only when the JSON fails to parse. An empty list
  parses, so the draft has stayed empty for three months.

### P4. Twitch category is gated behind a custom title

- `effective_twitch_metadata` (`crates/videorc-backend/src/twitch.rs:264`)
  applies `twitch_category_id`, `twitch_category_name` and
  `twitch_language` only when `customize` is true. `validate_stream_metadata_draft`
  (`streaming.rs:502`) then requires a non-empty custom title. A user who
  only wants "Just Chatting" must retype their title to get it.
- Made for kids (`youtube.rs:772`) and X Announce (`x_live.rs:1893`) already
  apply regardless of the switch, so the four platform fields are
  inconsistent with each other today.

## Design

Broadcast info, top to bottom:

1. Title, Description, Default privacy: unchanged.
2. One `Accordion type="multiple"` with an item per native platform that has
   at least one target in Destinations, in Destinations order. Trigger row,
   44 to 48 px, no underline on hover (override the primitive's
   `hover:underline` with the white-8% row overlay):
   - `PlatformGlyph` 24 px, then the destination label (the first target's
     `label`, else `platformLabel`), then a secondary-gray summary on the
     same line, then the chevron. Summary is quiet when fine, in the plan 057
     voice:
     - YouTube, switch off: `Global title · Unlisted` (default privacy), plus
       ` · Made for kids` only when true. Switch on: `Custom title · Public`.
     - Twitch: `Global title` or `Custom title`, plus ` · Just Chatting` when
       a category is set, plus ` · es` when the language is set and not `en`.
     - X: `Global title · Announces` or `Global title · No announcement`.
   - A validation issue for that platform appends a warning glyph to the row
     and opens the item by default.
3. Item content:
   - Switch row "Custom title and description", sub-copy when off:
     "Uses the global title, description and privacy." (X: "Uses the global
     title." Twitch: "Uses the global title.")
   - When on: Title (`value={override.title}`), then Description and Privacy
     for YouTube only. X and Twitch get Title only, with the existing
     one-line descriptions ("X broadcasts carry a title only...").
   - Always: YouTube Made for kids; Twitch Category (search + select) and
     Language; X Announce on X timeline.
4. No destinations besides Custom RTMP: one tertiary line, "Connect YouTube,
   Twitch or X to set per-destination details." The validation badge and
   Save button are unchanged.

The Go Live dialog (`components/go-live-dialog.tsx`) edits only the global
title and description and is not touched.

## Slices

### S1. The draft backfills missing platform rows (backend)

- Add `normalize_stream_metadata_draft(draft, now)` in
  `crates/videorc-backend/src/streaming.rs`: for each of YouTube, Twitch, X
  missing from `target_overrides`, push the default row from
  `default_stream_metadata_draft`; keep existing rows and their order first,
  then append missing ones in canonical order; drop nothing.
- Call it in `stream_metadata_draft()` after parse and in
  `save_stream_metadata_draft()` before `save_setting`
  (`crates/videorc-backend/src/storage.rs`). Validation
  (`streamTargets.metadata.validate`) validates the normalized draft too.
- Tests: `storage.rs` loads a stored draft with `targetOverrides: []` as
  three rows and preserves title, description and privacy; a stored draft
  with only a customized Twitch row keeps that row and gains the other two;
  `save_stream_metadata_draft` with an empty list stores three rows.
- `scripts/smoke-oauth-guards-app.mjs`: keep its empty-list payload (it is
  now the wire regression for this backfill) and assert the update response
  carries three overrides.
- Done when: `cargo test -p videorc-backend stream_metadata` passes, and the
  owner's app shows the three destination rows after a relaunch with no
  database edit.

### S2. Platform settings apply regardless of the switch (backend)

- `crates/videorc-backend/src/twitch.rs` `effective_twitch_metadata`: drop the
  `customize` filter on category id, category name and language. Title keeps
  the filter.
- `streaming.rs` validation: unchanged (a custom title is still required when
  the switch is on).
- Tests: Twitch resolves category and language with `customize: false`; title
  still falls back to the global title; the existing customized case still
  passes. Add a YouTube test asserting Made for kids applies with the switch
  off (documents the already-true behaviour).
- Done when: `cargo test -p videorc-backend twitch` and `youtube` pass and
  `cargo clippy -p videorc-backend -- -D warnings` is clean.

### S3. Per-destination accordions (renderer)

- `components/tabs/streaming-tab.tsx`:
  - `MetadataEditor`: compute `visiblePlatforms` from `targets` (native,
    ordered by first appearance); render the `Accordion` only when non-empty;
    render the tertiary hint otherwise.
  - Replace the `MetadataOverride` body with the item content from Design §3.
    Rename the switch and its `aria-label` ("Custom title and description for
    YouTube"). Render Title, Description and Privacy only when
    `override.customize` is true.
  - Trigger summary from a pure helper `metadataOverrideSummary(draft,
override)` in `lib/stream-metadata-summary.ts` (new, tested in S4).
  - Default open value: platforms with a `validation` issue.
  - Keep the existing per-platform `id`s on inputs so the go-live-dialog test
    fixtures and any probes keep matching.
- `components/ui/accordion.tsx`: no edits to the primitive. Style through
  `className` on the trigger (no underline, row overlay on hover, 44 px min
  height) and the content (`gap-3` column).
- Copy: the Default privacy description already points at "the X Announce
  toggle below"; keep it accurate ("in the X row below").
- Done when: `pnpm typecheck`, `pnpm lint`, `pnpm format:check` pass; with a
  YouTube, Twitch and Custom RTMP destination the section shows two closed
  rows under the global fields; opening YouTube with the switch off shows
  only the switch and Made for kids; turning the switch on reveals Title,
  Description and Privacy with an empty Title placeholder of the global
  title; turning it off hides them again with no stale text anywhere.

### S4. Tests and gates

- `lib/stream-metadata-summary.test.ts`: the summary strings above for every
  platform, on and off, with and without category, language, kids and
  announce; a target list with only Custom RTMP yields no visible platforms;
  targets order drives item order; an empty override list yields nothing
  (the studio-provider integration fixture at line 833 still sends one).
- A renderer test for `MetadataEditor` that mounts the section with a
  fixture draft and asserts which inputs exist with the switch off and on
  (the `settings-layout.test.ts` pattern). Copy sweeps break case-sensitive
  matchers: grep tests for "Customize" and "Inherits global" first.
- Gates: `pnpm --filter @videorc/desktop test`, `pnpm build`,
  `pnpm check:renderer-assets` (the tab is lazy; the eager numbers must not
  move), targeted `cargo test -p videorc-backend stream_metadata twitch
youtube`, `cargo fmt --check --all`, `cargo clippy -p videorc-backend --
-D warnings`.
- Done when: every gate above is green in the worktree and the diff carries
  no scratch probes.

### S5. Review, proof and docs

- Review route on the whole diff: findings first, file and line, missing
  tests. Check especially that S1 never drops a row a user customized and
  that S2 changes no YouTube or X behaviour.
- Proof for the owner: two screenshots from `pnpm dev` with a seeded draft
  (YouTube and Twitch connected via the manual-RTMP fixture the OAuth guards
  smoke uses): section closed, and YouTube open with the switch on. Attach
  to the PR.
- Docs: a changelog entry in the release's user voice ("Broadcast info is one
  form again: each destination is a row you can open. Twitch category and
  language apply without a custom title."). Add the plan entry to
  `plans/README.md`.
- Done when: the PR is open with proof attached and the owner has done a
  by-eye pass on their own machine (their draft now shows three rows).

## Out of scope

- The Go Live dialog's fields and the Stream Manager window.
- Scheduling (plans 045 and 049) and per-event metadata.
- Persisting which accordion items are open across launches.
- Any change to what is sent to YouTube or X.

## Verification summary

```
pnpm typecheck && pnpm lint && pnpm format:check
pnpm --filter @videorc/desktop test
pnpm build && pnpm check:renderer-assets
cargo fmt --check --all
cargo test -p videorc-backend stream_metadata
cargo test -p videorc-backend twitch
cargo test -p videorc-backend youtube
cargo clippy -p videorc-backend -- -D warnings
pnpm smoke:oauth-guards
```

## Execution notes (2026-09-25)

- S1: `normalize_stream_metadata_draft` in `streaming.rs`, called from the
  storage load and save paths and from the validate handler. Tests in
  `streaming.rs` and `storage.rs`. The OAuth guards smoke now asserts the
  update response carries the three rows.
- S2: `effective_twitch_metadata` applies category and language without the
  switch; two Twitch tests and one YouTube made-for-kids test document the
  contract. Validation is unchanged.
- S3: `MetadataEditor` (now exported for its test) draws the rows from
  `lib/stream-metadata-summary.ts` in a controlled `Accordion type="multiple"`.
  A row with a validation issue is held open until the issue clears. The
  switch is "Custom title and description"; its inputs mount only when on.
- S4: 15 renderer tests across `lib/stream-metadata-summary.test.ts` and
  `components/tabs/streaming-metadata.test.ts` (static markup, the
  go-live-dialog pattern). Full desktop suite green (215 files).
- Renderer eager budget: this Mac reads 386,086 gzip on clean main and
  386,098 with this branch (12 bytes, the accordion landed in the lazy
  `streaming-tab` chunk). Both are over the 385,000 ceiling locally; the
  known Mac-versus-CI gzip drift covers it and CI is the gate.
- Changelog: this repo writes one changelog file per release at cut time, so
  the user-facing line lives in the PR body for the next release to pick up.
- Owner by-eye on their own machine is still owed: their draft heals on the
  first launch of a build with S1.
