# Plan 174: The UI/UX pass — every page, one language, no unsafe clicks

> **Executor instructions**: Follow this plan slice by slice. Each slice lists
> the findings it closes (IDs from the companion register
> `plans/174-ui-ux-findings.md`, which holds the evidence and the exact
> recommendation for every ID). Read those entries before you start. Run every
> "Done when" check before moving on. If anything in "STOP conditions"
> happens, stop and report; do not improvise. When a slice lands, mark its IDs
> fixed in the register and update this plan's row in `plans/README.md`.
>
> **Drift check (run first, every slice)**:
> `git log --oneline c49e7855..origin/main -- apps/desktop/src/renderer apps/desktop/src/main crates/videorc-backend/remote_web`
> Line numbers in the register were read at `c49e7855`. If an anchor moved,
> re-find it by symbol. If a _behaviour_ changed (not just a line number),
> that is a STOP condition for that finding.
>
> **Path convention**: paths without a leading `apps/`, `crates/`, `docs/`,
> `plans/` or `scripts/` are relative to `apps/desktop/src/renderer/src/`.

## Status

- **Priority**: Phase 0 is P0 (it can end a live stream, post as the
  streamer, turn the microphone back on, or delete data without asking). The
  rest is P1/P2 product quality.
- **Effort**: XL. 5 phases, 53 slices. Phase 0 is about one week of agent
  work; the whole program is several weeks if run in parallel lanes.
- **Risk**: MEDIUM. Mostly renderer-only. The risky slices touch session
  start/stop (S0.1, S3.1), Buddy consent (S0.2, S3.14a), capture selection
  (S1.9, S3.8), scene composition (S3.9) and the phone remote (S3.20); each of
  those carries the AGENTS.md smoke for its area.
- **Depends on**: PR #647 (Buddy, plans 164–172) being merged before S0.2 and
  every Buddy slice (S3.13, S3.14, S3.15). PR #653 (plan 173, Sources
  rewrite) merged on 2026-10-10 as `f4735e4f`; S1.9 and S3.8 re-audit
  against it first (see "In-flight work"). The audit baseline already includes #647,
  because it touches 216 renderer files and a pass on bare `main` would
  conflict with all of them.
