# Plan 179: The live lab on Linux. The plan 178 lab runs unattended on ogre (Omarchy, Hyprland) with the same safety guarantees

## Status

- **Priority**: P2. The owner wants to stream to @VideorcApp from the Linux box
  `ogre` too; the plan 178 harness was macOS-only (BetterDisplay, BlackHole,
  pf/dnctl, launchd, `/Library` policy, codesign).
- **Executed**: 2026-10-12 on `feat/live-lab-linux`, all code built and
  offline-tested (scripts suite green on macOS and with `process.platform`
  forced to linux; no new failures with it forced to win32). Nothing has run
  on ogre yet: the Mac's SSH key is not authorized there.
- **Depends on**: plan 178 (merged as #684), the owner's visit to ogre
  (`docs/live-lab-machine.md`, "Linux lab machine", L1-L8).
- **macOS**: unchanged. Every platform choice takes `platform` (default
  `process.platform`) or reads the app layout; the macOS tests pin `darwin`.

## Decisions

1. **Lab display = Hyprland headless output, not Xvfb.** Linux Videorc captures
   only through the ScreenCast portal (`linux_portal_capture.rs`: no x11grab,
   no output enumeration), so the display must be a compositor output.
2. **No portal restore token is ever reused.** A token is opaque and could
   point at the real desktop. Each run deletes
   `<lab profile>/app-data/linux-portal/restore-tokens.json` and writes the lab
   output's name to `~/videorc-live-lab/portal-pick`; xdph's
   `custom_picker_binary` (`config/live-lab/linux/videorc-lab-share-picker`)
   answers with exactly that output while the file exists and defers to
   `hyprland-share-picker` otherwise. Teardown removes the file.
3. **Lab mic = remap source over a null sink.** Videorc hides `.monitor`
   sources, so `videorc_lab_mic` is a `module-remap-source` over
   `videorc_lab_speech.monitor`. Linux Videorc has no system-audio capture, so
   the card's click goes into the same sink (`PULSE_SINK` on Chrome).
4. **Network faults = one root-owned helper with four fixed verbs**
   (`/usr/local/sbin/videorc-lab-netfault loss|throttle|clear|status`): nft
   marks TCP 443/1935 to the resolved ingest hosts, a tc `prio` root `2178:`
   sends only marked packets to a netem band. sudoers lists the four lines
   (unit-tested both ways), never `nft`/`tc`. Timer, detached watchdog and
   read-back as on macOS; the doctor FAILs a helper the lab user can write.
5. **Policy at `/etc/videorc-lab/policy.json`**, same ownership rules; new
   optional `labUser` key (default `videorc-lab`) names the account the
   schedule installs for.
6. **Builds**: extracted AppImage dir (no FUSE), `file:` (hash from
   `--sha256`, `.sha256` sidecar or `release.json`) or `local:` (built on the
   box). `release` is refused while `latest-linux.yml` 404s; `candidate:` is
   refused (no Linux lab-candidate workflow). Linux builds are unsigned, so
   `file` and `local-build` count as `candidate` for `allowedBuilds`.
7. **Schedule = systemd user timer** (`OnStartupSec=60`, `OnUnitActiveSec=300`,
   `KillMode=mixed`, `TimeoutStopSec=90`); weekly reboot = a root system timer.
8. **Doctor (Linux)**: desktop session, lab display, screen grant, lab audio,
   espeak-ng, chrome; machine: auto-login, linger, unattended boot (LUKS),
   screen lock (hypridle/hyprlock), sleep targets masked, notifications DND,
   lab user rights (FAIL on passwordless sudo), plus the shared policy,
   network faults, gh, kill switch, run lock, STOP file.

## Owed (on ogre, in order)

1. Owner: authorize the Mac's SSH key on ogre (or run the steps at the box).
2. Owner visit: `docs/live-lab-machine.md` L1-L6 (account, auto-login,
   linger, masked sleep, hypridle off, DND, packages, lab output, share
   picker, PipeWire devices, policy, `live:hookup --role` consent).
3. `pnpm live:doctor` on ogre: every Linux check PASS (or the expected WARNs),
   then break each on purpose (L6) and see it FAIL.
4. First grant: `pnpm live:install --build file:...` or `local:...`, then
   `pnpm live:run --scenario dry --trigger manual` (local sink, nothing leaves
   the box): the card lands fullscreen on `videorc-lab`, the picker answers
   without a dialog, the sink recording shows the card markers, speech plays.
5. Verify on real systemd/nft/tc (never run here): `systemd-analyze --user
   verify` of the rendered units; `sudo videorc-lab-netfault loss` then
   `status` then `clear` with a stream to the local sink and to YouTube
   (attended, owner's go).
6. Only with the owner's go: a first unattended YouTube run inside the policy.

## STOP conditions

- The share picker ever answers with an output other than the lab output, or
  a run captures anything but the card: stop, fix the picker, never rely on a
  token instead.
- `videorc-lab-netfault clear` leaves a table or a `2178:` qdisc behind, or
  shapes traffic other than the ingest hosts.
- The lab account can write `/etc/videorc-lab/policy.json` or the helper.
