# spike-room (plan 260 S0.8, lane L2)

LiveKit's Rust SDK (`livekit` =0.12.0) as the host of a talk-show room, the
way the backend would hold it (plan 260 D9). It measures plan 220's room
spike Part 2 (`videorc-rust:docs/rust-ui/spike-guests-room.md`) against a
local `livekit-server` with headless-Chrome guests running the desktop's own
`livekit-client` 2.23.0. The results are in the S0.8 report.

- `src/host.rs`: the host. A synthetic camera (I420 1280x720 at 30 fps,
  VP8, simulcast 180p/360p under 720p as Electron) and microphone (440 Hz),
  a screen on request (VP8, no simulcast, 4 Mbps), the stage message on
  `videorc.stage`, the overlay byte streams (a 2 MB PNG set in 16 KiB
  writes, a clear, two sets cancelled half-way), and no subscription to the
  program page. It decodes every guest frame and reads a 48-bit wall-clock
  barcode from it (camera-to-screen delay), and checks each guest's tone.
- `web/guest.html`: the browser side. `role=guest` publishes a barcoded
  canvas camera and a tone and watches the host; `role=watch` is Chromium's
  own WebRTC watching guest 0 (the Electron-like delay baseline);
  `role=program` is a managed show's program page.
- `run.mjs`: starts `livekit-server` on 17880-17881 (UDP 51000-51400), the
  pages and the host; samples the host's CPU and RSS; writes `pages.json`,
  `summary-host.json`, `host-cpu.csv`; greps everything written for the
  host's token. Refuses to run while Videorc is on air.

## Run (macOS)

Needs `livekit-server` (1.13), Google Chrome, and a checkout of `main` with
`pnpm install` done (for `playwright-core` and `livekit-client`; the paths
are at the top of `run.mjs`).

```sh
CARGO_PROFILE_RELEASE_STRIP=false CARGO_PROFILE_RELEASE_BUILD_OVERRIDE_STRIP=false cargo build --release
node run.mjs --name hold --guests 1 --watch --program --seconds 1800 --screen-at 300 --screen-for 60 --overlay-at 120
node run.mjs --name full --guests 9 --seconds 300 --overlay-at 60
```

`cargo build --release --no-default-features` is the same program without
the SDK: the size baseline.

**Trap:** libwebrtc's Objective-C categories load only with `-ObjC`
(`build.rs`); without it the first `PeerConnectionFactory` throws
`+[NSString stringForStdString:]: unrecognized selector`. The backend needs
the same link argument.

## Build on Windows and Linux (check 7)

The cross-build from macOS (`cargo xwin`) fails in `webrtc-sys`'s C++ bridge
on the xwin SDK headers, so the proof is a native build:

```powershell
cd spikes\gpui\spike-room
Measure-Command { cargo build --release } | Select-Object TotalMinutes
(Get-Item target\release\spike-room.exe).Length / 1MB
cargo build --release --no-default-features
(Get-Item target\release\spike-room.exe).Length / 1MB
```

On Linux (ogre), the same with `ls -l target/release/spike-room` after
`strip`. Send the minutes and both sizes.
