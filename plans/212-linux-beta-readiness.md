# Linux Beta readiness

Status: implementation in progress; **no accepted or published Beta**.
Authorized scope: x64 AppImage on Ubuntu 24.04 GNOME/Wayland and
Omarchy/Hyprland/Wayland. Work starts at main
`8e601aeb3f804ccf120b4c7986182e2b44448b86` (0.16.0). Existing Alpha
candidates, owner waivers, CI results and older artifacts are not Beta evidence.
Do not modify `/home/orcdev/retest-fix-153/src` or its unrelated user changes.

## Delivery order

1. **Trustworthy evidence (in progress).** Fix swallowed Rust workflow exits,
   reject reused docs-only Linux jobs, enforce artifact analyzer verdicts and
   98% take coverage, inspect actual AppImage bytes, define the complete
   acceptance ledger and maintained Linux development gates.
2. **Runtime and channel integration (open).** Resolve the feature rows below;
   derive the Linux badge from immutable build identity; retain Alpha defaults;
   finish private Beta candidates, protected exact-byte pilot/public promotion,
   finalizer, storage and web/update consumers. Do not enable the release
   controller as a side effect. The current controller lacks Linux support.
3. **Freeze and build (open).** Reconcile newer main, overlapping PRs and live
   numeric versions. Choose a strictly higher patch only when preparing the
   actual candidate. Merge reviewed preparation, freeze protected-main source,
   build unsigned production AppImage with bundled OAuth and pinned LGPL
   FFmpeg, validate payload, retain exact checksums and workflow provenance.
4. **Physical acceptance (blocked on candidate and Ubuntu operator).** Complete
   every row below on both separate physical desktops with that same AppImage.
   Test hooks/dev binaries can diagnose failures but cannot replace acceptance.
5. **Pilot (open).** Seven actual days; at least three testers per desktop,
   three sessions per tester, at least 20 aggregate session hours. Record bugs
   and rerun affected gates on a new candidate after any source/payload change.
6. **Public release (blocked on acceptance).** Commit a reviewed, hash-bound
   PASS record; promote those bytes through protected automation; verify signed-in
   download, production updater and configured mirrors; finish support/rollback
   records. No real provider broadcast or announcement without its authorization.

## Complete acceptance ledger

All rows are **OPEN** until named operators provide current candidate evidence.
For every row record source SHA, AppImage SHA-256/size, environment versions,
operator, start/end timestamps, commands/actions, expected and observed result,
and hashes of private reports. Never commit tokens, user profiles or recordings.
For failures preserve evidence and fixes; a skip, waiver, screenshot alone,
file size or successful build is not a pass.

