# S16 output and provider lifecycle integration

S16 base: published S4 desktop `6a142e936`; web `9f708259` (including S2/S3). Isolated `feat/249-s16-cloud-parity` trees. Coordinator commits/publishes; no S3 semantic dependency. Media v2 is unrelated to provider authority.

## Canonical interval (owned by S16)

Web source: `lib/cloud/media/output-interval.ts`, `LiveInterval`:

```ts
{ id: string; requestedAt: string; liveSince?: string;
  endRequestedAt?: string; endedAt?: string }
```

Stored in `cloud_show_media.state_json.liveInterval` and exposed as optional `state.liveInterval`. All times are ISO UTC. Server `randomUUID()` allocates an ID outside `media.mutate` (stable across CAS retries). `observeLiveInterval` runs in `syncManagedState` AFTER event/settle application and BEFORE final state construction. Accepted destinations create `requestedAt`; first actual live leg supplies `liveSince`. Opening a room or recording without streaming creates neither. Handoff/reconnect and automatic egress recovery keep identity. End confirms `endedAt`; a later Go Live creates a new ID in the same show. `endedAt` confirms stream output stop, never provider completion.

Desktop mirrors are `CloudLiveInterval` in `cloud_show.rs` and shared `backend.ts`, `CloudStatus.liveInterval`, optional `RunnerState.live_interval`, and `OutputSessionFacts.liveIntervalId`. Old servers omit the field; clients must not invent canonical interval IDs from polling edges. The local `liveSince` fallback is an activation fence only, not an archival interval identity.

S18 owns service reattachment and destination snapshots. Use canonical show + interval with current controller ownership, actual legs and freshness; do not create IDs or infer credentials from the fact that an output exists. S20 owns recording tables, migrations, takes and plural take-to-interval links; it may associate after `observeLiveInterval` and before final state build. A continuous recording may overlap A and B; record-only has no invented interval.

## Provider reconciliation (owned by S16)

`lib/cloud/media/provider-lifecycle.ts` owns a durable bounded journal separate from interval/take identity. Each operation key hashes show + canonical interval + destination + redacted identity reference. It is not a take or an egress ID; restart preserves the provider operation. Terminal settlement is independent of recording. Handoff never requests terminal settlement.

Server adapter `ProviderCompletionAuthority` is deliberately absent by default. Its registration may return only an existing, explicitly consented, encrypted operation reference bound to user/show/interval/destination/provider/broadcast and `complete`. No OAuth keys, token lookup, credential acquisition, room metadata/grant changes, paid-service activation or production adapter are implemented. Completion must recheck revocation and remote state before retrying an unknown outcome. The journal records absent authority and bounded retry exhaustion as pending, never success.

Controlled stop requests X completion before stream stop, and YouTube only after stop confirmation. Unplanned egress death records actual after-stop order and pending reconciliation; no retroactive ordering claim. An unresolved obligation cannot complete a newer active interval on the same destination. Public diagnostics are allowlisted and omit capability references and account/broadcast identifiers.

## Integration ownership

- S16: `cloud_show.rs` lifecycle/status mirrors, `scheduled_streams_service.rs` output ownership, provider lifecycle helper, stream-stop readiness, `state_json.liveInterval`/`providerLifecycle`, `output-interval.ts`, pre-build observation in `sync.ts`, renderer terminal coordination.
- S18: chat/Sidekick service reattachment and authorized destination facts. Reconcile adjacent `main.rs`/`cloud_show.rs` hunks against S16 before publishing.
- S20: recording columns/types/migrations, association helper after interval observation, downloader/Library. Reconcile adjacent `db/schema.ts`, `sync.ts` and shared backend type hunks without changing S16 identity allocation.
- S3: auxiliary media role and v2 negotiation, central ledger. S16 makes no central ledger edit.

All smoke, browser/device, managed/provider integration, heavy suites and builds remain deferred until the authorized post-merge run. Source support and fake-provider tests are not qualification.

## Final reconciliation notes

S16 is reconciled onto published S4 desktop `6a142e9361f2eccb52c85762e3ecf6c4adcdf18c` and web `9f7082594fcbb2c0c31cae98dc2b71609c08e677`, including S2 privacy and S3 auxiliary audio. S18, S20, PR115 and PR118 remain separate. The coordinator publishes the paired S16 tips before peers reconcile; this slice creates no commits or PRs.

The canonical projection is `CloudStatus.live_interval: Option<CloudLiveInterval>` in Rust, `CloudStatus.liveInterval?: CloudLiveInterval` in shared TypeScript, and `ManagedShowState.liveInterval?: LiveInterval` on web. Rust fields are snake_case; serialized fields use the camelCase interface above. `OutputSessionFacts.liveIntervalId` is optional. S18 may replace its serialized structural read with `status.live_interval.as_ref().map(|i| i.id.clone())`; no peer allocates IDs.

S20 ordering is mandatory: event application → `settleManagedShow` → `observeLiveInterval` → `associateRecordingIntervals` → final state/revision build. First confirmed `liveSince` is present before association. Preserve its `startRecordingAssociation(next, takeId)` additions at accepted takes in `recording.ts`, `destinations.ts` and `legs-end.ts`. Observed record-only takes have `[]`; historical unknown remains unknown. These hooks and recording columns belong to S20 and are not copied into S16.

Preserve `ControlRevAnswer.ending` / `raise_floor` in `cloud_control_web.rs` and the `/end` pending-response check in `videorc_api.rs`: an HTTP success acknowledging `ending` does not confirm output stop. Unconfirmed close retains the desktop room/show. Server public provider facts include destination, provider, state, attempt count, terminal reason and actual stop order, but never capability references. A full desktop show clear drops its runner projection; the durable server journal remains authoritative afterward.

The reaper resumes interrupted stream-only End under the existing show lease. Where destination URLs are unavailable, the existing recording fallback may continue the recording as a new take. A recovered egress retains crash history but must obtain fresh stop confirmation; a later controlled End again requests X before stopping that replacement.

S18 adjacent `main.rs` service hooks must forget identities only on confirmed End/close and must preserve S16 pending acknowledgements. Its module declaration is independent of `mod provider_output`. S2 privacy, S3 media-v2/soundboard and S4 graphics/output-token behavior are preserved in these bases and remain authoritative during downstream reconciliation.

PR118 takeover (`af5be462`) owns program silence and has no S16 implementation overlap. PR115 continuation (`ca66ea5f`) has adjacent state/sync/destination changes; preserve the newer `showEnding` refusal and S16 pending-stop semantics when reconciling its older diff. Handoff never calls terminal provider settlement. Neither PR was merged or modified.


## Injected authority boundary

The optional context dependency is `ProviderCompletionAuthority`: `register(binding, signal)` returns an existing explicit capability or null; `complete(capability, idempotencyKey, signal)` returns `confirmed` or `pending`. Binding is exact user/show/canonical interval/destination/provider; capability additionally carries `operation: "complete"`, opaque `encryptedRef`, broadcast ID, expiry and `consent: "explicit-provider-completion"`. Production routes do not supply this dependency. Fake tests inject it; there is no production adapter, credential store, token lookup or encryption/consent provisioning in S16. The approved adapter would resolve the encrypted reference and revalidate consent/revocation and provider state. Missing authority remains durable pending. See `249-s16-handoff.md` for the exact TypeScript contract and fresh S4 integration evidence.
