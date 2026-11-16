# Plan 249 S1 coordinator handoff

Implementation ready for review. **Live acceptance NOT RUN; not qualified.**
No commit, push, PR creation, merge, deployment or web modification by this agent.

## Stack

- Worktree: `/Users/orcdev/projects/videorc-wt-249-s1`
- Branch: `feat/249-s1-cloud-parity`
- HEAD/base: `570d72926b0a2679f7816a2e0b531218291ff7a6`
- Eventual PR base: `feat/249-s0-cloud-parity-baseline` (preserve the S0 branch).
- S0: <https://github.com/TheOrcDev/videorc/pull/1437>, open, implemented;
  live acceptance remains not-run.
- Dedicated S1 issue/PR: none found on the fresh GitHub query. Mapping slots
  remain null for the coordinator; no duplicate issue or PR was created.
- Web dependency: <https://github.com/TheOrcDev/videorc-web/pull/118>, open at
  `af5be462f5d790fd5c808c0acfd4b801382f5e9c`. Inspected read-only. Reuse its
  stage audio silence, stage wiring, emitted v1 bundles and tests. Coordinator
  must arrange integration; no takeover code was duplicated. S8 owns the later
  D3 speech/auxiliary policy. No deployed behavior is inferred from this PR.

## PR-ready title

Plan 249 S1: route room controls through confirmed output owners

## PR-ready body

Room mute and remote/agent Stop previously read native recording state even
when LiveKit and cloud outputs owned the show. Mixer, palette, hotkey, deck,
phone and agent mute now reach the room publisher and wait for confirmation.
Initial mute precedes publication; camera None/off releases capture, and exact
selected-device constraints prevent fallback to a different/default device.

Add native/cloud output facts without manufacturing a native session. Record
Stop and Stream Stop act independently on cloud outputs and preserve platform
end ordering. Agent status reports room activity and confirmed media state;
unavailable cloud pictures are refused. Native-only source/scene and agent
gain/system-audio commands refuse false room acknowledgement. Remote additions
contain only fixed enums/booleans/null; no new methods, events or permissions.

Implement the maintained `controls` parity case and update all-slice mapping
with S0 PR #1437. Reuse open web PR #118 for takeover all-program silence and
remove the desktop's unconfirmed “everyone muted” claim. Publisher epochs,
canonical interval/take IDs and effective profiles stay null where their
owner protocol supplies none; later slices must provide those facts before
consumers depend on them.

Validation: 286 distinct focused desktop unit tests across 13 files passed
(incremental runs; final adapter/room/join rerun: 50 tests). All 16 parity
inventory/schema/media/control-helper Node tests passed. Renderer/shared TS7
no-emit check, changed-file format and syntax checks, scoped lint, touched Rust
format checks and diff whitespace checks passed. Lint retains one existing
`recording` dependency warning in the unchanged stop-confirmation memo; no
unrelated cleanup. Shadscan baseline/floor 27/27; final score is in the frozen
handoff report.

Per user instruction, no smoke, real-page, app/device, heavy suite or build was
executed. Backend compilation/tests are deferred because this fresh worktree
would require a heavy backend build; Rust adapter tests are maintained but not
run. Browser/managed media, A/V, OS hotkey and off-loopback LAN acceptance remain
not-run. The controls harness's controller-fixture stops and browser captures
cannot qualify managed egress. Production parity inventory flags remain false.

## Focused commands

Run from `apps/desktop` using existing dependencies:

```sh
node_modules/.bin/vitest run \
  src/shared/output-session.test.ts \
  src/renderer/src/lib/talk-show-room.test.ts \
  src/renderer/src/hooks/use-talk-show-room-join.test.ts \
  src/renderer/src/lib/studio-actions/remote.test.ts \
  src/renderer/src/lib/studio-actions/agent.test.ts \
  src/renderer/src/lib/studio-actions/run-the-show.test.ts \
  src/renderer/src/lib/global-shortcuts.test.ts \
  src/renderer/src/lib/agent-surface.test.ts \
  src/renderer/src/lib/remote-surface.test.ts \
  src/renderer/src/components/studio/show-stage.test.ts \
  src/renderer/src/components/studio/audio-section.test.ts \
  src/renderer/src/components/sources/sources-audio-mixer.test.ts \
  src/renderer/src/components/command-palette.test.ts
```

