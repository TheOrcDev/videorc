# Plan 064: Settings gets tabs across the top

> Executor: implement the ordered slices below in an isolated worktree of
> current main. Read `AGENTS.md` and `.claude/skills/videorc-design/SKILL.md`
> first. Planning authorizes no merge or release.

## Status and decisions

- Status: **EXECUTED** 2026-09-26 on `feat/settings-tabs` (S1 to S4, one
  commit each, pushed per slice). Owner by-eye review is still owed.
  Deviations from the plan below:
  - Links from outside React reuse the existing `videorc:navigate-workspace`
    event with a `settingsTab` field instead of a new `videorc:open-settings`
    event. `openSettingsTab(tab)` in `lib/settings-tabs.ts` is the one typed
    way to send it.
  - At `lg`, two-section tabs fill the visible height (`SECTION_PAIR`), so
    the column hairline runs the full height on short tabs. The first
    screenshots showed it stopping mid-page.
  - The App shortcuts description is "Keys that work while Videorc is in
    front." Below `lg` the global recorders sit above the list, not to its
    left, so "on the left" was dropped.
  - Kept General as a pair (Appearance beside Import). Its right column is
    sparse at 1280 px, like About's. It is listed for the owner's by-eye.
  - Found, not fixed (out of scope): the "Open Livestream" action on the
    chat-not-connected toast (`use-studio.tsx`, about line 2217) sends
    `{ tab: 'streaming' }`, which is not a workspace tab id (`live` is),
    so that button does nothing.
- Verification: typecheck, lint, format:check, desktop tests (223 files),
  test:scripts (1,530), build, and check:renderer-assets are green. Eager JS
  is 1,987,692 raw / 383,324 gzip locally, up from 1,985,665 / 382,812 on
  main (CI reads about 1.6 KB less gzip). A CDP probe of the dev app passed
  14/14. It covered the ⌘K items, the navigate event, scroll reset, the
  pinned strip, tab memory across a relaunch, and the S4 recorder check:
  main swallows D while a recorder is armed, and D reaches the page again
  after its tab is switched away.
- Priority: P2. Effort: M (about 1 to 1.5 days). Risk: low. This is
  renderer-only. It does not touch recording, native preview, the backend or
  persisted settings keys.
- Planned against origin/main `d39b4a4d`. The `feat/windows-owner-waiver`
  checkout is 82 commits behind main, so every reference below is from
  origin/main.
- Owner route: UI/Product Design (fit 8). S1 and S3 are Implementation
  (fit 8). Model lanes: S1 and S3 use `gpt-5.5`; S2 and S4 use `opus-4.8`.
- Branch `feat/settings-tabs`, commit prefix `feat(settings):`, one commit per
  slice, one PR.
- Owner request (2026-09-26): "separate the entire Settings into tabs inside,
  on top … so people can go on top and click things like shortcuts."
- Owner decisions (2026-09-26, answered in session):
  1. **Seven focused tabs:** General · Recording · Permissions · Shortcuts ·
     Remote · Orcle · About.
  2. **Segmented control**, the same recessed glass pill as Livestream's
     Setup / Upcoming and the Stream Manager tabs. Text labels, no icons.
  3. **Settings opens on the last tab you used**, remembered on this Mac.
     A link that names a tab (update chip, FFmpeg banner, ⌘K, toasts) opens
     that tab instead.
  4. **No settings search field.** Add a ⌘K "Settings" group that jumps
     straight to each tab.

### What is wrong today

`components/tabs/settings-tab.tsx` (968 lines) renders **11 cards in one
two-column `ConfigGrid`**, in this order:

| Left column (line) | Right column (line) |
| --- | --- |
| Recording & storage (233) | Appearance & behavior (625) |
| System access (409) | Import (698) |
| Orcle (alpha) (500, `CohostSettingsSection`) | Support (711) |
| Global shortcuts (505) | About & updates (731, `AboutAndUpdates`) |
| Remote control (569) | Shortcuts reference (735) |
| Phone remote (618, `PhoneRemoteSection`) | |

Everything is on one long scroll. Global shortcuts is fourth in the left
column, below the tall Orcle card, and the in-app shortcut list is last in the
right column. So "change a shortcut" means scrolling past storage,
permissions and the whole Orcle form. Below `lg` (the window can go down to
960 px), both columns stack into one very long list. Links into Settings
cannot say where to land either: the update chip, the FFmpeg banner and the
"pick different bindings" toast all drop you at the top of the page.

