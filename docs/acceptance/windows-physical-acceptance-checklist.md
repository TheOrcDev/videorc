# Windows physical acceptance checklist

A step-by-step checklist for one physical acceptance pass of a Windows Alpha
candidate on one clean Windows 11 x64 machine. It turns section 3 of the
[Windows Alpha runbook](../releases/windows-alpha-runbook.md) and the
[acceptance template](windows-app-acceptance-template.md) into numbered steps,
each tagged with the file it comes from (Sources, at the end).

This checklist adds no gate and loosens none. Where it and a source file
disagree, the source file wins. Steps marked **(inferred)** are where the repo
gives no exact method; the open questions at the end list what the release
owner still has to decide.

Record every verdict as PASS, FAIL or BLOCKED in a dated private copy of the
acceptance template (step 1.8). Never commit raw evidence.

## Before you start: what one pass can and can't prove

- **Candidate:** the next numeric Windows Alpha after the newest record in
  [docs/acceptance/windows-alpha/](windows-alpha/). Records are immutable, so a
  build that already has an owner waiver can't be re-accepted. Builds ship
  often, so pick the predecessor on the day of the pass, not from an old note.
  [S1, S3, S8]
- **Release sequence:** waivers count in the acceptance chain, so the first
  PASS record is a successor of that newest record, and `alphaToAlphaUpdate`
  must be PASS. The first-public-alpha bootstrap does not apply. [S8]
- **Path:** the legacy runbook. `VIDEORC_RELEASE_CONTROLLER_ENABLED` stays off
  until the coordinator rollout gates pass. [S1, S11]
- **One machine can't close every public gate.** `lowerCapacityHardware` needs
  a second, weaker machine. `fallbackGpuPath` needs a documented way to disable
  acceleration (none is written down yet) or a host that falls back naturally.
  `productionDownloadRoute` and `alphaToAlphaUpdate` need pilot promotion
  first. Expect the first two BLOCKED on a one-machine pass, so it produces a
  private dated record, not a committable PASS record. [S1, S2]
- **1080p60:** the UHD 620 flake (2 of 16 takes short of the 2% gate) was
  measured on 0.25.2, before the #1042 D3D11 encoder fixes (#1362, #1373). The
  first physical pass is its first recheck on hardware after them. [S7]
- **Who does what:** the release owner supplies the candidate identity,
  candidate-read storage credentials and the pilot token, and dispatches pilot
  promotion. The operator runs every step below. Only the release owner commits
  an acceptance record or a waiver. [S1, S3]

## Phase 1: Prerequisites and machine setup

- [ ] 1.1 Physical Windows 11 x64, build 22000 or newer, not a VM. Record make,
      CPU, RAM, GPU and driver privately. [S1, S4, S5]
- [ ] 1.2 Attach a camera and a physical microphone, and one display at a known
      resolution and scale. No physical mic means BLOCKED, never a synthetic
      pass. [S2, S6]
- [ ] 1.3 Plug into AC power and keep it there for the whole run. The gate
      records the power source; battery is only a warning, and the 1080p60
      numbers are judged on AC. [S4, S7]
- [ ] 1.4 Clean state: no Videorc in Settings > Apps, no `%APPDATA%\Videorc`
      folder, a fresh Windows user profile. **(inferred** definition of clean;
      the template asks for a launch from a clean user profile**)** [S2]
- [ ] 1.5 Microsoft Defender up to date with real-time protection on. [S2]
- [ ] 1.6 Install the toolchain the gate needs: git, Node 24.x, Rust stable
      with MSVC (Visual Studio Build Tools), then run `corepack enable` and
      `corepack install`. The installed-app gate still runs Rust tests and
      clippy from a source checkout. [S4, S5]
- [ ] 1.7 Make a clean checkout of the exact candidate source commit (full
      40-character SHA, no local changes), then run `pnpm install`. [S1]
- [ ] 1.8 Copy
      [windows-app-acceptance-template.md](windows-app-acceptance-template.md)
      to a dated private record, with evidence under the ignored artifact
      directory. Fill Scope and Lab Setup. [S1, S2]
- [ ] 1.9 Get from the release owner: release ID, source commit, installer
      SHA-256, exact publisher CN, candidate prefix and workflow URL. [S1]

Evidence: Scope and Lab Setup sections of the dated record.

