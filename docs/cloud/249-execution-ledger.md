# Plan 249 execution ledger

Current coordinator-confirmed publication accounting: **18 merged source slice checkpoints, 4 open-PR slices (S13a/S17/S22/S24), 10 unpublished slices = 32**. Runtime qualification: **0**; all required runtime acceptance remains **not-run**. A merged checkpoint does not mean parity or production qualification. W4 viewer totals is separate (#1458/web#139); repair #1457 is open and is not another slice.

Execution authority: the 2026-11-16 implementation instruction supersedes the
planning-only banner in local planning commit `712010475` on
`plan/cloud-feature-parity`. D1–D12 recommended choices are implementation
defaults, preserving opt-in, consent, bounded costs and safe rollout.

The coordinator commissions one dependency-ready slice per report and owns
issue creation/linking, commits and PRs. The coordinator merged the earlier PRs
under explicit user authority. This followup agent performs no integration merges to main, deployments, paid egress,
credential expansion or enabling unqualified production media capabilities.
No agent-created commit, push, issue or PR was made in S0.

## Initial S0 source and forge reconciliation

- Desktop fetched `origin/main`: `c0d6ca8b8c25628b1932bd7ff21312e390b6839b`.
- Web fetched `origin/main`: `8f90dd74944cf08b9ca202e977a2ebf46ee6b16d`.
- Both exactly match the plan pins; source drift diff is empty.
- The shared desktop checkout and the web active checkout have unrelated changes;
  neither was edited. The planning worktree was preserved.
- S0 worktree: `/Users/orcdev/projects/videorc-wt-249-s0`.
- Branch: `feat/249-s0-cloud-parity-baseline`; base: desktop revision above.
- `src repo view --json nameWithOwner` returned exit 1 in both repositories;
  both remotes are GitHub. Source skill read; GitHub queries used afterward.
- Searched all-state issues/PRs for `249` and `cloud parity`, then all open
  issues/PRs on 2026-11-16. The coordinator subsequently opened desktop PR #1437
  for S0. A fresh S1 query found no dedicated S1 issue/PR; null issue mappings
  remain deliberate, not invented issue URLs.
- Reuse/reconcile [web #118](https://github.com/TheOrcDev/videorc-web/pull/118)
  in S1: open takeover all-bus silence fix. D3 calls for speech-only mute with
  deliberate auxiliary sound; inspect it before adding another implementation.
- Reconcile [web #115](https://github.com/TheOrcDev/videorc-web/pull/115)
  in S24: open continuation work. Neither PR is proof of deployed behavior.
- No need to recover original research sessions: complete plan and exact pinned
  source snapshots were available. Deployment and legacy-runner revision unknown.

## Machine-readable ownership and stacking

`protocol-fixtures/cloud-parity-plan.json` is the execution ledger data:
dependencies (S7/S13/S21 aliases expanded), case ownership, touched modules,
gate descriptions, repo needs, intended title/branch/base and issue/PR slots.
`protocol-fixtures/cloud-parity-inventory.json` declares all 57 A/G/V/O features
across local, solo cloud, room stream, room recording, host monitor, guest
return and handoff. Supported means source wiring, never live qualification.
All acceptance lanes are `not-run`; all new production-parity flags are false.
Citation prefixes retain the plan roots: B = backend `src`, R = desktop
renderer `src`, M = Electron main, S = desktop shared, W = web root.

Historical stack bases below describe the published sequence. The earlier PRs
are now merged; the S21a followup starts from fetched current main. If the coordinator chooses parallel branches,
reconcile all prerequisite tips explicitly and update the ledger. Paired
desktop/web PRs must link each other and their prerequisite PRs. A qualified
consumer contract must exist before a producer can be enabled.

| Slice / case              | Dependencies                                                                                                                                          | Repositories | Intended bases                                                                              | Issue / PR                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S0 / `baseline`           | None                                                                                                                                                  | desktop      | desktop: `main`                                                                             | No dedicated issue; [Desktop #1437](https://github.com/TheOrcDev/videorc/pull/1437) (merged)                                                                                                                                                                                                                                                                                    |
| S1 / `controls`           | S0                                                                                                                                                    | desktop      | desktop: `feat/249-s0-cloud-parity-baseline`                                                | No dedicated issue; [Desktop #1438](https://github.com/TheOrcDev/videorc/pull/1438) (merged)                                                                                                                                                                                                                                                                                    |
| S2 / `privacy`            | S0, S1                                                                                                                                                | desktop, web | desktop: `feat/249-s1-cloud-parity`; web: `main`                                            | No dedicated issue; [Desktop #1439](https://github.com/TheOrcDev/videorc/pull/1439) (merged); [Web #125](https://github.com/TheOrcDev/videorc-web/pull/125) (merged)                                                                                                                                                                                                            |
| S3 / `soundboard`         | S0, S1                                                                                                                                                | desktop, web | desktop: `feat/249-s2-cloud-parity`; web: `feat/249-s2-cloud-parity`                        | No dedicated issue; [Desktop #1440](https://github.com/TheOrcDev/videorc/pull/1440) (merged); [Web #126](https://github.com/TheOrcDev/videorc-web/pull/126) (merged)                                                                                                                                                                                                            |
| S4 / `avatar`             | S3                                                                                                                                                    | desktop, web | desktop: `feat/249-s3-cloud-parity`; web: `feat/249-s3-cloud-parity`                        | No dedicated issue; [Desktop #1441](https://github.com/TheOrcDev/videorc/pull/1441) (merged); [Web #127](https://github.com/TheOrcDev/videorc-web/pull/127) (merged); owner `S6z:P60l3:G6oxv`                                                                                                                                                                                   |
| S5 / `avatar-animation`   | S4                                                                                                                                                    | desktop, web | desktop: `main`; web: `main`                                                                | No dedicated issue; [Desktop #1451](https://github.com/TheOrcDev/videorc/pull/1451) (merged); [Web #133](https://github.com/TheOrcDev/videorc-web/pull/133) (merged); owner `S6z:P60l3:G7m82`                                                                                                                                                                                   |
| S6 / `views`              | S3, S4                                                                                                                                                | desktop, web | desktop: `main`; web: `main`                                                                | No dedicated issue; [Desktop #1452](https://github.com/TheOrcDev/videorc/pull/1452) (merged); [Web #134](https://github.com/TheOrcDev/videorc-web/pull/134) (merged); owner `S6z:P60l3:G9zgb`                                                                                                                                                                                   |
| S7a / `microphone-bridge` | S1, S3                                                                                                                                                | desktop      | desktop: `feat/249-s3-cloud-parity`                                                         | No dedicated issue; [Desktop #1444](https://github.com/TheOrcDev/videorc/pull/1444) (merged); owner `S6z:P60l3:G67rq`                                                                                                                                                                                                                                                           |
| S7b / `microphone`        | S7a                                                                                                                                                   | desktop      | desktop: `main`                                                                             | No dedicated issue; [Desktop #1448](https://github.com/TheOrcDev/videorc/pull/1448) (merged); owner `S6z:P60l3:G67rq`                                                                                                                                                                                                                                                           |
| S8 / `audio-routing`      | S2, S3, S7a, S7b                                                                                                                                      | desktop, web | desktop: `feat/249-s7b-cloud-parity`; web: `feat/249-s6-cloud-parity`                       | No dedicated issue; in-progress-isolated; owner `S6z:P60l3:G67rq`                                                                                                                                                                                                                                                                                                               |
| S9 / `graphics`           | S4, S6                                                                                                                                                | desktop, web | desktop: `feat/249-s6-cloud-parity`; web: `feat/249-s6-cloud-parity`                        | No dedicated issue; [Desktop #1454](https://github.com/TheOrcDev/videorc/pull/1454) (merged); [Web #136](https://github.com/TheOrcDev/videorc-web/pull/136) (merged); owner `S6z:P60l3:G6oxv`                                                                                                                                                                                   |
| S10 / `alpha-spike`       | S6                                                                                                                                                    | desktop, web | desktop: `feat/249-s6-cloud-parity`; web: `feat/249-s6-cloud-parity`                        | No dedicated issue; [Desktop #1453](https://github.com/TheOrcDev/videorc/pull/1453) (merged); [Web #135](https://github.com/TheOrcDev/videorc-web/pull/135) (merged); owner `S6z:P60l3:G6ltc`                                                                                                                                                                                   |
| S11 / `html`              | S9, S10                                                                                                                                               | desktop, web | desktop: `feat/249-s10-cloud-parity`; web: `feat/249-s10-cloud-parity`                      | No dedicated issue; not-started                                                                                                                                                                                                                                                                                                                                                 |
| S12 / `scenes`            | S2, S6, S9                                                                                                                                            | desktop, web | desktop: `feat/249-s11-cloud-parity`; web: `feat/249-s11-cloud-parity`                      | No dedicated issue; [Desktop #1455](https://github.com/TheOrcDev/videorc/pull/1455) (merged); [Web #137](https://github.com/TheOrcDev/videorc-web/pull/137) (merged)                                                                                                                                                                                                            |
| S13a / `camera-bridge`    | S1, S10, S12                                                                                                                                          | desktop, web | desktop: `feat/249-s12-cloud-parity`; web: `feat/249-s12-cloud-parity`                      | No dedicated issue; [Desktop #1459](https://github.com/TheOrcDev/videorc/pull/1459) (open); [Web #140](https://github.com/TheOrcDev/videorc-web/pull/140) (open)                                                                                                                                                                                                                |
| S13b / `camera`           | S13a                                                                                                                                                  | desktop      | desktop: `feat/249-s13a-cloud-parity`                                                       | No dedicated issue; not-started                                                                                                                                                                                                                                                                                                                                                 |
| S14 / `sources`           | S2, S12, S13a, S13b                                                                                                                                   | desktop, web | desktop: `feat/249-s13b-cloud-parity`; web: `feat/249-s13a-cloud-parity`                    | No dedicated issue; not-started                                                                                                                                                                                                                                                                                                                                                 |
| S15 / `captions`          | S7a, S7b, S9                                                                                                                                          | desktop, web | desktop: `feat/249-s9-cloud-parity + S7b dependency merge`; web: `feat/249-s9-cloud-parity` | No dedicated issue; [Desktop #1456](https://github.com/TheOrcDev/videorc/pull/1456) (merged); [Web #138](https://github.com/TheOrcDev/videorc-web/pull/138) (merged)                                                                                                                                                                                                            |
| S16 / `lifecycle`         | S1                                                                                                                                                    | desktop, web | desktop: `feat/249-s4-cloud-parity`; web: `feat/249-s4-cloud-parity`                        | No dedicated issue; [Desktop #1442](https://github.com/TheOrcDev/videorc/pull/1442) (merged); [Web #128](https://github.com/TheOrcDev/videorc-web/pull/128) (merged); owner `S6z:P60l3:G6ltc`                                                                                                                                                                                   |
| S17 / `outputs`           | S9, S12, S16                                                                                                                                          | desktop, web | desktop: `feat/249-s16-cloud-parity`; web: `feat/249-s16-cloud-parity`                      | No dedicated issue; [Desktop #1460](https://github.com/TheOrcDev/videorc/pull/1460) (open); [Web #141](https://github.com/TheOrcDev/videorc-web/pull/141) (open)                                                                                                                                                                                                                |
| S18 / `services`          | S1, S16                                                                                                                                               | desktop      | desktop: `feat/249-s17-cloud-parity`                                                        | No dedicated issue; [Desktop #1447](https://github.com/TheOrcDev/videorc/pull/1447) (merged); owner `S6z:P60l3:G1q9i`                                                                                                                                                                                                                                                           |
| S19 / `markers`           | S1, S15                                                                                                                                               | desktop      | desktop: `feat/249-s18-cloud-parity`                                                        | No dedicated issue; not-started                                                                                                                                                                                                                                                                                                                                                 |
| S20 / `library`           | S1, S16                                                                                                                                               | desktop, web | desktop: `feat/249-s16-cloud-parity`; web: `feat/249-s16-cloud-parity`                      | No dedicated issue; [Desktop #1443](https://github.com/TheOrcDev/videorc/pull/1443) (merged); [Web #129](https://github.com/TheOrcDev/videorc-web/pull/129) (merged); owner `S6z:P60l3:G55dg`                                                                                                                                                                                   |
| S21a / `replay-ring`      | S20                                                                                                                                                   | desktop, web | desktop: `main`; web: `main`                                                                | No dedicated issue; [Desktop #1446](https://github.com/TheOrcDev/videorc/pull/1446) (merged); [Web #130](https://github.com/TheOrcDev/videorc-web/pull/130) (merged); [Desktop followup #1449](https://github.com/TheOrcDev/videorc/pull/1449) (open-unmerged); [Web followup #131](https://github.com/TheOrcDev/videorc-web/pull/131) (open-unmerged); owner `S6z:P60l3:G55dg` |
| S21b / `clips`            | S19, S21a                                                                                                                                             | desktop, web | desktop: `feat/249-s20-cloud-parity`; web: `feat/249-s21a-cloud-parity`                     | No dedicated issue; not-started                                                                                                                                                                                                                                                                                                                                                 |
| S21c / `archive`          | S20, S21a                                                                                                                                             | desktop, web | desktop: `feat/249-s21a-managed-replay`; web: `feat/249-s21a-managed-replay`                | No dedicated issue; [Desktop #1450](https://github.com/TheOrcDev/videorc/pull/1450) (merged); [Web #132](https://github.com/TheOrcDev/videorc-web/pull/132) (merged); owner `S6z:P60l3:G55dg`                                                                                                                                                                                   |
| S22 / `iso`               | S7a, S7b, S20                                                                                                                                         | desktop, web | desktop: `feat/249-s21c-cloud-parity`; web: `feat/249-s21b-cloud-parity`                    | No dedicated issue; [Desktop #1462](https://github.com/TheOrcDev/videorc/pull/1462) (open); [Web #143](https://github.com/TheOrcDev/videorc-web/pull/143) (open)                                                                                                                                                                                                                |
| S23 / `virtual-camera`    | S6, S13a, S13b                                                                                                                                        | desktop      | desktop: `feat/249-s22-cloud-parity`                                                        | No dedicated issue; not-started                                                                                                                                                                                                                                                                                                                                                 |
| S24 / `handoff`           | S5, S9, S16, S18, S20                                                                                                                                 | desktop, web | desktop: `feat/249-s23-cloud-parity`; web: `feat/249-s22-cloud-parity`                      | No dedicated issue; [Desktop #1461](https://github.com/TheOrcDev/videorc/pull/1461) (open); [Web #142](https://github.com/TheOrcDev/videorc-web/pull/142) (open)                                                                                                                                                                                                                |
| S25 / `reporting`         | S18, S20, S24                                                                                                                                         | desktop, web | desktop: `feat/249-s24-cloud-parity`; web: `feat/249-s24-cloud-parity`                      | No dedicated issue; not-started                                                                                                                                                                                                                                                                                                                                                 |
| S26 / `health`            | S6, S7a, S7b, S17, S24                                                                                                                                | desktop, web | desktop: `feat/249-s25-cloud-parity`; web: `feat/249-s25-cloud-parity`                      | No dedicated issue; not-started                                                                                                                                                                                                                                                                                                                                                 |
| S27 / `all`               | S0, S1, S2, S3, S4, S5, S6, S7a, S7b, S8, S9, S10, S11, S12, S13a, S13b, S14, S15, S16, S17, S18, S19, S20, S21a, S21b, S21c, S22, S23, S24, S25, S26 | desktop, web | desktop: `feat/249-s26-cloud-parity`; web: `feat/249-s26-cloud-parity`                      | No dedicated issue; not-started                                                                                                                                                                                                                                                                                                                                                 |

S0 is committed/pushed by the coordinator at `570d72926` and merged as
[PR #1437](https://github.com/TheOrcDev/videorc/pull/1437), implemented with
**live acceptance not run**. S1 is committed/pushed at `0f9790f86` and merged as
[PR #1438](https://github.com/TheOrcDev/videorc/pull/1438), with live acceptance
**not run**. S2 is merged as desktop [#1439](https://github.com/TheOrcDev/videorc/pull/1439)
(`27a8380b4`) and web [#125](https://github.com/TheOrcDev/videorc-web/pull/125)
(`03b31e8e`), with live acceptance **not run**. S3 is merged as desktop [#1440](https://github.com/TheOrcDev/videorc/pull/1440)
(`a93168fc4`) and web [#126](https://github.com/TheOrcDev/videorc-web/pull/126)
(`a68454e0`); live acceptance remains **not run**.

Parallel ownership (current coordinator assignments; isolated trees):

- S7b: `S6z:P60l3:G67rq` — published open PR #1448; S8 active.
- S5: `S6z:P60l3:G7m82` — paired PRs #1451/#133 open.
- S6: `S6z:P60l3:G9zgb`, reconciled by `S6z:P60l3:G7e0v` — paired PRs #1452/#134 open.
- S9: `S6z:P60l3:G6oxv` — paired PRs #1454/#136 open on S6.
- S10: `S6z:P60l3:G6ltc` — paired PRs #1453/#135 open on S6; alpha disabled.
- S24: `S6z:P60l3:G1q9i` — active.
- S12: `S6z:P60l3:G98zv` — active.
- S13a: `S6z:P60l3:G7e0v` — active.
- S22: `S6z:P60l3:G1wkh` — active.
- S21a source followup published open #1449/#131; S21c published open #1450/#132; S15 and central ledger: `S6z:P60l3:G55dg`.

S4 is merged as desktop [#1441](https://github.com/TheOrcDev/videorc/pull/1441)
(`6a142e936`) and web [#127](https://github.com/TheOrcDev/videorc-web/pull/127)
(`9f708259`). S16 was stacked on S4 and is merged as desktop
[#1442](https://github.com/TheOrcDev/videorc/pull/1442) (`5b340c09c`) and web
[#128](https://github.com/TheOrcDev/videorc-web/pull/128) (`78586c99`). Their live
acceptance remains **not run**.

S20 paired `feat/249-s20-cloud-parity` worktrees are now reconciled onto those
exact S16 tips. All six integration seams are resolved, with canonical typed
interval reads and association after the S16 observer. S4 output-token claims
and S16 pending-End acknowledgements are preserved. Original frozen diffs are
backed up at `/tmp/249-s20-before-s16-integration`. See
`docs/cloud/249-s20-handoff.md` for PR-ready bodies, exact paths and deferred gates.
S18's separate `app_settings.cloud.showServices` storage does not overlap takes.

All 32 slices remain commissioned; this is a checkpoint, not plan completion.

## Deferred gates and release blocks

User continues to forbid smoke and heavy tests for this followup despite the
earlier merges. This
overrides plan/repo requirements to execute those gates in each slice. Each
slice still implements its maintained acceptance case and focused tests, and
records deferred gates. Never change `not-run` to passed/qualified on that basis.

- S0: full N/W suites, WB real-page and guest suites, C managed/legacy/solo
  smokes, and `smoke:cloud-parity -- --case baseline` are not run.
- All slices: applicable D/B/N/W full suites, WB/C/R/P/RC/REL and specialized
  smoke/device/media/Windows stability gates remain deferred as listed in JSON.
- S10, S13a, S21a and S22 still require real managed feasibility/cost evidence;
  consumers may be implemented behind disabled capabilities, never enabled by
  inferred success. S27 rollout/deploy actions need separate commissioning.
- No real-page, packaged-platform, guest-device, final managed-egress, A/V
  sync/drift, native bridge, alpha, higher-profile, ISO or retention qualification
  was obtained in S0. No measured baseline absence/presence is claimed.
- Source checks, pure helper tests and local fixture HTTP unit tests do not
  discharge live media gates. Browser output capture is not managed egress.

## S0 implementation and verification

See `docs/cloud/cloud-parity-harness.md` for prerequisites, evidence boundaries,
recording/analyzer behavior and the maintained case interface. See
`docs/acceptance/2026-11-16-cloud-parity-s0.md` for the honest not-run baseline.

Focused checks: 14 parity tests, 3 existing managed-token/control tests and
2 format-glob tests passed. `pnpm test:cloud-parity`, syntax checks for touched MJS files,
targeted Prettier checks and `git diff --check`. New parity modules pass scoped
Oxlint. Including the pre-existing managed fixture reports its unchanged
`no-control-regex` finding in `validText`; it is not repaired by S0.

The pnpm focused-test invocation populated 673 dependency packages from cache
in 3.8 seconds and ran the existing prepare hook. No lockfile/source changes
resulted; Git config mtime predates that invocation, so the hook was a no-op.
No browser/app build or smoke followed.

Shadscan baseline/floor: 27/27
(desktop React package; root package is not a React application). Final advisory
audit score is reported in the coordinator handoff, after the diff is frozen.

## Exact web work for S0

No web source changes are required by this implementation. The desktop harness
takes `VIDEORC_PARITY_WEB_ROOT`, bundles the real `GuestRoom` in memory with
existing esbuild/tsx dependencies, and imports the existing program fixture
server read-only. It serves the actual `programDocument`, CSP and emitted v1
assets, with real LiveKit. It changes only fixture API/device input and guest
test-wrapper sizing (not a geometry acceptance test). No Next build/migration.
A clean, dependency-installed web fixture checkout at the intended revision is
a prerequisite for the later run; never mutate the active web checkout to get it.

## PR draft

Title: `Plan 249 S0: establish cloud parity inventory and real-page baseline harness`

Body:

> Room publishing bypasses native media features, while existing managed smoke
> coverage does not inspect the web program picture/audio. Add a 57-feature
> capability inventory, a dependency-ordered 32-slice execution ledger,
> deterministic media fixtures and a local-LiveKit baseline harness connecting
> the actual desktop publisher, web program page and guest component. Capture
> program/guest artifacts separately, analyze tones/pixel markers, and report
> soundboard/avatar gaps without requiring those gaps to remain broken.
>
> Add narrow explicit guest/recorder fixture grants and fail unimplemented
> acceptance cases explicitly. No product capability is enabled.
>
> Validation: focused registry/schema/media/grant tests, MJS syntax, targeted
> format and diff checks. All smoke, real-page/device and heavy suites are
> deferred by explicit user instruction until after all merges on main.
> Baseline and managed acceptance remain not-run. Issue: none exists yet;
> coordinator to assign/link. Related web #118 and #115 are recorded for later
> slices, not closed or duplicated by S0.

## S0 changed paths

- `package.json`
- `docs/acceptance/2026-11-16-cloud-parity-s0.md`
- `docs/cloud/249-execution-ledger.md`
- `docs/cloud/cloud-parity-harness.md`
- `protocol-fixtures/cloud-parity-inventory.json`
- `protocol-fixtures/cloud-parity-media.json`
- `protocol-fixtures/cloud-parity-plan.json`
- `scripts/lib/cloud-parity-baseline.mjs`
- `scripts/lib/cloud-parity-browser.mjs`
- `scripts/lib/cloud-parity-contract.mjs`
- `scripts/lib/cloud-parity-contract.test.mjs`
- `scripts/lib/cloud-parity-media.mjs`
- `scripts/lib/cloud-parity-media.test.mjs`
- `scripts/lib/fake-cloud-web-managed.mjs`
- `scripts/smoke-cloud-parity-app.mjs`

## S1 implementation checkpoint

Worktree `/Users/orcdev/projects/videorc-wt-249-s1`, branch
`feat/249-s1-cloud-parity`, base `570d72926b0a2679f7816a2e0b531218291ff7a6`.
PR base is `feat/249-s0-cloud-parity-baseline`; preserve that published branch.
No S1 commit, push, issue or PR was created by this agent. No web writes.

Native/cloud output adapters now expose independent activity, clocks, freshness,
allowlisted destinations and confirmed room mic/camera state. Native recording
state remains untouched by the projection. Publisher epoch, canonical live
interval/take IDs and effective profiles are explicitly unavailable (`null`)
where today's protocol supplies none. They must not be synthesized from polling
edges; later ownership/lifecycle/media slices must populate them before service
idempotency or quality claims depend on them.

Tile, mixer, palette, global shortcut, deck/phone and agent microphone controls
reach the room publisher and wait for confirmation. Initial mute happens before
publication; None/off captures no camera, missing/vanished devices cannot fall
back to defaults, and control completion is fenced to its room/track. Cloud
recording/live stops are independent, with provider end ordering preserved.
Native scene, microphone replacement, screen picker, gain and system-audio
commands cannot falsely acknowledge room parity; supported stage/share controls
remain available. Room program pictures are explicitly unavailable to agents
until their later snapshot implementation. Remote protocol adds only fixed
output enums/booleans/null, no credentials, destinations or identifiers.

The maintained `controls` case exercises actual UI tile/mixer, the hotkey
handler, deck protocol, signed phone protocol and agent MCP listener, then
measures program PCM. It asserts initial None/mute, camera unpublication,
independent Stop and takeover all-program silence. It is **not run**. Its fake
cloud Stop checks prove controller behavior only when eventually run; browser
captures are not encoded managed-egress evidence, physical-device qualification,
or OS global-key registration proof.

Web PR #118 was reconciled read-only at head
`af5be462f5d790fd5c808c0acfd4b801382f5e9c`: stage audio fades its bus to zero,
fallback elements and late voices inherit silence, and stage/timer state calls
that policy. It remains OPEN. Reuse that work and emitted v1 bundle; no duplicate
web fix. The desktop no longer says “everyone muted.” D3 speech-only policy
with enabled auxiliary audio belongs to S8. No web deploy/acceptance is claimed.

Focused verification and exact changed paths are in `249-s1-handoff.md`.
Shadscan baseline/floor is **27/27**. Final numeric audit is reported by the
agent after freezing the diff. Backend compile/tests, full suites, all app,
real-page, smoke, device, media and managed acceptance remain deferred by the
user instruction; the Rust adapter tests are maintained but unexecuted.

## S2 paired checkpoint

- Desktop: `/Users/orcdev/projects/videorc-wt-249-s2`, branch
  `feat/249-s2-cloud-parity`, base `feat/249-s1-cloud-parity` at
  `0f9790f869a07102560ee864ac91b001fe73f7e4`.
- Web: `/Users/orcdev/projects/videorcweb-wt-249-s2`, branch
  `feat/249-s2-cloud-parity`, base `main` at
  `8f90dd74944cf08b9ca202e977a2ebf46ee6b16d`.
- Both shared active checkouts, planning worktree, S0 and S1 branches preserved.
  Source detection selected GitHub. Searches found no dedicated S2 issue or PR;
  no forge objects created. Null issue mappings are intentional.
- Web #118 remains open at `af5be462f5d790fd5c808c0acfd4b801382f5e9c`.
  Its takeover-audio work is independent; do not merge or duplicate it. Reconcile
  `stage.ts` and re-emit generated assets when integrating both branches.
- Contract and deferred commands: `docs/cloud/249-s2-handoff.md`; mirrored fixture
  `protocol-fixtures/cloud-parity-privacy.json` / web
  `tests/fixtures/cloud-parity-privacy.json`.
- Consumer-first integration. Older consumers remain unconfirmed; newer consumers
  cannot infer source protection from legacy track names. Native generation is
  optional for backwards parsing, but absent generations cannot open browser
  publication. No LiveKit grants, rollout flags, deployment or paid output changed.

## S3 paired checkpoint

- Desktop `/Users/orcdev/projects/videorc-wt-249-s3`, branch
  `feat/249-s3-cloud-parity`, base `feat/249-s2-cloud-parity` at
  `27a8380b496667fc2d12b06fdb356ee48fe571cc` (PR #1439).
- Web `/Users/orcdev/projects/videorcweb-wt-249-s3`, same branch name,
  base `feat/249-s2-cloud-parity` at
  `03b31e8e1c030f0a4fedd8517242f3de8ea06e57` (PR #125).
- Shared active checkouts and published stack branches preserved. No commit,
  push, PR, merge or deployment made. S3 searches found no dedicated issue/PR;
  null issue/PR mappings await coordinator publication.
- Both sides implement the pinned media-v2 manifest mirrored in
  `protocol-fixtures/cloud-parity-media-v2.json` and web `tests/fixtures/`.
  The static program asset path stays v1 for compatibility; the loaded consumer
  must explicitly advertise media v2. Deploying files cannot upgrade an old page.
- Per-room opt-in defaults off. Publication additionally requires every active
  consumer's authenticated current-SID v2 receipt. Unknown sessions receive no
  auxiliary subscription permission, even before host join-event processing.
  Missing/expired receipts stop the source and unpublish; no fabricated on-air
  state, no guest publishing grant change, no system/speaker capture.
- Native backend voice IDs remain authoritative. Pending decode presses are
  fenced by Stop/restart/eviction. Browser decode tickets, ended IDs and epoch
  cutoffs prevent stale starts and one-shot reconnect replay; loops join phase.
- Independent monitor and stereo auxiliary sink; program aux ignores screen and
  host stage selection; guests attach every allowed audio SID. Receiver RMS is
  scoped to the current auxiliary SID and expires independently of publication.
- Web #118 remains independent at `af5be462f5d790fd5c808c0acfd4b801382f5e9c`.
  S3 requires no takeover branch dependency. Reconcile overlapping stage/audio
  files and re-emit when integrating it. S8 owns deliberate speech/aux policy.
- Full contract, focused evidence, deferred gates and paired PR bodies are in
  `docs/cloud/249-s3-handoff.md` in each repository. Waveform acceptance is
  implemented, **not run**; `productionQualified` and production parity flags
  remain false. Do not mark S3 live parity complete from these source changes.

## Parallel commissioning during S3

- Coordinator started S4 avatar (`S6z:P60l3:G6oxv`), S7a bounded PCM bridge
  (`S6z:P60l3:G67rq`) and S16 provider lifecycle (`S6z:P60l3:G6ltc`).
- Each owns isolated S2-based worktrees and a slice-local handoff. S3 retains
  central ledger and negotiation ownership. The coordinator reconciles S3 and
  each declared prerequisite before publishing dependent PRs.
- Stable note: `docs/cloud/249-media-v2-contract.md`, copied to the paired web
  worktree and sent directly to all three threads. V2 certifies auxiliary only;
  graphics and microphone bridge need independent capabilities. No concrete
  incompatible peer contract was reported at this checkpoint.

## S20 checkpoint

- Dedicated issue searches for Plan 249 / recording returned no S20 issue; no issue URL invented.
- Desktop worktree `/Users/orcdev/projects/videorc-wt-249-s20`; web `/Users/orcdev/projects/videorcweb-wt-249-s20`.
- Additive SQLite associations/download journal and Postgres take metadata/backfill; no real user database opened or migrated.
- Downloaded local files retain `cloud-recording` provenance and use existing Play/export/Clean cut/noise cleanup paths. Existing opt-in, entitlements and consent remain enforced.
- Maintained `library` acceptance uses isolated app/HTTPS fixtures and full artifact analyzer; **not run**. Rust compilation, actual migrations, crash/media/device/live provider validation, full suites and build gates are deferred per user.
- All production parity qualification flags remain false. S16 source integration is complete with focused fixture evidence; runtime/live acceptance remains not run.

## Historical S21a groundwork checkpoint

- S20 published desktop [#1443](https://github.com/TheOrcDev/videorc/pull/1443)
  at `d3f6a6dcb92c6fa17c166806a64ed1536d44416c` and web
  [#129](https://github.com/TheOrcDev/videorc-web/pull/129) at
  `3c72571af05ab374dca752a4616278d85043e26a`. S7a published desktop
  [#1444](https://github.com/TheOrcDev/videorc/pull/1444) at
  `58c3ab5cd9a80d8122fbfe5555371bb8b9fd6189`, based on S3. All live acceptance not run.
- Fresh isolated desktop `/Users/orcdev/projects/videorc-wt-249-s21a` and web
  `/Users/orcdev/projects/videorcweb-wt-249-s21a`, both branch
  `feat/249-s21a-cloud-parity`, based on those exact S20 tips. PR bases are
  `feat/249-s20-cloud-parity`. Shared checkouts and published branches preserved.
- At groundwork preparation, no dedicated S21a issue/PR was found; null mappings remained
  deliberate. No forge objects, commits or pushes created by this agent.
- Implemented bounded ring, strict local growing-HLS acquisition, typed canonical
  identity projection and owner-session boundary. No migration/provider code or
  historical timestamps changed. Never deletes source recording objects.
- Desktop adds the maintained real-program tab + final mixed audio capture,
  before-finalization ingestion, authorized window reconstruction, decoded
  pixels/tones/keyframes/packet clocks and strict existing artifact analyzer.
  This is runnable source, **not-run acceptance**, not measured capability.
- Groundwork had no managed provider adapter. The followup below supersedes that
  source limitation; managed availability/cost/clock qualification remains unmeasured.
- Parallel ownership: S6 restacks onto S16 and completes guest graphics; S5 fixes
  monitor animation/status; S9/S10 wait S6; S18 closes pending-command durability.
  Independent YouTube emotes thread `G4z27` and its checkout were not touched.
- Full limits/contracts, paths, PR bodies and deferred commands:
  `docs/cloud/249-s21a-handoff.md` in each repo. All 32 slices remain commissioned.

## S21a managed-provider source followup

- All earlier desktop #1437–1447 and web #125–130 PRs are merged, per coordinator.
  Desktop #1445 is the separate YouTube-emote task, not a Plan 249 slice.
  This includes S18/S7a integration resolutions. Acceptance remains **not run**.
- Fetched current desktop main `dda61b03ef52a97bd74a6796a2a0032d480878e5`
  and web main `59fb8ba6c3cd9559523c5d320bad2065f3cdce1d`.
  Fresh paired branch `feat/249-s21a-managed-replay` starts directly at these
  commits; no merge/rebase/cherry-pick is pending and indexes match HEAD.
- Desktop worktree: `/Users/orcdev/projects/videorc-wt-249-s21a-managed-replay`.
  Web worktree: `/Users/orcdev/projects/videorcweb-wt-249-s21a-managed-replay`.
  Original S21a trees/branches remain untouched. Frozen diffs/files are backed up
  at `/Users/orcdev/projects/videorc-249-handoffs/s21a-before-main-20261116`.
  Followup restored byte-for-byte before documentation reconciliation; runtime
  code needed no conflict resolution. New paired PRs target **main**; no agent
  commit/push/PR. Exact parents, paths and PR text are in the paired handoff.
- S22 owner `S6z:P60l3:G1wkh` confirmed no edits to our recording/schema/SDK seams.
  ISO uses `iso/` below the canonical S20 take prefix; replay does not. Replay
  adds no egress and reserves no separate concurrency slot; its `replayUsage`
  does not replace ISO's independent cost reservation. No peer worktree edited.
- Source integration now implements LiveKit `SegmentedFileOutput.livePlaylistName`,
  requested only for replay-armed, independently started recording. Existing
  program page, output claims, take, writer credential and egress are reused.
  No automatic Record, extra egress, grant or finalized-take polling.
- Server-owned persistent metadata stores bounded segment references and durable
  cost/byte/request reservations in the existing media row. Show leases, CAS,
  generation fencing, read-time expiry and the reaper enforce isolation and cleanup.
  No binary cache or source recording deletion: recording retention is unchanged.
- S3 reader uses existing server credential injection and child-branch isolation;
  no credential configuration was read by this agent. Mocked SDK/storage tests
  exercise the path. Runtime configuration remains disabled/unqualified with
  null measured pricing. Missing provider/PDT/continuity evidence is not invented.
- Maintained actual-program acquisition/analyzer remains intact and **not run**.
  Focused evidence, exact paths, SDK constraints, PR text and pending acceptance
  are in the revised paired `docs/cloud/249-s21a-handoff.md`.

## Current S21c optional local program archive checkpoint

- S21a source followup is published, **open/unmerged**: desktop
  [#1449](https://github.com/TheOrcDev/videorc/pull/1449) at
  `183f4812dd8bbf4405d264031eec139176fd9de2`, web
  [#131](https://github.com/TheOrcDev/videorc-web/pull/131) at
  `cd32e7e7ba1a025f2b4f4c805dd6a8d0a6dea914`. Both base main.
  Groundwork #1446/#130 remains merged; managed qualification remains false.
- S7b [#1448](https://github.com/TheOrcDev/videorc/pull/1448), commit
  `68c623f07754e755af0def3d9ed24383059bd36f`, is open on main. S8 owner
  `S6z:P60l3:G67rq` is active. Other parallel assignments above remain owned.
- S21c owner/central ledger: `S6z:P60l3:G55dg`. Fresh desktop
  `/Users/orcdev/projects/videorc-wt-249-s21c` and web
  `/Users/orcdev/projects/videorcweb-wt-249-s21c`, branch
  `feat/249-s21c-cloud-parity`, start at the exact S21a source commits above.
  Both eventual PRs base `feat/249-s21a-managed-replay`; originals untouched.
- Native bounded journal/downloader/remux and Library registration, archive
  controls, owner-authorized web projection, and maintained actual-program
  acquisition/restart/loss/pixel/audio acceptance are implemented. No implicit
  Record, source deletion, new capture owner, extra egress or grant. A local
  archive depends on cloud egress/network; it is not an offline-independent backup.
- S22 preserves the canonical take ID and separate ISO storage. S24 confirms
  archive reads survive controller transfer; only account/show/take/generation
  are fenced, with no controller writes or pending-End acknowledgement changes.
- S21b is **not started**: S19 is unstarted. S21c does not bypass that dependency
  or implement Clips. All 32 slices remain commissioned, not completed.
- Source qualification is still false. No smoke/device/real-page/managed/provider,
  full Rust build, deployment, paid calls or real user DB migration. Exact checks,
  limits, paths and PR text: `docs/cloud/249-s21c-handoff.md`.

## S15 host speech and published S9 integration checkpoint

The machine mapping above is current to coordinator messages, including open
S7b #1448, S5 #1451/#133, S6 #1452/#134, S9 #1454/#136, S10 #1453/#135,
S21a followup #1449/#131 and S21c #1450/#132. Earlier desktop #1437–1447 and
web #125–130 are merged. Every live acceptance remains **not run**.

S15 uses desktop HEAD S7b `68c623f07754e755af0def3d9ed24383059bd36f` with a
resolved pending dependency merge of actual S9 `894810e69650ea71812d78efd6f0771216144836`.
Its staged index is the dependency integration; S15 work is unstaged/untracked.
Web HEAD is actual S9 `c419182892fda1aec058df86710cc425458b0f16`, with no merge pending.
No stale original local S9 branch was used. Prior S15 changes are backed up at
`/Users/orcdev/projects/videorc-249-handoffs/s15-before-s9/`.

Host-only source/consent/PCM admission, local final transcript storage, S9 bounded
caption raster delivery and actual fake-gateway acquisition are implemented.
No guest or auxiliary audio is host command input. Native capture is excluded
while the room owns speech, including mute and native encoder finalization.
Independent stream/record flags use Scene layout, and old pages lacking
`graphics.static.captions:1` receive no caption pixels. No runtime acceptance,
Rust compilation, paid speech call or production qualification was performed.

S24 must wire the named ownership-loss hook before controller handoff readiness;
its unpublished controller code is not copied here. S13a's unpublished native
clock is not inferred: source-to-show observational offsets retain null
uncertainty. See `docs/cloud/249-s15-contract.md` and the S15 handoff for exact
interfaces, checks and deferred gates. S8 remains capture/aux owner; S12 scenes,
S13a camera/PCM timing, S22 ISO and S24 controller ownership stay in peer trees.

## Historical initial S19 recovery (superseded by committed-dependency reconciliation below)

- Desktop S15 base `97ec02dcca20bd03ea9674ffbfb3a379f2302e5f`; web S15 base `3f181288cf8731514b867cd9c5847c67b08ad558`. Isolated S19 source is uncommitted and unpublished.
- Merged source slices: S0, S1, S2, S3, S4, S5, S6, S7a, S7b, S9, S10, S12, S15, S16, S18, S20, S21a, S21c. S21a followup #1449/web#131 and S21c #1450/web#132 are included, without double-counting S21a groundwork.
- S13a is published/open #1459/web#140, desktop `3e42ca9af06fbff8f646b58823b6c29405e92e43`, web `952ce7b554791551d4d58198726354afa90785ed`. Native monotonic incarnation/origin are not a show clock. S19 needs no copied anchor source; S15 source-to-show uncertainty remains null.
- Parallel owners: S13a `S6z:P60l3:G7e0v`, S17 `S6z:P60l3:G67rq`, S22 `S6z:P60l3:G2anc`, S24 `S6z:P60l3:G1q9i`, S19/central ledger `S6z:P60l3:G55dg`. S24 still awaits combined S5+S9 reconciliation; no committed tip supplied to S19.
- W4 viewer totals `S6z:P60l3:G6ltc` published #1458/web#139 is separate from S25. Repair #1457 open is also separate from the 32 slices.
- S19 uses server receipt minus canonical show.createdAt. Interval, take and provider identities are separate associations; no association implies extractable media. Voice source offsets remain unconverted. See S19 contract/handoff and exact manifests for checks and remaining dependencies.
- Smoke/app/device/provider/paid/heavy/full Rust checks remain explicitly deferred by user instruction. No real database was migrated. No acceptance result is inferred from source, fixture tests or merged PRs.

## S19 committed-dependency reconciliation (latest)

- Publication count updated: **18 merged checkpoints, 4 open-PR slices (S13a/S17/S22/S24), 10 unpublished**. All runtime qualification remains deferred. S19 remains unpublished until coordinator integration.
- S17 #1460 `49437135c87a1f09272c8e98e2ab394795d86199`, stacked on repair #1457; web#141 `fb6c3af001fda449f7861f1c53cf8e4415a2912b`.
- S24 #1461 `7c2e0ed519417a4132c6670a982907d4b80b1ddd`; web#142 `db7ce88e5de3e2f878ccf0be3d57c1aaeb08cebb`. Both are now S19's exact integration bases. S24 ownership watch, synchronous source guard, epoch header and request reservation are retained. Marker POST/DELETE reserve the controller command; GET stays owner-readable. Loss clears the voice-marker grant and requires explicit re-enable.
- Fresh S19 integration worktrees are `videorc-wt-249-s19-integration` and `videorcweb-wt-249-s19-integration`, branch `integrate/249-s19-s24-reconcile`. Original S15-based S19 trees and `/tmp/249-s19-before-s24-{videorc,videorcweb}` backups are preserved. No commits or pending merges.
- Current peer ownership: S8 `S6z:P60l3:G98zv`, S13b `S6z:P60l3:G7e0v`, S25 `S6z:P60l3:G1q9i`, S22 fence completion `S6z:P60l3:G1wkh`. Prior assignment notes are historical. W4 is still separate from S25.
- Migration reservations: S24 0041, S22 0042, S19 **0043_cloud_show_marks.sql**. No user database was opened or migrated.

Latest publication: S22 desktop [#1462](https://github.com/TheOrcDev/videorc/pull/1462) `9b73f830a8a72f7e24bed84702ca811f67fe28fa`; web [#143](https://github.com/TheOrcDev/videorc-web/pull/143) `57bd08650d45367146f7cc108788f2b2adfb3c29`, stacked on S24. Counts now **18 merged / 4 open-PR / 10 unpublished**, qualification unchanged. S11 `S6z:P60l3:G1wkh` now active; other active slices S8/S13b/S19/S25.
