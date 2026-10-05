# Plan 154: Member and subscriber rows get a quiet tint in the Stream Manager

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report; do not improvise. Read `AGENTS.md` and
> `.claude/skills/videorc-design/SKILL.md` first. When done, update this
> plan's entry at the top of `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 671c67d2..HEAD -- apps/desktop/src/renderer/src/components/comment-row.tsx apps/desktop/src/renderer/src/lib/live-chat-view.ts apps/desktop/src/renderer/src/styles.css scripts/comments-window-probe.mjs apps/desktop/src/main/index.ts`
> If any of those files changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Status: EXECUTED, in review, 2026-10-05.** The owner said: "execute the
  entire plan and create a pr". Built on `cursor/member-row-tint-plan-bc7b`
  (PR #618), one branch for the plan and the slices. Every decision stands
  as written. Steps 1 to 5, 7 and 8 are done and green on Linux
  (typecheck, lint, format, desktop unit tests). Step 6 is in place (the
  `rowTints` reader-state field, the member fixture row and the `member:`
  assertion) but `pnpm probe:comments-window` and the by-eye check need a
  macOS host with the dev app; the agent environment is headless Linux.
  `bg-member/8` is the untuned starting value until that check runs.
- **Priority**: P2
- **Effort**: S (one renderer component, one pure helper, one token, one
  probe fixture, docs)
- **Risk**: LOW (presentation only; no backend, protocol or IPC change)
- **Depends on**: none
- **Category**: direction (UI/Product Design, Stream Manager)
- **Planned at**: commit `671c67d2`, 2026-10-05

## The owner's ask

"Our members, if they're subscribed on YouTube or Twitch, should have a
different background color inside of the stream manager. It shouldn't be
something very bright, but it should be something subtle with a nice
background, so they can be more recognizable inside the stream manager. We
already have a member badge right on the right side with them, but we also
need a background."

## Why this matters

Mid-stream the streamer scans chat fast. Today a member's row differs from
any other row only by a small monochrome "Member" tag chip next to the name
(`RoleTags`, `components/comment-row.tsx`). On the big-text comfortable rows
the chip is easy to miss, and the people who pay for the channel deserve to
be found at a glance. Paid messages already prove the pattern: a Super Chat
or bits row is a faint amber block (`bg-warning/10 ring-1 ring-warning/30`).
Members get the same treatment one notch quieter: a faint tinted block under
the whole row, the chip stays, text stays monochrome.

This is **colour as information**, which the design language allows
("Colour is information", rule 4), as long as it is a subtle fill and never
a loud slab. The design skill is updated in this plan so the rule and the
new tint are stated together.

## Current state (measured on `origin/main` `671c67d2`)

### Membership already arrives as one normalized role

Every chat provider in the backend folds its own subscriber flag into the
single role string `member` on `LiveChatMessage.author_roles`. No backend
work is needed:

- YouTube, `crates/videorc-backend/src/youtube_chat.rs:824-838`
  (`author_roles`): `is_chat_sponsor` → `"member"`.
- Twitch, `crates/videorc-backend/src/twitch_chat.rs:399-411`
  (`roles_from_badges`): badge set `subscriber` or `founder` → `"member"`.
- Kick, `crates/videorc-backend/src/kick_chat.rs:1362-1375`: same mapping.
- X, `crates/videorc-backend/src/x_chat.rs:795-801`: `is_subscriber` →
  `"member"`.

So "a YouTube member or a Twitch subscriber" is exactly
`message.authorRoles.includes('member')` in the renderer. Kick and X
subscribers ride along for free; that is intended.

### Where chat rows are drawn

- `apps/desktop/src/renderer/src/components/comment-row.tsx` is the only
  chat row. The Stream Manager's chat list,
  `components/stream-manager/chat-pane.tsx:548-575`, renders it with
  `density="comfortable"` for live and History alike.
- The row has two shells. A highlightable row (live, `onHighlight` passed)
  is a shadcn `Button`; otherwise it is a `div`. Both carry the row tints
  today:

```tsx
// comment-row.tsx:733-754 (the Button shell)
<Button
  ...
  className={cn(
    'h-auto w-full min-w-0 flex-1 items-start justify-start gap-2 whitespace-normal px-2 py-1.5',
    cohostSpotlight && highlight.phase !== 'live' && 'bg-accent',
    message.amountText && 'bg-warning/10 ring-1 ring-warning/30'
  )}
  ...
  variant={highlight.phase === 'live' ? 'secondary' : 'ghost'}
>

// comment-row.tsx:756-765 (the div shell)
<div
  className={cn(
    'flex min-w-0 flex-1 items-start gap-2 rounded-row px-2 py-1.5',
    cohostSpotlight && 'bg-accent',
    message.amountText && 'bg-warning/10 ring-1 ring-warning/30'
  )}
>
```

- The `<li>` (`comment-row.tsx:722-731`) exposes row facts as data
  attributes for tests and probes: `data-highlight-phase`, `data-mention`,
  `data-spotlight`, `data-message-id`.
- The role chips (`comment-row.tsx:221-241`):

```tsx
const ROLE_LABELS: Record<string, string> = {
  owner: 'Host',
  moderator: 'Mod',
  vip: 'VIP',
  member: 'Member'
}
/** Role tags (owner, moderator, VIP, member) as glass tag chips (plan 055, D3). */
function RoleTags({ roles }: { roles: readonly string[] }): ReactElement | null {
```

- `cn` is `clsx` + `tailwind-merge`. Two `bg-*` classes in one `cn` call
  collapse to the LAST one. That is how a paid row beats the spotlight
  accent today, and it is why the tint precedence below must be written as
  one decision, not as three independent conditions.
- The on-stream row (`highlight.phase === 'live'`) uses
  `variant="secondary"` (`bg-secondary`). A class in `className` would
  override that fill, which is why the spotlight guard reads
  `highlight.phase !== 'live'`.

### Semantic colour tokens

`apps/desktop/src/renderer/src/styles.css` defines the tones twice (light in
`:root` at line 53, dark in `.dark` at line 181) and exposes them to
Tailwind in `@theme inline` (line 392):

```css
/* styles.css:95-103 (light) */
/* Semantic — meaning only, never chrome. */
--live: oklch(0.55 0.24 27);
--live-foreground: oklch(0.985 0 0);
--success: oklch(0.6 0.14 150);
--success-foreground: oklch(0.985 0 0);
--warning: oklch(0.75 0.15 75);
--warning-foreground: oklch(0.27 0.06 75);
--info: oklch(0.58 0.14 250);
--info-foreground: oklch(0.985 0 0);

/* styles.css:218-225 (dark) */
--live: oklch(0.62 0.24 27);
...
--info: oklch(0.68 0.14 250);
--info-foreground: oklch(0.205 0.04 250);

/* styles.css:439-448 (@theme inline) */
--color-info-foreground: var(--info-foreground);
--color-info: var(--info);
--color-live-foreground: var(--live-foreground);
--color-live: var(--live);
...
--color-warning-foreground: var(--warning-foreground);
--color-warning: var(--warning);
```

Tailwind v4 turns `bg-member/8` into
`color-mix(in oklab, var(--color-member) 8%, transparent)`, so one class
tints both themes from their own token values. `tone-*` utilities
(`styles.css:579-603`) exist for chips; this plan does not need one.

### Guards that apply

- `apps/desktop/src/renderer/src/renderer-style-guards.test.ts` fails on any
  colour literal in a renderer `.ts/.tsx/.css/.html` file outside its
  allowlist. The new token lives in `styles.css` as an `oklch(...)` value
  like its neighbours; the component uses only the Tailwind class.
- `pnpm lint` runs `check:em-dashes`: no em dash in app copy or code.
- `pnpm format:check` runs Prettier on `scripts/comments-window-probe.mjs`
  too.

### The pure-helper convention

Behaviour that needs tests lives in a small pure function in `lib/`, and the
component only calls it. Exemplar: `commentCanHighlight` in
`apps/desktop/src/renderer/src/lib/live-chat-view.ts:505-519`, tested in
`lib/live-chat-view.test.ts` and consumed by `comment-row.tsx:3`.

```ts
export function commentCanHighlight(message: LiveChatMessage): boolean {
  if (message.isDeleted || message.eventType === 'deleted' || message.eventType === 'moderation') {
    return false
  }
  ...
  return true
}
```

### The Stream Manager probe

`scripts/comments-window-probe.mjs` (`pnpm probe:comments-window`, macOS dev
app, part of `smoke:local-gates`) pushes fixture snapshots into the real
window and reads them back through the `comments-window-reader-state` smoke
command (`apps/desktop/src/main/index.ts:11091-11135`), which returns
`document.body.innerText` plus per-row maps built from
`document.querySelectorAll('[data-message-id]')`:

```js
highlightPhases: Object.fromEntries(rows.map((row) => [
  row.getAttribute('data-message-id'),
  row.getAttribute('data-highlight-phase')
])),
```

`probeLinksAndStreaks()` (`probe.mjs:663`) pushes `linksAndStreakSnapshot()`
(`probe.mjs:1224-1252`), whose rows come from `messageFixture(...)`
(`probe.mjs:1361-1385`, `authorRoles: []`).

## Decisions (the recommendation is taken; ⚑ = the owner may override)

- **D1 ⚑ One hue for every platform: a muted violet token `--member`.**
  Light `oklch(0.55 0.13 300)`, dark `oklch(0.7 0.12 300)`, with
  `--member-foreground` mirroring `--info-foreground`'s pattern (white on
  light, dark ink on dark) for completeness even though no text uses it
  here. Why violet: it is the one hue the palette does not already use for
  a meaning (red = live/destructive, green = healthy, amber = money and
  attention, blue = info), and it reads as "membership" to streamers from
  both platforms without being Twitch's brand purple. One hue, not a
  per-platform hue: the platform icon already says where the viewer is.
  Override: reuse `--info` (blue) and add no token.
