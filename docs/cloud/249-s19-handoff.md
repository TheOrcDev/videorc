# S19 source handoff — show timeline markers

This is an uncommitted source checkpoint, not runtime qualification. The coordinator owns commits, pushes, PRs and integration. No commit, push, PR, deployment, provider call, credential access or real database migration was performed.

## Behavior

Cloud manual/voice markers and clip marks persist in an account-owned server journal; native marker/file behavior stays native. The show coordinate is server acceptance minus show.createdAt. It never treats the S13a native anchor, processed PCM offsets, live interval start or take/provider identifiers as an extractable media range. Record-only has no fabricated live interval. Lost replies recover the original operation; tombstones block replay resurrection. Room expiry blocks new marks but retains saved metadata while its show row remains.

Desktop Studio/Comments, clip shortcut/remote and allowlisted agent paths select the real output owner. Library exposes show moments without inventing a local file; copy says “Marker saved on the show timeline; no media to extract.” Voice marks consume only S15's processed host source, carry admitted consent epochs, and retire on mute/source/controller loss. Controller loss latches a requirement to turn listening off/on again.

Web uses a bounded 2000-entry JSON journal, revision CAS with eight attempts, 4KiB request bound, owner authentication, canonical operation hashing and 60/minute request limiter. S24 withControllerCommand covers POST/DELETE through the write; GET remains owner-readable after handoff. SourcePosition uncertainty remains null. Measured segment mapping is a guarded helper; **no qualified production mapping supplier exists**, so production receipts never report extractable media.

## Dependency reconciliation

Both final integration trees start exactly at committed S24 (it contains S15/S9/S7b and previous merged work). The original S15-based S19 trees remain untouched backups after reconciliation. Additional backups: `/tmp/249-s19-before-s24-videorc/` and `/tmp/249-s19-before-s24-videorcweb/` (tracked.patch, untracked.tar, base.txt, apply.log). No pending merge/rebase or staged changes. Shared/peer checkouts were not modified.

Resolved three desktop patch intersections by retaining both implementations: S21c Library archive and S19 markers; all baseline acquisition dispatch lanes; archive/controller fake hooks plus marker handler. Published S24 source watch, synchronous S15 admission/send gate and epoch header are preserved. S19 adds ownership_allows for writes and retires the marker consent grant on loss. The web tests cover stale/missing epochs and takeover between the fence read and command reservation.

Published S13a inspected at desktop `3e42ca9af06fbff8f646b58823b6c29405e92e43`; its native monotonic incarnation/origin are explicitly **not a show clock**. No copied clock implementation or unresolved clock-code dependency. S13a physical/source-to-show mapping remains unmeasured. S22's optional ISO schema/0042 and Library additions are independent, with ordinary additive reconciliation needed when those branches combine.

## Focused evidence

- Desktop: 51 tests in cloud-markers, session-markers, marker-command, studio-actions/remote, agent-tools and clip-marks.
- Web: 16 marker model/route/controller/CAS/clock projection tests; 12 existing migration-runner fixture tests. Migration checks are fake-client/source checks, **not PostgreSQL migration execution**.
- Scripts: 12 marker analyzer and parity-registry tests. Analyzer fixtures do not count as acquired evidence.
- Desktop renderer/shared and main/preload TypeScript checks passed; web TypeScript check passed. Scoped Rust format/parse checks passed; no Rust compilation or Rust tests ran.
- Web scoped ESLint passed. Desktop scoped oxlint reports two inherited findings reproduced on exact S24 base: `scripts/lib/fake-cloud-web-managed.mjs:58` no-control-regex; use-studio existing stopConfirmation useMemo exhaustive-deps (`recording`). Neither was suppressed or changed. Logs `/tmp/249-s19-desktop-lint{,-base}.log`.
- Node syntax checks cover maintained acquisition, baseline dispatcher and managed fake. Web program source/generated assets are unchanged from S24; no asset generation needed.
- Final audit protocol: Shadscan original baseline/floor **desktop 27/27, web 47/47**. Run `pnpm dlx @shadscan/cli@next --json` in desktop apps/desktop and web root. Final numeric scores are in `/tmp/249-s19-{desktop,web}-shadscan-final.json` and coordinator report, obtained after this diff is frozen. This is an advisory commit-ready checkpoint; no agent commit.

## Deferred acceptance and limits

Do not run until coordinator authorizes the deferred suite: `pnpm smoke:cloud-parity -- --case markers` with a clean installed matching web checkout and prebuilt app/backend. It drives the real Comments composer, authenticated remote and agent requests, processed host tap against the fake speech gateway, real room reconnect, End/Go Live, record-only and successor computer against the actual web marker handler with injected journal/controller stores. It is authored and **not-run**. Local IDs/intervals/egress identities in the fake are explicitly fixture state, never managed artifacts. No smoke, real-page, physical device, managed/provider, paid STT/model, heavy build, full Rust, live SQL, or final recording artifact analysis was executed.

