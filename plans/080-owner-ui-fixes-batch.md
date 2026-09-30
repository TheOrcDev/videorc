# Plan 080: Six owner fixes: update chip, Livestream setup, mic preview, Screen and Camera rows, Settings icons

Status: **PLANNED** 2026-09-30 against `origin/main` `9ec80d41`, on branch
`plan/080-studio-live-settings-cleanup` (worktree `../videorc-wt-080`).
All six owner decisions were confirmed on 2026-09-30. Nothing is implemented yet. Priority P1: item 4 is a user-visible false error
that has shipped in every macOS build since 0.9.101. The rest is polish the
owner asked for directly. Size L overall, in 8 ordered slices. Slices 1-4 are
independent of each other; slices 5-7 build on each other.

## What the owner asked for (2026-09-30, from screenshots)

1. **Sidebar update row.** It reads "Restart to update t…" because the label
   never fits. It should say only "Restart to update".
2. **Livestream destination card (expanded).** It is disorganized and reads
   like developer output: raw OAuth scopes, the status repeated three times, a
   full-width Disconnect. It should read well for someone connecting through
   OAuth or through a stream key (RTMP).
3. **Livestream right column** ("Live output health", "Multistream readiness").
   It is technical, always open, and not explained. "Live stream should be
   about connecting your accounts and not about reading some tech data." The
   technical part must be expandable, not always visible.
4. **Mic preview.** The Audio mixer says "Live preview unavailable. The mic may
   be in use or needs permission." with AirPods Pro selected. The owner records
   with that mic every day. "We need to fix that."
5. **Studio Inputs card.** Split the single "Source" row, which today holds both
   screen and camera, into a **Screen** row and a **Camera** row, so the card
   has six rows.
6. **Settings.** "In settings no need for those icons at all": no icon next to
   any section heading, on every Settings tab.

Scope decisions already stated to the owner (not objected to):
- Item 6 covers **Settings only**. Headings on Livestream, Sources, Health and
  the other pages keep their icons unless a slice below rebuilds that section.
- Button icons, platform logos and status dots stay. Only the decorative
  heading icons go.

## Owner decisions (all six CONFIRMED by the owner, 2026-09-30)

