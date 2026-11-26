# GPUI parity list

The checklist the GPUI app must pass before anyone switches (plan 260,
[What parity means](../../plans/260-gpui-rewrite.md#what-parity-means)):
one line per control of today's Electron app, and a column per platform.
Generated from the code by plan 260 slice S0.11 on `origin/main`
`0b32fb218` (2026-11-23); each screen slice ticks its lines on each
platform, and S5.0 regenerates the list before the switch.

## How to read it

- **A line passes on a platform** when the control works there as it does
  in Electron today: by eye in dark, light and the platform's high-contrast
  mode (Increase Contrast, Windows contrast themes, the desktop's
  high-contrast theme), with byte-identical strings, reachable by keyboard,
  named for the platform's screen reader (VoiceOver, Narrator, Orca), and
  with its smokes green with `VIDEORC_APP=gpui`.
- **Cells:** `[ ]` to do, `[x]` passed (with the PR that proved it in the
  screen slice's PR description), `n/a` Electron does not have it on that
  platform today, so it is not a row there (the reason is in the
  description), `dev` development builds only, not a parity line.
- **`Source`** points at where Electron builds the control today, relative
  to `apps/desktop/src/` (`renderer/` is `apps/desktop/src/renderer/src/`).
  Line numbers are from `0b32fb218` and drift; the file is the anchor.
- **Quoted text** is the visible label as Electron shows it. Where a
  description says "per platform", the strings differ by platform on
  purpose (for example "Show in Finder" and "Show in Explorer"); the GPUI
  app keeps the same split.
- **IDs** (`P001`…) are stable for this generation. A screen slice cites
  them ("ticks P412–P437 on macOS"). S5.0's regeneration keeps the IDs of
  lines that still exist and adds new ones after the last.
- **Checker:** `node scripts/gpui-parity.mjs check` names any malformed
  row, duplicate ID, unknown cell, out-of-date Counts table or Source file
  Electron no longer has, and `pnpm test:scripts` runs it; `stats` prints
  done/lines per area and platform. A slice that ticks lines runs both.
- **Windows** contributors: the Windows column is yours, together with the
  [Windows-only lines](#windows-only-lines) at the end, which are the
  [Windows testing plan's checklist](../../plans/260-gpui-rewrite-windows-testing.md#windows-parity-checklist).
  Send evidence as that plan's "Sending evidence" says.

## Counts

| | Lines | macOS | Windows | Linux |
| --- | ---: | ---: | ---: | ---: |
| Controls (P lines) | 1,559 | 1,521 | 1,470 | 1,478 |
| Windows-only lines (W lines) | 14 | | 14 | |

Not counted as lines: the backend's own behaviour (recording, streaming,
the compositor), which the smokes cover and Phase 1 keeps unchanged.

## Shell

### Shell: sidebar (zones, rows, page keys)

The page keys come from `assignPageKeys` (shared/sidebar-pages.ts:129). Fixed keys are G, S, 0 and `,` (line 110). The digits 1–9 go to the other rows in order. ⌘ is the command key on macOS and Ctrl elsewhere (renderer/lib/platform.ts:103).

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P001 | Sidebar layout (zones) | Studio slab; Setup, Livestream, Assets groups; Library and Settings at foot | `shared/sidebar-pages.ts:45` | [ ] | [ ] | [ ] |
| P002 | Zone label "Setup" / "Livestream" / "Assets" | Section label above each labelled group | `renderer/components/sidebar.tsx:391` | [ ] | [ ] | [ ] |
| P003 | Row "Studio" (⌘1) | Big chrome row, goes home; shows session clock while live | `renderer/components/sidebar.tsx:375` | [ ] | [ ] | [ ] |
| P004 | Studio row session clock | Live dot and elapsed time while recording or on air | `renderer/components/sidebar.tsx:382` | [ ] | [ ] | [ ] |
| P005 | Row "Sources" (⌘2) | Opens Sources page | `shared/sidebar-pages.ts:47` | [ ] | [ ] | [ ] |
| P006 | Row "Scene" (⌘3) (id `layouts`) | Opens Scene page | `shared/sidebar-pages.ts:57` | [ ] | [ ] | [ ] |
| P007 | Row "Captions" (⌘4) | Opens Captions page | `shared/sidebar-pages.ts:58` | [ ] | [ ] | [ ] |
| P008 | Row "Output" (⌘5) (id `recording`) | Opens Output page | `shared/sidebar-pages.ts:59` | [ ] | [ ] | [ ] |
| P009 | Row "Destinations" (⌘6) (id `live`) | Opens Destinations page | `shared/sidebar-pages.ts:60` | [ ] | [ ] | [ ] |
| P010 | Row "Guests" (⌘7) | Opens Guests; shown only when cloud talk shows are available | `renderer/components/sidebar.tsx:254` | [ ] | [ ] | [ ] |
| P011 | Row "Avatar" (⌘8) | Opens Avatar page | `shared/sidebar-pages.ts:62` | [ ] | [ ] | [ ] |
| P012 | Row "Sidekick" (⌘9) (id `ai`) | Opens Sidekick page | `shared/sidebar-pages.ts:63` | [ ] | [ ] | [ ] |
| P013 | Row "Images" (⇧⌘G) (id `assets`) | Opens Images page | `shared/sidebar-pages.ts:111` | [ ] | [ ] | [ ] |
| P014 | Row "Sounds" (⇧⌘S) | Opens Sounds page | `shared/sidebar-pages.ts:112` | [ ] | [ ] | [ ] |
| P015 | Row "Library" (⌘0) | Opens Library; sits in the bottom block | `shared/sidebar-pages.ts:113` | [ ] | [ ] | [ ] |
| P016 | Row "Settings" (⌘,) | Opens Settings; bottom block | `shared/sidebar-pages.ts:114` | [ ] | [ ] | [ ] |
| P017 | Row shortcut chips | Key chips appear on rows while ⌘/Ctrl is held | `renderer/components/sidebar.tsx:298` | [ ] | [ ] | [ ] |
| P018 | Page-key routing | Main catches page chords in every window, forwards `shortcut:navigate` | `main/index.ts:3141` | [ ] | [ ] | [ ] |
| P019 | Sidebar "Search" icon button (⌘K) | Opens command palette | `renderer/components/sidebar.tsx:344` | [ ] | [ ] | [ ] |
| P020 | Traffic-light gutter (88 px) | Header leaves room for the window buttons *(macOS only (window-frame.tsx:42))* | `renderer/components/window-frame.tsx:36` | [ ] | n/a | n/a |
| P021 | Update chip "Update available" / "Downloading… N%" / "Restart to update" / "Update after stop" | Installs if downloaded and idle, otherwise opens Settings → About *("Update available" on Linux links to videorc.com (update-ui.ts:40))* | `renderer/components/sidebar.tsx:407 (labels renderer/lib/update-ui.ts:30)` | [ ] | [ ] | [ ] |
| P022 | Theme toggle (D) "Toggle color theme" | Switches light/dark; tooltip "Switch to light/dark theme" | `renderer/components/theme-toggle.tsx:42` | [ ] | [ ] | [ ] |
| P023 | Health page (no row) | Reachable from ⌘K, the status bar and the account menu | `renderer/components/sidebar.tsx:399` | [ ] | [ ] | [ ] |

### Shell: account row and menu

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P024 | Account trigger (avatar or icon + name / "Sign in") | Opens the account menu; ↑/↓ also open it | `renderer/components/account-menu-trigger.tsx:29; account-menu.tsx:180` | [ ] | [ ] | [ ] |
| P025 | Needs-sign-in dot | Warning dot while chat or Sidekick waits on a Videorc sign-in | `renderer/components/account-menu-trigger.tsx:38` | [ ] | [ ] | [ ] |
| P026 | Menu header (name / "Not signed in") | Avatar and display name | `renderer/components/account-menu-body.tsx:140` | [ ] | [ ] | [ ] |
| P027 | Plan badge "Basic" / "Premium" / "Max" / "Developer" | Shows entitlement tier | `renderer/components/account-menu-body.tsx:149; renderer/lib/account.ts:56` | [ ] | [ ] | [ ] |
| P028 | "Account" | Opens the web account page (signed in) | `renderer/components/account-menu-body.tsx:155` | [ ] | [ ] | [ ] |
| P029 | "Sign in" | Starts Videorc sign-in (signed out) | `renderer/components/account-menu-body.tsx:160` | [ ] | [ ] | [ ] |
| P030 | "View Premium" | Opens the Premium web page | `renderer/components/account-menu-body.tsx:165` | [ ] | [ ] | [ ] |
| P031 | "Health" (with status dot) | Opens Health page | `renderer/components/account-menu-body.tsx:172` | [ ] | [ ] | [ ] |
| P032 | "Settings" | Opens Settings | `renderer/components/account-menu-body.tsx:179` | [ ] | [ ] | [ ] |
| P033 | "Sign out" | Signs out; disabled while recording or live | `renderer/components/account-menu-body.tsx:187` | [ ] | [ ] | [ ] |
| P034 | "Sign out is locked while you're recording or live." | Reason line under the disabled Sign out | `renderer/components/account-menu-body.tsx:193` | [ ] | [ ] | [ ] |
| P035 | Toast "Couldn't open the account menu" | Shown when the lazy menu chunk fails to load | `renderer/components/account-menu.tsx:128` | [ ] | [ ] | [ ] |

### Shell: status bar and bell

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P036 | Session state ("Ready", "Recording", "On air", "· Rec", clock) | Session words and elapsed time; click opens Health | `renderer/components/status-bar-session.tsx:53` | [ ] | [ ] | [ ] |
| P037 | Tooltip "Open Health" | Tooltip on the state button | `renderer/components/status-bar-session.tsx:71` | [ ] | [ ] | [ ] |
| P038 | "Search" hint (⌘K) | Opens command palette | `renderer/components/app-shell.tsx:736` | [ ] | [ ] | [ ] |
| P039 | "Preview" hint (⌘P), pressed when open | Toggles Preview window | `renderer/components/app-shell.tsx:741` | [ ] | [ ] | [ ] |
| P040 | "Notes" hint (⇧⌘N), pressed when open | Toggles Notes window; hidden if VIDEORC_NOTES_WINDOW=0 | `renderer/components/app-shell.tsx:750` | [ ] | [ ] | [ ] |
| P041 | "Stream Manager" hint (⇧⌘J), pressed when open | Toggles Stream Manager; hidden if VIDEORC_COMMENTS_WINDOW=0 | `renderer/components/app-shell.tsx:760` | [ ] | [ ] | [ ] |
| P042 | Bell (⇧⌘B), unread count text | Opens the notification centre popover; tooltip "Notifications" | `renderer/components/notifications/notification-bell.tsx:153; main-notification-bell.tsx:13` | [ ] | [ ] | [ ] |

### Shell: window frame, title bar, toolbar, tabs, shell keys

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P043 | Main window 1180×780 (min 960×660), title "Videorc" | Main window; its frame is not saved | `main/index.ts:3042` | [ ] | [ ] | [ ] |
| P044 | Hidden-inset title bar + traffic lights | Native buttons sit in the 40 px header band *(macOS only (window-glass.ts:268))* | `main/window-glass.ts:268` | [ ] | n/a | n/a |
| P045 | Mica backdrop | Windows 11 window material *(Windows only (window-glass.ts:147))* | `main/window-glass.ts:285` | n/a | [ ] | n/a |
| P046 | Native frame / title bar | OS draws the title bar *(Windows and Linux)* | `main/window-glass.ts:161` | n/a | [ ] | [ ] |
| P047 | Toolbar page title (h1, drag region) | Active page name; gets focus after keyboard navigation | `renderer/components/pane.tsx:21; app-shell.tsx:664` | [ ] | [ ] | [ ] |
| P048 | WindowHeader (aux windows) | Title, optional meta and controls; drag band | `renderer/components/window-frame.tsx:64` | [ ] | [ ] | [ ] |
| P049 | PageTabs strip | Shared pinned tab list pages use | `renderer/components/page-tabs.tsx:57` | [ ] | [ ] | [ ] |
| P050 | Page error panel "This page hit a problem" + "Try again" | Page crash stays inside the page | `renderer/components/page-error-panel.tsx:22; app-shell.tsx:676` | [ ] | [ ] | [ ] |
| P051 | ⌘K | Toggles Search; closes it from inside its dialog | `renderer/lib/shell-shortcuts.ts:57` | [ ] | [ ] | [ ] |
| P052 | ⌘P | Toggles Preview window | `renderer/lib/shell-shortcuts.ts:58` | [ ] | [ ] | [ ] |
| P053 | ⇧⌘N | Toggles Notes; also works from aux windows | `renderer/lib/shell-shortcuts.ts:52; main/index.ts:3716` | [ ] | [ ] | [ ] |
| P054 | ⌘J | Shows Stream Manager | `renderer/lib/shell-shortcuts.ts:61` | [ ] | [ ] | [ ] |
| P055 | ⇧⌘J | Toggles Stream Manager | `renderer/lib/shell-shortcuts.ts:53` | [x] | [ ] | [ ] |
| P056 | ⇧⌘C | Toggles Captions reader | `renderer/lib/shell-shortcuts.ts:54` | [ ] | [ ] | [ ] |
| P057 | ⇧⌘B | Toggles notification centre | `renderer/lib/shell-shortcuts.ts:51` | [ ] | [ ] | [ ] |
| P058 | ⌘/ | Opens Settings → Shortcuts | `renderer/lib/shell-shortcuts.ts:62` | [ ] | [ ] | [ ] |
| P059 | Space (Studio page) | Record / stop, or asks End livestream while live | `renderer/lib/shortcuts.ts:57` | [ ] | [ ] | [ ] |
| P060 | D | Toggle light/dark theme | `renderer/lib/shortcuts.ts:188` | [ ] | [ ] | [ ] |
| P061 | Modal gate | No shell chord fires while a dialog or menu is open | `renderer/lib/shell-shortcuts.ts:46` | [ ] | [ ] | [ ] |

### Health page (diagnostics-tab, cloud-program-health)

Ways in: ⌘K "Health" (command-palette.tsx:153), the status-bar state button, and the account menu "Health" row.

The native implementation and remaining verification are recorded in
[Health screen implementation](health-screen.md). Its cells stay unchecked
until the runtime, visual and accessibility checks above can run.

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P062 | Section "Checks" ("Is anything wrong right now?") | Verdict alert, warnings, check chips | `renderer/components/tabs/diagnostics-tab.tsx:223` | [x] | [ ] | [ ] |
| P063 | Verdict alert | Overall health in words | `renderer/components/tabs/diagnostics-tab.tsx:224` | [x] | [ ] | [ ] |
| P064 | Permission warning "{Name} needs permission" | Names a missing grant and when it was last asked | `renderer/components/tabs/diagnostics-tab.tsx:229` | [x] | [ ] | [ ] |
| P065 | Fix button ("Allow…", "Reopen Videorc", "Open System Settings…" / "Open Windows Settings…") | Runs the permission fix *(macOS and Windows)* | `renderer/components/tabs/diagnostics-tab.tsx:514; renderer/lib/system-access-view.ts:50` | [x] | [ ] | n/a |
| P066 | "Dismiss" (×) on a permission warning | Hides that warning | `renderer/components/tabs/diagnostics-tab.tsx:521` | [x] | [ ] | [ ] |
| P067 | Linux setup alerts (keyring / device groups / screen portal) | Says what to install; command text can be copied *(Linux only (hooks/use-linux-desktop-check.ts:22))* | `renderer/components/tabs/diagnostics-tab.tsx:239; renderer/components/linux-setup-alert.tsx:11` | n/a | n/a | [ ] |
| P068 | "Videorc's recorder isn't available" | Alert when FFmpeg is missing | `renderer/components/tabs/diagnostics-tab.tsx:243` | [x] | [ ] | [ ] |
| P069 | Check chips + "Show all checks (N)" / "Show fewer checks" | Expands the full check list | `renderer/components/tabs/diagnostics-tab.tsx:477` | [x] | [ ] | [ ] |
| P070 | Section "Cloud room" (In the room / Program pages / Outputs / Videorc Cloud) | Per-layer health while a cloud room is open | `renderer/components/tabs/cloud-program-health.tsx:80` | [x] | [ ] | [ ] |
| P071 | Section "Support bundle" + "Export support bundle" | Exports redacted logs and checks | `renderer/components/tabs/diagnostics-tab.tsx:261; support-bundle-button.tsx:19` | [x] | [ ] | [ ] |
| P072 | Collapsible "Technical details" | Expands the metric groups | `renderer/components/tabs/diagnostics-tab.tsx:541` | [x] | [ ] | [ ] |
| P073 | Group "Overview" | Recording and stream summary metrics | `renderer/components/tabs/diagnostics-tab.tsx:265` | [x] | [ ] | [ ] |
| P074 | Group "Start and stop" | Click→recording, timelines, slowest phases | `renderer/components/tabs/diagnostics-tab.tsx:268` | [x] | [ ] | [ ] |
| P075 | Group "App connection" | WebSocket transport metrics | `renderer/components/tabs/diagnostics-tab.tsx:302` | [x] | [ ] | [ ] |
| P076 | Group "Preview" | Preview path, FPS and latency metrics *("Metal p95" macOS only (diagnostics-tab.tsx:310); some rows hidden on Linux)* | `renderer/components/tabs/diagnostics-tab.tsx:307` | [x] | [ ] | [ ] |
| P077 | Group "Recording and encoder" | Encoder, bitrates, writer timings *(VT/Metal rows macOS only (diagnostics-tab.tsx:318))* | `renderer/components/tabs/diagnostics-tab.tsx:316` | [x] | [ ] | [ ] |
| P078 | Group "System and sources" + device warnings | Memory, processes, sources, device warnings | `renderer/components/tabs/diagnostics-tab.tsx:322` | [x] | [ ] | [ ] |
| P079 | Group "Videorc Camera" | Virtual-camera state, apps using it, frames *(hidden where the camera is hidden)* *(Windows: hidden until proven, plan 260 "What parity means")* | `renderer/components/tabs/diagnostics-tab.tsx:348` | [x] | n/a | [ ] |
| P080 | "Remove Videorc Camera" + confirm "Remove Videorc Camera?" | Turns the camera off and deactivates the system extension *(macOS only (diagnostics-tab.tsx:743))* | `renderer/components/tabs/diagnostics-tab.tsx:746` | [x] | n/a | n/a |
| P081 | Group "Pipeline" | Each recording stage's state, or "Nothing is recording." | `renderer/components/tabs/diagnostics-tab.tsx:354` | [x] | [ ] | [ ] |
| P082 | Group "Alerts" | Watchdog alert history for the session | `renderer/components/tabs/diagnostics-tab.tsx:382` | [x] | [ ] | [ ] |
| P083 | Group "Log of this recording" / "Log of the last recording" | Session log lines | `renderer/components/tabs/diagnostics-tab.tsx:398` | [x] | [ ] | [ ] |
| P084 | Group "App log" + last engine crash | App log tail and the last backend crash | `renderer/components/tabs/diagnostics-tab.tsx:424` | [x] | [ ] | [ ] |

### ⌘K command palette

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P085 | Input "Search commands…" / "No results found." | Filters commands | `renderer/components/command-palette.tsx:280` | [ ] | [ ] | [ ] |
| P086 | Footer (selected item + ↵) | Shows the selected action and its key | `renderer/components/command-palette.tsx:855` | [ ] | [ ] | [ ] |
| P087 | Group "Session": "Start recording" / "Go live…" / "Stop recording" / "End livestream" | Starts, or stops (End livestream asks first) | `renderer/components/command-palette.tsx:287` | [ ] | [ ] | [ ] |
| P088 | Session: "Hide screen" / "Show screen" | Toggles screen privacy (default Ctrl+Alt+H) | `renderer/components/command-palette.tsx:324` | [ ] | [ ] | [ ] |
| P089 | Session: camera background command | Cycles camera background effect | `renderer/components/command-palette.tsx:332` | [ ] | [ ] | [ ] |
| P090 | Session: green screen command | Toggles chroma key | `renderer/components/command-palette.tsx:343` | [ ] | [ ] | [ ] |
| P091 | Session: "Turn Videorc Camera on/off" | Toggles the virtual camera *(hidden where the camera is hidden)* *(Windows: hidden until proven, plan 260 "What parity means")* | `renderer/components/command-palette.tsx:360` | [ ] | n/a | [ ] |
| P092 | Session: "Mute microphone" / "Unmute microphone" | Toggles mic mute | `renderer/components/command-palette.tsx:383` | [ ] | [ ] | [ ] |
| P093 | Session: "Save a 30-second clip" / "Save a 1-minute clip" | Saves a clip; shown while live or replay is on | `renderer/components/command-palette.tsx:397` | [ ] | [ ] | [ ] |
| P094 | Session: "Stop agents" | Stops every agent action and turns Agents off | `renderer/components/command-palette.tsx:419` | [ ] | [ ] | [ ] |
| P095 | Group "Pages": every sidebar page + "Health" | Opens the page; shows its key *(Guests only with talk shows)* | `renderer/components/command-palette.tsx:441` | [ ] | [ ] | [ ] |
| P096 | Pages: "Edit scene", "Background settings" | Scene editor; Scene background panel | `renderer/components/command-palette.tsx:462` | [ ] | [ ] | [ ] |
| P097 | Pages: "Upcoming events", "Discord announcements" | Opens those Destinations views | `renderer/components/command-palette.tsx:493` | [ ] | [ ] | [ ] |
| P098 | Pages: "Open notifications" | Opens the bell's list | `renderer/components/command-palette.tsx:513` | [ ] | [ ] | [ ] |
| P099 | Group "Windows": "Open/Close Preview", "Notes", "Stream Manager", "Captions reader" | Toggles each window | `renderer/components/command-palette.tsx:527` | [ ] | [ ] | [ ] |
| P100 | Windows: "Hide Stream Manager from stream" / "Show Stream Manager on stream" | Toggles capture hiding for Stream Manager *(disabled on Linux ("This system cannot hide a window from screen capture.") (window-capture-protection.ts:64))* | `renderer/components/command-palette.tsx:578` | [ ] | [ ] | [ ] |
| P101 | Group "Scenes": "Add scene…", "Switch to {name}" | Adds a scene / applies a saved scene | `renderer/components/command-palette.tsx:617` | [ ] | [ ] | [ ] |
| P102 | Group "Banners": "Show/Hide banner: {name}", "Hide all banners" | Toggles banners | `renderer/components/command-palette.tsx:654` | [ ] | [ ] | [ ] |
| P103 | Group "Sounds": "Play sound: {name}", "Stop all sounds" | Plays a soundboard pad / stops all | `renderer/components/command-palette.tsx:690` | [ ] | [ ] | [ ] |
| P104 | Group "Avatar": "Profile", "Greetings" | Opens Avatar tabs | `renderer/components/command-palette.tsx:723` | [ ] | [ ] | [ ] |
| P105 | Group "Sidekick": "Overview", "Chat", "Community", "Voice", "Reports", "Clean cut" | Opens Sidekick tabs | `renderer/components/command-palette.tsx:742` | [ ] | [ ] | [ ] |
| P106 | Group "Settings": "General", "Permissions", "Shortcuts" (⌘/), "Remote", "About" | Opens Settings tabs | `renderer/components/command-palette.tsx:761` | [ ] | [ ] | [ ] |
| P107 | Settings: "Connect an agent…" | Settings → Remote with the connect dialog open | `renderer/components/command-palette.tsx:777` | [ ] | [ ] | [ ] |
| P108 | Settings: "Run setup again…" | Replays first-run setup; hidden during a session | `renderer/components/command-palette.tsx:794` | [ ] | [ ] | [ ] |
| P109 | Group "Appearance": "Light", "Dark", "System" (checked) | Sets the theme | `renderer/components/command-palette.tsx:808` | [ ] | [ ] | [ ] |
| P110 | Appearance: "Chat in Studio" (checked) | Toggles the studioChat setting | `renderer/components/command-palette.tsx:839` | [ ] | [ ] | [ ] |


## Studio ⌘1 and Sources ⌘2

### Studio page shell (studio-tab.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P111 | Space key | Records when idle; stops a recording; asks to end a livestream | `renderer/components/tabs/studio-tab.tsx:137` | [x] | [ ] | [ ] |
| P112 | Space yields | Ignored while a dialog, menu, focused control or repeat owns it | `renderer/lib/studio-space-shortcut.ts:1` | [x] | [ ] | [ ] |
| P113 | Responsive layout | Inspector sits beside preview from 720 px; narrower, transport leads | `renderer/components/tabs/studio-tab.tsx:185` | [x] | [ ] | [ ] |
| P114 | "Session inspector" aside | Holds cloud notice, Session, Chat, Audio, Sources, Takeover | `renderer/components/tabs/studio-tab.tsx:225` | [ ] | [ ] | [ ] |
| P115 | Retro LCD switch | Settings → General Retro LCD swaps every inspector section to LCD | `renderer/components/tabs/studio-tab.tsx:72` | [ ] | [ ] | [ ] |
| P116 | "Preview" section | Holds the preview stage; untitled when docked | `renderer/components/tabs/studio-tab.tsx:480` | [ ] | [ ] | [ ] |
| P117 | Preview health alert + "Retry preview" | Degraded preview error, with retry | `renderer/components/tabs/studio-tab.tsx:437` | [ ] | [ ] | [ ] |
| P118 | "Open Health" (preview alert) | Opens Health page | `renderer/components/tabs/studio-tab.tsx:449` | [ ] | [ ] | [ ] |
| P119 | Blocked jump "Open Destinations" | Go Live blocked: entitlement or destination not set up | `renderer/components/tabs/studio-tab.tsx:516` | [ ] | [ ] | [ ] |
| P120 | Blocked jump "Open Health" | Recorder (ffmpeg) unavailable blocks Record | `renderer/components/tabs/studio-tab.tsx:506` | [ ] | [ ] | [ ] |
| P121 | Loading skeletons | Scenes, Chat, Audio placeholders while chunks load | `renderer/components/tabs/studio-tab.tsx:352` | [ ] | [ ] | [ ] |
| P122 | Show stage swap | Show stage replaces Preview while talk-show room is open | `renderer/components/tabs/studio-tab.tsx:402` | [ ] | [ ] | [ ] |
| P123 | Talk-show outputs on transport | Room open: Record/Go Live drive cloud recording/live | `renderer/components/tabs/studio-tab.tsx:278` | [ ] | [ ] | [ ] |

### Preview stage (docked / detached), preview-stage.tsx

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P124 | "Preview is closed" empty state | Says Preview can open here or in its own window | `renderer/components/preview-stage.tsx:224` | [ ] | [ ] | [ ] |
| P125 | "Show here" (closed) | Opens Preview docked in Studio; shows ⌘P when docked mode | `renderer/components/preview-stage.tsx:619` | [ ] | [ ] | [ ] |
| P126 | "Open in its own window" | Opens floating Preview window; shows ⌘P when floating mode | `renderer/components/preview-stage.tsx:629` | [ ] | [ ] | [ ] |
| P127 | ⌘P / Ctrl+P | Opens Preview in remembered mode | `renderer/lib/shortcuts.ts:70` | [ ] | [ ] | [ ] |
| P128 | "Preview is open in its own window" | Floating-state status with detail and fallback path label | `renderer/components/preview-stage.tsx:218` | [ ] | [ ] | [ ] |
| P129 | "Show here" (floating) | Moves floating Preview into Studio (dock) | `renderer/components/preview-stage.tsx:589` | [ ] | [ ] | [ ] |
| P130 | "Bring to front" | Raises the floating Preview window | `renderer/components/preview-stage.tsx:593` | [ ] | [ ] | [ ] |
| P131 | "Close Preview" | Closes the floating Preview window | `renderer/components/preview-stage.tsx:596` | [ ] | [ ] | [ ] |
| P132 | "Keep on top of other apps" switch | Floating Preview always-on-top | `renderer/components/preview-stage.tsx:605` | [ ] | [ ] | [ ] |
| P133 | Permission fix button ("Allow…"/"Reopen Videorc"/"Open System Settings…"/"Open Permissions") | Fixes missing camera/screen grant blocking preview *(wording per OS (apps/desktop/src/renderer/src/lib/system-access-view.ts))* | `renderer/components/preview-stage.tsx:599` | [ ] | [ ] | [ ] |
| P134 | Docked surface slot | Native preview glued over slot, true canvas aspect *(macOS CAMetalLayer in-window; child window elsewhere (preview-stage.tsx:287))* | `renderer/components/preview-stage.tsx:362` | [ ] | [ ] | [ ] |
| P135 | Docked startup card ("Step n of N", "Open Sources") | Shows startup step until first frame; opens Sources | `renderer/components/preview-startup-card.tsx:22` | [ ] | [ ] | [ ] |
| P136 | Docked hidden-reason text | "Placing preview…", hidden under window/scrolled/fullscreen messages | `renderer/components/preview-stage.tsx:449` | [ ] | [ ] | [ ] |
| P137 | "Waiting for the first frame…" | Docked slot text before frame | `renderer/components/preview-stage.tsx:444` | [ ] | [ ] | [ ] |
| P138 | Checking spinner label | Preview holds picture while performance check runs | `renderer/components/preview-stage.tsx:397` | [ ] | [ ] | [ ] |
| P139 | "Pop out" | Moves docked Preview to its own window | `renderer/components/preview-stage.tsx:412` | [ ] | [ ] | [ ] |
| P140 | "Close" (docked) | Closes docked Preview | `renderer/components/preview-stage.tsx:416` | [ ] | [ ] | [ ] |
| P141 | Supervisor states | "Opening preview…", "Closing preview…", "Preview failed", "Preview needs permission", "Preview is recovering" | `renderer/components/preview-stage.tsx:684` | [ ] | [ ] | [ ] |
| P142 | "Using a slower preview path" | Names non-native fallback path *(macOS + Windows only (preview-stage.tsx:827); not for Windows proof surface (:836))* | `renderer/components/preview-stage.tsx:818` | [ ] | [ ] | n/a |
| P143 | "Preview runs on the CPU" | No native surface; Open preview / Retry *(Linux only)* | `renderer/components/preview-stage.tsx:245` | n/a | n/a | [ ] |
| P144 | "The fast preview is off" | Native surface disabled warning *(macOS/Windows)* | `renderer/components/preview-stage.tsx:253` | [ ] | [ ] | n/a |
| P145 | "Open preview" (no native surface) | Opens Preview window, with ⌘P | `renderer/components/preview-stage.tsx:652` | [ ] | [ ] | [ ] |
| P146 | "Retry preview" (card) | Retries preview pipeline | `renderer/components/preview-stage.tsx:660` | [ ] | [ ] | [ ] |
| P147 | Room-open card + "Close the room" | Preview replaced by Show stage; closes room | `renderer/components/preview-stage.tsx:188` | [ ] | [ ] | [ ] |

### Session transport (session-panel.tsx SessionTransport)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P148 | "Record" (Space chip) | Starts recording; lit while starting/running | `renderer/components/studio/session-panel.tsx:168` | [x] | [ ] | [ ] |
| P149 | Record → "Stop recording"/"Stopping…"/"Force stop"/"Cancel livestream"/"End livestream" | Same button stops session per state | `renderer/lib/studio-session-view.ts:124` | [x] | [ ] | [ ] |
| P150 | "Go Live" / "Checking…" | Starts record+stream; preflight checks state | `renderer/components/studio/session-panel.tsx:186` | [ ] | [ ] | [ ] |
| P151 | Go Live → "End livestream" | While room live, ends talk-show livestream | `renderer/components/go-live-button.tsx:19` | [ ] | [ ] | [ ] |
| P152 | Hidden Go Live while active | Go Live disappears while a local session runs | `renderer/components/studio/session-panel.tsx:181` | [x] | [ ] | [ ] |
| P153 | Disabled-reason tooltips | Hover/focus tells why Record or Go Live is off | `renderer/components/studio/session-panel.tsx:167` | [x] | [ ] | [ ] |
| P154 | Stop note "Your recording stops too." | Explains End livestream also stops recording | `renderer/components/studio/session-panel.tsx:200` | [x] | [ ] | [ ] |
| P155 | Blocked reason line + jump link | One line why start is blocked, link to fix page | `renderer/components/studio/session-panel.tsx:233` | [ ] | [ ] | [ ] |
| P156 | Alert "Stopping is taking longer than expected" | Explains Force stop when stop overruns | `renderer/components/studio/session-panel.tsx:210` | [x] | [ ] | [ ] |
| P157 | "End livestream?" dialog (shell) | Confirms ending livestream; "Keep streaming"/hand-off options | `renderer/components/end-livestream-dialog.tsx:81` | [ ] | [ ] | [ ] |
| P158 | Go Live confirmation dialog (shell) | Opened by Go Live; ⌘Enter confirms | `renderer/lib/shortcuts.ts:64` | [ ] | [ ] | [ ] |

### Session panel rows and alerts (session-panel.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P159 | "Livestream" row | Destinations summary; opens Destinations | `renderer/components/studio/session-panel.tsx:296` | [ ] | [ ] | [ ] |
| P160 | "Output" row | Recording/encode summary; opens Recording settings panel | `renderer/components/studio/session-panel.tsx:302` | [ ] | [ ] | [ ] |
| P161 | "Destinations" row (live) | "n of n on air" status dot; opens Destinations | `renderer/components/studio/session-panel.tsx:532` | [ ] | [ ] | [ ] |
| P162 | Per-destination problem rows | One row per problem: the destination's name, then its word ("Ended", "Failed", "Reconnecting…", "Not receiving"); opens Destinations | `renderer/components/studio/session-panel.tsx:547` | [x] | [ ] | [ ] |
| P163 | "Stream" health row (live) | Healthy or failing stage; opens Health | `renderer/components/studio/session-panel.tsx:597` | [ ] | [ ] | [ ] |
| P164 | "Sidekick" (co-host) row (live) | Buddy presence/alerts; hint lines; opens Stream Manager | `renderer/components/studio/session-panel.tsx:639` | [ ] | [ ] | [ ] |
| P165 | "Guests" row (room open) | "Room open · n backstage"; opens Guests page | `renderer/components/studio/guests-session-row.tsx:22` | [ ] | [ ] | [ ] |
| P166 | Agents row + "Stop" | "Claude Desktop connected"; Stop cuts all agents | `renderer/components/studio/agents-session-row.tsx:54` | [ ] | [ ] | [ ] |
| P167 | Watchdog alert cards | One card per open watchdog problem | `renderer/components/studio/session-panel.tsx:401` | [ ] | [ ] | [ ] |
| P168 | Alert "Couldn't start" + "Retry"/"Dismiss" | Persistent refused-start reason with retry | `renderer/components/studio/session-panel.tsx:417` | [x] | [ ] | [ ] |
| P169 | Alert "Camera opened twice" | Camera shared between capture paths warning | `renderer/components/studio/session-panel.tsx:445` | [x] | [ ] | [ ] |
| P170 | Session runtime notice | Mid-session failure/degradation alert | `renderer/components/studio/session-panel.tsx:451` | [x] | [ ] | [ ] |

### Session runtime alert (session-runtime-alert.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P171 | Runtime alert (destructive/warning, role=alert) | Recording failed or degraded, backend message | `renderer/components/studio/session-runtime-alert.tsx:35` | [ ] | [ ] | [ ] |
| P172 | "Open Audio" | Focuses Studio microphone row (lost/silent mic) | `renderer/components/studio/session-runtime-alert.tsx:50` | [ ] | [ ] | [ ] |
| P173 | "Open Library" | Opens Library for the saved file | `renderer/components/studio/session-runtime-alert.tsx:60` | [x] | [ ] | [ ] |
| P174 | Reveal ("Show in Finder"/"Show in Explorer"/"Show in folder") | Reveals saved recording *(label per OS (apps/desktop/src/renderer/src/lib/platform.ts))* | `renderer/components/studio/session-runtime-alert.tsx:65` | [ ] | [ ] | [ ] |
| P175 | "Dismiss" | Clears notice | `renderer/components/studio/session-runtime-alert.tsx:70` | [x] | [ ] | [ ] |

### Watchdog alert card (watchdog-alert-card.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P176 | Card (critical/warning/notice tone) | Backend title and live detail | `renderer/components/studio/watchdog-alert-card.tsx:56` | [ ] | [ ] | [ ] |
| P177 | Kebab "Snooze 10 min" | Snoozes alert ten minutes | `renderer/components/studio/watchdog-alert-card.tsx:66` | [ ] | [ ] | [ ] |
| P178 | "Source: Videorc Cloud" | Marks cloud-sourced reading | `renderer/components/studio/watchdog-alert-card.tsx:81` | [ ] | [ ] | [ ] |
| P179 | Primary fix button | Runs first backend fix | `renderer/components/studio/watchdog-alert-card.tsx:88` | [ ] | [ ] | [ ] |
| P180 | Extra fix buttons | Run other fixes | `renderer/components/studio/watchdog-alert-card.tsx:98` | [ ] | [ ] | [ ] |
| P181 | "Got it" / "Seen" | Acknowledges alert | `renderer/components/studio/watchdog-alert-card.tsx:121` | [ ] | [ ] | [ ] |
| P182 | "I meant to" | Mic-muted check: snoozes for this stream | `renderer/components/studio/watchdog-alert-card.tsx:111` | [ ] | [ ] | [ ] |

### Cloud resume notice (cloud-resume-notice.tsx + CloudResumeSlot)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P183 | Notice "You're still live through Videorc Cloud." | Show still live, computer not feeding it | `renderer/components/studio/cloud-resume-notice.tsx:49` | [ ] | [ ] | [ ] |
| P184 | Continue pointer text | Where a phone/device continues (selectable) | `renderer/components/studio/cloud-resume-notice.tsx:53` | [ ] | [ ] | [ ] |
| P185 | "Resume"/"Resuming…"/"Continue here"/"Continuing…"/"Reconnecting…" | Resumes cloud show or rejoins talk-show room | `renderer/components/studio/cloud-resume-notice.tsx:60` | [ ] | [ ] | [ ] |
| P186 | "End livestream" | Opens end confirmation | `renderer/components/studio/cloud-resume-notice.tsx:78` | [ ] | [ ] | [ ] |
| P187 | Dialog "End livestream?" ("Keep streaming"/"End livestream"/"Ending…") | Ends cloud show on every platform | `renderer/components/studio/cloud-resume-notice.tsx:91` | [ ] | [ ] | [ ] |

### Chat in Studio (studio-chat.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P188 | Section visibility | Shows only on air with Chat in Studio setting on | `renderer/components/tabs/studio-tab.tsx:248` | [ ] | [ ] | [ ] |
| P189 | "Open Stream Manager" (⌘⇧J tooltip) | Opens Stream Manager window | `renderer/components/studio/studio-chat.tsx:113` | [ ] | [ ] | [ ] |
| P190 | "Hide chat in Studio" (X) | Turns setting off; toast "Chat hidden in Studio" with "Undo" | `renderer/components/studio/studio-chat.tsx:124` | [ ] | [ ] | [ ] |
| P191 | Destination notice line | Which destination's chat needs attention | `renderer/components/studio/studio-chat.tsx:142` | [ ] | [ ] | [ ] |
| P192 | No-chat / empty text | No chat destinations or no messages yet | `renderer/components/studio/studio-chat.tsx:146` | [ ] | [ ] | [ ] |
| P193 | "Chat messages" list | Virtualized, auto-follow newest; fixed height | `renderer/components/studio/studio-chat.tsx:252` | [ ] | [ ] | [ ] |
| P194 | Jump chip | Resume following; unread count | `renderer/components/studio/studio-chat.tsx:289` | [ ] | [ ] | [ ] |
| P195 | Row click | Puts message on stream / takes it off | `renderer/components/studio/studio-chat.tsx:349` | [ ] | [ ] | [ ] |
| P196 | Keys ↑ ↓ Home End | Move between rows | `renderer/components/studio/studio-chat.tsx:223` | [ ] | [ ] | [ ] |
| P197 | Key C | Copies "Name: message" | `renderer/components/studio/studio-chat.tsx:230` | [ ] | [ ] | [ ] |
| P198 | Row parts | Avatar, name, text, amount badge, arrival chip, highlight status, platform icon | `renderer/components/studio/studio-chat.tsx:404` | [ ] | [ ] | [ ] |
| P199 | Highlight failure reason | Why highlight failed under row | `renderer/components/studio/studio-chat.tsx:425` | [ ] | [ ] | [ ] |

### Audio section, default look (audio-section.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P200 | "Microphone" row title | Microphone channel strip | `renderer/components/studio/audio-section.tsx:368` | [ ] | [ ] | [ ] |
| P201 | "Muted"/takeover status badge | Says microphone is muted or held by takeover | `renderer/components/studio/audio-section.tsx:334` | [ ] | [ ] | [ ] |
| P202 | Mute shortcut keys chip | Shows bound global mic-mute key | `renderer/components/studio/audio-section.tsx:340` | [ ] | [ ] | [ ] |
| P203 | "Mute microphone" toggle | Mutes/unmutes mic; tooltip with shortcut | `renderer/components/studio/audio-section.tsx:341` | [ ] | [ ] | [ ] |
| P204 | Microphone picker ("Off", "Finding microphones…") | Switches microphone live | `renderer/components/studio/audio-section.tsx:375` | [ ] | [ ] | [ ] |
| P205 | Microphone level meter | Live level; dims when muted | `renderer/components/studio/audio-section.tsx:397` | [ ] | [ ] | [ ] |
| P206 | Takeover hold hint | Why takeover is silencing the mic | `renderer/components/studio/audio-section.tsx:408` | [ ] | [ ] | [ ] |
| P207 | Microphone "Gain" fader | −24…+24 dB, detent 0; readout resets "Reset to 0 dB" | `renderer/components/audio/gain-faders.tsx:42` | [ ] | [ ] | [ ] |
| P208 | Session level unavailable line | Says bus sends no level | `renderer/components/studio/audio-section.tsx:416` | [ ] | [ ] | [ ] |
| P209 | "System audio" row | Switch, level, gain, issues *(macOS always; Linux/older Windows hidden (apps/desktop/src/renderer/src/lib/system-audio.ts:34))* | `renderer/components/studio/audio-section.tsx:490` | [ ] | [ ] | [ ] |
| P210 | "System audio" switch | Turns system audio capture on/off; shortcut tooltip *(as above)* | `renderer/components/studio/audio-section.tsx:479` | [ ] | [ ] | [ ] |
| P211 | System audio status chip | On/Off/joining state words *(as above)* | `renderer/components/studio/audio-section.tsx:505` | [ ] | [ ] | [ ] |
| P212 | System audio meter | Level while recording/live/Clips bus runs *(as above)* | `renderer/components/studio/audio-section.tsx:511` | [ ] | [ ] | [ ] |
| P213 | Clips-off idle line | Says level shows only with Clips/session *(as above)* | `renderer/components/studio/audio-section.tsx:220` | [ ] | [ ] | [ ] |
| P214 | System audio "Gain" fader | System audio gain with reset readout *(as above)* | `renderer/components/audio/gain-faders.tsx:82` | [ ] | [ ] | [ ] |
| P215 | Alert "System audio needs Screen Recording permission." + "Open Permissions" | Permission missing; opens Settings → Permissions *(macOS (permission))* | `renderer/components/studio/audio-section.tsx:464` | [ ] | n/a | n/a |
| P216 | Issue alert + "Open Permissions" (unavailable) | System audio unavailable fix *(macOS only)* | `renderer/components/studio/audio-section.tsx:470` | [ ] | n/a | n/a |
| P217 | Echo alert + "Resume" | Echo guard paused system audio; resume *(all where shown)* | `renderer/components/studio/audio-section.tsx:474` | [ ] | [ ] | [ ] |
| P218 | ⌘/Ctrl+↑/↓ | Moves focus between channel strips | `renderer/components/studio/audio-section.tsx:240` | [ ] | [ ] | [ ] |
| P219 | "Open Audio" focus target | Notifications land on mic picker | `renderer/components/studio/audio-section.tsx:82` | [ ] | [ ] | [ ] |

### Audio section, Retro LCD look (retro-lcd-studio.tsx RetroAudioSectionView)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P220 | LCD "Microphone" header | Channel title on LCD screen | `renderer/components/studio/retro-lcd-studio.tsx:336` | [ ] | [ ] | [ ] |
| P221 | Mute key "Mute"/"Muted" | Toggles mic mute, lit when muted, shortcut text | `renderer/components/studio/retro-lcd-studio.tsx:348` | [ ] | [ ] | [ ] |
| P222 | LCD "Device" picker | Chooses microphone in LCD popup | `renderer/components/studio/retro-lcd-studio.tsx:377` | [ ] | [ ] | [ ] |
| P223 | Switch status line | Live mic switch progress on screen | `renderer/components/studio/retro-lcd-studio.tsx:394` | [ ] | [ ] | [ ] |
| P224 | LCD mic meter (CLIP flag, no scale) | Level, held peak, digits, clip | `renderer/components/studio/retro-lcd-studio.tsx:406` | [ ] | [ ] | [ ] |
| P225 | Takeover hold message | "Muted by takeover" sentence | `renderer/components/studio/retro-lcd-studio.tsx:418` | [ ] | [ ] | [ ] |
| P226 | Session level unavailable message | No backend level | `renderer/components/studio/retro-lcd-studio.tsx:424` | [ ] | [ ] | [ ] |
| P227 | LCD Gain fader | Microphone gain | `renderer/components/studio/retro-lcd-studio.tsx:429` | [ ] | [ ] | [ ] |
| P228 | LCD "System audio" header + switch | Toggles system audio *(macOS; hidden Linux/older Windows)* | `renderer/components/studio/retro-lcd-studio.tsx:460` | [ ] | [ ] | [ ] |
| P229 | "Needs permission" | Opens Settings → Permissions *(macOS)* | `renderer/components/studio/retro-lcd-studio.tsx:697` | [ ] | n/a | n/a |
| P230 | "Resume" (echo) | Resumes after echo guard pause *(where shown)* | `renderer/components/studio/retro-lcd-studio.tsx:708` | [ ] | [ ] | [ ] |
| P231 | Issue word with tooltip | Short system-audio issue label *(where shown)* | `renderer/components/studio/retro-lcd-studio.tsx:714` | [ ] | [ ] | [ ] |
| P232 | LCD system audio meter + Gain | Level and gain *(where shown)* | `renderer/components/studio/retro-lcd-studio.tsx:469` | [ ] | [ ] | [ ] |

### Retro LCD transport, Session, Sources, Takeover (retro-lcd-studio.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P233 | LCD "Record" key (Space text) | Starts recording / "Stop recording" for room | `renderer/components/studio/retro-lcd-studio.tsx:132` | [ ] | [ ] | [ ] |
| P234 | LCD "Go Live"/"Checking…"/"End livestream" key | Starts or ends livestream | `renderer/components/studio/retro-lcd-studio.tsx:151` | [ ] | [ ] | [ ] |
| P235 | LCD stop key (stopLabel) | Stops active session | `renderer/components/studio/retro-lcd-studio.tsx:120` | [ ] | [ ] | [ ] |
| P236 | LCD stop note / blocked line + action | Explanations and jump to fix | `renderer/components/studio/retro-lcd-studio.tsx:169` | [ ] | [ ] | [ ] |
| P237 | Stop overrun alert | Force-stop explanation | `renderer/components/studio/retro-lcd-studio.tsx:180` | [ ] | [ ] | [ ] |
| P238 | LCD Session rows | Livestream, Output, Destinations, Stream, Sidekick, Guests, Agents | `renderer/components/studio/retro-lcd-studio.tsx:227` | [ ] | [ ] | [ ] |
| P239 | LCD Camera picker + "Open Sources" cog | Switches camera; cog opens Sources | `renderer/components/studio/retro-lcd-studio.tsx:518` | [ ] | [ ] | [ ] |
| P240 | LCD "Background" row | Opens camera background picker popover | `renderer/components/studio/retro-lcd-studio.tsx:598` | [ ] | [ ] | [ ] |
| P241 | LCD stage / system-effect lines | Background cover and OS effect notes | `renderer/components/studio/retro-lcd-studio.tsx:643` | [ ] | [ ] | [ ] |
| P242 | LCD "Captions" row | Captions status; opens Captions panel | `renderer/components/studio/retro-lcd-studio.tsx:546` | [ ] | [ ] | [ ] |
| P243 | LCD "Chat" row | "n new" or Stream Manager + key; opens it | `renderer/components/studio/retro-lcd-studio.tsx:562` | [ ] | [ ] | [ ] |
| P244 | LCD "Takeover" header + "Open Images" cog | Opens Images | `renderer/components/studio/retro-lcd-studio.tsx:741` | [ ] | [ ] | [ ] |
| P245 | LCD "None yet" / "Add in Images" | Empty takeover state; opens Images | `renderer/components/studio/retro-lcd-studio.tsx:746` | [ ] | [ ] | [ ] |
| P246 | LCD takeover press rows | Toggle takeover covering output | `renderer/components/studio/retro-lcd-studio.tsx:758` | [ ] | [ ] | [ ] |
| P247 | LCD takeover hint | What a click does / connection reason | `renderer/components/studio/retro-lcd-studio.tsx:773` | [ ] | [ ] | [ ] |

### Quick settings (quick-settings.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P248 | "Camera" picker ("Off") | Switches camera live; Off sticks | `renderer/components/studio/quick-settings.tsx:92` | [ ] | [ ] | [ ] |
| P249 | "Open Sources" cog | Opens Sources page | `renderer/components/studio/quick-settings.tsx:89` | [ ] | [ ] | [ ] |
| P250 | Camera switch status | Preparing/unavailable/check line | `renderer/components/studio/quick-settings.tsx:87` | [ ] | [ ] | [ ] |
| P251 | Stand-in line | Another camera stands in for missing pick | `renderer/components/studio/quick-settings.tsx:239` | [ ] | [ ] | [ ] |
| P252 | "Background" row (thumbnail · value) | Opens camera background popover *(all; effects disabled Win/Linux (apps/desktop/src/renderer/src/lib/camera-background-view.ts:108))* | `renderer/components/camera-background/camera-background-popover.tsx:81` | [ ] | [ ] | [ ] |
| P253 | Background stage warning line | Effect stage covering or can't run | `renderer/components/studio/quick-settings.tsx:284` | [ ] | [ ] | [ ] |
| P254 | System effect info line | macOS Video Effects / Windows Studio Effects altering camera *(macOS + Windows)* | `renderer/components/studio/quick-settings.tsx:254` | [ ] | [ ] | n/a |
| P255 | "Captions" row | Captions status; opens Captions panel | `renderer/components/studio/quick-settings.tsx:123` | [ ] | [ ] | [ ] |
| P256 | "Chat" door row | "n new" or "Stream Manager · ⌘⇧J"; opens it | `renderer/components/studio/quick-settings.tsx:145` | [ ] | [ ] | [ ] |

### Camera background popover (opened from Camera row)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P257 | "What viewers see" live viewer | Live camera picture with effect | `renderer/components/camera-background/camera-background-picker.tsx:43` | [ ] | [ ] | [ ] |
| P258 | Tiles "Off", "Slight blur", "Strong blur" | Choose blur *(macOS only enabled (camera-background-view.ts:108))* | `renderer/lib/camera-background-view.ts:212` | [ ] | [ ] | [ ] |
| P259 | Image tiles + "Choose…" | Pick background image; opens "Choose an image" dialog *(macOS only enabled)* | `renderer/components/camera-background/camera-background-tiles.tsx:109` | [ ] | [ ] | [ ] |
| P260 | "Green screen", "Blue screen" | Screen-colour backgrounds *(macOS only enabled)* | `renderer/lib/camera-background-view.ts:224` | [ ] | [ ] | [ ] |
| P261 | Blur caveat line | Blur limitations note | `renderer/components/camera-background/camera-background-picker.tsx:61` | [ ] | [ ] | [ ] |
| P262 | Lock line + "Settings" | Opens Scene page Background section | `renderer/components/camera-background/camera-background-picker.tsx:69` | [ ] | [ ] | [ ] |
| P263 | Dialog "Choose an image" | Grid of background images | `renderer/components/camera-background/camera-background-image-dialog.tsx:43` | [ ] | [ ] | [ ] |

### Source switch status (source-switch-status.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P264 | Status messages | "Checking source…", "Preparing X…", "Turning off…", "Restoring previous source…" | `renderer/components/studio/source-switch-status.tsx:37` | [ ] | [ ] | [ ] |
| P265 | Unavailable messages | Choose again, or "Stop, then choose it again" *(Linux: locked during session (source-switch-status.tsx:33))* | `renderer/components/studio/source-switch-status.tsx:47` | [ ] | [ ] | [ ] |
| P266 | Output check messages | "Source changed. Checking output…" / newer scene active | `renderer/components/studio/source-switch-status.tsx:51` | [ ] | [ ] | [ ] |
| P267 | "Check again" | Retries source status | `renderer/components/studio/source-switch-status.tsx:62` | [ ] | [ ] | [ ] |

### Takeover section (session-panel.tsx TakeoverSection)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P268 | "Takeover" header + "Open Images" cog | Opens Images page | `renderer/components/studio/session-panel.tsx:680` | [ ] | [ ] | [ ] |
| P269 | Empty "No takeovers yet." + "Add in Images" | Opens Images | `renderer/components/studio/session-panel.tsx:684` | [ ] | [ ] | [ ] |
| P270 | Takeover buttons (by name) | Cover output / click again to return | `renderer/components/studio/session-panel.tsx:703` | [ ] | [ ] | [ ] |
| P271 | Hint line | What a click does, or disconnected reason | `renderer/components/studio/session-panel.tsx:740` | [x] | [ ] | [ ] |

### Studio dashboard bottom row (studio-dashboard-bottom-row.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P272 | Scenes off notice | "Scenes are off while the room is open…" | `renderer/components/studio/studio-dashboard-bottom-row.tsx:24` | [ ] | [ ] | [ ] |
| P273 | Order | Scenes, Soundboard, Vertical stream | `renderer/components/studio/studio-dashboard-bottom-row.tsx:22` | [ ] | [ ] | [ ] |

### Scenes section (scene-presets.tsx, scenes-gallery.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P274 | "Scenes" header description | Scene keys range "⌘1 to ⌘9 switch them from any app" | `renderer/components/scene/scene-entries.tsx:51` | [ ] | [ ] | [ ] |
| P275 | "Edit scene" | Opens Scene editor page | `renderer/components/scene-presets.tsx:125` | [ ] | [ ] | [ ] |
| P276 | "Add scene…" | Opens Add scene picker dialog | `renderer/components/scene-presets.tsx:129` | [ ] | [ ] | [ ] |
| P277 | "Studio orientation" segmented (16:9 / 9:16) | Switches canvas orientation; locked while recording/live | `renderer/components/scene-presets.tsx:148` | [ ] | [ ] | [ ] |
| P278 | "Follow the app in front" switch | Auto-switch to app's scene *(macOS only (scene-presets.tsx:166))* | `renderer/components/scene/follow-front-app-switch.tsx:19` | [ ] | n/a | n/a |
| P279 | Library error line | Scene library read error | `renderer/components/scene-presets.tsx:168` | [ ] | [ ] | [ ] |
| P280 | Scene card click | Puts scene on stream; repair dialog if sources missing | `renderer/components/scene-presets.tsx:239` | [ ] | [ ] | [ ] |
| P281 | Drag to reorder | Moves card; position keys follow | `renderer/components/scene-presets.tsx:195` | [ ] | [ ] | [ ] |
| P282 | ⌥← / ⌥→ | Moves focused card left/right | `renderer/components/scene-presets.tsx:197` | [ ] | [ ] | [ ] |
| P283 | ⌘K "Add scene…" / Sources "Open Scenes" | Opens picker / scrolls Scenes into view | `renderer/components/scene-presets.tsx:98` | [ ] | [ ] | [ ] |
| P284 | Scene switch status line | Slow switch: what it waits for | `renderer/components/scene/scene-switch-status.tsx:32` | [ ] | [ ] | [ ] |
| P285 | Gallery reason + "Open Sources" | Why some scenes can't go on | `renderer/components/scene-presets.tsx:248` | [ ] | [ ] | [ ] |
| P286 | Scene still pictures | Card thumbnails show screen still *(macOS only; not while recording/live)* | `renderer/components/scene-presets.tsx:67` | [ ] | n/a | n/a |
| P287 | Loading fallback | "Scenes" skeleton | `renderer/components/studio/scenes-gallery.tsx:53` | [ ] | [ ] | [ ] |

### Scene card (scene-card.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P288 | Thumbnail (layout diagram + still/glyph) | Layout geometry; never live program | `renderer/components/studio/scenes-gallery.tsx:174` | [ ] | [ ] | [ ] |
| P289 | Name row + check | Name truncates; check marks on-stream scene | `renderer/components/studio/scene-card.tsx:160` | [ ] | [ ] | [ ] |
| P290 | Meta line + key chips | What it shows / reason / "Applying…"; shortcut keys | `renderer/components/studio/scene-card.tsx:191` | [ ] | [ ] | [ ] |
| P291 | Key conflict text | Shows conflict instead of key | `renderer/components/scene/scene-shortcut-keys.tsx:35` | [ ] | [ ] | [ ] |
| P292 | Truncation tooltip | Full name/meta on hover when cut | `renderer/components/studio/scene-card.tsx:218` | [ ] | [ ] | [ ] |
| P293 | Disabled reason tooltip | Card's own reason on hover/focus | `renderer/components/studio/scene-card.tsx:211` | [ ] | [ ] | [ ] |
| P294 | ⋯ menu "Rename…" | Opens Rename scene dialog | `renderer/components/scene/scene-dialogs.tsx:288` | [ ] | [ ] | [ ] |
| P295 | ⋯ "Change screen…" | Opens Change screen picker | `renderer/components/scene/scene-dialogs.tsx:295` | [ ] | [ ] | [ ] |
| P296 | ⋯ "Set key…" | Opens Set key dialog | `renderer/components/scene/scene-dialogs.tsx:303` | [ ] | [ ] | [ ] |
| P297 | ⋯ "Follow the app"/"Stop following" | App-scene follow toggle *(macOS (app scenes only exist on macOS))* | `renderer/components/scene/scene-dialogs.tsx:311` | [ ] | n/a | n/a |
| P298 | ⋯ "Save audio to scene" | Saves mic + system audio into scene | `renderer/components/scene/scene-dialogs.tsx:321` | [ ] | [ ] | [ ] |
| P299 | ⋯ "Guests in the room…" | Opens guest placement dialog | `renderer/components/scene/scene-dialogs.tsx:338` | [ ] | [ ] | [ ] |
| P300 | ⋯ "Duplicate" | Copies scene at end | `renderer/components/scene/scene-dialogs.tsx:345` | [ ] | [ ] | [ ] |
| P301 | ⋯ "Delete" | Opens delete confirmation (last/on-air protected) | `renderer/components/scene/scene-dialogs.tsx:358` | [ ] | [ ] | [ ] |

### Scene dialogs (scene-dialogs.tsx, scene-picker-dialog.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P302 | Dialog "Add scene" | Multi-pick apps/displays/camera only; "Add n scenes" | `renderer/components/scene/scene-picker-dialog.tsx:208` | [ ] | [ ] | [ ] |
| P303 | Dialog "Change screen" | Single pick; "Change screen"; "No screen" option | `renderer/components/scene/scene-picker-dialog.tsx:208` | [ ] | [ ] | [ ] |
| P304 | Search field | "Search apps and displays…" / incl. windows | `renderer/components/scene/scene-picker-dialog.tsx:215` | [ ] | [ ] | [ ] |
| P305 | "Apps" group | Open apps; "Finding your open apps…", "No app windows found" *(macOS only (scene-picker-dialog.tsx:120))* | `renderer/components/scene/scene-picker-dialog.tsx:236` | [ ] | n/a | n/a |
| P306 | "Windows" group (change) | Pick a specific window *(macOS only (:123))* | `renderer/components/scene/scene-picker-dialog.tsx:564` | [ ] | n/a | n/a |
| P307 | "Displays" group | Display stills; "No displays found" *(all; stills macOS)* | `renderer/components/scene/scene-picker-dialog.tsx:280` | [ ] | [ ] | [ ] |
| P308 | "Camera" group | "Camera only" / "No screen" pick | `renderer/components/scene/scene-picker-dialog.tsx:301` | [ ] | [ ] | [ ] |
| P309 | Screen Recording alert | Shown when grant missing *(macOS)* | `renderer/components/scene/scene-picker-dialog.tsx:227` | [ ] | n/a | n/a |
| P310 | No-match empty | "Nothing matches “…”." | `renderer/components/scene/scene-picker-dialog.tsx:230` | [ ] | [ ] | [ ] |
| P311 | Layout note + "Cancel" | Layout hides screen note; cancel | `renderer/components/scene/scene-picker-dialog.tsx:322` | [ ] | [ ] | [ ] |
| P312 | Dialog "Rename scene" | Name field (unique, ≤80), Enter, "Rename"/"Cancel" | `renderer/components/scene/scene-dialogs.tsx:564` | [ ] | [ ] | [ ] |
| P313 | Dialog "Set key" | Records global scene key; "Done" *(all; Wayland warning (scene-dialogs.tsx:648))* | `renderer/components/scene/scene-dialogs.tsx:643` | [ ] | [ ] | [ ] |
| P314 | Dialog "Guests in the room" | Over/below/side placement; "Save"/"Cancel" | `renderer/components/scene/scene-dialogs.tsx:482` | [ ] | [ ] | [ ] |
| P315 | Dialog "Resolve scene sources" | Pick Camera and Screen / window; "Apply scene" | `renderer/components/scene/scene-dialogs.tsx:715` | [ ] | [ ] | [ ] |
| P316 | "Apply without background"/"Background omitted" | Applies repaired scene without its background | `renderer/components/scene/scene-dialogs.tsx:758` | [ ] | [ ] | [ ] |
| P317 | Confirm "Delete scene?" | "Delete scene"; says which scene goes on | `renderer/components/scene/scene-dialogs.tsx:437` | [ ] | [ ] | [ ] |

### Scene on stream fields (scene-on-stream.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P318 | "On stream: {name}" header | Edits save into this scene | `renderer/components/studio/scene-on-stream.tsx:236` | [ ] | [ ] | [ ] |
| P319 | "Screen" field description/note | What scene shows | `renderer/components/studio/scene-on-stream.tsx:245` | [ ] | [ ] | [ ] |
| P320 | "Hide screen"/"Show screen" (with ⌃⌥H) | Privacy-hides screen in output | `renderer/components/studio/scene-on-stream.tsx:409` | [ ] | [ ] | [ ] |
| P321 | "Screen hidden" chip | Shows hidden state / room privacy status tooltip | `renderer/components/studio/scene-on-stream.tsx:261` | [ ] | [ ] | [ ] |
| P322 | "Change screen…" | Opens Change screen picker for on-air scene | `renderer/components/studio/scene-on-stream.tsx:134` | [ ] | [ ] | [ ] |
| P323 | Capture switch status / stand-in | Screen switch progress | `renderer/components/studio/scene-on-stream.tsx:271` | [ ] | [ ] | [ ] |
| P324 | Screen Recording alert | Missing grant inline *(macOS)* | `renderer/components/studio/scene-on-stream.tsx:279` | [ ] | n/a | n/a |
| P325 | "Layout" select (diagram + name, "Freeform") | Chooses scene layout; asks screen if needed | `renderer/components/studio/scene-on-stream.tsx:285` | [ ] | [ ] | [ ] |
| P326 | Camera line | Why camera layouts are off | `renderer/components/studio/scene-on-stream.tsx:334` | [ ] | [ ] | [ ] |
| P327 | "Framing" Fill / Fit | Screen framing (vertical or landscape) | `renderer/components/studio/scenes-gallery.tsx:68` | [ ] | [ ] | [ ] |
| P328 | "Vertical stream" subsection | 9:16 layout when simulcast armed | `renderer/components/studio/scene-on-stream.tsx:344` | [ ] | [ ] | [ ] |
| P329 | LCD rows: On stream, Screen, Change screen…, Hide screen press row, Layout, Framing, Vertical stream, Vertical framing | LCD versions of the above | `renderer/components/studio/scene-on-stream.tsx:157` | [ ] | [ ] | [ ] |

### Screen privacy control (screen-privacy-control.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P330 | Hide/Show toggle | One shared hide state; error toast on failure | `renderer/components/studio/screen-privacy-control.tsx:63` | [ ] | [ ] | [ ] |
| P331 | Default key | Control+Alt+H unless changed | `shared/global-shortcuts.ts:3` | [ ] | [ ] | [ ] |
| P332 | Disabled reason | Refused hide or offline | `renderer/components/studio/screen-privacy-control.tsx:59` | [ ] | [ ] | [ ] |
| P333 | Room privacy chip + tooltip | Room's own status and observations | `renderer/components/studio/screen-privacy-control.tsx:80` | [ ] | [ ] | [ ] |

### Vertical stream (vertical-leg-monitor.tsx, vertical-stream-layout-control.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P334 | "Vertical stream" panel | Shows when simulcast armed | `renderer/components/studio/vertical-leg-monitor.tsx:27` | [ ] | [ ] | [ ] |
| P335 | "On air" / "Ready" badge | Session state | `renderer/components/studio/vertical-leg-monitor.tsx:29` | [ ] | [ ] | [ ] |
| P336 | Description | Live edits affect vertical stream only | `renderer/components/studio/vertical-leg-monitor.tsx:35` | [ ] | [ ] | [ ] |
| P337 | "Vertical stream layout" select | Six 9:16 layouts; gaps disabled | `renderer/components/studio/vertical-stream-layout-control.tsx:185` | [ ] | [ ] | [ ] |
| P338 | Gap reason line | Why layouts unavailable | `renderer/components/studio/vertical-stream-layout-control.tsx:226` | [ ] | [ ] | [ ] |
| P339 | Fill / Fit | Vertical framing | `renderer/components/studio/vertical-stream-layout-control.tsx:228` | [ ] | [ ] | [ ] |

### Soundboard (soundboard-section.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P340 | "Soundboard" header description | Who hears sounds (session/monitor) | `renderer/lib/sounds.ts:127` | [ ] | [ ] | [ ] |
| P341 | "Stop all" | Stops every playing sound | `renderer/components/stop-all-sounds-button.tsx:48` | [ ] | [ ] | [ ] |
| P342 | Sound pads (6 columns) | "Play X"/"Stop X"; ring and progress | `renderer/components/sound-pad-board.tsx:112` | [ ] | [ ] | [ ] |
| P343 | Keys 1–9 | Press pad; hold-mode stops on key up/blur | `renderer/components/studio/soundboard-section.tsx:94` | [ ] | [ ] | [ ] |
| P344 | Disconnected line | Sounds play once connected | `renderer/components/studio/soundboard-section.tsx:61` | [ ] | [ ] | [ ] |
| P345 | Loading state | "Loading sounds…" / offline | `renderer/components/studio/soundboard-section.tsx:69` | [ ] | [ ] | [ ] |
| P346 | Empty "No sounds yet." + "Add in Sounds" | Opens Sounds page | `renderer/components/studio/soundboard-section.tsx:75` | [ ] | [ ] | [ ] |

### Room sounds and room audio routing (room-sounds.tsx, room-audio-routing.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P347 | "Room sounds · Preview" status | Aux track state/consumers; acceptance caveat | `renderer/components/studio/room-sounds.tsx:16` | [ ] | [ ] | [ ] |
| P348 | "Try room sounds for this room"/"Turn off room sounds" | Per-room consent for sounds into room | `renderer/components/studio/room-sounds.tsx:24` | [ ] | [ ] | [ ] |
| P349 | "Share system audio for this room"/"Stop sharing system audio" | Shares system audio with room *(dev builds only (enabled only when DEV, :20))* | `renderer/components/studio/room-audio-routing.tsx:17` | dev | dev | dev |
| P350 | "System gain · n dB" slider | −24…+12 dB room system gain | `renderer/components/studio/room-audio-routing.tsx:26` | [ ] | [ ] | [ ] |
| P351 | "Mute system audio"/"Unmute…" | Mutes room system audio | `renderer/components/studio/room-audio-routing.tsx:35` | [ ] | [ ] | [ ] |
| P352 | "Program speech · n%" slider | Program speech gain | `renderer/components/studio/room-audio-routing.tsx:46` | [ ] | [ ] | [ ] |
| P353 | "Mute program speech" | Toggles program speech | `renderer/components/studio/room-audio-routing.tsx:55` | [ ] | [ ] | [ ] |
| P354 | "Program music and sounds · n%" slider | Program auxiliary gain | `renderer/components/studio/room-audio-routing.tsx:68` | [ ] | [ ] | [ ] |
| P355 | "Mute program auxiliary audio" | Toggles program auxiliary audio | `renderer/components/studio/room-audio-routing.tsx:77` | [ ] | [ ] | [ ] |
| P356 | Takeover routing note | Takeover silences program speech | `renderer/components/studio/room-audio-routing.tsx:89` | [ ] | [ ] | [ ] |

### Show stage (show-stage.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P357 | "Show stage" section + description | Replaces Preview while room open | `renderer/components/studio/show-stage.tsx:186` | [ ] | [ ] | [ ] |
| P358 | "Close the room" + confirm "Close the room?" | Closes room; guests leave, recording finalizes | `renderer/components/guests/close-room-button.tsx:45` | [ ] | [ ] | [ ] |
| P359 | "Room view" well | Room tracks at room latency, program geometry | `renderer/components/studio/show-stage.tsx:228` | [ ] | [ ] | [ ] |
| P360 | "Nobody is on stage." | Empty stage | `renderer/components/studio/show-stage.tsx:246` | [ ] | [ ] | [ ] |
| P361 | "Room" label tooltip | Explains room view vs Program | `renderer/components/studio/show-stage.tsx:248` | [ ] | [ ] | [ ] |
| P362 | "Joining the room…"/"Reconnecting…" | Connection status pill | `renderer/components/studio/show-stage.tsx:259` | [ ] | [ ] | [ ] |
| P363 | Tile states | "Waiting for the screen", "No picture yet", "Back in a moment" | `renderer/components/studio/show-stage.tsx:371` | [ ] | [ ] | [ ] |
| P364 | Name plates (Muted / Talking) | Voice state on picture | `renderer/components/studio/show-stage.tsx:383` | [ ] | [ ] | [ ] |
| P365 | Host circle / portrait fill | Circle host shape; portrait blurred fill | `renderer/components/studio/show-stage.tsx:331` | [ ] | [ ] | [ ] |
| P366 | Local problem alert | Host media problem warning | `renderer/components/studio/show-stage.tsx:196` | [ ] | [ ] | [ ] |
| P367 | "Wants to join" list, "Let in"/"Decline" | Admit or refuse join requests (max 3) | `renderer/components/guests/room-person.tsx:293` | [ ] | [ ] | [ ] |
| P368 | "n more want to join" | Opens Guests page | `renderer/components/studio/show-stage.tsx:1406` | [ ] | [ ] | [ ] |
| P369 | "Layout" cards | Choose stage layout (incl. "Two screens") | `renderer/components/studio/show-stage.tsx:598` | [ ] | [ ] | [ ] |
| P370 | Layout reasons line | Why layouts are disabled | `renderer/components/studio/show-stage.tsx:617` | [ ] | [ ] | [ ] |
| P371 | "Screens" cards ("On stage"/"Put on stage") | Put shared screen on/off stage | `renderer/components/studio/show-stage.tsx:737` | [ ] | [ ] | [ ] |
| P372 | Screens empty text | No screens yet + guest hint | `renderer/components/studio/show-stage.tsx:733` | [ ] | [ ] | [ ] |
| P373 | "Share screen…" | Lists display sources; opens "Share a screen" dialog | `renderer/components/studio/show-stage.tsx:714` | [ ] | [ ] | [ ] |
| P374 | "Stop sharing" | Stops host screen share | `renderer/components/studio/show-stage.tsx:703` | [ ] | [ ] | [ ] |
| P375 | Dialog "Share a screen" | Thumbnail grid of screens/windows to share | `renderer/components/studio/show-stage.tsx:764` | [ ] | [ ] | [ ] |
| P376 | Empty "Nothing to share. Check Screen Recording in System Settings." | No sources listed *(all (macOS wording))* | `renderer/components/studio/show-stage.tsx:774` | [ ] | [ ] | [ ] |
| P377 | "Hide screen"/"Show screen" + key + chip | Same privacy state on stage | `renderer/components/studio/show-stage.tsx:819` | [ ] | [ ] | [ ] |
| P378 | "On stage n" / "Backstage n" lists | Everyone in room | `renderer/components/studio/show-stage.tsx:1457` | [ ] | [ ] | [ ] |
| P379 | "Bring on" / "Send backstage" | Moves guest on or off stage | `renderer/components/studio/show-stage.tsx:1564` | [ ] | [ ] | [ ] |
| P380 | Person mic toggle / screen-share toggle | Mute guest/host; stop guest share | `renderer/components/guests/room-person.tsx:395` | [ ] | [ ] | [ ] |
| P381 | Person ⋯ "Spotlight"/"End spotlight" | Spotlight layout for person | `renderer/components/studio/show-stage.tsx:1522` | [ ] | [ ] | [ ] |
| P382 | Host ⋯ "Turn camera off"/"Turn camera on" | Host camera in room | `renderer/components/studio/show-stage.tsx:1541` | [ ] | [ ] | [ ] |
| P383 | Guest ⋯ "Rename…", "Remove…", "Ban…" | Moderation dialogs ("Rename guest", confirms) | `renderer/components/guests/guest-moderation.tsx:93` | [ ] | [ ] | [ ] |
| P384 | Backstage empty + "Invite link" | Opens Guests page | `renderer/components/studio/show-stage.tsx:1475` | [ ] | [ ] | [ ] |
| P385 | "Program" / "Program preview" monitor | Cloud return or managed-stage preview | `renderer/components/studio/show-stage.tsx:1069` | [ ] | [ ] | [ ] |
| P386 | Program state badge (tooltip) | Applied/warning page report | `renderer/components/studio/show-stage.tsx:1072` | [ ] | [ ] | [ ] |
| P387 | Takeover muted badge | Takeover silences voices on program | `renderer/components/studio/show-stage.tsx:1084` | [ ] | [ ] | [ ] |
| P388 | "Listen to the program"/"Mute the program" | Plays return audio | `renderer/components/studio/show-stage.tsx:1107` | [ ] | [ ] | [ ] |
| P389 | "More for the Program" ⋯ "Send to Videorc Camera"/"Stop sending…" | Sends program preview to virtual camera *(where virtual camera supported (show-stage.tsx:1015))* *(Windows: hidden until proven, plan 260 "What parity means")* | `renderer/components/studio/show-stage.tsx:1043` | [ ] | n/a | [ ] |
| P390 | Program waiting text | "Waiting for the program…" / empty | `renderer/components/studio/show-stage.tsx:1146` | [ ] | [ ] | [ ] |
| P391 | Graphics/avatar overlays + failure text | Banners, captions, chat, avatar preview | `renderer/components/studio/show-stage.tsx:872` | [ ] | [ ] | [ ] |
| P392 | Reason/status lines | Avatar, animation, graphics, scene, Videorc Camera status | `renderer/components/studio/show-stage.tsx:1178` | [ ] | [ ] | [ ] |
| P393 | Opt-in chips → Guests | Program opt-ins; opens Guests | `renderer/components/studio/show-stage.tsx:1212` | [ ] | [ ] | [ ] |
| P394 | Output profile chips (tooltip) | What each cloud output sends | `renderer/components/studio/show-stage.tsx:1234` | [ ] | [ ] | [ ] |

### Talk-show room host and camera-off avatar

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P395 | Room controller (no UI) | Runs room, hands value to cloud context | `renderer/components/studio/talk-show-room-host.tsx:31` | [ ] | [ ] | [ ] |
| P396 | Join request chime | Local chime when someone asks to join | `renderer/components/studio/talk-show-room-host.tsx:41` | [ ] | [ ] | [ ] |
| P397 | Cloud recording watch | Reports stopped cloud recording to Library | `renderer/components/studio/talk-show-room-host.tsx:47` | [ ] | [ ] | [ ] |
| P398 | Scripted room hook | Smoke-test scripted room *(dev builds only)* | `renderer/components/studio/talk-show-room-host.tsx:55` | dev | dev | dev |
| P399 | Videorc Camera retire | Room program camera ends with room *(Windows: hidden until proven, plan 260 "What parity means")* | `renderer/components/studio/talk-show-room-host.tsx:89` | [ ] | n/a | [ ] |
| P400 | Camera-off avatar | Circle with initial; "Camera off" for screen readers | `renderer/components/studio/camera-off-avatar.tsx:12` | [ ] | [ ] | [ ] |

### Sources page header (sources-tab.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P401 | "Sources" title + description | "Changes apply live." / Linux: change while idle *(Linux copy differs)* | `renderer/lib/platform-copy.ts:104` | [x] | [ ] | [ ] |
| P402 | "Refresh"/"Refreshing…" | Re-reads screens, windows, cameras, microphones | `renderer/components/tabs/sources-tab.tsx:35` | [x] | [ ] | [ ] |
| P403 | Refresh re-asks portal share | Re-opens share dialog after it ended unanswered *(Linux only (apps/desktop/src/renderer/src/lib/screen-share-recovery.ts:38))* | `renderer/components/tabs/sources-tab.tsx:44` | n/a | n/a | [ ] |
| P404 | Layout | Video beside Audio at lg; stacked narrower | `renderer/components/tabs/sources-tab.tsx:71` | [x] | [ ] | [ ] |

### Permission alerts (source-permission-alerts.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P405 | Screen Recording alert | "Screen Recording permission is required for Videorc." *(macOS (not Windows: system-access.ts:285; none on Linux: system-access.ts:254))* | `renderer/lib/source-permissions.ts:110` | [x] | n/a | n/a |
| P406 | "Reopen Videorc to record your screen." | Grant needs relaunch *(macOS)* | `renderer/lib/source-permissions.ts:114` | [x] | n/a | n/a |
| P407 | Camera / Microphone alerts | Permission required; OS-specific fix path *(macOS + Windows wording (source-permissions.ts:55))* | `renderer/lib/source-permissions.ts:63` | [x] | [ ] | [ ] |
| P408 | Fix button (actionLabel) | Allow access / opens OS privacy settings *(per OS)* | `renderer/components/sources/source-permission-alerts.tsx:64` | [x] | [ ] | [ ] |
| P409 | Reveal helper button | "Show helper in …" reveal target *(per OS)* | `renderer/components/sources/source-permission-alerts.tsx:72` | [ ] | [ ] | [ ] |
| P410 | "Videorc couldn't check every device." + "Open Health" | Device warnings; opens Health | `renderer/components/sources/source-permission-alerts.tsx:82` | [x] | [ ] | [ ] |

### Video column (video-sources.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P411 | "Video" section description | "What people see." (+ fresh-frames note live) | `renderer/components/sources/video-sources.tsx:108` | [x] | [ ] | [ ] |
| P412 | "Screen" row status chip | Live/needs permission/not shared etc. *(all; "Not shared" Linux (apps/desktop/src/renderer/src/lib/screen-share-recovery.ts:30))* | `renderer/components/sources/video-sources.tsx:117` | [x] | [ ] | [ ] |
| P413 | "Screen / window" picker | Searchable, grouped; "None" when allowed *(all; locked when no grant (video-sources.tsx:272))* | `renderer/components/sources/video-sources.tsx:124` | [x] | [ ] | [ ] |
| P414 | Screen facts line | Resolution/fps facts | `renderer/components/sources/video-sources.tsx:141` | [x] | [ ] | [ ] |
| P415 | Scene line + "Open Scenes" | Which scene's screen; scrolls Studio Scenes | `renderer/components/sources/video-sources.tsx:144` | [x] | [ ] | [ ] |
| P416 | "Synthetic diagnostic source" switch | Frame-number test screen *(dev builds only (:429))* | `renderer/components/sources/video-sources.tsx:162` | dev | dev | dev |
| P417 | "Camera" row status chip | Camera state incl. low fps, stand-in | `renderer/components/sources/video-sources.tsx:183` | [x] | [ ] | [ ] |
| P418 | "Camera" picker ("Off") | Switches camera live | `renderer/components/sources/video-sources.tsx:190` | [x] | [ ] | [ ] |
| P419 | Camera format shortfall alert | Camera can't meet requested rate | `renderer/components/sources/video-sources.tsx:207` | [x] | [ ] | [ ] |
| P420 | Camera facts line | Camera format facts | `renderer/components/sources/video-sources.tsx:211` | [x] | [ ] | [ ] |
| P421 | "Low-light compensation" switch | Brightens picture; may halve fps *(Windows only (crates/videorc-backend/src/camera_low_light.rs:564))* | `renderer/components/sources/video-sources.tsx:214` | n/a | [ ] | n/a |
| P422 | Picker search / finding text | "Search …", "Finding screens and windows…" etc. | `renderer/lib/source-select-state.ts:52` | [x] | [ ] | [ ] |

### Source item shell (source-item.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P423 | Header click / More chevron | Expands "More … settings"; remembered per device | `renderer/components/sources/source-item.tsx:136` | [x] | [ ] | [ ] |
| P424 | Status chip / tag | Source status; tag (e.g. "Sync +40 ms") | `renderer/components/sources/source-item.tsx:42` | [x] | [ ] | [ ] |
| P425 | Value readout reset | "Reset to 0 dB" when off default | `renderer/components/sources/source-item.tsx:213` | [x] | [ ] | [ ] |

### Audio mixer column (sources-audio-mixer.tsx, gain-faders.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P426 | "Audio" section description | After gain; or room-mic processing text | `renderer/components/sources/sources-audio-mixer.tsx:235` | [x] | [ ] | [ ] |
| P427 | "Room microphone" alert | Processing detail for room mic | `renderer/components/sources/sources-audio-mixer.tsx:242` | [ ] | [ ] | [ ] |
| P428 | Retro LCD meters | Meters drawn as LCD when Retro LCD on | `renderer/components/sources/sources-audio-mixer.tsx:233` | [ ] | [ ] | [ ] |
| P429 | ⌘/Ctrl+↑/↓ | Moves focus between channel strips | `renderer/components/sources/sources-audio-mixer.tsx:148` | [ ] | [ ] | [ ] |
| P430 | "Microphone" status chip | Muted/silent/takeover/switching state | `renderer/components/sources/sources-audio-mixer.tsx:312` | [x] | [ ] | [ ] |
| P431 | "Mute microphone" toggle | Mutes mic; shortcut tooltip | `renderer/components/sources/sources-audio-mixer.tsx:445` | [x] | [ ] | [ ] |
| P432 | Microphone picker ("Off") | Switches microphone live | `renderer/components/sources/sources-audio-mixer.tsx:289` | [x] | [ ] | [ ] |
| P433 | "No microphone selected." | Empty mic fact | `renderer/components/sources/sources-audio-mixer.tsx:515` | [x] | [ ] | [ ] |
| P434 | "Microphone level" meter | Live mic level | `renderer/components/sources/sources-audio-mixer.tsx:518` | [x] | [ ] | [ ] |
| P435 | Mic "Gain" fader | −24…+24 dB, reset 0 | `renderer/components/audio/gain-faders.tsx:42` | [x] | [ ] | [ ] |
| P436 | Level unavailable lines | Why mic level missing | `renderer/components/sources/sources-audio-mixer.tsx:521` | [x] | [ ] | [ ] |
| P437 | "Noise reduction" switch | RNNoise on/off; needs a mic | `renderer/components/sources/sources-audio-mixer.tsx:533` | [x] | [ ] | [ ] |
| P438 | More: "Microphone sync" slider (reset, input) | Offset voice ± ms vs video | `renderer/components/sources/sources-audio-mixer.tsx:469` | [x] | [ ] | [ ] |
| P439 | More: "Keep microphone ready" switch | Warm mic while Studio visible *(macOS only (CoreAudio ids, :269))* | `renderer/components/sources/sources-audio-mixer.tsx:493` | [x] | n/a | n/a |
| P440 | More: "Calibrate" (Stimulus, "Import JSON…", "Apply") | A/V sync measurement import *(dev builds only (:256))* | `renderer/components/sources/sources-audio-mixer.tsx:624` | dev | dev | dev |
| P441 | "System audio" row | "Everything your Mac/PC plays, except Videorc." *(macOS; hidden Linux/older Windows (apps/desktop/src/renderer/src/lib/system-audio.ts:34))* | `renderer/components/sources/sources-audio-mixer.tsx:813` | [x] | [ ] | [ ] |
| P442 | "System audio" switch | Toggles capture; shortcut tooltip *(as above)* | `renderer/components/sources/sources-audio-mixer.tsx:763` | [x] | [ ] | [ ] |
| P443 | System audio meter / idle line | Level while bus runs *(as above)* | `renderer/components/sources/sources-audio-mixer.tsx:816` | [x] | [ ] | [ ] |
| P444 | System audio "Gain" fader | Gain with reset *(as above)* | `renderer/components/audio/gain-faders.tsx:82` | [x] | [ ] | [ ] |
| P445 | Issue alert + "Open Permissions" | Unavailable: opens Settings → Permissions *(macOS only)* | `renderer/components/sources/sources-audio-mixer.tsx:748` | [x] | n/a | n/a |
| P446 | Issue alert + "Resume" | Echo pause resume *(as above)* | `renderer/components/sources/sources-audio-mixer.tsx:752` | [x] | [ ] | [ ] |
| P447 | More: "Pause if your stream echoes back" | Echo guard switch *(as above)* | `renderer/components/sources/sources-audio-mixer.tsx:783` | [x] | [ ] | [ ] |
| P448 | More: tips list | Tab capture, headphones; volume note *(volume bullet macOS only (:801))* | `renderer/components/sources/sources-audio-mixer.tsx:795` | [x] | [ ] | [ ] |
| P449 | "Sounds" row meter / "Level shows while recording or live." | Soundboard mix level | `renderer/components/sources/sources-audio-mixer.tsx:919` | [x] | [ ] | [ ] |
| P450 | "Level" fader ("Sounds level") | Trims all sounds; saves on release | `renderer/components/sources/sources-audio-mixer.tsx:928` | [ ] | [ ] | [ ] |
| P451 | "Hear sounds yourself" switch | Local monitor of sounds | `renderer/components/sources/sources-audio-mixer.tsx:959` | [ ] | [ ] | [ ] |


## Scene ⌘3, Captions ⌘4 and Output ⌘5

### Scene ⌘3: Scenes list (components/scene/scene-list.tsx, scene-entries.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P452 | "Edit scene" button | Turns the stage editor on and selects the camera | `renderer/components/scene/scene-list.tsx:66-74` | [ ] | [ ] | [ ] |
| P453 | "Add scene…" button | Opens the Add scene picker dialog | `renderer/components/scene/scene-list.tsx:76-85` | [ ] | [ ] | [ ] |
| P454 | Disabled reason "Update Videorc to change your scenes." | Shown when the scene library is read-only | `renderer/components/scene/scene-entries.tsx:44` | [ ] | [ ] | [ ] |
| P455 | Scenes line (description) | Says "Each scene shows its own screen. ⌃⌥1 to ⌃⌥9 switch them…" | `renderer/components/scene/scene-entries.tsx:51-69` | [ ] | [ ] | [ ] |
| P456 | Scene library error line | Shows a status message when the library fails | `renderer/components/scene/scene-list.tsx:92-96` | [ ] | [ ] | [ ] |
| P457 | Scene row (name button) | Click puts the scene on stream, or opens Resolve if sources are missing | `renderer/components/scene/scene-list.tsx:186-194; scene-dialogs.tsx:168-171` | [ ] | [ ] | [ ] |
| P458 | Row thumbnail | Small layout picture with the screen still | `renderer/components/scene/scene-list.tsx:220-249` | [ ] | [ ] | [ ] |
| P459 | Row meta text | "Applying…", why it's blocked, "Resolve sources", or what it shows | `renderer/components/scene/scene-entries.tsx:157-165` | [ ] | [ ] | [ ] |
| P460 | "Follows" badge | Shown when the scene follows its app | `renderer/components/scene/scene-list.tsx:201` | [ ] | [ ] | [ ] |
| P461 | Shortcut key chips | Show the position key and custom key, or a conflict reason | `renderer/components/scene/scene-shortcut-keys.tsx:10-45` | [ ] | [ ] | [ ] |
| P462 | On-stream check ("On stream") | Marks the scene that is live | `renderer/components/scene/scene-list.tsx:203` | [ ] | [ ] | [ ] |
| P463 | Disabled-row tooltip | Explains why a scene can't go on (e.g. app not open) | `renderer/components/scene/scene-list.tsx:185` | [ ] | [ ] | [ ] |
| P464 | Drag to reorder | Drag a row to move the scene; shows a drop line | `renderer/components/scene/scene-entries.tsx:258-281` | [ ] | [ ] | [ ] |
| P465 | ⌥↑ / ⌥↓ on a row | Moves the focused scene up or down one place | `renderer/components/scene/scene-entries.tsx:282-296; renderer/lib/scene-list.ts:24-25` | [ ] | [ ] | [ ] |
| P466 | ⋯ kebab "Actions for {name}" | Opens the scene's actions menu (shows on hover) | `renderer/components/scene/scene-list.tsx:204-209` | [ ] | [ ] | [ ] |
| P467 | Camera-gap reason + "Open Sources" | Explains once why camera scenes are off, links to Sources | `renderer/components/scene/scene-list.tsx:125-132` | [ ] | [ ] | [ ] |

### Scene ⌘3: Scene ⋯ menu and dialogs (components/scene/scene-dialogs.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P468 | "Rename…" | Opens the Rename scene dialog | `renderer/components/scene/scene-dialogs.tsx:286-292` | [ ] | [ ] | [ ] |
| P469 | "Change screen…" | Opens the picker to change what the scene shows | `renderer/components/scene/scene-dialogs.tsx:293-300` | [ ] | [ ] | [ ] |
| P470 | "Set key…" | Opens the Set key dialog for the scene's global key | `renderer/components/scene/scene-dialogs.tsx:301-306` | [ ] | [ ] | [ ] |
| P471 | "Follow the app" / "Stop following" | Turns follow-front-window on or off for an app scene *(macOS only (app scenes, scene-picker-dialog.tsx:119-120))* | `renderer/components/scene/scene-dialogs.tsx:307-318` | [ ] | n/a | n/a |
| P472 | "Save audio to scene" | Saves the current mic and system audio into the scene | `renderer/components/scene/scene-dialogs.tsx:319-333` | [ ] | [ ] | [ ] |
| P473 | "Guests in the room…" | Opens the guest placement dialog | `renderer/components/scene/scene-dialogs.tsx:336-342` | [ ] | [ ] | [ ] |
| P474 | "Duplicate" | Copies the scene to the end of the list | `renderer/components/scene/scene-dialogs.tsx:343-356` | [ ] | [ ] | [ ] |
| P475 | "Delete" (destructive) | Opens Delete confirm; last scene and live scene are protected | `renderer/components/scene/scene-dialogs.tsx:357-366` | [ ] | [ ] | [ ] |
| P476 | Dialog "Delete scene?" / "Delete scene" | Confirms the delete and names the next scene on stream | `renderer/components/scene/scene-dialogs.tsx:437-450, 260-269` | [ ] | [ ] | [ ] |
| P477 | Dialog "Rename scene": "Name" input, "Cancel", "Rename" | Unique name, 1–80 chars; Enter submits; shows an inline error | `renderer/components/scene/scene-dialogs.tsx:533-598` | [ ] | [ ] | [ ] |
| P478 | Dialog "Set key": "Key" recorder, "Done" | Records the scene's global shortcut, checks for conflicts | `renderer/components/scene/scene-dialogs.tsx:618-683` | [ ] | [ ] | [ ] |
| P479 | Set key Wayland warning alert | Says global keys don't work in this session *(Linux Wayland only)* | `renderer/components/scene/scene-dialogs.tsx:605-612, 648-652` | n/a | n/a | [ ] |
| P480 | Dialog "Guests in the room": "Guests" segmented control ("Beside", "Below", "Over the scene"), "Cancel", "Save" | Sets where talk-show guests go | `renderer/components/scene/scene-dialogs.tsx:462-530; renderer/lib/scene-guest-roles.ts:26-30` | [ ] | [ ] | [ ] |
| P481 | Dialog "Resolve scene sources": "Camera" picker (none label "Off") | Picks a connected camera for the scene | `renderer/components/scene/scene-dialogs.tsx:721-730` | [ ] | [ ] | [ ] |
| P482 | Resolve: "Screen / window" picker (none label "None"), searchable | Picks a connected screen or window | `renderer/components/scene/scene-dialogs.tsx:731-756` | [ ] | [ ] | [ ] |
| P483 | Resolve: "Apply without background" / "Background omitted" toggle | Drops the scene's background when applying | `renderer/components/scene/scene-dialogs.tsx:757-765` | [ ] | [ ] | [ ] |
| P484 | Resolve: "Cancel", "Apply scene", error status line | Applies the repaired sources; the scene keeps them | `renderer/components/scene/scene-dialogs.tsx:767-784` | [ ] | [ ] | [ ] |
| P485 | Repair error "The scene couldn't be put on stream…" | Shown in the repair dialog when a switch fails | `renderer/components/scene/scene-dialogs.tsx:156-160` | [ ] | [ ] | [ ] |

### Scene ⌘3: Add scene / Change screen picker (components/scene/scene-picker-dialog.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P486 | Title "Add scene" / "Change screen" + description | Explains what the pick does | `renderer/components/scene/scene-picker-dialog.tsx:207-210, 349-357` | [ ] | [ ] | [ ] |
| P487 | Search "Search apps and displays…" / "Search apps, windows and displays…" | Filters the picks *(macOS only (:120))* | `renderer/components/scene/scene-picker-dialog.tsx:211-225` | [ ] | n/a | n/a |
| P488 | Screen Recording permission alert | Shown when capture permission is missing | `renderer/components/scene/scene-picker-dialog.tsx:227-229` | [ ] | [ ] | [ ] |
| P489 | Empty "Nothing matches “{q}”." | No search results | `renderer/components/scene/scene-picker-dialog.tsx:230-234` | [ ] | [ ] | [ ] |
| P490 | "Apps" group (app cards, multi-select) | Picks an app to follow *(macOS only (:119-120))* | `renderer/components/scene/scene-picker-dialog.tsx:235-268` | [ ] | n/a | n/a |
| P491 | Apps loading "Finding your open apps…" | Shown while apps load *(macOS only)* | `renderer/components/scene/scene-picker-dialog.tsx:237-241` | [ ] | n/a | n/a |
| P492 | Empty "No app windows found" + "Refresh" | No apps; Refresh asks again *(macOS only)* | `renderer/components/scene/scene-picker-dialog.tsx:242-253` | [ ] | n/a | n/a |
| P493 | "A specific window" collapsible (window list) | Keeps one fixed window; Change screen only *(macOS only)* | `renderer/components/scene/scene-picker-dialog.tsx:270-278, 529-560` | [ ] | n/a | n/a |
| P494 | "Displays" group (display cards with stills) | Picks a display | `renderer/components/scene/scene-picker-dialog.tsx:279-299` | [ ] | [ ] | [ ] |
| P495 | Empty "No displays found" | Says to connect a display or check Sources | `renderer/components/scene/scene-picker-dialog.tsx:281-285` | [ ] | [ ] | [ ] |
| P496 | "Camera" group card "Camera only" / "No screen" | Scene with no screen | `renderer/components/scene/scene-picker-dialog.tsx:300-321` | [ ] | [ ] | [ ] |
| P497 | Layout note "…uses {layout}, which shows no screen…" | Warns that the layout hides the chosen screen | `renderer/components/scene/scene-picker-dialog.tsx:323-330, 363-369` | [ ] | [ ] | [ ] |
| P498 | "Cancel"; "Add scene" / "Add N scenes" / "Change screen" | Commits the picks; the disabled reason says what's missing | `renderer/components/scene/scene-picker-dialog.tsx:331-345` | [ ] | [ ] | [ ] |

### Scene ⌘3: Layout section (components/tabs/layout-tab.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P499 | Orientation segmented control "Horizontal (16:9)" / "Vertical (9:16)" | Switches the studio canvas orientation; locked while live | `renderer/components/tabs/layout-tab.tsx:244-257, 840-851` | [ ] | [ ] | [ ] |
| P500 | Lock reason "The canvas is fixed while you're recording or live…" | Explains the orientation lock | `renderer/components/tabs/layout-tab.tsx:210-211` | [ ] | [ ] | [ ] |
| P501 | Layout presets (horizontal) "Screen + camera", "Screen only", "Camera only", "Side by side" | Applies a layout to the scene on stream | `renderer/components/tabs/layout-tab.tsx:216-221, 862-900; renderer/lib/layout-labels.ts:10-21` | [ ] | [ ] | [ ] |
| P502 | Layout presets (vertical) "Camera top", "Camera bottom", "Split", "Screen + camera", "Screen only", "Camera only" | Vertical layouts | `renderer/components/tabs/layout-tab.tsx:223-242` | [ ] | [ ] | [ ] |
| P503 | Pending spinner on a preset | Shows while that switch is applying | `renderer/components/tabs/layout-tab.tsx:875-877` | [ ] | [ ] | [ ] |
| P504 | Layout that needs a screen | Opens Change screen when the scene shows none | `renderer/components/tabs/layout-tab.tsx:805-818` | [ ] | [ ] | [ ] |
| P505 | "Freeform" toggle | Enters freeform mode and restores the remembered arrangement | `renderer/components/tabs/layout-tab.tsx:904-916, 651-673` | [ ] | [ ] | [ ] |
| P506 | Scene switch status line | Says what a slow switch is waiting for | `renderer/components/scene/scene-switch-status.tsx:32-69` | [ ] | [ ] | [ ] |
| P507 | Hint "Switching applies live…" | Shown during a session | `renderer/components/tabs/layout-tab.tsx:923-926` | [ ] | [ ] | [ ] |
| P508 | Hint "Choose a screen or window in Sources…" + "Open Sources" | Shown when no screen is chosen | `renderer/components/tabs/layout-tab.tsx:927-931` | [ ] | [ ] | [ ] |
| P509 | Hint "Choose a camera in Sources…" + "Open Sources" | Shown when no camera is chosen | `renderer/components/tabs/layout-tab.tsx:932-938` | [ ] | [ ] | [ ] |
| P510 | "Screen" framing control "Fill" / "Fit" (aria "Screen framing") | Sets whether the screen fills or fits (vertical, or landscape screen layouts) | `renderer/components/tabs/layout-tab.tsx:940-956; renderer/components/studio/scenes-gallery.tsx:36-39, 68-112` | [ ] | [ ] | [ ] |
| P511 | "Animate scene changes" switch | Glides layout switches instead of cutting | `renderer/components/tabs/layout-tab.tsx:959-970` | [ ] | [ ] | [ ] |

### Scene ⌘3: Canvas / freeform stage editor (components/scene/scene-stage.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P512 | Canvas description | "Changes save to “{scene}”…" or "Drag sources and overlays into place." | `renderer/components/tabs/layout-tab.tsx:819-821` | [ ] | [ ] | [ ] |
| P513 | "Overlays on" segmented control "Horizontal" / "Vertical" | Shows the vertical stream's overlay positions | `renderer/components/tabs/layout-tab.tsx:978-991` | [ ] | [ ] | [ ] |
| P514 | Source and overlay chips toolbar (aria "Scene sources") | Select a source, overlay or banner; shows a state badge | `renderer/components/scene/scene-stage.tsx:1006-1070` | [ ] | [ ] | [ ] |
| P515 | Chip badges "Hidden" / "Off" / "Stream only" / "Recording only" | Says what each output shows | `renderer/components/scene/overlay-stage.ts:86-91` | [ ] | [ ] | [ ] |
| P516 | Click a source on the canvas | Selects it and turns on edit mode | `renderer/components/scene/scene-stage.tsx:1205-1213; renderer/components/tabs/layout-tab.tsx:1104-1111` | [ ] | [ ] | [ ] |
| P517 | Drag a source (move) | Moves the source box; commits on release | `renderer/components/scene/scene-stage.tsx:727-797, 913-961` | [ ] | [ ] | [ ] |
| P518 | Resize handles ("Resize {id}") | 8 handles resize the selected box | `renderer/components/scene/scene-stage.tsx:1615-1706` | [ ] | [ ] | [ ] |
| P519 | Shift while dragging | Locks the move to one axis, or keeps aspect on resize | `renderer/components/scene/stage-gesture.ts:133-153; scene-stage.tsx:1530-1535` | [ ] | [ ] | [ ] |
| P520 | Alt while dragging | Turns off snapping | `renderer/components/scene/stage-gesture.ts:140-175` | [ ] | [ ] | [ ] |
| P521 | Alt + drag an edge | Crops the screen instead of resizing it (Freeform) | `renderer/components/scene/scene-stage.tsx:758-765` | [ ] | [ ] | [ ] |
| P522 | Snapping guides | Snap to the canvas and other boxes (5 px on, 9 px off) | `renderer/components/scene/stage-gesture.ts:27-29; scene-stage.tsx:1420-1433` | [ ] | [ ] | [ ] |
| P523 | Corner snap on release | In a preset layout, dropping the camera in a corner applies that corner | `renderer/components/scene/scene-stage.tsx:883-894, 955-958; layout-tab.tsx:1114-1129` | [ ] | [ ] | [ ] |
| P524 | Escape | Cancels the gesture in progress | `renderer/components/scene/scene-stage.tsx:572-578` | [ ] | [ ] | [ ] |
| P525 | Arrow keys on the focused canvas | Nudge the selected source | `renderer/components/scene/scene-stage.tsx:972-979; stage-nudge.ts:13-25` | [ ] | [ ] | [ ] |
| P526 | Shift + arrow | Nudges a bigger step | `renderer/components/scene/stage-nudge.ts:24` | [ ] | [ ] | [ ] |
| P527 | Window blur, scroll or resize | Cancels the gesture | `renderer/components/scene/scene-stage.tsx:583-590` | [ ] | [ ] | [ ] |
| P528 | Drag an overlay item or banner | Moves it or resizes it (banners keep aspect) | `renderer/components/scene/scene-stage.tsx:804-859, 1292-1419` | [ ] | [ ] | [ ] |
| P529 | Empty "No sources in the scene yet…" + "Open Sources" | Empty-stage state | `renderer/components/scene/scene-stage.tsx:1470-1483` | [ ] | [ ] | [ ] |
| P530 | Layout-only note + "Open Preview" / "Show Preview" / "Pop out Preview" | Says where the picture is when the canvas is a diagram *(Windows; also macOS/Linux when the native surface is off (layout-tab.tsx:723-725, 745-746))* | `renderer/components/scene/scene-stage.tsx:204-219, 1484-1502` | [ ] | [ ] | [ ] |
| P531 | Live canvas (native preview docked in the stage) | The real picture under the hit-only SVG *(macOS and Linux only (:725))* | `renderer/components/tabs/layout-tab.tsx:723-742` | [ ] | n/a | [ ] |
| P532 | Auto-open docked preview on page entry | Opens the closed preview docked into the canvas *(macOS and Linux only)* | `renderer/components/tabs/layout-tab.tsx:766-789` | [ ] | n/a | [ ] |
| P533 | Live hint (why the docked preview is hidden) | One footer line with the reason *(macOS and Linux only)* | `renderer/components/scene/scene-stage.tsx:1513-1516; layout-tab.tsx:738-742` | [ ] | n/a | [ ] |
| P534 | Footer key hints ("nudge", "constrain / aspect / bigger nudge", "no snap / crop edge", "cancel") | Lists the stage keys | `renderer/components/scene/scene-stage.tsx:1517-1547` | [ ] | [ ] | [ ] |
| P535 | "Undo" button (⌘Z / Ctrl+Z chip) | Single-level undo of the last layout change | `renderer/components/scene/scene-stage.tsx:1556-1569; stage-undo-control.ts` | [ ] | [ ] | [ ] |
| P536 | ⌘Z / Ctrl+Z on the page | Same undo; ignored in text fields, dialogs and gestures | `renderer/components/tabs/layout-tab.tsx:701-716; renderer/lib/layout-undo-shortcut.ts:22-32` | [ ] | [ ] | [ ] |
| P537 | Redo | Not implemented (⇧⌘Z is explicitly not handled) *(n/a)* | `renderer/lib/layout-undo-shortcut.ts:8` | n/a | n/a | n/a |
| P538 | "Make freeform" button | Shown after grabbing a box a preset owns; enters Freeform | `renderer/components/scene/scene-stage.tsx:737, 1570-1574` | [ ] | [ ] | [ ] |
| P539 | "Snap" toggle | Turns snapping on or off in Freeform (off by default) | `renderer/components/scene/scene-stage.tsx:426-427, 1575-1587` | [ ] | [ ] | [ ] |
| P540 | "Pop out" / "Show preview here" | Floats or docks the live preview *(macOS and Linux only)* | `renderer/components/scene/scene-stage.tsx:1591-1602` | [ ] | n/a | [ ] |
| P541 | "Open Preview" / "Close Preview" | Plain preview window toggle *(Windows (and when the live canvas is unsupported))* | `renderer/components/scene/scene-stage.tsx:1603-1607` | [ ] | [ ] | [ ] |
| P542 | Live placement hint "Changes apply to your stream when you let go." | Shown while recording or live | `renderer/components/tabs/layout-tab.tsx:164, 207` | [ ] | [ ] | [ ] |

### Scene ⌘3: Inspector, source / placement / transforms (components/tabs/layout-tab.tsx, source-transform-fields.tsx, screen-*)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P543 | Empty "Inspector" ("Click a source, an overlay or a banner…") | Shown when nothing is selected | `renderer/components/tabs/layout-tab.tsx:1196-1202` | [ ] | [ ] | [ ] |
| P544 | "Visible in scene" switch | Shows or hides the source; locked while live | `renderer/components/tabs/layout-tab.tsx:1776-1803` | [ ] | [ ] | [ ] |
| P545 | Full-canvas source compact panel | Says "Fills the whole canvas… Use Freeform…" | `renderer/components/tabs/layout-tab.tsx:1238-1266` | [ ] | [ ] | [ ] |
| P546 | "Screen size" slider (60–100%) | Sets the background's visibility around the screen | `renderer/components/scene/screen-size-field.tsx:11-12, 58-60; layout-tab.tsx:1260-1265` | [ ] | [ ] | [ ] |
| P547 | "Placement" "Reset" button | Resets the source's transform | `renderer/components/tabs/layout-tab.tsx:1283-1302` | [ ] | [ ] | [ ] |
| P548 | Placement description and lock reasons | Hint text, or "Position and size are locked…" / "…isn't available on this recording…" | `renderer/components/tabs/layout-tab.tsx:149-209` | [ ] | [ ] | [ ] |
| P549 | "Position and size": X, Y, W, H % inputs | Exact box; Enter commits, Escape reverts | `renderer/components/scene/source-transform-fields.tsx:121-181; transform-fields-math.ts:30-35` | [ ] | [ ] | [ ] |
| P550 | Aspect lock button "Lock/Unlock aspect ratio" | Keeps or frees the box aspect | `renderer/components/scene/source-transform-fields.tsx:97-137` | [ ] | [ ] | [ ] |
| P551 | Pixel readout and forced-aspect reason | e.g. "The picture sets the shape. Crop to change it." | `renderer/components/scene/source-transform-fields.tsx:183-190; layout-tab.tsx:161` | [ ] | [ ] | [ ] |
| P552 | Screen "Zoom" slider (100–400%) + hint | Zooms the screen; "Zooming softens text…" | `renderer/components/scene/screen-zoom-field.tsx:62-76; screen-zoom.ts:12-15` | [ ] | [ ] | [ ] |
| P553 | "Crop": Left / Top / Right / Bottom % inputs | Crops the screen picture | `renderer/components/scene/source-transform-fields.tsx:202-270; transform-fields-math.ts:145-150` | [ ] | [ ] | [ ] |
| P554 | "Reset crop" | Clears the crop | `renderer/components/scene/source-transform-fields.tsx:~275-282` | [ ] | [ ] | [ ] |
| P555 | Nudge d-pad "Nudge source up/left/down/right" | Nudges the source; Shift for a bigger step | `renderer/components/tabs/layout-tab.tsx:1376-1431` | [ ] | [ ] | [ ] |

### Scene ⌘3: Camera inspector, placement / lens / mask (layout-tab.tsx CameraInspector)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P556 | "Reset camera settings" + confirm "Reset camera settings?" | Restores the camera placement, frame and lens defaults | `renderer/components/scene/camera-reset-button.tsx:34-60` | [ ] | [ ] | [ ] |
| P557 | "Split" "50/50" / "60/40" / "70/30" | Side-by-side split ratio | `renderer/components/tabs/layout-tab.tsx:264-268, 1546-1556` | [ ] | [ ] | [ ] |
| P558 | "Camera side" "Camera left" / "Camera right" | Which side the camera sits on (side by side) | `renderer/components/tabs/layout-tab.tsx:270-273, 1557-1565` | [ ] | [ ] | [ ] |
| P559 | "Corner" "Top left" / "Top right" / "Bottom left" / "Bottom right" | Camera corner in inset layouts | `renderer/components/tabs/layout-tab.tsx:276-281, 1568-1580` | [ ] | [ ] | [ ] |
| P560 | "Size" "Small" / "Medium" / "Large" | Camera bubble size (not in Freeform) | `renderer/components/tabs/layout-tab.tsx:283-287, 1584-1594` | [ ] | [ ] | [ ] |
| P561 | "Shape" "Rectangle" / "Rounded" / "Circle" | Camera mask shape (circle mask) | `renderer/components/tabs/layout-tab.tsx:289-293, 1595-1604` | [ ] | [ ] | [ ] |
| P562 | "Corner radius" slider 0–50% | Rounded-mask radius | `renderer/components/tabs/layout-tab.tsx:1607-1619` | [ ] | [ ] | [ ] |
| P563 | "Aspect" "Original" / "Square" / "Portrait" + crop note | Camera crop aspect (not with Circle) | `renderer/components/tabs/layout-tab.tsx:297-301, 1621-1637` | [ ] | [ ] | [ ] |
| P564 | "Margin" slider 0–96 px | Inset margin from the edge (not in Freeform) | `renderer/components/tabs/layout-tab.tsx:1639-1652` | [ ] | [ ] | [ ] |
| P565 | Camera X / Y / W / H fields | Exact camera box | `renderer/components/tabs/layout-tab.tsx:1654-1670` | [ ] | [ ] | [ ] |
| P566 | Placement copy for Camera only, vertical camera, stacked layouts | Explains why corner, size and shape don't apply | `renderer/components/tabs/layout-tab.tsx:1524-1535` | [ ] | [ ] | [ ] |
| P567 | Lens "Fit" "Fill crop" / "Fit frame" | Camera fit; hidden in vertical bands | `renderer/components/tabs/layout-tab.tsx:303-306, 1703-1716` | [ ] | [ ] | [ ] |
| P568 | "Mirror camera" switch | Mirrors the camera | `renderer/components/tabs/layout-tab.tsx:1717-1729` | [ ] | [ ] | [ ] |
| P569 | "Zoom" slider 100–200% | Camera zoom | `renderer/components/tabs/layout-tab.tsx:1730-1740` | [ ] | [ ] | [ ] |
| P570 | "Pan X" / "Pan Y" sliders −100 to 100 | Pans the camera crop | `renderer/components/tabs/layout-tab.tsx:1741-1762` | [ ] | [ ] | [ ] |
| P571 | "Camera look" "Reset" | Resets brightness, contrast and saturation | `renderer/components/scene/camera-look-controls.tsx:20-34` | [ ] | [ ] | [ ] |
| P572 | "Brightness" / "Contrast" / "Saturation" sliders | Camera colour look, saved per camera | `renderer/components/scene/camera-look-controls.tsx:37-75` | [ ] | [ ] | [ ] |
| P573 | Camera look disabled reasons | "Videorc is reconnecting." / "Choose a camera in Sources." | `renderer/components/tabs/layout-tab.tsx:1226-1232` | [ ] | [ ] | [ ] |

### Scene ⌘3: Camera Background (components/camera-background/*)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P574 | "Background" section + description | Blur or replace what's behind you | `renderer/components/camera-background/camera-background-section.tsx:76-82; renderer/lib/camera-background-view.ts:76, 82-83` | [ ] | [ ] | [ ] |
| P575 | Focus from ⌘K / "Background settings" | Scrolls to the section and focuses the pick | `renderer/components/tabs/layout-tab.tsx:552-572; camera-background-section.tsx:56-64` | [ ] | [ ] | [ ] |
| P576 | Tiles "Off" / "Slight blur" / "Strong blur" | Background blur choices (radio, arrow keys move) *(blur tiles disabled on Windows and Linux (lib/camera-background-view.ts:108-111))* | `renderer/lib/camera-background-view.ts:212-214; renderer/components/camera-background/camera-background-tiles.tsx:54-105` | [ ] | [ ] | [ ] |
| P577 | Image tiles (2 shown) | Replace the background with a picture *(disabled on Windows and Linux)* | `renderer/components/camera-background/camera-background-section.tsx:83-92` | [ ] | [ ] | [ ] |
| P578 | "Choose image…" tile | Opens the Choose an image dialog | `renderer/components/camera-background/camera-background-tiles.tsx:107-130` | [ ] | [ ] | [ ] |
| P579 | "Green screen" / "Blue screen" tiles | Chroma key | `renderer/lib/camera-background-view.ts:224-225` | [ ] | [ ] | [ ] |
| P580 | Disabled reasons | "Choose a camera first.", "Background effects come to Windows/Linux in a later update.", "…come to rooms…" *(per platform)* | `renderer/lib/camera-background-view.ts:94-111` | [ ] | [ ] | [ ] |
| P581 | "Blur strength" slider 10–100% (marks "Slight" / "Strong") | Blur amount *(macOS only in effect)* | `renderer/components/camera-background/camera-background-section.tsx:93-107` | [ ] | [ ] | [ ] |
| P582 | "Similarity" / "Smoothness" / "Spill removal" sliders | Chroma-key tuning | `renderer/components/camera-background/camera-background-section.tsx:108-142` | [ ] | [ ] | [ ] |
| P583 | "Hide edges" Left / Top / Right / Bottom % (max 25) | Makes the camera edges see-through for the key | `renderer/components/scene/camera-key-edges-fields.tsx:47-85` | [ ] | [ ] | [ ] |
| P584 | "Show all edges" | Clears the edge masks | `renderer/components/scene/camera-key-edges-fields.tsx:86-97` | [ ] | [ ] | [ ] |
| P585 | Hint line (blur caveat, screen hint) | Lighting or privacy advice | `renderer/components/camera-background/camera-background-section.tsx:69-74, 149-153` | [ ] | [ ] | [ ] |
| P586 | Dialog "Choose an image": tiles, "Open Images", "Done" | Pick a picture; empty "No images yet. Add one in Images." | `renderer/components/camera-background/camera-background-image-dialog.tsx:40-78` | [ ] | [ ] | [ ] |
| P587 | Studio "Background" row popover (viewer, grouped tiles "Blur" / "Images" / "Screen behind you", "Choose…", lock line, "Settings") | Quick background picker from Studio | `renderer/components/camera-background/camera-background-popover.tsx:71-125; camera-background-picker.tsx:30-76` | [ ] | [ ] | [ ] |
| P588 | Dialog "Replace which background?" (10 slot tiles, "Cancel", "Replace {name}") | Replace a full background slot (used from Images) | `renderer/components/background-replace-dialog.tsx:104-167` | [ ] | [ ] | [ ] |

### Scene ⌘3: Overlay item inspector (layout-tab.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P589 | Section title "Highlight" / "Captions" / "Avatar" / "Chat" + description | The selected overlay item | `renderer/components/tabs/layout-tab.tsx:1809-1847; renderer/lib/overlay-layout.ts:31-36` | [ ] | [ ] | [ ] |
| P590 | Off line "Off. Viewers don't see your avatar/chat." | Shown when both outputs are off | `renderer/components/tabs/layout-tab.tsx:1824-1827` | [ ] | [ ] | [ ] |
| P591 | Offline lock alert | Controls are off while reconnecting | `renderer/components/tabs/layout-tab.tsx:1870; overlay-stage.ts:292-294` | [ ] | [ ] | [ ] |
| P592 | "Show on stream" switch | Overlay on the stream | `renderer/components/tabs/layout-tab.tsx:1909-1919` | [ ] | [ ] | [ ] |
| P593 | "Show in recording" switch | Overlay in the recording | `renderer/components/tabs/layout-tab.tsx:1920-1930` | [ ] | [ ] | [ ] |
| P594 | Captions row "Live captions" (Off / On…) → Captions | Opens the Captions page | `renderer/components/tabs/layout-tab.tsx:1938-1961` | [ ] | [ ] | [ ] |
| P595 | "Snap to" / "Snap on the vertical stream": "Top left", "Top right", "Bottom left", "Bottom right", "Bottom center" | One-shot overlay placement | `renderer/components/tabs/layout-tab.tsx:1877-1889; renderer/lib/overlay-layout.ts:54-60` | [ ] | [ ] | [ ] |

### Scene ⌘3: Banners (components/scene/banner-inspector.tsx, banners-section.tsx, banner-*)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P596 | "Banners" section list (thumbnail, name, timing chip, "Showing") | Lists every banner; click selects it on the stage | `renderer/components/scene/banner-inspector.tsx:148-229; banner-timing-chip.tsx` | [ ] | [ ] | [ ] |
| P597 | Row "Show" / "Hide" ("Show {name}") | Toggles the banner; the limit reason is "Four banners are showing…" | `renderer/components/scene/banner-inspector.tsx:213-225; renderer/lib/banners.ts:15` | [ ] | [ ] | [ ] |
| P598 | Offline alert | Shown while reconnecting | `renderer/components/scene/banner-inspector.tsx:181` | [ ] | [ ] | [ ] |
| P599 | "Loading banners…" | Shown before the list loads | `renderer/components/scene/banner-inspector.tsx:230-237` | [ ] | [ ] | [ ] |
| P600 | Empty "No banners yet." + "Open Images" | Empty state | `renderer/components/scene/banner-inspector.tsx:238-246` | [ ] | [ ] | [ ] |
| P601 | Banner inspector header "Show" / "Hide" + state line | "Showing" / "Hidden. Viewers don't see it." / "Off…" | `renderer/components/scene/banner-inspector.tsx:72-82, 324-341` | [ ] | [ ] | [ ] |
| P602 | "Place" / "Place on the vertical stream": "Top left", "Top center", "Top right", "Bottom left", "Bottom center", "Bottom right", "Full frame" | Snap the banner | `renderer/components/scene/banner-inspector.tsx:344-360; renderer/lib/banner-place.ts:48-56` | [ ] | [ ] | [ ] |
| P603 | Size advice lines and warning | Says whether the image is sharp at this size | `renderer/components/scene/banner-inspector.tsx:361-371` | [ ] | [ ] | [ ] |
| P604 | HTML overlay status line | Page loading, failed or blocked network | `renderer/components/scene/banner-inspector.tsx:95-125, 372-385` | [ ] | [ ] | [ ] |
| P605 | "Opacity" slider | Banner opacity; commits on release | `renderer/components/scene/banner-inspector.tsx:387-409` | [ ] | [ ] | [ ] |
| P606 | "Appears in": "Stream" / "Recording" switches | Which outputs show the banner | `renderer/components/scene/banner-inspector.tsx:410-432` | [ ] | [ ] | [ ] |
| P607 | "Order": "Bring to front" / "Send to back" | Drawing order, with an already-front/back reason | `renderer/components/scene/banner-inspector.tsx:433-448` | [ ] | [ ] | [ ] |
| P608 | "Timing" collapsible: "Hide after" (Off, 10 s, 30 s, 1 min, 5 min) | Auto-hide timer | `renderer/components/scene/banner-inspector.tsx:489-541; renderer/lib/banner-timing.ts:13` | [ ] | [ ] | [ ] |
| P609 | "Show every" (Off, 5/10/15/30 min) + "Repeats only while you're recording or live." | Repeat timer | `renderer/components/scene/banner-inspector.tsx:542-571; renderer/lib/banner-timing.ts:16-19` | [ ] | [ ] | [ ] |
| P610 | "Manage in Images" | Opens the Images page | `renderer/components/scene/banner-inspector.tsx:450-453` | [ ] | [ ] | [ ] |
| P611 | (Images page) "Import image…" / "Import HTML…" | Imports a banner | `renderer/components/banners-section.tsx:106-135` | [ ] | [ ] | [ ] |
| P612 | (Images page) row menu: "Show/Hide", "Place on Scene", "Rename…", "Move earlier" (⌥←), "Move later" (⌥→), "Delete…" | Banner actions | `renderer/components/banners-section.tsx:305-337; renderer/lib/takeover-order.ts:6-7` | [ ] | [ ] | [ ] |
| P613 | (Images page) drag reorder; inline rename (Enter / Escape) | Reorders and renames banners | `renderer/components/banners-section.tsx:165-177, 380-405` | [ ] | [ ] | [ ] |
| P614 | (Images page) "Delete banner?" confirm ("Delete banner" / "Deleting…") | Deletes the banner | `renderer/components/banners-section.tsx:215-237` | [ ] | [ ] | [ ] |
| P615 | (Images page) empty "No banners yet" / "Loading banners…" | Empty states | `renderer/components/banners-section.tsx:204-212` | [ ] | [ ] | [ ] |

### Scene ⌘3: Hide screen (components/scene/hide-screen-section.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P616 | "Hide screen" section description | Frosts the screen on every output | `renderer/components/scene/hide-screen-section.tsx:68-72` | [ ] | [ ] | [ ] |
| P617 | "Shortcut" row (key or "Not set") → Settings → Shortcuts | Shows the hide key, default ⌃⌥H | `renderer/components/scene/hide-screen-section.tsx:74-82; shared/global-shortcuts.ts:3` | [ ] | [ ] | [ ] |
| P618 | "Hide when a password manager is in front" switch | Auto-hides when a password manager is in front *(macOS only (:66, :83))* | `renderer/components/scene/hide-screen-section.tsx:90-106` | [ ] | n/a | n/a |
| P619 | "Password managers" list + ⋯ "Remove" | Removes an app (the last one can't be removed) *(macOS only (:85))* | `renderer/components/scene/hide-screen-section.tsx:112-144` | [ ] | n/a | n/a |
| P620 | "Add app…" popover (search "Search open apps…", status lines) | Adds an open app to the list *(macOS only)* | `renderer/components/scene/hide-screen-section.tsx:180-240` | [ ] | n/a | n/a |
| P621 | "Restore built-in apps" | Brings back the removed defaults *(macOS only)* | `renderer/components/scene/hide-screen-section.tsx:147-154` | [ ] | n/a | n/a |

### Scene ⌘3: Shortcuts, follow app, Studio scenes section

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P622 | Scene position keys 1–9 | Switch scenes from any app *(⌃⌥1–9 on macOS; Ctrl+Alt+Shift+1–9 on Windows and Linux)* | `shared/global-shortcuts.ts:24-33` | [ ] | [ ] | [ ] |
| P623 | Custom per-scene key | Set via "Set key…" | `renderer/lib/scene-shortcuts.ts:43-44` | [ ] | [ ] | [ ] |
| P624 | "Follow the app in front" switch | Puts the app's scene on stream when the app comes to front *(macOS only)* | `renderer/components/scene/follow-front-app-switch.tsx:15-35; renderer/components/scene-presets.tsx:166` | [ ] | n/a | n/a |
| P625 | Studio Scenes section (cards, "Edit scene", "Add scene…", "Studio orientation", ⌥← ⌥→ reorder) | Same scenes as cards on Studio | `renderer/components/scene-presets.tsx:116-268` | [ ] | [ ] | [ ] |

### Captions ⌘4 (components/tabs/captions-tab.tsx, components/captions/*)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P626 | "Caption preview" panel + "Sample" / "Latest caption" badge | Renders the chosen style at the canvas aspect | `renderer/components/captions/caption-preview.tsx:52-82` | [ ] | [ ] | [ ] |
| P627 | Preview info line (resolution · "Top"/"Bottom") | Shows size and position | `renderer/components/captions/caption-preview.tsx:84-91` | [ ] | [ ] | [ ] |
| P628 | "Preview background" "Dark" / "Light" / "Mixed" | Preview backdrop only | `renderer/components/captions/caption-preview.tsx:92-108` | [ ] | [ ] | [ ] |
| P629 | Upload lock alert (entitlement) + unlock action | Captions locked by plan | `renderer/components/captions/captions-controls.tsx:213-215` | [ ] | [ ] | [ ] |
| P630 | "Live captions" switch + status dot / off hint | Turns captions on or off *(disabled on Linux (lib/captions-preflight.ts:141-143))* | `renderer/components/captions/captions-controls.tsx:219-254` | [ ] | [ ] | [ ] |
| P631 | "Retry" | Restarts captions after a block or error | `renderer/components/captions/captions-controls.tsx:237-247` | [ ] | [ ] | [ ] |
| P632 | Alert "Host microphone only" | Shown while a cloud room is open | `renderer/components/captions/captions-controls.tsx:256-265` | [ ] | [ ] | [ ] |
| P633 | Alert "Live captions aren't available on Linux yet" | Explains the Linux limit *(Linux only)* | `renderer/components/captions/captions-controls.tsx:266-271` | n/a | n/a | [ ] |
| P634 | Alert "Captions can't go out on your next livestream" | Livestream blocker (fps, quality) | `renderer/components/captions/captions-controls.tsx:272-277` | [ ] | [ ] | [ ] |
| P635 | "Show captions on" "Live stream only" / "Live stream and recording" | Captions output; locked during a session | `renderer/components/captions/captions-controls.tsx:282-296; renderer/lib/captions-page-view.ts:20-23` | [ ] | [ ] | [ ] |
| P636 | "Microphone" row → Sources | Shows the mic captions hear | `renderer/components/captions/captions-controls.tsx:301-306` | [ ] | [ ] | [ ] |
| P637 | "Placement" row → Scene | Shows the bar position, opens Scene | `renderer/components/captions/captions-controls.tsx:307-315` | [ ] | [ ] | [ ] |
| P638 | "Allowance" row | Remaining caption minutes | `renderer/components/captions/captions-controls.tsx:316-318` | [ ] | [ ] | [ ] |
| P639 | "Style" "Classic" / "Glass" / "Lower third" / "High contrast" | Caption look, applied live | `renderer/components/captions/captions-controls.tsx:320-359; renderer/lib/caption-overlay.ts:78-128` | [ ] | [ ] | [ ] |
| P640 | "Text size" "Small" / "Medium" / "Large" | Caption size | `renderer/components/captions/captions-controls.tsx:365-375` | [ ] | [ ] | [ ] |
| P641 | "Spoken language" select | Language or Auto-detect; locked during a session | `renderer/components/captions/captions-controls.tsx:378-408` | [ ] | [ ] | [ ] |
| P642 | Live strip ("Listening…" / lines) | Recent partial and final captions | `renderer/components/captions/captions-controls.tsx:410-431` | [ ] | [ ] | [ ] |
| P643 | "Open/Close Captions reader" (⌘⇧C / Ctrl+Shift+C) | Toggles the reader window | `renderer/components/captions/captions-controls.tsx:438-452; renderer/lib/shortcuts.ts:96-99` | [ ] | [ ] | [ ] |
| P644 | "Host transcript" + "Refresh transcript" + list | Loads the saved host transcript | `renderer/components/captions/host-transcript.tsx:8-61` | [ ] | [ ] | [ ] |
| P645 | Alert "The host transcript is unavailable for this room." | Transcript load failed | `renderer/components/captions/host-transcript.tsx:44-48` | [ ] | [ ] | [ ] |

### Captions reader window (components/captions-reader.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P646 | Header "Captions reader" + status dot | Window title and caption state | `renderer/components/captions-reader.tsx:62-65` | [x] | [ ] | [ ] |
| P647 | "Keep on top" pin | Toggles always-on-top | `renderer/components/captions-reader.tsx:66-68; renderer/components/pin-window-button.tsx:10` | [x] | [ ] | [ ] |
| P648 | Notice line ("Starting captions…", "Live captions are off…", errors) | Status or empty states; errors use role alert | `renderer/components/captions-reader.tsx:78-96; renderer/lib/captions-page-view.ts:78-116` | [x] | [ ] | [ ] |
| P649 | Caption feed (last 8 lines, auto-scroll) | Latest line styled, larger | `renderer/components/captions-reader.tsx:42-47, 97-118` | [x] | [ ] | [ ] |
| P650 | Top / bottom alignment and text size | Follows the caption position and size settings | `renderer/components/captions-reader.tsx:55, 74` | [x] | [ ] | [ ] |

### Output ⌘5: Local recording (components/tabs/recording-tab.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P651 | Session lock alert | Settings are locked while live | `renderer/components/tabs/recording-tab.tsx:264` | [x] | [ ] | [ ] |
| P652 | "Save a local recording" switch | Saves an MP4, or stream only | `renderer/components/tabs/recording-tab.tsx:266-284` | [x] | [ ] | [ ] |
| P653 | "Separate source recordings" switch + warnings | Also saves Screen and Camera files *(macOS only (lib/capture.ts:255-257))* | `renderer/components/tabs/recording-tab.tsx:290-343` | [x] | n/a | n/a |
| P654 | "Recording preset" select | Quality preset ("Editing a value below switches the preset to Custom.") | `renderer/components/tabs/recording-tab.tsx:346-368` | [x] | [ ] | [ ] |
| P655 | Performance check line + "Use {preset}" + "Check this computer" / "Check again" | Verifies that the quality holds on this machine | `renderer/components/tabs/recording-tab.tsx:369-415; renderer/lib/performance-check-line.ts` | [x] | [ ] | [ ] |
| P656 | Entitlement lock alert | The quality needs a plan | `renderer/components/tabs/recording-tab.tsx:416-421` | [x] | [ ] | [ ] |
| P657 | Compatibility alert (destructive or warning) | The profile can't run or is risky *(per platform (lib/capture.ts:1075))* | `renderer/components/tabs/recording-tab.tsx:422-426` | [x] | [ ] | [ ] |
| P658 | "Resolution" "4K" / "1440p" / "1080p" / "720p" | One-click canvas size per orientation | `renderer/components/tabs/recording-tab.tsx:429-448; renderer/lib/capture.ts:542-554` | [x] | [ ] | [ ] |
| P659 | "Width" / "Height" / "FPS" / "Bitrate kbps" inputs | Exact values; Enter commits, Escape reverts, shows a refusal error | `renderer/components/tabs/recording-tab.tsx:601-681` | [x] | [ ] | [ ] |
| P660 | "Fallback video encoder" (Beta): "Automatic" / "Intel Quick Sync" / "Software only" | Backup H.264 encoder *(Windows with Intel Quick Sync only)* | `renderer/components/settings/encoder-preference-field.tsx:14-73; recording-tab.tsx:468-479` | n/a | [ ] | n/a |

### Output ⌘5: Clips (recording-tab.tsx, cloud-clips-section.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P661 | "Keep the last seconds" switch + state line | Keeps a one-minute buffer while open; shows a blocked reason | `renderer/components/tabs/recording-tab.tsx:133-153` | [x] | [ ] | [ ] |
| P662 | "Disk use" "about {size}" | Estimated buffer size on disk | `renderer/components/tabs/recording-tab.tsx:154-160` | [x] | [ ] | [ ] |
| P663 | "Save a 30-second clip" key recorder | Global clip key, conflict check | `renderer/components/tabs/recording-tab.tsx:161-185; renderer/lib/global-shortcuts.ts:123` | [x] | [ ] | [ ] |
| P664 | "Save a 1-minute clip" key recorder | Global long-clip key | `renderer/components/tabs/recording-tab.tsx:161-185; renderer/lib/global-shortcuts.ts:124` | [x] | [ ] | [ ] |
| P665 | "Where clips go" row | Says clips go to a Clips subfolder | `renderer/components/tabs/recording-tab.tsx:186-190` | [x] | [ ] | [ ] |
| P666 | Cloud "Clips" (room open): "Clip program orientation" Horizontal / Vertical | Replaces the native section while a room is open | `renderer/components/tabs/cloud-clips-section.tsx:60-81; recording-tab.tsx:103-108` | [x] | [ ] | [ ] |
| P667 | Cloud "Enable cloud Clips" / "Disable Clips" | Opt into the cloud buffer | `renderer/components/tabs/cloud-clips-section.tsx:84-127` | [x] | [ ] | [ ] |
| P668 | Cloud jobs "Cancel clip" / "Retry clip" / "Dismiss job" / "Discard staging files" + error alert | Manages clip jobs | `renderer/components/tabs/cloud-clips-section.tsx:140-191` | [x] | [ ] | [ ] |

### Output ⌘5: Videorc Camera (components/tabs/videorc-camera-section.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P669 | "Camera for other apps" section | Hidden when the platform reports unsupported *(supported platforms only)* *(Windows: hidden until proven, plan 260 "What parity means")* | `renderer/components/tabs/videorc-camera-section.tsx:37-68; renderer/lib/virtual-camera-view.ts:131` | [x] | n/a | [ ] |
| P670 | "Videorc Camera" switch | Turns the program-as-a-camera on or off *(all supported)* *(Windows: hidden until proven, plan 260 "What parity means")* | `renderer/components/tabs/videorc-camera-section.tsx:70-104` | [x] | n/a | [ ] |
| P671 | Status line (installing, ready, in use, needs restart…) | Camera state with icon tone *(all supported)* *(Windows: hidden until proven, plan 260 "What parity means")* | `renderer/components/tabs/videorc-camera-section.tsx:112-134; renderer/lib/virtual-camera-view.ts:58-75` | [x] | n/a | [ ] |
| P672 | Action button "Open System Settings" ("Opening…") | Opens the camera-extension approval *(macOS only)* | `renderer/lib/virtual-camera-view.ts:192-197` | [x] | n/a | n/a |
| P673 | Action "Set up" ("Setting up…") | One-time driver setup *(Windows only)* *(Windows: hidden until proven, plan 260 "What parity means")* | `renderer/lib/virtual-camera-view.ts:205-207` | n/a | n/a | n/a |
| P674 | Action "Load" ("Loading…") + install command with "Copy" / "Copied" | Loads v4l2loopback *(Linux only)* | `renderer/lib/virtual-camera-view.ts:208-215; videorc-camera-section.tsx:137-158` | n/a | n/a | [ ] |
| P675 | Error line | Shows an action failure message *(all supported)* *(Windows: hidden until proven, plan 260 "What parity means")* | `renderer/components/tabs/videorc-camera-section.tsx:80` | [x] | n/a | [ ] |

### Output ⌘5: Where recordings go (recording-tab.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P676 | "Recordings folder" path, detail and error | Shows the folder, checks it as it changes | `renderer/components/tabs/recording-tab.tsx:542-553` | [x] | [ ] | [ ] |
| P677 | "Choose…" | Picks the folder | `renderer/components/tabs/recording-tab.tsx:555-558` | [x] | [ ] | [ ] |
| P678 | "Show in Finder" / "Show in Explorer" / file-manager label | Reveals the folder *(label per platform)* | `renderer/components/tabs/recording-tab.tsx:559-568; renderer/lib/platform.ts:114-124` | [x] | [ ] | [ ] |
| P679 | "Use default" | Resets to the default folder | `renderer/components/tabs/recording-tab.tsx:569-582` | [x] | [ ] | [ ] |
| P680 | "Keep original recording" switch | Also keeps the capture MKV | `renderer/components/tabs/recording-tab.tsx:585-595` | [x] | [ ] | [ ] |


## Destinations ⌘6, Guests ⌘7, Stream Manager and Notes

### Destinations ⌘6 — page shell (streaming-tab.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P681 | "Setup" / "Upcoming" / "Discord" view strip | Switches Destinations view; reopens the last one used | `renderer/components/tabs/streaming-tab.tsx:125 (labels renderer/lib/livestream-tabs.ts:16)` | [ ] | [ ] | [ ] |
| P682 | "Loading upcoming streams…" / "Loading Discord settings…" / "Loading guests…" | Lazy-view loading status | `renderer/components/tabs/streaming-tab.tsx:120,138,143` | [ ] | [ ] | [ ] |
| P683 | Linux keyring alert (LinuxSetupAlert) | Says what to install before Sign in fails *(Linux only (apps/desktop/src/renderer/src/hooks/use-linux-desktop-check.ts:22))* | `renderer/components/tabs/streaming-tab.tsx:310` | n/a | n/a | [ ] |
| P684 | Livestreaming LockAlert | Entitlement lock reason and unlock action | `renderer/components/tabs/streaming-tab.tsx:312` | [ ] | [ ] | [ ] |
| P685 | "Some destinations aren’t on air" banner | Lists failed/reconnecting/not-receiving/skipped destinations while live | `renderer/components/tabs/streaming-tab.tsx:508` | [ ] | [ ] | [ ] |
| P686 | "End livestream" (banner) | Opens End livestream dialog for whole session | `renderer/components/tabs/streaming-tab.tsx:541` | [ ] | [ ] | [ ] |
| P687 | "Continue streaming" (banner) | Dismisses this set of problems until new ones | `renderer/components/tabs/streaming-tab.tsx:544` | [ ] | [ ] | [ ] |
| P688 | Session lock alert | "Destinations, stream quality, Videorc Cloud and stream details" locked while live | `renderer/components/tabs/streaming-tab.tsx:325,454` | [ ] | [ ] | [ ] |
| P689 | Scheduled-event alert + "Use instant broadcast" | Drops the chosen scheduled event from the destination | `renderer/components/tabs/streaming-tab.tsx:327,346` | [ ] | [ ] | [ ] |
| P690 | "Destinations" section + cap notice alert | Lists destination cards; explains destination cap | `renderer/components/tabs/streaming-tab.tsx:353,358` | [ ] | [ ] | [ ] |
| P691 | Auto-open first destination needing setup / open-by-name | Expands, scrolls and focuses a destination card | `renderer/components/tabs/streaming-tab.tsx:265,277,285` | [ ] | [ ] | [ ] |

### Destination card (destination-card.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P692 | Row title button (destination label) | Click/Enter/Space expands or collapses the card | `renderer/components/streaming/destination-card.tsx:418` | [ ] | [ ] | [ ] |
| P693 | Row context ("9:16 · account" / "Stream key") | Shows orientation and how it connects | `renderer/components/streaming/destination-card.tsx:329` | [ ] | [ ] | [ ] |
| P694 | State badge ("Needs setup", "Prepared", "API paused", runtime state) | Shows idle/saved/live state of destination | `renderer/components/streaming/destination-card.tsx:423` | [ ] | [ ] | [ ] |
| P695 | "Falling behind" badge + uplink line | Uplink overflowed; viewers skipped seconds | `renderer/components/streaming/destination-card.tsx:424,463` | [ ] | [ ] | [ ] |
| P696 | Quality tag badge | Names a per-destination quality override | `renderer/components/streaming/destination-card.tsx:429` | [ ] | [ ] | [ ] |
| P697 | "Enable {label}" switch | Turns destination on/off; held off by cap | `renderer/components/streaming/destination-card.tsx:439` | [ ] | [ ] | [ ] |
| P698 | Chevron | Shows expanded state | `renderer/components/streaming/destination-card.tsx:447` | [ ] | [ ] | [ ] |
| P699 | Status message / lock reason text | Runtime message or why switch is locked | `renderer/components/streaming/destination-card.tsx:460,467` | [ ] | [ ] | [ ] |
| P700 | "Stream quality" (with "Use default") | Per-destination quality override | `renderer/components/streaming/destination-card.tsx:472` | [ ] | [ ] | [ ] |
| P701 | "URL mode" ("Server + key" / "Full URL") | Custom RTMP entry mode | `renderer/components/streaming/destination-card.tsx:481` | [ ] | [ ] | [ ] |
| P702 | "Connect with" ("Sign in"/"Stream key"; X: "Sign in · Chat works"/"Stream key · No chat") | Picks OAuth or manual key | `renderer/components/streaming/destination-card.tsx:494` | [ ] | [ ] | [ ] |
| P703 | Key-only note (Facebook / "{platform} uses a stream key.") | Explains sign-in unavailable | `renderer/components/streaming/destination-card.tsx:505` | [ ] | [ ] | [ ] |
| P704 | Key guidance + external link (YouTube Studio, Twitch dashboard, Kick dashboard, Media Studio, TikTok LIVE Center, Live Producer) | Where to find the stream key | `renderer/components/streaming/destination-card.tsx:515,786` | [ ] | [ ] | [ ] |
| P705 | YouTube quota paused alert + "Use stream key" + Studio link | Switch to key while API quota paused | `renderer/components/streaming/destination-card.tsx:529` | [ ] | [ ] | [ ] |
| P706 | "Server URL" / "Full RTMP URL" field | Edits server URL; validated on blur; Enter saves full URL | `renderer/components/streaming/destination-card.tsx:570` | [ ] | [ ] | [ ] |
| P707 | "Save URL" | Saves full RTMP URL securely | `renderer/components/streaming/destination-card.tsx:606` | [ ] | [ ] | [ ] |
| P708 | "Clear" (URL/key) | Asks to remove saved credential | `renderer/components/streaming/destination-card.tsx:614,666` | [ ] | [ ] | [ ] |
| P709 | "Stream key" password field (Enter saves) | Paste key; "Saved securely · ends ••••" hint | `renderer/components/streaming/destination-card.tsx:635` | [ ] | [ ] | [ ] |
| P710 | "Save key" | Saves key (confirms replace or platform mismatch) | `renderer/components/streaming/destination-card.tsx:658` | [ ] | [ ] | [ ] |
| P711 | "Restore previous {stream key/RTMP URL}" | Restores last replaced credential | `renderer/components/streaming/destination-card.tsx:684` | [ ] | [ ] | [ ] |
| P712 | Dialog "Replace the … ?" / "Save this … to …?" | Confirms key save; warns on mismatched platform | `renderer/components/streaming/destination-card.tsx:698` | [ ] | [ ] | [ ] |
| P713 | Dialog "Remove the {label} {credential}?" | Confirms clearing credential (kept as previous) | `renderer/components/streaming/destination-card.tsx:729` | [ ] | [ ] | [ ] |
| P714 | "Connect {platform}" | Starts OAuth (YouTube opens consent first) | `renderer/components/streaming/destination-card.tsx:1130` | [ ] | [ ] | [ ] |
| P715 | "Environment override" badge | OAuth client from env var *(dev builds only)* | `renderer/components/streaming/destination-card.tsx:1146` | dev | dev | dev |
| P716 | Sign-in pending: "Waiting for your browser…", "Copy link", "Cancel" | Shows browser wait; copy auth link; stop waiting | `renderer/components/streaming/destination-card.tsx:939` | [ ] | [ ] | [ ] |
| P717 | Account row (avatar, name, handle, green "Connected" dot tooltip) | Signed-in account and last check on hover | `renderer/components/streaming/destination-card.tsx:1186` | [ ] | [ ] | [ ] |
| P718 | "Needs reconnect" badge + "Reconnect" | Re-runs sign-in for lost access | `renderer/components/streaming/destination-card.tsx:1209,1214,1244` | [ ] | [ ] | [ ] |
| P719 | "Disconnect" | Asks then signs account out | `renderer/components/streaming/destination-card.tsx:1219` | [ ] | [ ] | [ ] |
| P720 | Dialog "Disconnect {platform}?" | Confirms sign-out (YouTube covers Vertical too) | `renderer/components/streaming/destination-card.tsx:1226` | [ ] | [ ] | [ ] |
| P721 | Permissions row ("Reconnect" / "Reconnect Twitch") | Requests missing moderation/Twitch activity scopes | `renderer/components/streaming/destination-card.tsx:1249` | [ ] | [ ] | [ ] |
| P722 | "Same account and channel as {label}." | Vertical twin shares YouTube account | `renderer/components/streaming/destination-card.tsx:1267` | [ ] | [ ] | [ ] |
| P723 | "Channel" select | Picks YouTube channel for the account | `renderer/components/streaming/destination-card.tsx:1272` | [ ] | [ ] | [ ] |
| P724 | "Refresh channels" icon button | Reloads YouTube channel list | `renderer/components/streaming/destination-card.tsx:1304` | [ ] | [ ] | [ ] |
| P725 | X Live badge ("X Live ready", "Authorization needed", etc.) | X native broadcast capability state | `renderer/components/streaming/destination-card.tsx:1327` | [ ] | [ ] | [ ] |
| P726 | "Check again" | Re-checks X native capability | `renderer/components/streaming/destination-card.tsx:1341` | [ ] | [ ] | [ ] |
| P727 | "Authorize X Live" | Opens x.com to approve live broadcasting | `renderer/components/streaming/destination-card.tsx:1361` | [ ] | [ ] | [ ] |
| P728 | "Use a stream key instead" | Switches X destination to manual RTMP | `renderer/components/streaming/destination-card.tsx:1366` | [ ] | [ ] | [ ] |
| P729 | "X Producer docs" / "X API overview" links | Opens X docs externally | `renderer/components/streaming/destination-card.tsx:1373` | [ ] | [ ] | [ ] |

### YouTube consent dialog (destination-card.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P730 | Dialog "Connect YouTube to Videorc" | Google-reviewed consent before OAuth | `renderer/components/streaming/destination-card.tsx:893` | [ ] | [ ] | [ ] |
| P731 | "Privacy Policy" / "Videorc Terms" / "YouTube Terms" / "Google Privacy" | Open policy pages externally | `renderer/components/streaming/destination-card.tsx:902` | [ ] | [ ] | [ ] |
| P732 | "I agree to the Videorc and YouTube terms…" checkbox | Gates Continue; resets each open | `renderer/components/streaming/destination-card.tsx:912` | [ ] | [ ] | [ ] |
| P733 | "Cancel" / "Continue to Google" | Close / start Google sign-in | `renderer/components/streaming/destination-card.tsx:922,925` | [ ] | [ ] | [ ] |

### Stream details (streaming-tab.tsx MetadataEditor)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P734 | "Stream details" status badge | Unsaved / validation status | `renderer/components/tabs/streaming-tab.tsx:623` | [ ] | [ ] | [ ] |
| P735 | "Save" / "Saving…" | Saves stream metadata draft | `renderer/components/tabs/streaming-tab.tsx:628` | [ ] | [ ] | [ ] |
| P736 | "Loading stream details…" | Draft loading state | `renderer/components/tabs/streaming-tab.tsx:645` | [ ] | [ ] | [ ] |
| P737 | Thumbnail (only with YouTube on) | YouTube thumbnail; disabled unless YouTube signed in | `renderer/components/tabs/streaming-tab.tsx:655` | [ ] | [ ] | [ ] |
| P738 | Per-destination accordion ("Details for each destination") | Rows per native destination with summary, "Needs attention" icon | `renderer/components/tabs/streaming-tab.tsx:684` | [ ] | [ ] | [ ] |
| P739 | "Turn on YouTube, Twitch, Kick or X…" empty line | No native destinations on | `renderer/components/tabs/streaming-tab.tsx:731` | [ ] | [ ] | [ ] |
| P740 | "Custom title and description" switch | Per-destination text override | `renderer/components/tabs/streaming-tab.tsx:786` | [ ] | [ ] | [ ] |
| P741 | Override "Title" | Destination title; Twitch/X notes beneath | `renderer/components/tabs/streaming-tab.tsx:805` | [ ] | [ ] | [ ] |
| P742 | Override "Description" | YouTube-only description override | `renderer/components/tabs/streaming-tab.tsx:828` | [ ] | [ ] | [ ] |
| P743 | Override "Privacy" ("Private"/"Unlisted"/"Public") | YouTube-only privacy override | `renderer/components/tabs/streaming-tab.tsx:839` | [ ] | [ ] | [ ] |
| P744 | "Made for kids" switch | YouTube audience flag | `renderer/components/tabs/streaming-tab.tsx:856` | [ ] | [ ] | [ ] |
| P745 | Twitch "Category" combobox | Picks Twitch category | `renderer/components/tabs/streaming-tab.tsx:869` | [ ] | [ ] | [ ] |
| P746 | Twitch "Language" select | Picks stream language | `renderer/components/tabs/streaming-tab.tsx:891` | [ ] | [ ] | [ ] |
| P747 | Kick "Category" combobox | Picks required Kick category | `renderer/components/tabs/streaming-tab.tsx:917` | [ ] | [ ] | [ ] |
| P748 | "Announce on X timeline" switch | Off skips the announcement post | `renderer/components/tabs/streaming-tab.tsx:950` | [ ] | [ ] | [ ] |

### Broadcast info fields (broadcast-info-fields.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P749 | "Title" + character counter | Broadcast title; required-error after touch | `renderer/components/streaming/broadcast-info-fields.tsx:79` | [ ] | [ ] | [ ] |
| P750 | "Description" textarea | Optional broadcast description | `renderer/components/streaming/broadcast-info-fields.tsx:102` | [ ] | [ ] | [ ] |
| P751 | "Privacy" segmented + hint ("Twitch, Kick and X are always public.") | YouTube privacy choice | `renderer/components/streaming/broadcast-info-fields.tsx:117` | [ ] | [ ] | [ ] |
| P752 | "Made for kids" switch (when provided) | YouTube kids flag | `renderer/components/streaming/broadcast-info-fields.tsx:135` | [ ] | [ ] | [ ] |

### Category combobox (category-combobox.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P753 | Trigger "Choose a category…" | Opens category search popover | `renderer/components/streaming/category-combobox.tsx:110` | [ ] | [ ] | [ ] |
| P754 | "Search categories…" input | Debounced (300 ms, ≥2 chars) platform search | `renderer/components/streaming/category-combobox.tsx:136` | [ ] | [ ] | [ ] |
| P755 | Result items | Pick a category; closes popover | `renderer/components/streaming/category-combobox.tsx:146` | [ ] | [ ] | [ ] |
| P756 | "Clear category" | Removes chosen category | `renderer/components/streaming/category-combobox.tsx:158` | [ ] | [ ] | [ ] |
| P757 | Status lines ("Type 2 or more letters…", "Searching…", "No categories match.") | Search state | `renderer/components/streaming/category-combobox.tsx:35` | [ ] | [ ] | [ ] |

### Thumbnail field (thumbnail-field.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P758 | Thumbnail preview image | Shows chosen 16:9 thumbnail | `renderer/components/streaming/thumbnail-field.tsx:64` | [ ] | [ ] | [ ] |
| P759 | "Choose thumbnail…" / "Replace thumbnail…" | Native file picker import | `renderer/components/streaming/thumbnail-field.tsx:88` | [ ] | [ ] | [ ] |
| P760 | "Remove thumbnail" | Clears thumbnail | `renderer/components/streaming/thumbnail-field.tsx:92` | [ ] | [ ] | [ ] |
| P761 | "The thumbnail file is missing. Choose it again." | Broken-preview notice | `renderer/components/streaming/thumbnail-field.tsx:80` | [ ] | [ ] | [ ] |
| P762 | "This image isn't 16:9. YouTube will add bars." | Aspect warning | `renderer/components/streaming/thumbnail-field.tsx:105` | [ ] | [ ] | [ ] |
| P763 | Import error line | Picker failure message | `renderer/components/streaming/thumbnail-field.tsx:103` | [ ] | [ ] | [ ] |

### Stream quality (stream-quality-control.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P764 | "Stream quality" segmented (1080p30, 1080p60, "YouTube · 4K30", "Use default") | Picks stream preset; 4K only with YouTube | `renderer/components/streaming/stream-quality-control.tsx:26` | [ ] | [ ] | [ ] |
| P765 | Hint ("Using a saved custom profile.", 4K latency note) | Explains quality/recording interplay | `renderer/components/streaming/stream-quality-control.tsx:41` | [ ] | [ ] | [ ] |

### Go Live panel (go-live-panel.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P766 | Compatibility warning alert | Video profile blocking/warning reason | `renderer/components/streaming/go-live-panel.tsx:157` | [ ] | [ ] | [ ] |
| P767 | "Output quality" section | Default stream quality for all destinations | `renderer/components/streaming/go-live-panel.tsx:164` | [ ] | [ ] | [ ] |
| P768 | "Ready to go live" checklist | Plain-word readiness rows | `renderer/components/streaming/go-live-panel.tsx:308` | [ ] | [ ] | [ ] |
| P769 | "Destinations" row + "{label} · {hint}" links | N of M ready; link opens/focuses card | `renderer/components/streaming/go-live-panel.tsx:309,323` | [ ] | [ ] | [ ] |
| P770 | "Stream settings" row ("Checked"/"Checking…"/"Couldn't check") | Output-path preflight; detail on hover | `renderer/components/streaming/go-live-panel.tsx:404` | [ ] | [ ] | [ ] |
| P771 | "Retry" (stream settings) | Re-runs output topology preflight | `renderer/components/streaming/go-live-panel.tsx:424` | [ ] | [ ] | [ ] |
| P772 | "Stream" row (live) | Healthy / problem label; sentence on hover | `renderer/components/streaming/go-live-panel.tsx:472` | [ ] | [ ] | [ ] |
| P773 | "Quality" row (+ per-destination lines) | Summarises output quality / "Varies by destination" | `renderer/components/streaming/go-live-panel.tsx:346` | [ ] | [ ] | [ ] |
| P774 | "Captions" row | Caption output rule blocker | `renderer/components/streaming/go-live-panel.tsx:354` | [ ] | [ ] | [ ] |
| P775 | "Recording" / "Upload needed" / "Disk" info rows | Recording quality, Mbps, GB per hour | `renderer/components/streaming/go-live-panel.tsx:367,375,378` | [ ] | [ ] | [ ] |
| P776 | "FFmpeg · Missing" row | Navigates to Health page | `renderer/components/streaming/go-live-panel.tsx:384` | [ ] | [ ] | [ ] |

### Videorc Cloud section (cloud-section.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P777 | Premium / unavailable LockAlert ("View Premium") | Explains cloud lock | `renderer/components/streaming/cloud-section.tsx:101` | [ ] | [ ] | [ ] |
| P778 | "Stream through Videorc Cloud" switch (+ hours lines) | Routes Go Live through cloud | `renderer/components/streaming/cloud-section.tsx:120` | [ ] | [ ] | [ ] |
| P779 | "Test Videorc Cloud" → "Test"/"Testing…" | 10 s test upload; result in description | `renderer/components/streaming/cloud-section.tsx:132` | [ ] | [ ] | [ ] |
| P780 | "If this computer drops, show" select ("Be right back card", screens) | Hold image while disconnected | `renderer/components/streaming/cloud-section.tsx:156` | [ ] | [ ] | [ ] |
| P781 | "End the stream after" segmented | Max hold duration | `renderer/components/streaming/cloud-section.tsx:185` | [ ] | [ ] | [ ] |
| P782 | Scroll-to-section on "Open Destinations" notice | Brings section into view | `renderer/components/streaming/cloud-section.tsx:56` | [ ] | [ ] | [ ] |

### Watchdog section (watchdog-section.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P783 | Check switches: "Microphone muted", "Microphone silent", "No voice", "Viewers hear nothing", "Black picture", "Picture stopped", "Destination down", "Platform reports a problem", "Connection too slow", "Sound and picture drift", "Chat says there is a problem", "Long Be right back", "Still there?", "Cloud program not reporting", "Not reaching the room" | Enable/disable each live check | `renderer/components/streaming/watchdog-section.tsx:26 (rows), :186 (switches)` | [ ] | [ ] | [ ] |
| P784 | "Alert me after" (15 s/30 s/1 min/2 min) | Muted-mic alert delay | `renderer/components/streaming/watchdog-section.tsx:203` | [ ] | [ ] | [ ] |
| P785 | "System notifications" switch | OS notifications when unfocused/critical | `renderer/components/streaming/watchdog-section.tsx:215` | [ ] | [ ] | [ ] |
| P786 | Phone Premium LockAlert | "Alerts on your phone come with Premium." | `renderer/components/streaming/watchdog-section.tsx:224` | [ ] | [ ] | [ ] |
| P787 | "Phone" switch (+ device count) | Push alerts to phone | `renderer/components/streaming/watchdog-section.tsx:241` | [ ] | [ ] | [ ] |
| P788 | "Show QR code" / "Hide code" | Toggles QR to videorc.com/live | `renderer/components/streaming/watchdog-section.tsx:259` | [ ] | [ ] | [ ] |
| P789 | "Copy link" | Copies live alerts URL | `renderer/components/streaming/watchdog-section.tsx:262` | [ ] | [ ] | [ ] |
| P790 | "AI reads chat for problems" switch | AI reads chat for A/V reports | `renderer/components/streaming/watchdog-section.tsx:270` | [ ] | [ ] | [ ] |

### Stream report email — "After the stream" (stream-report-email-section.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P791 | Signed-out LockAlert (Sign in) | Reports need a Videorc account | `renderer/components/streaming/stream-report-email-section.tsx:113` | [ ] | [ ] | [ ] |
| P792 | "Email me a report after each stream" switch | Toggle post-stream email report | `renderer/components/streaming/stream-report-email-section.tsx:123` | [ ] | [ ] | [ ] |
| P793 | "Try again" | Re-reads settings after failed load | `renderer/components/streaming/stream-report-email-section.tsx:127` | [ ] | [ ] | [ ] |
| P794 | "Save my streams on videorc.com" switch | Keep stream history online 90 days | `renderer/components/streaming/stream-report-email-section.tsx:141` | [ ] | [ ] | [ ] |
| P795 | "Your streams" → "Open" | Opens videorc.com/live | `renderer/components/streaming/stream-report-email-section.tsx:154` | [ ] | [ ] | [ ] |
| P796 | "Send the last one" → "Send"/"Sending…" | Emails last report; result line beneath | `renderer/components/streaming/stream-report-email-section.tsx:168` | [ ] | [ ] | [ ] |

### Chat commands section (chat-commands-section.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P797 | Offline alert | Videorc reconnecting; section disabled | `renderer/components/streaming/chat-commands-section.tsx:90` | [ ] | [ ] | [ ] |
| P798 | "Answer !commands" switch | Lists commands in chat | `renderer/components/streaming/chat-commands-section.tsx:94` | [ ] | [ ] | [ ] |
| P799 | Command row "!name" (click/Enter) | Opens editor | `renderer/components/streaming/chat-commands-section.tsx:207` | [ ] | [ ] | [ ] |
| P800 | "Answer !{name}" switch | Enable/disable one command | `renderer/components/streaming/chat-commands-section.tsx:214` | [ ] | [ ] | [ ] |
| P801 | ⋯ menu "Edit…" / "Delete" | Row actions (hover reveal) | `renderer/components/streaming/chat-commands-section.tsx:197,221` | [ ] | [ ] | [ ] |
| P802 | "No commands yet." | Empty state | `renderer/components/streaming/chat-commands-section.tsx:118` | [ ] | [ ] | [ ] |
| P803 | "Couldn't read your chat commands." + "Try again" | Load failure + retry | `renderer/components/streaming/chat-commands-section.tsx:124` | [ ] | [ ] | [ ] |
| P804 | "Loading chat commands…" | Loading state | `renderer/components/streaming/chat-commands-section.tsx:131` | [ ] | [ ] | [ ] |
| P805 | "Add command…" | Opens add dialog; disabled at max/offline | `renderer/components/streaming/chat-commands-section.tsx:143` | [ ] | [ ] | [ ] |
| P806 | Dialog "Delete !{name}?" ("Delete command") | Confirms deletion | `renderer/components/streaming/chat-commands-section.tsx:157` | [ ] | [ ] | [ ] |
| P807 | Reveal from Stream Manager "Chat commands…" | Scrolls/focuses this section | `renderer/components/streaming/chat-commands-section.tsx:62` | [ ] | [ ] | [ ] |

### Chat command dialog (chat-command-dialog.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P808 | Title "Add command" / "Edit !{name}" | Dialog title | `renderer/components/streaming/chat-command-dialog.tsx:132` | [ ] | [ ] | [ ] |
| P809 | "Name" (with "!" prefix) | Command name; leading ! stripped | `renderer/components/streaming/chat-command-dialog.tsx:137` | [ ] | [ ] | [ ] |
| P810 | "Description" | Shown after name in !commands | `renderer/components/streaming/chat-command-dialog.tsx:161` | [ ] | [ ] | [ ] |
| P811 | "Reply" (one line, room counter, "X gets this in 2 posts.") | Reply text; ⌘/Ctrl+Enter saves | `renderer/components/streaming/chat-command-dialog.tsx:179,200` | [ ] | [ ] | [ ] |
| P812 | "Preview" | "@viewer" + reply preview | `renderer/components/streaming/chat-command-dialog.tsx:227` | [ ] | [ ] | [ ] |
| P813 | "Cancel" / "Save" | Close / save command | `renderer/components/streaming/chat-command-dialog.tsx:241,244` | [ ] | [ ] | [ ] |

### Go Live dialog (go-live-dialog.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P814 | Dialog "Go live" | Pre-flight check before starting | `renderer/components/go-live-dialog.tsx:285` | [ ] | [ ] | [ ] |
| P815 | "Stream details" (Title/Description/Privacy) | Edit instant broadcast details; first focus | `renderer/components/go-live-dialog.tsx:299` | [ ] | [ ] | [ ] |
| P816 | Destinations summary badge | Ready/warn summary | `renderer/components/go-live-dialog.tsx:331` | [ ] | [ ] | [ ] |
| P817 | Scheduled-event alert | Scheduled event starts now | `renderer/components/go-live-dialog.tsx:339` | [ ] | [ ] | [ ] |
| P818 | Destination row ("Ready"/"Needs attention", scheduled, privacy line) | Per-destination readiness | `renderer/components/go-live-dialog.tsx:780` | [ ] | [ ] | [ ] |
| P819 | Chat "Read"/"Send" status badges | Chat capability per destination | `renderer/components/go-live-dialog.tsx:930` | [ ] | [ ] | [ ] |
| P820 | "Sign in to Videorc" | Signs in for chat relay | `renderer/components/go-live-dialog.tsx:937` | [ ] | [ ] | [ ] |
| P821 | "Connect/Reconnect {platform}…" then "Check again" | Re-auth then re-run preflight | `renderer/components/go-live-dialog.tsx:811` | [ ] | [ ] | [ ] |
| P822 | "Use stream key" (row) | Saves switch to manual key | `renderer/components/go-live-dialog.tsx:827` | [ ] | [ ] | [ ] |
| P823 | "Go live without {label}" | Excludes destination for this livestream only | `renderer/components/go-live-dialog.tsx:835` | [ ] | [ ] | [ ] |
| P824 | Excluded row "Left out" + "Add back" | Re-includes excluded destination | `renderer/components/go-live-dialog.tsx:875,879` | [ ] | [ ] | [ ] |
| P825 | "No destination is on…" empty line | No destinations enabled | `renderer/components/go-live-dialog.tsx:377` | [ ] | [ ] | [ ] |
| P826 | Captions status ("Captions can't start"/"No captions this time"/Ready row) | Caption readiness | `renderer/components/go-live-dialog.tsx:669` | [ ] | [ ] | [ ] |
| P827 | "Go live without captions" | Skips captions for this livestream | `renderer/components/go-live-dialog.tsx:673` | [ ] | [ ] | [ ] |
| P828 | Entitlement LockAlert | Plan lock blocking Go Live | `renderer/components/go-live-dialog.tsx:392` | [ ] | [ ] | [ ] |
| P829 | "Fix before going live" alert | General blockers list | `renderer/components/go-live-dialog.tsx:399` | [ ] | [ ] | [ ] |
| P830 | "Chat limits" alert | Chat warnings | `renderer/components/go-live-dialog.tsx:412` | [ ] | [ ] | [ ] |
| P831 | "Streaming both orientations" alert | Simulcast bandwidth advice | `renderer/components/go-live-dialog.tsx:1000` | [ ] | [ ] | [ ] |
| P832 | "Publish in Live Producer" alert | Facebook/Instagram manual publish step | `renderer/components/go-live-dialog.tsx:1041` | [ ] | [ ] | [ ] |
| P833 | Output advice alerts ("This computer may not keep up", "… may stutter while live", "Streaming at …", "Recording will match the stream") | Performance step-down advice | `renderer/components/go-live-dialog.tsx:597` | [ ] | [ ] | [ ] |
| P834 | "Overlays this time" alert | Overlays/banners this session can't honour | `renderer/components/go-live-dialog.tsx:436` | [ ] | [ ] | [ ] |
| P835 | "Some destinations couldn't be set up" alert + "Use stream key" + Studio link | Partial setup failures | `renderer/components/go-live-dialog.tsx:458` | [ ] | [ ] | [ ] |
| P836 | "Cancel" | Closes dialog | `renderer/components/go-live-dialog.tsx:500` | [ ] | [ ] | [ ] |
| P837 | Primary "Go live" / "Go live on N destinations" / "Go live on {ready}" + key chip | Starts livestream; pending label names phase | `renderer/components/go-live-dialog.tsx:510,534` | [ ] | [ ] | [ ] |
| P838 | Disabled reason "Fix the items above, then go live." | Hover/focus reason when blocked | `renderer/components/go-live-dialog.tsx:533` | [ ] | [ ] | [ ] |
| P839 | ⌘↵ / Ctrl+↵ | Triggers primary anywhere in dialog | `renderer/components/go-live-dialog.tsx:243` | [ ] | [ ] | [ ] |
| P840 | Privacy confirm "Go live unlisted?" ("Go live unlisted"/"Change privacy"/"Go back") | Confirms non-public YouTube | `renderer/components/go-live-dialog.tsx:561` | [ ] | [ ] | [ ] |

### Upcoming view (scheduled-streams.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P841 | Header "Upcoming streams"/"Past streams" + last-checked | Page title, description, last sync | `renderer/components/scheduled-streams.tsx:199` | [ ] | [ ] | [ ] |
| P842 | "Refresh" / "Refreshing…" | Re-syncs scheduled events | `renderer/components/scheduled-streams.tsx:207` | [ ] | [ ] | [ ] |
| P843 | "Upcoming" / "Past" tabs | Switches list | `renderer/components/scheduled-streams.tsx:221` | [ ] | [ ] | [ ] |
| P844 | Error alert / loading skeleton | Load error or loading | `renderer/components/scheduled-streams.tsx:143` | [ ] | [ ] | [ ] |
| P845 | Provider section (YouTube, X) + count | One section per platform | `renderer/components/scheduled-streams.tsx:451` | [ ] | [ ] | [ ] |
| P846 | "Schedule on {platform}" | Opens schedule dialog | `renderer/components/scheduled-streams.tsx:461` | [ ] | [ ] | [ ] |
| P847 | Unavailable reason line | Why scheduling is off | `renderer/components/scheduled-streams.tsx:470` | [ ] | [ ] | [ ] |
| P848 | "No upcoming/past {platform} {noun}s." | Empty state | `renderer/components/scheduled-streams.tsx:478` | [ ] | [ ] | [ ] |
| P849 | Event row (thumbnail, title, lifecycle chip, privacy, meta, "Last checked" tooltip) | Event summary | `renderer/components/scheduled-streams.tsx:584` | [ ] | [ ] | [ ] |
| P850 | Event error alert / "Updating {noun}…" | Event error or pending | `renderer/components/scheduled-streams.tsx:612` | [ ] | [ ] | [ ] |
| P851 | "Retry thumbnail" | Retries thumbnail upload | `renderer/components/scheduled-streams.tsx:628` | [ ] | [ ] | [ ] |
| P852 | "Recover" | Opens recovery dialog | `renderer/components/scheduled-streams.tsx:633` | [ ] | [ ] | [ ] |
| P853 | "Use for Go Live…" | Picks event + destination for next Go Live | `renderer/components/scheduled-streams.tsx:639` | [ ] | [ ] | [ ] |
| P854 | "Schedule" (draft) | Publishes draft to platform | `renderer/components/scheduled-streams.tsx:648` | [ ] | [ ] | [ ] |
| P855 | ⋯ "Edit…", "Duplicate", "Copy link", "Open on {platform}", "Cancel {noun}"/"Move to Past" | Event actions | `renderer/components/scheduled-streams.tsx:528` | [ ] | [ ] | [ ] |
| P856 | Dialog "Cancel this … ?" / "Move draft to Past?" | Confirms cancel/move | `renderer/components/scheduled-streams.tsx:248` | [ ] | [ ] | [ ] |
| P857 | Dialog "Find the … created" + candidate select + "Use selected candidate"/"Close" | Recovers uncertain creation | `renderer/components/scheduled-streams.tsx:272` | [ ] | [ ] | [ ] |
| P858 | Dialog "Use this … for Go Live" + destination select + "Use saved event"/"Cancel" | Assigns event to destination | `renderer/components/scheduled-streams.tsx:342` | [ ] | [ ] | [ ] |
| P859 | "No … destination signs in as …" alert + "Open Setup" | No matching destination | `renderer/components/scheduled-streams.tsx:385` | [ ] | [ ] | [ ] |

### Schedule dialog (schedule-stream-dialog.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P860 | Title "Schedule on {platform}" / "Edit {platform} {noun}" | Dialog title | `renderer/components/schedule-stream-dialog.tsx:353` | [ ] | [ ] | [ ] |
| P861 | "YouTube channel"/"X account" select | Account; locked when editing | `renderer/components/schedule-stream-dialog.tsx:368` | [ ] | [ ] | [ ] |
| P862 | "Sign in to … first." + "Open Setup" | No connected account | `renderer/components/schedule-stream-dialog.tsx:401` | [ ] | [ ] | [ ] |
| P863 | Title / Description / Privacy (YouTube) | Broadcast info fields | `renderer/components/schedule-stream-dialog.tsx:417` | [ ] | [ ] | [ ] |
| P864 | "Date and time" (datetime-local) + summary | Start time | `renderer/components/schedule-stream-dialog.tsx:436` | [ ] | [ ] | [ ] |
| P865 | "Planned end" | X planned end | `renderer/components/schedule-stream-dialog.tsx:454` | [ ] | [ ] | [ ] |
| P866 | "Time zone" picker ("Search time zones…", "No time zones found.") | Searchable zone list | `renderer/components/schedule-stream-dialog.tsx:472,709` | [ ] | [ ] | [ ] |
| P867 | "This time happens twice" select | DST ambiguity choice | `renderer/components/schedule-stream-dialog.tsx:500` | [ ] | [ ] | [ ] |
| P868 | "Keep replay available" switch | X replay setting | `renderer/components/schedule-stream-dialog.tsx:537` | [ ] | [ ] | [ ] |
| P869 | "Made for kids" select | YouTube audience; locked once published | `renderer/components/schedule-stream-dialog.tsx:546` | [ ] | [ ] | [ ] |
| P870 | Thumbnail field | Event thumbnail | `renderer/components/schedule-stream-dialog.tsx:579` | [ ] | [ ] | [ ] |
| P871 | "Event created." + "Open event on {platform}" | Success link | `renderer/components/schedule-stream-dialog.tsx:589` | [ ] | [ ] | [ ] |
| P872 | "This event changed while you were editing" + "Reload latest changes" | Conflict resolution | `renderer/components/schedule-stream-dialog.tsx:605` | [ ] | [ ] | [ ] |
| P873 | Error / capability warning alerts | Save failure or provider reason | `renderer/components/schedule-stream-dialog.tsx:625` | [ ] | [ ] | [ ] |
| P874 | "Cancel" / "Save draft" | Close / save draft locally | `renderer/components/schedule-stream-dialog.tsx:636,641` | [ ] | [ ] | [ ] |
| P875 | "Schedule on {platform}" / "Update {noun}" + ⌘↵ | Publishes; ⌘/Ctrl+Enter shortcut | `renderer/components/schedule-stream-dialog.tsx:346,663` | [ ] | [ ] | [ ] |
| P876 | Dialog "Discard changes?" ("Keep editing"/"Discard changes") | Guards unsaved edits | `renderer/components/schedule-stream-dialog.tsx:676` | [ ] | [ ] | [ ] |

### Discord view (discord-section.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P877 | Header "Discord announcements" | View title and line | `renderer/components/streaming/discord-section.tsx:83` | [ ] | [ ] | [ ] |
| P878 | "Loading Discord settings…" / error | Load state | `renderer/components/streaming/discord-section.tsx:90` | [ ] | [ ] | [ ] |
| P879 | "Webhook URL" field (Enter saves, Esc cancels) | Paste Discord webhook | `renderer/components/streaming/discord-section.tsx:144` | [ ] | [ ] | [ ] |
| P880 | "Connect" / "Connecting…" | Saves webhook | `renderer/components/streaming/discord-section.tsx:165` | [ ] | [ ] | [ ] |
| P881 | "Cancel" (add another) | Hides extra webhook field | `renderer/components/streaming/discord-section.tsx:174` | [ ] | [ ] | [ ] |
| P882 | Webhook row (name, channel hint, last post) | Connected webhook status | `renderer/components/streaming/discord-section.tsx:408` | [ ] | [ ] | [ ] |
| P883 | "Send test message" | Posts test to webhook | `renderer/components/streaming/discord-section.tsx:449` | [ ] | [ ] | [ ] |
| P884 | "Remove" | Asks to remove webhook | `renderer/components/streaming/discord-section.tsx:459` | [ ] | [ ] | [ ] |
| P885 | "View in Discord" | Opens posted message | `renderer/components/streaming/discord-section.tsx:475` | [ ] | [ ] | [ ] |
| P886 | "Add webhook…" (max-count reason) | Shows another-webhook field | `renderer/components/streaming/discord-section.tsx:297` | [ ] | [ ] | [ ] |
| P887 | "New webhook URL"/"Another webhook URL" field | Replace deleted / add webhook | `renderer/components/streaming/discord-section.tsx:283` | [ ] | [ ] | [ ] |
| P888 | "Announce when I go live" switch | Enables go-live posts | `renderer/components/streaming/discord-section.tsx:312` | [ ] | [ ] | [ ] |
| P889 | "Post as" select | Sender identity | `renderer/components/streaming/discord-section.tsx:320` | [ ] | [ ] | [ ] |
| P890 | "Ping" ("No ping"/"@here"/"@everyone") | Mention mode | `renderer/components/streaming/discord-section.tsx:340` | [ ] | [ ] | [ ] |
| P891 | "Videorc footer" switch | Adds "Live with Videorc" | `renderer/components/streaming/discord-section.tsx:349` | [ ] | [ ] | [ ] |
| P892 | "Links in the post" rows + "Link {label} in the post" switch | Include destination links | `renderer/components/streaming/discord-section.tsx:520,587` | [ ] | [ ] | [ ] |
| P893 | "Add link…" / edit pencil / remove-typed X / link input + Save/Cancel | Type or clear a destination link | `renderer/components/streaming/discord-section.tsx:616` | [ ] | [ ] | [ ] |
| P894 | "Changes apply to your next stream." | Live notice | `renderer/components/streaming/discord-section.tsx:363` | [ ] | [ ] | [ ] |
| P895 | Dialog "Remove the … webhook?" ("Remove webhook") | Confirms removal | `renderer/components/streaming/discord-section.tsx:366` | [ ] | [ ] | [ ] |

### Guests ⌘7 — Room section (guests-tab.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P896 | Offline / LockAlert ("View Premium") / session lock | Why the room is unavailable | `renderer/components/guests/guests-tab.tsx:145` | [ ] | [ ] | [ ] |
| P897 | Room row (status dot, phase label, "Backstage time counts after 30 min") | Room phase | `renderer/components/guests/guests-tab.tsx:157` | [ ] | [ ] | [ ] |
| P898 | Count badges ("N want to join", "N on stage", "N backstage") | Room counts | `renderer/components/guests/guests-tab.tsx:171` | [ ] | [ ] | [ ] |
| P899 | "Open the room" / "Opening…" | Opens cloud room with title/platforms | `renderer/components/guests/guests-tab.tsx:188` | [ ] | [ ] | [ ] |
| P900 | "Sends" profile chips / output-plan description | What the room sends (hover sentence) | `renderer/components/guests/guests-tab.tsx:209` | [ ] | [ ] | [ ] |
| P901 | Room message warning alert | Backend room message | `renderer/components/guests/guests-tab.tsx:240` | [ ] | [ ] | [ ] |

### Guests — On the program (guests-tab.tsx RoomProgramOptIns)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P902 | "Avatar" switch ("Avatar on the program") | Avatar on managed-show program | `renderer/components/guests/guests-tab.tsx:290` | [ ] | [ ] | [ ] |
| P903 | "Show the avatar to guests" switch | Guests see avatar | `renderer/components/guests/guests-tab.tsx:305` | [ ] | [ ] | [ ] |
| P904 | "Graphics" switch ("Graphics on the program") | Graphics on program | `renderer/components/guests/guests-tab.tsx:318` | [ ] | [ ] | [ ] |
| P905 | "Open the room first." reason | Disabled reason before open | `renderer/components/guests/guests-tab.tsx:236` | [ ] | [ ] | [ ] |

### Guests — Invite link (guests-tab.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P906 | Read-only "Invite link" field | Shows link; selects on focus | `renderer/components/guests/guests-tab.tsx:393` | [ ] | [ ] | [ ] |
| P907 | "Copy" / "Copied" | Copies invite link | `renderer/components/guests/guests-tab.tsx:405` | [ ] | [ ] | [ ] |
| P908 | "New link" / "Making…" | Rotates invite (may ask first) | `renderer/components/guests/guests-tab.tsx:421` | [ ] | [ ] | [ ] |
| P909 | "Let anyone with the link in backstage" switch | Door open/closed | `renderer/components/guests/guests-tab.tsx:442` | [ ] | [ ] | [ ] |
| P910 | Consent line "Guests read this before they ask to join…" | Shows guest consent text | `renderer/components/guests/guests-tab.tsx:456` | [ ] | [ ] | [ ] |
| P911 | Dialog "Make a new link?" | Confirms rotation | `renderer/components/guests/guests-tab.tsx:459` | [ ] | [ ] | [ ] |
| P912 | Limits description | Room limits line | `renderer/components/guests/guests-tab.tsx:387` | [ ] | [ ] | [ ] |

### Guests — Who's here (guests-tab.tsx, room-person.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P913 | "The room is full…" alert | Room capacity reached | `renderer/components/guests/guests-tab.tsx:251` | [ ] | [ ] | [ ] |
| P914 | "Nobody has joined yet. Share the link." | Empty state (+ declined line) | `renderer/components/guests/guests-tab.tsx:493` | [ ] | [ ] | [ ] |
| P915 | Groups "Wants to join" / "On stage" / "Backstage" with counts | People lists | `renderer/components/guests/guests-tab.tsx:521` | [ ] | [ ] | [ ] |
| P916 | Request row (initial, device icon) + "Let in" / "Decline" | Admit or decline guest | `renderer/components/guests/room-person.tsx:255,293,301` | [ ] | [ ] | [ ] |
| P917 | Person thumb (live camera, green rim when talking, camera-off letter) | Person picture | `renderer/components/guests/room-person.tsx:65` | [ ] | [ ] | [ ] |
| P918 | Connection dot (tooltip) | Weak connection indicator | `renderer/components/guests/room-person.tsx:115` | [ ] | [ ] | [ ] |
| P919 | "Away" badge / mic-held or mic-off badge | State words beside icons | `renderer/components/guests/room-person.tsx:145,154` | [ ] | [ ] | [ ] |
| P920 | Mic toggle ("Mute {name}"/"Let {name} unmute"; host self-mute) | Host mic hold / own mute | `renderer/components/guests/room-person.tsx:170,393` | [ ] | [ ] | [ ] |
| P921 | Screen-share toggle | Allow/disallow/stop guest screen share | `renderer/components/guests/room-person.tsx:219` | [ ] | [ ] | [ ] |
| P922 | ⋯ "More for {name}" menu | Moderation items | `renderer/components/guests/room-person.tsx:414` | [ ] | [ ] | [ ] |

### Guests — Moderation (guest-moderation.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P923 | ⋯ "Rename…" | Opens Rename guest dialog | `renderer/components/guests/guest-moderation.tsx:93` | [ ] | [ ] | [ ] |
| P924 | ⋯ "Remove…" | Asks to remove guest | `renderer/components/guests/guest-moderation.tsx:99` | [ ] | [ ] | [ ] |
| P925 | ⋯ "Ban…" | Asks to ban guest (rotates link) | `renderer/components/guests/guest-moderation.tsx:105` | [ ] | [ ] | [ ] |
| P926 | Dialog "Rename guest" ("Name", "Cancel", "Save") | Renames guest tile | `renderer/components/guests/guest-moderation.tsx:191` | [ ] | [ ] | [ ] |
| P927 | Dialog "Remove {name}?" | Confirms remove | `renderer/components/guests/guest-moderation.tsx:139` | [ ] | [ ] | [ ] |
| P928 | Dialog "Ban {name}?" + toast "New link. Share it again…" | Confirms ban; announces new link | `renderer/components/guests/guest-moderation.tsx:152` | [ ] | [ ] | [ ] |
| P929 | Unmute toast "{name} can talk again once they unmute." | Explains unmute lets go only | `renderer/components/guests/guest-moderation.tsx:74` | [ ] | [ ] | [ ] |

### Guests — Close room (close-room-button.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P930 | "Close the room" / "Closing…" | Closes room (asks if anyone in/live) | `renderer/components/guests/close-room-button.tsx:45` | [ ] | [ ] | [ ] |
| P931 | Dialog "Close the room?" | "Your guests leave and the recording finalizes." | `renderer/components/guests/close-room-button.tsx:65` | [ ] | [ ] | [ ] |

### Guests — Separate files / cloud ISO (cloud-iso-section.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P932 | "Record separate files" switch | Opens consent to enable; off disables | `renderer/components/guests/cloud-iso-section.tsx:183` | [ ] | [ ] | [ ] |
| P933 | "Guests" consent list | Per-guest agreement status dots | `renderer/components/guests/cloud-iso-section.tsx:203` | [ ] | [ ] | [ ] |
| P934 | "Files" list | Per-person/source file status this take | `renderer/components/guests/cloud-iso-section.tsx:217` | [ ] | [ ] | [ ] |
| P935 | Notes / "A take's separate files couldn't be read." | Warnings | `renderer/components/guests/cloud-iso-section.tsx:235` | [ ] | [ ] | [ ] |
| P936 | Dialog "Record separate files?" + cost line + "I agree…" checkbox + "Turn on separate files" | Consent and enable ISO | `renderer/components/guests/cloud-iso-section.tsx:246` | [ ] | [ ] | [ ] |

### Guests — Allowance gating (lib/guests-view.ts, lib/livestream-tabs.ts)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P937 | Guests page visibility | Shown with talk-show allowance or open room | `renderer/lib/livestream-tabs.ts:23` | [ ] | [ ] | [ ] |
| P938 | Lock reasons ("Talk shows with guests come with Videorc Premium.", "Videorc Cloud isn't on…", "Talk shows aren't on…", "Videorc can't check…") | Explains lock; upsell only for no plan | `renderer/lib/guests-view.ts:51` | [ ] | [ ] | [ ] |
| P939 | "The room opens once your recording or livestream ends." | Session holds camera | `renderer/lib/guests-view.ts:100` | [ ] | [ ] | [ ] |

### Stream Manager — window and tiers

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P940 | Window header "Stream Manager" | Title-only row | `renderer/components/stream-manager/stream-manager.tsx:1317` | [ ] | [ ] | [ ] |
| P941 | Default size 1120×720; legacy 420×640 frame migrated once; min width 320 | Window sizing | `main/stream-manager-frame.ts:7-8; main/index.ts:4728` | [x] | [ ] | [ ] |
| P942 | Layout tiers: Wide ≥1040, Medium 640–1039, Narrow <640, labels hide <800 | Container-query layout | `renderer/lib/stream-manager-layout.ts:1-37` | [ ] | [ ] | [ ] |
| P943 | History bar + "Back to live" | Session history view; return to live | `renderer/components/stream-manager/stream-manager.tsx:1319,1328` | [ ] | [ ] | [ ] |
| P944 | Sidekick toasts (question, promise reminder, dead air) | Private live nudges | `renderer/components/stream-manager/stream-manager.tsx:675-695` | [ ] | [ ] | [ ] |

### Stream Manager — stats bar (stats-bar.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P945 | "ON AIR" / "Recording" / "History" chip | Session state | `renderer/components/stream-manager/stats-bar.tsx:114` | [ ] | [ ] | [ ] |
| P946 | Watchdog alert chip + hover card (fix relayed to Studio) | Open alert summary | `renderer/components/stream-manager/stats-bar.tsx:46` | [ ] | [ ] | [ ] |
| P947 | Stat cells: Clock, Viewers, Followers, Subs and members, Tips, Chat pace | Live stats; details hover card on hover/focus | `renderer/components/stream-manager/stats-bar.tsx:178` | [ ] | [ ] | [ ] |
| P948 | Sparklines | Trend graphs at Wide only | `renderer/components/stream-manager/stats-bar.tsx:238` | [ ] | [ ] | [ ] |
| P949 | Drag a stat | Reorders stats | `renderer/components/stream-manager/stats-bar.tsx:289` | [ ] | [ ] | [ ] |
| P950 | Screen hidden chip | Screen hidden from viewers | `renderer/components/stream-manager/stats-bar.tsx:375` | [ ] | [ ] | [ ] |
| P951 | Right-click menu "Stats": per-stat checkboxes, "Move {stat} left/right", "Reset stats" | Show/hide/reorder stats | `renderer/components/stream-manager/stats-bar.tsx:384` | [ ] | [ ] | [ ] |

### Stream Manager — panes and shortcuts (stream-manager.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P952 | Below-Wide tabs "Chat" / "Activity" / "Sidekick" | Pick single pane | `renderer/components/stream-manager/stream-manager.tsx:1357` | [ ] | [ ] | [ ] |
| P953 | Wide right tabs "Activity" / "Sidekick" | Right pane beside chat | `renderer/components/stream-manager/stream-manager.tsx:1389` | [ ] | [ ] | [ ] |
| P954 | Tab unseen badge (count, "99+", "New"), status dot, "On stream" dot | Unread and state on tabs | `renderer/components/stream-manager/stream-manager.tsx:252` | [ ] | [ ] | [ ] |
| P955 | ⌘J / ⌘F / ⌘L | Focus Sidekick / search chat / write in chat | `renderer/components/stream-manager/stream-manager.tsx:932` | [ ] | [ ] | [ ] |
| P956 | Auto-reveal Sidekick pane on new card | Brings cards forward, restores after | `renderer/components/stream-manager/stream-manager.tsx:901` | [ ] | [ ] | [ ] |

### Stream Manager — chat pane filters and list (chat-pane.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P957 | Platform filter "All" + per-platform icon chips ("Only {platform}") | Filters chat by platform (≥2 platforms) | `renderer/components/stream-manager/platform-filter.tsx:33` | [ ] | [ ] | [ ] |
| P958 | "Questions" / "Mentions" toggles | Filter to Sidekick questions / @mentions | `renderer/components/stream-manager/chat-pane.tsx:461` | [ ] | [ ] | [ ] |
| P959 | "Filters" menu (Narrow): "Every platform"/platforms, Questions, Mentions | Same filters folded <640 px | `renderer/components/stream-manager/chat-pane.tsx:491` | [ ] | [ ] | [ ] |
| P960 | "Search chat…" (⌘F chip; Esc clears) | Searches chat | `renderer/components/stream-manager/chat-pane.tsx:550` | [ ] | [ ] | [ ] |
| P961 | "Chat on stream" switch | Chat overlay on stream | `renderer/components/stream-manager/chat-on-stream-switch.tsx:28` | [ ] | [ ] | [ ] |
| P962 | Sign-in rows "Use Sign in" / "Sign in to Videorc" | Fix chat needing sign-in | `renderer/components/stream-manager/chat-sign-in-rows.tsx:93,105` | [ ] | [ ] | [ ] |
| P963 | Chat command failure rows + "Dismiss" | Replies that couldn't post | `renderer/components/stream-manager/chat-command-failures.tsx:51` | [ ] | [ ] | [ ] |
| P964 | "No messages match these filters." | Filtered empty state | `renderer/components/stream-manager/chat-pane.tsx:603` | [ ] | [ ] | [ ] |
| P965 | Off-air/empty: "Start a livestream to see chat here." / "Chat is connected…" | Empty chat | `renderer/components/stream-manager/chat-pane.tsx:1452` | [ ] | [ ] | [ ] |
| P966 | Row keys ↑/↓ Home End, R reply, C copy, ⇧⌫ remove, Esc composer | Roving-focus row actions | `renderer/components/stream-manager/chat-pane.tsx:403; renderer/lib/chat-list-keys.ts:23` | [ ] | [ ] | [ ] |
| P967 | Row ⋯: "Show on stream"/"Take off stream", "Reply", "About {name}", "Open/Copy link", "Copy", "Remove from chat" | Message actions | `renderer/components/comment-row.tsx:941` | [ ] | [ ] | [ ] |
| P968 | Right-click person menu: "About {name}", "Same person as…" (X disabled), "Mark as bot" | Community person actions | `renderer/components/stream-manager/chat-pane.tsx:1489` | [ ] | [ ] | [ ] |
| P969 | "Mark as bot" toast + "Undo" | Marks bot with undo | `renderer/components/stream-manager/stream-manager.tsx:1549` | [ ] | [ ] | [ ] |
| P970 | Jump chip ("N new"/"New chat"/"Latest") | Return to newest message | `renderer/components/chat-jump-chip.tsx:30` | [ ] | [ ] | [ ] |

### Stream Manager — composer (chat-pane.tsx Composer)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P971 | "To: {All/None/platforms}" send-to menu + "Every writable destination" | Choose chat destinations | `renderer/components/stream-manager/chat-pane.tsx:1184` | [ ] | [ ] | [ ] |
| P972 | Mode tag ("Local · current session", "Sidekick", "All chats", "Local") | Shows local command target | `renderer/components/stream-manager/chat-pane.tsx:1170` | [ ] | [ ] | [ ] |
| P973 | Message input ("Message, /marker [title] or /clip…") | Type message or command; Enter sends | `renderer/components/stream-manager/chat-pane.tsx:1233` | [ ] | [ ] | [ ] |
| P974 | Character counter (n/max, marker n/120) | Length and over-limit icon | `renderer/components/stream-manager/chat-pane.tsx:1280` | [ ] | [ ] | [ ] |
| P975 | Send button (varied aria labels) | Sends message / runs command | `renderer/components/stream-manager/chat-pane.tsx:1301` | [ ] | [ ] | [ ] |
| P976 | Completions: /hide, /show, /marker, /clip, /clip 60, /banner, /sound, /buddy, /help, !commands, "Edit chat commands…" | Arrow/Tab/Enter completion list | `renderer/components/stream-manager/chat-pane.tsx:755,1325` | [ ] | [ ] | [ ] |
| P977 | Marker voice status line | Sidekick connecting for markers | `renderer/components/stream-manager/chat-pane.tsx:1346` | [ ] | [ ] | [ ] |
| P978 | Notice line + "Undo" (marker) | Command result; undo saved marker | `renderer/components/stream-manager/chat-pane.tsx:1354` | [ ] | [ ] | [ ] |
| P979 | "Sidekick's draft. Enter sends it." | Question reply draft hint | `renderer/components/stream-manager/chat-pane.tsx:1384` | [ ] | [ ] | [ ] |
| P980 | Destination status + "Retry" | Failed send retry | `renderer/components/stream-manager/chat-pane.tsx:1392,1398` | [ ] | [ ] | [ ] |
| P981 | Sidekick-off nudge "Turn on" / "Dismiss" | Offer to enable Sidekick | `renderer/components/cohost-nudge.tsx — renderer/components/cohost-nudge.tsx:30` | [ ] | [ ] | [ ] |
| P982 | "Sending…" delivery badge | In-flight send (text on hover) | `renderer/components/stream-manager/chat-pane.tsx:1428` | [ ] | [ ] | [ ] |

### Stream Manager — activity pane (activity-pane.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P983 | Platform filter ("Show activity from") | Filter activity by platform | `renderer/components/stream-manager/activity-pane.tsx:478` | [ ] | [ ] | [ ] |
| P984 | Kind chips with counts: Follows, Subs, Tips, Rewards, Raids, Streaks, Destinations | Filter activity kind | `renderer/components/stream-manager/activity-pane.tsx:485; renderer/lib/stream-activity.ts:45` | [ ] | [ ] | [ ] |
| P985 | "Filters" menu (Narrow): "Everything"/kinds + platforms | Same filters <640 px | `renderer/components/stream-manager/activity-pane.tsx:507` | [ ] | [ ] | [ ] |
| P986 | "Auto-show" switch | Auto-highlights new events on stream | `renderer/components/stream-manager/activity-pane.tsx:567` | [ ] | [ ] | [ ] |
| P987 | Power-ups banner + "Reconnect Twitch" | Requests Twitch bits/points scope | `renderer/components/stream-manager/activity-pane.tsx:585` | [ ] | [ ] | [ ] |
| P988 | Row ⋯: "Show on stream"/"Take off stream", "Thank in chat", "Reconnect Twitch", "Copy" | Activity row actions | `renderer/components/stream-manager/activity-pane.tsx:205` | [ ] | [ ] | [ ] |
| P989 | Empty: "Follows, subs, gifts…" / "Nothing matches this filter." + "Reconnect Twitch" | Empty state + follow-names fix | `renderer/components/stream-manager/activity-pane.tsx:620` | [ ] | [ ] | [ ] |

### Stream Manager — Sidekick pane and cards

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P990 | Header "Sidekick" + "Alpha" + listening indicator + status | Sidekick identity and state | `renderer/components/stream-manager/stream-manager.tsx:1057` | [ ] | [ ] | [ ] |
| P991 | "Sidekick Live" switch | Turns Sidekick on/off (consent first) | `renderer/components/cohost-status.tsx:101` | [ ] | [ ] | [ ] |
| P992 | "N waiting" + polite announcement | Cards waiting count | `renderer/components/stream-manager/buddy-cards-area.tsx:51` | [ ] | [ ] | [ ] |
| P993 | Card keys Enter primary; Esc/⌫/Del decline; 1–3 choose | Keyboard answers when nothing focused | `renderer/components/stream-manager/buddy-card.tsx:44; removal-cards.tsx:53,74` | [ ] | [ ] | [ ] |
| P994 | "Which comment did you mean?" chooser + "Cancel" | Voice-command disambiguation | `renderer/components/stream-manager/command-cards.tsx:157` | [ ] | [ ] | [ ] |
| P995 | "Show this comment on stream?" / "Remember this?" ("Show"/"Save"/"Yes", "Cancel") | Confirm flagged/command action | `renderer/components/stream-manager/command-cards.tsx:206` | [ ] | [ ] | [ ] |
| P996 | "Remove {author}'s message from {platform}?" ("Remove"/"Remove now", "Cancel", timer) | Confirms Sidekick removal | `renderer/components/stream-manager/removal-cards.tsx:147` | [ ] | [ ] | [ ] |
| P997 | "{name} wants to post" ("Send"/"Dismiss") | Approve proposed post | `renderer/components/stream-manager/buddy-utterance-cards.tsx:206` | [ ] | [ ] | [ ] |
| P998 | "{name}'s milestone" ("Show on stream") | Put milestone card on stream | `renderer/components/stream-manager/buddy-utterance-cards.tsx:184` | [ ] | [ ] | [ ] |
| P999 | "Linked A and B" ("Undo"/"Keep") | Undo community link | `renderer/components/stream-manager/link-made-cards.tsx:46` | [ ] | [ ] | [ ] |
| P1000 | "Reconnect {platform} to let Sidekick remove messages." + "Reconnect" | Missing moderation scope | `renderer/components/stream-manager/remove-messages-reconnect.tsx:38` | [ ] | [ ] | [ ] |
| P1001 | Sidekick empty "Sidekick reads chat during a live stream…" | Pane empty state | `renderer/components/stream-manager/stream-manager.tsx:1232` | [ ] | [ ] | [ ] |
| P1002 | "{name} talks" segmented ("Off"/"Bubble"/"Suggest") + hint | Avatar talk mode | `renderer/components/stream-manager/buddy-chat-controls.tsx:129` | [ ] | [ ] | [ ] |
| P1003 | Behaviour chips ("What {name} says") | Opens that behaviour's settings | `renderer/components/stream-manager/buddy-chat-controls.tsx:150` | [ ] | [ ] | [ ] |
| P1004 | Dialog "Let {name} post as you?" ("Not now"/"Allow") | Posting consent for Suggest | `renderer/components/stream-manager/buddy-chat-controls.tsx:194` | [ ] | [ ] | [ ] |
| P1005 | Say footer ("Say something on stream", "React on stream", "{name} on stream") | Avatar speech/reactions/visibility | `renderer/components/cohost-pane.tsx:810,831,880` | [ ] | [ ] | [ ] |
| P1006 | Person card: popover/"About {name}" dialog (<640 px), "View Premium", Forget dialogs | Community person details | `renderer/components/stream-manager/person-card-host.tsx:117,124,82,142,166` | [ ] | [ ] | [ ] |

### Stream Manager — status bar (stream-manager-status-bar.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P1007 | Per-platform chat state (icon, dot, words, hover card) | Chat read/send capability and problems | `renderer/components/stream-manager/stream-manager-status-bar.tsx:457` | [ ] | [ ] | [ ] |
| P1008 | "Hidden from your stream" footer | Window excluded from capture *(macOS/Windows only (apps/desktop/src/main/window-capture-protection.ts:57))* | `renderer/components/stream-manager/stream-manager-status-bar.tsx:517` | [ ] | [ ] | n/a |
| P1009 | Hints "Search" ⌘F, "Write" ⌘L, "Sidekick" ⌘J | Clickable shortcut hints | `renderer/components/stream-manager/stream-manager-status-bar.tsx:548` | [ ] | [ ] | [ ] |
| P1010 | "Hide screen" / "Show screen" | Frosts screen on recording and streams | `renderer/components/stream-manager/stream-manager-status-bar.tsx:561` | [ ] | [ ] | [ ] |
| P1011 | "Keep on top" pin | Always-on-top window | `renderer/components/stream-manager/stream-manager-status-bar.tsx:575` | [ ] | [ ] | [ ] |
| P1012 | "Hide from stream" toggle | Keeps window out of capture *(macOS capture filter; Windows content protection; Linux disabled with reason (apps/desktop/src/main/window-capture-protection.ts:57))* | `renderer/components/stream-manager/stream-manager-status-bar.tsx:583` | [ ] | [ ] | [ ] |
| P1013 | "Highlight position" menu (Top/Bottom left/right) | Highlight card corner | `renderer/components/stream-manager/stream-manager-status-bar.tsx:601` | [ ] | [ ] | [ ] |
| P1014 | "Clip 30 s" / "1 min" | Save last seconds as clip | `renderer/components/stream-manager/stream-manager-status-bar.tsx:617` | [ ] | [ ] | [ ] |
| P1015 | "Banners" menu (banner checks, "Hide all banners", "Import banners in Images") | Show/hide banners | `renderer/components/stream-manager/stream-manager-status-bar.tsx:633` | [ ] | [ ] | [ ] |
| P1016 | "Sounds" | Opens Sounds popover | `renderer/components/stream-manager/stream-manager-status-bar.tsx:651` | [ ] | [ ] | [ ] |
| P1017 | "Clear" | Asks to clear the view | `renderer/components/stream-manager/stream-manager-status-bar.tsx:663` | [ ] | [ ] | [ ] |
| P1018 | "Commands" ("Chat commands…") | Opens Destinations chat commands (≥800 px) | `renderer/components/stream-manager/stream-manager-status-bar.tsx:674` | [ ] | [ ] | [ ] |
| P1019 | "Open {Preview}" | Opens preview window | `renderer/components/stream-manager/stream-manager-status-bar.tsx:684` | [ ] | [ ] | [ ] |
| P1020 | Notification bell | Opens notification list | `renderer/components/stream-manager/stream-manager-status-bar.tsx:691` | [ ] | [ ] | [ ] |
| P1021 | ⋯ "More Stream Manager actions" (Narrow): hints, Hide screen, Highlight position, Keep on top, Hide from stream, Clips, Banners, "Sounds…", "Chat commands…", Open Preview, "Notifications (n)", "Show or hide stats", "Clear view" | Folded controls <640 px | `renderer/components/stream-manager/stream-manager-status-bar.tsx:693` | [ ] | [ ] | [ ] |
| P1022 | Dialog "Clear the view?" ("Clear view") | Empties chat/Activity for this window | `renderer/components/stream-manager/stream-manager-status-bar.tsx:921` | [ ] | [ ] | [ ] |

### Stream Manager — Sounds popover (sounds-popover.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P1023 | "Sounds" header + Stop all | Stops all playing sounds | `renderer/components/stream-manager/sounds-popover.tsx:28` | [ ] | [ ] | [ ] |
| P1024 | Sound pads (4 per row) | Play/stop a pad via Studio | `renderer/components/stream-manager/sounds-popover.tsx:39` | [ ] | [ ] | [ ] |
| P1025 | "Loading sounds…" / "No sounds yet. Add them in Sounds." | Loading/empty states | `renderer/components/stream-manager/sounds-popover.tsx:36` | [ ] | [ ] | [ ] |

### Notification centre (components/notifications/*)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P1026 | Bell button (count "9+", tooltip with shortcut, live announcements) | Toggles notification popover | `renderer/components/notifications/notification-bell.tsx:135` | [ ] | [ ] | [ ] |
| P1027 | ⌘⇧B / Ctrl+Shift+B | Toggles notifications | `renderer/lib/shortcuts.ts:41; renderer/components/notifications/stream-manager-notification-bell.tsx:33` | [ ] | [ ] | [ ] |
| P1028 | Header "Notifications" + "Clear all" | Clears all clearable entries | `renderer/components/notifications/notification-center.tsx:181,183` | [ ] | [ ] | [ ] |
| P1029 | "No notifications" / "Problems and finished work show up here." | Empty state | `renderer/components/notifications/notification-center.tsx:195` | [ ] | [ ] | [ ] |
| P1030 | "Now" / "Earlier" groups | Groups entries | `renderer/components/notifications/notification-center.tsx:209` | [ ] | [ ] | [ ] |
| P1031 | Entry row (icon, title, unread dot, time, detail) | One notification | `renderer/components/notifications/notification-entry.tsx:61` | [ ] | [ ] | [ ] |
| P1032 | Entry action buttons | Run notification's actions (spinner while busy) | `renderer/components/notifications/notification-entry.tsx:114` | [ ] | [ ] | [ ] |
| P1033 | "Clear {title}" X | Clears one entry | `renderer/components/notifications/notification-entry.tsx:136` | [ ] | [ ] | [ ] |
| P1034 | Keys ↑/↓, Enter (first action), ⌫/Del (clear) | Keyboard list navigation | `renderer/components/notifications/notification-center.tsx:143` | [ ] | [ ] | [ ] |
| P1035 | Footer quiet line + "Settings" (main window) | Quiet-while-live state; opens settings | `renderer/components/notifications/main-notification-center.tsx:30,41` | [ ] | [ ] | [ ] |
| P1036 | Footer quiet line + "Settings" (Stream Manager) | Opens main window settings | `renderer/components/notifications/stream-manager-notification-center.tsx:33,44` | [ ] | [ ] | [ ] |

### Notes window (notes-window.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P1037 | Window header "Notes" | Title row; default 640×420, min 360×240 | `renderer/components/notes-window.tsx:215; main/index.ts:3780` | [ ] | [ ] | [ ] |
| P1038 | Notes textarea ("Notes for this recording…") | Teleprompter text; autosaves; Esc blurs | `renderer/components/notes-window.tsx:216` | [ ] | [ ] | [ ] |
| P1039 | "These notes can appear in your recording" alert | Capture protection unavailable/failed *(Linux (unsupported) or failure (apps/desktop/src/main/window-capture-protection.ts:102))* | `renderer/components/notes-window.tsx:249` | [ ] | [ ] | [ ] |
| P1040 | "Couldn't open your notes…" + "Retry" | Load failure retry | `renderer/components/notes-window.tsx:263` | [ ] | [ ] | [ ] |
| P1041 | "Couldn't save your notes…" + "Retry" | Save failure retry | `renderer/components/notes-window.tsx:289` | [ ] | [ ] | [ ] |
| P1042 | Word count | "N words" in footer | `renderer/components/notes-window.tsx:318` | [ ] | [ ] | [ ] |
| P1043 | Save state ("Saved"/"Saving…"/"Not saved") | Autosave status | `renderer/components/notes-window.tsx:320` | [ ] | [ ] | [ ] |
| P1044 | "Hidden from recordings and streams" | Capture protection holds *(macOS/Windows only (apps/desktop/src/main/window-capture-protection.ts:102))* | `renderer/components/notes-window.tsx:324` | [ ] | [ ] | n/a |
| P1045 | "Text size" ("Small"/"Medium"/"Large") | 18/24/32 px text, saved | `renderer/components/notes-window.tsx:333` | [ ] | [ ] | [ ] |
| P1046 | Pin error ("Couldn't keep on top"/"Keep on top isn't available") | Why pin failed | `renderer/components/notes-window.tsx:348` | [ ] | [ ] | [ ] |
| P1047 | "Keep on top" pin | Always-on-top toggle | `renderer/components/notes-window.tsx:360` | [ ] | [ ] | [ ] |
| P1048 | Close flush | Last save before window closes | `renderer/components/notes-window.tsx:171` | [ ] | [ ] | [ ] |


## Avatar ⌘8, Sidekick ⌘9, Images, Sounds, Library ⌘0 and Settings ⌘,

### Avatar page (⌘8): page shell and status row (tabs/avatar-tab.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P1049 | Page key ⌘8 ("Avatar") | Opens the Avatar page. Key assigned by the sidebar digit order | `shared/sidebar-pages.ts:144` | [ ] | [ ] | [ ] |
| P1050 | Tab strip "Profile" / "Greetings" | Switches the Avatar sections. The shell remembers the last tab | `renderer/components/tabs/avatar-tab.tsx:60 (labels renderer/lib/avatar-tabs.ts:23)` | [ ] | [ ] | [ ] |
| P1051 | Avatar emblem + name + placement line | Shows the avatar's picture, its name and where it appears | `renderer/components/tabs/avatar-tab.tsx:105` | [ ] | [ ] | [ ] |
| P1052 | "Place on Scene" button + shortcut chip | Opens the Scene page | `renderer/components/tabs/avatar-tab.tsx:125` | [ ] | [ ] | [ ] |
| P1053 | Quiet alert "{name} isn't on stream yet…" | Explains how to turn the avatar on in Stream Manager | `renderer/components/tabs/avatar-tab.tsx:142` | [ ] | [ ] | [ ] |
| P1054 | Alive creator overlay | Hides Profile and shows the pet creator while it is open | `renderer/components/tabs/avatar-tab.tsx:69` | [ ] | [ ] | [ ] |

### Avatar → Profile: My avatars (buddy-library-section.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P1055 | Section "My avatars" + Syncing spinner | Avatar library. A spinner shows while it syncs | `renderer/components/buddy-library-section.tsx:179` | [ ] | [ ] | [ ] |
| P1056 | "New avatar…" button | Opens the 4-step avatar onboarding dialog | `renderer/components/buddy-library-section.tsx:189` | [ ] | [ ] | [ ] |
| P1057 | Invitation alert "Make this avatar your own, or pick another." + "Start" | Opens the onboarding at step 1 | `renderer/components/buddy-library-section.tsx:205` | [ ] | [ ] | [ ] |
| P1058 | Invitation "Dismiss" (X, tooltip) | Hides the invitation for good | `renderer/components/buddy-library-section.tsx:225` | [ ] | [ ] | [ ] |
| P1059 | Alert (avatar is local only) + "Save to my library" | Uploads an avatar that only exists on this computer to the library | `renderer/components/buddy-library-section.tsx:248` | [ ] | [ ] | [ ] |
| P1060 | Busy status line | Says what the library is working on | `renderer/components/buddy-library-section.tsx:267` | [ ] | [ ] | [ ] |
| P1061 | Alert (avatar picked on another device) + "Use" | Switches to the avatar chosen on another device | `renderer/components/buddy-library-section.tsx:279` | [ ] | [ ] | [ ] |
| P1062 | Group "Official" gallery cards | Built-in avatars, each with a "Use" button | `renderer/components/buddy-library-section.tsx:300` | [ ] | [ ] | [ ] |
| P1063 | Group "Made by you" gallery | The user's avatars | `renderer/components/buddy-library-section.tsx:316` | [ ] | [ ] | [ ] |
| P1064 | Signed-out empty state + "Sign in" | Asks the user to sign in to see web-made avatars | `renderer/components/buddy-library-section.tsx:317` | [ ] | [ ] | [ ] |
| P1065 | Empty "Avatars you create show up here…" / unavailable line | Shown when there are no avatars or the library can't load | `renderer/components/buddy-library-section.tsx:338` | [ ] | [ ] | [ ] |
| P1066 | Card "Use" button | Makes this avatar the active one | `renderer/components/buddy-library-section.tsx:469` | [ ] | [ ] | [ ] |
| P1067 | Card "Alive" tag / Active state | Marks cards that move, and the card in use | `renderer/components/buddy-library-section.tsx:452` | [ ] | [ ] | [ ] |
| P1068 | Card "More for {name}" menu | Opens the card's actions menu | `renderer/components/buddy-library-section.tsx:482` | [ ] | [ ] | [ ] |
| P1069 | Menu "Rename" | Opens a rename dialog (made-by-you avatars only) | `renderer/components/buddy-library-section.tsx:500` | [ ] | [ ] | [ ] |
| P1070 | Menu "Edit personality" | Opens the personality and About-you editor | `renderer/components/buddy-library-section.tsx:507` | [ ] | [ ] | [ ] |
| P1071 | Menu "Make it Alive" | Uses this avatar, then opens the Alive creator | `renderer/components/buddy-library-section.tsx:517` | [ ] | [ ] | [ ] |
| P1072 | Menu "Delete" (destructive) | Asks before deleting the avatar | `renderer/components/buddy-library-section.tsx:525` | [ ] | [ ] | [ ] |
| P1073 | Delete confirm "Delete {name}?" ("Cancel" / "Delete" / "Deleting…") | Removes the avatar's pictures from the account | `renderer/components/buddy-library-section.tsx:580` | [ ] | [ ] | [ ] |
| P1074 | Rename dialog: "Name" input (1–24 characters) + "Cancel" / "Save" | Renames a library avatar | `renderer/components/buddy-library-section.tsx:686` | [ ] | [ ] | [ ] |
| P1075 | Edit-personality dialog: "Personality" and "About you (optional)" textareas with counters | Edits the library avatar's personality and context | `renderer/components/buddy-library-section.tsx:706` | [ ] | [ ] | [ ] |
| P1076 | Error alert (destructive) | Shows a failed library sync or action | `renderer/components/buddy-library-section.tsx:364` | [ ] | [ ] | [ ] |

### Avatar onboarding dialog (buddy-onboarding.tsx, copy in lib/buddy-onboarding-copy.ts)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P1077 | Dialog title per step ("Meet your avatar", "Describe it", "Give it a personality", "Create your avatar") | Four-step wizard for creating an avatar | `renderer/components/buddy-onboarding.tsx:376` | [ ] | [ ] | [ ] |
| P1078 | Step 1 gallery card "Use this one" | Uses an official avatar | `renderer/components/buddy-onboarding.tsx:712` | [ ] | [ ] | [ ] |
| P1079 | Step 1 "Create my own" (⌘/Ctrl+Enter) | Moves on to describing a custom avatar | `renderer/components/buddy-onboarding.tsx:529` | [ ] | [ ] | [ ] |
| P1080 | Step 2 "What does it look like?" textarea + example chips | Describes the avatar | `renderer/components/buddy-onboarding.tsx:790` | [ ] | [ ] | [ ] |
| P1081 | Step 2 "Choose a picture" / "Remove" | Adds or removes an optional inspiration picture | `renderer/components/buddy-onboarding.tsx:849` | [ ] | [ ] | [ ] |
| P1082 | Step 3 "Name" (Enter advances), "Personality", "About you (optional)" | Sets the avatar's name, personality and context | `renderer/components/buddy-onboarding.tsx:909` | [ ] | [ ] | [ ] |
| P1083 | "Back" | Goes to the previous step | `renderer/components/buddy-onboarding.tsx:474` | [ ] | [ ] | [ ] |
| P1084 | "Skip for now" | Skips an optional step | `renderer/components/buddy-onboarding.tsx:567` | [ ] | [ ] | [ ] |
| P1085 | "Next" (⌘/Ctrl+Enter) | Goes to the next step | `renderer/components/buddy-onboarding.tsx:577` | [ ] | [ ] | [ ] |
| P1086 | Step 4 summary (Look / Name / Personality / About you) | Reviews the answers before creating | `renderer/components/buddy-onboarding.tsx:1049` | [ ] | [ ] | [ ] |
| P1087 | "Create my avatar" (⌘/Ctrl+Enter) | Starts AI drawing (1–3 minutes) | `renderer/components/buddy-onboarding.tsx:592` | [ ] | [ ] | [ ] |
| P1088 | Draft live preview "The new look, alive. Click it to react." | Previews the new look, animated | `renderer/components/buddy-onboarding.tsx:1104` | [ ] | [ ] | [ ] |
| P1089 | "Make it Alive" / "Use as my avatar" (⌘/Ctrl+Enter) | Keeps the draft, optionally opening the Alive creator | `renderer/components/buddy-onboarding.tsx:541` | [ ] | [ ] | [ ] |
| P1090 | "Delete…" + confirm "Delete {name}" / "Keep it" | Deletes the drafted avatar | `renderer/components/buddy-onboarding.tsx:486` | [ ] | [ ] | [ ] |
| P1091 | "Start a new one" | Throws the draft away and starts over | `renderer/components/buddy-onboarding.tsx:496` | [ ] | [ ] | [ ] |
| P1092 | Gate alerts (sign in, Premium, allowance, "Allow cloud AI") | Explains why creating is locked and offers the fix | `renderer/components/buddy-create-gate-alert.tsx:30` | [ ] | [ ] | [ ] |
| P1093 | Failure alert | "Couldn't draw the pictures…" | `renderer/components/buddy-onboarding.tsx:1139` | [ ] | [ ] | [ ] |

### Avatar → Profile: Name and personality (buddy-persona-section.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P1094 | Section "Name and personality" | Edits the persona | `renderer/components/buddy-persona-section.tsx:103` | [ ] | [ ] | [ ] |
| P1095 | "Name" input (Enter blurs and saves) | Renames the avatar | `renderer/components/buddy-persona-section.tsx:273` | [ ] | [ ] | [ ] |
| P1096 | "Start over" + confirm "Start over with a new avatar?" ("Keep {name}" / "Start over") | Deletes the local persona and starts again | `renderer/components/buddy-persona-section.tsx:109` | [ ] | [ ] | [ ] |
| P1097 | "Bubble" style picker (Speech / Thought / Shout) | Sets the speech-bubble style | `renderer/components/buddy-persona-section.tsx:132` | [ ] | [ ] | [ ] |
| P1098 | "Zoom in on the bubble" button + "Bubble" dialog | Shows a larger bubble preview and picker | `renderer/components/buddy-persona-section.tsx:146` | [ ] | [ ] | [ ] |
| P1099 | "Personality" textarea + example chips | Sets the personality text | `renderer/components/buddy-persona-section.tsx:319` | [ ] | [ ] | [ ] |
| P1100 | "About you" textarea | Facts Sidekick uses to answer viewers | `renderer/components/buddy-persona-section.tsx:382` | [ ] | [ ] | [ ] |
| P1101 | Save error alert | Shows a failed save | `renderer/components/buddy-persona-section.tsx:122` | [ ] | [ ] | [ ] |

### Avatar → Profile: Look, Still/Alive and living preview (buddy-pet-settings.tsx, buddy-avatar-section.tsx, buddy-look-section.tsx, buddy-look-tiles.tsx, buddy-pet-preview.tsx, buddy-test-dialog.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P1102 | Section "Look" + segmented "Still" / "Alive" (manual activation) | Chooses a still picture set or the animated pack | `renderer/components/buddy-avatar-section.tsx:221` | [ ] | [ ] | [ ] |
| P1103 | Alert "A new look … under Still" + "Switch to Still" | Points to a pending look draft | `renderer/components/buddy-avatar-section.tsx:242` | [ ] | [ ] | [ ] |
| P1104 | Living preview (click to react, Esc re-centers) | Animated avatar that reacts when clicked | `renderer/components/buddy-pet-preview.tsx:461` | [ ] | [ ] | [ ] |
| P1105 | Preview error tooltip | Shows why the preview failed | `renderer/components/buddy-pet-preview.tsx:484` | [ ] | [ ] | [ ] |
| P1106 | "Play/Pause {name}" button | Pauses the moving preview | `renderer/components/buddy-avatar-section.tsx:289` | [ ] | [ ] | [ ] |
| P1107 | "Test" button (key T) | Opens the Test dialog | `renderer/components/buddy-avatar-section.tsx:301` | [ ] | [ ] | [ ] |
| P1108 | Key "I" in the Alive view | Imports moves | `renderer/components/buddy-avatar-section.tsx:212` | [ ] | [ ] | [ ] |
| P1109 | Test dialog "Test {name}" | Previews each state without going live | `renderer/components/buddy-test-dialog.tsx:144` | [ ] | [ ] | [ ] |
| P1110 | Test "State" segmented control (Idle 1 / Talking 2 / Laughing 3 / Thinking 4) | Switches the preview state, by click or digit key | `renderer/components/buddy-test-dialog.tsx:218` | [ ] | [ ] | [ ] |
| P1111 | Test reaction buttons | Plays each of the pack's reactions | `renderer/components/buddy-test-dialog.tsx:252` | [ ] | [ ] | [ ] |
| P1112 | "Show the bubble while Talking" switch | Toggles the bubble in the test | `renderer/components/buddy-test-dialog.tsx:273` | [ ] | [ ] | [ ] |
| P1113 | Still: "Current look" pose tiles (Default / Uses idle badges) | Shows the four pose pictures | `renderer/components/buddy-look-section.tsx:109` | [ ] | [ ] | [ ] |
| P1114 | Still: "Making the new look…" + elapsed time + "Cancel" | Progress of drawing a new look, with cancel | `renderer/components/buddy-look-tiles.tsx:201` | [ ] | [ ] | [ ] |
| P1115 | Draft pose tile "Redo" (key R) | Redraws one pose from the idle picture | `renderer/components/buddy-look-tiles.tsx:288` | [ ] | [ ] | [ ] |
| P1116 | Draft "Use as my avatar" (⌘/Ctrl+Enter) | Wears the drafted look | `renderer/components/buddy-look-section.tsx:183` | [ ] | [ ] | [ ] |
| P1117 | Draft "Delete…" + confirm "Delete the new look?" ("Keep it" / "Delete look") | Throws the draft away | `renderer/components/buddy-look-section.tsx:196` | [ ] | [ ] | [ ] |
| P1118 | Still: "Make it Alive" | Opens the Alive creator from the idle picture | `renderer/components/buddy-look-section.tsx:227` | [ ] | [ ] | [ ] |
| P1119 | Alive: create gate alert / "Allow cloud AI" | Explains the creation lock or asks for cloud-AI consent | `renderer/components/buddy-avatar-section.tsx:467` | [ ] | [ ] | [ ] |
| P1120 | Alive: "Moves" radiogroup rows ("Wearing" marker, arrow keys) | Wears a move pack | `renderer/components/buddy-avatar-section.tsx:495` | [ ] | [ ] | [ ] |
| P1121 | Alive empty state "No moves yet…" | Shown when no packs exist | `renderer/components/buddy-avatar-section.tsx:484` | [ ] | [ ] | [ ] |
| P1122 | "Create" | Opens the Alive creator | `renderer/components/buddy-avatar-section.tsx:441` | [ ] | [ ] | [ ] |
| P1123 | "Import moves…" | Imports a page-pet folder | `renderer/components/buddy-avatar-section.tsx:453` | [ ] | [ ] | [ ] |
| P1124 | "Remove" + confirm "Remove {pack}?" ("Keep it" / "Remove") | Deletes the worn move pack | `renderer/components/buddy-avatar-section.tsx:524` | [ ] | [ ] | [ ] |
| P1125 | Errors "Couldn't list your moves" / "Couldn't import those moves" | Failure alerts | `renderer/components/buddy-avatar-section.tsx:475` | [ ] | [ ] | [ ] |
| P1126 | Cloud AI consent dialog | Grants cloud AI before creating | `renderer/components/buddy-avatar-section.tsx:361` | [ ] | [ ] | [ ] |

### Avatar → Profile: Reactions and Motion (buddy-reactions-section.tsx, buddy-motion-section.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P1127 | Section "Reactions" grouped as Viewers / Regulars / Your stream | Maps stream events to avatar reactions | `renderer/components/buddy-reactions-section.tsx:66` | [ ] | [ ] | [ ] |
| P1128 | Per-trigger reaction select (Follow, Sub, Gifted subs, Raid…) | Picks the reaction for each event | `renderer/components/buddy-reactions-section.tsx:114` | [ ] | [ ] | [ ] |
| P1129 | "Try the … reaction" button | Plays the reaction in the preview | `renderer/components/buddy-reactions-section.tsx:131` | [ ] | [ ] | [ ] |
| P1130 | Section "Motion": slider + tick buttons "Off" / "Calm" / "Lively" | Sets how much the avatar moves | `renderer/components/buddy-motion-section.tsx:57` | [ ] | [ ] | [ ] |
| P1131 | "Sleep after" select | Idle time before the avatar sleeps | `renderer/components/buddy-motion-section.tsx:109` | [ ] | [ ] | [ ] |
| P1132 | "Breathing" switch | Slow breathing between events | `renderer/components/buddy-motion-section.tsx:146` | [ ] | [ ] | [ ] |

### Alive creator (buddy-pet-creator.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P1133 | "Back" + title "Create an Alive avatar" + allowance line | Leaves the creator, back to Profile | `renderer/components/buddy-pet-creator.tsx:328` | [ ] | [ ] | [ ] |
| P1134 | Step list (Picture / First poses / All poses / Check / Save) | Shows the creator's progress | `renderer/components/buddy-pet-creator.tsx:607` | [ ] | [ ] | [ ] |
| P1135 | Expired alert + "Start a new one" | Restarts a creation that expired | `renderer/components/buddy-pet-creator.tsx:357` | [ ] | [ ] | [ ] |
| P1136 | "Start from one picture": "My avatar's picture" / "Upload" | Chooses the reference image source | `renderer/components/buddy-pet-creator.tsx:808` | [ ] | [ ] | [ ] |
| P1137 | "New avatar…" / "Choose a picture…" | Opens the onboarding or a file picker | `renderer/components/buddy-pet-creator.tsx:842` | [ ] | [ ] | [ ] |
| P1138 | "What Videorc sees" fields: "Its colors are", "It's made of", "Its proportions" | Edits the AI-read description | `renderer/components/buddy-pet-creator.tsx:918` | [ ] | [ ] | [ ] |
| P1139 | "On one side only" feature rows + side select (Its left / Its right) + remove | Lists asymmetric features | `renderer/components/buddy-pet-creator.tsx:946` | [ ] | [ ] | [ ] |
| P1140 | "Add a feature" | Adds a feature row | `renderer/components/buddy-pet-creator.tsx:1011` | [ ] | [ ] | [ ] |
| P1141 | "Use another picture" | Goes back and picks a new reference | `renderer/components/buddy-pet-creator.tsx:1053` | [ ] | [ ] | [ ] |
| P1142 | "First poses" + "Draw them again ({n} left)" | Shows the pilot sheet and lets you redraw it | `renderer/components/buddy-pet-creator.tsx:1094` | [ ] | [ ] | [ ] |
| P1143 | "Poses" sheet rows + "Redo" / "Try again" | Eight pose sheets, each with a redo | `renderer/components/buddy-pet-creator.tsx:1161` | [ ] | [ ] | [ ] |
| P1144 | "Moves" progress + "Redo {sheet}" on failure | Builds the pack on this computer | `renderer/components/buddy-pet-creator.tsx:1223` | [ ] | [ ] | [ ] |
| P1145 | "Check": per-row "Looks right" / "Redo row" + "{n} of {m} rows look right" | Reviews every animation row | `renderer/components/buddy-pet-creator.tsx:1320` | [ ] | [ ] | [ ] |
| P1146 | "Name it": "Name of the moves" input + "Back to Check" | Names the pack | `renderer/components/buddy-pet-creator.tsx:1486` | [ ] | [ ] | [ ] |
| P1147 | Primary action (⌘/Ctrl+Enter): "Read the picture" / "Looks like my avatar" / "Draw the poses" / "Make the moves" / "Name it" / "Save and wear it" | Runs the current step's main action | `renderer/components/buddy-pet-creator.tsx:466` | [ ] | [ ] | [ ] |
| P1148 | "Cancel creation" + confirm "Cancel this creation?" ("Keep it") | Deletes an in-progress creation | `renderer/components/buddy-pet-creator.tsx:455` | [ ] | [ ] | [ ] |
| P1149 | Problem alerts | Show creation errors | `renderer/components/buddy-pet-creator.tsx:378` | [ ] | [ ] | [ ] |

### Avatar → Greetings (buddy-greetings-section.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P1150 | Section "Greetings" + "Greetings" switch | Turns greetings for new chatters and events on or off | `renderer/components/buddy-greetings-section.tsx:137` | [ ] | [ ] | [ ] |
| P1151 | "Write greetings with AI" row + "Sidekick → Chat" link | Points to the AI switch on the Sidekick page | `renderer/components/buddy-greetings-section.tsx:165` | [ ] | [ ] | [ ] |
| P1152 | "Welcomes" list rows + "{title} welcome on" switch | Welcome lines, each with an enable switch | `renderer/components/buddy-greetings-section.tsx:185` | [ ] | [ ] | [ ] |
| P1153 | "Activity" list rows (per kind, Default rows) + "{title} greeting on" switch | Lines for follow, sub, raid and the rest | `renderer/components/buddy-greetings-section.tsx:201` | [ ] | [ ] | [ ] |
| P1154 | "Add a greeting…" select | Adds a greeting kind | `renderer/components/buddy-greetings-section.tsx:262` | [ ] | [ ] | [ ] |
| P1155 | Editor textarea (counter, Esc closes) | Edits the greeting text | `renderer/components/buddy-greetings-section.tsx:586` | [ ] | [ ] | [ ] |
| P1156 | "Avatar state" segmented control | Sets the pose used while it speaks | `renderer/components/buddy-greetings-section.tsx:600` | [ ] | [ ] | [ ] |
| P1157 | "Platform" select (Any + platforms) | Limits a line to one chat platform | `renderer/components/buddy-greetings-section.tsx:616` | [ ] | [ ] | [ ] |
| P1158 | "Fields" popover | Inserts template fields such as the name | `renderer/components/buddy-greetings-section.tsx:630` | [ ] | [ ] | [ ] |
| P1159 | "Add variant" (⌘/Ctrl+N) | Adds an alternate line | `renderer/components/buddy-greetings-section.tsx:655` | [ ] | [ ] | [ ] |
| P1160 | "Remove greeting" (X) | Deletes the line | `renderer/components/buddy-greetings-section.tsx:669` | [ ] | [ ] | [ ] |
| P1161 | Warning notes | Show length and platform-limit warnings | `renderer/components/buddy-greetings-section.tsx:684` | [ ] | [ ] | [ ] |

### Sidekick page (⌘9): shell and Overview (tabs/buddy-tab.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P1162 | Page key ⌘9 ("Sidekick") | Opens the Sidekick page (key by digit order) | `shared/sidebar-pages.ts:144` | [ ] | [ ] | [ ] |
| P1163 | Tab strip "Overview", "Chat", "Community", "Voice", "Reports", "Clean cut" | Switches the Sidekick sections | `renderer/components/tabs/buddy-tab.tsx:131 (renderer/lib/buddy-tabs.ts:28)` | [ ] | [ ] | [ ] |
| P1164 | Status row: Sidekick mark + status line (dot, label, reason, detail) | Shows Sidekick Live's state | `renderer/components/tabs/buddy-tab.tsx:284` | [ ] | [ ] | [ ] |
| P1165 | "Sidekick Live" switch (with disabled reason) | Turns Sidekick on or off. Asks for consent if needed | `renderer/components/cohost-status.tsx:123` | [ ] | [ ] | [ ] |
| P1166 | "Open Stream Manager" + shortcut chip | Opens the comments window | `renderer/components/tabs/buddy-tab.tsx:304` | [ ] | [ ] | [ ] |
| P1167 | Lock alert (Sign in / View Premium) | Explains why Sidekick is locked and offers the fix | `renderer/components/tabs/buddy-tab.tsx:207` | [ ] | [ ] | [ ] |
| P1168 | Section "Sidekick Live" ("Alpha" badge) | Holds the listening setting | `renderer/components/tabs/buddy-tab.tsx:332` | [ ] | [ ] | [ ] |
| P1169 | "Sidekick hears you while you're live" switch + allowance line | Turns microphone listening on or off | `renderer/components/cohost-settings-section.tsx:135` | [ ] | [ ] | [ ] |
| P1170 | "What Sidekick does" rows + tab buttons (Chat / Voice) | Each power links to its settings tab | `renderer/components/tabs/buddy-tab.tsx:352` | [ ] | [ ] | [ ] |
| P1171 | Section "Cloud AI": "Allow cloud AI" switch + uses list | Grants or revokes cloud-AI consent | `renderer/components/tabs/buddy-tab.tsx:431` | [ ] | [ ] | [ ] |
| P1172 | Consent dialog "Turn on Sidekick Live?" ("Not now" / "Allow and turn on") | Asks for consent before Sidekick turns on | `renderer/components/buddy-consent-dialog.tsx:43` | [ ] | [ ] | [ ] |
| P1173 | Error toast with "Retry" | Turning on failed | `renderer/components/tabs/buddy-tab.tsx:468` | [ ] | [ ] | [ ] |

### Sidekick → Chat (cohost-settings-section.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P1174 | Lock alert above both columns | Says why it is locked and what stays free | `renderer/components/tabs/buddy-tab.tsx:235` | [ ] | [ ] | [ ] |
| P1175 | Section "Replies": "Answers" switch + cooldown slider | Auto-answers viewer questions | `renderer/components/cohost-settings-section.tsx:186` | [ ] | [ ] | [ ] |
| P1176 | "Banter" switch + cooldown slider | Quiet-time remarks | `renderer/components/cohost-settings-section.tsx:196` | [ ] | [ ] | [ ] |
| P1177 | "Write greetings with AI" switch | Sidekick rewrites greetings in the avatar's voice | `renderer/components/cohost-settings-section.tsx:209` | [ ] | [ ] | [ ] |
| P1178 | "Reply tone" segmented (Friendly / Short / Professional) | Sets the tone of drafted replies | `renderer/components/cohost-settings-section.tsx:225` | [ ] | [ ] | [ ] |
| P1179 | Section "Moderation": "Chat rules" list (edit, remove) | Edits the chat rules Sidekick enforces | `renderer/components/cohost-settings-section.tsx:351` | [ ] | [ ] | [ ] |
| P1180 | "Add a rule…" input (Enter) | Adds a chat rule | `renderer/components/cohost-settings-section.tsx:400` | [ ] | [ ] | [ ] |
| P1181 | "Flag sensitivity" (Relaxed / Balanced / Strict) | Sets the threshold for flags | `renderer/components/cohost-settings-section.tsx:426` | [ ] | [ ] | [ ] |
| P1182 | "Put comments on stream automatically" segmented | Auto-shows chat cards on stream | `renderer/components/cohost-settings-section.tsx:447` | [ ] | [ ] | [ ] |
| P1183 | Save error | Shows a failed save | `renderer/components/cohost-settings-section.tsx:239` | [ ] | [ ] | [ ] |

### Sidekick → Community (community/*.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P1184 | Premium lock alert | Says "Sidekick remembers" needs Premium | `renderer/components/community/community-tab.tsx:98` | [ ] | [ ] | [ ] |
| P1185 | "Your community" header + "Reading your past streams" progress | Summary of the community and backfill progress | `renderer/components/community/community-tab.tsx:156` | [ ] | [ ] | [ ] |
| P1186 | Remember offer alert ("Turn on" / "Not now") | Offers to turn on Sidekick remembers | `renderer/components/community/remember-offer.tsx:42` | [ ] | [ ] | [ ] |
| P1187 | "Links that need you": "Same person" / "Not the same" | Resolves suggestions to merge accounts | `renderer/components/community/community-tab.tsx:222` | [ ] | [ ] | [ ] |
| P1188 | "People": "Search people" input | Filters people | `renderer/components/community/community-tab.tsx:366` | [ ] | [ ] | [ ] |
| P1189 | "Sort people" select (Streams / Last chat / Name) | Sorts the list | `renderer/components/community/community-tab.tsx:379` | [ ] | [ ] | [ ] |
| P1190 | "Show" segmented (Regulars / Everyone / Linked / Bots) | Filters the list | `renderer/components/community/community-tab.tsx:391` | [ ] | [ ] | [ ] |
| P1191 | People list rows / empty state / loading spinner | Opens a person's card | `renderer/components/community/community-tab.tsx:402` | [ ] | [ ] | [ ] |
| P1192 | Person card dialog (name title) | Shows the person's details | `renderer/components/community/community-tab.tsx:125` | [ ] | [ ] | [ ] |
| P1193 | Card "Wave" / "Waved" | Avatar waves at this person | `renderer/components/community/person-card-body.tsx:366` | [ ] | [ ] | [ ] |
| P1194 | Card "Same person as…" picker (search, "Same person" confirm) | Links two accounts as one person | `renderer/components/community/person-card-body.tsx:389` | [ ] | [ ] | [ ] |
| P1195 | Card "More for {name}" menu: "Mark as bot" / "Not a bot", "Forget {name}…" | Bot flag and forgetting a person | `renderer/components/community/person-card-body.tsx:204` | [ ] | [ ] | [ ] |
| P1196 | Memory "Forget …" + confirm | Deletes one remembered fact | `renderer/components/community/person-card-body.tsx:300` | [ ] | [ ] | [ ] |
| P1197 | Linked account "Not the same" | Unlinks an account | `renderer/components/community/person-card-body.tsx:520` | [ ] | [ ] | [ ] |
| P1198 | Suggestion alert "Same person" / "Not the same" | Answers a link suggestion | `renderer/components/community/person-card-body.tsx:557` | [ ] | [ ] | [ ] |
| P1199 | "Your note" textarea (⌘/Ctrl+Enter) | Private note about the person | `renderer/components/community/person-card-body.tsx:602` | [ ] | [ ] | [ ] |
| P1200 | YouTube retention note | Explains YouTube data limits | `renderer/components/community/person-card-body.tsx:340` | [ ] | [ ] | [ ] |
| P1201 | "Preview": "Play a welcome" / "Play a milestone" | Local preview of the avatar's reactions | `renderer/components/community/community-preview.tsx:84` | [ ] | [ ] | [ ] |
| P1202 | Settings: "Remember my community" switch | Turns on tracking of regulars | `renderer/components/community/community-tab.tsx:590` | [ ] | [ ] | [ ] |
| P1203 | "Welcome regulars on stream" switch | Bubble welcome for regulars | `renderer/components/community/community-tab.tsx:596` | [ ] | [ ] | [ ] |
| P1204 | "Show milestone cards automatically" switch | Auto-shows milestone cards | `renderer/components/community/community-tab.tsx:608` | [ ] | [ ] | [ ] |
| P1205 | "Regular after" select | Streams needed before someone counts as a regular | `renderer/components/community/community-tab.tsx:620` | [ ] | [ ] | [ ] |
| P1206 | Retention quiet alert | Explains what is kept | `renderer/components/community/community-tab.tsx:645` | [ ] | [ ] | [ ] |
| P1207 | Premium: "Sidekick remembers" switch | Keeps facts viewers share | `renderer/components/community/community-tab.tsx:666` | [ ] | [ ] | [ ] |
| P1208 | Premium: "Community sync" switch (always disabled) | Placeholder for syncing across computers | `renderer/components/community/community-tab.tsx:680` | [ ] | [ ] | [ ] |
| P1209 | "Your data": disclosure line + "Copy" / "Copied" | Copies the viewer disclosure line | `renderer/components/community/community-tab.tsx:711` | [ ] | [ ] | [ ] |
| P1210 | "Export…" / "Import…" | Saves or loads the community file | `renderer/components/community/community-tab.tsx:724` | [ ] | [ ] | [ ] |
| P1211 | "Forget everyone…" + confirm "Forget everyone?" | Wipes all community data | `renderer/components/community/community-tab.tsx:746` | [ ] | [ ] | [ ] |

### Sidekick → Voice (buddy-voice-commands.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P1212 | Off alert "Turn on Sidekick Live to use voice commands." + "Go to Overview" | Points to the Overview switch | `renderer/components/buddy-voice-commands.tsx:120` | [ ] | [ ] | [ ] |
| P1213 | Paused lines | Say why commands are paused | `renderer/components/buddy-voice-commands.tsx:131` | [ ] | [ ] | [ ] |
| P1214 | Section "Commands": "What you can say" list | Lists the voice commands | `renderer/components/buddy-voice-commands.tsx:145` | [ ] | [ ] | [ ] |
| P1215 | "Commands need “Sidekick” first" switch | Requires the wake word | `renderer/components/buddy-voice-commands.tsx:171` | [ ] | [ ] | [ ] |
| P1216 | "Before Sidekick removes a comment" (Confirm first / 5-second countdown) | Sets the removal confirmation | `renderer/components/buddy-voice-commands.tsx:183` | [ ] | [ ] | [ ] |
| P1217 | Section "Remove messages": per-platform rows + fix button (tooltip) | Reconnects accounts so Sidekick can remove messages | `renderer/components/buddy-voice-commands.tsx:203` | [ ] | [ ] | [ ] |

### Sidekick → Reports (buddy-report-card.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P1218 | Section "Stream report" | Shows what happened on the stream | `renderer/components/buddy-report-card.tsx:106` | [ ] | [ ] | [ ] |
| P1219 | "Markers" button | Opens the session's markers dialog | `renderer/components/buddy-report-card.tsx:111` | [ ] | [ ] | [ ] |
| P1220 | "Stream" select | Switches which session's report shows | `renderer/components/buddy-report-card.tsx:211` | [ ] | [ ] | [ ] |
| P1221 | Error alert + "Try again" | Reloads the report | `renderer/components/buddy-report-card.tsx:146` | [ ] | [ ] | [ ] |
| P1222 | Loading line / empty state | Shown with no report | `renderer/components/buddy-report-card.tsx:178` | [ ] | [ ] | [ ] |
| P1223 | Off note alert | Says Sidekick was off | `renderer/components/buddy-report-card.tsx:247` | [ ] | [ ] | [ ] |
| P1224 | Chat platform chips (tooltip counts) | Messages per platform | `renderer/components/buddy-report-card.tsx:446` | [ ] | [ ] | [ ] |
| P1225 | Lists: "Said on stream", "Posted as you", "Missed questions", "Open promises", "Moments", "Alerts", "Commands", "Regulars back", "Milestones" | Report sections | `renderer/components/buddy-report-card.tsx:272` | [ ] | [ ] | [ ] |
| P1226 | Summary lock alert | Premium lock for the summary | `renderer/components/buddy-report-card.tsx:582` | [ ] | [ ] | [ ] |
| P1227 | "Show all {n}" / "Show fewer" | Expands a capped list | `renderer/components/buddy-report-card.tsx:673` | [ ] | [ ] | [ ] |

### Sidekick → Clean cut (clean-cut/*.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P1228 | Lock alert | Says why Clean cut is locked | `renderer/components/clean-cut/clean-cut-card.tsx:278` | [ ] | [ ] | [ ] |
| P1229 | Section "Clean cut": "Make a clean cut of every recording" switch | Auto-cuts every recording | `renderer/components/clean-cut/clean-cut-card.tsx:299` | [ ] | [ ] | [ ] |
| P1230 | Section "Recordings": "Search recordings…" | Filters recordings | `renderer/components/clean-cut/clean-cut-card.tsx:477` | [ ] | [ ] | [ ] |
| P1231 | Recording rows / "No recordings match" / "Show all (n)" / "Show fewer" | Picks a recording | `renderer/components/clean-cut/clean-cut-card.tsx:487` | [ ] | [ ] | [ ] |
| P1232 | "Kind of cut" (Clean / Condensed) | Chooses the cut type | `renderer/components/clean-cut/clean-cut-card.tsx:333` | [ ] | [ ] | [ ] |
| P1233 | "Condensed length" segmented + "Make again" | Sets the condensed target length | `renderer/components/clean-cut/clean-cut-card.tsx:342` | [ ] | [ ] | [ ] |
| P1234 | "Make a clean cut" / "Make a condensed cut" | Starts the cut job | `renderer/components/clean-cut/clean-cut-card.tsx:600` | [ ] | [ ] | [ ] |
| P1235 | "Review" / "Cancel" (while busy) | Opens the review or cancels the job | `renderer/components/clean-cut/clean-cut-card.tsx:610` | [ ] | [ ] | [ ] |
| P1236 | "Show in Finder" / "Show in Explorer" | Reveals the output file *(Label varies: "Show in Finder" on macOS, "Show in Explorer" on Windows, other text on Linux (lib/platform.ts:114))* | `renderer/components/clean-cut/clean-cut-card.tsx:630 (label renderer/lib/platform.ts:114)` | [ ] | [ ] | [ ] |
| P1237 | "Open in Library" | Opens the output session in Library | `renderer/components/clean-cut/clean-cut-card.tsx:638` | [ ] | [ ] | [ ] |
| P1238 | "Allow cloud AI…" | Opens the consent dialog | `renderer/components/clean-cut/clean-cut-card.tsx:685` | [ ] | [ ] | [ ] |
| P1239 | Failed status alert + toasts with "Retry" | Retries a failed cut | `renderer/components/clean-cut/clean-cut-card.tsx:374` | [ ] | [ ] | [ ] |
| P1240 | Consent dialog "Make a clean cut?" / "Turn on Clean cut?" | Asks for cloud-AI consent ("Allow and make it" / "Allow and turn on") | `renderer/components/clean-cut/clean-cut-consent-dialog.tsx:48` | [ ] | [ ] | [ ] |
| P1241 | Review: back button | Leaves the review | `renderer/components/clean-cut/clean-cut-review.tsx:705` | [ ] | [ ] | [ ] |
| P1242 | Review "Kind of cut" segmented | Switches between the clean and condensed drafts | `renderer/components/clean-cut/clean-cut-review.tsx:731` | [ ] | [ ] | [ ] |
| P1243 | "What plays" (Preview the cut / Original) | Chooses the playback source | `renderer/components/clean-cut/clean-cut-review.tsx:766` | [ ] | [ ] | [ ] |
| P1244 | "Cut selection" (Backspace/Delete) | Removes the selected words | `renderer/components/clean-cut/clean-cut-review.tsx:789` | [ ] | [ ] | [ ] |
| P1245 | "Undo" (⌘/Ctrl+Z) / "Redo" (⌘/Ctrl+Shift+Z) | Undoes or redoes draft edits | `renderer/components/clean-cut/clean-cut-review.tsx:809` | [ ] | [ ] | [ ] |
| P1246 | "Follow playback" switch | Transcript scrolls with playback | `renderer/components/clean-cut/clean-cut-review.tsx:841` | [ ] | [ ] | [ ] |
| P1247 | Keys: Space play, ←/→ seek ±5s, ↑/↓ step removals, Enter toggle | Review keyboard control | `renderer/components/clean-cut/clean-cut-review.tsx:664` | [ ] | [ ] | [ ] |
| P1248 | "Kinds of cuts" toggle chips | Turns categories of removals on or off | `renderer/components/clean-cut/clean-cut-review.tsx:1087` | [ ] | [ ] | [ ] |
| P1249 | Timeline pins (tooltip, click seeks) | Jumps to a removal | `renderer/components/clean-cut/clean-cut-review.tsx:1172` | [ ] | [ ] | [ ] |
| P1250 | Transcript words / removal blocks with keep/cut button | Toggles individual removals | `renderer/components/clean-cut/clean-cut-transcript.tsx:513` | [ ] | [ ] | [ ] |
| P1251 | Transcript-unreadable alert + "Try again" / empty "No speech found" | Fallback states | `renderer/components/clean-cut/clean-cut-review.tsx:861` | [ ] | [ ] | [ ] |
| P1252 | Footer "Retry", "Open in Library", "Discard" | Footer actions for the job and draft | `renderer/components/clean-cut/clean-cut-review.tsx:939` | [ ] | [ ] | [ ] |
| P1253 | "Save changes" (⌘/Ctrl+S) | Saves the edited cut | `renderer/components/clean-cut/clean-cut-review.tsx:978` | [ ] | [ ] | [ ] |
| P1254 | Confirm "Leave without saving?" ("Keep editing" / "Discard changes") | Guards against leaving unsaved edits | `renderer/components/clean-cut/clean-cut-review.tsx:990` | [ ] | [ ] | [ ] |
| P1255 | "Couldn't open the cut" + "Try again" / waiting empty state + "Open Clean cut" | Error and waiting states | `renderer/components/clean-cut/clean-cut-review.tsx:1034` | [ ] | [ ] | [ ] |

### Co-host pane (Stream Manager; cohost-pane.tsx, cohost-*.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P1256 | Upsell alert + "View Premium" | Shown when Sidekick is locked | `renderer/components/cohost-pane.tsx:256` | [ ] | [ ] | [ ] |
| P1257 | "Sidekick needs cloud AI" + "Allow cloud AI…" | Consent prompt | `renderer/components/cohost-pane.tsx:284` | [ ] | [ ] | [ ] |
| P1258 | Nudge "Sidekick is off…" + "Turn on" / dismiss | Offers to turn Sidekick on | `renderer/components/cohost-nudge.tsx:28` | [ ] | [ ] | [ ] |
| P1259 | Status pill (tooltip, unread badge) | Sidekick state and new-question count | `renderer/components/cohost-status.tsx:48` | [ ] | [ ] | [ ] |
| P1260 | Trend alerts (warning) | Shows repeated chat themes | `renderer/components/cohost-pane.tsx:398` | [ ] | [ ] | [ ] |
| P1261 | "Sidekick questions and flags" list (↑/↓ select) | Questions and flags queue | `renderer/components/cohost-pane.tsx:436` | [ ] | [ ] | [ ] |
| P1262 | Question badges "On topic" / "Answered from About you" / "Talking about this" | Context on each question | `renderer/components/cohost-question-row.tsx:84` | [ ] | [ ] | [ ] |
| P1263 | "Reply" (R) | Drafts a reply | `renderer/components/cohost-pane.tsx:557` | [ ] | [ ] | [ ] |
| P1264 | "Show on stream" (H) | Puts the question on stream | `renderer/components/cohost-pane.tsx:567` | [ ] | [ ] | [ ] |
| P1265 | "Answered" (A) | Marks the question answered | `renderer/components/cohost-pane.tsx:577` | [ ] | [ ] | [ ] |
| P1266 | "Dismiss" (Backspace) | Dismisses a question or flag | `renderer/components/cohost-pane.tsx:586` | [ ] | [ ] | [ ] |
| P1267 | "Jump to message" (Enter) | Scrolls chat to the flagged message | `renderer/components/cohost-pane.tsx:598` | [ ] | [ ] | [ ] |
| P1268 | Remove from chat (Shift+Backspace) | Deletes the flagged message on the platform | `renderer/components/cohost-pane.tsx:614` | [ ] | [ ] | [ ] |
| P1269 | "Draft a recap" | Writes a recap for new viewers | `renderer/components/cohost-pane.tsx:520` | [ ] | [ ] | [ ] |
| P1270 | Recap card "Edit in chat box" / "Dismiss" | Uses or dismisses the recap | `renderer/components/cohost-pane.tsx:1229` | [ ] | [ ] | [ ] |
| P1271 | Answered-on-air "Restore" / "{n} more answered on air" | Restores answered items | `renderer/components/cohost-pane.tsx:974` | [ ] | [ ] | [ ] |
| P1272 | Promises "Done" / "Dismiss" | Clears open promises | `renderer/components/cohost-pane.tsx:1056` | [ ] | [ ] | [ ] |
| P1273 | "Say hi" list "Greeted" | Marks first-timers as greeted | `renderer/components/cohost-pane.tsx:1128` | [ ] | [ ] | [ ] |
| P1274 | "Welcome back" list actions | Returning viewers | `renderer/components/cohost-pane.tsx:1193` | [ ] | [ ] | [ ] |
| P1275 | Avatar identity (preview + bubble) | Shows the avatar and its current line | `renderer/components/cohost-pane.tsx:640` | [ ] | [ ] | [ ] |
| P1276 | Off-outputs alert + actions (show on stream / use Suggest) | Explains that the avatar is not visible | `renderer/components/cohost-pane.tsx:761` | [ ] | [ ] | [ ] |
| P1277 | "Say something on stream" input (Enter talk, ⌘/Ctrl+Enter laugh) | Avatar speaks typed text in its bubble | `renderer/components/cohost-pane.tsx:809` | [ ] | [ ] | [ ] |
| P1278 | "React on stream" chips (disabled reasons) | Triggers avatar reactions | `renderer/components/cohost-pane.tsx:831` | [ ] | [ ] | [ ] |
| P1279 | "{name} on stream" switch | Shows or hides the avatar overlay | `renderer/components/cohost-pane.tsx:879` | [ ] | [ ] | [ ] |
| P1280 | Listen prompt "Sidekick can hear you while you're live" ("Turn on" / "Not now") | Offers microphone listening | `renderer/components/cohost-pane.tsx:920` | [ ] | [ ] | [ ] |

### Images page (⇧⌘G; tabs/assets-tab.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P1281 | Page key ⇧⌘G ("Images") | Opens Images | `shared/sidebar-pages.ts:105` | [x] | [ ] | [ ] |
| P1282 | Header "Images" | Page header | `renderer/components/tabs/assets-tab.tsx:207` | [x] | [ ] | [ ] |
| P1283 | Section "Backgrounds" + "Import image…" | Imports a background image | `renderer/components/tabs/assets-tab.tsx:212` | [x] | [ ] | [ ] |
| P1284 | Current-scene background row: style control + "Use no background" | Tunes or removes the current background | `renderer/components/tabs/assets-tab.tsx:222` | [x] | [ ] | [ ] |
| P1285 | Live backgrounds tiles (click applies or removes) | Animated backgrounds | `renderer/components/live-backgrounds-group.tsx:122` | [x] | [ ] | [ ] |
| P1286 | Live "Adjust style": "Look" select, "Motion" segmented, sliders | Tunes a live background | `renderer/components/live-backgrounds-group.tsx:208` | [x] | [ ] | [ ] |
| P1287 | Image tiles (click applies, removes or imports; double-click renames) | Toggles a background on the scene | `renderer/components/tabs/assets-tab.tsx:400` | [x] | [ ] | [ ] |
| P1288 | Status badges (Empty / Ready / In use / File missing / Unsupported) | Tile status | `renderer/components/tabs/assets-tab.tsx:77` | [x] | [ ] | [ ] |
| P1289 | Empty slot "Add image…" / "Restore default" | Fills or restores a slot | `renderer/components/tabs/assets-tab.tsx:442` | [x] | [ ] | [ ] |
| P1290 | Inline rename input (Enter / Esc) | Renames a background | `renderer/components/tabs/assets-tab.tsx:455` | [x] | [ ] | [ ] |
| P1291 | "Actions for {name}" menu: "Rename…", "Replace image…", Show in Finder/Explorer, "Reset style to defaults", "Remove" | Tile actions *(Reveal label varies by OS (lib/platform.ts:114))* | `renderer/components/tabs/assets-tab.tsx:485` | [x] | [ ] | [ ] |
| P1292 | "Adjust style" popover: "Fit" (Fill / Fit / Stretch) + Visibility, Scale, Pan X, Pan Y, Blur, Dim, Saturation | Tunes image placement and look | `renderer/components/tabs/assets-tab.tsx:551` | [x] | [ ] | [ ] |
| P1293 | Confirm "Remove applied background?" / "Remove {name}?" | Confirms removing a background | `renderer/components/tabs/assets-tab.tsx:310` | [x] | [ ] | [ ] |
| P1294 | Dialog "Replace which background?" + "Replace {slot}" | Chooses the slot when all slots are full | `renderer/components/background-replace-dialog.tsx:107` | [x] | [ ] | [ ] |
| P1295 | Section "Banners": "Import image…" / "Import HTML…" | Imports a banner | `renderer/components/banners-section.tsx:106` | [x] | [ ] | [ ] |
| P1296 | Banner tiles (drag to reorder, "Showing" chip, timing chip) | Banner gallery | `renderer/components/banners-section.tsx:150` | [x] | [ ] | [ ] |
| P1297 | Banner menu: "Show"/"Hide", "Place on Scene", "Rename…", "Move earlier" (Alt+←), "Move later" (Alt+→), "Delete…" | Banner actions | `renderer/components/banners-section.tsx:305` | [x] | [ ] | [ ] |
| P1298 | Banner rename input (Enter / Esc) | Renames a banner | `renderer/components/banners-section.tsx:382` | [x] | [ ] | [ ] |
| P1299 | Banner empty "No banners yet" / "Loading banners…" / offline alert | Empty and offline states | `renderer/components/banners-section.tsx:204` | [x] | [ ] | [ ] |
| P1300 | Confirm "Delete banner?" | Deletes a banner | `renderer/components/banners-section.tsx:215` | [x] | [ ] | [ ] |
| P1301 | Section "Takeovers" + "Import images…" (also drag-drop files) | Imports full-frame takeover images | `renderer/components/takeover-screens-section.tsx:112` | [x] | [ ] | [ ] |
| P1302 | Quiet alert (editing blocked while recording or live) | Explains the lock | `renderer/components/takeover-screens-section.tsx:152` | [x] | [ ] | [ ] |
| P1303 | Takeover tile: "Takeover name" input + "Save takeover name" | Renames a takeover | `renderer/components/takeover-screens-section.tsx:426` | [x] | [ ] | [ ] |
| P1304 | "Move earlier" / "Move later" (Alt+←/→, drag) | Reorders takeovers | `renderer/components/takeover-screens-section.tsx:452` | [x] | [ ] | [ ] |
| P1305 | "Delete takeover" + confirm "Delete {name}?" | Deletes a takeover | `renderer/components/takeover-screens-section.tsx:490` | [x] | [ ] | [ ] |
| P1306 | Takeover empty "No takeovers yet" / "Loading takeovers…" | Empty states | `renderer/components/takeover-screens-section.tsx:210` | [x] | [ ] | [ ] |

### Sounds page (⇧⌘S; tabs/sounds-tab.tsx, sounds-section.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P1307 | Page key ⇧⌘S + header "Sounds" | Opens the Sounds page | `renderer/components/tabs/sounds-tab.tsx:15` | [x] | [ ] | [ ] |
| P1308 | "Import sounds…" / "Choosing sounds…" | Imports audio files | `renderer/components/sounds-section.tsx:90` | [x] | [ ] | [ ] |
| P1309 | Offline alert | Backend offline | `renderer/components/sounds-section.tsx:115` | [x] | [ ] | [ ] |
| P1310 | Row "Play/Stop {name}" | Previews the sound | `renderer/components/sounds-section.tsx:242` | [x] | [ ] | [ ] |
| P1311 | "How {name} plays" select (Play once / Play/stop / Loop / While held) | Sets the pad's play mode | `renderer/components/sounds-section.tsx:262` | [x] | [ ] | [ ] |
| P1312 | "{name} volume" fader | Sets this sound's volume | `renderer/components/sounds-section.tsx:277` | [x] | [ ] | [ ] |
| P1313 | "{name} key" select (None, 1–9) | Assigns a pad hotkey | `renderer/components/sounds-section.tsx:314` | [x] | [ ] | [ ] |
| P1314 | "Actions for {name}": "Rename…", "Move up", "Move down", "Remove" | Row actions | `renderer/components/sounds-section.tsx:213` | [x] | [ ] | [ ] |
| P1315 | Dialog "Rename sound" ("Name", "Cancel" / "Save") | Renames a sound | `renderer/components/sounds-section.tsx:352` | [x] | [ ] | [ ] |
| P1316 | Empty "No sounds yet" + import | Shown with no sounds | `renderer/components/sounds-section.tsx:142` | [x] | [ ] | [ ] |
| P1317 | "Restore starter sounds" | Re-adds the bundled sounds | `renderer/components/sounds-section.tsx:149` | [x] | [ ] | [ ] |
| P1318 | Loading / "Couldn't load sounds" + "Retry" | Load states | `renderer/components/sounds-load-state.tsx:72` | [x] | [ ] | [ ] |

### Library page (⌘0): Local (tabs/library-tab.tsx, session-poster.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P1319 | Page key ⌘0 | Opens Library | `shared/sidebar-pages.ts:107` | [x] | [ ] | [ ] |
| P1320 | Tabs "Local" / "Cloud" | Switches between local and cloud recordings | `renderer/components/tabs/library-tab.tsx:167` | [x] | [ ] | [ ] |
| P1321 | Header "Library" | Page header | `renderer/components/tabs/library-tab.tsx:523` | [x] | [ ] | [ ] |
| P1322 | "Filter" select (All recordings / Recorded / Livestreamed) | Filters rows | `renderer/components/tabs/library-tab.tsx:537` | [x] | [ ] | [ ] |
| P1323 | "Sort" select (Newest first / Oldest first) | Sorts rows | `renderer/components/tabs/library-tab.tsx:557` | [x] | [ ] | [ ] |
| P1324 | "Search recordings…" | Text filter | `renderer/components/tabs/library-tab.tsx:572` | [x] | [ ] | [ ] |
| P1325 | "Import…" | Imports a video file | `renderer/components/tabs/library-tab.tsx:580` | [x] | [ ] | [ ] |
| P1326 | "Open Studio" | Goes to Studio | `renderer/components/tabs/library-tab.tsx:584` | [x] | [ ] | [ ] |
| P1327 | Selection bar "Delete" / "Clear selection" | Bulk delete | `renderer/components/tabs/library-tab.tsx:594` | [x] | [ ] | [ ] |
| P1328 | Partial notice + "Load all" | Loads every session | `renderer/components/tabs/library-tab.tsx:618` | [x] | [ ] | [ ] |
| P1329 | Empty "No recordings yet" / "No recordings match" + clear button / loading | Empty states | `renderer/components/tabs/library-tab.tsx:635` | [x] | [ ] | [ ] |
| P1330 | Grid header "Select all recordings in view" checkbox + Name/Scene/Duration/Size/File/Actions | Table header | `renderer/components/tabs/library-tab.tsx:676` | [x] | [ ] | [ ] |
| P1331 | Row checkbox "Select {title}" | Selects one row | `renderer/components/tabs/library-tab.tsx:1011` | [x] | [ ] | [ ] |
| P1332 | Row poster | Thumbnail, backfilled lazily | `renderer/components/session-poster.tsx:18` | [x] | [ ] | [ ] |
| P1333 | Row badges: clean-cut chip, quality warning, role, "Noise cleaned", status | Row status info with tooltips | `renderer/components/tabs/library-tab.tsx:1030` | [x] | [ ] | [ ] |
| P1334 | Row click / ⌘- or Shift-click / double-click plays | Selects rows; double-click opens the file externally | `renderer/components/tabs/library-tab.tsx:999` | [x] | [ ] | [ ] |
| P1335 | Keys ↑/↓/Home/End (+Shift), Space, Esc, Enter rename, ⌘/Ctrl+Backspace or Delete delete, ⌘/Ctrl+A select all | Grid keyboard control | `renderer/lib/library-view.ts:299` | [x] | [ ] | [ ] |
| P1336 | "Play recording" (tooltip "Play in the default player") | Opens the file in the OS player | `renderer/components/tabs/library-tab.tsx:1180` | [x] | [ ] | [ ] |
| P1337 | Footer "{n} recordings loaded"/storage + "Load more" | Pagination | `renderer/components/tabs/library-tab.tsx:761` | [x] | [ ] | [ ] |
| P1338 | "Session actions" menu (also right-click context menu) | Row actions | `renderer/components/tabs/library-tab.tsx:1215` | [x] | [ ] | [ ] |
| P1339 | Menu "Play" | Plays the recording | `renderer/components/tabs/library-tab.tsx:1466` | [x] | [ ] | [ ] |
| P1340 | Menu "Sidekick report" | Opens Sidekick → Reports | `renderer/components/tabs/library-tab.tsx:1477` | [x] | [ ] | [ ] |
| P1341 | Menu "Make a clean cut…" / "Review clean cut" | Opens Clean cut | `renderer/components/tabs/library-tab.tsx:1491` | [x] | [ ] | [ ] |
| P1342 | Menu "Markers" | Opens the markers dialog | `renderer/components/tabs/library-tab.tsx:1514` | [x] | [ ] | [ ] |
| P1343 | Menu "Show in Finder"/"Show in Explorer" (or "Show original · MP4 is saving") | Reveals the file *(Label varies by OS (lib/platform.ts:114))* | `renderer/components/tabs/library-tab.tsx:1520` | [x] | [ ] | [ ] |
| P1344 | Menu noise cleanup | Cleans the audio | `renderer/components/tabs/library-tab.tsx:1530` | [x] | [ ] | [ ] |
| P1345 | Menu "Export MP4" / "Retry MP4 export" | Finalizes the MP4 | `renderer/components/tabs/library-tab.tsx:1540` | [x] | [ ] | [ ] |
| P1346 | Menu "Open in Stream Manager" | Opens the session's chat window | `renderer/components/tabs/library-tab.tsx:1556` | [x] | [ ] | [ ] |
| P1347 | Menu "Rename…" (Enter) + dialog "Rename recording" ("Cancel" / "Rename") | Renames a session | `renderer/components/tabs/library-tab.tsx:1564` | [x] | [ ] | [ ] |
| P1348 | Menu "Duplicate" | Copies the recording | `renderer/components/tabs/library-tab.tsx:1575` | [x] | [ ] | [ ] |
| P1349 | Menu "Check quality" / "Repair & fix" / "Restore original" | Quality check and repair | `renderer/components/tabs/library-tab.tsx:1585` | [x] | [ ] | [ ] |
| P1350 | Menu "Delete" (⌘/Ctrl+Backspace) | Asks before deleting | `renderer/components/tabs/library-tab.tsx:1617` | [x] | [ ] | [ ] |
| P1351 | Confirm "Move this recording to the Trash/Recycle Bin?" | Moves the file to the OS trash *(Windows says "Recycle Bin", others "Trash" (lib/platform.ts:129))* | `renderer/components/tabs/library-tab.tsx:845` | [x] | [ ] | [ ] |

### Library: player, markers and cloud markers (media/*, session-markers-dialog.tsx, cloud-markers-dialog.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P1352 | Dialog "Markers · {title}" | Lists markers with a player | `renderer/components/session-markers-dialog.tsx:255` | [ ] | [ ] | [ ] |
| P1353 | "Recording player" video | In-app playback | `renderer/components/media/session-player.tsx:379` | [ ] | [ ] | [ ] |
| P1354 | "Play" / "Pause" (Space) | Toggles playback | `renderer/components/media/session-player.tsx:562` | [ ] | [ ] | [ ] |
| P1355 | "Playhead" slider | Seeks | `renderer/components/media/session-player.tsx:583` | [ ] | [ ] | [ ] |
| P1356 | "Mute" / "Unmute" (M) | Toggles audio | `renderer/components/media/session-player.tsx:609` | [ ] | [ ] | [ ] |
| P1357 | Keys ←/→ seek, Home/End | Player keyboard control | `renderer/lib/session-player-view.ts:97` | [ ] | [ ] | [ ] |
| P1358 | Player error: "Try again", "Open in default player", Show in Finder/Explorer | Recovery when the video won't play *(Reveal label varies by OS)* | `renderer/components/media/session-player.tsx:507` | [ ] | [ ] | [ ] |
| P1359 | "Marker timeline" pins (tooltip) and cluster dropdown | Jumps to a marker | `renderer/components/media/marker-pins.tsx:63` | [ ] | [ ] | [ ] |
| P1360 | "Saved markers" list: rename (inline input, Enter) / delete (toast "Undo") | Edits markers | `renderer/components/session-markers-dialog.tsx:302` | [ ] | [ ] | [ ] |
| P1361 | Markers error + retry / "No markers yet" / "Load more markers" | List states | `renderer/components/session-markers-dialog.tsx:291` | [ ] | [ ] | [ ] |
| P1362 | "Show markers" button + dialog | Cloud show markers | `renderer/components/cloud-markers-dialog.tsx:28` | [ ] | [ ] | [ ] |
| P1363 | Cloud marker "Save clip" / "Remove" / refresh | Saves clips from server markers | `renderer/components/cloud-markers-dialog.tsx:139` | [ ] | [ ] | [ ] |

### Library → Cloud (library-cloud-recordings.tsx, library-cloud-iso.tsx, library-cloud-archive.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P1364 | Header "Cloud recordings" + "Refresh" + "Show markers" | Lists cloud recordings | `renderer/components/tabs/library-cloud-recordings.tsx:247` | [ ] | [ ] | [ ] |
| P1365 | Sign-in lock "Sign in to see your cloud recordings." | Signed-out state | `renderer/components/tabs/library-cloud-recordings.tsx:278` | [ ] | [ ] | [ ] |
| P1366 | Error + "Try again" / loading / "No cloud recordings yet" | List states | `renderer/components/tabs/library-cloud-recordings.tsx:285` | [ ] | [ ] | [ ] |
| P1367 | "Cloud recordings" grid (↑/↓/Home/End) | Rows with deletion date | `renderer/components/tabs/library-cloud-recordings.tsx:317` | [ ] | [ ] | [ ] |
| P1368 | Row primary button (Download / Open in Library / reveal / Try again / Cancel download) | Context action, with tooltip | `renderer/components/tabs/library-cloud-recordings.tsx:628` | [ ] | [ ] | [ ] |
| P1369 | "Cloud recording actions" menu: "Open in Library", reveal, "Open on videorc.com", "Download to Library"/"Try the download again", "Cancel download", "Show markers" | Row actions *(Reveal label varies by OS)* | `renderer/components/tabs/library-cloud-recordings.tsx:515` | [ ] | [ ] | [ ] |
| P1370 | Footer count and size | Totals | `renderer/components/tabs/library-cloud-recordings.tsx:374` | [ ] | [ ] | [ ] |
| P1371 | ISO "Separate files": "Import separate files"/"Import again", "Cancel" | Imports per-guest ISO files | `renderer/components/tabs/library-cloud-iso.tsx:280` | [ ] | [ ] | [ ] |
| P1372 | ISO file rows + "Open in Library" / status dot | Per-file state | `renderer/components/tabs/library-cloud-iso.tsx:360` | [ ] | [ ] | [ ] |
| P1373 | "Local program archive": "Horizontal"/"Vertical" + "Enable local archive" | Opt-in local archive of the cloud program | `renderer/components/tabs/library-cloud-archive.tsx:102` | [ ] | [ ] | [ ] |
| P1374 | "Stop archive", "Cancel archive", "Resume archive", "Discard staging files" | Archive lifecycle | `renderer/components/tabs/library-cloud-archive.tsx:142` | [ ] | [ ] | [ ] |

### Cloud clips (tabs/cloud-clips-section.tsx; rendered on the Output page, not Library)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P1375 | Section "Clips": "Horizontal"/"Vertical" | Clip orientation | `renderer/components/tabs/cloud-clips-section.tsx:61 (used recording-tab.tsx:106)` | [ ] | [ ] | [ ] |
| P1376 | "Enable cloud Clips" / "Disable Clips" | Turns the cloud clip buffer on or off | `renderer/components/tabs/cloud-clips-section.tsx:84` | [ ] | [ ] | [ ] |
| P1377 | Clip status alert "Cancel clip" / "Retry clip" | Clip job control | `renderer/components/tabs/cloud-clips-section.tsx:134` | [ ] | [ ] | [ ] |

### Settings (⌘,): shell and General (tabs/settings-tab.tsx, settings/general-settings.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P1378 | Page key ⌘, | Opens Settings | `shared/sidebar-pages.ts:108` | [ ] | [ ] | [ ] |
| P1379 | Tabs "General", "Permissions", "Shortcuts", "Remote", "About" | Settings sections. Refreshes on window focus | `renderer/components/tabs/settings-tab.tsx:43` | [ ] | [ ] | [ ] |
| P1380 | "Appearance" → "Theme" (Light / Dark / System) | Sets the color theme *(all ("Mac"/"PC" wording via platformCopy))* | `renderer/components/settings/general-settings.tsx:77` | [ ] | [ ] | [ ] |
| P1381 | "Retro LCD" switch | LCD-style Studio controls | `renderer/components/settings/general-settings.tsx:87` | [ ] | [ ] | [ ] |
| P1382 | "Animate scene changes" → Scene | Link to the Scene page | `renderer/components/settings/general-settings.tsx:102` | [ ] | [ ] | [ ] |
| P1383 | "Graphics acceleration" status + "Retry on next launch" | GPU fallback status and retry *(Windows only (general-settings.tsx:107))* | `renderer/components/settings/general-settings.tsx:107` | n/a | [ ] | n/a |
| P1384 | "Chat" → "Show 7TV emotes in chat" switch | Shows 7TV emotes | `renderer/components/settings/seventv-emotes-field.tsx:97` | [ ] | [ ] | [ ] |
| P1385 | "GIFs in Twitch chat" (Animated / Still / Off) | How Twitch GIFs render | `renderer/components/settings/seventv-emotes-field.tsx:133` | [ ] | [ ] | [ ] |
| P1386 | Emote error alert | Emote setting failure | `renderer/components/settings/seventv-emotes-field.tsx:57` | [ ] | [ ] | [ ] |
| P1387 | "Chat in Studio" switch | Shows chat in Studio while live | `renderer/components/settings/general-settings.tsx:146` | [ ] | [ ] | [ ] |
| P1388 | "Open Stream Manager when you go live" switch | Auto-opens the comments window | `renderer/components/settings/general-settings.tsx:159` | [ ] | [ ] | [ ] |
| P1389 | "Notifications" → "Quiet while recording or live" switch | Holds notifications back while on air | `renderer/components/settings/general-settings.tsx:181` | [ ] | [ ] | [ ] |
| P1390 | "Setup" → "Run setup again…" | Reopens first-run setup | `renderer/components/settings/general-settings.tsx:239` | [ ] | [ ] | [ ] |
| P1391 | "Import" → "Import from OBS…" | Opens the OBS import dialog | `renderer/components/settings/general-settings.tsx:208` | [ ] | [ ] | [ ] |
| P1392 | OBS dialog "Import from OBS": "Scene collection" and "Profile" selects | Chooses the OBS source | `renderer/components/obs-import-dialog.tsx:270` | [ ] | [ ] | [ ] |
| P1393 | OBS errors + "Try again" / not-found / looking states | Discovery states | `renderer/components/obs-import-dialog.tsx:253` | [ ] | [ ] | [ ] |
| P1394 | OBS "Cancel" / "Import setup" | Applies the import | `renderer/components/obs-import-dialog.tsx:384` | [ ] | [ ] | [ ] |
| P1395 | "Privacy" → "Share anonymous usage stats" switch | Opts in or out of usage pings | `renderer/components/settings/usage-stats-field.tsx:57` | [ ] | [ ] | [ ] |
| P1396 | Usage stats error alert | Save failure | `renderer/components/settings/usage-stats-field.tsx:41` | [ ] | [ ] | [ ] |
| P1397 | "Elsewhere" rows (Account and Premium, Sidekick…, Your avatar…, Recording quality…, Destinations…, Checks…) | Links to settings on other pages | `renderer/components/settings/general-settings.tsx:261` | [ ] | [ ] | [ ] |

### Settings → Permissions (settings/permissions-settings.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P1398 | "System access" + "Refresh" | Re-checks permissions | `renderer/components/settings/permissions-settings.tsx:32` | [ ] | [ ] | [ ] |
| P1399 | Access rows (Screen Recording, System audio, Microphone, Camera) + status + action button | Grant or fix each permission *(macOS and Windows; row set differs on Windows (lib/system-access.ts:266))* | `renderer/components/system-access-list.tsx:62` | [ ] | [ ] | n/a |
| P1400 | "Change a permission" + "Open System Settings…"/"Open Windows Settings…" | Opens the OS privacy settings *(macOS and Windows (lib/platform.ts:36))* | `renderer/components/settings/permissions-settings.tsx:51` | [ ] | [ ] | n/a |
| P1401 | Empty "Nothing to grant here" | No permissions to list *(Linux only (lib/system-access.ts:254))* | `renderer/components/settings/permissions-settings.tsx:68` | n/a | n/a | [ ] |

### Settings → Shortcuts (settings/shortcuts-settings.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P1402 | "Global shortcuts" recorder fields (Hide screen, Record, Go live, Mute/unmute mic, System audio, 30s/1-min clip, Next/Previous scene) | Records system-wide hotkeys | `renderer/components/settings/shortcuts-settings.tsx:118` | [ ] | [ ] | [ ] |
| P1403 | "Scenes" recorder fields per scene | Hotkey per scene | `renderer/components/settings/shortcuts-settings.tsx:136` | [ ] | [ ] | [ ] |
| P1404 | Hint: Esc cancels, Backspace clears | Recorder keys | `renderer/components/settings/shortcuts-settings.tsx:156` | [ ] | [ ] | [ ] |
| P1405 | Unavailable warning alert | Global shortcuts don't work under Wayland *(Linux Wayland only (apps/desktop/src/main/global-shortcut-lifecycle.ts:33))* | `renderer/components/settings/shortcuts-settings.tsx:113` | n/a | n/a | [ ] |
| P1406 | "App shortcuts" grouped lists (read-only key chips) | Reference list of in-app keys | `renderer/components/settings/shortcuts-settings.tsx:161` | [ ] | [ ] | [ ] |

### Settings → Remote (settings/remote-settings.tsx, phone-remote-section.tsx, settings/agents-section.tsx, settings/connect-agent-dialog.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P1407 | "Remote control" switch "Enable remote control" | Turns the Stream Deck/remote API on or off | `renderer/components/settings/remote-settings.tsx:96` | [ ] | [ ] | [ ] |
| P1408 | "Pairing token" read-only + "Copy" | Copies the token | `renderer/components/settings/remote-settings.tsx:116` | [ ] | [ ] | [ ] |
| P1409 | "New token" → "Regenerate" + confirm "Regenerate the pairing token?" | Rotates the token | `renderer/components/settings/remote-settings.tsx:147` | [ ] | [ ] | [ ] |
| P1410 | Confirm "Turn off remote control?" | Shown when phones are paired | `renderer/components/settings/remote-settings.tsx:185` | [ ] | [ ] | [ ] |
| P1411 | "Phone remote" switch "Enable phone remote" | Turns phone remote on or off | `renderer/components/phone-remote-section.tsx:298` | [ ] | [ ] | [ ] |
| P1412 | Blocked warning alert | Why the phone remote can't run | `renderer/components/phone-remote-section.tsx:311` | [ ] | [ ] | [ ] |
| P1413 | "Phones" → "Pair a phone…" | Opens the QR pairing dialog | `renderer/components/phone-remote-section.tsx:323` | [ ] | [ ] | [ ] |
| P1414 | Dialog "Pair a phone": hidden QR (click to reveal), countdown, "New code" | QR pairing | `renderer/components/phone-remote-section.tsx:106` | [ ] | [ ] | [ ] |
| P1415 | "Network" segmented (multi-NIC) | Picks the LAN address | `renderer/components/phone-remote-section.tsx:149` | [ ] | [ ] | [ ] |
| P1416 | "Copy link instead" / troubleshooting text | Alternative to the QR code | `renderer/components/phone-remote-section.tsx:164` | [ ] | [ ] | [ ] |
| P1417 | "Paired phones" list + menu "Rename…" / "Remove…" | Manages phones | `renderer/components/phone-remote-section.tsx:335` | [ ] | [ ] | [ ] |
| P1418 | Dialog "Rename phone" / confirm "Remove {phone}?" | Phone edits | `renderer/components/phone-remote-section.tsx:216` | [ ] | [ ] | [ ] |
| P1419 | "Agents" switch "Let AI agents control Videorc" | Turns the MCP agent bridge on or off | `renderer/components/settings/agents-section.tsx:118` | [ ] | [ ] | [ ] |
| P1420 | Bind error / "bridge missing" alerts | Agent errors | `renderer/components/settings/agents-section.tsx:137` | [ ] | [ ] | [ ] |
| P1421 | "Agent apps" → "Connect an agent…" | Opens the connect dialog | `renderer/components/settings/agents-section.tsx:152` | [ ] | [ ] | [ ] |
| P1422 | "Your agents" list + "Remove…" + confirm "Remove {agent}?" | Revokes an agent | `renderer/components/settings/agents-section.tsx:174` | [ ] | [ ] | [ ] |
| P1423 | Activity: "Activity from" select (All agents / per agent) + list / "No actions yet." | Agent action log | `renderer/components/settings/agents-section.tsx:287` | [ ] | [ ] | [ ] |
| P1424 | Dialog "Connect an agent": "App" select, "Name" input, "Cancel" / "Connect" | Creates an agent token | `renderer/components/settings/connect-agent-dialog.tsx:169` | [ ] | [ ] | [ ] |
| P1425 | Dialog "Connect {name}": "Show/Hide token", "Copy", "Add to {app}", "Done" | Shows the setup line once | `renderer/components/settings/connect-agent-dialog.tsx:281` | [ ] | [ ] | [ ] |

### Settings → About (settings/about-settings.tsx)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P1426 | "Support bundle" → open Health | Goes to the Health export | `renderer/components/settings/about-settings.tsx:48` | [ ] | [ ] | [ ] |
| P1427 | "Links": Website, Privacy policy, Terms of service, Source code and licenses | Opens web links | `renderer/components/settings/about-settings.tsx:57` | [ ] | [ ] | [ ] |
| P1428 | "About & updates" version + release track | Shows version and channel *(Track label per platform (releaseTrackLabel :96))* | `renderer/components/settings/about-settings.tsx:82` | [ ] | [ ] | [ ] |
| P1429 | "What's new…" | Opens the changelog dialog | `renderer/components/settings/about-settings.tsx:101` | [ ] | [ ] | [ ] |
| P1430 | Update error alert + "Try again" | Update check failure | `renderer/components/settings/about-settings.tsx:109` | [ ] | [ ] | [ ] |
| P1431 | "Updates" row: check / "Checking…" / "Update download" progress / install / external link | Updater control states | `renderer/components/settings/about-settings.tsx:140` | [ ] | [ ] | [ ] |

### Encoder preference (settings/encoder-preference-field.tsx; rendered on Output, not Settings)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P1432 | "Fallback video encoder" (Beta) select: Automatic / Intel Quick Sync / Software only | Chooses the fallback H.264 encoder *(Windows with Intel Quick Sync only (hidden unless `quickSyncAvailable`, :35))* | `renderer/components/settings/encoder-preference-field.tsx:42 (used renderer/components/tabs/recording-tab.tsx:468)` | n/a | [ ] | n/a |


## Dialogs

### Global dialogs (not owned by one page)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P1433 | What's New "What's new in Videorc {v}" | Highlights after an update; waits until setup is done *(entries filtered by platform (hooks/use-whats-new.ts:11))* | `renderer/components/whats-new-dialog.tsx:55; app-shell.tsx:785` | [ ] | [ ] | [ ] |
| P1434 | What's New "Full release notes" / "Continue" | Opens web notes / closes | `renderer/components/whats-new-dialog.tsx:77` | [ ] | [ ] | [ ] |
| P1435 | What's New reopen | From Settings → About (`onShowWhatsNew`) | `renderer/components/tabs/settings-tab.tsx:72` | [ ] | [ ] | [ ] |
| P1436 | End livestream "End livestream?" / "…and quit?" / "…and close?" | Asks before every stop while live | `renderer/components/end-livestream-dialog.tsx:49; renderer/lib/session-stop.ts:69` | [ ] | [ ] | [ ] |
| P1437 | End livestream "Keep streaming" (focus, Esc) | Cancels | `renderer/components/end-livestream-dialog.tsx:62` | [ ] | [ ] | [ ] |
| P1438 | End livestream "End livestream" / "…and quit" / "…and close" | Ends the stream | `renderer/components/end-livestream-dialog.tsx:76; renderer/lib/session-stop.ts:81` | [ ] | [ ] | [ ] |
| P1439 | End livestream hand-off "Continue on another device" / "Quit and keep it live" / "Close and keep it live" | Keeps a managed cloud show live | `renderer/components/end-livestream-dialog.tsx:66; renderer/lib/cloud-handoff-view.ts:42` | [ ] | [ ] | [ ] |
| P1440 | Go Live dialog (GoLiveDialogGate) | Go Live confirmation over any page | `renderer/components/go-live-dialog-gate.tsx:1; app-shell.tsx:776` | [ ] | [ ] | [ ] |
| P1441 | Command palette dialog | ⌘K overlay (section 1f) | `renderer/components/app-shell.tsx:779` | [ ] | [ ] | [ ] |
| P1442 | First-run setup (whole window) | Section 2a *(not auto-shown on Linux)* | `renderer/components/app-shell.tsx:622` | [ ] | [ ] | [ ] |
| P1443 | AgentsWatcher | Agent activity toasts | `renderer/components/app-shell.tsx:794; renderer/components/agents-watcher.tsx:15` | [ ] | [ ] | [ ] |
| P1444 | Toaster (sonner), offset per window | Global toasts | `renderer/components/window-providers.tsx:55` | [ ] | [ ] | [ ] |
| P1445 | Root error "Videorc hit a problem" ("Try again", reload, "Copy details") | App-level crash panel | `renderer/components/root-error-panel.tsx:45` | [ ] | [ ] | [ ] |
| P1446 | Page error "This page hit a problem" ("Try again") | Per-page crash panel | `renderer/components/page-error-panel.tsx:22` | [ ] | [ ] | [ ] |
| P1447 | ConfirmDialog (generic; default "Cancel") | Shared confirm used by about 40 callers across pages | `renderer/components/confirm-dialog.tsx:35` | [ ] | [ ] | [ ] |
| P1448 | Cloud AI consent "Allow cloud AI" / "Not now" | Cloud AI opt-in (onboarding, Sidekick tab, pet creator, create gate) | `renderer/components/cloud-ai-consent-dialog.tsx:34` | [ ] | [ ] | [ ] |
| P1449 | Sidekick consent "Turn on Sidekick Live?" / "Not now" | Sidekick Live cloud AI opt-in (Sidekick tab, avatar section) | `renderer/components/buddy-consent-dialog.tsx:36` | [ ] | [ ] | [ ] |
| P1450 | YouTube consent "Connect YouTube to Videorc" ("Cancel" / "Continue to Google") | Policy acceptance before YouTube OAuth | `renderer/components/streaming/destination-card.tsx:858` | [ ] | [ ] | [ ] |
| P1451 | Lock alert ("Sign in" / "View Premium") | Shared gate alert with an unlock action | `renderer/components/lock-alert.tsx:22` | [ ] | [ ] | [ ] |
| P1452 | OBS import dialog | Import from OBS (opened from Settings → General) | `renderer/components/obs-import-dialog.tsx:46; renderer/components/settings/general-settings.tsx` | [ ] | [ ] | [ ] |
| P1453 | Native main-process dialogs | Windows 11 required; window stopped working; HTML banner pick *(see section 3b)* | `main/index.ts:10801; index.ts:2835; index.ts:17089` | [ ] | [ ] | [ ] |


## First run

### First run (components/first-run)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P1454 | Auto-show decision | Shown on a fresh install or to resume; never auto-shown on Linux *(macOS and Windows (first-run.ts:84))* | `renderer/lib/first-run.ts:84` | [ ] | [ ] | n/a |
| P1455 | Step order: permissions, goal, look, sound, destinations | Linux skips Permissions; "Recordings" skips Destinations *(Permissions step not on Linux (first-run.ts:108))* | `renderer/lib/first-run.ts:7; first-run.ts:105` | [ ] | [ ] | [ ] |
| P1456 | Welcome backdrop | Moving liquid-chrome backdrop; still with reduced motion or no GPU acceleration | `renderer/components/first-run/welcome-backdrop.tsx:59` | [ ] | [ ] | [ ] |
| P1457 | Title band | Drag band on the traffic-light line | `renderer/components/first-run/first-run-setup.tsx:187` | [ ] | [ ] | [ ] |
| P1458 | Step counter + live "Step X of Y, {title}" | Announces the step change | `renderer/components/first-run/setup-step-frame.tsx:89` | [ ] | [ ] | [ ] |
| P1459 | "Skip setup" | Leaves setup from any step | `renderer/components/first-run/setup-step-frame.tsx:134` | [ ] | [ ] | [ ] |
| P1460 | "Back" | Previous step | `renderer/components/first-run/setup-step-frame.tsx:161` | [ ] | [ ] | [ ] |
| P1461 | Primary "Continue" / "Open Studio" / "Done" (replay) | Next step, or leaves on the last one | `renderer/components/first-run/first-run-setup.tsx:111` | [ ] | [ ] | [ ] |
| P1462 | Placeholder | Solid window shown while the setup chunk loads | `renderer/components/app-shell.tsx:632` | [ ] | [ ] | [ ] |
| P1463 | Permissions "Welcome to Videorc" | App icon, OS description, privacy line | `renderer/components/first-run/permissions-step.tsx:89` | [ ] | [ ] | [ ] |
| P1464 | Rows "Screen Recording", "System audio", "Microphone", "Camera" | Status badge and tag ("Needed to record"/"Optional") per row *(none on Linux (system-access.ts:254); Screen Recording optional on Windows (system-access.ts:286))* | `renderer/lib/system-access.ts:282` | [ ] | [ ] | [ ] |
| P1465 | Row action "Allow…" / "Reopen Videorc" / "Open System Settings…" | OS prompt, relaunch, or OS settings pane *(macOS / Windows)* | `renderer/lib/system-access-view.ts:50` | [ ] | [ ] | n/a |
| P1466 | Microphone level proof | "Say something. The bar moves when Videorc hears you." | `renderer/components/first-run/permissions-step.tsx:41` | [ ] | [ ] | [ ] |
| P1467 | Permissions primary "Continue" / "Skip for now" | Continue once required grants are in | `renderer/components/first-run/permissions-step.tsx:103` | [ ] | [ ] | [ ] |
| P1468 | "Nothing to grant here" empty state | Linux explanation (replay only) *(Linux only (permissions-step.tsx:68))* | `renderer/components/first-run/permissions-step.tsx:114` | n/a | n/a | [ ] |
| P1469 | Goal "What are you making?" rows "Recordings" / "Livestreams" / "Both" | Picks the goal and advances; ↑↓ move between rows | `renderer/components/first-run/goal-step.tsx:29` | [ ] | [ ] | [ ] |
| P1470 | Look "Your look": scene picture | Live preview of the chosen look | `renderer/components/first-run/look-step.tsx:151` | [ ] | [ ] | [ ] |
| P1471 | Look: "Orientation" ("Horizontal 16:9" / "Vertical 9:16") | Sets canvas orientation | `renderer/components/first-run/look-step.tsx:166` | [ ] | [ ] | [ ] |
| P1472 | Look: "Camera shape" ("Rectangle" / "Rounded" / "Circle") | Sets camera mask, when it applies | `renderer/components/first-run/look-step.tsx:182` | [ ] | [ ] | [ ] |
| P1473 | Look: "Background" tiles ("None" + live backgrounds) | Picks a live background | `renderer/components/first-run/look-step.tsx:196` | [ ] | [ ] | [ ] |
| P1474 | Look: "Layout" scene cards | Picks a layout preset; unavailable ones give a reason | `renderer/components/first-run/look-step.tsx:231` | [ ] | [ ] | [ ] |
| P1475 | Look: "Back to permissions" | Jumps back when a grant is missing | `renderer/components/first-run/look-step.tsx:250` | [ ] | [ ] | [ ] |
| P1476 | Sound "Sound check": Microphone picker (None = "Off") | Switches the live microphone | `renderer/components/first-run/sound-step.tsx:172` | [ ] | [ ] | [ ] |
| P1477 | Sound: "Videorc can't hear your microphone yet." + "Back to permissions" | Blocked-mic alert | `renderer/components/first-run/sound-step.tsx:200` | [ ] | [ ] | [ ] |
| P1478 | Sound: level meter + "Microphone gain" fader + verdict | Live level and manual gain | `renderer/components/first-run/sound-step.tsx:206` | [ ] | [ ] | [ ] |
| P1479 | Sound: "Set level for me" | Sets gain automatically from speech peak | `renderer/components/first-run/sound-step.tsx:228` | [ ] | [ ] | [ ] |
| P1480 | Sound: "System audio" switch | Enables system audio capture *(row hidden where unsupported (lib/system-audio.ts:92))* | `renderer/components/first-run/sound-step.tsx:151` | [ ] | [ ] | [ ] |
| P1481 | Destinations "Where you stream": rows YouTube / Twitch / Kick / X + "Connected" badge | Sign-in status per platform | `renderer/components/first-run/destinations-step.tsx:159` | [ ] | [ ] | [ ] |
| P1482 | "Sign in…" | Starts OAuth; YouTube asks for consent first | `renderer/components/first-run/destinations-step.tsx:138` | [ ] | [ ] | [ ] |
| P1483 | "Authorize X Live…" | Authorizes X native live | `renderer/components/first-run/destinations-step.tsx:142` | [ ] | [ ] | [ ] |
| P1484 | Pending "Waiting for your browser…" + "Copy link" + "Cancel" | Browser sign-in in progress | `renderer/components/first-run/destinations-step.tsx:168; renderer/components/streaming/destination-card.tsx:950` | [ ] | [ ] | [ ] |
| P1485 | YouTube consent "Connect YouTube to Videorc" | Policy links, checkbox, "Cancel" / "Continue to Google" | `renderer/components/first-run/destinations-step.tsx:173; renderer/components/streaming/destination-card.tsx:858` | [ ] | [ ] | [ ] |
| P1486 | Offline alert | Shown when the engine is disconnected | `renderer/components/first-run/destinations-step.tsx:239` | [ ] | [ ] | [ ] |
| P1487 | "Open Destinations" | Leaves setup to Destinations (stream keys, TikTok, Instagram) | `renderer/components/first-run/destinations-step.tsx:264` | [ ] | [ ] | [ ] |
| P1488 | Replay entry "Run setup again…" | In Settings → General and ⌘K | `renderer/components/settings/general-settings.tsx:244` | [ ] | [ ] | [ ] |

### Linux setup alert

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P1489 | LinuxSetupAlert (warning, selectable text) | One missing desktop piece and the install command *(Linux only)* | `renderer/components/linux-setup-alert.tsx:11` | n/a | n/a | [ ] |
| P1490 | Keyring issue titles ("No keyring on this desktop", etc.) | Secret Service / password-store problems *(Linux only)* | `renderer/lib/linux-desktop-check.ts:87` | n/a | n/a | [ ] |
| P1491 | "Videorc can't open {devices}" | Device-group permissions *(Linux only)* | `renderer/lib/linux-desktop-check.ts:150` | n/a | n/a | [ ] |
| P1492 | "Screen capture needs xdg-desktop-portal" / "Your desktop's portal can't share the screen" | Portal problems *(Linux only)* | `renderer/lib/linux-desktop-check.ts:210` | n/a | n/a | [ ] |
| P1493 | Where shown | Health Checks; Destinations shows the keyring one before sign-in *(Linux only)* | `renderer/components/tabs/diagnostics-tab.tsx:239` | n/a | n/a | [ ] |


## OS

### OS integration: macOS menu bar (app-menu.ts)

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P1494 | App menu: "About Videorc" | Native About panel *(macOS only (app-menu.ts:64))* | `main/app-menu.ts:93` | [ ] | n/a | n/a |
| P1495 | App menu: "Settings…" (⌘,) | Opens Settings *(macOS only)* | `main/app-menu.ts:96` | [ ] | n/a | n/a |
| P1496 | App menu: Services, Hide, Hide Others, Show All, Quit | Standard roles; Quit asks first if live *(macOS only)* | `main/app-menu.ts:101` | [ ] | n/a | n/a |
| P1497 | Edit: Undo, Redo, Cut, Copy, Paste, Paste and Match Style, Delete, Select All | Standard roles; text-field editing keys depend on them *(macOS only)* | `main/app-menu.ts:113` | [ ] | n/a | n/a |
| P1498 | Edit: Speech → Start / Stop Speaking | Standard roles *(macOS only)* | `main/app-menu.ts:123` | [ ] | n/a | n/a |
| P1499 | View: "Studio" ⌘1 | Shows main window on the page *(macOS only)* | `main/app-menu.ts:71; shared/app-menu-items.ts:20` | [ ] | n/a | n/a |
| P1500 | View: "Sources" ⌘2, "Scene" ⌘3, "Captions" ⌘4, "Output" ⌘5 | Setup pages *(macOS only)* | `shared/app-menu-items.ts:20` | [ ] | n/a | n/a |
| P1501 | View: "Destinations" ⌘6, "Guests" ⌘7, "Avatar" ⌘8, "Sidekick" ⌘9 | Livestream pages (Guests listed whatever the cloud status) *(macOS only)* | `shared/app-menu-items.ts:20` | [ ] | n/a | n/a |
| P1502 | View: "Images" ⇧⌘G, "Sounds" ⇧⌘S | Assets pages *(macOS only)* | `shared/app-menu-items.ts:20` | [ ] | n/a | n/a |
| P1503 | View: "Library" ⌘0 | Library page *(macOS only)* | `shared/app-menu-items.ts:20` | [ ] | n/a | n/a |
| P1504 | View: Reload, Force Reload, Toggle Developer Tools | Development builds only *(dev only (all OS))* | `main/app-menu.ts:49` | dev | dev | dev |
| P1505 | View: Toggle Full Screen | Fullscreen role *(macOS; dev-only menu elsewhere (app-menu.ts:68))* | `main/app-menu.ts:128` | [ ] | n/a | n/a |
| P1506 | Window: "Preview" ⌘P, "Notes" ⇧⌘N, "Stream Manager" ⇧⌘J, "Captions reader" ⇧⌘C | Toggles each window; reopens main window if needed *(macOS only; each removed by its VIDEORC_*_WINDOW=0 kill switch)* | `shared/app-menu-items.ts:38; main/index.ts:18341` | [ ] | n/a | n/a |
| P1507 | Window: Minimize, Zoom, Close, Bring All to Front | Standard roles *(macOS only)* | `main/app-menu.ts:134` | [ ] | n/a | n/a |
| P1508 | Help: "Release Notes" | Opens videorc.com/releases/{version} *(macOS only)* | `main/app-menu.ts:144; main/index.ts:18375` | [ ] | n/a | n/a |
| P1509 | No menu bar | Packaged Windows and Linux builds have no menu *(Windows and Linux)* | `main/app-menu.ts:66` | n/a | [ ] | [ ] |
| P1510 | Text context menu | Spelling suggestions or "No Guesses Found"; Cut, Copy, Paste, Select All | `main/context-menu.ts:25` | [ ] | [ ] | [ ] |

**Known gaps in the GPUI menu bar** (plan 260 S2.6a part 1, #1857, lane L4).
To fix before Phase 3 ticks these lines on macOS:

- **P1497, Edit's items: in code, not yet checked by eye** (plan 260
  Phase 4, L4). The items are the text field's own actions
  (`gpui_base::input`), so each is enabled while a field has focus and does
  what its key does there; before this, they dispatched app actions nothing
  handled, so the menu showed them disabled. Paste and Match Style is Paste
  (a GPUI field only takes plain text); Delete is the field's Delete.
- **P1498, Edit → Speech (Start Speaking, Stop Speaking): in code, not
  yet checked by eye** (plan 260 Phase 4, L4). GPUI 0.3.14 has no form for
  `startSpeaking:`, and a GPUI field is not an AppKit text view the selector
  could reach, so Start Speaking speaks the focused field's selection (or
  all its text) with `NSSpeechSynthesizer`, the synthesizer the roles use;
  Stop Speaking stops it (`app/speech.rs`, `platform/macos/speech.rs`).
- **P1494, "About Videorc": in code, not yet checked by eye.** It shows
  macOS's standard About panel (`orderFrontStandardAboutPanel:`, the
  bundle's name, version and credits), as Electron's `about` role.
- **P1515 and P1496, the Dock's Quit, a logout and a restart while on
  air: held in code, not yet checked by eye** (plan 260 Phase 4, lane L4).
  GPUI 0.3.14 implements only `applicationWillTerminate:`, so the app adds
  `applicationShouldTerminate:` to GPUI's delegate class at launch
  (`platform/macos/terminate.rs`) and answers "cancel" while the exit guard
  holds the quit. The guard's question is now asked: its answerer is the
  Studio's stop request, which the shell's End livestream dialog shows, and
  that dialog's yes (or the hand-off) lets the quit or close through. The
  build pass ticks the rows after a by-eye check.

### OS integration: dock, lifecycle, deep links, single instance

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P1511 | Dock menu | None: no `app.dock.setMenu` anywhere *(n/a)* | `main/index.ts:10760` | n/a | n/a | n/a |
| P1512 | Dock icon override | Sets the dock icon in dev builds only *(macOS dev only)* | `main/index.ts:10777` | dev | dev | dev |
| P1513 | Dock click / `activate` | Recreates the main window when none is open *(macOS)* | `main/index.ts:20201` | [ ] | n/a | n/a |
| P1514 | Close all windows | Quits the app *(Windows and Linux (macOS stays running))* | `main/index.ts:20208` | n/a | [ ] | [ ] |
| P1515 | Close or quit while live | Holds the close and asks End livestream | `main/index.ts:3183` | [ ] | [ ] | [ ] |
| P1516 | `videorc://` protocol registration | Registers the scheme handler *(all; Linux AppImage writes its own .desktop entry (main/linux-desktop-entry.ts:1))* | `main/index.ts:10811` | [ ] | [ ] | [ ] |
| P1517 | `videorc://oauth/callback` | Provider OAuth callback (YouTube/Twitch/Kick/X) | `main/index.ts:11058` | [ ] | [ ] | [ ] |
| P1518 | `videorc://account/callback` | Videorc account sign-in callback | `main/index.ts:11065` | [ ] | [ ] | [ ] |
| P1519 | `videorc://buddy`, `videorc://buddy/library?alive=<id>` | Opens Sidekick/avatar library; `alive` uses it, then opens creator | `main/buddy-deep-link.ts:20; main/index.ts:11043` | [ ] | [ ] | [ ] |
| P1520 | `open-url` handler | Receives deep links (queued until ready) *(macOS)* | `main/index.ts:18259` | [ ] | n/a | n/a |
| P1521 | Single instance lock | A second launch quits; first focuses main and takes the URL from argv | `main/index.ts:18227` | [ ] | [ ] | [ ] |
| P1522 | "Windows 11 required" dialog ("Quit") | Blocks Windows builds below 22000 *(Windows only)* | `main/index.ts:10785` | n/a | [ ] | n/a |
| P1523 | "The Videorc window stopped working" ("Reload" / "Quit Videorc") | Shown after repeated renderer crashes | `main/index.ts:2835` | [ ] | [ ] | [ ] |
| P1524 | "Import an HTML banner" question | Asks folder or single file *(Windows and Linux (htmlOverlayPickNeedsChoice))* | `main/index.ts:17089` | n/a | [ ] | [ ] |
| P1525 | Linux password store | Forces libsecret on desktops Chromium doesn't recognize *(Linux only)* | `main/linux-password-store.ts:1` | n/a | n/a | [ ] |

### OS integration: global shortcuts

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P1526 | "Hide screen" (default Ctrl+Alt+H) | Toggles screen privacy while Videorc is in the background *(all except Wayland)* | `shared/global-shortcuts.ts:66` | [ ] | [ ] | [ ] |
| P1527 | "Record / stop recording" | Global record toggle (unset by default) *(all except Wayland)* | `shared/global-shortcuts.ts:67` | [ ] | [ ] | [ ] |
| P1528 | "Go Live / end livestream" | Global stream toggle; stop needs a second press within the arm window *(all except Wayland)* | `shared/global-shortcuts.ts:68; renderer/src/lib/session-stop.ts:98` | [ ] | [ ] | [ ] |
| P1529 | "Mute / unmute microphone" | Global mic toggle *(all except Wayland)* | `shared/global-shortcuts.ts:69` | [ ] | [ ] | [ ] |
| P1530 | "Turn system audio on or off" | Toggles system audio; toast if not possible *(all except Wayland)* | `shared/global-shortcuts.ts:70; renderer/src/lib/global-shortcuts.ts:93` | [ ] | [ ] | [ ] |
| P1531 | "Save a 30-second clip" / "Save a 1-minute clip" | Global clip marks *(all except Wayland)* | `shared/global-shortcuts.ts:71` | [ ] | [ ] | [ ] |
| P1532 | "Next scene" / "Previous scene" | Cycles scenes *(all except Wayland)* | `shared/global-shortcuts.ts:73` | [ ] | [ ] | [ ] |
| P1533 | "Scene 1–9" slots | Default Ctrl+Alt+N (mac) / Ctrl+Alt+Shift+N elsewhere *(all except Wayland)* | `shared/global-shortcuts.ts:31` | [ ] | [ ] | [ ] |
| P1534 | Per-scene keys `scene:<id>` | Switches to that saved scene *(all except Wayland)* | `shared/global-shortcuts.ts:62` | [ ] | [ ] | [ ] |
| P1535 | Wayland unavailable reason | "Global shortcuts can't work in this Wayland session…" *(Linux Wayland)* | `main/global-shortcut-lifecycle.ts:29` | [ ] | [ ] | [ ] |
| P1536 | Registration toasts ("Global shortcuts don't work here", "Global shortcuts didn't register") | Reports keys that failed or are taken | `renderer/lib/global-shortcuts.ts:235` | [ ] | [ ] | [ ] |
| P1537 | Shortcut recorder arm | Suspends global keys while Settings records a key; 30 s idle disarms | `main/index.ts:963` | [ ] | [ ] | [ ] |

### OS integration: permissions, camera, power, protection, windows, updates, notifications

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
| P1538 | Screen Recording priming / in-place request | Logs status at launch; requests via desktopCapturer *(macOS only (index.ts:12691))* | `main/index.ts:12690; index.ts:12719` | [ ] | n/a | n/a |
| P1539 | Camera/Microphone "Allow…" prompt | `askForMediaAccess`; on Windows it only re-reads status *(macOS prompt; Windows status only; Linux none)* | `main/index.ts:16547` | [ ] | [ ] | [ ] |
| P1540 | Grant watcher → backend restart | Restarts capture once after a late grant *(macOS / Windows)* | `main/index.ts:12730` | [ ] | [ ] | n/a |
| P1541 | "Reopen Videorc" (relaunch for permission) | `app.relaunch` + quit, refused while capturing *(macOS)* | `main/index.ts:12750; main/permission-relaunch.ts:11` | [ ] | n/a | n/a |
| P1542 | Deferred permission restart | Waits for the recording to stop before restarting | `main/deferred-permission-restart.ts:15` | [ ] | [ ] | [ ] |
| P1543 | OS settings deep links | Opens Privacy panes (x-apple.systempreferences / ms-settings) *(macOS / Windows)* | `main/runtime-info.ts:12` | [ ] | [ ] | n/a |
| P1544 | Videorc Camera system extension activate/deactivate | OSSystemExtensionRequest; states include needs-approval and reboot *(macOS only (camera-extension.ts:181))* | `main/camera-extension.ts:181; main/index.ts:18431` | [ ] | n/a | n/a |
| P1545 | Virtual camera setup action | macOS extension; Windows setUp; Linux v4l2loopback module *(per-OS branches (virtual-camera-action.ts:107))* *(Windows: hidden until proven, plan 260 "What parity means")* | `main/virtual-camera-action.ts:91` | [ ] | n/a | [ ] |
| P1546 | Sleep guard | Blocks display sleep while recording, live, or in a cloud room | `main/index.ts:1211; main/display-sleep-guard.ts:22` | [ ] | [ ] | [ ] |
| P1547 | Stream Manager "Hide from stream" | Capture filter on mac; content protection on Windows *(macOS / Windows; unsupported on Linux)* | `main/window-capture-protection.ts:57; main/index.ts:4111` | [ ] | [ ] | n/a |
| P1548 | Main, Preview, Captions windows | Never hidden from capture (stay visible) | `main/window-capture-protection.ts:92` | [ ] | [ ] | [ ] |
| P1549 | Saved frame: Preview (`preview-window.json`: frame, open, keep on top, mode) | Restored, and clamped on-screen, at launch | `main/index.ts:3489` | [ ] | [ ] | [ ] |
| P1550 | Saved frame: Notes (`notes-window.json`: frame, open, keep on top, text) | Restored on open | `main/index.ts:3581; index.ts:3844` | [ ] | [ ] | [ ] |
| P1551 | Saved frame: Stream Manager (`comments-window.json`, per-screen frames) | Restored on open | `main/index.ts:3997; index.ts:4708` | [ ] | [ ] | [ ] |
| P1552 | Saved frame: Captions reader (`captions-window.json`) | Restored on open | `main/index.ts:5068; index.ts:5209` | [ ] | [ ] | [ ] |
| P1553 | Main window frame | Not persisted; always 1180×780 | `main/index.ts:3043` | [ ] | [ ] | [ ] |
| P1554 | Update ready system notification "Videorc {v} is ready" | "Restart Videorc to finish updating…"; never during capture *(macOS / Windows)* | `main/updater.ts:380; main/updater-status.ts:133` | [ ] | [ ] | n/a |
| P1555 | Settings → About update row ("Check for updates", "Check again", "Restart & install {v}") | Check, install, or show reason; install refused while capturing *(macOS / Windows)* | `renderer/lib/about-update-view.ts:32; main/updater.ts:571` | [ ] | [ ] | n/a |
| P1556 | Linux update notice ("Open downloads page") | Points to videorc.com only, no auto-install *(Linux only)* | `main/updater.ts:75; renderer/src/lib/about-update-view.ts:81` | n/a | n/a | [ ] |
| P1557 | Windows feed states ("Open account page") | Pilot/alpha feed gating; differential download off *(Windows only)* | `main/updater.ts:99; renderer/src/lib/about-update-view.ts:97` | n/a | [ ] | n/a |
| P1558 | Watchdog system notification | Stream alert when Studio isn't front; click focuses its card | `main/index.ts:19698; main/watchdog-notify.ts:1` | [ ] | [ ] | [ ] |
| P1559 | Aux-window key forwarding | Page keys and ⇧⌘N/J/C work from Notes, Stream Manager and Captions | `main/index.ts:3711` | [ ] | [ ] | [ ] |

## Windows-only lines

On top of every P line's Windows column. From the
[Windows testing plan](../../plans/260-gpui-rewrite-windows-testing.md#windows-parity-checklist);
a change there is made in both places in one PR.

| # | Line | Windows |
| --- | --- | :-: |
| W01 | Scale: 100 %, 125 %, 150 % and 200 %, and moving a window between two displays with different scales: no blurry text, nothing cut off | [ ] |
| W02 | Title bar: Windows' own minimise, maximise and close buttons and snap layouts | [ ] |
| W03 | The window frame and saved window positions after restart | [ ] |
| W04 | Dark, light and contrast themes follow Windows' setting live | [ ] |
| W05 | Text input: Japanese and Chinese IME in the chat composer, Notes and every text field | [ ] |
| W06 | Text input: emoji with Win+.; Ctrl+C, Ctrl+V, Ctrl+A, Ctrl+Z; right-click Cut, Copy and Paste | [ ] |
| W07 | Narrator: every control named, dialogs announced, lists navigable with arrow keys | [ ] |
| W08 | Keyboard: Tab order matches the screen; every shortcut shown in the app works; global shortcuts work with another app in front | [ ] |
| W09 | Hide from stream: Notes, the floating Preview and the Stream Manager are absent from screen shares and from Videorc's own screen capture | [ ] |
| W10 | `videorc://` links from the browser (sign-in, Stream Deck, remote) open the running app, or start it; one instance: a second start focuses the first | [ ] |
| W11 | Notifications: Windows notifications for the watchdog and "update ready"; clicking one opens the right page | [ ] |
| W12 | Files: open and save dialogs, "Show in folder", drag-and-drop of images and sounds, deleting to the Recycle Bin; the display stays awake while recording or live | [ ] |
| W13 | Install, update and uninstall: the installer, SmartScreen and UAC prompts as today, the Start menu entry, the update from Electron, and an uninstall that leaves no app files | [ ] |
| W14 | Performance on your PC: idle and live CPU of the app's process against the Electron baseline (S0.10), reported, not judged | [ ] |

## How this list was made, and how S5.0 remakes it

S0.11 read the renderer (`apps/desktop/src/renderer/src`), the main
process (`apps/desktop/src/main`) and `apps/desktop/src/shared` at
`0b32fb218`, one area per reader (shell and OS; Studio and Sources; Scene,
Captions and Output; Destinations, Guests, Stream Manager and Notes;
Avatar to Settings), and listed every user-visible control with its label,
source line and platform gating (`process.platform`, `lib/platform.ts`,
the backend's capability flags). A control shared by two pages is listed
once, under the page that owns its component (the scene dialogs under
Scene, cloud Clips and the encoder preference under Output, the avatar
onboarding under Avatar, the notification centre and Notes under Stream
Manager and Notes). S5.0 repeats the read on the switch commit, keeps the IDs of
lines that still exist, marks removed lines `removed` rather than deleting
them, and adds new controls after the last ID. The drift check in plan
260's executor instructions applies: a control added since this list is
scope to add, not to drop.