Native-to-show timing, precise utterance-to-media alignment, and extraction stay unavailable. No recording/replay is implicitly activated. Runtime qualification and all production parity flags remain false. The ledger distinguishes 18 merged source slice checkpoints, 4 open-PR slices S13a/S17/S22/S24, and 10 unpublished; viewer totals W4 (#1458/web#139) is separate from S25. This checkpoint does not complete Plan 249.

## Publication

No dedicated S19 issue URL is known; ledger issue fields remain null. Link the paired PRs to each other, Plan249, S15 #1456/web#138 and direct S24 prerequisite #1461/web#142. Do not close an invented issue. Preserve all earlier stack branches.

Worktree: `/Users/orcdev/projects/videorc-wt-249-s19-integration`. Branch: `integrate/249-s19-s24-reconcile`. HEAD/base: `7c2e0ed519417a4132c6670a982907d4b80b1ddd`. Intended PR base: **publish/249-s24-on-main**. Parent commit is exactly HEAD (uncommitted diff); index empty, no merge parents/state. Peer tree: `/Users/orcdev/projects/videorcweb-wt-249-s19-integration`.

Dependency-only symlinks `node_modules` (and desktop `apps/desktop/node_modules`) are untracked and **must not be staged**. All intentional diff paths are below and in the manifest.

### PR title

Plan 249 S19: route show markers through Studio, remote and host voice

### PR body

Cloud rooms can now save markers without a fabricated local recording. Marks retain a server show timeline, stable retry identity, author/source and distinct live-interval/take/provider associations. Recording association does not imply an extractable media range; the UI and agent receipt say that no media is available to extract.

Connects real UI/remote/agent paths and S15 host voice, adds a show marker list in Library, and retains consent/source/ownership cancellation. Includes runnable maintained acquisition and updated Plan249 source/publication ledger.

Stacked on S24 #1461/web#142. Paired S19 PR link: coordinator to insert after publication. Focused tests and TypeScript checks pass; desktop scoped lint retains the two documented base findings. Runtime/media/database acceptance and Rust compilation remain not-run by instruction; this PR does not qualify production parity or enable media extraction.

### Exact paths

- `apps/desktop/src/renderer/comments/main.tsx`
- `apps/desktop/src/renderer/src/components/cloud-markers-dialog.tsx`
- `apps/desktop/src/renderer/src/components/stream-manager/chat-pane.tsx`
- `apps/desktop/src/renderer/src/components/stream-manager/stream-manager.tsx`
- `apps/desktop/src/renderer/src/components/tabs/library-cloud-recordings.tsx`
- `apps/desktop/src/renderer/src/hooks/use-studio.tsx`
- `apps/desktop/src/renderer/src/lib/marker-command.test.ts`
- `apps/desktop/src/renderer/src/lib/marker-command.ts`
- `apps/desktop/src/renderer/src/lib/marker-toast.ts`
- `apps/desktop/src/renderer/src/lib/studio-actions/clips.ts`
- `apps/desktop/src/renderer/src/lib/studio-actions/context.ts`
- `apps/desktop/src/renderer/src/lib/studio-actions/remote.ts`
- `apps/desktop/src/renderer/src/lib/studio-actions/studio-context.ts`
- `apps/desktop/src/shared/backend-rpc-contract.ts`
- `apps/desktop/src/shared/backend.ts`
- `apps/desktop/src/shared/clip-marks.ts`
- `apps/desktop/src/shared/cloud-markers.test.ts`
- `apps/desktop/src/shared/cloud-markers.ts`
- `apps/desktop/src/shared/session-markers.ts`
- `crates/videorc-backend/src/agent_call.rs`
- `crates/videorc-backend/src/agent_look.rs`
- `crates/videorc-backend/src/captions.rs`
- `crates/videorc-backend/src/captions/cloud_host.rs`
- `crates/videorc-backend/src/cloud_markers.rs`
- `crates/videorc-backend/src/main.rs`
- `crates/videorc-backend/src/videorc_api.rs`
- `docs/cloud/249-execution-ledger.md`
- `docs/cloud/249-s19-contract.md`
- `docs/cloud/249-s19-handoff.md`
- `docs/cloud/249-s19-manifest.json`
- `protocol-fixtures/agent-tools.json`
- `protocol-fixtures/cloud-parity-inventory.json`
- `protocol-fixtures/cloud-parity-plan.json`
- `scripts/lib/cloud-parity-baseline.mjs`
- `scripts/lib/cloud-parity-markers-contract.mjs`
- `scripts/lib/cloud-parity-markers-contract.test.mjs`
- `scripts/lib/cloud-parity-markers.mjs`
- `scripts/lib/fake-cloud-web-managed.mjs`
- `scripts/smoke-cloud-parity-app.mjs`
