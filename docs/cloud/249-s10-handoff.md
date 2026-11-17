# Plan 249 S10 implementation handoff

Independent implementation is prepared and uncommitted. Measured feasibility
is **undecided**, local/managed acquisition is **not-run**, production capability
is **false**. See `docs/acceptance/249-s10-alpha-feasibility.md` for the complete
transport, acquisition, source-count, authority and budget contract.

## Exact pair and dependency status

Final implementation is reconciled onto the coordinator's exact published S6
commits (not the stale same-named local S6 branches):

- Desktop: `/Users/orcdev/projects/videorc-wt-249-s10`, branch
  `feat/249-s10-cloud-parity`, base
  `f27307cd97400b6933ac2324de3c6baffab5dfaf`, S6 PR1452.
- Web: `/Users/orcdev/projects/videorcweb-wt-249-s10`, same branch, base
  `b615c28b13997128c50edecae5d03f583a7cb32f`, S6 PR134.
- Both published bases include current main/S16. S6's real source and emitted
  `presentation-views` modules are present. The new self-contained web
  typecheck supersedes the earlier temporary linked-source compatibility
  check; no source link or substitute declaration is used now.
- Original frozen S16-based S10 changes are preserved at
  `/Users/orcdev/projects/249-s10-backups/20261117-s6-reconcile/{desktop,web}`:
  exact files, original content manifests, tracked full-index binary patches,
  original tracked base files, untracked inventories and target bases.
  Original bases were desktop `5b340c09c50b8500c312a00634bdf122fc04855c` and
  web `78586c998d0ae15f5e7f82d81863edeac753b6ae`.
- All experimental source/test/generated files replay byte-for-byte. The only
  code reconciliation is the desktop dispatcher's additive `alpha-spike`
  routing beside S6/current-main cases. Web emitter merges additively beside
  `presentation-views`. Documentation now records the published stack.
- S6 guest graphics, S2 privacy, S3 auxiliary roles, S4 signed output tokens,
  S16 lifecycle and other current-main dispatcher cases are preserved.
  Guest graphics gives no alpha capability. S5 animation remains a separate
  sibling (PR1451/web133); its future seams remain untouched.
- S9 static and S13a camera contracts remain distinct from S10. No peer tree,
  unrelated sibling diff or central ledger was edited.

## Ownership and integration

S10 adds only experimental protocol/GPU modules, fixture publisher/consumer,
acquisition/analyzer and their pure tests. It allocates no live interval, show,
take or lifecycle identity and touches no production provider authority. Its
random show/epoch values are local fixture identities only. No production
role-reader or capability has been widened. S11 must wait for successful
local plus separately authorized managed evidence and integrate all role
readers and signed output-token capability/relay/receipt paths explicitly.

Only two existing files change: desktop `scripts/smoke-cloud-parity-app.mjs`
adds `alpha-spike`; web `lib/cloud/program/tools/emit.ts` emits three isolated
experimental modules. Preserve sibling case names and module entries. The committed S6
`presentation-views` dependency is now included in the base. No
package or lockfile changes, new dependencies, Rust changes, commits, pushes,
PRs, merges or deployments were made.

## Focused verification after S6 reconciliation

- Desktop Vitest: **9 passed**, alpha protocol and S6 presentation-view helpers.
- Web Node/tsx: **25 passed**, alpha protocol/GPU/receiver, S6 presentation views, media-v2
  and guest graphics. This is pure/fake coverage, with no real page or GPU.
- Node: **4 passed**, alpha analyzer budget vectors and fake ICE protocol tests. These
  never claim acquired media evidence and open no sockets or SFU.
- Desktop renderer TypeScript and **self-contained web TypeScript** pass.
  The earlier TS2307 for unpublished `presentation-views` is resolved by the
  real committed S6 module. No source-preview symlink is used.
- Scoped Oxlint/ESLint, Prettier, JavaScript syntax, source-mirror comparison,
  emitted-module check and diff whitespace checks pass.
- Fresh S6 Shadscan baseline/floor: desktop 27/27, web 47/47, ruleset
  2026.07.34. Final frozen-diff scores and exact test counts are recorded in
  the final report and logs. No commit checkpoint or score override was used.

Fresh evidence uses `/tmp/249-s10-s6-`: `desktop-tests.txt`, `web-tests.txt`,
`analyzer-tests.txt`, `desktop-tsc.txt`, `web-tsc.txt`, `desktop-lint.txt`,
`script-lint.txt`, `web-lint.txt`, `mirrors.txt`, `web-emit.txt`,
`{desktop,web}-format.txt`, `{desktop,web}-shadscan-{baseline,final}.json` and
`{desktop,web}-frozen-manifest.json`. Prior evidence remains at
`/tmp/249-s10-*`. Frozen manifests include exact branch, base, path list and
per-file SHA-256. Dependency links used only for installed tools are removed
before the final freeze. No acquisition manifest, recording, screenshot,
timing score, public broadcast or managed result was generated.

## Stable consumer helper seam for S13a