## Phase 2: Fetch and verify the exact candidate

- [ ] 2.1 Set the identity variables, load the candidate-read storage
      credentials into the `VIDEORC_RELEASE_UPLOAD_S3_*` names without printing
      them, then download and verify. Pass: both commands exit 0. [S1]

```powershell
$env:VIDEORC_RELEASE_ID = '<releaseId>'
$env:VIDEORC_RELEASE_SOURCE_COMMIT = '<candidate source commit>'
$env:VIDEORC_RELEASE_EXPECTED_SHA256 = '<installer sha256>'
$env:VIDEORC_WINDOWS_PUBLISHER_NAME = '<exact publisher CN>'
pnpm release:candidate:download:windows
pnpm release:candidate:verify:windows
```

- [ ] 2.2 Derive the two expected hashes from the verified `win-unpacked`
      copy, with the `Get-FileHash` and `packagedAppPayloadIdentity` commands
      exactly as written in runbook section 3. Set
      `VIDEORC_WINDOWS_ACCEPTANCE_EXPECTED_APP_SHA256` and
      `VIDEORC_WINDOWS_ACCEPTANCE_EXPECTED_PAYLOAD_SHA256`. Never take either
      from the installed copy. [S1]
- [ ] 2.3 Before launching any candidate code, remove every
      `VIDEORC_RELEASE_UPLOAD_S3_*`, `VIDEORC_DOWNLOAD_S3_*`,
      `VIDEORC_WINDOWS_SIGNING_*` and `AZURE_*` variable with the
      `Get-ChildItem Env:` block in runbook section 3. [S1]
- [ ] 2.4 Installer hash and byte size match the manifest. [S2, Candidate
      Identity]

```powershell
Get-FileHash -Algorithm SHA256 .\Videorc-*-win-x64.exe | Format-List
(Get-Item .\Videorc-*-win-x64.exe).Length
```

- [ ] 2.5 Signature: `Get-AuthenticodeSignature` on the installer shows Valid
      and the exact publisher, and `signtool verify /pa /all /v` shows a
      trusted timestamp. Unsigned, NotSigned, UnknownError, another publisher
      or no timestamp is an automatic FAIL. [S2, Signing]
- [ ] 2.6 Defender scan of the exact installer after the hash check. No
      third-party scanner without owner approval. Pass: zero detections. [S2,
      Malware Scan]

```powershell
Get-MpComputerStatus | Select-Object AMEngineVersion,AntivirusSignatureVersion,AntivirusSignatureLastUpdated,RealTimeProtectionEnabled
Start-MpScan -ScanType CustomScan -ScanPath .\Videorc-*-win-x64.exe
Get-MpThreatDetection
```

Evidence: Candidate Identity And Integrity, Signing and Malware Scan sections.
Gates: `authenticodeSignature`, `defenderMalwareScan`.

## Phase 3: Clean install and first launch

- [ ] 3.1 Run the installer: an assisted, per-user NSIS installer with a
      changeable install folder. Record the SmartScreen prompt; it must name
      the expected verified publisher. [S9, S2]
- [ ] 3.2 Let the installer launch the app. Pass: first launch on the clean
      profile, backend reports READY. Note the installed `Videorc.exe` path
      privately. [S2, Packaged App]
- [ ] 3.3 Sources: screen, camera and microphone each appear and select.
      Restart: selections persist. Unplug the camera: the selection reconciles.
      Windows permission links open. [S2, Sources]
- [ ] 3.4 Protocol sign-in from the installed app: browser auth returns through
      the Videorc protocol to this app and the identity shows. Keep callback
      URLs and tokens out of evidence. [S1, S2]
- [ ] 3.5 Sign out, quit fully, confirm no Videorc, backend or FFmpeg process
      remains, relaunch: still signed out. Sign in again: works. [S2]
- [ ] 3.6 Windows UX sweep: snap, maximize, restore, dark and light theme,
      command palette, Ctrl hints, Notes, Comments, detached Preview, narrow
      window, multi-monitor if present. [S2, Windows UX]

Evidence: Packaged App, Sources, Protocol Sign-In, Sign-Out And Relaunch and
Windows UX sections. Gates: `cleanInstall`, `protocolSignIn`,
`signOutRelaunch`.