| Contract category         | Required cases and evidence                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| provenance-and-gates      | Actual executed JS/Rust gates; typecheck, lint, format, dependency audits, script/desktop tests and build; Linux compile plus relevant shared macOS/Windows regression checks; workflow source equals frozen main; pinned dependencies/FFmpeg; clean build; no credential or test-hook override in production; exact AppImage, feed, sidecar and receipt hashes.                                    |
| install-and-payload       | Clean download, hash check, executable bit, FUSE and supported extraction path, launch without development tools/host FFmpeg; inspect AppImage itself for backend, FFmpeg/ffprobe, license/source/build configuration, app.asar, Electron fuses, production flags, icons and desktop entry; paths with spaces, no executable in Downloads assumptions; clean removal without deleting recordings.   |
| first-run-and-accounts    | Linux first-use flow, permission explanations, setup completion/restart; sign in/out and browser videorc:// callback from packaged app; cancel/expired/duplicate callback; keyring locked/unavailable and session restart; secure persistence without plaintext fallback; migration from current Alpha; settings and scenes preserved.                                                              |
| portal-capture            | Monitor/window picker grant/cancel/deny/revoke; restore token and stale token; portal restart and app restart; multi-monitor, fractional scaling, HiDPI, portrait, source resize/minimize/close; screen lock/suspend/resume; correct source pixels, no silent substitute; no stuck picker or leaked stream.                                                                                         |
| camera-and-microphone     | Integrated and USB camera/mic enumeration and selection; preview dimensions/cadence; real moving camera target and audible controlled signal; no device/permissions/in-use cases; unplug/replug, default-device changes, live source replacement, recovery and diagnostics.                                                                                                                         |
| scenes-and-preview        | Every exposed scene/layout, crop/fit/mirror, portrait/landscape, overlays/backgrounds/captions/chat/banners; exported pixels and presented pixels agree; CPU/BMP presenter states its real transport; source liveness and stalls; 20 detach/close/reopen/focus cycles; resize/scaling/placement; Notes capture visibility explicitly disclosed and tested.                                          |
| recording-and-storage     | Every exposed 1080p/1440p/4K 30/60 profile, vertical twins and 640x360 floor; forced OpenH264 and approved VAAPI; hard-content pressure; H.264 level, BT.709/video-range, GOP, fps, frame count and complete take; cold/warm start/stop/finalization; repeated sessions; unwritable/deleted/full output disk; failed-start Library state, crash/finalization recovery and no corrupt-success state. |
| audio-and-sync            | Mic-only, mute/gain/noise cleanup, real bus soundboard exactly once, no-sound PCM preservation; silence and missing-device behavior; system audio and combined mix; direct-Pulse fallback warning if mixing unavailable; gap/clipping and A/V flash-click analysis, 60-minute drift and stop tail.                                                                                                  |
| replay-library-and-export | Clips/replay arm/save/disarm during Record/Stream, performance check with ring active, bounded disk and rollover; Library identity/duration/thumbnails, file move/delete/Trash collisions; replay/trim/export/cancel, original preservation, unsupported imports and damaged files.                                                                                                                 |
| streaming-and-recovery    | Local RTMP receiver artifacts and decoded output for every supported provider workflow, reconnect/offline/auth failures, multiple destinations, record+stream, differing profiles and dual orientations; output continuity while provider API/chat is down; explicit refusals for unsupported combinations; real-provider acceptance separately authorized.                                         |
| companion-and-remotes     | Chat/activity/highlights and fake-provider quota outage; Buddy, captions contract/live fake Gateway, kill switch and captions audio source; remote control, Phone LAN, Agents and Buddy tools, pairing/revoke/allowlists/leak tests; keyboard/global shortcuts on GNOME and Hyprland; supported/excluded features match visible controls and docs.                                                  |
| performance-and-endurance | Three fresh passes of critical workflows; 50 Record/Stop cycles per encoder; 60 minutes simultaneous real capture recording+local stream per encoder; >=4 hours on minimum-spec hardware per desktop; CPU/RAM/VRAM/disk/thermal trends, preview and output liveness; process crash and recovery; only owned children killed/reaped, no process/portal/encoder leaks.                                |
| security-and-licenses     | Bundled credential handling and secret-service guarantees, protocol/origin/token checks, redacted support bundles and logs; dependency advisory gates; LGPL/source/license notices and exact FFmpeg configuration; published SHA-256 and deliberate unsigned authenticity policy; no release secrets inherited by candidate processes.                                                              |
| updates-and-rollback      | Real AppImage Alpha→Beta→higher-patch hotfix through staged feeds on both desktops; preserve data/keyring/settings; reject wrong hash/stale/feed mismatch, offline/download interrupted, read-only path, restart; rollback web/feed pointers without overwriting immutable bytes; installed-client recovery rolls forward; never move macOS/Windows pointers.                                       |
| support-and-production    | Rehearse authenticated download/feed/mirror routes in pilot; support/acceptance/release/rollback owners; troubleshooting for both desktops, prerequisites, safe-GPU policy, diagnostics and redaction; explicit supported profiles/features and limitations. Public production verification is a separate post-promotion receipt (below), not fabricated in prepublication acceptance.              |

## Fixed quality budgets

- FPS and frame-count error <=2%; moving-content freeze <=100 ms, repeated
  frames <=2; audio gap <=20 ms; A/V target <=100 ms, hard limit <=150 ms.
- GOP <=2.5 seconds; A/V stop tail <=100 ms; take coverage >=98%.
- Cold Record <=1000 ms; warm Record p95 <=350 ms; Stop-to-idle p95 <=300 ms;
  short-take finalization p95 <=5000 ms. Long-file finalization gets its own
  measured storage profile; never silently apply a relaxed short-take budget.
- Capture target must move and the microphone must have non-silent controlled
  input for quality evidence. A static image cannot prove temporal fidelity.
- No threshold reduction, waiver or omitted required environment for green.

## Runtime scope decisions still to resolve

