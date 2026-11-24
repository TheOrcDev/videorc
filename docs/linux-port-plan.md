# Linux Port Plan

Linux is a **public Alpha** on its way to Beta. Since 0.9.122 every
`<version>-alpha.1` Linux AppImage has been published through the signed-in
videorc.com download under an **owner waiver**: no physical acceptance pass
was ever performed (`docs/acceptance/linux-alpha/*.json`, `performed: false`;
0.36.0 is the latest). The Beta bar, the supported desktops and the parity
matrix against macOS live in
[plan 257](../plans/257-linux-beta.md). The L-phases below are the original
delivery history of the port; each has an implementation, and the status
column says what is still short.

## Support baseline

| Area | Alpha baseline | Current status |
| --- | --- | --- |
| Distribution | Ubuntu 24.04 LTS (the CI build and packaging box) | Shipped as an AppImage built on Ubuntu 24.04; supported desktops are the Tier table below |
| Architecture | x86_64 | x64 only; arm64 is not in Beta |
| Display session | Wayland first | Wayland is the Tier 1 session; X11 is best effort (global shortcuts work there, not on Wayland) |
| Screen/window capture | `xdg-desktop-portal` backed by PipeWire | Works (L4). CPU copy into BGRA, no DMA-BUF; one stream, no resolution-change follow; no app scenes or Follow front app (no Wayland API) |
| Camera | V4L2 | Works, degraded (L3): an FFmpeg `-f v4l2` child scales on the CPU (about 180 % CPU at idle with ogre's FaceTime camera, plan 257 audit); no hotplug until restart |
| Audio | PipeWire | Microphone through pipewire-pulse (L2). Desktop/system audio is missing. Live captions are not available yet |
| Preview | CPU composition and BMP transport | Works, degraded (L5): the Electron proof surface polls per-source BMPs on the CPU and Health reports "Fallback"; no live canvas on the Scene tab |
| H.264 encode | VAAPI hardware, OpenH264 software fallback | Works (L1.5, proven on ogre 2026-11-23): with nothing set, `auto` probes the render nodes and picks VAAPI on Intel iHD; OpenH264 is the fallback. AMD VAAPI is unproven (no second box, D2); no NVENC arm |
| Packaging | AppImage | Shipped (L6), unsigned, public Alpha under owner waiver. No self-update: the app only shows a changelog notice |
| Videorc Camera (plan 214 D) | v4l2loopback: the user installs the module, the app loads it with `pkexec modprobe … exclusive_caps=1 card_label="Videorc Camera" video_nr=42` and writes YUYV 1080p30 to the device found by name | Written and compiled by the Linux CI job; hidden (`PROVEN = false` in `virtual_camera_linux.rs`) until spike P0c passes on a named box |

### Supported desktops (plan 257, D1)

| Tier | Distro and desktop | Session | GPU and encoder |
| --- | --- | --- | --- |
| 1 (beta-supported, in acceptance) | Ubuntu 24.04 LTS, GNOME 46+ | Wayland | Intel iHD or AMD radeonsi VAAPI |
| 1 | Arch-family (Omarchy) with Hyprland 0.5x (ogre) | Wayland | Intel iHD VAAPI; OpenH264 fallback |
| 1 | Fedora 41+ KDE Plasma 6 | Wayland | VAAPI |
| 2 (best effort, bug reports accepted) | The same distros on X11; Sway and other wlroots; Debian 13; Linux Mint | Either | VAAPI, NVENC (after plan 257 S6), OpenH264 |
| Not supported | VMs, arm64, Ubuntu 22.04 and older (old PipeWire and portal) | n/a | n/a |

Minimums: PipeWire 1.0 or newer with pipewire-pulse, xdg-desktop-portal 1.18
or newer with the desktop's backend, a Secret Service (gnome-keyring or
KWallet), and the user in the `video` and `render` groups.

Ubuntu 24.04 GNOME Wayland is the packaging baseline and a Tier 1 desktop,
but no Ubuntu box has ever run an acceptance pass (plan 257 D2, owner-owed).
The encoder contract in L1.5 is distribution-independent and is accepted from
any named physical Linux x64 box (see "Named tester boxes").

