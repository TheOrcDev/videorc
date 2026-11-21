# Linux physical acceptance checklist

A step-by-step checklist for one physical acceptance pass of a Linux Beta
candidate AppImage on one physical Tier 1 Linux x64 box. It turns plan 257's
"Physical acceptance" section into numbered steps with the same shape as the
[Windows checklist](windows-physical-acceptance-checklist.md), each tagged
with the file it comes from (Sources, at the end).

This checklist adds no gate and loosens none. Where it and a source file
disagree, the source file wins. Steps marked **(inferred)** are where the repo
gives no exact method; steps marked **(needs Sn)** test behaviour that plan
257 slice Sn delivers, and are BLOCKED until it lands. The open questions at
the end list what the release owner still has to decide.

Record every verdict as PASS, FAIL or BLOCKED in a dated private copy of the
[acceptance template](linux-app-acceptance-template.md) (step 1.9). Never
commit raw evidence.

## Before you start: what one pass can and can't prove

- **One pass is one box.** A Linux Beta needs a PASS on **at least two
  physical boxes on different Tier 1 desktops, one of them Ubuntu 24.04
  GNOME** (`ubuntu-24.04-gnome-wayland`), with every gate PASS on each, and
  **no owner waiver** (D11). The validator refuses a waived Beta record and
  one without the Ubuntu box. Today that is ogre (Arch/Omarchy, Hyprland)
  plus an Ubuntu 24.04 GNOME box that does not exist yet (D2, owner-owed).
  [S1, S3]
- **Tier 1 desktops (D1):** Ubuntu 24.04 LTS GNOME 46+ Wayland
  (`ubuntu-24.04-gnome-wayland`), Arch-family Hyprland 0.5x Wayland
  (`arch-hyprland-wayland`), Fedora 41+ KDE Plasma 6 Wayland
  (`fedora-kde-plasma-6-wayland`). X11, other wlroots, VMs and arm64 never
  count. [S1]
- **Candidate:** the exact AppImage, source commit and release ID
  (`<x.y.z>-beta.N`) the release owner names. The record is immutable: a
  rebuilt AppImage is a new candidate and a new pass. [S3]
- **Release sequence:** the first Linux Beta is `first-public-beta`; every
  later one names the immediately preceding accepted Beta. `betaToBetaUpdate`
  is PASS in both cases; the first Beta updates from the newest Linux Alpha
  that updates itself. [S3]
- **Lab budget:** going live from ogre costs one of the lab's 8 runs a day.
  Plan Phase 6 so all four platforms go live on as few runs as possible. [S6]
- **No real accounts on a lab box** beyond the lab's own channel accounts;
  isolated profiles only. [S6]
- **Who does what:** the release owner supplies the candidate identity,
  candidate download and any pilot feed, and alone commits the public record.
  The operator runs every step below on the box. [S3, S11]

## Phase 1: Machine

- [ ] 1.1 Physical x64 box, not a VM, on a Tier 1 desktop in a **Wayland**
      session (`echo $XDG_SESSION_TYPE` prints `wayland`). Record make, CPU,
      RAM, GPU and driver privately. [S1]
- [ ] 1.2 Versions, privately: distro and release (`/etc/os-release`),
      kernel (`uname -r`), desktop and version, PipeWire (`pipewire --version`,
      at least 1.0, with `pipewire-pulse` running), xdg-desktop-portal (at
      least 1.18) and its desktop backend, Mesa / VAAPI driver (`vainfo`).
      [S1]
- [ ] 1.3 A Secret Service answers on the session bus (gnome-keyring or
      KWallet): `busctl --user list | grep org.freedesktop.secrets`. [S1]
- [ ] 1.4 The user is in `video` and `render` (`id -nG`). [S1]
- [ ] 1.5 Attach a webcam (built-in and, for 4.4, a USB one) and a physical
      microphone (built-in and USB). No physical mic means BLOCKED, never a
      synthetic tone. One display at a known resolution and scale. [S1, S2]
- [ ] 1.6 Clean state: no `~/.config/Videorc`, no
      `~/.local/share/applications/videorc.desktop`, no Videorc process, no
      earlier AppImage on the box. **(inferred** definition of clean**)**
      [S8]