| Feature                            | Current finding                                                           | Required completion                                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| System audio                       | Linux unsupported                                                         | Implement and prove before broad streaming Beta, or obtain an explicit narrower scope decision.             |
| Live camera/mic/screen replacement | Recording path refuses Linux replacement                                  | Implement/prove replacement and recovery; do not disguise refusal as support.                               |
| Captions                           | Renderer hard-disabled although normal microphone now uses shared PCM bus | Trace backend path and implement/prove with fake Gateway, or obtain explicit exclusion.                     |
| Separate source recordings         | macOS-only                                                                | First Beta may explicitly exclude; keep unsupported controls guarded and publish limitation.                |
| Preview                            | CPU/BMP proof presenter                                                   | Native GPU rewrite is not required; real pixels, cadence/liveness, lifecycle and honest diagnostics are.    |
| Soundboard                         | Normal Linux worker PCM bus supported; direct Pulse fallback cannot mix   | Prove shared-bus mix and fallback warning.                                                                  |
| First run                          | Linux setup enabled with sharing guidance; focused tests pass             | Real-app smoke and packaged physical proof still required.                                                  |
| Notes protection                   | Capture exclusion unsupported                                             | Tell users Notes may be captured; prove behavior.                                                           |
| Split profiles / dual orientation  | Restricted encoded paths                                                  | Inventory actual combinations, implement/prove supported cases and explicit refusals; keep docs/UI aligned. |

### System-audio routing investigation

`pnpm probe:system-audio-routing:linux` is a development-only PipeWire routing
probe. It creates two owned tones/null sinks, moves both tones to one owned sink,
and uses explicit output-port links with automatic target selection disabled.
Its simultaneous control must contain both 440 Hz and 880 Hz; the selective
capture must contain 440 Hz and exclude 880 Hz on both channels. It verifies the
capture client's server-reported PID, bounds capture/cleanup, and writes a
private JSON receipt. Only its own processes/modules are stopped or unloaded;
desktop configuration and default devices are unchanged.

The probe passed on ogre with PipeWire 1.6.8. That establishes a possible routing
primitive, **not Linux system-audio support**. Production registry tracking,
Videorc/Electron process exclusion, source disappearance/replacement, timestamp
alignment, bus integration, and real app/device acceptance are still open. The
probe does not launch Videorc or certify any of those requirements. PipeWire
1.6.8's `pw-record` returns 1 for an intentional capture SIGINT (only playback
drain returns 0); the receipt retains that actual exit and requires the owned
stop after sufficient PCM, empty stderr, and successful signal handling.

The microphone artifact analyzer now accepts one exact backend-reported FFmpeg
tee output shared by recording and stream only when their applied offsets agree.
Duplicate roles, mismatched offsets and foreign session/process owners still
fail. Sixteen focused analyzer/fixture tests pass. The modified Rust backend,
Clippy and full app microphone/caption gates remain pending; this investigation
does not close their acceptance rows.

## Maintained evidence tooling

- `pnpm smoke:local-gates:linux --list` lists explicit source and Linux runtime
  gates. `--phase=source` or `--phase=runtime` runs that phase; no argument runs
  both. Runtime requires an explicitly approved VAAPI node, physical tester
  metadata from `docs/linux-dev-loop.md`, moving camera target, non-silent mic,
  and operator screen-sharing grants. Logs/profiles live in a private temp dir.
- This runner labels evidence **development-only**, tracks source SHA and dirty
  state, rejects missing runtime proof/skips/report-only, and never calls its
  result a physical Beta PASS. The remaining feature and packaged gates above
  are still required. Darwin/ScreenCaptureKit/Metal aggregate skips do not count.
- `pnpm release:validate:linux-beta-acceptance --template <release.json>` emits a
  pending JSON template. Save it separately from frozen candidate source. Fill
  it from real observations; no template values authorize publication.
- `pnpm release:candidate:download:linux --release-id <id> --source-commit
<full-sha> --sha256 <appimage-sha256> --output-parent <private-directory>`
  retrieves the six private candidate objects using candidate-read storage
  authority. It creates a new mode-0700 directory, refuses any mismatched
  identity/feed/checksum or partial/compressed/oversized response, and retains
  the AppImage without execute permission. Existing files are never replaced.
  Strip storage authority before the later payload inspection and app launch;
  downloading and hashing does not execute candidate code or pass acceptance.
