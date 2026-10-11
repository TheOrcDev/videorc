# Plan 174 findings register — the UI/UX audit, every finding with its evidence

Companion to [`174-ui-ux-pass.md`](174-ui-ux-pass.md), which turns these
findings into ordered slices. Audited at `c49e7855` (`origin/main` `72b47404`
plus PR #647), 2026-10-10.

**Owner calls (2026-10-10)**: Clean cut stays on the Buddy page, which stays
directly under Studio because it sells Premium (D6, D8), and a click on a
live chat row keeps putting it on stream (D10). The owner-decision lines
below are annotated where these apply.

## How to read this

- **IDs** name the review that found the issue: A shell · B Studio · C
  Sources/Scene/Assets · D Livestream/Output/Captions · E Library/Clean cut ·
  F Buddy page · G Buddy creation · H Stream Manager · I Settings/Health/
  Notes/remote · J1 design system · J2 copy and states · V visual-only.
  `I-NEW` is a defect the orchestrator found while checking area I.
- **Severity**: P0 broken, misleading, data-loss or an accessibility blocker;
  P1 a clear inconsistency or best-practice violation a streamer will notice;
  P2 polish; P3 nit.
- **✔** means the orchestrator re-read the cited code and confirmed the
  finding. Every P0 is verified. "(= X-n)" marks a duplicate of another ID;
  fix them together.
- **Paths**: `components/…`, `lib/…`, `hooks/…` and `ui/…` are under
  `apps/desktop/src/renderer/src/`; a bare file name (for example
  `use-studio.tsx`) is the unique renderer file of that name
  (`hooks/use-studio.tsx`); `comments/main.tsx`, `notes/main.tsx` and
  `captions/main.tsx` are under `apps/desktop/src/renderer/`; Rust files are
  under `crates/videorc-backend/src/`; `remote_web/` is
  `crates/videorc-backend/remote_web/`. Line numbers are as of `c49e7855`;
  re-find moved anchors by symbol.
- **When a slice lands**, mark its IDs here: append `— fixed in #NNN` (or
  `— deferred: reason`).

Totals: 347 findings (17 P0 entries describing 11 distinct problems, 87 P1,
187 P2, 56 P3).

## Area A — App shell, navigation and global chrome

- **A-1** · P0 ✔ · Space ends session from focused slider thumb (role=slider span), dialog body, mouse-opened menu; handler on window in StudioProvider (all pages), no confirm — fixed in #647 (S0.1 `084f3b9a`)
  - Evidence: use-studio.tsx:14834-14880,15933; App.tsx:39
  - Fix: gate: no modal, Studio active, widget roles excluded; tests; (owner: Space never ends a livestream)
- **A-2** · P1 · ⌘1–9/⌘,/⌘K navigate from under page dialogs (unsaved schedule edits lost; OBS import lock bypassed); modal gate checks only onboarding+WhatsNew; theme D key behind modals
  - Evidence: app-shell.tsx:301-363; schedule-stream-dialog.tsx:268; obs-import-dialog.tsx:209; use-theme-toggle.ts:13
  - Fix: one isModalOpen() for all handlers
- **A-3** · P1 · Space/⌘K "Start session"/global record start the LAST mode (streamEnabled persists) → open Go Live confirm that only renders on Studio → nothing happens off-Studio; global Go Live says "Streaming is not configured" after a recording — partly fixed in #647 (S0.6 `159c1155`, dialog hosted in AppShell); explicit modes in S3.1; fixed in #647 (S0.6 `159c1155`, S3.1 `a069d07f`)
  - Evidence: session-panel.tsx:115; studio-tab.tsx:122-168; use-studio.tsx:13744,14840; command-palette.tsx:203; global-shortcuts.ts:36-50; remote-surface.ts:265
  - Fix: explicit modes; host GoLive dialog in AppShell
- **A-4** · P1 · Status bar prints raw ws enums (Connected/Waiting/Closed/Failed); failed recording shows green Connected; Starting/Stopping pulse red; no role=status; no on-air clock off Studio — fixed in #647 (S1.3 `6bd8f9a2`)
  - Evidence: app-shell.tsx:411-421; account-menu.tsx:141; library-view.ts:90
  - Fix: sessionStatusLabel/Tone; elapsed; clickable → Health
- **A-5** · P1 · Shortcut text wrong per platform: Windows "CtrlK", "ShiftCtrlJ", "Ctrl1"; macOS ⇧⌘J vs ⌘⇧J; "Cmd+P"; "Ctrl↵"; boot flashes Ctrl; aria-keyshortcuts Meta+K everywhere — fixed in #647 (S1.2 `e257d3c4`)
  - Evidence: platform.ts:4-55; app-shell.tsx:507-529; sidebar.tsx:74,205; command-palette.tsx:220; shortcuts.ts:30; preview-stage.tsx:445; cohost-pane.tsx:743
  - Fix: acceleratorDisplayKeys (shared/accelerator.ts:349) behind <ShortcutKeys>; dataset.platform
- **A-6** · P1 ✔ · capitalize in StatusBadge/StatusDot → Title Case chips ("Checked On First Use", "Backend Offline", "Needs Reconnect"); hides raw enum leaks; workaround in buddy-voice-commands — fixed in #647 (S1.3 `6bd8f9a2`)
  - Evidence: status-badge.tsx:58; status-dot.tsx:45; diagnostics-tab.tsx:197,226,231
  - Fix: drop capitalize; human labels; test rejects /^[a-z-]+$/
- **A-7** · P1 · One root error boundary: a page crash/failed chunk takes down sidebar, status bar and Stop; panel shows raw error, no drag region, no support export
  - Evidence: main.tsx:32; error-boundary.tsx:27; app-shell.tsx:466
  - Fix: page boundary keyed by active + better root panel
- **A-8** · P1 ✔ · No application menu → Electron default (Reload ⌘R, Force Reload, DevTools) ships; no Settings…/windows/Help; Windows shows generic menu bar + duplicate brand — fixed in #647 (S0.6 `159c1155`; Theme, Check for Updates, Keyboard Shortcuts and Export Support Bundle menu items need main-to-renderer IPC, deferred)
  - Evidence: main: no setApplicationMenu; web-contents-security.ts:107; window-glass.ts:207; sidebar.tsx:199
  - Fix: real menu from workspace-nav + SHORTCUTS; hide on Windows
- **A-9** · P1 · ⌘K gaps: no Preview/Notes, no Record vs Go Live, no mute/mark clip; "Go to" vs "Open" verbs; no synonyms (layout, diagnostics, recording, destinations, keyboard); theme not checked
  - Evidence: command-palette.tsx:83-259
  - Fix: Windows group; Session mirrors transport; keywords
- **A-10** · P2 · Single-item sidebar groups LIBRARY→Library, SYSTEM→Settings; stale "under Studio" comments
  - Evidence: sidebar.tsx:257-296
  - Fix: proposed IA (labels only for Setup; Settings bottom; Studio row live dot + clock; Buddy stays second under Studio, owner call D8)
- **A-11** · P2 · Windows/actions have 3–5 names (Captions window: "Videorc Captions"/"Live captions"/"Open captions reader"/"Open reader"; Preview; "Chat closed for this recording"); Session actions (Record/Stream/Confirm Go Live/Resolve Blockers First/End livestream/Start session/Start-stop the session/Go live-end stream) — partly fixed in #647 (S2.2 `ae1e6788`, session actions); windows in S2.3a; fixed in #647 (S2.2 `ae1e6788`, S2.3a `490d7f6a`)
  - Evidence: captions.html:10; captions-reader.tsx:62; command-palette.tsx:200-233; shortcuts.ts:28-32; use-studio.tsx:10178
  - Fix: canonical names
- **A-12** · P2 · ⌘J: main window toggles (closes) Stream Manager; inside SM focuses Buddy (documented as Focus Buddy); no ⇧⌘J inside SM; undocumented p, arrows, R; no ⌘/ reference
  - Evidence: app-shell.tsx:324; shortcuts.ts:31,37; stream-manager.tsx:672; use-studio.tsx:14846-14876
  - Fix: scope by window; ⌘/ → Shortcuts
- **A-13** · P2 · ⌘K below palette scale (16px input, 20px icon, 12.5px headings), no footer/metadata/icons on some rows; group order; 4 names for palette
  - Evidence: ui/command.tsx:67-116; command-palette.tsx:72-261
  - Fix: retune + footer + order
- **A-14** · P2 (= D-29) · Livestream strip scrolls away; shell hard-codes non-scrolling ids; strip hand-copied 5x; Livestream tab not remembered (sessionStorage + event) — fixed in #647 (S1.6b `1bd4865c`)
  - Evidence: app-shell.tsx:464; streaming-tab.tsx:55-73
  - Fix: PaneStrip/PageTabs; typed openLivestream
- **A-15** · P2 · ListRow rounded-[5px]; interactive default true (11/14 pass false); hand-built interactive rows; bg-foreground/[0.03] fill copied ~30x; NavigableRow 36px off-scale (SessionRow better); KebabMenu size override — fixed in #647 (S1.6a `b5e1c5b7`)
  - Evidence: list-row.tsx:53,62,116; navigable-row.tsx:45; kebab-menu.tsx:49
  - Fix: fix primitives; bg-inset token
- **A-16** · P2 · Onboarding permission rows = card stack, truncated detail (title-only), amber vs Settings red, "Open settings" ambiguous; alt="Videorc" redundant — fixed in #647 (S3.17 `b88c8794`)
  - Evidence: permissions-onboarding-dialog.tsx:80,150-176; permissions-settings.tsx:44-101
  - Fix: shared SystemAccessList
- **A-17** · P2 · metaKey||ctrlKey on macOS steals ⌃K/⌃P text-editing keys — fixed in #647 (S1.2 `e257d3c4`)
  - Evidence: app-shell.tsx:303-335; main index.ts:2210
  - Fix: commandModifierKey(platform)
- **A-18** · P2 · No focus management/announcement on page change; static document.title
  - Evidence: app-shell.tsx:200; pane.tsx:30; index.html:11
  - Fix: focus h1; document.title
- **A-19** · P2 · What's New autofocuses "Full release notes" (Return opens browser); only newest entry
  - Evidence: whats-new-dialog.tsx:57; use-whats-new.ts:53 |
- **A-20** · P2 · Toasts say "Details are in diagnostics." (no such place) — fixed in #647 (S2.3a `490d7f6a`)
  - Evidence: lib/toast.ts:10
  - Fix: "Details were saved for support" + Export action
- **A-21** · P2 · Account trigger aria-label "Open account menu" over visible "Sign in" (WCAG 2.5.3); promised status dot missing; Sign out disabled w/o reason; 7px initials — partly fixed in #647 (S0.5 `e0140afc`, trigger name); status dot, Sign out reason and initials size open
  - Evidence: account-menu.tsx:32,86,95,152 |
- **A-22** · P2 · Shortcut conflict toast lists ids ("record-toggle, layout:camera-only") — fixed in #647 (S2.4 `4929496f`)
  - Evidence: global-shortcuts.ts:158
  - Fix: labels
- **A-23** · P2 · Settings → Recording competes with Output page (both id 'recording') — fixed in #647 (S3.6 `06caf5d1`)
  - Evidence: settings-tabs.ts:16; workspace-nav.tsx:71
  - Fix: rename tab "Storage"
- **A-24** · P3 · Heading hierarchy h1 → h3 — fixed in #647 (S1.6a `b5e1c5b7`)
  - Evidence: panel-section.tsx:43; page.tsx:45
  - Fix: h2 default
- **A-25** · P3 · Update chip "Restart to update" while live only navigates; green dot; aria-label mismatch
  - Evidence: update-ui.ts:43; sidebar.tsx:126 |
- **A-26** · P3 · Copy: "Your {settings} is blocking…", "Loading workspace…", "Search for a command to run..." — partly fixed in #647 (S2.1 `e6379d71`, palette "..." and title); rest in S2.5
  - Evidence: system-access.ts:313; app-shell.tsx:103; ui/command.tsx:28 |
- **A-27** · P3 · Skill/docs stale (fullscreen gutter; Comments window; Chat hints)
  - Evidence: SKILL.md:60; docs/buddy.md:412; App.tsx:41 |

**Owner decisions raised by this review:** Space never ends a livestream (Studio-only; stop recording instantly; livestream needs confirm/hold/⌘.); ⌘9 Buddy out of order (**owner 2026-10-10: Buddy stays directly under Studio on ⌘9**, it sells Premium; D8); Windows sidebar duplicate brand; ⌘J toggles SM → ⌘J show+focus Buddy, ⇧⌘J toggle; first Buddy tab → "Profile"

**Patterns to standardise:** ShortcutKeys (acceleratorDisplayKeys); session state labels (sessionStatusLabel/Tone; StatusDotTone 'error'=live vs StatusTone 'live'); WindowToolbar; Keep-on-top label (4 variants); Tooltip vs ~100 title= (Tooltip in only 3 files); SectionLabel (12 hand-rolled); inset surface token; PaneStrip; typed deep links; NavigableRow on SessionRow metrics; Empty (6 treatments); KebabMenu; formatVideoProfile; dataset.platform; "View Premium".

## Area B — Studio and the Record / Go Live flow

- **B-1** · P0 ✔ (with A-1) · Nothing protects a live stream from being ended: Space (any page, slider/dialog focus), global record AND stream hotkeys (also from background; record hotkey labelled "Start / stop recording" ends the livestream), ⌘K Stop session, Stop button — all instant; YouTube broadcasts completed; no AlertDialog — fixed in #647 (S0.1 `084f3b9a`)
  - Evidence: use-studio.tsx:13936-13987,14834; global-shortcuts.ts:36-43; command-palette.tsx:194; session-panel.tsx:93; studio-session-view.ts:141
  - Fix: requestStopSession(origin) + AlertDialog "End livestream?" (Keep streaming default); hotkey double-press while live
- **B-2** · P0 · Unnamed Selects: Go Live "Default privacy" (decides public!), Livestream Default privacy, Studio Inspector Output — fixed in #647 (S0.5 `e0140afc`)
  - Evidence: go-live-dialog.tsx:223-235; streaming-tab.tsx:520; quick-settings.tsx:233
  - Fix: htmlFor/id; aria-label; guard test every SelectTrigger named
- **B-3** · P1 (with A-3) · Hidden persisted streamEnabled mode: Record/Stream buttons mutate it; Space/⌘K Start session/record hotkey/remote recordStart open Go Live after a stream; Go Live hotkey refuses "Streaming is not configured" after a recording; ␣ chip on Record wrong; Space does nothing when stream blocked while Record enabled; Record re-enables Output "Save local recording"; Session "Streaming: Disabled" beside enabled Stream — fixed in #647 (S3.1 `a069d07f`)
  - Evidence: studio-tab.tsx:96-140; go-live-flow.ts:20; use-studio.tsx:6102,12081,14834; global-shortcuts.ts:43; remote-surface.ts:244-266; recording-tab.tsx:59; studio-session-view.ts:62
  - Fix: explicit startRecording()/startLivestream() intents
- **B-4** · P1 · Live dashboard has no per-destination state or stream health; dropped destination = 4 s toast (visibleToasts 3); "stream stopped/frozen" toast only — fixed in #647 (S3.2 `8ad74d53`)
  - Evidence: session-panel.tsx:230; use-studio.tsx:3774-3785; stream-target-notices.ts:28; session-runtime-recovery.ts:428
  - Fix: live Destinations group ("3 of 3 live"); Stream health fact; persistent notices
- **B-5** · P1 (= A-3) · Go Live dialog mounted only in StudioTab → invisible when started from other pages/remote/hotkeys; appears later with stale preflight — fixed in #647 (S0.6 `159c1155`)
  - Evidence: app-shell.tsx:467; studio-tab.tsx:168; use-studio.tsx:13726; remote-surface.ts:270
  - Fix: mount in AppShell; test
- **B-6** · P1 ✔ · Runtime notices treat default Go Live (record+stream reports state 'recording') as "recording": mic dropout "recording continues with silence", crash "Recording stopped unexpectedly" while audience lost stream — fixed in #647 (S0.6 `159c1155`)
  - Evidence: use-studio.tsx:5053; session-runtime-recovery.ts:210,534,622
  - Fix: sessionIsLive(); integration test
- **B-7** · P1 · Stream click: seconds of preflight with no feedback, no re-entry guard; failures go to generic reportError not reportSessionStartFailure — fixed in #647 (S3.1 `a069d07f`)
  - Evidence: use-studio.tsx:13676-13728; session-panel.tsx:120
  - Fix: "Checking…"; guard; Retry path
- **B-8** · P1 · Go Live dialog resolve buttons silently change SAVED settings ("Go live without YouTube" disables it forever; "Switch to Manual RTMP" drops account); no Reconnect route — fixed in #647 (S3.4 `cf2da9d9`)
  - Evidence: go-live-dialog.tsx:584-591; use-studio.tsx:14526
  - Fix: session-only exclusion or honest labels; "Reconnect {platform}…"
- **B-9** · P1 · Why Stream/Record disabled: native title on disabled button; Stream's reasons never inline; any reportError hides inline reason (!lastError) — partly fixed in #647 (S1.1 `add86ec0`, reasons on hover and focus); inline line in S3.1; fixed in #647 (S1.1 `add86ec0`, S3.2 `8ad74d53`)
  - Evidence: session-panel.tsx:118-123; studio-tab.tsx:87; use-studio.tsx:14711
  - Fix: one reason line; focusable Tooltip wrapper
- **B-10** · P1 ✔ (visual) · Transport below fold at 960–1023px (lg viewport breakpoint 1024 vs minWidth 960); scrolling to Stop hides docked preview (0.98 visible fraction) — fixed in #647 (S3.3 `b8e235e7`)
  - Evidence: studio-tab.tsx:189; index.ts:2109; preview-dock.ts:21
  - Fix: container query; sticky transport row
- **B-11** · P1 · Five names for going live (Stream / Confirm Go Live / End livestream / Streaming / Live session / Start session / Go live-end stream); stale "Open Recording"/"Open Live"/"Recording → Output"; "Switch to Manual RTMP" vs "Use stream key"; OAuth/Manual RTMP badges; Title Case buttons — fixed in #647 (S2.2 `ae1e6788`)
  - Evidence: session-panel.tsx:127; go-live-dialog.tsx:142,305,378,411,416,557-590; studio-tab.tsx:386-396
  - Fix: one vocabulary (owner D)
- **B-12** · P1 (= D-7) · Go Live dialog body: card stack, hand-rolled tinted callouts with coloured titles, rules in text-subtle — fixed in #647 (S3.4 `cf2da9d9`)
  - Evidence: go-live-dialog.tsx:153-545; go-live-panel.tsx:425
  - Fix: GroupedList + Alert
- **B-13** · P1 · Studio Captions switch turns on cloud audio upload with no disclosure; different status words from Captions page — fixed in #647 (S3.2 `8ad74d53`)
  - Evidence: quick-settings.tsx:58-64,265-275; captions-controls.tsx:75-111,220,417
  - Fix: shared captionsStatusPresentation; disclosure or NavigableRow
- **B-14** · P1 · Space inside Go Live dialog restarts Go Live (drops partial-setup/skip-captions choices); initial focus can land on a settings-changing resolve button; no ⌘↵; disabled primary label = instruction; "Checking…" covers all phases — partly fixed in #647 (S0.1 `084f3b9a`, Space in the dialog); focus, ⌘↵ and phases in S3.4; fixed in #647 (S0.1 `084f3b9a`, S3.4 `cf2da9d9`); fixed in #647 (S0.1, S3.4 `cf2da9d9`, S3.1 `a069d07f`)
  - Evidence: use-studio.tsx:13683; go-live-dialog.tsx:401-418,575; dialog.tsx:64
  - Fix: ignore keys in dialogs; onOpenAutoFocus; ⌘↵; phase labels
- **B-15** · P2 (= V) · Output twice in inspector (2 icons, 2 formats); Studio select lacks Output page performance warning; Output/Captions under "Inputs" — partly fixed in #647 (S1.4 `215e6585`, format); rest in S3.3; fixed in #647 (S1.4 `215e6585`, S3.3 `b8e235e7`)
  - Evidence: session-panel.tsx:236; quick-settings.tsx:149,220-239
  - Fix: single row; formatOutput
- **B-16** · P2 · Starting Go Live shows "Stop recording"; "Force stop" unexplained; backend recording-stop-finalize-overrun unhandled; recording.message never shown — partly fixed in #647 (S0.1 `084f3b9a`, labels while live); Force stop copy in S3.1; fixed in #647 (S0.1 `084f3b9a`, S3.1 `a069d07f`)
  - Evidence: studio-session-view.ts:136-169; use-studio.tsx:13094; recording.rs:6333
  - Fix: "Cancel livestream"; Alert; explain Force stop
- **B-17** · P2 · Session pill: recording/streaming/failed/offline same red chip; green "Ready" when blocked; not a live region — partly fixed in #647 (S1.3 `6bd8f9a2`, status pill); rest in S3.2; fixed in #647 (S1.3 `6bd8f9a2`, S3.2 `8ad74d53`)
  - Evidence: studio-session-view.ts:165-199; status-badge.tsx:33-48
  - Fix: icons per state; "Not ready"; role=status
- **B-18** · P2 · Toasts repeating Go Live dialog content ("Some destinations failed setup", "Resolve Go Live issues", output notice) — partly fixed in #647 (S2.4 `4929496f`); blocked toast kept as a warning because the server verdict can differ; rest in S3.4; fixed in #647 (S2.4 `4929496f`, S3.4 `cf2da9d9`; the output-adjusted toast stays in the start path)
  - Evidence: use-studio.tsx:13036,13840,13859
  - Fix: remove
- **B-19** · P2 · Readiness computed twice (page "2 of 2 ready" vs dialog "Blocked"); Broadcast info fields twice with different validation — fixed in #647 (S3.4 `cf2da9d9`)
  - Evidence: go-live-panel.tsx:209-245,765; go-live-dialog.tsx:190-273,549
  - Fix: BroadcastInfoFields; shared readiness words; "Go live…" at end of checklist
- **B-20** · P2 · Three scene-card looks + three selected markers (built-in, saved "✓ Applied", vertical leg, Assets green icon); disabled reason title-only and misleading ("unavailable. Choose a replacement." when camera Off) — fixed in #647 (S3.3 `b8e235e7`)
  - Evidence: scenes-gallery.tsx:146-176; scene-presets.tsx:113-151; vertical-leg-monitor.tsx:68-82; scene-presets.ts:263; assets-tab.tsx:373
  - Fix: one SceneCard; reason line
- **B-21** · P2 · Mic picker lacks SourceSwitchStatus; two picker styles in inspector; raw "(permission-required)" in device names — partly fixed in #647 (S1.9 `819509ef`, one picker + mic status); rest in S3.3; fixed in #647 (S1.9 `819509ef`, S3.3 `b8e235e7`)
  - Evidence: microphone-section.tsx:30,69; quick-settings.tsx:387-471; source-select.tsx:126 |
- **B-22** · P2 · Jargon in start-blocking copy: "Backend socket is failed.", "Enable Record MKV, Stream RTMP…", "Checking FFmpeg…" (+34 Backend socket strings) — fixed in #647 (S2.3a `490d7f6a`)
  - Evidence: use-studio.tsx:12058-12087
  - Fix: copy table
- **B-23** · P2 · Preview stage engineering labels ("Surface proof", "Electron proof", "Tearing down the detached preview surface"); promises "stick it into this panel" w/o action; header icons duplicate body buttons (3 phrasings); "Resolve permission" vs "Enable Camera" — partly fixed in #647 (S2.3a `490d7f6a`, copy); duplicate controls in S3.3; fixed in #647 (S2.3a `490d7f6a`, S3.3 `b8e235e7`)
  - Evidence: preview-stage.tsx:147,263,406-633; studio-tab.tsx:330-359 |
- **B-24** · P2 (= V-X3) · Built-in scenes have three name tables — fixed in #647 (S1.4 `215e6585`)
  - Evidence: scenes-gallery.tsx:25; layout-tab.tsx:65; layout-framing-memory.ts:4
  - Fix: LAYOUT_PRESET_LABELS
- **B-25** · P2 · SessionRow duplicates NavigableRow; Inputs mirrors have no way home — partly fixed in #647 (S1.6a `b5e1c5b7`, row tokens); rest in S3.3; fixed in #647 (S1.6a `b5e1c5b7`, S3.3 `b8e235e7`)
  - Evidence: session-panel.tsx:419-466; quick-settings.tsx:354 |
- **B-26** · P2 · "Degraded" preview alert vague + jargon + no action — fixed in #647 (S3.2 `8ad74d53`)
  - Evidence: studio-tab.tsx:292; studio-health.ts:183 |
- **B-27** · P2 · Missing space renders "later.The instant-stream…" in Go Live dialog — fixed in #647 (S0.4a `d0dca074`)
  - Evidence: go-live-dialog.tsx:180-184 |
- **B-28** · P3 · ~25 title= on Studio, no Tooltip
  - Evidence: session-panel.tsx etc. |
- **B-29** · P3 · Hand-rolled skeletons and links; Cancel outline vs ghost; 32px segmented in 20px slot; On/Off button pair for boolean — fixed in #647 (S1.7 `466ff1e5`)
  - Evidence: studio-tab.tsx:249; session-panel.tsx:253; scenes-gallery.tsx:93,231; vertical-leg-monitor.tsx:112-137 |
- **B-30** · P3 · Regex-trimmed lowercase labels ("off", "2 q", "ready"); "Could not start." period; Open Library vs Open in Library; missing "…"; hyphen separator
  - Evidence: session-panel.tsx:273,342; go-live-dialog.tsx:365,506 |
- **B-31** · P3 · Dead startButtonLabel helpers pinned by smoke:start-labels (asserts Title Case labels no UI renders) — fixed in #647 (S2.2 `ae1e6788`)
  - Evidence: capture.ts:2771; scripts/smoke-start-labels.mjs |

**Owner decisions raised by this review:** mic mute control on Studio (muted looks same as silence); Space app-wide (keep Record on Studio only); editable Output row on stage → NavigableRow; Go Live and Stop are one session (no "end stream, keep recording"; label "End livestream & recording")

**Patterns to standardise:** disabled reasons (inline line standard); callouts → Alert; session failures → "Session notices" list + toast only when Studio hidden; fact rows → NavigableRow; readiness visuals → StatusBadge; formatOutput; SceneCard; Tabs/ToggleGroup/Switch; permission fix button labels by action; session status words; one inspector picker; explicit short labels (no regex).

## Area C — Sources, Scene editor, Assets

- **C-1** · P0 ✔ · Takeover Delete: red icon button deletes takeover + stored image file, no confirm/undo; toast "Deleted Screen." — fixed in #647 (S0.3 `1aeee1f1`)
  - Evidence: takeover-screens-section.tsx:72,220-231; use-studio.tsx:11433; storage.rs:6386
  - Fix: KebabMenu + confirm; toast names it
- **C-2** · P1 ✔ · Assets Import fails on every default profile (all 10 slots prefilled 'ready'; firstEmptySlotId finds none) → toast points to hover-only ⋯ — fixed in #647 (S0.4b `355a1d4c`)
  - Evidence: background-assets.ts:143-150,333; assets-tab.tsx:130-176,390
  - Fix: file picker → "Replace which background?"; or disable with rule
- **C-3** · P1 · Renames + style edits of built-in backgrounds lost on relaunch (reconcile drops stored built-in records) — fixed in #647 (S0.4b `355a1d4c`)
  - Evidence: background-assets.ts:574,650; assets-tab.tsx:399,404,526
  - Fix: merge stored name/styleDefaults; test
- **C-4** · P1 · One preset click (Scene or Studio gallery) destroys a Freeform layout; Freeform re-seeds from preset; no confirm/undo — partly fixed in #647 (S0.4b `355a1d4c`, Freeform memory); undo in S3.9; fixed in #647 (S3.9 `c3cf6b59`, single-level ⌘Z)
  - Evidence: layout-tab.tsx:221-344; use-studio.tsx:9234
  - Fix: remember freeform overrides per orientation, or confirm
- **C-5** · P1 · Scene inspector FieldSet disabled+inert on every change → keyboard focus lost after each toggle/commit/nudge; whole column dims — fixed in #647 (S3.9 `c3cf6b59`)
  - Evidence: layout-tab.tsx:145-156,486-490; use-studio.tsx:8888
  - Fix: inert only for pointer gestures; restore focus
- **C-6** · P1 · Overlay changes (Show on stream/in recording, snaps, drag) fail silently (.catch(() => {})) → streamer may believe Buddy/captions are on stream — fixed in #647 (S0.4b `355a1d4c`)
  - Evidence: layout-tab.tsx:181-195; overlay-stage.ts:132; use-studio.tsx:2645
  - Fix: reportError; disable with reason when disconnected
- **C-7** · P1 · OBS import report false about background (dropped when no slot; never applied); failed read/discovery stuck "Reading…/Looking for OBS…" forever — fixed in #647 (S0.4b `355a1d4c`)
  - Evidence: obs-import-map.ts:358; obs-import-dialog.tsx:72-115,171-189,262
  - Fix: truthful report; apply; error states
- **C-8** · P1 · Raw device statuses in pickers ("C920 (permission-required)", "· ScreenCaptureKit display discovery failed…"); every backend warning → Alert title (quotes helper exe path); duplicate alerts; curated alert omits "quit and reopen" — partly fixed in #647 (S1.9 `819509ef`, item renderer); alerts in S3.8; fixed in #647 (S3.8 `1fd8befe`)
  - Evidence: source-select.tsx:126; source-select-searchable.tsx:166; quick-settings.tsx:462; sources-tab.tsx:166-193; screen_capture.rs:546; devices.rs:177
  - Fix: shared item renderer; curated alerts; rest → Health
- **C-9** · P1 · Three device picker implementations (filled Select 28px "None" / outline Button+Command 40px rows / inline Select "Off") side by side — fixed in #647 (S1.9 `819509ef`)
  - Evidence: source-select.tsx:96-133; source-select-searchable.tsx:67-180; quick-settings.tsx:387-470
  - Fix: one DevicePicker
- **C-10** · P1 · Fix-it reasons only in title= (source chip hints "No fresh frames…", locked preset reason on pointer-events-none item, truncated stage hint) — fixed in #647 (S3.8 `1fd8befe`)
  - Evidence: sources-tab.tsx:38-67; video-preset-select-items.tsx:96; scene-stage.tsx:1028
  - Fix: visible role=status line
- **C-11** · P1 · No visible keyboard focus on background tiles (outline clipped by overflow-hidden parent) — fixed in #647 (S3.10 `31c121b0`)
  - Evidence: assets-tab.tsx:331-352; styles.css:729
  - Fix: inset ring via has-[>button:focus-visible]
- **C-12** · P1 · Removing a non-applied imported background is immediate; asset pruned next load — fixed in #647 (S0.3 `1aeee1f1`)
  - Evidence: assets-tab.tsx:212-219; background-assets.ts:398,619
  - Fix: confirm or Undo
- **C-13** · P2 · Switched-off overlays (Captions/Buddy default off) drawn identical to on ones on stage — fixed in #647 (S3.9 `c3cf6b59`)
  - Evidence: overlay-layout.ts:116,283; overlay-stage.ts:51; scene-stage.tsx:919
  - Fix: "off" badge + dim
- **C-14** · P2 · Four permission-recovery styles on Sources; none for microphone ("Check Settings → Permissions." text) — fixed in #647 (S3.8 `1fd8befe`)
  - Evidence: sources-tab.tsx:172-219; sources-audio-mixer.tsx:679; mic-meter-input.ts:75
  - Fix: one flush Alert per permission
- **C-15** · P2 · Layout preset row = raw aria-pressed buttons (no group name, no roving, cursor-not-allowed); Freeform looks like a 5th preset — partly fixed in #647 (S1.7 `466ff1e5`, segmented controls); rest in S3.9; fixed in #647 (S1.7 `466ff1e5`, S3.9 `c3cf6b59`; Freeform stays a text toggle the smoke clicks)
  - Evidence: layout-tab.tsx:319-344; recording-tab.tsx:171
  - Fix: ToggleGroup + separate Freeform toggle
- **C-16** · P2 · Inspector segmented controls unnamed; labels "Top L/Bot R", "S/M/L", "Rect/Round", "Wide" (wrong for portrait camera); corners named 2 ways — partly fixed in #647 (S0.5 `e0140afc`, accessible names); rest in S3.9; fixed in #647 (S3.9 `c3cf6b59`)
  - Evidence: layout-tab.tsx:527-896; assets-tab.tsx:500; ui/field.tsx:86
  - Fix: aria-labelledby; full words
- **C-17** · P2 · Takeover reorder drag-only (WCAG 2.1.1/2.5.7); dropped image files silently ignored on both galleries — partly fixed in #647 (S3.10 `31c121b0`, keyboard reorder); file drop deferred: it needs a preload/main IPC the plan doesn't name
  - Evidence: takeover-screens-section.tsx:15-165; assets-tab.tsx
  - Fix: Move earlier/later; file drop import
- **C-18** · P2 · "Reset camera settings" resets 18 values instantly, even live; no undo — fixed in #647 (S0.3 `1aeee1f1`)
  - Evidence: layout-tab.tsx:946-981
  - Fix: confirm or Undo
- **C-19** · P2 (= D-35) · Amber status text (camera shortfall, System audio issues, preset items) — fixed in #647 (S1.8 `df1a6513`; Sources sites already fixed by #653)
  - Evidence: sources-tab.tsx:278; sources-audio-mixer.tsx:680-698; video-preset-select-items.tsx:95
  - Fix: Alert warning
- **C-20** · P2 (= B-24) · Layout preset names x3; "layouts" vs "scenes" in adjacent hints — fixed in #647 (S1.4 `215e6585`)
  - Evidence: layout-tab.tsx:64,352; scenes-gallery.tsx:24; layout-framing-memory.ts:3
  - Fix: LAYOUT_PRESET_LABELS
- **C-21** · P2 ✔ (visual) · Scene hints send users to Studio for devices (home is Sources); OBS notes contradict; no links; "No sources in the scene yet" no next step — fixed in #647 (S3.9 `c3cf6b59`)
  - Evidence: layout-tab.tsx:350-359; obs-import-map.ts:419; scene-stage.tsx:1012
  - Fix: "Pick … in Sources" + Open Sources
- **C-22** · P2 · "Scene layout is locked while live" while most controls work live; Visible in scene disabled w/o reason — fixed in #647 (S3.9 `c3cf6b59`)
  - Evidence: layout-tab.tsx:760,983-1090 |
- **C-23** · P2 · Orientation toggle + vertical Screen framing only in Studio; "Modified" saved scene w/o Update on Scene page — fixed in #647 (S3.9 `c3cf6b59`)
  - Evidence: layout-tab.tsx:62,238; scenes-gallery.tsx:80-186; scene-presets.tsx:81-195
  - Fix: bring onto Scene page
- **C-24** · P2 · Camera/mic pickers always show "None" — never "Finding devices…"/"No camera found"; searchable popup shows two status lines — fixed in #647 (S1.9 `819509ef`)
  - Evidence: source-select.tsx:103-113; source-select-state.ts:8; source-select-searchable.tsx:135 |
- **C-25** · P2 · Takeover tiles: green Ready badge on healthy tiles; amber "Active" (vs green ring on backgrounds); prints internal file path; 4:3 previews; "Upload" primary; doesn't say takeover mutes mic — fixed in #647 (S3.10 `31c121b0`)
  - Evidence: takeover-screens-section.tsx:41-215; screen-takeover-microphone.ts:20 |
- **C-26** · P2 · Orphan "Current scene background" row between sections; bare div not PageStack; "10 slots"; same icon for both sections; file types not stated — fixed in #647 (S3.10 `31c121b0`)
  - Evidence: assets-tab.tsx:161-286 |
- **C-27** · P2 · "Sync" no direction; jargon ("structural default", "paired flash/click measurement") — fixed in #647 (S3.8 `1fd8befe`)
  - Evidence: sources-audio-mixer.tsx:245,402; capture.ts:1541,1571
  - Fix: "Mic sync" + direction
- **C-28** · P2 · "Reveal in Finder" (on Windows too) with eye icon; "Show Capture Helper" with upload icon — fixed in #647 (S3.10 `31c121b0`)
  - Evidence: assets-tab.tsx:412; sources-tab.tsx:187,213
  - Fix: revealInFileManagerLabel + FolderIcon
- **C-29** · P2 · OBS selects unlabelled ("Untitled" both); toast refers to closed report; log-like notes; button with 2 icons; overflow-y-auto not ScrollArea — fixed in #647 (S0.4b `355a1d4c`)
  - Evidence: obs-import-dialog.tsx:188-305; obs-import-map.ts:232-419 |
- **C-30** · P2 · "this Mac" in echo warning on Windows — partly fixed in #647 (S1.4 `215e6585`, platform copy); rest in S3.8; fixed in #647 (S3.8 `1fd8befe`)
  - Evidence: system-audio.ts:125 |
- **C-31** · P2 · No arrow-key/Shift nudge on stage (copy says "nudge with the arrows"); large step exists unused — fixed in #647 (S3.9 `c3cf6b59`)
  - Evidence: scene-stage.tsx:325; layout-tab.tsx:1042-1087; use-studio.tsx:8357 |
- **C-32** · P2 · Sources Refresh runs a 13-request full backend refresh; any unrelated failure leaves devices stale — fixed in #647 (S3.8 `1fd8befe`)
  - Evidence: sources-tab.tsx:148; use-studio.tsx:8040-8112
  - Fix: device-only refresh
- **C-33** · P3 · 12.5px sub-labels; 3 small-label recipes on one page — partly fixed in #647 (S1.6a `b5e1c5b7`, tokens); rest in S3.9; fixed in #647 (S3.9 `c3cf6b59`)
  - Evidence: layout-tab.tsx:371,516,773,854; source-transform-fields.tsx:82 |
- **C-34** · P3 · Schematic stage sources unlabelled (Windows/Linux, preview detached) — fixed in #647 (S3.9 `c3cf6b59`)
  - Evidence: scene-stage.tsx:785-858 |
- **C-35** · P3 ✔ (visual) · Source name repeated under its own title in inspector — fixed in #647 (S3.9 `c3cf6b59`)
  - Evidence: layout-tab.tsx:494,996 |
- **C-36** · P3 · Rename toast (routine); "Deleted Screen." — fixed in #647 (S2.4 `4929496f`)
  - Evidence: use-studio.tsx:11412,11435 |
- **C-37** · P3 · Jargon: "Vertical leg", "Its width is the rect", "Snap (horizontal)"; one-shot snaps as ToggleGroup; "Alt / ⌥" — partly fixed in #647 (S1.7 `466ff1e5`, snaps as buttons); keys in S1.2, copy in S2.3a; fixed in #647 (S1.2, S1.7, S2.3a `490d7f6a`)
  - Evidence: layout-tab.tsx:435,1139,1180-1196; scene-stage.tsx:1034 |
- **C-38** · P3 · "Monitoring" idle state (no monitor bus); echo-guard label footnote; gain reset double-click only — partly fixed in #647 (S2.3a `490d7f6a`); gain reset still double-click only; fixed in #647 (S2.3a, S3.8 `1fd8befe`: the readout resets gain)
  - Evidence: mic-visual-gate.ts:43; sources-audio-mixer.tsx:667; fader.tsx:209 |
- **C-39** · P3 (= A-6) · capitalize in StatusBadge — fixed in #647 (S1.3 `6bd8f9a2`)
  - Evidence: status-badge.tsx:58 |
- **C-40** · P3 · Tile overrides (h-6 input, glass-float on in-window buttons); full-resolution images as thumbnails — fixed in #647 (S3.10 `31c121b0`)
  - Evidence: assets-tab.tsx:402,444,490; index.ts:14052 |

**Owner decisions raised by this review:** Calibrate in packaged builds (can't feed JSON → hide); flat System audio meter between sessions (state line); no undo in scene editor (single-level ⌘Z); ten fixed prefilled background slots (ask which to replace / extra user slots)

**Patterns to standardise:** DevicePicker; segmented choice (ToggleGroup named; Tabs for pages; Buttons for actions); "in use" state on picture cards (4 variants → ring + neutral chip); card actions (KebabMenu standard); adding an image ("Import image…"); reveal in file manager; why unavailable (visible line/Alert; ShortcutTooltip model); Reset ("Reset {label}", multi-value confirm); small labels 11/600; Empty; PageStack; vocabulary (None/Off, Takeover/Screen, Vertical leg/stream, layout names, Level/gain, "Backend socket" x39); docs vs code (Sources only device home; Screens on Scene page).

## Area D — Livestream, scheduling, Output, Captions

- **D-1** · P0 ✔ · Output Width/Height/FPS/Bitrate commit per keystroke and transpose (typing "2560" in Width → 1080×2) — fixed in #647 (S0.4a `d0dca074`)
  - Evidence: recording-tab.tsx:262-269; use-studio.tsx:14333; capture.ts:209
  - Fix: local draft, commit on blur/Enter, clamp, never transpose typed value; test
- **D-2** · P0 ✔ · Unlabelled controls (FieldLabel w/o htmlFor): Output number fields, Default privacy, Privacy, Made for kids ToggleGroup, category result selects, YouTube Channel select — fixed in #647 (S0.5 `e0140afc`)
  - Evidence: recording-tab.tsx:260; streaming-tab.tsx:520,680,808,831,885; destination-card.tsx:1077; ui/field.tsx:86
  - Fix: id/htmlFor; aria-label; lint/test FieldLabel htmlFor
- **D-3** · P1 · Output "Recording quality" header switch = "Save local recording" (aria only); off → stream-only, fields stay enabled — fixed in #647 (S3.6 `06caf5d1`)
  - Evidence: recording-tab.tsx:57-70
  - Fix: labelled settings row
- **D-4** · P1 · "Stop all" in failure banner ends every destination + recording, no confirm; Studio calls it "End livestream" — fixed in #647 (S0.1 `084f3b9a`)
  - Evidence: streaming-tab.tsx:396-401,216
  - Fix: "End livestream" + confirm
- **D-5** · P1 · "Metadata ready" green chip shown for unvalidated edits (validation nulled per edit); "metadata" jargon — fixed in #647 (S3.5b `21159948`)
  - Evidence: streaming-tab.tsx:594-606; use-studio.tsx:11966
  - Fix: 3 states; "Unsaved changes"
- **D-6** · P1 · Copy says "Go Live in Studio" but button says "Stream"; "Recording → Output"; "Open Live"/"Open Recording" — fixed in #647 (S2.2 `ae1e6788`)
  - Evidence: scheduled-streams.tsx:306,345; go-live-dialog.tsx:446; performance-check.ts:155; studio-tab.tsx:386-396
  - Fix: match UI names
- **D-7** · P1 · Go Live dialog uses OAuth/Manual RTMP (owner D2 said Sign in/Stream key), 3 labels for "use stream key", 9 tinted boxes, Title Case "Continue With Ready"/"Resolve Blockers First" — partly fixed in #647 (S2.2 `ae1e6788`, labels and badges); rows and Alerts in S3.4; fixed in #647 (S2.2 `ae1e6788`, S3.4 `cf2da9d9`)
  - Evidence: go-live-dialog.tsx:557,581,378,545,411,416; obs-import-map.ts:454
  - Fix: ListRow anatomy; Alert; sentence case
- **D-8** · P1 · Studio Output row keeps 6 Mbps when picking 4K; Output page sets 30 Mbps (same option list) — fixed in #647 (S0.4a `d0dca074`)
  - Evidence: quick-settings.tsx:229 vs recording-tab.tsx:177
  - Fix: one pickRecordingResolution()
- **D-9** · P1 · Caption blockers (30 fps, shared profile) only surface in Go Live dialog — fixed in #647 (S3.4 `cf2da9d9`)
  - Evidence: captions-preflight.ts:40; go-live-panel.tsx:236
  - Fix: checklist row + Captions Alert + description
- **D-10** · P1 · Captions Premium lock after the switch; Style/Text size/Language stay enabled — fixed in #647 (S3.7 `54f561c1`)
  - Evidence: captions-controls.tsx:224-365
  - Fix: LockAlert leads; disable
- **D-11** · P1 · Schedule dialog primary disabled with 6 silent rules — fixed in #647 (S3.5b `21159948`)
  - Evidence: schedule-stream-dialog.tsx:184-193,583
  - Fix: per-field reasons
- **D-12** · P1 · Destination row: Switch nested inside role=button row — fixed in #647 (S0.5 `e0140afc`)
  - Evidence: destination-card.tsx:309-348
  - Fix: CollapsibleTrigger + sibling Switch
- **D-13** · P2 · Premium/limit lock shown 6 ways (incl. Premium toast for a non-Premium gate); Output quality + Upcoming ignore livestream lock — partly fixed in #647 (S1.5 `905ea8fe`, LockAlert); rest in S3.5a; fixed in #647 (S1.5, S3.5a `88d5c501`, S3.5b `21159948`)
  - Evidence: streaming-tab.tsx:206; recording-tab.tsx:140; captions-controls.tsx:232; go-live-dialog.tsx:281; video-preset-select-items.tsx:94; session-runtime-recovery.ts:516
  - Fix: shared LockAlert (from BuddyUnlockAlert)
- **D-14** · P2 · 5-destination cap sentence repeated under every off row (2px rule); not in description; 3 forms auto-expand — fixed in #647 (S3.5a `88d5c501`)
  - Evidence: destination-card.tsx:207,355,239
  - Fix: description + one Alert at cap
- **D-15** · P2 · "Locked while live" 3 forms; Livestream understates ("credentials") — fixed in #647 (S3.5a `88d5c501`)
  - Evidence: streaming-tab.tsx:219; recording-tab.tsx:72; captions-controls.tsx:356
  - Fix: one Alert
- **D-16** · P2 · Disconnect instant (signs out YouTube + YouTube Vertical); "Approve in browser" as success toast; Connect no pending state — partly fixed in #647 (S0.3 `1aeee1f1`, disconnect confirm); pending state in S3.5a, browser-step toast in S2.4; fixed in #647 (S0.3, S2.4, S3.5a `88d5c501`)
  - Evidence: destination-card.tsx:1029-1044; use-studio.tsx:11550,11621,6068
  - Fix: confirm; waiting state
- **D-17** · P2 · "Quality override" tag hidden on horizontal quiet rows — fixed in #647 (S3.5a `88d5c501`)
  - Evidence: destination-card.tsx:314-326 |
- **D-18** · P2 · Broadcast info rows for all platforms regardless of use; thumbnail picker enabled when unusable — fixed in #647 (S3.5b `21159948`)
  - Evidence: stream-metadata-summary.ts:48; streaming-tab.tsx:503 |
- **D-19** · P2 · Server URL not validated until start — fixed in #647 (S3.5a `88d5c501`)
  - Evidence: destination-card.tsx:483; capture.ts:2028 |
- **D-20** · P2 · "Where to find your key" only for TikTok/Instagram/Kick; links styled 2 ways — fixed in #647 (S3.5a `88d5c501`)
  - Evidence: destination-card.tsx:714,587,1170 |
- **D-21** · P2 · Title/privacy/audience rules + labels differ across Broadcast info / Go Live / Schedule ("Privacy" vs "Visibility"; ToggleGroup vs Select) — partly fixed in #647 (S3.4 `cf2da9d9`, BroadcastInfoFields in Go Live); Livestream page and Schedule dialog in S3.5b; fixed in #647 (S3.4 `cf2da9d9`, S3.5b `21159948`)
  - Evidence: streaming-tab.tsx:476,520,829; schedule-stream-dialog.tsx:186,471,490
  - Fix: shared fields
- **D-22** · P2 · Video quality: 8+ spellings; "Output quality" vs Output page; "choose a stream-safe preset" w/o such option; "independent of recording" false on shared encode — fixed in #647 (S1.4 `215e6585`)
  - Evidence: output-quality.ts:5; capture.ts:749; go-live-panel.tsx:271,524,742; performance-check.ts:134; studio-session-view.ts:48; entitlement-ui.ts:186
  - Fix: formatVideoQuality()
- **D-23** · P2 · Essential reasons in title= (stream check failure, per-destination qualities, provider validation)
  - Evidence: go-live-panel.tsx:312,274; destination-card.tsx:1014 |
- **D-24** · P2 · Checklist links don't move focus; ~20px targets; FFmpeg row no action — fixed in #647 (S3.5a `88d5c501`)
  - Evidence: streaming-tab.tsx:185; go-live-panel.tsx:249,290 |
- **D-25** · P2 · Captions reader title 12px subtle; hand-rolled dot; body ignores status; 3 window names — partly fixed in #647 (S1.6b `1bd4865c`, WindowHeader); rest in S3.7; fixed in #647 (S3.7 `54f561c1`)
  - Evidence: captions-reader.tsx:61-99; index.ts:3846
  - Fix: WindowTitleBar; StatusDot
- **D-26** · P2 · Captions status vocab x3 (Armed/Listening vs Live/Waiting vs Idle); green "Live" chip in preview — fixed in #647 (S2.3a `490d7f6a`)
  - Evidence: captions-controls.tsx:67; quick-settings.tsx:51; captions-reader.tsx:182; caption-preview.tsx:52
  - Fix: captionsStatusView()
- **D-27** · P2 · Captions page: mic unnamed; "Realtime"/"Live transcription" jargon; Scene placement path w/o link; min vs credits units — fixed in #647 (S3.7 `54f561c1`)
  - Evidence: captions-controls.tsx:254-266,381
  - Fix: NavigableRows
- **D-28** · P2 · Output: Resolution raw buttons not ToggleGroup; recording presets list includes stream/legacy presets; "Tutorial 1080p30"; folder not shown/linked — partly fixed in #647 (S1.7 `466ff1e5`, resolution tiles); rest in S3.6; fixed in #647 (S3.6 `06caf5d1`)
  - Evidence: recording-tab.tsx:167; video-preset-select-items.tsx:39; capture.ts:749 |
- **D-29** · P2 · Livestream Setup/Upcoming strip scrolls away; last view not remembered — fixed in #647 (S1.6b `1bd4865c`)
  - Evidence: app-shell.tsx:464; streaming-tab.tsx:55-73
  - Fix: pin like Settings
- **D-30** · P2 · Twitch/Kick category = Input + Search + Select (typed Twitch text shown as chosen); language free text "en" — fixed in #647 (S3.5b `21159948`)
  - Evidence: streaming-tab.tsx:646-906
  - Fix: CategoryCombobox
- **D-31** · P2 · Schedule: always-visible DST offset field; raw IANA zones; noisy time line; p-4 sm:p-6 override — fixed in #647 (S3.5b `21159948`)
  - Evidence: schedule-stream-dialog.tsx:409-451,281 |
- **D-32** · P2 · Upcoming labels: "Delete local draft?"→"Confirm cancellation" (doesn't delete); "Recover an unknown create"; dead-end select — fixed in #647 (S3.5b `21159948`)
  - Evidence: scheduled-streams.tsx:199-330 |
- **D-33** · P2 · Scheduling errors shown as neutral Alerts — fixed in #647 (S3.5b `21159948`)
  - Evidence: schedule-stream-dialog.tsx:561; scheduled-streams.tsx:540 |
- **D-34** · P2 · Refresh no feedback; refresh-on-focus re-reads every event (quota); History toggle labelled by other view — fixed in #647 (S3.5b `21159948`)
  - Evidence: scheduled-streams.tsx:106-118; use-scheduled-streams.ts:72
  - Fix: throttle; Tabs Upcoming/Past
- **D-35** · P2 · Coloured status text (text-warning etc.) — fixed in #647 (S1.8 `df1a6513`)
  - Evidence: go-live-panel.tsx:422; recording-tab.tsx:105; video-preset-select-items.tsx:95; recording-settings.tsx:112; go-live-dialog.tsx:283
  - Fix: icon/Badge carries tone
- **D-36** · P3 · "X / Twitter" vs "X"; "Custom" vs "Custom RTMP"; "saving it to tiktok."; ellipses on progress labels; "Stopped" vs "Failed" — partly fixed in #647 (S1.4 `215e6585`); the "X / Twitter" default lives in Rust and saved configs (S2.3a); fixed in #647 (S1.4 `215e6585`, S2.3a `490d7f6a`: Rust default "X", saved "X / Twitter" shown as "X")
  - Evidence: capture.ts:535; stream-key-format.ts:31
  - Fix: platformLabel()
- **D-37** · P3 · rounded-[6px]; ListRow h-auto min-h-10; border-l-2; p-4 sm:p-6; hand-copied grouped classes; hand-built h3 — fixed in #647 (S3.5a `88d5c501`)
  - Evidence: platform-glyph.tsx:91; destination-card.tsx:310,359 |
- **D-38** · P3 · Every Alert role=alert (assertive on mount) — fixed in #647 (S1.5 `905ea8fe`)
  - Evidence: ui/alert.tsx:33
  - Fix: role=status default
- **D-39** · P3 · Stream key saves on blur (can pop modal); key ending shown twice — fixed in #647 (S3.5a `88d5c501`)
  - Evidence: destination-card.tsx:546
  - Fix: Save key button

**Owner decisions raised by this review:** rename Studio "Stream" → "Go Live…" (every other surface says Go Live); NavigableRow "Go live from Studio" under checklist; Upcoming "Go Live…" → "Use for Go Live…"; fixed eight destinations → "Add destination" catalog

**Patterns to standardise:** platformLabel(); formatVideoQuality(); LockAlert; locked-while-live Alert; captionsStatusView(); WindowTitleBar 13/600 (main 14/600, Notes 13/600, SM 12/500, Captions 12/500 subtle); PinWindowButton; external links Button link + ExternalLinkIcon, 5 copies of openExternalUrl; Alert for warnings; status chip roles; Popover+Command pickers; AlertDialog missing; ConfigGrid uneven-columns variant (streaming 1.5fr/1fr; captions 1.2fr/0.8fr); Tabs vs ToggleGroup rule; one start/stop verb pair (Stream / Confirm Go Live / Go live-end stream / End livestream / Stop all / Go Live…); success toasts for visible actions.

## Area E — Library, player, markers, Clean cut

- **E-1** · P0 ✔ · Library Recordings/Streams filters never match current sessions — fixed in #647 (S0.4a `d0dca074`)
  - Evidence: lib/library-view.ts:23-25 vs backend modes record/stream/record+stream (recording.rs:22517) ; tests use stale fixtures
  - Fix: shared mode-set helper; fix fixtures
- **E-2** · P0 ✔ · Delete confirm says "You can restore them from the DeleteIcon." + false restore promise (entry, markers, Buddy report, chat, clean-cut jobs are deleted) — fixed in #647 (S0.3 `1aeee1f1`)
  - Evidence: library-tab.tsx:502
  - Fix: rewrite copy; guard test for /\b[A-Z]\w+Icon\b/ in strings
- **E-3** · P0 · Slider thumb has no accessible name; player scrubber announces raw ms — fixed in #647 (S0.5 `e0140afc`)
  - Evidence: ui/slider.tsx:20-45 (aria-label on Root), session-player.tsx:483
  - Fix: forward aria-label/valuetext to Thumb (4 call sites)
- **E-4** · P1 · Library unaware of Clean cut jobs (no status, actions enabled then backend refuses) — fixed in #647 (S3.11 `3c129b55`)
  - Evidence: library-tab.tsx:796 fileActionsBusy
  - Fix: activeCleanCutSourceIds; status chip
- **E-5** · P1 · Unsaved Clean cut edits lost on tab/page switch; review not re-keyed on target change — fixed in #647 (S3.13 `e0c3763a`)
  - Evidence: buddy-tab.tsx:183-186 key={current}; clean-cut-review.tsx:165
  - Fix: leave guard on all exits; per-job draft store; key by target
- **E-6** · P1 · "Allow it under Customize." points to nonexistent tab (also Buddy Live string) — fixed in #647 (S2.3b `21073ea6`)
  - Evidence: clean-cut-view.ts:87-88; buddy-tab-view.ts:120-121
  - Fix: Alert with "Allow cloud AI" action
- **E-7** · P1 · Marker pins not on scrubber axis; pile at 100% while loading — fixed in #647 (S3.12 `e4f8da11`)
  - Evidence: marker-pins.tsx:26; session-player.tsx:364-370
  - Fix: overlay pins on track; render when duration>0
- **E-8** · P1 · Marker delete instant, irreversible, can't be recreated — fixed in #647 (S0.3 `1aeee1f1`; the deferred delete runs when the Markers dialog closes); fixed in #647 (S0.3 `1aeee1f1`; S3.12 `e4f8da11` made the deferred delete follow the toast)
  - Evidence: session-markers-dialog.tsx:195-203
  - Fix: undo toast (marker-toast pattern)
- **E-9** · P2 · Markers list hand-rolled; selection invisible; raw "voice/manual"; rename form detached; no maxLength — fixed in #647 (S3.12 `e4f8da11`)
  - Evidence: session-markers-dialog.tsx:167-235
  - Fix: GroupedList/ListRow; inline rename
- **E-10** · P2 · Markers dialog overflows short windows — fixed in #647 (S3.12 `e4f8da11`)
  - Evidence: session-markers-dialog.tsx:135 max-h-[90vh] grid
  - Fix: flex col + ScrollArea
- **E-11** · P2 · Markers dialog uses stale session snapshot (playability never re-checked) — fixed in #647 (S3.12 `e4f8da11`)
  - Evidence: library-tab.tsx:147,409
  - Fix: pass id, read live row
- **E-12** · P2 · Library→Clean cut→Library round trip has no way back; "Clean cut" noun as action; same ClipIcon for Markers — fixed in #647 (S3.13 `e0c3763a`)
  - Evidence: library-tab.tsx:962-970; clean-cut-review.tsx:491
  - Fix: origin:'library'; "Make a clean cut…"
- **E-13** · P2 · Clean cut consent dialog lists 5 Buddy bullets; retention in text-subtle — fixed in #647 (S2.3b `21073ea6`)
  - Evidence: clean-cut-consent-dialog.tsx:46-60
  - Fix: reframe copy
- **E-14** · P2 · Transcript lacks follow-playback, cut-selection, undo — fixed in #647 (S3.13 E-14 `936c8fa0`; cut selection in Clean mode only)
  - Evidence: clean-cut-transcript.tsx:120; clean-cut-review.ts:226
  - Fix: L
- **E-15** · P2 · Transcript a11y: role=button spans unfocusable; no live region — fixed in #647 (S3.13 `e0c3763a`)
  - Evidence: clean-cut-transcript.tsx:332-414
  - Fix: live region; role=status
- **E-16** · P2 · Library rows not desktop-like (no arrows/click select/dbl-click/context menu); 3-4 tab stops/row — fixed in #647 (S3.11 `3c129b55`)
  - Evidence: library-tab.tsx:571-588
  - Fix: roving focus + ContextMenu
- **E-17** · P2 · Search/sort/filter only over loaded 50 rows; "Oldest" reverses page — fixed in #647 (S3.11 `3c129b55`)
  - Evidence: use-studio.tsx:575; library-view.ts:34-48
  - Fix: backend params or partial notice
- **E-18** · P2 · Bulk delete includes hidden selected rows; confirm names none; no indeterminate — fixed in #647 (S3.11 `3c129b55`)
  - Evidence: library-tab.tsx:144,340,496
  - Fix: prune; name titles
- **E-19** · P2 · Background noise-cleanup completion resets user filter/search — fixed in #647 (S3.11 `3c129b55`)
  - Evidence: library-tab.tsx:156-160,228-241
  - Fix: only when no filter
- **E-20** · P2 · Four time formats (02:05 / 1 hour and 2 minutes / 00:02:05 / 2:05) — fixed in #647 (S1.4 `215e6585`)
  - Evidence: format.ts:48; session-player-view.ts:32; session-markers.ts:233; clip-marks.ts:4
  - Fix: one formatTimecode
- **E-21** · P2 · "MP4" painted as green success chip — fixed in #647 (S3.11 `3c129b55`)
  - Evidence: library-tab.tsx:639
  - Fix: outline tag
- **E-22** · P2 · Library toast discipline (queued toast duplicates row; import no feedback; rename error toast while dialog open) — fixed in #647 (S2.4 `4929496f`)
  - Evidence: library-tab.tsx:906,759,205,167
  - Fix: focus new row; FieldError
- **E-23** · P2 · title= tooltips for failure reasons / disabled reasons / shortcuts
  - Evidence: library-tab.tsx:635,303,922; clean-cut-\*
  - Fix: Tooltip+Kbd; visible failure line
- **E-24** · P2 · Review footer shows only "Failed" — fixed in #647 (S3.13 `e0c3763a`)
  - Evidence: clean-cut-review.tsx:642
  - Fix: detail + Retry
- **E-25** · P2 · Auto clean cut silently skips; toast action "Open Buddy" — fixed in #647 (S3.13 `e0c3763a`)
  - Evidence: clean-cut-auto.ts:149-185
  - Fix: warning toast per recording
- **E-26** · P2 · Library filter Select unnamed — fixed in #647 (S0.5 `e0140afc`)
  - Evidence: library-tab.tsx:287
  - Fix: aria-label
- **E-27** · P3 · Library row hover/selected off-token (accent/50, /60, ring, transition); paddings px-3/px-gutter/px-4; text-muted-foreground/50 — fixed in #647 (S3.11 `3c129b55`)
  - Evidence: library-tab.tsx:575,334,709
  - Fix: tokens
- **E-28** · P3 · session vs recording; Noise Cleanup/cleanup case; "Clean noise" vs "Clean cut"; "New Recording" navigates; blank column header — fixed in #647 (S3.11 `3c129b55`); fixed in #647 (S2.3a `490d7f6a`)
  - Evidence: library-tab.tsx:281,315,328,361
  - Fix: vocabulary
- **E-29** · P3 · Clean cut copy nits (loading ellipsis, "Make one from the Buddy tab" inside Buddy, back label) — fixed in #647 (S3.13 `e0c3763a`)
  - Evidence: clean-cut-review.tsx:493,548,759,769 |
- **E-30** · P3 · Player: no click-to-play, J/K/L, Home/End, mute; refusal copy without action — fixed in #647 (S3.12 `e4f8da11`)
  - Evidence: session-player-view.ts:58; session-player.tsx:333 |
- **E-31** · P3 · Clean cut lock placement differs from Chat/Voice — fixed in #647 (S3.13 `e0c3763a`)
  - Evidence: clean-cut-card.tsx:276-297 vs buddy-tab.tsx:326
  - Fix: lock strip

**Owner decisions raised by this review:** Clean cut home (proposed: move per-recording cut/review to Library; **owner 2026-10-10: no, Clean cut stays on the Buddy page**, D6/S3.13); quality column return (problem states only); review player size toggle

**Patterns to standardise:** AlertDialog missing (no ui/alert-dialog.tsx) — destructive confirms vary (Library X+"Move to Trash"; Buddy autofocus Cancel "Delete"; Scenes "Delete scene"; Assets "Remove background"; Scheduled "Keep event"; Markers none; Review Discard none). KebabMenu vs hand-rolled Library DropdownMenu. Empty variants. Quiet alert variant repeated 7x (AlertTitle font-normal text-muted-foreground). ToggleGroupItem h-6 overrides → xs size.

## Area F — The Buddy page in use (co-host pane, settings, reports, voice)

- **F-1** · P0 ✔ · Suggest cards: window capture-phase Enter/⌫ (only skips inputs/dialogs) → Enter on focused chat-row button/menu/toggle POSTS the proposed message as the streamer; mounted while pane hidden — fixed in #647 (S0.2 `da6fa229`)
  - Evidence: buddy-utterance-cards.tsx:50-66 vs removal-cards.tsx:37-82 scoping
  - Fix: reuse removalKeyAnswer; listen only while visible; reveal/unseen count
- **F-3** · P0 ✔ (upgraded from P1, consent) · Any Stream Manager behaviour toggle silently re-enables "Buddy hears you" (mic → cloud STT) — fixed in #647 (S0.2 `da6fa229`)
  - Evidence: use-studio.tsx:4680 buddyLiveSettingsPatch(command.enabled) always listen:true; comments/main.tsx:506
  - Fix: listen:true only on off→on; behaviour-only patch; test
- **F-2** · P1 · Five ways on, two meanings; pane "Off" can show while Buddy reads chat/hears mic; then no off control mid-stream — fixed in #647 (S3.14a `00dfb9dd`)
  - Evidence: comments/main.tsx:481-506; cohost-status.tsx:145; buddy-chat-controls.tsx:57,103
  - Fix: every on-path writes a mode; pressed Off writes enabled:false
- **F-4** · P1 · Buddy page leads with creation; status/consent/"Joins my streams"/Cloud AI at the bottom (temporary placement outlived S-D6) — fixed in #647 (S3.14b `bc1edee8`)
  - Evidence: buddy-tab.tsx:190-207
  - Fix: status row at top; Live tab
- **F-5** · P1 · Pointers to nonexistent "Customize", "Go to Live", "Buddy Live" — fixed in #647 (S2.3b `21073ea6`)
  - Evidence: buddy-tab-view.ts:118-121,250; clean-cut-view.ts:87; buddy-voice-commands.tsx:122; buddy-tab.tsx:420
  - Fix: rewrite + actions
- **F-6** · P1 · Say box says "on stream" but in Auto also posts to every chat as the streamer (clipped at 140 for X) — fixed in #647 (S3.14b `bc1edee8`)
  - Evidence: cohost-pane.tsx:815-819
  - Fix: mode-aware placeholder/badge/counter
- **F-7** · P1 · Viewer-reported problems ("Chat says: no audio") only visible inside Buddy pane — partly fixed in #647 (S3.2 `8ad74d53`, Studio Buddy row); rest in S3.14; fixed in #647 (S3.14c `36de1ef8`)
  - Evidence: cohost-pane.tsx:220,450; stream-manager.tsx:171-182,582
  - Fix: tab dot warn; stats bar health slot; Studio row
- **F-8** · P1 · Stream Manager Buddy pane: ~9 config blocks + two duplicate "Buddy" headers above a 192px questions list; palette-scale rows — fixed in #647 (S3.14c `36de1ef8`)
  - Evidence: stream-manager.tsx:742-821; cohost-pane.tsx:406-437,514
  - Fix: one header; list flex-1; h-row rows
- **F-9** · P1 · Truncated Cloud AI mic disclosure (title= only) next to one-click "Turn on cloud AI" (also turns on listening) — fixed in #647 (S0.2 `da6fa229`)
  - Evidence: cohost-pane.tsx:311-317; comments/main.tsx:606
  - Fix: wrapping Alert or consent dialog with CLOUD_AI_USES
- **F-10** · P2 · Buddy header (Say, Show on stream, reactions — free) hidden unless live — fixed in #647 (S3.14c `36de1ef8`)
  - Evidence: stream-manager.tsx:453,821 |
- **F-11** · P2 · Greetings on with zero templates posts nothing, says nothing — fixed in #647 (S3.14b `bc1edee8`)
  - Evidence: buddy-chat-controls.tsx:121 |
- **F-12** · P2 · Mode meanings + disabled reasons only in title=; reaction chips disabled w/o reason for Still Buddy — partly fixed in #647 (S1.1 `add86ec0`, disabled reasons); mode meanings in S1.10; fixed in #647 (S3.14a `00dfb9dd`)
  - Evidence: buddy-chat-controls.tsx:112,131-142,209; cohost-pane.tsx:841 |
- **F-13** · P2 · Proposed post doesn't show destinations; failed rows read as faded text — fixed in #647 (S3.14b `bc1edee8`)
  - Evidence: buddy-utterance-cards.tsx:83,134 |
- **F-14** · P2 · Hand-rolled notice boxes, text-[10px] "alpha", "Premium alpha" — partly fixed in #647 (S1.8 `df1a6513`, 10 px text); rest in S3.14c; fixed in #647 (S3.14c `36de1ef8`)
  - Evidence: cohost-pane.tsx:417,1205; cohost-nudge.tsx:22
  - Fix: Alert + one Badge
- **F-15** · P2 · FieldLabel htmlFor on ToggleGroup (unlabelled groups) x4 — fixed in #647 (S0.5 `e0140afc`)
  - Evidence: cohost-settings-section.tsx:217,458,482; buddy-voice-commands.tsx:184
  - Fix: aria-labelledby
- **F-16** · P2 · Voice list omits Marker command and that the Buddy's own name works — fixed in #647 (S3.14b `bc1edee8`)
  - Evidence: buddy-tab-view.ts:200-248; buddy-command-view.ts:187 |
- **F-17** · P2 · FieldDescription text-sm default vs text-xs overrides (14 vs 12px) — fixed in #647 (S1.6a `b5e1c5b7`)
  - Evidence: ui/field.tsx:138
  - Fix: 12px in grouped FieldGroup
- **F-18** · P2 · "Show on stream" means 3 things on one surface — fixed in #647 (S3.14b `bc1edee8`)
  - Evidence: cohost-pane.tsx:800,636; cohost-settings-section.tsx:482
  - Fix: "{name} on stream"
- **F-19** · P2 · "What Buddy does"/Premium lines wrong ("never acts on its own" while Auto posts; "Buddy requires Premium" over free Greetings) — fixed in #647 (S2.3b `21073ea6`)
  - Evidence: buddy-tab-view.ts:31,38,259; entitlements.ts:60 |
- **F-20** · P2 · Three status vocabularies (Off/On/Live now; "Buddy · 3 q", "paused · quota"; Studio row) — fixed in #647 (S3.14b `bc1edee8`)
  - Evidence: buddy-tab-view.ts:69; cohost-presence.ts:107-124; session-panel.tsx:335
  - Fix: one label table
- **F-21** · P2 · Report empty/loading/offline states (Loading forever offline) — fixed in #647 (S3.14b `bc1edee8`)
  - Evidence: buddy-report-card.tsx:146-200; use-buddy-report.ts:50 |
- **F-22** · P2 · Concatenated Kbd "{shift}{mod}J" → "ShiftCtrlJ" on Windows; "Ctrl↵" — fixed in #647 (S1.2 `e257d3c4`)
  - Evidence: buddy-tab.tsx:397; cohost-pane.tsx:831
  - Fix: KbdGroup
- **F-23** · P2 · Recap "Post to chat" only pre-fills composer — fixed in #647 (S3.14b `bc1edee8`)
  - Evidence: cohost-pane.tsx:1118-1149
  - Fix: "Edit in chat box"
- **F-24** · P2 · Same switch "Greet activity" vs "Greetings"; Answers/Banter in two homes — fixed in #647 (S3.14a `00dfb9dd`)
  - Evidence: buddy-greetings-section.tsx:93; buddy-chat-controls.tsx:125 |
- **F-25** · P3 · Dead code: BuddyConsentDialog "Turn on Buddy Live?", cohostChipView, CohostStatusChip — fixed in #647 (S3.14a `00dfb9dd`)
  - Evidence: buddy-tab.tsx:521; cohost-view.ts:230; comments-destination-status.tsx:126
  - Fix: delete
- **F-26** · P3 · "Buddy" vs "the Buddy" vs persona name; mic disclosure worded 3 ways — fixed in #647 (S2.3b `21073ea6`)
  - Evidence: buddy-auto-chat-view.ts:18; cohost-pane.tsx:896 |
- **F-27** · P3 · Header container query targets wrong container (hides never apply); shortcuts list misses ⇧⌫, Suggest keys, Say keys — fixed in #647 (S3.14b `bc1edee8`)
  - Evidence: cohost-pane.tsx:756,1201; shortcuts.ts:37 |
- **F-28** · P3 · Voice phrase rows hand-rolled; effect in text-subtle; phrases in title — fixed in #647 (S3.14b `bc1edee8`)
  - Evidence: buddy-voice-commands.tsx:148-164
  - Fix: ListRow

**Owner decisions raised by this review:** (1) chat mode = on switch → separate "Buddy on" + "Chat posting: Off·Suggest·Auto"; (2) first tab "Buddy" → "Character" + "Live" tabs; (3) Clean cut to Library (**owner 2026-10-10: no**, it stays on the Buddy page, D6); (4) behaviour switches in two homes → read-only chips in SM; (5) ⇧⌫ instant removal → removal card confirm (D20)

**Patterns to standardise:** window card keys (removal-card scoping standard); inline notices → Alert; one status derivation/label table; Empty; inline save failures; "View Premium"/"Turn on cloud AI" button variants (outline/xs AlertAction); lists → GroupedList+ListRow (cmdk only for kb nav, h-row); Tooltip not title; KbdGroup; CLOUD_AI_USES single consent source.

## Area G — Buddy creation and customisation flows

- **G-1** · P0 ✔ · Onboarding "Discard" (ghost, Back slot) deletes saved Buddy from account library, no confirm; look panel Discard too — fixed in #647 (S0.3 `1aeee1f1`)
  - Evidence: buddy-onboarding.tsx:416-426; buddy-look-section.tsx:181-189; backend cohost_avatar.rs:1615
  - Fix: route via delete confirm; "Delete…"; restore Back
- **G-2** · P1 · Nothing tells the streamer how to put the new Buddy on stream (Show on stream lives in Stream Manager, off by default) — fixed in #647 (S3.14b `bc1edee8`)
  - Evidence: overlay-layout.ts:119; buddy-onboarding.tsx:245-269; buddy-tab.tsx:379
  - Fix: ready Alert w/ "Open Stream Manager"; status row
- **G-3** · P1 · Example chips overwrite + immediately save a written personality — fixed in #647 (S3.15a `2addd9c7`)
  - Evidence: buddy-persona-section.tsx:328; buddy-onboarding.tsx:731,869
  - Fix: fill only empty; confirm replace
- **G-4** · P1 · Stale pointers to "Create my Buddy in the Avatar section" (removed in plan 170) — fixed in #647 (S3.15a `2addd9c7`)
  - Evidence: buddy-pet-creator.tsx:807; buddy-look-section.tsx:122; buddy-avatar-section.tsx:459
  - Fix: "New Buddy…" button
- **G-5** · P1 · Creation gates without actions (creator Alert no AlertAction; avatar Create disabled w/ text-subtle footnote; Redo disabled reason never rendered; creator tells user to use a section hidden behind it) — fixed in #647 (S3.15a `2addd9c7`)
  - Evidence: buddy-pet-creator.tsx:296; buddy-avatar-section.tsx:419-430; buddy-look-tiles.tsx:89
  - Fix: one gate model + Alert+AlertAction
- **G-6** · P1 · Consent/Save copy says Alive pictures stay local, but since plan 172 linked packs upload — fixed in #647 (S2.3b `21073ea6`)
  - Evidence: buddy-tab-view.ts:58; buddy-pet-creator.tsx:1457; backend buddy_pet_create.rs:2210
  - Fix: correct consent copy
- **G-7** · P1 · 17 bare red-text async failures, no live region; 3 treatments — fixed in #647 (S3.15b `85364e5b`)
  - Evidence: buddy-\*.tsx (list)
  - Fix: Alert destructive / FieldError
- **G-8** · P1 · Switch nested in role=button row; warnings as coloured "!" with title-only text — fixed in #647 (S0.5 `e0140afc`)
  - Evidence: buddy-greetings-section.tsx:218-230,412
  - Fix: un-nest; AlertIcon+sr-only
- **G-9** · P1 · "About you" = "Buddy notes" (two names, two homes, two editors/save models) — fixed in #647 (S3.15a `2addd9c7`)
  - Evidence: buddy-onboarding-copy.ts:74; cohost-settings-section.tsx:238; cohost-question-row.tsx:84
  - Fix: one name, one home
- **G-10** · P2 · Still/Alive segmented both navigates and changes what viewers see; switching back wears "first" pack — fixed in #647 (S3.15a `2addd9c7`)
  - Evidence: buddy-pet-settings.tsx:43-64
  - Fix: remember worn pack; draft surface
- **G-11** · P2 · Same draft worded/paced differently (About a minute vs one to three minutes; Keep this look vs Use as my Buddy; Talk vs Talking) — fixed in #647 (S3.15b `85364e5b`)
  - Evidence: buddy-look-section.tsx:118,178; buddy-onboarding-copy.ts:87,90
  - Fix: one copy object
- **G-12** · P2 · Onboarding input lost on sub-tab switch / outside click; reopen resets to step 1 — fixed in #647 (S3.15a `2addd9c7`)
  - Evidence: buddy-onboarding.tsx:141,189,320; buddy-tab.tsx:184
  - Fix: store; dirty guard
- **G-13** · P2 · Pending draft traps New Buddy at step 4 — partly fixed in #647 (S0.3 `1aeee1f1`, Back restored); rest in S3.15a; fixed in #647 (S0.3 `1aeee1f1`, S3.15a `2addd9c7`)
  - Evidence: buddy-onboarding.tsx:174-188,405
  - Fix: Start a new one
- **G-14** · P2 · Look generation not cancellable; Redo silently spends images — fixed in #647 (S3.15a `2addd9c7`)
  - Evidence: use-buddy-look.ts:86-99; buddy-look-tiles.tsx:189
  - Fix: Cancel; "Redo · 1 image"
- **G-15** · P2 · Moving Buddy has 6 names (Alive, living Buddy, pet pack, page-pet pack, pack, moves); "Buddy" used for the vision AI; 4 gate-copy families — fixed in #647 (S2.3b `21073ea6`)
  - Evidence: buddy-pet-view.ts:15,192; buddy-avatar-section.tsx:216,459; buddy-pet-creator.tsx:768,1021
  - Fix: glossary
- **G-16** · P2 · Limits/Premium/warnings in text-subtle footnotes — fixed in #647 (S1.8 `df1a6513`)
  - Evidence: buddy-onboarding.tsx:428; buddy-pet-creator.tsx:283; greetings :146,:412
  - Fix: descriptions/Alert
- **G-17** · P2 · Buddy picture in 4 recipes, 3 selection signals, cards-in-cards; hover-only personality; alt duplicates name — fixed in #647 (S3.15b `85364e5b`)
  - Evidence: buddy-library-section.tsx:431-475; buddy-look-tiles.tsx:138; assets-tab.tsx:335
  - Fix: BuddyPictureCard + Gallery
- **G-18** · P2 · Pickers: radiogroup w/o arrows; unnamed focusable tile div; no aria-current — fixed in #647 (S3.15b `85364e5b`)
  - Evidence: buddy-avatar-section.tsx:468; buddy-look-tiles.tsx:137 |
- **G-19** · P2 · Creator ⌘↵ on window fires behind dialogs/⌘K (can start paid generation) — fixed in #647 (S3.15a `2addd9c7`)
  - Evidence: buddy-pet-creator.tsx:254-264
  - Fix: scope to root
- **G-20** · P2 · No pause for looping demo/preview (WCAG 2.2.2); demo bubble text inside role=img never read — fixed in #647 (S3.15b `85364e5b`)
  - Evidence: buddy-stream-demo.tsx:70-93; buddy-pet-preview.tsx:289 |
- **G-21** · P2 · Onboarding step changes not announced; focus lost on step 4 — fixed in #647 (S3.15b `85364e5b`)
  - Evidence: buddy-onboarding.tsx:334-503 |
- **G-22** · P2 · Avatar Zoom vs Test vs bubble Zoom: three "see it big" dialogs — fixed in #647 (S3.15b `85364e5b`)
  - Evidence: buddy-avatar-section.tsx:254-362
  - Fix: fold Zoom into Test
- **G-23** · P2 · Hard-coded ⌘N + title= tooltips in Buddy surfaces — partly fixed in #647 (S1.2 `e257d3c4`, keys); tooltips in S1.10
  - Evidence: buddy-greetings-section.tsx:388,397 + 7 title=
  - Fix: displayKeyGlyph + Tooltip
- **G-24** · P3 · Library edit dialog closes before save accepted — fixed in #647 (S3.15a `2addd9c7`)
  - Evidence: buddy-library-section.tsx:358 |
- **G-25** · P3 · Copy nits (See Premium vs View Premium x9; New Buddy no ellipsis; "Not available yet"; manifest.json; back button "Buddy") — partly fixed in #647 (S2.3b `21073ea6`); casing and ellipses in S2.5
  - Evidence: |
- **G-26** · P3 · A11y nits: every Alert role=alert (assertive for info lines); FieldLabel htmlFor on ToggleGroup div; smooth scroll ignores reduced motion — partly fixed in #647 (S1.5 `905ea8fe`, Alert role); rest in S3.15b; fixed in #647 (S1.5 `905ea8fe`)
  - Evidence: ui/alert.tsx:33
  - Fix: role=status variant

**Owner decisions raised by this review:** Premium gate only at step 4 (show at step 1); primary button left at step 4; creator jargon (Reference/Pilot/Build/Review/Save, sheets, rows, pack); official golem named "Buddy" w/ kind hidden (Buddy › Buddy › Buddy); review marks session-only

**Patterns to standardise:** WizardFrame; failure display; Alert+action; one gate model; PictureCard; ToggleGroup (value) vs Tabs (view) split → document in skill; Save model (auto on change/blur, explicit only in dialogs); CharCounter; SectionLabel 11px; "Use / Use as my Buddy / Wear" verbs; one CloudAiConsentDialog; banded DialogContent variant; Empty; GroupedList reuse.

## Area H — Stream Manager window

- **H-1** · P0 ✔ (= F-1) · Suggest card window-capture Enter/⌫ posts as streamer from any focused non-text control, even when pane hidden; no test file — fixed in #647 (S0.2 `da6fa229`)
  - Evidence: buddy-utterance-cards.tsx:53-65
  - Fix: removalKeyAnswer, bubble phase, only while visible, test
- **H-2** · P0 ✔ · Live chat rows are Buttons whose aria-label replaces message content → screen readers can't read live chat — fixed in #647 (S0.5 `e0140afc`)
  - Evidence: comment-row.tsx:902-922
  - Fix: name by content (aria-labelledby), action in aria-description; later roving list
- **H-3** · P1 (= F-2) · Three "turn on" paths bypass the mode; mode reads Off while Buddy listens; Off hint "never posts" but stops Buddy entirely — fixed in #647 (S3.14a `00dfb9dd`)
  - Evidence: cohost-status.tsx:145; cohost-nudge.tsx:29; cohost-pane.tsx:314; comments/main.tsx:481-506,606
  - Fix: route on through mode; Off hint rewrite
- **H-4** · P1 · Buddy action/Clear/transport failures shown as "Custom: …" composer badges with RTMP icon (invisible when Chat pane hidden); other Buddy failures toast — fixed in #647 (S2.4 `4929496f`)
  - Evidence: comments/main.tsx:408-415,633-643,794-800; comments-destination-status.tsx:182
  - Fix: toast/inline Alert in pane
- **H-5** · P1 · Suggest cards get no badge/reveal when Buddy pane hidden; expire unseen after 45 s — fixed in #647 (S0.2 `da6fa229`)
  - Evidence: stream-manager.tsx:582-588,646-649
  - Fix: count + reveal or compact row above composer
- **H-6** · P1 · "Clear" (20px text button next to Open Preview) empties chat AND Activity, drops msg/min; no confirm/undo; tooltip misleading — fixed in #647 (S0.3 `1aeee1f1`; confirm, not Undo: restoring a cleared view needs an RPC)
  - Evidence: stream-manager-status-bar.tsx:231-241; live-chat-view.ts:354
  - Fix: confirm or Undo toast; separate; one name "Clear view"
- **H-7** · P1 · Chat pane has no keyboard model (2 tab stops per row; no composer shortcut; no hints); Buddy pane has a good one — fixed in #647 (S3.16a `aeddb652`)
  - Evidence: stream-manager.tsx:672-689; chat-pane.tsx:710; comment-row.tsx:902,934
  - Fix: roving focus, H/R/C/⇧⌫ keys, ⌘L composer, StatusBarHints
- **H-8** · P1 (= F-12) · Answers/Banter disabled, reason in title only; double dim (opacity-70) — fixed in #647 (S3.14a `00dfb9dd`)
  - Evidence: buddy-chat-controls.tsx:54,129-144,209
  - Fix: one Alert w/ action
- **H-9** · P2 (= F-10) · Buddy header (free) hidden off-air; mode control above identity; "Buddy" printed 3x — fixed in #647 (S3.14c `36de1ef8`)
  - Evidence: stream-manager.tsx:453,742,762-821; cohost-pane.tsx:416,809
  - Fix: header first; mode in header
- **H-10** · P2 · "0 msg/min" shown when chat not connected/after Clear; health "–" without reason — partly fixed in #647 (S1.4 `215e6585`, placeholders); rest in S3.16b; fixed in #647 (S3.16b `3919c3ea`)
  - Evidence: stream-manager-stats.ts:309-328,504-560
  - Fix: "–" with reason; subtle tone
- **H-11** · P2 · "Remove from chat" offered without moderate scope (then fails); fix only in Buddy pane, worded as Buddy feature — fixed in #647 (S3.16a `aeddb652`)
  - Evidence: chat-moderation.ts:125; chat-removal-view.ts:94; platform-scopes.ts:182
  - Fix: disabled with reason + Reconnect item
- **H-12** · P2 · Live chat empty says "Chat appears here once you go live" while live; icon+16px title empty — fixed in #647 (S3.16b `3919c3ea`)
  - Evidence: chat-pane.tsx:526,1015; live-chat-view.ts:433
  - Fix: branch copy; plain Empty
- **H-13** · P2 · Provider state words: "read-only" vs "receive-only"; "off" vs "Unavailable" vs "Idle" — fixed in #647 (S2.3a `490d7f6a`)
  - Evidence: stream-manager-status-bar.tsx:60,70; comments-destination-status.tsx:18,30,55,112
  - Fix: one helper, skill words
- **H-14** · P2 · One Twitch reconnect with 3 labels ("Reconnect Twitch", "Show who followed", "Reconnect"); tooltip points to Livestream → Setup; toast about follower names — fixed in #647 (S3.16b `3919c3ea`)
  - Evidence: activity-pane.tsx:204,442,487; stream-manager-status-bar.tsx:101; comments/main.tsx:680 |
- **H-15** · P2 · Stats hover cards not focusable; customisation right-click only; provider details title-only; <640 failed provider = red dot only; Buddy tab state colour-only — fixed in #647 (S3.16b `3919c3ea`)
  - Evidence: stats-bar.tsx:146-204,319; stream-manager-status-bar.tsx:158-179; stream-manager.tsx:963 |
- **H-16** · P2 · 73 title= in window, zero Tooltip; removal outcome/highlight failure (cleared after 5 s)/flag reason only in title
  - Evidence: comment-row.tsx:129,168,199; activity-pane.tsx:280; comments/main.tsx:129
  - Fix: Tooltip/HoverCard; inline failures
- **H-17** · P2 · Badges h-4 text-[10px]; ad-hoc rounded-full pill; 10px text (row time, flag action, alpha); rounded-[4px], rounded-md; ToggleGroup h-6 overrides vs h-7 — partly fixed in #647 (S1.8 `df1a6513`, 10 px text); rest in S3.16b; fixed in #647 (S3.16b `3919c3ea`)
  - Evidence: stream-manager.tsx:208; chat-pane.tsx:448,597,388-428; comment-row.tsx:198-204,282,367,422,688; activity-pane.tsx:257,375-406 |
- **H-18** · P2 · Composer is rounded-panel bordered box with card (nudge) inside — fixed in #647 (S3.16b `3919c3ea`)
  - Evidence: chat-pane.tsx:778; cohost-nudge.tsx:22
  - Fix: flush region
- **H-19** · P2 · Activity vs Chat: no narrow Filters menu, no "All" chip, hover highlight on non-clickable rows, ⋯ visibility & time style differ — fixed in #647 (S3.16a `aeddb652`)
  - Evidence: activity-pane.tsx:246-413; comment-row.tsx:688,935
  - Fix: PlatformFilter; one row contract
- **H-20** · P2 · Time-limited cards (removal countdown, Suggest) and failures not announced — fixed in #647 (S3.14c `36de1ef8`)
  - Evidence: buddy-utterance-cards.tsx:75; removal-cards.tsx:183; command-cards.tsx:162
  - Fix: polite live region per pane
- **H-21** · P2 · Buddy pane fixed stack unbounded; questions area can collapse — fixed in #647 (S3.14c `36de1ef8`)
  - Evidence: stream-manager.tsx:780; buddy-utterance-cards.tsx:71
  - Fix: ScrollArea cap
- **H-22** · P2 · ⌘F hard-coded (Windows), "Ctrl↵" on macOS (displayKeyGlyph(…, undefined) → 'Ctrl'), UA regex elsewhere — fixed in #647 (S1.2 `e257d3c4`)
  - Evidence: chat-pane.tsx:519; cohost-pane.tsx:743; platform.ts:9-17,50-55; stream-manager.tsx:121
  - Fix: displayKeyGlyph falls back to detected platform
- **H-23** · P2 · Four Buddy cards: decline ⌫ vs Esc; "esc"/"Esc"; focusability; button order flips; padding — fixed in #647 (S3.14c `36de1ef8`)
  - Evidence: buddy-utterance-cards.tsx:59,115; command-cards.tsx:143,211,217; removal-cards.tsx:141,179,233
  - Fix: one BuddyCard + key contract
- **H-24** · P2 · Composer marker line shown every session (standing upsell) — fixed in #647 (S3.16b `3919c3ea`)
  - Evidence: chat-pane.tsx:932-941
  - Fix: only starting/blocked
- **H-25** · P2 · "Suggests timeout/ban" — app can't do either — fixed in #647 (S2.3a `490d7f6a`)
  - Evidence: cohost-view.ts:390-394
  - Fix: "Suggests removing"
- **H-26** · P2 · Draft cleared before send result (lost on failure); Send aria-label ignores To: pick; red counter text — fixed in #647 (S3.16a `aeddb652`)
  - Evidence: chat-pane.tsx:761-766,884-904; comments/main.tsx:791
  - Fix: restore + Retry
- **H-27** · P2 (= F-26) · "the Buddy" vs "Buddy" vs persona name; alpha vs Alpha; Turn on vs Allow cloud AI — fixed in #647 (S2.3b `21073ea6`)
  - Evidence: buddy-utterance-cards.tsx:77; buddy-chat-controls.tsx:160 |
- **H-28** · P3 · Window title rows differ (SM 12/500 span no heading; Captions 12/500 subtle; Notes 13/600; main 14/600 h1) — fixed in #647 (S1.6b `1bd4865c`)
  - Evidence: stream-manager.tsx:912; captions-reader.tsx:61; notes-window.tsx:153; pane.tsx:30
  - Fix: WindowTitleRow
- **H-29** · P3 · Eye icon = Open Preview AND Show on stream — fixed in #647 (S3.16b `3919c3ea`)
  - Evidence: icons.tsx:248; stream-manager-status-bar.tsx:250,297; comment-row.tsx:785
  - Fix: LivestreamIcon for on-stream
- **H-30** · P3 · History: two date formats; live-only controls visible; "Back to live" when not live; rows lose ⋯ (Copy/links) — fixed in #647 (S3.16a `aeddb652`)
  - Evidence: stream-manager.tsx:923-935,762,1073; comment-row.tsx:778 |
- **H-31** · P3 · Skill/docs out of date vs code by owner calls (activity mark far right; SM status bar 32px; Mark clip/Clear labelled)
  - Evidence: SKILL.md:170,225,268; docs/buddy.md:413
  - Fix: amend skill
- **H-32** · P3 · Success toasts for "do this in your browser"; Mark clip toast w/o Undo vs /marker inline Undo — partly fixed in #647 (S2.4 `4929496f`, browser steps as info); Mark clip Undo needs an RPC the plan doesn't name (deferred); deferred: Mark clip Undo needs an RPC the plan doesn't name (S2.4, S3.16b)
  - Evidence: comments/main.tsx:656,680,697 |
- **H-33** · P3 · "Questions" chip shown when Buddy off; Buddy jump wipes filters silently — fixed in #647 (S3.16a `aeddb652`)
  - Evidence: chat-pane.tsx:309,404 |

**Owner decisions raised by this review:** (1) click anywhere on live chat row (incl. links/text select) puts it on stream → proposed: click selects, H/Show button puts on stream (**owner 2026-10-10: no, a click keeps putting it on stream**, D10; only a text-selecting drag stops counting as a click); (2) manual Remove + ⇧⌫ immediate → 3 s Undo (D20); (3) platform mark far right → after name; (4) behaviour switches in two homes → summary chip

**Patterns to standardise:** error feedback channels (5) → inline where action lives; window key scoping (removalKeyAnswer bubble phase); modifier glyphs (3 ways); count badges (4 ways); locked reasons (4 ways) → Alert w/ action; inline notices → flush Alert row; hover details → Tooltip/HoverCard; StatusBarAction primitive (ACTION_CLASS copy); PlatformFilter; row interaction (Buddy model); time labels; provider-state words; health vocabulary across windows (healthReading vs liveProblemLabel → one classifier); ScrollArea; error-text guard (lib/toast.ts) for all surfaced reasons.

## Area I — Settings, Health, Notes window, Phone remote

- **I-NEW** · P1 ✔ · "Chat is not connected" toast action "Open Livestream" dispatches {tab:'streaming'} → isWorkspaceTab rejects → does nothing (plan 064 noted, unfixed) — fixed in #647 (S0.4a `d0dca074`)
  - Evidence: use-studio.tsx:2457-2461
  - Fix: typed openWorkspaceTab('live'); replace raw CustomEvents
- **I-1** · P1 · Support bundle: written to hidden app-data folder; toast shows filename only, no reveal; no support contact anywhere; jargon error when backend down; two different buttons (About outline BugIcon vs Health primary ExternalLink) — partly fixed in #647 (S1.6b `1bd4865c`, one SupportBundleButton); reveal in S3.18; Contact support needs an owner-supplied address; partly fixed in #647 (S1.6b, S2.4, S3.18 `6e3546dd`: one button, reveal); Contact support needs an owner-supplied address
  - Evidence: use-studio.tsx:10369,10397; support_bundle.rs:151; about-settings.tsx:33-46; diagnostics-tab.tsx:702
  - Fix: save panel / reveal action; Contact support; one SupportBundleButton
- **I-2** · P1 · Notes never says it's hidden from capture; protection failure only logged to console (notes may appear on stream) — fixed in #647 (S0.6 `159c1155`)
  - Evidence: notes-window.tsx:91,219; main index.ts:2809
  - Fix: footer "Hidden from recordings and streams"; destructive Alert on failure
- **I-3** · P1 (= A-20) · Copy points to places that don't exist: "Details are in diagnostics"; "Recording → Output"; phone "Settings → Phone remote" (tab is Remote); doc paths — fixed in #647 (S2.3a `490d7f6a`; doc paths in S4.2)
  - Evidence: toast.ts:10; performance-check.ts:155; go-live-dialog.tsx:445; remote_web/index.html:32; app.js:511 |
- **I-4** · P1 · Health "Verdicts" = 14–16 equal chips, raw enums ("Permission-needed"), jargon (OBS-native, Surface proof, Tick spike), amber for transitional; no overall answer; actionable warnings buried — fixed in #647 (S3.18 `6e3546dd`)
  - Evidence: diagnostics-tab.tsx:169-248,695,1022,1242,1467
  - Fix: lead Alert verdict; non-green chips only; words
- **I-5** · P1 · Phone page hint text fails AA (4.0:1 dark, 2.75:1 light) — pairing instructions — fixed in #647 (S3.20 `991f0c6e`)
  - Evidence: remote_web/app.css:10,28,174-191
  - Fix: --text-2
- **I-6** · P2 · Health entry points: status dot not clickable (IA plan said it should be); no ⌘K keywords/command; Degraded alert no action; About no link — partly fixed in #647 (S1.3 `6bd8f9a2`, status-bar door to Health); rest in S3.18; fixed in #647 (S1.3 `6bd8f9a2`, S3.18 `6e3546dd`)
  - Evidence: app-shell.tsx:505; command-palette.tsx:99; studio-tab.tsx:291; about-settings.tsx:30 |
- **I-7** · P2 · Settings rows hand-built (8 copied justify-between, 4 stacked, 2 fake inputs, Permissions/About/Phone no rows); root cause FieldDescription text-sm — partly fixed in #647 (S1.6a `b5e1c5b7`, SettingsRow primitive); migration in S3.17; fixed in #647 (S3.17 `b88c8794`; Recording tab rows in S3.6)
  - Evidence: general-settings.tsx:30-128; recording-settings.tsx:80-234; ui/field.tsx:138
  - Fix: SettingsRow + 12px description + aria-describedby
- **I-8** · P2 · Locked w/o reason: Pair a phone (only text colour changes); 7TV+GIF both disabled, reason under one; Linux empty Permissions box — fixed in #647 (S3.17 `b88c8794`)
  - Evidence: phone-remote-section.tsx:238; seventv-emotes-field.tsx:37-95; permissions-settings.tsx:44 |
- **I-9** · P2 · Mac-only copy on all platforms ("this Mac", "~/Movies/…", "macOS shows its microphone indicator", "capture your Mac" on Linux, Metal/VT rows on Windows) — fixed in #647 (S1.4 `215e6585`)
  - Evidence: remote-settings.tsx:50,90; recording-settings.tsx:109,156; permissions-onboarding-dialog.tsx:62-86; diagnostics-tab.tsx:433,589
  - Fix: platformCopy module
- **I-10** · P2 (= A-16) · Permission rows differ Settings vs onboarding (red icon vs amber word; detail visible vs title-only; Manage missing); "Set up permissions" reopens same rows — fixed in #647 (S3.17 `b88c8794`)
  - Evidence: permissions-settings.tsx:63-117; permissions-onboarding-dialog.tsx:156-176
  - Fix: SystemAccessRow
- **I-11** · P2 · Phone controls enabled while offline; endless "Reconnecting…"; blank body while connecting; raw snacks ("remote.intent timed out.", "Only layoutPreset scene switches…") — fixed in #647 (S3.20 `991f0c6e`)
  - Evidence: remote_web/app.js:92-112,497,528; remote-client.js:143,306; remote-surface.ts:261-362 |
- **I-12** · P2 · Phone semantics: comment buttons given role=listitem; no aria-pressed; user-scalable=no; light-mode focus invisible; tap-to-show not explained — fixed in #647 (S3.20 `991f0c6e`)
  - Evidence: remote_web/app.js:213,333,558; index.html:7,39; app.css:82,425 |
- **I-13** · P2 · Phone "Microphone" key lit red when MUTED (reads as live) — fixed in #647 (S3.20 `991f0c6e`)
  - Evidence: remote_web/app.js:428-434
  - Fix: "Mic muted"/"Mic on"
- **I-14** · P2 · Phone vocabulary: Comments vs Chat; LIVE vs ON AIR; "Clear comment" vs "Take off stream"; scene names from ids ("Side By Side"); Deck/remote naming — fixed in #647 (S2.3a `490d7f6a`)
  - Evidence: remote_web/index.html:15-56; app.js:286,329,446
  - Fix: send labels; Chat/Controls tabs
- **I-15** · P2 · Regenerate token and Remove phone run immediately (disconnect mid-stream); no AlertDialog — fixed in #647 (S0.3 `1aeee1f1`)
  - Evidence: remote-settings.tsx:77-90; phone-remote-section.tsx:272
  - Fix: AlertDialog confirms
- **I-16** · P2 · Turning Remote control off silently turns Phone remote off — fixed in #647 (S0.3 `1aeee1f1`)
  - Evidence: remote-settings.tsx:41-50; phone-remote-section.tsx:232 |
- **I-17** · P2 · Shortcut recorder: aria-label hides current binding; refusals not live; can bind ⌘K/⌘1-9/⌘P globally (breaks own keys) — fixed in #647 (S3.17 `b88c8794`)
  - Evidence: shortcut-recorder.tsx:178-230; shortcuts-settings.tsx:68; accelerator.ts:230 |
- **I-18** · P2 (= A-5) · Shortcut rendering: chord-in-one-keycap vs keycap-per-key; Windows "␣"/"⌫" glyphs, "ShiftCtrlN"; ⌘F/⌘N literals; "Cmd+P" — fixed in #647 (S1.2 `e257d3c4`)
  - Evidence: sidebar.tsx:74; command-palette.tsx:108; shortcuts-settings.tsx:146; platform.ts:42-97
  - Fix: KbdChord / ShortcutKeys
- **I-19** · P2 (= A-22) · Global shortcut failure toast prints ids — fixed in #647 (S2.4 `4929496f`)
  - Evidence: global-shortcuts.ts:158 |
- **I-20** · P2 · About update states: raw electron-updater error in warning text; unsupported states w/o links; "Finish your recording first" (also streams); OS "ready" notification during capture; auto-install on quit not stated; hand-rolled progress — fixed in #647 (S3.17 `b88c8794`)
  - Evidence: about-settings.tsx:113-195; updater.ts:255,275 |
- **I-21** · P2 · About lacks website/privacy/terms/licences (AGPL)/support links — fixed in #647 (S3.17 `b88c8794`)
  - Evidence: about-settings.tsx:23-51; videorc-web-links.ts:27 |
- **I-22** · P2 · Fake inputs (styled divs) for output folder and pairing token; labels connect to nothing; "Browse"/"Reveal" — partly fixed in #647 (S3.17 `b88c8794`, read-only token); folder in S3.6; fixed in #647 (S3.17 `b88c8794`, S3.6 `06caf5d1`)
  - Evidence: recording-settings.tsx:81-104; remote-settings.tsx:56-65
  - Fix: InputGroup readOnly
- **I-23** · P2 · Recording tab: empty Advanced disclosure; "Reveal" vs Show in Finder helper; "Output directory" vs "output folder"; "Blank uses default" for untypeable field; no reset; raw sonner import (bypasses toast guard) with raw error.message — fixed in #647 (S3.6 `06caf5d1`)
  - Evidence: recording-settings.tsx:10,81,104-110,173,221-234 |
- **I-24** · P2 · Notes status line announces every keystroke (aria-live); "Save failed" in text-subtle, no retry; "S text" names — fixed in #647 (S3.19 `42eeb62f`)
  - Evidence: notes-window.tsx:17-244 |
- **I-25** · P2 · Health details: mixed empty markers (--, None, Unknown, Off, -); "12 drop"; raw stage/state/code/level; "selected session" with no selector; logs truncated silently; xl breakpoint; icon-only Resolve — partly fixed in #647 (S1.4 `215e6585`, placeholders); rest in S3.18; fixed in #647 (S1.4 `215e6585`, S3.18 `6e3546dd`)
  - Evidence: diagnostics-tab.tsx:69-1307 |
- **I-26** · P2 (= D-35) · Coloured status text; FieldError text-destructive; hand-tinted alert boxes — fixed in #647 (S1.8 `df1a6513`)
  - Evidence: recording-settings.tsx:112; about-settings.tsx:192; diagnostics-tab.tsx:250-879; ui/field.tsx:216 |
- **I-27** · P2 · Settings IA: no Account/Buddy/Health pointers; "Stream destinations" under Recording; General mixes theme + 3 Stream Manager chat settings + scene animation + GPU — partly fixed in #647 (S3.17 `b88c8794`); "Stream destinations" under Recording in S3.6; fixed in #647 (S3.17, S3.6 `06caf5d1`)
  - Evidence: general-settings.tsx:25-114; recording-settings.tsx:189
  - Fix: split sections + "Elsewhere" NavigableRows
- **I-28** · P2 · Phone device rows hand-built 44px with hover on non-clickable; rename exists in hook but no UI; all named "iPhone · Safari" — fixed in #647 (S3.20 `991f0c6e`)
  - Evidence: phone-remote-section.tsx:257-283; use-studio.tsx:15168 |
- **I-29** · P3 · Notes header controls in title row corner; h-6/size-7 overrides; 4 Keep-on-top labels; no WindowToolbar — fixed in #647 (S1.6b `1bd4865c`)
  - Evidence: notes-window.tsx:141-203; window-frame.tsx:31 |
- **I-30** · P3 · Theme ToggleGroup unnamed; theme vs Select for similar choices; sidebar toggle/D drops "System" silently — partly fixed in #647 (S1.7 `466ff1e5`, theme control); the D-key toggle still skips System; fixed in #647 (S3.17 `b88c8794`)
  - Evidence: general-settings.tsx:30; use-theme-toggle.ts:8 |
- **I-31** · P3 · Copy-to-clipboard 3 behaviours; silent copies — fixed in #647 (S1.6b `1bd4865c`)
  - Evidence: remote-settings.tsx:66; phone-remote-section.tsx:153; scheduled-streams.tsx:483
  - Fix: copyText + "Copied"
- **I-32** · P3 · Missing ellipses ("Pair a phone", "Set up permissions", "What's new", "Browse"); shortcut labels "Open … window" for toggles; "Chat" group — partly fixed in #647 (S2.2 `ae1e6788`, session shortcut labels; S3.17 its files); ellipses in S2.5
  - Evidence: phone-remote-section.tsx:252; shortcuts.ts:28-42 |
- **I-33** · P3 · SECTION_PAIR duplicates CONFIG_GRID_PAIR; 3 sub-group label styles — partly fixed in #647 (S1.6a `b5e1c5b7`, tokens); rest in S3.17; fixed in #647 (S3.17 `b88c8794`)
  - Evidence: settings-tab.tsx:22; shortcuts-settings.tsx:105,139 |
- **I-34** · P3 · Phone: no auto-lock guidance; no REC chip; can't forget computer — fixed in #647 (S3.20 `991f0c6e`)
  - Evidence: remote_web/app.js:43,400 |

**Owner decisions raised by this review:** Health out of sidebar → keep, but status-bar dot opens Health (IA plan said so); "Animate scene changes" → Scene page

**Patterns to standardise:** SettingsRow; GroupedList (hand-copied 4x); sub-group label 11/600; inline status Alert; InputGroup readOnly; copyText; revealInFileManagerLabel; SupportBundleButton; KbdChord; Keep on top (PinIcon, status bar); "–" empty values; typed openWorkspaceTab (broken 'streaming' event); WindowToolbar; AlertDialog; platformCopy module.

## Area J1 — Design system and app-wide accessibility sweeps

**Counts:** Buttons 341 (sm 123, xs 98, default 80, icon 18, icon-sm 13, icon-xs 6, lg 3; ghost 150, outline 114, default 35, destructive 16, secondary 11, link 6); 30% of buttons are 24px; 28 per-site height overrides; text-[11px] 54 (≈35 metadata); text-[13px] 13; text-[12.5px] 7; text-[10px] 8; ~160 native title= vs 4 Tooltip roots; 32/32 dialogs titled; 43/44 icon buttons named; 0 icon-package bypasses; 50 Alerts all role=alert; 19 ad-hoc spinners; 12 destructive confirms in 3 styles; 6 segmented-control looks.

- **J1-1** · P0 ✔ (= D-2/B-2) · 15 Fields never associate FieldLabel (Output number inputs, privacy selects, Made for kids, Channel, Theme, 8 Scene ToggleGroups); root cause Field makes no id — fixed in #647 (S0.5 `e0140afc`)
  - Evidence: ui/field.tsx:80-118
  - Fix: Field useId context → FieldLabel htmlFor + control ids + ToggleGroup aria-labelledby; AST guard
- **J1-2** · P1 · title= on disabled controls never shows (pointer-events-none) — 7 sites incl. Clean cut Save, orientation switch, Library Play, locked preset — fixed in #647 (S1.1 `add86ec0`)
  - Evidence: ui/button.tsx:8; toggle.tsx:10; select.tsx:117; clean-cut-review.tsx:679,807; scene-presets.tsx:124; source-transform-fields.tsx:91; library-tab.tsx:922; session-panel.tsx:385; video-preset-select-items.tsx:96
  - Fix: ui/disabled-reason.tsx from library-tab.tsx:1135 pattern
- **J1-3** · P1 · No AlertDialog: 12 destructive confirms in 3 styles (✕ shown 7/hidden 5; Cancel outline vs ghost; only 1 autofocuses safe button; verb mismatches); takeover delete unconfirmed (= C-1) — fixed in #647 (S0.3 `1aeee1f1`)
  - Evidence: ui/ (no alert-dialog.tsx)
  - Fix: install AlertDialog; one recipe; migrate 12
- **J1-4** · P1 · text-subtle fails AA by token (3.99–4.11:1 on solid; ~2.5:1 dark over bright desktop); not in prefers-contrast block; ~60 of 99 uses are essential info (Premium rule, listening quota, data-retention disclosure in consent dialogs, overlay notices, consent consequence, instructions) — fixed in #647 (S1.8 `df1a6513`)
  - Evidence: styles.css:89,214,336-359
  - Fix: raise --subtle (~L0.60 dark/0.55 light), add to contrast block, reserve tier for disabled/incidental; move essential copy
- **J1-5** · P1 · Status copy coloured (28 text-destructive, 23 text-warning, 9 text-success ≈45 text); light amber 2.18:1; ~20 text-xs text-destructive paragraphs vs FieldError used once; go-live alert clones — fixed in #647 (S1.8 `df1a6513`)
  - Evidence: recording-settings.tsx:112,117; sources-audio-mixer.tsx:680-698; go-live-dialog.tsx:281-495
  - Fix: Alert / StatusDot+icon / restyled FieldError; guard on text-(warning|success|destructive)
- **J1-6** · P1 ✔ · ~160 native title= vs 4 Tooltip roots; TooltipProvider only in main window → Tooltip would crash Stream Manager/Notes/Captions; shortcuts hidden in titles; explanations on non-focusable badges — partly fixed in #647 (S1.1 `add86ec0`, providers in every window); `title=` migration in S1.10
  - Evidence: App.tsx:37; comments/main.tsx; notes/main.tsx; captions/main.tsx
  - Fix: WindowProviders (TooltipProvider+Toaster) for all 4 entries; promote ShortcutTooltip; migrate; title only for truncation
- **J1-7** · P1 · Segmented choice built 6 ways (Tabs track; borderless ToggleGroup; outline ToggleGroup; joined spacing=0; hand-rolled buttons (eager budget); aria-pressed tiles); owner rule "segmented choices use Tabs" (plan 080) — fixed in #647 (S1.7 `466ff1e5`)
  - Evidence: ui/tabs.tsx:22,82 + sites
  - Fix: Radix-free ui/segmented-control.tsx on tabsListVariants; ToggleGroup only for multi-select filters
- **J1-8** · P2 · Alert role=alert always; 5 warning icon treatments; no info/locked variant (overrides x2+) — fixed in #647 (S1.5 `905ea8fe`)
  - Evidence: ui/alert.tsx:33; buddy-tab.tsx:295; clean-cut-card.tsx:277
  - Fix: role by variant; default icon per variant; locked variant
- **J1-9** · P2 · TabsContent outline-none but tabIndex 0 (13 invisible tab stops); Accordion trigger no focus style; Command tabIndex 0 outline-none; destination row nested switch; transcript role=button spans unfocusable; marker pins 16×24
  - Evidence: ui/tabs.tsx:76; ui/accordion.tsx:39; cohost-pane.tsx:504; destination-card.tsx:309; marker-pins.tsx:21 |
- **J1-10** · P2 · Input/Textarea text-base md:text-sm (mobile rule) → 16px text in narrow Stream Manager/Notes/Captions windows; per-call overrides fail — fixed in #647 (S1.8 `df1a6513`)
  - Evidence: ui/input.tsx:7; ui/textarea.tsx:10; notes-window.tsx:24; cohost-pane.tsx:814
  - Fix: text-sm
- **J1-11** · P2 · One control height eroded: 30% 24px buttons; sm == default; icon-sm == icon; Toggle sm == default → 9 h-6 overrides; InputGroup icon-sm 32px in 28px group
  - Evidence: ui/button.tsx:27-32; ui/toggle.tsx:20; ui/input-group.tsx:72
  - Fix: sanctioned xs (24px) where allowed; delete redundant sizes
- **J1-12** · P2 · Arbitrary type sizes: tokens --text-label 11/600, --text-section 13/600, --text-meta 12; --radius-tag 7px; FieldDescription → text-xs; metadata 10–11px → 12px — partly fixed in #647 (S1.6a `b5e1c5b7`, tokens); guards in S4.1
  - Evidence: ui/field.tsx:138; ui/badge.tsx:15 |
- **J1-13** · P2 · Empty primitive off-skill (text-lg title, icon tile, secondary desc); 4 empty looks — fixed in #647 (S1.5 `905ea8fe`)
  - Evidence: ui/empty.tsx:34-73
  - Fix: retune + migrate
- **J1-14** · P2 · Menu/select items rounded-md (8px) not 6px concentric; chart tooltip rounded-xl; separator strengths differ — fixed in #647 (S1.6b `1bd4865c`)
  - Evidence: dropdown-menu.tsx:72-210; context-menu.tsx; select.tsx:117,139; chart.tsx:168
  - Fix: rounded-chip
- **J1-15** · P2 · Switch knob ignores --knob (dark checked knob near-black; light knob translucent); transition-all — fixed in #647 (S1.8 `df1a6513`)
  - Evidence: ui/switch.tsx:18,25
  - Fix: bg-knob ring-knob-ring
- **J1-16** · P2 · Kbd inside primary buttons 2.38:1 (dark); "Save ↵" literal — fixed in #647 (S1.2 `e257d3c4`)
  - Evidence: ui/kbd.tsx:15; session-markers-dialog.tsx:229
  - Fix: on-primary Kbd style
- **J1-17** · P2 ✔ · Stream Manager Toaster offset 16 over its 32px status bar controls; Notes/Captions no Toaster — fixed in #647 (S1.1 `add86ec0`)
  - Evidence: comments/main.tsx:821
  - Fix: WindowProviders offset
- **J1-18** · P2 (= H-28/D-25) · Window title recipes x4 — fixed in #647 (S1.6b `1bd4865c`)
  - Evidence: pane.tsx:30; stream-manager.tsx:912; notes-window.tsx:154; captions-reader.tsx:61
  - Fix: WindowHeader 14/600
- **J1-19** · P2 · Hand-rolled boxes: GroupedList string copied x4; tinted callouts x5; 4 card fills; composer box with card inside; fake inputs; glass-float on in-window buttons — fixed in #647 (S1.6b `1bd4865c`, MediaCard; GroupedList copies with S1.6a)
  - Evidence: list-row.tsx:116 etc.
  - Fix: GroupedList; Alert; MediaCard; Button variant overlay
- **J1-20** · P2 · DialogContent no size variants (7 widths, 5 height recipes); OBS dialog max-w-xl loses to sm:max-w-md (renders 448 not 576) — fixed in #647 (S1.6b `1bd4865c`); fixed in #647 (S1.6b `1bd4865c`, S3.4 `cf2da9d9`)
  - Evidence: ui/dialog.tsx:59; obs-import-dialog.tsx:210
  - Fix: size prop + DialogBody
- **J1-21** · P2 · No Spinner/Progress/Table: 19 ad-hoc spinners w/o role=status; 2 progress bars; Library CSS-grid table w/o semantics; native datetime-local; loading copy drift — partly fixed in #647 (S1.5 `905ea8fe`, Spinner and Progress); table semantics in S3.11; fixed in #647 (S1.5 `905ea8fe`, S3.11 `3c129b55`)
  - Evidence: | install Spinner/Progress; Table semantics; copy rule
- **J1-22** · P3 · ClipIcon (scissors) = Clean cut AND Markers AND Mark clip; unused licence slots (VerifiedIcon, BrainIcon, FastIcon); inline status icons 14 vs 16; ⋯ triggers 24/28 bold/regular — partly fixed in #647 (S3.12 `e4f8da11`, MarkerIcon); inline icon sizes open
  - Evidence: icons.tsx:178,265,267; library-tab.tsx:965,970
  - Fix: MarkerIcon; remove dead slots
- **J1-23** · P3 · Float motion zoom-in-95 + slide vs skill 0.98; smooth scroll ignores reduced motion; transition-all; duration-200 — fixed in #647 (S1.8 `df1a6513`)
  - Evidence: ui/select.tsx:70 etc. |
- **J1-24** · P3 · Dead variants/tokens/classes; cursor-not-allowed x12 (never shows); palette scale; tracking-widest; skill drift (gutter)
  - Evidence: |

**Owner decisions raised by this review:** Radix-free SegmentedControl respecting eager budget; raise --subtle + rule "essential info never tertiary"; delete borderless Input ghost variant (fails 2.4.7)

**Patterns to standardise:** status row → Alert; chips/dots (Badge status 7px tags vs StatusBadge round; 7 hand-rolled dots) → StatusDot/StatusBadge, Badge status round; Disclosure trigger (4 looks, Accordion chevron swap); SectionLabel; shortcut hints (ShortcutTooltip/Kbd); DisabledReason; FieldError; StatusBarButton (ACTION_CLASS copy); AlertDialog; WindowProviders.

## Area J2 — Copy, terminology, toasts and state design

**Counts:** ~195 toast producers (~91 error, 40 success, 27 warning, 9 info, 5 plain, 2 loading): ~86 keep, 15 routine success, 62 errors/warnings w/o next step (37 raw error.message), 9 duplicate-wording groups, 10 dev-only strings; 97 raw error.message passthroughs (ipcErrorMessage used in 3 places); ~333 disabled props, ~85% no reason nearby; 7 "locked while live" wordings; "Could not" 77 vs "Couldn't" 31; "cannot" 64 vs "can't" 53; 69 toast titles with period vs 46 without; "…" 127 vs "..." 2.

- **J2-1** · P0 ✔ (= E-2) · "You can restore them from the DeleteIcon." (codemod 3cf5d942 #282) — fixed in #647 (S0.3 `1aeee1f1`)
  - Evidence: library-tab.tsx:502
  - Fix: "…from the Trash." (Recycle Bin on Windows); guard /\b[A-Z][a-z]+Icon\b/
- **J2-2** · P0 ✔ (= C-1) · Takeover delete one click; "Deleted Screen." — fixed in #647 (S0.3 `1aeee1f1`)
  - Evidence: takeover-screens-section.tsx:220; use-studio.tsx:11420-11435
  - Fix: confirm or soft-delete Undo
- **J2-3** · P1 · Copy points at controls/pages that don't exist: "click Go Live in Studio" (button says Stream); "Enable Record MKV, Stream RTMP"; "Turn on Record in the Studio" (clip-marks.ts:42); "Recording → Output"; "Streaming settings"; "Customize" (x2); "Go to Live"; "Open Recording"/"Open Live"; "Library → Session actions → Markers"; "Details are in diagnostics" — fixed in #647 (S2.2 `ae1e6788`; two toasts in S2.4)
  - Evidence: scheduled-streams.tsx:307,345; global-shortcuts.ts:48; use-studio.tsx:12064,14595; shared/clip-marks.ts:42; performance-check.ts:155; clean-cut-view.ts:88; buddy-tab-view.ts:121; buddy-voice-commands.tsx:122; studio-tab.tsx:386-396; chat-pane.tsx:726; toast.ts:10
  - Fix: rewrites + test that quoted labels/paths match constants
- **J2-4** · P1 · One state, several labels: destination failed="Stopped" vs "Failed"; stopped="Ended" vs "Stopped"; session raw ws enums vs pill; captions 3 label sets; "Live" = any session / source producing frames / on air — fixed in #647 (S2.3a `490d7f6a`)
  - Evidence: destination-card.tsx:96-100,755; stream-manager-stats.ts:259; app-shell.tsx:421; captions-controls.tsx:73; quick-settings.tsx:51; captions-reader.tsx:182; mic-visual-gate.ts:63; sources-tab.tsx:43
  - Fix: destinationStateLabel/sessionStatusLabel/captionsStatusLabel; "On air" only for on air; source chip "Receiving"
- **J2-5** · P1 (= B-3) · Start controls depend on hidden mode; "Streaming: Disabled" after a Record; Go Live shortcut refused — fixed in #647 (S2.2 `ae1e6788`); fixed in #647 (S2.2 `ae1e6788`, S3.1 `a069d07f`)
  - Evidence: studio-tab.tsx:128,140; session-panel.tsx:115; use-studio.tsx:13744,14834; global-shortcuts.ts:36-49; command-palette.tsx:195
  - Fix: "Record ␣" / "Go Live…"; explicit modes
- **J2-6** · P1 · Engineering internals in copy: "Backend socket is not connected." x13 toasts + raw ws enum; RPC method names + ms timeouts; "Layout committed at revision n…"; "livestream providers"; "compositor"; "OAuth callback"; server codes "(ai-gateway-error: …)"; action ids; VIDEORC\_\* env vars; "unavailable outside Electron" x10; "entitlement"; "Metadata draft"; "quality gate"; "pet pack"; managed file path — partly fixed in #647 (S2.1 `e6379d71`, copy guard with ratchet); toast strings in S2.4; fixed in #647 (S2.1 `e6379d71` guard, S2.4 `4929496f` toast strings)
  - Evidence: use-studio.tsx (many); backendClient.ts:313,382,414,510; backend-transport.ts:34; session-runtime-recovery.ts:242-330; cohost-state.ts:125
  - Fix: banned-word guard; "Videorc is reconnecting. Try again in a moment."; dev strings → console
- **J2-7** · P1 · 97 raw error.message passthroughs; ipcErrorMessage in 3 places; Stream Manager toasts show "Error invoking remote method 'comments-window:…'"; generic "Import failed." etc. — fixed in #647 (S2.4 `4929496f`)
  - Evidence: use-studio.tsx (31); comments/main.tsx (12); library-tab.tsx (8); preload/index.ts:17
  - Fix: userErrorMessage(error,{action,object}); strip IPC prefix in guardToastText
- **J2-8** · P1 · Library/Takeovers claim "No sessions yet"/"No takeovers yet" before data loads or while offline (sessions starts []) — partly fixed in #647 (S3.11 `3c129b55`, sessions); takeovers in S3.10; fixed in #647 (S3.11 `3c129b55`, S3.10 `31c121b0`)
  - Evidence: library-tab.tsx:356; use-studio.tsx:2145; takeover-screens-section.tsx:50; session-panel.tsx:363
  - Fix: sessionsLoaded/screensLoaded; Skeleton; offline Alert
- **J2-9** · P1 · ~85% of 333 disabled controls show no reason; 7 wordings/4 styles of "locked while live" — partly fixed in #647 (S1.5 `905ea8fe`, SessionLockAlert); per-control reasons in S1.10, toasts in S2.4
  - Evidence: layout-tab.tsx:316; library-tab.tsx:337,938,1023-1051; recording-tab.tsx:62,74,81; quick-settings.tsx:222; account-menu.tsx:153; takeover-screens-section.tsx:33,46; streaming-tab.tsx:221; captions-controls.tsx:357; scenes-gallery.tsx:85; use-studio.tsx:11402
  - Fix: SessionLockAlert; offline alert; disabledReason tooltips
- **J2-10** · P1 · Terminology map: going live; stream vs livestream; on-air state; recording vs session; Output; scene/layout/preset; source/input/device; destination/account/channel/stream key (never target/provider); Stream Manager vs chat/comments; Health vs diagnostics; takeover vs Screen; Import vs Upload; Stream details vs Broadcast info/metadata; Premium phrasing x6 ("{Feature} is part of Videorc Premium." + View Premium); remove/delete/discard/clear; microphone vs mic — fixed in #647 (S2.1 `e6379d71`, glossary in CONTEXT.md)
  - Evidence: (see report)
  - Fix: adopt canonical terms; record in CONTEXT.md; copy guard
- **J2-11** · P2 · 15 success toasts for routine visible actions (channel set, imported x2, HW accel retry scheduled, renamed, saved stream metadata, key saved/removed/restored, duplicated, noise cleanup queued, saved event selected, OAuth callback received) — fixed in #647 (S2.4 `4929496f`)
  - Evidence: use-studio.tsx:5917,10331,10419,11412,12015,14623-14661; library-tab.tsx:759,906; assets-tab.tsx:152; scheduled-streams.tsx:345; session-runtime-recovery.ts:315
  - Fix: remove; focus new rows
- **J2-12** · P2 · Toast types/durations by meaning: refusals as error/warning/info; self-healing retries as error; "approve in browser" as success; failed destination 4 s; long descriptions 4 s; long-lived conditions toasted once (overloaded, falling behind) — partly fixed in #647 (S2.4 `4929496f`, types and durations); mirroring into Session/Health in S3.18; fixed in #647 (S2.4 `4929496f`, S3.2 `8ad74d53`: failures persist as Session rows)
  - Evidence: use-studio.tsx:3784,6068,8869,9403,11402,11624,11785,11915,14356; session-runtime-recovery.ts:57,460; studio-health.ts:68
  - Fix: type rules; ≥8 s with description; persist until replaced; mirror into Session/Health
- **J2-13** · P2 · 9 duplicate-wording groups ("not connected" x11; MP4 ready vs Exported MP4 share id (action lost); Buddy stopped x2 ids; approve-in-browser x4; sign-in retry x4; quality check; broadcast failure; restart instruction; Open Library vs Open in Library) — fixed in #647 (S2.4 `4929496f`)
  - Evidence: (see report)
  - Fix: one wording each
- **J2-14** · P2 · ~62 error toasts without next step; title-as-noun toasts ("Microphone check", "Mark clip") — fixed in #647 (S2.4 `4929496f`)
  - Evidence: library-tab.tsx:172; use-studio.tsx:3860,10430,11634,13840,14279; use-whats-new.ts:76; global-shortcuts.ts:173
  - Fix: "Couldn't {verb} {object}" + reason + one action
- **J2-15** · P2 (= A-6) · capitalize in StatusBadge/StatusDot ("Needs Reconnect", "Higher Delay", "Device Disconnected") — fixed in #647 (S1.3 `6bd8f9a2`)
  - Evidence: status-badge.tsx:58; status-dot.tsx:45 |
- **J2-16** · P2 · Plurals ("1 viewers", "credits", "sheets/redos", "sessions loaded"; "(s)" hacks; 3 private plural()); durations (4 formats; Library "1 hour and 5 minutes"); unknown placeholders (-, --:--, –); relative time 3 styles; resolution formats; forced en-US numbers
  - Evidence: stream-manager-stats.ts:124,213,253; captions-controls.tsx:265; buddy-pet-creator.tsx:1119; library-tab.tsx:432,620; format.ts:36-63; seventv-status.ts:17
  - Fix: lib/format.ts helpers; locale
- **J2-17** · P2 (= I-9, C-28) · Windows copy: "Reveal in Finder", "this Mac", "~/Movies/…", "system Trash", "Show in folder" — fixed in #647 (S1.4 `215e6585`, S2.3a `490d7f6a`)
  - Evidence: assets-tab.tsx:414; remote-settings.tsx:50,91; recording-settings.tsx:109; library-tab.tsx:500; use-studio.tsx:2177
  - Fix: platform helpers; trashName()
- **J2-18** · P2 · State matrix: empty/loading/error presentations differ per page; several pages no loading/error state; ~57 coloured status text; Empty primitive drifts; Captions window "Error"/"Blocked" w/o reason; Notes "Save failed" 11px subtle; "Loading stream details" never times out — partly fixed in #647 (S3.19 `42eeb62f`, Notes); Captions reader in S3.7; fixed in #647 (S3.19 `42eeb62f`, S3.7 `54f561c1`)
  - Evidence: (matrix in report)
  - Fix: Empty retune; Skeleton; Alert; FieldError
- **J2-19** · P2 · "The other destinations keep streaming." shown even with one destination — fixed in #647 (S2.3a `490d7f6a`)
  - Evidence: stream-target-notices.ts:33,41
  - Fix: count-aware copy
- **J2-20** · P2 · Buddy naming in copy: persona name vs fixed "Buddy" in toasts; switch has 4 names ("Buddy Live", "Joins my streams", "chat mode"); "pet pack", "sheets" — fixed in #647 (S2.3b `21073ea6`)
  - Evidence: buddy-tab.tsx:377,380,545; cohost-view.ts:565; cohost-state.ts:109; buddy-tab-view.ts:250; buddy-avatar-section.tsx:216
  - Fix: "Buddy" for feature; persona name when character acts; one switch name
- **J2-21** · P3 · Conventions: casing deviations; "..." x2; missing "…" on commands opening steps (Stream, Import, Upload, Rename, Browse, Choose thumbnail, Edit) and pending labels; British/American tie (cancelled/canceled, colours/color, behavior); contractions; toast title periods; placeholder styles; Select vs Choose — partly fixed in #647 (S2.1 `e6379d71`, rules in docs/ui-copy.md); sweep in S2.5
  - Evidence: (see report)
  - Fix: sentence case; "…" rules; American English; contractions; no period in toast titles

**Owner decisions raised by this review:** Health page content vs label — keep Verdicts/Actionable warnings/Support bundle on top, fold ~110 engineering metrics into one collapsed "Technical details" (like Livestream)

**Patterns to standardise:** toast shape (outcome title, no period, description, one action); "not connected" copy; userErrorMessage; copy-to-clipboard (quiet success, loud failure, "Copied" state); reveal label helper; SessionLockAlert; state label functions; delete behaviour (confirm or Undo); Empty/Skeleton/Alert; SupportBundleButton (one home Health, About links); plural/duration/relative helpers; Premium sentence.

## V — Visual-only findings from the screenshot sweep

- **V-1** · P3 · "Alive" tag on official Buddy cards is drawn under the artwork (Nib's ear covers it, both themes); tag on every card when all five are Alive carries no information — fixed in #647 (S3.15b `85364e5b`)
  - Evidence: buddy-library-section.tsx:431-475 (tag + image well)
  - Fix: tag above image (z-order) or inside the text block; show only when it distinguishes
- **V-2** · P2 · Livestream destination rows: switches and chevrons shift left when a 9:16 tag is present, so the switch column doesn't align — fixed in #647 (S3.5a `88d5c501`)
  - Evidence: destination-card.tsx:309-348 (meta slot)
  - Fix: tag as inline context ("YouTube Vertical · 9:16"); controls in a fixed trailing column
- **V-3** · P2 · Livestream Title field renders a red error border and "Global title is required before going live." on first visit, before any interaction ("Global title" is jargon) — fixed in #647 (S3.5b `21159948`)
  - Evidence: streaming-tab.tsx:475-500
  - Fix: validate on blur / on Go Live attempt; "Add a title before you go live."
- **V-4** · P2 · Studio's active scene card label truncates at 1280 px ("Screen …") — fixed in #647 (S3.3 `b8e235e7`)
  - Evidence: studio/scenes-gallery.tsx:146-176
  - Fix: shorter labels via LAYOUT_PRESET_LABELS or two-line label
- **V-5** · P3 · Captions page repeats state: an "Off" status chip in the header beside an "Enable live captions" switch; the microphone row is a bordered card in the page — fixed in #647 (S3.7 `54f561c1`)
  - Evidence: captions/captions-controls.tsx:216-266
  - Fix: one state signal; NavigableRow for the mic (D-27)
- **V-6** · P3 · Settings → Remote: "clients pair with the token below" when no token is shown (off); "Off. Turn on to…" state sentences repeat the switch — fixed in #647 (S3.17 `b88c8794`)
  - Evidence: settings/remote-settings.tsx:41-93; phone-remote-section.tsx:232
  - Fix: copy depends on state
- **V-7** · P3 · Health shows "Pipeline" twice (accordion and section); log rows show "info info" (badge + text) — fixed in #647 (S3.18 `6e3546dd`)
  - Evidence: tabs/diagnostics-tab.tsx:670-915
  - Fix: one Pipeline; level badge only
- **V-8** · P3 · Stream Manager stats bar shows a run of placeholders ("– · – · –") that reads as broken — fixed in #647 (S3.16b `3919c3ea`)
  - Evidence: lib/stream-manager-stats.ts:228,504-560
  - Fix: hide unmeasured optional stats or show one "–" with reason (H-10)
- **V-9** · P3 · ⌘K opens vertically centred over the content; Raycast/Spotlight convention is the upper third
  - Evidence: components/ui/command.tsx (CommandDialog position)
  - Fix: top offset ~20% of window height
- **V-10** · P3 · Scene page: "Save scene" renders as a heading-sized text button, 17 px further in than the section content — fixed in #647 (S3.9 `c3cf6b59`)
  - Evidence: scene-presets.tsx:81-91 (on layout-tab)
  - Fix: Button in the PanelSection action slot
- **V-11** · P2 · First-run permissions: primary CTA reads "Continue without granting →" even when Screen Recording and Microphone are granted and only the camera is "checked on first use"; descriptions truncate — fixed in #647 (S3.17 `b88c8794`)
  - Evidence: permissions-onboarding-dialog.tsx:150-182
  - Fix: "Continue" when nothing required is missing; full descriptions (A-16)
- **V-12** · P3 · Settings → General: "Open Stream Manager when I go live" (first person) beside second-person rows — partly fixed in #647 (S3.17 `b88c8794`, Settings copy); fixed in #647 (S3.17 `b88c8794`, S2.3a `490d7f6a`)
  - Evidence: settings/general-settings.tsx:44-62
  - Fix: "Open Stream Manager when you go live" (J2-21 voice)

### Cross-cutting patterns seen in the screenshots (V-X)

Each V-X item is a pattern visible on many screens; the code-level IDs that
fix it are listed after the arrow.

- **V-X1** Shortcut chips render in five notations on one screen: status bar
  "⌘K"/"⇧⌘N", sidebar "⌘1", Studio "Open preview **Cmd+P**", Scene editor
  "Shift" / "Alt / ⌥" / "Esc", Settings → Shortcuts one keycap per key in
  ⌘⇧ order, ⌘K "⌘⇧J"; the Record chip "␣" looks like an empty box → A-5,
  I-18, H-22, F-22, G-23, C-37 (S1.2).
- **V-X2** Resolution and frame rate are spelled at least five ways:
  "1920×1080 · 30fps", "1080p30", "Full HD · 30 fps", "1080p · 30 fps · 6
  Mbps", "1920 × 1080 · Bottom", "Tutorial 1080p30", and "2K" for 2560×1440
  → D-22, B-15 (S1.4).
- **V-X3** Built-in layouts carry three name sets (Studio "Screen + …",
  "Screen", "Camera", "Side by side"; Scene "Screen + camera", "Screen only",
  "Camera only", "Side-by-side"; Shortcuts "Screen + Cam") → B-24, C-20
  (S1.4).
- **V-X4** Segmented choices come in at least five looks on adjacent pages
  (Tabs track, outline toggles, full-width thirds, borderless text segments,
  big tiles, icon segments) → J1-7 (S1.7).
- **V-X5** Empty states in at least five styles (illustrated tile + 20 px
  title, left-aligned title + line, inline sentence + link, plain muted line,
  bordered hint card) → J1-13, J2-18 (S1.5).
- **V-X6** State is shown twice beside switches ("Off" + switch; "Off" chip +
  "Enable" switch; switch + "• Off"; switch + "Off. Turn on to…") → V-5, V-6,
  D-3, E-31 (S1.6a, S3.7, S3.17).
- **V-X7** Description text changes size within one page (12 px section
  descriptions next to 14–16 px card descriptions and empty lines) → F-17,
  J1-12 (S1.6a).
- **V-X8** Bordered cards inside pages where the skill wants flush sections
  or grouped lists (Captions microphone box, Buddy settings cards, the Scene
  stage card, Personality box, onboarding permission rows) → J1-19, A-16,
  D-27, G-17 (S1.6a/b, S3.7, S3.15b, S3.17).
- **V-X9** Title Case drift ("Enable Camera", "Show Capture Helper", "New
  Recording", "Checked On First Use", "Device-Missing") → J2-21, A-6
  (S1.3, S2.5).
- **V-X10** Three-dot ellipses in placeholders and buttons ("Search
  recordings...", "Search commands...", "Import from OBS...") next to "…"
  elsewhere → J2-21 (S2.5).
- **V-X11** One action, two labels or looks ("Import" outline vs "Upload"
  primary on one page; "Use" vs "Use this one"; "Export support bundle" vs
  "Export"; "Release notes" vs "What's new") → C-25, G-PAT, I-1, J2-10
  (S1.6b, S2.3a, S3.10).
- **V-X12** Vocabulary drift visible on screen (sessions vs recordings,
  takeovers vs takeover screens, "X receive-only" vs "X read-only", "Streaming
  tab", "events" vs "broadcasts", "the Buddy" vs "Buddy", "sidekick", a
  "Live" chip on a capture source, "Disabled" vs "No destinations") → J2-4,
  J2-10, H-13, E-28 (S2.1–S2.3).

## Appendix A — Toast inventory (spec for S2.4)

From the J2 sweep: every toast producer with its type, copy, action and the
proposed rewrite. Line numbers are as of `c49e7855`.

**Class key**

- **a** = keep (news the UI doesn't show);
- **b** = success for a routine action the user just watched;
- **c** = error/warning without a next step (rewrite proposed);
- **d** = duplicate or near-duplicate wording (rewrite proposed);
- **dev** = developer-only string reaching a toast.

**Totals.** About 195 producers: about 86 a, 15 b, 62 c, 43 in 9 d-groups, 10 dev. Classes overlap. Types: about 91 error, 40 success, 27 warning, 9 info, 5 plain, 2 loading.

Abbreviations: "∞" = persistent; "—" = no action/id. Rows give line numbers within the file named in the heading.

**apps/desktop/src/renderer/src/hooks/use-studio.tsx**
| Line(s) | Type | Copy (title · description) | Action · id · duration | Class | Proposed |
|---|---|---|---|---|---|
| 2161, 6688 | loading | {finalizing %} · "Your recording is safe. Long recordings can take several minutes to save as MP4." | `finalization-{id}` · ∞ | a | — |
| 2173, 6709 | success | "MP4 ready" | "Show in folder" · 15 s | a, d | action label from `revealInFileManagerLabel()` |
| 2184, 6722 | error | "MP4 export failed" · backend text ?? "The original MKV recording was kept." | "Retry export" · ∞ | a | desc "Your original recording is safe." |
| 2454 | warning | "{Platform} chat is not connected" · provider text | "Open Livestream" | a | — |
| 2767 | error | raw voice-marker refusal | — | c | "Couldn't add the marker" · reason |
| 3246, 5877, 6053, 10307, 10370, 11481, 11514, 11546, 11589, 11993, 14605, 14647 (+11403/11426/11449 else) | error | "Backend socket is not connected." | — | d, leak | warning "Videorc is reconnecting" · "Try again in a moment." |
| 8875 | error | "Backend socket is not connected. Layout unchanged." | — | d | same · "The scene didn't change." |
| 10430 | error | "Microphone check" · "Backend is not connected. Try again in a moment." | — | d | "Couldn't check the microphone" · reconnecting desc |
| 14279 | error | "Mark clip" · same | — | d | "Couldn't mark the clip" · reconnecting desc |
| 3285 | error | raw ?? "Could not open saved comments." | — | c | "Couldn't open this stream's chat" · reason · Retry |
| 3784 | notifyOnce e/w/s | "Streaming to {label} stopped" / "{label} is reconnecting" / "{label} isn't receiving your stream" / "{label} is back" | per destination · 4 s | a | failed persists until "back"; see J2-19 |
| 3860 | error | "The working scene could not be saved for the next launch." | `working-scene-storage` | c | "Couldn't remember this scene for next time" · "Your stream and recording aren't affected." |
| 3888 | error | raw source-switch failure | `source-switch-{req}` | c | "Couldn't switch to {device}" · reason · "Pick it again in Sources." |
| 4063 | error | "Could not start" · reason | "Retry" · ∞ | a | "Couldn't start recording" / "Couldn't go live" |
| 4178 | error | "Buddy stopped: … ({code}: {server text})." | `cohost-error` | c, d, leak | drop code; action per reason (Sign in / View Premium / Retry) |
| 4185 | plain | "Buddy stopped. Premium ended." / "…You signed out." | `cohost-stopped` | d | merge with 4178 under one id |
| 5917 | success | "YouTube channel set to {label}." | — | b | remove |
| 6057, 11593 | error | "OAuth browser launch is unavailable outside Electron." | — | dev | console only |
| 6068 | success | "Approve Videorc on x.com to enable X Live." | — | a, d | info "Approve X Live in your browser" + "Copy link" |
| 6132 | info | "X feed is connected. Now start the Broadcast on X." · Media Studio steps | "Open Media Studio" · 20 s | a | — |
| 6666 | success | "{device} paired with Videorc" | — | a | — |
| 7272 | success/warning | "Clip marked at {m:ss}" / "Recording is off, so this clip can't be saved." · "Turn on Record in the Studio…" | `clip-marked` | a / c | desc "Turn on Save local recording on the Output page." + "Open Output" |
| 7408 | notifyOnce error | backend `error` event text | per text | c, leak | console; user copy "Videorc hit a problem" · "Export a support bundle from Health if it repeats." |
| 8869 | error | "Stop the recording or stream before switching orientation." | `scene-orientation-lock` | a | type → warning |
| 9059 | notifyOnce warning | "Preview verification lagged behind the layout change" · "…output is unaffected…" | key | c, leak | silent, or info "The preview may be behind" · "Reopen it if it looks stale." |
| 9070 | error (reportError) | "Layout committed at revision {n}, but preview proof was not observed…" | — | c, leak | "Couldn't confirm the scene change" · "Check the preview; pick the scene again if it's wrong." |
| 9207 | error | "{Camera} unavailable. Choose a replacement." | `layout-source-unavailable` | a | add "…in Sources." |
| 9403 | error | "The scene is changing." / "The session is starting." / "Checking the current session…" | — | c | warning "{reason} Try again in a second." |
| 10162, 10178 | notifyOnce warning | "Notes/Chat closed for this recording" · env-var text | key | dev, leak | console; "Notes closed so they stay out of the recording" |
| 10311, 10342, 10357, 10412 | error | "… is unavailable outside Electron." | — | dev | console |
| 10331 | success | "Imported {name}." | — | b | remove |
| 10400 | success | "Support bundle exported." · file name | — | a | add reveal action |
| 10419 | success | "Hardware acceleration retry scheduled." · "Quit and reopen…" | — | b | remove (Settings line says it) |
| 11111 | error | "Live captions cannot start in this session" · reason | `captions-output-unsupported` | a | — |
| 11122 | error | "Live captions could not start" · raw ?? "The caption service is unavailable." | — | c | add Retry; mapped reason |
| 11403, 11426, 11449 | error | "Screen management is locked while live." | — | d | warning "Takeovers are locked while you're recording or live" |
| 11412 | success | "Renamed {name}." | — | b | remove |
| 11435 | success | "Deleted Screen." | — | a | "Deleted “{name}”" + Undo (J2-2) |
| 11572 | success | "Disconnected account." | — | a | "Disconnected {Platform}" |
| 11624 | success | "Approve the connection in your browser" · "Signed in on a different browser? Copy the link…" | "Copy link" · `oauth-authorization-link` · ∞ | a, d | type → info |
| 11633 | success | "Authorization link copied." | — | copy | keep, then apply the copy pattern |
| 11634 | error | "Could not copy the link." | — | c | "Couldn't copy the link" · "The page is already open in your default browser." |
| 11764 | notifyOnce error | "Account sign-in is still unavailable. Videorc kept the callback without acknowledging it." | `account-callback-retry` | c, d, leak | "Couldn't finish signing in" · "Sign in again from the account menu." + "Sign in" |
| 11785 | notifyOnce error | "Account sign-in is temporarily unavailable. Videorc will retry." | same key | d | info "Finishing sign-in…" |
| 11915 | notifyOnce error | "OAuth completion is temporarily unavailable. Videorc will retry." | `oauth-callback-retry` | d, leak | info "Finishing the {Platform} connection…" |
| 11997 | error | "Metadata draft is not loaded yet." | — | c, leak | warning "Stream details are still loading" · "Try again in a moment." |
| 12015 | success | "Saved stream metadata." | — | b | remove |
| 12017 | warning | "Saved stream metadata with warnings." | — | c | "Saved. {n} details need attention before you go live." |
| 12401 | warning | "X chat needs review for {label}." · raw | — | c | "X chat isn't connected for {label}" · reason · "Open Livestream" |
| 12428 | warning | "Could not publish {label} on X." · raw | — | c, d | "Couldn't start the X broadcast" · reason |
| 12586 | warning | "Could not end {label} on X." · raw | — | c, d | "Couldn't end the X broadcast" · "End it in X Media Studio." + "Open Media Studio" |
| 13036 | info | "Streaming at {1080p 30}." / "Recording will match the stream." | `stream-output-adjusted` | a | — |
| 13784, 13902 | warning | "Live captions are not ready." · reason | — | a | — |
| 13826 | warning | "The scheduled event changed. Review its updated visibility and details, then confirm again." | — | a | — |
| 13840 | error | "Resolve Go Live issues before starting." | — | c | warning "Fix the items marked in red, then go live." |
| 13859 | warning | "Some destinations failed setup." · "Continue with the ready destinations or cancel this Go Live." | — | a | "Some destinations aren't ready" |
| 14268 | success | "Exported MP4." | `finalization-{id}` | d | "MP4 ready" + reveal action |
| 14283 | info | "Nothing to mark yet." · "Start recording or go live…" | `clip-marked` | a | — |
| 14444 | warning | "{x} is too heavy for this computer" · "…Switch in Recording → Output." | — | c | "…{y} held steady." + action "Use {y}" |
| 14593 | warning | "Could not migrate {label} stream key." · "…Save it again from Streaming settings to remove the legacy local copy." | — | c, leak | "Save your {label} stream key again" · "Paste it in Livestream → Setup so Videorc can store it securely. It works for now." |
| 14623, 14627, 14661 | success | "{label} stream key saved/removed/restored (ends …)." | — | b | remove |
| 15235 | info | "No other available layout." | `layout-shortcut-empty` | a | "No other scene to switch to" |

**apps/desktop/src/renderer/src/lib/session-runtime-recovery.ts**
| Line(s) | Type | Copy | Action · id · duration | Class | Proposed |
|---|---|---|---|---|---|
| 43 | warning | "Couldn't start/end the YouTube broadcast." · reason | `youtube-broadcast-{step}:{id}` | a, d | the X copy aligns to this |
| 57 | notifyOnce info | three YouTube budget steps | key · 4 s | a | ≥ 8 s |
| 147 | error | "Recording stopped unexpectedly" / "Live session stopped unexpectedly" | "Open Library" + reveal · ∞ | a | "Stream stopped unexpectedly"; "Open in Library" |
| 233, 356 | warning | microphone-loss titles | ∞ | a | — |
| 242 | warning | "Backend crashed" · "Restarting automatically (attempt n)…" | `backend-lifecycle` | a, leak | "Videorc is recovering" · same desc |
| 247 | error | "Backend crashed repeatedly" · "Automatic restarts stopped. Restart Videorc to recover." | ∞ | a, d, leak | "Videorc can't recover on its own" · "Quit and reopen Videorc." |
| 253 | error | "Backend shutdown could not be confirmed" · "A replacement was not started. Quit and reopen Videorc to recover safely." | ∞ | a, d, leak | "Videorc needs a restart" · "Quit and reopen Videorc." |
| 267, 269 | error | raw backend text | `backend-transport` / key | c, leak | `userErrorMessage` |
| 276, 280, 285 | notifyOnce s/w/e | "Viewers can watch your X broadcast." / "X is still provisioning playback." / "X never produced playback for this broadcast." | `x-playback` | a | "X is still preparing your stream" / "X never showed your stream" |
| 311, 313 | success | "Account connected." / "X live authorization complete." | `oauth-callback:{p}` | a | "Connected {Platform}" / "X Live is on" |
| 315 | success | "OAuth callback received." | same | b, leak | remove |
| 321 | error | "Couldn't finish connecting {Platform}." · reason | same | a | — |
| 327 | error | same title · "OAuth completion is still unavailable. Videorc kept the callback without acknowledging it." | same | c, d, leak | desc "Connect {Platform} again from Livestream → Setup." + "Open Livestream" |
| 374 | success | "Recording saved" | "Play" / "Open in Library" · 12 s | a | — |
| 387 | warning/error | startup: "Recording started on an unsteady compositor", "Recording at a lower resolution", "Recording is falling behind", "Microphone can't be changed this session", "Going on without a microphone", "Could not start" | per code | a | first → "The first seconds may stutter" |
| 399 | warning | "Recording is not 100%" · backend text | "Open Library" · 15 s | c | "This recording has dropped frames" |
| 407 | error/warning | "Recording has no sound" / "Microphone is silent" | 15 s | a | — |
| 429, 435, 441 | e/w/s | "Your stream stopped" / "Your stream is frozen" / "Your stream is moving again" | `stream-output` · ∞/∞/8 s | a | — |
| 448, 454 | e·w/s | "Screen capture stopped" / "Screen capture is back" | `screen-capture` | a | — |
| 460 | warning | "This computer is overloaded" | 20 s | a | also show as a persistent Health verdict |
| 475 | warning | "System audio paused: your stream was echoing" | "Resume" · ∞ | a | — |
| 482, 487 | notifyOnce w/s | "Audio dropped for a moment" / "Microphone is back" | key | a | — |
| 495 | success | "Noise cleanup complete" · "A separate cleaned copy is ready…" | "Play" / reveal · 15 s | a | — |
| 505 | error | raw `openSession` problem | — | c | "Couldn't play this recording" · reason + reveal |
| 525 | error | backend Premium text / "Premium required for this Go Live setup." / "…media profile." | "View Premium" · 15 s | a | type → info; "{Feature} is part of Videorc Premium"; never for non-plan limits |
| 533 | warning | "Source changed while streaming/recording. Check the output before continuing." | 10 s | a | name the device: "Camera switched to {name}" |

**apps/desktop/src/renderer/src/components/tabs/library-tab.tsx**
| Line(s) | Type | Copy | Class | Proposed |
|---|---|---|---|---|
| 172 | error | raw ?? "Import failed." | c | "Couldn't import {file}" · reason |
| 182 | success | "Recording moved to Trash." / "{n} recordings moved to Trash." | a | — |
| 190 | error | raw ?? "Delete failed." | c | "Couldn't move the recording to Trash" · reason |
| 205 | error | raw ?? "Rename failed." | c | "Couldn't rename the recording" · reason |
| 759 | success | "Recording duplicated." | b | remove; focus the new row |
| 761 | error | raw ?? "Duplicate failed." | c | "Couldn't duplicate the recording" · reason |
| 805 | error | raw `openSession` problem | c | as session-runtime-recovery 505 |
| 820, 850 | success | "Passes every quality gate." / "Recording already passes every quality gate." | a, d | one: "No problems found" |
| 823 | warning | "{n} quality issue(s) found." · reason | a | — |
| 833, 854 | error | raw ?? "Quality check failed." / "The quality check could not run." | c, d | "Couldn't check the recording" · reason · Retry |
| 846 | success | "Repaired with interpolated frames." / "Recording repaired." | a | — |
| 852 | warning | "Kept the original. It could not reach 100%." | c | "Couldn't fully repair the recording" · "The original is unchanged." |
| 857 | error | raw ?? "Repair failed." | c | "Couldn't repair the recording" · reason |
| 867 | success | "Restored the original recording from backup." | a | — |
| 872 | info | "No backup was found for this recording." | a | — |
| 875 | error | raw ?? "Restore failed." | c | "Couldn't restore the original" · reason |
| 902 | info | noise-cleanup cancel notices | a | "canceled" (J2-21) |
| 906 | success | "Noise cleanup queued." · "Videorc will create a separate cleaned copy…" | b | remove; the row shows progress |
| 910 | error | "Could not cancel cleanup." / "Noise cleanup failed." · raw | c | "Couldn't cancel / start noise cleanup" · reason · Retry |

**apps/desktop/src/renderer/comments/main.tsx**
| Line(s) | Type | Copy | Class | Proposed |
|---|---|---|---|---|
| 324 | error/warning | removal outcome ("Hidden in Videorc. Viewers may still see it.", …) | a | — |
| 330, 350, 434, 468, 491, 516, 662, 686, 703 | error | raw IPC error ?? "Could not remove the message." / "Could not answer the removal." / "Buddy action failed." / "Could not answer Buddy." / "Could not change the Buddy setting." / "Could not change the Buddy chat mode." / "Could not mark the clip." / "Could not open the Twitch reconnect." / "Could not open the reconnect." | c | strip the IPC prefix; "Couldn't remove the message", "Couldn't change Buddy's chat mode", "Couldn't open the Twitch page"… · mapped reason |
| 656 | success/warning | clip marked | a | — |
| 680, 697 | success | "Allow the follow permission in your browser" / "Approve the {Platform} permission in your browser" | a, d | info; one verb, "Approve" |

**Other files** (full paths)
| Location | Type | Copy | Class | Proposed |
|---|---|---|---|---|
| `apps/desktop/src/renderer/src/lib/global-shortcuts.ts:46` | error | "Streaming is not configured" · "Enable streaming in the Studio before using the Go Live shortcut." | c | the shortcut opens Go Live; if no destination is ready, warning "Set up a destination to go live" + "Open Livestream" |
| `apps/desktop/src/renderer/src/lib/global-shortcuts.ts:68,73` | warning | system audio needs access / not available | a | — |
| `apps/desktop/src/renderer/src/lib/global-shortcuts.ts:162` | error | "Some global shortcuts could not be registered" · "{action ids}: invalid, duplicate or already used…" | c, leak | list labels ("Go live / end stream, Mark a clip: another app uses them") |
| `apps/desktop/src/renderer/src/lib/global-shortcuts.ts:173` | error | "Global shortcuts could not be registered" · "…system shortcut registry. Try again." | c | add "Open Shortcuts"; "Restart Videorc if they still don't work." |
| `apps/desktop/src/renderer/src/components/tabs/assets-tab.tsx:127` | error | "Image import is unavailable outside Electron." | dev | console |
| `apps/desktop/src/renderer/src/components/tabs/assets-tab.tsx:132` | error | "All preset slots are full. Replace one from its ⋯ menu." | a | type → warning; "background slots" |
| `apps/desktop/src/renderer/src/components/tabs/assets-tab.tsx:152` | success | "Imported {name}." | b | remove |
| `apps/desktop/src/renderer/src/components/tabs/assets-tab.tsx:154` | error | raw ?? "Could not import the background." | c | "Couldn't import the image" · reason (format/size) |
| `apps/desktop/src/renderer/src/lib/youtube-thumbnail-toast.ts:46,62,65` | warning/success | "Thumbnail not set on YouTube" (+Retry) / "Thumbnail set on YouTube" | a | — |
| `apps/desktop/src/renderer/src/lib/marker-toast.ts:16` | success | "Marker saved · {label}" (+Undo) | a | — |
| `apps/desktop/src/renderer/src/lib/marker-toast.ts:29` | error | raw ?? "Could not remove marker." | c | "Couldn't undo the marker" · "Delete it from the recording's Markers in Library." |
| `apps/desktop/src/renderer/src/lib/chat-moderation-relay.ts:109,125` | plain ∞ / typed | removal confirm/countdown (2 actions) / outcome | a | — |
| `apps/desktop/src/renderer/src/lib/chat-moderation-relay.ts:128` | error | raw | c | `userErrorMessage` |
| `apps/desktop/src/renderer/src/components/stream-manager/stream-manager.tsx:477,481,486` | plain | Buddy question / "You promised: …" / dead-air nudge | a | persona name (J2-20) |
| `apps/desktop/src/renderer/src/components/scheduled-streams.tsx:97` | error | raw `String(error)` | c | "Couldn't recover the event" · reason |
| `apps/desktop/src/renderer/src/components/scheduled-streams.tsx:345` | success | "Saved event selected. Click Go Live in Studio when ready." | b | remove (the Livestream alert shows the event) |
| `apps/desktop/src/renderer/src/components/scheduled-streams.tsx:483` | success | "Event link copied." | copy | copy pattern |
| `apps/desktop/src/renderer/src/components/clean-cut/clean-cut-card.tsx:181,231,240` | error | "Couldn't start the condensed/clean cut" / "Couldn't cut it again" / "Couldn't cancel the clean cut" · raw | c | keep titles ("Couldn't redo the clean cut"); map the reason; add Retry |
| `apps/desktop/src/renderer/src/lib/system-permission-orchestration.ts:113` | error | "Could not check {label} permission." · "Try again before changing access." | a | — |
| `apps/desktop/src/renderer/src/lib/system-permission-orchestration.ts:146` | error | "Permission request is unavailable outside Electron." | dev | console |
| `apps/desktop/src/renderer/src/lib/chat-link-actions.ts:15,33` | error | "Couldn't open that link." / "Couldn't copy that link." | c | "…Copy it and open it in your browser." / "…Select the text and press ⌘C." |
| `apps/desktop/src/renderer/src/hooks/use-whats-new.ts:76,81` | info | "Release notes are not available right now." | c | add "Open changelog" (videorc.com/changelog) |
| `apps/desktop/src/renderer/src/hooks/use-scene-presets.ts:26` | error | "Scene could not be saved. Storage is unavailable or full." | c | "Couldn't save the scene" · "Free up disk space, then save it again." |
| `apps/desktop/src/renderer/src/hooks/use-scene-presets.ts:35` | error | scene name validation | a | — |
| `apps/desktop/src/renderer/src/components/buddy-voice-commands.tsx:84,99` | error | "Could not save the voice command setting" / "Could not reconnect {label}" · raw | c | "Couldn't save…" / "Couldn't open the {Platform} page" · mapped reason |
| `apps/desktop/src/renderer/src/lib/clean-cut-notify.ts:78` | success | "Your clean cut is ready (…)" (+Review, 15 s) | a | — |
| `apps/desktop/src/renderer/src/lib/clean-cut-auto.ts:182` | warning | "Your clean cut didn't start" (+Open Buddy) | a | — |
| `apps/desktop/src/renderer/src/components/tabs/buddy-tab.tsx:525` | error | "Could not turn on Buddy Live" · raw | c | "Couldn't turn on Buddy Live" · mapped reason · Retry |
| `apps/desktop/src/renderer/src/components/settings/recording-settings.tsx:174` | error | "Could not change the fallback video encoder." · raw | c | "Couldn't change the backup encoder" · mapped reason |
| `apps/desktop/src/renderer/src/components/obs-import-dialog.tsx:187` | success | "OBS setup imported" · "Review Sources and the Scene stage. The report told you what changed." | a | desc "Check Sources and Scene." |
| `apps/desktop/src/renderer/src/components/captions/captions-controls.tsx:202` | error | "Live captions could not start" · raw | c | twin of use-studio.tsx 11122; add Retry |
| `apps/desktop/src/renderer/src/components/buddy-persona-section.tsx:76` | error | "Could not start over" · raw | c | "Couldn't start over" · mapped reason |