Wayland capture must go through the desktop portal rather than bypassing the
user-consent boundary. PipeWire is required for screen capture and audio; V4L2
owns the first camera path. Exact portal, PipeWire, VAAPI, and window-system
development packages should be added only when the phase that uses them proves
the dependency is necessary.

## Licensing and encoder constraint

Videorc ships an LGPL-only FFmpeg distribution. Linux must never select or
bundle `libx264`, because that would introduce GPL requirements incompatible
with the product's open-core distribution model.

The Linux encoder decision is:

- probe `/dev/dri/renderD*` with the exact staged FFmpeg binary and select VAAPI
  only when a real `h264_vaapi` encode succeeds; and
- use OpenH264 as a supported software fallback when automatic VAAPI probing
  fails.

`VIDEORC_LINUX_H264_ENCODER=auto|vaapi|openh264` controls the selection. `auto`
is the default. Forced `vaapi` fails session startup if the probe fails; forced
`openh264` chooses the software path directly. Automatic or explicit OpenH264
selection is logged and exposed in diagnostics without raising a health alert.

### Render-node policy on multi-GPU hosts

A VAAPI probe on the wrong GPU can hang the whole host (ogre, 2026-09-24: the
amdgpu node lost its command stack, firmware recovery failed, and the session
collapsed into an unclean reboot). The probe timeout cannot rescue a kernel
GPU hang, so the policy keeps the app from touching a bad node at all:

- `VIDEORC_LINUX_VAAPI_DEVICE=/dev/dri/renderDNNN` pins the probe to one
  node. With the pin set, `auto` and `vaapi` probe that node only; a value
  that is not an existing render node is a typed startup error.
- Before probing a node the backend writes
  `<app data>/linux-vaapi/probe-in-progress.json` (`node`, `driver`,
  `startedAt`, `ffmpegSha`) and deletes it when the probe returns, pass or
  fail. A file still present at the next backend start means the previous
  backend died mid-probe (the host hung or was rebooted, the backend was
  killed): the node is appended to `<app data>/linux-vaapi/quarantined.json`,
  logged at `warn`, listed in diagnostics, and never probed again unless the
  pin names it explicitly. A probe future dropped in-process (a cancelled
  session start, quit mid-probe) clears its own sentinel: the process is
  still alive, so the node did not hang the host.