## Phase 4: First recording and the installed-app gate, including 1080p60

- [ ] 4.1 By hand, record screen only, camera only, then screen + camera + mic,
      about 30 s each. Each stops cleanly, shows in Library and plays back.
      **(inferred** clip length**)** [S2]
- [ ] 4.2 Inspect each file with ffprobe-based analysis, never file size alone:
      duration, frame count, fps, audio present, A/V skew. **(inferred:** the
      docs name no exact analyzer command**)** [S2, Recording And Streaming
      Evidence]
- [ ] 4.3 Dry-run the gate to print its plan. Pass: host checks OK (Windows 11
      x64, known build) and the power source shows AC. [S1, S4]

```powershell
$env:VIDEORC_WINDOWS_ACCEPTANCE_REQUIRE_INSTALLED = '1'
$env:VIDEORC_WINDOWS_ACCEPTANCE_EXECUTABLE = '<installed Videorc.exe>'
$env:VIDEORC_WINDOWS_ACCEPTANCE_DIR = '<private evidence folder>'
pnpm smoke:local-gates:windows -- --dry-run
```

- [ ] 4.4 Run it for real with `pnpm smoke:local-gates:windows`. It checks the
      installed exe and payload against step 2.2, the NSIS uninstall
      registration, the signature and ProductVersion, then runs its steps.
      Pass: it ends with `windows-local-gates: PASS` and
      `windows-local-gates.manifest.json` shows the candidate binding verified.
      [S1, S4]
- [ ] 4.5 The 1080p60 check is the gate's step named "native Windows
      ScreenCamera D3D11 direct-record smoke 1080p60": 1920x1080 at 60 fps,
      8 s, screen + camera on D3D11. It fails when frames come up more than 2%
      short. The encoded-bridge matrix and both RTMP matrices also run 1080p30
      and 1080p60. [S4, S7]
- [ ] 4.6 If the 1080p60 step fails, record FAIL with that take's frames short,
      rerun up to two more times, and record every take, not only a passing
      one. **(inferred;** the repo is explicit that no gate is loosened**)**
      [S7]
- [ ] 4.7 A step that exits with code 2 (the RTMP matrices, live microphone
      controls) is BLOCKED, not PASS. Record the reason from its report. [S4]
- [ ] 4.8 Force-close: while idle, end Videorc from Task Manager. Pass: no
      owned backend or FFmpeg child remains. The gate's process-lifecycle smoke
      covers a normal quit. [S1, S2, S4]
- [ ] 4.9 Support bundle: the gate's last step runs
      `pnpm support-bundle:verify` with `--windows-acceptance`. Keep the bundle
      private and record only the verdict. [S2, S6]
- [ ] 4.10 Advertised RTMP: write down the exact outward claim and destination
      tested. If no RTMP workflow will be advertised, the owner removes the
      claim instead of marking it not applicable. [S2]

Evidence: Build And Static Gates (the gate manifest), the D3D11 1080p30 and
1080p60 rows, Recording And Streaming Evidence, Preview Decision Evidence and
Support Bundle. Gates: `screenOnlyRecording`, `cameraOnlyRecording`,
`screenCameraMicrophoneRecording`, `normalGpuPath`, `ownedProcessCleanup`,
`supportBundleRedaction`, `advertisedRtmpWorkflow`.

## Phase 5: Uninstall and reinstall

- [ ] 5.1 Uninstall from Windows Settings > Apps. The uninstaller shows the
      verified publisher. [S2]
- [ ] 5.2 After uninstall: no Videorc process, binaries and shortcuts gone,
      existing recordings still on disk. [S2]
- [ ] 5.3 Note what stays in `%APPDATA%\Videorc`. The repo has no written
      app-data policy and the NSIS config doesn't ask for deletion, so data
      most likely stays. **(inferred)** Flag it as an owner decision. [S2, S9]
- [ ] 5.4 Reinstall the same installer: it installs and launches. [S1, S2]

Evidence: the uninstall rows of Signing, Installer, And Updates. Gate:
`uninstall`.

## Phase 6: Pilot promotion and the production-shaped download

- [ ] 6.1 The release owner dispatches Promote Windows Alpha Candidate with
      stage `pilot` and an empty acceptance record URL, points the web pilot at
      `releases/windows/pilot/release.json`, and sends the operator the pilot
      token through the release secret channel. The stable feed and manifests
      stay untouched. [S1]
