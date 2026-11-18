# Plan 249 S10: packed alpha feasibility remains undecided

Status: implementation prepared, acquisition **not run**. Local budgets are
**unmeasured**, managed qualification is **not-run**, and
`ALPHA_PRODUCTION_ENABLED` is **false**. This is an experiment and maintained
acquisition harness, not completion of S10's measured acceptance or authority to
start S11. A missing or failed budget cannot approve the transport.

## Experiment and authority

The test publisher sends VP8 RGB on the left and grayscale alpha on the right
of one video frame, separated by an eight-pixel gutter. Logical H is 640x360;
V is 360x640. Encoded frames are respectively 1288x360 and 728x640, at most
30 fps and 4 Mbps per publication. There are at most two experimental
publications (H and V), each reused by stream and recording receivers. These
limits intentionally do not establish full-resolution HTML or keyed-camera
fidelity. Increasing them requires fresh measurement and a budget decision.

The fixture uses the existing production-shaped host/guest grants via
`managedParityGrant` / `roomGrantFor`, and a hidden subscribe-only recorder
that cannot publish tracks or data. The host keeps camera, microphone and
screen; the two experimental publications use the existing CAMERA source.
UNKNOWN is deliberately tested for a 403 refusal. No source grant is widened.

`AlphaAuthority` is injected by the local acquisition controller after it
checks actual SFU participant and publication SIDs, source enums and counts.
The receiver verifies show, host identity, publisher SID, track SID, epoch,
generation, output, orientation, dimensions and a maximum 30-second lease.
The fixture denies every subscriber before publication and only grants exact
recipient SIDs their authorized track SIDs. Track names alone grant nothing.
The late recorder uses the same explicit authorization and current lease.

This injection is test authority, not a production authorization adapter.
There is no production alpha capability, relay, receipt, signed page-token
integration, guest lane or automatic enablement. S3 media-v2, S4 graphics and
S9 static graphics never imply alpha support. Any future production work must
extend the existing signed output-token capability/relay/receipt path with a
separate versioned default-off alpha field, and update **all** role readers
before allowing duplicate legacy sources. This slice changes no credential,
service activation or provider authority.

## Rendering and ownership

WebGL2 uses one reusable texture/program/buffer per owner, exact dimension
checks before upload, no frame queue (one latest frame), and one decode-driven
upload via `requestVideoFrameCallback`. The shader reconstructs unpremultiplied
RGBA and the browser composites it. Sparse diagnostic pixel readback runs once
per second, outside the frame loop. GPU allocation counters are estimates of
owned texture/backbuffer bytes, not a GPU-driver memory measurement; draw times
are CPU submission time, not GPU elapsed time. Context loss, invalid dimensions,
lease expiry, publication loss or owner/generation replacement closes the
consumer. Teardown releases the owned objects and is idempotent.

S6 geometry is canonical: normalized `OverlayRect`, `overlayRectPixels` on
`STAGE_CANVAS`, then `presentation-views.fitBox(..., "contain")`. The isolated
fixture places alpha in a banner root above sources, below future caption,
chat, avatar, bubble and highlight roots. No production stage imports it.
S9's static topic and capability are separate. A program-page stage key is
never an alpha receipt or encoded-output acknowledgement.

## Maintained acquisition (authored, prohibited from execution this turn)

After all merges and separate authorization, from a clean installed desktop
checkout with the matching clean installed web checkout:

```sh
VIDEORC_PARITY_WEB_ROOT=/absolute/paired/web CHROME_PATH=/absolute/chromium \
  pnpm smoke:cloud-parity -- --case alpha-spike
```

Requirements are existing `livekit-server`, Chromium/Playwright, ffmpeg, and
`ps`. The harness never installs these. It only accepts a local paired checkout,
starts an owned loopback SFU with a newly generated temporary local key, and
deletes its config during cleanup. It reads no saved credentials and accepts
no managed URL. Static fixture pages have restrictive CSP, no remote HTML,
external asset fetch or frame-PNG transport. Screenshots are evidence only.

Four matched cases run: baseline/alpha x clean/TCP-jitter. Each has six
camera+microphone publishers, host screen, independent H/V stream views, and
H/V recorders joining after 15 seconds. Every lane supplies a full 30-minute
raw sample span; recorder startup does not shorten its soak. Procedural hard
RGBA animation includes opaque, half-alpha and transparent patches plus a
24-bit clock strip with an eight-bit checksum. No guessed latency replaces a
failed checksum. `VIDEORC_ALPHA_SECONDS=30..1800` can shorten a future diagnostic
run; any value below 1800 must fail the qualification budget.