- `pnpm release:validate:linux-beta-acceptance <release.json> <record.json>
<private-evidence-root>` checks identity, both desktops, all categories,
  metrics/endurance/pilot and actual private evidence-file SHA-256s. This checks
  the evidence contract, not the truth of observations: named operators and
  protected reviewers must inspect raw reports and attest the rows.
- Acceptance belongs at `docs/acceptance/linux-beta/<releaseId>.json`, referenced
  by a commit-pinned GitHub URL naming that exact release. No Beta owner-waiver
  route. A future promotion workflow must call this validator against retrieved
  private evidence, not merely trust the manifest URL. **Promotion wiring is
  still open; this first slice does not create a public release path.**
- `pnpm release:plan:linux-beta-promotion -- --candidate-dir <verified-directory>
--release-id <id> --source-commit <sha> --sha256 <appimage-sha256>
--trusted-main-commit <sha> --acceptance-record-url <pinned-url>
--evidence-root <private-directory> --output <new-private-plan.json>` prepares
  a read-only public-promotion plan. It loads the acceptance blob from the pinned
  Git commit (never the working file), checks candidate/record ancestry and the
  trusted tree's package version, enforces the full physical/pilot contract,
  and hashes every private receipt and measured artifact. It also rechecks all
  six candidate files and feed/sidecar consistency. The plan contains only
  isolated Beta destinations and exact source hashes; Alpha is refused. It
  neither executes the AppImage nor writes storage. The output file is created
  exclusively, so an existing plan is never overwritten.
- A plan is not publication authority. Protected automation must independently
  establish current main, exact candidate build provenance and payload validity,
  retrieve private evidence, compare remote versions/bytes, bind pointer writes
  to prior state, journal ambiguous writes and verify all configured origins.
  The protected finalizer, pilot enrollment and updater/rollback proof remain
  open. The planner does not alter the release-controller setting.

### Private measurement receipts

Each category's `evidence` reference points to a private JSON receipt under
1 MiB, with `schemaVersion: 1`, `status: pass`, the complete `candidate` identity,
`environmentId`, `operator`, `startedAt`, `finishedAt`, `categoryIds`, and a
nonempty `artifacts` list of `{path, sha256}` references to actual measurements.
Times must fit the environment's acceptance window. A pilot receipt instead
names `pilotSessionId`, the tester as `operator`, and that session's exact times.
The validator checks receipt bytes, their identity/coverage, and all measured
artifact bytes. Relative paths must stay inside the private evidence root,
including through symlinks. Large recordings are streamed for hashing. The
reviewer still verifies that the observations actually satisfy the ledger.

## Post-promotion receipt and completion

After protected exact-byte promotion, record resolved production download and
feed paths, final object hashes/sizes, current version, authenticated account
visibility, short-lived redirect behavior, configured primary/mirror outcomes,
Alpha-client upgrade and hotfix/rollback rehearsal references. Keep any pending
mirror sync explicit. Only then expose Beta web state and declare Linux live.
No Discord/email/provider broadcast is implied by this implementation request.

## Current coordination and blockers

- Ogre: physical Omarchy 4.0.4 x64; Intel `/dev/dri/renderD128` is allowed.
  `/dev/dri/renderD129` is quarantined: **never probe it**. Use isolated profiles
  and sequential encoders. Do not change desktop/system configuration to pass.
- Ubuntu: separate physical Ubuntu 24.04 GNOME/Wayland host/operator requested;
  answer pending. Camera/mic/picker grants are operator actions.
- Named owners, exact production candidate, physical runs, real elapsed pilot,
  update/rollback evidence and production receipts remain outstanding.
- Review existing work before implementing overlaps: #928 disk-full, #927
  aspect ratio, #926 Trash, #925 output permissions, #924 Secret Service, #923
  assets, #922 protocol registration, #920 failed-start Library, #915 Clips
  performance check, #843 clippy allowances. #921 Alpha owner waiver is not Beta
  acceptance. Do not overwrite these branches or bypass protected review.
- The original planned baselines and old candidate run 40888591935 do not prove
  this changed source. No version bump, candidate dispatch or publication yet.

### Engineering checkpoint, 2026-10-29