### The target experience

```
┌ Settings ───────────────────────────────────────────────────────────┐  ← toolbar: title only
│ ╭──────────────────────────────────────────────────────────────────╮ │
│ │[General] Recording  Permissions  Shortcuts  Remote  Orcle  About │ │  ← pinned tab strip
│ ╰──────────────────────────────────────────────────────────────────╯ │
├──────────────────────────────────────────────────────────────────────┤
│  the selected tab's sections (only this area scrolls)                │
└──────────────────────────────────────────────────────────────────────┘
```

- The strip sits directly under the toolbar and never scrolls away. It is
  built like the Livestream page's (`streaming-tab.tsx:117-125`: a
  `border-b border-border px-gutter py-2` band holding a default-variant
  `TabsList`). The toolbar keeps only the page title (owner call,
  2026-09-23).
- Click a tab, or focus the strip and use ←/→/Home/End (Radix provides the
  arrow keys). Switching tabs scrolls the content back to the top.
- ⌘, and the sidebar open the last tab you used. The first launch opens
  General.

### Tab contents (the one-home law still holds)

Every existing control keeps exactly one home. Nothing moves to another page,
and Recording preset / Stream destinations still **link** to Output and
Livestream instead of copying their controls (ST1).

| Tab | Sections, in order | Layout |
| --- | --- | --- |
| **General** | **Appearance & behavior**: Theme; Open Stream Manager when I go live (only when `commentsWindowEnabled`); **Animate scene changes** (moved here from Recording & storage); Graphics acceleration (win32 only). **Import**: Import from OBS… | `ConfigGrid` (2 columns at `lg`) |
| **Recording** | **Recording & storage**: Output directory + folder facts; Keep original recording; Keep microphone ready; Recording preset → Output and Stream destinations → Livestream rows; FFmpeg status; Advanced | `PageStack` |
| **Permissions** | **System access**: permission rows, Refresh, Set up permissions | `PageStack` |
| **Shortcuts** | **Global shortcuts**: the five action recorders, then Horizontal and Vertical layouts, and the Esc/⌫ hint. **App shortcuts** (renamed from "Shortcuts"): the in-app reference from `shortcutsByGroup()` | `ConfigGrid` |
| **Remote** | **Remote control** (Stream Deck), **Phone remote** | `ConfigGrid` |
| **Orcle** | **Orcle (alpha)**: `CohostSettingsSection`, unchanged | `PageStack` |
| **About** | **About & updates**: identity block, update control, What's new. **Support**: Export support bundle | `ConfigGrid` |

Two content decisions, both inside the brief:

- **Animate scene changes → General.** It is a studio behavior that shows
  live on stream and in recordings, not a storage setting. The owner
  approved this grouping in the session.
- **The App shortcuts reference drops its `Global · …` rows.** They were
  added (plan 062) so one list showed everything, but on the Shortcuts tab
  the recorders sit right next to it, so the rows would repeat the same
  binding twice on one screen. The card description becomes "Keys that work
  while Videorc is in front. Global shortcuts are on the left." Put the rows
  back only if the owner wants them.

## Design

### Tab model (new, pure): `renderer/src/lib/settings-tabs.ts`

```ts
export const SETTINGS_TABS = [
  { id: 'general', label: 'General' },
  { id: 'recording', label: 'Recording' },
  { id: 'permissions', label: 'Permissions' },
  { id: 'shortcuts', label: 'Shortcuts' },
  { id: 'remote', label: 'Remote' },
  { id: 'orcle', label: 'Orcle' },
  { id: 'about', label: 'About' }
] as const
export type SettingsTabId = (typeof SETTINGS_TABS)[number]['id']
export const DEFAULT_SETTINGS_TAB: SettingsTabId = 'general'
export function isSettingsTabId(value: unknown): value is SettingsTabId
export function readLastSettingsTab(storage?: Pick<Storage, 'getItem'>): SettingsTabId
export function writeLastSettingsTab(id: SettingsTabId, storage?: Pick<Storage, 'setItem'>): void
```

- Add `settingsTab: 'videorc.settingsTab'` to `STORAGE_KEYS` in
  `lib/capture.ts:454`.