- A probe still running after 20 s is the same hang seen from inside the
  process (#1027): FFmpeg is killed and reaped, the node is quarantined on
  the spot with `timedOutAfterSecs`, the `compat` argument profile is never
  tried on it (a timeout is not an argument rejection), and no further node
  is probed in that backend lifetime, because the timed-out FFmpeg may still
  hold its GPU and the driver may be mid-reset. The nodes left over are
  listed as `skipped` and probed at the next start.
- `cargo test -p videorc-backend` never probes a render node and never reads
  or writes the real quarantine: a unit test gets a throwaway quarantine
  directory under the temp dir unless `VIDEORC_DATABASE_PATH` isolates one,
  and the resolver answers "unit tests never probe render nodes" unless
  `VIDEORC_LINUX_VAAPI_DEVICE` names the one node a test may use.
- The backend probes once per lifetime per FFmpeg path and caches the
  decision; sessions do not re-probe. A forced `openh264` session does not
  invalidate the cached VAAPI decision.
- The probe runs the session's real encode arguments and filter chain at the
  session's resolution, not a 128x72 black clip, so a probe pass predicts a
  session pass.
- Diagnostics list every render node with its driver (the basename of
  `/sys/class/drm/<node>/device/driver`) and probe state: `probed-ok`,
  `rejected`, `quarantined`, or `skipped`.
- The driver is evidence, not policy. There is no amdgpu or other driver
  blocklist; most amdgpu boxes encode fine through VAAPI. The quarantine file
  is box-local state.
- A quarantine entry names the GPU, not its node number (plan 257 S5).
  Numbers can swap between boots (ogre, 2026-10-20: the AMD GPU came up as
  `renderD128`). Entries carry the PCI address (`device`, the basename of
  `/sys/class/drm/<node>/device`) and the driver. A node matches an entry by
  PCI address when both sides know it, else by driver, else by node name
  (an entry planted by hand with neither). ogre's older entry
  (`renderD129`, `amdgpu`, no address) therefore keeps the AMD GPU out
  whichever number it boots with.
- An isolated profile (`VIDEORC_DATABASE_PATH` elsewhere, as every smoke
  sets it) also reads the machine's list beside the un-isolated database
  (`~/.videorc/linux-vaapi/quarantined.json`) and never writes it. A hang is
  a fact about the hardware: without this, a fresh smoke profile started with
  an empty list and, unpinned, could probe the GPU the machine had already
  quarantined.

### Named tester boxes

| Box | Hardware | Distribution / session | Render nodes | Role |
| --- | --- | --- | --- | --- |
| ogre | T2 MacBook Pro, Intel UHD 630 (Coffee Lake) + Radeon Pro 555X, FaceTime HD camera | Omarchy 4.5.0 (Arch family), Hyprland / Wayland, PipeWire + `xdg-desktop-portal-hyprland` | `renderD128` i915, allowed; `renderD129` amdgpu, **quarantined** after the 2026-09-24 host hang | Named physical tester for L1.5 through L5 |

Beta needs a second named Tier 1 box, an Ubuntu 24.04 x64 machine (plan 257
D2, owner-owed), for the AppImage and updater evidence; ogre does not
substitute for it. Until that box exists AMD VAAPI, GNOME, KDE and Ubuntu's
Secure Boot path cannot be accepted.

The binary pin lives in `vendor/ffmpeg/linux-pin.json`. Run
`pnpm ffmpeg:fetch:linux` on Linux x64 to download and stage it. The fetch step
checks the SHA-256, executes the binary, and fails closed unless the build is
LGPL-only, enables VAAPI and OpenH264, disables x264/x265/fdk-aac, and exposes
both `h264_vaapi` and `libopenh264` encoders. Linux CI repeats this check.

Second ogre run (2026-09-24, on Plan 052): OpenH264 records in-app; the only
matrix gap was missing `color_primaries`/`color_transfer` in the OpenH264
bitstream, now closed by the SPS VUI rewrite. VAAPI on `renderD128` rejects
the standard argument set with "Failed to end picture encode issue: 24"
while a plain CLI encode passes. The probe therefore tries a compat set
(CBR, no B-frames, no level pin) after the standard set fails on the same
node; that compat set is provisional until the bisect on the box confirms
which argument the iHD driver rejects (Plan 053, S3).
The bisect found the `-level 4.0` spelling (`linux-dev-loop.md`); on
2026-11-23 the standard set passed on `renderD128` in every run, so the compat
set stays as defence in depth only.

## Delivery phases

### L1 — Compile and CI gate

- Compile the backend natively on Ubuntu.
- Run clippy with warnings denied and the backend unit suite on every pull
  request and push to `main`; the main CI workflow owns platform-independent
  Rust formatting.
- Keep shared geometry and pixel conversion outside Apple-only modules.
- Return explicit unsupported results for runtime paths with no Linux backend.

The Linux and Windows clippy gates run with warnings denied and no lint allow
list. Code that only one platform uses is fenced with `cfg` at its definition
rather than allowed crate-wide.

### L1.5 — Encoder policy and provisioning

- Pin and verify the Linux x64 LGPL FFmpeg bundle.
- Select a probed VAAPI render node per session, with OpenH264 as the named
  software fallback.
- Preserve BT.709/video-range tags, profile/level, keyframe cadence, bounded
  rate control, and truthful backend diagnostics.
- Keep `libx264`, GPL, and nonfree builds out of provisioning and runtime args.

The code and CI contract are implemented, and L1.5 is proven on ogre
(2026-11-23, plan 257 S5): the two-backend acceptance passed with
`complete: true` and no device pin, and `auto` with nothing set picks VAAPI on
the Intel node while the AMD node stays quarantined. Record:
[`acceptance/2026-11-23-linux-l1.5-ogre.md`](acceptance/2026-11-23-linux-l1.5-ogre.md)
and its JSON. AMD VAAPI still needs a box whose AMD GPU encodes (plan 257 S21,
blocked on D2).

Run the hardware-only acceptance command on a named physical Linux x64 tester
box (the distribution is recorded in the evidence, not gated). It requires a
webcam, a VAAPI render node, and explicit tester/machine labels; it fetches
the pinned FFmpeg bundle, records 1080p30 through the real dev app once per
forced backend, checks the final artifacts and diagnostics, and writes
`linux-encoder-acceptance.json` beside the recordings. On a multi-GPU box set
`VIDEORC_LINUX_VAAPI_DEVICE` first; the pin is recorded too. Run the direct
matrix command from `linux-dev-loop.md` with the software backend before the
first acceptance attempt on a new box:

```bash
VIDEORC_LINUX_TESTER_NAME="<person>" \
VIDEORC_LINUX_TESTER_MACHINE="<specific box>" \
VIDEORC_LINUX_PHYSICAL_HARDWARE=1 \
pnpm smoke:linux-encoder-acceptance
```

`--backend=openh264` or `--backend=vaapi` may be used to diagnose one path,
but only the default two-backend run emits `complete: true` evidence and clears
the L1.5 hardware gate. CI runners and virtual machines are not substitutes.

### Videorc Camera (plan 214 D)

The Linux camera is v4l2loopback (`docs/linux-dev-loop.md` has the tester
steps). No Mac compiles its `cfg(target_os = "linux")` writer, so the Linux
CI job is its compile gate and spike P0c on a named box is its behaviour
gate: `ffmpeg -f v4l2 -i /dev/video42` reads 30 fps for 10 s and Chrome
Meet lists the camera only while the switch is on. Until P0c passes,
`virtual_camera_linux::PROVEN` is `false`, `platform_sink` answers
`hidden_until_proven("Linux")`, the status reports `platformStep:
unsupported` and the Output page shows no section; flipping that one
constant turns it on. The pure half (module detection, the state table,
the V4L2 ABI mirror) is tested on every platform. The `needs-setup`
message is the distribution's install command alone (the page shows it as
one copyable line; absent when the distribution is unknown); a load the
kernel refuses under Secure Boot comes back as a `failed` step with the
Machine Owner Key words. No kernel module is bundled, built or signed
(D9). STOP (plan 214): if the baseline box cannot load the module under
Secure Boot, Linux ships guidance only.

