# YYYY-MM-DD Linux App Acceptance (<box>)

The private evidence template for one pass of the
[Linux physical acceptance checklist](linux-physical-acceptance-checklist.md)
on one physical Tier 1 box. Copy it to a dated file **outside the repo** and
fill it as you go. Keep recordings, screenshots, logs, support bundles, stream
keys, tokens and generated media out of git. Never paste a hostname, serial,
device ID, credential, presigned URL or support-bundle contents into anything
committed; the public record carries only the verdicts
([contract](linux-beta-acceptance-record.md)).

Every row is PASS / FAIL / BLOCKED, with the reason for FAIL or BLOCKED. A
gate is PASS only if every row under it is PASS.

## Scope

- Release ID (`<x.y.z>-beta.N`):
- Release sequence: first-public-beta / successor of `<immediately prior accepted Beta>`
- Source commit (40 characters):
- AppImage filename:
- AppImage SHA-256:
- AppImage size (bytes):
- Candidate `releasedAt` (exact UTC):
- Tier 1 desktop id: ubuntu-24.04-gnome-wayland / arch-hyprland-wayland / fedora-kde-plasma-6-wayland
- Operator:
- Evidence directory (private):
- Known hardware or permission blockers:

## Machine

- Make and model:
- CPU / RAM:
- GPU(s) and driver:
- Distro and release:
- Kernel:
- Desktop and version:
- Session type (`$XDG_SESSION_TYPE`):
- PipeWire version, pipewire-pulse running:
- xdg-desktop-portal version and backend:
- `vainfo` driver and profiles:
- Secret Service (`org.freedesktop.secrets` on the bus):
- Groups include `video` and `render`:
- Secure Boot (Ubuntu):
- Cameras (built-in, USB):
- Microphones (built-in, USB):
- Display resolution and scale:
- Clean state confirmed (no profile, desktop entry or earlier AppImage):

## Candidate Identity and Integrity

- SHA-256 matches `release.json`: PASS / FAIL / BLOCKED
- Byte size matches: PASS / FAIL / BLOCKED
- Detached signature verifies (tool, key fingerprint): PASS / FAIL / BLOCKED
- Starts without `libfuse2`: PASS / FAIL / BLOCKED
- `unshare -Ur true` result, and `--no-sandbox` on the command line matches it: PASS / FAIL / BLOCKED
- **`artifactSignature`:** PASS / FAIL / BLOCKED

## Install and First Launch

- First launch, backend ready: PASS / FAIL / BLOCKED
- Linux first-run steps shown (portal, groups, Secret Service, destinations, Videorc Camera): PASS / FAIL / BLOCKED
- `videorc.desktop` written, `xdg-mime` resolves `videorc://`: PASS / FAIL / BLOCKED
- **`cleanInstall`:** PASS / FAIL / BLOCKED
- Sign-in through `videorc://` returns to this app: PASS / FAIL / BLOCKED
- No Secret Service: Destinations and Health say what to install first: PASS / FAIL / BLOCKED
- **`protocolSignIn`:** PASS / FAIL / BLOCKED
- Portal dialog appears, grant shows the screen: PASS / FAIL / BLOCKED
- **`portalScreenGrant`:** PASS / FAIL / BLOCKED
- Relaunch reuses the grant without a dialog: PASS / FAIL / BLOCKED
- Revoked grant asks again once, then works: PASS / FAIL / BLOCKED
- **`restoreToken`:** PASS / FAIL / BLOCKED

## Sources

- Whole screen and single window capture: PASS / FAIL / BLOCKED
- Built-in camera, native format, CPU share noted: PASS / FAIL / BLOCKED
- USB camera, native format: PASS / FAIL / BLOCKED
- Camera hotplug in and out: PASS / FAIL / BLOCKED
- Built-in and USB microphone levels: PASS / FAIL / BLOCKED
- Desktop audio row available, own playback excluded: PASS / FAIL / BLOCKED
- Change mic, camera, screen while recording: PASS / FAIL / BLOCKED
- Change one source while live: PASS / FAIL / BLOCKED
- **`liveSourceChange`:** PASS / FAIL / BLOCKED

## Recordings

