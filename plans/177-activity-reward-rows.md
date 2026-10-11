# Plan 177: Activity reward rows get their own background, and the row ⋯ menu stops being cut off

> **Executor instructions**: Follow this plan slice by slice. Run every
> verification command and confirm the expected result before moving to the
> next slice. If anything in "STOP conditions" happens, stop and report. Do
> not improvise. When done, update this plan's entry in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 2aeee8c6..HEAD -- apps/desktop/src/renderer/src/components/stream-manager/activity-pane.tsx apps/desktop/src/renderer/src/components/stream-manager/activity-pane.test.ts apps/desktop/src/renderer/src/components/ui/scroll-area.tsx apps/desktop/src/renderer/src/components/kebab-menu.tsx apps/desktop/src/renderer/src/styles.css scripts/comments-window-probe.mjs .claude/skills/videorc-design/SKILL.md`
> If `ActivityRow`'s markup, the `ScrollArea` primitive, or the `--member`
> token block changed, re-check "What exists today" against the live code
> first.

## Status

- **Priority**: P2. Cosmetic, but the ⋯ menu is unreachable on long reward
  rows, so "Show on stream", "Thank in chat" and "Copy" are lost there.
- **Effort**: S. Two slices, about half an agent day, plus an owner by-eye.
- **Risk**: LOW. Renderer-only. No backend, no wire contract, no recording or
  preview path.
