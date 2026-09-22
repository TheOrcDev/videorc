# Plan 044: Save visual scenes and improve everyday Studio controls

> Executor: implement the slices below in order, checking each slice before
> continuing. Execution was authorized on 2026-09-22; verification is recorded below.
> Preserve user changes and update this plan's slice statuses and its index row
> as work actually passes verification. Do not merge, push, or publish a release
> without the operator's instruction.

## Status and implementation baseline

- Status: BLOCKED for final acceptance — all five slices implemented; draft PR prepared; native stress, fixed asset budget and manual platform acceptance remain outstanding.
- Priority: P1. Overall effort: L across five bounded slices; overall risk: MED.
- Category: product usability, persistence, scene transaction correctness.
- Planned: 2026-09-22.
- Plan-storage checkout: `/Users/orcdev/projects/videorc`, HEAD `15206746`.
- Implementation investigated: `/Users/orcdev/projects/videorc-wt-studio-fixes`,
  HEAD `ebcd29da`, including Scene editor PR #378 / commit `de4c9fc9`.
- Prerequisite: implement against a branch containing PR #378 or its equivalent.
  The plan-storage checkout has an older editor. Do not copy that editor over the
  newer implementation, or merge unrelated Windows waiver changes just to get it.
- Plans 042 and 043 are adjacent work, not blanket prerequisites. Coordinate shared
  `use-studio.tsx` changes and preserve 042's scene animation and 043's Freeform
  geometry/commit semantics. This plan does not fix either of those reports.

Start in the implementation checkout:

```sh
git status --short
git merge-base --is-ancestor de4c9fc9 HEAD
git diff --stat ebcd29da..HEAD -- apps/desktop/src/renderer/src apps/desktop/src/shared apps/desktop/src/main/index.ts apps/desktop/src/preload/index.ts crates/videorc-backend/src/live_layout.rs
```

The ancestry check must succeed, or equivalent editor code must be established
explicitly. Review any drift against the symbols and excerpts below before editing.
Do not discard existing local modifications. Read that checkout's `AGENTS.md`.

Execution reconciliation (2026-09-22): isolated branch
`feat/scene-presets-studio-usability` in
`/Users/orcdev/projects/videorc-wt-scene-presets`, based on `origin/main`
`7b093ce9a`. The planned source-path diff from `ebcd29da` is empty.
Use `pnpm --filter @videorc/desktop exec vitest run <paths>` for focused tests;
the package-manager `test --` forwarding does not reliably filter this setup.
The existing Vitest configuration collects `.test.ts`; component tests should
follow the provider harness with `createElement`, or explicitly extend collection.

## Why this matters

The requested improvements form a coherent workflow: find a capture source quickly,
frame each layout independently, save the complete visual setup, and switch layouts
without leaving a presentation. Background removal must do what its label says.
Search and removal are small changes. Saved scenes require more care because the
current application has one working visual configuration and asynchronous backend
scene commits, rather than a library of named scenes.

## Product decisions

Confirmed by the owner:

1. Saved scene presets restore the **full visual setup**: layout, framing,
   camera/screen selection, and background.
2. Layout switching gets **configurable OS-global shortcuts**, usable while
   presenting in another application.

The following are the proposed implementation defaults, chosen to keep scope clear:

- A **layout** is a built-in arrangement such as Screen + Cam or Camera.
  A **saved scene** is a named visual snapshot. Keep built-in layouts and saved
  scenes visibly separate within the existing Scenes surface.
- Saved scenes include all normalized `LayoutSettings`, including Freeform source
  transforms, camera crop/zoom/pan, shape/mirror/keying, split and vertical framing;
  visual source references; and an independent background/style snapshot.
- Do not save microphone selection, audio processing, captions, transient chat
  highlights/takeovers, output resolution/fps/bitrate, stream destinations, secrets,
  or recording/streaming enabled state. Orientation comes from the layout and uses
  the existing off-air canvas coupling; it is not a new output-profile preset.
- Scene snapshots are explicit: **Save scene**, **Update saved scene**, **Save as
  new scene**, **Rename**, and **Delete**. Editing an applied scene changes the
  working setup and shows “Modified”; it does not silently overwrite the snapshot.
- Save/update only the confirmed working visual state. Disable these actions while
  a scene transaction or editor gesture is unresolved. No live camera screenshots
  are stored; use the existing schematic thumbnail language.
- Built-in layouts remember camera zoom and pan (`cameraZoom`, `cameraOffsetX`,
  `cameraOffsetY`) independently. This is digital framing and needs no special
  camera hardware. Other per-layout appearance memory is outside this request;
  named snapshots already preserve the full layout.
- Background **Remove** empties that library slot persistently, for both bundled
  and imported images. “Use no background” remains a separate working-scene action.
  Keep the existing ten slots; do not turn this into an unlimited asset-library
  rewrite. Empty slots accept imports and offer explicit **Restore default**.