- Wrap the read and the write in try/catch. A missing, unknown or throwing
  value falls back to `general`, and a failed write is ignored. The tab
  choice is a convenience and must never break Settings.
- Do not import any icons. This module ends up in the **eager** chunk
  because app-shell imports it, and the renderer eager asset budget is
  nearly full (see memory `videorc-renderer-budget-gzip-drift`, #389). Keep
  it to ids, labels and the two storage helpers.

### Who owns the selected tab: app-shell

The selected tab lives next to `active` in `app-shell.tsx` (line 153),
the same way `selectedSessionId` does for Publish:

- `const [settingsTab, setSettingsTab] = useState(readLastSettingsTab)`.
  A `selectSettingsTab(id)` sets it and calls `writeLastSettingsTab`.
- `WorkspaceNavValue` (`workspace-nav.tsx:115`) gains
  `openSettings: (tab?: SettingsTabId) => void`. With a tab, it selects that
  tab; either way it then calls `setActive('settings')`. With no argument, the
  last tab stays.
- `<SettingsTab tab={settingsTab} onTabChange={selectSettingsTab} … />`
  becomes controlled.
- Code outside React (the global-shortcut toast in `lib/global-shortcuts.ts`)
  opens a tab through a window event, following `videorc:open-publish`
  (app-shell line 208):
  `window.dispatchEvent(new CustomEvent('videorc:open-settings', { detail: { tab } }))`.
  App-shell listens for it and checks `detail.tab` with `isSettingsTabId`.

### Scrolling: Settings owns its scroll, like Library

The strip has to stay pinned. A sticky strip over the translucent glass
would need a second background coat, which the design language forbids
("exactly ONE element paints `--background`"). So Settings owns its scroll,
the way Library already does:

- `app-shell.tsx:341`: `scroll={active !== 'library' && active !== 'settings'}`.
- `SettingsTab` root: `Tabs` with `className="flex min-h-0 flex-1 flex-col gap-0"`.
  Inside it: the strip band (`shrink-0`), then one scroll region
  (`min-h-0 flex-1 overflow-y-auto overscroll-contain`,
  `data-slot="settings-scroll"`) that holds all seven `TabsContent`.
- When the tab changes, set the scroll region's `scrollTop` to 0 in the
  change handler, not in an effect (the repo is removing unneeded
  `useEffect`s, see memory `videorc-useeffect-elimination-plan`).
- Each `TabsTrigger` gets `data-videorc-settings-tab={id}` so probes and
  CDP runs can click it.

### File split (all of it stays in the lazy Settings chunk)

`settings-tab.tsx` becomes the shell: the strip, the scroll region, the
window-focus `refreshBackend` listener (kept at page level so behavior does
not change), and the seven `TabsContent`. Each panel moves to
`renderer/src/components/settings/`:

| File | Takes from today's `settings-tab.tsx` |
| --- | --- |
| `general-settings.tsx` | Appearance & behavior, `graphicsAccelerationDescription`, Import + `ObsImportDialog` state, the Animate scene changes field |
| `recording-settings.tsx` | Recording & storage (minus Animate), the directory-facts effect and `browseOutputDirectory`, `formatFreeSpace` |
| `permissions-settings.tsx` | System access, the `systemAccessRows` wiring |
| `shortcuts-settings.tsx` | `GLOBAL_ACTION_ROWS`, `GLOBAL_ACTION_LABELS`, `globalShortcutActionLabel`, the recorder wiring (`useSyncExternalStore` registration), App shortcuts |
| `remote-settings.tsx` | Remote control, `REMOTE_CONTROL_OFF_HINT`, `runRemoteAction`, and `PhoneRemoteSection` |
| `about-settings.tsx` | `AboutAndUpdates`, `UpdateControl`, Support |
| Orcle tab | Renders `CohostSettingsSection` directly; no new file |

Radix unmounts inactive `TabsContent`, so each panel mounts when you open
it. That is fine: the directory check re-runs with its 350 ms debounce, and
an **armed shortcut recorder already hands shortcuts back to main when it
unmounts** (`shortcut-recorder.tsx:126`, "Unmounting mid-capture (tab
switch) must hand global shortcuts back"). S4 verifies that path by hand.
Only `settings-tab.tsx` may import these files; importing them from an eager
module would pull them into the entry chunk.

## Slices

### S1: Tab model and navigation plumbing (`gpt-5.5`)

1. Add `lib/settings-tabs.ts` and `lib/settings-tabs.test.ts`: the ids in
   the order above; `isSettingsTabId`; `readLastSettingsTab` for a stored
   valid id, a missing value, a garbage value, and a `getItem` that throws;
   `writeLastSettingsTab` with a `setItem` that throws.
2. Add `STORAGE_KEYS.settingsTab`.
3. App-shell: add the `settingsTab` state, `selectSettingsTab`,
   `openSettings` on the `WorkspaceNavContext` value, and the
   `videorc:open-settings` listener. Pass `tab` and `onTabChange` to
   `SettingsTab`. For this slice, `SettingsTab` accepts the props and
   ignores them, so the page looks exactly the same.

**Done when:** `pnpm typecheck` and `pnpm --filter @videorc/desktop test`
pass, the new lib tests are green, and Settings looks exactly the same.

### S2: Tabbed Settings page (`opus-4.8`)

1. Split the panels into `components/settings/*` as described in the file
   split table. Move code without changing it, except for the three content
   edits: Animate → General, the reference card renamed "App shortcuts" and
   its `Global · …` rows dropped, and the new App shortcuts description.
2. Rewrite `SettingsTab` as the tab shell: controlled `Tabs`, the strip band
   copied from the Livestream page, the pinned scroll region, scroll-to-top
   on change, and `data-videorc-settings-tab` on each trigger. Use
   `ConfigGrid` or `PageStack` per tab as the contents table says. Remove
   the long "ONE grid, two continuous columns" comment, since tabs replace
   that layout.
3. `app-shell.tsx:341`: Settings owns its scroll.
4. Rewrite `components/tabs/settings-layout.test.ts`. The desktop vitest
   runs in `node` with no DOM, so keep the source-scanning style. It must
   assert:
   - the strip renders `SETTINGS_TABS` in order and nothing else;
   - each tab panel's section titles, in order, match the contents table;
   - every section title appears in **exactly one** panel (the one-home
     law), and `animate-scene-changes` is in `general-settings.tsx` and not
     in `recording-settings.tsx`;
   - app-shell turns PaneBody scroll off for `settings`, and the strip is
     outside `data-slot="settings-scroll"`;
   - no panel pins a fixed height (the existing rule, now checked across
     all panel files);
   - the Remote control off-state hint test stays, importing
     `REMOTE_CONTROL_OFF_HINT` from its new file.

   Delete the column-order and "ONE grid" tests. Tabs replace that layout.

**Done when:** typecheck, lint, format:check and the desktop tests pass;
`pnpm build` succeeds; and in the dev app every tab shows its sections, the
strip stays put while a long tab (Orcle, Shortcuts) scrolls, and ⌘, reopens
the last tab after a relaunch.

### S3: Every way into Settings lands on the right tab (`gpt-5.5`)

| Entry point | Today | After |
| --- | --- | --- |
| Sidebar update chip (`sidebar.tsx:291`) | `onSelect('settings')` | `openSettings('about')` |
| Account menu → Settings (`sidebar.tsx:302`) | `onSelect('settings')` | `openSettings()` (last tab) |
| ⌘, and ⌘K "Go to Settings" | open Settings | unchanged (last tab) |
| Studio "FFmpeg unavailable → Open Settings" (`studio-tab.tsx:387`, `SessionPanel` `blockedJump`) | top of Settings | Recording tab. Add an optional `settingsTab` to the banner and jump shape; `SessionPanel` calls `openSettings(settingsTab)` when `to === 'settings'` |
| Global-shortcut conflict toast (`lib/global-shortcuts.ts:130`) | description only | add a sonner action "Open Shortcuts" that dispatches `videorc:open-settings` with `shortcuts`; copy "… Pick different bindings in Settings → Shortcuts." |
| New ⌘K group "Settings" (`command-palette.tsx`, after "Setup") | none | one `CommandItem` per tab: label = tab label, `value="Settings ${label}"`, runs `openSettings(id)` |

Copy that names a place in Settings (use `→`, as the Kick copy already
does):

- `lib/cohost-view.ts:195`: "Orcle is off. Turn it on in Settings → Orcle."
- `lib/source-select-state.ts:13`: "No devices found. Check Settings →
  Permissions" (update `source-select-state.test.ts:18`).
- `hooks/use-studio.tsx:11722` and `:12767`: "… Choose it again in
  Settings → Recording."
- `permissions-onboarding-dialog.tsx:85-86`: "… later in Settings →
  Permissions."
- Code comments that say "Settings → About & updates", "Settings →
  Co-host" and similar: update them to the new tab names when you touch
  those files. Do not sweep untouched files just for comments.

Memory `videorc-studio-small-fixes-batch-plan` warns that copy sweeps break
case-sensitive test matchers. Run the full desktop suite after the copy
edits; `cohost-presence.test.ts:54` matches `'Orcle is off'`, which
survives.

**Done when:** the desktop tests pass, and in the dev app each entry point
in the table lands on its tab: the chip via a forced `downloaded` updater
state or a unit check of the handler; the FFmpeg banner via the existing
dev path or a unit check; the toast by binding two actions to the same keys;
the ⌘K items by hand.

### S4: Design pass, probes and gates (`opus-4.8`)

1. Extend `scripts/capture-ui-pages.mjs`. After `open-tab settings`, click
   each `[data-videorc-settings-tab=…]` through `eval-js` and capture
   `settings-<id>.png`. Shoot 1280×860 (the script default) and the
   narrowest window, 960 wide. Take one pass in light mode too.
2. By eye, per the design skill:
   - all seven triggers fit on one line at 960 px, with no clipping and no
     horizontal scroll (estimate ≈560 px of strip in ≈680 px of pane);
   - the active chip reads clearly in dark and in light;
   - the two-column tabs have no big empty areas; if General's right column
     (Import only) looks bare, fall back to `PageStack` for General and note
     it in the PR;
   - single-column tabs read well at 1440 px wide.
3. Recorder safety (by hand or CDP, matching plan 062's method): arm a
   recorder on the Shortcuts tab, click Remote, then press the recorded
   global shortcut (for example ⌘⇧R). The action must fire, which proves
   main is no longer swallowing keys.
4. Run the gates below and record the results in the PR.

**Done when:** screenshots are attached to the PR, the recorder check
passes, and every gate is green.

## Verification

Renderer-only UI, so no recording or native-preview smokes (AGENTS.md
gates those on capture, preview and output changes; none are touched):

```
pnpm typecheck && pnpm lint && pnpm format:check
pnpm --filter @videorc/desktop test
pnpm build
pnpm check:renderer-assets      # eager chunk budget; CI Linux is the gate
node scripts/capture-ui-pages.mjs
```

Use arm64 node for vitest and build (`PATH=/opt/homebrew/bin:$PATH`, see
memory `videogre-node-arch-arm64-gate`). Mac gzip reads about 1.6 KB higher
than CI, so if `check:renderer-assets` fails only on the Mac, CI decides. If
CI fails the budget, move `SETTINGS_TABS` labels out of the eager module (the
palette and the Settings shell are both lazy) and keep only the id guard and
storage helpers in app-shell's import graph.

## Risks

1. **Eager budget** (low to medium): S1 adds app-shell imports. Keep
   `settings-tabs.ts` tiny and icon-free, and follow the fallback above.
2. **Recorder armed during a tab switch** (low): already handled by the
   unmount disarm; S4 step 3 proves it.
3. **Scroll ownership change** (low): Settings becomes the second page that
   owns its scroll. Check that the Orcle tab's long form, Phone remote's QR
   and the What's new dialog still scroll and position correctly.
4. **Parallel sessions** (medium): other sessions edit `settings-tab.tsx`
   often (#445 recorder, #440 row padding, #402 Stream Manager, #397 About
   icon). Rebase right before S2. S2 is mostly moving code, so a conflict
   means re-applying the other change inside the new panel file, not
   merging line by line.

## Out of scope

- A search field in Settings (owner declined; ⌘K covers it).
- Editable in-app shortcuts; new settings; renamed persisted keys.
- Moving controls to or from other pages (Output, Livestream, Sources).
- A keyboard shortcut to cycle tabs (such as ⌃Tab). The arrow keys in the
  strip and ⌘K cover it; add one later only if the owner asks.
- Restyling the sections themselves beyond what the tab layout needs.