Run from worktree root:

```sh
node apps/desktop/node_modules/typescript-native/bin/tsc --noEmit -p apps/desktop/tsconfig.web.json
node --test scripts/lib/cloud-parity-*.test.mjs
rustfmt --edition 2024 --check --config skip_children=true crates/videorc-backend/src/main.rs crates/videorc-backend/src/output_session.rs crates/videorc-backend/src/agent_look.rs
git diff --check
```

Changed-file Oxlint/Prettier and `node --check` use the exact paths below.
No dependencies were installed; ignored per-entry symlinks reuse S0's modules.
Shadscan command, from desktop: `pnpm dlx @shadscan/cli@next --json`.
The final audit is advisory for the coordinator's commit; this agent commits nothing.

## Deferred gates

`smoke:cloud-parity -- --case controls`, baseline, room/talk-show, remote-control,
remote-LAN, agent-MCP, recording studio/latency/device, full desktop/Node/Rust/web
suites, builds/clippy and real-page/web/browser/managed acceptance are deferred
by the user until the final integration gate. No deferred gate is passed.
See `docs/acceptance/2026-11-16-cloud-parity-s1.md`.

## Exact changed paths

- `apps/desktop/src/renderer/src/components/command-palette.test.ts`
- `apps/desktop/src/renderer/src/components/command-palette.tsx`
- `apps/desktop/src/renderer/src/components/sources/sources-audio-mixer.tsx`
- `apps/desktop/src/renderer/src/components/studio/audio-section.tsx`
- `apps/desktop/src/renderer/src/components/studio/show-stage.test.ts`
- `apps/desktop/src/renderer/src/components/studio/show-stage.tsx`
- `apps/desktop/src/renderer/src/hooks/use-studio.tsx`
- `apps/desktop/src/renderer/src/hooks/use-talk-show-room-join.test.ts`
- `apps/desktop/src/renderer/src/hooks/use-talk-show-room.ts`
- `apps/desktop/src/renderer/src/lib/agent-surface.test.ts`
- `apps/desktop/src/renderer/src/lib/agent-surface.ts`
- `apps/desktop/src/renderer/src/lib/global-shortcuts.test.ts`
- `apps/desktop/src/renderer/src/lib/global-shortcuts.ts`
- `apps/desktop/src/renderer/src/lib/remote-surface.ts`
- `apps/desktop/src/renderer/src/lib/studio-actions/agent.test.ts`
- `apps/desktop/src/renderer/src/lib/studio-actions/audio.ts`
- `apps/desktop/src/renderer/src/lib/studio-actions/context.ts`
- `apps/desktop/src/renderer/src/lib/studio-actions/remote.test.ts`
- `apps/desktop/src/renderer/src/lib/studio-actions/run-the-show.ts`
- `apps/desktop/src/renderer/src/lib/studio-actions/session.ts`
- `apps/desktop/src/renderer/src/lib/studio-actions/studio-context.ts`
- `apps/desktop/src/renderer/src/lib/studio-actions/tools.ts`
- `apps/desktop/src/renderer/src/lib/talk-show-room.test.ts`
- `apps/desktop/src/renderer/src/lib/talk-show-room.ts`
- `apps/desktop/src/shared/output-session.fixture.ts`
- `apps/desktop/src/shared/output-session.test.ts`
- `apps/desktop/src/shared/output-session.ts`
- `crates/videorc-backend/src/agent_look.rs`
- `crates/videorc-backend/src/main.rs`
- `crates/videorc-backend/src/output_session.rs`
- `docs/acceptance/2026-11-16-cloud-parity-s1.md`
- `docs/agents-mcp.md`
- `docs/cloud/249-execution-ledger.md`
- `docs/cloud/249-s1-handoff.md`
- `docs/cloud/cloud-parity-harness.md`
- `docs/remote-control.md`
- `protocol-fixtures/cloud-parity-plan.json`
- `scripts/lib/cloud-parity-baseline.mjs`
- `scripts/lib/cloud-parity-controls-contract.mjs`
- `scripts/lib/cloud-parity-controls-contract.test.mjs`
- `scripts/lib/cloud-parity-controls.mjs`
- `scripts/smoke-cloud-parity-app.mjs`