- **Category**: UI/UX, accessibility, copy, IA
- **Planned at**: `c49e7855` (= `origin/main` `72b47404` + PR #647 head),
  2026-10-10
- **Route**: UI/Product Design owns the program (fit 9). The orchestrator
  sequences phases and keeps the register current. Each slice names its own
  owner route and model lane per `CLAUDE.md`.
- **Execution (owner call 2026-10-10)**: the whole plan is executed inside
  PR #647 (branch `plan-164-golem-b`), on top of its head with `main`
  (including #653) merged in first. Every "#647 merged" dependency is met
  by that base. Owner decisions not answered below follow the
  recommendation.
- **Owner calls (2026-10-10)**: the Buddy page stays directly under Studio,
  because it sells Premium, and Clean cut stays in it (D6, D8); a click on a
  live chat row keeps putting it on stream (D10). The other decisions are
  still recommendations.

## In-flight work this plan must respect

- **PR #647** (Buddy, plans 164–172) is the audit baseline. S0.2, S2.3b,
  S3.13 and S3.14a–S3.15b wait for it to merge.
- **PR #653** (plan 173, the Sources rewrite; merged 2026-10-10 as
  `f4735e4f`, after this audit) rebuilds the
  Sources page: Video beside Audio, one `SourceItem` per source,
  `lib/source-status.ts` (one chip vocabulary and `uncoveredDeviceWarnings`),
  Sync folded into the microphone's More with a `Sync +N ms` tag, Calibrate in
  development builds only, condensed System audio copy, no dead meter,
  permission alerts that disable what they lock, and no "Monitoring" label.
  Re-audit every Sources ID against `main` before S1.9 and S3.8. It likely
  closes C-38, the placement half of C-27, the System audio paragraph, the
  Calibrate and flat-meter owner items, and parts of C-8, C-10 and C-14. C-9,
  C-24, C-30 and C-32 stay open unless #653 says otherwise. #653 keeps "Live"
  on a source chip during a session; reconcile that with D4 ("On air" only
  for on air) in S2.3a, and build S2.3a's state labels on
  `lib/source-status.ts`.
- **PR #619** removes the stream health stat from the Stream Manager stats
  bar. If it merges, drop the health half of H-10 and V-8 from S3.16b.
- **PRs #632** (separate source recordings), **#609** (dependency updates)
  and **#504** (Facebook Live) touch files this plan edits; run the drift
  check before each slice and rebase rather than redo.

## How the audit was done

1. **Eleven parallel code reviews**, read-only, each against the
   `videorc-design` skill (v2, the window family) plus Nielsen's heuristics,
   macOS HIG, WCAG 2.2 AA and shadcn/Radix practice. Areas: A shell and
   navigation · B Studio and Go Live · C Sources, Scene, Assets · D
   Livestream, scheduling, Output, Captions · E Library, player, markers,
   Clean cut · F Buddy page in use · G Buddy creation flows · H Stream Manager
   window · I Settings, Health, Notes, Phone remote · J1 design system and
   app-wide accessibility sweeps · J2 copy, toasts and states. Every finding
   cites `path:line`.
2. **A visual sweep** of the real app (isolated dev profile through
   `pnpm ui:driver`): every page and sub-tab in dark, key pages in light, the
   minimum window (960×660), the Stream Manager at 420/800/1280 px with seeded
   chat, ⌘K, the New Buddy wizard, an attempted Go Live, an expanded
   destination and the first-run permissions dialog.
3. **Every P0 was re-verified** by the orchestrator against the code before it
   went into this plan (marked ✔ in the register).

Totals: 347 findings in the register (17 P0 entries describing 11 distinct
problems, 87 P1, 187 P2, 56 P3), including 12 visual-only findings from the
screenshot sweep.

## What is already good (keep it, copy it)

- The token contract (`styles.css`), the glass float tiers, the licence-capped
  icon registry with zero bypasses, and the guard tests in
  `renderer-style-guards.test.ts`.
- The shell primitives (`Pane`, `Toolbar`, `PaneBody`, `PanelSection`,
  `StatusBar`) match the skill's measurements exactly; `workspace-nav.tsx` is
  one tested source for page labels, order and digits.
- Failure plumbing for session start (`lib/session-start-failure.ts`): a
  persistent, keyed failure with a Retry that re-runs the exact start.
- Stream Manager layout tiers by container query, the stats bar, and the pure
  view modules (`stream-manager-stats.ts`, `chat-removal-view.ts`,
  `chat-send.ts`, `stream-activity.ts`).
- Removal-card key scoping (`stream-manager/removal-cards.tsx:22-82`), the
  model every window-level key handler should copy.
- Stream-key safety on destinations, the YouTube quota-paused row, the
  failure banner's paired "is back" notices.
- Clean cut's view models and error copy keyed by code; the virtualised
  transcript.
- The disabled-with-reason wrapper in `tabs/library-tab.tsx:1135-1149`, the
  `ShortcutTooltip` in `sources/sources-audio-mixer.tsx:129-155`, the
  accessible faders, and `PowerSlider`.
- The pairing dialog and hold-to-stop on the phone remote.

## The ten problems that matter most

1. **A livestream ends on one keystroke.** Space (from any page, even from a
   focused slider or inside a dialog), the global record or stream hotkey
   (even with Videorc in the background), ⌘K "Stop session" and the Stop
   button all end a multistream instantly. YouTube broadcasts are completed
   and every audience drops. (A-1, B-1)
2. **Buddy can act as the streamer without asking.** Enter on almost any
   focused control posts Buddy's proposed message to chat as the streamer,
   even with the Buddy pane hidden; toggling any Buddy behaviour in Stream
   Manager silently turns cloud microphone listening back on. (F-1/H-1, F-3)
3. **Irreversible deletes without a question.** A ghost "Discard" in the Back
   slot deletes a Buddy the screen just called "Saved to your library";
   takeover delete removes the image file in one click; plus imported
   backgrounds, markers, the paired token, phones, accounts, the chat view
   and 18 camera values. There is no `AlertDialog` primitive. (G-1, C-1,
   C-12, E-8, I-15, D-16, H-6, C-18, J1-3)
4. **Controls that do not work.** Library's Recordings/Streams filters match
   nothing; Output's Width field transposes as you type; "Open Livestream" on
   a warning toast does nothing; Assets' Import fails on every fresh profile;
   built-in background edits vanish on relaunch; the OBS import report is
   false about backgrounds. (E-1, D-1, I-NEW, C-2, C-3, C-7)
5. **Screen-reader blockers.** Live chat rows announce "Show Alice's message
   on the stream" instead of the message; 15 form fields have no accessible
   name (including the Go Live privacy select); slider thumbs are unnamed.
   (H-2, J1-1, E-3)
6. **One thing, five names.** Going live is "Stream", "Confirm Go Live",
   "Start session", "Go live / end stream" and "End livestream"; resolution is
   spelled eight ways; layouts have three name tables; shortcuts render in
   seven notations ("Cmd+P" on macOS, "ShiftCtrlJ" on Windows); copy points
   at pages that were renamed ("Streaming tab", "Recording → Output",
   "diagnostics", "Customize", "Go to Live").
7. **Locked and disabled states hide their reason.** About 160 native
   `title=` tooltips carry essential information; on disabled controls they
   never appear at all; Tooltip cannot even mount in three of the four
   windows. Premium locks are drawn six different ways, often with enabled
   controls under a "locked" banner.
8. **Status shows raw internals.** Raw enums (`Connected`, `Waiting`,
   `Device-Missing`), CSS-capitalised Title Case chips ("Checked On First
   Use"), coloured status text that fails contrast, and a tertiary text tier
   that fails WCAG AA by its own token values.
9. **Missing primitives, so every page hand-rolls its own.** No AlertDialog,
   segmented control, Spinner, Progress, SettingsRow, DevicePicker, shortcut
   renderer or window header; 6 segmented-control looks, 4 empty-state looks,
   3 device pickers, 4 window title styles, 5 error channels.
10. **IA leftovers.** Recording setup is split between Output and Settings →
    Recording; Health has no door except the account menu; two sidebar groups
    label a single row; Electron's default menu (with Reload ⌘R and DevTools)
    ships; at the minimum window size Record/Stream/Stop sit below the fold.

## Owner decisions (answer before the gated slices)

Rows marked **Owner call** are answered: follow them as written. For the
rest, the slices assume the recommendation unless the owner says otherwise.

| #   | Question                                                                                            | Recommendation                                                                                                                                                                                                                                                                                                                                                                                                                          | Gates        |
| --- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| D1  | What does Space do? (today: app-wide start/stop, owner call in `docs/ux-ia-refactor-plan.md:71-72`) | Space = Record / Stop recording **on the Studio page only**. It never starts Go Live and never ends a livestream; while live it opens the End livestream confirmation with "Keep streaming" focused.                                                                                                                                                                                                                                    | S0.1, S3.1   |
| D2  | Confirm before ending a livestream?                                                                 | Yes: one `AlertDialog` "End livestream?" for every in-app stop path while live. Global hotkeys while live: a second press within 2 s ("Press again to end the livestream"). Stream Deck / remote-control intents and the phone's hold-to-stop keep their current contract (deliberate device actions; `smoke:remote-control` pins the protocol). Record-only sessions stop instantly.                                                   | S0.1         |
| D3  | One verb for going live (the skill says "Record / Stream / Stop")                                   | Rename the Studio button **"Go Live…"**; dialog "Go live"; stop "End livestream"; state "On air"; ⌘K "Go live…" / "End livestream"; update the skill.                                                                                                                                                                                                                                                                                   | S2.2         |
| D4  | Canonical vocabulary (the glossary in S2.1)                                                         | recording (not session); Livestream (page) / livestream (noun); scene (anything you switch to, built-in or saved) vs layout (the arrangement inside a scene) vs preset (quality presets only); takeover (not screen); "X" (not "X / Twitter"); "Buddy" with no article, or the streamer's name; "Stream Manager"; "Captions reader"; "read-only" provider; sentence case; US English UI copy (see J2).                                  | S2.1–S2.5    |
| D5  | Output page vs Settings → Recording                                                                 | One home for the local file: the Output page gets "Where recordings go" (folder, Show in Finder, Keep original); "Keep microphone ready" moves to Sources → Microphone; the FFmpeg line moves to Health/About; the Settings → Recording tab is removed (or renamed "Storage" if anything remains).                                                                                                                                      | S3.6, S3.17  |
| D6  | Where Clean cut lives (plan 119 put it under the AI tab, now the Buddy page)                        | **Owner call 2026-10-10: it stays on the Buddy page.** The Buddy page sits directly under Studio to show what Premium does, so Clean cut, its jobs and its review stay there. Fix the journey in place: each Library recording keeps "Make a clean cut…", which opens Buddy → Clean cut for that recording, and the review's back button returns to where it was opened (the Library row, or the Clean cut list). ⌘K keeps "Clean cut". | S3.13        |
| D7  | The Buddy page's first tab is also called "Buddy"; status and consent sit at the bottom             | Rename the first tab **"Profile"** and lead it with one status row (on/off, why not, Open Stream Manager ⇧⌘J). Separate the on switch, named **Buddy Live**, from "Chat posting: Off · Suggest · Auto" (today Off means both). Stream Manager shows the behaviour switches as read-only summary chips linking to Buddy → Chat (one home).                                                                                               | S3.14        |
| D8  | Sidebar groups                                                                                      | Drop the single-row labels ("Library", "System"); keep "Setup"; Settings moves to a bottom block above the account row; the Studio row shows a live dot and clock while a session runs. **Owner call 2026-10-10: Buddy stays second, directly under Studio, on ⌘9**, because it sells Premium; no slice moves it.                                                                                                                       | S3.21        |
| D9  | Health stays out of the sidebar, but needs a door                                                   | The status-bar state becomes a button that opens Health (as `docs/ux-ia-refactor-plan.md:61` specified); add "Open Health" to Degraded alerts, error toasts and About → Support; ⌘K keywords.                                                                                                                                                                                                                                           | S1.3, S3.18  |
| D10 | A click on a live chat row puts it on stream (plans 055/151)                                        | **Owner call 2026-10-10: keep it.** A click on a row puts the message on stream and a click on the live row takes it off, as today. No selection step and no separate Show button. Enter and Space do the same from the keyboard, and the row's accessible name carries the message (S0.5).                                                                                                                                             | S0.5, S3.16a |
| D11 | Empty states                                                                                        | Follow the skill: short muted text, centred, no illustration (retune `ui/empty.tsx`; Library and Takeovers lose their icon tiles).                                                                                                                                                                                                                                                                                                      | S1.5         |
| D12 | The tertiary text tier fails AA (3.99–4.11:1 on the solid, ~2.5:1 over a bright desktop)            | Raise `--subtle` to ≥4.5:1 on the solid (≈L 0.60 dark, 0.55 light), add it to the `prefers-contrast` block, and write "essential information never uses `text-subtle`" into the skill.                                                                                                                                                                                                                                                  | S1.8         |
| D13 | Segmented controls (owner rule in plan 080: "segmented choices use Tabs")                           | A Radix-free `ui/segmented-control.tsx` styled by `tabsListVariants` (no eager-chunk cost) for 2–4 exclusive options; `ToggleGroup` only for multi-select filters; `Switch` for booleans.                                                                                                                                                                                                                                               | S1.7         |
| D14 | Ten prefilled background slots make Import fail                                                     | Import opens the file picker, then "Replace which background?" with the ten tiles. (Extra user slots: out of scope.)                                                                                                                                                                                                                                                                                                                    | S0.4b        |
| D15 | Scene editor undo (out of scope in plans 043/058)                                                   | Add a single-level ⌘Z for the last committed layout patch, and remember Freeform overrides per orientation.                                                                                                                                                                                                                                                                                                                             | S3.9         |
| D16 | Microphone mute on Studio (owner call 2026-10-02: picker and level only)                            | Add a mute button in the Microphone section header with its hotkey chip and a "Muted" status; muted must not look like silence.                                                                                                                                                                                                                                                                                                         | S3.3         |
| D17 | "Animate scene changes" lives in Settings → General                                                 | Move it to the Scene page (it changes what viewers see); Settings keeps a pointer row.                                                                                                                                                                                                                                                                                                                                                  | S3.9, S3.17  |
| D18 | Windows sidebar repeats the icon and "Videorc" under a native title bar                             | Drop the sidebar mark on win32 (or adopt `titleBarOverlay`).                                                                                                                                                                                                                                                                                                                                                                            | S3.21        |
| D19 | Go Live and Stop are one session (plan 095 S5)                                                      | Keep, but label it honestly: "End livestream" carries the visible line "Your recording stops too." A separate "end stream, keep recording" is out of scope.                                                                                                                                                                                                                                                                             | S0.1         |
| D20 | Manual "Remove from chat" (⋯ menu and ⇧⌫) runs at once                                              | Give it a 3 s "Removing… · Undo" first.                                                                                                                                                                                                                                                                                                                                                                                                 | S3.16a       |

## Phases at a glance

| Phase | What                                                 | Slices     | Can start                           |
| ----- | ---------------------------------------------------- | ---------- | ----------------------------------- |
| 0     | Stop the harm: P0s and silent dangers                | S0.1–S0.6  | now (S0.2 after #647)               |
| 1     | Foundations: one primitive and one formatter per job | S1.1–S1.10 | now, parallel to Phase 0            |
| 2     | Vocabulary and copy                                  | S2.1–S2.5  | after D3/D4; S2.1 first             |
| 3     | Pages and windows (consume Phase 1)                  | S3.1–S3.21 | per slice, after its Phase 1 inputs |
| 4     | Guardrails, docs, acceptance                         | S4.1–S4.3  | last                                |

Parallel lanes that do not collide: (a) Studio/session (S0.1, S3.1–S3.4);
(b) Stream Manager/Buddy (S0.2, S3.13, S3.14, S3.15, S3.16); (c) Library
(S3.11, S3.12); (d) Sources/Scene/Assets (S3.8–S3.10); (e) Settings/Health/
remote (S3.17–S3.20). S3.13 also edits the Library's "Make a clean cut…"
item, so it rebases on S3.11. Phase 1 slices touch `components/ui/*` and
shared primitives: land each one, then rebase the lanes.

---

## Phase 0 — Stop the harm

### S0.1: Ending a livestream takes intent

- **Closes**: A-1, B-1, B-14 (Space inside the Go Live dialog), D-4, B-16
  (labels while live), D19.
- **Route / lane**: Diagnose → Implementation, fit 9, `fable-5` (session
  stop path, release-critical).
- **Files**: `hooks/use-studio.tsx` (Space handler `:14821-14880`,
  `isEditableTargetSafe` `:15933`, `stopSession` `:13936`), `lib/global-shortcuts.ts:36-50`,
  `components/command-palette.tsx:194-209`, `components/studio/session-panel.tsx:93-127`,
  `lib/studio-session-view.ts:136-144`, `components/tabs/streaming-tab.tsx:396-401`,
  `components/app-shell.tsx`, new `components/ui/alert-dialog.tsx`, new
  `lib/session-stop.ts`, new `components/end-livestream-dialog.tsx`.

1. Install shadcn `alert-dialog` (`pnpm dlx shadcn@latest add alert-dialog`
   in `apps/desktop`, per the shadcn skill). Move it onto `border
glass-float-dialog rounded-panel p-5` (the guard test rejects
   `bg-popover`); no ✕; Cancel is focused on open; Esc cancels.
2. Add a pure `lib/session-stop.ts`:
   `stopDecision({ origin, live, armedAt, now })` →
   `'stop' | 'confirm' | 'arm'`. Origins: `button`, `space`, `palette`,
   `global-hotkey`, `remote-control`, `phone-remote`, `failure-banner`.
   Record-only sessions return `'stop'` for every origin. Live: `button`,
   `space`, `palette`, `failure-banner` → `'confirm'`; `global-hotkey` →
   `'arm'`, then `'stop'` on a second press within 2 s; `remote-control` and
   `phone-remote` → `'stop'` (deliberate device actions; the phone already
   uses hold-to-stop).
3. Add `requestStopSession(origin)` to the studio provider and route every
   stop path through it. Host `EndLivestreamDialog` in `AppShell` (so it works
   from every page): title "End livestream?", body "Viewers on {platforms}
   are disconnected. Your recording stops too and is saved to the Library.",
   buttons "Keep streaming" (focused) and "End livestream" (destructive).
4. Space: move the handler out of the provider into the Studio page so it
   exists only there, and act only when no
   `[role=dialog][data-state=open]` or open menu exists, and the target is not
   inside a widget (`a[href]`, `[role=slider|switch|tab|menuitem|option|listbox|combobox|radio|checkbox]`,
   `[role=dialog] *`, plus today's inputs and buttons). Idle → Record (D1);
   recording-only → Stop recording; live → open the confirmation.
5. The armed state for hotkeys shows one keyed toast "Press again to end the
   livestream" (no success icon).
6. Labels: while live the Stop control reads "End livestream" with the
   visible line "Your recording stops too." (not a `title`); the failure
   banner's "Stop all" becomes "End livestream" and uses the dialog.
7. Tests: `session-stop.test.ts` (decision table, including armed expiry);
   key-gating tests for slider, dialog-body, menu and tab targets; palette
   and banner paths open the dialog; "Keep streaming" has focus.

**Done when**:

- `pnpm --filter @videorc/desktop test session-stop global-shortcuts command-palette app-shell studio`
- `pnpm typecheck && pnpm lint`
- `pnpm smoke:remote-control` (remote intents still round-trip) and
  `pnpm smoke:record-latency:gate` (AGENTS.md: start/stop paths)
- By eye in `pnpm ui:driver`: Space on Library does nothing; Space on Studio
  while idle starts a recording.

### S0.2: Buddy never posts or listens without the streamer

- **Closes**: F-1/H-1, F-3, F-9, H-5.
- **Depends on**: PR #647 merged.
- **Route / lane**: Implementation, fit 9, `fable-5` (consent and posting as
  the streamer).
- **Files**: `components/stream-manager/buddy-utterance-cards.tsx:44-66`,
  `components/stream-manager/removal-cards.tsx:37-82` (reuse
  `removalKeyAnswer`), `components/stream-manager/stream-manager.tsx:582-649`,
  `hooks/use-studio.tsx:4670-4690`, `lib/cohost-state.ts:18-22`,
  `comments/main.tsx` (`apps/desktop/src/renderer/comments/main.tsx:481-512`, `:606`),
  `components/cohost-pane.tsx:311-317`.

1. Suggest cards: answer keys through `removalKeyAnswer` (Enter only with
   nothing focused; ignore repeat, IME, modifiers, `defaultPrevented`), in the
   bubble phase, and attach the listener only while the Buddy pane is
   visible.
2. Count proposed utterance ids in the Buddy tab's unseen badge and add them
   to the auto-reveal set, like removal cards.
3. The enable relay writes `listen: true` only on an off→on transition;
   behaviour-only patches save `{ autoChat }` alone.
4. Replace the truncated one-line cloud-AI notice with a wrapping `Alert`
   ("Buddy needs cloud AI", the full `CLOUD_AI_USES` list, action "Turn on
   cloud AI…" that opens the consent dialog). One click never grants consent
   and listening at once.
5. Tests: a new `buddy-utterance-cards.test.ts` modelled on
   `removal-cards.test.ts` (Enter on a focused chat-row button does not
   approve); a relay test that `listen` stays false after a Greetings toggle.

**Done when**: the tests above, `pnpm typecheck && pnpm lint`,
`pnpm probe:comments-window`.

### S0.3: Confirm or undo every destructive action

- **Closes**: G-1 (and the restored Back from G-13), C-1 (= J2-2), C-12,
  C-18, E-2 (= J2-1), E-8, H-6, I-15, I-16, D-16, J1-3, plus the 12 existing
  confirms migrated.
- **Route / lane**: Implementation, fit 8, `opus-4.8` (copy and dialog
  anatomy).
- **Depends on**: the `AlertDialog` from S0.1 (if S0.3 lands first, it
  installs it).
- **Files**: `components/buddy-onboarding.tsx:405-428`,
  `components/buddy-look-section.tsx:181-189`,
  `components/takeover-screens-section.tsx:72,220-231`,
  `components/tabs/assets-tab.tsx:212-266`,
  `components/tabs/layout-tab.tsx:946-981`,
  `components/tabs/library-tab.tsx:487-524`,
  `components/session-markers-dialog.tsx:195-203`, `lib/marker-toast.ts`,
  `components/stream-manager/stream-manager-status-bar.tsx:231-252`,
  `components/settings/remote-settings.tsx:41-90`,
  `components/phone-remote-section.tsx:272-280`,
  `components/streaming/destination-card.tsx:1029-1044`, and the 12 existing
  confirm dialogs listed under J1-3.

1. One recipe, written once as `components/confirm-dialog.tsx` over
   `AlertDialog`: title "Verb object?", one sentence that names exactly what
   is lost (the Scenes confirm in `scene-presets.tsx:204-217` is the model),
   ghost "Keep …"/"Cancel" focused, destructive button labelled verb + object.
2. New confirms (copy in the register): Buddy draft Discard → "Delete
   {name}?" (button relabelled "Delete…", moved out of the Back slot, Back
   restored); takeover delete; imported background remove; Reset camera
   settings; Regenerate pairing token; Remove phone; Disconnect account (names
   YouTube and YouTube Vertical); turning Remote control off while phones are
   connected.
3. Undo instead of confirm where the action is frequent and cheap to
   restore: marker delete (defer `session.marker.delete` until the Undo toast
   closes) and Clear view (restore the snapshot) — or confirm, if deferral is
   not possible.
4. Rewrite the Library delete copy (E-2): "Move this recording to the Trash?"
   / "The video file goes to the Trash. Its Library entry, markers, Buddy
   report and chat history are deleted and can't be restored." Add a guard
   test that fails on `\b[A-Z]\w+Icon\b` inside JSX text and string literals.
5. Migrate the 12 existing confirms onto the recipe (one ✕ rule, ghost
   Cancel, focus on the safe button, verbs that match titles).

**Done when**: a test per new confirm (dialog opens, Cancel keeps the item,
the destructive button calls through), the icon-name guard, `pnpm
typecheck && pnpm lint && pnpm --filter @videorc/desktop test`,
`pnpm smoke:remote-lan` (pairing token and device removal).

### S0.4a: Fix the controls that do nothing or do the wrong thing (Library, Output, navigation)

- **Closes**: E-1, D-1, I-NEW, D-8, B-27, I-PAT-12 (typed navigation).
- **Route / lane**: Implementation, fit 8, `gpt-5.5`.
- **Files**: `lib/library-view.ts:18-30` (+ test fixtures),
  `components/tabs/recording-tab.tsx:190-270`, `hooks/use-studio.tsx:14333`
  and `:2457-2461`, `components/studio/quick-settings.tsx:229`,
  `lib/output-quality.ts:29-57`, `components/go-live-dialog.tsx:180-184`,
  `components/app-shell.tsx` (navigation event), new `lib/workspace-navigation.ts`.

1. Library filters: one shared mode helper beside `CLEAN_CUT_SOURCE_MODES`
   (recordings = `record`, `record+stream`, `imported`, legacy `recording*`;
   streams = `stream`, `record+stream`, legacy `streaming*`); rewrite the test
   fixtures with the backend's values.
2. Output number fields: local draft per field, commit on blur/Enter, clamp to
   min/max on commit, never transpose a typed value (show "A landscape scene
   needs a width at least as large as the height." instead).
3. A typed `openWorkspaceTab(tab, subTab?)` replaces raw
   `videorc:navigate-workspace` events; fix the toast that sends `'streaming'`.
4. Studio's Output row and the Output page both call one
   `pickRecordingResolution()` (bitrate moves with size).
5. Fix the missing space in the Go Live scheduled-event note.

**Done when**: `library-view.test.ts` with real backend modes; a
recording-tab test ("typing 2560 into Width gives 2560×1080"); a navigation
test for every `openWorkspaceTab` id; a test that both resolution surfaces
produce the same bitrate; `pnpm typecheck && pnpm lint`.

### S0.4b: Fix Assets, OBS import and silent overlay failures

- **Closes**: C-2 (D14), C-3, C-7, C-29, C-6, C-4 (Freeform discard guard).
- **Route / lane**: Implementation, fit 8, `gpt-5.5`.
- **Files**: `lib/background-assets.ts:143-150,333-410,574-652`,
  `components/tabs/assets-tab.tsx:126-176`, `components/obs-import-dialog.tsx:72-189`,
  `lib/obs-import-map.ts:358-365`, `lib/obs-import-apply.ts`,
  `components/tabs/layout-tab.tsx:181-236`, `components/scene/overlay-stage.ts:132-136`,
  `hooks/use-studio.tsx:2645-2651,9234-9240`.

1. Import with no empty slot: file picker, then "Replace which background?"
   (the ten tiles, the active or last slot preselected).
2. `reconcileRegistry` keeps stored `name` and `styleDefaults` for built-in
   ids (this build's URLs win); reconcile test for a renamed, restyled
   built-in.
3. OBS import: resolve the background slot while building the report and say
   what will happen; apply the background when the report promises it; error
   states for a failed read ("Couldn't read this OBS profile. {reason}" + Try
   again) and a failed discovery; visible "Scene collection" / "Profile"
   labels, sentence-case notes, one icon on the final button, `ScrollArea`,
   and a closing toast that doesn't refer to the closed report (C-29).
4. Overlay switch, snap and drag failures go through `reportError`; when the
   backend is disconnected, the overlay inspector is disabled with one reason.
5. Freeform: remember the last Freeform overrides per orientation and restore
   them when Freeform is chosen again (the full undo is S3.9).

**Done when**: unit tests for each (slot choice, reconcile, report text,
failure reporting, Freeform memory); `pnpm typecheck && pnpm lint`;
`pnpm smoke:recording-studio` (AGENTS.md: layout composition) —
if blocked by permissions, run the closest focused scene/layout smoke and say
why.

### S0.5: Assistive-technology blockers

- **Closes**: H-2, J1-1 (with D-2, B-2), E-3, E-26, F-15, C-16 (names only),
  G-8, D-12/J1-9 (nested switch in the destination row), A-21.
- **Route / lane**: Implementation, fit 8, `gpt-5.5`; H-2 reviewed by
  `opus-4.8`.
- **Files**: `components/ui/field.tsx:80-140`, `components/ui/slider.tsx:20-45`,
  `components/comment-row.tsx:898-925`, the 15 Field sites in J1-1,
  `components/tabs/library-tab.tsx:287`, `components/buddy-greetings-section.tsx:218-230`,
  `components/streaming/destination-card.tsx:309-348`, `components/account-menu.tsx:86`,
  `renderer-style-guards.test.ts`.

1. `Field` puts a `useId()` in context; `FieldLabel` defaults `htmlFor`;
   Input, Textarea, SelectTrigger, Switch, Slider and Checkbox default their
   `id`; ToggleGroup and TabsList default `aria-labelledby`.
2. Fix the 15 sites, the Library filter select, and the Buddy settings
   ToggleGroups.
3. Slider: forward `aria-label`, `aria-labelledby` and `aria-valuetext` (or
   `getValueText`) to each Thumb; the player passes "2:05 of 41:10".
4. Live chat rows stay one button whose click puts the message on stream
   (owner call, D10). Name it by its content (author, platform, text); keep
   `aria-pressed` for "on stream"; move the action into `aria-description`
   ("Shows it on stream" / "Takes it off the stream").
5. Un-nest the Switch from `role="button"` rows (greetings, destinations):
   the title area becomes the real button; the Switch is a sibling.
6. Account trigger: drop the `aria-label` that hides the visible "Sign in".
7. AST guards in `renderer-style-guards.test.ts`: every `SelectTrigger` has
   an `id` or `aria-label`; a `Field` holding a control associates its label;
   no `Switch` inside `role="button"`.

**Done when**: the guards, unit tests for Field association and the slider
thumb name, `pnpm probe:comments-window`, `pnpm typecheck && pnpm lint`.

### S0.6: No silent danger in the global chrome

- **Closes**: A-8 (application menu), I-2 (Notes capture protection), B-6
  (record+stream notices), B-5/A-3 (Go Live dialog visible from every page).
- **Route / lane**: Implementation, fit 8, `gpt-5.5` (main-process menu
  reviewed by `fable-5`).
- **Files**: `apps/desktop/src/main/index.ts` (new `app-menu.ts`),
  `lib/shortcuts.ts`, `components/workspace-nav.tsx`,
  `components/notes-window.tsx:91-95,219`, `apps/desktop/src/main/index.ts:2809-2812`,
  `hooks/use-studio.tsx:5053`, `lib/session-runtime-recovery.ts:209-214,532-536,622-626`,
  `components/tabs/studio-tab.tsx:168-182`, `components/app-shell.tsx`.

1. Application menu built from `workspace-nav` and `SHORTCUTS`: Videorc
   (About, Settings… ⌘,, Check for Updates…, Quit), Edit (roles), View (pages
   ⌘1–⌘9, Theme, Enter Full Screen; **no Reload or DevTools when packaged**),
   Window (Preview ⌘P, Notes ⇧⌘N, Stream Manager ⇧⌘J, Captions reader ⇧⌘C,
   standard roles), Help (Keyboard Shortcuts, Release Notes, Export Support
   Bundle). On Windows hide the bar (`autoHideMenuBar` or a null menu).
2. Notes: footer "Hidden from recordings and streams" when `protected`; a
   destructive `Alert` "These notes can appear in your recording" when
   protection failed (forward the main-process failure instead of only
   logging it).
3. Runtime notices use `sessionIsLive()` in all four places; add an
   integration case for `state: 'recording'` with a `streamUrl`.
4. Mount `GoLiveConfirmationDialog` in `AppShell` (it reads `useStudioCore`),
   with a test that it renders while `active === 'live'`.

**Done when**: a menu-template test (no `reload`/`toggleDevTools` roles when
`app.isPackaged`), notes and notice tests, `pnpm typecheck && pnpm lint`,
`pnpm probe:preview-lifecycle` (the menu routes the Preview toggle).

---

## Phase 1 — Foundations: one primitive and one formatter per job

### S1.1: Window providers, tooltips and disabled reasons that work everywhere

- **Closes**: J1-6 (providers), J1-17, J1-2 (DisabledReason), F-12 (part),
  B-9 (part).
- **Route / lane**: Implementation, fit 8, `gpt-5.5`.
- **Files**: `App.tsx`, `apps/desktop/src/renderer/comments/main.tsx:821`,
  `apps/desktop/src/renderer/notes/main.tsx`, `apps/desktop/src/renderer/captions/main.tsx`,
  `components/ui/tooltip.tsx`, `components/sources/sources-audio-mixer.tsx:129-155`,
  `components/tabs/library-tab.tsx:1135-1149`.

1. `components/window-providers.tsx`: `TooltipProvider` (600 ms) plus a
   `Toaster` whose offset clears that window's status bar (main 26 px, Stream
   Manager 32 px) with one `visibleToasts`/`closeButton` policy. Use it in
   all four entries.
2. Promote `ShortcutTooltip` to `components/ui/shortcut-tooltip.tsx` (label +
   `KbdGroup`).
3. Promote the Library wrapper to `components/ui/disabled-reason.tsx`
   (`<DisabledReason reason>` = focusable span + Tooltip + `aria-describedby`)
   and use it at the 7 sites in J1-2.

**Done when**: a render test that `Tooltip` mounts in each window entry; a
`DisabledReason` test (focusable, described); `pnpm typecheck && pnpm lint`.

### S1.2: One way to show a shortcut

- **Closes**: A-5, I-18, H-22, F-22, G-23, A-17, J1-16, the "Cmd+P" and "Alt
  / ⌥" chips (V-X1), C-37 (keys).
- **Route / lane**: Implementation, fit 8, `gpt-5.5`.
- **Files**: `lib/platform.ts:4-97`, `apps/desktop/src/shared/accelerator.ts:330-360`,
  `lib/shortcuts.ts`, `components/ui/kbd.tsx`, every site listed in A-5/I-18,
  `components/app-shell.tsx:301-338` (modifier check), `apps/desktop/src/main/index.ts:2210`.

1. Author `SHORTCUTS` as accelerators (`CmdOrCtrl+Shift+J`).
2. One `<ShortcutKeys accelerator="…">` built on `acceleratorDisplayKeys`:
   macOS one keycap in system order (⇧⌘J); Windows/Linux "Ctrl+Shift+J";
   ␣→Space, ⌫→Backspace, ↵→Enter, ⌦→Delete off macOS.
3. `displayKeyGlyph` falls back to `document.documentElement.dataset.platform`
   (set before first paint), so nothing flashes "Ctrl" on a Mac.
4. `aria-keyshortcuts` uses `Meta+` on macOS and `Control+` elsewhere.
5. Shell keydown accepts `metaKey` on macOS and `ctrlKey` elsewhere (frees
   ⌃K and ⌃P for text editing).
6. A Kbd style for chips inside primary and destructive buttons.
7. Guard: no `Cmd+` strings and no hard-coded `⌘X` literals in renderer TSX
   outside `lib/platform.ts` and the shortcut modules.

**Done when**: formatter tests per platform, the guard, `pnpm typecheck &&
pnpm lint`, by eye: status bar, sidebar hold-⌘, ⌘K, Settings → Shortcuts and
Studio "Open preview" all read ⌘P / ⇧⌘J.

### S1.3: Status words, not enums

- **Closes**: A-6 (= C-39, J2-15), A-4, B-17, I-6 (status-bar door), D9.
- **Route / lane**: UI/Product Design, fit 8, `opus-4.8`.
- **Files**: `components/status-badge.tsx:58`, `components/status-dot.tsx:7-45`,
  `components/app-shell.tsx:411-421,505`, `components/account-menu.tsx:141`,
  `lib/studio-session-view.ts:152-199`, `lib/library-view.ts:86-92`,
  `components/tabs/diagnostics-tab.tsx:173-248`.

1. Remove `capitalize` from both primitives; callers pass sentence-case
   labels (a `previewStateLabel()` for Health's raw states).
2. One tone API (`StatusDot` gains a real `live` tone).
3. The status bar, the account menu's Health row and Library use
   `sessionStatusLabel`/`sessionStatusTone`; pulse only while recording or on
   air; show the elapsed time ("● On air 12:04"); `role="status"`.
4. The status-bar state is a button that opens Health.
5. The Studio pill gets an icon per state (record, live, alert) and a neutral
   "Not ready" when start is blocked.
6. Dev-only assertion and a test that status primitives reject
   `/^[a-z-]+$/` values.

**Done when**: unit tests for labels and the assertion, `pnpm typecheck &&
pnpm lint`, by eye (backend stopped: "Videorc is reconnecting…", not "Closed").

### S1.4: Formatters: one spelling per fact

- **Closes**: D-22, B-15 (format), E-20, D-36, B-24/C-20, I-25 (placeholders),
  H-10 (placeholders), I-9/C-30 (platform copy), V-X2, V-X3, the "2207h 25m"
  relative time.
- **Route / lane**: Implementation, fit 8, `gpt-5.5`.
- **Files**: new `lib/format-video.ts`, `lib/format-time.ts`,
  `lib/platform-copy.ts`, `lib/layout-labels.ts`; call sites in the register
  entries.

1. `formatVideoQuality(video, { size: 'short' | 'full', bitrate? })`:
   "1080p · 30 fps · 6 Mbps" (short), "1920 × 1080 · 30 fps" (full). Replace
   the eight spellings.
2. `formatTimecode` ("2:05", "1:02:05") for every clock and table cell;
   relative times roll over to days and dates.
3. `platformLabel()` ("X", "Custom RTMP") replacing five label maps.
4. `LAYOUT_PRESET_LABELS` ("Screen + camera", "Screen only", "Camera only",
   "Side by side"; "Vertical …" only where both orientations are listed).
5. One "–" placeholder with a reason, and a plural helper ("1 drop", "12
   drops").
6. `platformCopy`: `deviceNoun` (Mac / PC / computer), `osSettingsName`, the
   default recordings path from the backend.

**Done when**: unit tests per helper, no remaining ad-hoc formats (grep list
in the register), `pnpm typecheck && pnpm lint`.

### S1.5: Feedback primitives: Alert, LockAlert, Empty, Spinner, Progress, FieldError

- **Closes**: J1-8, D-38, G-26 (role), J1-13, V-X5, D-13 (LockAlert), J2-9
  (SessionLockAlert), J1-21 (Spinner, Progress), J1-5/I-26 (FieldError),
  E-PAT (quiet alert).
- **Route / lane**: UI/Product Design, fit 8, `opus-4.8`.
- **Files**: `components/ui/alert.tsx`, `components/ui/empty.tsx`,
  `components/ui/field.tsx` (FieldError), new `ui/spinner.tsx`,
  `ui/progress.tsx`, `components/tabs/buddy-tab.tsx:285-313` (BuddyUnlockAlert →
  `components/lock-alert.tsx`).

1. Alert: role from variant (`destructive` → `alert`, others → `status`), a
   default icon per variant (one weight), new `locked` and `quiet` variants
   (replacing the 7 `AlertTitle className="font-normal text-muted-foreground"`
   overrides).
2. `LockAlert`: lock icon, the reason as title, one action ("View Premium" /
   "Sign in"); leads the tab; everything under it disabled.
3. `SessionLockAlert`: one neutral Alert with a lock icon, one copy ("Locked
   while you're recording or live. Changes apply to your next session."),
   replacing the seven wordings in J2-9; and one offline Alert ("Videorc is
   reconnecting. These controls come back in a moment.").
4. Empty: 14 px muted text, optional 14/500 title, no media tile; migrate the
   four looks.
5. Install shadcn `spinner` and `progress`; replace 19 ad-hoc spinners and 2
   progress bars.
6. FieldError: monochrome text with a destructive icon.

**Done when**: primitive tests, `desktop-scale.test.ts` updated, `pnpm
typecheck && pnpm lint`, by eye in both themes.

### S1.6a: Rows, labels and type tokens

- **Closes**: I-7 (primitive), F-17, A-15, B-25, J1-12, C-33, I-33, A-24,
  J1-19 (GroupedList copies, `bg-inset`).
- **Route / lane**: UI/Product Design, fit 8, `opus-4.8`.
- **Files**: `components/ui/field.tsx`, `components/list-row.tsx`,
  `components/navigable-row.tsx`, `components/panel-section.tsx`,
  `components/studio/session-panel.tsx:419-466`, `styles.css` (@theme).

1. `SettingsRow` on `Field orientation="horizontal"` with a 12 px
   `FieldDescription` and automatic `aria-describedby`.
2. `ListRow`: `rounded-chip` icon tile, `interactive` defaults to `false`, an
   `as="button"` mode with the focus ring.
3. `bg-inset` utility for the 3% inset fill (≈30 copies).
4. `NavigableRow` on `SessionRow`'s metrics (h-row, px-3); Session uses it.
5. `SectionLabel` (11 px / 600 tertiary) exported once.
6. Type tokens `--text-label`, `--text-section`, `--text-meta`, and
   `--radius-tag: 7px`; FieldDescription → 12 px.
7. `PanelSection` renders `h2` by default (heading order).

**Done when**: primitive tests, `pnpm typecheck && pnpm lint`, by eye.

### S1.6b: Strips, headers, status-bar actions, dialogs, cards, menus

- **Closes**: A-14/D-29 (PaneStrip), H-28/J1-18/D-25/I-29 (WindowHeader), H-PAT
  (StatusBarAction), J1-20 (DialogContent sizes), J1-19 (MediaCard), E-PAT/A-PAT
  (KebabMenu), D-PAT/I-29 (PinWindowButton), I-1 (SupportBundleButton), I-31
  (copyText), J1-14 (menu radius).
- **Route / lane**: UI/Product Design, fit 8, `opus-4.8`.
- **Files**: `components/pane.tsx`, `components/window-frame.tsx`,
  `components/status-bar.tsx`, `components/ui/dialog.tsx`,
  `components/kebab-menu.tsx`, new `components/media-card.tsx`,
  `components/pin-window-button.tsx`, `components/support-bundle-button.tsx`,
  `lib/copy-text.ts`, `components/ui/dropdown-menu.tsx`, `context-menu.tsx`,
  `select.tsx`.

1. `PaneStrip`/`PageTabs`: pins the strip, turns `PaneBody` scroll off for
   the page (replace the hard-coded id list in `app-shell.tsx:464`), and
   remembers the last tab (Livestream gains this).
2. `WindowHeader` (traffic-light gutter, drag region, `h1` 14/600, optional
   trailing slot) for Stream Manager, Notes and Captions.
3. `StatusBarAction` (icon, label, optional keys) replacing `ACTION_CLASS`.
4. `DialogContent size="sm|md|lg|xl"` plus `DialogBody` (one max-height
   rule); fix the OBS dialog width.
5. `MediaCard` (8 px, 4% fill, hairline) for objects with a picture.
6. `KebabMenu`: groups, busy state, shortcuts; shown on hover and focus.
7. `PinWindowButton` ("Keep on top", `PinIcon`, `aria-pressed`, tooltip).
8. `SupportBundleButton` (one look; reveal action on success).
9. `copyText()` (quiet success with a 1.5 s "Copied" state; failure toast).
10. Menu, select and context items at 6 px (`rounded-chip`).

**Done when**: primitive tests, `pnpm typecheck && pnpm lint`,
`pnpm probe:comments-window` (Stream Manager header).

### S1.7: One segmented control

- **Closes**: J1-7, D13, C-15, D-28 (resolution tiles), B-29 (Follow switch),
  C-37 (one-shot snaps as buttons), I-30 (theme control).
- **Route / lane**: UI/Product Design, fit 8, `opus-4.8`.
- **Files**: new `components/ui/segmented-control.tsx`, `components/ui/tabs.tsx:22,82`,
  and the six look families listed in J1-7.

1. `SegmentedControl`: plain buttons with radio semantics and arrow-key
   roving, styled by `tabsListVariants` (no Radix, so the eager chunk is
   unchanged — record `pnpm check:renderer-assets` before and after).
2. Migrate every exclusive 2–4 option choice; `ToggleGroup` remains only for
   multi-select filters; booleans become `Switch`; one-shot actions become
   Buttons.
3. Write the rule into the skill (S4.2).

**Done when**: a keyboard test (arrows, Home/End), `pnpm
check:renderer-assets` within budget, `pnpm typecheck && pnpm lint`, by eye
on Studio, Scene, Captions, Settings, Notes.

### S1.8: Contrast and colour discipline

- **Closes**: J1-4 (D12), J1-5, D-35, I-26, C-19, J1-15, J1-10, J1-23, G-16,
  F-14 (10 px text), H-17 (10 px text).
- **Route / lane**: UI/Product Design, fit 8, `opus-4.8`.
- **Files**: `styles.css:89,214,336-359`, `components/ui/switch.tsx`,
  `components/ui/input.tsx`, `components/ui/textarea.tsx`, float motion in
  `components/ui/*`, the coloured-text sites in J1-5.

1. Retune `--subtle` to ≥4.5:1 on the solid; add it to the
   `prefers-contrast` block.
2. Move the ~60 essential `text-subtle` uses (Premium rules, quotas,
   retention disclosures, instructions) to `text-muted-foreground` or into
   descriptions.
3. Status copy monochrome: section conditions → `Alert`; inline facts →
   `StatusDot`/tone icon + monochrome text; guard on
   `text-(warning|success|destructive)` outside icon contexts.
4. Switch knob on `--knob`; Input/Textarea plain `text-sm`; floats fade and
   scale from 0.98 without slides; `behavior: reducedMotion ? 'auto' :
'smooth'` for JS scrolls; no 9–10 px text.

**Done when**: `pnpm probe:ui-glass --gate --surfaces` (contrast), the
colour-text guard, `pnpm typecheck && pnpm lint`, by eye over a bright and a
dark wallpaper in both themes.

### S1.9: One device picker

- **Closes**: C-9, B-21, C-24, C-8 (item renderer), V (None vs Off).
- **Depends on**: PR #653 (merged as `f4735e4f`); re-audit these IDs
  against it first.
- **Route / lane**: Implementation, fit 8, `gpt-5.5`, reviewed by `opus-4.8`.
- **Files**: `components/source-select.tsx`, `components/source-select-searchable.tsx`,
  `components/studio/quick-settings.tsx:387-471`, `components/studio/microphone-section.tsx`,
  `lib/source-select-state.ts`.

1. `DevicePicker` (Popover + Command, `SelectTrigger` look, 28 px rows, one
   item renderer with a trailing muted status: "Needs permission",
   "Unavailable"), `searchable` only adds the input, status rows while
   discovering ("Finding cameras…") or empty, `noneLabel="Off"` for camera and
   microphone, `trigger="inline"` for the Studio inspector.
2. The microphone gets `SourceSwitchStatus` like screen and camera.

**Done when**: picker tests, `pnpm typecheck && pnpm lint`,
`pnpm smoke:sources` and `pnpm smoke:recording-studio` (AGENTS.md: capture
selection) — if device permissions block the latter, run
`pnpm smoke:recording-studio:devices` where possible and state why.

### S1.10: `title=` is not an information channel

- **Closes**: J1-6 (migration), H-16, B-28, E-23, D-23, C-10, F-12, G-23,
  A-PAT hover hints, I-PAT.
- **Route / lane**: Implementation, fit 7, `gpt-5.5` (mechanical), split in
  three PRs: main-window pages · Stream Manager · Notes, Captions, Buddy.
- **Files**: the ~160 sites (grep `title=` in TSX).

1. Essential reasons and outcomes become visible text (a `role="status"`
   line, a `FieldDescription`, or the row's secondary line).
2. Control hints become `Tooltip`; shortcuts become `ShortcutTooltip`;
   badge explanations get a focusable trigger or `HoverCard`.
3. Keep `title` only for truncation reveal; add a guard that rejects `title=`
   on `Button`, `button`, `ToggleGroupItem` and `Badge`.

**Done when**: the guard, `pnpm typecheck && pnpm lint`,
`pnpm probe:comments-window`.

---

## Phase 2 — Vocabulary and copy

The canonical terms come from D3/D4 and the J2 terminology map (J2-10). Every
rewrite proposed by the audit is in the register; the toast rewrites are in its
Appendix A.

### S2.1: The glossary, the writing rules and a copy guard

- **Closes**: J2-10 (decision record), J2-21 (rules), J2-6 (guard), A-26,
  the vocabulary rows of C-PAT, D-PAT, H-PAT.
- **Route / lane**: UI/Product Design, fit 8, `opus-4.8`.
- **Files**: `CONTEXT.md` (it already defines Marker, Clip mark and Moment),
  new `docs/ui-copy.md`, new `apps/desktop/src/renderer/src/renderer-copy-guards.test.ts`.

1. Add a **Glossary** to `CONTEXT.md` with the D4 terms: Go Live (action),
   livestream/stream (noun), On air (state), recording (never "session" in
   copy), scene (switchable) vs layout (arrangement) vs preset (quality only),
   source, destination / account / channel / stream key (never target,
   provider, "Manual RTMP", "OAuth"), Stream Manager / chat, Health / support
   bundle, takeover, Import…, Stream details, Buddy / Buddy Live, Premium
   sentence ("{Feature} is part of Videorc Premium." + "View Premium"), Delete
   vs Remove vs Discard vs Clear, microphone, camera.
2. Write `docs/ui-copy.md`: sentence case (only proper names capitalised);
   "…" on commands that open a further step and on every pending label;
   American English; contractions; toast shape (outcome title without a
   period, a description in sentences, one action); error shape ("Couldn't
   {verb} {object}" + reason + one fix); platform-true words through
   `lib/platform-copy.ts`; no internals (the banned list below).
3. Add `renderer-copy-guards.test.ts`, which scans string literals and JSX
   text in the renderer and fails on: `backend`, `socket`, `WebSocket`, `RPC`,
   `OAuth`, `callback`, `provider`, `revision`, `compositor`, `entitlement`,
   `VIDEORC_`, `Electron`, `Manual RTMP`, `X / Twitter`, `Streaming tab`,
   `Recording → Output`, `Open Live`, `Open Recording`, `Customize`,
   `diagnostics` (in user copy), `Command Palette`, `receive-only`, `...`
   (three dots), and `\b[A-Z][a-z]+Icon\b`. It starts with an explicit
   allowlist of today's offenders (path:line) that S2.2–S2.5 shrink to zero
   (a ratchet, like the useEffect lint budget).

**Done when**: the guard runs green with its allowlist, the glossary and
`docs/ui-copy.md` exist, `pnpm typecheck && pnpm lint && pnpm format:check`.

### S2.2: Going live, end to end

- **Closes**: B-11, A-11 (session actions), D-6, D-7 (labels and badges),
  J2-3 (the Go Live references), J2-5 (labels), I-32 (shortcut labels), B-31,
  the Upcoming row action (D-OD).
- **Depends on**: D3; S0.1.
- **Route / lane**: UI/Product Design, fit 8, `opus-4.8`.
- **Files**: `components/studio/session-panel.tsx:115-127`,
  `components/go-live-dialog.tsx`, `lib/studio-session-view.ts:136-178`,
  `components/command-palette.tsx:192-242`, `lib/shortcuts.ts:26-42`,
  `components/settings/shortcuts-settings.tsx:30-46`,
  `lib/session-runtime-notice.ts:25`, `lib/session-runtime-recovery.ts:147`,
  `components/scheduled-streams.tsx:306-345,571`, `lib/capture.ts:2771-2786`,
  `scripts/smoke-start-labels.mjs`.

1. Studio: "Record ␣" and "Go Live…". The Go Live dialog's title is "Go
   live"; its primary "Go live" (or "Go live on 3 destinations"); stopping
   while on air is "End livestream"; the state is "On air".
2. ⌘K: "Start recording", "Go live…", and while running "Stop recording" /
   "End livestream". Shortcut labels: "Record / stop recording", "Go Live /
   end livestream".
3. Runtime notices and toasts say "Livestream stopped unexpectedly"; the
   Upcoming row action is "Use for Go Live…".
4. Delete the dead `startButtonLabel` helpers and point `smoke:start-labels`
   at the real transport labels.

**Done when**: label tests, the copy guard allowlist shrinks,
`pnpm smoke:start-labels`, `pnpm typecheck && pnpm lint`.

### S2.3a: One name per page, window, state and platform

- **Closes**: J2-4 (state label functions), A-11 (windows), D-26, H-13, I-14,
  E-28, I-3/A-20, J2-17 (with S1.4), J2-19, B-22, B-23 (copy), C-37, C-38,
  H-25, D-36, C-PAT/D-PAT vocabulary rows, V-12.
- **Route / lane**: UI/Product Design, fit 8, `opus-4.8`.
- **Files**: new `lib/state-labels.ts` (`destinationStateLabel`,
  `captionsStatusLabel`, re-exporting `sessionStatusLabel`), the call sites in
  J2-4, `lib/stream-target-notices.ts:28-42`, `hooks/use-studio.tsx:12058-12087`,
  `components/preview-stage.tsx:147,406,559-633`, `lib/toast.ts:10`, the
  window titles (`apps/desktop/src/renderer/*.html`, `apps/desktop/src/main/index.ts`).

1. One label function per state machine, used on every surface; "On air"
   only for on air; a source producing frames is "Receiving"; locks say
   "while recording or live".
2. Window names: "Preview", "Notes", "Stream Manager", "Captions reader"
   (titles, ⌘K, menu, status bar, Settings → Shortcuts, in-window headers).
3. The start-blocking copy table (B-22): "Starting Videorc's capture
   engine…", "Turn on Save local recording in Output, or go live.",
   "Checking the recorder…".
4. Preview stage: the transport label only when it is a fallback ("Using a
   slower preview path"); "Opening preview…" / "Closing preview…".
5. "Details were saved for support." with an "Export support bundle" action.
6. Count-aware destination notices ("Viewers see nothing until it's back."
   when there is no other destination).
7. Phone remote words match the desktop (Chat, ON AIR, On stream, Take off
   stream, real layout names sent with `remote.describe`).

**Done when**: label-function tests, the copy guard allowlist shrinks,
`pnpm smoke:remote-lan` (the phone's describe payload gains labels; the PR
carries the leak argument AGENTS.md requires), `pnpm typecheck && pnpm lint`.

### S2.3b: Buddy copy and consent copy

- **Closes**: J2-20, F-5, F-19, F-26, H-27, G-6, G-15, G-25, E-6, E-13.
- **Depends on**: #647 merged; D7.
- **Route / lane**: UI/Product Design, fit 8, `opus-4.8`.
- **Files**: `lib/buddy-tab-view.ts`, `lib/buddy-auto-chat-view.ts`,
  `lib/cohost-view.ts`, `lib/cohost-state.ts`, `lib/clean-cut-view.ts:87-88`,
  `components/clean-cut/clean-cut-consent-dialog.tsx`,
  `components/buddy-pet-creator.tsx`, `components/buddy-avatar-section.tsx`,
  `lib/buddy-onboarding-copy.ts` and `docs/buddy-onboarding-copy.md` (kept in
  step by its test).

1. "Buddy" names the feature; the streamer's name for it is used when the
   character speaks or acts ("Grum: 5 people asking…", "Let Grum post as
   you?"); no article.
2. The on switch is "Buddy Live" everywhere (D7 makes it real again).
3. Consent copy matches what is sent: Alive packs of library-linked Buddies
   are saved to the account (G-6); the Clean cut consent leads with Clean
   cut's own bullet and shows retention in `text-muted-foreground` (E-13).
4. One word for the moving Buddy ("Alive", "moves"); "Videorc", not
   "Buddy", for the vision model; "pet" leaves user copy.

**Done when**: the Buddy-name guard and copy guard, the onboarding copy test,
`pnpm typecheck && pnpm lint`.

### S2.4: Toasts: news only, and every error says what to do

- **Closes**: J2-7, J2-11, J2-12, J2-13, J2-14, J2-6 (toast strings), B-18,
  E-22, C-36, H-4, H-32, A-22/I-19, I-1 (toast), D-16 (browser step as
  info).
- **Route / lane**: Implementation, fit 7, `gpt-5.5` (the register's Appendix
  A is the spec), reviewed by `opus-4.8`.
- **Files**: new `lib/user-error.ts`, `lib/toast.ts`, `hooks/use-studio.tsx`,
  `lib/session-runtime-recovery.ts`, `components/tabs/library-tab.tsx`,
  `apps/desktop/src/renderer/comments/main.tsx`, `lib/global-shortcuts.ts`,
  and the other files in Appendix A.

1. `userErrorMessage(error, { action, object })`: strips the IPC prefix,
   maps known `BackendRequestError.code`s, otherwise "Couldn't {action}
   {object}." plus "Try again. If it keeps happening, export a support bundle
   from Health." (the raw text goes to the console and the bundle).
   `guardToastText` also strips the IPC prefix as a backstop.
2. Apply Appendix A row by row: remove the 15 routine success toasts; merge
   the 9 duplicate groups (one id each, so "MP4 ready" keeps its reveal
   action); rewrite the ~62 dead-end errors; move dev-only strings to the
   console.
3. Types by meaning (error = failed and needs you; warning = can't now or
   degraded; info = neutral news or a step to take; success = finished out of
   view). Durations: 4 s one-liners, ≥8 s with a description, persistent with
   an action or when mirroring an inline state; "Streaming to {X} stopped"
   persists until "{X} is back" replaces it.
4. Buddy and Clear failures stop appearing as "Custom: …" composer badges.

**Done when**: `user-error.test.ts`, a guard that no `toast.*(` receives
`error.message` directly, the copy-guard allowlist shrinks, `pnpm typecheck
&& pnpm lint`, `pnpm probe:comments-window`.

### S2.5: Writing conventions sweep

- **Closes**: J2-21, J2-16 (call sites, with S1.4 helpers), B-30, G-25
  (casing, ellipsis), I-32, A-26, V-12.
- **Route / lane**: Implementation, fit 7, `gpt-5.5`.

1. Sentence case on every button, menu item, tab and title (allowlist proper
   names: Go Live, Stream Manager, Buddy Live, Premium, Videorc, platform
   names).
2. "…" on commands that open a picker or a dialog asking for input (Import…,
   Rename…, Choose…, Edit…, Pair a phone…, Set up permissions…, What's
   new…), and on every pending label (Saving…, Importing…, Exporting…).
3. American English; contractions; toast titles without a period; "Choose"
   over "Select"; placeholders "Search …".
4. Extend the copy guard: Title Case heuristic on `Button` children, and the
   "..." ban.

**Done when**: the guard allowlist reaches zero, `pnpm typecheck && pnpm
lint`, the existing copy-matching tests updated (memory: copy sweeps break
case-sensitive test matchers — grep tests for each changed string).

---

## Phase 3 — Pages and windows

Each slice consumes the Phase 1 primitives and the Phase 2 vocabulary. A
slice closes the listed IDs **and every other open ID in its area** that no
other slice claims (the coverage table at the end maps every ID).

### S3.1: Studio starts and stops what the label says

- **Closes**: B-3, A-3, J2-5, B-7, B-14 (rest), B-16 (rest).
- **Depends on**: S0.1, S2.2.
- **Route / lane**: Diagnose → Implementation, fit 9, `fable-5` (session
  start; release-critical).
- **Files**: `components/tabs/studio-tab.tsx:96-140`, `hooks/use-studio.tsx`
  (`startSession`, `openGoLiveConfirmation` `:13676-13749`, `:6102-6107`,
  `:12058-12087`), `lib/go-live-flow.ts:20-22`, `lib/global-shortcuts.ts:36-50`,
  `lib/remote-surface.ts:244-270`, `components/command-palette.tsx`,
  `components/tabs/recording-tab.tsx:59-64`, `lib/studio-session-view.ts:61-64,136-144`.

1. Add explicit `startRecording()` and `startLivestream()` intents that pass
   `{ record, stream }` without mutating the persisted
   `recordEnabled`/`streamEnabled`; "also record" on Go Live comes only from
   the Output switch.
2. Space (Studio only, D1) = Record when idle; the stream hotkey always opens
   Go Live (with "Set up a destination to go live" + "Open Livestream" when
   none is ready); the remote's `recordStart`/`streamStart` call the explicit
   intents.
3. The Session row shows the destination summary whatever the last mode was;
   both blocked reasons come from one function.
4. Go Live shows "Checking…" from the first click, guards re-entry, and
   routes failures through `reportSessionStartFailure` (with Retry).
5. While a Go Live is starting, the stop control reads "Cancel livestream";
   handle `recording-stop-finalize-overrun` with a warning `Alert` that
   explains "Force stop" ("Ends it now; the last seconds may be lost.").

**Done when**: unit tests (intents, hotkeys, remote surface),
`pnpm smoke:remote-control`, `pnpm smoke:record-latency:gate`,
`pnpm smoke:recording-studio`, `pnpm typecheck && pnpm lint`.

### S3.2: The live dashboard tells the truth

- **Closes**: B-4, B-9, B-13, B-17 (rest), B-26, F-7 (Studio part), J2-12
  (persistent destination failures, with S2.4).
- **Route / lane**: UI/Product Design, fit 8, `opus-4.8`; data derivation
  reviewed by `fable-5`.
- **Files**: `components/studio/session-panel.tsx`, `components/tabs/studio-tab.tsx:87-90,290-299`,
  `components/studio/quick-settings.tsx:255-275`, `lib/studio-session-view.ts`,
  `lib/stream-health-attribution.ts`, `components/streaming/go-live-panel.tsx:573-595`
  (reuse `liveProblemLabel`), `lib/studio-health.ts:183-189`.

1. A live-only Destinations group in Session: quiet ("3 of 3 on air") when
   fine, one row per problem ("Twitch stopped" + "Open") when not.
2. One "Stream" health fact reusing `classifyStreamHealthAttribution`.
3. One inline reason line under the transport for whichever button is
   disabled (drop the `!lastError` condition).
4. The Captions row shows the upload disclosure the first time, or becomes a
   `NavigableRow` to Captions.
5. Degraded preview alert: "Preview may not match the recording" + "Videorc
   is drawing the picture on the CPU, so it may stutter." + Retry preview /
   Open Health.
6. Buddy's viewer-reported problems ("Chat says: no audio") show in the
   Studio Buddy row.

**Done when**: derivation tests, `pnpm smoke:live-chat-fake-providers`
(fake live data), `pnpm typecheck && pnpm lint`, by eye with a fake live
session.

### S3.3: Studio inspector, scenes and narrow windows

- **Closes**: B-10, B-15, B-20, B-21 (rest), B-23 (duplicate controls),
  B-25, B-29, V-4, D16.
- **Route / lane**: UI/Product Design, fit 8, `opus-4.8`.
- **Files**: `components/tabs/studio-tab.tsx:189-262,330-359`,
  `components/studio/*`, `components/scene-presets.tsx`,
  `components/preview-stage.tsx:410-446`, `apps/desktop/src/main/preview-dock.ts:21`
  (read only).

1. A container query keeps the inspector beside the preview down to about
   720 px of content; below that, a sticky transport row (pill, clock,
   Record / Go Live… / Stop) sits above the preview.
2. One Output row (a `NavigableRow`, or the select with the performance
   warning); rename or split "Inputs" so Output and Captions aren't "inputs".
3. One `SceneCard` (on `MediaCard`) for built-in, saved and vertical-leg
   scenes; one reason line under the gallery when scenes are unavailable
   ("Camera is off — pick one in Sources to use …").
4. Microphone section: a mute button with its hotkey chip and a "Muted"
   status (D16); `SourceSwitchStatus` for the microphone.
5. Remove the preview header icons that duplicate body buttons; "Follow
   horizontal scene" becomes a `Switch`; `Skeleton` for the loading tiles.

**Done when**: `pnpm probe:preview-lifecycle` (the dock slot), a 960×660
screenshot shows the transport without scrolling, `pnpm typecheck && pnpm lint`.

### S3.4: The Go Live dialog, rebuilt

- **Closes**: B-8, B-12, D-7, B-14 (focus, ⌘↵, phases), B-18, B-19, D-21,
  D-9, J1-20 (its size).
- **Route / lane**: UI/Product Design, fit 9, `opus-4.8`; B-8 (per-session
  exclusion) `fable-5`.
- **Files**: `components/go-live-dialog.tsx`, `hooks/use-studio.tsx:13840-13859,14526-14533`,
  `lib/captions-preflight.ts`, `components/streaming/go-live-panel.tsx`,
  `components/tabs/streaming-tab.tsx:475-537`, `components/schedule-stream-dialog.tsx`,
  new `components/streaming/broadcast-info-fields.tsx`.

1. Destinations as one `GroupedList` of `ListRow`s (platform tile, label,
   account as context, `StatusBadge` Ready / Needs attention, message as
   meta); every callout an `Alert` (destructive blockers, warning limits,
   default advice).
2. "Go live without {label}" applies to this livestream only (a per-session
   exclusion like `suppressCaptionsForSession`) with the note "Only for this
   livestream. Your destination stays on."; add "Reconnect {platform}…".
3. One `BroadcastInfoFields` (title counter, `<>` rule, "Privacy", "Made for
   kids", one thumbnail hint) used by the dialog, the Livestream page and the
   Schedule dialog.
4. Caption blockers surface before the dialog: a "Captions" row in Ready to
   go live, a warning `Alert` on the Captions page, and the rule in its
   description.
5. ⌘↵ confirms (shown as a `Kbd`); initial focus on the title field or the
   primary; pending labels by phase ("Checking…", "Preparing YouTube…",
   "Starting…"); remove the two toasts that repeat the dialog.

**Done when**: dialog tests (the exclusion does not persist; focus;
⌘↵), `pnpm smoke:multistream`, `pnpm typecheck && pnpm lint`.

### S3.5a: Livestream destinations

- **Closes**: D-13 (with S1.5), D-14, D-15, D-16 (pending state), D-17,
  D-19, D-20, D-24, D-37, D-39, V-2.
- **Route / lane**: UI/Product Design, fit 8, `opus-4.8`.
- **Files**: `components/streaming/destination-card.tsx`,
  `components/tabs/streaming-tab.tsx:185-292,396-401`, `lib/capture.ts:2028-2044`,
  `lib/entitlement-ui.ts:158-163`, `components/streaming/go-live-panel.tsx:236-293`.

1. The 5-destination rule in the section description; one neutral `Alert`
   above the list only at the cap; auto-expand only the first destination that
   needs setup.
2. One `SessionLockAlert` ("Locked while you're recording or live. Changes
   apply to your next session.") that names everything it locks.
3. A row anatomy with a fixed trailing control column; `9:16` as inline
   context; the "Quality override" tag on every row that has one, naming the
   override.
4. Server URL validation ("Server URLs start with rtmp:// or rtmps://.");
   "where to find your key" for every stream-key platform; external links as
   `Button variant="link"` + `ExternalLinkIcon`; an explicit "Save key".
5. Sign-in pending state ("Waiting for your browser…" + Copy link).
6. Checklist links move focus to the destination, are ≥24 px, and the FFmpeg
   row is a `NavigableRow`.

**Done when**: validation and readiness tests, `pnpm smoke:streaming-secrets`,
`pnpm smoke:platform-lifecycle`, `pnpm typecheck && pnpm lint`.

### S3.5b: Stream details, scheduling and Upcoming

- **Closes**: D-5, D-11, D-18, D-30, D-31, D-32, D-33, D-34, V-3, the
  Upcoming label (D-OD).
- **Route / lane**: UI/Product Design, fit 8, `opus-4.8`.
- **Files**: `components/tabs/streaming-tab.tsx:470-906`,
  `components/schedule-stream-dialog.tsx`, `components/scheduled-streams.tsx`,
  `hooks/use-scheduled-streams.ts`, `lib/stream-metadata-summary.ts`.

1. Stream details: validated / validated with issues / "Unsaved changes";
   no error before interaction ("Add a title before you go live."); rows only
   for destinations in use; the thumbnail picker disabled with its reason when
   unusable.
2. One `CategoryCombobox` (Popover + Command) for Twitch and Kick; language
   as a `Select` of language names.
3. Schedule dialog: per-field reasons; the daylight-saving offset only when
   the time is ambiguous; zones labelled "Madrid (GMT+2)"; "Sat, Oct 12, 9:00
   PM CEST".
4. Upcoming: honest labels ("Move draft to history?", "Find the event
   YouTube created"), an explanation for an empty destination select, errors
   as destructive `Alert`s, Refresh with a loading state and "Last checked",
   refresh-on-focus throttled (≥5 min), and `Tabs` "Upcoming / Past".

**Done when**: tests, `pnpm smoke:youtube-quota` (refresh throttling),
`pnpm typecheck && pnpm lint`.

### S3.6: The Output page is the one home for the local file (D5)

- **Closes**: D-3, D-28, A-23, I-22 (folder), I-23, D5.
- **Route / lane**: UI/Product Design, fit 8, `opus-4.8`.
- **Files**: `components/tabs/recording-tab.tsx`, `components/settings/recording-settings.tsx`,
  `components/video-preset-select-items.tsx`, `lib/capture.ts:749-768`,
  `lib/settings-tabs.ts` (migration of the remembered tab),
  `components/sources/*` (receives "Keep microphone ready").

1. "Save a local recording" is a labelled settings row (the Captions row is
   the model); off disables the fields below with the reason.
2. Resolution as the segmented control; the preset list holds recording
   presets plus Custom; names through `formatVideoQuality`.
3. A "Where recordings go" section: Recordings folder (path as description,
   "Choose…", Show in Finder, "Use default" when custom), Keep original
   recording.
4. Settings → Recording is removed: "Keep microphone ready" moves to Sources
   → Microphone, the FFmpeg line to Health/About; the remembered tab and deep
   links migrate (`recording` → `general`).

**Done when**: a settings-tab migration test, recording-tab tests, `pnpm
typecheck && pnpm lint`, by eye.

### S3.7: Captions page and Captions reader

- **Closes**: D-10, D-25, D-27, V-5, J2-18 (captions window).
- **Route / lane**: UI/Product Design, fit 8, `opus-4.8`.
- **Files**: `components/captions/captions-controls.tsx`,
  `components/captions-reader.tsx`, `apps/desktop/src/renderer/captions/main.tsx`,
  `components/tabs/captions-tab.tsx`.

1. `LockAlert` leads when captions need Premium; every control below is
   disabled.
2. One state signal (no header chip beside the switch).
3. `NavigableRow`s: "Microphone · {device}" → Sources; "Placement · Bottom,
   on stream" → Scene; one allowance unit ("N min left this month").
4. Reader: `WindowHeader` "Captions reader", `StatusDot`, a state-dependent
   body (off / armed / error with `status.message`), `PinWindowButton`.

**Done when**: tests, `pnpm probe:ui-glass --gate` (the reader window),
`pnpm typecheck && pnpm lint`.

### S3.8: Sources

- **Closes**: C-8 (alerts), C-10, C-14, C-19, C-27, C-30, C-32, C-38, the
  "Live" source chip (J2-4), the duplicate camera alerts (visual).
- **Depends on**: PR #653 (plan 173, merged as `f4735e4f`). Re-audit every
  ID here against it first and drop the ones it closes; this slice only
  finishes the rest.
- **Route / lane**: UI/Product Design, fit 8, `opus-4.8`.
- **Files**: `components/tabs/sources-tab.tsx`, `components/sources/sources-audio-mixer.tsx`,
  `lib/mic-meter-input.ts:73-88`, `lib/system-audio.ts:118-127`, `lib/capture.ts:1541,1571`,
  `lib/mic-visual-gate.ts`, `components/ui/fader.tsx:205-215`, `hooks/use-studio.tsx:8040-8112`.

1. One curated, flush `Alert` per missing permission (Screen Recording,
   Camera, Microphone), each with "Open {X} settings" and, for Screen
   Recording, "Show helper in Finder" and "then quit and reopen Videorc";
   unknown backend warnings go to Health. No alert for a camera nobody chose.
2. Source chip hints become a visible `role="status"` line; amber text
   becomes `Alert`s.
3. "Mic sync" with a direction ("Moves your voice later (+) or earlier (−)");
   plain reset and calibration copy; "Monitoring" → "Ready".
4. A device-only Refresh (`devices.list` + media access).
5. The dB readout resets gain; the echo guard is a labelled row.

**Done when**: tests, `pnpm smoke:sources`, `pnpm typecheck && pnpm lint`.

### S3.9: Scene editor

- **Closes**: C-4 (undo), C-5, C-13, C-15, C-16, C-21, C-22, C-23, C-31,
  C-33, C-34, C-35, D15, D17, V-10.
- **Route / lane**: `fable-5` for C-5 and the undo (layout transactions);
  `opus-4.8` for the rest.
- **Files**: `components/tabs/layout-tab.tsx`, `components/scene/scene-stage.tsx`,
  `components/scene/source-transform-fields.tsx`, `components/scene/overlay-stage.ts`,
  `hooks/use-studio.tsx:8357,8888-8890,9234-9240`, `components/scene-presets.tsx`,
  `components/settings/general-settings.tsx:65-84` (Animate scene changes moves here).

1. The inspector stays enabled during precise edits (drop input while
   pending; restore focus); `inert` only during pointer gestures.
2. Single-level ⌘Z for the last committed layout patch (D15).
3. Switched-off overlays drawn dimmed with an "off" badge; sources labelled on
   the schematic stage.
4. Named segmented controls with full words (Top left…, Small/Medium/Large,
   Rectangle/Rounded/Circle, "Original"); one-shot snaps as buttons.
5. Hints point to Sources with an "Open Sources" link; truthful "locked while
   live" copy; a reason beside a disabled "Visible in scene".
6. Orientation, vertical screen framing and "Update “{name}”" on the Scene
   page; "Animate scene changes" lives here (D17).
7. Arrow and Shift-arrow nudge on the stage with a footer hint; the camera
   inspector split into Placement / Lens / Green screen `PanelSection`s; no
   repeated source name; "Save scene" in the section action slot.

**Done when**: tests (undo, nudge, focus retention), `pnpm
smoke:recording-studio`, `pnpm probe:preview-lifecycle`, `pnpm typecheck &&
pnpm lint`.

### S3.10: Assets

- **Closes**: C-11, C-17, C-25, C-26, C-28, C-40, J2-8 (takeovers), the
  Import/Upload pair.
- **Route / lane**: UI/Product Design, fit 8, `opus-4.8`.
- **Files**: `components/tabs/assets-tab.tsx`, `components/takeover-screens-section.tsx`,
  `lib/screen-takeover-microphone.ts`, `apps/desktop/src/main/index.ts:14009-14058`.

1. A visible inset focus ring on tiles; the ⋯ menu shows on hover **and**
   focus.
2. Takeovers: keyboard reorder (Move earlier / later, Alt+←/→), PNG/JPEG/WebP
   file drop on both galleries, a badge only for "Missing", one "in use"
   treatment for both galleries (ring + neutral chip), no file path,
   `aspect-video` previews, "Import image…" (outline), and "Turning one on
   mutes your microphone until you turn it off."
3. The orphan current-background row moves into Backgrounds; `PageStack`;
   the rules in the description ("Ten backgrounds · PNG, JPEG or WebP.");
   separate section icons.
4. `revealInFileManagerLabel()` + `FolderIcon`; ~480 px thumbnails generated
   at import.
5. Loading and offline states before "No takeovers yet".

**Done when**: tests, `pnpm smoke:screens`, `pnpm typecheck && pnpm lint`.

### S3.11: Library

- **Closes**: E-4, E-16, E-17, E-18, E-19, E-21, E-27, E-28, J2-8 (sessions),
  J1-21 (table semantics), the quality-status owner item (E-OD).
- **Route / lane**: UI/Product Design, fit 8, `opus-4.8`; E-16 (roving
  focus, L) may go to `gpt-5.5`.
- **Files**: `components/tabs/library-tab.tsx`, `lib/library-view.ts`,
  `hooks/use-studio.tsx:575,2145`, `components/kebab-menu.tsx`.

1. The Library knows Clean cut jobs: a status chip ("Cutting 40%"), file
   actions blocked with "Cancel or finish Clean cut first", and "Review clean
   cut" once one exists.
2. A desktop list: roving focus (↑/↓), click selects, ⇧/⌘-click extend,
   double-click plays, Return renames, ⌘⌫ asks to delete; a row
   `ContextMenu` built from the same items as the ⋯ `KebabMenu`; table
   semantics.
3. Search, sort and filter say when results are partial ("Searched the 50
   newest recordings. [Load all]") until the backend takes the parameters; a
   sort `Select`; no-results `Empty` with "Clear search".
4. Bulk delete prunes hidden selections and names up to five titles; the
   header checkbox has an indeterminate state; background jobs never reset the
   user's filter.
5. "MP4" as an outline tag; problem quality states as a status chip ("quiet
   when fine"); row tokens; loading and offline states before "No recordings
   yet".

**Done when**: tests, `pnpm typecheck && pnpm lint`, by eye with 0, 1 and 50+
recordings.

### S3.12: Markers and the player

- **Closes**: E-7, E-9, E-10, E-11, E-30, J1-22.
- **Route / lane**: UI/Product Design, fit 8, `opus-4.8`.
- **Files**: `components/media/session-player.tsx`, `components/media/marker-pins.tsx`,
  `components/session-markers-dialog.tsx`, `lib/session-player-view.ts`,
  `components/icons.tsx` (MarkerIcon; reclaim the unused `VerifiedIcon`,
  `BrainIcon`, `FastIcon` slots), `docs/icon-set.md`.

1. Pins drawn over the slider track, only once the duration is known, with a
   24 px hit area and a 2 px tick; close pins merge into a chooser.
2. The markers list as a `GroupedList` of compact `ListRow`s with visible
   selection, inline rename (`maxLength`, `<Kbd>↵</Kbd>`), errors as an
   `Alert` whose Retry repeats the failed action, and `Empty`.
3. The dialog scrolls (`DialogBody`), and re-checks playability while open.
4. Player: click toggles playback; J/K/L, Home/End, M; a mute button; refusal
   states offer "Open in default player" and Show in Finder.
5. A `MarkerIcon` so scissors means only Clean cut and clips.

**Done when**: tests, `pnpm icons:build` + icon tests, `pnpm typecheck &&
pnpm lint`.

### S3.13: Clean cut, fixed where it lives (D6)

- **Closes**: E-5, E-12, E-14, E-15, E-24, E-25, E-29, E-31, D6.
- **Depends on**: #647 merged (`components/tabs/buddy-tab.tsx` exists only
  there).
- **Route / lane**: UI/Product Design, fit 8, `opus-4.8` for the journey and
  the review polish; `fable-5` for step 2 (edits must survive every exit);
  E-14 (transcript editing) as its own PR.
- **Files**: `components/clean-cut/*`, `components/tabs/buddy-tab.tsx`,
  `components/tabs/library-tab.tsx`, `components/app-shell.tsx:215-224`,
  `lib/clean-cut-events.ts`, `lib/clean-cut-auto.ts`.

1. Clean cut stays on the Buddy page (owner call, D6): its jobs, status and
   review do not move. The Library's per-recording "Make a clean cut…" (not
   the bare noun) opens Buddy → Clean cut for that recording with
   `origin: 'library'`; the review's back button then reads "Back to
   Library" and returns to the source row, and opened from the Buddy page it
   reads "Back to Clean cut". ⌘K "Clean cut" opens Buddy → Clean cut.
2. Unsaved transcript edits survive tab and page switches (per-job drafts),
   every exit goes through the leave guard, and the review is keyed by target.
3. Transcript: follow the playhead, "Cut selection ⌫", undo/redo (⌘Z /
   ⇧⌘Z); a polite live region for selection and status.
4. The footer shows a failure's reason and Retry; a skipped auto cut warns
   once per recording, and its toast action reads "Open Clean cut"; the
   Premium lock uses the same lock strip as Chat and Voice (E-31); copy
   polish (ellipses; no "Make one from the Buddy tab" inside the Buddy page).

**Done when**: tests, `pnpm typecheck && pnpm lint`, by eye through Library →
Buddy → Clean cut review → back to the Library row, and Buddy → Clean cut →
review → back to the list.

### S3.14a: Buddy on, Buddy off, and what it may do (D7)

- **Closes**: F-2, H-3, F-24, F-25, F-12 (rest), H-8, the two-homes owner
  item (F-OD4/H-OD4).
- **Depends on**: #647 merged; S0.2.
- **Route / lane**: `fable-5` (consent and state model).
- **Files**: `apps/desktop/src/renderer/comments/main.tsx:440-606`,
  `components/stream-manager/buddy-chat-controls.tsx`, `components/cohost-status.tsx`,
  `components/cohost-nudge.tsx`, `components/cohost-pane.tsx`,
  `components/tabs/buddy-tab.tsx`, `lib/cohost-state.ts`, `lib/buddy-auto-chat-view.ts`.

1. A "Buddy Live" switch (pane header and the Profile status row) turns Buddy
   on and off; "Chat posting: Off · Suggest · Auto" governs only what it
   posts. Every on-path writes a consistent state; Off is really off.
2. Greetings, Answers and Banter have one home (Buddy → Chat); the Stream
   Manager shows them as read-only summary chips that link there.
3. Delete the dead consent and status code (or rewire it into this flow).

**Done when**: tests, `pnpm probe:comments-window`,
`pnpm smoke:buddy-commands`, `pnpm smoke:command-lanes`, `pnpm typecheck &&
pnpm lint`.

### S3.14b: The Buddy page

- **Closes**: F-4, F-6, F-11, F-13, F-16, F-18, F-20, F-21, F-23, F-27,
  F-28, G-2, D7 (Profile tab).
- **Route / lane**: UI/Product Design, fit 8, `opus-4.8`.

1. The first tab is "Profile" and leads with one status row (Buddy Live on /
   off / needs attention · reason · "Open Stream Manager ⇧⌘J" · the one unlock
   action); after "Use as my Buddy", an `Alert` says how to put it on stream.
2. One status vocabulary (Off · Starting · Reading chat · 3 questions ·
   Paused: daily AI allowance used up).
3. The Say box says when it also posts to chat (Auto); proposed posts show
   their destinations; failed posts read as failed.
4. Voice lists the marker command and the Buddy's own name; "{name} on
   stream" for the overlay switch; "Edit in chat box" for the recap; report
   empty/loading/offline states; shortcut list completed.

**Done when**: tests, `pnpm typecheck && pnpm lint`, by eye.

### S3.14c: The Stream Manager's Buddy pane

- **Closes**: F-8, F-10/H-9, F-14, H-20, H-21, H-23.
- **Route / lane**: UI/Product Design, fit 8, `opus-4.8`.

1. One pane header: identity first (image, name, Buddy Live switch, posting
   mode); the Say box and reactions in a footer; visible off-air.
2. The triage list is `flex-1 min-h-0` with 32 px rows; Suggest and removal
   cards in a capped `ScrollArea` ("3 waiting").
3. One `BuddyCard` (Alert group, `tabIndex={-1}`, timer slot, actions slot):
   ↵ primary, Esc declines (⌫ as alias), fixed button order; a polite live
   region announces time-limited cards.
4. Notices as `Alert`s; one outline "Alpha" badge.

**Done when**: `pnpm probe:comments-window`, tests, `pnpm typecheck && pnpm
lint`.

### S3.15a: Buddy creation flows

- **Closes**: G-3, G-4, G-5, G-9, G-10, G-12, G-13, G-14, G-19, G-24, and the
  G owner items (Premium gate at step 1; primary button rightmost; review
  marks persisted; creator step names).
- **Depends on**: #647 merged.
- **Route / lane**: `fable-5` (flows, backend cancel); `opus-4.8` for copy.

1. Example chips fill only an empty field (or confirm "Replace your
   personality?"); "New Buddy…" pointers replace the stale "Create my Buddy"
   ones.
2. One gate model (signed out / Premium / cloud AI / unavailable / allowance)
   rendered by one `Alert` + `AlertAction`, shown at step 1 for creation.
3. "About you" has one name and one home (under Personality).
4. The worn Alive pack is remembered; a pending draft shows above the toggle.
5. Onboarding input survives tab switches and stray clicks (a store, a dirty
   guard, reopen at the reachable step); "Start a new one" from a draft.
6. Look generation can be cancelled, shows elapsed time, and Redo shows its
   cost ("Redo · 1 image", "{n} images left today"); ⌘↵ scoped to the
   creator; the library edit dialog closes only when the save is accepted.

**Done when**: tests, `pnpm typecheck && pnpm lint`; if the backend cancel is
added: targeted `cargo test -p videorc-backend` + `cargo clippy -p
videorc-backend -- -D warnings` (per the owner's directive to run targeted Rust
tests locally).

### S3.15b: Buddy creation visuals and accessibility

- **Closes**: G-7, G-11, G-16, G-17, G-18, G-20, G-21, G-22, G-26, V-1.
- **Route / lane**: UI/Product Design, fit 8, `opus-4.8`.

1. Section failures as `Alert`s, field errors as `FieldError` (17 bare red
   lines go).
2. One `BuddyPictureCard` on `MediaCard` in `Gallery`; one selection signal
   (`bg-accent` + neutral "Active" tag + `aria-current`); the personality
   visible, not hover-only; the "Alive" tag above the art.
3. Pickers with proper keyboard semantics (roving radios or `ToggleGroup`).
4. A pause control for the looping demo and the preview; the demo's bubble
   lines in its accessible name; step changes announced.
5. Fold avatar Zoom into Test.

**Done when**: tests, `pnpm smoke:buddy-pet` (the pet preview and player),
`pnpm typecheck && pnpm lint`, by eye in both themes.

### S3.16a: Stream Manager chat: a keyboard model and undoable removal (D10, D20)

- **Closes**: D10 (kept as is), D20 (H-OD2/F-OD5), H-7, H-11, H-19, H-26,
  H-30, H-33.
- **Route / lane**: `fable-5` (public actions as the streamer).
- **Files**: `components/comment-row.tsx`, `components/stream-manager/chat-pane.tsx`,
  `components/stream-manager/activity-pane.tsx`, `components/stream-manager/stream-manager.tsx:672-689`,
  `components/stream-manager/stream-manager-status-bar.tsx`,
  `apps/desktop/src/renderer/comments/main.tsx:307`, `lib/chat-removal-view.ts`,
  `apps/desktop/src/shared/chat-moderation.ts:125-135`.

1. A click on a row keeps putting it on stream, and a click on the live row
   takes it off (owner call, D10; plans 055/151). Do not add a selection
   step or a separate Show button. Links stay as plan 151 left them (a left
   click belongs to the row; right click or ⋯ opens them). Only a mouse drag
   that ends with selected text is not a click, so copying a message's words
   never puts it on stream.
2. The list is one tab stop with roving focus (↑/↓, Home/End); Enter and
   Space do what a click does; row keys R (reply), C (copy), ⇧⌫ (remove);
   ⌘L focuses the composer; Esc returns to it; `StatusBarHint`s for ⌘F, ⌘J,
   ⌘L.
3. Remove from chat (menu and ⇧⌫) runs after a 3 s "Removing… · Undo" (D20);
   it is offered only where the account can moderate, otherwise disabled with
   "Reconnect {platform} to remove messages".
4. One `PlatformFilter` (with All, and a Filters menu below 640 px) for Chat
   and Activity; one row contract (⋯ visibility, time style).
5. A failed send keeps the draft and offers Retry; the Send label names the
   pick; History polish (one date format, live-only controls hidden, ⋯ with
   Copy and links kept); the Questions chip only when Buddy has questions.

**Done when**: tests (a click still puts a row on stream and takes it off; a
text-selecting drag does not), `pnpm probe:comments-window`,
`pnpm smoke:live-chat-fake-providers`, `pnpm typecheck && pnpm lint`.

### S3.16b: Stream Manager feedback, states and chips

- **Closes**: H-10, H-12, H-14, H-15, H-17, H-18, H-24, H-29, H-32, V-8.
- **Route / lane**: UI/Product Design, fit 8, `opus-4.8`.

1. No unmeasured numbers ("–" with a reason; no "0 msg/min" when chat isn't
   connected); the live chat empty state says "Chat is connected. New
   messages appear here."
2. One Twitch-permission story ("Reconnect Twitch…" everywhere); the
   composer marker line only when it matters.
3. Hover details reachable by keyboard (focusable stat cells, "Customize
   stats…" in ⋯, provider chips with hover cards, a word beside non-green
   dots below 640 px).
4. Chips back to spec (no `h-4 text-[10px]` badges, no ad-hoc pill, 11 px
   minimum); the composer is a flush region with no card inside.
5. `LivestreamIcon` for "on stream" (the eye stays Preview); Mark clip
   confirms inline with Undo like `/marker`.

**Done when**: `pnpm probe:comments-window` (it sweeps 320–1280 px),
`pnpm typecheck && pnpm lint`.

### S3.17: Settings and permissions

- **Closes**: I-7 (migration), I-8, I-10/A-16, I-17, I-20, I-21, I-27,
  I-30, I-33, V-6, V-11, D17 (pointer row).
- **Route / lane**: UI/Product Design, fit 8, `opus-4.8`.
- **Files**: `components/tabs/settings-tab.tsx`, `components/settings/*`,
  `components/shortcut-recorder.tsx`, `components/permissions-onboarding-dialog.tsx`,
  `lib/system-access.ts`, `apps/desktop/src/main/updater.ts:255-281`.

1. Every row is a `SettingsRow`; lists (Permissions, App shortcuts, phones)
   are `GroupedList`s; read-only values use `InputGroup` with `readOnly`.
2. One `SystemAccessList` for onboarding and Settings: visible details, one
   tone mapping, "Open System Settings…"; the onboarding CTA reads "Continue"
   when nothing required is missing.
3. Locked reasons (Pair a phone, chat emotes, Linux's empty Permissions).
4. Shortcut recorder: its accessible name includes the binding; refusals in
   a live region; Videorc's own shortcuts can't be bound globally.
5. About: update errors as an `Alert` with Try again, links for unsupported
   builds, "Finish your recording or stream first", no OS update banner during
   capture, install-on-quit stated, a shadcn `Progress`, and links (website,
   privacy, terms, open-source licences, Contact support…).
6. General splits into Appearance / Stream Manager / Import, ending with an
   "Elsewhere" `GroupedList` of `NavigableRow`s (Account, Buddy, Output,
   Livestream, Health).

**Done when**: tests, `pnpm smoke:remote-control`, `pnpm typecheck && pnpm
lint`.

### S3.18: Health

- **Closes**: I-4, I-6 (rest), I-25, I-1 (rest), V-7, the J2 owner item
  (Technical details), D9.
- **Route / lane**: UI/Product Design, fit 8, `opus-4.8`.
- **Files**: `components/tabs/diagnostics-tab.tsx`, `lib/studio-health.ts`,
  `components/support-bundle-button.tsx` (from S1.6b), `crates/videorc-backend/src/support_bundle.rs`
  (only if the save panel needs a path parameter).

1. Lead with one verdict `Alert` ("Everything looks healthy" / "2 things
   need attention: …"), then Actionable warnings, then the support bundle.
2. Only non-green checks show; the rest sit behind "Show all checks"; states
   in words; neutral, not amber, for transitional states; one Repair chip.
3. Live stats, Pipeline and the logs fold into one collapsed "Technical
   details"; unhealthy groups open themselves; one "–" placeholder; plurals;
   logs titled with their session and truncation stated.
4. The support bundle has one home here, a reveal action on success, and a
   Contact support link; About links to it.

**Done when**: tests, `pnpm typecheck && pnpm lint`; if the backend export
path changes, targeted `cargo test -p videorc-backend` + clippy.

### S3.19: Notes window

- **Closes**: I-24, J2-18 (notes).
- **Route / lane**: UI/Product Design, fit 7, `opus-4.8`.

1. "Saved"/"Saving" visual only; a separate `role="status"` failure line
   with Retry; pin errors beside the pin; "Small/Medium/Large text" names.
2. `WindowHeader` with the title only; size and pin in the footer status
   line; "Keep on top".

**Done when**: tests, `pnpm probe:ui-glass --gate`, `pnpm typecheck && pnpm
lint`.

### S3.20: Phone remote

- **Closes**: I-5, I-11, I-12, I-13, I-28, I-34.
- **Route / lane**: UI/Product Design, fit 8, `opus-4.8` (web UI);
  `gpt-5.5` for `lib/remote-surface.ts` copy.
- **Files**: `crates/videorc-backend/remote_web/*`, `components/phone-remote-section.tsx`,
  `lib/remote-surface.ts`, `lib/phone-remote-view.ts`.

1. Hint text at `--text-2` (AA); `aria-pressed` on toggles; zoom allowed;
   visible focus in light mode; real list semantics with buttons.
2. Offline honesty: disabled controls while not connected, "Can't reach
   Videorc…" after 10 s, a connecting state, and plain snack copy.
3. "Mic muted" / "Mic on" (the key no longer lights when muted).
4. Phones as `ListRow`s with Rename… and Remove… (confirmed); an auto-lock
   tip after pairing; a REC chip; "Forget this computer".

**Done when**: `pnpm smoke:remote-lan` (mandatory; no new LAN route or event
without the leak argument), tests, `pnpm typecheck && pnpm lint`.

### S3.21: Shell and navigation

- **Closes**: A-2, A-7, A-9, A-10, A-12, A-13, A-18, A-19, A-25, D8, D18,
  V-9.
- **Route / lane**: UI/Product Design, fit 9, `opus-4.8`; A-2 and A-7
  `fable-5`.
- **Files**: `components/app-shell.tsx`, `components/sidebar.tsx`,
  `components/workspace-nav.tsx`, `components/command-palette.tsx`,
  `components/ui/command.tsx`, `components/error-boundary.tsx`, `main.tsx`,
  `components/whats-new-dialog.tsx`, `lib/update-ui.ts`, `hooks/use-theme-toggle.ts`.

1. One `isModalOpen()` gates the IPC navigation, the shell keydown handler,
   the Space handler and the theme key.
2. A page error boundary keyed by the active page ("This page hit a problem.
   Other pages still work." + Reload page / Copy details); a recoverable root
   panel with a drag strip and Export support bundle.
3. ⌘K: a Windows group, a Session group that mirrors the transport, one verb
   for pages, synonyms (layout, diagnostics, recording, destinations,
   keyboard…), the palette scale (18–20 px input, 24 px icon, footer with the
   selected action and ↵), order Session → Pages → Windows → Scenes → Buddy →
   Settings → Appearance, positioned in the upper third.
4. Sidebar per D8 (Studio row live dot and clock; Buddy stays second,
   directly under Studio, on ⌘9); ⌘J shows Stream Manager and focuses Buddy,
   ⇧⌘J toggles it (also from inside); ⌘/ opens Settings → Shortcuts.
5. Focus the toolbar `h1` after keyboard navigation; `document.title` =
   "{Page} — Videorc".
6. What's New focuses Continue and mentions skipped releases; the update chip
   says "Update after this session" while live, with a neutral dot; the
   Windows sidebar mark goes (D18).

**Done when**: tests (shortcut gating with an open dialog, error boundary,
palette entries), `pnpm probe:preview-lifecycle` (⌘P path), `pnpm typecheck
&& pnpm lint`, by eye.

---

## Phase 4 — Guardrails, docs, acceptance

### S4.1: Guardrails consolidated

- **Closes**: J1-11, J1-12 (guards), J1-24, and verifies every guard added in
  earlier slices.
- **Route / lane**: Implementation, fit 7, `gpt-5.5`.

1. Delete dead variants, tokens and classes (Badge `default`=`secondary`,
   Input `ghost`, TabsList `line`, Alert `success` if still unused, menu
   `inset`, `--shadow-soft`, `--shadow-glass*`, `--radius-2xl…4xl`,
   `no-scrollbar`, `cn-toast`); replace `cursor-not-allowed` with nothing.
2. One sanctioned compact size (24 px `xs`) on Button, Toggle, SelectTrigger
   and Badge, with the places it is allowed written in the skill; remove the
   redundant `sm`/`icon-sm` and the 28 per-call-site height overrides.
3. Make sure these guards exist and pass: no `capitalize` in status
   primitives; no `title=` on controls; no `text-[9px]`/`text-[10px]`; no
   off-tier radii outside an allowlist; FieldLabel association; named
   SelectTriggers; no Switch inside `role="button"`; no raw `aria-pressed`
   button groups; no coloured status text; the copy guard at zero allowlist.

**Done when**: all guards green, `pnpm typecheck && pnpm lint && pnpm
--filter @videorc/desktop test`, `pnpm check:renderer-assets`.

### S4.2: The design skill and the docs match the app

- **Closes**: H-31, A-27, J1-24 (skill drift), the docs-vs-code rows of C-PAT,
  I-3 (doc paths).
- **Route / lane**: UI/Product Design, fit 8, `opus-4.8`.
- **Files**: `.claude/skills/videorc-design/SKILL.md`, `docs/ux-ia-refactor-plan.md`,
  `docs/buddy.md`, `docs/remote-control.md`, `docs/icon-set.md`, `CONTEXT.md`.

1. The skill: the verb (D3), the segmented-control rule (D13), the tertiary
   tier rule (D12), the Empty rule (D11), the confirm recipe, the new
   primitives (AlertDialog, ConfirmDialog, SegmentedControl, DisabledReason,
   LockAlert, SessionLockAlert, SettingsRow, ShortcutKeys, WindowHeader,
   MediaCard, DevicePicker, StatusBarAction, PaneStrip), toast types and
   durations, the Stream Manager status bar's real height and labelled
   actions, the fullscreen gutter, and a link to `docs/ui-copy.md`.
2. The docs: where devices live (Sources plus the Studio mirrors), where
   takeovers live (Assets), the Buddy pane's position, the remote's Settings
   paths.

**Done when**: a reviewer reads the skill against three random screens and
finds no contradiction; `pnpm format:check`.

### S4.3: Acceptance sweep

- **Route / lane**: Orchestrator, fit 10.

1. Re-run this audit's screenshot set with `pnpm ui:driver` (every page and
   sub-tab, dark and light, 1280×860 and 960×660, the Stream Manager at
   420/800/1280 with seeded chat, ⌘K, the New Buddy wizard, an attempted Go
   Live, an expanded destination, first-run permissions) and compare with the
   audit baseline.
2. `pnpm probe:comments-window`, `pnpm probe:ui-glass --gate --surfaces`,
   `pnpm smoke:local-gates` on the final branch.
3. The owner's by-eye pass in both themes.
4. Every register ID is marked fixed, deferred (with a reason) or rejected
   (owner call).

**Done when**: the register has no open P0/P1, and the owner signs off.

---

## Sequencing

```
S0.1 ─┬─> S2.2 ─> S3.1 ─> S3.2
      └─> S0.3 (AlertDialog)
S0.2 (after #647) ─> S3.14a ─> S3.14b, S3.14c
S0.4a, S0.4b, S0.5, S0.6 : independent
S1.1 ─> S1.10            S1.2, S1.3, S1.4 : independent
S1.5, S1.6a, S1.6b, S1.7, S1.8, S1.9 : before the Phase 3 slices that use them
S2.1 ─> S2.2, S2.3a, S2.3b, S2.4, S2.5
Phase 3 lanes in parallel: Studio (S3.1–S3.4) · Livestream/Output/Captions
(S3.5a–S3.7) · Sources/Scene/Assets (S3.8–S3.10) · Library (S3.11–S3.12) ·
Buddy/Clean cut/Stream Manager (S3.13–S3.16b, after #647) · Settings/Health/
Notes/remote/shell (S3.17–S3.21)
S4.1 ─> S4.2 ─> S4.3
```

Land Phase 1 primitives one PR at a time and rebase the lanes after each.
Keep each slice to one PR (S1.10 and S3.13 are split as noted).

## Out of scope

- New features the audit only touched on: an "Add destination" catalog in
  place of the fixed eight rows (D-OD); background slots beyond ten (C-OD); a
  session model that ends the stream but keeps recording (D19); timeouts and
  bans in chat moderation (H-25 only relabels).
- Moving the platform mark in chat rows (owner call in plan 165, kept).
- Moving the Buddy page, or moving Clean cut or any other feature out of it:
  it sits directly under Studio to sell Premium (owner call 2026-10-10, D6
  and D8).
- Changing what a click on a live chat row does: it puts the message on
  stream (owner call 2026-10-10, D10; plans 055/151).
- The website (videorcweb), Windows/Linux packaging, and in-flight feature
  PRs (#632, #504, #486, #609).
- Rust/backend behaviour, except the small hooks named in S3.15a (look
  cancel) and S3.18 (bundle path), which stop for review if they grow.

## STOP conditions

- A slice needs a new RPC, wire field, LAN route or LAN event that it does not
  name: stop and propose it (AGENTS.md requires a leak argument for LAN
  changes).
- The owner answers a decision differently from the recommendation: re-plan
  the gated slices before starting them.
- `pnpm check:renderer-assets` goes over a ceiling and lazy-loading doesn't
  fix it.
- A recording-studio, native-preview or remote smoke regresses.
- `pnpm probe:ui-glass --gate` fails after the `--subtle` retune.
- A Buddy slice (S3.13 included) is due and #647 isn't merged (moot while
  this plan executes inside #647).
- A change would move the Buddy page or a feature out of it, or change what
  a click on a live chat row does: those are owner calls (D6, D8, D10).
- A new guard would need an allowlist of more than about 20 entries:
  rethink the rule before landing it.
- A finding's behaviour changed since `c49e7855` (see the drift check).

## Verification summary

| Slice            | Gates                                                                                        |
| ---------------- | -------------------------------------------------------------------------------------------- |
| S0.1             | desktop tests, `smoke:remote-control`, `smoke:record-latency:gate`                           |
| S0.2             | desktop tests, `probe:comments-window`                                                       |
| S0.3             | desktop tests, icon-name guard, `smoke:remote-lan`                                           |
| S0.4a            | desktop tests                                                                                |
| S0.4b            | desktop tests, `smoke:recording-studio`                                                      |
| S0.5             | style guards, desktop tests, `probe:comments-window`                                         |
| S0.6             | desktop tests, `probe:preview-lifecycle`                                                     |
| S1.1–S1.8, S1.10 | desktop tests, guards; S1.7 `check:renderer-assets`; S1.8 `probe:ui-glass --gate --surfaces` |
| S1.9             | desktop tests, `smoke:sources`, `smoke:recording-studio`                                     |
| S2.1–S2.5        | copy guard ratchet, desktop tests; S2.2 `smoke:start-labels`; S2.3a `smoke:remote-lan`       |
| S3.1             | `smoke:remote-control`, `smoke:record-latency:gate`, `smoke:recording-studio`                |
| S3.2             | `smoke:live-chat-fake-providers`                                                             |
| S3.3             | `probe:preview-lifecycle`                                                                    |
| S3.4             | `smoke:multistream`                                                                          |
| S3.5a / S3.5b    | `smoke:streaming-secrets`, `smoke:platform-lifecycle` / `smoke:youtube-quota`                |
| S3.8             | `smoke:sources`                                                                              |
| S3.9             | `smoke:recording-studio`, `probe:preview-lifecycle`                                          |
| S3.10            | `smoke:screens`                                                                              |
| S3.14a           | `probe:comments-window`, `smoke:buddy-commands`, `smoke:command-lanes`                       |
| S3.15b           | `smoke:buddy-pet`                                                                            |
| S3.16a / S3.16b  | `probe:comments-window`, `smoke:live-chat-fake-providers`                                    |
| S3.17            | `smoke:remote-control`                                                                       |
| S3.20            | `smoke:remote-lan`                                                                           |
| S3.21            | `probe:preview-lifecycle`                                                                    |
| every slice      | `pnpm typecheck`, `pnpm lint`, `pnpm format:check`                                           |
| S4.3             | `smoke:local-gates`, owner by eye                                                            |

## As built

(Fill in per slice: PR, commit, IDs closed, deviations.)
