# Plan 214: Videorc Camera in Meet and Zoom

> **Executor instructions**: This plan is three spikes (P0a to P0c) and six
> workstreams (A to F), one PR each. Nothing in A to F starts before the
> owner's go on D1 and the spike for that platform is a go. Pick a
> workstream from "Order of work", follow its slices in order, and run
> every "Done when" check before moving on. If anything in "STOP
> conditions" happens, stop and report; do not improvise. When a
> workstream is done, update this plan's row in `plans/README.md` and fill
> in its "As built" line. Gates run once at the end of each workstream
> (owner rule): write and commit its slices first, then run its gate.
> Spike code never enters the tree; only its findings do (in this plan's
> "As built").
>
> **Drift check (run first)**: `git diff --stat b7e68a2c..origin/main --`
> plus the paths listed under your workstream. If an anchor quoted below
> has moved, re-find it by the symbol name. If a _behaviour_ changed (not
> just a line number), that is a STOP condition.

## Status

- **Status:** MERGED 2026-11-03 as
  [#1091](https://github.com/TheOrcDev/videorc/pull/1091) (`bc84c35ec`)
  for macOS and the shared parts, with Linux hidden. The owner said "merge
  it" before CI and the review had finished. Windows (C) follows as its own
  PR. The owed smokes and on-device checks are in "As built".
- **Was:** EXECUTING 2026-11-03. The owner, before the plan was
  finished: "when plan is ready, execute the entire plan and create a
  pr". So D1 is **go**, D2 to D14 are taken as recommended, and the whole
  plan ships as **one PR** (not one per workstream).
  - Spikes: P0a waits on B0 (the Apple portal). P0b and P0c wait on the
    Windows and Linux boxes.
  - Work that no spike can change starts now: A, E, F1 and B's source.
    Each platform's on-device proof stays owed until its spike runs.
  - Lanes: Codex is out until 2026-11-04 12:40, so the `gpt-6.1-sol`
    workstreams (D, F) run on `fable-5.1`, the next stronger lane.
- **Owner, 2026-11-03, later:**
  - "Don't do smokes and runs here. We are going to do it later when we
    merge everything to main." No smoke, probe, app launch or
    on-device run happens before the merge. The PR lists them as owed.
  - Workstream C (Windows) kept hitting account limits, so the owner
    chose to ship it as a **follow-up PR**. PR 1 carries macOS, Linux
    (hidden) and the shared parts. Windows stays hidden (`unsupported`),
    and its Set up action answers "Not available on this computer."
    until C lands.
- **Was:** PLANNED 2026-11-02.
- **Source:** the owner, 2026-11-02: "how hard would it be to create a
  virtual camera from Videorc? like OBS has, that can be used for example
  as camera source in Google meet etc?" After a short feasibility answer:
  "ok plan it out properly for all platforms".
- **Planned against:** `origin/main` `b7e68a2c`, in
  `.claude/worktrees/agent-ad1819c2c9d036ea7` (branch
  `plan-214-virtual-camera`). Work in a fresh worktree from `origin/main`.
- **Owner route:** Orchestrator, fit 10, for the plan as a whole. Each
  workstream names its own route and model lane from `CLAUDE.md`.
- **How the facts were found:** one read-only investigation of `b7e68a2c`
  (`git show`, `rg`, no build, no test, no app launch: this Mac's swap was
  nearly full and a disk-exhaustion panic happened the same day), plus
  the primary sources listed under "Sources". Each fact is marked
  **verified** (read in the code or the cited source) or **guess**
  (reasoned, not reproduced). Nothing was built or run.

## The short answer

Medium-hard, and most of the difficulty is not the camera. On every
platform the camera itself is a few hundred lines that take frames the
compositor already makes. What is new for this repo:

- **macOS:** a sandboxed Camera Extension (a system extension) inside the
  app bundle, a restricted entitlement, and so a Developer ID provisioning
  profile for the app and one for the extension. That changes signing,
  notarization, the release validator and CI secrets. It is
  release-critical: get it wrong and the app is killed at launch.
- **Windows 11:** a COM media-source DLL that Windows loads into its own
  Frame Server service (another user, another session), a cross-process
  shared-memory ring, and a one-time elevated setup step because the DLL
  must be registered machine-wide and live outside the user's profile.
- **Linux:** easy, but it needs a kernel module (v4l2loopback) the user
  installs, and root to load it.
- **Videorc side:** a new output that reads the program as the Preview
  shows it, converts it off the compositor tick, and asks the compositor
  for pixels at idle on Windows and Linux (today it composes none there).

No audio: a virtual camera carries no sound. A virtual microphone is a
separate, harder project (see "Not in this plan").

## The product question first

The owner pivoted Videorc's goal to "a smooth preview and a correct
recording; OBS parity dropped" (`docs/windows-port-plan.md:4`,
**verified**). A virtual camera is an OBS-parity feature. It also serves
a different person than a streamer: anyone who wants their Videorc scene
(camera shape, background, banners, Buddy) in a meeting. The plan is
written so the owner can say no at D1 with nothing lost, or yes with the
scope fixed to "the program as a camera", not OBS parity.

## What we found, in one table

