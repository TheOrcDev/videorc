# UI Glass Redesign — Execution Slices

> **Errata (2026-06-12, mid-execution).** Two macOS/Electron landmines found while executing slices 2–3, both bisected on isolated instances:
> 1. **Transparent window backgrounds wedge the renderer compositor on every in-place reload** (DOM runs, window paints nothing). The shell therefore uses NO backgroundColor override.
> 2. **Opening the command palette via synthetic ⌘K halts frame production** in every tested window config — including pre-redesign commits, so it likely predates this migration (tracked separately; real-keyboard repro still needed). Until resolved, true under-window vibrancy is **opt-in** via `VIDEORC_GLASS_VIBRANCY=1` and the shell ships the skill's solid-fallback glass; Slice 7's palette work is **blocked** on that investigation.
> Screenshot harness note: `capturePage` and `screencapture` are unreliable on these window configs; the sweep (`scripts/ui-theme-screens.mjs`) now captures via CDP `Page.captureScreenshot` (compositor-direct).

Cut from [ui-glass-redesign-plan.md](./ui-glass-redesign-plan.md). Design authority: `.claude/skills/videorc-design/SKILL.md` — read it before any slice. Components are shadcn/ui ONLY (see `.agents/skills/shadcn/`).

## Battle order

1. **Glass tokens (dark + light) + system font** — none
2. **Electron vibrancy shell** — depends on 1
3. **Shared primitives + shadcn variant retune** — depends on 1
4. **App shell, sidebar, navigation** — depends on 3
5. **Studio tab** — depends on 3
6. **Streaming tab** — depends on 3
7. **Dialogs, command palette, toasts** — depends on 3
8. **Tabs batch A: sources, layout, screens, recording** — depends on 3
9. **Tabs batch B: library, ai, diagnostics, settings** — depends on 3
10. **Color purge + dead-style cleanup** — depends on 4–9
11. **Final acceptance** — depends on all

## Shared contract (every slice)

- **Restyle-only.** No handler, hook, IPC, request, or copy changes. A functional problem discovered mid-slice becomes a separate task — never a rider.
- **Gates before commit:** from `apps/desktop/`: `pnpm typecheck && pnpm exec vitest run` (78+ tests stay green). From repo root: `pnpm exec eslint <touched files>` and `pnpm format:check` (run prettier --write on touched files first). Capture exit codes directly — do not pipe gates through `tail`/`grep`.
- **Screenshot recipe** (visual check): launch an isolated instance alongside any running dev app:
  `VIDEORC_USER_DATA_DIR=$(mktemp -d) VIDEORC_DATABASE_PATH=$(mktemp -d)/videorc.sqlite3 VIDEORC_SMOKE_PREVIEW_MOTION=1 VIDEORC_SMOKE_OUTPUT_DIR=/tmp pnpm dev`
  wait for the `[smoke] preview-motion-ready {host,port,capability}` line, then per surface:
  `curl -s -X POST http://HOST:PORT/command -H "Authorization: Bearer $CAPABILITY" -H 'Content-Type: application/json' -d '{"command":"open-tab","params":{"tab":"<tab>"}}'` followed by
  `curl -s -X POST ... -H "Authorization: Bearer $CAPABILITY" -d '{"command":"capture-page","params":{"name":"<tab>"}}'` → PNG path returned; open and compare against the skill's tokens/patterns.
- **Commit + push to `main` after each slice**, message naming the slice.

---