- Removing a library background does not delete its managed file or alter saved
  scene snapshots. If it is currently applied, clear the working background through
  the confirmed scene path. Saved scenes retain their own copy/reference and style.
- Source search applies to the Screen / window dropdown. Camera and microphone
  selectors retain their current compact behavior.
- Global bindings start unassigned, matching current Settings behavior. Offer next
  layout, previous layout, and direct bindings to every built-in layout. Next/previous
  wrap within the current orientation and skip layouts with missing required sources.
  Direct bindings use stable layout IDs, never gallery indexes. Saved-scene global
  bindings and external remote-protocol scene libraries are deferred.

## Current state and evidence

Paths below are relative to the implementation checkout at `ebcd29da`.

| File / symbol | Verified behavior and consequence |
| --- | --- |
| `apps/desktop/src/renderer/src/components/studio/scenes-gallery.tsx:19` | Explicitly says no saved scenes exist. Cards call `applyCameraPreset({ layoutPreset })`; the gallery is orientation-scoped. Its eager bundle size is constrained. |
| `apps/desktop/src/renderer/src/lib/capture.ts`, `CaptureConfig`, `loadCaptureConfig`, `persistableCaptureConfig`, `normalizeLayout` | One persisted layout with one zoom/pan set. Existing memory only remembers the last layout ID per orientation. Normalization already clamps zoom and pan. |
| `apps/desktop/src/renderer/src/hooks/use-studio.tsx:7464`, `requestCameraPresetTransaction` | Starts with current layout, merges the patch, and exits Freeform when a built-in layout is chosen. Zoom carries across layouts. |
| Same file: `requestLayoutTransaction:7183`, `applyLayoutTransactionState:7053`, `readLayoutTransactionBackendTruth` | Existing authoritative, latest-intent transaction machinery handles preview/live apply and presentation proof. Sources and background are currently read from global working state, not an explicit full-scene target. |
| Same file: `liveBackgroundFingerprintRef`, `activeSceneBackground`, `sceneWithBackground` | Background has a separate registry-driven apply effect and is overlaid onto scene state. A named scene must not trigger a second old-layout commit or have its committed background overwritten by that overlay. |
| `apps/desktop/src/renderer/src/lib/background-assets.ts:397`, `removeSlotAsset` | “Remove” replaces the current asset with the built-in image. `reconcileRegistry:555` and `applyBundledBackgroundAssets:250` also repopulate empty slots. |
| `apps/desktop/src/renderer/src/components/tabs/assets-tab.tsx:336` | The destructive menu label is already “Remove”, making current restore behavior misleading. |
| `apps/desktop/src/renderer/src/components/source-select.tsx` | Uses shadcn Select with every device rendered; no search. Preserves missing selection, availability, None, discovery and disabled states. |
| `apps/desktop/src/renderer/src/components/tabs/sources-tab.tsx:306` | Screen / window uses the shared SourceSelect. Device metadata includes name, kind, optional detail, dimensions and status. |
| `apps/desktop/src/renderer/src/lib/global-shortcuts.ts`, main `index.ts:470` | Existing configurable OS-global registration and dispatch supports record, stream and mic only. |
| `apps/desktop/src/shared/electron-ipc-contract.ts:1087` | Runtime event validation has an explicit shortcut-action enum. Updating only a TypeScript union would drop new actions at runtime. |
| `apps/desktop/src/renderer/src/lib/remote-surface.ts:266`, hook `handleRemoteIntent` | Remote scene switching already delegates to `requestCameraPresetTransaction`. Preserve this common route and its backend-confirmed receipt. |

Drift anchors, copied from inspected source:

```ts
// requestCameraPresetTransaction
const arrangementPatch =
  patch.layoutPreset !== undefined && patch.arrangementMode === undefined
    ? { arrangementMode: 'preset' as const, sourceTransformOverrides: {} }
    : {}
// requestLayoutTransaction payload
sources: requestedSources,
layout,
video: options?.videoOverride ?? requestedConfig.video,
background: activeSceneBackground,
```

```ts
// removeSlotAsset
entry.id === slotId ? { ...entry, assetId: builtinAsset.id, status: 'ready' } : entry
// Current persistence restores empty entries from code defaults:
const assetId = typeof stored === 'string' && assets[stored] ? stored : slot.assetId
```

Follow the pure-helper + Vitest pattern in `lib/background-assets.test.ts` and
`lib/source-select-state.test.ts`. For asynchronous commits, extend the real
StudioProvider harness in `hooks/studio-provider.integration.test.ts`; it already
has deferred backend responses. Do not replace behavior coverage with source-text
assertions or arbitrary sleeps.

## Architecture and invariants

### Separate saved data from working state

Add `lib/scene-presets.ts` for pure schema, normalization, snapshot comparison,
source preflight and library operations; add a small persistence/provider module
under `hooks/` using the existing localStorage provider convention. Suggested shape:

```ts
type SavedScene = {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  visual: {
    layout: LayoutSettings
    sources: VisualSourceSelection // explicit camera + screen/window fields only
    background: SavedSceneBackground | null
  }
}
type ScenePresetLibrary = { version: 1; scenes: SavedScene[] }
type CameraFraming = Pick<LayoutSettings, 'cameraZoom' | 'cameraOffsetX' | 'cameraOffsetY'>
```

Use an explicit visual-source allowlist, not `Omit` or a spread of CaptureConfig.
Deep-copy transform maps and styles. Generate stable IDs independently of names.
Names trim to 1–80 characters; reject case-insensitive duplicates with inline
validation. Keep stable creation order, no scene-count cap in this slice. Reject
malformed entries individually; unknown future schema versions must be preserved
without overwriting them, with a visible recovery message. A failed storage write
must report failure and must not claim the scene was saved.

`SavedSceneBackground` stores a stable bundled asset ID or an imported managed-asset
descriptor plus an independent normalized style, never just `bg-01` or another
mutable slot ID. Resolve bundled assets to current-build paths after hydration;
do not persist a hashed Vite URL as permanent identity. Replacing/removing a library
slot must not change saved scene A. Imported files already live in app-managed
storage; retain them in this feature. Physical file garbage collection is deferred.
Only existing trusted managed-asset resolution may turn descriptors into paths.

Add versioned framing memory to capture persistence, keyed by all ten canonical
layout IDs. On migration, preserve the current layout's existing zoom/pan and
initialize other layouts at default framing. Clamp invalid values using existing
ranges. A committed built-in layout edit updates only that layout's memory. A
rejected/superseded intent cannot write target memory. Applying/editing a named
scene uses its working snapshot and must not overwrite the built-in memories;
returning to a built-in layout restores that layout's last independent framing.
Carry the edit origin in transaction metadata, not by guessing from layout equality.

### One authoritative visual apply

Extend the existing transaction target/options to carry sources and background
explicitly, including an explicit null background. Do not apply a scene by calling
source switch, layout switch and background selection sequentially. Resolve and
preflight the complete target, then send one existing `scene.layout.apply_preview`
or `scene.layout.apply_live` request. Preserve transition settings, protected-window
filtering, latest-intent rules, scene revision proofs and simulcast derivation.

Expand `LayoutTransactionSnapshot` / reconciliation metadata to retain the entire
committed visual target and origin. Update working source controls, layout, background
and named-scene identity at the existing authoritative reconciliation edge. Backend
commit followed by presentation timeout still means committed: show the established
warning and retain the actual backend state. Do not treat the early boolean commit
receipt as proof that React state and native presentation are already reconciled.

The background provider must distinguish library membership/default styles from
the current working selection/snapshot. Preserve legacy `activeSlotId` migration.
All Assets apply/clear/style/remove actions and saved-scene applies use the same
working-background contract; change the registry-triggered live effect and scene
overlay accordingly so one accepted visual change causes one scene transaction.
Persist a committed working visual checkpoint (sources/layout/background and scene
identity together) in one versioned envelope; hydrate it over the legacy visual
fields after validation. Existing capture persistence continues to own nonvisual
settings and framing memory. Do not create two competing working-visual authorities.
Persist no pending target, and never reapply a saved snapshot merely because its
ID is stored: a modified working scene must reopen as modified.

On lost responses/reconnect, compare backend source identities, layout, background
and revision against pending targets. Recover matched committed state; otherwise
show backend truth as an unsaved working scene. Do not attach an unrelated named
scene label or persist an uncommitted target. A crash before a completed persistence
write restores the last persisted checkpoint, not a partially updated visual setup.

### Missing devices and background files

- A saved source is an explicit choice. Never use
  `reconcileSourceSelectionForLayoutTransaction` to silently replace a saved window
  with the first available screen. Add a strict-source option for saved targets;
  preserve existing unrelated callers' policy.
- Resolve required sources against refreshed discovery, with exact available device
  identity/kind and permission status. Names/details are hints, not unique identity.
  Closed windows and rotated IDs require user reassignment through searchable pickers.
- Preflight only sources actually used by the chosen layout/Freeform composition;
  keep dormant visual selections in the snapshot without requiring unused hardware.
  Recheck at dispatch and preserve backend readiness checks for discovery races.
- Missing required source: refuse the whole apply and offer **Resolve sources**.
  Keep the current scene running. Never open that dialog automatically from a global
  shortcut; give a concise failure message instead.
- Missing background: retain the current scene and offer explicit **Apply without
  background** or repair. No silent substitution with a bundled image. Choosing
  without background changes the working copy only until Update is requested.
- While recording/streaming, allow same-orientation scene changes; reject cross-
  orientation requests with the existing stop-first explanation. Never stop/restart
  recording implicitly or mutate resolution/fps as part of a live scene switch.