| #   | Question                                      | Finding (short)                                                                                                                                                                                                                                                                                                                                            | Mark     |
| --- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 1   | Earlier virtual-camera work                   | None. "Virtual cams" appear only as consumed slow-waking sources (`live_layout.rs:67`, changelog 0.9.52).                                                                                                                                                                                                                                                  | verified |
| 2   | Where the program is                          | A `FrameStore` per leg on `CompositorRuntime`: `frame_store` (primary), `stream_frame_store` (aux), `program_frame_store` (the Preview's own picture, plan 205 S6). `presented_frame_store` picks the program leg when current, else the primary (`compositor_preview_frame_lease.rs:26-77`). Consumers poll `latest()` (the encoder bridge does, `encoder_bridge.rs:7922`). | verified |
| 3   | Frame formats                                 | macOS: a 32BGRA CVPixelBuffer backed by an IOSurface, a 3-slot ring with in-flight guards (`metal_compositor.rs:1153-1260`). Windows D3D11: BGRA8 or NV12 textures by lease ticket (`compositor.rs:178-212`). CPU path: planar I420, BT.709 video range (`compositor.rs:5037`).                                                                           | verified |
| 4   | Does the compositor run idle?                 | Only while a Preview surface exists, sized to the surface, `NativePreview` consumer (`preview_surface.rs:1899-1925`). On macOS that is Metal, so pixels exist. Off macOS the idle tick publishes metadata-only frames: no pixels (`compositor.rs:647-654`, `:10117-10126`).                                                                               | verified |
| 5   | Fixed canvas at idle                          | Only through a capture lease: a session or Clips arms the preview run in place at its canvas (`arm_compositor_for_capture`, `compositor.rs:4127`). It refuses when already leased or not preview-owned. Clips is on by default, so most idle runs are already leased at the recording canvas with pixels.                                                   | verified |
| 6   | Hide screen                                   | Made at the capture source; every leg that reads the frame store gets the frost (`screen_privacy.rs:1-16`, AGENTS.md). A new reader is covered by construction; the smoke still proves it.                                                                                                                                                                 | verified |
| 7   | macOS mechanism                               | A Camera Extension (CoreMediaIO, macOS 12.3+). Legacy DAL plug-ins stopped loading in macOS 14.1. OBS uses the extension on macOS 13+ and pushes copied NV12 pixel buffers from the OBS process into the extension's sink stream through the CMIO C API.                                                                                                   | verified |
| 8   | macOS signing                                 | `com.apple.developer.system-extension.install` is restricted: the app and the extension each need a Developer ID provisioning profile embedded, and the bundle notarized. OBS applies the extension entitlements only when a profile is configured. Today Videorc has no profile and one plist for the app and every helper (`electron-builder.yml:108-109`). | verified |
| 9   | macOS activation                              | `OSSystemExtensionRequest` from the app in `/Applications`; an admin allows it in System Settings (Privacy & Security on 13/14; General → Login Items & Extensions → Camera Extensions on 15). Deleting the app uninstalls it. Developer mode needs SIP off.                                                                                               | verified |
| 10  | Windows mechanism                             | `MFCreateVirtualCamera` (build 22000+). The media source runs in the Frame Server service (Local Service, session 0); the DLL is registered in HKLM and must sit outside the user profile. The vcam is seen by Media Foundation and DirectShow apps alike; a DirectShow-only filter (OBS's route) is invisible to the Camera app and the new Teams. | verified |
| 11  | Windows install                               | The NSIS installer is per-user (`perMachine: false`, `electron-builder.yml:243`). HKLM and a Program Files/ProgramData copy need elevation. Frame transport is a named `Global\` section the media source creates with a DACL; the app opens it.                                                                                                             | verified |
| 12  | Linux mechanism                               | v4l2loopback: `v4l2loopback-dkms`, `modprobe … exclusive_caps=1 card_label=…`, the writer sets the format. OBS runs `pkexec modprobe` and writes YUYV. Secure boot can block an unsigned module.                                                                                                                                                           | verified |
| 13  | Linux support level                           | Alpha, candidate-only; preview is CPU composition + JPEG; ogre (Arch, Hyprland) is the named tester; an Ubuntu 24.04 box is still needed for L6 (`docs/linux-port-plan.md:10-20, 84-87`).                                                                                                                                                                 | verified |
| 14  | Feedback loop                                 | Cameras are listed per platform: `AVCaptureDeviceDiscoverySession` (`camera_capture.rs:667-720`), `MFEnumDeviceSources` (`camera_capture.rs:466-516`), sysfs (`linux_v4l2_camera.rs:1-12`), plus the FFmpeg avfoundation probe (`devices.rs:109-120`). None filters a Videorc device.                                                                     | verified |
| 15  | Packaging                                     | macOS ships bare binaries in `Contents/Resources` (backend, preview helper, mcp, the `.node` addon, ffmpeg) signed with the one plist (`electron-builder.yml:72-104`, `sign-macos-local-app.mjs:44-77`). electron-builder has `provisioningProfile`, `entitlements`, `entitlementsInherit`, `minimumSystemVersion`. The README says macOS 13+; no `LSMinimumSystemVersion` is set. | verified |
| 16  | Release and CI                                | Release builds on `macos-15` with `CSC_LINK`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` (`release-macos.yml:93-97, 171-178`). Rust CI on `macos-15` and `windows-latest`. The gh token lacks `workflow` scope: workflow edits need the owner's merge click.                                                                                 | verified |
| 17  | Premium rule                                  | "Premium is the features Videorc pays to serve" (`entitlements.rs:11-19`). A camera runs on the user's machine.                                                                                                                                                                                                                                             | verified |
| 18  | Bundled FFmpeg for the smoke                  | macOS: `--enable-avfoundation` (`build-ffmpeg-macos.sh:90`). Windows: `ffmpeg-capture.exe` with DirectShow (`electron-builder.yml:169`). Linux: BtbN build; v4l2 input presumed.                                                                                                                                                                           | guess    |

## Order of work

| Wave | Work                                              | Why this order                                                                                                         | Runs in parallel?                                                        |
| ---- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 0    | Owner decisions D1 to D14; Apple portal (B0)      | Nothing ships without D1. The profiles take owner time, not agent time.                                                | Owner only.                                                              |
| 1    | P0a macOS spike, P0c Linux spike                  | P0a settles signing, profiles, nesting and AMFI: the release-critical unknowns. P0c is half a day.                     | Yes. P0a on a Mac with the Developer ID cert; P0c on the Linux box.      |
| 1    | P0b Windows spike                                 | Settles Frame Server, the shared section and the elevated setup.                                                       | Yes, on the Windows box. ≤3 Rust delegates at once (host rule).          |
| 2    | A the output tap                                  | Shared by every platform. Mostly pure Rust with unit tests.                                                            | After P0a is a go. Alone: it touches `compositor.rs`.                    |
| 3    | B macOS camera                                    | The Beta platform; the owner's daily Mac.                                                                              | After A. B and E share no files.                                         |
| 3    | E UI and copy                                     | Needs A's status contract only.                                                                                        | With B.                                                                  |
| 4    | F smoke, docs, release                            | Proves B on a signed packaged build in /Applications.                                                                  | After B and E.                                                           |
| 5    | C Windows camera                                  | After F proves the shape on macOS.                                                                                     | C and D are separate files; cap backend builds at two (`pnpm cargo:slot`). |
| 5    | D Linux camera                                    | Candidate-only, like the Linux Alpha.                                                                                  | With C.                                                                  |

## Decisions for the owner

Each has a recommendation. The plan is written to the recommendation.

- **D1. Go or no-go.** The goal is "smooth preview + correct recording;
  OBS parity dropped". _Recommended:_ go, scoped as "your program as a
  camera for other apps", off by default, free. It reaches people who
  never stream (meetings, classes), and the Preview already makes the
  picture. If no: file this plan as PARKED; nothing else changes.
- **D2. The name.** _Recommended:_ **Videorc Camera** everywhere. Windows
  appends " Windows Virtual Camera" to the name on its own (Microsoft's
  docs), so Windows apps show "Videorc Camera Windows Virtual Camera"; we
  can't stop that.
- **D3. Free or Premium.** _Recommended:_ free. It costs Videorc nothing to
  serve (the rule in `entitlements.rs`).
- **D4. Off by default, remembered.** _Recommended:_ off; the switch is
  saved and the camera comes back at the next launch when it was on.
- **D5. Which picture.** _Recommended:_ the program as the Preview shows it
  (`presented_frame_store`), including the Preview hold during a
  performance check (never test noise in a meeting) and the packaged
  backstop. Stream-only Buddy, banners and highlights appear exactly when
  the Preview shows them (plan 205 D2). No dedicated leg, no aux wiring.
  _Also possible:_ the primary leg (the recording's picture), which would
  drop stream-only layers from the camera.
- **D6. Platform order.** _Recommended:_ macOS, then Windows, then Linux.
  macOS is the Beta and the signing spike is the big unknown. Linux is a
  candidate-only track.
- **D7. Windows technology.** _Recommended:_ Media Foundation only
  (`MFCreateVirtualCamera`). Videorc ships on Windows 11 only, and an MF
  camera is seen by Chrome, Edge, Zoom, the new Teams, Discord and the
  Camera app. A DirectShow filter (OBS's route) adds a second DLL and a
  `regsvr32` step for apps that MF already reaches. _Also possible:_ both,
  for old DirectShow-only apps; a later plan if anyone asks.
- **D8. Windows setup step.** The DLL must be registered in HKLM and live
  outside the user profile, and the installer is per-user.
  _Recommended:_ a one-time "Set up Videorc Camera" button in the app
  that elevates once (UAC), copies the DLL to `%ProgramData%\Videorc\camera\`
  and writes the HKLM keys; it runs again only when the DLL version
  changes. _Also possible:_ a per-machine installer (changes every
  Windows install and the updater).
- **D9. Linux support level.** _Recommended:_ ship it in the Linux Alpha
  with "Install v4l2loopback" guidance (the distro command shown) and a
  `pkexec modprobe` load. No kernel module is bundled or built.
- **D10. Spikes first.** _Recommended:_ yes. P0a and P0b are go/no-go
  gates with throwaway code outside the tree. Skipping them risks
  learning about AMFI or the Frame Server in a release.
- **D11. Format.** _Recommended:_ one format, 1920×1080 at 30 fps. A
  vertical program is pillarboxed on black, never cropped. No mirror
  switch: Meet mirrors only your own self-view, others see it right; the
  Output page says so in one line. _Also possible:_ a 720p choice.
- **D12. When Videorc isn't running (macOS).** The extension is a process
  of its own and keeps the camera in every app's list once installed.
  _Recommended:_ it draws a still that says "Videorc isn't running" (off:
  "Videorc Camera is off · Output → Videorc Camera"). On Windows and
  Linux the camera exists only while the switch is on in a running
  Videorc.
- **D13. Wake only for a viewer.** _Recommended:_ on macOS and Windows the
  compositor is asked for pixels only while some app holds the camera;
  on Linux it writes whenever the switch is on (no reader count exists).
  _Also possible:_ always on while the switch is on (simpler, costs CPU on
  Windows and Linux idle).
- **D14. Where the switch lives.** _Recommended:_ the Output page, a new
  "Camera for other apps" section under Clips (one home). ⌘K and the
  agents' settings tool mirror it. Nothing in the Studio transport, no
  toolbar button (owner rules).

---

## Phase 0: spikes, kept out of the tree

Each spike is a throwaway folder outside the repo (`~/videorc-vcam-spike/`).
Only findings land in this plan's "As built". Each has a go/no-go.

### P0a. macOS: a signed, notarized test-pattern camera

**Route:** Diagnose, fit 9. **Lane:** `fable-5.1` (signing, provisioning,
AMFI). **Needs:** the Developer ID certificate, the two profiles from B0,
a Mac with SIP on (what users have).

1. Apple's Camera Extension template (Xcode): extension id
   `dev.theorcdev.videorc.camera`, app group
   `C2PA37RB58.dev.theorcdev.videorc`, `CMIOExtensionMachServiceName`
   `C2PA37RB58.dev.theorcdev.videorc.camera` (the mach service name must
   be prefixed by the app group: Apple's doc and WWDC22). A source stream
   at 1920×1080 32BGRA 30 fps and a sink stream, as OBS does. The source
   draws a moving test pattern when nothing is pushed.
2. Sign with Developer ID, both profiles embedded, notarize, staple, copy
   to `/Applications`, activate. Approve in System Settings. The camera
   shows in FaceTime, Meet (Chrome), Zoom and Discord.
3. Nest the same `.systemextension` into a locally packaged Videorc.app:
   hand-run an `afterPack` step that copies it to
   `Contents/Library/SystemExtensions/`, split the entitlements (main app
   gets the system-extension and app-group keys; helpers keep today's
   five), embed the app profile, sign with `sign-macos-local-app.mjs`
   adapted, copy to `/Applications`, launch. **The app must launch** (no
   AMFI kill) and activate the extension from Electron's main process
   (a 50-line objc2 `OSSystemExtensionRequest` in a scratch `.node`).
4. A scratch Rust CLI pushes a Metal-rendered BGRA IOSurface into the
   sink at 30 fps through `CMIOStreamCopyBufferQueue`,
   `CMIODeviceStartStream`, `CMSimpleQueueEnqueue` (OBS's calls). Meet
   shows it. Measure: CPU of the pusher, frames queued vs consumed,
   whether the extension copies or passes the IOSurface through.
5. Try the pusher as a bare binary in `Contents/Resources` (where
   `videorc-backend` lives) and as Electron main. Record which one sees
   the device (TCC attribution) and whether a camera prompt appears.

_Go when:_ 2, 3 and 4 pass on macOS 15 (and 13 or 14 if a Mac is
available). _No-go when:_ the portal can't issue the profiles, the nested
app is killed at launch, or notarization rejects the bundle. Report
which, with the exact error (`OSSystemExtensionError` codes are listed in
"Sources").

### P0b. Windows 11: an MF test-pattern camera seen in Chrome Meet

**Route:** Diagnose, fit 9. **Lane:** `fable-5.1`. **Needs:** the Windows
box (not CI: `windows-latest` is a Server image; whether its Frame Server
can host a vcam is a **guess**).

1. Build Microsoft's `Samples/VirtualCamera` SimpleMediaSource. Copy the
   DLL to `%ProgramData%\Videorc\camera\`, register HKLM
   `CLSID\{…}\InProcServer32` (elevated). Create a Session, CurrentUser
   vcam from a scratch Rust program through the `windows` crate (confirm
   `MFCreateVirtualCamera` is bound; else a 30-line C++ shim). Chrome
   Meet, the Camera app, Zoom and the new Teams list and show it.
2. Replace the synthetic frames with a `Global\VideorcCamera.1920x1080`
   section the media source creates with a DACL (Local Service writes
   the header, the user's SID writes frames, Everyone reads) and a
   seqlocked 3-frame NV12 ring. The Rust program writes a moving pattern
   at 30 fps. Measure feeder-to-Chrome latency and dropped frames.
3. Confirm: what happens when the feeder exits (placeholder or stall),
   when the vcam process exits (camera gone), and whether a non-elevated
   `MFCreateVirtualCamera` with Session + CurrentUser succeeds.

_Go when:_ 1 and 2 pass. _No-go when:_ the Frame Server never loads the
DLL from `%ProgramData%`, or the section can't be opened from the user
session, or Chrome doesn't list the camera.

### P0c. Linux: v4l2loopback test pattern

**Route:** Implementation, fit 8. **Lane:** `gpt-6.1-sol`, high effort.
**Needs:** the Ubuntu 24.04 box if it exists, else ogre.

1. `apt install v4l2loopback-dkms` (or the distro's package), then
   `pkexec modprobe v4l2loopback exclusive_caps=1 card_label="Videorc Camera" video_nr=42`.
   Note secure boot behaviour.
2. A scratch Rust program sets YUYV 1920×1080 and writes a pattern at
   30 fps. Chrome Meet and Zoom (Linux) list and show it; `ffmpeg -f v4l2`
   reads it.

_Go when:_ 2 passes. _No-go when:_ the module can't load (secure boot)
on the baseline box; then Linux ships guidance only.

---

## Workstream A: the output tap (every platform)

**Route:** Implementation, fit 9 (cross-cutting compositor change, the
preview and record-latency gates). **Lane:** `fable-5.1`.

**Drift paths:** `crates/videorc-backend/src/compositor.rs crates/videorc-backend/src/compositor_preview_frame_lease.rs crates/videorc-backend/src/frame_store.rs crates/videorc-backend/src/preview_surface.rs crates/videorc-backend/src/recording.rs (arm site ~5495) crates/videorc-backend/src/protocol.rs crates/videorc-backend/src/main.rs crates/videorc-backend/src/screen_privacy.rs apps/desktop/src/shared/backend-rpc-contract.ts apps/desktop/src/shared/backend.ts protocol-fixtures/`

**Why (verified unless marked):**

- The program is already a frame store other consumers poll
  (`latest()`); the encoder bridge is the template
  (`encoder_bridge.rs:7922-7928`). A new reader needs no new leg.
- What the Preview shows is `presented_frame_store` (the hold and the
  packaged backstop included). The camera must read the same, or a
  performance check's noise reaches a meeting (plan 212).
- At idle the run is sized to the Preview surface and, off macOS, has no
  pixels (`compositor.rs:647-654`). The `program_picture_waiters` path
  already composes CPU pixels on demand for one tick
  (`compositor.rs:10120-10145`): the shape to extend, not copy.
- `arm_compositor_for_capture` refuses an already-leased run
  (`AlreadyLeased`, `compositor.rs:4142`). A camera lease that blocked a
  session's in-place arm would push Record down the restart path and
  regress `smoke:record-latency:gate`. So the camera's lease must be
  **weak**: any session or Clips arm replaces it.
- Hide screen is at the source (`screen_privacy.rs`), so the camera gets
  the frost with no code. Prove it anyway (F1).
- **Guess:** Clips on by default means most idle runs already compose at
  the recording canvas with pixels on every platform (the buffer-only
  lease uses an encoder consumer). The weak lease then matters only with
  Clips off.

**Slices:**

- **A1. `virtual_camera.rs`: the pure half.** A `VirtualCameraOutput`
  that owns a thread, polls the presented store at its own 30 fps clock,
  converts the newest frame to the camera format (1920×1080; pillarbox a
  vertical canvas; repeat the last frame when the run is slower; never
  touch the compositor tick), and hands it to a platform sink trait
  (`VirtualCameraSink::push(frame, pts)`). Pure helpers with tests:
  fit-and-pillarbox geometry, cadence (no more than one frame per tick,
  repeats counted), I420 → NV12 and I420 → YUYV converters, and the
  "which store" rule (presented store, re-read every tick: the hold or
  the program leg can appear mid-run).
  _Done when:_ `cargo test` covers geometry, cadence and converters
  against fixtures, and a fake sink records exactly one push per tick.
- **A2. Pixels on demand.** A `pixel_demand` counter on the run (the
  camera holds one while a viewer holds the camera, D13; always on Linux).
  While it is non-zero the tick composes CPU pixels even for the
  metadata-only preview, as it does for a picture waiter, and the Metal
  path changes nothing.
  _Done when:_ a test shows a metadata-only run publishing pixels while
  the counter is held and none after release. The idle CPU on a Linux
  Studio with the camera off is unchanged (the plan-0014 reason).
- **A3. The weak lease.** `arm_compositor_for_capture` gains a lease kind
  `VirtualCamera { canvas }`. A session or Clips arm replaces it in place
  (no `AlreadyLeased`, no restart path), and when that lease is released
  while a viewer still holds the camera, the camera re-arms at its canvas.
  With Clips or a session leased, the camera just reads their store.
  _Done when:_ tests cover camera → record → stop → camera, camera with
  Clips on, and Clips off; `smoke:record-latency:gate` is unchanged.
- **A4. Status and RPCs.** `virtual_camera.status` and
  `virtual_camera.set { on }`, an event `virtual_camera.changed`, and a
  `VirtualCameraStatus { on, available, state, viewers, platform_step,
  message }` where `state` is one of `off | installing | needs-approval |
  needs-setup | ready | streaming | unavailable` and `message` is plain
  copy. Every `Option` has `skip_serializing_if`. Counters go in
  `framePipeline` (`virtualCameraPushed`, `virtualCameraRepeated`,
  `virtualCameraConvertMsMax`). All of it in `backend-rpc-contract.ts`,
  the IPC contract and the fixtures; the setting is saved in the backend
  settings store (D4).
  _Done when:_ contract round-trip tests pass in Rust and TS; an older
  payload without the fields loads; `pnpm typecheck` passes.
- **A5. Never list yourself.** `list_native_cameras` on each platform and
  the FFmpeg avfoundation probe drop the Videorc camera: by the
  extension's fixed device UUID on macOS (one constant shared by Rust
  and Swift), by the vcam's `sourceId` CLSID or the friendly name on
  Windows, by `card_label` on Linux. A saved camera id that names it
  resolves to nothing (no silent substitute: plan 213 E).
  _Done when:_ a unit test per platform filters a fixture list, and the
  smoke proves the Sources page never shows it.

**Gate:** targeted `cargo test` (compositor, virtual_camera, protocol),
`cargo clippy -p videorc-backend -- -D warnings`, `pnpm typecheck`,
desktop tests, `pnpm probe:preview-lifecycle`,
`pnpm smoke:record-latency:gate`, `pnpm smoke:recording-studio`. Run a
release build after the cfg edits (release-build cfg trap).

**Size:** M, 3 to 4 days.

---

## Workstream B: macOS, a Camera Extension in the bundle

**Route:** Implementation with Release, fit 10 (release-critical signing).
**Lane:** `fable-5.1`. **Depends on:** P0a go, A.

**Drift paths:** `apps/desktop/electron-builder.yml apps/desktop/build-resources/ crates/videorc-native-preview-addon/src/lib.rs apps/desktop/src/main/ scripts/sign-macos-local-app.mjs scripts/validate-macos-release-artifact.mjs scripts/check-packaged-app.mjs .github/workflows/release-macos.yml .github/workflows/lab-candidate-macos.yml docs/releases/release-runbook.md docs/releases/macos-signing.md .claude/skills/videorc-release/SKILL.md .agents/skills/videorc-release/SKILL.md`

**Why (verified unless marked):**

- Camera Extensions are the only supported path: DAL plug-ins deprecated
  in 12.3, not loaded since 14.1. Videorc's floor is macOS 13 (README).
- The extension lives at `Contents/Library/SystemExtensions/`, must be
  app-sandboxed, runs as its own daemon as `_cmiodalassistants`, and is
  activated by the app from `/Applications`. Deleting the app uninstalls
  it; updates go through the same activation with the replace delegate.
- The restricted entitlement needs a Developer ID profile in the app and
  one in the extension; the bundle must be notarized. A bare binary can't
  carry a profile, so `videorc-backend`, ffmpeg and the helpers must
  **not** claim the entitlement: the single plist must split
  (`entitlements` vs `entitlementsInherit`, both supported by
  electron-builder, which also has `provisioningProfile` and passes it
  to osx-sign).
- The activation request must come from the app's own process (the
  extension is looked up in the requester's bundle). Electron main is
  that process; the N-API addon is the existing way main calls native
  code (`lib.rs:394-571`, loaded from `resourcesPath`). **Guess:** a
  second executable in `Contents/MacOS` would also count as the app; the
  addon route avoids finding out.
- The sink client: OBS pushes from its unsandboxed app process with no
  extra entitlement; a sandboxed client needs camera TCC to even see the
  device (SimulatorCamera's notes). `videorc-backend` already opens
  cameras, so TCC attributes to Videorc.app. **Guess:** it sees the sink
  device without a new prompt; P0a step 5 settles it.
- Zero-copy: the compositor's target is already an IOSurface-backed
  BGRA CVPixelBuffer. OBS copies into a pool because its frames are CPU
  memory; ours are GPU surfaces whose ring slots are reused
  (`begin_in_flight`), so a GPU blit into a camera-owned
  `CVPixelBufferPool` (IOSurface-backed, 32BGRA) is the safe zero-CPU
  path. **Guess:** the extension passes the surface through to clients,
  so a slot must not be reused until the extension has consumed it
  (`notifyScheduledOutputChanged`).
- User approval lives in Privacy & Security (13, 14) and in General →
  Login Items & Extensions → Camera Extensions (15), as OBS's strings
  say.
- Developer mode (`systemextensionsctl developer on`) needs SIP off and
  lets an Apple Development build activate from any folder;
  `systemextensionsctl uninstall` also needs SIP off. With SIP on, the
  loop is: packaged, Developer ID signed, in `/Applications`.
- CI builds on `macos-15` (Xcode present; version **guess**), which can
  build Swift but cannot activate a system extension.

**Slices:**

- **B0 (owner, before B starts).** In the Apple portal: enable System
  Extension and App Groups on `dev.theorcdev.videorc`; register
  `dev.theorcdev.videorc.camera` with App Groups; create the app group
  `C2PA37RB58.dev.theorcdev.videorc`; make two Developer ID provisioning
  profiles. Add them base64 as `VIDEORC_MACOS_PROFILE_APP` and
  `VIDEORC_MACOS_PROFILE_CAMERA` to GitHub secrets and
  `~/.videorc-release.env` (the same places as `macos-signing.md`).
  _Done when:_ `security cms -D -i` shows both profiles carry the
  entitlements and the Team ID.
- **B1. The extension.** `apps/desktop/camera-extension/` (Swift, built
  with `swiftc`/`xcodebuild` by `scripts/build-camera-extension.mjs`,
  with a package script and a pinned deployment target of 13.0): one
  device, a 1920×1080 32BGRA 30 fps source stream, a sink stream, the
  D12 stills drawn in the extension, a client-count custom property for
  D13, the sink restricted to a producer whose signing id is Videorc's
  (OBS checks nothing; LemurCam reads the pid when CMIO reports
  "unknown"). The device UUID and the stills' copy are constants shared
  with Rust through a generated header. Unit tests for the pure Swift
  (format table, client counting) run in CI.
  _Done when:_ the build script produces a `.systemextension` with the
  Info.plist keys (`CMIOExtensionMachServiceName`,
  `NSSystemExtensionUsageDescription`) and the sandbox + app-group
  entitlements, and CI builds it on `macos-15`.
- **B2. Packaging and signing.** `electron-builder.yml`: an `afterPack`
  hook copies the extension to `Contents/Library/SystemExtensions/`,
  embeds `VIDEORC_MACOS_PROFILE_CAMERA` as its `embedded.provisionprofile`
  and signs it with its own entitlements before the app is signed;
  `mac.provisioningProfile` points at the app profile written from
  `VIDEORC_MACOS_PROFILE_APP`; `entitlements` becomes
  `entitlements.mac.plist` plus the system-extension and app-group keys;
  `entitlementsInherit` becomes `entitlements.mac.inherit.plist` with
  today's five keys and nothing more. `sign-macos-local-app.mjs` learns
  both plists and the extension. Unsigned `dist`/`package` builds skip
  the extension and say so once in the log (never a silent fallback).
  _Done when:_ a locally signed packaged app in `/Applications` launches,
  `codesign -d --entitlements` shows the restricted keys on the app
  only, `systemextensionsctl list` shows the extension after approval,
  and `spctl -a -vv` accepts the notarized build (F2 runs the smoke).
- **B3. Activation from Electron main.** The addon gains
  `activateCameraExtension(identifier)` and
  `deactivateCameraExtension(identifier)` (objc2, a delegate class):
  the result is one of `completed | needs-approval | will-complete-after-reboot | failed(code, text)`,
  with the `OSSystemExtensionError` code mapped to a plain reason
  (`unsupportedParentBundleLocation` → "Move Videorc to the Applications
  folder"). Main requests activation at launch when the switch is on
  (Apple: "as early as possible", so updates replace cleanly), reports
  the state to the backend (A4), and a `videorc:camera-extension`
  smoke command exposes it. Off never deactivates (D12): the still says
  it's off. Deactivation exists for Health → "Remove Videorc Camera".
  _Done when:_ a unit test covers the code mapping; by eye, a fresh Mac
  shows the approval state with the right Settings path per macOS
  version, and approval flips it to ready without a relaunch.
- **B4. The sink client in the backend.** `virtual_camera_macos.rs`
  implements `VirtualCameraSink`: find the device by UUID, the sink as
  the second stream (OBS; CMIO exposes no direction), a non-nil
  no-op callback to `CMIOStreamCopyBufferQueue` (the nil-callback trap),
  `CMIODeviceStartStream`, then per frame a Metal blit from the target
  into a pool buffer and `CMSampleBufferCreateForImageBuffer` with a
  monotonic PTS and a 1/30 duration, `CMSimpleQueueEnqueue` with its
  result checked (a full queue counts as a drop). Re-find the ids on
  every connect (the extension may have restarted). Read the client
  count property each second for D13. If P0a step 5 showed the backend
  can't see the device, the sink moves to Electron main through the
  addon instead; say which in the PR.
  _Done when:_ with the switch on, `ffmpeg -f avfoundation -i "Videorc Camera"`
  reads 30 fps for 10 s with ≤1 repeat per second, and the counters show
  zero CPU copies.
- **B5. Release, validator, docs.** `validate-macos-release-artifact.mjs`
  and `check-packaged-app.mjs` assert the extension's presence, its
  signature and entitlements, both embedded profiles, the app's
  restricted keys, and that no bare binary claims them.
  `release-macos.yml` and `lab-candidate-macos.yml` pass the two secrets
  (owner's merge click). The release runbook, `macos-signing.md` and
  both release skills get a "Videorc Camera" section: secrets, profile
  renewal, the validator's new lines, and the rollback note (a build
  without the profile must fail the validator, never ship).
  _Done when:_ the validator is red on a build without a profile and
  green on the signed one; the docs name every secret.

**Gate:** `cargo test` for the touched modules, clippy, `pnpm typecheck`,
desktop tests, `pnpm check:packaged-app`, `pnpm release:validate:macos`
on a local signed build, `pnpm probe:preview-lifecycle`,
`pnpm smoke:recording-studio` (the compositor tap), then F2 on the lab
Mac. The dev app cannot run any of the extension path: say so in the PR
and point at the packaged evidence.

**Size:** L, 5 to 8 days of agent time plus the owner's portal time.

---

## Workstream C: Windows 11, a Media Foundation virtual camera

**Route:** Implementation, fit 9. **Lane:** `fable-5.1` (COM, services,
cross-session memory, elevation). **Depends on:** P0b go, A, F1.

**Drift paths:** `crates/videorc-virtual-camera-windows/ (new) crates/videorc-backend/src/virtual_camera_windows.rs (new) crates/videorc-backend/src/camera_capture.rs apps/desktop/electron-builder.yml apps/desktop/electron-builder.windows-signed.cjs .github/workflows/windows.yml .github/workflows/sign-windows-alpha.yml docs/windows-port-plan.md`

**Why (verified unless marked):**

- `MFCreateVirtualCamera` needs build 22000; the Windows build is a
  Windows 11 x64 Alpha. Session + CurrentUser needs no admin; AllUsers
  does.
- The media source runs in the Frame Server (Local Service, session 0).
  It must be registered in HKLM and the DLL must be readable from
  outside the user's profile. The per-user installer can't do that
  without elevation (D8).
- Transport: a `Global\` section created by the media source (session 0
  needs no privilege) with a DACL that lets the user write and everyone
  read; the app opens it and drops frames until it exists. A NULL DACL
  (BestCam) is not acceptable.
- Windows composes the program in a D3D11 session only while recording
  or streaming; at idle the Electron proof surface draws per-source
  BMPs and the backend composes nothing (AGENTS.md, `compositor.rs:647`).
  So A2's demand matters most here: idle with a viewer means CPU
  composition at 1080p30 (**guess** on cost: ~6 to 10 ms a frame on the
  CPU path; measure in C3).
- During a D3D11 session the frame is a GPU texture: a staging readback
  (8 MB BGRA or 3 MB NV12 a frame) is the honest path; a shared NT
  handle across sessions is possible but is a second spike.
- electron-builder signs the app exe and installer, not extraResources
  (`electron-builder.yml:154-155`). The DLL must be signed in the
  protected sign job (owner's merge click for the workflow).
- `windows-latest` CI can compile the DLL and run its unit tests; whether
  it can host a vcam is a **guess**: treat the Windows box as the
  behaviour gate.

**Slices:**

- **C1. The media source DLL.** A new crate `videorc-virtual-camera-windows`
  (Rust, `windows` crate `implement` for `IMFMediaSource`,
  `IMFMediaStream`, `IMFGetService`, `IKsControl` as the sample needs;
  if the crate can't express one interface, a C++ shim for that one,
  named in the PR). One stream, NV12 1920×1080 30 fps, frames from the
  shared ring, a "Videorc isn't running" still when the ring is absent
  or stale for 1 s. A `DllRegisterServer` that writes HKLM. Unit tests
  for the ring (seqlock, stale detection, size change by name).
  _Done when:_ the sample's `VirtualCameraTest`-style harness (in the
  crate's tests) opens the source in-process and pulls frames.
- **C2. Setup, elevated once (D8).** `videorc-camera-setup.exe` (tiny,
  in the same crate): copies the DLL to `%ProgramData%\Videorc\camera\<version>\`,
  writes HKLM, and on `/remove` undoes both. The app runs it with
  `runas` (UAC) from the "Set up Videorc Camera" button and again when
  the DLL version in the bundle differs from the registered one. The
  installer's uninstall calls `/remove` when it can (**guess**: NSIS
  per-user uninstall is not elevated; then leave the keys and say so in
  the docs).
  _Done when:_ a fresh Windows user can set up, see the camera in the
  Camera app, update to a build with a newer DLL and be asked once.
- **C3. The sink in the backend.** `virtual_camera_windows.rs`:
  `MFCreateVirtualCamera(SoftwareCameraSource, Session, CurrentUser, "Videorc Camera", "{CLSID}")`
  off the main thread, `Start` when the switch goes on, `Shutdown` when
  off or at exit; opens the ring and writes NV12: from the CPU I420 path
  with A1's converter, or from the D3D11 session by staging readback
  (`CompositorFrameExportHandle::d3d11_texture`). D13 reads the viewer
  count from the ring header. Measure the readback and convert cost at
  1080p30 and put it in the PR.
  _Done when:_ `ffmpeg-capture.exe -f dshow -i video="Videorc Camera Windows Virtual Camera"`
  reads 30 fps for 10 s idle and while recording 1080p30, with the
  recording's A/V unchanged.
- **C4. Signing and CI.** The DLL and the setup exe are signed by
  `sign-windows-alpha.yml` with the rest (owner's merge click); the
  Windows installer artifact job builds the crate and runs its tests;
  `check:packaged-app` on Windows asserts both files and their signatures.
  `docs/windows-port-plan.md` gets a "Videorc Camera" section.
  _Done when:_ the signed Alpha carries signed files and the Windows
  smoke (F3) passes on the box.

**Gate:** `cargo test -p videorc-virtual-camera-windows` and
`cargo test -p videorc-backend` on the box, three runs from PowerShell 7
for the process tests (AGENTS.md), clippy, `pnpm smoke:packaged:bundled`,
`pnpm smoke:recording-native-preview`, then F3.

**Size:** L, 5 to 8 days.

---

## Workstream D: Linux, v4l2loopback

**Route:** Implementation, fit 8. **Lane:** `gpt-6.1-sol`, high effort.
**Depends on:** P0c go, A, F1.

**Drift paths:** `crates/videorc-backend/src/virtual_camera_linux.rs (new) crates/videorc-backend/src/linux_v4l2_camera.rs docs/linux-port-plan.md docs/linux-dev-loop.md`

**Why (verified):**

- v4l2loopback is a kernel module; the user installs `v4l2loopback-dkms`;
  loading needs root; `exclusive_caps=1` hides the device from apps until
  a writer is attached, which is what Chrome needs; the writer sets the
  format. OBS loads it with `pkexec modprobe … exclusive_caps=1 card_label='OBS Virtual Camera'`
  and writes YUYV.
- Linux's idle preview composes nothing (metadata-only); A2 covers it.
  Linux has no reader count, so D13 says write while on.

**Slices:**

- **D1. Detect and guide.** `virtual_camera_linux.rs`: `modinfo` says
  whether the module is installed; `/sys/module/v4l2loopback` whether it
  is loaded; a Videorc device is found by `card_label` in sysfs. Status
  states: `needs-setup` with the distro's install command in `message`
  (apt, dnf, pacman by `/etc/os-release`), `needs-approval` while
  `pkexec modprobe v4l2loopback exclusive_caps=1 card_label="Videorc Camera" video_nr=42`
  runs, `ready`. Never bundle, build or sign a module.
  _Done when:_ unit tests cover the state table against fake sysfs
  trees (the `V4l2Roots` pattern).
- **D2. The writer.** Open `/dev/video42` for output, `VIDIOC_S_FMT`
  YUYV 1920×1080, write one frame per A1 tick (I420 → YUYV from A1), and
  `exclusive_caps` makes the device appear. Close on off.
  _Done when:_ on the box, `ffmpeg -f v4l2 -i /dev/video42` reads 30 fps
  for 10 s and Chrome lists the camera only while the switch is on.
- **D3. Docs.** `docs/linux-port-plan.md` gets the row; `linux-dev-loop.md`
  the tester steps (secure boot note).

**Gate:** targeted `cargo test`, clippy, the Linux CI compile job, then
F4 on the named box (or a statement of why it couldn't run, AGENTS.md).

**Size:** S to M, 2 days.

---

## Workstream E: the switch, the status and the words

**Route:** UI/Product Design, fit 9. **Lane:** `opus-5.5`. Read
`.claude/skills/videorc-design/SKILL.md` and `docs/ui-copy.md` first.
**Depends on:** A4's contract.

**Drift paths:** `apps/desktop/src/renderer/src/components/tabs/recording-tab.tsx apps/desktop/src/renderer/src/components/command-palette.tsx apps/desktop/src/renderer/src/lib/studio-actions/settings.ts apps/desktop/src/renderer/src/components/diagnostics-tab.tsx apps/desktop/src/renderer/src/lib/platform.ts apps/desktop/src/renderer/src/lib/platform-copy.ts CONTEXT.md docs/ui-copy.md`

**Why (verified):**

- The Output page is the home of outputs: Clips, Local recording, Where
  recordings go, each a `SettingsRow` in a `FieldGroup variant="grouped"`
  (`recording-tab.tsx:116, 243, 512`). One home per control; ⌘K mirrors
  switches (Hide screen, `command-palette.tsx:247`); agents patch
  settings through `studio-actions/settings.ts` (the
  `separateSourceRecordings` arm at :157-172 is the template, with a
  platform refusal).
- Owner rules: nothing beside Record/Go Live, no toolbar-corner buttons,
  toasts colour the icon only, check light and dark, a locked control
  always says why, Premium copy is one sentence (not needed: D3 free).
- Platform words come from `lib/platform.ts` (`osSettingsName()`), never
  a literal.

**Slices:**

- **E1. The section.** Output → "Camera for other apps", under Clips: one
  `SettingsRow` "Videorc Camera" with the Switch, description "Shows
  your program as a camera in Meet, Zoom, Teams and Discord. No sound.
  Meet shows you a mirror image; everyone else sees it right." A status
  line under it from A4's `state`: "Ready · choose Videorc Camera in the
  other app", "In use by 1 app", "Allow it in {osSettingsName()} →
  Privacy & Security" or "… → General → Login Items & Extensions →
  Camera Extensions" by macOS version, with one button "Open
  {osSettingsName()}" (`x-apple.systempreferences:` URL, **guess** on the
  pane id; fall back to opening System Settings). Windows: "Set up
  Videorc Camera" (one UAC prompt) and "Needs Windows 11". Linux: the
  install command in a copyable line, then "Load module" (pkexec).
  Unavailable states disable the Switch with the reason (locked means
  disabled, with one reason). No toast for on/off: the row is the
  confirmation. One warning toast, id `virtual-camera`, when the camera
  stops on its own ("Videorc Camera stopped · {reason}"), persistent until
  it is back.
  _Done when:_ a test pins every state's copy and action; by eye in
  light and dark.
- **E2. Mirrors.** ⌘K "Turn Videorc Camera on" / "off"; the agents'
  settings tool gains `videorcCamera: boolean` with the platform and
  state refusals in the same words. No Deck or phone intent in this plan.
  _Done when:_ the settings-tool test covers accept and refuse, and
  `smoke:agent-mcp`'s catalog test still passes.
- **E3. Health.** A "Videorc Camera" line in Health (state, viewers,
  pushed/repeated counts, the DLL or extension version) and in the
  support bundle; on macOS a "Remove Videorc Camera" action (B3
  deactivation) with a confirm.
  _Done when:_ a test pins the section and the bundle shows no new
  personal data.
- **E4. Words.** `CONTEXT.md` glossary: "Videorc Camera" (the camera other
  apps see; never "virtual cam", "vcam" or "webcam"). `docs/ui-copy.md`:
  the approval paths quoted exactly as System Settings reads today.

**Gate:** `pnpm typecheck`, `pnpm lint`, `pnpm format:check`,
`pnpm --filter @videorc/desktop test`, the copy guards. By eye in both
themes on macOS; Windows and Linux states by eye on their boxes.

**Size:** S to M, 2 days.

---

## Workstream F: the smoke, the proof, the records

**Route:** Implementation, fit 8. **Lane:** `gpt-6.1-sol`, high effort,
with `fable-5.1` if F2's read-back comparison fights the host.

**Drift paths:** `scripts/smoke-virtual-camera.mjs (new) scripts/lib/ package.json AGENTS.md docs/releases/release-runbook.md docs/acceptance/`

**Why (verified unless marked):**

- The macOS extension runs only in a Developer ID–signed bundle in
  `/Applications`, so the dev app proves nothing here; the smoke is a
  packaged smoke, like `smoke:packaged:bundled` on Windows.
- The bundled macOS FFmpeg has `avfoundation`; the Windows capture FFmpeg
  has `dshow`; the Linux build is BtbN's (v4l2 input **guess**). An
  FFmpeg process reading a camera needs camera TCC for its parent (the
  terminal): the smoke names that grant and SKIPs without it, never
  silently.
- The packaged backstop refuses a test-pattern scene to the Preview (and
  so to the camera): the marker must be an image source, not the test
  pattern.

**Slices:**

- **F1 (red first). `pnpm smoke:virtual-camera`.** Drives the packaged
  app through the smoke command server with an isolated profile: seed a
  scene with a bundled marker image (a corner code that changes every
  second through the banner path), turn the camera on, read it with the
  platform FFmpeg for 10 s and assert: listed only while on; 30 ± 1 fps;
  the marker in the read-back matches the marker in a recording made
  during the same 10 s (frame-by-frame within 2 s of drift); the frost
  within 1 s of `screen.hide` and the live picture within 1 s of
  `screen.show`; the Sources page never lists Videorc Camera; the Record
  → Stop cycle during the read keeps the camera at 30 fps and the
  recording passes the analyzer; `framePipeline` shows zero copies on
  macOS and the convert cost under 4 ms p95 on Windows and Linux.
  Written and seen red (camera absent) before B4 lands.
- **F2. macOS on the lab Mac.** Signed, notarized, in `/Applications`:
  the smoke, plus by hand FaceTime, Meet in Chrome, Zoom, Discord and
  Teams, the approval flow from a fresh user, an update that replaces
  the extension, and delete-the-app uninstalls it (`systemextensionsctl list`).
  Record it in `docs/acceptance/<date>-videorc-camera-macos.md`.
- **F3. Windows on the box.** The smoke with `ffmpeg-capture.exe`, plus by
  hand Meet in Chrome and Edge, Zoom, the new Teams, Discord and the
  Camera app; setup from a fresh user; an update with a new DLL version.
- **F4. Linux on the named box.** The smoke, plus Meet in Chrome and Zoom.
- **F5. Records.** `AGENTS.md` gets a "Videorc Camera" rule (run the
  smoke for changes touching `virtual_camera*.rs`, the extension, the
  DLL, or the entitlements), the release runbook's acceptance gate lists
  F2, and `plans/README.md` is updated.

**Gate:** `pnpm test:scripts` for the smoke's pure helpers, and the smoke
itself on each box.

**Size:** M, 2 to 3 days plus box time.

---

## STOP conditions

- **P0a/B:** the Apple portal can't issue a Developer ID profile with the
  System Extension capability for team `C2PA37RB58`; or the nested app
  is killed at launch (AMFI) after the entitlement split; or notarization
  rejects the bundle. Report the exact error; do not ship any build with
  the restricted entitlement until P0a is green.
- **B4:** the backend never sees the sink device (empty CMIO list) even
  with camera TCC granted. Move the sink to Electron main through the
  addon and report; do not add entitlements to bare binaries.
- **B:** the extension replaces or activates only after a reboot on an
  update (`willCompleteAfterReboot`) on a clean Mac. Report; the updater
  copy needs a decision.
- **P0b/C:** the Frame Server won't load the DLL from `%ProgramData%`, or
  the user session can't open the `Global\` section with a non-NULL
  DACL, or Chrome doesn't list the camera. A NULL DACL is never the fix.
- **C1:** the `windows` crate can't express a needed interface and the
  C++ shim grows past one file. Report before continuing.
- **A:** `smoke:record-latency:gate`, `probe:preview-lifecycle` or
  `smoke:recording-studio` regress with the camera on, or the Linux idle
  CPU rises with the camera off.
- **D:** the baseline box can't load the module (secure boot). Linux
  ships guidance only; report.
- Any new status, event or settings field that isn't in
  `backend-rpc-contract.ts`, or a Rust `Option` without
  `skip_serializing_if`.
- An anchor's behaviour changed since `b7e68a2c`.

## Not in this plan

- **Sound.** A virtual camera carries no audio. A virtual microphone
  ("Videorc Microphone" in Meet) is a separate project: on macOS an
  AudioServerPlugIn HAL driver in `/Library/Audio/Plug-Ins/HAL` installed
  with admin rights (BlackHole's shape; DriverKit audio needs an Apple
  approved entitlement); on Windows a kernel-mode audio driver with
  attestation or WHQL signing (VB-Cable's shape), by far the heaviest
  part; on Linux a PipeWire or PulseAudio null sink is one command. Plan
  it only if the owner wants the camera's audio in meetings.
- Windows 10 and a DirectShow filter (D7).
- Intel Macs (the Beta is arm64 only).
- The Mac App Store.
- A PipeWire camera on Linux (Chrome's PipeWire camera flag is off by
  default; v4l2loopback is what every app reads).
- A second camera, a per-scene camera, a clean leg without overlays, a
  mirror switch, a 720p or 60 fps choice (D11).
- A Deck key or a phone intent for the switch (E2 names ⌘K and agents
  only).

## Owner acceptance

- **D1 to D14** answered; B0 done (profiles in both secret stores).
- **macOS:** on the owner's Mac (macOS 15) and a 13 or 14 Mac if one is
  around: install the Beta, turn the camera on, approve it, pick Videorc
  Camera in Meet, Zoom, Teams, Discord and FaceTime; hide the screen and
  see the frost in Meet; record while in a call; update to the next Beta
  and see the camera keep working; delete the app and see it gone from
  FaceTime.
- **Windows:** the same in Meet (Chrome and Edge), Zoom, the new Teams,
  Discord and the Camera app on the Windows box; one UAC prompt at setup.
- **Linux:** Meet in Chrome and Zoom on the named box after installing
  the module.
- **By eye in light and dark:** the Output section in every state, the
  Health line, ⌘K.

## As built

- **P0a (2026-11-03): GO**, on macOS 26.5.1 with SIP on. The scratch code
  is in `~/videorc-vcam-spike/`, outside the tree.
  - **B0, done through Xcode automatic signing** (owner's choice).
    - The owner first had to accept Apple's updated Program License
      Agreement. Until then the portal answered "PLA Update available".
    - Xcode registered the App IDs `dev.theorcdev.videorc` and
      `dev.theorcdev.videorc.camera`, the app group
      `C2PA37RB58.dev.theorcdev.videorc` and this Mac as a device (owner
      approved). Then it issued a development profile and **one**
      Developer ID profile, "Mac Team Direct Provisioning Profile:
      dev.theorcdev.videorc", expiring 2044.
    - **The extension needs no profile.** Its sandbox and team-prefixed
      app group aren't restricted.
    - The app profile carries `system-extension.install`, the application
      identifier and the team identifier, but **not** the app group. The
      app group rides on the signature alone.
    - The profile embeds the Developer ID certificate, so it must be
      regenerated when that certificate is renewed on 2027-02-01.
    - xcodebuild's archive must be development-signed, which is why the
      device was needed. Only `-exportArchive` (developer-id, automatic)
      creates the Developer ID profile.
  - **Step 2.** A notarized test camera in
    `/Applications/Videorc Camera Spike.app`. Approval is at General →
    Login Items & Extensions → Camera Extensions on macOS 26.
    - `ffmpeg -f avfoundation -i "Videorc Camera"` reads 30 fps.
    - The owner saw the **pushed** picture in Chrome (webcamtests.com).
    - Replacing it with v0.0.2 took 1 s, with no re-approval and no
      reboot.
  - **Step 3, AMFI.** A 0.18.0 copy with the extension nested, re-signed
    inside out (no `--deep`), launched and notarized.
    - The main executable has today's five keys, plus
      `system-extension.install` and the app group.
    - Every other binary keeps the five.
    - The extension has app-sandbox and the app group only.
    - A bare binary carrying the restricted key dies with SIGKILL at exec,
      silently.
  - **Step 4, the pusher.** A bare Developer ID binary with today's plist
    (the backend's shape) sees the sink and pushes with 0 drops and no TCC
    prompt. The sink stays in the backend.
    - `kCMIOStreamPropertyDirection` is 0 on the sink and 1 on the camera
      stream (the plan's "no direction" was wrong).
    - The extension passes the producer's IOSurface to every client
      untouched. The sink queue capacity is 10.
    - CMIO caches custom properties until the extension calls
      `notifyPropertiesChanged`.
    - Measured: pusher 6 to 13% of one core, extension about 7%, readers
      at 29.0 to 29.7 fps.
  - **What changed in Workstream B:** one profile secret
    (`VIDEORC_MACOS_PROFILE_APP`), not two. Fixed in a follow-up
    (`feat/214-b-fixes`).
- **PR #1091 (2026-11-03):** A, B (with the P0a fixes), B4, D, E, F1 and
  F5, merged into main as `bc84c35ec`.
  - The secret `VIDEORC_MACOS_PROFILE_APP` was set with `gh secret set` as
    a GitHub Actions secret, which is what the workflows read.
  - Verified without app runs (the owner's rule):
    - targeted `virtual_camera` Rust tests (A 68, D 50, B4 57), clippy,
      fmt and the release check;
    - 22 Swift tests and 85 addon tests;
    - `test:scripts` 2952/0, the desktop suite on E, typecheck, lint and
      format.
  - Lanes: Codex was out, so D and F ran on `fable-5.1`. The Claude
    accounts hit rate limits, so C restarted three times; F1 died on a
    network blip and the orchestrator finished it.
- **Review follow-up** (`fix/214-review-followups`). A code-only Fable
  review found no blockers. Fixed:
  - **The first viewer.** It sees "Starting Videorc Camera…", not "Videorc
    isn't running", and the viewer count is re-read every 250 ms (it was
    1 s).
  - **The camera's own arm** keeps the Preview's fps; it was forced to 30.
  - **Main refuses Windows Set up and Linux Load module** unless the
    backend says the platform isn't hidden. That keeps the hide rule in
    main too.
  - **modprobe's error line** is capped, so the message fits the 512
    character IPC field.
  - **A no-profile `build:camera-extension`** skips with the one line
    (`--force` and `--test` still build), so packaging on a Mac without
    Swift works as before.
  - **CI** runs `pnpm test:camera-extension` on macOS.
  - **The runbook's** two-profile wording is fixed.
  - **A wanted camera with no compositor run** is logged once.
- **Open:**
  - **A camera with no run.** A viewer can hold the camera while no
    compositor run exists (Clips off and no Preview surface). The Output
    row still says "In use by 1 app" while the meeting shows the
    "Starting…" still. It needs a status signal and copy.
  - **Missing tests:**
    - the supervisor loop against a real arm and release;
    - the camera → record → off → stop path;
    - the release validator's runner wiring;
    - the afterPack hook itself;
    - main's camera wiring.
  - **Owed on main (no smokes or app runs before main, owner rule):**
    - `smoke:virtual-camera`, `smoke:recording-studio`,
      `smoke:record-latency:gate` and `probe:preview-lifecycle`;
    - a signed, notarized build in /Applications, which replaces the spike
      camera;
    - by eye: Meet, Zoom and FaceTime, the off and "isn't running"
      stills, a fresh-Mac approval, Health → Remove, and light and dark;
    - B4's on-device list;
    - Linux P0c;
    - Windows C (its own PR, from `feat/214-c-windows-3`).
  - **Local release builds** need `VIDEORC_MACOS_PROFILE_APP` in
    `~/.videorc-release.env` (a path works).

## Sources

Apple:

- [Creating a camera extension with Core Media I/O](https://developer.apple.com/documentation/coremediaio/creating-a-camera-extension-with-core-media-i-o):
  macOS 12.3+, the System Extension and App Groups capabilities, the
  `/Applications` rule, admin approval in System Settings.
- [Installing system extensions and drivers](https://developer.apple.com/documentation/systemextensions/installing-system-extensions-and-drivers):
  `Contents/Library/SystemExtensions`, activation early at launch,
  replacement, uninstall on app delete.
- [com.apple.developer.system-extension.install](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.system-extension.install).
- [OSSystemExtensionError.Code](https://developer.apple.com/documentation/systemextensions/ossystemextensionerror/code).
- [WWDC22 10022, Create camera extensions with Core Media IO](https://developer.apple.com/videos/play/wwdc2022/10022/):
  sink streams, the `_cmiodalassistants` daemon and sandbox, "disable
  DAL plug-ins entirely in the next major release after macOS Ventura".
- [Apple support 108387](https://support.apple.com/en-us/108387): from
  macOS 14.1 only cameras using modern system extensions are supported.
- Apple forums on the restricted entitlement and Developer ID profiles:
  [710046](https://developer.apple.com/forums/thread/710046),
  [713784](https://developer.apple.com/forums/thread/713784),
  [795579](https://developer.apple.com/forums/thread/795579).
- [systemextensionsctl(8)](https://keith.github.io/xcode-man-pages/systemextensionsctl.8.html)
  and [SimulatorCamera's README](https://github.com/dautovri/SimulatorCamera)
  on developer mode needing SIP off.

OBS (macOS 13+ uses the extension):

- [plugin-main.mm](https://github.com/obsproject/obs-studio/blob/master/plugins/mac-virtualcam/src/obs-plugin/plugin-main.mm):
  activation from the OBS process, the CMIO calls, the pixel-buffer pool.
- [OBSCameraDeviceSource.swift](https://github.com/obsproject/obs-studio/blob/master/plugins/mac-virtualcam/src/camera-extension/OBSCameraDeviceSource.swift):
  1920×1080 32BGRA, a sink stream, a placeholder still.
- [entitlements-extension.plist](https://github.com/obsproject/obs-studio/blob/master/frontend/cmake/macos/entitlements-extension.plist)
  and [helpers.cmake](https://github.com/obsproject/obs-studio/blob/master/cmake/macos/helpers.cmake):
  the extension entitlements only with a provisioning profile.
- [en-US.ini](https://github.com/obsproject/obs-studio/blob/master/plugins/mac-virtualcam/src/obs-plugin/data/locale/en-US.ini):
  the System Settings paths per macOS version.
- [v4l2-output.c](https://github.com/obsproject/obs-studio/blob/master/plugins/linux-v4l2/v4l2-output.c):
  `pkexec modprobe v4l2loopback exclusive_caps=1`, YUYV.
- [virtualcam-install.bat.in](https://github.com/obsproject/obs-studio/blob/master/plugins/win-dshow/virtualcam-module/virtualcam-install.bat.in):
  the DirectShow route needs admin and `regsvr32`.

Microsoft:

- [MFCreateVirtualCamera](https://learn.microsoft.com/en-us/windows/win32/api/mfvirtualcamera/nf-mfvirtualcamera-mfcreatevirtualcamera):
  build 22000, the name suffix, admin for AllUsers.
- [MFVirtualCameraLifetime](https://learn.microsoft.com/en-us/windows/win32/api/mfvirtualcamera/ne-mfvirtualcamera-mfvirtualcameralifetime).
- [Windows-Camera VirtualCamera sample](https://github.com/microsoft/Windows-Camera/tree/master/Samples/VirtualCamera):
  HKLM registration, the Frame Server and Frame Server Monitor.
- Community notes on the Frame Server as Local Service, the DLL outside
  the profile and the `Global\` section's DACL:
  [VL.Video.VirtualCamera](https://github.com/bj-rn/VL.Video.VirtualCamera),
  [spiegel #1](https://github.com/juniormartinxo/spiegel/issues/1),
  [CapView wiki](https://github.com/NuclearMeltdown/CapView/wiki/Virtual-camera)
  (which apps see MF vs DirectShow cameras).

Linux:

- [v4l2loopback README](https://github.com/umlaeute/v4l2loopback):
  DKMS, secure boot, `exclusive_caps`, the writer sets the format.

electron-builder (from its source):

- [macOptions.ts](https://github.com/electron-userland/electron-builder/blob/master/packages/app-builder-lib/src/options/macOptions.ts):
  `entitlements`, `entitlementsInherit`, `minimumSystemVersion`.
- [MacTargetHelper.ts](https://github.com/electron-userland/electron-builder/blob/master/packages/app-builder-lib/src/targets/mac/MacTargetHelper.ts):
  `provisioningProfile` handed to osx-sign.
