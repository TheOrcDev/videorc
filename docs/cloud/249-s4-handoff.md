# Plan 249 S4 paired implementation handoff

Status: implementation complete; focused verification passed; live/managed
qualification **not-run**. No commit, push, issue, PR, merge or deployment was
performed. Coordinator owns publication. Central execution ledger untouched.

## Worktrees and prerequisites

- Desktop: `/Users/orcdev/projects/videorc-wt-249-s4`, branch `feat/249-s4-cloud-parity`, exact base `a93168fc46b8edc1b1fc6947562ea54e4c7b2be0`.
- Web: `/Users/orcdev/projects/videorcweb-wt-249-s4`, branch `feat/249-s4-cloud-parity`, exact base `a68454e065e6e331e863e67b7d801bd69e2d24ee`.

Initial worktrees were based on S2 and then reconciled onto the committed S3
prerequisites above. S3 desktop PR1440 and web PR126 are fully incorporated as
bases; there is no outstanding S3 interface stub. The existing v2 media parser,
receipt topic and server relay carry an independent optional `graphics`
extension. S2 privacy and S3 auxiliary behavior remain in place.

No new dependencies or lockfile changes. Untracked `node_modules` entries are
local symlinks used for verification, **not deliverables; do not stage them**.
Desktop has root and `apps/desktop/node_modules` links to S3 dependencies; web
has a root link to the existing web S2 dependency tree. A desktop reconciliation
stash remains as backup; do not blindly pop or delete shared stash references.

Source skill and src detection were completed before any forge lookup: neither
repository was found on TanStack Source. No forge mutation was performed.
Videorc design, shadcn and Shadscan instructions were applied.

## Delivered behavior

- Room avatar defaults off and enables separately from soundboard audio.
- Public character and bubble pixels use bounded PNG layers, per-orientation
  normalized geometry, immutable SHA256 assets, a 30-second maximum lease,
  expiring bubbles and monotonic revisions fenced to the current host SID.
- Existing Alive packs provide the static neutral cell; Still packs provide
  the current public state image. Deterministic full motion belongs to S5.
- Program and local Program preview share the same receiver and raster view.
  Local preview is never claimed as egress output or managed qualification.
- Delivery targets only explicitly capable EG consumers. A signed output claim,
  current egress identity/SID and token orientation authorize each graphics lane.
  Legacy/shared-output tokens keep existing health/audio but cannot authorize
  independent graphics. Guests receive no S4 pixels.
- Private Sidekick persona fields, prompts, local paths and arbitrary URLs do
  not cross the room. Only locally rasterized public avatar/bubble pixels do.
- Clear defeats pending decode/upload; owner changes, expiry, room loss and
  failed paint clear state/resources. Applied observations follow two frame
  callbacks and cannot turn local preview into output evidence.
- Renderer-only applied-output reports gate bubble-only AI admission on fresh,
  enabled, running output. Hide/observation changes report immediately; reports
  refresh every five seconds and expire after fifteen seconds. Chat-capable
  behavior and native/local visibility remain under existing rules.
- Maintained `--case avatar` acceptance exercises preview before egress, separate
  stream/recording artifacts, hide/expiry, host camera off, guest spotlight,
  output visibility switches, reload and decode failure/recovery. It is
  implemented and syntax-checked, not executed.

## Downstream ownership

See `249-s4-contract.md`. S5 and S6 received stable seams directly through
Ghostex. S5 adds optional animation capability, atlas metadata and bounded motion
updates while preserving static fallback and receiver leases. S6 preserves
`ProgramAvatar` as a frame sibling, owns monitor header/stage beacon changes,
and must add explicit consent and an authorized guest lane to the existing
parsers/publisher/relay before any guest graphics. No competing negotiation or
placeholder capability was introduced.

## Focused verification

- Desktop: 162 tests passed across seven focused files (`cloud-avatar`,
  `protocol-contract-fixtures`, `room-avatar-publisher`, `talk-show-room`,
  `use-talk-show-room-join`, `buddy-overlay`, `show-stage`). The hook's 14 tests
  passed again after its final immediate-observation dependency change.
- Desktop: TS node and renderer checks passed using direct TypeScript binaries;
  renderer check repeated after the final hook change. Scoped oxlint passed
  with the pre-existing unrelated missing `recording` useMemo dependency warning
  in `use-studio.tsx`. Scoped Prettier check passed.
