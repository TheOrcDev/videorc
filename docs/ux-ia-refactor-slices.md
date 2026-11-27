> Current page shortcuts follow visible sidebar rows (Q187); see
> [Page shortcut numbering](ui-copy.md#page-shortcut-numbering). Historical
> fixed page numbers below do not override that rule.

# UX/IA Refactor — Battle Order

Cut from docs/ux-ia-refactor-plan.md (grilled 2026-06-13). Execute in order;
every slice leaves the app green and committable. Gates used throughout:

- `pnpm typecheck && pnpm lint && pnpm --filter @videorc/desktop test`
- `node scripts/smoke-dev-app.mjs` (launch → connect → record; kill stale
  Electron/`target/debug/videorc-backend` instances first if it exits with
  code=0 immediately)
- Visual judge-by-eye: `VIDEORC_SMOKE_OUTPUT_DIR=/tmp node scripts/ui-theme-screens.mjs <tab …>`
  (both themes; smoothness/visuals are perceptual — look at the PNGs)

## Battle order — ALL DONE 2026-06-13

1. **Sidebar regroup, renames, shortcuts** — DONE (37ca186c)
2. **Bound the sources device diagnostics** — DONE (cd3ad686)
3. **Library absorbs Export-MP4; Output sheds artifacts** — DONE (b0c19801)
4. **Scene absorbs Screens; framing regroups** — DONE (f35bc9d2)
5. **Studio session strip replaces five accordions** — DONE (ce6f1e25)
6. **Live-only chat rail; last accordion dies** — DONE (e1ab8176)
7. **Destinations: rows + separated Broadcast info** — DONE (5c5467ee;
   note: smoke:oauth-guards fails identically pre/post — pre-existing
   X-account contamination in the smoke profile, flagged separately)
8. **Health: verdicts pinned, metrics grouped** — DONE (8f8a7f4e; four
   contiguous groups instead of five so no metric reordered; groups
   default closed, the always-open Verdicts panel carries the alarm role)

Slices 2 and 3 can land any time after their commit point; 7 and 8 any time
after Slice 1. The critical path is 1 → 4 → 5 → 6.

---

## Slice 1 — Sidebar regroup, renames, shortcuts

**Goal:** The sidebar shows Stage/SETUP/LIBRARY/SYSTEM with new labels,
Health appears in SYSTEM, and ⌘1–⌘9/⌘, navigate pages.
**Depends on:** none
**Touches:** `apps/desktop/src/renderer/src/components/workspace-nav.tsx`,
`sidebar.tsx`, `app-shell.tsx`, `command-palette.tsx`,
`onboarding-dialog.tsx` (recommended-tab labels only).
**Steps:**

1. `workspace-nav.tsx`: relabel STUDIO_PANELS (`Layouts→Scene`,
   `Live→Destinations`, `Recording→Output`) — ids and `legacyTabId`
   UNCHANGED. Add a `diagnostics` entry labeled `Health` to
   WORKSPACE_TABS with `group: 'system'` (pick a Phosphor icon, e.g.
   `Pulse`). Replace WORKSPACE_GROUPS with
   `stage` (unlabeled, studio) · `setup` (label SETUP, the four panels) ·
   `library` (label LIBRARY: library, ai) · `system` (label SYSTEM:
   settings, diagnostics). Keep the `StudioPanel` type and exports —
   other modules import them.
2. `sidebar.tsx`: render the four groups flat (no nested Studio block);
   right-align a `Kbd` chip per row (⌘1…⌘9 in the order of the plan's
   sidebar spec). Make the footer `StatusDot` a button that navigates to
   the `diagnostics` tab.
3. `app-shell.tsx`: extend the existing keydown handler
   (`app-shell.tsx:75-88` pattern) with ⌘1–⌘9 → tabs in sidebar order and
   ⌘, → settings.
4. `command-palette.tsx`: labels follow WORKSPACE_TABS/STUDIO_PANELS
   automatically if it maps them; hand-edit any hardcoded strings
   ("Open Live" → "Open Destinations", etc.).
   **Done when:** gates green; `node scripts/smoke-start-labels.mjs` (uses
   legacy ids) green; ui-theme-screens sweep of `studio` shows the new sidebar
   groups in both themes; pressing ⌘3 lands on Scene (verify via CDP eval of
   `document.querySelector('[aria-current="page"]')?.textContent` in the sweep
   session or by eye).
   **Out of scope:** any page-content change; the chips; renaming ids or files.

## Slice 2 — Bound the sources device diagnostics

**Goal:** The device-diagnostics block on Sources can never grow the page.
**Depends on:** none
**Touches:** `apps/desktop/src/renderer/src/components/tabs/sources-tab.tsx`
(diagnostics panel, ~lines 449-467).
**Steps:**

1. If `components/ui/collapsible.tsx` is missing, install it:
   `pnpm dlx shadcn@latest add collapsible` (per the shadcn skill).
2. Wrap the diagnostics list: `Collapsible` default-CLOSED; trigger row
   reads `Device diagnostics · <n>` with a monochrome problem-count
   `Badge` when any device has a non-available status.
3. Inside, wrap rows in `ScrollArea` with `max-h-72`.
   **Done when:** gates green; with the trigger expanded and 20+ devices the
   panel caps at ~18rem (verify by eye in the sweep screenshot of `sources`);
   collapsed by default on fresh load.
   **Out of scope:** changing DiagnosticRow content; moving the panel to
   Health; the device warnings Alert (stays).

## Slice 3 — Library absorbs Export-MP4; Output sheds artifacts

**Goal:** Library is the single home of session artifacts; the Output page
is settings-only.
**Depends on:** none (label copy assumes Slice 1 landed; harmless either way)
**Touches:** `library-tab.tsx`, `recording-tab.tsx`, the export handler
wiring in `hooks/use-studio.tsx` (re-use, don't duplicate).
**Steps:**

1. Find the Export-MP4 handler used by `recording-tab.tsx`'s
   `OutputSessionRow` (grep `exportMp4|Export MP4`) and expose the same
   callback to Library rows.
2. `library-tab.tsx`: collapse Check-quality/Repair/Restore/Export-MP4
   into one right-aligned `DropdownMenu` per session row (`Open in AI`
   stays as the visible primary action). Export-MP4 enabled under the
   same conditions as today (completed + MKV + no MP4 yet).
3. `recording-tab.tsx`: delete the Recording Artifacts panel and its
   `OutputSessionRow`; update page copy to "Output".
   **Done when:** gates green; `grep -rn "Export MP4" apps/desktop/src` hits
   library-tab only; recording-tab renders only the settings panel in the
   sweep; exporting from a Library row still works (record via
   `smoke-dev-app`, then export through the UI or verify the handler is the
   same function reference).
   **Out of scope:** repair logic, session row data, Output settings
   controls.

## Slice 4 — Scene absorbs Screens; framing regroups

**Goal:** One Scene page owns presets, transforms, framing, AND Screens;
the stacked double-page render dies.
**Depends on:** Slice 1 (label "Scene")
**Touches:** `app-shell.tsx` (~lines 135-140), `layout-tab.tsx`,
`screens-tab.tsx`.
**Steps:**

1. `app-shell.tsx`: when `active === 'layouts'` render `LayoutTab` only.
2. Mount the Screens grid (the `PanelSection` + `ScreenTile` content of
   `screens-tab.tsx`) as a titled section at the bottom of
   `layout-tab.tsx`, keeping its session-locked upload behavior. Either
   export a `ScreensSection` from screens-tab or move the component —
   do not duplicate it.
3. Regroup the right-column framing controls into two labeled clusters:
   "Placement" (corner, size, shape, margin) and "Lens" (fit, mirror,
   zoom, pan). Pure re-ordering inside the existing panel — no control
   behavior changes.
   **Done when:** gates green; `node scripts/smoke-screens-app.mjs` green;
   sweep of `layouts` shows Screens as a section and the two framing
   clusters; no route renders two stacked pages.
   **Out of scope:** Studio's screens accordion (Slice 5 removes it); preset
   logic; transform math.

## Slice 5 — Studio session strip replaces five accordions

**Goal:** Studio = preview + transport + one chip strip; the source,
scene, screens, mixer, and output accordions are gone (chat stays for
Slice 6).
**Depends on:** Slices 1–4 (every chip needs its home page final)
**Touches:** new `components/session-strip.tsx`; `tabs/studio-tab.tsx`;
nav via `useWorkspaceNav()`.
**Steps:**

1. Build `SessionStrip` per the plan's chip table: Source · Mic (name +
   mute toggle — NO live meter, it's on-demand only) · Layout (popover
   with the four presets, live-safe switch via the existing handler) ·
   Takeover (hidden when no Screens exist; popover lists screens +
   Normal, using the existing activate handler) · Destinations (re-home
   today's chips) · Output (one-line summary). Chips follow the
   design-language row anatomy in miniature; clicking a chip navigates
   to its owning page.
2. Remove the five AccordionItems and their imports from studio-tab;
   keep the transport bar (minus the embedded 4-preset grid — the
   Layout chip popover replaces it) and the Go Live dialog untouched.
3. The output-status accordion's six summary rows are deleted here;
   their pipeline badges (Socket/FFmpeg/Stream) move into the Output
   chip's secondary text or are dropped (Health owns detail) — keep the
   chip to one line.
   **Done when:** gates green; `node scripts/smoke-start-labels.mjs` and
   `node scripts/smoke-dev-app.mjs` green; `grep -c AccordionItem
apps/desktop/src/renderer/src/components/tabs/studio-tab.tsx` returns 1
   (chat only); sweep of `studio` shows preview + transport + strip in both
   themes with no accordion stack.
   **Out of scope:** chat (Slice 6); any change to Sources/Scene/Output
   pages; preview/transport behavior.

## Slice 6 — Live-only chat rail; last accordion dies

**Goal:** Chat is a collapsible right rail that exists only while live;
Studio has zero accordions.
**Depends on:** Slice 5
**Touches:** `tabs/studio-tab.tsx`, new `components/live-chat-rail.tsx`
(hosts the existing `LiveChatPanel`), `app-shell.tsx` (⌘J).
**Steps:**

1. Rail renders only when the session is active AND a chat-capable
   destination is enabled (same condition that gates today's chat
   accordion); hosts `LiveChatPanel` unchanged (snapshot +
   onClearLocal).
2. Auto-open on go-live when the condition holds; ⌘J toggles; state
   does not persist across sessions.
3. Delete the chat AccordionItem and the Accordion import from
   studio-tab.
   **Done when:** gates green; `node scripts/smoke-live-chat-fake-providers.mjs`
   green; `grep -c Accordion apps/desktop/src/renderer/src/components/tabs/studio-tab.tsx`
   returns 0; off-air sweep of `studio` shows no chat surface.
   **Out of scope:** chat features, unread badges, detached-window chat.

## Slice 7 — Destinations: rows + separated Broadcast info

**Goal:** Destination targets render as design-language rows whose detail
holds auth+credentials only; broadcast metadata is its own section.
**Depends on:** Slice 1 (label)
**Touches:** `tabs/streaming-tab.tsx` (1,438 lines — presentation
restructure, NOT a logic rewrite).
**Steps:**

1. Replace each DestinationCard header with a shared row (24px platform
   tile, label, account secondary text, status badge, enable Switch);
   the existing card body (auth toggle, OAuth block, manual RTMP block,
   key-save dialog) becomes the row's expand/collapse detail,
   UNCHANGED internally.
2. Move the Broadcast Metadata Editor panel out of the column flow into
   its own titled section ("Broadcast info") below the destination
   list; per-platform overrides keep their current components.
3. Readiness checklist stays in the right column.
   **Done when:** gates green; `node scripts/smoke-oauth-app.mjs`,
   `node scripts/smoke-oauth-guards-app.mjs`,
   `node scripts/smoke-streaming-secrets.mjs`, and
   `node scripts/smoke-provider-readiness.mjs` all green; sweep of
   `streaming` shows rows + separate Broadcast info.
   **Out of scope:** OAuth flows, key storage, metadata validation logic,
   Go Live dialog.

## Slice 8 — Health: verdicts pinned, metrics grouped

**Goal:** Health leads with verdicts; the 50+ metrics live in grouped
collapsibles instead of one flat grid.
**Depends on:** Slice 1 (sidebar entry exists)
**Touches:** `tabs/diagnostics-tab.tsx`.
**Steps:**

1. Pin the existing summary badges (likely bottleneck, health badges,
   quality warning) at the top as a "Verdicts" block.
2. Group `DiagnosticMetric`s into collapsible sections — Pipeline ·
   Preview · Sources · Encoder · System — default closed EXCEPT
   Verdicts and any section containing a currently-unhealthy metric.
3. Logs panels unchanged (already bounded).
   **Done when:** gates green; sweep of `diagnostics` shows verdicts on top
   and closed sections; every metric still reachable by expanding (count
   audit: number of DiagnosticMetric instances unchanged before/after —
   `grep -c "DiagnosticMetric" diagnostics-tab.tsx` identical).
   **Out of scope:** metric definitions, the warnings/logs panels, backend
   diagnostics payloads.