- [ ] 1.7 Ubuntu only: note whether Secure Boot is on (`mokutil --sb-state`),
      for the module in Phase 8. [S1, S5]
- [ ] 1.8 A source checkout of the exact candidate commit with `pnpm install`
      done, for the smokes in Phases 5 and 9. [S7]
- [ ] 1.9 Copy [linux-app-acceptance-template.md](linux-app-acceptance-template.md)
      to a dated private record, with evidence outside the checkout. Fill
      Scope and Machine. [S2]

Evidence: Scope and Machine sections of the dated record.

## Phase 2: Fetch and verify the exact candidate

- [ ] 2.1 Get the AppImage and its `.sha256` from the release owner. Check
      the SHA-256 and byte size against the candidate's `release.json`. [S3,
      S11]

```bash
sha256sum Videorc-<x.y.z>-linux-x64.AppImage
stat -c %s Videorc-<x.y.z>-linux-x64.AppImage
```

- [ ] 2.2 The detached signature verifies against the published Videorc key
      (minisign or GPG, per D5). No signature, a bad one or another key is an
      automatic FAIL. **(needs S19)** [S1]
- [ ] 2.3 `chmod +x` and run it. It starts without installing `libfuse2`
      (static type2 runtime). [S4]
- [ ] 2.4 Sandbox path: on Ubuntu 24.04 (AppArmor refuses unprivileged user
      namespaces) the running app's command line carries `--no-sandbox`; on a
      desktop where `unshare -Ur true` succeeds it does not. Check with
      `ps -C videorc -o pid,args` and write the probe result down.
      **(inferred:** AppRun logs nothing, so the command line is the
      evidence**)** [S4]

Evidence: Candidate Identity and Integrity section. Gate:
`artifactSignature`.

## Phase 3: Clean install and first launch

- [ ] 3.1 First launch on the clean profile: the backend reports ready and
      the main window opens. [S2]
- [ ] 3.2 First-run onboarding shows the Linux steps: what the portal will
      ask, `video`/`render` groups, Secret Service, destinations, optional
      Videorc Camera. **(needs S17)** [S1]
- [ ] 3.3 `~/.local/share/applications/videorc.desktop` exists and points at
      this AppImage; `xdg-mime query default x-scheme-handler/videorc` prints
      `videorc.desktop`. [S8]
- [ ] 3.4 Protocol sign-in: sign in to YouTube from the app; the browser
      returns through `videorc://` to this app and the identity shows. Keep
      callback URLs and tokens out of evidence. [S1, S2]
- [ ] 3.5 Without a Secret Service (stop it, or a fresh session without it),
      Destinations and Health say what to install before any sign-in starts.
      Restore it after. **(needs S18)** [S1]
- [ ] 3.6 Pick the screen: the desktop's own portal dialog appears, you grant
      it, and the preview shows the screen. [S1]
- [ ] 3.7 Quit fully and relaunch: the screen comes back **without** the
      portal dialog (restore token reused). Revoke the grant in the desktop's
      settings, relaunch: the app asks again once, then works. [S1]

Evidence: Install and First Launch section. Gates: `cleanInstall`,
`protocolSignIn`, `portalScreenGrant`, `restoreToken`.

## Phase 4: Sources

- [ ] 4.1 Screen: whole screen and a single window (`Window (portal)`) each
      capture. [S1]
- [ ] 4.2 Camera: built-in and USB each preview at the device's own format,
      without the CPU upscale seen in the audit (note the app's CPU share
      privately). **(needs S2)** [S1]
- [ ] 4.3 Camera hotplug: plug the USB camera in after launch; it appears
      without a restart. Unplug it: the selection reconciles. **(needs S2)**
      [S1]
- [ ] 4.4 Microphone: built-in and USB each show a moving level. [S1]
- [ ] 4.5 Desktop audio: the system audio row is available and moves with a
      browser playing sound; Videorc's own playback is not captured. **(needs
      S8)** [S1]
- [ ] 4.6 While recording, change the mic, the camera and the screen, one at
      a time: each changes in place, no stop, and the file keeps going. Repeat
      once while live (Phase 6). **(needs S9)** [S1]

Evidence: Sources section. Gate: `liveSourceChange` (4.6).

