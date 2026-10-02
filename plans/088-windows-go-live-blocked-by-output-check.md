# Plan 088: Windows Go Live refused with "Checking the exact livestream output path"

> Executor: read this plan and `AGENTS.md` first. Work in your own worktree
> from current `origin/main`, not the shared checkout. Owner route: Diagnose
> (fit 9), model lane `fable-5` (recording start path, Windows-only, one prior
> failed incident in the same area: Plan 067).

## Status

- Priority: P0 for Windows (a user cannot go live). Effort: M. Risk: MED.
- Status: TODO. Investigation and plan only; no product code changed.
- Planned 2026-10-01 against `origin/main` `26ccbf96`. All line numbers below
  are from that commit.
- Related: Plan 067 (Windows startup failure, PARTIAL), Plan 065 (MF probe
  ladder and rejection cache). This plan does not reopen either.

Drift check before starting:

```sh
git diff --stat 26ccbf96..origin/main -- \
  apps/desktop/src/renderer/src/hooks/use-studio.tsx \
  apps/desktop/src/renderer/src/components/streaming/go-live-panel.tsx \
  apps/desktop/src/renderer/src/backendClient.ts \
  crates/videorc-backend/src/recording.rs \
  crates/videorc-backend/src/windows_media_foundation_encoder.rs
```

## The report

One Windows user cannot start a livestream. Their screenshot
(`~/Downloads/winnnn.png`, do not commit) is a red error toast:

> Checking the exact livestream output path before Go Live.

No support bundle, app version or hardware details came with it.

## What the toast means

It is not a failure message. It is the "still checking" text of the
output-path preflight, shown as an error.

1. With streaming on, the renderer asks the backend which encoder path a
   livestream would use (`stream.output.topology.probe`). The effect at
   `use-studio.tsx:9736` fires it whenever the output profile changes.
2. `streamOutputTopologyBlockReason` (`use-studio.tsx:686`) returns the
   "Checking…" string for every state that is not `ready` or `failed` for
   the current request: `pending`, `not-requested`, or a stale request key.
3. `startBlockedReason` (`use-studio.tsx:11049`) treats that string like any
   other blocker.
4. Both start paths refuse and call `reportError` with it, which is the red
   toast: `openGoLiveConfirmation` (`:12571`) and `runStartSession`
   (`:11950`).

So Go Live is refused whenever the user clicks while the check has not
finished. The Go Live button is not disabled while this is true; the only
hint is a "Stream settings: Checking…" row inside Livestream setup
(`go-live-panel.tsx:261`), which is not on the Studio screen.

## Why it only bites on Windows

On macOS and Linux the probe returns in milliseconds, so the window is never
seen. On Windows the probe runs the real Media Foundation hardware encoder:

- `probe_stream_output_topology` (`recording.rs:14455`) →
  `probe_windows_media_foundation_topology` (`:14399`) →
  `probe_windows_native_encoded_bridge` (`:14572`) →
  `probe_hardware_encoder` (`windows_media_foundation_encoder.rs:3341`).
- That walks every input topology, and inside each one up to three bitrates
  (`:3345`, `:3388`). Each attempt can wait 3 s per event and 5 s to drain
  (`EVENT_TIMEOUT`, `DRAIN_TIMEOUT`, `:91`).
- The code's own comment (`recording.rs:14528`) records 6.5 to 11.9 s per
  probe on a tester's Iris Xe laptop. A split recording + stream setup
  probes two profiles.
- The hardware probe runs in `spawn_blocking` with **no overall deadline**
  (`recording.rs:14603`). Only the later FFmpeg copy step has one (15 s).
  If a driver call blocks, the RPC never answers.
- The renderer waits up to 120 s for it (`backendClient.ts:128`). After
  that the state becomes `failed`, and nothing retries until the user finds
  the Retry button in Livestream setup.