### Hardware stop before L2

This was the rule for building L2 onward: a named Linux tester and a specific
physical Linux x64 machine had to be recorded in "Named tester boxes" and the
L1.5 evidence had to be `complete: true`. L2 through L6 were then built and
shipped as an Alpha under owner waivers without that evidence. ogre's L1.5
evidence is now committed (2026-11-23). Beta removes the waiver: virtual
machines and CI runners still do not satisfy the gate, and both Tier 1 boxes
need a physical acceptance pass (plan 257 D11).

### L2 — PipeWire audio

- Discover and ingest microphone audio through PipeWire.
- Preserve mute/gain, sample format, reconnect, and explicit unavailable-state
  behavior behind the shared source contracts.
- Prove the phase with deterministic tests and a real-device audio artifact.

### L3 — V4L2 camera

- Discover and capture cameras through V4L2.
- Preserve stable source identity, format negotiation, switching, reconnect,
  and explicit unavailable-state behavior.
- Camera access depends on `video` group membership (and `render` for the
  encoder node); a missing group must surface as an explicit permission
  state with the fix named, never as a silent "no camera".
- Prove a camera-only recording on the named tester hardware.

### L4 — Portal and PipeWire screen capture

- Implement Wayland-first screen/window capture through
  `xdg-desktop-portal` and PipeWire.
- Model portal consent, cancellation, revoked sessions, missing sources, and
  reconnects as explicit states and diagnostics.
