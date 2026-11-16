# Plan 249 combined S5 + S9 prerequisite merge

Both isolated merges are resolved and staged for the coordinator. No commit, push, PR creation, deployment, private memory write, or S24 implementation was performed. Original and peer worktrees were not modified. Historical S5/S9 handoffs describe their original publications; this document describes the combined checkpoint.

## Exact paired sources

Both branches are `integrate/249-s5-s9-prerequisite`. Keep `MERGE_HEAD` and create ordinary merge commits so S9 remains first parent and published S5 remains second parent.

| Repository | Worktree                                                      | HEAD / first parent (S9)                            | MERGE_HEAD / second parent (S5)                     |
| ---------- | ------------------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------- |
| Desktop    | `/Users/orcdev/projects/videorc-wt-249-s5-s9-prerequisite`    | `894810e69650ea71812d78efd6f0771216144836` (PR1454) | `3c5f004cbcad02e4d6f446cb2309c247a64349bf` (PR1451) |
| Web        | `/Users/orcdev/projects/videorcweb-wt-249-s5-s9-prerequisite` | `c419182892fda1aec058df86710cc425458b0f16` (PR136)  | `7935c3b69917f24470392582e99570192d551dec` (PR133)  |

The external frozen manifests `/tmp/249-s5-s9-desktop-checkpoint.json` and `/tmp/249-s5-s9-web-checkpoint.json` contain each exact index tree, ordered parents, branch, every staged path and its SHA256, and any deliberately resolved path unchanged from the first parent. They hash this handoff too; keeping them external avoids a self-referential tree/hash. Dependency symlinks (desktop root and apps/desktop, web root node_modules) are untracked local verification aids, excluded from publication.

## Resolution and behavior

- Combined S5 animation/atlas capability parsing with S9 static capability and applied observations. The web relay retains its S9 applied-only stripping, which already preserves animation; stale avatar and static acks are independently removed. Guest static claims stay stripped.
- Preserved S6 opt-in guest stream/h avatar lane, static guest fallback, Program preview labels/geometry and stage keys. Guests never join S5 motion coverage or S9 static delivery.
- Preserved S9 static roots/z-order/output ACLs and S5 animated Program avatar. Both static snapshots and motion are handled by the program consumer. Regenerated browser JavaScript from combined TypeScript; no generated conflict was resolved manually.
- Preserved all acquisition dispatch cases, including views, graphics and avatar-animation. Acquisition was not run.
- Added a conservative managed-card input bridge agreed directly with the S5 owner. `RoomAvatarPublisher.motionViews()` projects authorized EG lanes; `graphicsMotionCards()` accepts only a nonexpired highlight with stream AND recording enabled and current applied observations for every animated consumer of its orientation. The graphics publisher already fences observed revisions to the exact currently sent envelope, so different peers can legitimately acknowledge different revision numbers.
- Graphics status changes call the existing motion card hook. New unacknowledged content, expiry, clear, failure and reconnect remove the card input. Changes enter S5's existing fixed-tick event/flush path. Legacy sendOverlay card acceptance remains active only while managed graphics are off; switching ownership clears its remembered cards.
- No new motion fields: `cards: {h, v}` and one simulation per orientation remain unchanged. No S24 accepted callback or persistence was added; S24 still owns that seam after coordinator publication.

## Known limitation

A stream-only or recording-only managed highlight produces **no card gaze** for either consumer of that orientation. This is the agreed conservative limitation of one shared orientation simulation, not an output-specific card-gaze parity pass. A consumer lacking a current static applied receipt also prevents gaze for that orientation. Guests remain static.

## Focused evidence

- Desktop: 200 passed, one intentionally skipped fixture-writer case, across 16 affected test files (aggregate unique tests; follow-up runs replaced earlier versions). Includes pure animation/golden replay, static/avatar publishers, managed-card current-ack/expiry/clear/failure/reconnect integration, legacy path switching, guest fallback, hooks, monitor and protocol fixtures.
- Web: 86 passed across nine affected protocol/stage/source/overlay/guest tests; seven additional generated-bundle consistency/import tests passed. The unrelated historical stage-color assertion was outside this scoped run.
- Pure acquisition contract tests: 20 passed across graphics, views and registry contracts. Changed acquisition/dispatch scripts pass syntax checking; no acquisition was invoked.
- Desktop node and renderer TypeScript and web TypeScript passed. Scoped oxlint/ESLint and formatting passed; desktop retains the preexisting use-studio missing `recording` useMemo-dependency warning. Rustfmt passed on the three imported Rust files using edition 2024; no Rust compilation or tests ran.
- Exact S9 byte mirrors: cloud-avatar, cloud-graphics, cloud-graphics-view. S5 formatted mirrors: buddy-animator, cloud-avatar-atlas-meta, cloud-avatar-motion, cloud-avatar-view. Paired avatar/graphics/views and animator fixture JSON are byte-equal. The preexisting buddy-motion ports intentionally differ in source representation and are covered by the shared motion replay tests rather than a byte-mirror claim.
- Program emitter regenerated and `--check` passed. No dependencies or lockfiles changed. A pnpm exec attempt requested implicit installation and aborted before running; all focused checks used existing installed binaries directly afterward.
- Shadscan command: `pnpm dlx @shadscan/cli@next --json`, desktop apps/desktop and web root. Baseline/floor/final: desktop **27/27/27**, web **47/47/47**. Reports `/tmp/249-s5-s9-{desktop,web}-shadscan-{baseline,final}.json`. These are frozen-tree advisory audits, not commits; rerun if source changes before coordinator commit.

Logs: `/tmp/249-s5-s9-desktop-tests.log`, `web-tests.log`, `extra-tests.log`, `contract-tests.log`, and `bundle-tests.log` (all with the same `/tmp/249-s5-s9-` prefix). Follow-up bridge/type/lint checks also completed in the agent tool transcript.

## Deferred gates and next owner

Smoke, real pages, devices, managed/live qualification, heavy builds/suites, full Rust, provider calls and broad recording acceptance remain **not-run**, per explicit authorization limits. No runtime parity claim is made. Coordinator commits/pushes these paired merge checkpoints and sends the resulting tips to S24 (G1q9i). S24 can then add its accepted-envelope callback/persistence against the reconciled publishers. S15/S12 are not absorbed here.

Suggested merge titles: desktop `Merge S5 avatar animation with S9 static graphics`; web `Merge S5 program animation with S9 graphic snapshots`.
