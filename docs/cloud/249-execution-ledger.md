# Plan 249 execution ledger

Execution authority: the 2026-11-16 implementation instruction supersedes the
planning-only banner in local planning commit `712010475` on
`plan/cloud-feature-parity`. D1–D12 recommended choices are implementation
defaults, preserving opt-in, consent, bounded costs and safe rollout.

The coordinator commissions one dependency-ready slice per report and owns
issue creation/linking, commits and PRs. No merges, deployments, paid egress,
credential expansion or enabling unqualified production media capabilities.
No agent-created commit, push, issue or PR was made in S0.

## Source and forge reconciliation

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

Use the serialized per-repository stack bases below; this supplies every
prerequisite without merging. If the coordinator chooses parallel branches,
reconcile all prerequisite tips explicitly and update the ledger. Paired
desktop/web PRs must link each other and their prerequisite PRs. A qualified
consumer contract must exist before a producer can be enabled.

| Slice / case              | Dependencies                           | Repo         | Intended base(s)                                                         | Issue / PR                                                                                      |
| ------------------------- | -------------------------------------- | ------------ | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| S0 / `baseline`           | None                                   | desktop      | desktop: `main`                                                          | No issue / [#1437](https://github.com/TheOrcDev/videorc/pull/1437)                              |
| S1 / `controls`           | S0                                     | desktop      | desktop: `feat/249-s0-cloud-parity-baseline`                             | No issue / coordinator to create; web [#118](https://github.com/TheOrcDev/videorc-web/pull/118) |
| S2 / `privacy`            | S0, S1                                 | desktop, web | desktop: `feat/249-s1-cloud-parity`; web: `main`                         | Unassigned / not created                                                                        |
| S3 / `soundboard`         | S0, S1                                 | desktop, web | desktop: `feat/249-s2-cloud-parity`; web: `feat/249-s2-cloud-parity`     | Unassigned / not created                                                                        |
| S4 / `avatar`             | S3                                     | desktop, web | desktop: `feat/249-s3-cloud-parity`; web: `feat/249-s3-cloud-parity`     | Unassigned / not created                                                                        |
| S5 / `avatar-animation`   | S4                                     | desktop, web | desktop: `feat/249-s4-cloud-parity`; web: `feat/249-s4-cloud-parity`     | Unassigned / not created                                                                        |
| S6 / `views`              | S3, S4                                 | desktop, web | desktop: `feat/249-s5-cloud-parity`; web: `feat/249-s5-cloud-parity`     | Unassigned / not created                                                                        |
| S7a / `microphone-bridge` | S1, S3                                 | desktop      | desktop: `feat/249-s6-cloud-parity`                                      | Unassigned / not created                                                                        |
| S7b / `microphone`        | S7a                                    | desktop      | desktop: `feat/249-s7a-cloud-parity`                                     | Unassigned / not created                                                                        |
| S8 / `audio-routing`      | S2, S3, S7a, S7b                       | desktop, web | desktop: `feat/249-s7b-cloud-parity`; web: `feat/249-s6-cloud-parity`    | Unassigned / not created                                                                        |
| S9 / `graphics`           | S4, S6                                 | desktop, web | desktop: `feat/249-s8-cloud-parity`; web: `feat/249-s8-cloud-parity`     | Unassigned / not created                                                                        |
| S10 / `alpha-spike`       | S6                                     | desktop, web | desktop: `feat/249-s9-cloud-parity`; web: `feat/249-s9-cloud-parity`     | Unassigned / not created                                                                        |
| S11 / `html`              | S9, S10                                | desktop, web | desktop: `feat/249-s10-cloud-parity`; web: `feat/249-s10-cloud-parity`   | Unassigned / not created                                                                        |
| S12 / `scenes`            | S2, S6, S9                             | desktop, web | desktop: `feat/249-s11-cloud-parity`; web: `feat/249-s11-cloud-parity`   | Unassigned / not created                                                                        |
| S13a / `camera-bridge`    | S1, S10, S12                           | desktop, web | desktop: `feat/249-s12-cloud-parity`; web: `feat/249-s12-cloud-parity`   | Unassigned / not created                                                                        |
| S13b / `camera`           | S13a                                   | desktop      | desktop: `feat/249-s13a-cloud-parity`                                    | Unassigned / not created                                                                        |
| S14 / `sources`           | S2, S12, S13a, S13b                    | desktop, web | desktop: `feat/249-s13b-cloud-parity`; web: `feat/249-s13a-cloud-parity` | Unassigned / not created                                                                        |
| S15 / `captions`          | S7a, S7b, S9                           | desktop      | desktop: `feat/249-s14-cloud-parity`                                     | Unassigned / not created                                                                        |
| S16 / `lifecycle`         | S1                                     | desktop, web | desktop: `feat/249-s15-cloud-parity`; web: `feat/249-s14-cloud-parity`   | Unassigned / not created                                                                        |
| S17 / `outputs`           | S9, S12, S16                           | desktop, web | desktop: `feat/249-s16-cloud-parity`; web: `feat/249-s16-cloud-parity`   | Unassigned / not created                                                                        |
| S18 / `services`          | S1, S16                                | desktop      | desktop: `feat/249-s17-cloud-parity`                                     | Unassigned / not created                                                                        |
| S19 / `markers`           | S1, S15                                | desktop      | desktop: `feat/249-s18-cloud-parity`                                     | Unassigned / not created                                                                        |
| S20 / `library`           | S1, S16                                | desktop, web | desktop: `feat/249-s19-cloud-parity`; web: `feat/249-s17-cloud-parity`   | Unassigned / not created                                                                        |
| S21a / `replay-ring`      | S20                                    | web          | web: `feat/249-s20-cloud-parity`                                         | Unassigned / not created                                                                        |
| S21b / `clips`            | S19, S21a                              | desktop, web | desktop: `feat/249-s20-cloud-parity`; web: `feat/249-s21a-cloud-parity`  | Unassigned / not created                                                                        |
| S21c / `archive`          | S20, S21a                              | desktop      | desktop: `feat/249-s21b-cloud-parity`                                    | Unassigned / not created                                                                        |
| S22 / `iso`               | S7a, S7b, S20                          | desktop, web | desktop: `feat/249-s21c-cloud-parity`; web: `feat/249-s21b-cloud-parity` | Unassigned / not created                                                                        |
| S23 / `virtual-camera`    | S6, S13a, S13b                         | desktop      | desktop: `feat/249-s22-cloud-parity`                                     | Unassigned / not created                                                                        |
| S24 / `handoff`           | S5, S9, S16, S18, S20                  | desktop, web | desktop: `feat/249-s23-cloud-parity`; web: `feat/249-s22-cloud-parity`   | Unassigned / not created                                                                        |
| S25 / `reporting`         | S18, S20, S24                          | desktop, web | desktop: `feat/249-s24-cloud-parity`; web: `feat/249-s24-cloud-parity`   | Unassigned / not created                                                                        |
| S26 / `health`            | S6, S7a, S7b, S17, S24                 | desktop, web | desktop: `feat/249-s25-cloud-parity`; web: `feat/249-s25-cloud-parity`   | Unassigned / not created                                                                        |
| S27 / `all`               | All enabled slices (full list in JSON) | desktop, web | desktop: `feat/249-s26-cloud-parity`; web: `feat/249-s26-cloud-parity`   | Unassigned / not created                                                                        |

S0 is committed/pushed by the coordinator at `570d72926` and open as
[PR #1437](https://github.com/TheOrcDev/videorc/pull/1437), implemented with
**live acceptance not run**. S1 is implemented in its child worktree and ready
for coordinator review; its live acceptance is also **not run**. S2–S27 are not
started. This S1 checkpoint does not complete Plan 249 or authorize S2 work
before the coordinator commissions it.

## Deferred gates and release blocks

User explicitly forbids smoke and heavy tests until all merges on main. This
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
