# YYYY-MM-DD Windows App Acceptance

This is the evidence template for the Windows app track. Copy it to a dated
file after running the Windows gates on a real Windows 11 x64 machine. Keep
recordings, screenshots, package logs, support bundles, stream keys, local
tokens, and generated media out of git; store them under the ignored artifact
directory. In a committed note, use repository-relative ignored paths or private
evidence IDs only — never paste a home-directory path, username, device ID,
credential, presigned URL, or support-bundle contents.

## Scope

- Milestone: Functional Alpha / Public Beta / Mirror App
- Release ID:
- Release sequence: first-public-alpha / successor of `<immediately prior accepted release ID>`
- Bundle version:
- Release channel: alpha
- Commit:
- Release manifest URL/object key:
- Manifest `releasedAt` (exact UTC):
- Release notes URL:
- Known-issues URL:
- Operator:
- Windows machine:
- GPU(s):
- Camera:
- Microphone:
- Remote access mode: local / Parsec / RDP / SSH + screenshots / other
- Artifact directory:
- `VIDEORC_WINDOWS_ACCEPTANCE_DIR`, if set:
- Known hardware or permission blockers:

## Lab Setup

- Windows version/build:
- Architecture:
- Power mode:
- Display count/resolution/scale:
- Git version:
- Node version:
- pnpm version:
- Rust toolchain:
- Visual Studio Build Tools:
- FFmpeg source:

## Build And Static Gates

- `pnpm install`: PASS / FAIL / BLOCKED
- `cargo clippy -p videorc-backend -- -D warnings`: PASS / FAIL / BLOCKED
- `cargo test -p videorc-backend`: PASS / FAIL / BLOCKED
- `pnpm check:text-files`: PASS / FAIL / BLOCKED
- `pnpm test:scripts`: PASS / FAIL / BLOCKED
- `pnpm typecheck`: PASS / FAIL / BLOCKED
- `pnpm --filter @videorc/desktop test`: PASS / FAIL / BLOCKED
- `cargo test -p videorc-backend capture_input`: PASS / FAIL / BLOCKED
- `cargo test -p videorc-backend fifo`: PASS / FAIL / BLOCKED
- `pnpm ffmpeg:fetch:windows`: PASS / FAIL / BLOCKED
- `pnpm package:preflight:windows`: PASS / FAIL / BLOCKED
- Installed candidate executable path (private evidence only):
- `VIDEORC_WINDOWS_ACCEPTANCE_REQUIRE_INSTALLED=1`: set / missing
- `VIDEORC_WINDOWS_ACCEPTANCE_EXECUTABLE`: set / missing
- `VIDEORC_WINDOWS_ACCEPTANCE_EXPECTED_APP_SHA256`: set from verified private candidate / missing
- `pnpm smoke:local-gates:windows` against the installed signed candidate: PASS / FAIL / BLOCKED
- Windows local-gates manifest:
- Local-gates manifest candidate binding `verified: true`: PASS / FAIL / BLOCKED
- Gate logs:

## Candidate Identity And Integrity

Run these checks against the exact installer downloaded through the production
Windows download route, not a similarly named file left in the build directory.
Store command output privately under the ignored acceptance artifact directory.

```powershell
Get-FileHash -Algorithm SHA256 .\Videorc-*-win-x64.exe | Format-List
(Get-Item .\Videorc-*-win-x64.exe).Length
```

- Download route used:
- Downloaded installer filename:
- Download completed at (exact UTC):
- Manifest `filename`:
- Manifest `objectKey`:
- Manifest `sourceCommit`:
- Manifest SHA-256:
- Downloaded installer SHA-256:
- SHA-256 exact match: PASS / FAIL / BLOCKED
- Manifest `sizeBytes`:
- Downloaded installer byte size:
- Byte-size exact match: PASS / FAIL / BLOCKED
- Hash/size command evidence ID:
- Candidate was not replaced after these checks: PASS / FAIL / BLOCKED
- Verified private candidate `win-unpacked/Videorc.exe` SHA-256:
- Installed `Videorc.exe` SHA-256:
- Private-candidate/installed-app SHA-256 exact match: PASS / FAIL / BLOCKED
- Installed `Videorc.exe` ProductVersion:
- ProductVersion matches the release ID core version: PASS / FAIL / BLOCKED
- Installed-app binding evidence ID:

## Required Public-Gate Scenarios

