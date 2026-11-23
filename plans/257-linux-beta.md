# Plan 257: Linux beta, every Mac feature on Linux or an honest Linux equivalent

## Status and scope

- **Status:** PLANNED 2026-11-21. Audit and plan only; no product code
  changed. Owner decisions D1 and D3–D12 DECIDED 2026-11-21 (the recommended
  defaults); D2 (a second Linux machine) is OWNER-OWED, and the checks only
  that machine can make wait in S21 and S22.
- **Summary for dispatch:** [257-linux-beta-summary.md](257-linux-beta-summary.md).
- **The owner's ask (2026-11-21):** "lets continue now working towards beta
  for linux on ogre machine, what's your recommendation what can we do to
  match all features to work same like on mac there?"
- **Where Linux stands:** 0.36.0 shipped `Videorc-0.36.0-linux-x64.AppImage`
  as a public Alpha under an owner waiver with no physical acceptance
  (`docs/acceptance/linux-alpha/0.36.0-alpha.1.json`, `performed: false`).
  Every Linux Alpha since 0.9.122 was waived the same way. The same morning
  the stock live-lab harness went live from ogre on 0.36: live 1.1 s after
  the click, about 30 fps, 0 % dropped.
- **Out of scope:** the separate Rust UI app (`~/src/videorc-rust`), Windows,
  and the cloud/web repos except where a Linux desktop slice needs them.
- **Base:** `origin/main` at `6f29ff59e` (2026-11-21).

## How this was checked

1. **Code.** Every `process.platform` / `isMac` / `darwin` / `linux` branch
   in `apps/desktop/src` and every `#[cfg(target_os …)]` in `crates/`, plus
   the Linux docs, plans 052, 053, 179 and the acceptance records.
2. **ogre, real app.** The 0.36.0 lab build in
   `~/.local/share/videorc-lab/Videorc` (built from `origin/main` `dbda7f43d`
   with `VIDEORC_PACKAGED_TEST_HOOKS=1`, so it can be driven over CDP; the
   shipped commit `ead80722` is an ancestor). Its hash is not the shipped
   artifact's (`7fb1089e…` vs `b78fd1f1…`): the shipped AppImage is not on
   ogre and needs a signed-in download. Isolated profile, data and
   recordings dirs, auto-update and usage stats off, no accounts. Wayland
   (Hyprland 0.56.2, Omarchy), lab output `videorc-lab`, tone into
   `videorc_lab_speech` and recorded through `videorc_lab_mic`. No USB mic
   is plugged in. The FaceTime HD camera is in the closed lid, so its
   picture is black.
3. **What limited the spot check (read before trusting a verdict):**
   - **The session was locked.** ogre's locker is omarchy-shell
     (quickshell, `ext-session-lock`), not hyprlock. The lock covers the lab
     output too, so screen capture showed the lock screen, and once the lab
     output was awake Hyprland stopped sending the app window frame
     callbacks (CDP screenshots hung). The page screenshots were therefore
     taken from the same build relaunched with `--ozone-platform=headless`;
     the recording, capture and remote checks ran on the real Wayland
     instance.
   - **The box was busy.** Other agents' `rustc`/`cc1` builds and a Godot
     process pushed the load average to 34 on 12 threads during both
     recordings. The two recording failures below must be reproduced on a
     quiet box before anyone calls them the product's fault (S1).
   - **No OAuth client IDs in the lab build.** It says "Signing in to
     YouTube/Twitch/Kick isn't available in this build". The CI Linux
     release embeds them (`.github/workflows/release-linux-alpha.yml:187-209`),
     so sign-in on the shipped build is unverified, not missing.
   - Nothing went live (today's lab budget is spent; streaming was proven
     this morning).

Evidence: screenshots `~/.local/share/ghostex/i/videorc-linux-beta-audit-*.png`;
logs, page text and recordings in `~/logs/linux-beta-audit/` (`run/app.log`,
`text/*.txt`, `run/app-data/recordings/`).

## Parity matrix

Status key: **W** works (seen today), **W\*** works in code, not seen
today, **D** degraded, **B** broke in today's spot check, **M** missing,
**OS** the OS has no Mac-style API (a Linux-native equivalent is listed
below), **=** neither platform has it. `R` = `crates/videorc-backend/src`,
`M` = `apps/desktop/src/main`, `UI` = `apps/desktop/src/renderer/src`.

### Capture and sources

| Feature                                                  | Mac                                 | Linux today                                                                  | St  | Gap                                                                                                                                            | Evidence                                                                                                                                   |
| -------------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------- | --- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Whole-screen capture                                     | ScreenCaptureKit, full display list | xdg-desktop-portal ScreenCast + PipeWire; the portal picker chooses          | W   | No list before consent; CPU copy into BGRA (no DMA-BUF)                                                                                        | Portal granted in 0.3 s, `BGRx 1920x1080` (`run/app.log` 20:18:23); `R/linux_portal_capture.rs:236-276`, `R/linux_pipewire_stream.rs:1-48` |
| Window capture                                           | SCK window list                     | `Window (portal)` entry                                                      | W\* | Not exercised                                                                                                                                  | `R/screen_capture.rs:519-600`                                                                                                              |
| Restore without asking again                             | n/a                                 | Restore token, `ExplicitlyRevoked`, re-asks once                             | W   | Restart only, no reconnect after revoke                                                                                                        | `R/linux_portal_session.rs:310`, `R/preview_screen.rs:6238-6300`                                                                           |
| Two screens / follow a resolution change                 | Yes                                 | `set_multiple(false)`, no display facts, no resize follow                    | D   | One stream; a resize keeps the old size                                                                                                        | `R/linux_portal_session.rs:309`, `R/preview_screen.rs:3176-3188`                                                                           |
| App scenes, Follow front app, scene stills, app previews | Yes                                 | Hidden / `unsupported`                                                       | OS  | No front-app or window-list API on Wayland                                                                                                     | `R/screen_capture.rs:144-153,282-289,470-489`; `UI/components/scene/scene-picker-dialog.tsx:119-121`                                       |
| Change mic, camera or screen while recording/live        | Yes, in place                       | Refused: "On Linux, change them while nothing is recording or live"          | M   | Must stop to change a source                                                                                                                   | `R/recording.rs:560-572,7807-7823`; Sources page text                                                                                      |
| Camera                                                   | AVFoundation, native format         | V4L2 via an FFmpeg `-f v4l2` child; asks the canvas size, no `-input_format` | D   | FaceTime HD only offers 1280x720 NV12; the child asks 1920x1080 and scales to BGRA on the CPU: **~180 % CPU at idle**                          | `ps` of PID 1498924; `R/preview_camera.rs:5427-5450`; `R/linux_v4l2_camera.rs`                                                             |
| Camera hotplug                                           | CFRunLoop observer                  | `device_watch::install` is a no-op                                           | M   | Plug a webcam in, restart the app                                                                                                              | `R/device_watch.rs:122-128`                                                                                                                |
| Microphone                                               | CoreAudio                           | Pulse protocol through pipewire-pulse, native capture worker                 | B   | Both takes: tone for 3.5 s / 6 s, then digital silence; "could not place it on the session timeline"; 897,628 frames dropped (under host load) | `run/app.log` 20:30:49, 20:33:32; per-second RMS in the MP4s                                                                               |
| Desktop / system audio                                   | SCK audio, own app excluded         | `system_audio_capable()==false`, row Unavailable                             | M   | Game, browser and alert sound never reach the stream                                                                                           | `R/system_audio_session.rs:78-90`, `R/devices.rs:70-84`                                                                                    |
| Noise reduction                                          | rnnoise                             | Same                                                                         | W\* | —                                                                                                                                              | `R/recording.rs:24834-24847`                                                                                                               |
| Camera low light                                         | —                                   | —                                                                            | =   | Windows only                                                                                                                                   | `R/camera_low_light.rs:561`                                                                                                                |