- [ ] 6.2 Signed in on the web, download Windows through the pilot deployment's
      `/download/windows`: a short-lived redirect with no durable credential
      and no private prefix. Signed out, the request fails without exposing a
      storage URL. [S2, Production Download Route]
- [ ] 6.3 The downloaded installer's filename, size and SHA-256 match Phase 2.
      [S1, S2]

Evidence: Production Download Route section. Gate: `productionDownloadRoute`.

## Phase 7: Rollback and default-deny check

Rollback is forward-only: installed clients are never downgraded. A bad release
is handled by disabling the web Windows state, restoring the last accepted
pointers and shipping a higher version. On the machine, the proof is the
template's row for rollback and default-deny with a rejected candidate. The
method below is **inferred**. [S1, S2]

- [ ] 7.1 Uninstall the candidate. Install the immediately prior Alpha (the
      predecessor chosen in "Before you start") from the public signed-in
      download, and check its hash against its manifest. [S1, S2]
- [ ] 7.2 Signed out, with no pilot variables set, open Settings > About &
      updates and check for updates. Pass: the pending pilot candidate is not
      offered. Stay signed out, because signed-in installs can be moved to the
      pilot feed per account. [S1, S10]
- [ ] 7.3 After Phase 8, with the pilot variables cleared, check for updates on
      the candidate. Pass: the prior Alpha is not offered as a downgrade.
      **(inferred)** [S1]
- [ ] 7.4 If anything in this pass fails: keep the candidate private and never
      replace it in place. The next build gets a new numeric version. [S1, S6]

Evidence: the rollback and default-deny row of Signing, Installer, And Updates.

## Phase 8: Update from the prior Alpha to the candidate

- [ ] 8.1 Start the prior Alpha on the pilot feed from PowerShell. [S1]

```powershell
$env:VIDEORC_WINDOWS_PILOT_UPDATE = '1'
$env:VIDEORC_WINDOWS_PILOT_UPDATE_TOKEN = '<operator pilot token>'
& '<installed prior Videorc.exe>'
```

- [ ] 8.2 Settings > About & updates: check, then download. Pass: the candidate
      version is offered and downloads. [S2, S10]
- [ ] 8.3 Start a recording, then try Restart & install. Pass: the install
      waits while recording or streaming is active. [S2, S10]
- [ ] 8.4 Stop, go idle, Restart & install. Pass: it completes, and the
      relaunched app and `Videorc.exe` ProductVersion show the candidate
      version. [S2]
- [ ] 8.5 Sign in and record a short screen + camera + mic clip on the updated
      app; inspect it as in 4.2. [S1]
- [ ] 8.6 Quit every Videorc process and clear the pilot variables. [S1]

```powershell
Remove-Item Env:VIDEORC_WINDOWS_PILOT_UPDATE -ErrorAction SilentlyContinue
Remove-Item Env:VIDEORC_WINDOWS_PILOT_UPDATE_TOKEN -ErrorAction SilentlyContinue
```

Evidence: the update rows of Signing, Installer, And Updates. Gate:
`alphaToAlphaUpdate`.

## Phase 9: Final uninstall and cleanup

- [ ] 9.1 Run step 7.3, then uninstall from Settings and repeat the 5.2 checks.
      [S2]
- [ ] 9.2 Clear every acceptance and identity variable from the session, and
      confirm none was set at user or machine scope. **(inferred)** [S1]
- [ ] 9.3 Move evidence to private storage. `git status` in the checkout shows
      nothing new: logs, bundles, recordings and the dated record are never
      committed. [S1, S2]

## Recording results

Write every verdict in the dated private record from step 1.8: the overall
result in its Verdict section, and product failures, hardware blockers and
owner decisions in Failures And Follow-Up. The public JSON at
`docs/acceptance/windows-alpha/<releaseId>.json` comes later, only when every
required gate is PASS, and only the release owner commits it. [S2, S3]

