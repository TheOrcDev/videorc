# Plan 249 S9 paired integration handoff

Status: implementation reconciled onto the exact published S6 prerequisites; focused checks passed; ready for coordinator commit/push/paired PR creation. Live/managed qualification remains **not-run**. No commit, push, PR, issue, merge or deployment was performed. No private memory writes, central execution ledger edits, or modifications to other agents' trees.

## Exact publication source and bases

| Repository | Integration worktree | Local branch | Exact base | PR base |
| --- | --- | --- | --- | --- |
| Desktop | `/Users/orcdev/projects/videorc-wt-249-s9-integration` | `integrate/249-s9-s6-reconcile` | `f27307cd97400b6933ac2324de3c6baffab5dfaf` | `feat/249-s6-cloud-parity` ([PR1452](https://github.com/TheOrcDev/videorc/pull/1452)) |
| Web | `/Users/orcdev/projects/videorcweb-wt-249-s9-integration` | `integrate/249-s9-s6-reconcile` | `b615c28b13997128c50edecae5d03f583a7cb32f` | `feat/249-s6-cloud-parity` ([PR134](https://github.com/TheOrcDev/videorc-web/pull/134)) |

Use these integration trees as the publication source. Original `/Users/orcdev/projects/videorc-wt-249-s9` and `/Users/orcdev/projects/videorcweb-wt-249-s9`, both local `feat/249-s9-cloud-parity`, remain untouched frozen backups on S4 (`6a142e9361f2eccb52c85762e3ecf6c4adcdf18c` / `9f7082594fcbb2c0c31cae98dc2b71609c08e677`). Their original source/fixture/generated hashes were reverified. Do not accidentally publish the stale originals or use the stale local S6 branches.

All three untracked dependency links (desktop root, desktop apps/desktop, web root node_modules) point to existing installed dependencies; they are not deliverables. Nothing is staged and no dependencies/lockfiles were changed. Source skill/detection was completed before forge lookup; neither repository was found on TanStack Source. Design/shadcn and Shadscan instructions were applied.

## Reconciliation

The replay starts directly at the exact published S6 commits, including their merged main dependencies (S16/S18/S20/S21a/S7a/emotes). Five desktop conflicts were combined: monitor guest/status rows, development fixture hooks, main module registration, and the baseline/entrypoint acceptance dispatch. Existing S6 view/guest cases and other published microphone/services/replay/lifecycle cases remain intact. Web source changes applied cleanly; emitted files were regenerated/checked.

S6 guest-avatar controls, guest stream/h capability, receiver, Program preview badge/geometry and stage key remain intact. S9 static delivery remains EG-only: the server relay removes a guest's claimed static extension while retaining its authorized avatar capability, and the publisher independently refuses guest targeting. Focused regressions cover both boundaries. Stage acknowledgement and per-egress static applied revision remain independent.

S5 was not absorbed. Its separate commits are desktop `3c5f004cbcad02e4d6f446cb2309c247a64349bf` and web `7935c3b69917f24470392582e99570192d551dec`. Static parsing is additive to the avatar capability; the relay strips only stale avatar `applied`, retaining other sanitized capability fields so S5 animation can coexist when merged. Static applied observations are fenced separately. S12 scene and S15 caption extensions were discussed directly; their future layer/capability changes are not invented here.

## Delivered behavior

- Opt-in public static PNG snapshots carry native image banners, curated chat and normal/milestone highlight cards to program output and preview.
- Native normalized placement, fixed-card overlap ownership, straight alpha, opacity, 200 ms absolute fades, per-output switches, and output-session facts are preserved. Recording-only output activates timers/chat painting.
- Targeted delivery uses S3/S4 signed-lane/current-SID capability receipts. No HTML executes, no private Sidekick state or source paths travel, and no dynamic-alpha capability is inferred.
- Source preparation is single-flight; decodes retain one latest pending snapshot. Clear, room/owner generation changes, expiry and paint failure fence stale work and release resources. Actual applied observations follow paint, not merely send/parse.
- Managed cards use the targeted static path so legacy broadcast cannot bypass consent/output flags. Rich chat fragments remain intact through the existing raster painters.
- Maintained `--case graphics` acquisition uses actual desktop RPCs/painters/publishers and four emitted stream/recording H/V pages. It imports authorized fixtures, checks alpha/opacity/z-order/native positions/overlapping card pixels/fade times/timer phases/chat/emotes/output switches, reloads for late join, stalls decode against clear, and analyzes finalized videos. It is authored, not executed.

Full interface and bounds: `249-s9-contract.md` in both trees. No remaining prerequisite integration is blocked.

## Refreshed focused evidence

- Desktop: **161 tests**, nine files: cloud-graphics, cloud-avatar, cloud-presentation-views, protocol-contract-fixtures, room-graphics-publisher, room-avatar-publisher, talk-show-room, use-talk-show-room-join, show-stage. Log `/tmp/249-s9-integration-desktop-tests.txt`.
- Web: **74 tests**, seven files: cloud-graphics, cloud-avatar, cloud-room-media-v2, cloud-program-overlays, cloud-program-stage, cloud-program-source, guest-graphics. Log `/tmp/249-s9-integration-web-tests.txt`.
- Pure scripts: **20 tests** across cloud-parity-graphics-contract, cloud-parity-contract and cloud-parity-views-contract. Changed acquisition/dispatch modules pass `node --check`.
- Desktop node/renderer TypeScript and web TypeScript pass. Existing installed binaries were used directly; no install was performed.
- Scoped oxlint/ESLint pass. Desktop retains the inherited use-studio.tsx missing `recording` useMemo-dependency warning (currently line19886).
- Scoped Prettier and Rustfmt pass. Main Rust format parsing uses skip_children=true; no Rust compile was run.
- Shared avatar/static modules and graphics fixture are byte-identical across repositories. Mirrors use desktop formatting; other web files use web formatting.
- Web emitter write/check and both git whitespace checks pass.

## Deferred gates

Smoke, real-page/device/native capture, heavy suites/builds, full Rust compilation/tests/clippy, provider calls and managed egress qualification were **not-run**, per explicit instruction. The maintained graphics acquisition was not invoked. Post-merge acceptance still requires Plan249 S9 broad gates, `pnpm smoke:cloud-parity -- --case graphics`, `pnpm smoke:banners`, relevant recording-studio gates and separately authorized managed checks. No acceptance evidence was fabricated from focused tests.

## Frozen Shadscan

Command: `pnpm dlx @shadscan/cli@next --json` in desktop apps/desktop and web root. On the S6 integration bases, baseline/floor/final: desktop **27/27/27**, web **47/47/47**. JSON files `/tmp/249-s9-integration-{desktop,web}-shadscan-{baseline,final}.json`. No commit created; these are final advisory audits. Coordinator should rerun immediately before committing if the tree changes.

## Prepared paired PR metadata

Both PR bases: `feat/249-s6-cloud-parity` at the exact commits above. The local integration branches contain the complete working diffs for coordinator publication; the original feat/249-s9 branches are backups.

Desktop title: **feat: carry opt-in static graphics into cloud outputs**

Desktop body:

> Image banners, chat boxes and highlight/milestone cards previously relied on native or legacy broadcast paths that could not preserve independent managed output visibility. Add an opt-in bounded raster publisher using existing capability receipts, native placement/fades and stream/recording switches. Timers and chat painting follow live or recording-only room facts; current snapshots survive late join while clear, owner changes and lifecycle generations defeat pending work.
>
> Includes public source RPC, preview layers and maintained graphics acquisition. Preserves S6 guest avatar support while restricting static pixels to authorized egress lanes. Validation: 161 focused desktop tests, 20 pure contract tests, TypeScript, scoped lint/format and paired asset consistency. Smoke/device/managed/heavy/Rust compile gates are intentionally not run. Paired web implementation required; stack on S6 PR1452. Production qualification remains not-run.

Web title: **feat: render authorized static graphic snapshots in cloud program**

Web body:

> Render opted-in banner/chat/card snapshots only for the token-authorized EG output/orientation. Extend the existing graphics capability with an independent static applied revision, validate immutable bounded PNGs, and coalesce decoding so clear and newer state defeat pending work. Preserve native ordering around avatar and suppress the bypassing legacy card path after a validated static snapshot.
>
> Keeps S6 guest avatar rendering intact while removing guest static capability claims; no guest static pixels or dynamic-alpha grant is introduced. Includes generated program assets and protocol/lifecycle/relay coverage. Validation: 74 focused web tests, TypeScript, scoped lint/format and emitted-asset consistency. Real-page/managed/smoke/heavy gates intentionally not run. Paired desktop publisher required; stack on S6 PR134. Production qualification remains not-run.

## YouTube emote compatibility

PR1445 commit e0d2fd738 is in the published main lineage beneath S6; no separate cherry-pick was performed. S9 leaves youtube_chat.rs/comment-row.tsx unchanged, retains rich fragments through the existing painters and preserves the youtube_emotes module registration in main.rs alongside the additive cloud_graphics registration. Member custom aliases remain text under that fix.

## Frozen inventory

`docs/cloud/249-s9-manifest.json` in each integration tree identifies its exact branch/base and SHA256 for every changed source, fixture, generated asset and contract. The handoff and manifest are listed but excluded from their own digest map to avoid self-reference. Dependency symlinks are excluded. Full paths follow.

### Desktop

- `apps/desktop/src/renderer/src/components/studio/show-stage.tsx`
- `apps/desktop/src/renderer/src/hooks/use-studio.tsx`
- `apps/desktop/src/renderer/src/hooks/use-talk-show-room-join.test.ts`
- `apps/desktop/src/renderer/src/hooks/use-talk-show-room.ts`
- `apps/desktop/src/renderer/src/lib/room-graphics-publisher.test.ts`
- `apps/desktop/src/renderer/src/lib/room-graphics-publisher.ts`
- `apps/desktop/src/renderer/src/lib/talk-show-context.ts`
- `apps/desktop/src/renderer/src/lib/talk-show-room.ts`
- `apps/desktop/src/shared/backend-rpc-contract.ts`
- `apps/desktop/src/shared/cloud-avatar.ts`
- `apps/desktop/src/shared/cloud-graphics-view.ts`
- `apps/desktop/src/shared/cloud-graphics.test.ts`
- `apps/desktop/src/shared/cloud-graphics.ts`
- `crates/videorc-backend/src/banner_timers.rs`
- `crates/videorc-backend/src/chat_overlay.rs`
- `crates/videorc-backend/src/cloud_graphics.rs`
- `crates/videorc-backend/src/comment_highlight.rs`
- `crates/videorc-backend/src/compositor.rs`
- `crates/videorc-backend/src/main.rs`
- `crates/videorc-backend/src/state.rs`
- `docs/cloud/249-s9-contract.md`
- `docs/cloud/249-s9-handoff.md`
- `docs/cloud/249-s9-manifest.json`
- `protocol-fixtures/cloud-parity-graphics.json`
- `scripts/lib/cloud-parity-baseline.mjs`
- `scripts/lib/cloud-parity-browser.mjs`
- `scripts/lib/cloud-parity-graphics-contract.mjs`
- `scripts/lib/cloud-parity-graphics-contract.test.mjs`
- `scripts/lib/cloud-parity-graphics.mjs`
- `scripts/smoke-cloud-parity-app.mjs`

### Web

- `docs/cloud/249-s9-contract.md`
- `docs/cloud/249-s9-handoff.md`
- `docs/cloud/249-s9-manifest.json`
- `lib/cloud/program/cloud-avatar.ts`
- `lib/cloud/program/cloud-graphics-view.ts`
- `lib/cloud/program/cloud-graphics.ts`
- `lib/cloud/program/overlays.ts`
- `lib/cloud/program/source.ts`
- `lib/cloud/program/stage.ts`
- `lib/cloud/program/tools/emit.ts`
- `lib/cloud/room-media-relay.ts`
- `public/cloud/program/v1/cloud-avatar.js`
- `public/cloud/program/v1/cloud-graphics-view.js`
- `public/cloud/program/v1/cloud-graphics.js`
- `public/cloud/program/v1/overlays.js`
- `public/cloud/program/v1/source.js`
- `public/cloud/program/v1/stage.js`
- `tests/cloud-graphics.test.ts`
- `tests/cloud-program-source.test.ts`
- `tests/fixtures/cloud-parity-graphics.json`