| # | Question | Decision |
| --- | --- | --- |
| D1 | "Update 0.9.124 available" and "Downloading update… 42%" truncate the same way. Drop the version from them too? | Yes: "Update available", "Downloading… 42%", "Restart to update". The full text (with version) goes in the tooltip. |
| D2 | Rename the connection modes "OAuth" / "Manual RTMP"? | Yes: **Sign in** / **Stream key**, under the label "Connect with". |
| D3 | Where does Disconnect go? | A small ghost button at the end of the account row, not full width and not hidden in a menu. |
| D4 | The technical details: collapsed in place, or moved to the Health page? | Collapsed in place, at the bottom of the right column ("Technical details", closed by default). The owner said "expandable there". |
| D5 | What does the Camera row show when no camera is chosen? | "Off", matching the System audio and Captions rows. |
| D6 | The Screen row also lists windows. Label it "Screen" anyway? | Yes, "Screen" (the owner's word). The picker groups items under "Screens" and "Windows". |

## Findings (read-only research, 2026-09-30)

All renderer paths are relative to `apps/desktop/src/renderer/src/`.

### Item 1: update chip

- `lib/update-ui.ts:18-38`, `updateChip()`, builds every chip label:
  - `available`: `` `Update ${version} available` ``
  - `downloading`: `` `Downloading update… ${percent}%` ``
  - `downloaded`: `` `Restart to update to ${version}` ``
- `components/sidebar.tsx:97-140` renders it. The label is
  `<span className="min-w-0 flex-1 truncate">` (:134) inside a `w-52` sidebar,
  so about 20 characters fit. All three labels are longer than that.
- There is no tooltip and no `aria-label`. The sidebar convention is the
  native `title` attribute (Search button `sidebar.tsx:204`, `theme-toggle.tsx:23`).
- The same chip runs on macOS, Windows and Linux; there are no platform
  branches. Settings → About (`settings/about-settings.tsx:103-212`) has its own
  hard-coded strings. It has room, so it is untouched.
- Tests: `lib/update-ui.test.ts:40-58` matches all three labels exactly.
  `components/tabs/settings-entry-points.test.ts:19-23` pins the mount line
  `sidebar.tsx:295` as source text. Do not reformat that line.

### Item 2: destination card

Everything lives in `components/tabs/streaming-tab.tsx` (2,375 lines, lazy
loaded from `app-shell.tsx:65-67`, so it costs nothing in the eager bundle).

- `DestinationCard` :462-930. It is one component for all platforms, with
  branches inside.
  - Header `ListRow` :608-638: glyph, `target.label`, context
    `account?.accountLabel` (shown even in Manual mode), a 9:16 tag, a status
    badge, an enable `Switch` and a decorative chevron.
  - The row is `role="button"` with `onClick` but **no `tabIndex` and no key
    handler**, so the keyboard cannot reach it.
  - Status badge :514-517: while idle it is almost always **"Idle"**.
    `configuredBadge` (:438-443, "Off" / "Ready" / "Needs setup") never runs,
    because every normalized target keeps `status.state: 'not-configured'`
    (`lib/capture.ts:590`, `:1835`). So "Idle" says nothing.
  - "Auth mode" `ToggleGroup` with "OAuth" / "Manual RTMP" :691-717. The design
    skill says segmented choices use `Tabs`.
  - Manual body :738-849: "RTMP server" / "Full RTMP URL", "Stream key", the
    helper "Saved securely per platform. Switching platforms never overwrites
    another key.", "Restore previous …", and the replace and remove dialogs
    :851-917.
- `OAuthAccountPanel` :994-1361:
  - **No account:** "No account connected" plus Connect :1032-1060. Below it,
    "Uses backend provider credentials." and a credential-source badge
    ("Environment override" / "Bundled default" / "Missing client ID")
    :1062-1069, :1363-1372. Both are developer information.
  - **Connected box** :1159-1360:
    - avatar, name, @handle; a "Connected" or "Reconnect" pill;
    - a **nested** box with a "Validated" / "Refreshed" / "Needs reconnect" /
      "Not checked" badge and the raw backend `validation.message`
      ("Account access is valid.", or raw errors such as "Account validation
      failed: {error}; token refresh retry failed: …", from
      `crates/videorc-backend/src/main.rs:2414-2566`);
    - **every granted scope as a chip** :1185-1195;
    - the Twitch audience-scope strip :1196-1211;
    - the YouTube channel `Select`, Refresh, and the helper "Switching channels
      clears prepared YouTube ingest state…" :1212-1253;
    - the X capability block :1254-1349;
    - a full-width Disconnect :1350-1358.
- Special cases to keep:
  - Manual-only targets: Custom RTMP, TikTok and Instagram
    (`lib/capture.ts:557-565`), and Kick when no client ID is bundled.
    Facebook joins them in open PR #504.
  - YouTube Vertical shares the YouTube account and channel.
  - X keeps the explicit "Switch to Manual RTMP" action; never fall back
    silently (plan 028).
  - The Twitch "Reconnect Twitch" affordance must stay on the Twitch card:
    `comments-header.test.ts:81` pins the pointer copy "Reconnect Twitch in
    Livestream → Setup", and plan 055 S6 makes this card its one home.
- Tests: no vitest file or probe asserts on "Auth mode", "Validated",
  "Disconnect", the scope strings or the card markup. The one hard pin is
  `main/renderer-security-policy.test.ts:403-407`: the literals
  `openExternalUrl(xNativeCapability.docsUrl)` and
  `openExternalUrl(xNativeCapability.apiOverviewUrl)` must stay in
  `streaming-tab.tsx`.

### Item 3: right column

- `StreamingSetup` :138-389 uses the grid
  `lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]` (:254). The right column
  :359-386 holds a compatibility `Alert`, `LiveOutputHealth` and
  `StreamingReadiness`, nothing else.
- `LiveOutputHealth` :1929-2093:
  - the description comes from `streamHealthDescription` :2133-2175 ("The
    backend verified the exact output path…");
  - "Classified stage" plus a badge;
  - **six stats that all read "-" unless live**;
  - path rows Effective provider / profile / GOP / Encode sharing / Requested
    path / Effective path / Effective encoder, rendered as `<code>`.
- **Preflight blocks Go Live.** When the output-path check has not run or has
  failed, the copy says "Go Live stays blocked." That is the only part of
  this card a user must see while idle. It cannot go behind a collapse.
- `StreamingReadiness` :2215-2323: "Destinations ready", an output row with the
  long per-destination string again, "FFmpeg available", estimated upload,
  estimated disk and a footnote.
- **Bug: the ready count ignores sign-in.** "Destinations ready" uses
  `isStreamTargetReady` (a server URL plus a stored key, `capture.ts:1973-1988`).
  A destination connected by sign-in with no stored key therefore counts as
  not ready, although Go Live uses `isStreamTargetStartReady`
  (`capture.ts:1990`), which accepts it. The owner's "1/4 ready" undercounts.
- **Bug: TikTok and Instagram show as "Custom".** `platformLabel`
  :1914-1927 knows only youtube, twitch, kick and x. YouTube Vertical shows as
  "YouTube".
- **Re-render cost.** `StreamingSetup` itself subscribes to
  `useStudioDiagnostics()` (:177), so the whole Setup view, destination cards
  and Broadcast info form included, re-renders on every diagnostics tick.
- While live, the same numbers already appear in the Stream Manager stats bar
  (`stream-manager/stats-bar.tsx`, the plan 057 words rule) and on the Health
  page (`tabs/diagnostics-tab.tsx:491-545`).
- shadcn `Collapsible` and `Accordion` are installed (`components/ui/`).

### Item 4: mic preview (root cause found in code; confirm on device in S3)

- The screenshot shows the **Sources page** panel (`tabs/sources-tab.tsx:423-447`).
  The text comes from `components/studio/mic-picker-preview.tsx:50-54` when
  `lifecycle.status === 'unavailable'`.
- The preview is the renderer's browser analyser
  (`hooks/use-studio-mic-visual.tsx` → `lib/browser-mic-visual-pipeline.ts` →
  `lib/mic-visual-pipeline.ts` → `lib/mic-stream.ts`), not the backend.
- **Root cause (high confidence).** Since #389 (`13139793`, plan 046 S5,
  shipped in 0.9.101), the preview opens the mic in **strict** mode
  (`use-studio-mic-visual.tsx:122`).
  - Strict mode requires exactly one Chromium audio input whose label equals
    the backend's device name after trimming and lowercasing
    (`mic-stream.ts:106-120`). Otherwise `open()` returns `null` **before
    calling `getUserMedia`**, and the pipeline publishes `'unavailable'`.
  - On macOS, Chromium appends the transport to every label: "AirPods Pro
    (Bluetooth)", "MacBook Pro Microphone (Built-in)", "(Virtual)", and a
    `(vid:pid)` suffix for USB.
  - The repo has recorded this already:
    `docs/acceptance/2026-09-28-system-audio.md:154` shows "Default - MacBook
    Pro Microphone (Built-in)".
  - The backend name is the bare CoreAudio name, "AirPods Pro"
    (`crates/videorc-backend/src/audio.rs:1418-1450`), so the match can never
    succeed. This probably breaks the idle preview for every Mac mic.
  - The test fixtures use bare labels only (`mic-stream.test.ts:40`,
    `mic-visual-pipeline.test.ts:120`, `studio-mic-visual-provider.test.ts:455`),
    which hid it.
  - The older non-strict matcher (`lib/mic-meter.ts:173-192`) accepted this case.
- **The copy lies.** `'unavailable'` is reachable only after
  `mediaAccess.microphone === 'granted'` (`mic-stream.ts:68-73`), so "needs
  permission" is never the real reason there. Every failure (no match, an
  ambiguous match, any `getUserMedia` DOMException, an AudioContext failure)
  collapses to the same `null` with no reason and no log
  (`mic-stream.ts:95,100,120,133`; `mic-visual-pipeline.ts:343-353,388-398`).