- Prove source switching and lifecycle behavior on the real Linux desktop.
- Status (Plan 0006, 2026-09-25): first cut landed. `linux_portal_capture.rs`
  (state model, restore-token store, BGRA copy, device entries; unit-tested
  on every platform), `linux_portal_session.rs` (ashpd session runner) and
  `linux_pipewire_stream.rs` (pipewire reader) feed the shared screen frame
  store; `pnpm smoke:linux-portal-capture` is the box gate. Reconnect after
  revoke is a restart with the saved token, not an in-place reconnect, and
  DMA-BUF import is not done.

### L5 — CPU composition and JPEG preview

- Reuse shared scene geometry in a Linux CPU compositor.
- Add the maintained JPEG preview transport with first-frame, liveness,
  backpressure, detach/reattach, and truthful fallback diagnostics.
- Prove composed recording and preview behavior without claiming a GPU-native
  preview surface.
- Status (Plan 0007, 2026-09-25): the Electron proof surface (uncompressed
  latest-wins BMP per source, `electron-proof-surface` /
  `electron-browser-window`) is the Linux preview, fed by the CPU compositor
  and the L4 portal screen store. Backend, supervisor, renderer and waiting
  copy name it "Linux CPU preview" and never a native surface;
  `pnpm probe:preview-lifecycle:linux` (`VIDEORC_EXPECT_LINUX_PROOF=1`) is
  the box gate. `pnpm smoke:portal-preview-proof` is the Phase D gate:
  granted `screen:portal:monitor` + ScreenOnly must show
  `sourcePixelsPresent=true` on `electron-proof-surface` (not synthetic).
  A composed-frame (single BMP) transport is not done; the proof surface
  layers per-source BMPs like Windows.

### L6 — AppImage, release lane, and acceptance

- Status: shipped as a public Alpha under owner waiver
  (`docs/acceptance/linux-alpha/`). `electron-builder.yml` has a Linux
  AppImage+dir target; `pnpm package:desktop:linux` +
  `preflight-linux-package.mjs` stage the release backend and pinned LGPL
  FFmpeg. `.github/workflows/release-linux-alpha.yml` builds an unsigned
  Ubuntu 24.04 x64 AppImage and stores it as a private candidate under
  `candidates/linux-alpha/<releaseId>/<sourceCommit>/`. There is no promote
  workflow: the release owner publishes the create-only
  `releases/linux-alpha/<releaseId>/release.json` (with the commit-pinned
  owner-waiver record URL) and the videorc-web download manifest env, and the
  signed-in videorc.com download serves it. The in-app update is a changelog
  notice, not an updater: the `latest-linux.yml` feed is not published, so
  Linux never self-updates.
- Still owed for Beta (plan 257): a promote workflow with a signature and
  `.sha256` per release, AppImage self-update from a published feed, packaged
  smoke on a named Ubuntu 24.04 box, and a physical acceptance pass on both
  Tier 1 boxes with no waiver.

- Build an Ubuntu 24.04 x64 AppImage with the verified LGPL FFmpeg payload.
- Use an isolated Linux lane under `releases/linux-alpha/`; never reuse or
  mutate the macOS Beta or Windows Alpha manifests.
- Add packaged-app device, recording, streaming, updater, and cleanup smokes.
- Beta publishes Linux only after dated real-device evidence on both Tier 1
  boxes meets the same quality and lifecycle bar as the other shipping
  platforms; the Alpha lane has used an owner waiver instead.

## Reference implementation and attribution

The `linux/phase0-compile` branch of
[`ForrestKnight/videorc-linux`](https://github.com/ForrestKnight/videorc-linux)
was used as a reference for identifying platform seams, including moving the
source-mask model out of the Metal implementation. Its stale branch is not
merged or cherry-picked: changes are re-derived against current Videorc code.
Its GPL `libx264` encoder choice is explicitly rejected by this plan.
Contributor coordination and DCO confirmation are tracked in
[`#247`](https://github.com/TheOrcDev/videorc/issues/247).