These rows substantiate the same named gates in
`windows-alpha-acceptance-record.template.json`. A public acceptance record may
set a gate to `PASS` only when the matching row below was run on physical
Windows 11 x64 hardware against this exact installed candidate. Keep raw output
private and record only sanitized evidence IDs here.

### Protocol Sign-In (`protocolSignIn`)

- Production-shaped account sign-in was initiated from the installed app: PASS / FAIL / BLOCKED
- Browser authentication returned through the registered Videorc protocol: PASS / FAIL / BLOCKED
- The installed app, not another build, received the callback: PASS / FAIL / BLOCKED
- Signed-in identity was visible after callback: PASS / FAIL / BLOCKED
- Callback URL, tokens, cookies, and account identifiers are absent from committed evidence: PASS / FAIL / BLOCKED
- Protocol sign-in evidence ID:

### Sign-Out And Relaunch (`signOutRelaunch`)

- Sign-out removed the authenticated session from the running app: PASS / FAIL / BLOCKED
- Full app quit left no owned processes: PASS / FAIL / BLOCKED
- Relaunch stayed signed out and did not reuse stale credentials: PASS / FAIL / BLOCKED
- A fresh protocol sign-in after relaunch succeeded: PASS / FAIL / BLOCKED
- Sign-out/relaunch evidence ID:

### Normal GPU Path (`normalGpuPath`)

- Physical hardware profile and GPU driver version recorded privately: PASS / FAIL / BLOCKED
- Normal hardware-accelerated path selected without a forced override: PASS / FAIL / BLOCKED
- Screen + camera + microphone recording completed and analyzed: PASS / FAIL / BLOCKED
- Preview and saved media passed on the selected normal path: PASS / FAIL / BLOCKED
- Normal-path encoder/backend observed:
- Normal-path evidence ID:

### Fallback GPU Path (`fallbackGpuPath`)

- Normal acceleration was unavailable or disabled using the documented test method: PASS / FAIL / BLOCKED
- App reported the expected fallback backend/reason: PASS / FAIL / BLOCKED
- Screen + camera + microphone recording completed and analyzed on fallback: PASS / FAIL / BLOCKED
- Preview and saved media passed on the selected fallback path: PASS / FAIL / BLOCKED
- Fallback-path encoder/backend and trigger:
- Fallback-path evidence ID:

### Lower-Capacity Hardware (`lowerCapacityHardware`)

- A second, lower-capacity physical Windows 11 x64 machine was used: PASS / FAIL / BLOCKED
- CPU, RAM, GPU, display, and driver profile recorded privately: PASS / FAIL / BLOCKED
- Clean install, first launch, sources, recording, save, playback, and uninstall passed: PASS / FAIL / BLOCKED
- Resource pressure, dropped frames, fallback, and thermal/power observations recorded: PASS / FAIL / BLOCKED
- Lower-capacity hardware evidence ID:

### Production Download Route (`productionDownloadRoute`)

- Signed-in production-shaped `/download/windows` flow returned a short-lived redirect: PASS / FAIL / BLOCKED
- Anonymous request failed without exposing an artifact or storage URL: PASS / FAIL / BLOCKED
- Redirect contained no durable credential and did not expose the private candidate prefix: PASS / FAIL / BLOCKED
- Downloaded filename, byte size, and SHA-256 match Candidate Identity And Integrity above: PASS / FAIL / BLOCKED
- Production route release ID and manifest URL/object key:
- Production-route evidence ID:

### Advertised RTMP Workflow (`advertisedRtmpWorkflow`)

- The exact outward claim and destination tested are recorded: PASS / FAIL / BLOCKED
- Start, sustained stream, stop, and local-output behavior passed: PASS / FAIL / BLOCKED
- Test sink confirmed expected video/audio and no secret was captured in evidence: PASS / FAIL / BLOCKED
- If no RTMP workflow will be advertised, the release owner removed the claim instead of marking this gate not applicable: PASS / FAIL / BLOCKED
- Advertised RTMP evidence ID:

## Packaged App

- Package type: win-unpacked / NSIS installer / other
- Installer path:
- Packaged executable:
- Bundled backend path:
- Bundled FFmpeg path:
- Launches from a clean user profile: PASS / FAIL / BLOCKED
- Backend reports READY: PASS / FAIL / BLOCKED
- App quit leaves no owned backend/FFmpeg children: PASS / FAIL / BLOCKED
- Force-close leaves no owned backend/FFmpeg children: PASS / FAIL / BLOCKED
- Process proof path:

## Sources

| Source         | Expected | Observed | Stable ID | Verdict               | Notes |
| -------------- | -------: | -------- | --------- | --------------------- | ----- |
| Screen/display |      yes |          |           | PASS / FAIL / BLOCKED |       |
| Camera         |      yes |          |           | PASS / FAIL / BLOCKED |       |
| Microphone     |      yes |          |           | PASS / FAIL / BLOCKED |       |

- Selection persistence after restart: PASS / FAIL / BLOCKED
- Selection reconciliation after device removal: PASS / FAIL / BLOCKED
- Windows permission/settings links: PASS / FAIL / BLOCKED

## Recording And Streaming Evidence

Every finished artifact must be inspected with ffprobe/ffmpeg-based analysis.
File-size-only evidence is not enough.

| Scenario                   | Artifact path | Analyzer JSON/path | Preview verdict       | Final-file verdict    | A/V verdict           | Notes |
| -------------------------- | ------------- | ------------------ | --------------------- | --------------------- | --------------------- | ----- |
| Test pattern               |               |                    | PASS / FAIL / BLOCKED | PASS / FAIL / BLOCKED | PASS / FAIL / BLOCKED |       |
| Screen only                |               |                    | PASS / FAIL / BLOCKED | PASS / FAIL / BLOCKED | PASS / FAIL / BLOCKED |       |
| Camera only                |               |                    | PASS / FAIL / BLOCKED | PASS / FAIL / BLOCKED | PASS / FAIL / BLOCKED |       |
| Screen + camera + mic      |               |                    | PASS / FAIL / BLOCKED | PASS / FAIL / BLOCKED | PASS / FAIL / BLOCKED |       |
| RTMP/multistream test sink |               |                    | PASS / FAIL / BLOCKED | PASS / FAIL / BLOCKED | PASS / FAIL / BLOCKED |       |

- Decoder/encoder selected:
- Encoder fallback reason, if any:
- RTMP sink:
- Dropped frames/repeated frames:
- Audio gaps:
- A/V skew:

## Preview Decision Evidence

- Portable polling preview under moving screen content: PASS / FAIL / BLOCKED
- Portable polling preview under camera motion: PASS / FAIL / BLOCKED
- Preview while recording: PASS / FAIL / BLOCKED
- Preview while streaming: PASS / FAIL / BLOCKED
- CPU/GPU observations:
- By-eye smoothness verdict:
- Native preview required before public Windows: YES / NO / UNKNOWN
- Evidence paths/screenshots/video:

## Windows UX

- Native chrome/snap/maximize/restore/drag: PASS / FAIL / BLOCKED
- Dark theme: PASS / FAIL / BLOCKED
- Light theme: PASS / FAIL / BLOCKED
- Command palette: PASS / FAIL / BLOCKED
- `Ctrl` keyboard hints: PASS / FAIL / BLOCKED
- Notes window: PASS / FAIL / BLOCKED
- Comments window: PASS / FAIL / BLOCKED
- Detached Preview window: PASS / FAIL / BLOCKED
- Narrow window text overflow check: PASS / FAIL / BLOCKED
- Multi-monitor behavior: PASS / FAIL / BLOCKED
- Screenshot sweep path:

## Signing, Installer, And Updates

