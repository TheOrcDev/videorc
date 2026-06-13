# Plan 018: Add a redacted support bundle and diagnostics export

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the next
> step. If a STOP condition occurs, stop and report; do not improvise.
>
> **Drift check (run first)**:
> `git diff --stat 0ea3c66c..HEAD -- apps/desktop/src/shared/backend.ts apps/desktop/src/preload/index.ts apps/desktop/src/main/index.ts apps/desktop/src/renderer/src/hooks/use-studio.tsx apps/desktop/src/renderer/src/components/tabs/diagnostics-tab.tsx crates/videorc-backend/src/protocol.rs crates/videorc-backend/src/main.rs crates/videorc-backend/src/diagnostics.rs crates/videorc-backend/src/storage.rs docs/distribution.md`
> If any in-scope file changed since this plan was written, compare the current
> excerpts below against live code before proceeding. On mismatch, treat it as a
> STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW-MED
- **Depends on**: Plan 007
- **Category**: dx, docs, security
- **Planned at**: commit `0ea3c66c`, 2026-06-13
- **Status**: IN PROGRESS (Slices A6-A9 export, UI action, and verifier)

## Why this matters

Manual testing has already surfaced issues that are hard to diagnose from a
chat paste: preview fallback reasons, linker/build failures, stream failures,
and A/V sync reports. A redacted support bundle gives every future bug report a
single artifact with logs, diagnostics, environment, and recent session metadata
without exposing stream keys, OAuth tokens, or local media.

## Current state

Relevant files:

- `apps/desktop/src/renderer/src/components/tabs/diagnostics-tab.tsx` -
  diagnostics UI.
- `apps/desktop/src/renderer/src/hooks/use-studio.tsx` - logs, health events,
  diagnostics, sessions in memory.
- `apps/desktop/src/shared/backend.ts` and `protocol.rs` - protocol mirrors.
- `crates/videorc-backend/src/diagnostics.rs` - diagnostic stats.
- `crates/videorc-backend/src/storage.rs` - session metadata and app DB.
- `apps/desktop/src/main/index.ts` - privileged file save/reveal IPC.

The Studio provider already keeps useful state:

```ts
// apps/desktop/src/renderer/src/hooks/use-studio.tsx:540
const [deviceList, setDeviceList] = useState<DeviceList>({ devices: [], warnings: [] })
const [recording, setRecording] = useState<RecordingStatus>({ state: 'idle', message: 'Ready.' })
const [logs, setLogs] = useState<BackendLogEvent[]>([])
const [healthEvents, setHealthEvents] = useState<HealthEvent[]>([])
```

Diagnostics already include many media proof fields in shared types:

```ts
// apps/desktop/src/shared/backend.ts:1213
export interface DiagnosticStats {
```

Repo conventions:

- Never include secrets, stream keys, OAuth tokens, local recordings, or app DB
  contents in committed/generated evidence.
- Prefer explicit diagnostics over silent fallbacks.
- Privileged filesystem work belongs in main/backend, not renderer-only code.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Desktop tests | `pnpm --filter @videorc/desktop test` | all pass |
| TypeScript | `pnpm typecheck` | exits 0 |
| Lint | `pnpm lint` | exits 0 |
| Rust tests | `cargo test -p videorc-backend diagnostics` | new tests pass |
| Script tests | `pnpm test:scripts` | all pass if scripts added |
| Smoke dev | `pnpm smoke:dev` | still passes |

## Scope

**In scope**:

- support bundle data model and redaction helpers
- backend/main command to write a bundle
- Diagnostics tab export action
- tests proving redaction
- docs describing what is included/excluded

**Out of scope**:

- Cloud crash reporting or telemetry upload.
- Including local recordings or screenshots automatically.
- Uploading support bundles anywhere.
- Rewriting the diagnostics UI.

## Git workflow

- Branch: `codex/018-support-bundle`
- Commit style: redaction helpers, backend/main command, UI action, docs.
- Do not push unless instructed.

## Steps

### Step 1: Define the support bundle schema

Create a pure schema/helper for a JSON bundle containing:

- app version and commit if available
- platform and packaged/dev mode
- backend health and FFmpeg status
- device list with names allowed, but no secret values
- current recording status
- latest diagnostic stats
- latest health events and logs
- recent session summaries with media paths redacted or basename-only
- entitlement/provider readiness status if Plan 016 exists

Add redaction helpers for:

- stream keys
- OAuth tokens
- client secrets
- API keys
- home-directory paths when not needed
- URLs with credentials

**Verify**: unit tests prove known secret-shaped fields are redacted.

### Step 2: Add a backend/main export command

Add a command such as `diagnostics.supportBundle.export` or a main IPC wrapper
that writes the bundle to a user-chosen or default support directory.

The command should return:

- bundle path
- included sections
- redaction summary

It must not include recordings, database files, extracted audio, AI artifact
contents, or screenshots by default.

**Verify**:

```sh
cargo test -p videorc-backend diagnostics
pnpm typecheck
```

### Step 3: Add Diagnostics tab action

Add a compact Diagnostics tab button:

- icon button or clear text button consistent with existing UI
- disabled while export is running
- success toast with reveal action
- failure toast with reason

Do not create a marketing/explainer panel.

**Verify**:

```sh
pnpm --filter @videorc/desktop test
pnpm lint
```

### Step 4: Add script-level verifier

If the bundle format is JSON, add a small script test or node helper that
checks:

- required sections exist
- forbidden keys are absent or redacted
- bundle validates after a dev smoke

**Verify**: `pnpm test:scripts` exits 0.

### Step 5: Document usage

Update docs with:

- where bundles are written
- what they include
- what they exclude
- how a tester attaches one to a bug report
- reminder not to attach recordings unless requested

**Verify**: `pnpm format:check` exits 0.

## Test plan

- Pure redaction tests.
- Backend/main export command tests.
- Desktop unit/type/lint gates.
- `pnpm smoke:dev`, then manually export a bundle from Diagnostics.

## Done criteria

- [ ] Support bundle export exists.
- [ ] Redaction tests cover stream keys, OAuth tokens, API keys, and local paths.
- [ ] Bundle excludes recordings, DB files, extracted audio, and AI artifact
      bodies by default.
- [ ] Diagnostics tab can export and reveal the bundle.
- [ ] Docs explain support-bundle usage.
- [ ] Required gates pass.
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report if:

- The only way to export useful data includes secrets or local media.
- Renderer-only filesystem access would be required.
- Export depends on Plan 016 state that has not landed.
- Redaction cannot be tested deterministically.

## Maintenance notes

Every new credential-bearing feature should add a redaction test here. This
bundle should be boring, reliable, and safe to share with an agent or human
debugger.
