# Plan 249 S16 implementation handoff

## Delivery state

Implementation is complete in the isolated, uncommitted paired worktrees below. Coordinator owns commits, publication and integration. No commits, pushes, PR creation, merges, deploys, credential access, paid calls or real provider broadcasts occurred. S3/S18/S20 trees and central ledger were not edited. No tasks beyond S16 were absorbed.

| Repository | Worktree | Branch | Exact HEAD/base |
| --- | --- | --- | --- |
| Desktop | `/Users/orcdev/projects/videorc-wt-249-s16` | `feat/249-s16-cloud-parity` | `6a142e9361f2eccb52c85762e3ecf6c4adcdf18c` |
| Web | `/Users/orcdev/projects/videorcweb-wt-249-s16` | `feat/249-s16-cloud-parity` | `9f7082594fcbb2c0c31cae98dc2b71609c08e677` |

Both bases are the published S4 tips ([desktop PR1441](https://github.com/TheOrcDev/videorc/pull/1441), [web PR127](https://github.com/TheOrcDev/videorc-web/pull/127)), including S2 privacy and S3 auxiliary audio. S1 PR1438/`0f9790f86` remains the declared semantic dependency. Provider authority is independent of media-v2/graphics. S18/S20 are not absorbed; there are no S16 committed tips yet. Coordinator should publish this S4 → S16 stack before handing paired S16 tips to those owners.

Original frozen S2-based changes are preserved, with exact files, SHA256 manifests, full-index binary patches, original bases and untracked-file lists, under `/Users/orcdev/projects/249-s16-backups/20261116-s4-reconcile/{desktop,web}`. The replay has the same 18 changed paths per repository. All original S16 added/removed source lines replayed unchanged except the acceptance dispatcher now preserves `soundboard` and `avatar` beside `lifecycle`, and the single `mod provider_output` declaration was placed in rustfmt order. Contract/handoff documents now describe the S4 bases. Shared hooks/types/media changes applied cleanly; existing S3/S4 consent, privacy generations, graphics authorization, and signed output-token behavior remain in the base. No other worktree or central ledger was changed.

## Behavior

- Scheduled YouTube/X activation accepts the exact owned cloud destination, waits on actual output/provider ingest with bounded retries, and rechecks ownership before activation. Existing title/description/tags/privacy/thumbnail preparation stays intact.
- Room Go Live bypasses native encoder/caption readiness gates. Local output behavior remains supported.
- Explicit stream End and room close coordinate X before output stop and YouTube afterward. External terminal observations claim the existing lifecycle owner once; handoff/disconnect alone never do so. In-flight mutation is awaited before ordered stop, and canceled activation cannot reinstall its owner.
- Unconfirmed `ending` responses propagate through the web control adapter and `/end` API adapter; desktop retains Ending/room state until confirmation.
- Server interval IDs are UUIDs allocated outside optimistic store callbacks, independent of show/take/egress IDs. First confirmed live leg stamps `liveSince`; End→Go Live creates a new interval; reconnect/handoff preserves one.
- Server pre-end coordination uses explicitly scoped injected authority only. No production adapter or automatic credential/consent acquisition is enabled. Missing authority remains durable pending even after egress stops.
- Durable bounded provider attempts use stable operation keys and leases, retain actual stop order, and fence successor destinations. Unexpected crash history survives recovery without certifying the replacement stopped. The reaper resumes interrupted stream-only End; an unlisted owned egress is explicitly stopped/confirmed by ID.
- Recording remains independent. If recovery of stream-only End lacks destination URLs, existing shared-egress fallback can carry recording on as a new take.

## Canonical interface and integration

See paired `docs/cloud/249-s16-lifecycle-contract.md` for full ownership details.

```ts
interface LiveInterval {
  id: string;
  requestedAt: string;
  liveSince?: string;
  endRequestedAt?: string;
  endedAt?: string;
}
```

All timestamps are ISO UTC. `endedAt` confirms output stop, not provider completion. Web source is `lib/cloud/media/output-interval.ts`, stored in `state_json.liveInterval` and publicly mirrored as `ManagedShowState.liveInterval`. Desktop typed mirrors: Rust `CloudStatus.live_interval: Option<CloudLiveInterval>` and TS `CloudStatus.liveInterval?: CloudLiveInterval`. `OutputSessionFacts.liveIntervalId` remains optional. No client fabricates canonical IDs for older servers.

S20 must reconcile these six seams after coordinator publishes S16:

1. Run `associateRecordingIntervals` AFTER S16 `observeLiveInterval`, itself after event/`settleManagedShow`, and before final state/revision build. `liveSince` is available at association time.
2. Preserve S20 `startRecordingAssociation(next, takeId)` at accepted takes in `recording.ts`, `destinations.ts`, and `legs-end.ts`.
3. Combine additive schema fields; S16 owns only JSON `liveInterval`/`providerLifecycle`. S20 owns recording columns, migrations, SQLite journal and take-to-interval links.
4. Consume the typed canonical interval. Observed record-only is `[]`; old unknown history stays unknown; one take may overlap A and B.
5. Preserve `ControlRevAnswer.ending`, `raise_floor`, and `videorc_api.rs` pending-End semantics.
6. Run fresh lightweight association/lifecycle/static checks on the reconciled paired tips. Heavy gates stay deferred.

S18 owns `cloud_services` and adjacent `main.rs` hooks; S16 adds only `mod provider_output` there. S18 may use `status.live_interval.as_ref().map(|i| i.id.clone())` after reconciliation. Forget service identity only after confirmed End/close; retain pending acknowledgement behavior. S18 allocates no IDs. Its `OutputSessionFacts.liveIntervalId` remains S16-owned.

Read-only independent PR reconciliation:

- [Web PR118 takeover](https://github.com/TheOrcDev/videorc-web/pull/118), head `af5be462`: program silence ownership, no S16 implementation overlap.
- [Web PR115 continuation](https://github.com/TheOrcDev/videorc-web/pull/115), head `ca66ea5f`: adjacent managed route/state/sync/destination hunks. Its older diff removes newer `showEnding` refusal; preserve current ending refusal and S16 interval/provider state. Handoff must never call terminal settlement.

Neither PR was modified or merged. Desktop clears runner facts on full show clear; pending provider obligations remain durable on the server, not retained as a desktop post-show archive.

## Actual injected provider authority contract

`lib/cloud/media/provider-lifecycle.ts` exports the optional server-only seam:

```ts
type ProviderBinding = {
  userId: string; showId: string; interval: string;
  destinationId: string; provider: "x" | "youtube";
};
type ProviderCapability = ProviderBinding & {
  operation: "complete"; encryptedRef: string; broadcastId: string;
  expiresAt: number; consent: "explicit-provider-completion";
};
type ProviderCompletionAuthority = {
  register(binding: ProviderBinding, signal: AbortSignal): Promise<ProviderCapability | null>;
  complete(capability: ProviderCapability, idempotencyKey: string,
    signal: AbortSignal): Promise<"confirmed" | "pending">;
};
```

The optional `providerCompletion` dependency passes through managed-route/show-route/media contexts. **No production route supplies it; no production adapter, credentials, OAuth lookup, encryption-key provisioning or consent acquisition is supplied.** Tests alone inject fake authorities. `register` may resolve only existing explicit authorization; returned capability scope, operation, expiry and reference bounds are validated before persistence. A real approved adapter would own encrypted-reference resolution, consent/revocation revalidation and provider-state query before retrying unknown outcomes. The journal does not itself implement a credential store or encrypt an arbitrary token.

Calls are bounded to two seconds with an abort signal; completion uses a stable idempotency key and at most four durable attempts with backoff. Missing/expired/mismatched authority stays pending (`authority-unavailable`), even when output stop is confirmed. Handoff does not trigger completion. Production enabling of this seam requires separately authorized adapter/consent work; S16 and S4 publication alone do not enable it.

## Focused evidence

- Web after S4 reconciliation: **65 passed, 0 failed**, eight focused fake suites: provider lifecycle, managed end order, talk egress/recording, egress death, ended cleanup, deadlines, avatar/output-token authorization, media-v2. Command: `node --import tsx --test tests/cloud-provider-lifecycle.test.ts tests/cloud-managed-end-order.test.ts tests/cloud-managed-talk-egress.test.ts tests/cloud-managed-egress-dies.test.ts tests/cloud-managed-ended-cleanup.test.ts tests/cloud-managed-deadlines.test.ts tests/cloud-avatar.test.ts tests/cloud-room-media-v2.test.ts`.
- Desktop after S4 reconciliation: **72 passed**, seven Vitest files: cloud-provider-lifecycle, scheduled-streams, talk-show-session, shared/output-session, talk-show-room (privacy/lifecycle), room-aux-publisher and room-avatar-publisher. Run via existing local Vitest binary, no install.
- Prior frozen S16 Rust evidence retained: **2 passed**, pure `provider_output.rs` standalone tests compiled with `rustc --edition 2024 --test`; no Cargo/backend build. Pure helper code is byte-identical after reconciliation; these tests were not rerun.
- Web TypeScript check (`tsc --noEmit --incremental false`), desktop renderer TypeScript check (`typescript-native/bin/tsc --noEmit -p tsconfig.web.json`), scoped web ESLint, scoped desktop Oxlint, scoped Prettier, scoped Rust formatting, acceptance-runner JS syntax and paired `git diff --check` pass.
- Desktop Oxlint reports the pre-existing `react-hooks/exhaustive-deps` missing `recording` dependency in `use-studio.tsx` (currently around line 19876). Reproduced on exported S2 and S4 source; not introduced or changed by S16. The standalone `/tmp` S4 baseline probe exits 1 with that diagnostic labeled error because repository path overrides do not match; the actual in-repository scoped lint exits 0 with a warning. No new scoped lint error.
- Fresh S4 Shadscan advisory baseline/floor/final: desktop **27 / 27 / 27**, web **47 / 47 / 47**. Command: `pnpm dlx @shadscan/cli@next --json`, desktop from `apps/desktop`, web from repository root. This is a frozen-diff advisory audit, not a commit checkpoint; no commit was created.

Fresh reconciliation evidence uses `/tmp/249-s16-s4-`: `web-focused.txt`, `desktop-focused.txt`, `web-tsc.txt`, `desktop-tsc.txt`, `web-lint.txt`, `desktop-lint.txt`, `desktop-baseline-lint.txt`, `web-format.txt`, `desktop-format.txt`, `rustfmt.txt`, and `{desktop,web}-shadscan-{baseline,final}.json`. Frozen path/content manifests are `{desktop,web}-frozen-manifest.json` under the same prefix. Original evidence remains under `/tmp/249-s16-`. Scoped formatting initially caught the merged dispatcher's long case list and Rust module order; both were corrected. No implementation or test behavior changed for those formatting fixes.

## Deferred gates and limitations

User explicitly deferred all smoke/heavy/real integration until after all merges on main. No `smoke:cloud-parity -- --case lifecycle`, platform-lifecycle/provider-readiness smokes, real pages, devices, managed egress/provider integration, public broadcasts, builds, full Rust tests/compilation/clippy or broad suites ran. New Rust integration regression fixtures are maintained and formatted but not compiled/executed. Run these only at the coordinator's authorized post-merge gate.

The maintained lifecycle acceptance runner was added and syntax-checked, not executed. It composes fake provider/ownership fixtures, scheduled backend fixtures and local room controls, and explicitly labels managed/provider qualification `not-run`. Source/fake evidence does not claim production qualification. Server-only provider completion remains pending without an independently approved existing explicit capability; implementing the seam does not authorize credentials or paid activation.

## PR-ready desktop title/body

Title: `fix(cloud): bind provider activation and settlement to owned output lifecycle (S16)`

Body:

Scheduled YouTube/X starts now use actual owned cloud destination readiness while retaining existing metadata and thumbnail preparation. Room Go Live skips native encoder/caption gates; End and close settle the owning provider lifecycle in order, reject stale handoff ownership, and keep unconfirmed cloud stops pending. Canonical optional interval and allowlisted settlement facts are mirrored without coupling them to media-v2 or recording IDs.

Based on published S4 `6a142e936`. Validation after reconciliation: 72 focused desktop tests passed; prior 2 standalone Rust ownership tests remain applicable to unchanged helper code; renderer typecheck, scoped format/lint and Rust formatting passed (one existing hook dependency warning). Shadscan 27 baseline/floor/final. Maintained lifecycle acceptance coverage added; all smoke, device/provider integration, builds and full Rust gates explicitly deferred by user until post-merge. Pair with the S16 web change; no production provider authority is enabled.

## PR-ready web title/body

Title: `fix(cloud): persist scoped provider settlement and canonical live intervals (S16)`

Body:

Managed outputs now receive server-owned live interval IDs and a durable provider reconciliation journal. Controlled End requests scoped X completion before confirmed stream stop and YouTube completion afterward; duplicate requests share operation keys, and crash/missing-authority outcomes remain truthful pending reconciliation with bounded retries. Reaper retries survive controller loss and closed shows while successor outputs are fenced. Recording stays independent.

Provider authority is an injected, explicitly consented capability seam with no production adapter or credential acquisition. Public state exposes only allowlisted diagnostics. Based on published S4 `9f708259`. Validation after reconciliation: 65 focused fake-provider/lifecycle/recording/graphics/media-v2 tests passed; TypeScript, scoped ESLint/Prettier passed; Shadscan 47 baseline/floor/final. All real managed/provider integration, smoke and builds deferred by user until post-merge. Pair with S16 desktop; reconcile S20 association after `observeLiveInterval`.

## Exact desktop path list

- `apps/desktop/src/renderer/src/hooks/use-studio.tsx`
- `apps/desktop/src/renderer/src/hooks/use-talk-show-room.ts`
- `apps/desktop/src/renderer/src/lib/cloud-provider-lifecycle.test.ts`
- `apps/desktop/src/renderer/src/lib/cloud-provider-lifecycle.ts`
- `apps/desktop/src/shared/backend.ts`
- `apps/desktop/src/shared/output-session.ts`
- `crates/videorc-backend/src/cloud_control_web.rs`
- `crates/videorc-backend/src/cloud_show.rs`
- `crates/videorc-backend/src/cloud_talk.rs`
- `crates/videorc-backend/src/main.rs`
- `crates/videorc-backend/src/output_session.rs`
- `crates/videorc-backend/src/provider_output.rs`
- `crates/videorc-backend/src/scheduled_streams_service.rs`
- `crates/videorc-backend/src/videorc_api.rs`
- `docs/cloud/249-s16-handoff.md`
- `docs/cloud/249-s16-lifecycle-contract.md`
- `scripts/lib/cloud-parity-lifecycle.mjs`
- `scripts/smoke-cloud-parity-app.mjs`

## Exact web path list

- `db/schema.ts`
- `docs/cloud/249-s16-handoff.md`
- `docs/cloud/249-s16-lifecycle-contract.md`
- `lib/cloud/managed-route.ts`
- `lib/cloud/media/events.ts`
- `lib/cloud/media/legs-end.ts`
- `lib/cloud/media/lifecycle.ts`
- `lib/cloud/media/media-store.ts`
- `lib/cloud/media/output-interval.ts`
- `lib/cloud/media/provider-lifecycle.ts`
- `lib/cloud/media/reconcile.ts`
- `lib/cloud/media/state.ts`
- `lib/cloud/media/sync.ts`
- `lib/cloud/media/types.ts`
- `lib/cloud/shows-route.ts`
- `tests/cloud-managed-talk-egress.test.ts`
- `tests/cloud-provider-lifecycle.test.ts`
- `tests/fixtures/cloud-managed-kit.ts`