- **No retry.** After `'unavailable'`, the same device is never tried again
  until the selection, mute, tab or visibility changes. Nothing listens for
  `devicechange` (AirPods connect and disconnect constantly).
- **Why recording "works".** Recording uses the backend capture. The Studio
  mixer (`studio/audio-mixer.tsx:94-137`) falls back to the backend's
  `micLiveLevel` during a session, so its bars move while recording. While
  idle it sits flat at "Idle" because it uses the same broken analyser. The
  fix should revive those idle bars too.
- The five local commits on `feat/windows-owner-waiver` in the shared checkout
  (71d7c3e5 "say Muted", 15206746 "remove the system audio row", dc76bd5b and
  others) are **already on main** through #375 `f1beb51b`. Plan 069 then
  superseded the system-audio row. Nothing needs porting. Do not re-apply
  15206746.

### Item 5: Inputs card

- `components/studio/quick-settings.tsx:94-336` (`QuickSettings`, mounted at
  `tabs/studio-tab.tsx:237`, lazy loaded).
- The "Source" row (:160-201) is a `Popover` with two `SourceSelect` fields:
  "Screen / window" and "Camera". Its trigger joins both names with " · "
  (:150-154), which truncates.
- **The model already separates them.** `SourceSelection`
  (`shared/backend.ts:329-339`) has independent capture and camera slots, and
  `switchSourceDeviceLive('capture' | 'camera', …)` (`use-studio.tsx:8467-8512`)
  switches each one alone, idle or live. Picking a camera never changes the
  layout preset. So this is a presentation change, plus one bug fix:
- **Bug: choosing no camera does not stick while idle.** `reconcileSourceSelection`
  (`lib/capture.ts:2604-2605`) sets
  `camera = findRememberedSource(…) ?? cameras[0]`. The effect at
  `use-studio.tsx:5546-5566` re-runs it on every `deviceList` change and when a
  session ends, so "None" silently comes back as the first camera. A dedicated
  Camera row with "Off" makes this obvious.