A second trigger: `confirmGoLive` (`:12735`) prepares the OAuth broadcasts,
which rewrites `captureConfig`, then calls `runStartSession`. If that changes
the probed profile, a new probe starts and the start is refused seconds after
the platform broadcasts were created.

`runStartSession` already contains `await probeStreamOutputTopology(...)`
(`:11964`), which would wait for the check. The `startBlockedReason` gate
above it returns first, so that wait is never reached while pending. The
existing integration test enshrines the refusal
(`studio-provider.integration.test.ts:4850`: "startSession during pending
sends no session.start").

## What is and is not established

| Claim | Confidence |
| --- | --- |
| The toast is the pending/not-requested state of the preflight, surfaced as an error | HIGH, read directly from the code |
| Clicking Go Live while the check runs is refused instead of waited for | HIGH |
| The Windows probe takes seconds and has no overall deadline | HIGH for the code; duration on this user's PC unknown |
| Which case this user is in: slow probe clicked early, or a probe that never returns | Slow probe clicked early is LIKELY per their bundle (below); not directly logged |

Both cases have the same two defects, so the fix does not depend on which
one it is.

## Reporter's support bundle (added 2026-10-01)

`~/Downloads/videorc-support-bundle-20261001-150707Z.json` (private, do not
commit). Packaged Windows 0.9.124, Windows 11 22631, x64.

| Evidence | Reading |
| --- | --- |
| GPU: Intel UHD Graphics 600 only | A Celeron/Pentium-class laptop. |
| Backend ready 15:06:29, bundle exported 15:07:07 | The toast and the export happened within 38 s of launch. |
| Quick Sync rejects every size tried, including 1280x720 at 4000 kbps, in both input topologies: `stage=process-output HRESULT=0x8000FFFF` | The probe always walks the whole ladder on this PC before it can answer. |
| Two record starts today spent 12.5 s and 19.8 s in `device-resolve` (total start 18.1 s and 28.6 s) | Likely the same probe ladder; the bundle does not name the phase's contents, so treat as strong but indirect. |
| Both of those record starts finished | No sign of a probe that never returns. |
| The five retained sessions are all record-only | No livestream start is on record for this user. |
| Performance check today: 1080p30 at 0.58x realtime, 720p30 at 0.685x, `belowFloor=true`, software OpenH264, CPU compositor | This PC cannot encode even 720p30 in real time. |

Reading: the user most likely clicked Go Live while a 12 to 20 s check was
still running, shortly after launch. That is the S1 defect. A hung probe is
not supported by this bundle, so S2 is hardening, not this user's cause.

The bundle has no line for the topology probe itself, so its real duration
and verdict are still inferred. S4 stays.

**Second problem, more important for this user:** once S1 lets them through,
the stream will not work. Streaming sessions get no step-down
(`resolve_windows_recordable_video` returns `None` when streaming,
`recording.rs:14297`), so the stream would run 1080p30 on software OpenH264
at about half real time. Their record-only sessions, stepped down to 720p,
still came out with 56 freezes in a minute. See S5.

## Third screenshot: the hard block (added 2026-10-01)

`~/Downloads/b.png` (private). YouTube only, Record on, Output 1920x1080 30
fps. Red toast on the Studio screen:

> A separate encoded livestream output is unavailable: Media Foundation
> recording output probe rejected 1920x1080@30 8000kbps: … Use one shared
> provider-safe profile at 6000 kbps or lower before going live.

This is the `ready` branch of `streamOutputTopologyBlockReason`
(`use-studio.tsx:690`), not the pending one. It is **permanent** on this PC,
and it is the user's real blocker:

- Recording is 1080p30 at 8000 kbps, the YouTube stream is 6000 kbps. The
  profiles differ, so `buildStreamOutputTopologyProbeParams` asks for two
  roles, recording + stream (`:665`). It always plans as if a separate
  encoder were available (`providerStreamOutputPlanOptions(..., true)`,
  `:643`).
- A separate stream encoder needs the hardware path. Quick Sync rejects it,
  so the verdict is raw video for a split plan, which blocks Go Live every
  time.
- With YouTube + Twitch (second screenshot) the plan was a shared encode,
  which does not block. That is why that screenshot looked fine.

So this user hits both: the "Checking…" refusal while the check runs, then
this block once it finishes. Workarounds today: turn Record off while
streaming, or set the Output bitrate to 6000 kbps so both profiles match.
The toast does say the second one, after nine lines of HRESULT text.

See S6. It is the highest-value slice for this user.

Also seen, not part of this plan: `performanceCheck.appVersion` reads
`0.9.0` on a 0.9.124 install, and the microphone capture worker failed to
open on both of today's sessions (direct fallback used).

## Scope

Allowed: `use-studio.tsx`, `go-live-panel.tsx`, `session-panel.tsx` (copy
only), `backendClient.ts`, `studio-provider.integration.test.ts`,
`go-live-panel.test.ts`, `recording.rs`, `main.rs` (RPC arm only), protocol
mirrors only if S4 needs a field.

Out of scope: changing which encoder is chosen, the MF ladder itself, Plan
067's media work, a release, any new UI surface.

## Slices

### S1. Go Live waits for the check instead of refusing (renderer)

- Split the preflight result into two pure helpers: "is there a real
  blocker" (`failed`, or `ready` with a raw split stream role) and "is the
  check still running" (`pending`, `not-requested`, stale key).
- `startBlockedReason` keeps real blockers only. The still-running case
  must no longer produce an error toast.
- In `openGoLiveConfirmation` and `runStartSession`: when the check is not
  ready for the current request, `await probeStreamOutputTopology(request)`
  (it already joins the in-flight call), then judge the **returned result**,
  not the closure's stale `startBlockedReason`. When the state is `failed`,
  a Go Live click forces one fresh probe before reporting the failure.
- In `confirmGoLive`, run that wait **before** `prepareOauthTargetsForGoLive`
  so no platform broadcast is created for a start that is then refused.
- While waiting, the Go Live control shows its existing pending state with
  "Checking stream settings…". Follow `videorc-design`; no new component.
- A real rejection keeps today's wording ("Livestream output check failed:
  …" and the split-output message).

Done when: the updated integration test shows `startSession` during a
deferred probe sends nothing, then proceeds to the confirmation once the
probe is released, with no error reported; a failed probe is retried once on
click; a `ready` raw split result still blocks.

### S2. The Windows probe always answers (backend)

- Give `probe_windows_native_encoded_bridge` one overall deadline around
  the `spawn_blocking` hardware probe (start at 20 s; record the measured
  normal duration from S4 before tuning).
- On expiry: return a `Rejected` verdict with a plain reason ("the GPU
  encoder did not answer in time"), store it in
  `WINDOWS_MF_PROBE_REJECTIONS` so `session.start` falls to the software
  path instead of repeating the wait, and log it.
- The blocked thread cannot be cancelled. Make the hardware probe
  single-flight per rejection key so repeated clicks cannot stack stuck
  threads, and let a late result update the cache.
- Lower the renderer timeout for `stream.output.topology.probe` from
  120 s to the backend deadline plus slack (about 45 s for two profiles).

Done when: a unit test with an injected never-returning probe gets a
`Rejected` verdict inside the deadline, a second call returns from the
cache immediately, and `pnpm check:windows` compiles.

### S3. Say the truth in the idle UI

- The session panel's blocked line (`session-panel.tsx:197`) shows a neutral
  "Checking stream settings…" while the probe runs, not a warning.
- The `not-requested` row copy in `go-live-panel.tsx:287` ("Go Live stays
  off until it passes") changes to match S1: Go Live now waits.

Done when: `go-live-panel.test.ts` covers pending, failed and ready copy.

### S4. Make the next report diagnosable

- Log one line per topology probe RPC: profile, roles, elapsed ms, verdict,
  whether it came from a cache.
- Confirm that line reaches the support bundle's backend log tail; if the
  probe verdict is not in the bundle today, add elapsed ms and verdict to
  the existing diagnostics snapshot (Rust and TS mirrors together, no
  `Option` without `skip_serializing_if`).

Done when: a bundle exported after a probe shows its duration and verdict.

### S5. Tell a below-floor PC the truth before it goes live

Needs an owner decision first (see below); do not start it without one.

This PC's saved performance check says no tested profile can be encoded in
real time. Today Go Live ignores that. After S1 the user would create
platform broadcasts and then send a stream at a few frames per second, or
hit the Plan 067 startup failure.

- In the Go Live confirmation, when the saved performance check has
  `belowFloor=true` and the probe verdict is software encoding, show one
  plain warning: this PC cannot encode this stream in real time, viewers
  will see a frozen or stuttering picture.
- Owner decision: warn and allow, or block. Recommendation: warn and allow,
  because a block with no working alternative is worse than an honest
  warning, and the check can be stale.
- Do not add a stream step-down here. That is Plan 065 B3 and needs
  provider-aware planning.

Done when: a renderer test covers below-floor + software verdict (warning
shown) and a passing check (no warning).

### S6. No separate encoder means a shared encode, not a refusal

Do this right after S1.

- When the probe says a separate stream output is unavailable, re-plan the
  session as one shared encode at the provider-safe stream profile (the
  recording takes the stream's profile) and probe that shared plan. The
  planner already supports this: `go-live-panel.tsx:75` passes
  `separateEncodedOutputRoleAvailable=false` to get it. The start request
  and the probe request must be built from the same re-planned profile
  (`stream_output_topology_session_start_and_rpc_build_the_same_split_plan`
  guards this on the Rust side).
- Tell the user once, in plain words, in the Go Live confirmation: "This PC
  can't encode a separate recording while streaming, so the recording will
  match the stream (1080p30, 6000 kbps)." No HRESULT text in any toast; the
  technical reason stays in Technical details and the log.
- Keep a block only when the shared plan is also impossible.
- Captions burned into the stream only (`forceSameProfileSplit`, `:660`)
  also force a split. Decide and test that case: recommended is the same
  fallback with the burn applied to both.

Done when: an integration test with a rejected split verdict shows Go Live
proceeding with `outputRoles: ['shared']` and the stream profile for both,
one notice shown, and `session.start` params matching the probed plan.

## Verification

```sh
pnpm --filter @videorc/desktop exec vitest run \
  src/renderer/src/hooks/studio-provider.integration.test.ts \
  src/renderer/src/components/streaming/go-live-panel.test.ts
pnpm typecheck && pnpm lint && pnpm format:check
cargo fmt --check --all
cargo test -p videorc-backend stream_output_topology
cargo clippy -p videorc-backend -- -D warnings
pnpm check:windows
```

Use `RUSTUP_TOOLCHAIN=1.98.0` while the floating stable toolchain is broken.
The start path is touched, so also run `pnpm smoke:recording-studio` and
`pnpm smoke:record-latency:gate` on macOS; S1 must not add delay when the
check is already `ready`. Run the gates at low priority if Videorc is live
on this Mac.

Windows acceptance (owed, cannot be done on macOS): on a Windows 11 box,
launch, enable one destination, click Go Live within two seconds of the app
opening. Expected: the button shows the checking state, then the
confirmation opens. No red toast.

## Stop conditions

- If the reporter's bundle shows the probe finished and the state still read
  "Checking", the cause is a renderer state bug not found here. Stop S2 and
  reproduce that first.
- Do not remove the preflight or let a start proceed with no verdict.
- Do not raise or drop the deadline to make a test pass.

## Not checked

No Windows machine was used. How many times the reporter clicked, and
whether a later click got further, is unknown. The exact duration of the
stream probe on their PC is inferred from record-start timelines, not
logged. The 6.5 to 11.9 s figure is from the Plan 065 comment in the code.