## Phase 5: Recordings

- [ ] 5.1 Record about 30 s each: screen only, camera only, screen + camera +
      mic, and screen + desktop audio. Each stops cleanly (no "FFmpeg did not
      finish after Stop", no recovery), shows in Library and plays back.
      **(inferred** clip length**)** [S1, S2]
- [ ] 5.2 Repeat screen + camera + mic at 1080p30 and 1080p60. [S1]
- [ ] 5.3 Separate source files: one take with ISO files on; every file
      exists and plays. **(needs S15)** [S1]
- [ ] 5.4 Clips: with Clips on, save a clip; it plays. [S1]
- [ ] 5.5 Run every file through the analyzer, never file size alone. Pass:
      exit 0, the expected fps, audio present with no silent gap where sound
      was made, A/V skew inside the gate, colour tags present. [S1, S10]

```bash
pnpm analyze:recording <file> --fps 30 --expect-audio
```

- [ ] 5.6 From the source checkout, on the box:
      `pnpm smoke:recording-matrix` and `pnpm smoke:record-latency:gate`.
      Record PASS, FAIL or BLOCKED and the report paths. [S1, S7]

Evidence: Recordings section. Gates: `screenOnlyRecording`,
`cameraOnlyRecording`, `screenCameraMicrophoneRecording`,
`desktopAudioRecording`.

## Phase 6: Live

Through the live lab where possible (plan 179), with the picture checked in
each platform's player, not only "went live". [S1, S6]

- [ ] 6.1 YouTube, Twitch, Kick and X: sign in, go live, chat both ways (a
      message from the platform shows in Videorc, one sent from Videorc shows
      on the platform), stop. The picture and sound on each platform match
      the scene. [S1]
- [ ] 6.2 Live captions on while live: the caption text follows speech into
      the stream. **(needs S10)** [S1]
- [ ] 6.3 Scene hotkey: with another app focused, press a scene hotkey; the
      scene switches. On a desktop with the GlobalShortcuts portal (Hyprland,
      KDE 6, GNOME 48+) the desktop's own bind dialog assigned it and Videorc
      shows the assignment (D9). On GNOME 46 (Ubuntu 24.04), which has no
      such portal, PASS means Videorc clearly says global shortcuts need a
      newer desktop and points to Phone remote and Stream Deck; Phone remote
      then switches the scene (6.4). GNOME 48+ is not required. **(needs
      S11)** [S1]
- [ ] 6.4 Stream Manager opens and shows chat and activity; phone remote
      pairs and switches a scene. [S1]
- [ ] 6.5 Change one source while live (step 4.6). [S1]

Evidence: Live section. Gates: `allFourPlatformsLive`, `liveCaptions`,
`globalShortcuts`.

## Phase 7: Talk show

- [ ] 7.1 Join a room, share the screen; a guest on another machine sees
      it. **(needs S13)** [S1]
- [ ] 7.2 The guest hears desktop audio from this box. **(needs S13)** [S1]

Evidence: Talk Show section. Gate: `talkShowScreenShare`.

## Phase 8: Virtual camera

- [ ] 8.1 Load v4l2loopback the way the app's Output page says for this
      distro (on Ubuntu with Secure Boot on, follow its signed-module
      guidance). **(needs S16)** [S1, S5]
- [ ] 8.2 Turn on Videorc Camera, use it in a browser video call; the scene
      shows at 30 fps. Run `pnpm smoke:virtual-camera -- <path to videorc>`
      from the source checkout. **(needs S16)** [S5, S7]
- [ ] 8.3 Turn it off and unload the module; nothing is left behind. [S1]

Evidence: Virtual Camera section. Gate: `virtualCamera`.

## Phase 9: Encoders

- [ ] 9.1 VAAPI: the app selects VAAPI on its own (no encoder override) and
      a 1080p30 take passes the analyzer; step 9.4's evidence names the
      backend and render node. Never probe a render node the box has
      quarantined. **(needs S5)** [S1, S7]
- [ ] 9.2 OpenH264 fallback: with VAAPI off (`VIDEORC_LINUX_H264_ENCODER=openh264`
      in the launch environment), a 1080p30 take passes the analyzer. [S5]
- [ ] 9.3 NVENC, only if the box has an NVIDIA GPU: the app selects
      `h264_nvenc` and a take passes. Not a gate (D7). **(needs S6)** [S1]
- [ ] 9.4 The named-box encoder acceptance from the source checkout. Keep
      `linux-encoder-acceptance.json` with the private evidence. [S5, S7]

```bash
VIDEORC_LINUX_TESTER_NAME="<person>" \
VIDEORC_LINUX_TESTER_MACHINE="<specific box>" \
VIDEORC_LINUX_PHYSICAL_HARDWARE=1 \
pnpm smoke:linux-encoder-acceptance
```

Evidence: Encoders section. Gates: `vaapiPath`, `softwareFallbackPath`.

## Phase 10: Update

- [ ] 10.1 Install the previous Linux Beta (for the first Beta: the newest
      Linux Alpha that updates itself) and point it at the pilot feed the
      release owner gives you. **(needs S19)** [S1]
- [ ] 10.2 Settings > About & updates: check, then download. Pass: the
      candidate version is offered and downloads. **(needs S19)** [S1]
- [ ] 10.3 Start a recording, then try Restart to update. Pass: it waits
      while recording or live. **(needs S19)** [S1]
- [ ] 10.4 Stop, go idle, Restart to update. Pass: the relaunched app shows
      the candidate version, and a short screen + camera + mic take passes
      the analyzer. **(needs S19)** [S1]
- [ ] 10.5 Rollback is forward-only, as on Windows: installed apps are
      never downgraded, and a bad release is fixed by a higher version. On
      the updated candidate, with the feed serving the previous release,
      check for updates. Pass: the previous release is not offered as a
      downgrade. **(needs S19; inferred** method, mirrors Windows step 7.3**)**
      [S1, S9]

Evidence: Update section. Gate: `betaToBetaUpdate`.

## Phase 11: Support bundle and cleanup

- [ ] 11.1 Export a support bundle from Settings and verify it. Keep the
      bundle private and record only the verdict. **(inferred:** the verifier
      has a Windows profile and no Linux one yet**)** [S2]

```bash
pnpm support-bundle:verify <bundle.json>
```

- [ ] 11.2 Quit Videorc. No `videorc`, `videorc-backend` or `ffmpeg`
      process the app started remains (`ps -C videorc,videorc-backend,ffmpeg`).
      Force-close once while idle (`kill <main pid>`): no owned child
      survives. [S1]
- [ ] 11.3 Remove the AppImage, `~/.local/share/applications/videorc.desktop`
      and its icon, and the isolated profile. `xdg-mime` no longer resolves
      `videorc://` to it. Recordings stay. [S1, S8]
- [ ] 11.4 Move evidence to private storage. `git status` in the checkout
      shows nothing new. [S2]

Evidence: Support Bundle and Cleanup sections. Gates:
`supportBundleRedaction`, `ownedProcessCleanup`.

## Recording results

Write every verdict in the dated private record from step 1.9. The public
JSON at `docs/acceptance/linux-beta/<releaseId>.json` comes later, only when
**every gate is PASS on at least two boxes on different Tier 1 desktops**,
and only the release owner commits it, from
[linux-beta-acceptance-record.template.json](linux-beta-acceptance-record.template.json)
under the [record contract](linux-beta-acceptance-record.md). There is no
waiver form for a Beta. [S3]

| Gate in the JSON record           | Checklist steps | Lands with |
| --------------------------------- | --------------- | ---------- |
| `cleanInstall`                    | 3.1 to 3.3      | S17        |
| `protocolSignIn`                  | 3.4, 3.5        | S18        |
| `portalScreenGrant`               | 3.6             | today      |
| `restoreToken`                    | 3.7             | today      |
| `screenOnlyRecording`             | 5.1, 5.5, 5.6   | S1         |
| `cameraOnlyRecording`             | 4.2, 5.1, 5.5   | S1, S2     |
| `screenCameraMicrophoneRecording` | 5.1, 5.2, 5.5   | S1         |
| `desktopAudioRecording`           | 4.5, 5.1, 5.5   | S8         |
| `liveSourceChange`                | 4.6, 6.5        | S9         |
| `vaapiPath`                       | 9.1, 9.4        | S5         |
| `softwareFallbackPath`            | 9.2, 9.4        | today      |
| `globalShortcuts`                 | 6.3             | S11        |
| `liveCaptions`                    | 6.2             | S10        |
| `allFourPlatformsLive`            | 6.1, 6.4        | today      |
| `talkShowScreenShare`             | 7.1, 7.2        | S13        |
| `virtualCamera`                   | 8.1 to 8.3      | S16        |
| `betaToBetaUpdate`                | 10.1 to 10.5    | S19        |
| `ownedProcessCleanup`             | 11.2            | today      |
| `supportBundleRedaction`          | 11.1            | today      |
| `artifactSignature`               | 2.1, 2.2        | S19        |

"Today" means the behaviour exists on `main` now; it still needs its PASS on
the box. Steps 3.2, 4.2–4.4 and 5.3–5.4 have no gate of their own but sit
under the gate beside them: a FAIL there fails that gate. [S1]

## Open questions for the release owner

The release owner took the recommended defaults on 2026-11-22.

- [x] **`globalShortcuts` on GNOME 46 (Ubuntu 24.04). DECIDED:** the gate
      PASSes there when Videorc clearly says global shortcuts need a newer
      desktop and points to Phone remote and Stream Deck. No GNOME 48+
      requirement: 24.04 is the LTS most users run. Step 6.3.
- [x] **Which two boxes. DECIDED:** one of the Beta boxes must be Ubuntu
      24.04 GNOME (`ubuntu-24.04-gnome-wayland`), the other a different Tier
      1 desktop. The validator enforces it (`acceptance-ubuntu-box-missing`).
- [x] **Signature tool for `artifactSignature`. DECIDED:** left to S19 (D5:
      minisign or GPG). Step 2.2 keeps its wording until S19 lands.
- [x] **Rollback. DECIDED:** matches Windows: forward-only, and the update
      feed must refuse a downgrade. Step 10.5.

## Sources

| Ref | File                                                                                                                                                                                               | Used for                                                                              |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| S1  | [plans/257-linux-beta.md](../../plans/257-linux-beta.md)                                                                                                                                           | Beta definition, Tier 1 (D1), phases, gates, D5, D7, D9, D11, slices                  |
| S2  | [docs/acceptance/linux-app-acceptance-template.md](linux-app-acceptance-template.md)                                                                                                               | Private evidence rows                                                                 |
| S3  | [docs/acceptance/linux-beta-acceptance-record.md](linux-beta-acceptance-record.md), its template JSON and [scripts/lib/linux-acceptance-record.mjs](../../scripts/lib/linux-acceptance-record.mjs) | Public record contract, two-box rule, no waiver, release chain                        |
| S4  | [docs/distribution.md](../distribution.md) "Current Linux Alpha Target"                                                                                                                            | Static type2 runtime, AppRun `--no-sandbox` probe                                     |
| S5  | [docs/linux-dev-loop.md](../linux-dev-loop.md)                                                                                                                                                     | Encoder acceptance env, v4l2loopback install                                          |
| S6  | [docs/live-lab.md](../live-lab.md) and [docs/live-lab-machine.md](../live-lab-machine.md) "Linux lab machine"                                                                                      | Lab runs, run budget, isolated profiles                                               |
| S7  | [AGENTS.md](../../AGENTS.md)                                                                                                                                                                       | Recording matrix, record-latency gate, `smoke:virtual-camera`, render-node quarantine |
| S8  | [apps/desktop/src/main/linux-desktop-entry.ts](../../apps/desktop/src/main/linux-desktop-entry.ts)                                                                                                 | `videorc.desktop` path and `videorc://` registration                                  |
| S9  | [docs/acceptance/windows-physical-acceptance-checklist.md](windows-physical-acceptance-checklist.md)                                                                                               | Shape of this checklist                                                               |
| S10 | [scripts/analyze-recording.mjs](../../scripts/analyze-recording.mjs)                                                                                                                               | Recording analyzer                                                                    |
| S11 | [docs/releases/release-runbook.md](../releases/release-runbook.md) "Linux Alpha Is A Separate Candidate-Only Track"                                                                                | Candidate storage, release owner's role                                               |
