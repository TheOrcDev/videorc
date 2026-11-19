# Plan 250: A notification center

The owner's ask (2026-11-18): toasts are killing them during livestreams.
Many are about things like memory pressure or the microphone. They want a
proper notifications bell with an unread count beside it. Opening it shows a
dropdown where each notification can be acted on or cleared. "Take action"
means going to where the problem is handled: a microphone problem opens the
microphone controls.

Facts are read from `origin/main` `fe53fde02` (2026-11-18).

## Status and scope

- **Status: BUILT 2026-11-19, in review.** The owner took every
  recommendation: D1 to D13 are answered "a". For D12 no ceiling is raised:
  PR #1512 (the minified renderer) merged first, so the bell fits. The ten
  slices are ten commits in one PR, with one more commit for what the
  by-eye pass found and one for a first-run fix the smokes found. "What was
  built" below says what the 317 became and where the build differs from
  this plan.
- **In scope:** the desktop renderer (the bell, the list, the store, routing
  today's toasts through it), a small main-process relay for the Stream
  Manager, and two small backend additions (clear signals, and the open
  conditions on reconnect).
- **Out of scope:** the phone remote, Stream Deck, the MCP tools and the
  /live page (their allowlists do not change), system notification rules
  (plan 223 owns them), Sidekick's own nudges (D11), and the Rust UI
  (`videorc-rust`), which gets its own pass later.
- **Number:** 250 is the next free number. 248 is unused and 249 (cloud
  parity) lives in other worktrees. If another plan takes 250 first, rename
  this file.

## What was built

Recorded 2026-11-19, from branch `feat/notification-center`.

**What the 317 became.** The inventory script (same script, same rules)
counts 228 direct toast call sites where it counted 304; the 13 sites
reached through an alias are down to 7.

- 57 `publish` sites in `lib/notifications/sources/*` and
  `lib/session-runtime-recovery.ts` replace the unprompted toasts, over 44
  kinds in `lib/notifications/kinds.ts`.
- No unprompted toast is left outside the store, except the six this plan
  keeps (D11): Sidekick's three nudges and the "Remove this message?"
  question with its two outcomes.
- Three toasts still set `duration: Infinity`, and the guard names them:
  the removal question, "Couldn't start", and the browser step of a
  connection. Every other pinned toast is gone.
- `showBackendError` (`reportError`) stays a toast: it answers the action
  that failed. The backend's own `error` event is the entry "Videorc hit a
  problem".

**Where the build differs from the plan.**

- **Urgent kinds.** Five kinds are urgent on their own (`stream-output`,
  `stream-output-failed`, `recording-output-failed`, `recording-failed`,
  `audio-output-failed`), and six may become urgent from a report
  (`microphone`, `screen-capture`, `stream-target`, `x-playback`,
  `backend`, `watchdog`). `lib/notifications/kinds.test.ts` pins both lists.
- **A full disk** (`recording-disk-full`) and the take that failed on it
  are one entry, in Videorc's own words: the backend's line ends in an
  FFmpeg exit code.
- **A session that ended is not a recovery.** Its open problems resolve
  with a gray icon, never the green tick, and no recovery toast. The same
  subject in the next session is a new problem, even inside the 60 s flap
  window.
- **Repeat words lead the detail** ("3 times. …"), so the two-line clamp
  never hides them.
- **The Stream Manager's list is its own relay**, not the live dashboard:
  four invoke channels and three events in `shared/notifications-relay.ts`,
  each with a strict schema, a row in the renderer security policy and in
  the preload allowlist. The dashboard carries only what the phone remote
  may see.
- **Low recording space** is sent again each time it gets worse (five
  minutes left, then the last minute), not only at Record.
- **The rebuild on reconnect** replays the last word on each subject, so a
  problem that cleared during the gap also resolves.
- **`go-live-step`, `cloud-announce` and `cloud-controller`** pop up
  although they are news: the first two would otherwise never be seen, and
  the third answers Continue here.

**Seen by eye** (dev app, isolated profile, dark and light): the bell's
four states, the list live, idle, long and empty, the urgent pop-up, a
prompted toast over the open list, the Settings section, seven doors
landing on their section with focus inside, and the Stream Manager's bell
and list at 1,040, 800, 640 and 520 px. The pass found three bugs unit
tests had missed (the list marking itself read on open, a door that did not
scroll, the Stream Manager's bell stuck at zero); each has a test now.

**One fix outside the plan.** `pnpm smoke:first-run` picks a layout and a
background 2 ms apart. Setup applied a look one tick after its press, so
the second press rebuilt the look from the layout still drawn and undid the
first. The look's helpers are now kept once loaded
(`lib/first-run-look-door.ts`) and a choice is applied inside its own
press. `origin/main` has the same race (its third setup profile fails 4
runs of 4).

**Still red on `origin/main` and here:** in that third profile the smoke
presses a layout the moment setup's performance check ends, the backend
refuses the idle scene reload ("superseded by session startup") and setup
shows "Videorc hit a problem". Not part of this plan.

**Not seen or run:** an urgent pop-up inside the Stream Manager (it shows
there only while that window is focused, which a background run cannot
do; unit-tested), VoiceOver, Increase Contrast and Reduce Motion, Windows,
the Videorc Cloud door (the cloud is off on a test profile), and a real
stream.

## The short version

Videorc shows 317 toast call sites today. 212 answer something the streamer
just did ("Couldn't import the image"). They are fine and stay toasts. The
other 97 are Videorc speaking up on its own, mostly from backend events
while a stream runs. Those are the ones that pile up, and three things make
them worse:

1. **The same problem toasts from two systems.** A silent microphone raises
   a `health` event toast ("Microphone is silent",
   `lib/session-runtime-recovery.ts:521`) and a watchdog alert toast
   (`lib/watchdog-surface.ts:150`, check `mic-silent`). A dropped destination
   raises a `stream.targets` toast and the watchdog's `destination-down`.
   The connection raises `stream-bitrate-floor` and the watchdog's
   `bitrate-floor`.
2. **Bad news is pinned, and good news is another toast.** About a third
   of the 97 stay until closed. Each recovery ("Microphone is back", "Your
   stream is smooth again") is a second toast.
3. **Nothing remembers.** A toast that timed out is gone, so toasts are made
   long and loud to be safe.

The plan:

- **One list behind a bell.** Everything Videorc notices on its own becomes
  an entry in Notifications. One entry per subject (the microphone, one
  destination, the connection), updated in place, whichever system reported
  it. A problem that clears marks its entry Resolved. Nothing stacks.
- **Quiet while recording or live.** On by default. Only an urgent problem
  (viewers or the recording are affected right now) pops up, once, for 15 s.
  Everything else only raises the number on the bell.
- **Every entry has its way out.** One button that fixes it (Unmute, Resume,
  Retry, Use it) or opens the page where it is fixed, and a way to clear it.
- **Answers stay toasts.** A toast is only ever the answer to something you
  just did, or one urgent problem. No toast is pinned.

## What it looks like

### Where the bell lives

The toolbar holds only the page title (owner, 2026-09-23), so the bell
cannot go there. Four homes were considered:

| | Home | For | Against |
| --- | --- | --- | --- |
| **A (recommended)** | The right end of the status bar, in the main window and in the Stream Manager | The status bar is already the home of global state (`StatusBarSessionState` opens Health, design skill: "Global state and hints: StatusBar"). It is the corner where toasts land today (`windowToasterOffset`, `components/window-providers.tsx:33`), so news keeps arriving in the same place. One rule for both windows. A desktop habit (VS Code and JetBrains keep their bell there) | The bar is quiet by design: a 20 px action with 11 px text. The count and the icon's tone must carry it |
| B | The sidebar's account row, between the account menu and the theme toggle (`components/sidebar.tsx:411–426`) | A 28 px button with a count chip: the most visible. The row already holds one icon button | The sidebar is 208 px: the account name truncates sooner. The Stream Manager has no sidebar, so it would need a second home anyway. Toasts and the bell would sit in opposite corners |
| C | The sidebar's top row, beside Search (`components/sidebar.tsx:341`) | Top of the window, always in sight | It is the window's drag band beside the traffic lights: a corner button in all but name, which the owner already rejected for the toolbar |
| D | The Studio inspector's header, above Record | Next to the session it mostly talks about | Studio only. A problem raised while you are on Destinations would have no bell |

A in the main window, live, with two unread entries and a problem open:

```
┌────────────┬─────────────────────────────────────────────────────────────────────┐
│ ● ● ●    ⌕ │ Studio                                                              │
│ ▓ Studio ● │                                                                     │
│ SETUP      │                                                  ┌────────────────┐ │
│   Sources  │                    (the page)                    │ End livestream │ │
│   Scene    │                                                  │ …              │ │
│   …        │                                                  └────────────────┘ │
│   Settings ├─────────────────────────────────────────────────────────────────────┤
│ ◐ Orc ▾  ☾ │ ● On air 12:04 · Rec      ⌘K Search  ⌘P Preview  ⇧⌘J Stream Manager  🔔 2│
└────────────┴─────────────────────────────────────────────────────────────────────┘
                                                                      the bell ──┘
```

B, for comparison: the bell in the sidebar's account row.

```
│   Settings     │
├────────────────┤
│ ◐ Orc ▾  🔔2 ☾ │
└────────────────┘
```

The bell's four states (the glyph is one `NotificationsIcon`, 14 px):

```
  🔔       nothing unread, nothing open     tertiary, like the hints beside it
  🔔 2     2 unread                         the number in primary text
  🔔 2     a warning is open                the icon in the warning tone (amber)
  🔔 2     an urgent problem is open        the icon in the live tone (red)
```

- The tone is on the icon only. The number is never coloured (design skill:
  colour is information, and a status word is never coloured).
- The tone stays while a problem is open, even with nothing unread, so a
  glance says "something is still wrong".
- The bell's name for a screen reader is "Notifications, 2 unread, 1 urgent".
- Tooltip: "Notifications" with its shortcut, through `ShortcutTooltip`.

### The dropdown

A shadcn `Popover` on the popup tier (`border glass-float`, 10 px radius),
opening upward from the bell, right-aligned, 380 px wide, never taller than
the window less 80 px. Its body is a `ScrollArea`.

Live, with problems open:

```
                                  ┌──────────────────────────────────────────────┐
                                  │ Notifications                     Clear all  │
                                  ├──────────────────────────────────────────────┤
                                  │ NOW                                          │
                                  │ ⊗ Microphone is silent                  0:40 │
                                  │   No sound for 40 s. Viewers hear nothing.   │
                                  │   [ Unmute ]  Open Audio                   ✕ │
                                  │ ──────────────────────────────────────────── │
                                  │ ⚠ Twitch is reconnecting               2 min │
                                  │   The other 2 destinations keep streaming.   │
                                  │   [ Open Destinations ]                    ✕ │
                                  │ ──────────────────────────────────────────── │
                                  │ ⚠ This computer is overloaded          6 min │
                                  │   A load of 42 on 10 cores. Close heavy      │
                                  │   apps or pause background work.           ✕ │
                                  │ EARLIER                                      │
                                  │ ✓ Your stream is smooth again          12:01 │
                                  │   It was choppy for 38 s.                  ✕ │
                                  │ ──────────────────────────────────────────── │
                                  │ ⓘ Microphone silenced for a moment     11:52 │
                                  │   3 times.                                 ✕ │
                                  ├──────────────────────────────────────────────┤
                                  │ Quiet while recording or live.      Settings │
                                  └──────────────────────────────────────────────┘
                                  … ⇧⌘J Stream Manager  [🔔 2]
```

Idle, with finished work:

```
┌──────────────────────────────────────────────┐
│ Notifications                     Clear all  │
├──────────────────────────────────────────────┤
│ ✓ MP4 ready                            2 min │
│   Friday stream.mp4                          │
│   [ Show in Finder ]                       ✕ │
│ ──────────────────────────────────────────── │
│ ✓ Recording saved                     14 min │
│   [ Play ]  Open in Library                ✕ │
│ ──────────────────────────────────────────── │
│ ⚠ Thumbnail not set on YouTube        15 min │
│   YouTube refused the image.                 │
│   [ Retry ]                                ✕ │
└──────────────────────────────────────────────┘
```

Empty:

```
┌──────────────────────────────────────────────┐
│ Notifications                                │
├──────────────────────────────────────────────┤
│                                              │
│              No notifications                │
│   Problems and finished work show up here.   │
│                                              │
└──────────────────────────────────────────────┘
```

**The header.** "Notifications" (14 px / 600) and one ghost `xs` button,
"Clear all", shown only when there is something to clear.

**Groups.** "Now" holds what is still true: open problems, urgent first,
then warnings, then work in progress. "Earlier" holds the rest, newest
first: resolved problems, finished work and news. Each label is a
`SectionLabel`. A group with nothing in it is not drawn, and with only
"Earlier" entries its label is not drawn either.

**One entry.** Rows are flush and split by hairlines, never cards.

```
 ┌ icon 16 px, in the entry's tone
 │   ┌ title, 14 px / 500, primary, one line          ┌ time, 12 px, secondary, tabular
 ⚠ Twitch is reconnecting                        2 min
   The other 2 destinations keep streaming.           ← detail, 12 px, secondary, up to 2 lines
   [ Open Destinations ]  Second action           ✕   ← one primary, at most one more, then Clear
```

- **Icon:** `ErrorIcon` in the live tone for urgent, `WarningIcon` in the
  warning tone, `InfoIcon` in secondary gray for news, `SuccessIcon` in the
  success tone for resolved and finished, `Spinner` for work in progress.
  Nothing else in the row is tinted (the owner's toast rule carries over:
  the type colours the icon only).
- **Title and detail:** the words today's toasts use, by the rules of
  `docs/ui-copy.md` (the title is the outcome with no period, the detail is
  whole sentences). A resolved entry takes the recovery's title ("Your
  stream is smooth again") and says how long it lasted.
- **Time:** an open problem shows how long it has been open ("0:40", then
  "2 min", `formatRelativeTime`). Everything else shows when it happened.
- **Actions:** `Button` `xs`. The first is `default`; a second is `ghost`.
  Never more than two. An entry with nothing to do (the computer is
  overloaded) has none.
- **Clear:** a ghost `icon-xs` button with `CloseIcon`, named "Clear {title}".
  It shows on hover and on focus, like `KebabMenu`'s `reveal="hover"`.
- **A repeat** updates its entry and says so in the detail ("3 times"). It
  never adds a second row.
- **Unread** entries carry a 6 px `StatusDot` before the time. Opening the
  list marks everything in it read when it closes.

**The footer.** One line that says what the quiet rule is doing ("Quiet
while recording or live.") and a link-style `xs` button, "Settings", that
opens Settings → General at the switch (D4). The switch itself has one home.

**Keyboard.**

- ⇧⌘B (Ctrl+Shift+B on Windows and Linux) opens and closes the list from
  anywhere in the window (D10). It joins `SHORTCUT_LIST` (`lib/shortcuts.ts`),
  so Settings → Shortcuts and ⌘K list it. ⌘K gains "Open notifications".
- The bell is in the status bar's tab order.
- Open: focus lands on the first entry. ↑ and ↓ move between entries (one
  tab stop, roving). ↵ runs the entry's first action. ⌫ or Delete clears it.
  Tab walks the buttons inside the entry. Esc closes and returns focus to
  the bell.
- A new urgent entry is announced through a visually hidden `role="alert"`
  line beside the bell; everything else through a `role="status"` line. The
  status bar already announces the session state this way.

**Light and dark.** Nothing new to design: the popup tier, hairlines, the
three text tiers and the tone utilities already have both columns. To check
by eye in both: the amber and red bell against the status bar's ground, the
unread dot, and the `default` `xs` button (silver in dark, black chrome in
light) inside the popup.

**Retro LCD.** The status bar and the popover are not part of the LCD
Studio. Nothing changes there.

### The Stream Manager

While live, the Stream Manager is the window in front. Its status bar
(`components/stream-manager/stream-manager-status-bar.tsx`, 32 px) gets the
same bell as its last control: an icon and a number in a 22 px chip. Its
dropdown is the same list. Below 640 px the bell folds into the bar's ⋯ menu
as "Notifications (2)", like every other control there.

## How it behaves

### What becomes a notification

The rule is who started it.

- **You did something, and this is its answer:** a toast, as today, in the
  window you did it in. "Couldn't import the image", "Clips are off",
  "Removing {name}'s message · Undo". 212 call sites; they do not change.
- **Videorc noticed something on its own:** a notification. It becomes an
  entry in the list, and the rules below decide whether it also pops up.
  97 call sites; the plan moves 91 of them (D11 keeps 6).

A few notifications are the late answer to a press (a clip saved by a
hotkey, a step of Go Live that failed a few seconds in). They are entries
and they still pop up, briefly, because the streamer is waiting for them.
Each kind says so in the registry (`answersAPress`); the inventory marks
them.

### Four tones

| Tone | Means | Icon | Examples |
| --- | --- | --- | --- |
| **Urgent** | Viewers or the recording are affected right now | `ErrorIcon`, live tone | Your stream stopped. Your stream is frozen. Microphone lost. Recording stopped. The only destination on air dropped. Videorc needs a restart. Any watchdog alert with severity `critical` |
| **Warning** | Degraded, or it needs you soon | `WarningIcon`, warning tone | Twitch is reconnecting (others still on air). Your stream is choppy. This computer is overloaded. Recording space is low. Thumbnail not set |
| **News** | Worth knowing, nothing to do | `InfoIcon`, gray | Microphone silenced for a moment. Stream output adjusted. "Claude Desktop ended the livestream" |
| **Done** | Work finished out of view, or a problem that cleared | `SuccessIcon`, success tone | Recording saved. MP4 ready. Your stream is smooth again |

The urgent list is short on purpose and is written down in one table
(`lib/notifications/kinds.ts`): a new urgent kind is a decision, not a
default.

### Three kinds of life

- **A condition** is true for a while: it opens, may update, and resolves
  on its own when the backend says it cleared. "Your stream is choppy" →
  "Your stream is smooth again".
- **An event** happened once: "Recording saved", "X ended your broadcast".
  It stays until cleared.
- **Work in progress** runs, then becomes done or failed: an MP4 export →
  "MP4 ready".

### One entry per subject

Each entry has a key that names its subject, not its message. A second
report about the same subject updates the entry in place, whichever system
sent it.

| Subject key | Reports that land on it today |
| --- | --- |
| `microphone` | `health`: `mic-silent`, `microphone-input-lost`, `microphone-timeline-lost`, `microphone-silent` and their three `-recovered` codes. Watchdog: `mic-muted`, `mic-silent`, `no-voice` |
| `stream-target:<id>` | `stream.targets` state changes. Watchdog: `destination-down` |
| `stream-uplink` | `health`: `stream-leg-overflow`, `stream-bitrate-lowered`, `stream-bitrate-floor`, `stream-bitrate-restored`. Watchdog: `bitrate-floor` |
| `stream-output` | `health`: `stream-output-failed`, `-stalled`, `-resumed`. Watchdog: `picture-stopped` |
| `stream-delivery` | `health`: `stream-delivery-degraded`, `-recovered` |
| `screen-capture` | `health`: `screen-capture-stopped`, `-restored`, `screen-window-out-of-sight`, `screen-window-back` |
| `cloud-status` | `cloud.status` changes (fallback, lost, restarted, cap). Watchdog: `program-unreported`, `contribution-missing` |

- When the watchdog has an alert open on a subject, its words and its fixes
  lead the entry: it has the live clock ("No sound for 40 s") and the
  one-press fix. The other system's report only keeps the entry open.
- The worse tone wins. A warning that becomes urgent is one entry that
  changed, and that change may pop up (below).
- An entry resolves when every report on it has cleared.

So a silent microphone is one row, "Microphone is silent · No sound for
40 s · Unmute", where today it is up to three toasts.

### What pops up

"Pops up" means a toast in the window you are in. It is the same entry: a
toast you close by hand, or whose button you press, marks its entry read.
One that times out leaves it unread behind the bell. So nothing is lost
when a toast goes, and no toast needs to be pinned any more.

| | Idle | Recording or live, quiet on (the default) | Quiet off |
| --- | --- | --- | --- |
| Urgent | Toast, 15 s | **Toast, 15 s, once** | Toast, 15 s |
| Warning | Toast, 8 s | Bell only | Toast, 8 s |
| Done | Toast, 8 s | Bell only | Toast, 8 s |
| News | Bell only | Bell only | Bell only |
| The late answer to a press | Toast, 4 to 8 s | Toast, 4 to 8 s | Toast, 4 to 8 s |

- **Once** means once per episode. An update to an open entry never pops up
  again. The same subject pops up again only when it gets worse (warning →
  urgent), or when it comes back after at least 5 minutes of being fine.
- **Nothing pops up while the list is open.** It appears in the list.
- **Recoveries never pop up.** "Microphone is back" resolves the entry and,
  if its toast is still showing, replaces it for 4 s.
- **A resolved problem takes its toast with it.** No toast outlives the
  problem it reports.
- "Recording or live" is what the shell already calls `live`
  (`sessionOwnsTransport(recording)`, `components/app-shell.tsx:573`): a
  recording, a livestream, or both. The Clips buffer alone is not one.
- The system notification the watchdog asks main for when the Studio is not
  in front (plan 223 D2, D3; `main/watchdog-notify.ts`) does not change. It
  is the operating system's banner, with its own switch in Destinations.

### What the number counts

The number is what waits for you: **unread urgent and warning entries, and
unread finished work.**

- News never adds to it.
- A warning that cleared on its own before you looked stops counting. It
  stays in the list as Resolved.
- An urgent problem that cleared keeps counting until you have seen it: you
  should know the stream dropped.
- Opening the list marks everything in it read when it closes.
- Above 9 the bell says "9+".

### Flapping

- A condition that clears and comes back within 60 s is the same episode:
  one entry, still open, with "Came back 3 times." in its detail. It does
  not become unread again and it does not pop up again.
- Short blips with no open state ("Microphone silenced for a moment",
  "Audio dropped for a moment") are one News entry per session with a
  count ("3 times"), and the time of the last one.

### When the session ends

- Conditions that belong to the session resolve ("Ended with the
  livestream."). They stay under Earlier, so the list reads as what
  happened during the stream.
- Quiet ends with the session. Nothing that waited pops up afterwards: the
  number on the bell is the summary.

### Clearing

- **Clear** on a finished or resolved entry removes it.
- **Clear** on an open problem means "I know": the entry goes, and the
  bell's tone drops if nothing else is open. It comes back only if the
  problem gets worse, or ends and starts again. For a watchdog alert, Clear
  is its Got it (`watchdog.alert.acknowledge`), so the Session panel's card
  says Seen and the system notification's second ask is dropped.
- **Clear all** removes everything under Earlier. Open problems stay: an
  urgent problem cannot be swept away by accident. With only open problems
  listed, the button is not shown.

### How long it keeps things

- The list keeps the newest 50 entries. Open problems are never dropped;
  the oldest Earlier entries go first.
- The list lives for this run of the app (D8). On a relaunch or a reload
  mid-session it is rebuilt from what is still true: the watchdog's open
  alerts (`watchdog.alerts.list`), each destination's state
  (`stream.targets`), the cloud status, and the session's open conditions
  (slice S9).

### What stays where it is

- **The Session panel's watchdog cards** (`components/studio/watchdog-alert-card.tsx`)
  and the inline session alert (`components/studio/session-runtime-alert.tsx`)
  stay (D7). They are state on the Studio page, not pop-ups. Only their
  toasts go through the rules above.
- **The Stream Manager's health chip** and its hover card (plan 223 A6) stay.
- **Health** stays the place for checks, logs and the support bundle. An
  entry Videorc cannot explain offers "Open Health".
- **Sidekick's nudges** and the "Remove this message?" question stay toasts
  in their windows (D11).

## Decisions for the owner

Each has a recommendation. "Start" with no answers means the recommended
ones.

- **D1. Where the bell lives.** The four homes are in "Where the bell
  lives" above.
  - **a (recommended):** the right end of the status bar, in the main
    window and in the Stream Manager. It is where toasts land today and
    where the session state already sits.
  - b: the sidebar's account row (between the account menu and the theme
    toggle) in the main window, and the status bar in the Stream Manager.
    More visible, two different places.
  - c: the sidebar's top row beside Search. Not recommended: it is a corner
    button on the window's title band.
- **D2. What may pop up while you are recording or live.**
  - **a (recommended):** only an urgent problem, once, for 15 s. Everything
    else raises the number on the bell.
  - b: nothing at all. Urgent problems turn the bell red, and the system
    notification (plan 223) covers a Studio that is not in front.
  - c: urgent problems pop up and stay until closed, as today.
- **D3. When quiet applies.**
  - **a (recommended):** while a recording or a livestream runs. A
    recording is often a presentation, and the lock rule already says
    "recording or live".
  - b: only while a livestream runs.
- **D4. Whether quiet is a switch.**
  - **a (recommended):** one switch, "Quiet while recording or live", on by
    default, in Settings → General → Notifications. Its line: "Only urgent
    problems pop up. Everything else waits in Notifications." The dropdown's
    footer says what it is doing and links there.
  - b: no switch. It is simply how Videorc works.
- **D5. What the number counts.**
  - **a (recommended):** unread urgent and warning entries, and unread
    finished work. News never adds to it. A warning that cleared on its own
    before you looked stops counting.
  - b: everything unread, news included.
  - c: only problems that are still open.
- **D6. What happens to a problem that cleared.**
  - **a (recommended):** it stays in the list under Earlier as resolved
    ("Your stream is smooth again · It was choppy for 38 s."), until
    cleared. After a stream the list reads as what happened.
  - b: it disappears. The list only ever shows what is wrong now.
- **D7. The watchdog's cards in the Studio's Session panel** (plan 223 D2),
  and the inline alert for a failed recording or a lost microphone.
  - **a (recommended):** keep them. They are state on the Studio page and
    never pop up. Only their toasts move behind the rules above. The card
    and the entry show the same alert with the same buttons.
  - b: remove the cards. The bell is the one list of problems, and the
    Session panel shows only its rows.
- **D8. Whether the list survives a relaunch.**
  - **a (recommended):** no. It lives for this run. What is still true is
    rebuilt on launch; yesterday's stream does not greet you with a number.
  - b: unread finished work and errors (never conditions) survive, up to
    50, in this device's saved settings.
- **D9. The Stream Manager's bell.**
  - **a (recommended):** in this plan, as its own slice (S8). While live it
    is the window in front, so the bell matters most there.
  - b: later. The Stream Manager keeps its health chip only.
- **D10. The shortcut.**
  - **a (recommended):** ⇧⌘B (Ctrl+Shift+B) opens and closes the list. It
    is free in both windows and in the app menu.
  - b: no shortcut. ⌘K's "Open notifications" is the keyboard way in.
- **D11. Sidekick's nudges** (its question, its promise reminder and its
  dead-air nudge, `components/stream-manager/stream-manager.tsx:685–694`)
  and the "Remove this message?" question
  (`lib/chat-moderation-relay.ts:115`).
  - **a (recommended):** they stay toasts. The nudges are Sidekick talking,
    with their own switches on the Sidekick page; the question needs an
    answer inside 20 s. Look at them again once the bell has been used on a
    real stream.
  - b: the nudges become News entries too.
- **D12. The eager bundle.** The bell is in every window's first paint, and
  the eager budget has 91 bytes of gzip left
  (`scripts/check-renderer-asset-budget.mjs:166–178`). The bell, its count
  store and one icon are expected to cost 0.9 to 1.5 KB gzip.
  - **a (recommended):** approve a raise of the eager gzip ceiling by
    1,500 B (and the raw ceiling by 6,000 B) for this plan, measured and
    recorded in the budget file as every raise has been. If PR #1512
    (minified renderer) merges first, no raise is needed.
  - b: no raise. S1 must first move the same number of bytes out of the
    eager chunk, which makes S1 a bigger and riskier slice.
- **D13. Results while idle** ("Recording saved · Play", "MP4 ready",
  "Clean cut ready").
  - **a (recommended):** a short toast (8 s, never pinned) and an entry.
    You have just stopped and are looking at the window; the button is
    useful right then, and the entry keeps it afterwards.
  - b: bell only, always.

Two owner calls this plan touches, both from the design skill's "Toast
discipline": "a toast with an action stays until it is acted on or closed,
and so does one that mirrors a state still true", and "Warnings and errors
always surface". With the list behind the bell, a notification never needs
a pinned toast, and a warning during a stream surfaces as the number. The
skill and `docs/ui-copy.md` are updated in the slice that changes the
behaviour (S3). Prompted toasts keep both rules.

## Inventory: every toast today

Read from `origin/main` `fe53fde02`. Paths are under
`apps/desktop/src/renderer/`; the main process raises no toast (it shows
system notifications, listed at the end). 317 call sites in 59 files
(`toast(…)`, `toast.<kind>(…)`, `notifyOnce(…)`, `toastUserError(…)`,
`toastOffline(…)`, `showStreamTargetNotice(…)` and the calls through an
alias such as `const show = … ? toast.error : toast.warning`). 8 of them are
the wrappers' own bodies (`lib/notify-once.ts:64–76`, `lib/user-error.ts:262`
and `:290`, `lib/session-runtime-recovery.ts:310`).

The split that matters is who started it:

- **Prompted (212 sites):** the answer to something the streamer just did in
  that window ("Couldn't import the image", "Clips are off", an Undo). These
  are not the problem. They stay toasts.
- **Unprompted (97 sites):** Videorc noticed something on its own, usually
  from a backend event, often mid-stream. These are the toasts that pile up.
  91 of them move to the notification center. 6 stay as they are (D11).

Classes, from the brief: **(a)** a one-off confirmation, **(b)** an ongoing
condition, **(c)** an error that needs action. Tones: critical, warning,
info, done.

### Unprompted: these move to the notification center

`srr` is `src/lib/session-runtime-recovery.ts`. "Pinned" means the toast
stays until closed (`duration: Infinity`).

#### Live output and the connection (backend `health` events)

| Site | Trigger (`code`) | Words today | Today | Class | Becomes |
| --- | --- | --- | --- | --- | --- |
| `srr:545` | `stream-output-failed` | Your stream stopped | error, pinned | c | Critical entry `stream-output`; pops up even while live |
| `srr:559` | `stream-output-stalled` | Your stream is frozen | warning, pinned | b | Critical condition `stream-output` |
| `srr:565` | `stream-output-resumed` | Your stream is moving again | success, 8 s | b | Resolves `stream-output`; no toast |
| `srr:553` | `recording-output-failed` | Your recording stopped | error, pinned | c | Critical entry `recording-output` |
| `srr:574` | `stream-delivery-degraded` | Your stream is choppy | warning, pinned | b | Warning condition `stream-delivery` |
| `srr:580` | `stream-delivery-recovered` | Your stream is smooth again | success, 8 s | b | Resolves `stream-delivery` |
| `srr:588` | `stream-leg-overflow` | Your connection can't keep up | warning, 20 s | b | Warning condition `stream-uplink` |
| `srr:594` | `stream-bitrate-lowered` | Stream quality lowered to fit your connection | warning, 15 s | b | Updates `stream-uplink` |
| `srr:600` | `stream-bitrate-floor` | Your connection can't carry this stream | warning, 30 s | b | Updates `stream-uplink` |
| `srr:606` | `stream-bitrate-restored` | Stream quality is back | success, 8 s | b | Resolves `stream-uplink` |
| `srr:613` | `screen-capture-stopped` | Screen capture stopped | error pinned, or warning 20 s | b | Condition `screen-capture`: critical on `error`, else warning |
| `srr:619` | `screen-capture-restored` | Screen capture is back | success, 8 s | b | Resolves `screen-capture` |
| `srr:627` | `screen-window-out-of-sight` | Window out of sight | warning, 20 s | b | Warning condition `screen-capture` |
| `srr:633` | `screen-window-back` | The window is back | success, 8 s | b | Resolves `screen-capture` |
| `srr:639` | `host-overloaded` | This computer is overloaded | warning, 20 s | b | Warning condition `host-overloaded` (the owner's "memory pressure": load and swap, `host_pressure.rs:53`) |
| `srr:647` | `disk-space-low` | Recording space is low | warning, 20 s | b | Warning condition `disk-space` |
| `srr:501` | startup codes (`lib/studio-health.ts:53–118`) | The first seconds may stutter · Recording at a lower resolution · Recording is falling behind · Microphone can't be changed until you stop · Going on without a microphone | warning, 15–20 s | b | Warning entries, one key per code |
| `srr:501` | `recording-startup-barrier-timeout` (error) | Couldn't start | error, pinned | c | Stays a toast: it answers Record or Go Live |
| `srr:512` | `recording-quality-not-100` | This recording has dropped frames | warning, 15 s, Open in Library | c | Warning entry `recording-quality:<session>` |
| `srr:337` | `separate-source-recordings-role-failed` | (Screen or Camera file stopped) | warning, 8 s, Open Health | c | Warning entry `separate-file:<session>:<role>` |
| `srr:356` | `separate-source-recordings-shed` | (separate files stopped to protect the take) | warning, 8 s, Open Health | c | Warning entry `separate-files-shed:<session>` |
| `srr:176` | recording status `failed` | Recording stopped unexpectedly | error, pinned, Open in Library | c | Critical entry `recording-failed:<session>` |
| `srr:781` | `sources.fallback` | Camera switched to FaceTime HD Camera | warning, 10 s | b | Warning entry `source-fallback:<kind>` |

#### Audio (backend `health` events)

| Site | Trigger (`code`) | Words today | Today | Class | Becomes |
| --- | --- | --- | --- | --- | --- |
| `srr:521` | `mic-silent` | Microphone is silent · Recording has no sound | warning or error, 15 s | b | Condition `microphone`: critical on `error` while live, else warning |
| `srr:264`, `srr:460` | `microphone-input-lost`, `microphone-timeline-lost`, `microphone-silent` | (microphone lost, by phase) | warning, pinned | b | Critical condition `microphone` |
| `srr:693` | `microphone-timeline-recovered`, `microphone-input-recovered` | Microphone is back | success, 8 s | b | Resolves `microphone` |
| `srr:699` | `microphone-signal-recovered` | Your microphone has sound again | success, 8 s | b | Resolves `microphone` |
| `srr:665` | `microphone-noise-reduction-silenced` | Microphone silenced for a moment | warning, 12 s | b | Info entry `microphone-blip`, counted ("3 times"), never pops up |
| `srr:677` | `audio-output-stalled` | Audio dropped for a moment | warning, 12 s | b | Info entry `audio-blip`, counted, never pops up |
| `srr:670` | `system-audio-echo-paused` | System audio paused: your stream was echoing | warning, pinned, Resume | b | Warning condition `system-audio-echo`, fix: Resume |
| `srr:683` | `audio-output-failed` | Your recording has no sound from here | error, pinned | c | Critical entry `audio-output` |
| `src/lib/sound-monitor.ts:114` | monitor playback failed | Couldn't play {sound} on this computer | warning | c | Info entry `sound-monitor:<id>` |

#### Destinations and platforms

| Site | Trigger | Words today | Today | Class | Becomes |
| --- | --- | --- | --- | --- | --- |
| `src/lib/studio-toasts.ts:76` (from `src/hooks/use-studio.tsx:5140`, built in `src/lib/stream-target-notices.ts:61`) | `stream.targets` state change | Streaming to {X} stopped · {X} is reconnecting · {X} isn't receiving your stream · {X} is back · Reconnecting to Videorc Cloud | error or warning, pinned; success | b | One condition per destination, `stream-target:<id>`. Critical when no other destination is on air, else warning. "{X} is back" resolves it |
| `src/hooks/use-studio.tsx:3343` | chat provider not connected at Go Live | {Platform} chat isn't connected | warning, pinned (action) | b | Warning condition `chat:<platform>` |
| `src/lib/studio-connection-toasts.ts:29` | X chat not connected | X chat isn't connected for {target} | warning, pinned | b | Warning condition `chat:x:<target>` |
| `src/lib/studio-connection-toasts.ts:77` | chat needs the Videorc account | {Platform} chat needs your Videorc sign-in | warning, pinned | c | Warning entry `chat-sign-in:<platform>`, fix: Sign in |
| `src/lib/studio-connection-toasts.ts:90` | account session expired | Your Videorc sign-in expired | warning, pinned | c | Warning entry `account-session`, fix: Sign in |
| `src/lib/studio-connection-toasts.ts:37` | X broadcast would not end | (X broadcast still running) | warning, pinned, Open Media Studio | c | Warning entry `x-broadcast-end:<target>` |
| `src/lib/studio-connection-toasts.ts:44` | X broadcast would not start | (X broadcast did not start) | warning, 8 s | c | Warning entry `x-broadcast-start:<target>` |
| `src/hooks/use-studio.tsx:7794` | X feed connected | X feed is connected: start the broadcast on X | info, long | c | Info entry `x-start-broadcast`; pops up (it is a step of Go Live) |
| `srr:371`, `srr:375`, `srr:382` | `x.playback` | Viewers can watch your X broadcast · X is still preparing your stream · X ended your broadcast | success, warning, error | b | Condition `x-playback`: warning while preparing, critical when X ended it, resolved when viewers can watch |
| `srr:58` | YouTube broadcast start or end failed | (YouTube step failed) | warning, 8 s | c | Warning entry `youtube-broadcast-<step>:<target>` |
| `srr:91` | YouTube budget reached | (YouTube request budget notice) | info, 8 s | b | Info entry `youtube-budget` |
| `srr:76` | Discord go-live post failed | (announcement failed) | error or warning | c | Warning entry `discord-announce` |
| `src/lib/youtube-thumbnail-toast.ts:47`, `:68` | thumbnail upload failed | Thumbnail not set on YouTube | warning, Retry | c | Warning entry `youtube-thumbnail:<target>`, fix: Retry |
| `src/lib/youtube-thumbnail-toast.ts:63` | thumbnail set after a retry | Thumbnail set on YouTube | success | a | Silent: it resolves the entry |
| `src/hooks/use-studio.tsx:19456` | stream key stored the old way | Save your {platform} stream key again | warning, 8 s | c | Warning entry `stream-key-migration:<target>` |
| `src/hooks/use-studio.tsx:16678` | Go Live changed the output | (stream output adjusted) | info, 8 s | a | Info entry `stream-output-adjusted` |

#### The stream watchdog (plan 223)

| Site | Trigger | Words today | Today | Class | Becomes |
| --- | --- | --- | --- | --- | --- |
| `src/lib/watchdog-surface.ts:150` | `watchdog.alerts`: an alert opens or its words change | The backend's title and detail, with its first fix | info 8 s, or warning pinned | b | One entry per alert, `watchdog:<id>`; critical, warning or info from the alert's severity; its fixes are the entry's actions |
| `src/lib/watchdog-surface.ts:164` | the alert cleared | (cleared words) | success | b | Resolves the entry |

#### Videorc Cloud

| Site | Trigger | Words today | Today | Class | Becomes |
| --- | --- | --- | --- | --- | --- |
| `src/lib/cloud-notices.ts:48` | `cloud.status`: ended elsewhere | The show was ended from videorc.com. | info, 8 s | a | Info entry `cloud-status` |
| `src/lib/cloud-notices.ts:51`, `:53`, `:55`, `:57` | `cloud.status`: fallback, lost, restarted, show cap | (one warning each) | warning, 8 s | b | Warning condition `cloud-status`, updated in place |
| `src/lib/cloud-notices.ts:63` | another device continued the show | (taken over) | info, 8 s | a | Info entry `cloud-status` |
| `src/lib/cloud-notices.ts:187` | past the month's hours | (allowance past) | info | b | Info entry `cloud-allowance` |
| `src/lib/cloud-notices.ts:196` | Videorc Cloud switched on for the account | (announcement, Open Destinations) | info, pinned | a | Info entry `cloud-announce` |
| `src/hooks/use-talk-show-room.ts:215` | this device now controls the show | You control this show here now | info | a | Info entry `cloud-controller` |

#### Devices and the app

| Site | Trigger | Words today | Today | Class | Becomes |
| --- | --- | --- | --- | --- | --- |
| `src/hooks/use-studio.tsx:12508` | an unplugged source is connected again mid-session | {device} is back, Use it | neutral, pinned | b | Info condition `source-return:<kind>:<id>`, fix: Use it; goes when used or unplugged |
| `src/hooks/use-virtual-camera.ts:87` | Videorc Camera stopped | (the camera's stopped title, with the reason) | warning, pinned | b | Warning condition `videorc-camera` |
| `src/lib/global-shortcuts.ts:215`, `:227`, `:243` | global shortcuts failed to register | Global shortcuts don't work here · A global shortcut didn't register · Global shortcuts didn't register | warning or error, pinned | c | Warning entry `global-shortcuts` |
| `src/hooks/use-studio.tsx:13324`, `:13349` | Notes or Stream Manager closed when a window recording starts | Notes closed for this recording · Stream Manager closed for this recording | warning, 8 s | a | Info entry `window-closed-for-recording` |
| `src/hooks/use-studio.tsx:11137` | preview proof lag | The preview may be behind | info, 8 s | b | Info entry `preview-behind` |
| `src/hooks/use-studio.tsx:19279` | performance check: the chosen output is too heavy | (too heavy, with a preset to apply) | warning, pinned | c | Warning entry `output-too-heavy`, fix: the preset |
| `srr:273` | backend restarting | Videorc is recovering | warning | b | Warning condition `backend`; resolves on reconnect |
| `srr:278`, `srr:284` | backend failed or lost | Videorc can't recover on its own · Videorc needs a restart | error, pinned | c | Critical entry `backend`; always pops up |
| `srr:315`, `src/hooks/use-studio.tsx:9314` | backend `error` event | Videorc hit a problem, Open Health | error, 8 s | c | Warning entry `backend-error` (one, counted) |
| `src/lib/agent-notices.ts:32` | an agent's on-air action | "{Agent} ended the livestream" | info | a | Info entry `agent-notice:<agent>:<tool>` |

#### Work that finishes out of view

| Site | Trigger | Words today | Today | Class | Becomes |
| --- | --- | --- | --- | --- | --- |
| `srr:478` | a recording was saved | Recording saved, Play, Open in Library | success, 12 s | a | Done entry `recording-saved:<session>`; a short toast while idle |
| `src/lib/finalization-toast.ts:17` | MP4 export running | (the export's progress line) | loading, pinned | b | Entry `mp4:<session>` with a spinner; no toast |
| `src/lib/finalization-toast.ts:26` | MP4 export finished | MP4 ready, Show in Finder | success, 15 s | a | The same entry turns done |
| `src/lib/finalization-toast.ts:43` | MP4 export failed | MP4 export failed | error, pinned | c | The same entry turns warning |
| `srr:707` | noise cleanup finished | Noise cleanup complete, Play | success, 15 s | a | Done entry `noise-cleanup:<job>` |
| `src/lib/clean-cut-notify.ts:78` | clean cut finished | (clean cut ready), Review | success, 15 s | a | Done entry `clean-cut:<job>` |
| `src/lib/clean-cut-auto.ts:231` | automatic clean cut did not start | Your clean cut didn't start, Open Clean cut | warning, pinned | c | Warning entry `clean-cut-auto:<session>` |
| `src/lib/cloud-recording-downloads.ts:76` | cloud recording downloaded | Cloud recording saved, Show in Finder | success, pinned | a | Done entry `cloud-download:<recording>` |
| `src/lib/cloud-recording-downloads.ts:69` | cloud recording download failed | Couldn't download the cloud recording | error | c | Warning entry `cloud-download:<recording>` |
| `src/lib/replay-buffer.ts:62` | a clip was saved | Clip saved, Show in Finder | success, 12 s | a | Done entry `clip:<save>`; a 4 s toast, because it answers a key press |
| `src/lib/replay-buffer.ts:74` | a clip save failed | Couldn't save the clip | error, 10 s | c | Warning entry `clip:<save>`; a 4 s toast |
| `src/lib/replay-buffer.ts:122`, `:130` | Clips stopped, or could not start | Clips stopped · Clips couldn't start | warning or error, 10 s | b | Warning condition `clips` |

#### Left as they are (unprompted, but not part of this plan)

| Site | What | Why it stays |
| --- | --- | --- |
| `src/components/stream-manager/stream-manager.tsx:685`, `:689`, `:694` | Sidekick's question, promise reminder and dead-air nudge, in the Stream Manager | Sidekick talking, with its own switches (D11) |
| `src/lib/chat-moderation-relay.ts:115`, `:130`, `:134` | "Remove this message?" with its two answers, and its outcome | A question with a 20 s deadline; it needs an answer, not a list |

### Prompted: these stay toasts (212 sites)

Each answers a click, a key or a save in the window it shows in. Nothing
changes for them except two rules from this plan: none is pinned while a
recording or livestream runs unless it carries an Undo or a Retry, and
success toasts for a change the screen already shows stay forbidden.

Paths in this table are under `renderer/src/`, except `comments/main.tsx`,
which is under `renderer/`.

| File | Sites | Lines |
| --- | ---: | --- |
| `comments/main.tsx` | 27 | 199, 200, 236, 237, 311, 326, 584, 590, 599, 629, 697, 730, 766, 785, 806, 816, 831, 849, 869, 891, 1015, 1029, 1035, 1062, 1069, 1081, 1087 |
| `components/buddy-persona-section.tsx` | 1 | 98 |
| `components/buddy-voice-commands.tsx` | 2 | 86, 103 |
| `components/captions/captions-controls.tsx` | 1 | 189 |
| `components/clean-cut/clean-cut-card.tsx` | 3 | 184, 238, 249 |
| `components/command-palette.tsx` | 1 | 402 |
| `components/community/community-tab.tsx` | 9 | 217, 510, 525, 534, 539, 550, 559, 571, 776 |
| `components/community/person-card-body.tsx` | 2 | 155, 702 |
| `components/community/remember-offer.tsx` | 1 | 37 |
| `components/guests/guest-moderation.tsx` | 1 | 164 |
| `components/media/session-player.tsx` | 1 | 301 |
| `components/obs-import-dialog.tsx` | 1 | 219 |
| `components/scheduled-streams.tsx` | 1 | 122 |
| `components/session-markers-dialog.tsx` | 1 | 235 |
| `components/settings/agents-section.tsx` | 2 | 109, 225 |
| `components/stream-manager/person-card-host.tsx` | 2 | 157, 181 |
| `components/stream-manager/stream-manager.tsx` | 5 | 1099, 1199, 1562, 1570, 1576 |
| `components/streaming/stream-report-email-section.tsx` | 2 | 281, 302 |
| `components/streaming/watchdog-section.tsx` | 1 | 170 |
| `components/studio/agents-session-row.tsx` | 1 | 30 |
| `components/studio/quick-settings.tsx` | 1 | 498 |
| `components/studio/studio-chat.tsx` | 1 | 87 |
| `components/tabs/assets-tab.tsx` | 1 | 181 |
| `components/tabs/buddy-tab.tsx` | 2 | 275, 469 |
| `components/tabs/diagnostics-tab.tsx` | 2 | 694, 699 |
| `components/tabs/library-cloud-iso.tsx` | 3 | 199, 216, 231 |
| `components/tabs/library-cloud-recordings.tsx` | 1 | 171 |
| `components/tabs/library-tab.tsx` | 17 | 257, 267, 278, 1245, 1320, 1323, 1330, 1350, 1354, 1356, 1360, 1367, 1377, 1382, 1385, 1412, 1418 |
| `components/tabs/recording-tab.tsx` | 2 | 469, 519 |
| `hooks/use-camera-low-light.ts` | 1 | 98 |
| `hooks/use-scene-presets.ts` | 2 | 51, 68 |
| `hooks/use-screen-privacy.ts` | 1 | 68 |
| `hooks/use-studio.tsx` | 60 | 3685, 4218, 4256, 5275, 5320, 5512, 7516, 7691, 8457, 9141, 10895, 10901, 11343, 11590, 11602, 11675, 11921, 11996, 12090, 12111, 12328, 12494, 13472, 13533, 13553, 13586, 13660, 13726, 13773, 13823, 14571, 14584, 14982, 15026, 15059, 15091, 15117, 15138, 15305, 15325, 15451, 15525, 15529, 15549, 17438, 17444, 17636, 17738, 17878, 17931, 18050, 18178, 18319, 18674, 19155, 19469, 19499, 19789, 20276, 20296 |
| `hooks/use-virtual-camera.ts` | 1 | 139 |
| `lib/chat-link-actions.ts` | 1 | 17 |
| `lib/cloud-notices.ts` | 5 | 77, 103, 130, 133, 155 |
| `lib/cloud-recording-downloads.ts` | 3 | 60, 160, 174 |
| `lib/copy-text.ts` | 2 | 30, 31 |
| `lib/global-shortcuts.ts` | 2 | 92, 97 |
| `lib/marker-toast.ts` | 2 | 28, 56 |
| `lib/replay-buffer.ts` | 4 | 92, 100, 108, 114 |
| `lib/session-runtime-recovery.ts` | 6 | 408, 410, 420, 428, 738, 748 |
| `lib/soundboard-actions.ts` | 14 | 41, 48, 62, 68, 150, 176, 185, 193, 208, 215, 237, 241, 243, 246 |
| `lib/studio-connection-toasts.ts` | 2 | 53, 64 |
| `lib/studio-toasts.ts` | 2 | 141, 145 |
| `lib/system-permission-orchestration.ts` | 2 | 113, 140 |
| `lib/talk-show-end.ts` | 2 | 30, 39 |
| `lib/watchdog-surface.ts` | 4 | 202, 234, 246, 259 |
| `lib/whats-new.ts` | 1 | 222 |

`src/hooks/use-studio.tsx` holds 60 of them: refusals ("Stop the recording
or stream before switching orientation"), `toastOffline` ("Videorc is
reconnecting"), saves and deletes, and the Go Live checks. `comments/main.tsx`
is the Stream Manager's window: every one of its 27 is the answer to a
click there.

A few prompted toasts are **(a)** confirmations that could become silent in
a later pass, because the interface already shows the result: "Link copied"
(`src/lib/studio-connection-toasts.ts:64`), "Disconnected {platform}"
(`src/hooks/use-studio.tsx:15117`), "Deleted “{name}”" (`:13660`, `:14982`).
They are left alone here: they are not the complaint, and the toast rule
already allows a confirmation for a delete.

### What the main process shows

Main raises no toast and has no channel to ask for one. It shows two
system notifications, which do not change:

- the watchdog's, when the Studio is not in front (`main/index.ts:19355–19384`,
  rules in `main/watchdog-notify.ts`);
- "update ready" (`main/updater.ts:378–382`), skipped while capturing.

### Problems the backend reports that raise nothing today

| Code or event | Where | In this plan |
| --- | --- | --- |
| `recording-disk-full` | `crates/videorc-backend/src/recording.rs:15198–15212` | S5 gives it an urgent entry with Open Output |
| `stream-dropped-frames` | `recording.rs:31401–31411`, on every rise of FFmpeg's count | Stays silent: `stream-delivery` covers it |
| `live-background-gpu-budget` | `compositor.rs:12243–12250` | Stays silent: the Assets page's still line covers it |
| `cloud.room.requests` (a guest asks to join) | `cloud_talk.rs:46`, no subscriber | Not in this plan ("Also seen") |
| Clipping (`audio.levels.masterClippedSamples`) | `protocol.rs:2105` | Not in this plan: the meter shows it |
| App memory (`backendRssBytes`) | `protocol.rs:3894`; a Health check only (`src/lib/health-checks.ts:453`) | Not in this plan. There is no "memory pressure" event: the toast the owner means is `host-overloaded`, which reports load and swap |

## Actions: where each notification sends you

Every entry gets the most direct honest way out: a fix when one press can
safely fix it, otherwise the door to the place that owns the control (one
home per control, design skill "Where things live"). Each destination below
was checked on `origin/main`; "needs a door" marks a place that exists but
cannot be opened from outside React today (slice S6 adds those).

Paths are under `apps/desktop/src/renderer/src/`.

### Fixes that run in place

| Entry | Button | What it runs | Why it is safe |
| --- | --- | --- | --- |
| Microphone muted while live | Unmute | The watchdog's `unmute` fix: the `micUnmute` executor (`lib/watchdog-surface.ts:190–201`) | Reverses the streamer's own mute; same as the mute key |
| A takeover covers the stream too long | End takeover | The `takeoverHide` executor (same place) | Same as the Takeover button |
| System audio paused for echo | Resume | `requestSystemAudioResume` (`lib/system-audio.ts:193`) | Today's toast button |
| A source is connected again | Use it | `switchSourceDeviceLive` with the returned device (`hooks/use-studio.tsx:12482–12498`) | Today's toast button |
| Thumbnail not set on YouTube | Retry | `streamTargets.youtube.thumbnail.retry` (`lib/youtube-thumbnail-toast.ts:47`) | Today's toast button |
| A cloud destination dropped | Reconnect | `cloud.show.reconnectDestination` (`lib/watchdog-surface.ts:222–228`) | The watchdog's fix |
| Chat needs the Videorc account, or the sign-in expired | Sign in | `beginVideorcSignIn` | Today's toast button |
| The chosen output is too heavy (idle only) | The lighter preset's name | `applyVideoPreset` (`hooks/use-studio.tsx:19279–19285`) | Today's toast button; hidden while recording or live, where output is locked |
| Recording saved, noise cleanup done | Play | `window.videorc.openSession` | Today's toast button |
| MP4 ready, clip saved, cloud recording saved | Show in Finder | `revealSession`, `revealCloudDownload` (`revealInFileManagerLabel()` gives the platform's words) | Today's toast button |
| Clean cut ready | Review | `openCleanCut({ sessionId, jobId })` (`lib/clean-cut-events.ts:27`) | Today's toast button |

Nothing new changes a stream on its own. No entry lowers quality, switches
a device or restarts capture mid-stream with one press: those stay on their
pages.

### Doors

| Entry | Button | Opens | Exists today |
| --- | --- | --- | --- |
| Microphone silent or lost, no voice | Open Audio | Studio, the Audio group: picker, level, Gain, mute (`components/studio/audio-section.tsx:250`, `:327`, `:346`). The watchdog's `open-audio` already goes to Studio (`lib/watchdog-surface.ts:211`) | The page yes; scrolling to the group **needs a door** |
| System audio lost or echoing (second button) | Open Sources | Sources → Audio → System audio (`components/sources/sources-audio-mixer.tsx:765`, `data-videorc-system-audio-settings`) | Page yes; the section **needs a door** |
| A source fell back, screen capture stopped | Open Sources | Sources → Video (`components/sources/video-sources.tsx:93`, `:139`) | Yes (`openWorkspaceTab('sources')`) |
| Screen capture stopped for want of access | Open Permissions | Settings → Permissions (`components/settings/permissions-settings.tsx:18`), from the event's `permissionPane` | Yes (`openSettingsTab('permissions')`) |
| A destination stopped, is reconnecting, or isn't receiving | Open Destinations | Destinations → Setup, that destination's card (`components/streaming/destination-card.tsx:187`, `id=destination-<id>`) | The page yes. Opening a named card works only over IPC from the Stream Manager (`components/app-shell.tsx:547–553`): **needs a door** |
| Chat isn't connected, stream key to save again, YouTube or X step failed, Discord post failed | Open Destinations | The same card, or Setup | As above |
| X broadcast to start or end by hand | Open Media Studio | `openXMediaStudio` (`lib/studio-connection-toasts.ts:37`) | Yes |
| Stream choppy, frozen, connection can't keep up, a separate file stopped, an unexplained problem | Open Health | Health (`openHealth`, `lib/health-door.ts:12`) | Yes |
| Recording space is low | Open Output | Output → Where recordings go (`components/tabs/recording-tab.tsx:532`) | Page yes (`openWorkspaceTab('recording')`); the section **needs a door** |
| Clips stopped or couldn't start | Open Output | Output → Clips (`components/tabs/recording-tab.tsx:82`) | Page yes; today's toast already goes there |
| Videorc Camera stopped | Open Output | Output → Videorc Camera (`components/tabs/videorc-camera-section.tsx:61`) | Page yes; today's toast has no button |
| Global shortcuts didn't register | Open Shortcuts | Settings → Shortcuts | Yes (`openSettingsTab('shortcuts')`) |
| Videorc Cloud fell back, lost the feed, restarted, reached its cap | Open Destinations | Destinations → Setup → Videorc Cloud (`requestCloudSectionFocus`, `lib/cloud-section-focus.ts:15`) | Yes |
| Another device took over the show | Open Studio | Studio, where the Continue here notice sits (`components/studio/cloud-resume-notice.tsx`) | Yes |
| Recording stopped unexpectedly, dropped frames, recording saved (second button) | Open in Library | Library, on that recording | **Broken today:** `openWorkspaceTab('library', id)` drops the id (`components/app-shell.tsx:257`, `:514`; `lib/workspace-navigation.ts:31` says so). **Needs a door** |
| Clean cut didn't start | Open Clean cut | `openCleanCut({ sessionId })` | Yes |
| An agent's on-air action | Open Settings | Settings → Remote, the Agents section (`components/settings/remote-settings.tsx:169`) | Yes (`openSettingsTab('remote')`) |
| A takeover or scene to choose (watchdog: Show Be right back, Switch scene) | The watchdog's label | Assets → Takeovers, the Scene page (`lib/watchdog-surface.ts:203–210`) | Yes |
| This computer is overloaded, Videorc is recovering, a moment of silence | none | Nothing in the app fixes these; the detail says what to do | n/a |

A door pressed in the Stream Manager brings the main window forward
first. That is new: the watchdog's relay forwards a fix without raising
the window (`main/index.ts:19390`); the system notification's click shows
how (`main/index.ts:19372–19378`).

A door closes the list. A fix keeps it open and shows a spinner on its
button until the entry updates or resolves; a fix that fails says so with a
toast (`toastUserError`), because it answers a press.

## Architecture

Paths are under `apps/desktop/src/` (`renderer/src/` is written `R/`).

### One store, in the main window's renderer

The main window owns the backend socket (`R/backendClient.ts:231`) and
`StudioProvider`, and every one of the 91 toasts this plan moves is raised
there today. So the store lives there. Other windows read a copy.

```
 backend ──health.event──────────┐
 backend ──watchdog.alerts───────┤
 backend ──stream.targets────────┤     R/lib/notifications/        R/lib/notification-count.ts
 backend ──cloud.state───────────┼──▶  sources/*  ──▶  store  ──▶  { unread, tone }  ──▶  the bell (eager)
 backend ──replay.*, account.*───┤        │              │
 main ─────backend:lifecycle─────┤        │              ├──▶ pop-up.ts ──▶ lib/toast.ts (the only toast door)
 renderer: devices, exports, ────┘        │              ├──▶ the list (lazy, on first open)
           shortcuts, agents              │              └──▶ snapshot ──▶ main ──▶ Stream Manager's bell
                                    kinds.ts (tone, life, actions)
```

New modules:

| Module | Loaded | Holds |
| --- | --- | --- |
| `R/lib/notification-count.ts` | eager | A tiny external store, `{ unread: number, tone: 'urgent' \| 'warning' \| null }`, and `useNotificationCount()`. Nothing else |
| `R/lib/notify.ts` | eager | `notify(input)`, `resolveNotification(key)`: two thin functions that `import()` the store chunk and queue until it is there. For the few callers in eager code |
| `R/components/notifications/notification-bell.tsx` | eager | The `StatusBarAction`, the icon, the number, the `PopoverTrigger`. It preloads the list on hover and focus, like `CommandPalette` is mounted only while open (`R/components/app-shell.tsx:751`) |
| `R/lib/notifications/types.ts`, `store.ts` | lazy, one chunk | Entries, and `publish`, `resolve`, `clear`, `clearAll`, `markRead`, `sessionEnded`, `snapshot`, `subscribe` |
| `R/lib/notifications/policy.ts` | lazy | Pure functions: does it pop up, does it count, how two reports on one subject merge, the 60 s flap window, the 5 minute re-alert rule. Table-tested |
| `R/lib/notifications/kinds.ts` | lazy | The registry: one row per kind with its tone, its life, `answersAPress`, and how to build its actions |
| `R/lib/notifications/health-kinds.ts` | lazy | `health` code → subject key and effect (`open`, `update`, `resolve`, `blip`, `ignore`). Replaces the three `if` chains in `R/lib/session-runtime-recovery.ts:485–704` |
| `R/lib/notifications/sources/*.ts` | lazy | One per feed: `health.ts`, `watchdog.ts`, `stream-targets.ts`, `cloud.ts`, `platforms.ts`, `app.ts`, `work.ts` |
| `R/lib/notifications/pop-up.ts` | lazy | The only place a notification becomes a toast |
| `R/components/notifications/notification-center.tsx`, `notification-entry.tsx` | lazy | The `Popover` content and one row |

An entry, as the store keeps it:

```ts
type NotificationTone = 'urgent' | 'warning' | 'news' | 'done'
type NotificationLife = 'condition' | 'event' | 'progress'

interface NotificationEntry {
  key: string // the subject: 'microphone', 'stream-target:tw-1'
  kind: NotificationKindId // its row in kinds.ts
  tone: NotificationTone
  life: NotificationLife
  state: 'open' | 'resolved' | 'happened' | 'running' | 'done' | 'failed'
  title: string
  detail?: string
  openedAt: number
  updatedAt: number
  resolvedAt?: number
  occurrences: number
  read: boolean
  sessionId?: string // resolves when this session ends
  actions: { id: string; label: string; kind: 'fix' | 'door' }[] // at most two
}
```

The action's function stays inside the store, keyed by `key` and `id`, so
the entry itself is plain data: the snapshot the Stream Manager receives is
this list, and it runs an action by sending `{ key, id }` back.

### How each feed reaches the store

| Feed | Today | After |
| --- | --- | --- |
| `health.event` (`R/hooks/use-studio.tsx:8724`) | `showSessionHealthEvent` and friends, a toast per code | `sources/health.ts` looks the code up in `health-kinds.ts` and calls `publish` or `resolve`. Codes the watchdog writes for its own history (`watchdog-<check>`, `-cleared`, `-acknowledged`, `-snoozed`, `-withdrawn`; `crates/videorc-backend/src/watchdog/alerts.rs:615–625`) are `ignore`: the alert list is their source |
| `watchdog.alerts` (`R/hooks/use-studio.tsx:8718`, shown from `:5805`) | `onWatchdogAlertsChanged`: a toast per open alert, a success toast on clear | `sources/watchdog.ts` maps each alert onto its subject. The asks for a system notification stay in `R/lib/watchdog-surface.ts` untouched |
| `stream.targets` (`R/hooks/use-studio.tsx:8859`) | `streamTargetNotices` → `showStreamTargetNotice` | The same pure `streamTargetNotices`, then `publish` or `resolve` per destination |
| `cloud.state` (`R/hooks/use-studio.tsx:9116`) | `toastCloudStatus` | `sources/cloud.ts`, same comparisons |
| `replay.state`, `replay.saveFailed`, `account.changed`, `liveChat.providerStatus`, `virtualCamera.changed` | Their own toasts | `sources/platforms.ts`, `sources/app.ts`, `sources/work.ts` |
| Main: `backend:lifecycle` (`R/hooks/use-studio.tsx:7840`) | `showBackendLifecycle` | `sources/app.ts`: `restarting` opens `backend`, `running` resolves it, `failed` and `lost` make it urgent |
| Renderer's own: a device is back, exports, global shortcuts, agents | Their own toasts | `notify(…)` from where they are detected |

On connect, and after a renderer reload mid-session, the store is rebuilt
from what is still true: `watchdog.alerts.list` (already asked for,
`R/hooks/use-studio.tsx:5776`), the current `stream.targets` and
`cloud.state` snapshots, and for the running session the last page of
`sessions.healthEvents.list` (120 events,
`shared/backend-rpc-contract.ts:7369`) folded through `health-kinds.ts`:
an `open` with no later `resolve` is still open (slice S9).

### The event contract

**The first eight slices add no RPC, no event and no field.** Everything
they need is already sent. A backend-owned `notifications.*` list was
considered and rejected: half of the reports are made in the renderer by
comparing snapshots (destinations, the cloud status, devices, exports), so
a backend list would be a second mirror to keep in step, for no new fact.

Slice S9 adds `health` codes only. `HealthEvent.code` is a free string
(`crates/videorc-backend/src/protocol.rs:6180`), and `health.event` is not
in the strict `BackendEventMap` (`shared/backend-rpc-contract.ts:1036`), so
a new code needs no schema change. It does need its row in
`health-kinds.ts`, and a look at `watchdog::observe_health_event`
(`crates/videorc-backend/src/recording.rs:31007`), which reads codes as
signals.

If any slice does add a field, an event or an RPC, the rules are:

- A new field on an existing payload goes into its schema in
  `shared/backend-rpc-contract.ts` in the same PR. `healthEventSchema`
  (`:3202`) and most others are strict (`allowUnknown: false`): the
  renderer drops a registered event that fails its schema
  (`R/backendClient.ts:431`), and main retires the whole socket
  (`main/backend-event-message.ts:29`).
- Every `Option` field is
  `#[serde(default, skip_serializing_if = "Option::is_none")]`, a `Vec` uses
  `"Vec::is_empty"`, a `bool` uses `"std::ops::Not::not"`
  (`crates/videorc-backend/src/watchdog/alerts.rs:187–201`,
  `protocol.rs:2109`). Absent, never `null`: a serialized `null` has broken
  app load before. (`HealthEvent.session_id` and
  `permission_pane` are the old exception, `protocol.rs:6178`: do not copy
  them.)
- A new RPC needs: its match arm (`main.rs:10286`), its row in
  `websocket_method_execution_policy` (`main.rs:5848`; the test
  `websocket_handler_execution_policy_inventory_is_exhaustive` at
  `main.rs:21441` fails without it), its types in `shared/backend.ts`, and
  in `shared/backend-rpc-contract.ts` its entries in `BackendRpcMethodMap`
  (`:429`) and `runtimeContracts` (`:8147`). A new event needs
  `BackendEventMap` (`:1036`) and `runtimeEventSchemas` (`:8172`).
- A fixture in `protocol-fixtures/` that both sides read, like
  `protocol-fixtures/watchdog.json`
  (`shared_watchdog_fixture_round_trips_without_nulls`,
  `watchdog/mod.rs:1593`).
- Remote sockets see nothing new by default (`main.rs:9187–9203`). Nothing
  in this plan is added to `LAN_EVENTS` (`remote_lan.rs:680`).

### How toasts route through it

- `R/lib/toast.ts` stays the one door to sonner and keeps its text guard.
  Prompted toasts call it as today.
- Unprompted code stops importing `toast`. It calls `publish` (or `notify`),
  and `pop-up.ts` decides, from `policy.ts`, whether the entry also shows
  as a toast. That toast has the id `notification:<key>`, a timed life,
  the entry's first action as its button, and three hooks: closed by hand
  or acted on → `markRead(key)`; timed out → nothing; the entry resolved →
  `toast.dismiss`.
- `pop-up.ts` asks nothing while the list is open.
- `notifyOnce` (`R/lib/notify-once.ts`) stays for prompted repeats (the
  sign-in callback retries). Its unprompted callers move to the store,
  which does the same job by key.
- Guards, in `R/renderer-toast-guards.test.ts`:
  - the modules that only carry unprompted news (`sources/*`,
    `session-runtime-recovery.ts`'s health functions, `watchdog-surface.ts`,
    `stream-target-notices.ts`, `cloud-notices.ts`'s `toastCloudStatus`)
    call no `toast.*`;
  - no toast is pinned (`duration: Infinity` or
    `Number.POSITIVE_INFINITY`) outside a short named list: the removal
    question, the browser-approval step, the Undo toasts.
- The store's errors (a fix that failed) are prompted: they answer the
  press, through `toastUserError`.

### The quiet setting

`SettingsState` (`R/lib/capture.ts:47–99`, saved in `localStorage` as
`videorc.settings`) gains `quietWhileLive?: boolean`. Absent means on. The
row sits in a new "Notifications" section of Settings → General
(`R/components/settings/general-settings.tsx`), built like the Chat
section's rows (`:131–151`). The store reads the setting and `live`
(`sessionOwnsTransport(recording)`) through two getters `StudioProvider`
hands it, so `policy.ts` stays pure.

### Other windows and surfaces

- **Stream Manager.** It has no backend socket; main relays what it shows.
  The watchdog's alerts already travel in the live dashboard
  (`R/lib/live-dashboard-relay.ts:236`, `shared/live-dashboard.ts:40`), and
  a fix pressed there already comes back (`comments-window:watchdog-fix`,
  `main/index.ts:19390`, `preload/index.ts:134`). The bell uses the same two
  paths: the snapshot rides the dashboard push, and one new channel,
  `comments-window:notification-act`, carries `{ key, id }` back to the main
  window (with its entries in `shared/electron-ipc-contract.ts` and
  `preload/index.ts`). For a door, main raises the main window first, as
  the system notification's click does (`main/index.ts:19372–19378`); the
  watchdog relay does not do that today. Clear and Clear all travel the
  same channel.
- **An urgent pop-up shows in the window you are in.** The main window asks
  main where to show it; main answers with the Stream Manager when that
  window is focused, else the main window. Neither focused: the main
  window, plus plan 223's system notification, as today.
- **Captions reader and Notes.** No bell. Their toasts are prompted.
- **Preview.** Not a React window. Nothing.
- **Sidekick.** No change (D11). Sidekick cannot read the list.
- **Stream Deck, the phone remote, MCP.** No change. `remote.state`,
  `LAN_EVENTS` and `get_status` do not carry the list, so their allowlists
  and leak arguments stand. The phone keeps plan 223's push.
- **The /live page.** No change. `live_status.rs:158–190` keeps sending the
  watchdog's open alerts only.
- **Windows and Linux.** The status bar, the popover and the shortcut
  (Ctrl+Shift+B) are the same code. No Dock or taskbar badge is added.
  `host-overloaded` never fires on Windows, which has no load average
  (`crates/videorc-backend/src/host_pressure.rs:74–79`).
- **The Rust UI** (`videorc-rust`) gets the bell in its own pass, from
  this plan's rules, after the Electron one has been used on a stream.

### Words and the icon

- New words, all through the copy guard: "Notifications", "Clear all",
  "Now", "Earlier", "No notifications", "Problems and finished work show
  up here.", "Quiet while recording or live.", "Only urgent problems pop
  up. Everything else waits in Notifications.", "Open notifications",
  "Clear {title}", "It was choppy for 38 s.", "Came back 3 times.",
  "Ended with the livestream.", "Ended with the recording."
- `CONTEXT.md` gains **Notifications** (the list behind the bell; _avoid_:
  alerts, inbox, activity) and keeps "system notification" for the
  operating system's banner.
- `NotificationsIcon` is a new slot in `R/components/icons.tsx` (Phosphor
  Bell). The registry has no bell today. It is one more glyph against the
  100-glyph ceiling (`docs/icon-set.md:105`); draw only the weights used
  through `IconBase`, the way plan 239 kept `AvatarPageIcon` small.

## Slices

Ten slices, cut with `.claude/skills/cut-it/SKILL.md`. Each is one agent
run, leaves the app working, and is its own PR from its own worktree off
`origin/main`. Paths are under `apps/desktop/src/` (`R/` is
`renderer/src/`).

Battle order:

| # | Slice | Depends on |
| --- | --- | --- |
| S1 | The store and its rules | none |
| S2 | The bell and the list, showing the watchdog's alerts | S1, D1, D10, D12 |
| S3 | Quiet while recording or live | S2, D2 to D5 |
| S4 | Doors | none (can run beside S1 to S3) |
| S5 | The session's health events | S3, S4 |
| S6 | Destinations, platforms and Videorc Cloud | S3, S4 |
| S7 | Devices, the app and finished work | S3, S4 |
| S8 | The Stream Manager's bell | S3, D9 |
| S9 | Clear signals and the rebuild on reconnect (backend) | S5 |
| S10 | Sweep, guards and acceptance | all |

S5, S6 and S7 each touch `R/lib/notifications/kinds.ts`,
`R/hooks/use-studio.tsx` and `R/lib/session-runtime-recovery.ts`. Run them
one after another, or rebase the later ones: their edits are in different
functions.

The first relief comes early: S3 ends the watchdog's pinned toasts, and S5
ends the microphone and "This computer is overloaded" toasts.

Gates every renderer slice runs at its end: `pnpm typecheck`, `pnpm lint`,
`pnpm format:check`, `pnpm --filter @videorc/desktop test`,
`pnpm build && pnpm check:renderer-assets`. A slice names what it adds to
that. Cosmetic slices get no heavy smokes (owner, 2026-11-14); a slice
that changes what a smoke reads runs that smoke.

### Slice S1: the store and its rules

**Owner route:** Implementation (fit 8). **Model lane:** `gpt-6.1-sol`.
**Goal:** the notification store and its pure rules exist and are tested.
Nothing on screen changes.
**Depends on:** none.
**Touches:** new `R/lib/notifications/types.ts`, `store.ts`, `policy.ts`,
`kinds.ts` (empty registry and its types), and their tests.
**Steps:**

1. `types.ts`: `NotificationEntry`, `NotificationInput`, the tones, lives
   and states from "Architecture".
2. `store.ts`: `publish`, `resolve`, `clear`, `clearAll`, `markRead`,
   `sessionEnded`, `snapshot`, `subscribe`, `runAction`, with an injected
   clock and injected `live` and `quiet` getters. No React, no `toast`.
3. `policy.ts`, all pure: `popUpDecision`, `countsAsUnread`, `mergeReports`
   (two reports on one subject, the worse tone wins, the watchdog's words
   lead), the 60 s flap window, the 5 minute re-alert rule, retention at 50.
4. Table tests for every row of "What pops up", "What the number counts",
   "Flapping", "When the session ends", "Clearing" and "How long it keeps
   things".

**Done when:** `pnpm --filter @videorc/desktop test -- notifications`
passes with those tables, and `pnpm check:renderer-assets` reports the
same eager size as `origin/main` (nothing imports the new chunk yet).
**Out of scope:** any UI, any toast call, any source of entries.

### Slice S2: the bell and the list

**Owner route:** UI/Product Design (fit 9). **Model lane:** `fable-5.1`
(a new surface in every window's first paint, with the budget on the line).
Read `.claude/skills/videorc-design/SKILL.md` first.
**Goal:** the bell is in the main window's status bar (D1) and opens the
list. It shows the watchdog's alerts, because they are already a list with
fixes. Toasts are untouched, so this slice only adds.
**Depends on:** S1; D1, D10, D12 answered.
**Touches:** `R/components/icons.tsx` and `docs/icon-set.md`
(`NotificationsIcon`); new `R/lib/notification-count.ts`, `R/lib/notify.ts`;
new `R/components/notifications/notification-bell.tsx`,
`notification-center.tsx`, `notification-entry.tsx`;
`R/components/app-shell.tsx` (the bell after the last `StatusBarHint`,
`:741`); `R/lib/shortcuts.ts` and `R/lib/shell-shortcuts.ts` (⇧⌘B);
`R/components/command-palette.tsx` ("Open notifications"); new
`R/lib/notifications/sources/watchdog.ts`; `R/hooks/use-studio.tsx` (hand
the alert list to the source, next to `:5805`);
`scripts/check-renderer-asset-budget.mjs` only if D12 a.
**Steps:**

1. Add the icon slot, drawing only the weights used. Run `pnpm icons:build`
   if the pipeline asks, and update the count in `docs/icon-set.md`.
2. `notification-count.ts` and `notify.ts`, as small as they can be. The
   store writes the count; the bell reads it with `useSyncExternalStore`.
3. The bell: `StatusBarAction` as the `PopoverTrigger`'s `render`, the
   number in primary text, the icon's tone from the count store,
   `ShortcutTooltip`, the screen-reader name, the two live-region lines.
4. The list and the entry, as drawn in "What it looks like": `Popover`
   (`border glass-float`), `ScrollArea`, `SectionLabel`, hairlines, `Button`
   `xs`, `Empty`, `StatusDot`, `Spinner`. No new primitive. It closes on a
   workspace navigation event, like `AccountMenu`
   (`R/components/account-menu.tsx:74–92`).
5. Keyboard: the shortcut, roving ↑ and ↓, ↵, ⌫ and Delete, Esc, focus back
   to the bell.
6. `sources/watchdog.ts`: each open alert becomes an entry on its subject
   key (table in "One entry per subject"); its fixes are the actions,
   through `runWatchdogFix`; Clear is `acknowledgeWatchdogAlert`; mic-muted's
   second button is "I meant to" (`snoozeWatchdogAlert(…, 'stream')`); a
   cleared alert resolves the entry, a withdrawn one removes it.
7. Tests: the bell's four states; an entry's anatomy for each tone; the
   keyboard walk; the watchdog mapping. Extend `icons.test.ts` if the slot
   needs a line there.

**Done when:** in the dev app on an isolated profile, a session with the
microphone muted past the watchdog's limit shows the bell in the warning
tone with "1"; opening it shows one entry with Unmute and "I meant to";
Unmute resolves it; the list is reachable and walkable by keyboard alone;
`pnpm check:renderer-assets` passes at the agreed ceiling; `pane.test.ts`
and `sidebar.test.ts` pass unchanged.
**Extra gates:** `pnpm ui:check`; by eye in light and dark.
**Out of scope:** changing or removing any toast; the Stream Manager;
quiet.

### Slice S3: quiet while recording or live

**Owner route:** UI/Product Design (fit 9). **Model lane:** `fable-5.1`
(it changes two written owner rules about toasts).
**Goal:** the pop-up rule exists, the watchdog obeys it, and the setting
has its home. From here a watchdog alert is one entry, and it pops up only
when urgent.
**Depends on:** S2; D2, D3, D4, D5 answered.
**Touches:** new `R/lib/notifications/pop-up.ts`;
`R/lib/watchdog-surface.ts` (`:127–183`: the toasts go, the system
notification asks stay); `R/lib/capture.ts` (`SettingsState.quietWhileLive`);
`R/components/settings/general-settings.tsx` (a Notifications section);
`notification-center.tsx` (the footer line and its link);
`R/renderer-toast-guards.test.ts`; `.claude/skills/videorc-design/SKILL.md`
("Toast discipline", "Where things live", the mapping table),
`docs/ui-copy.md` (Toasts), `CONTEXT.md` (Notifications).
**Steps:**

1. `pop-up.ts`: subscribe to the store; for each change ask
   `popUpDecision`; show through `lib/toast.ts` with id
   `notification:<key>`, 15 s for urgent and 8 s otherwise; close-by-hand
   and the action mark the entry read; a resolve dismisses or replaces it.
   Nothing while the list is open.
2. Remove the direct toasts from `onWatchdogAlertsChanged`. Keep
   `askMain`, the 60 s second ask and `runWatchdogFix` exactly as they are.
3. The setting, its row ("Quiet while recording or live" · "Only urgent
   problems pop up. Everything else waits in Notifications."), and the
   footer line that reads it.
4. The guard: no pinned toast outside the named list.
5. The three documents, in this PR.

**Done when:** tests pin the "What pops up" table through `pop-up.ts` with
a fake toast door; with quiet on and a session running, a `warning` alert
raises the number and shows no toast, and a `critical` alert shows one
toast for 15 s once; with quiet off both show; the watchdog's system
notification still fires when the Studio is not in front (its existing
tests pass unchanged).
**Extra gates:** by eye in light and dark, idle and with a recording
running.
**Out of scope:** health events, destinations, every other toast.

### Slice S4: doors

**Owner route:** Implementation (fit 8). **Model lane:** `gpt-6.1-sol`.
**Goal:** every place an entry points at can be opened from outside React.
**Depends on:** none.
**Touches:** `R/lib/workspace-navigation.ts`, `R/components/workspace-nav.tsx`,
`R/components/app-shell.tsx` (`:254–260`, `:506–518`, `:547–553`); new
`R/lib/section-focus.ts`; `R/lib/cloud-section-focus.ts` (becomes a caller
of it); the sections that take a focus request.
**Steps:**

1. Library: `openWorkspaceTab('library', sessionId)` keeps the id. Today
   `setActive` clears `libraryFocusSessionId` (`app-shell.tsx:257`).
2. Destinations: `openWorkspaceTab('live', 'setup')` plus a destination id
   opens that card, through the same `destinationToOpen` the IPC path
   sets (`app-shell.tsx:547–553`).
3. `section-focus.ts`: `requestSectionFocus(id)` and
   `takeSectionFocus(id)`, the pattern of `cloud-section-focus.ts` for many
   sections (a flag the section takes on mount, and an event for a page
   already open). No imports, like the original.
4. Sections that take it: Studio's Audio group
   (`R/components/studio/audio-section.tsx:250`), Sources' Microphone and
   System audio (`R/components/sources/sources-audio-mixer.tsx:454`, `:765`),
   Output's "Where recordings go", Clips and Videorc Camera
   (`R/components/tabs/recording-tab.tsx:532`, `:82`;
   `videorc-camera-section.tsx:61`), Settings → General's Notifications.
   Each scrolls itself into view and moves focus to its first control.

**Done when:** a test per door: the event opens the page, the section
takes the request once, and a second mount does not scroll again; "Open in
Library" from the existing "Recording saved" toast lands on that
recording.
**Out of scope:** the notification code. No entry uses these yet.

### Slice S5: the session's health events

**Owner route:** Implementation (fit 8). **Model lane:** `fable-5.1`
(what a streamer is told while live; high rigor).
**Goal:** every `health` event that toasts today is an entry instead. The
microphone and "This computer is overloaded" stop popping up mid-stream.
**Depends on:** S3, S4.
**Touches:** new `R/lib/notifications/health-kinds.ts`,
`sources/health.ts`; `R/lib/notifications/kinds.ts`;
`R/lib/session-runtime-recovery.ts` (`showSessionHealthEvent` `:485`,
`showLiveOutputNews` `:543`, `showSessionAudioNews` `:661`,
`showMicrophoneLoss` `:261`, `showRecordingFailure` `:172`,
`showSeparateFileFailed` `:328`, the shed notice `:356`,
`showSourceFallbackActiveSession` `:777`, `showSessionFinished` `:441`);
`R/lib/studio-health.ts` (`recordingStartupHealthToast`);
`R/hooks/use-studio.tsx` (`:8724–8830`, `:5531–5592`);
`scripts/smoke-system-audio-app.mjs`, `scripts/smoke-record-latency-app.mjs`
(they read toasts); new `scripts/lib/notifications-smoke.mjs`.
**Steps:**

1. `health-kinds.ts`: one row per code from the inventory's "Live output
   and the connection" and "Audio" tables, with its subject key and
   effect. Add `recording-disk-full` (urgent, Open Output): it has no
   notice of its own today. `stream-dropped-frames`,
   `live-background-gpu-budget` and every `watchdog-*` code are `ignore`,
   by name.
2. `sources/health.ts`: `publishHealthEvent(event, context)` keeps the
   guards the call site has today (the session epoch, the session id, the
   `recording-degraded` active-only rule, `use-studio.tsx:8796–8812`).
3. The start-failure toast (`recording-startup-barrier-timeout` at `error`)
   stays a toast: it answers Record.
4. `sessionEnded(sessionId)` from `showSessionFinished`; "Recording saved"
   itself moves in S7.
5. `scripts/lib/notifications-smoke.mjs`: `readNotifications(page)` opens
   the list, reads `[data-notification-key]` rows and the bell's
   `data-videorc-notification-count`, and closes it. The two smokes read
   through it where they read a toast that moved.
6. Tests: a table of every old code → the entry it makes, and a test that
   no code handled before S5 is missing from `health-kinds.ts`.

**Done when:** that table passes; with a session running and quiet on,
`mic-silent` then `microphone-signal-recovered` leave one resolved entry
and no toast; `stream-output-failed` shows one 15 s toast and an urgent
entry; `pnpm smoke:system-audio` and `pnpm smoke:record-latency` pass.
**Out of scope:** new backend codes (S9); destinations (S6).

### Slice S6: destinations, platforms and Videorc Cloud

**Owner route:** Implementation (fit 8). **Model lane:** `gpt-6.1-sol`.
**Goal:** a destination, a chat connection, a platform step and the cloud
status are each one entry.
**Depends on:** S3, S4.
**Touches:** `R/lib/studio-toasts.ts` (`showStreamTargetNotice` `:74`);
`R/lib/stream-target-notices.ts`; `R/lib/studio-connection-toasts.ts`
(`:29`, `:37`, `:44`, `:77`, `:90`); `R/lib/youtube-thumbnail-toast.ts`;
`R/lib/cloud-notices.ts` (`toastCloudStatus` `:46–67`, `:187`, `:196`);
`R/hooks/use-talk-show-room.ts:215`; `R/hooks/use-studio.tsx` (`:3343`,
`:5140`, `:7794`, `:16678`, `:19456`); `R/lib/session-runtime-recovery.ts`
(`:58`, `:76`, `:91`, `:371–382`); new `sources/stream-targets.ts`,
`sources/cloud.ts`, `sources/platforms.ts`; the smokes that read these
toasts: `scripts/smoke-youtube-quota-app.mjs:582`,
`scripts/lib/cloud-managed-smoke.mjs:470–481`,
`scripts/smoke-cloud-solo-managed-app.mjs:66`, `:466`,
`scripts/smoke-cloud-talk-show-managed-app.mjs:437`.
**Steps:**

1. Destinations: `streamTargetNotices` stays pure; its result publishes or
   resolves `stream-target:<id>`. Urgent when no other destination is on
   air (`otherDestinationsOnAir`), else warning. Merge with the watchdog's
   `destination-down` on the same key.
2. Chat, X, YouTube, Discord, the thumbnail and the stream-key notice, per
   the inventory. The browser-approval step and "Connected {platform}" stay
   toasts: they answer Connect.
3. Cloud: one `cloud-status` condition updated in place; the allowance,
   the announcement and the take-over as their own entries.
4. The smokes read entries through `notifications-smoke.mjs`.

**Done when:** a table test per source; a destination that fails,
reconnects and returns is one entry that ends resolved;
`pnpm smoke:youtube-quota` passes with "one paused notice" read from the
list; `pnpm smoke:cloud-solo` and `pnpm smoke:cloud-talk-show` pass (they
need `VIDEORC_CLOUD_DIR`; if the runner checkout is not available, say so
and run their unit tests).
**Out of scope:** the Stream Manager's Activity rows for destinations.

### Slice S7: devices, the app and finished work

**Owner route:** Implementation (fit 8). **Model lane:** `gpt-6.1-sol`.
**Goal:** the rest of the unprompted toasts are entries: devices, the
app's own state, and work that finishes out of view.
**Depends on:** S3, S4.
**Touches:** `R/hooks/use-studio.tsx` (`:9314`, `:11137`, `:12508`,
`:13324`, `:13349`, `:19279`); `R/hooks/use-virtual-camera.ts:87`;
`R/lib/global-shortcuts.ts` (`:215`, `:227`, `:243`);
`R/lib/replay-buffer.ts` (`:62`, `:74`, `:122`, `:130`);
`R/lib/finalization-toast.ts`; `R/lib/clean-cut-notify.ts:78`;
`R/lib/clean-cut-auto.ts:231`; `R/lib/cloud-recording-downloads.ts`
(`:69`, `:76`); `R/lib/agent-notices.ts:32`; `R/lib/sound-monitor.ts:114`;
`R/lib/session-runtime-recovery.ts` (`:271–290`, `:315`, `:478`, `:707`);
new `sources/app.ts`, `sources/work.ts`;
`scripts/smoke-agent-mcp-app.mjs:920`, `scripts/smoke-first-run-app.mjs:175`,
`scripts/smoke-smart-scenes-app.mjs:1479`.
**Steps:**

1. Work: the MP4 export is a `progress` entry that turns done or failed;
   "Recording saved", noise cleanup, clean cut and cloud downloads are done
   entries with today's buttons.
2. Clips: "Clip saved" and "Couldn't save the clip" are entries marked
   `answersAPress` (a 4 s toast too); "Clips stopped" and "Clips couldn't
   start" are one `clips` condition.
3. Devices: "{device} is back" is a condition with Use it; Videorc Camera;
   global shortcuts.
4. The app: `backend:lifecycle` and the backend `error` event; the notes
   and Stream Manager "closed for this recording" notices; the preview
   lag; the too-heavy output; agent notices.
5. The three smokes read entries where they read a toast that moved.

**Done when:** a table test per source; an MP4 export shows one entry that
goes from a spinner to "MP4 ready · Show in Finder" with no pinned toast;
`pnpm smoke:agent-mcp`, `pnpm smoke:first-run` and `pnpm smoke:smart-scenes`
pass (smart-scenes SKIPs naming a missing grant, never silently).
**Out of scope:** prompted toasts (the 212). Sidekick's nudges (D11).

### Slice S8: the Stream Manager's bell

**Owner route:** UI/Product Design (fit 9). **Model lane:** `opus-5.5`.
Read the design skill's "Stream Manager" section first.
**Goal:** the same bell and list in the Stream Manager, and an urgent
pop-up shows in the window you are in.
**Depends on:** S3; D9 a.
**Touches:** `shared/live-dashboard.ts`, `R/lib/live-dashboard-relay.ts`
(the snapshot rides the dashboard); `shared/electron-ipc-contract.ts`,
`preload/index.ts`, `main/index.ts` (next to `:19390`: the
`comments-window:notification-act` channel, and where an urgent pop-up
goes); `R/components/stream-manager/stream-manager-status-bar.tsx` (the
bell, and its row in the ⋯ menu below 640 px); `renderer/comments/main.tsx`;
`R/lib/notifications/pop-up.ts`.
**Steps:**

1. The snapshot (plain entries, no functions) on the dashboard push; the
   Stream Manager's count and list read it.
2. `comments-window:notification-act` with `{ key, id }`, and the same for
   Clear and Clear all: main checks the sender is the Stream Manager, as
   `comments-window:watchdog-fix` does, forwards to the main window, and
   for a door shows and focuses the main window first.
3. The bell as the status bar's last control: a 22 px chip. Below 640 px,
   "Notifications (2)" in the ⋯ menu.
4. The pop-up's window: main answers which window is focused.

**Done when:** with the Stream Manager in front and a session live, an
urgent entry pops up there and not in the main window; its bell shows the
same number as the main window's; Unmute pressed there unmutes; Open
Destinations brings the main window forward on the right card;
`pnpm probe:comments-window` passes at all six widths.
**Extra gates:** `pnpm smoke:local-gates` is not needed; by eye at 640,
800 and 1,040 px in light and dark.
**Out of scope:** the Captions reader, Notes, the phone, Stream Deck.

### Slice S9: clear signals and the rebuild on reconnect

**Owner route:** Implementation (fit 8). **Model lane:** `fable-5.1`
(it touches the live session's monitor in Rust).
**Goal:** the two conditions that open and never close get a clear signal,
and a reload mid-stream rebuilds the list.
**Depends on:** S5.
**Touches:** `crates/videorc-backend/src/host_pressure.rs` (`:119–166`),
`crates/videorc-backend/src/encoder_bridge.rs` (`:9938–9948`),
`crates/videorc-backend/src/disk_space.rs`,
`crates/videorc-backend/src/recording.rs` (`:6645–6660`, `:30966–30992`);
`R/lib/notifications/health-kinds.ts`, `sources/health.ts`;
`R/hooks/use-studio.tsx` (the connect effect near `:5776`).
**Steps:**

1. `host-overloaded` fires when the overload starts, not once per session,
   and `host-overload-cleared` fires after the load has stayed under 1.5
   per core for 30 s. One pair per episode.
2. `disk-space-low` is checked every 60 s while a session records, not
   once at the start, and `disk-space-recovered` fires when space is back
   over the line with the same margin.
3. Check `watchdog::observe_health_event` (`recording.rs:31007`) ignores
   the two new codes.
4. Renderer: both codes resolve their entries. On connect with a session
   running, ask `sessions.healthEvents.list` for it once and fold the page
   through `health-kinds.ts`.

**Done when:** Rust unit tests cover open, clear and open again for both;
a renderer test folds a recorded page of events into the right open
entries; `cargo fmt --check --all`, the two clippy commands from
`AGENTS.md`, `cargo test -p videorc-backend host_pressure` and
`disk_space`, and `pnpm smoke:record-latency` pass. One backend cargo job
at a time, through `pnpm cargo:slot`.
**Out of scope:** any new field, event or RPC. A Windows processor-queue
sample for `host-overloaded`.

### Slice S10: sweep, guards and acceptance

**Owner route:** Review (fit 9). **Model lane:** `fable-5.1`.
**Goal:** nothing unprompted can toast around the store again, and the
whole thing is checked on a real session.
**Depends on:** S1 to S9.
**Touches:** `R/renderer-toast-guards.test.ts`;
`R/lib/session-runtime-recovery.ts` and `R/lib/notify-once.ts` (dead code);
the three documents; `docs/acceptance/`.
**Steps:**

1. The guard: the unprompted modules call no `toast.*`; the pinned-toast
   list is final.
2. Delete what nothing calls any more. Re-run the inventory script from
   this plan's method and record the new numbers here.
3. `pnpm smoke:local-gates` once.
4. The by-eye list below, on an isolated profile, with a local RTMP sink,
   never a real channel. A private live test only if the owner asks for one
   (`AGENTS.md` "Live Tests On YouTube").

**Done when:** the guard fails on a planted `toast.warning` in
`sources/health.ts`; the by-eye list is ticked with screenshots in both
themes; the plan's status says what the 317 became.
**Out of scope:** new features.

## Risks

1. **Quiet hides something the streamer needed.** The whole point is fewer
   interruptions, so the cost of a wrong tone is a missed problem. Held by:
   the urgent list written in one table with a test per row; the Session
   panel's cards staying (D7); plan 223's system notification staying; the
   bell's red tone lasting as long as the problem does.
2. **The eager budget.** Under 100 bytes of gzip are free
   (`scripts/check-renderer-asset-budget.mjs:166–178`). The bell is in the
   first paint. S2 cannot land without D12. Known costs from earlier work:
   a Phosphor glyph module ships six weights (about 620 B) unless drawn
   through `IconBase`; a component defined inside `icons.tsx` drags the
   whole registry eager; each new lazy chunk adds its name to
   `__vite__mapDeps`.
3. **Two systems, one subject.** Merging the watchdog's alerts with
   `health` events and `stream.targets` on one key is where a double entry
   or a stuck entry would come from. Held by `policy.ts`'s table tests and
   by ignoring the `watchdog-*` history codes by name.
4. **Edge events are lost on a reload.** `health` events are sent once. S9
   rebuilds from the session's stored events, but only the last 120; a
   session that logged more since a problem opened would miss it until the
   next report. The watchdog's list, the destinations and the cloud status
   are full snapshots and are not affected.
5. **Conditions with no clear signal.** `recording-degraded`,
   `system-audio-echo-paused` (cleared by the Resume press) and the startup
   notices never say they ended. They resolve when the session ends. S9
   fixes the two that matter most on the owner's Mac: `host-overloaded` and
   `disk-space-low`.
6. **Smokes read toasts.** Ten scripts query `[data-sonner-toast]`
   (`smoke-youtube-quota-app`, `smoke-cloud-solo-managed-app`,
   `smoke-cloud-talk-show-managed-app`, `smoke-agent-mcp-app`,
   `smoke-first-run-app`, `smoke-record-latency-app`,
   `smoke-system-audio-app`, `smoke-smart-scenes-app`,
   `lib/cloud-managed-smoke`, `live-lab/lib/ui-driver`). Each slice that
   moves a toast a smoke reads updates that smoke in the same PR (named in
   S5 to S7). `smoke-comment-highlight-stream-app` reads an Undo toast,
   which stays.
7. **`use-studio.tsx` is 20,000 lines and many branches touch it.** Plan
   249's slices and the perf PRs are open against it. Each slice here keeps
   its edit there to swapping one call for another, with the logic in the
   lazy modules.
8. **The store lives in the main window.** A main-window reload empties the
   Stream Manager's bell until the next dashboard push. S8 checks what the
   Stream Manager shows while the main window reloads.
9. **Toasts and the open list share a corner** (D1 a). `pop-up.ts` shows
   nothing while the list is open; check by eye that a prompted toast over
   the open list is still readable and closable.
10. **Screen readers.** A list that updates every second (the watchdog's
    clock) must not re-announce. Only an entry's first appearance and a
    tone change speak; the clock is `aria-hidden` text.
11. **Owner rules being changed.** Pinned toasts and "warnings always
    surface" are written in the design skill. D2 and D7 ask before S3
    rewrites them.
12. **The icon set's count.** One more glyph: 93 of the 100 the set may
    hold (`docs/icon-set.md:24`, `:105`).

## What needs a by-eye check

Light and dark for every row (owner, 2026-10-11: never dark only).

- The bell's four states in the status bar, next to the hints, at the
  window's narrowest width. Is the number readable? Is the amber and the
  red distinct from the gray without looking loud?
- The list: 0, 1, 9+ and 50 entries; a long title; a three-line detail
  cut to two; the scroll; the Now and Earlier labels; the unread dot.
- The `default` `xs` button in the popup tier in both themes.
- Live: start a session to a local RTMP sink, then mute the microphone,
  pull the network, unplug the camera, and stop the sink. One entry per
  subject, one 15 s toast for the urgent ones, the count right, the
  entries resolving on their own.
- Idle: stop, export an MP4, save a clip. Short toasts, entries with
  working buttons, nothing pinned.
- Every door lands on the right section and focuses its first control.
- The keyboard walk, with VoiceOver on once.
- Increase Contrast and Reduce Motion.
- The Stream Manager at 640, 800 and 1,040 px, and its ⋯ menu below 640.
- A toast over the open list.
- Windows: the status bar and Ctrl+Shift+B. Nobody on the team has a
  Windows PC, so this row goes to a contributor's run after the merge
  (owner, 2026-11-16).
- A real private stream, only on the owner's go: one hour with quiet on,
  and the owner's own count of what interrupted.

## Also seen, not in this plan

- **A guest asking to join has no notice of its own.** `cloud.room.requests`
  has no subscriber (requests are read from `cloud.state.room.requests`,
  `lib/guests-view.ts:125`). "{name} wants to join · Open Guests" would be a
  natural entry. It belongs to plan 224's owner.
- **`stream-dropped-frames` and `live-background-gpu-budget`** raise no
  notice today. They stay that way: the delivery state and the still line
  on the Assets page cover them.
- **MCP's `get_status`** returns warnings but not the watchdog's alerts
  (`agent_look.rs:404–430`). An agent that could read the list would need
  an allowlisted projection and a leak argument (`docs/agents-mcp.md`).
- **Sidekick could read the list aloud** ("what's wrong?"). After D11.
- **The update chip** in the sidebar and main's "update ready" system
  notification (`main/updater.ts:378`) are not notifications in this sense
  and do not move.
- **A Dock or taskbar badge.** Not found anywhere in main today; not added.
- **Clipping** (`audio.levels.masterClippedSamples`) raises no notice
  today. The brief names it; the meter shows it. A "Microphone is
  clipping" condition would be a new backend check, best made a watchdog
  check by plan 223's owner.

## Handoff

- **Goal:** Notifications behind a bell, quiet while recording or live,
  with 91 of the 97 unprompted toasts routed through it, in ten slices.
- **State:** this plan only, on branch `plan/notification-center` in
  `~/projects/videorc-wt-notifications`, uncommitted. Nothing is built.
  Facts are from `origin/main` `fe53fde02`. The inventory was made with the
  scripts in `~/notifications-plan-scratch/` (`extract.py`, `prompted.py`);
  re-run them before S5, because line numbers in `use-studio.tsx` move
  daily.
- **Owner route, lane, fit:** the orchestrator owns the plan (fit 10,
  `fable-5.1`); each slice names its own route and lane.
- **Before any slice:** D1 to D13 answered, or "start" for the recommended
  ones. D12 (the budget) blocks S2.
- **Order:** S1, S2, S3, then S5 to S7 one after another; S4 beside S1 to
  S3; S8 after S3; S9 after S5; S10 last. Each in its own worktree from
  `origin/main`, never the shared checkout.
- **Out of scope:** the phone remote, Stream Deck, MCP, the /live page,
  system notification rules, Sidekick's nudges, the Rust UI.
- **Known blockers:** the eager budget (D12); `smoke:cloud-solo` and
  `smoke:cloud-talk-show` need the private runner checkout
  (`VIDEORC_CLOUD_DIR`); no Windows machine for the by-eye row.
- **Cleanup:** remove `~/projects/videorc-wt-notifications` with
  `git worktree remove` once this plan is on main.