## Ordered execution slices

### S1 — Searchable screen/window selection

Status IMPLEMENTED; automated feature verification passed; see final acceptance ledger. Effort S. Risk LOW. Independent of S2–S5.

1. Add an opt-in `searchable` mode to `components/source-select.tsx`, enabled only
   for Screen / window in `tabs/sources-tab.tsx`. Compose installed shadcn Popover
   and Command, keeping the same controlled ID/onChange interface.
2. Search name + kind + existing detail (app/window context where available),
   case-insensitively with trimmed multiword matching. Do not search transient IDs
   as user text. Keep IDs as unique item values so duplicate names remain selectable.
   Group screens/windows without changing discovery's order within groups.
3. Preserve the chosen label while filtering; searching or dismissing never changes
   selection. Show distinct discovery pending, no discovered sources, no matches,
   missing saved selection and disabled/permission-required states. None remains
   available independently of the query when allowed. Clear the query on close.
4. Autofocus search on open; support arrows, Enter, Escape and trigger focus return.
   Associate the field label, accessible combobox state and popup; no hand-built
   keyboard/listbox engine. Do not disable the whole popup just because devices are
   still being discovered. Handle device updates while open without selecting a row.
5. Extend `source-select-state.ts` with testable matching/state helpers and add
   component interaction coverage patterned on the provider DOM harness. Cover
   duplicate names, accents/non-Latin text preservation, unavailable choices, None,
   closing with Escape, refresh/removal during search and a list of 500 fixtures.
   Add virtualization only if measured interaction is slow; avoid a new dependency.

Verify: `pnpm --filter @videorc/desktop exec vitest run src/renderer/src/lib/source-select-state.test.ts src/renderer/src/components/source-select.test.ts`
→ all pass. Then `pnpm typecheck` → exit 0. Real-app check: selecting a filtered
window uses its correct ID; dismissing does not switch capture.

### S2 — Make background removal permanent

Status IMPLEMENTED; automated feature verification passed; see final acceptance ledger. Effort S–M. Risk MED. Independent of S1; precedes S4.

1. Version the background registry and record intentional empty slots explicitly.
   Legacy registries retain their current bundled/default behavior during migration;
   newly cleared slots remain empty through reconcile, bundled-path hydration and
   subsequent app launches. Invalid records must not be mistaken for user deletion.
2. Make Remove clear the slot and active selection when relevant. Restore default
   is an explicit separate helper/action and never overwrites an imported image
   unexpectedly. Imports into empty slots keep the existing import flow working.
3. Use a confirmation for removing the applied background, explaining its visible
   effect during a running session. Keep unrelated backgrounds and styles untouched.
   Preserve managed files; add no filesystem deletion API. Ensure the menu is usable
   on keyboard focus as well as hover. Empty tiles show Add image and Restore default.
4. Unit-test built-in/imported removal, active/inactive removal, remove→serialize→
   reconcile→bundled hydration, restore, replacement/import, malformed legacy data,
   and late async file-check results after removal. Update tests that currently
   assert removal restores the bundled preset.
5. Extend provider coverage for clearing an applied background during a live session.
   When S4 introduces working snapshots, migrate this path to its coordinated apply
   contract and retain these tests; do not leave two implementations.

Verify: `pnpm --filter @videorc/desktop exec vitest run src/renderer/src/lib/background-assets.test.ts src/renderer/src/hooks/studio-provider.integration.test.ts`
→ all pass. `pnpm typecheck` → exit 0. Real-app acceptance: remove built-in and
imported items, restart, and import into each empty slot; no image reappears.

### S3 — Preserve zoom and pan per built-in layout

Status IMPLEMENTED; automated feature verification passed; see final acceptance ledger. Effort M. Risk MED. Precedes S4 and S5.

1. Add pure framing-memory normalization/migration and a resolver, preferably in
   `lib/layout-framing-memory.ts`, wired through CaptureConfig persistence.
2. In `requestCameraPresetTransaction`, use remembered target framing only for an
   actual layout-ID change; same-layout edits must retain their explicit patch.
   Explicit fields override recalled values. Preserve the existing Freeform exit
   semantics and off-air orientation/canvas coupling.
3. Update memory from committed state, including authoritative recovery after a
   lost response. Carry enough origin/previous-state information to avoid treating
   background-only updates or stale requests as new layout edits. Never optimistically
   store a target zoom before the backend accepts it.
4. Prove 150% Screen + Cam → 100% Camera → Screen + Cam restores 150%; include
   independent pan, every vertical layout, restart, default migration, malformed
   storage, same-layout edits, rejection, late success, rapid A→B→A and proof timeout.
   Existing remote switches must recall the same framing because they share the route.