### Encoding, preview and compositing

| Feature                            | Mac               | Linux today                                                                     | St  | Gap                                                                                                       | Evidence                                                                     |
| ---------------------------------- | ----------------- | ------------------------------------------------------------------------------- | --- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Hardware H.264                     | VideoToolbox      | `auto` picks VAAPI on Intel iHD with nothing set (S5); OpenH264 fallback        | W   | S5: L1.5 proven on ogre, AMD node stays quarantined (matched by GPU, not number); AMD VAAPI unproven (D2) | `R/linux_vaapi.rs`; `docs/acceptance/2026-11-23-linux-l1.5-ogre.md`          |
| NVIDIA                             | n/a               | No `h264_nvenc` arm                                                             | M   | NVIDIA owners get OpenH264                                                                                | `R/protocol.rs:2255-2270`                                                    |
| Separate record and stream encodes | VT split roles    | One shared encode                                                               | D   | Recording quality follows the stream; one failure takes both                                              | `R/recording.rs:23249-23259`                                                 |
| Clips (keep the last seconds)      | On                | On with VAAPI (S5); "Off on this computer … OpenH264" only on the software path | W   | S5: the ring runs on ogre on VAAPI; saving a clip on Linux not checked yet (plan 181)                     | Output page text                                                             |
| Preview                            | CAMetalLayer, GPU | Electron proof surface: waiting I420 requests drawn with WebGL (S3)             | W   | S3: 30 of 30 fps, 29 / 37 ms on the camera; Health "Smooth", "App window"; CPU half owed (183 %)          | `M/native-preview-proof-poller-runtime.ts`; `R/preview_bmp.rs`; S3 spike doc |
| Preview first-frame watchdog       | Metal heal        | Proof watchdog with heal on Linux (S3)                                          | W   | S3: stall seen in 1.7 s, two heals, fallback at 7.6 s, live again 1 s after the source returns            | `M/native-preview-first-frame.ts` (`proofWatchdogHealAction`)                |
| Compositor                         | Metal             | CPU YUV420p (`GpuCompositor` uninhabited)                                       | D   | Rendered 7 fps of 30 at 166 % CPU during a take (under load)                                              | `run/app.log` 20:33:16; `R/compositor.rs:8119-8137`                          |
| Live backgrounds                   | Metal             | GLES 3 on EGL, one render node                                                  | W\* | ogre goldens owed (plans 190, 194)                                                                        | `R/live_background/gl.rs`                                                    |
| Green / blue screen                | Metal or CPU      | CPU path                                                                        | W\* | Not seen (black camera)                                                                                   | `R/compositor.rs:9548-9556`                                                  |
| Background removal / segmentation  | —                 | —                                                                               | =   | Neither platform has it                                                                                   | —                                                                            |
| Live canvas on the Scene tab       | Yes               | On (S3): the docked in-window view                                              | W   | S3: docked into the `scene` slot on ogre                                                                  | `UI/components/tabs/layout-tab.tsx`                                          |
| Window glass                       | Vibrancy          | Solid palette                                                                   | OS  | Cosmetic                                                                                                  | `M/window-glass.ts:161-163`                                                  |

### Recording and output

| Feature                     | Mac                | Linux today                 | St  | Gap                                                                                                                                                              | Evidence                                                          |
| --------------------------- | ------------------ | --------------------------- | --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| MP4 recording               | Yes                | Yes                         | B   | 2/2 takes: "FFmpeg did not finish after Stop … SIGKILL", saved by recovery (14.0 s and 30.6 s); 1080p30 H.264 + AAC; audio silent after 3.5–6 s (see Microphone) | `run/app.log` 20:31:15, 20:33:58; `run/app-data/recordings/*.mp4` |
| Separate source (ISO) files | Yes                | "Works on Mac only for now" | M   | —                                                                                                                                                                | `R/source_iso.rs:38-43`; Output page                              |
| Recordings folder           | `~/Movies/Videorc` | XDG Videos                  | W   | —                                                                                                                                                                | Output page                                                       |
| Markers, Library, clean cut | Yes                | Same code                   | W\* | Library page renders                                                                                                                                             | `R/clean_cut/render.rs:436-452`                                   |

### Streaming, accounts and chat

| Feature                                            | Mac                  | Linux today                                                                             | St  | Gap                                                                     | Evidence                                                                 |
| -------------------------------------------------- | -------------------- | --------------------------------------------------------------------------------------- | --- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| RTMP to YouTube                                    | Yes                  | Yes                                                                                     | W   | Proven by this morning's lab run (picture content not checked, see Lab) | lab run `2026-11-21-golive-short-08f1c2`                                 |
| Twitch, Kick, X, Facebook, Custom RTMP, vertical   | Yes                  | Same pipeline                                                                           | W\* | Not exercised per platform                                              | Destinations page                                                        |
| OAuth sign-in (YouTube, Twitch, Kick, X)           | Loopback callback    | Same loopback flow; AppImage registers `videorc://` with a managed `.desktop`           | W\* | Unverified on the shipped build (lab build has no client IDs)           | `M/index.ts:10522-10609`; `M/linux-desktop-entry.ts`                     |
| Password store                                     | Keychain safeStorage | libsecret / KWallet; forces `gnome-libsecret` on Hyprland/Sway/i3; refuses `basic_text` | D   | No Secret Service → sign-in fails with no preflight                     | `M/linux-password-store.ts:79-86`; `M/secure-persistence-codec.ts:57-62` |
| Stream Manager, chat, activity                     | Yes                  | Same                                                                                    | W   | Renders                                                                 | screenshot `h-stream-manager`                                            |
| Hide a window from capture (Stream Manager, Notes) | Capture filter       | `unsupported`, switch disabled                                                          | OS  | The chat window shows up in a screen capture                            | `M/window-capture-protection.ts:57-65`                                   |
| Always-on-top Notes/Comments/Captions windows      | Yes                  | `setAlwaysOnTop` only; a no-op on most Wayland compositors, no copy                     | D   | —                                                                       | `M/index.ts:3541-3555`                                                   |
| Stream Manager screen-swap tap                     | Moves the window     | Refused on Wayland                                                                      | OS  | —                                                                       | `M/stream-manager-screen.ts:209-228`                                     |

### Live features

