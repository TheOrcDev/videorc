# Plan 249 S2 paired coordinator handoff

Implementation ready for review. **Live acceptance NOT RUN; not qualified.**
No commits, pushes, PR creation, merges, deployment, paid egress or credential
expansion. The coordinator owns paired publication and commissions S3 afterward.

## Stack and reconciliation

- Desktop worktree: `/Users/orcdev/projects/videorc-wt-249-s2`.
- Branch: `feat/249-s2-cloud-parity`.
- HEAD/base: `0f9790f869a07102560ee864ac91b001fe73f7e4`.
- PR base: `feat/249-s1-cloud-parity`.
- Web worktree: `/Users/orcdev/projects/videorcweb-wt-249-s2`.
- Web branch: `feat/249-s2-cloud-parity`.
- Web HEAD/base: `8f90dd74944cf08b9ca202e977a2ebf46ee6b16d`; PR base `main`.
- S0: <https://github.com/TheOrcDev/videorc/pull/1437>, committed `570d72926`.
- S1: <https://github.com/TheOrcDev/videorc/pull/1438>, committed `0f9790f86`.
  Both implemented, open for review; live acceptance not run.
- No dedicated S2 issue or PR found. Mapping URLs remain null; do not invent them.
- Web <https://github.com/TheOrcDev/videorc-web/pull/118> remains open at
  `af5be462f5d790fd5c808c0acfd4b801382f5e9c`. Takeover audio is independent.
  No dependency on its branch; reconcile `stage.ts` and regenerate emitted JS
  when integrating. S2 does not modify its stage-audio implementation.
- Shared active checkouts, planning worktree and previously published stack
  branches preserved. Only ignored dependency links were added in S2 worktrees;
  no package or lockfile changes or installations.

## Desktop PR title

Plan 249 S2: gate browser screen publication before privacy acknowledgement

## Desktop PR body

Room sharing previously published raw display capture independently of Hide
screen. Publish only a guarded canvas track. Hide closes that gate synchronously,
replaces the publication with opaque neutral frost and preserves the decision
across pending capture, source replacement and reconnect. Processing failures
stop capture and unpublish with an explicit paused status. Native transitions
carry monotonic generations; delayed reads and Show replies cannot reopen a
newer Hide. Automatic password-manager privacy uses this path, and room sharing
requires explicit Show instead of the native follower's automatic restoration.

Separate capture-epoch/source-blocked time from program and individual guest
observations. Accept observations only from the server relay for the current
publication; stale, absent, disconnected and timed-out consumers stay
unconfirmed. Studio privacy status reports Hiding, observed receivers, Unconfirmed or Paused, and
lists receiver observations without treating a local command as remote proof.

Implement the maintained `privacy` acceptance case, mirrored wire fixture and
S0/S1/S2 ledger mapping. Pair with the web S2 PR (URL to be added by coordinator).
No LiveKit grant or unqualified production-parity flag is enabled.

Validation: focused desktop logic/UI/schema tests, parity helper/registry Node
tests, renderer/shared no-emit typecheck, changed-file lint/format, touched Rust
format and diff checks. No smoke, real page, device, heavy suite or build ran.
Rust tests were updated but not executed because compilation in this fresh
worktree is a heavy gate. Final counts and Shadscan scores accompany handoff.

## Cross-repository contract

- Published screen name: `vrc-privacy:<32 lowercase hex capture epoch>:<positive
safe integer generation>:<0 visible | 1 hidden>`; no credentials or PII.
- The raw capture track is never passed to LiveKit. A new privacy generation
  gets a new publication; existing canvas generations can close, never reopen.
  Neutral opaque RGB 128 frost uses the native safe no-picture frost, deliberately
  avoiding sampling potentially sensitive content to create a blurred still.
- Host reliable topic `videorc.screen-privacy.v1` carries epoch/generation/hidden.
  It can close receiver gates promptly. Only a newer publication may open them.
- Program discards cached crossfade stills and applies source frost; guest host
  screen tiles apply frost synchronously. Both inspect newly decoded neutral
  pixels before sending an applied observation. Failure/timeout sends no proof.
- Guest POST `/api/guest/:slug/privacy`: `{show,guestId,participantSid,privacy:{epoch,generation,
hidden:true,appliedAt}}`, existing HttpOnly guest cookie, same-origin check,
  current membership, show ownership and LiveKit participant SID. Reconnected
  guest sessions cannot reuse an observation from an earlier SID. Body is bounded to 1024 bytes during
  streaming reads. IP/slug and per-receiver rate limits bound requests.
- Program sends optional `privacy` in its existing beacon with the existing
  page token, restricted to that show/orientation. Stale page boots/sequences do
  not relay; recording-page observations have a separate `:recording` receiver
  suffix. Guest cannot certify program.
- Server compares the observation with the sole current unmuted host screen
  publication and relays to `host:<show>` on `videorc.screen-privacy.ack.v1`.
  Receiver identity is derived from guest session or program token, never body.
  Guest publish-data grants stay false. Each guest can certify only itself.
- Observations are point-in-time, not continuous protection certification. Client
  timestamps outside a conservative 10-second past/1-second future window are
  refused; clock skew therefore stays unconfirmed, never a false confirmation.
- Local timeout is 5 seconds. Receiver disconnect/reconnect invalidates observations.
  Missing/legacy consumers remain unconfirmed; UI never promises all receivers
  are hidden solely from source blocking. Already-transmitted frames cannot be recalled.