| Gate in the JSON record           | Checklist steps | Expected after one machine                                             |
| --------------------------------- | --------------- | ---------------------------------------------------------------------- |
| `cleanInstall`                    | 3.1, 3.2        | PASS possible                                                          |
| `protocolSignIn`                  | 3.4             | PASS possible                                                          |
| `signOutRelaunch`                 | 3.5             | PASS possible                                                          |
| `uninstall`                       | 5.1 to 5.4, 9.1 | PASS possible                                                          |
| `screenOnlyRecording`             | 4.1 to 4.4      | PASS possible                                                          |
| `cameraOnlyRecording`             | 4.1 to 4.4      | PASS possible                                                          |
| `screenCameraMicrophoneRecording` | 4.1 to 4.5      | PASS possible                                                          |
| `normalGpuPath`                   | 4.4, 4.5        | PASS possible                                                          |
| `fallbackGpuPath`                 | none            | BLOCKED: needs a documented disable method or a natural-fallback host |
| `lowerCapacityHardware`           | none            | BLOCKED: needs a second, weaker machine                                |
| `ownedProcessCleanup`             | 3.5, 4.4, 4.8   | PASS possible                                                          |
| `supportBundleRedaction`          | 4.9             | PASS possible                                                          |
| `defenderMalwareScan`             | 2.6             | PASS possible                                                          |
| `authenticodeSignature`           | 2.5             | PASS possible                                                          |
| `alphaToAlphaUpdate`              | 8.1 to 8.5      | After pilot promotion                                                  |
| `productionDownloadRoute`         | 6.2, 6.3        | After pilot promotion                                                  |
| `advertisedRtmpWorkflow`          | 4.4, 4.10       | PASS possible, or the claim is removed                                 |

A schema 2 record needs these 17 gates. Schema 3 adds five more (D3D11
multi-host aggregate, automatic default, natural fallback, Windows source lane,
macOS regression) that one Windows machine can't close. [S3, S8]

## Open questions for the release owner

- [ ] Which method counts as documented for disabling GPU acceleration in
      `fallbackGpuPath`?
- [ ] What should uninstall do with `%APPDATA%\Videorc`: keep it or remove it?
- [ ] Is a second, lower-capacity Windows 11 machine available for
      `lowerCapacityHardware`?

When one is answered, replace the matching **(inferred)** step above and tick
it off here.

## Sources

| Ref | File                                                                                                                                                        | Used for                                                              |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| S1  | [docs/releases/windows-alpha-runbook.md](../releases/windows-alpha-runbook.md)                                                                              | Candidate fetch, physical acceptance, pilot update, rollback          |
| S2  | [docs/acceptance/windows-app-acceptance-template.md](windows-app-acceptance-template.md)                                                                    | Evidence rows and pass criteria                                       |
| S3  | [docs/acceptance/windows-alpha-acceptance-record.md](windows-alpha-acceptance-record.md) and its template JSON                                               | Public record contract, gates, waivers                                |
| S4  | [scripts/lib/windows-local-gates.mjs](../../scripts/lib/windows-local-gates.mjs) and [scripts/smoke-local-gates-windows.mjs](../../scripts/smoke-local-gates-windows.mjs) | Installed-app gate steps, 1080p60 step, BLOCKED exit code, power source |
| S5  | [docs/windows-dev-loop.md](../windows-dev-loop.md)                                                                                                          | Toolchain, Windows 11 floor                                           |
| S6  | [docs/distribution.md](../distribution.md)                                                                                                                  | Windows Alpha publication rules, support bundle                       |
| S7  | [docs/acceptance/2026-11-14-windows-uhd620-d3d11-gates-recheck.md](2026-11-14-windows-uhd620-d3d11-gates-recheck.md)                                        | 1080p60 flake, 2% gate, AC power                                      |
| S8  | [scripts/lib/windows-acceptance-record.mjs](../../scripts/lib/windows-acceptance-record.mjs), `windows-acceptance-history.mjs` and [docs/acceptance/windows-alpha/](windows-alpha/) | Release chain, schema 2 and 3 gates, waiver records                   |
| S9  | [apps/desktop/electron-builder.yml](../../apps/desktop/electron-builder.yml)                                                                                | NSIS installer settings                                               |
| S10 | [apps/desktop/src/main/updater.ts](../../apps/desktop/src/main/updater.ts)                                                                                  | Settings update flow, install deferred during capture, account pilot  |
| S11 | [docs/release-coordinator-runbook.md](../release-coordinator-runbook.md)                                                                                    | Controller flag stays off                                             |