| Feature                               | Mac              | Linux today                                                                             | St  | Gap                                                                                                  | Evidence                                                               |
| ------------------------------------- | ---------------- | --------------------------------------------------------------------------------------- | --- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Live captions                         | Yes              | "Live captions aren't available on Linux yet"                                           | M   | The mic never reached the caption path when it went straight to FFmpeg; the native worker now exists | `UI/lib/captions-preflight.ts:130-145`; Captions page                  |
| Global shortcuts, scene hotkeys       | `globalShortcut` | Wayland: none registered, reason shown; X11 works                                       | OS  | Hotkeys from a game or a Stream Deck profile on the keyboard don't fire                              | `M/global-shortcut-lifecycle.ts:21-37`                                 |
| Scenes, in-app switching              | Yes              | Yes                                                                                     | W   | —                                                                                                    | Studio                                                                 |
| Talk-show rooms (LiveKit)             | Yes              | Room screen share ids not mapped; room system audio `bail!`; frame bridge `unsupported` | D   | Guests can't see your screen from Linux                                                              | `UI/lib/room-screen-source.ts:14-22`; `R/room_system_audio.rs:211-214` |
| Cloud shows and handoff               | Yes              | No OS gate; plan 184 "Linux comes later"                                                | W\* | Never run on Linux                                                                                   | `R/cloud_show.rs:140-160`                                              |
| Sidekick and its voice, avatar, buddy | Yes              | Same code; buddy via `/preview/buddy/latest.bmp`                                        | W\* | Pages render; voice not exercised                                                                    | screenshots `h-sidekick`, `h-avatar`                                   |
| Takeovers, images, sounds, soundboard | Yes              | Same                                                                                    | W   | Pages render                                                                                         | screenshots                                                            |
| Virtual camera                        | CMIO extension   | v4l2loopback writer, `PROVEN=false` → hidden; module not installed on ogre              | M   | —                                                                                                    | `R/virtual_camera_linux.rs:66`; `modinfo v4l2loopback` fails           |
| Notifications (system)                | Yes              | Same code; ogre has a notification daemon                                               | W\* | —                                                                                                    | `M/index.ts:19395-19415`                                               |
| Remote control (Stream Deck)          | Yes              | Yes                                                                                     | W   | Pairing token issued                                                                                 | screenshot `h-settings-remote-phone-on`                                |
| Phone remote                          | Yes              | Yes                                                                                     | W   | Listened on `0.0.0.0:7420`, closed when turned off                                                   | `ss -ltnp` before/after                                                |
| Agents / MCP                          | Yes              | MCP bridge in `~/.local/share/videorc/bin`                                              | W\* | —                                                                                                    | `M/agent-bridge.ts:92`                                                 |

### App, install and update

| Feature                   | Mac                   | Linux today                                                | St  | Gap                                                                             | Evidence                                                            |
| ------------------------- | --------------------- | ---------------------------------------------------------- | --- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| First-run onboarding      | Yes                   | Hidden entirely                                            | M   | New Linux users get no setup (groups, portal, Secret Service)                   | `UI/lib/first-run.ts:84`                                            |
| Permissions page          | TCC rows              | "Nothing to grant here"                                    | W   | —                                                                               | screenshot `h-settings-permissions`                                 |
| Health and support bundle | Yes                   | Yes                                                        | W   | Flags the preview fallback                                                      | screenshot `h-settings-about-open-health`                           |
| Auto-update               | electron-updater      | "This build doesn't update itself"; `latest-linux.yml` 404 | M   | Users must notice and redownload                                                | About page; `M/updater.ts:418-421`                                  |
| Packaging                 | Signed, notarized DMG | Unsigned x64 AppImage only                                 | D   | No deb/rpm/Flatpak/arm64; Ubuntu 24.04 AppArmor needs `--no-sandbox` via AppRun | `apps/desktop/electron-builder.yml`; `docs/distribution.md:135-156` |
| Release track label       | Beta                  | Alpha                                                      | —   | Flips at the end of this plan                                                   | `UI/lib/release-track.ts:11`                                        |
| Sleep inhibit while live  | powerSaveBlocker      | Same (portal/ScreenSaver inhibit)                          | W\* | —                                                                               | `M/index.ts:1179`                                                   |

### Counts

55 rows (one is the release-track label). **Works, seen today 11**;
**works in code, not seen 12**; **degraded 11**; **broke in the spot check
2** (mic, recording stop); **missing 11**; **OS-limited 5**; **neither
platform 2**. The two "broke" rows ran under heavy host load and need S1's
quiet-box repro first.

## What "beta" means for Linux

No doc defines how a platform moves from Alpha to Beta (the release docs only
promote candidate → pilot → public inside a track). This plan defines it.

**Linux Beta = a streamer on a supported desktop can set up, record, go live
on all four platforms with sign-in and chat, and update, with every Mac
feature either working or replaced by a named Linux equivalent, proven by a
physical acceptance pass on two named boxes, with no owner waiver.**

### Supported (D1)

| Tier                                  | Distro and desktop                                                     | Session | GPU and encoder                    |
| ------------------------------------- | ---------------------------------------------------------------------- | ------- | ---------------------------------- |
| 1 (beta-supported, in acceptance)     | Ubuntu 24.04 LTS, GNOME 46+                                            | Wayland | Intel iHD or AMD radeonsi VAAPI    |
| 1                                     | Arch-family (Omarchy) with Hyprland 0.5x — ogre                        | Wayland | Intel iHD VAAPI; OpenH264 fallback |
| 1                                     | Fedora 41+ KDE Plasma 6                                                | Wayland | VAAPI                              |
| 2 (best effort, bug reports accepted) | The same distros on X11; Sway and other wlroots; Debian 13; Linux Mint | Either  | VAAPI, NVENC (after S6), OpenH264  |
| Not supported                         | VMs, arm64, Ubuntu 22.04 and older (old PipeWire/portal)               | —       | —                                  |

Minimums: PipeWire ≥ 1.0 with pipewire-pulse, xdg-desktop-portal ≥ 1.18 with
the desktop's backend, a Secret Service (gnome-keyring or KWallet), user in
`video` and `render`.

### Packaging and update (D3, D4, D5)

- **Beta ships one format: the x64 AppImage**, as today (static type2
  runtime, no libfuse2).
- **It updates itself.** electron-updater already supports AppImage updates
  from `latest-linux.yml` with a blockmap; the feed just isn't published.
  Same rules as the Mac: never while recording or live, staged download,
  "Restart to update". The changelog notice stays as the fallback for
  extracted or read-only installs.
- **Integrity:** the feed carries sha512 over HTTPS (electron-updater
  checks it); every release also gets a `.sha256` and a detached signature
  for people who verify by hand.
- `.deb` and Flatpak come after beta (Flatpak needs FFmpeg, V4L2 and
  v4l2loopback inside a sandbox; worth a plan of its own).

### Physical acceptance (mirrors the Windows checklist, #1579)

A new `docs/acceptance/linux-physical-acceptance-checklist.md` with the
same shape as `windows-physical-acceptance-checklist.md` (preamble on what one
pass proves, numbered phases of `- [ ]` steps with Evidence and Gates lines, a
gate table, open questions, sources), a private dated evidence template, and
a public JSON record validated by `scripts/lib/linux-acceptance-record.mjs`.
Run once per Tier 1 box (ogre plus an Ubuntu 24.04 box, D2).

1. **Machine.** Distro, kernel, desktop, session type, GPU and driver,
   PipeWire, portal and backend versions, Secret Service, groups. No
   leftover Videorc data.