- Signing mode: Azure Trusted Signing / OV-EV Authenticode / unsigned internal
- Public Alpha signing requirement met: PASS / FAIL / BLOCKED
- Expected publisher certificate subject (exact pinned value):
- Installer publisher certificate subject (exact observed value):
- Installed `Videorc.exe` publisher certificate subject (exact observed value):
- Exact publisher match for both files: PASS / FAIL / BLOCKED
- Installer signature status (`Get-AuthenticodeSignature`):
- Installed executable signature status (`Get-AuthenticodeSignature`):
- Signer certificate thumbprint:
- Timestamp present on installer: PASS / FAIL / BLOCKED
- Timestamp authority certificate subject (exact observed value):
- Signature timestamp (raw `signtool verify /pa /all /v` value):
- Signature timestamp normalized to exact UTC:
- Timestamp trust-chain verdict: PASS / FAIL / BLOCKED
- Authenticode/signtool evidence ID:
- Signing blocker, if any:
- NSIS installer launches app: PASS / FAIL / BLOCKED
- SmartScreen experience:
- SmartScreen reports the expected verified publisher: PASS / FAIL / BLOCKED
- Production download route returns this exact candidate: PASS / FAIL / BLOCKED
- Update feed URL:
- Feed version/filename/SHA-512 or checksum fields match candidate metadata: PASS / FAIL / BLOCKED
- Update from previous accepted Alpha downloads successfully: PASS / FAIL / BLOCKED
- Update waits while recording/streaming is active: PASS / FAIL / BLOCKED
- Restart and install completes on idle app: PASS / FAIL / BLOCKED
- Relaunched app reports expected version: PASS / FAIL / BLOCKED
- Rollback/default-deny behavior proven with a rejected candidate: PASS / FAIL / BLOCKED
- Update/feed evidence ID:
- Uninstall launched from Windows Settings: PASS / FAIL / BLOCKED
- Uninstaller shows the expected verified publisher: PASS / FAIL / BLOCKED
- App processes are gone after uninstall: PASS / FAIL / BLOCKED
- Installed binaries and shortcuts are removed: PASS / FAIL / BLOCKED
- Existing recordings are preserved: PASS / FAIL / BLOCKED
- App-data retention/removal matches the documented policy: PASS / FAIL / BLOCKED
- Reinstall after uninstall succeeds: PASS / FAIL / BLOCKED
- Uninstall evidence ID:
- FFmpeg LGPL notices present in package: PASS / FAIL / BLOCKED

Unsigned output, an unexpected publisher, `UnknownError`/`NotSigned`, or a
missing/untrusted timestamp is an automatic public-Alpha `FAIL`, even when the
installer otherwise launches.

## Malware Scan

Use an up-to-date Microsoft Defender installation on the clean Windows 11 x64
acceptance machine. Record product/signature versions and run a custom scan of
the exact downloaded installer after the SHA/size check. Do not upload a private
candidate to a third-party scanning service without explicit release-owner
approval.

```powershell
Get-MpComputerStatus | Select-Object AMEngineVersion,AntivirusSignatureVersion,AntivirusSignatureLastUpdated,RealTimeProtectionEnabled
Start-MpScan -ScanType CustomScan -ScanPath .\Videorc-*-win-x64.exe
Get-MpThreatDetection
```

- Scanner: Microsoft Defender Antivirus
- Engine version:
- Antivirus signature version:
- Signature last updated (exact UTC):
- Real-time protection enabled: PASS / FAIL / BLOCKED
- Scan started/finished (exact UTC):
- Scanned installer SHA-256:
- Threat detections attributable to candidate: 0 / other
- No-detections verdict: PASS / FAIL / BLOCKED
- Defender command/evidence ID:

## Support Bundle

- Support bundle private evidence ID (never a local path in git):
- Verifier command: `pnpm support-bundle:verify -- <support-bundle.json> --windows-acceptance`
- Verifier verdict: PASS / FAIL / BLOCKED
- Windows OS build included: PASS / FAIL / BLOCKED (`rendererDiagnostics.runtimeInfo.osRelease`)
- GPU adapter(s) included: PASS / FAIL / BLOCKED (`rendererDiagnostics.runtimeInfo.gpuDevices`)
- Selected encoder included: PASS / FAIL / BLOCKED
- Capture backend/fallback reason included: PASS / FAIL / BLOCKED
- Device IDs redacted: PASS / FAIL / BLOCKED
- Packaged runtime included: PASS / FAIL / BLOCKED
- Authenticode signing status checked outside bundle: PASS / FAIL / BLOCKED
- No secrets/tokens/recordings/stream keys included: PASS / FAIL / BLOCKED
- Bundle kept out of git and public issue attachments: PASS / FAIL / BLOCKED
- Public issue contains verifier verdict only, with no local path or raw bundle data: PASS / FAIL / BLOCKED

## Failures And Follow-Up

- Product failures:
- Host/hardware blockers:
- Signing/business blockers:
- Owner decisions needed:
- Follow-up plan/issue:

## Verdict

- Milestone A verdict: PASS / FAIL / BLOCKED
- Milestone B verdict: PASS / FAIL / BLOCKED
- Milestone C verdict: PASS / FAIL / BLOCKED
- Overall Windows app verdict: PASS / FAIL / BLOCKED
- Notes:
