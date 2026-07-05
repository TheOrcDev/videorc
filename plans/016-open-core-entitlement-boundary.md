# Plan 016: Add the open-core entitlement boundary for premium features

> **Addendum 2026-07-05**: the `VIDEORC_PREMIUM_FEATURES=1` unlock described
> below was removed — a release binary honored it at runtime, which defeated
> the boundary. The variable is now downgrade-only (`=0` forces Basic for gate
> testing); premium comes from the signed-in account's verified entitlement,
> and dev builds resolve to Developer on their own (smokes no longer set the
> variable). See `docs/distribution.md` ("Open-Core Capability Boundary") for
> the current enforcement story.

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the next
> step. If a STOP condition occurs, stop and report; do not improvise.
>
> **Drift check (run first)**:
> `git diff --stat 0ea3c66c..HEAD -- README.md apps/desktop/src/shared/backend.ts apps/desktop/src/renderer/src/lib/capture.ts apps/desktop/src/renderer/src/hooks/use-studio.tsx apps/desktop/src/renderer/src/components/tabs/streaming-tab.tsx apps/desktop/src/renderer/src/components/tabs/ai-tab.tsx crates/videorc-backend/src/protocol.rs crates/videorc-backend/src/main.rs crates/videorc-backend/src/recording.rs crates/videorc-backend/src/ai.rs docs/distribution.md`
> If any in-scope file changed since this plan was written, compare the current
> excerpts below against live code before proceeding. On mismatch, treat it as a
> STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: Plans 007 and 009
- **Category**: direction, security, tests
- **Planned at**: commit `0ea3c66c`, 2026-06-13
- **Status**: DONE (2026-06-13; slices A1-A5 landed and required gates passed)

## Why this matters

The intended product shape is open core: free local recording and preview, paid
livestreaming and cloud AI. That cannot be implemented as scattered disabled
buttons, because renderer-only gates are bypassable and confusing. The app needs
a single capability model shared by backend and UI so free users keep a complete
OBS-like recording tool, while premium-only actions are blocked honestly.

## Current state

Relevant files:

- `apps/desktop/src/renderer/src/lib/capture.ts` - default streaming settings.
- `apps/desktop/src/renderer/src/components/tabs/streaming-tab.tsx` - live
  destination UI.
- `apps/desktop/src/renderer/src/components/tabs/ai-tab.tsx` - cloud AI UI.
- `apps/desktop/src/renderer/src/hooks/use-studio.tsx` - session start and AI
  actions.
- `crates/videorc-backend/src/recording.rs` - backend session start guard.
- `crates/videorc-backend/src/ai.rs` - cloud AI workflow.
- `crates/videorc-backend/src/protocol.rs` and shared TS types - protocol
  mirrors.

Streaming exists as a normal config path today:

```ts
// apps/desktop/src/renderer/src/lib/capture.ts:103
export function defaultStreamingSettings(): StreamingSettings {
  return {
    enabled: false,
    mode: 'single',
```

AI consent exists, but there is no premium entitlement check:

```tsx
// apps/desktop/src/renderer/src/components/tabs/ai-tab.tsx:120
<PanelSection icon={ShieldCheck} title="Cloud AI consent">
```

Cloud AI runs when consent and `OPENAI_API_KEY` are present:

```rust
// crates/videorc-backend/src/ai.rs:80
let api_key = match std::env::var("OPENAI_API_KEY") {
```

Session start currently decides stream behavior from params, not entitlements:

```ts
// apps/desktop/src/renderer/src/hooks/use-studio.tsx:3529
const startSession = useCallback(async () => {
  if (captureConfig.streamEnabled) {
```

Repo conventions:

- Do not silently disable core recording features.
- Backend must enforce security/product boundaries; renderer gates are UX only.
- Prefer explicit status and diagnostics over silent fallbacks.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Desktop tests | `pnpm --filter @videorc/desktop test` | all pass |
| TypeScript | `pnpm typecheck` | exits 0 |
| Lint | `pnpm lint` | exits 0 |
| Rust tests | `cargo test -p videorc-backend entitlement` | new tests pass |
| Rust full | `cargo test -p videorc-backend` | all pass |
| Stream smoke | `pnpm smoke:multistream` | still passes when premium/dev entitlement enabled |