2. **Fetch and verify the exact candidate.** sha256 and signature match the
   release record; AppImage runs without FUSE; on Ubuntu, the AppArmor
   `--no-sandbox` path is taken and logged.
3. **Clean install and first launch.** First-run steps (S17); `.desktop`
   and `videorc://` registered; screen grant through the real portal
   dialog; restore token reused on the next launch.
4. **Sources.** Screen, window, camera (built-in and USB, hotplug), mic
   (built-in and USB), desktop audio. Change each one while recording.
5. **Recordings.** Screen-only, camera-only, screen+camera+mic, desktop
   audio, 1080p30 and 1080p60, separate source files, a clip; every file
   through the artifact analyzer (A/V sync, no silent gaps, fps, colour
   tags). `pnpm smoke:recording-matrix` and `smoke:record-latency:gate` on
   the box.
6. **Live.** YouTube, Twitch, Kick and X: sign in, go live, chat both ways,
   captions on, scene hotkey from another focused app, Stream Manager,
   phone remote. Through the lab where possible (plan 179), with the picture
   checked.
7. **Talk show.** Join a room, share the screen to a guest, guest hears
   desktop audio.
8. **Virtual camera.** Load the module, use Videorc Camera in a browser
   call, unload.
9. **Encoders.** VAAPI on Intel and AMD, OpenH264 fallback, NVENC if a box
   has it; `pnpm smoke:linux-encoder-acceptance`.
10. **Update.** Previous Beta → candidate through the feed, held while
    recording; rollback.
11. **Cleanup.** Remove the AppImage, `.desktop`, data; owned processes gone.

Gates (JSON keys): `cleanInstall`, `protocolSignIn`, `portalScreenGrant`,
`restoreToken`, `screenOnlyRecording`, `cameraOnlyRecording`,
`screenCameraMicrophoneRecording`, `desktopAudioRecording`,
`liveSourceChange`, `vaapiPath`, `softwareFallbackPath`, `globalShortcuts`,
`liveCaptions`, `allFourPlatformsLive`, `talkShowScreenShare`,
`virtualCamera`, `betaToBetaUpdate`, `ownedProcessCleanup`,
`supportBundleRedaction`, `artifactSignature`.

## Gaps ranked by what a streamer feels

1. **The recording can lose the mic and hang at Stop** (2/2 takes today:
   tone for 3.5–6 s then silence, FFmpeg SIGKILLed, file saved by recovery).
   Ran under heavy host load, so it may be load-only, but a streamer on a
   busy laptop is exactly the case. S1.
2. **The preview is a CPU fallback.** Health calls it "Fallback"; the
   camera layer updated about once a second in the sample; camera plus
   preview cost about 3 cores at idle. The Mac preview is the product's
   pride. S2, S3.
3. **Scene and global hotkeys don't work on Wayland**, which is the default
   on every Tier 1 desktop. S11.
4. **No desktop audio.** Game, browser and alert sound never reach the
   stream. S8.
5. **No live captions on Linux.** S10.
6. **No source changes while live or recording** (mic, camera, screen). S9.
7. **The camera path is heavy and rigid**: upscales on the CPU, no format
   choice, no hotplug. S2.
8. **No self-update.** S19.
9. **Hardware encoding isn't the default on most boxes** (VAAPI evidence
   missing, AMD quarantined on ogre, no NVENC), so Clips are off and record
   and stream share one encode. S5, S6, S7. (S5 done 2026-11-23: VAAPI is
   the default on Intel iHD and Clips run on ogre; NVENC and split encodes
   remain.)
10. **Talk-show rooms from Linux can't share the screen or desktop audio.**
    S14.

Then: Videorc Camera hidden (S16); separate source files missing (S15);
chat window visible in captures and not on top on Wayland (S12); no
onboarding (S17); no Secret Service preflight (S18); AppImage only (D3).

## What Linux can't do the Mac way, and the closest Linux equivalent

| Mac way                                            | Why Linux can't                                                                                                 | Closest Linux-native equivalent                                                                                                                                                                                                                                                                                                                                                 | Slice     |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `globalShortcut` key grabs                         | Wayland gives no app a global key grab; Chromium's GlobalShortcuts portal route fails ("An app id is required") | Videorc registers its shortcuts itself through the **GlobalShortcuts portal** (`ashpd`), after registering its app id `videorc` with the portal host Registry. xdph (Hyprland), KDE 6 and GNOME 48+ implement it; the desktop shows its own bind dialog. On X11, keep `globalShortcut`. GNOME 46 (Ubuntu 24.04) lacks the portal: say so, point to Phone remote and Stream Deck | S11       |
| SCK lists every display and window up front        | The portal hands over only what the user picked                                                                 | Keep the picker; restore tokens per scene screen so each scene asks once, ever                                                                                                                                                                                                                                                                                                  | S9        |
| Front app / app scenes / window thumbnails         | No front-app or window-list protocol on Wayland                                                                 | Hyprland and Sway have IPC for the active window (opt-in, Tier 1 Hyprland only); GNOME/KDE: hide with a reason, as today                                                                                                                                                                                                                                                        | post-beta |
| Hide a window from capture (`NSWindowSharingNone`) | No standard protocol                                                                                            | Hyprland's `noscreenshare` window rule (Videorc offers to add it for its own windows); everywhere else, say so and suggest capturing a single window                                                                                                                                                                                                                            | S12       |
| Always-on-top floating chat                        | `xdg_toplevel` has no "above" state                                                                             | Hyprland `pin` / window rules, KWin window rules; elsewhere explain                                                                                                                                                                                                                                                                                                             | S12       |
| CMIO system extension (Videorc Camera)             | Needs a kernel module                                                                                           | `v4l2loopback` (DKMS), loaded with `pkexec modprobe`; Secure Boot needs a signed module or guidance                                                                                                                                                                                                                                                                             | S16       |
| Signed and notarized app, Sparkle-style update     | No notarization; AppImage is unsigned                                                                           | sha512 feed over HTTPS + detached signature; electron-updater AppImage updates                                                                                                                                                                                                                                                                                                  | S19       |
| Window glass (vibrancy)                            | No blur API for clients (KWin and Hyprland blur on their own)                                                   | Solid palette; Hyprland/KWin users can blur with compositor rules                                                                                                                                                                                                                                                                                                               | none      |
| CAMetalLayer native preview                        | No CAMetalLayer; Electron draws its own surfaces                                                                | A shared-memory or GPU-texture preview path inside Electron (S3); a native Wayland subsurface is not possible from Electron                                                                                                                                                                                                                                                     | S3        |
| SCK system audio, own app excluded                 | Different API                                                                                                   | PipeWire: capture the default sink's monitor and drop Videorc's own playback node; per-app capture is easier on PipeWire than on the Mac                                                                                                                                                                                                                                        | S8        |

## Slices

Each slice is one PR to `TheOrcDev/videorc` `main`, leaves `main` green,
and follows `AGENTS.md`'s gates. Every slice that touches the Linux
recording arm runs the direct matrix command on ogre (AGENTS.md); macOS
can't compile that arm. Heavy jobs on ogre follow its limits: `cargo -j3`,
`vitest --maxWorkers=4`, one heavy job at a time, quiet box for timing
claims.