Jitter is a bounded loopback TCP byte proxy (0 or up to 80 ms ordered delay,
backpressure, 2 MiB per-direction queue cap, at most 128 sockets). The browser
ICE shim refuses non-loopback candidates, removes UDP and points TCP to that
proxy. The analyzer requires the **selected actual remote candidate** to use
the proxy port and verifies observed proxy traffic/delay. This is TCP-only
local evidence; it says nothing about managed UDP behavior or WAN budgets.

Acquisition retains raw per-second RTC decode/bytes/drop/jitter-buffer/freeze
counters, HTML video playback counters, 30-fps rAF scheduling cadence, CDP
TaskDuration/JS heap, browser-owned process CPU/RSS, publisher/consumer GPU
counters, clock latency and decoded alpha/color samples. It also saves
per-minute screenshots and complete browser video artifacts for all four
lanes, source hashes, exact runtime versions and SHA-256 artifact inventory.
Large videos are hashed as streams. The analyzer decodes the finished videos
with ffmpeg and checks solid/half/transparent compositing against the screen
background; an in-memory pixel report alone is insufficient.

The rAF counter is a **local scheduling proxy**, and Playwright video is a
**local browser artifact**, not managed encoded-egress evidence. CPU/RSS span
the acquisition Chromium processes, including publishers/receivers; they are
not Electron/native-production CPU measurements. Exact runtime renderer and
browser versions are acquired when the harness runs, not inferred now.

## Budget decisions

The analyzer requires the complete 4-case x 4-lane matrix, integrity-checked
raw/video artifacts, six participants plus screen, exact host source counts,
positive media/decode counters, finite CPU/memory/cadence counters, at least
900 samples, and 1800 seconds per lane. It rejects missing metrics.

- Added video dropped-frame ratio and rAF cadence-miss ratio each <=1 percentage
  point over the matched no-layer baseline.
- Local sampled paint-to-reconstructed-frame latency p95 <=500 ms; last-quarter
  median must not grow by more than 50 ms over the first steady quarter.
- Solid/half/transparent alpha error <=16/255, RGB and finished-composite error
  <=24/255. These are declared experimental codec tolerances, not evidence.
- Startup includes all decoded video sources and the first GPU composite;
  <=15 seconds after recorder connection, reported separately.
- No >10% monotonic process-RSS or JS-heap rise after two-minute warm-up.
- One-frame GPU queue, owned texture/backbuffer estimate <=3 MiB per receiver,
  no GPU context loss, proxy overflow or unverified network path.

A passing local decision still returns `productionApproved: false`,
`managedQualification: "not-run"`, `capabilityEnabled: false` and an undecided
production feasibility decision. Managed S27 performance (including combined
avatar/HTML workloads, real encoder/frame cost and independent output gates),
full-resolution fidelity, real Electron capture/publisher cost, real device
and browser support, every role-reader interaction and source-count support
remain deferred. No paid or managed acquisition was attempted or authorized.

## Exact source inspection, not measured support

| Component                      | Inspected version | What is known                                                                                                                                            |
| ------------------------------ | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop/web livekit-client     | 2.23.0            | `LocalParticipant.publish` logs a second same-source track and continues; source permission is checked first. This is not an SFU/source-count guarantee. |
| Web livekit-server-sdk         | 2.19.2            | Existing source-restricted grant shapes are reused; no new source authority.                                                                             |
| Installed local livekit-server | 1.13.10           | Version-only inspection; not started. Multiple CAMERA publications remain unmeasured.                                                                    |
| Installed Electron             | 39.8.10           | Not launched or qualified; acquisition uses a separately versioned Chromium fixture.                                                                     |

Requested host counts are baseline CAMERA=1/MICROPHONE=1/SCREEN_SHARE=1 and
alpha CAMERA=3/MICROPHONE=1/SCREEN_SHARE=1. Each recorder subscribes to six
cameras + one screen + its single alpha orientation (eight videos), versus
seven in baseline. SDK source permits do not establish a safe production
count. Legacy consumers select by source and have not been changed for these
extra CAMERA publications. Therefore the experiment must remain isolated.