Verify: `pnpm --filter @videorc/desktop exec vitest run src/renderer/src/lib/layout-framing-memory.test.ts src/renderer/src/lib/capture.test.ts src/renderer/src/hooks/studio-provider.integration.test.ts`
→ all pass, followed by `pnpm typecheck` → exit 0. Run
`pnpm smoke:preview-scene-commit` → committed scenes and native preview remain live.

### S4 — Save and apply complete visual scene presets

Status IMPLEMENTED; automated feature verification passed; see final acceptance ledger. Effort L. Risk MED–HIGH. Requires S2 and S3; uses S1 for source repair.

Deliver in four reviewable substeps, keeping UI entry points disabled until the
corresponding production apply path is complete:

1. **Data and persistence.** Implement the schema/library helpers, immutable snapshots,
   migration and working checkpoint described above. Use existing localStorage and
   managed-background APIs, not a new Rust database or sync service. Test round trips,
   invalid entries/future versions, duplicate names/IDs, nested deep copies, write
   failures and secret/audio/output exclusion. Verify with
   `pnpm --filter @videorc/desktop exec vitest run src/renderer/src/lib/scene-presets.test.ts`
   → all pass, then `pnpm typecheck` → exit 0.
2. **Coordinated application.** Extend request/snapshot/recovery metadata for strict
   visual targets and background overrides. Migrate working-background consumers,
   including preview/start-session params and the live background effect. Saved
   Freeform scenes must bypass the built-in picker function that clears transforms.
   Keep all used source changes within the same backend scene request. Verify with
   `pnpm --filter @videorc/desktop exec vitest run src/renderer/src/hooks/studio-provider.integration.test.ts src/renderer/src/lib/layout-transaction-policy.test.ts`
   → all pass, plus `pnpm smoke:preview-scene-commit` → exit 0.
3. **Library UI.** Add a Saved scenes section beside the built-in layout vocabulary
   in `scenes-gallery.tsx` and Save scene in the Scene editor toolbar. Use a lazy
   shadcn Dialog for name/save/update/repair and KebabMenu for actions. Selecting a
   saved card applies its snapshot. Show pending target by saved ID (two scenes can
   share a layout), committed checkmark, Modified state and unavailable requirements.
   Save as new generates a fresh ID. Update replaces only that saved snapshot after
   an explicit action. Delete confirms removal of the snapshot but leaves the working
   scene and recording unchanged; clear its active library identity. Add saved scenes
   to the existing command palette. Verify with
   `pnpm --filter @videorc/desktop exec vitest run src/renderer/src/components/scene-presets.test.ts src/renderer/src/hooks/studio-provider.integration.test.ts`
   → all pass, `pnpm typecheck` → exit 0, and after a build
   `pnpm check:renderer-assets` → no eager bundle regression.
4. **Integration edge cases.** Add deterministic deferred-response tests and a
   maintained scene-presets app smoke using the repository's app launcher/analyzer
   patterns. If a new smoke is needed, name it `scripts/smoke-scene-presets-app.mjs`
   with a `smoke:scene-presets` package script. It must exercise actual provider
   actions, not a parallel test-only apply implementation. Seed identifiable fixture
   sources, apply two same-layout scenes with different sources/zoom/background,
   save/reload, record switches, and inspect final pixels/source identity as well as
   ffprobe metadata. Verify `pnpm smoke:scene-presets` → exit 0 with artifact analysis.

Required S4 regression cases:

- Save A, alter every visual field, save B, apply A: exact normalized snapshot.
- A/B use the same layout ID but different camera/source/background; card identity
  and pending state remain correct.
- Freeform source transforms, camera framing and vertical screen fit survive save,
  apply and restart. Saved-scene editing cannot contaminate built-in framing memory.
- Changing a background library style/replacing/removing its slot leaves saved A
  reproducible. Removing the currently applied item modifies the working copy only.
- Active scene modified → restart preserves the modified working scene, not the
  original snapshot. Delete active saved entry → current picture continues.
- Missing camera/window/background, lost permission and discovery refresh races:
  whole apply is refused before commit or backend refusal is reconciled, without
  silently choosing another device or persisting partial changes.
- Saved source requirements are layout-aware; unused camera need not be connected
  for Screen-only. Keep the current microphone and all output/stream settings.
- A→B→A overlaps, backend rejection, accepted-but-response-lost, native proof timeout,
  reconnect, and async bundled-path hydration cannot commit an old background or
  falsely label the active scene. Exactly one scene request per user apply.
- Same-orientation apply while recording preserves the session; cross-orientation
  request is refused. Existing simulcast following behavior remains intact.

### S5 — Configurable global layout shortcuts

Status IMPLEMENTED; automated feature verification passed; see final acceptance ledger. Effort M. Risk MED. Requires S3; may land before S4 if desired.