Routes and lanes follow the repo's convention (plan 250): **Owner route**
(Implementation, Diagnose → Implementation, UI/Product Design, Docs,
Release) with a fit score, and a **Model lane** (`fable-5.1`,
`gpt-6.1-sol`, `opus-5.5`).

### Battle order

| #   | Slice                                                            | Route · lane · fit                            | Depends on                |
| --- | ---------------------------------------------------------------- | --------------------------------------------- | ------------------------- |
| S0  | Lab tells a locked session and checks the picture                | Implementation · `gpt-6.1-sol` · 8            | —                         |
| S1  | Mic dropout and FFmpeg hang at Stop: reproduce, fix              | Diagnose → Implementation · `fable-5.1` · 9   | —                         |
| S2  | Camera: native format, device size, hotplug                      | Implementation · `fable-5.1` · 8              | —                         |
| S3  | Preview transport and watchdog (spike, then build)               | Implementation · `fable-5.1` · 9              | S2                        |
| S4  | Linux docs tell the truth                                        | Docs · `gpt-6.1-sol` · 7                      | —                         |
| S5  | VAAPI by default, L1.5 evidence committed                        | Implementation · `gpt-6.1-sol` · 8            | S1                        |
| S6  | NVENC arm                                                        | Implementation · `gpt-6.1-sol` · 8            | S5, D7                    |
| S7  | Separate record and stream encodes on VAAPI                      | Implementation · `fable-5.1` · 8              | S5                        |
| S8  | Desktop audio through PipeWire                                   | Implementation · `fable-5.1` · 9              | S1                        |
| S9  | Change sources while recording or live; per-scene screens        | Implementation · `fable-5.1` · 9              | S1, S2                    |
| S10 | Live captions on Linux                                           | Implementation · `gpt-6.1-sol` · 8            | S1                        |
| S11 | Global shortcuts through the GlobalShortcuts portal              | Implementation · `fable-5.1` · 9              | D9                        |
| S12 | Wayland window behaviours: hide from capture, on top, screen tap | UI/Product Design · `opus-5.5` · 8            | D8                        |
| S13 | Talk-show rooms from Linux: screen share, desktop audio          | Implementation · `fable-5.1` · 8              | S8                        |
| S14 | Cloud shows and handoff on Linux, verified                       | Diagnose → Implementation · `gpt-6.1-sol` · 7 | S13                       |
| S15 | Separate source (ISO) recordings on Linux                        | Implementation · `fable-5.1` · 8              | S7                        |
| S16 | Videorc Camera proven and shown                                  | Implementation · `gpt-6.1-sol` · 8            | owner installs the module |
| S17 | First-run onboarding for Linux                                   | UI/Product Design · `opus-5.5` · 8            | S18                       |
| S18 | Secret Service, groups and portal preflight                      | Implementation · `gpt-6.1-sol` · 8            | —                         |
| S19 | AppImage self-update and the Linux feed                          | Implementation · `fable-5.1` · 9              | D4, D5                    |
| S20 | Linux acceptance checklist, record schema, validator             | Docs · `gpt-6.1-sol` · 8                      | —                         |
| S21 | Feature sweep on both boxes (no going live)                      | Review · `fable-5.1` · 9                      | S1–S19; second box: D2    |
| S22 | Physical acceptance and the Beta flip                            | Release · human gate                          | S20, S21, **D2 (owed)**   |

Streamer relief comes early: S1 (recordings you can trust), S2 (a lighter
camera), S11 (hotkeys) and S8 (desktop audio) can run in parallel after S0.
S3 is the biggest single piece.

### S0: the lab tells a locked session and checks the picture

**Owner route:** Implementation (fit 8). **Model lane:** `gpt-6.1-sol`.
**Goal:** a lab run on Linux never streams a lock screen as if it were the
test card.
**Why:** ogre's locker is omarchy-shell (quickshell, `ext-session-lock`).
`evaluateLinuxScreenLock` only looks for hyprlock
(`scripts/live-lab/lib/doctor-checks.mjs:818-830`), and `card-up` passes on
window placement, not pixels. Today's lab output under the lock was the lock
screen (`videorc-linux-beta-audit-06-lab-output-awake-fullscreen.png`).
**Touches:** `scripts/live-lab/lib/doctor-checks.mjs`,
`scripts/live-lab/lib/linux-desktop.mjs`, `common-steps.mjs`, tests.
**Steps:**

1. Detect a session lock by protocol, not process name: Hyprland's
   `hyprctl layers`/`monitors` lock state, or `loginctl show-session -p
LockedHint`, plus known lockers (hyprlock, omarchy-shell/quickshell lock,
   swaylock, gtklock) as a hint.
2. `card-up` grabs one frame of the lab output (`grim -o`) and looks for the
   card's pixel markers; a lock screen or black output fails it.
   **Done when:** `pnpm test:scripts` covers locked/unlocked/black cases, and
   `pnpm live:doctor` on ogre FAILs while the session is locked by
   omarchy-shell and passes after unlock.
   **Out of scope:** changing the owner's lock policy (D12).

### S1: mic dropout and FFmpeg hang at Stop: reproduce, then fix

**Owner route:** Diagnose → Implementation (fit 9). **Model lane:** `fable-5.1`.
**Goal:** every Linux recording keeps its microphone for its whole length
and stops cleanly.
**Evidence:** two takes on ogre (`~/logs/linux-beta-audit/run/app.log`):
"Microphone buffers keep arriving but none could be placed for 2s",
"could not place it on the session timeline after 18.6 s", "897628 frames
dropped", then "FFmpeg did not finish after Stop … SIGKILL" and recovery to
MP4. Per-second RMS: tone for 3.5 s / 6 s, then `-inf`. Load average was
~28–34 during the takes; the compositor rendered 7 fps of 30.
**Steps:**

1. Reproduce on a quiet ogre (no other agents' builds): 10 × 60 s takes with
   a continuous tone through `videorc_lab_mic`, then the built-in mic, then
   a USB mic if the owner plugs one in. Repeat 5 × under `stress-ng --cpu 8`.
2. If it only fails under load: the timeline placement must survive late
   buffers (re-anchor instead of dropping for the rest of the session) and
   Stop must drain the encoder bridge with a bounded wait before signals.
   If it fails quiet, find the clock mismatch between the Pulse worker's
   timestamps and the session epoch (`R/session_audio.rs`,
   `R/audio_capture_adapter.rs`, `R/recording.rs` Linux arm).
3. Add a Linux case to the record-latency/artifact smokes that asserts no
   silent seconds while a tone plays.
   **Done when:** on ogre, 10 quiet and 5 loaded takes all give MP4s with no
   `-inf` second while the tone plays, A/V sync inside the analyzer budget, and
   no SIGKILL at Stop; `pnpm smoke:record-latency:gate` passes on ogre; the
   direct matrix command passes.
   **Out of scope:** changing sources mid-session (S9).
   **Result (2026-11-22, PR #1659):** load-driven, not a clock mismatch. FFmpeg
   encodes the Linux raw bridge itself and reads the audio FIFO only as far
   as the muxed video has got; a below-realtime encode held the bus cursor
   back, the bus queued only 1 s ahead of it, so every mic buffer was refused
   (`ahead-of-cap`) for the rest of the take. Fixed on Linux only: on-time
   capture waits for a trailing cursor (20 s backlog), and Stop hands FFmpeg
   the audio it owes (up to 15 s). Evidence in `~/linux-beta/s1/` on ogre:
   - Baseline (0.36 lab build, same code path): 2 × 30 s at load 22–30 lost
     28.3–29.1 s of tone per take; 2 × 60 s under 8 busy loops lost 13–35 s.
   - Quiet (no other jobs; the take itself holds ogre at load 19–27), 10 × 60 s
     camera + mic, 1080p30 OpenH264: **10/10 pass**, 0 ms silent, A/V skew
     0–20 ms, Stop 0.8–2.4 s, no forced Stop.
   - Loaded (`--load-cpus 8`, load 31–41): 1080p30 0/5 and VAAPI 0/3. The
     encode falls to 1–5 fps and the bridge ends 3 of the 5 software takes
     early (pre-existing: the baseline does the same). This is capacity (the
     CPU camera and compositor, S2/S3), not mic placement. 720p30 is 2/5:
     no early end and the mic held for the whole take; it failed on 1.2–2.6 s
     of video stamped past Stop (raw input queue latency, follow-up) and one
     forced Stop at load 41.
   - `smoke:record-latency:gate`: every artifact verified; fails only the
     macOS budgets Linux has no calibration for (warm click→recording p50
     702 ms / p95 1579 ms, stop→idle p50 925 ms / p95 1158 ms).
   - Direct matrix command (1080p30 OpenH264): PASS.

### S2: camera: native format, device size, hotplug

**Owner route:** Implementation (fit 8). **Model lane:** `fable-5.1`.
**Goal:** the camera costs a fraction of a core and appears when plugged in.
**Evidence:** the FFmpeg child asks the FaceTime HD camera (1280x720 NV12
only) for 1920x1080, then scales and converts to BGRA on the CPU: ~180 % CPU
at idle (`R/preview_camera.rs:5427-5450`).
**Steps:**

1. Enumerate formats with `VIDIOC_ENUM_FMT`/`ENUM_FRAMESIZES` (or `ffmpeg
-list_formats all`) once per device; choose the device's native size at
   the session fps, preferring MJPEG for USB cams over 720p and NV12/YUYV
   otherwise; pass `-input_format`; let the compositor scale.
2. Fill the camera capability matrix and pixel-format label on Linux
   (`R/camera_capture.rs:159-199`).
3. Hotplug: watch `/dev/v4l/by-id` (inotify) or udev and send the same
   device events the Mac sends (`R/device_watch.rs:122-128`).
   **Done when:** on ogre the camera child is under 40 % CPU at 720p30; Health
   shows the real format; a USB webcam plugged in while Videorc runs appears in
   the picker within 2 s and disappears on unplug (needs a USB webcam, owner);
   `pnpm smoke:linux-av-devices` and the matrix pass.

### S3: preview transport and watchdog

**Owner route:** Implementation (fit 9). **Model lane:** `fable-5.1`.
**Goal:** the Linux preview is smooth at the session fps and cheap, and
Health stops calling it a fallback.
**Steps:**

1. **Spike (one day, own commit, measured on a quiet ogre with the lid open
   and a moving card):** today's BMP-over-HTTP polling vs (a) shared memory
   ring + `ImageData`/`VideoFrame` into a canvas through the preload, (b) a
   WebCodecs-decoded low-latency H.264 preview leg, (c) the composed program
   frame instead of per-layer polling. Record fps delivered, latency and CPU.
2. Build the winner behind the existing proof-surface lifecycle; keep the
   `electron-proof-surface` identity rules from AGENTS.md (never claim
   CAMetalLayer).
3. Linux first-frame watchdog (`M/native-preview-first-frame.ts`), and
   bring the Scene tab's live canvas back on Linux.
   **Done when:** `pnpm probe:preview-lifecycle:linux` passes; the preview
   shows ≥ 29 of 30 fps of a moving card at 1080p30 for 60 s; idle app CPU with
   camera on drops by at least half from today's ~3 cores; Health's preview
   check is healthy.
   **Out of scope:** a GPU compositor (D6).
   **Result (2026-11-23, PR #1690):** spike first
   (`docs/acceptance/2026-11-23-linux-preview-transport-spike.md`): (a) won,
   without shared memory; (b) measured as components and deferred; (c) does
   not exist on Linux at idle. Built: the Linux proof surface asks for each
   source layer's next frame with `waitMs` (the backend holds the request
   until the source publishes), as BT.709 I420 shrunk only by whole box
   factors, in a two-stage pipeline per layer, drawn with WebGL into a canvas;
   the surface asks for 30 fps status ticks on Linux; Windows keeps its
   interval BMP and `<img>` unchanged. The proof watchdog runs on Linux and
   heals (restarts the frame requests twice) before it declares a fallback;
   Health judges the Linux Preview on its own presented rate ("Smooth",
   "Slow display", "Stalled") and names the path "App window" (never native);
   the Scene tab's live canvas is on. On ogre, production renderer: a moving
   1080p card 29.99 of 30 fps (min 29.86) at 8 / 27 ms; the real camera 29.98
   at 29 / 37 ms against 8.5 fps at 104 / 128 ms for today's transport; app
   CPU with the camera on 183 % (today's transport at the same surface rate
   204 %, main ~250-270 %, the plan's ~300 %). `pnpm
probe:preview-lifecycle:linux` passes (100 cycles). **Owed:** the CPU half (183 %
   against ~150 %; the H.264 leg is the measured way to the rest), and the
   moving card as a real screen capture of the lab card (the session was
   locked all night; the dev fixture camera stood in).

### S4: Linux docs tell the truth

**Owner route:** Docs (fit 7). **Model lane:** `gpt-6.1-sol`.
**Goal:** the docs say Linux is a public Alpha (waived) on its way to Beta.
**Touches:** `docs/linux-port-plan.md:10-21,144-146,249-265`,
`docs/distribution.md:9,172-174`, `docs/releases/release-runbook.md:76-88`,
`docs/linux-dev-loop.md:202`, `changelog/README.md:45-46`, release skill §5,
`docs/acceptance/linux-alpha/0.16.0-alpha.1.json` (malformed).
**Done when:** no doc says Linux is candidate-only or that public download
is owed; the support table matches this plan's tiers; `pnpm format:check`.

### S5: VAAPI by default, L1.5 evidence committed

**Owner route:** Implementation (fit 8). **Model lane:** `gpt-6.1-sol`.
**Goal:** a Tier 1 box with Intel or AMD encodes on the GPU without env pins.
**Steps:** run plan 052 S1–S3 and plan 053 S4 on ogre with
`VIDEORC_LINUX_H264_ENCODER` unset; commit the L1.5 evidence record; flip
the port-plan row; make sure `auto` picks VAAPI on iHD and that the
quarantine stays on ogre's amdgpu node. AMD proof waits for the second box
(D2).
**Done when:** `pnpm smoke:linux-encoder-acceptance` passes on ogre with
both backends; the Output page no longer says Clips are off on ogre; the
evidence JSON is committed. The AMD VAAPI check moves to S21's second-box
pass (blocked on D2).
**Result (2026-11-23):** `auto` already chose VAAPI first; ogre encoded
with OpenH264 only because the lab environment pinned it. Two safety gaps
would have opened once it stopped pinning, and both are fixed. (1) The
quarantine matched entries by node number, and ogre's numbers swap between
boots, so a swapped boot would have blocked Intel and probed the AMD GPU that
hangs the host. Entries now carry the PCI address and match by PCI address,
else driver, else name; the live-background node choice uses the same rule.
(2) Every isolated profile (all smokes) started with an empty quarantine; it
now also reads the machine's list in `~/.videorc/linux-vaapi` and never
writes it. On ogre, with no encoder, device or libva pins: the direct matrix
picked `hardware-vaapi` on `renderD128` (standard profile, `renderD129`
`quarantined`) and passed; `pnpm smoke:linux-encoder-acceptance` passed both
backends with `complete: true`
(`docs/acceptance/2026-11-23-linux-l1.5-ogre.{md,json}`); in the dev app with
the real camera the Output page's Clips row read "The newest seconds are on
disk…" with the switch on. Seen there and owed elsewhere: the ring's encoder
at 0.86× with "Uneven frames" in Health (the CPU compositor at 1080p30, D6).
**Owed:** AMD VAAPI on a second box (S21, D2); the lab environment
(`~/logs/s4.2a-env.sh`) still pins OpenH264 for other slices' runs.

### S6: NVENC arm

**Owner route:** Implementation (fit 8). **Model lane:** `gpt-6.1-sol`.
**Goal:** NVIDIA owners encode on the GPU.
**Steps:** confirm the pinned LGPL FFmpeg carries `h264_nvenc` (ffnvcodec
headers are MIT; no libx264); add a probed NVENC arm with spec-valid levels
like VAAPI; same quarantine model.
**Done when:** recording-matrix passes with NVENC on an NVIDIA box (D7);
without NVIDIA, the probe falls through to VAAPI/OpenH264 with a logged
reason.

### S7: separate record and stream encodes on VAAPI

**Owner route:** Implementation (fit 8). **Model lane:** `fable-5.1`.
**Goal:** the recording keeps its own quality while streaming, as on the Mac.
**Steps:** allow split encoded roles on Linux when two VAAPI sessions open
(`R/recording.rs:23249-23259`), falling back to one shared encode with the
existing copy.
**Done when:** a 1440p recording plus a 1080p stream on ogre (iHD) both meet
their profiles in the matrix; the fallback path is unit-tested.

### S8: desktop audio through PipeWire

**Owner route:** Implementation (fit 9). **Model lane:** `fable-5.1`.
**Goal:** game, browser and alert sound reach the stream and recording.
**Steps:**

1. Capture the default sink's monitor through the Pulse protocol (or
   PipeWire directly), following default-sink changes.
2. Exclude Videorc's own playback (soundboard, Sidekick voice, monitoring)
   by node/application properties, like SCK's own-app exclusion.
3. Device row "Desktop audio" on Linux; room system audio uses the same
   source (`R/room_system_audio.rs:211-214`).
   **Done when:** a smoke plays a tone through the default sink and finds it in
   the recording; a soundboard sound appears once, not twice; `pnpm
smoke:recording-studio` items that apply on Linux pass; A/V analysis in
   `pnpm test:scripts`.

### S9: change sources while recording or live; per-scene screens

**Owner route:** Implementation (fit 9). **Model lane:** `fable-5.1`.
**Goal:** the Sources page stops saying "change them while nothing is
recording or live".
**Steps:** mic replacement on the native Pulse worker, camera swap on the
V4L2 child, screen swap as a bounded portal restart that reuses the
scene's restore token; one restore token per scene screen so switching
scenes with different screens never re-asks.
**Done when:** mid-recording mic, camera and screen changes on ogre keep the
recording going with a gap ≤ 500 ms each in the analyzer; switching between
two scenes with two different screens shows both without a dialog after
the first grant.

### S10: live captions on Linux

**Owner route:** Implementation (fit 8). **Model lane:** `gpt-6.1-sol`.
**Goal:** captions work on Linux like on the Mac.
**Steps:** feed caption PCM from the Linux session audio bus (the native
worker exists now; the gate dates from when the mic went straight to
FFmpeg); remove `captionsPlatformUnavailableReason` for Linux.
**Done when:** `pnpm smoke:captions-contract` passes on ogre against the
fake gateway, and `pnpm smoke:captions-live` passes there (never a real
gateway).

### S11: global shortcuts through the GlobalShortcuts portal

**Owner route:** Implementation (fit 9). **Model lane:** `fable-5.1`.
**Goal:** scene hotkeys and the other global shortcuts fire on Wayland.
**Steps:**

1. Register the app id `videorc` with the portal host Registry
   (`org.freedesktop.host.portal.Registry.Register`, xdg-desktop-portal ≥
   1.19), using the managed `videorc.desktop`.
2. Create a GlobalShortcuts session (backend via `ashpd`, or main), bind
   the shortcut list with their descriptions and preferred triggers, and map
   `Activated` signals to the existing intents.
3. Shortcuts settings: when the portal owns the keys, show the trigger the
   desktop assigned and "Change in your desktop's settings"; when no portal
   implements it (GNOME 46), keep today's reason and point to Phone remote
   and Stream Deck.
   **Done when:** on ogre (xdph) a scene hotkey switches scenes while another
   app has focus; the X11 path keeps `globalShortcut`; unit tests for the mapping; `pnpm
smoke:remote-control` still passes. The GNOME 48+ / KDE 6 check moves to
   S21's second-box pass (blocked on D2).

### S12: Wayland window behaviours

**Owner route:** UI/Product Design (fit 8). **Model lane:** `opus-5.5`.
Read `.claude/skills/videorc-design/SKILL.md` first.
**Goal:** what Wayland can't do is said plainly, and Hyprland users get the
native equivalent.
**Steps:** on Hyprland, offer to add `noscreenshare` and `pin` rules for
Videorc's Stream Manager, Notes and Captions windows (D8); elsewhere the Hide
from stream switch explains and suggests window capture; Keep on top on
Wayland says when the compositor ignores it; the screen-swap tap explains.
**Done when:** component tests for each state; both themes checked by eye;
on ogre with the rule added, the Stream Manager is absent from a screen
recording.

### S13: talk-show rooms from Linux

**Owner route:** Implementation (fit 8). **Model lane:** `fable-5.1`.
**Goal:** a Linux host can share the screen and desktop audio to guests.
**Steps:** map portal screen sources for the room (Chromium's
`getDisplayMedia` uses the portal on Wayland, or publish the backend's
portal stream), room system audio from S8.
**Done when:** the cloud talk-show smoke runs on ogre with a fake guest
receiving the screen track and the desktop audio track.

### S14: cloud shows and handoff on Linux, verified

**Owner route:** Diagnose → Implementation (fit 7). **Model lane:** `gpt-6.1-sol`.
**Goal:** cloud shows, handoff, Sidekick voice, avatar, markers and Clips are
run once on Linux and fixed where they break.
**Done when:** the existing cloud and Sidekick smokes that run on the Mac
also pass on ogre, or each failure has its own issue and fix.

### S15: separate source (ISO) recordings on Linux

**Owner route:** Implementation (fit 8). **Model lane:** `fable-5.1`.
**Done when:** the Output switch is available on Linux; a recording yields
Combined, Screen (with desktop audio) and Camera (with mic) files that pass
the analyzer on ogre; the recording-matrix passes.

### S16: Videorc Camera proven and shown

**Owner route:** Implementation (fit 8). **Model lane:** `gpt-6.1-sol`.
**Goal:** spike P0c passes on two boxes and `PROVEN` flips to true.
**Steps:** owner installs `v4l2loopback-dkms` on ogre (sudo); run the
`docs/linux-dev-loop.md:247-323` spike; Secure Boot guidance on Ubuntu.
**Done when:** Videorc Camera shows in a browser call on ogre; Load module,
unload and the missing-module copy are tested. The Ubuntu/Secure Boot check
moves to S21's second-box pass (blocked on D2).

### S17: first-run onboarding for Linux

**Owner route:** UI/Product Design (fit 8). **Model lane:** `opus-5.5`.
**Goal:** a new Linux user is walked through what Linux needs.
**Steps:** stop hiding first-run on Linux (`UI/lib/first-run.ts:84`); steps:
screen (what the portal will ask), groups (`video`, `render`), Secret
Service (from S18), destinations, optional Videorc Camera.
**Done when:** component tests for the Linux step list; screenshots of each
step in both themes; the unreachable Linux copy in `permissions-step.tsx` is
used or removed.

### S18: Secret Service, groups and portal preflight

**Owner route:** Implementation (fit 8). **Model lane:** `gpt-6.1-sol`.
**Goal:** sign-in never fails silently on a desktop without a keyring.
**Done when:** with no Secret Service on the bus, Destinations and Health
say what to install before any sign-in starts; missing `video`/`render`
membership and a missing portal backend each have a Health row; unit tests.

### S19: AppImage self-update and the Linux feed

**Owner route:** Implementation (fit 9). **Model lane:** `fable-5.1`.
Publishing is a human gate (`.agents/skills/videorc-release/SKILL.md`).
**Steps:** publish `latest-linux.yml` + blockmap per release (release
workflow and storage); enable electron-updater for AppImage installs
(`APPIMAGE` env present, writable path), with the Mac's hold-while-recording
rules; keep the notice for extracted installs; detached signature per D5;
a `promote-linux` workflow mirroring Windows candidate → pilot → public.
**Done when:** on ogre an installed previous build updates to a pilot build
through a staging feed, held while recording, and rolls back; `--build
release` in the lab stops answering `linux-feed-unavailable`.

### S20: Linux acceptance checklist, record schema, validator

**Owner route:** Docs (fit 8). **Model lane:** `gpt-6.1-sol`.
**Done when:** `docs/acceptance/linux-physical-acceptance-checklist.md`,
its private template and a public JSON template exist with the gates above;
`scripts/lib/linux-acceptance-record.mjs` validates records (and the waiver
form) in `pnpm test:scripts`.

### S21: feature sweep on both boxes

**Owner route:** Review (fit 9). **Model lane:** `fable-5.1`.
**Goal:** rerun this audit's matrix on an unlocked, quiet ogre and the
Ubuntu box after S1–S19, and turn every W\* into W or a bug.
**Done when:** the matrix in this plan is updated with a dated column per
box, with screenshots of every area from the real Wayland window. The ogre
half can run as soon as S1–S19 land; the second-box half is **blocked on
D2** and also carries the checks moved here from S5 (AMD VAAPI), S11 (GNOME
48+ / KDE 6 portal) and S16 (Ubuntu, Secure Boot).

### S22: physical acceptance and the Beta flip

**Owner route:** Release (human gate).
**Blocked on:** D2 (owner-owed): the second box must exist first.
**Done when:** both Tier 1 boxes pass the checklist with no waiver (D11);
the record is committed; `release-track.ts` says Beta on Linux; the release
skill publishes a Linux Beta.

## Owner decisions

The owner took the recommended defaults on 2026-11-21. D2 needs a purchase.

- **D1. Supported desktops. DECIDED (recommended default).** Tier 1 =
  Ubuntu 24.04 GNOME Wayland, Arch/Omarchy Hyprland (ogre), Fedora KDE
  Plasma 6 Wayland; X11 and other wlroots are best effort.
- **D2. A second named Linux box. OWNER-OWED.** Recommended: one Ubuntu
  24.04 machine with an Intel or AMD GPU that works (ogre's AMD is
  quarantined), as a second named tester. It needs the owner's purchase.
  Until it exists, S21's second-box half and all of S22 are blocked, and
  AMD VAAPI, GNOME, KDE's GlobalShortcuts portal and Ubuntu's Secure Boot
  path can't be accepted.
- **D3. Formats. DECIDED (recommended default).** AppImage only for Beta;
  `.deb` and Flatpak after.
- **D4. Self-update. DECIDED (recommended default).** electron-updater
  AppImage updates from a published `latest-linux.yml`; the changelog notice
  stays for extracted installs.
- **D5. Integrity. DECIDED (recommended default).** sha512 feed over HTTPS
  plus a detached signature (minisign or GPG) and `.sha256` per release.
- **D6. GPU compositor. DECIDED (recommended default).** Not in Beta; the
  CPU compositor stays if S1 and S3 meet their budgets. A GLES compositor is
  a 1.0 plan.
- **D7. NVENC in Beta. DECIDED (recommended default).** Yes if someone can
  lend an NVIDIA box for acceptance; otherwise right after Beta. S6 builds
  the arm either way; only its NVIDIA check waits for such a box.
- **D8. Hide from capture on Hyprland. DECIDED (recommended default).**
  Videorc offers (never silently writes) the `noscreenshare`/`pin` rules for
  its own windows.
- **D9. Global shortcuts UX. DECIDED (recommended default).** On portal
  desktops the desktop owns the key choice (its own dialog); Videorc shows
  what was assigned.
- **D10. arm64. DECIDED (recommended default).** Not in Beta.
- **D11. Beta gate. DECIDED (recommended default).** Physical acceptance on
  both Tier 1 boxes, no owner waiver.
- **D12. Lab under a locked session. DECIDED (recommended default).** The
  lab refuses to run while the session is locked (S0); attended runs need
  the owner to unlock at the console.

## Sources

- Code surveys of `origin/main` `6f29ff59e` (Rust: `crates/`; Electron:
  `apps/desktop/src`), file:line refs in the matrix.
- ogre spot check 2026-11-21 20:15–21:45 CET:
  `~/logs/linux-beta-audit/` (launch script, CDP drivers, `run/app.log`,
  page text, recordings) and screenshots
  `~/.local/share/ghostex/i/videorc-linux-beta-audit-*.png`.
- Lab run `~/videorc-live-lab/runs/2026-11-21-golive-short-08f1c2/`.
- `docs/linux-port-plan.md`, `docs/linux-dev-loop.md`,
  `docs/live-lab-machine.md`, `docs/distribution.md`,
  `docs/acceptance/windows-physical-acceptance-checklist.md`,
  `docs/acceptance/linux-alpha/0.36.0-alpha.1.json`, plans 052, 053, 069,
  179, 181, 184, 190, 194, 214, 215.