- Mirrored JSON: desktop `protocol-fixtures/cloud-parity-privacy.json`, web
  `tests/fixtures/cloud-parity-privacy.json`. Consumer-first integration; no deploy
  performed. Old browser consumers can receive safe source pixels but cannot
  acknowledge; old backends lacking generations cannot open the browser gate.

## Maintained acceptance and explicit deferrals

`pnpm smoke:cloud-parity -- --case privacy` now exercises synthetic secret-bearing
screen input through the real desktop gate, local LiveKit, real program/recording
pages and guest components. It checks source pixels, decoded-frame traces,
per-consumer applied observations, composed screenshots, finished subscriber
VP8 artifacts and a finished composed program-page recording. Cases cover manual
and password-manager Hide, source switch, rapid Show/Hide, receiver reload and
missing authenticated acknowledgements. Old-frame drain has a separate 500 ms
local budget. Fixture HTTP receipts never forge host confirmations. Production
cookie/token route authorization is exercised by focused injected-dependency tests.

The harness itself was **not run**. Browser recordings and fixture HTTP transport
are not managed egress/recording qualification. Managed final artifacts, physical
capture, drain limits and platform behavior remain not-run until deferred gates.

Deferred by explicit user instruction:

- Full D/N/W suites and production builds; focused subsets/static checks only.
- `cargo test -p videorc-backend`, `cargo clippy -p videorc-backend -- -D warnings`.
- `pnpm smoke:cloud-parity -- --case privacy` and all baseline/controls cases.
- Web `node tests/browser/cloud-program/{run,run-stage,run-livekit,run-stage-livekit}.mjs`
  and `pnpm smoke:guest-call`.
- `pnpm smoke:cloud-talk-show-managed`, `pnpm smoke:cloud-talk-show`,
  `pnpm smoke:cloud-solo-managed`, `pnpm smoke:recording-studio`,
  `pnpm smoke:recording-studio:devices`, `pnpm smoke:smart-scenes`,
  Windows `pnpm smoke:hide-screen:windows`.
- Real macOS/Windows device permissions, managed H/V stream/recording artifacts,
  network reconnect behavior and S27 release qualification.

## Known baseline check failure

Web focused bundle suite has one pre-existing failure: “the stage's colours are
the runner's luma values”, `tests/cloud-program-bundle.test.ts:339`, asserts the
removed `.tile-dim` CSS rule. Both this test and `public/cloud/program/v1/program.css`
are byte-for-byte identical to web base `8f90dd7`. No assertion weakened and no
unrelated CSS restored. Generated module emission/check and privacy tests pass.
Desktop scoped lint retains the pre-existing `recording` dependency warning in
the stop-confirmation memo. Shadscan baseline/floors: desktop 27/27, web 47/47;
final advisory checkpoint is reported with the frozen diff, not written afterward.

## Focused verification results

- Desktop: 193 focused tests across seven files passed. Final changed
  publication/observation rerun: 35 tests passed. Renderer/shared no-emit
  typecheck passed; parity registry/privacy helper tests: 11 passed.
- Web: 116 of 117 selected tests passed; the sole failure is the unchanged
  `.tile-dim` baseline assertion documented above. All eight privacy tests,
  including guest SID isolation and program-token/stale-beacon handling, passed.
- Both no-emit typechecks, scoped lint/format and diff checks passed, with only
  the documented pre-existing desktop lint warning. Touched Rust formatting
  passed using edition 2024; Rust compilation and tests remain deferred.
- Maintained web emitter `--check` passed; generated modules match source.
- Shadscan baseline/floor 27/27 desktop and 47/47 web. Final frozen-diff scores
  are in the coordinator report. No audit autofixes or unrelated cleanup.

## Exact changed paths

- `apps/desktop/src/renderer/src/components/studio/quick-settings.tsx`
- `apps/desktop/src/renderer/src/components/studio/retro-lcd-studio.tsx`
- `apps/desktop/src/renderer/src/hooks/use-follow-front-app.test.ts`
- `apps/desktop/src/renderer/src/hooks/use-follow-front-app.ts`
- `apps/desktop/src/renderer/src/hooks/use-screen-privacy.ts`
- `apps/desktop/src/renderer/src/hooks/use-studio.tsx`
- `apps/desktop/src/renderer/src/lib/follow-front-app.ts`
- `apps/desktop/src/renderer/src/lib/room-screen-privacy.test.ts`
- `apps/desktop/src/renderer/src/lib/room-screen-privacy.ts`
- `apps/desktop/src/renderer/src/lib/screen-privacy-view.ts`
- `apps/desktop/src/renderer/src/lib/talk-show-room.test.ts`
- `apps/desktop/src/renderer/src/lib/talk-show-room.ts`
- `apps/desktop/src/shared/backend-rpc-contract.ts`
- `apps/desktop/src/shared/backend.ts`
- `crates/videorc-backend/src/main.rs`
- `crates/videorc-backend/src/protocol.rs`
- `crates/videorc-backend/src/screen_privacy.rs`
- `docs/cloud/249-execution-ledger.md`
- `docs/cloud/249-s2-handoff.md`
- `protocol-fixtures/cloud-parity-inventory.json`
- `protocol-fixtures/cloud-parity-plan.json`
- `protocol-fixtures/cloud-parity-privacy.json`
- `protocol-fixtures/screen-privacy.json`
- `scripts/lib/cloud-parity-baseline.mjs`
- `scripts/lib/cloud-parity-browser.mjs`
- `scripts/lib/cloud-parity-privacy-contract.mjs`
- `scripts/lib/cloud-parity-privacy-contract.test.mjs`
- `scripts/lib/cloud-parity-privacy.mjs`
- `scripts/smoke-cloud-parity-app.mjs`
