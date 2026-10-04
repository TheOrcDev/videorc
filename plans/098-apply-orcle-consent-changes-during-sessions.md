# Plan 098: Apply cloud-AI consent changes to an active Orcle session

> Fix plan only. Work from latest main, preserve unrelated changes, and verify drift with `git diff --stat 05ff9188..HEAD -- crates/videorc-backend/src/cohost.rs crates/videorc-backend/src/captions.rs apps/desktop/src/renderer/src/hooks/use-studio.tsx scripts/smoke-cohost-fake.mjs`.

Implementation should start from release 0.9.129 (`05ff9188`) or newer main in an isolated worktree. Preserve the original checkout's existing user changes, and perform the drift check before editing.

## Execution status

Source repair merged as `9e015cb1` in [PR 546](https://github.com/TheOrcDev/videorc/pull/546), main `406fc61e`. Focused checks passed: 99 caption, 75 Orcle, 124 renderer and 19 fixture tests (317 total), TS checks and Rust fmt; Shadscan 37. Same-session consent changes retire speech/cloud ownership while preserving chat/capture identity. Real fake-service app smokes and full gates remain pending. Plan 097 still owns recording matcher identity and late-caption routing; no real-provider speech trial was performed.

## Status

- Priority: P1; privacy setting must take effect
- Effort: M
- Risk: MED; cancellation and lifecycle publication must remain ordered
- Depends on: none
- Category: bug / privacy
- Planned at: `05ff9188`, 2026-10-03, desktop 0.9.129
- Confidence: HIGH, confirmed source behavior; no real cloud transmission was initiated to reproduce it

## Problem and reproduction

Start a live-chat session with Orcle enabled, listening enabled, and cloud-AI consent on. Turn cloud-AI consent off during that same session. The renderer resends `cohost.start` with false, but the backend returns its existing snapshot without updating consent. New tick/spotlight requests and the existing listening intent continue to use the old consent. The reverse transition also fails: a session started without consent remains blocked after consent is granted.

Reproduce against the local fake cohost/speech services, never real viewers or a real cloud account: start with true, resend for the same session with false, advance the next tick, and observe fake-service traffic and listening state. Repeat false→true. Distinguish requests already sent before revocation from work admitted afterward.

## Evidence and conventions

- `apps/desktop/src/renderer/src/hooks/use-studio.tsx:3093` writes consent to renderer state/localStorage only.
- `use-studio.tsx:3885–3917` deliberately reasserts `cohost.start` whenever `aiConsent` changes, passing `consentToProcessChat: aiConsent`.
- `crates/videorc-backend/src/cohost.rs:4209` ignores changed parameters:

```rust
if engine.is_running_for(&session_id) {
    return Ok(engine.snapshot());
}
```

- The session stores `consent`; `prepare_tick` around `cohost.rs:3718` gates on that stored value. Tick and spotlight payloads also carry it.
- `start_listen_if_wanted` around `cohost.rs:4082` only checks consent on initial listening startup.
- `cohost_start_with_fences` already owns `live_chat_persistence.begin_delivery()` and validates the authoritative chat session. Extend this lifecycle discipline rather than adding renderer-only gates.
- Existing inline cohost tests and `scripts/smoke-cohost-fake.mjs:257–276` test initial/repeated startup; current repeated-start test treats unchanged consent as a no-op.

## Scope

In scope: `cohost.rs` and inline tests; minimal listen-intent cancellation/epoch changes in `captions.rs`; existing fake cohost/speech fixture and smoke; renderer `use-studio.tsx` and its provider integration tests if acknowledgement behavior needs adjustment.

Execution reconciliation: a retained explicit-caption task has a second stale-work path. Chunked and realtime callbacks append Orcle transcript finals unconditionally, and readiness callbacks originally read the current listen epoch when a response arrives. A pre-revocation response arriving after regrant can therefore acquire the new ownership. Narrow internal scope includes the chunk upload tuple and realtime item/timeline ownership: stamp Orcle listen ownership at input/request admission, validate it at the actual transcript append/readiness publication, and prevent check/append from straddling the revoke boundary. Preserve explicit caption presentation and immutable recording clip-mark routing independently. Do not await the chat lifecycle fence from a caption task, because capture finalization joins that task while holding the fence. Add deterministic tests through both actual callback seams, including revoke→regrant; manually calling old-generation engine methods is insufficient alone. This extension was reviewed and authorized during execution, not an unrelated caption refactor.

The raw caption receiver can also retain frames across revoke/grant. Use the existing monotonic `AudioFrame.captured_at` and duration to reject Orcle ownership for queued or crossing frames predating the current grant; preserve the grant time on a same-intent resume and leave caption/recording timestamps unchanged. The spotlight transcript snapshot must be read after acquiring its existing lifecycle fence, so a queued new-generation scheduler cannot carry a pre-boundary snapshot into admission. Both seams require deterministic regressions.

Contract reconciliation: explicitly enabled captions already supply Orcle speech/spotlight context with active cloud consent even when `CohostSettings.listen` is false. Keep speech admission consent/epoch separate from `listen_wanted`, which owns the extra provider task and listen readiness. Retire speech admission before clearing transcript at authoritative cohost consent/session boundaries and grant it afterward. Preserve caption-only Orcle context for consent=true, fence delayed input/results across false→true, and keep independent clip-mark routing. Cover this mode through actual callbacks; changing the maintained spotlight smoke to enable Listen would hide a regression.

Retire retained listen readiness in the validated initial/replacement start branch as well as consent changes. Preserve the explicit caption task while rejecting its prior listen owner. The new speech owner must retire at sign-out and restore for an enabled consenting session after sign-in, including Listen=false; grant must respect existing privacy/shutdown guards. Stop-listen cleanup also needs to retire an owned finished task handle when no presenting/draining intent remains, rather than testing only task liveness. Reproduce that cleanup with a deterministic task-completion barrier and retain existing capture-drain behavior.

The replacement regression also reproduced an initial-state discrepancy: `CohostSession::new` reports Listening/None immediately for consent=false until a scheduler pass notices it. Initialize that session as Paused/ConsentRequired, consistently with an active-session revocation; preserve the authoritative RPC-state assertion rather than removing it.

Out of scope: account sign-out, live captions consent unrelated to Orcle, subscription entitlement, post-recording AI/export behavior, and actual provider calls.

## Steps and checks

1. Add an RPC-level regression for true→false and false→true on the same live-chat session. Assert stored consent, returned/published state, listening intent, and fake request admissions. The current backend must fail the revocation assertion. Run `cargo test -p videorc-backend cohost::tests::`.
2. Handle changed consent inside the existing lifecycle fence. Unchanged consent remains idempotent. Revocation must block new cloud work, stop the Orcle listen intent, and invalidate pending results using the existing generation/epoch mechanisms. Do not restart recording or the live-chat session. Granting consent must enable eligible work according to existing listen settings. Run focused cohost and caption tests.
3. Add deterministic delayed fake responses to prove old tick, spotlight and speech callbacks cannot restore an allowed/listening state or publish stale work after revocation. Extend `smoke:cohost-fake`, then add a real renderer preference-flip integration test that observes confirmed state. Run the complete suites below.

## Verification

`cargo test -p videorc-backend cohost::tests::`, `cargo test -p videorc-backend captions::tests::`, `cargo test -p videorc-backend`, `cargo fmt --check --all`, `cargo clippy -p videorc-backend -- -D warnings`, `pnpm smoke:cohost-fake`, `pnpm --filter @videorc/desktop test studio-provider.integration.test.ts`, `pnpm typecheck`, and `pnpm lint` must all pass. If caption finalization/start-stop behavior changes, run `pnpm smoke:recording-studio` and `pnpm smoke:record-latency:gate` too.

## Done criteria

- [ ] Revocation is acknowledged by authoritative state and stops admitting new Orcle cloud requests/listening.
- [ ] A delayed pre-revocation response cannot reactivate listening or publish stale cloud results.
- [ ] Consent grant resumes the same session when settings and entitlement allow it.
- [ ] Repeated same-consent starts stay idempotent; capture/chat do not restart.
- [ ] Automated fake-service and renderer tests exercise both directions and late responses.
- [ ] Plan index includes gate evidence and any remaining real-provider acceptance limit.

## STOP and maintenance

Stop if listening and explicit captions share a consent/cancellation handle that cannot revoke Orcle independently; expand the contract explicitly before editing. Review future cohost admission paths for the same authoritative consent and epoch checks. Never infer that a UI switch cancels already-transmitted network requests.