- Live-switch rules to respect (plan 046, #389):
  - the rows stay usable while recording or streaming;
  - they are disabled with a reason while a session starts or stops, or while
    a switch is pending (`sourceSwitchReason`);
  - the screen "None" option appears only where `allowCaptureNone` allows it;
  - turning the camera off keeps the layout geometry, and an empty camera-only
    canvas is black.
- Tests: `studio/quick-settings.test.ts` covers only the System audio value.
  Nothing asserts "Source", "Inputs" or the row count.

### Item 6: Settings heading icons

- The heading component is `components/panel-section.tsx:11-60` (`icon?: AppIcon`,
  rendered at :43-48).
- Settings has 11 call sites, and **all** of them pass an icon:

  | Tab | File:line | Heading | Icon |
  | --- | --- | --- | --- |
  | General | `settings/general-settings.tsx:24` | Appearance & behavior | ThemeIcon |
  | General | `settings/general-settings.tsx:116` | Import | DownloadIcon |
  | Recording | `settings/recording-settings.tsx:73` | Recording & storage | SettingsIcon |
  | Permissions | `settings/permissions-settings.tsx:34` | System access | LockIcon |
  | Shortcuts | `settings/shortcuts-settings.tsx:83` | Global shortcuts | SettingsIcon |
  | Shortcuts | `settings/shortcuts-settings.tsx:137` | App shortcuts | KeyboardIcon |
  | Remote | `settings/remote-settings.tsx:40` | Remote control | SettingsIcon |
  | Remote | `components/phone-remote-section.tsx:223` | Phone remote | MobileIcon |
  | Orcle | `components/cohost-settings-section.tsx:125` | Orcle (alpha) | CohostIcon |
  | About | `settings/about-settings.tsx:31` | Support | BugIcon |
  | About | `settings/about-settings.tsx:61` | About & updates | SparkleIcon |

- `ThemeIcon` (PaintBrush) and `KeyboardIcon` (Keyboard) are used nowhere
  else, so they become unused. The icon set is licence-counted (100 glyphs).
  `docs/icon-set.md` counts are stale (:24, :54, :138).
- `PanelSection` is used 32 more times outside Settings. The `icon` prop
  stays.
- No test or probe asserts on the icons. `components/tabs/settings-layout.test.ts:84-95`
  checks the heading **titles** by regex, so keep every title unchanged.

## Cross-cutting constraints

- **Worktree.** Run everything in `../videorc-wt-080`, never in the shared
  checkout (other sessions switch its branch). Camera and mic smokes cannot
  run from a worktree because of per-binary TCC; the device acceptance for S3
  and S4 uses the packaged app.
- **Copy.** Follow the plan 057 words rule: quiet when fine, specific when not.
  `pnpm lint` fails on an em dash in app copy. Use "·", a comma or a new
  sentence.
- **Design.** Load `.claude/skills/videorc-design/SKILL.md` before S2 and
  S4-S7, and follow its rules:
  - shadcn only;
  - `Tabs` for segmented choices;
  - `GroupedList` + `ListRow` for sets;
  - no cards on cards;
  - tooltips are native `title` in the sidebar, and the glass `Tooltip`
    elsewhere;
  - a rounded bordered text span is a bug: use `Badge`.
- **Budget.** `streaming-tab.tsx`, `quick-settings.tsx` and `sources-tab.tsx`
  are lazy. Logic added to `hooks/use-studio.tsx` or `lib/capture.ts` is
  **eager**, and eager headroom has been a few hundred bytes (plans 076/077).
  Keep new logic in lazy modules. Run `pnpm check:renderer-assets` on every
  slice that touches an eager file.
- **Open PRs that touch the same files.**
  - #504 (Facebook Live, plan 079) changes 8 lines of `streaming-tab.tsx`: a
    manual-only target, guidance and `platformLabel`. Whichever lands second
    rebases.
  - Plan 078 (Twitch follower names, in a worktree) may touch the Twitch
    audience-scope strip. Keep that strip's gating exactly as it is on main.
- **Release classification.** Every renderer file here except
  `cohost-settings-section.tsx` counts as capture-sensitive for the macOS
  capture-decay (D3) release gate
  (`scripts/lib/capture-decay-release-acceptance.mjs:88-120`). The release that
  carries this plan needs the normal D3 evidence. Nothing here avoids that.

## Slices

Route and model per `CLAUDE.md`:
- S1-S2: Implementation (fit 8), lane `opus-4.8` (small, user-facing copy and
  cosmetics).
- S3: Diagnose (fit 9), lane `gpt-5.5`. The root cause is identified and the
  fix is clear, with tests. Escalate to `fable-5` if the S3 step 1 repro
  contradicts the diagnosis.
- S4-S7: UI/Product Design (fit 9), lane `opus-4.8`. Escalate to `fable-5` if
  the first pass is below the bar.
- S8: the owner's by-eye acceptance.

### S1. The update chip says "Restart to update" (item 1)

- In `lib/update-ui.ts`, drop the version from all three chip labels (D1):
  "Update available", "Downloading… {n}%", "Restart to update".
- Return a second field, `detail`, carrying the full sentence with the version:
  "Restart to update to 0.9.125", "Downloading update 0.9.125… 42%",
  "Update 0.9.125 available".
- `sidebar.tsx` renders `detail` as the button's `title` and `aria-label`.
  Leave line :295 exactly as it is (`settings-entry-points.test.ts` pins it).
- Keep `truncate` as a guard, but no label may need it at `w-52`.

**Done when:** `lib/update-ui.test.ts` asserts the three new labels and the
three `detail` strings. A render of the sidebar in the downloaded state shows
"Restart to update" with no ellipsis. Check this with a packaged-style
capture, or the dev app plus a stubbed `useUpdater`, at the default sidebar
width. Gates: `pnpm typecheck`, `pnpm lint`,
`pnpm --filter @videorc/desktop test -- update-ui settings-entry-points sidebar`.

### S2. No section-heading icons in Settings (item 6)

- Remove `icon=` from the 11 call sites in the table above. Delete the imports
  that become unused; ESLint `no-unused-vars` catches the leftovers.
- Remove the `ThemeIcon` and `KeyboardIcon` slots from `components/icons.tsx`
  and update `docs/icon-set.md`: correct the counts at :24, :54 and :138, and
  record the two freed glyphs.
- Add a guard to `components/tabs/settings-layout.test.ts`: for every file
  rendered under Settings (`settings/*.tsx`, `phone-remote-section.tsx`,
  `cohost-settings-section.tsx`), the source contains no
  `<PanelSection` … `icon=`. A heading icon added to Settings later then fails
  the test.
- Do not touch `PanelSection` itself or any call site outside Settings.

**Done when:**
- the guard test passes and fails if any one `icon=` is restored;
- `settings-layout.test.ts` title checks still pass;
- a click through all seven Settings tabs in the dev app shows text-only
  headings, aligned flush with their descriptions.

Gates: `pnpm typecheck`, `pnpm lint`, `pnpm --filter @videorc/desktop test`,
`pnpm check:renderer-assets` (`icons.tsx` is eager).

### S3. The mic preview works for real Mac mics and never falsely blames permission (item 4)

1. **Reproduce first (diagnose route).**
   - In the dev app with the owner's AirPods Pro, open Sources.
   - In DevTools, run
     `(await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput').map(d => d.label)`
     and record the labels next to the backend device names in the plan's
     implementation record.
   - Repeat with the built-in mic. The diagnosis predicts that one fails too.
   - If the labels are empty, or match exactly, stop and re-diagnose on
     `fable-5` before changing code.
2. **Typed failure instead of `null`.**
   - `mic-stream.ts` `open()` returns
     `{ stream } | { failure: 'no-media' | 'no-label-match' | 'ambiguous-label' | 'labels-hidden' | 'permission-denied' | 'device-busy' | 'device-missing' | 'overconstrained' | 'audio-context' | 'unknown', detail }`.
   - Map the DOMException names: NotAllowedError → permission-denied;
     NotReadableError / AbortError → device-busy; NotFoundError → device-missing;
     OverconstrainedError → overconstrained.
   - The pipeline carries it as `unavailableReason` in the lifecycle snapshot.
   - `MicPickerPreview` exposes it as `data-videorc-mic-preview-reason` for
     smokes, and logs one `console.debug` per failure in dev builds.
3. **Match Chromium's labels.**
   - Add a pure helper `chromiumAudioInputBaseLabel(label)` in a lazy-safe
     `lib/` module (not `use-studio.tsx`).
   - It strips a trailing ` (Built-in|Bluetooth|Bluetooth LE|USB|Virtual|Aggregate|AutoAggregate|PCI|FireWire|HDMI|DisplayPort|AirPlay|AVB|Thunderbolt)`,
     a trailing ` ([0-9a-f]{4}:[0-9a-f]{4})`, and a leading `Default - ` /
     `Communications - `.
   - Strict mode keeps its "exactly one match" rule, applied to base labels.
   - Report `ambiguous-label` rather than guessing when two inputs share a
     base label (for example two identical USB mics).
   - Do not reintroduce the loose containment matcher. Plan 046 S5 chose
     strictness so the preview never meters the wrong device.
4. **Retry when devices change.**
   - One `navigator.mediaDevices` `devicechange` listener, owned by the
     pipeline for as long as it wants frames.
   - It re-runs `open()` for the current selection when the status is
     `'unavailable'` with reason `no-label-match`, `device-missing` or
     `device-busy`.
   - Debounce it (500 ms), and remove the listener when the pipeline releases.
5. **Honest copy** in `mic-picker-preview.tsx`, chosen by reason:
   - `permission-denied`: "Videorc can't use this mic. Allow it in System
     Settings." plus the existing permission action. Only this reason may
     mention permission.
   - `device-busy`: "Another app is using this mic. The preview resumes when
     it's free. Recording still works."
   - `no-label-match`, `ambiguous-label` or `device-missing`: "No preview for
     this mic. Recording still works."
   - anything else: "Preview unavailable. Recording still works."
   - Never say "needs permission" when `mediaAccess.microphone === 'granted'`,
     and add a test that pins this.

**Done when:**
- `mic-stream.test.ts` passes. It must include "AirPods Pro (Bluetooth)",
  "MacBook Pro Microphone (Built-in)", "Default - MacBook Pro Microphone
  (Built-in)", "Shure MV7 (14ed:1012)", two identical "USB Mic (Virtual)"
  entries (ambiguous), and "Studio" vs "Studio Plus (USB)" (still no match).
  Each case asserts the stream or the typed failure.
- A pipeline test shows `devicechange` recovering `no-label-match` → live.
- A preview render test shows no "permission" copy for any reason except
  `permission-denied`.
- In the **packaged** app, the Sources preview and the Studio mixer idle bars
  move with AirPods Pro and with the built-in mic, and
  `data-videorc-mic-preview-reason` is absent.

Gates: `pnpm typecheck`, `pnpm lint`, `pnpm --filter @videorc/desktop test`,
`pnpm smoke:recording-studio`. The visual mic owner interacts with live mic
switching; see AGENTS.md audio-capture rules.

Follow-up, not in this plan: on macOS, stream the backend warm-mic level
instead of opening a second capture client. That would remove label mapping
entirely. Only worth it if S3 step 1 shows Chromium labels that the helper
cannot normalize (for example data-source names).

### S4. Separate Screen and Camera rows in Inputs (item 5)

1. **The camera stays off when the user turns it off.**
   - Persist an explicit "camera off" choice, so `reconcileSourceSelection`
     does not fill in `cameras[0]` after the user chose Off.
   - First find where `captureConfig.sources` is persisted and whether it
     crosses into Rust.
   - If it crosses: follow the serde rule. A new `Option` field needs
     `#[serde(default, skip_serializing_if = "Option::is_none")]`, and the
     mirrors must stay in step (see the "serde null → contract trap" memory).
   - A renderer-only flag is preferred if the backend never reads it.
   - A first-launch or unknown state still auto-picks a camera, as today.
   - Picking any camera clears the flag.
2. **Six rows, in this order:** Screen, Camera, Mic, System audio, Output,
   Captions.
   - **Screen** (`DisplayIcon`):
     - a `SourceSelect` over `captureDevices` with the searchable variant,
       grouped "Screens" / "Windows" (lazy cmdk, already used on Sources);
     - `allowNone={allowCaptureNone}`, and `switchSourceDeviceLive('capture', …)`;
     - the value is the display or window name, "Test pattern" when set, and
       otherwise the saved `screenName` / `windowName`, as the Mic row does;
     - `SourceSwitchStatus kind="capture"` as its description or tooltip.
   - **Camera** (`CameraIcon`):
     - a `SourceSelect` over cameras, with an "Off" option in place of "None";
     - `switchSourceDeviceLive('camera', …)`;
     - the value is the camera name or "Off" (D5);
     - `SourceSwitchStatus kind="camera"`.
   - Both rows use the Mic row's pattern: `InspectorRow` + `TRIGGER_CLASS`.
     Use a direct `Select` trigger if no secondary control is needed, and a
     `Popover` only if the switch-status line needs room.
   - Disabled states and reasons come from `sourceSwitchReason('capture' | 'camera')`,
     unchanged.
3. Neither row ever changes the layout preset. The Scene page hint "Select a
   camera in Studio…" (`layout-tab.tsx:292-297`) now points at a real row;
   keep its wording.

**Done when:**
- new `quick-settings.test.ts` cases render six labelled rows in order;
- the Camera row shows "Off" when no camera is selected;
- a `capture.test.ts` case proves an explicit Off survives
  `reconcileSourceSelection` with cameras present, while an unknown state
  still defaults to `cameras[0]`;
- `studio-provider.integration.test.ts` switches `'camera'` to Off and back,
  idle and live;
- in the **packaged** app, switching the camera while recording follows the
  plan 046 rules (black and pending, then the new camera; layout geometry
  kept);
- Off survives a Sources → Refresh and a record/stop cycle.

Gates: `pnpm typecheck`, `pnpm lint`, `pnpm --filter @videorc/desktop test`,
`pnpm check:renderer-assets` (if `capture.ts` changed), `pnpm smoke:recording-studio`,
`node scripts/smoke-live-source-switch-app.mjs`, and
`pnpm smoke:recording-studio:devices` from the packaged app if TCC allows. If
TCC blocks it, say so and run the closest focused smoke.

### S5. Destination card header and connection mode (item 2, part 1)

All changes stay in `streaming-tab.tsx`, or new files imported only by it.
Start by moving `DestinationCard` and `OAuthAccountPanel` into
`components/streaming/destination-card.tsx` (no behaviour change, its own
commit), so S5-S7 stop growing a 2,375-line file. Keep the two
`openExternalUrl(xNativeCapability.…)` literals **in `streaming-tab.tsx`**, or
move the policy test's target in the same commit.

- **Header (quiet when fine).**
  - While idle, the badge shows only a problem: "Needs setup" (warning) when
    the destination is enabled and `!isStreamTargetStartReady`; "Prepared" as
    today when prepared; nothing when ready or disabled.
  - Delete the dead `configuredBadge` path. In-session runtime badges are
    unchanged ("On air", "Connecting", "Stopped", "Skipped", "Ended").
  - The context reads the account name in Sign-in mode and "Stream key" in
    Stream-key mode.
  - The row becomes keyboard-operable: `tabIndex={0}`, Enter and Space toggle,
    and `aria-expanded` is kept. The Switch keeps its own focus.
- **Connection mode** (D2): a `Field` labelled "Connect with", holding shadcn
  `Tabs` "Sign in" / "Stream key" in place of the `ToggleGroup`. The custom
  target's "URL mode" gets the same `Tabs` treatment ("Server + key" /
  "Full URL").
- **Manual-only targets** (Custom, TikTok, Instagram, Kick without a client
  ID, Facebook after #504) show no switch. They show one line, "{Platform}
  uses a stream key.", plus the existing "Where to find it" guidance link.
  Kick's manual guidance appears only in Stream-key mode.
- **Stream-key body.** Labels "Server URL" and "Stream key". The helper is
  "Saved securely · ends ••{last4}" when a key is saved; otherwise nothing.
  Restore, replace and remove dialogs and the X Producer note are unchanged
  apart from shorter copy.

**Done when:** a new `destination-card.test.tsx` (renderToStaticMarkup, like
`streaming-metadata.test.ts`) covers:
- a connected Twitch card with no scope strings in the markup;
- a TikTok card with no mode switch;
- the header badge for each of enabled/not-ready, ready and prepared;
- the header row reachable with the keyboard (`tabIndex="0"`);
- "Stream key" context in manual mode.

`renderer-security-policy.test.ts` still passes.

### S6. The signed-in account reads as one line (item 2, part 2)

Replace the connected box :1159-1360 with, top to bottom:

1. **Account row.**
   - Avatar, name, @handle, and one status: a success dot for
     valid/refreshed, no dot for not-checked, or a warning "Needs reconnect"
     `StatusBadge`.
   - The backend `validation.message` moves to the status's tooltip and is
     never shown inline. There are no scope chips and no nested box.
   - Trailing: a small ghost **Disconnect** (D3). When a reconnect is needed,
     a **Reconnect {Platform}** button comes first.
2. **Only when something needs the user**, one line under the row:
   - needs reconnect: "Videorc lost access to this account. Reconnect to keep
     streaming here.";
   - the Twitch audience scopes: keep today's gating exactly. The copy becomes
     "Follow alerts and sub count need one more Twitch permission." plus
     **Reconnect Twitch**;
   - YouTube Vertical: "Uses your YouTube account above." instead of
     repeating Disconnect and the channel on both cards.
3. **YouTube "Channel"** field: the `Select`, plus an icon-only Refresh with
   the tooltip "Refresh channels". Drop the "Switching channels clears prepared
   YouTube ingest state…" helper. With no channels loaded, the placeholder
   reads "Refresh to load your channels".
4. **X Live**: keep the block and its explicit "Switch to Manual RTMP"
   action, which is renamed "Use a stream key instead". Reduce it to the
   badge, one sentence, and the two doc links (the literals stay, see S5).
5. **Not connected:** the full box becomes "Connect {Platform}" (primary)
   plus one line saying what signing in does: "Videorc sets your title and
   gets the stream key for you." Remove "Uses backend provider credentials."
   and the "Bundled default" badge. Show "Environment override" only in dev
   builds (`import.meta.env.DEV`). "Missing client ID" already routes to
   Stream key (S5).
6. The YouTube consent dialog is unchanged.

**Done when:** `destination-card.test.tsx` renders every account state:
- connected+valid;
- connected+refreshed;
- not-checked;
- needs-reconnect with a raw error message (the raw text appears only inside
  `title`);
- Twitch missing an audience scope;
- YouTube Vertical;
- X in each capability state;
- no account;
- no account in a dev build.

The markup contains no `https://www.googleapis.com/auth`, no `channel:` and no
`user:` scope string. `comments-header.test.ts` and `activity-pane.test.ts`
still pass.

### S7. The right column: "Ready to go live" plus collapsed Technical details (item 3)

1. **"Ready to go live"** replaces "Multistream readiness". It uses
   `PanelSection` with no heading icon, matching Destinations. Its rows are
   `ChecklistRow`s, quiet when fine:
   - **Destinations:** "3 of 4 ready", counted with `isStreamTargetStartReady`
     (fixing the sign-in undercount). Each destination that is not ready
     gets its own row, "Twitch · sign in or add a stream key", and clicking
     it scrolls to that card and opens it. This lifts the card's `expanded`
     state into `StreamingSetup` as a `Set<string>`.
   - **Stream check:** the preflight state in plain words. "Checking your
     stream settings…"; a failure reads "Couldn't check your stream settings.
     Go Live stays off until this passes." plus **Retry**; a success is a quiet
     success row, "Stream settings checked". This must stay outside the
     collapse, because it gates Go Live.
   - **Quality:** "1080p · 30 fps · 6 Mbps", once. When destinations differ,
     it reads "Varies by destination" and a tooltip lists each one.
   - **Upload needed:** "About 24 Mbps".
   - **Disk:** "About N GB per hour", shown only when recording too.
   - **FFmpeg:** shown only when unavailable, with the existing "check
     Settings" action.
   - The `compatibilityMessage` warning `Alert` stays above the section.
2. **"Technical details"**: a shadcn `Collapsible`, **closed by default**. The
   open state is a per-viewer convenience in `localStorage` under
   `videorc.livestream.technicalDetails`, with try/catch on every read and
   write; the default applies when storage is unavailable.
   - **Collapsed trigger:** "Technical details". While live it adds a one-line
     summary, following the Stream Manager words rule: the bitrate and fps
     when healthy ("6.0 Mbps · 30 fps"), otherwise the problem ("12
     dropped/min", "Encoder fallback").
   - **Contents while live:** the six stats with human labels (Frame rate,
     Bitrate, Encoder speed, Dropped frames, Duplicated frames, Coalesced
     frames).
   - **Contents while idle:** "Stats appear when you go live." instead of
     six "-".
   - **Output rows, one per line:** Encoder (for example "VideoToolbox ·
     hardware"), Output path, Fallback reason (only when present), Keyframe
     interval "2 s", Encode sharing, then **one row per destination** with its
     profile. Remove the joined " / " string.
   - Replace "Classified stage" with a "Health" row. Remove the description
     "The backend verified the exact output path…".
3. **Fix `platformLabel`.** Label every target by its own name, including
   TikTok, Instagram, YouTube Vertical and Facebook after #504. Reuse one
   helper if a shared one exists; do not add one to eager `capture.ts` unless
   the budget allows it.
4. **Performance.** Move the `useStudioDiagnostics()` subscription out of
   `StreamingSetup` into the Technical details body and the collapsed-summary
   component, so ticks no longer re-render the destination cards or the
   Broadcast info form.

**Done when:**
- `streaming-readiness.test.tsx` covers:
  - two sign-in destinations with no stored key counting as ready;
  - a TikTok destination labelled "TikTok";
  - a preflight failure visible with the collapse closed;
  - idle Technical details showing no "-" stats.
- A render-count check (a React Profiler test or a `vi.fn` counter on a
  memoized card) shows a diagnostics tick no longer re-renders
  `DestinationCard`.
- `smoke-scheduled-streams-app.mjs` still finds the "Upcoming" tab.

Gates for S5-S7: `pnpm typecheck`, `pnpm lint`,
`pnpm --filter @videorc/desktop test`, `pnpm check:renderer-assets`, and the
dev app with screenshots of Setup (idle, all states reachable with the test
account fixtures) at 1280 px and at the narrow single-column width. Flatten the
glass captures: `magick in.png -background '#000' -flatten`.

### S8. Owner acceptance

In a packaged build, check each item by eye:
1. the chip reads "Restart to update";
2. each destination card is clean for Sign in and for Stream key;
3. the right column is short, and Technical details opens and closes and
   remembers its state;
4. the mic preview moves with AirPods Pro and with the built-in mic;
5. Inputs has six rows and Camera Off sticks;
6. Settings headings have no icons.

Record the outcome in this plan's implementation record, and in the release
notes of the version that ships it.

## Out of scope

- Icons on non-Settings headings (Livestream Broadcast info, Sources, Health,
  Scene and others).
- Settings → About's own update strings.
- The Stream Manager window.
- A backend-streamed idle mic level (S3 follow-up only).
- Screen "None" stickiness (the screen still auto-defaults, as today).
- The Windows `unsupported` update copy.

## Verification summary

| Slice | Focused gates | Device / by-eye |
| --- | --- | --- |
| S1 | update-ui, settings-entry-points, sidebar tests | chip at default width |
| S2 | settings-layout guard, full desktop tests, renderer assets | 7 Settings tabs |
| S3 | mic-stream, pipeline, preview tests; `smoke:recording-studio` | packaged, AirPods + built-in |
| S4 | quick-settings, capture, provider tests; `smoke:recording-studio`, live source switch smoke | packaged, camera switch while recording |
| S5-S7 | destination-card, readiness tests; security-policy, comments-header, activity-pane; renderer assets | dev screenshots, all card states |
| S8 | - | owner, packaged |