## Scope

**In scope**:

- local entitlement model and protocol
- backend guards for livestreaming and cloud AI
- renderer UX for free vs premium capability state
- developer override for local testing
- docs describing the capability matrix

**Out of scope**:

- Payment provider integration.
- License server implementation.
- Website pricing copy in the sibling `videorc-web` repo.
- Disabling local recording, native preview, source selection, or library.

## Git workflow

- Branch: `codex/016-open-core-entitlements`
- Commit style: shared model, backend guards, UI states, docs.
- Do not push unless instructed.

## Steps

### Step 1: Define the capability matrix

Add a small document section in `README.md` or `docs/distribution.md`:

- Free/core: local recording, native preview, source/layout controls, library,
  local repair/remux, local audio extraction without cloud upload.
- Premium: livestreaming destinations, multistreaming, cloud AI workflow.
- Developer/self-host override: explicit env var for local testing.

Do not describe pricing mechanics here beyond the product boundary. The website
can say `$29`; this repo should enforce capabilities.

**Verify**: docs state that local recording remains first-class in free mode.

### Step 2: Add a shared entitlement protocol

Add protocol/types such as:

```ts
type FeatureId = 'local-recording' | 'livestreaming' | 'cloud-ai'
type EntitlementState = 'enabled' | 'disabled' | 'developer-override'
```

Expose a backend command/event like `entitlements.get` returning:

- tier: `free`, `premium`, or `developer`
- capabilities with reasons
- source: local config, env override, or future license

For v1, implement a deterministic local provider:

- default free
- `VIDEORC_PREMIUM_FEATURES=1` enables premium in dev/local smoke
- optional local config file only if needed

**Verify**: `pnpm typecheck` and Rust entitlement tests pass.

### Step 3: Enforce premium server-side

In backend command handlers:

- reject `session.start` when streaming is requested and livestreaming is not
  entitled
- reject `run_ai_workflow` cloud upload when cloud AI is not entitled
- allow local audio extraction only if the product explicitly keeps it free
- keep local recording allowed

Error messages should be specific and non-crashy.

**Verify**:

```sh
cargo test -p videorc-backend entitlement
cargo test -p videorc-backend
```

### Step 4: Gate renderer actions from the same model

In `use-studio.tsx`, load entitlement state after backend connection and expose
it through context. Update:

- Streaming tab: show premium-required state and disable Go Live setup when not
  entitled.
- Studio primary action: recording remains available; streaming path shows
  premium-required reason.
- AI tab: local artifact explanation remains; cloud AI action shows premium
  state when disabled.

Do not remove tabs unless the design explicitly calls for it. Prefer visible,
honest disabled states.

**Verify**:

```sh
pnpm --filter @videorc/desktop test
pnpm typecheck
pnpm lint
```

### Step 5: Update smokes for entitlement mode

Any smoke that starts streaming or cloud AI must set the developer/premium
override explicitly. Local recording smokes should not need premium.

Examples:

- `smoke:multistream` sets `VIDEORC_PREMIUM_FEATURES=1`
- provider live smokes document the required env
- AI tests use explicit entitlement fixtures

**Verify**:

```sh
pnpm smoke:dev
pnpm smoke:multistream
pnpm test:scripts
```

## Test plan

- Backend unit tests for entitlement defaults and env override.
- Backend tests that streaming/cloud AI are rejected without entitlement.
- Renderer tests for capability-state helpers.
- Existing stream smokes with explicit premium override.
- Existing local recording smokes without premium override.

## Done criteria

- [ ] Capability matrix is documented.
- [ ] Backend exposes entitlement state.
- [ ] Backend enforces livestreaming and cloud AI premium gates.
- [ ] Free mode still records locally with native preview.
- [ ] Renderer states use backend entitlement data.
- [ ] Streaming/AI smokes opt into developer/premium mode explicitly.
- [ ] TS/Rust/script gates pass.
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report if:

- Product decision changes and livestreaming should remain free.
- Payment/license server design becomes required.
- A gate would disable local recording or core preview.
- Existing smokes cannot be made explicit without weakening coverage.

## Maintenance notes

This is a boundary plan, not monetization plumbing. Future billing should replace
the local entitlement provider without changing feature checks scattered across
the app.