- Web: 66 focused tests passed (`cloud-avatar`, `cloud-room-media-v2`,
  `cloud-program-overlays`, `cloud-program-source`, `cloud-program-stage`).
  Four emitted-bundle consistency/import checks passed; emitter `--check` passed.
  TypeScript, scoped ESLint and scoped Prettier checks passed.
- Scripts: 14 parity registry/media tests passed. All four changed acceptance
  scripts passed `node --check`; none ran a real page or device.
- Rust: scoped `rustfmt --check --edition 2024 --config skip_children=true`
  passed for all three changed Rust files. No Rust compilation/test was run.
  The new admission truth-table test remains maintained but unexecuted.
- Both trees passed `git diff --check`. Mirrored contract/view sources and tiny
  shared fixture were checked for semantic/generated consistency.

Lightweight evidence remains in `/tmp/249-s4-*`: `desktop-tests-final.txt`,
`web-tests-final.txt`, `hook-final.txt`, `bundle-tests-final.txt`,
`script-tests-final.txt`, `{desktop,web}-lint-final.txt`,
`{desktop,web}-format-final.txt` and the Shadscan/manifest JSON files below.

## Existing unrelated failure

The earlier full web bundle test run hit the existing `.tile-dim` CSS assertion
at `tests/cloud-program-bundle.test.ts:339`, expecting opacity `0.453125` in
`public/cloud/program/v1/program.css`. That CSS is unchanged from S3: both the
working file and S3 git blob are `d88a0cce468d5d8a7201df45410cc0e2fad5fe59`.
Relevant source/generated consistency checks pass. No unrelated CSS change
was made, and the full bundle suite is not claimed green.

## Deferred gates

Per explicit user instruction, no smoke, real-page/device gate, heavy suite,
heavy build, provider call or managed/live qualification ran. After all merges
on main, the user will run the plan's acceptance and broader regression gates:
`pnpm smoke:cloud-parity -- --case avatar`, `pnpm smoke:buddy-pet`, applicable
recording/program/device checks, broader Rust/desktop/web suites and managed
stream/recording artifact qualification. S4 is not production-qualified on the
basis of lightweight tests or frame callbacks alone.

## Final Shadscan and frozen implementation

Same command as baseline: `pnpm dlx @shadscan/cli@next --json`. Desktop ran from
`apps/desktop`; web ran from its root. No dependency/config changes or auto-fix.

| Repository | Baseline | Floor | Final |
| ---------- | -------: | ----: | ----: |
| Desktop    |       27 |    27 |    27 |
| Web        |       47 |    47 |    47 |

Both final audits passed their floors on the frozen implementation. No commit
was created: this is an advisory handoff audit; coordinator should repeat the
required audit immediately before its commit. JSON outputs are
`/tmp/249-s4-{desktop,web}-shadscan-{baseline,final}.json`.

Content manifests include exact base, branch, paths and SHA256 per file,
excluding dependency symlinks and this self-referential handoff document:

- Desktop: `/tmp/249-s4-desktop-frozen.json`; implementation SHA256 `2a54cf182df757daeee11b972024a0e9b64baefeef1db095a90e5a82575bc3eb`.
- Web: `/tmp/249-s4-web-frozen.json`; implementation SHA256 `ed91b3e256a3f19fd1a1fa20095ed18f725de6c84eb302a63830f8a926fd7d00`.

## PR-ready desktop text

Title: `feat(cloud): publish opt-in avatar and bubble presentation (249 S4)`

Body:

Cloud rooms previously omitted the Avatar character and Say bubble from managed
program output. Add an independently enabled public raster presentation, using
the same revision/lease-aware renderer in Program preview and the paired web
consumer. Still state images and Alive neutral cells carry bounded hashed PNGs;
per-output visibility, expiry, clear and current-host fencing prevent stale
presentation. Private Sidekick configuration never leaves the desktop.

Extend S3's existing capability receipts with explicit graphics support and
record actual applied outputs separately from preview. Gate bubble-only AI work
on fresh enabled/running output observations. Preserve S2 privacy and S3 audio.
Depends on desktop PR1440 and the paired S4 web change; full animation is S5.

