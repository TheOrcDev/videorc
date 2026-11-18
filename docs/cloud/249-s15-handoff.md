# S15 paired source handoff

## Worktree and ancestry

Repository: desktop. Worktree: `/Users/orcdev/projects/videorc-wt-249-s15`.
Branch: `feat/249-s15-cloud-parity`. HEAD: `68c623f07754e755af0def3d9ed24383059bd36f`.

Desktop HEAD is S7b `68c623f07754e755af0def3d9ed24383059bd36f`.
MERGE_HEAD is published S9 `894810e69650ea71812d78efd6f0771216144836`.
The pending `--no-commit --no-ff` merge has no unresolved index entries.
Index tree `9f586ba87ebcd6e65b96ec5f054a0cee1b5e0911` contains only the S9/S6
integration and its three additive conflict resolutions (room client, room
client test and join-hook test). S15 source changes are unstaged/untracked.
Coordinator must finalize this dependency merge and intentionally stage S15;
do not commit only the present index as if it contains S15.
Suggested eventual PR base: published `feat/249-s9-cloud-parity`, retaining
S7b ancestry. S7b #1448 remains an open prerequisite. No peer tree was edited.

No commits, pushes or PRs were made by this agent. Dependency branches and
original worktrees remain intact. Pre-S9 source backup:
`/Users/orcdev/projects/videorc-249-handoffs/s15-before-s9/`.
Final source manifest: `docs/cloud/249-s15-manifest.json`; external complete
patch/untracked backup: `/Users/orcdev/projects/videorc-249-handoffs/s15-final/`.
Do not stage the local node_modules symlinks (desktop root + app, web root).
The manifest distinguishes S15 paths from staged dependency-integration paths.

## PR-ready title

Plan 249 S15: Caption the published host microphone with consent

## PR-ready body

Room captions and Sidekick listening consume the already processed, successfully
published host microphone instead of relying on a native encoder session.
Consent, realtime/quota admission, mute, source generation and observed room
ownership fence uploads; guests and auxiliary audio never become host commands.
Final cues persist locally with source-clock identity and explicit unmeasured
show-clock uncertainty. Native capture start/stop/failure cannot drain these cues
into an unrelated native recording artifact. Existing confirmed output facts
and spoken-action confirmation policy remain authoritative.

The existing S9 graphics lane gains a bounded, expiring caption raster with
independent stream/recording placement and a `graphics.static.captions:1`
capability. Old pages receive no captions until reload/rejoin advertises support.
Public graphics carry pixels only. Caption removal clears immediately despite
pending asset work. Paired web changes preserve S6 guest avatar authorization.

Maintained acquisition uses the real local fake speech gateway, actual processed
host publication and program picture; it measures decoded glyph pixels, partial
replacement, output selection, local cue timing, mute/off silence, listen-only
behavior and durable SQLite state. It is authored but NOT RUN. Production
qualification remains false. No paid calls, deployments or actual user database
migration occurred.

Dependencies: desktop S7b #1448 and S9 #1454, paired web S9 #136. S24 controller
watch integration is explicitly pending its committed source; native-to-show
clock mapping is unqualified. This is a source checkpoint, not completed
production acceptance. Link the paired S15 PR when the coordinator creates it.

## Focused evidence

- Desktop: 72 focused tests across six selected files (speech schema 5, graphics
  parser 6, source tap 3, graphics publisher 5, room client 39, join hook 14).
- Web: 7 selected captions/graphics tests; source/generated emitter `--check`.
- Node: 12 focused inventory/analyzer/in-memory migration tests. All 32 slices
  and 57 inventory features remain mapped, with all acceptance `not-run`.
- Desktop renderer/node TypeScript and web TypeScript passed. Scoped desktop
  oxlint has no errors and one inherited `useMemo` missing `recording` dependency
  warning in `use-studio.tsx` (same code in staged S9 integration). No unrelated fix.
  Scoped web ESLint, changed-file formatting, script syntax and whitespace checks
  passed. Shared graphics/avatar/view modules match byte-for-byte across repos.
- Rust formatting passed for touched modules. Rust authorization, revocation,
  queued-upload and native-artifact isolation tests are authored but NOT RUN;
  full compilation/type checking is deferred under the no-heavy-test instruction.
- One new publisher test initially sampled before the existing periodic send;
  its fake clock now advances the actual one-second send interval and passes.
- `pnpm exec` attempted workspace dependency reconciliation and refused without
  a TTY; no install was performed. Direct already-installed binaries completed
  checks. Root `tsc` is absent; the installed desktop binary completed node/web
  configs. No package/lockfile change or lowered assertion.
- Known inherited tile-dim assertion and reaper revision failure were not rerun
  and are not claimed fixed; affected S15 focused checks do not include them.

## Deferred evidence

