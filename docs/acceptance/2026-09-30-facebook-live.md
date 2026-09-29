# Facebook Live plan 079: execution evidence

Date: 2026-09-30. Branch: `feat/079-facebook-live`, based on `5ac14c24` (0.9.123 release; plan researched at `235d6014`).
This is S1 engineering evidence, not owner live acceptance or completion of
plan 079.

## Implemented

- A named Facebook manual-key destination and default RTMPS ingest, pinned
  horizontal when renderer settings reload.
- Platform enum, persistence and wire mirrors; event platform caps derive from
  the enum list rather than the old hard-coded seven.
- Secure manual-key references survive reload; OBS's Facebook Live service
  imports into the named card.
- Setup and Go Live explain persistent keys and the separate Live Producer
  publish action. Connected Page OAuth and comments explicitly stay unavailable.
- Phosphor Facebook brand mark, shared platform styling and remote glyph tint.
- Release-note fetching/control defer behind a dynamic import so the existing
  renderer budget is preserved: 1,999,509 raw / 385,931 gzip bytes.
- Web co-host compatibility prerequisite:
  https://github.com/TheOrcDev/videorc-web/pull/60 (`9047c470`). Its Vercel
  preview deployment passed; production deployment is pending.

## Local verification

| Gate                                                     | Result                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop tests                                            | 2,417 passed; one existing skipped test.                                                                                                                                                                                                                                                             |
| Node script tests                                        | 1,686 passed; the focused provider-readiness suite also passed all eight tests.                                                                                                                                                                                                                      |
| Typecheck                                                | Passed.                                                                                                                                                                                                                                                                                              |
| Lint                                                     | Passed with one existing `use-studio.tsx` hook dependency warning.                                                                                                                                                                                                                                   |
| Format check                                             | Passed.                                                                                                                                                                                                                                                                                              |
| Desktop production build and renderer asset budget       | Passed at the measurements above; no budget increase.                                                                                                                                                                                                                                                |
| Stream secret, start-label and platform-lifecycle smokes | Passed with the Facebook cases.                                                                                                                                                                                                                                                                      |
| Provider-readiness report                                | Ran; Facebook correctly reports paused/stream-key only. Real Twitch/Kick/X prerequisites are absent, so live-provider readiness is incomplete.                                                                                                                                                       |
| Rust targeted filters and clippy                         | Passed: streaming (40), storage (107), live_chat (72), oauth (92), audience (13), preflight (13); clippy and fmt clean.                                                                                                                                                                              |
| OAuth guard app smoke                                    | Passed, including Facebook refusal. Initial compilation timeouts resolved by allowing the app's non-incremental build to finish.                                                                                                                                                                     |
| App smokes                                               | Five-destination fan-out (including Facebook), all stream/recording artifact quality gates, fake comments and remote LAN passed. Comments window probe passed, including send/highlight correlation, live/history isolation, width sweeps and reopen persistence; inspected its narrow live capture. |
| Shadscan                                                 | Desktop baseline/floor/final 37/37/37; pre-commit audit from `apps/desktop`.                                                                                                                                                                                                                         |
| Web tests                                                | 633 passed; two opt-in live tests skipped. Typecheck passed; lint passed with four existing hook warnings. Shadscan 54/54/54 before commit.                                                                                                                                                          |

## Remaining owner and Meta gates

No live credentials were supplied or read. The owner's Meta Business app,
eligible Page, S0 device-login result, sign-in option A/B, SSE/drop/ingest probes,
and a persistent-key owner live remain outstanding. These are the prerequisites
for S2–S5; the connected-mode code is not implemented in this slice.

S6 also needs owner screencasts, App Review, Advanced Access, Access Verification,
release configuration and packaged acceptance. Nothing in this evidence enables
connected Facebook Pages publicly, publishes a Facebook video, or claims Meta
approval.

Before a Facebook desktop release, deploy web PR #60. A downgrade to an older
build cannot parse a stored `facebook` target because its Rust enum is strict;
the updater does not downgrade.