Validation: 162 focused desktop tests, 14 parity logic tests, scoped TypeScript,
lint/format and Rust format passed; final hook tests passed again. Shadscan
27/27/27 (baseline/floor/final). Avatar acceptance maintained but not run.
No smoke, real-page/device, Rust compile/test, heavy build or managed
qualification ran, as requested. User runs deferred gates after all merges.

## PR-ready web text

Title: `feat(cloud): render authorized avatar presentation in program (249 S4)`

Body:

Render the host's bounded public character/bubble layers on the whole cloud
program, independent of host-camera tiles. Validate current host SID, output,
orientation, lease, revision and hashed PNG bounds; clear stale, expired or failed
presentation. Acknowledge applied pixels separately from local preview.

Extend S3 media capability parsing/relay with optional graphics support, certified
only for the current egress lane using a signed page-token output claim. Legacy
and shared-output tokens keep existing health/audio behavior without granting
independent graphics. Regenerate committed program modules. Depends on web PR126
and the paired S4 desktop change. Guest projection and full animation remain S6/S5.

Validation: 66 focused tests, four generated consistency/import checks, emitter
check, TypeScript and scoped ESLint/format passed. Shadscan 47/47/47. The existing
full bundle CSS assertion fails against unchanged S3 CSS; documented above.
No smoke, real-page/device, heavy build or managed qualification ran, as requested.

## Exact publication paths

Only the following files are deliverables; no `node_modules` entry belongs in
the publication. Lists are relative to the corresponding worktree.

### Desktop

- `apps/desktop/src/renderer/src/components/studio/show-stage.test.ts`
- `apps/desktop/src/renderer/src/components/studio/show-stage.tsx`
- `apps/desktop/src/renderer/src/hooks/use-studio.tsx`
- `apps/desktop/src/renderer/src/hooks/use-talk-show-room.ts`
- `apps/desktop/src/renderer/src/lib/buddy-overlay.ts`
- `apps/desktop/src/renderer/src/lib/room-avatar-publisher.test.ts`
- `apps/desktop/src/renderer/src/lib/room-avatar-publisher.ts`
- `apps/desktop/src/renderer/src/lib/room-media-v2.ts`
- `apps/desktop/src/renderer/src/lib/talk-show-context.ts`
- `apps/desktop/src/renderer/src/lib/talk-show-room.ts`
- `apps/desktop/src/shared/backend-rpc-contract.ts`
- `apps/desktop/src/shared/cloud-avatar-view.ts`
- `apps/desktop/src/shared/cloud-avatar.test.ts`
- `apps/desktop/src/shared/cloud-avatar.ts`
- `crates/videorc-backend/src/buddy_overlay.rs`
- `crates/videorc-backend/src/cloud_talk.rs`
- `crates/videorc-backend/src/main.rs`
- `docs/cloud/249-s4-contract.md`
- `docs/cloud/249-s4-handoff.md`
- `protocol-fixtures/cloud-parity-avatar.json`
- `scripts/lib/cloud-parity-avatar.mjs`
- `scripts/lib/cloud-parity-baseline.mjs`
- `scripts/lib/cloud-parity-browser.mjs`
- `scripts/smoke-cloud-parity-app.mjs`

### Web

- `docs/cloud/249-s4-contract.md`
- `docs/cloud/249-s4-handoff.md`
- `lib/cloud/media/destinations.ts`
- `lib/cloud/media/page-token.ts`
- `lib/cloud/media/recording.ts`
- `lib/cloud/program-route.ts`
- `lib/cloud/program/cloud-avatar-view.ts`
- `lib/cloud/program/cloud-avatar.ts`
- `lib/cloud/program/main.ts`
- `lib/cloud/program/overlays.ts`
- `lib/cloud/program/room-media-v2.ts`
- `lib/cloud/program/source.ts`
- `lib/cloud/program/stage.ts`
- `lib/cloud/program/tools/emit.ts`
- `lib/cloud/room-media-relay.ts`
- `public/cloud/program/v1/cloud-avatar-view.js`
- `public/cloud/program/v1/cloud-avatar.js`
- `public/cloud/program/v1/main.js`
- `public/cloud/program/v1/overlays.js`
- `public/cloud/program/v1/room-media-v2.js`
- `public/cloud/program/v1/source.js`
- `public/cloud/program/v1/stage.js`
- `tests/cloud-avatar.test.ts`
- `tests/cloud-program-source.test.ts`
- `tests/fixtures/cloud-parity-avatar.json`