- **D2 Fill only, no ring: `bg-member/8`.** A paid row is a fill plus a
  hairline ring; the member row is one notch quieter, so a Super Chat from
  a member still reads louder than a plain member message. Text stays
  monochrome, the chip stays monochrome glass. The 8% is the starting
  point; the by-eye check (Step 6) may settle anywhere in 6% to 12%, and the
  chosen number is written into the design skill.
- **D3 Precedence, lowest to highest: member, spotlight, paid, on stream.**
  - On stream (`highlight.phase === 'live'`): the `secondary` button fill
    wins and no tint class is added (today's spotlight rule, kept).
  - Paid (`amountText`): the amber block, as today.
  - Spotlight ("Talking about this", `cohostSpotlight`): `bg-accent`, as
    today. It is a live, transient pull-up and must stay visible.
  - Member: `bg-member/8`.
  - Exactly one tint applies. The member chip remains in every case, so a
    member's Super Chat still says "Member".
- **D4 Which rows qualify.** A row is tinted as a member row when
  `authorRoles` includes `member`, the row is a viewer's own
  (`eventType` is `message`, `paid` or `membership`) and it is not deleted
  (a struck-through removed message stays quiet, like its text). System and
  moderation rows never tint, even when their author is a member.
- **D5 No setting.** The tint is part of the row design, like the paid
  block; there is no toggle. Density and timestamps are the only chat
  appearance knobs and they stay.
- **D6 Scope is the Stream Manager chat list** (live and History, they share
  `CommentRow`). The on-stream highlight card, the Activity pane and the
  Phone remote (`crates/videorc-backend/remote_web/app.js:153` shows a role
  label) are not touched; see Maintenance notes.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Install | `pnpm install` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0 |
| Lint | `pnpm lint` | exit 0 (includes the em-dash gate) |
| Format | `pnpm format:check` | exit 0 |
| Desktop unit tests, focused | `pnpm --filter @videorc/desktop test -- comment-row live-chat-view renderer-style-guards` | all pass |
| Desktop unit tests, full | `pnpm --filter @videorc/desktop test` | all pass |
| Stream Manager probe (macOS only) | `pnpm probe:comments-window` | exit 0, `member:` assertions listed as PASS |

## Suggested executor toolkit

- `.claude/skills/videorc-design/SKILL.md`: the token rules, the glass chip
  rules, and the Stream Manager section you will edit in Step 5.
- `.claude/skills/shadcn/SKILL.md` is not needed: no component is added.

## Scope

**In scope** (the only files you should modify):

- `apps/desktop/src/renderer/src/styles.css` (the `--member` token in both
  theme blocks and `@theme inline`)
- `apps/desktop/src/renderer/src/lib/live-chat-view.ts` (new pure helpers)
- `apps/desktop/src/renderer/src/lib/live-chat-view.test.ts`
- `apps/desktop/src/renderer/src/components/comment-row.tsx`
- `apps/desktop/src/renderer/src/components/comment-row.test.ts`
- `apps/desktop/src/main/index.ts` (one new field in
  `comments-window-reader-state` only)
- `scripts/comments-window-probe.mjs` (one fixture row and one assertion)
- `.claude/skills/videorc-design/SKILL.md` (Colour and Stream Manager)
- `plans/README.md` (status)

**Out of scope** (do NOT touch, even though they look related):

- Any backend crate: the `member` role is already normalized everywhere.
- `components/ui/badge.tsx`, `ui/button.tsx`: no new variant. The row class
  is composed in `comment-row.tsx` like the paid tint.
- `lib/comment-highlight.ts`, `lib/caption-overlay*.ts`: the on-stream card
  is viewer-facing and keeps its own design.
- `components/stream-manager/activity-pane.tsx`, `stream-activity.ts`:
  Activity rows are about events, not about who is a member.
- `crates/videorc-backend/remote_web/`: the Phone remote (never add to its
  router or events without a leak argument; not this plan).
- `components/ui/*`, `styles.css` beyond the three token lines: no new
  utility, no new chip tone, no `tone-member`.

## Git workflow

- Branch: `feat/154-member-row-tint` off current `origin/main`.
- One commit per step, imperative subject, e.g.
  `feat(stream-manager): tint member rows (plan 154, S2)`. Recent subjects
  for style: `fix(stream-manager): status dot halo, emote spacing on the
  highlight card, Copy link (#615)`.
- Push and open a PR only if the operator instructed it. Planning
  authorizes no merge or release.

## Steps

### Step 1: Add the `--member` token

In `apps/desktop/src/renderer/src/styles.css`:

1. In `:root` (light), directly after the `--info-foreground` line
   (currently line 103), add:

```css
--member: oklch(0.55 0.13 300);
--member-foreground: oklch(0.985 0 0);
```

2. In `.dark`, directly after its `--info-foreground` line (currently
   line 225), add:

```css
--member: oklch(0.7 0.12 300);
--member-foreground: oklch(0.205 0.04 300);
```

3. In `@theme inline`, directly after `--color-info: var(--info);`
   (currently line 440), add:

```css
--color-member-foreground: var(--member-foreground);
--color-member: var(--member);
```

Add one comment line above the light pair:
`/* Membership (plan 154): the member row tint. Never chrome, never text. */`

**Verify**: `pnpm --filter @videorc/desktop test -- renderer-style-guards`
→ passes (the token is an `oklch(...)` literal in `styles.css`, which the
guard treats like every other token). `pnpm format:check` → exit 0.

### Step 2: Pure helpers in `lib/live-chat-view.ts`

Add below `commentCanHighlight` (`live-chat-view.ts:505-519`):

```ts
/** The author holds a paid membership: YouTube member, Twitch or Kick
 * subscriber, X subscriber. Every provider normalizes it to `member`. */
export function commentAuthorIsMember(
  message: Pick<LiveChatMessage, 'authorRoles'>
): boolean {
  return message.authorRoles.includes('member')
}

export type CommentRowTint = 'paid' | 'spotlight' | 'member' | null

/**
 * The one background a chat row paints (plan 154, D3). Lowest to highest:
 * a member's own message, Orcle's "Talking about this" pull-up, a paid
 * message. An on-stream row paints none: its button fill says so.
 */
export function commentRowTint(
  message: Pick<LiveChatMessage, 'authorRoles' | 'eventType' | 'amountText' | 'isDeleted'>,
  { spotlight, onStream }: { spotlight: boolean; onStream: boolean }
): CommentRowTint {
  if (onStream) return null
  if (message.amountText) return 'paid'
  if (spotlight) return 'spotlight'
  const viewerRow =
    message.eventType === 'message' ||
    message.eventType === 'paid' ||
    message.eventType === 'membership'
  if (viewerRow && !message.isDeleted && commentAuthorIsMember(message)) return 'member'
  return null
}
```

Keep the existing `amountText` semantics: today a paid row keeps its block
even when deleted, and this helper preserves that (paid is checked before
`isDeleted`).

**Verify**: `pnpm typecheck` → exit 0.

### Step 3: Tests for the helpers

In `apps/desktop/src/renderer/src/lib/live-chat-view.test.ts`, inside the
existing `describe('live-chat-view', ...)` (line 117), add cases built on
the file's factory `message(id, platform, receivedAt)` (line 33) with
spread overrides, e.g.
`{ ...message('youtube:m1', 'youtube', '2026-07-10T12:00:00Z'), authorRoles: ['member'] }`,
for:

- `commentAuthorIsMember`: `['member']` → true; `['owner', 'member']` →
  true; `['vip']` → false; `[]` → false.
- `commentRowTint` precedence: on stream wins over paid, paid wins over
  spotlight, spotlight wins over member, member alone → `'member'`.
- `commentRowTint` eligibility: `eventType: 'system'` with role member →
  `null`; `eventType: 'moderation'` → `null`; `isDeleted: true` member
  message → `null`; `eventType: 'membership'` with role member →
  `'member'`.

**Verify**: `pnpm --filter @videorc/desktop test -- live-chat-view` → all
pass, new cases included.

### Step 4: Paint the tint in `CommentRow`

In `apps/desktop/src/renderer/src/components/comment-row.tsx`:

1. Extend the import on line 3:
   `import { commentCanHighlight, commentRowTint, type CommentRowTint } from '@/lib/live-chat-view'`.
2. Add one module-level map near `ROLE_LABELS`:

```ts
/** Row backgrounds (plan 154, D2, D3): one tint per row, never two. */
const ROW_TINT_CLASS: Record<Exclude<CommentRowTint, null>, string> = {
  paid: 'bg-warning/10 ring-1 ring-warning/30',
  spotlight: 'bg-accent',
  member: 'bg-member/8'
}
```

3. In `CommentRow`, after `const mentioned = ...` (line 699), compute:

```ts
const tint = commentRowTint(message, {
  spotlight: cohostSpotlight,
  onStream: highlight.phase === 'live'
})
```

4. Replace the two tint conditions in BOTH shells with the one lookup:
   - Button shell (`comment-row.tsx:744-748`): the `className` becomes

```tsx
className={cn(
  'h-auto w-full min-w-0 flex-1 items-start justify-start gap-2 whitespace-normal px-2 py-1.5',
  tint && ROW_TINT_CLASS[tint]
)}
```

   - div shell (`comment-row.tsx:757-762`): the `className` becomes

```tsx
className={cn(
  'flex min-w-0 flex-1 items-start gap-2 rounded-row px-2 py-1.5',
  tint && ROW_TINT_CLASS[tint]
)}
```

   The div shell is never on stream (no `onHighlight`), so passing
   `highlight.phase === 'live'` is harmless and keeps one computation.

5. On the `<li>` (`comment-row.tsx:722-731`) add
   `data-member={tint === 'member' || undefined}` and
   `data-row-tint={tint ?? undefined}` next to `data-mention`.

Behaviour that must not change: the paid row still renders
`bg-warning/10 ring-1 ring-warning/30`; the spotlight row still renders
`bg-accent` and, on stream, no `bg-accent` (existing tests at
`comment-row.test.ts:171-200` cover this); the Member chip
(`data-slot="comment-role"`) still renders.

**Verify**: `pnpm typecheck && pnpm lint` → exit 0.
`pnpm --filter @videorc/desktop test -- comment-row` → existing tests pass.

### Step 5: Row tests

In `apps/desktop/src/renderer/src/components/comment-row.test.ts`, add a
`describe('CommentRow: member tint', ...)` modelled on
`describe('CommentRow: Talking about this', ...)` (line 171), using the
file's `message()` factory and `renderToStaticMarkup`:

- A `message` row with `authorRoles: ['member']` renders `bg-member/8`,
  `data-member="true"`, `data-row-tint="member"`, and still contains the
  `Member` chip text. Covers both shells: once with `onHighlight`, once
  without.
- A member row with `amountText: '$5', eventType: 'paid'` renders
  `bg-warning/10` and NOT `bg-member/8`; `data-row-tint="paid"`.
- A member row with `cohostSpotlight: true` renders `bg-accent` and NOT
  `bg-member/8`.
- A member row with `highlight: { phase: 'live' }` renders neither
  `bg-member/8` nor `bg-accent`, and has no `data-row-tint`.
- A member row with `isDeleted: true` renders no `bg-member/8`.
- A row with `authorRoles: []` renders no `data-member`.

**Verify**: `pnpm --filter @videorc/desktop test -- comment-row` → all pass,
new cases included.

### Step 6: Probe fixture and assertion (macOS dev app)

1. In `apps/desktop/src/main/index.ts`, inside the
   `comments-window-reader-state` script (lines 11091-11135), add one field
   after `highlightPhases`:

```js
rowTints: Object.fromEntries(rows.map((row) => [
  row.getAttribute('data-message-id'),
  row.getAttribute('data-row-tint')
])),
```

2. In `scripts/comments-window-probe.mjs`, add a constant next to
   `LINK_MESSAGE_ID` (line 31):
   `const MEMBER_MESSAGE_ID = \`${NEXT_LIVE_SESSION_ID}:youtube:probe-member\``
   and append one row to `linksAndStreakSnapshot()` (line 1224) after the
   streak row:

```js
{
  ...messageFixture({
    id: MEMBER_MESSAGE_ID,
    platform: 'youtube',
    sessionId: NEXT_LIVE_SESSION_ID,
    authorName: 'Member Viewer',
    messageText: 'Members get a quiet tint (plan 154)',
    at: '2026-07-10T10:00:05Z'
  }),
  authorRoles: ['member']
}
```

3. In `probeLinksAndStreaks()` (line 663), after the streak assertion, wait
   for the reader state and assert:

```js
const tinted = await waitFor(
  () => smokeCommand('comments-window-reader-state'),
  (s) => s.rowTints?.[MEMBER_MESSAGE_ID] === 'member' && s.rowTints?.[LINK_MESSAGE_ID] === null,
  5000
)
assertProbe(
  tinted.ok,
  'member: a member row paints the member tint and a plain row paints none',
  JSON.stringify(tinted.last?.rowTints)
)
```

4. Run `pnpm probe:comments-window` on a macOS host with the dev app. It
   also writes window captures; open the 1280-wide live capture in both
   themes (toggle the app theme in Settings, rerun) and judge the tint by
   eye against D2: the row must read as "a member" at a glance and must
   not look like a card or compete with a paid row. If 8% is invisible over
   a bright desktop or loud over black glass, adjust `bg-member/8` within
   6% to 12% in `ROW_TINT_CLASS` and in the test expectations, then write
   the final number into Step 7's skill text.

**Verify**: `pnpm probe:comments-window` → exit 0 with the `member:` line
PASS. `pnpm format:check` → exit 0 (the probe is Prettier-checked). If no
macOS host is available, record that in the PR and the plan status and
keep the fixture and assertion in place for the next run.

### Step 7: Design skill

In `.claude/skills/videorc-design/SKILL.md`:

1. Under "Colour" (after the `--success` / `--warning` / `--info` bullet,
   line 139), add:

```md
- `--member`: a muted violet for paid membership (YouTube member, Twitch,
  Kick or X subscriber). It paints only the member row tint in chat
  (plan 154); never a chip tone, never text.
```

2. Under "Stream Manager", extend the "Chat keeps the big-text rows" bullet
   (line 252) with:

```md
  A row paints at most one background, lowest to highest: a member's own
  message `bg-member/8` (plan 154), Orcle's "Talking about this"
  `bg-accent`, a paid message `bg-warning/10` with its ring; an on-stream
  row keeps its button fill. The Member chip stays on every tinted row and
  text stays monochrome.
```

Replace `8` with the number settled in Step 6 if it changed.

**Verify**: `git diff --stat .claude/skills/videorc-design/SKILL.md` shows
only those two hunks.

### Step 8: Index

Add this plan's entry at the top of `plans/README.md`, matching the shape of
the plan 153 entry, with status EXECUTED, in review, the branch name and
whether the macOS probe ran.

## Test plan

- New unit tests (Steps 3 and 5) in `lib/live-chat-view.test.ts` and
  `components/comment-row.test.ts`; pattern: the existing
  `describe('CommentRow: Talking about this', ...)` block.
- Probe (Step 6): a member fixture row in the real Stream Manager, read
  back through `rowTints`.
- Gates before handoff: `pnpm typecheck && pnpm lint && pnpm format:check &&
  pnpm --filter @videorc/desktop test`; `pnpm probe:comments-window` on
  macOS. No recording, preview, capture or encoding path is touched, so the
  recording-studio smokes are not required (AGENTS.md: this is a
  presentation-only Stream Manager change; say so in the PR).

## Done criteria

ALL must hold:

- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm format:check` exit 0
- [ ] `pnpm --filter @videorc/desktop test` exits 0; the new `member tint`
      and `commentRowTint` cases exist and pass
- [ ] `grep -n "bg-member" apps/desktop/src/renderer/src/components/comment-row.tsx`
      shows exactly one match (the `ROW_TINT_CLASS` map)
- [ ] `grep -c -- "--member" apps/desktop/src/renderer/src/styles.css` → 6
      (two per block: `:root`, `.dark`, `@theme inline`)
- [ ] `grep -n "amountText && 'bg-warning" apps/desktop/src/renderer/src/components/comment-row.tsx`
      returns nothing (the inline conditions were replaced by the lookup)
- [ ] `pnpm probe:comments-window` passes on macOS, or the PR states that
      no macOS host was available and the fixture is in place
- [ ] Both theme captures were judged by eye and the chosen percentage is
      in `ROW_TINT_CLASS`, the tests and the design skill
- [ ] `git status` shows no files outside the in-scope list
- [ ] `plans/README.md` entry added

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts in "Current state" no longer match `comment-row.tsx`,
  `live-chat-view.ts` or `styles.css` (drift).
- `renderer-style-guards.test.ts` fails after Step 1: the guard may have
  gained a rule about new tokens; do not add the file to the allowlist.
- A `member` role is missing for a provider the owner named (YouTube or
  Twitch) in a real session: that is a backend bug, out of scope here.
- The change seems to need a Button or Badge variant, a new `tone-*`
  utility, or a settings toggle.
- `tailwind-merge` does not collapse the classes as described (a row renders
  two `bg-*` classes): report the rendered markup instead of adding
  `!important` or inline styles.

## Maintenance notes

- `commentRowTint` is now the one place that decides a row's background. Any
  new row state with a fill (a future "first-time Super Chat", a mod
  action) goes into that helper's precedence list and the `ROW_TINT_CLASS`
  map, never as another inline `&&` in the shells.
- Reviewers should check: no second `bg-*` in a rendered row; the Member
  chip still shows beside the tint; the on-stream `secondary` fill is not
  overridden; light mode was looked at, not only dark.
- Deferred, on purpose:
  - The Phone remote (`remote_web/app.js`) shows a role label but no tint.
    Styling it is a separate slice with its own leak review.
  - The on-stream highlight card stays as designed; whether a member's card
    should differ for viewers is a product call, not a dashboard one.
  - Activity rows (subs, gifts) are already about membership events and
    need no tint.
  - A `tone-member` chip tone (a violet dot on the Member chip) was
    considered and rejected: the owner asked for a background, and the chip
    rules keep tags monochrome.
