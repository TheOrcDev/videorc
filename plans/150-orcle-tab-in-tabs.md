# Plan 150: The Orcle tab, reorganized into tabs like Settings

> Executor: implement the slices below in order, in one isolated worktree of
> current `origin/main`, on one branch, with one PR. Read `AGENTS.md`,
> `CLAUDE.md` and `.claude/skills/videorc-design/SKILL.md` first.
>
> Commit and push per slice. Run the gates once at the end, per the owner's
> rule. Planning authorizes no merge or release.

## Status and decisions

- **Status: EXECUTED, in review, 2026-10-04.** The owner said: "execute
  the entire plan and create a pr". Both ⚑ defaults stand: D1 (the five tab
  names) and D5 ("What Orcle does" as navigation rows).
  - **Built differently from the slices below, on purpose:**
    - S7: the Clean cut recording picker and Clean / Condensed stay enabled
      while Clean cut is unavailable. Cuts already made stay reviewable
      there; an existing test pins "still lets a finished cut be
      reviewed". The auto switch and "Make a clean cut" are disabled, under
      the one reason (D7).
    - D5: "What Orcle does" gains a fourth row, "Talk to Orcle", which
      leads to Voice.
    - D10: the report keeps a real stream title. It drops only the
      backend's auto name ("Session 2026-10-02 14:55"), which the picker
      already says.
    - D4 / S3: Cloud AI's switch label reads "Allow cloud AI", because the
      section is titled "Cloud AI".
    - S5: when Orcle Live is off, the Voice tab says so in an `Alert` with
      "Go to Live".
    - `CONFIG_GRID_PAIR` moved into `components/page.tsx` so both tabbed
      pages share it. Settings keeps its local copy.
- **The owner's ask:** "we need to reorganize completely this UI, it is very
  confusing and it's not looking good. try to use like in our settings tabs,
  and to organize data better."
  - Two screenshots came with it: the whole Orcle tab, top to bottom, on
    0.9.13x.
- **Route:** UI/Product Design owns it (fit 9). Model lane: `opus-4.8`
  (scoped UI restructure with high taste risk). Escalate to `fable-5` if the
  first by-eye check fails.
- **Branch:** `feat/150-orcle-tab-tabs`.

### What is wrong today (measured on `origin/main` `415c1288`)

`components/tabs/orcle-tab.tsx` stacks five unrelated things in one long
scroll. On a 2560 px window that is about 2,600 px of page:

1. **The intro line** "Live with you. Edits after.", with the emblem.
2. **Orcle Live** (one `PanelSection`), which holds too much:
   - the switch and its status;
   - the unlock alert and "Open Stream Manager";
   - a three-column marketing blurb ("Never miss a question / Chat stays
     safe / The room, handled");
   - **then the whole Voice commands block**, nested inside it
     (`OrcleVoiceCommands`):
     - a reference list of phrases;
     - per-platform removal readiness;
     - a footnote;
     - two settings in a grouped card;
     - another footnote.
3. **Last stream** (`OrcleReportCard`). Its title says "Last stream", the
   picker says "2 Oct, 14:55", and a heading below repeats "Session
   2026-10-02 14:55".
4. **Clean cut** (`CleanCutCard`), with:
   - a live-looking switch;
   - *then* an alert saying "Clean cut isn't set up on Videorc's side yet";
   - *then* a recording picker, a segmented control and a status row, all
     still enabled.
5. **Customize**, a collapsed `Collapsible` at the very bottom. Behind it sit
   Cloud AI consent, "Orcle hears you", reply tone, notes, chat rules, flag
   sensitivity and show on stream.

The problems that follow, as the owner saw them:

- **No structure.** Settings, a phrase reference, account status, history and
  a cut tool all share one scroll and one visual weight.
- **Settings are split three ways:**
  - two voice settings mid-page;
  - the auto clean cut switch mid-page;
  - everything else hidden under Customize at the bottom.
- **Full-width rows on wide windows.** On 2560 px, a phrase sits at the left
  edge and its meaning ("Puts it on stream.") at the right edge, about
  1,900 px apart.
- **Marketing copy on a working page.** The three-power blurb reads like a
  landing page.
- **Dead controls.** Clean cut shows an enabled switch, picker and segmented
  control while saying the service isn't set up.
- **Footnote soup.** Three `text-subtle` paragraphs in Voice commands carry
  rules a streamer needs: the 20 s timeout, the rate limit, and Premium
  versus free.

**How Settings does it** (`tabs/settings-tab.tsx`, `lib/settings-tabs.ts`,
plan 064):
- A segmented `TabsList` sits under the toolbar in a pinned strip
  (`border-b px-gutter py-2`).
- Only the panel under the strip scrolls. The shell turns `PaneBody` scroll
  off for Settings.
- The last tab used is remembered in `localStorage` and read safely.
- Deep links open a named tab (`openSettingsTab`), and ⌘K lists every tab.
- Each tab body is a `ConfigGrid`: two flush columns at `lg`, split by a
  hairline. The columns hold `PanelSection`s of `FieldGroup variant="grouped"`
  rows: label and description on the left, control on the right.

### The new shape

Five tabs in Settings' strip. Each tab answers one question:

| Tab | The question it answers | Left column | Right column |
| --- | --- | --- | --- |
| **Live** | Is Orcle on, and what can it use? | **Orcle Live**: emblem, status, switch, unlock, Stream Manager, "Orcle hears you" | **What Orcle does** (rows that link to their tab) and **Cloud AI** consent |
| **Chat** | How does Orcle reply and moderate? | **Replies**: tone, notes | **Moderation**: chat rules, flag sensitivity, show on stream |
| **Voice** | What can I say, and what can it remove? | **Commands**: what you can say, "Orcle" first, before removing | **Remove messages**: per platform, and the limits |
| **Reports** | What happened on my streams? | One column: picker, summary, then lists in a two-column grid | |
| **Clean cut** | Edit my recordings | **Clean cut**: auto switch, allowance, unlock | **Recordings**: picker, kind, status, actions |

The Live tab:

```
Orcle                                                     (toolbar)
[ Live | Chat | Voice | Reports | Clean cut ]             (pinned strip)
──────────────────────────────────────────────────────────────────────
ORCLE LIVE                          Alpha │ WHAT ORCLE DOES
┌─────┐ Orcle joins my streams    [ ●○ ] │ Never miss a question     Chat ›
│ eye │ ● On, joins your next stream     │ Chat stays safe           Chat ›
└─────┘                                  │ The room, handled         Chat ›
[🔒 Sign in to use Orcle Live…  Sign in] │ Voice commands           Voice ›
[ Open Stream Manager  ⇧⌘J ]             │──────────────────────────────────
┌──────────────────────────────────────┐ │ CLOUD AI
│ Orcle hears you while you're live [●]│ │ ┌──────────────────────────────┐
│ 12 of 60 min left this month         │ │ │ Cloud AI                [●○] │
└──────────────────────────────────────┘ │ │ • reads your live chat …     │
                                         │ └──────────────────────────────┘
```

The Voice tab:

```
[ Live | Chat | Voice | Reports | Clean cut ]
──────────────────────────────────────────────────────────────────────
COMMANDS                                 │ REMOVE MESSAGES
Ask Orcle out loud. It never acts alone. │ Orcle removes a comment only when
┌ What you can say ───────────────────┐  │ you tell it to. A removal waits
│ Highlight  "Orcle, highlight the…"  │  │ 20 s for your answer; at most 10
│            Puts it on stream.       │  │ a minute.
│ Clear      "Orcle, take it down"    │  │ ┌──────────────────────────────┐
│            Takes it off stream.     │  │ │ Twitch  OrcDev      ● Ready  │
│ …                                   │  │ │ Kick    OrcDev  [Reconnect]  │
└─────────────────────────────────────┘  │ │ X       OrcDev      ● Ready  │
┌─────────────────────────────────────┐  │ └──────────────────────────────┘
│ Commands need "Orcle" first    [●○] │  │ Premium. Remove from chat in a
│ Before Orcle removes a comment      │  │ comment's menu is free for all.
│ [ Confirm first | 5-second ]        │  │
└─────────────────────────────────────┘  │
```

### Decisions (the recommendation is taken; ⚑ = the owner may override)

1. **⚑ There are five tabs: Live · Chat · Voice · Reports · Clean cut.**
   They split along what the streamer is doing: turning it on, shaping
   replies, talking to it, looking back, editing recordings. Customize is
   gone: each of its settings moves into the tab it belongs to.
2. **The strip is Settings' strip, verbatim:**
   - the same `Tabs`/`TabsList` markup and classes;
   - pinned under the toolbar, with only the panel scrolling (the shell
     turns `PaneBody` scroll off for `ai`);
   - keyed by tab, so a tab change starts at the top;
   - the last tab remembered on this device (`STORAGE_KEYS.orcleTab`, read
     and written in try/catch);
   - Live is the first-run default.
3. **Deep links open the right tab:**
   - the Library's "Orcle report" opens **Reports** on that session;
   - the Library's "Clean cut" and the ready toast's Review open **Clean
     cut**.
   - ⌘9 opens Orcle on the last tab used.
   - ⌘K gains an **Orcle** group with one item per tab, like the Settings
     group.
4. **The intro line goes.** The toolbar names the page and the tabs say what
   is in it. The emblem moves into the Live tab's status block at 56 px
   (`size="lg"`). It is the one place the full emblem shows on the page, so
   the plan 149 mark keeps its home. The consent dialog keeps its emblem.
5. **⚑ "What Orcle does" becomes navigation, not marketing.** The three
   powers, plus "Voice commands", become one `GroupedList`, each row with
   its one-line description. A row's trailing link ("Chat ›", "Voice ›")
   opens the tab that holds its settings. The three-column blurb is
   deleted.
6. **"Orcle hears you" moves to Live,** under the switch. Listening is part
   of what turning Orcle on means. **Cloud AI** sits in Live's right column,
   so consent is on the same screen as the switch it gates. It is still its
   single home (plan 119 decision 3).
7. **Locked means disabled, with one reason.** When a feature is unavailable
   (signed out, Basic, or the service not set up), its controls render
   disabled, and one `Alert` above them says why, with one action. No
   enabled-looking switch or picker sits next to "isn't set up". This
   applies to Orcle Live, Chat, Voice and Clean cut alike.
8. **Rules become section descriptions, not footnotes.** These move into the
   Remove messages section's description:
   - the 20 s timeout;
   - the 10-a-minute cap;
   - the local hide when a platform can't remove;
   - Premium versus free.
   "Turn on Orcle Live to use voice commands" becomes the Voice tab's locked
   `Alert` (D7).
9. **Phrase rows stack, not spread.** In "What you can say", each row puts
   the command and its phrase on line one and its effect on line two
   (`ListRow` `context` under the title). The effect stays next to the
   phrase at any width. The two-column grid also caps each column at half
   the pane.
10. **Reports drop the duplicate heading.**
    - The section title is "Stream report".
    - The picker in its action slot names the stream ("2 Oct, 14:55").
    - The summary line follows: duration · messages · per-platform counts.
    - The lists sit in a two-column grid at `lg`: missed questions and open
      promises on the left, moments and alerts on the right. An empty list
      is omitted.
    - A designed empty state covers no reports at all: "No stream reports
      yet. Orcle saves one after each stream it joins."
11. **A Clean cut review opens inside the Clean cut tab.**
    - The strip stays visible, and the review's own Back returns to the
      tab.
    - Switching tabs keeps the review open, and coming back shows it again.
    - It stays lazy-loaded, as today.
12. **No behaviour changes.** Every setting, RPC, consent flow and copy
    string keeps its meaning. This plan only moves and restyles. Copy edits
    are limited to section titles and descriptions, plus the merged
    footnotes.

## Slices

**S1: tab ids, the remembered tab and the shell.**
- Add `lib/orcle-tabs.ts`, mirroring `lib/settings-tabs.ts`:
  - `ORCLE_TABS` (`live`, `chat`, `voice`, `reports`, `clean-cut`);
  - `isOrcleTabId`, `readLastOrcleTab` and `writeLastOrcleTab`;
  - `openOrcleTab(tab)` on the existing `videorc:navigate-workspace` event.
- Add `STORAGE_KEYS.orcleTab`.
- In `app-shell.tsx`:
  - hold the Orcle tab state like `settingsTab`;
  - `PaneBody scroll={active !== 'library' && active !== 'settings' && active !== 'ai'}`;
  - `openOrcleReport` selects `reports`, and the clean-cut request selects
    `clean-cut`.
- Add `lib/orcle-tabs.test.ts`, mirroring `settings-tabs.test.ts`: storage
  that is missing, unknown or throwing; and the event detail.
- *Done when:* the tests pass and the app behaves as before, because the
  shell is not used yet.

**S2: the strip, with today's content moved in unchanged.**
- `OrcleTab` renders Settings' strip and five `TabsContent` panels inside a
  keyed scroll region, the same markup as `SettingsTab`.
- Move today's blocks into their panels **without restyling**:
  - Orcle Live section → Live;
  - `OrcleVoiceCommands` → Voice;
  - `OrcleReportCard` → Reports;
  - `CleanCutCard` and its review → Clean cut;
  - `CloudAiSection` → Live;
  - `CohostSettingsSection` → Chat.
- Delete `OrcleCustomize` and the intro `PageHeader`.
- Rewrite `tabs/orcle-tab.test.ts` around the tabs:
  - every existing assertion still holds, in the tab that now holds it;
  - add: the strip lists five tabs, the remembered tab opens, a report
    request lands on Reports, and a clean-cut request lands on Clean cut.
- Update `scripts/capture-ui-pages.mjs`: it still finds `#orcle-live-switch`
  on Live.
- *Done when:* the tests pass and every control is reachable in exactly one
  tab.

**S3: the Live tab.**
- The body is a `ConfigGrid`.
- **Left, "Orcle Live"** (`Alpha` badge in the action slot):
  - a status block: the emblem `lg` beside the "Orcle joins my streams"
    label and status line, with the switch on the right;
  - then the unlock `Alert` (D7: the switch is disabled while locked);
  - then "Open Stream Manager ⇧⌘J" while live;
  - then the "Orcle hears you while you're live" grouped row and its
    allowance, moved out of `CohostSettingsSection` (D6).
- **Right:**
  - "What Orcle does": a `GroupedList` of four `ListRow`s. Each row has a
    title, a one-line context, and a trailing ghost button that calls
    `onSelectTab` (D5).
  - "Cloud AI": the existing switch and its uses/keeps copy, as one grouped
    row.
- Keep `ORCLE_LIVE_POWERS`, adding a `tab` field per power. Delete the
  three-column `ul`.
- *Done when:* the Live tests cover the status block, the locked disabled
  switch, and each power row opening its tab. By eye, there is no row wider
  than its column.

**S4: the Chat tab.**
- Split `CohostSettingsSection` into `OrcleRepliesSection` (reply tone, Orcle
  notes) and `OrcleModerationSection` (chat rules, flag sensitivity, show on
  stream automatically), in one `ConfigGrid`.
- The save, draft and error logic stays as it is. If both sections need it,
  extract a small shared hook rather than duplicating it.
- When Orcle is locked, show one `Alert` above both columns, and every field
  is disabled (D7).
- *Done when:* the `cohost-settings-section` tests (moved or renamed) pass,
  and nothing about saving changes.

**S5: the Voice tab.**
- Split `OrcleVoiceCommands` into two sections:
  - **"Commands"**:
    - the description "Ask Orcle out loud. It never acts on its own.";
    - "What you can say", with stacked rows (D9);
    - the grouped settings: "Orcle" first, before removing.
  - **"Remove messages"**:
    - the merged rules as its description (D8);
    - the per-platform `GroupedList` with Reconnect actions;
    - the empty state "Connect YouTube, Twitch, Kick or X under Livestream".
- Locked (Orcle Live off or not Premium) becomes one `Alert` with the reason,
  and the settings are disabled.
- Remove the three `text-subtle` footnotes.
- *Done when:* the voice-command tests in `orcle-tab.test.ts` pass in the
  Voice tab. They cover the phrases, removal per account, the wake word and
  confirm mode saves, the countdown line, paused, and no platforms.

**S6: the Reports tab.**
- `OrcleReportCard` becomes the tab body (D10):
  - the title "Stream report", with the picker as its action;
  - the "Session …" heading deleted;
  - the summary line;
  - the "Orcle was off" note;
  - the lists in a two-column grid at `lg`;
  - the empty state.
- *Done when:* the `orcle-report-card` tests pass with the new heading, and
  there is an empty-state test.

**S7: the Clean cut tab.**
- Split `CleanCutCard` into two `ConfigGrid` columns:
  - **"Clean cut"**: the auto switch, the minutes badge, the unlock or
    service `Alert` (D7: with the service unavailable, the switch, picker,
    kind control and "Make a clean cut" are disabled);
  - **"Recordings"**: the picker, Clean / Condensed, the condensed length,
    the status row and actions.
- The review renders inside this panel (D11).
- *Done when:* the `clean-cut-card` and `clean-cut-review` tests pass, and a
  new test asserts that every control is disabled while the service is
  unavailable.

**S8: ⌘K, docs and captures.**
- ⌘K gets an "Orcle" group, mapping `ORCLE_TABS` like the Settings group.
- Add one paragraph to the design skill, under the Settings tab rule: the
  Orcle tab uses the same strip and its five tabs, and locked means
  disabled with one reason.
- Add the plan entry to `plans/README.md`.
- `capture-ui-pages`: capture all five Orcle tabs.
- *Done when:* the diff is reviewed.

## Edge cases

- **Narrow windows (below `lg`):** each `ConfigGrid` stacks with a hairline,
  as Settings does. The strip's five labels fit at the app's minimum width.
  The strip clips like Settings' if needed; check at the minimum width.
- **Live and the tab memory:** if Orcle is live and the remembered tab is
  Reports, the tab still opens on Reports. The sidebar status and the Stream
  Manager say live, and Live is one click away. Do not auto-switch tabs.
- **A Clean cut review open while another deep link arrives:** a report link
  switches to Reports and leaves the review state in Clean cut.
- **A remembered `clean-cut` while Clean cut is unavailable:** the tab still
  opens and shows the locked `Alert` (D7). It never redirects.
- **The consent dialog** stays mounted outside the tabs, so turning Orcle
  Live on from any tab can still ask.

## Out of scope

- The Stream Manager's Orcle pane, the status popover and the Studio session
  row.
- Any change to what Orcle does, its settings model, RPCs or Premium gating.
- New settings. The copy beyond section titles and descriptions (D12).

## Verification gates

- `pnpm typecheck`, `pnpm lint` and `pnpm format:check`.
- `pnpm --filter @videorc/desktop test`.
- `pnpm build` and `pnpm check:renderer-assets`. The Orcle tab is lazy, so
  only `lib/orcle-tabs.ts` should join the eager chunk, like
  `settings-tabs.ts`.
- `node scripts/capture-ui-pages.mjs`: all five Orcle tabs capture.
- **By eye** (the `run` route, isolated data):
  - each tab in dark and light;
  - at the minimum window width, about 1280 px and 2560 px;
  - signed out, Basic and Premium for the locked states.
- No Rust, recording or native-preview gates: nothing in those paths changes.

## Owner actions

1. ⚑ D1: the tab names and order (Live · Chat · Voice · Reports · Clean
   cut).
2. ⚑ D5: keep "What Orcle does" as navigation rows, or drop it entirely.
3. By eye on the PR captures.

## Handoff (cold start)

- **Goal:** the Orcle tab becomes a five-tab page built exactly like
  Settings. Every setting has one home, locked means disabled with one
  reason, and nothing about Orcle's behaviour changes.
- **Files:**
  - `components/tabs/orcle-tab.tsx` and its test;
  - `components/orcle-voice-commands.tsx`;
  - `components/cohost-settings-section.tsx`;
  - `components/orcle-report-card.tsx`;
  - `components/clean-cut/clean-cut-card.tsx`;
  - `components/app-shell.tsx`;
  - `components/command-palette.tsx`;
  - `lib/orcle-tabs.ts` (new) and `lib/orcle-tab-view.ts`;
  - `lib/capture.ts` (`STORAGE_KEYS`);
  - `scripts/capture-ui-pages.mjs`.
- **Patterns to copy:** `tabs/settings-tab.tsx`, `lib/settings-tabs.ts`,
  `components/page.tsx` (`ConfigGrid`), and
  `components/settings/general-settings.tsx` (grouped rows).
- **Order:** S1 → S8, then the gates. S2 is the safety net: everything moves
  before anything is restyled.