- **Depends on**: D1 (the tint) before S2. S1 has no open decision.
- **Category**: UI bug + UI polish (Stream Manager, Activity pane)
- **Planned at**: commit `2aeee8c6` (origin/main), 2026-10-11
- **Executed**: 2026-10-11 on `plan-177-activity-reward-rows`. The owner said
  "execute the entire plan", taken as D1 (a); D2 and D3 at their
  recommendations. The probe reproduced the bug first: one long reward
  pushed every row's ⋯ to x=1423 in a pane ending at 1280 (the short streak
  row's too, since all rows share the table's width). After the fix all
  four new probe checks pass at 1280 and 1040. In the dark capture the
  reward row reads `#10181a` on the pane's `#0a0a0c` (chat's member row:
  `#16151d`). Light theme and hover are left to the owner's by-eye.
  Follow-ups, same day, on the owner's "do those follow-ups as well":
  D2 moved the block override into `ui/scroll-area.tsx` (Activity's and
  Clean cut's own overrides removed); D3 paints tips `bg-warning/10`. The
  probe gained `comments-window-set-theme` (the renderer toggle's own
  `applyNativeTheme`), a tip and an unbroken-link fixture, a "no list wider
  than its pane" check, and runs every row check in light and dark at 1280
  and 1040, with a capture per theme. Light: reward `#c8d0d2`, tip
  `#d6d2c9` on the pane's `#d7d7d7` (member `#cecdd3`). Dark: reward
  `#10181a`, tip `#221b13` on `#0a0a0c`. Chat already wrapped the unbroken
  link (no red there); a scratch run confirmed Diagnostics' two log lists
  are blocks at their pane width at 900 and 1400 px. The Go Live, Schedule
  and Markers dialogs and the takeover screens list were not rendered.
- **Route**: UI/Product Design, fit 9. Model lane `opus-4.8` (scoped,
  user-facing taste work). Read `.claude/skills/videorc-design/SKILL.md`
  before S2.

## Goal

The owner, from a screenshot of Activity with two Twitch channel point
redemptions ("Orc War Cry · 1,000 Orc Gold", "Hydrate the Orc · 500 Orc
Gold"):

> I would like to have a background behind these rewards inside of our
> activity column. Also those three dots, that button is not displayed
> properly so we need to fix that one as well.

Done means:

1. Every Activity row's ⋯ button sits fully inside the pane at every window
   width, however long the name or reward is. The short fact truncates with
   an ellipsis instead of pushing the menu out.
2. A channel point redemption row reads as a reward at a glance: one quiet
   tinted background, in both themes, that never fights hover or the
   on-stream fill.

## What exists today

- `apps/desktop/src/renderer/src/components/stream-manager/activity-pane.tsx`
  - `ActivityRow` renders `<li className="flex items-start gap-2.5 px-3 py-2
    hover:bg-accent">`, the avatar, a `flex-1 min-w-0` text column (name
    `max-w-[60%] shrink-0 truncate`, short fact `min-w-0 truncate`, time,
    platform mark), then `<KebabMenu className="-mr-1 shrink-0">`.
  - On stream (`highlight.phase === 'live'`) the row adds `bg-accent`.
  - The list sits in `<ScrollArea className="min-h-0 flex-1" type="scroll">`.
  - Redemptions are `item.kind === 'redemption'`, filter `rewards`
    (`lib/stream-activity.ts`, plan 162/163). `KIND_ICONS.redemption` is
    `null`: the row shows the viewer's avatar.
- `components/ui/scroll-area.tsx` wraps Radix ScrollArea 1.2.10, whose
  Viewport renders its children inside
  `<div style="min-width:100%; display:table">`.
- `components/clean-cut/clean-cut-transcript.tsx:140` already works around
  that wrapper with `[&_[data-slot=scroll-area-viewport]>div]:block!`.
- Chat's row tints (plan 154) are the precedent for S2:
  `components/comment-row.tsx` `ROW_TINT_CLASS` (`member: 'bg-member/8'`,
  `paid: 'bg-warning/10 ring-1 ring-warning/30'`), one tint per row, exposed
  as `data-row-tint`. `--member` is defined in `styles.css` (dark ~L105,
  light ~L229, `@theme` ~L447).
- Design law (`videorc-design` SKILL.md): "Colour is information… Never tint
  panels, rows, or text decoratively." A row tint must mean something and
  have exactly one owner, like `--member`.
- `pnpm probe:comments-window` sweeps 320/480/640/800/1040/1280 and fails on
  document overflow and unreachable controls, but never checks that an
  Activity row's ⋯ is inside the pane.

## Root cause of the ⋯ bug (diagnosed, not yet reproduced in the probe)

Radix's `display: table` wrapper sizes to its content, not to the viewport.
Inside it, `truncate`/`min-w-0` cannot constrain anything: a row with a long
name + reward grows wider than the pane, the reward text shows in full (no
ellipsis, as in the screenshot), and the ⋯ button is pushed past the right
edge where the viewport clips it. Short rows look fine because the table's
`min-width: 100%` still fills the pane.

## Decisions

- **D1: which background (owner call, blocks S2).**
  - **(a) Recommended: one new `--reward` token**, a muted hue distinct from
    member violet (300) and paid amber (75), e.g. a muted blue-teal around
    hue 220, painted as `bg-reward/8` on redemption rows only. Same model
    as `--member`: one meaning, one owner, never chrome or text. Frontend
    only.
  - (b) The reward's own Twitch colour. EventSub's redemption event has no
    colour; it needs Helix `Get Custom Reward` (`background_color`, scope
    `channel:read:redemptions`, already opt-in), a per-session cache by
    reward id, a new optional wire field (`skip_serializing_if`, the
    serde-null trap), and a fallback for automatic rewards. Arbitrary
    streamer colours break "chrome is monochrome" and need light-mode
    contrast handling. Adds a backend slice; not recommended.
- **D2: scope of the ScrollArea fix.** (Executed: moved into the primitive
  on the owner's word.) Recommended: fix Activity only now
  (S1), matching the Clean cut precedent. Moving `block!` into the shared
  primitive would fix every pane (chat, Go Live, Diagnostics…) but changes
  layout for eight call sites; that is a follow-up plan if wanted.
- **D3: other paid events.** (Executed: tips paint `bg-warning/10`.) Tips,
  bits, Power-ups and Super Chats keep no tint in Activity. If the owner
  wants them to match chat's paid tint, that is a one-line follow-up after
  S2.

## Slices

### S1: The ⋯ menu stays inside the pane

1. Red first: in `scripts/comments-window-probe.mjs`, add a check to the
   width sweep: for every `[data-slot="activity-row"]`, the button with
   `aria-label^="Actions for"` has a bounding rect fully inside the
   `[data-slot="activity-pane"]` rect (1 px tolerance), and is not covered
   (`elementFromPoint` at its centre is the button or inside it). Run it on
   unchanged code and confirm it FAILS at least at one width. If no seeded
   row is long enough to fail, lengthen the fake Twitch redemption's reward
   title (e.g. "Hydrate the Orc before the raid") in the fake provider and
   update the one `title !== 'Hydrate'` assertion in
   `scripts/smoke-live-chat-fake-providers.mjs`. Do not add a row: fake
   activity counts are hard-coded in four places. (Executed: the probe's own
   snapshot fixture carries the long reward instead, so fake providers are
   untouched.)
2. Fix: on Activity's `ScrollArea`, add
   `[&_[data-slot=scroll-area-viewport]>div]:block!` (copy the
   Clean cut class exactly) with a one-line comment naming the Radix
   `display: table` wrapper.
3. Confirm the name and short fact now truncate with an ellipsis and the
   full sentence is still on hover (`title={item.line}`, unchanged).
4. Unit test in `activity-pane.test.ts`: the rendered pane markup carries the
   viewport override class (guards against the class being dropped; the
   probe is the real proof).

**Done when**: the new probe check fails on `2aeee8c6` and passes after the
fix at all six widths, and `pnpm --filter @videorc/desktop test` is green.

### S2: Reward rows get their background (after D1)

Assuming D1 (a):

1. `styles.css`: add `--reward` (dark and light values, beside `--member`,
   with the same style of comment: "the reward row tint in Activity. Never
   chrome, never text.") and `--color-reward: var(--reward)` in `@theme`.
   Pick values by eye against the dark glass and the porcelain light theme;
   the tint must read as clearly as `bg-member/8` does in chat, no louder.
2. `ActivityRow`: when `item.kind === 'redemption'`, add `bg-reward/8` and
   `data-row-tint="reward"`. Precedence, as in chat (one background at a
   time): on stream (`bg-accent`) wins over the tint; `hover:bg-accent`
   stays and replaces the tint while hovered. Keep the text monochrome.
3. Tests in `activity-pane.test.ts`: a redemption row has `bg-reward/8` and
   `data-row-tint="reward"`; a follow/tip row has neither; a live redemption
   row has `bg-accent` and not `bg-reward/8`.
4. `videorc-design` SKILL.md: add `--reward` to the Colour list (one owner:
   Activity reward rows) and mention the tint in the "Activity rows" bullet.

**Done when**: unit tests green, `pnpm probe:comments-window` still green,
and the owner has looked at a reward row in dark and light, idle, hovered
and on stream.

If the owner picks D1 (b) instead, stop after S1 and re-plan S2 with a
backend slice (Helix fetch + cache + optional `rewardColor` field + Rust
tests) before the UI slice.

## Verification

Use arm64 node (`PATH=/opt/homebrew/bin:$PATH`).

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`
- `pnpm --filter @videorc/desktop test`
- `pnpm build`
- `pnpm probe:comments-window` (S1 red then green; S2 green)
- `pnpm smoke:live-chat-fake-providers` only if S1 touched fake data
- Owner by-eye: Stream Manager with fake providers, Activity → Rewards and
  All, at narrow and wide widths, both themes.

No Rust, recording or native-preview gate applies: nothing outside the
renderer changes.

## Out of scope

- The shared `ScrollArea` primitive (D2) and other panes' overflow.
- Tints for tips/bits/Power-ups/Super Chats (D3).
- Reward images/icons, reward-specific colours (D1 b), auto-show behaviour.
- Making Activity rows clickable.

## STOP conditions

- The probe check cannot be made to fail on unchanged code at any width with
  a realistic long reward: the cause is not the table wrapper. Stop, report
  the measured rects, and diagnose before fixing.
- The `block!` override makes any Activity row or the empty state lose its
  scroll or height. Stop and report.
- D1 is unanswered when S1 is done. Ship S1 alone; do not invent a colour.
