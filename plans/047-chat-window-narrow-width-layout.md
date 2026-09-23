# Plan 047: Chat window stays whole at narrow widths

> Executor: implement the ordered slices below in an isolated worktree of current
> main. Read AGENTS.md and `.claude/skills/videorc-design/SKILL.md` first. Keep
> each slice independently testable. Planning authorizes no merge or release.

## Status and decisions

- Status: IMPLEMENTED 2026-09-23 on `fix/chat-window-narrow-width` (S1–S3).
  Owner by-eye at real widths while live is the remaining acceptance step.
  Priority P1 (owner: "we actually need that one fixed"); effort S–M; risk
  LOW (renderer layout plus probe-only smoke commands; no wire or backend change).
- Result: `pnpm probe:comments-window` passes 167 assertions (two consecutive
  runs), sweeping 320/380/420/429/430/480/559/560/900 px live, Orcle paused and
  history. Mutation check: removing `@container/chat-header` fails every
  narrow assertion, and measures the header content at 466 px even at the 420 px
  default window. The starting breakpoints (header content 460/330 px, i.e.
  windows 560/430 px) held with the real labels; no retune needed.
- Planned against `origin/main` `38a4712e` (release: prepare 0.9.101). The
  plan-storage checkout (`feat/windows-owner-waiver`, `15206746`) is 14 commits
  behind; the only drift in the touched files is the Orcle copy rename. Build
  on main.
- Owner route: UI/Product Design (fit 9). Model lane: `opus-4.8` (scoped,
  user-facing layout polish). Escalate to `fable-5` if the probe cannot measure
  layout reliably.
- Branch: `fix/chat-window-narrow-width`. Commits use `fix(chat):`.
- Owner decisions (2026-09-23):
  1. **The viewer count is never hidden while live.** It stays in the header
     and shrinks to eye icon + number (`1.2k`). The word "watching" drops at
     narrow widths; the per-platform split stays in the tooltip.
  2. **Right-side controls collapse only when narrow.** Wide windows look
     exactly as they do today. Below the breakpoint, highlight position, keep
     on top and Clear view move into one `⋯` menu.

## Problem (measured from source)

The detached Chat window (`src/main/index.ts`, `openCommentsWindow`) defaults to
420 px wide and allows `minWidth: 320`. Its header
(`apps/desktop/src/renderer/src/components/comments-reader.tsx`, `<header>`) is
a fixed `h-10` single row with `pl-[88px] pr-3` (traffic-light gutter), so only
**W − 100 px** is left for content: 220 px at the minimum, 320 px at the default.

A live header with viewers and Orcle needs roughly 440 px of content:

| Item | Approx. width |
| --- | ---: |
| `Chat` + `Live` badge | 60 |
| `👁 1.2k watching` | 95 |
| Orcle status (`● Orcle listening`, longer when paused with a reason) | 110+ |
| Highlight position + pin + `Clear view` | 136 |
| Gaps (`gap-2`) | 40 |

So the header overflows at **every width below ~540 px, including the default
420**. What the owner sees:

1. The viewer chip (`<span className="flex items-center gap-1 …">`) has no
   `shrink-0` / `whitespace-nowrap`, so flexbox squeezes it and
   "1.2k watching" wraps onto two lines inside the fixed 40 px strip.
2. `overflow-hidden` on the header silently clips the right-hand controls
   (`Clear view`, then pin, then highlight position), so they become
   unreachable.
3. `CohostStatus`'s trigger is `shrink-0` and its label's `truncate` has no
   `min-w-0`, so a long Orcle label (`Orcle paused · <reason>`, the grouped
   flash) never truncates. It pushes everything else out instead.
4. In history mode, `Back to live` competes with the history title, badge and
   Orcle status in the same 220 px.

The Orcle pane in the body breaks too (`cohost-pane.tsx`):

5. The active-row action bar (`data-slot="cohost-actions"`) shows the hint plus
   `Reply R`, `Show on stream H`, `Answered A` and `Dismiss ⌫`, about 350 px,
   inside a pane that is about 280 px wide at the minimum window.
6. The pane trigger row packs chevron, icon, `Orcle`, `alpha`, dot, status,
   `N new`, alert badges, `Partial` and mood into one line. The status span has
   `truncate` without `min-w-0`, so it cannot give up space.

Comment rows, the composer and the destination status already truncate or wrap
correctly. S3 verifies them at 320 px, but no change is expected.

## Design

Use **CSS container queries** (Tailwind v4 built-in `@container` plus `@max-*`
variants; precedent: `ui/field.tsx`). Do not use JS resize observers or window
width state: the header measures itself, so the reader stays correct if it is
ever embedded elsewhere.

