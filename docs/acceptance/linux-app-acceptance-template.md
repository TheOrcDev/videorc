# Linux App Acceptance (Template)

Date: YYYY-MM-DD

Platform: PikaOS 4 (Debian Sid), GNOME Wayland, amd64

Version: 
Commit:
PR:

## 1) Artifact and command

- Repository: `https://github.com/oladapodev/videorc`
- Branch/Tag:
- Package: 
- Package path:
- Checksum:
- `build-info.json` path:
- `linux-capabilities.json` path:

Run from repo root:

```bash
ACCEPTANCE_DIR=docs/acceptance/artifacts/linux/YYYY-MM-DD
pnpm acceptance:linux:verify -- "$ACCEPTANCE_DIR/manifest.json"
```

## 2) Host environment

- Device: Dell Latitude E7240
- CPU: Intel i5-4310U
- GPU: Intel UHD 4400 / i915
- Drivers: VA-API i965
- DE/session: GNOME Wayland
- Display server/socket:

## 3) Gates checklist (all must pass)

### Core host/stack gates
- [ ] GNOME Wayland and session discovery
- [ ] XDG Portal session start and source pick available
- [ ] PipeWire service reachable
- [ ] Screen/window capture selected and started
- [ ] Webcam discovered and startable
- [ ] Microphone discovered and startable
- [ ] System audio capture probe and fallback behavior explained

### Preview and scene gates
- [ ] Preview remains live during session and recording
- [ ] Same committed scene revision drives preview + output
- [ ] Preview path and selected path are not silently different

### Encoding gates
- [ ] Recording and stream paths accept explicit policies separately
- [ ] Requested encoder != selected encoder and selected is reported if changed
- [ ] AV-sync test completes and is within tolerance

### Artifacts and cleanup
- [ ] Final recording artifact exists and ffprobe passes
- [ ] File size alone is not treated as a pass
- [ ] Requested vs selected vs observed implementation is recorded for every runtime path
- [ ] `ffprobe`/`ffmpeg` inspect report:
  - duration
  - frame count > 0
  - expected codec/profile
  - motion present (non-static baseline)
  - no major A/V drift
- [ ] Process cleanup evidence proves no stale ffmpeg/preview/backend processes
- [ ] Redaction evidence confirms no username/home/token/serial in uploaded artifacts

### Full feature smoke
- [ ] Imports/repair pipeline still works
- [ ] Clips + publishing smoke
- [ ] Noise Cleanup run
- [ ] Captions/comments pass acceptance path
- [ ] AI/media workflows run with the Linux profile
- [ ] Support bundle verifier passes for Linux acceptance

## 4) Test evidence paths

- Manifest: `docs/acceptance/artifacts/linux/YYYY-MM-DD/manifest.json`
- Support bundle: `docs/acceptance/artifacts/linux/YYYY-MM-DD/support-bundle.json`
- Recordings:
  - `docs/acceptance/artifacts/linux/YYYY-MM-DD/recording-*.mp4`
  - `docs/acceptance/artifacts/linux/YYYY-MM-DD/stream-*.mp4`
- Media analyzer output:
  - `docs/acceptance/artifacts/linux/YYYY-MM-DD/analyzer.json`
- Smoke logs:
  - `docs/acceptance/artifacts/linux/YYYY-MM-DD/smoke.log`
- Validation command logs:
  - `docs/acceptance/artifacts/linux/YYYY-MM-DD/acceptance-verify.log`
- Package check:
  - `docs/acceptance/artifacts/linux/YYYY-MM-DD/linux-artifacts-check.json`

## 5) Requested-selected-observed evidence table (one row per feature)

For each gate that can fallback or fail:

- Feature: e.g. `encoder`
- Requested: what UI/user/config requested
- Selected: what runtime actually used
- Observed: evidence artifact path or direct log snippet
- Fallback reason: explicit reason + next action if selected differs from requested

Keep this table inside the manifest for any failure.

## 6) Failure and fallback log

For each failed gate, add one line:

- Requested: `<feature>`
- Selected: `<actual>`
- Observed: `<runtime output>`
- Fallback reason: `<explicit reason + next remediation>`

### Example

- Requested: VA-API hardware encode
- Selected: software libx264
- Observed: `h264_vaapi` absent in VA path probe on first start
- Fallback reason: unsupported render node path; recorded in diagnostics and prompt to run hardware test again after system reboot

## 7) Update and rollback

- Last known-good Debian package:
- Install command:
  - `sudo dpkg -i <package>.deb`
- Rollback command:
  - `sudo apt install <previous-package>.deb` or restore previous version in `/opt` package cache
- Uninstall command (app only):
  - `sudo apt remove videorc`
- Data retention note:
  - App data: `~/.videorc` (keep/clean if needed)
- Rollback artifacts to keep:
  - previous package path
  - `linux-capabilities.json`
  - `build-info.json`
- Extra rollback path:
  - `docs/acceptance/artifacts/linux/<date>/` manifest + logs + analyzer output