1. Define shared stable action IDs for next/previous and direct built-in layout
   selection. Extend `GlobalShortcutsConfig`, SettingsState, renderer action/context,
   main registration, Electron IPC runtime event validation and any preload typings
   together. Prefer a typed layout-binding map over ten unrelated string literals;
   validate unknown layout IDs and malformed actions at the boundary.
2. Add bindings under Settings → Global shortcuts, grouped by orientation. Render
   configured hints beside built-in layout choices and in the shortcut reference.
   Empty fields release keys. Report invalid/duplicate/OS-conflicting bindings per
   action without removing other valid actions. Preserve existing session bindings.
   Reuse platform accelerator display helpers; do not reuse ⌘1–⌘9 navigation keys.
3. Dispatch through `requestCameraPresetTransaction`, with source/orientation
   availability checks shared by cards, palette and shortcuts. Unknown actions must
   never fall through to microphone toggle. Global activation must not focus/raise
   Videorc. Do not install a second renderer listener for the same global binding.
4. Next/previous select from the canonical current-orientation list. If a saved or
   Freeform scene is active, start from its underlying layout ID and enter the
   selected built-in arrangement. If no other eligible layout exists, no-op with
   bounded feedback. Ignore repeated same-target actions while pending; coalesce
   key-repeat bursts with the existing latest-intent machinery. Do not queue a long
   series of delayed switches. Use the latest requested index for deliberate rapid
   next/previous, resetting it to confirmed state on rejection.
5. Test registration/unregistration, restart hydration, duplicate/conflicting keys,
   complete IPC action coverage, unknown payload refusal, unavailable sources,
   orientation lock, wraparound, repeat bursts, aux-window focus, background-app
   operation and quit cleanup. Existing remote layout intents retain their route;
   do not extend LAN routes, LAN_EVENTS, Stream Deck or remote saved-scene protocol.

Verify: `pnpm --filter @videorc/desktop exec vitest run src/renderer/src/lib/shortcuts.test.ts src/renderer/src/lib/global-shortcuts.test.ts src/main/global-shortcut-lifecycle.test.ts src/shared/electron-ipc-contract.test.ts src/renderer/src/hooks/studio-provider.integration.test.ts`
→ all pass. `pnpm smoke:remote-control` → allowlist, round-trip, debounce and revoke
checks pass. Real macOS/Windows acceptance must register actual OS shortcuts, switch
while a presentation app has focus, and show the corresponding confirmed output.

## UI and scope boundaries

Apply `.agents/skills/videorc-design/SKILL.md` and the shadcn skill in the execution
checkout. Existing UI is Radix shadcn, React, Tailwind, Phosphor and `@/` aliases.
Use installed Command, Popover, Dialog, Button, Field, Input, Kbd, Tooltip and shared
menus. Read component docs with the project's shadcn CLI before implementation.
Keep dark/light themes, compact spacing, labeled icon actions and focus visibility.
Lazy-load library dialogs so ScenesGallery does not exceed its eager asset budget.

Source changes in scope:

- Renderer `lib/{capture,background-assets,source-select-state,shortcuts,global-shortcuts,
  layout-transaction-policy}.ts`, new `{scene-presets,layout-framing-memory}.ts and tests.
- Renderer `hooks/{use-studio,use-background-assets}.tsx`, new scene-presets provider
  and tests; provider wiring in the existing renderer root as needed.
- Renderer `components/{source-select,command-palette}.tsx`,
  `components/studio/scenes-gallery.tsx`, `components/tabs/{sources,assets,layout,settings}-tab.tsx`,
  new focused scene-preset dialogs/controls and their tests.
- Shared `backend.ts`, `electron-ipc-contract.ts`, their relevant contract tests;
  main `index.ts`, shortcut registration helper/tests, preload shortcut bindings.
- Focused maintained smoke script/helpers, `package.json` script entry, acceptance
  checklist documentation and this plan/index status.

Existing backend live-layout/source transactions should be reused unchanged. If
testing proves they cannot apply the full visual target atomically or cannot expose
enough truth for recovery, report that precise gap and revise this plan before adding
a new protocol. No native presenter, compositor/encoder, recording lifecycle, audio,
LAN protocol, credential store, billing, cloud sync, scene export/import, asset file
deletion, library reordering or unrelated styling work is included.

No commit is required by this planning request. During execution, keep one logical
slice per reviewable change; if commits are requested, match existing `feat(...)` /
`fix(...)` history and run the applicable shadscan pre-commit skill. Stage only the
files intentionally changed for that slice.

## Verification and completion gates

Commands above are run from the implementation repo root; new test paths are
deliverables and must exist before their commands can pass. Use the smallest slice
gate first. Expected result for every required command is exit 0 with all targeted
cases passing; a filtered test run with no matching tests is not evidence.

Before handing off the completed feature set:

```sh
pnpm typecheck
pnpm lint
pnpm format:check
pnpm --filter @videorc/desktop test
pnpm test:scripts
pnpm build
pnpm check:renderer-assets
pnpm smoke:scene-presets
pnpm smoke:preview-scene-commit
pnpm smoke:remote-control
pnpm smoke:recording-studio
```

The full recording-studio gate is mandatory because this touches capture selection
and layout/background composition. Keep its maintained layout/source liveness,
backend scene commits, main pump, click/focus, detached lifecycle/reattach, imported
and real screen capture checks, final artifact analyzer and A/V checks enabled.
Run `pnpm smoke:recording-studio:devices` on the permissioned macOS host. If device
permissions block it, record the exact block and run the closest focused native
scene/layout smoke; do not claim complete device acceptance from TypeScript tests.

If implementation reaches beyond the intended scope, obey AGENTS.md: Rust changes
require `cargo fmt --check --all`, `cargo test -p videorc-backend` and
`cargo clippy -p videorc-backend -- -D warnings`; session lifecycle changes require
`pnpm smoke:record-latency`; encoding/fps changes require `pnpm smoke:recording-matrix`;
preview lifecycle/placement changes require `pnpm probe:preview-lifecycle` and,
for placement, `pnpm probe:preview-window`. Avoid these scope expansions rather than
quietly absorbing them. LAN changes require a separate approved plan and its gates.

Manual acceptance is additional to automated gates:

- Both themes: save/rename/update/delete/repair scenes without clipped controls;
  keyboard-only operation and query focus return work.
- Screen + Cam and Camera retain demonstrably different zoom/pan after cycling
  and restart; all portrait alternatives also retain independent memory.
- Background removal persists across restart; explicit restoration works.
- Two saved scenes restore different visual sources/backgrounds while audio and
  session output remain unchanged; test idle preview and an actual recording.
- Global shortcuts work from another app on macOS and Windows, never steal focus,
  and explain registration conflicts and refused switches.
- Record with scene animation on and off; preserve both settings and inspect final
  artifacts. Retain platform presenter truth: CAMetalLayer on macOS, the documented
  BMP Electron proof surface on Windows, no silent JPEG/PNG transport substitution.

Done means all five behaviors, their migration/negative-path tests and applicable
smokes pass; gates and any genuine platform blocks are recorded; no unrelated files,
tokens, recordings or generated evidence are staged; and plan/index statuses reflect
actual completion. Execution results and outstanding acceptance checks are recorded below.

## STOP conditions and maintenance notes

- Stop and report if the implementation checkout lacks the newer Freeform fields,
  or current commits invalidate the transaction/persistence design above.
- Stop rather than invent a new source identity heuristic when exact saved-device
  resolution is impossible. Surface source repair to the user.
- Stop if complete visual application needs a new backend commit protocol, native
  source lifecycle changes, or unscoped file deletion. Bring back the observed gap.
- If a gate fails twice after a focused fix attempt, document the failure and
  distinguish an existing baseline problem from a new regression.
- Future LayoutSettings fields must be normalized in saved snapshots and included
  deliberately in modified-state comparison. New layouts need framing migration,
  gallery/shortcut catalog and required-source test coverage together.
- Future managed-asset garbage collection must account for saved-scene snapshots
  and the persisted working checkpoint before deleting any imported file.
- Future remote saved-scene support is a separate protocol/data-projection decision;
  this feature must not accidentally broadcast source names, paths or preset data.

The planning investigation was limited to these five requests and their scene,
background, persistence, source-picker and shortcut paths. Implementation and
verification now proceed within that scope; no release or merge is authorized.

## Execution scope reconciliation

The reviewer authorized these necessary, bounded integration additions during
execution on 2026-09-22:

- `happy-dom` as a desktop development dependency and its lockfile entries, so
  source-picker and saved-scene tests exercise actual React/Radix/cmdk behavior.
- A minimal SceneStage gesture-active signal so saving can be disabled during
  gestures without permanently disabling Freeform scene saving. No geometry fix.
- A shared global-shortcut action catalog and focused tests to keep main, preload
  and renderer contracts consistent.
- Existing `js-yaml` override from 4.3.1 to patched 4.3.2: the production audit
  failed on unchanged base HEAD through electron-updater (GHSA-2883-xcg3-v3hh).
  This is a narrow prerequisite to passing the required advisory gate, not a
  general dependency upgrade.

- Renderer asset budget baseline exception: a clean build of base `7b093ce9a`
  measures 2,004,205 raw / 388,483 gzip eager renderer bytes, already exceeding
  the unchanged 2,000,000 / 385,000 limits. The initial execution target was no growth against that measured base;
  the final correctness reconciliation below records the small raw-byte exception.
  Lazy loading the command palette is a bounded integration improvement; no
  unrelated bundle refactor or ceiling increase is authorized. Record the strict
  gate failure and final measurements in the PR rather than claiming it passed.

- Final bundle reconciliation after the remount and strict-source fixes:
  2,004,270 raw / 388,128 gzip eager bytes versus the clean base
  2,004,205 / 388,483 (+65 raw, -355 gzip). Retain the required correctness
  fixes rather than expand scope into an unrelated optimization or weaken
  validation. The fixed-budget gate remains failed; neither ceiling is raised.
- `origin/main` advanced during execution to `abb37658` (clean native scene
  switches #381 and release instruction documentation #382). There is no
  renderer/shared/main TypeScript drift from the tested base `7b093ce9a`; these
  commits are not copied into this feature branch. PR integration/CI must retain
  their native scene-switch changes and additional pixel gate.

## Execution verification — 2026-09-22

Implementation is complete on `feat/scene-presets-studio-usability`, based on
`7b093ce9a`. All five requested behaviors and their persistence, failure, race and
DOM regression coverage are implemented. Review found and corrected source-priority,
remount/checkpoint, and queued-shortcut race cases before final verification.
The PR remains draft pending the acceptance items below; this is not a release
or merge approval.

Passed verification:

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm build`,
  `pnpm audit:js`, and `git diff --check`.
- Full desktop suite: 182 files, 1,823 passed, one existing skipped test.
  Baseline was 1,794 passed and one skipped.
- `pnpm test:scripts`: 1,415 passed across 250 suites.
- `pnpm smoke:scene-presets`: real provider save/apply, exact-source refusal,
  modified checkpoint restoration and saveability after reload, removed background
  slot persistence, and live switching within the same recording session. Finished
  artifacts passed analysis; encoded background-ring pixels distinguish both scenes.
- `pnpm smoke:remote-control`: real discovery/pairing, allowlist/filter lock,
  confirmed intent state, debounce and regenerate/disconnect contracts passed.
- The recording-studio run passed its focused desktop/Node suites, microphone
  control artifact probe, 485 focused Rust tests, captions/noise-cleanup artifacts,
  all-layout recordings, quit/finalization, enforced record-latency cycles, imported
  recordings, native launch/first-frame proof, all-layout preview liveness, active
  recording/RTMP switching, comment highlight/relay, and backend-owned scene commits.
- Record-latency results: cold start 132 ms, warm start p95 83 ms; cold stop 100 ms,
  warm stop p95 94 ms. All five sessions armed the existing compositor with no restart.
- Continued the exact remaining recording-studio steps after the first failure:
  pump diagnostics, click/focus continuity, interaction stress, window placement,
  native-surface reattach, real ScreenCaptureKit recording and Notes invisibility
  passed. Pump initially observed one rather than two expected mismatch events;
  its focused retry passed. Lifecycle initially failed before the main window was
  ready; its standalone `pnpm probe:preview-lifecycle` retry passed all 100 cycles.
- Device extension: real-device preview interaction/recording artifact and real
  ScreenCaptureKit live layout-switch recording passed.
- Final dark/light scene-gallery screenshots were inspected after CSS theme transitions
  settled; labels are readable and controls are not clipped.
- Shadscan baseline and enforced floor: 41; final review audit: 41. The executor
  reruns the same JSON audit immediately before committing.

Outstanding acceptance and limitations:

- Source-complete native-preview layout stress failed twice: first nine, then six
  CPU fallback frames. Command: `VIDEORC_NATIVE_PREVIEW_SOURCE_COMPLETE_SCENE=1
  VIDEORC_NATIVE_PREVIEW_LAYOUT_STRESS_UPDATES=4 pnpm smoke:recording-native-preview`.
  The native implementation and this smoke are unchanged by this PR, but a clean-base
  reproduction has not established whether this is pre-existing. Keep this result
  unresolved rather than relaxing its assertion or claiming the device gate passes.
- Consequently the initial `pnpm smoke:recording-studio` aggregate did not exit green;
  its remaining steps were executed individually/in order, with focused retries as
  described above. The device extension also did not pass in full.
- `pnpm check:renderer-assets` remains failed against its unchanged fixed ceilings;
  clean-base/final measurements and the +65 raw / -355 gzip delta are recorded above.
- Physical Windows execution and foreground-other-app global-shortcut acceptance
  on both platforms remain manual acceptance. Main-process registration/lifecycle,
  IPC validation, provider dispatch/conflicts and burst/manual-race handling have
  automated coverage; those tests do not substitute for an OS keyboard exercise.
- Physical camera unplug/replug repair and the full manual animation-on/off and
  keyboard-only acceptance matrix have not been completed on hardware. No Windows
  presenter, camera-capture or native compositor code is changed by this PR.
- The tested base predates native scene-switch PR #381. Preserve it and run its new
  pixel gate when integrating with current main. Do not interpret these results as
  a successful run against the combined native changes.

Local detailed logs use `/tmp/videorc-plan044-*`; generated recordings, screenshots,
reports and ephemeral connection credentials are excluded from the commit.