The draft source PR prepares Alpha/Beta identity, exact AppImage inspection,
strict CI reuse and recording verdicts, the acceptance contract, Linux gate
runner and first-run setup. These are engineering changes, not passed physical
acceptance rows. The initial source gates passed typecheck, lint, format, build,
JS/Rust advisory audits and 2,763 Node tests with no skips; onboarding added
155 passing focused desktop tests and 121 script tests. The production frontend rebuild passed. The bounded full desktop run passed
577 files and failed the Studio integration file; the test fixture omitted
the backend ready/listener handshake before sending an agent intent. With that
fixture corrected (no timeout or production change), all 198 tests in the
remaining file pass. One unrelated skipped desktop test remains a skip, not
acceptance evidence. The cold backend build is still running. Caption
enablement is being investigated separately and is not certified by these results.

GitHub rejected the push because the current OAuth credential lacks the
`workflow` scope. The release-workflow exit fix and its executable Bash
regression tests are retained in the local
`local/linux-beta-including-workflow` branch and pending worktree changes;
the draft source PR excludes those two files so its remaining work is
reviewable now. **The workflow fix must land before a Beta candidate build.**
Its exact shell change captures `status=$?` inside `else`, before leaving the
failed `if` command. Ordinary failures must fail; only 137/143 get one retry.
The corresponding test executes both actual YAML shell blocks against success,
ordinary failure, killed retry success and killed retry failure.

Main subsequently advanced to `c2d1eaffbaca2f09b553ca8300db6cf5b937fac0`,
merging #915, #920, #922–#928. Those upstream fixes are now merged into the
implementation branch. Rerun affected gates before freezing the candidate.
They address the earlier overlaps;
their merge does not supply the new candidate's physical acceptance.

Draft source PR: https://github.com/TheOrcDev/videorc/pull/930.

### Engineering checkpoint, 2026-10-30

Candidate storage now requires exact HEAD lengths and streams every uploaded
or reused object back through SHA-256 verification. A missing post-upload
object, incorrect metadata, partial/compressed response, short body, excess
bytes or mismatched content fails. Requests and body reads have deadlines.
The 60 focused release tests pass, including stored-byte negative cases.

Live Linux microphone replacement is a local implementation draft, pending
backend/runtime gates. The shared bus keeps output identity and supports
replace/remove; direct FFmpeg inputs remain refused. A maintained Pulse smoke
uses two owned null sinks/remapped sources, verifies 440/880 Hz identities in
encoded output, None, loss, failed replacement, duplicate fencing and unchanged
encoder/RTMP identity. Its fixture lifecycle and measurement tests pass (13);
the real fixture itself produces both exact tones through this host's Pulse
server and cleans up its owned modules/processes. That is fixture evidence
only: the complete app smoke, physical microphones, recording matrix, latency
and cross-platform regression gates have not passed yet. Camera and screen
replacement remain unsupported.

### Web and storage checkpoint, 2026-10-30

Web companion: https://github.com/TheOrcDev/videorc-web/pull/101
(`feat/linux-beta-downloads`, isolated from the original web checkout).
It adds an explicit, independently disabled Beta state; exact channel/source
manifest validation; public-stage plus pinned PASS requirements; stable Beta
manifest configuration; truthful download/guide copy; public Linux update routes
that validate the selected origin's accepted manifest; and a separate
operator-bearer Beta pilot streaming proxy with range validation. Alpha remains
the default. No production configuration or deployment changed. The website
checks manifest claims; protected publication still must verify full evidence
and exact feed/artifact bytes. Packaged pilot enrollment and real update/rollback
rehearsals remain open.

### Runtime investigation, 2026-10-30

The debug backend build completed (SHA-256
`d756ca3fe639016bc909a9d0c463f86ec2582c19d893e8c9b872c1b3df611fe0`), and
the fake-service caption transport contract passed. These are development
results from dirty source, not candidate acceptance. The OpenH264 1080p30
matrix passed its format/profile checks, but its static-source run reported
700 ms freeze, a 20-frame repeat run and 6.678 s silence. It does **not** pass
the Beta motion/audio budgets; no thresholds changed.