## Slice 1 — Glass tokens (dark + light) + system font
**Goal:** Both themes render on the glass token columns in the reference font; the green action accent ceases to exist; dark becomes the default theme. Light mode STAYS (owner decision) — same language, light column.
**Depends on:** none
**Touches:** `apps/desktop/src/renderer/src/styles.css`, the theme default (grep `useTheme|ThemeProvider|defaultTheme` under `apps/desktop/src/renderer/src/` — `components/theme-toggle.tsx` stays), `apps/desktop/package.json`.
**Steps:**
1. In `styles.css`: delete the `@fontsource-variable/geist` and `geist-mono` imports (lines ~3–4). Set `--font-sans`/`--font-heading` to `-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', system-ui, sans-serif` and `--font-mono` to `ui-monospace, 'SF Mono', SFMono-Regular, Menlo, monospace`.
2. Replace the `:root` token block with the skill's LIGHT glass column: `--background` `rgba(245,245,247,0.75)`-equivalent (oklch with alpha is fine), `--foreground #1C1C1E`, `--muted-foreground #6E6E73`, `--border`/`--input` black-8%, `--ring` black-25%, `--accent` black-6%, `--primary` near-black monochrome, `--popover`/`--card` solid `#F5F5F7` at 0.92 alpha.
3. Replace the `.dark` block with the DARK glass column: `--background` `rgba(24,24,27,0.75)`-equivalent, `--foreground #F4F4F5`, `--muted-foreground #A1A1AA`, `--border`/`--input` white-8%, `--ring` white-25%, `--accent` white-8%, `--primary` near-white, `--popover`/`--card` solid `#1C1C1F` at 0.92.
4. In BOTH columns: keep `--live` red and `--success/--warning/--info` (status-only usage is enforced in Slice 10); delete the green `--primary` action accent and the green sidebar/chart-1 values.
5. Keep the theme toggle and provider exactly as wired; change only the DEFAULT theme to dark.
6. `pnpm remove @fontsource-variable/geist @fontsource-variable/geist-mono` from `apps/desktop`.
**Done when:** gates pass; `grep -rn "fontsource\|Geist" apps/desktop/src` returns nothing; the theme toggle still switches themes (toggle once in the isolated instance); screenshots of `studio` and `streaming` in BOTH themes show glass tokens, no green accents, and SF Pro (Geist's single-story `g` is the tell); a fresh profile starts in dark.
**Out of scope:** layout/markup changes, Electron window settings, component variants, removing any theme machinery.

## Slice 2 — Electron vibrancy shell
**Goal:** The main window is genuinely translucent over the desktop (Raycast-style behind-window blur); the detached preview window chrome matches the glass language.
**Depends on:** Slice 1
**Touches:** `apps/desktop/src/main/index.ts` (mainWindow `new BrowserWindow` at ~line 146; `PREVIEW_WINDOW_HTML` constant), `apps/desktop/src/renderer/src/styles.css` (body/background transparency), renderer `index.html` if it sets a background.
**Steps:**
1. mainWindow options: drop `backgroundColor: '#ffffff'`; add `vibrancy: 'under-window'`, `visualEffectState: 'active'`, `transparent: true` (or `backgroundColor: '#00000000'`), `titleBarStyle: 'hiddenInset'`, and a `trafficLightPosition` that clears the app shell's header.
2. In `styles.css`, make `html, body` background transparent so the vibrancy shows through; the app container applies the translucent `--background` glass layer + hairline ring + `rounded-none` (the OS window provides the outer shape).
3. Sync the OS material with the app theme: set `nativeTheme.themeSource` from the renderer's theme (IPC on toggle; default `'dark'`) so the vibrancy tint always matches the in-app theme instead of the system appearance.
4. Restyle `PREVIEW_WINDOW_HTML`'s drag bar to the tokens: charcoal at 0.75 over its existing surface, white-8% hairline bottom border, tertiary-gray label — no other preview-window behavior changes (the preview window stays dark in both themes; it frames video).
4. Run `node scripts/perf-idle-probe.mjs` (repo root) before and after the change; record both outputs.
**Done when:** gates pass; screenshots in BOTH themes show the desktop blurring through the main window with matching vibrancy tint; `perf-idle-probe` still prints `probe PASSED` with presents ≈60/s and per-process CPU within 5 percentage points of the pre-change run; a record→stop smoke (start/stop via the app or `VIDEORC_PROBE_RECORD=1 node scripts/diag-probe.mjs` with the dev app closed) completes.
**Out of scope:** any preview/present pipeline code, window sizing/aspect logic, in-app component styling.

## Slice 3 — Shared primitives + shadcn variant retune
**Goal:** The four reusable design primitives exist, and the base shadcn components default to the glass language.
**Depends on:** Slice 1
**Touches:** new `apps/desktop/src/renderer/src/components/ui/kbd.tsx`, new `components/list-row.tsx`, new `components/section-header.tsx`, new `components/footer-action-bar.tsx`; retune `components/ui/button.tsx`, `badge.tsx`, `dialog.tsx`, `command.tsx`, `separator.tsx`, `input.tsx`, `sonner.tsx`.
**Steps:**
1. `Kbd`: rounded-md (6px) chip, white-10% bg, hairline border, 11–12px secondary-gray glyph. Accepts children like `⌘`, `K`, `↵`, `st`.
2. `ListRow`: the skill's row anatomy — 24px rounded-square icon slot, primary title, inline secondary-gray context, optional `Kbd` alias, spring space, right-aligned status icons + secondary-gray meta label; 44–48px tall; selected/hover = white-8% block at radius 8–10; built on plain flex + shadcn primitives (usable inside `Command` rows and plain lists).
3. `SectionHeader`: tertiary-gray 12–13px label with 16px top / 8px bottom spacing. `FooterActionBar`: hairline-top strip, ghost buttons + `Kbd` chips, `Separator` verticals.
4. Variant retunes: `Button` ghost-first (default visual weight ghost; no green fill anywhere; destructive = red text); `Badge` monochrome default + small dot-accent variants for live/success/warning; `Dialog` content = glass panel (rounded-2xl, hairline ring, `backdrop-blur`, fade+scale-from-0.98, 100–150ms); `Command` matches the borderless search header + sectioned list; `Separator` white-8%; `Input` gains a borderless on-panel variant; `sonner` toasts glass.
**Done when:** gates pass; `pnpm exec vitest run` green; a screenshot of any dialog (e.g. open Go Live confirmation via the studio tab) and of the command palette shows glass panel + retuned buttons; the four primitives are exported and compile.
**Out of scope:** adopting the primitives in feature components (Slices 4–9), removing old usages.

## Slice 4 — App shell, sidebar, navigation
**Goal:** The application frame reads as one glass command surface with a footer action bar and white-8% selection.
**Depends on:** Slice 3
**Touches:** `apps/desktop/src/renderer/src/components/app-shell.tsx`, `sidebar.tsx`, `workspace-nav.tsx`, `blocking-banner.tsx`.
**Steps:**
1. Sidebar items become `ListRow`s (icon + label + optional shortcut `Kbd`); active item = white-8% block — delete green active styling.
2. Workspace nav groups under `SectionHeader`s; banner restyles to hairline glass (no colored fills; severity via small status dot + text).
3. Add the global `FooterActionBar` to the shell surfacing the existing keyboard shortcuts (read the keydown map in `hooks/use-studio.tsx` — display only, do not change bindings).
**Done when:** gates pass; screenshots of the shell on two different tabs match the skill (monochrome chrome, hairlines, footer bar with kbd chips); keyboard shortcuts still work (manually trigger one, e.g. the palette shortcut).
**Out of scope:** tab content, dialogs.

## Slice 5 — Studio tab
**Goal:** The flagship operating surface follows the language: glass sections, footer-bar actions with shortcuts, status as dots — no filled CTAs.
**Depends on:** Slice 3
**Touches:** `components/tabs/studio-tab.tsx`, `components/panel-section.tsx`, `components/preview-stage.tsx`, `components/status-badge.tsx`, `components/status-dot.tsx`, `components/inspector.tsx`.
**Steps:**
1. `PanelSection` → glass section with `SectionHeader` (no card-on-card nesting).
2. Record / Go Live / Stop move into the tab's `FooterActionBar` as ghost text + `Kbd` (keep exact handlers); LIVE state = red `status-dot` + monochrome label, never a red/green button fill.
3. `status-badge`/`status-dot` restyle to monochrome badge + tiny color dot variants from Slice 3.
**Done when:** gates pass; screenshots idle AND during a recording (start/stop once) show the new layout with correct status treatment; Go Live dialog still opens.
**Out of scope:** the Go Live dialog itself (Slice 7), streaming tab.

## Slice 6 — Streaming tab
**Goal:** Destinations render exactly as the reference rows: colorful 24px platform icon, title, secondary-gray context, right-aligned meta — inside sectioned glass.
**Depends on:** Slice 3
**Touches:** `components/tabs/streaming-tab.tsx`.
**Steps:**
1. Each destination card becomes a `ListRow`: platform icon (Phosphor logo in a 24px rounded-square tile — the only saturated element), label as title, account/handle as inline context, right meta = state ("Connected" / "Manual RTMP" / "Blocked") in secondary gray with an optional status icon; row click/expand behavior unchanged.
2. Stream key + RTMP fields adopt the borderless `Input` variant inside glass sections; the existing key dialogs inherit Slice 3's glass `Dialog` automatically — verify, don't fork.
3. Go Live preflight destination rows (in `studio-tab.tsx`'s dialog) reuse the same `ListRow`.
**Done when:** gates pass; screenshots of connected, manual-RTMP, and blocked destination states plus the key-replace dialog match the row anatomy; saving/clearing/restoring a key still round-trips (use the isolated instance, store then restore a dummy key on Custom RTMP).
**Out of scope:** preflight logic, OAuth flows, key storage code.

## Slice 7 — Dialogs, command palette, toasts
**Goal:** Every overlay is a glass panel; the command palette IS the reference image.
**Depends on:** Slice 3
**Touches:** `components/command-palette.tsx`, the Go Live confirmation dialog in `components/tabs/studio-tab.tsx`, `components/onboarding-dialog.tsx`, stream-key dialogs in `components/tabs/streaming-tab.tsx` (verify-only), sonner usage sites.
**Steps:**
1. Command palette → `CommandDialog` with the full reference shape: borderless search header (icon + large placeholder + trailing hint chip), `SectionHeader` groups, `ListRow` results with right-aligned kind labels, `FooterActionBar` ("Open ↵ · Actions ⌘K" pattern using the palette's real actions).
2. Go Live confirmation + onboarding adopt glass panel composition: sectioned content, footer bar actions with `Kbd`, destructive confirm as red text.
3. Toast call sites need no change if Slice 3's sonner retune landed — verify one success and one error toast visually.
**Done when:** gates pass; palette screenshot is side-by-side comparable to the reference image (same anatomy top-to-bottom); each dialog screenshot shows glass + footer-bar actions.
**Out of scope:** adding new palette commands, changing dialog flow/conditions.

## Slice 8 — Tabs batch A: sources, layout, screens, recording
**Goal:** The four capture-config tabs converge on `ListRow`/`SectionHeader` glass composition.
**Depends on:** Slice 3
**Touches:** `components/tabs/sources-tab.tsx`, `layout-tab.tsx`, `screens-tab.tsx`, `recording-tab.tsx`, `components/source-select.tsx`.
**Steps:** device/source pickers and lists → `ListRow` (device icon tile, name, kind as context, state as right meta); option groups under `SectionHeader`; selects/sliders/switches keep shadcn components with retuned tokens (no bespoke styling).
**Done when:** gates pass; screenshot sweep of all four tabs; selecting a camera/screen still updates the preview (verify once in the isolated instance).
**Out of scope:** batch B tabs, preview behavior.

## Slice 9 — Tabs batch B: library, ai, diagnostics, settings
**Goal:** The remaining four tabs match; diagnostics keeps numerics in SF Mono.
**Depends on:** Slice 3
**Touches:** `components/tabs/library-tab.tsx`, `ai-tab.tsx`, `diagnostics-tab.tsx`, `settings-tab.tsx`, `components/live-chat-panel.tsx`.
**Steps:** recordings/library entries → `ListRow` (thumbnail/icon tile, filename, duration/size as meta); diagnostics tables → hairline rows, `--font-mono` numerics, monochrome severity with status dots; settings forms → glass sections; live-chat rows → `ListRow` variant with platform icon.
**Done when:** gates pass; screenshot sweep of all four tabs + the live-chat panel.
**Out of scope:** data shape, polling, chat behavior.

## Slice 10 — Color purge + dead-style cleanup
**Goal:** Nothing outside source icons and status dots is colored, in either theme; dead tokens are gone (the theme toggle and both themes STAY).
**Depends on:** Slices 4–9
**Touches:** `styles.css`, any stragglers the audits find.
**Steps:**
1. Audits (all must come back clean or be fixed in this slice):
   - `grep -rn "success\|warning\|info" apps/desktop/src/renderer/src/components --include="*.tsx" | grep -vE "status-dot|status-badge|sonner|toast"` → no styling hits outside status components/toasts.
   - `grep -rn "bg-primary\|bg-green\|text-green" apps/desktop/src/renderer/src` → nothing.
   - `grep -rn "Card" apps/desktop/src/renderer/src/components --include="*.tsx"` → no opaque card surfaces remain (delete `ui/card.tsx` if unused).
   - `grep -rn "rounded-(sm|3xl|full)" apps/desktop/src/renderer/src/components --include="*.tsx"` → only justified hits (avatars/dots may be `rounded-full`).
2. Delete dead tokens from `styles.css` (sidebar-green set, chart palette if unused, `--font-heading` if identical to sans) and any now-unused components.
**Done when:** gates pass; all four greps clean (or each remaining hit has a one-line justification comment in the slice's commit message); full screenshot sweep still renders correctly.
**Out of scope:** new styling work — this slice only removes and audits.

## Slice 11 — Final acceptance
**Goal:** Measured proof the redesign matches the reference without regressing performance or behavior.
**Depends on:** all
**Steps:**
1. Full gates: `pnpm typecheck`, `pnpm exec vitest run`, `cargo test -p videorc-backend`, eslint + `pnpm format:check` (all exit 0, captured directly).
2. `node scripts/perf-idle-probe.mjs` → `probe PASSED`, presents ≈60/s, CPU per process within 5 points of the documented pre-migration baseline; `node scripts/perf-memory-probe.mjs` → allocator growth not worse than its pre-migration run.
3. Screenshot sweep of every tab + palette + two dialogs, in BOTH themes; review the dark set side by side with the reference image and the light set against the skill's light column (tokens, row anatomy, footer bars, kbd chips).
4. Perceptual pass: watch the live preview while recording for a minute — smoothness judged by eye per the project rule.
**Done when:** every check above passes and the results (probe outputs + screenshot list) are pasted into the final commit message or a short `docs/ui-glass-redesign-acceptance.md`.
**Out of scope:** new features; any regression found becomes its own task.