- Desktop `apps/desktop/src/shared/cloud-alpha-gpu.ts` mirrors web
  `lib/cloud/program/alpha-gpu.ts` (emitted as `alpha-gpu.js`).
  `createAlphaGpu(canvas, logicalWidth, logicalHeight, "unpack")` returns
  `draw(videoOrCanvas): boolean`, `close()`, `stats`, `renderer`, `measure(now)`.
  `draw` accepts exact packed dimensions only; one reusable texture and
  decode-driven submission remain the adapter's responsibility. Stats include
  `firstDrawAt`, `frames`, `drawMs`, `maxDrawMs`, `textureBytes`, `queuePeak`,
  `contextLost`, `closed`; draw time is CPU submission time, not GPU timing.
- Desktop `cloud-alpha.ts` / web `alpha-transport.ts` export `alphaDimensions`,
  `packedSize`, `packedUv`, `blendPixel` and the fixed packing limits. Logical
  dimensions, not packed video dimensions, feed S12 scene geometry. The GPU
  helper does no scene crop, fit, mirror, radius, mask, key or spill processing.
- These low-level helpers do **not** authorize a publication. S13a's separate
  `CAMERA_FRAME_CONTRACT` / `CameraFrameAuthority` must validate and bind the
  actual publication and native generation before using them. Never replace
  `AlphaManifest.rect`, change `ALPHA_ROLE`, cast camera metadata through
  `parseAlphaManifest`, or feed native microseconds into the fixture clock.
- `receiveAlphaExperiment` remains an S10 layer receiver, with its existing
  manifest/authority/lane/lease contract. A camera adapter requires its own
  validation and output/capability policy; it does not inherit layer authority.
- Packed camera mode and production alpha remain disabled and unqualified.
  S13a's adapter/mirror tests reconcile against the coordinator-published S10
  commit; no S13a code or public capability is introduced here.

## Deferred gates

The user explicitly prohibits every smoke, real-page/device/browser test,
heavy suite/build and managed/paid/provider call until after all merges on
main. Consequently `alpha-spike`, recording/preview/device smokes, WB, native
Electron publishing/capture, production rendering, managed egress/S27,
advisory/full suites and full builds were not run. The plan's measured S10
Done criterion is not satisfied. Source inspection and fake tests cannot
convert this into a qualified transport or authorize S11 enablement.

## Desktop PR-ready title/body (base S6)

Title: Plan 249 S10: add disabled packed-alpha publisher and acquisition harness

Body:

Add an isolated CAMERA-source packed RGB/alpha fixture publisher and bounded
WebGL helpers, plus the maintained `alpha-spike` acquisition and artifact
analyzer. The harness compares no-layer/alpha across clean/TCP-jitter cases,
six participants plus screen, independent H/V stream and late recorder views,
with a full 30-minute sample span per lane. It checks actual source grants,
SIDs/counts, decoded pixels, finished artifacts, memory, latency and frame
budgets. Missing or failed metrics never approve transport.

Production alpha remains disabled. No production grant, credential, provider
or role-reader changes. This is implementation for deferred measurement;
local and managed feasibility remain undecided. Pair with the web S10 PR;
base `feat/249-s6-cloud-parity` at `f27307cd97400b6933ac2324de3c6baffab5dfaf`
(PR1452). No issue URL was provided. Focused pure/static checks pass; live/heavy gates intentionally not
run under user instruction.

## Web PR-ready title/body (base S6)

Title: Plan 249 S10: add disabled GPU alpha consumer and acquisition fixture

Body:

Add isolated emitted packed-alpha protocol/GPU/receiver modules and an
acquisition-only LiveKit consumer. Validate explicit host/publication/epoch/
generation/output authority, keep allocation and queues bounded, contain the
layer with S6 geometry, and close on invalid frames, lease/owner change or GPU
loss. Add pure authority/pixel/grant/lifecycle and generated-source tests.

No production page imports alpha; media-v2/static graphics and guests do not
enable it. The local controller supplies fixture authority only. Source-count
support and managed performance are unmeasured, so production remains disabled
and S11 awaits qualification. Pair with desktop S10; base
`feat/249-s6-cloud-parity` at `b615c28b13997128c50edecae5d03f583a7cb32f`
(PR134). Focused tests and self-contained web TypeScript pass with the real S6
geometry module. Preserve S6 guest graphics without granting alpha capability.
No smoke, browser, managed or heavy gates were run.

## Exact paths in this repository

- `apps/desktop/src/renderer/src/lib/cloud-alpha-fixture.ts`
- `apps/desktop/src/renderer/src/lib/room-alpha-experiment.ts`
- `apps/desktop/src/shared/cloud-alpha-gpu.ts`
- `apps/desktop/src/shared/cloud-alpha.test.ts`
- `apps/desktop/src/shared/cloud-alpha.ts`
- `docs/acceptance/249-s10-alpha-feasibility.md`
- `docs/cloud/249-s10-handoff.md`
- `scripts/check-cloud-alpha-mirrors.mjs`
- `scripts/lib/cloud-alpha-analysis.mjs`
- `scripts/lib/cloud-alpha-analysis.test.mjs`
- `scripts/lib/cloud-alpha-network.mjs`
- `scripts/lib/cloud-alpha-network.test.mjs`
- `scripts/lib/cloud-parity-alpha.mjs`
- `scripts/smoke-cloud-parity-app.mjs`