The real renderer/local RTMP caption smoke produced a correct clean recording
and captioned copy but zero caption pixels in the received stream. Linux's raw
bridge had no auxiliary caption picture. A draft now supplies separate clean
and captioned CPU YUV feeds for matching profiles up to 30 fps. It remains
unaccepted pending Rust and final-artifact gates. Other split profiles and dual
orientation remain restricted. The microphone smoke also failed because its
synthetic-only disconnect RPC cannot operate a real Pulse worker. Its draft
now disconnects/restores only the owned fixture source and reads a separate
admin-only timing receipt bound to the session and encoder process. Raw Linux
output timing and exact shared tee fanout are being added to that inspector.

A separate real Pulse fixture probe found PipeWire moving FFmpeg to the system
default input when the named source disappeared. Per-child
`node.dont-reconnect=true node.dont-fallback=true` properties closed capture
with no further PCM in the repeated probe. The draft applies them to workers,
direct-input fallback and meters, leaving playback and system settings alone.
The complete app loss/replacement gate still has to pass. These properties are
specific to PipeWire (the supported desktops' default); they do not certify a
native PulseAudio server's loss behavior.

First-run acceptance remains open: a prebuilt renderer completed five initial
checks before a screenshot timeout on a static reduced-motion frame. A draft
view-screenshot retry has not passed. A later run inadvertently rebuilt the
backend with inconsistent Cargo profile settings; that owned process group was
stopped. Use the same bounded Cargo settings for prebuild and app launch.

The web companion #101 merged normally at
`4f758dbd3b95f676d06218b7be606347c6b1b0a2` after all three checks passed.
Production deployment and Beta availability have not been verified or enabled.
Desktop #930 remains draft. Its Linux job on `06d0f4c` was interrupted with
exit 143 during Rust compilation, after policy and Clippy passed; a job-only
rerun was requested. Neither that interruption nor a successful skip proves
Rust execution.

Web typecheck and lint passed (five existing lint warnings); the focused
cross-platform download/update suite passed 115 tests, and the final Beta/card
delta passed 17. The full web suite passed 1,131 tests, with four skipped and no
failures. Skips are not acceptance evidence. The direct framework production
build passed with a clean environment, without database migrations or deployment
credentials. The web PR is ready for review; this does not enable Beta.

Candidate planning now also parses the actual `release.json` file and rejects
any difference from the manifest whose identity was validated. A correctly
hashed but semantically different manifest cannot be uploaded as that candidate.
Sixty focused release tests pass, including source/hash/stage/acceptance drift
and harmless JSON ordering. Runtime caption/microphone drafts remain uncommitted
until app gates run; the optimized debug backend is still compiling.

The current full desktop Node suite also passed all 2,783 tests with zero
failures/skips, using the new web checkout for cross-repository contracts.

Web PR #101 merged normally at
`4f758dbd3b95f676d06218b7be606347c6b1b0a2` after all three checks passed;
the merge tree matches the tested branch. No Beta availability configuration
changed, and production deployment remains unverified.

### Windows regression gate correction, 2026-10-30

PR #930 run `40974150748`, installer job `123798234376`, built the installer
and passed packaged recording/native-preview checks, then failed the window
recovery smoke. Its uploaded app log explicitly reports that the hardened
production package ignored `VIDEORC_REMOTE_DEBUG_PORT`. Retrying cannot fix that
test/package mismatch. The recovery command now prepares a separate test-only
directory, validates production hardening and test fuses, and verifies that the
production executable/app.asar hashes remain unchanged. The recovery evidence
is explicitly test-build evidence; the original installer is never rebuilt with
hooks enabled. Direct invocation against production fails immediately with an
actionable explanation. Twenty-four focused hardening/recovery tests pass.
The full current Node suite passed 2,792 tests with zero failures/skips; lint
and formatting passed. The Windows package/recovery run remains required;
Linux unit tests do not supply Windows execution evidence.

The next Windows run, `40977608889` / job `123809760536`, successfully built
and hardened the separate test package. Crash recovery passed, but default,
clear and software-rendering scenarios could not read runtime information.
The uploaded app log rejected renderer IPC. Node registered the trusted
short-path document with `RUNNER%7E1`, while Electron 39's `loadFile` loaded
`RUNNER~1`. A reproduction using both URL formatters confirmed the mismatch.
The document policy now canonicalizes percent-escaped unreserved ASCII only
for file URLs; sender, role, main-frame and exact-document checks still apply.
Encoded separators/delimiters, different files and remote URLs remain refused.
All 82 focused authorization/preload/IPC tests pass. Full source verification
passed typecheck, lint and formatting. The bounded desktop suite passed all
582 files: 6,383 tests passed, with one Windows-only OBS junction test skipped
on Linux. That skip is not Windows evidence; a fresh Windows installer/recovery
run and the platform-specific test remain required.

The Linux rerun on the older `06d0f4c` head also ended with runner shutdown
and exit 143 during Rust test compilation (job `123812040834`). Policy and
Clippy passed; Rust tests never executed. This is not a test pass or an observed
source failure. Current-head CI must replace that incomplete evidence.

### Public promotion preparation, 2026-10-30

The read-only Beta promotion planner passes 79 focused release/acceptance tests,
including a real temporary Git repository, pinned record reads, ancestry/version
refusals, changed candidate/evidence bytes, incomplete acceptance and short
pilots. Focused ESLint and formatting passed. The full worktree Node suite passed
all 2,820 tests with zero failures or skips, using two workers and the isolated
web checkout (including the locally preserved workflow regression tests).
These artificial contract tests do not supply physical acceptance or authorize
storage publication. No real
candidate has been accepted and no public object or availability setting changed.

Linux CI run `40983512321` on `aa6fff68` again received a runner shutdown
signal, ending with exit 143 during test compilation after FFmpeg checks and
Clippy passed. The job lasted six minutes, below its 45-minute timeout. No Rust
test result exists. A job-only retry was requested for job `123829230084`.
The required Windows storage correction below subsequently needed a new head;
current-head Linux Rust execution remains required.

### Windows diagnostic observation, 2026-10-30

Run `40983512504`, job `123829383523`, passed the debug backend build,
OpenH264 comparison, Media Foundation diagnostic step and controlled-audio
incident matrix. The independent FFmpeg-tone control failed its stream receiver
artifacts: A/V stop tails were 117–267 ms against the unchanged 100 ms limit;
some frame counts missed the unchanged 2% budget by reaching 2.1–2.3% error.
Record-only controls passed. GitHub retained the control evidence as artifact
`12948646220` for 14 days. This remains failed diagnostic evidence, not a PASS.

The existing release runbook's “Known-bad CI checks” explicitly excludes
`Windows startup incident diagnostics` from release source/signing gates and
says not to repair it as part of cutting a release. No thresholds or workflow
requirements were changed here. The actual Windows source and installer gates,
plus Linux exact-candidate quality acceptance, remain required. This diagnostic
failure does not establish a regression from the file-URL authorization fix.

The hosted macOS Rust job in run `40983512345` (job `123829603675`,
`macos-15`) passed its advisory audit, format check and Clippy, then reached
the 75-minute job limit during test compilation. No test execution/result
appears in the log. The process/memory sentinel never ran, so its upload step
subsequently found no report. This is incomplete macOS test/sentinel evidence,
not a source-test failure or a PASS. The runbook already excludes this hosted
job from release completion; relevant shared-platform regression evidence is
still owed. No timeout, test, or acceptance threshold was changed.

### Windows required source-gate correction, 2026-10-30

Run `40983512504`, required source job `123829383691`, passed Clippy and
both sets of 25 stability passes. Its first full Rust pass failed
`storage::tests::delete_quarantine_folder_that_is_not_a_directory_never_moves_the_file`:
4,111 tests passed, one failed, and 20 were ignored. Later source steps were
skipped. This is a required source failure, unlike the excluded diagnostics.

The directory guard previously returned a blocked deletion when a regular file
occupied the quarantine directory name. Unix rejects the earlier child lookup
with `NotADirectory`, while Windows can report `NotFound` and reach that guard,
so the test's expected error depended on the OS. The guard now explicitly errors
on a regular-file collision and propagates metadata inspection errors. The
existing no-move/no-byte-change assertions remain; the same test now exercises
the guard directly on every platform. Symlink blocking remains intact.

The exact regression and all 144 storage tests passed on Linux with zero
failures or ignores. This used the current full backend test source in an
isolated, unoptimized Rust test executable with the existing Cargo dependency
artifacts; it is focused functional evidence, not Windows or performance
acceptance. Rust formatting and diff checks passed. Optimized Cargo compilation,
full backend tests and Clippy remain in progress or queued.

Fresh Windows source and installer execution remains required. No test was
ignored and no quality threshold or release requirement was relaxed.