No smoke, app, real-page, device, managed/provider, full Rust build/test/clippy,
production build or broad suite ran. Deferred gates include Plan S15 D/B/N/W/WB/C/R
where broader than the focused checks above, `smoke:cloud-parity -- --case captions`,
`smoke:captions-contract`, `smoke:captions-live`, `smoke:captions-dual-orientation`,
`smoke:buddy-act`, recording/device and final-artifact A/V acceptance.
No pixel/timing/cancellation/SQLite runtime claim is qualified by the unit tests.
The browser-AEC path uses its existing single capture; opt-in native mode retains
S7b's development gate and unqualified device status.

## Remaining integration contracts

- S24 must consume `captions::cloud_host::ownership_lost(&AppState, show_id).await`
  on `Ownership` watch loss, and fence admission with the canonical controller
  ownership before any further speech request. Its code is not committed here;
  no independent controller epoch was created. Current source checks confirmed
  show/room/on-air ownership, publication generation and a two-second lease.
  This is not proof of the future S24 controller watch or cross-device cutoff.
- S13a native `originUs`/incarnation is unpublished and not copied or inferred.
  Persisted source-to-show wall estimate has `uncertaintyMs:null`; measured
  alignment to cloud recordings remains unavailable.
- Current transcript UI reads the local current open owner show. Finals survive
  restart, with a sign-out purge joining the existing privacy barrier. Historical
  cloud recording transcript browsing/export is not added by this slice.
- S8 keeps native/browser capture and aux ownership; no second capture, guest
  host-input grant, system-audio workaround or copied peer implementation.
- No dedicated S15 issue URL or S15 PR exists yet. Central JSON records supplied
  S5/S6/S9/S10/S21c mappings, existing S7b and S21a followup PRs, and current owners.

## Shadscan checkpoint

Skill: `/Users/orcdev/.agents/skills/shadscan-pre-commit/SKILL.md`.
Desktop baseline/floor: **27/27**; web baseline/floor: **47/47**.
Final audit runs against the frozen source after this handoff is written;
results are recorded externally at `/tmp/249-s15-desktop-shadscan-final.json`
and `/tmp/249-s15-web-shadscan-final.json` and in the coordinator final message.
Command: `pnpm dlx @shadscan/cli@next --json`, desktop cwd `apps/desktop`, web root.
No commit is created here; audit is the coordinator's commit-ready checkpoint.
No unrelated audit findings are changed.

## Exact S15 paths (excluding manifest itself)

- `apps/desktop/src/renderer/src/components/captions/captions-controls.tsx`
- `apps/desktop/src/renderer/src/components/captions/host-transcript.tsx`
- `apps/desktop/src/renderer/src/components/studio/show-stage.tsx`
- `apps/desktop/src/renderer/src/components/tabs/captions-tab.tsx`
- `apps/desktop/src/renderer/src/hooks/use-studio.tsx`
- `apps/desktop/src/renderer/src/hooks/use-talk-show-room.ts`
- `apps/desktop/src/renderer/src/lib/room-graphics-publisher.test.ts`
- `apps/desktop/src/renderer/src/lib/room-graphics-publisher.ts`
- `apps/desktop/src/renderer/src/lib/room-speech-source.test.ts`
- `apps/desktop/src/renderer/src/lib/room-speech-source.ts`
- `apps/desktop/src/renderer/src/lib/room-speech-worklet.ts`
- `apps/desktop/src/renderer/src/lib/talk-show-room.test.ts`
- `apps/desktop/src/renderer/src/lib/talk-show-room.ts`
- `apps/desktop/src/shared/backend-rpc-contract.ts`
- `apps/desktop/src/shared/cloud-avatar.ts`
- `apps/desktop/src/shared/cloud-graphics-view.ts`
- `apps/desktop/src/shared/cloud-graphics.ts`
- `apps/desktop/src/shared/cloud-speech.test.ts`
- `apps/desktop/src/shared/cloud-speech.ts`
- `crates/videorc-backend/src/backend_authority.rs`
- `crates/videorc-backend/src/captions.rs`
- `crates/videorc-backend/src/captions/cloud_host.rs`
- `crates/videorc-backend/src/cloud_graphics.rs`
- `crates/videorc-backend/src/main.rs`
- `crates/videorc-backend/src/storage.rs`
- `crates/videorc-backend/src/storage/cloud_speech.rs`
- `crates/videorc-backend/src/storage/cloud_speech.sql`
- `docs/cloud/249-execution-ledger.md`
- `docs/cloud/249-s15-contract.md`
- `docs/cloud/249-s15-handoff.md`
- `protocol-fixtures/cloud-parity-plan.json`
- `scripts/lib/cloud-managed-smoke.mjs`
- `scripts/lib/cloud-parity-baseline.mjs`
- `scripts/lib/cloud-parity-captions-contract.mjs`
- `scripts/lib/cloud-parity-captions-contract.test.mjs`
- `scripts/lib/cloud-parity-captions.mjs`
- `scripts/lib/fake-caption-service.mjs`
- `scripts/lib/fake-cloud-web-managed.mjs`
- `scripts/smoke-cloud-parity-app.mjs`