The header becomes `@container/chat-header`. Its container width is the content
box, W − 100. Three tiers, as starting values; S3 re-measures them with the real
labels:

| Tier | Header content width (window) | Layout |
| --- | --- | --- |
| **Full** | ≥ 460 px (W ≥ 560) | Exactly today's layout. |
| **Compact** | 330–459 px (W 430–559) | Highlight position, pin and Clear view collapse into `⋯`. Viewer chip still says `1.2k watching`. Orcle keeps its label, truncating. |
| **Tight** | < 330 px (W < 430) | Viewer chip becomes `👁 1.2k`. Orcle becomes a dot-only trigger with the label in the tooltip and `aria-label`. In history mode, the history title and date hide (shown in the History badge's `title`), and so does the `Chat` word. `Back to live` stays visible. |

Budget check for Tight at W = 320 (220 px available):
`Chat` 26 + `Live` 34 + `👁 1.2k` 45 + Orcle dot 24 + `⋯` 28 + gaps 32 = **189 px**.
History at W = 320: `History` 44 + Orcle 24 + `Back to live` 80 + `⋯` 28 +
gaps 24 = **200 px**. Both fit.

Shrink priority, so the viewer number is the last live item to lose space:
`Chat` label and live badge `shrink-0`; viewer chip `shrink-0 whitespace-nowrap`;
Orcle trigger `min-w-0 shrink` with its label `min-w-0 truncate` and a
`max-w-40` cap in Full; the history title `min-w-0 flex-1 truncate`. Keep
`overflow-hidden` on the header as a last-resort guard, never as the layout
mechanism.

The `⋯` menu (shadcn `DropdownMenu`, trigger `Button size="icon-sm"
variant="ghost"` with `MoreIcon` from `@/components/icons`,
`aria-label="More chat actions"`, `[-webkit-app-region:no-drag]`):

- Label `Show highlighted messages in` + `DropdownMenuRadioGroup` of the four
  anchors, in a `DropdownMenuSub` titled `Highlight position`.
- `DropdownMenuCheckboxItem` `Keep on top`, checked from `alwaysOnTop`.
- Separator, then `Clear view`, with the existing "Clear view keeps Library
  history." as secondary text. Only present when `onClear` exists.
- Items whose handler is absent do not render. If none would render, the
  trigger does not render either.

Render the inline controls and the `⋯` menu both, toggled with container-query
visibility (`@max-[460px]/chat-header:hidden` on the inline group,
`hidden @max-[460px]/chat-header:flex` on the menu). Wide windows keep today's
DOM and behaviour, and there is no JS resize state. Extract the anchor labels,
radio group and handlers once and share them between the inline dropdown and
the submenu, so the two cannot drift.

Viewer chip: split the label so the tiers are pure CSS.
`<span data-slot="viewer-count" aria-label="1.2k watching" title="youtube: 900 · twitch: 300">`
contains the icon, `<span>1.2k</span>`, and
`<span className="@max-[330px]/chat-header:hidden"> watching</span>`. Add
`viewerChipCount(sample)` to `lib/viewer-count-view.ts` and keep
`viewerChipLabel` for the accessible name. The stale-grey rule is unchanged.

Orcle pane (`cohost-pane.tsx`): the `Collapsible` root becomes
`@container/cohost-pane`.
- Trigger row: status span gains `min-w-0`; `alpha` and the mood label hide
  below ~300 px (mood is already in a `title`, so add the label there); the row
  gets `min-w-0 overflow-hidden`.
- Action bar: below ~340 px, hide the hint text and the `Kbd` chips (the
  shortcuts still work; set each button's `title` to `Reply (R)` etc.). Add
  `flex-wrap` as the safety net, so an extra-long label wraps to a second line
  instead of clipping.

Out of scope: raising `minWidth` (the owner wants narrow to work), changing the
in-app comments panel, any wire/backend/relay change, new icons (`MoreIcon`
already exists), and Windows-specific chrome (the 88 px gutter is the macOS
traffic-light budget; keep the same tiers on Windows).

## Slices

### S1 — Header tiers, viewer chip and `⋯` menu

Files: `components/comments-reader.tsx`, `lib/viewer-count-view.ts`,
`lib/viewer-count-view.test.ts`, new `components/comments-reader-header.test.ts`
(or extract the header into `comments-reader-header.tsx` if that keeps the reader
readable; the extraction is optional).

Steps:
1. Add `viewerChipCount` plus tests. Cover `999` → `999`, `1_200` → `1.2k`,
   `999_999` (today it formats as `1000k`: fix it to `1m`) and `1_500_000` →
   `1.5m`.
2. Make the header `@container/chat-header` and apply the shrink priorities
   above.
3. Split the viewer chip and add `data-slot="viewer-count"` plus `aria-label`.
4. Add the `⋯` menu with the shared anchor group and the tier visibility
   classes.
5. Tight-tier history rules: hide the title/date span and the `Chat` word, and
   move the title into the History badge `title`.

Done when: `renderToStaticMarkup` tests assert that (a) the live header renders
`data-slot="viewer-count"` with `aria-label="1.2k watching"` and a separate
count span; (b) the `⋯` trigger exists with `aria-label="More chat actions"`
when any action exists, and not when none do; (c) history mode keeps
`Back to live` outside the menu; (d) the inline controls and the menu carry the
container-query visibility classes. `pnpm typecheck`, `pnpm lint` and
`pnpm --filter @videorc/desktop test` pass.

### S2 — Orcle status and pane at narrow widths

Files: `components/cohost-status.tsx`, `components/cohost-pane.tsx`, their tests.

Steps:
1. `CohostStatus`: trigger `min-w-0 shrink` (was `shrink-0`), label
   `min-w-0 truncate`, `max-w-40` cap. In the Tight tier (the ancestor
   `chat-header` container variant), hide the label so the dot carries it. The
   `aria-label` already carries `view.label`; also check that the `title`
   includes the label, not only the tooltip lines.
2. Pane container, trigger-row `min-w-0` fixes, hide `alpha`/mood when narrow.
3. Action bar: hide the hint and `Kbd` chips when narrow, add `title="Label (K)"`
   and `flex-wrap`.

Done when: the tests assert the dot-only tier class on the status label, the
`title` on action buttons, and that no header or pane label loses its accessible
name. The same JS gates as S1 pass.

### S3 — Real-window proof in `probe:comments-window`

Files: `scripts/comments-window-probe.mjs`, `apps/desktop/src/main/index.ts`
(smoke-command handlers), `apps/desktop/src/main/smoke-command-security.ts`
(allowlists).

Steps:
1. Add smoke commands if missing: `comments-window-seed-viewers` (push a
   `ViewerSample` through the real main relay, e.g. total 1 234 across
   YouTube and Twitch) and `comments-window-seed-cohost` (push a
   `CohostWindowState`: entitled, consented, enabled, `paused` with the longest
   real reason label, plus one open question so the action bar renders). Use
   the existing push paths. The authority probe must still show that the
   renderer cannot forge these values.
2. Add `comments-window-layout-metrics`: `executeJavaScript` in the Chat window
   and return, for the header and `[data-slot="cohost-actions"]`,
   `scrollWidth`, `clientWidth` and each direct child's
   `getBoundingClientRect()`, plus the viewer chip's height, text and
   visibility.
3. In the probe, for widths **320, 380, 420, 480, 560, 900** × {live with
   viewers + Orcle, history, idle}, assert: header `scrollWidth <= clientWidth`;
   every visible child's right edge ≤ header right − 12; viewer chip visible
   while live and single-line (height ≤ 20); `Back to live` visible in history;
   no action-bar child clipped. At W ≥ 560, assert the inline controls are
   visible and `⋯` is hidden (today's layout is unchanged). Below that,
   assert the reverse.
4. Parameterize `captureState` (it hard-codes 420×640) and save captures at
   320 and 900 for the owner. Restore the 420×640 bounds before the existing
   frame-persistence assertions.
5. If a measured tier boundary disagrees with the plan's starting values,
   update the container-query breakpoints to the measured numbers and record
   them here.

Done when: `pnpm probe:comments-window` passes with the new assertions, and a
temporary revert of S1 makes them fail (confirm once locally, then restore it).
Build the debug backend before running the probe (known trap: see the chat
window glass plan memory).

## Verification

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`
- `pnpm --filter @videorc/desktop test` (arm64 node first on PATH)
- `pnpm build`, `pnpm check:renderer-assets` (the renderer asset budget was red
  on main as of 2026-09-21; report the delta rather than blaming this change)
- `pnpm probe:comments-window`
- Owner by-eye (required before merge, since the owner reported it): go live
  with viewers and Orcle on, drag the Chat window from wide to 320 px and back.
  At every width, the count should stay on one line, nothing should be clipped,
  and every action should be reachable, inline or in `⋯`. Repeat in history
  mode.

## Handoff

- Goal: the Chat window is fully usable at every width it allows (320 px and up),
  and the viewer count is always visible while live.
- Current state: nothing implemented. The problem lines are cited above.
- Route/model/fit: UI/Product Design · `opus-4.8` · 9.
- Order: S1 → S2 → S3 (S3's assertions prove S1 and S2; you may write them
  first as a red test).
- Blockers: the probe needs a local Electron run with the debug backend. No
  macOS capture permissions are needed (no camera or screen capture).