For each file: path (private), duration, fps, audio present, analyzer verdict.

- Screen only:
- Camera only:
- Screen + camera + mic 1080p30:
- Screen + camera + mic 1080p60:
- Screen + desktop audio:
- Separate source files:
- Clip:
- `pnpm smoke:recording-matrix`: PASS / FAIL / BLOCKED
- `pnpm smoke:record-latency:gate`: PASS / FAIL / BLOCKED
- **`screenOnlyRecording`:** PASS / FAIL / BLOCKED
- **`cameraOnlyRecording`:** PASS / FAIL / BLOCKED
- **`screenCameraMicrophoneRecording`:** PASS / FAIL / BLOCKED
- **`desktopAudioRecording`:** PASS / FAIL / BLOCKED

## Live

Lab run IDs (or by hand), and for each platform: went live, picture and
sound checked in the player, chat in, chat out.

- YouTube:
- Twitch:
- Kick:
- X:
- Stream Manager chat and activity: PASS / FAIL / BLOCKED
- Phone remote pairs and switches a scene: PASS / FAIL / BLOCKED
- **`allFourPlatformsLive`:** PASS / FAIL / BLOCKED
- Captions follow speech into the stream: PASS / FAIL / BLOCKED
- **`liveCaptions`:** PASS / FAIL / BLOCKED
- Scene hotkey from another focused app (how it was bound): PASS / FAIL / BLOCKED
- **`globalShortcuts`:** PASS / FAIL / BLOCKED

## Talk Show

- Guest sees the shared screen: PASS / FAIL / BLOCKED
- Guest hears desktop audio: PASS / FAIL / BLOCKED
- **`talkShowScreenShare`:** PASS / FAIL / BLOCKED

## Virtual Camera

- Module loaded as the Output page says (Secure Boot path, if any): PASS / FAIL / BLOCKED
- Browser call shows the scene at 30 fps: PASS / FAIL / BLOCKED
- `pnpm smoke:virtual-camera`: PASS / FAIL / BLOCKED
- Off and unloaded, nothing left: PASS / FAIL / BLOCKED
- **`virtualCamera`:** PASS / FAIL / BLOCKED

## Encoders

- VAAPI selected without an override, 1080p30 take passes: PASS / FAIL / BLOCKED
- **`vaapiPath`:** PASS / FAIL / BLOCKED
- OpenH264 forced, 1080p30 take passes: PASS / FAIL / BLOCKED
- **`softwareFallbackPath`:** PASS / FAIL / BLOCKED
- NVENC (only on an NVIDIA box, not a gate):
- `pnpm smoke:linux-encoder-acceptance` (evidence file kept privately): PASS / FAIL / BLOCKED

## Update

- From (previous Beta, or newest self-updating Alpha):
- Candidate offered and downloaded: PASS / FAIL / BLOCKED
- Held while recording or live: PASS / FAIL / BLOCKED
- Restart to update shows the candidate version: PASS / FAIL / BLOCKED
- Short take on the updated app passes the analyzer: PASS / FAIL / BLOCKED
- Previous AppImage starts again on the same profile (rollback): PASS / FAIL / BLOCKED
- **`betaToBetaUpdate`:** PASS / FAIL / BLOCKED

## Support Bundle

- Bundle exported and `pnpm support-bundle:verify` passes (bundle kept private): PASS / FAIL / BLOCKED
- **`supportBundleRedaction`:** PASS / FAIL / BLOCKED

## Cleanup

- After Quit, no owned `videorc`, `videorc-backend` or `ffmpeg` process: PASS / FAIL / BLOCKED
- After a force-close while idle, no owned child survives: PASS / FAIL / BLOCKED
- **`ownedProcessCleanup`:** PASS / FAIL / BLOCKED
- AppImage, desktop entry, icon and profile removed; recordings kept: PASS / FAIL / BLOCKED
- `git status` in the checkout shows nothing new: PASS / FAIL / BLOCKED

## Verdict

- Box result: PASS (all 20 gates) / FAIL / BLOCKED
- Box `testedAt` (canonical UTC, for the public record):
- Failures and follow-up (issue or PR links):
- Owner decisions needed:
