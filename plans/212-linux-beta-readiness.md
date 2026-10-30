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

| Feature                            | Current finding                                                                                   | Required completion                                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| System audio                       | Linux unsupported                                                                                 | Implement and prove before broad streaming Beta, or obtain an explicit narrower scope decision.             |
| Live camera/mic/screen replacement | Shared-bus microphone replacement passes development artifact checks; camera/screen still refused | Finish camera/screen replacement and exact-candidate physical recovery evidence.                            |
| Captions                           | Shared PCM bus enabled; fake contract and rendered local-stream/recording artifacts pass          | Exact-candidate physical microphone, supported-profile and packaged acceptance still required.              |
| Separate source recordings         | macOS-only                                                                                        | First Beta may explicitly exclude; keep unsupported controls guarded and publish limitation.                |
| Preview                            | CPU/BMP proof presenter                                                                           | Native GPU rewrite is not required; real pixels, cadence/liveness, lifecycle and honest diagnostics are.    |
| Soundboard                         | Normal Linux worker PCM bus supported; direct Pulse fallback cannot mix                           | Prove shared-bus mix and fallback warning.                                                                  |
| First run                          | Linux setup enabled with sharing guidance; full development smoke passes                          | Packaged physical proof and real OAuth still required.                                                      |
| Notes protection                   | Capture exclusion unsupported                                                                     | Tell users Notes may be captured; prove behavior.                                                           |
| Split profiles / dual orientation  | Restricted encoded paths                                                                          | Inventory actual combinations, implement/prove supported cases and explicit refusals; keep docs/UI aligned. |

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

A further owned-tone check on ogre shows that Pulse-compatible playback
clients' `pipewire.sec.pid` names the Pulse server (PID 954 in this run), not
the player. Their `application.process.id` matches the player normally but
accepts a deliberately false `PULSE_PROP` value of 1. It is not authenticated
process identity and cannot by itself establish Videorc/Electron exclusion.
Receipts: `/tmp/videorc-beta-pipewire-peer-identity-kUCPWP/report.json` and
`/tmp/videorc-beta-pipewire-peer-spoof-ekDjSE/report.json`. Both use only two
owned tones/null sinks and close their own fixtures; no default routing changes
or production capture occur. The production design must account for this
Pulse-server indirection rather than trusting the advertised process ID.

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
  The publication transaction core now checks every origin's immutable bytes
  before any pointer write, rejects downgrade/same-version drift, uses strong
  ETag or create-only conditions, publishes mirrors before the primary, and
  requires durable intent/readback/completion records. Ambiguous writes retain
  their generation; recovery inspection only compares prior/intended bytes.
  The journal state machine now persists a generation through a required private
  compare-and-swap store. Completion retains the lock until the protected caller
  acknowledges the exact successful finalizer result; a lost completion response
  therefore cannot admit a new publisher. Missing journals require explicit
  provisioning/recovery, and initialization cannot overwrite an existing journal.
  It revalidates stored receipt/intent identity and origin order after reload.
  The private journal now has an S3 adapter with a separate credential namespace,
  a reserved private prefix, signed conditional writes and exact body/ETag readback.
  It never retries or adopts an ambiguous write. Its explicit capability probe
  exercises create-only, stale-update and concurrent-update conditions on a fresh
  private probe key; it cannot provision or release the publication journal.
  The adapter has no CLI and has only run against artificial test transports.
  These modules have no publication credentials. Their
  public-pointer S3 adapter now hashes actual immutable GET bodies and signs
  conditional pointer writes, with bounded requests and reads. It is bound to
  the exact plan and configured origins and has only artificial-transport test
  evidence. Protected coordination, immutable artifact upload, storage capability
  proof, pilot enrollment and updater/rollback proof remain open. The planner does not alter the
  release-controller setting.

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

### Runtime compilation and publication transaction, 2026-10-30

The configured backend test build completed in 162 minutes. It includes the
caption split, live microphone and output-timing drafts, but predates the later
storage correction. Twenty focused runtime tests passed with no ignores in
that optimized backend test executable. The alternate unoptimized executable
overflowed its test-thread stack in the timing RPC test; the normal executable
passes that exact case. No core dump or OOM event was found. This remains a
limitation of that temporary unoptimized harness, not packaged evidence.

The broader optimized snapshot run executed 4,092 tests: 4,071 passed, two
failed and 19 were ignored. The source-derived RPC inventory found the missing
`audio.test.output-timing` execution policy. The draft now classifies the
read-only receipt as an Observation and asserts that choice in its authority
test; recompilation is still required. The other failure is the real GLES
Beams/studio golden comparison on the explicitly approved Intel renderD128:
mean pixel error 20.405, maximum 193, against unchanged limits 2.0 and 10.
The reference was captured through ANGLE/Metal on Apple M4. A temporary
two-pass GLES probe using the actual generated shaders/uniforms reproduced
that exact error on Intel UHD 630. Higher sampler precision had no effect;
CPU-derived lane-hash variants reduced but did not meet the limits. Exact
integer permutation and gradient variants had no effect, ruling out those
modulo/rounding hypotheses for this reproduction. No shader,
golden fixture or tolerance was changed. This visual correctness gate remains
failed. The quarantined renderD129 was not selected or opened for rendering.

The publication transaction core is tested against artificial storage/journal
adapters, including the actual verified planner's output. It binds claims to
the exact plan and configured origins, checks all immutable objects before
writes, refuses missing/inconsistent/downgraded pointers, and uses conditional
writes plus readback. Lost PUT/journal/completion responses preserve the
unresolved generation. Recovery refuses foreign generations or pointer bytes;
it neither unlocks nor retries writes. These tests do not provide a production
storage adapter, workflow authorization, actual acceptance or publication.

The fresh full worktree Node suite passed 2,834 tests with zero failures/skips.
The latest 48 focused release tests also pass with no skips, including planner/core
integration, bounds checks, and the two asynchronous caller/journal mutation
regressions added after the full suite loaded this module. Focused ESLint,
Prettier and diff checks passed. Optimized current-source backend compilation,
Clippy and full Rust execution remain in progress or queued. No runtime draft
is accepted on the strength of source tests, and no Beta has been published.

### Fresh committed-head CI, 2026-10-30

At `8251f911`, Linux run `40993109799`, job `123860005093`, passed the
executed FFmpeg policy/provisioning, Clippy and Test steps. The separate skip
job is not reused as evidence. Windows run `40993109705`, installer job
`123860022266`, passed the build and packaged capture-worker, live microphone,
recording A/V, screen/BMP preview, recording-preview continuity and renderer
crash recovery steps. This verifies the previously failing installer path.
Neither job includes the current uncommitted microphone/caption drafts.

The JavaScript job also passed. The independent Windows source gate and hosted
macOS Rust job were still running at this observation. Windows startup incident
diagnostics failed again; that runbook-excluded job still cannot count as a
PASS. Required source and physical/runtime acceptance remain separate. The
existing watched head is left running while the next tested slice is prepared.

### Publication journal and runtime queue, 2026-10-30

The journal now implements the transaction core's claim, intent, receipt,
completion, unknown and pre-write abandonment protocol against an injected
private conditional store. Its tests model independent coordinators, process
restart, lost responses, malformed stored state, changed receipts and missing
journals. An unknown generation remains locked. Completion is deliberately
separate from acknowledgement: only a protected caller that received the exact
successful finalizer result may acknowledge it. A lost acknowledgement response
is inspected through durable completed history, never retried automatically.
Initialization is a separate provisioning operation, permitted only after the
protected operator establishes that no prior Beta publication exists.

This is tested state/transaction logic, including the actual promotion planner's
output. A production private store adapter, conditional-write capability proof,
protected workflow and explicit unknown-generation recovery remain required.
No production journal was provisioned and no public pointer was written.
The full worktree Node suite passed all 2,849 tests with zero failures/skips;
the latest 61 focused release tests passed, including canonical receipt hashes
across store serialization and lost acknowledgement inspection. Focused ESLint,
Prettier and diff checks passed. These are artificial transaction/store tests,
not proof of any production storage provider or physical candidate.

Clippy completed successfully with the four existing Linux CI platform
allowances. The earlier backend build also completed, but predates the latest
RPC execution-policy correction. A single queue now rebuilds all backend bins,
checks a digest of every Rust/Cargo input before/after compilation, then runs
the fake caption contract, Linux Pulse microphone replacement/loss modes,
caption pixels through local RTMP, development first-run smoke and full Rust
tests. It uses isolated data/evidence and explicitly pins approved renderD128.
The prior queued test command was intentionally stopped before it spawned
children so these app smokes run first; its exit 143 is not a test failure.
Current runtime results are still pending. No release readiness is inferred
from the successful compilation or Clippy result.

### Current-source runtime findings and journal transport, 2026-10-30

The fresh source-checked backend build passed, as did the fake caption transport
contract. Linux Pulse microphone replacement/loss passed both recording-only
and streaming-only modes with two decoded source identities, intentional silence,
duplicate fencing, one encoder and monotonic packet DTS. The combined mode was
refused because the harness requested 640x360 recording against a 1080p stream.
The harness draft now requests matching profiles; its artifact gate still needs
to pass. Caption-live stopped before its pixel gate because the harness checked
Studio's session pill while the fresh profile showed the Library. First-run
passed initial setup, motion and reduced-motion checks, then timed out capturing
a CDP platform-view screenshot. Draft fixes open Studio explicitly and capture
Electron web contents on Wayland; they are not accepted runtime evidence yet.

The attempted app rerun collided with the full Rust suite's Cargo build lock:
development launches invoke `cargo run` even when prebuild is suppressed. The
microphone and caption reruns timed out before backend readiness and therefore
provide no new runtime behavior evidence. Run these app gates sequentially after Cargo releases
the lock. The full current-source Rust suite is still compiling. Rust source
remains frozen during compilation; analyzer/first-run logic tests passed all 133
cases with zero skips. No physical acceptance row is closed by these dev runs.

The new private S3 journal adapter signs the exact body checksum and conditional
headers, requires strong ETags and bounded uncompressed GETs, and compares both
readback bytes and generation. Missing/stale conditions fail; ambiguous PUTs do
not retry or adopt a later observation. Bounded reads clean up owned Node/Web
streams. Separate journal instances use the real journal state machine against
an artificial S3 transport to prove only one claim wins. An explicit capability
probe uses fresh private objects and verifies concurrent CAS; no real storage
probe, journal initialization or public write has run. The full Node suite passed
all 2,865 tests with zero failures/skips, including 16 new adapter tests. Focused
ESLint, Prettier and diff checks passed. Private IAM/durability provisioning and
protected coordinator integration remain required.

Windows startup incident diagnostics on `598a29b0`, job `123889294179` in run
`41002230883`, again failed all 36 independent FFmpeg-tone stream controls:
stop tails 114–267 ms against 100 ms, with some frame counts 2.1–2.3% off against
2%. All 12 recording-only controls passed. Artifact `12955554639` retains that
evidence. The release runbook excludes this diagnostic job from routine release
gates; this failed result remains recorded and no limit was relaxed.

### Microphone and caption runtime proof, 2026-10-30

The current-source Rust suite finished with 4,072 passed, one failed and 19
ignored. The timing receipt's execution-policy and authority tests now pass.
The remaining failure is the GLES Beams reference mismatch described above;
Cargo stopped on that main test binary, so the package suite did not pass.
An explicit subsequent backend build re-established the development binary's
identity before app testing. Its SHA-256 was
`3aeea22340efa17610c351fc1f7b339c6d73414af63bdb63e83d8867ded6fc8d`;
the queue checked the Rust/Cargo source digest and binary hash at each step.
These are dirty-worktree development measurements, not a release candidate.

The fake caption transport contract and the real renderer/local RTMP caption
smoke pass. The latter verifies mute and +6 dB gain ordering, API retry without
replacing the output process, caption pixels in the received stream, a clean
original recording, the SRT and captioned recording copy, and silence after
producer loss. The Linux raw-video split supports matching horizontal profiles
up to 30 fps; unsupported splits remain refused. Direct microphone input cannot
provide the caption bus and is not silently accepted.

All three Linux Pulse microphone modes now pass: recording, streaming and
combined. Owned null-sink fixtures feed 440/880 Hz through production capture
workers. Decoded artifacts prove replacement, None and loss silence, duplicate
fencing, one encoder and monotonic DTS. The fixture stays unplugged while the
smoke observes Linux's automatic recovery attempt fail without changing the
confirmed source or output process; only then does it request another switch.
This avoids racing recovery, without ignoring Busy errors or weakening audio
measurements. Per-child PipeWire properties prevent capture silently moving to
the default microphone on source loss. Sixteen focused analyzer/fixture tests
pass with zero skips. Real device/operator acceptance remains open.

The named-box 1080p30 matrix passes for both forced OpenH264 and approved Intel
VAAPI, including color tags, level and stop tails (1 ms and 8 ms respectively).
This debug-backend subset is not full-profile, motion, release pacing or physical
acceptance. The Linux proof-presenter lifecycle gate passes 100 cycles with clean
owned-process teardown and no budget failures. The enforced record-latency gate
stops before measurement because its first Clips buffer-only session stays off;
there are no passing latency samples. First-run remains under investigation:
its production-style prebuild passed motion, sound, saved look and restart but
lacked the development diagnostic hook for replay. Both the ordinary Vite run
and an explicitly bundled development renderer then remained at `starting`
with zero backdrop draws at the deadline. The latter's Electron window was
visible and focused with a nonzero canvas size and no renderer exception.
That narrows the investigation beyond module loading; first-run is still not a
PASS. The harness diagnostics remain a separate local draft. No startup budget
was relaxed.

Private development receipts are retained in the source-checked runtime queues
under `/tmp/videorc-beta-verified-runtime-F8LKyj`,
`/tmp/videorc-beta-recovery-runtime-bi6q7h` and
`/tmp/videorc-beta-broader-runtime-3RwLc3`. They must not be substituted for exact
AppImage evidence. The generic recording-studio aggregate includes unavailable
macOS ScreenCaptureKit/Metal gates; its Linux-adapted full coverage, real devices,
full matrix, latency and packaged checks remain incomplete. No skipped macOS
check counts as Linux acceptance. System audio, live camera/screen replacement,
publication wiring and the physical/pilot/update gates remain open.

### First-run choices and runtime diagnostics, 2026-10-30

Hyprland's sleeping display explained the zero-frame first-run observations:
the output reported `dpmsStatus: false`, while Electron still reported a
visible, focused window. Chromium's animation clock stayed at zero. Waking
the output restored animation under the unchanged budget. This is a host
precondition, not a shader fix or accepted presentation evidence. The smoke
now retains animation/visibility counters and captures Electron web contents
on Linux instead of the unreliable platform-view screenshot route.

The awake smoke exposed a real setup race: clicking a layout and then a
background could restore the previous layout. Each control now sends only
its changed fields; the provider merges against current state after the lazy
module loads and synchronizes its refs before another queued choice. Rapid
choices and reversals pass regression tests. Actual app checks preserve the
chosen look through completion, restart and replay, including dark and light
setup flows. An isolated Skip setup probe also passes. Two whole-run attempts
still failed during later fresh-profile attachment, before the renderer
mounted. The harness now waits for its renderer hook within the existing
180-second launch deadline; the mount-to-motion limit remains three seconds.
The full smoke with that readiness barrier passed all 51 development steps on
`9f65ce1f`, including dark/light setup, completion, restart, reopening setup,
and the fresh Skip profile. Its report is
`/tmp/videorc-beta-readiness-reprobe-mbNKxs/first-run/videorc-first-run-nYnhMt/report.json`.
Real OAuth is explicitly skipped by this development smoke and remains open
for packaged acceptance.

One five-cycle enforced Clips latency run passed: cold start 202 ms, warm
start p95 200 ms, stop p95 145 ms and finalization p95 132 ms, with every
artifact checked. A subsequent fresh run reproduced the initial Clips
failure. Its saved snapshot shows a connected, unblocked renderer, a live
test pattern and explicit Clips intent, but three failed startup attempts.
The successful run does not establish reliability or pass the stronger
whole-file motion gate added below.
The failure report projects readiness fields instead of saving destinations
or resource capabilities. Receipts are under
`/tmp/videorc-beta-clips-diagnostics-cHWG41` and
`/tmp/videorc-beta-first-run-regression-bV5Iog`.

Both named-box 1080p30 encoder subsets pass again. The current setup changes
pass 56 focused desktop tests and 158 first-run/latency/command-client Node
tests with no skips; typecheck, lint and formatting pass. The full desktop
suite passed 582 files and 6,385 tests, with one Windows-only OBS path test
skipped on Linux. The production frontend build also passed. These ran
sequentially after the runtime measurements and retained unchanged backend
and Rust-source hashes; logs are in the same regression directory above.
These remain development/debug results. Physical AppImage,
real OAuth, full profile, endurance and pilot acceptance remain open.

### Latency fixture correction and cadence failures, 2026-10-30

The private Clips error probe captured `session-start-failed`: the camera
preview had no frames. A follow-up projection showed that capture config,
working visual, confirmed visual and persisted scene all contained
`screen-camera`, despite the smoke's earlier screen-only storage seed. The
video preset remained 1080p30. Initial working-scene persistence can race that
seed/reload; this failure was not proof of an encoder-start defect.

The maintained latency smoke now invokes the same layout action as the UI
and waits for both the renderer's completed layout transaction and the
backend's visible synthetic-only scene. Observing the backend's trial scene
alone is insufficient: an intermediate probe started before confirmation,
then the renderer restored screen-plus-camera and refused Record. Regression
tests reject both stale/pending renderer state and a live pattern accompanied
by a visible camera. Failure snapshots retain reduced layout state.

Clips starts after this correction, but recording cadence remains failing.
The first corrected take had six identical startup frames and a 433 ms
whole-file freeze. A diagnostic repeat passed the startup motion check but
had a 367 ms freeze and ten identical frames later in the take. The latency
smoke now requires motion over the entire artifact and at least 98% requested
duration coverage; its previous whole-file check only warned about freezes.
The final run with renderer-transaction confirmation still failed at three
identical startup frames (limit two). No timing or quality limit was relaxed.

Evidence: `/tmp/videorc-beta-readiness-reprobe-mbNKxs/replay-errors`,
`/tmp/videorc-beta-replay-scene-sPzubt`,
`/tmp/videorc-beta-latency-scene-fixed-H6mEOc`,
`/tmp/videorc-beta-latency-cadence-cntxb9` and
`/tmp/videorc-beta-latency-scene-fixed-tdB9kj`.
The diagnostic run observed the raw-YUV bridge; its first Record and Stop
also exceeded latency budgets. These are failing development observations,
not accepted evidence. Thirty-seven focused Node tests and lint pass.
The corrected Clips-off baseline passed the first four artifacts but failed
the fifth: a 267 ms freeze and seven identical frames. Its measured starts
and stops also exceeded budgets (cold 1,149 ms; observed warm up to 473 ms;
Stop up to 821 ms). The cadence defect therefore is not confined to Clips
handover. The host was on battery; no power setting was changed, and that
observation does not waive the failure. VAAPI latency, full profile matrices
for both encoders and the broader Node suite continue sequentially under
`/tmp/videorc-beta-profile-regression-ucVwWu`; their outcomes remain pending.

### Full-profile fixture and motion gates, 2026-10-30

The completed VAAPI latency run passed all five strict startup/whole-file
artifact checks, but failed timing: cold 2,243 ms, warm start p95 979 ms,
Stop p95 825 ms. Finalization p95 1,091 ms passed. Its backend timelines
attribute 291–341 ms to admission/Clips handover, 163–172 ms to microphone
worker preparation and 361–476 ms of Stop to waiting for FFmpeg exit. These
are diagnostic observations, not waived budgets or release-build evidence.

The full OpenH264 matrix completed with only 2/18 cases passing. Most starts
were refused by an unexpected portal picker; the hard-content 1080p60 take
ran but delivered approximately 27.7 fps. The harness supplied test-pattern
params only to the backend, leaving the renderer's source selection stale
when it automatically re-armed Clips. The matrix now selects synthetic input
through the renderer, commits screen-only layout and checks the backend scene
before starting its unchanged profile inventory.

The original VAAPI matrix also exposed false-positive motion results: among
its early passing profiles, 1080p60 had seven identical frames and a 217 ms
freeze, and 4K30 had sixteen identical frames and an 800 ms freeze. Container
fps alone is insufficient. Ordinary profile gates now enforce motion; the
existing 4K noise survival and deliberate FIFO-pressure contracts are kept
separate. Twenty-eight focused matrix fixture/profile tests pass with zero
skips, and changed-script lint passes. Full corrected runtime results and
the broader Node suite remain pending. No AppImage or physical acceptance
claim follows from these debug-backend observations.

### Corrected matrix results and automatic Clips-start race, 2026-10-30

The corrected OpenH264 full matrix ran every case without the unexpected
portal picker. Seven ordinary profiles passed: 540p30, 720p30, 1080p30,
vertical-1080p30, floor-360p24, vertical-720p30 and vertical-540p30. The
existing hard 4K30 survival-only case also passed, for 8/18 total; that
survival contract does not establish moving-content acceptance.
Higher profiles still fail real artifact motion. Examples include 1080p60
at 733 ms frozen/42 identical frames, 1440p30 at 633 ms/15 frames and 4K30
at 1,467 ms/40 frames. The 1440p60 take saved 5.783 seconds against the
5.88-second minimum. The legacy 4K60 path saved only 1.883 seconds of the
six-second take and lacked keyframe evidence. Hard 1080p60 delivered about
20.9 fps. Diagnostics show both CPU composition and downstream writer/encoder
pressure. No output profile or acceptance budget was removed or relaxed.
The receipts are under `/tmp/videorc-beta-matrix-fixture-runtime-OPjuIr`.

VAAPI initially timed out before the first recording. Three fresh focused
runs then failed/passed/failed: one renderer confirmed screen-only while the
backend still exposed a camera; another reverted to screen-camera. The
matrix now retains its last renderer state, visible backend source kinds,
phase, elapsed time and causal error, and refuses another mutation after the
existing deadline. It no longer reduces that evidence to a final 1 ms HTTP
timeout. Thirty focused fixture/profile tests pass with no skips.

Automatic Clips starts crossed lazy loading and output-folder authorization
with a render-time scene snapshot. A delayed request could therefore carry
an older layout or race a newer recording. Starts now read the current
scene/config after lazy loading, wait for source/layout transitions, and
cancel before dispatch if the captured intent, scene, settings or session
state changes. Cancellation schedules fresh reconciliation without consuming
the failed-start retry budget. Four unit cases and two real StudioProvider
regressions cover supersession at authorization, the replacement layout,
Record taking over, request shape and genuine authorization failure; the
existing source-change re-arm integration also passes.

After this guard, three fresh VAAPI 1080p30 app processes each committed the
synthetic-only scene and passed strict artifact analysis. Reports are in
`/tmp/videorc-beta-replay-guard-runtime-kmptyu/queue.json`. They retain backend
SHA-256 `3aeea22340efa17610c351fc1f7b339c6d73414af63bdb63e83d8867ded6fc8d`
and Rust/Cargo source digest
`95e8a9a25b5447178b69218a13a28b01b36fef37304e074b9d895206705073df`.
These are development observations, not exact-AppImage acceptance.

The full VAAPI follow-up completed at 10/18: nine ordinary profiles and the
existing hard 4K30 survival case passed. Failures include 1080p60 at 183 ms
frozen/seven identical frames, 1440p30 at 167 ms/four frames, 1440p60 at
367 ms/20 frames and 4K30 at 733 ms/eight frames. Legacy 4K60 saved only
2.167 seconds of the six-second take. Hard 1080p60 froze for 600 ms and
repeated 31 frames. No scene-selection failure occurred in this full run.
The host was on mains power; its configuration was not changed.

VAAPI Clips latency completed all five strict artifact checks but failed
cold start (1,953 ms), warm start p95 (847 ms) and Stop p95 (967 ms).
Finalization p95 passed at 641 ms. OpenH264 Clips latency failed the first
artifact's startup-motion contract with four identical frames. The guard
therefore improves scene consistency but does not establish cadence or
latency readiness. Reports are under
`/tmp/videorc-beta-replay-regression-Wc4WGx`.
Typecheck, lint, formatting and all 2,886 Node tests pass (zero Node skips).
The remaining desktop suite was deliberately stopped when main advanced to
`9028bec9` (Plan 210); the old frontend build was not run. The partial suite
is not a pass. Owned process IDs and the interruption receipt are retained
beside the queue report. Validation restarts on the merged source below.

### Main integration, 2026-10-30

Main `9028bec9` adds app scenes and Hide screen. Both plan-index entries are
retained. Its scene/capture changes and the Linux caption, microphone and
Clips changes merge without a source conflict; only the plan index required
manual resolution. Every subsequent runtime pass needs a freshly compiled
backend for this source, not the earlier binary hash.

Hide screen is now also part of Linux physical acceptance: verify the frosted
still on Preview, recording, every supported stream leg and Clips, including
Hide/Show across start/stop and source recovery. Legacy paths must refuse the
unsupported combination rather than expose live screen pixels. App-following
features remain subject to their platform capability guards. The maintained
smart-scenes smoke requires macOS fixture apps and cannot certify Linux;
its Linux skip is not acceptance. Main's follow-up `ab82c61a` is also merged;
it accepts the new screen-command receiver type in the Linux PipeWire loop.

Merged-source verification passes 85 focused desktop tests, 61 focused Node
tests and 11 StudioProvider integration cases. One fixture incorrectly made
an absent account-refresh capability into a callable no-op with an invalid
return value; keeping that optional capability absent restores the existing
backend fallback without removing the error assertion. Typecheck, lint and
all 2,917 Node tests pass (zero Node skips). Formatting and the frontend
production build also pass. Full desktop tests are running on the merged
source. Rust formatting passes. An additional `cargo clippy --all-targets`
probe failed on 95 test-target lints; its log is retained and no pass is
claimed. The repository's standard production-target Clippy command, with
its existing four Linux allowances, is queued behind the new backend build.
Neither Rust check nor the new backend build is reported as complete.
Logs use the `/tmp/videorc-beta-main-merge-` prefix. The old runtime binary is
not used for this merged source; fresh backend provenance is recorded in
`/tmp/videorc-beta-main-merge-backend-provenance.json`.

### Account fixture and desktop regression follow-up, 2026-10-30

The delayed exit-143 notification for
`/tmp/videorc-beta-replay-regression-Wc4WGx` matches its recorded intentional
interruption after main advanced. Its earlier matrix and latency failures
remain failed evidence; the interrupted desktop step is not a pass.

The merged-source StudioProvider file then reported 65 failures, beginning
with its combined boot/sign-in/recording case and followed by overlapping
React `act` calls. An isolated trace showed the fake backend acknowledged
sign-in but returned its old signed-out snapshot on the next account refresh.
The fixture now persists the successful exchange before replying, as the real
backend does. The test asserts both the persisted and observed identity.
Its transport/provider/acknowledgement retries use a controlled clock and
wait for lazy imports to settle; four OAuth attempts, both acknowledgements,
record/start/stop assertions and the normal test deadline remain enforced.
The cooldown recovery test also waits for pending imports before advancing
its clock. Temporary diagnostic instrumentation is removed.

Eight focused account/recovery cases pass on the final fixture. The full
desktop rerun is queued in
`/tmp/videorc-beta-account-persistence-0rqgg8vr/report.json`; it waits for the
owned prior suite to exit before starting another full suite. Full desktop
success is still pending. Typecheck, ESLint and formatting pass; a final
renderer typecheck is also queued after restoring the fake window's real
timer bindings. These test-fixture changes do not alter the Rust/Cargo source digest;
the fresh backend build and its queued production-target Clippy check remain
in progress. No merged-source runtime or exact-AppImage pass is claimed.

### Protocol pin and completed desktop verification, 2026-10-30

The corrected full desktop run completed successfully: 603 test files and
6,641 tests passed; the one Windows-only OBS test remains skipped, not a
Linux pass. This includes all 203 StudioProvider cases. The tested fixture
bytes match `6c6f950c`; its report and commit provenance are retained under
`/tmp/videorc-beta-account-persistence-0rqgg8vr`. The final renderer
typecheck passed. The earlier merged-source backend build and required
production-target Clippy check also completed successfully, with the same
four documented Linux allowances.

Linux CI job `123992118254` on `6c6f950c` passed FFmpeg policy, provisioning
and Clippy, then reported 4,116 Rust tests passed, one failed and 19 ignored.
The sole failure was an outdated Agents guard that still pinned Phone
remote's intent enum to `dc1309cb`. The enum is byte-identical to reviewed
main `9028bec9`: Plan 210 added a bounded saved-scene ID and three fieldless
screen privacy intents, with leak arguments already in `docs/remote-control.md`.
The guard now pins that reviewed enum and retains the original five LAN
events. No remote method, event or production behavior changes in this fix.

An isolated Rust harness executes the exact updated test with the production
enum and event constant. The reviewed baseline passes; adding an unreviewed
intent or LAN event fails as expected. This is not full-crate validation.
Report: `/tmp/videorc-beta-remote-pin-z40e7ixd/report.json`. Rust formatting
and diff checks pass. Focused Cargo tests, standard Linux Clippy, a final
backend/bridge build and the remote-control/Agents app smokes are queued
sequentially in `/tmp/videorc-beta-remote-pin-verification-latest.txt`.
They refuse changed Rust source or a changed backend binary. The test edit
changes the source digest, so the earlier build is not claimed as validation
of the final source. Full Rust CI and these new runtime results remain
pending; no candidate or release acceptance is implied.

### Windows hidden-start fixture correction, 2026-10-30

Required Windows source job `124004914823` on `31bd1804` passed Clippy and
both 25-pass stability groups. Its first full Rust pass reported 4,159
passed, one failed and 20 ignored; passes two and three and subsequent
source checks did not run. The reviewed remote-intent pin passed in this
run. The sole failure was the real-start Hide screen test: it expected a
legacy-path refusal but received the bridge's missing-preview-frame error.

The fixture requested 4K60 without fixing the runner's encoder capability.
Windows correctly reduces a record-only canvas when hardware cannot encode
it; that reduced canvas can use the bridge. The test now seeds the existing
capability cache with a 4K60 result under its unique, non-executable FFmpeg
path and removes only that entry after the bounded start. It retains the
exact privacy message and no-active-session assertions. No production
selection policy or process-wide environment override changes. A companion
test covers both a hardware-accepted 4K60 request and the software reduction
that makes the bridge eligible. Both tests join the existing `live_control_`
filter, so the Windows PowerShell gate will exercise them 25 times before
the three full-suite passes. Those Windows results remain required and
pending; the earlier stability successes do not validate this correction.

The prior local verification queue was compiling an older normal backend
after its test-target compilation. Its one owned compiler was terminated
after the fixture correction made the source obsolete; cleanup and the
changed-source refusal are retained under
`/tmp/videorc-beta-remote-pin-verification-oP8ODR`. This is an interrupted
check, not a pass or an assertion failure. The replacement queue is tracked
by `/tmp/videorc-beta-hidden-legacy-verification-latest.txt`. Focused tests
use only the backend test target with test optimization disabled; the final
backend/bridge build and runtime smokes retain the normal optimized
development profile. No recording-quality or timing budget changes.

### State-scoped Windows capability fixture, 2026-10-30

The cache-based correction did not pass Windows. Required source job
`124041737662` on `17acc1d9` passed Clippy and 25 preview-concurrency passes,
then failed the first `live_control_` repetition: 14 tests passed and the
same hidden-start test failed. Full-suite and downstream source gates did
not run. The software-reduction companion test passed. A missing Windows
adapter deliberately produces a new UUID in its identity on every query;
this prevents production cache reuse under an unknown driver, and also
made the test's seeded cache entry unreachable.

The fixture now injects hardware acceptance into only its `AppState`, via
a field and resolver branch compiled exclusively for Windows unit tests.
It checks the selected canvas before calling the real start and verifies
that a fresh app state has no override. Global cache writes are removed.
The production identity policy, exact refusal assertions, bounded start,
25-repeat filter and three-full-suite requirement remain unchanged.

An isolated harness runs the exact maintained resolver/selector bodies with
substitute hardware. It reproduces the missed cache entry with changing
identities, verifies the fixture returns 4K60 without querying an adapter,
and verifies an independent state still follows the software reduction.
Its non-test build compiles without the fixture field, proving the guarded
branch is absent. Report:
`/tmp/videorc-beta-windows-capability-isolated-7uwr2rty/report.json`.
This is focused logic evidence, not Windows or full-backend acceptance.

On the preceding source, local Cargo passes all three Agent-role tests,
both recording live-control tests and standard Linux Clippy with the same
four allowances. Its normal backend build is still running; the changed
source guard will prevent its result from launching app acceptance. The
replacement verification waits for that owned queue to finish, then runs
focused tests, Clippy, a final normal-profile backend/bridge build and the
app smokes sequentially. Wait receipt:
`/tmp/videorc-beta-state-capability-wait.json`. Fresh Windows stability and
full-suite results remain pending.

### Recording interval coverage, 2026-10-30

The latency smoke now checks 98% coverage of the measured interval from the
observed Running event to the Stop request, with the configured hold as a
minimum. Previously it checked only the configured hold, although recording
continues while the renderer acknowledges Record. A delayed acknowledgement
could therefore conceal a shortened artifact. Missing or reversed monotonic
timestamps fail instead of reducing the coverage requirement. Per-cycle
timing receipts are written before artifact analysis and retain a pending,
passed or failed artifact status, so a quality failure no longer discards
the start/stop phase evidence.

All 40 focused latency-event, budget and duration tests pass, with zero
skips; lint and formatting pass. The full Node suite passes all 2,920 tests
with zero skips (`/tmp/videorc-beta-latency-coverage-full-node.log`).
A retrospective calculation from the rounded
timings in `/tmp/videorc-beta-replay-regression-Wc4WGx/latency-vaapi` finds
no additional duration failures in those five old takes. It is only a lower
bound from saved timings, not a fresh run or current-candidate acceptance.
The actual latency failures remain: the saved warm-start timelines spend
282–326 ms before admission completes and 165–171 ms at microphone warm-up;
FFmpeg exit accounts for 408–535 ms of Stop. These phase observations locate
work to investigate; they do not establish a fix or justify changing budgets.

The prior owned build completed and refused stale-source runtime launches.
Fresh Rust verification for `713a2a6d` is running under
`/tmp/videorc-beta-state-capability-verification-OhMWpx/report.json`.
The measured-interval smoke will run only after that queue releases the app
and its final normal-profile backend/bridge hashes have been verified.

### Main integration for microphone loss and smoke ownership, 2026-10-30

Integrating main `7feda92f` resolves conflicts with the reviewed Linux
microphone-loss protection and caption-smoke seed changes. Capture workers,
direct Pulse inputs and the meter now all use main's
`node.dont-fallback=true node.dont-move=true` policy. Its complete source-list
check refuses an unplugged selection and keeps the session on silence.
The earlier Beta `node.dont-reconnect` helper is removed: main documents
that it can leave the lost stream blocked instead of delivering EOF.
Live microphone replacement on the shared PCM bus and its tests are retained.
The caption smoke both commits the requested Studio state and synchronously
pins that same storage value before installing main's reload protection;
the post-reload configuration assertion remains required.

This merge also brings main's Linux idle-preview picture fix for Agents,
Windows camera/startup/presenter fixes, shared host smoke/build ownership,
Chat preview sizing and shortcut fixes. The published 0.16.0 Alpha waiver
is historical Alpha evidence only. It does not close a Beta acceptance row.
Heavy Cargo work now uses `pnpm cargo:slot`; app smokes retain the shared
host lock and memory admission checks.

The old owned Rust test compiler was deliberately terminated before the
source merge. Its receipt is
`/tmp/videorc-beta-state-capability-verification-OhMWpx/interrupted-for-main.json`.
The dependent latency queue refused to launch without a completed backend
build. Both runs are incomplete; no old binary is used as merged-source proof.
Rust formatting, 58 focused script tests and all 2,941 Node tests pass
(zero Node skips). Standard Linux Clippy passes with the same four documented
platform allowances. Full desktop/source verification, focused Rust tests,
the normal backend/bridge build and affected app smokes are being rerun.
No recording budgets, permission requirements or physical gates change.

### Merged-source runtime results and remote fixture correction, 2026-10-30

On `8af8d97d`, the full desktop suite passes 6,648 tests across 603 files
(one Windows-only OBS test skipped), and the frontend build, typecheck,
lint and formatting pass. All six focused Rust filters pass; the normal
optimized development backend and MCP bridge build succeeds. This remains
development verification, not an AppImage or physical acceptance result.
The complete source/binary receipt and individual logs are in
`/tmp/videorc-beta-main-mic-merge-verification-JKZ6wW/report.json`.

Live microphone replacement passes recording, streaming and combined modes,
including two decoded source identities, None, duplicate fencing, monotonic
DTS and one encoder. Both caption contract and fake-gateway/local-RTMP smokes
pass: microphone controls affect the bus, microphone loss pads with silence,
recordings remain clean, and SRT plus captioned export are produced.

The remaining runtime failures are retained:

- Remote control passes discovery, authorization, microphone, debounce and
  scene acknowledgement, then waits for a default Clips ring that stays off.
  This run forces OpenH264, which intentionally refuses automatic replay
  startup. The smoke now explicitly enables the ring through the same Output
  switch action before testing `clipMark`. It still requires confirmed ring
  state and both successful and refused exact-ticket acknowledgements. It no
  longer claims this proves automatic startup; the production guard is unchanged.
- Agents passes authorization, catalog, a decoded 1280×719 picture and scene,
  banner, takeover, microphone and privacy round trips. Its recording starts
  and receives a marker, but Stop times out waiting for Studio. The unfinished
  take and failure remain available; no successful session completion is claimed.
- VAAPI completes all five measured recordings, each passing the artifact
  checks including measured-interval coverage. Cold start is 2,263 ms, warm
  start p95 1,338 ms, and Stop p95 1,168 ms, failing the unchanged
  1,000/350/300 ms limits. Finalization p95 1,033 ms passes its 5,000 ms limit.
- OpenH264 fails the first recording's startup gate with four repeated frames
  against a maximum of two. Timing evidence survives in `cycle-0-timing.json`;
  the remaining cycles did not run. This is not a latency pass.

The sequential diagnostic run
(`/tmp/videorc-beta-control-diagnostics-Qxwr22/report.json`) passes the corrected
remote-control smoke through its real app. Agents reproduces the Stop timeout;
its log records the stop intent and stopping state, but no terminal receipt
before the tool deadline. Its cause remains unconfirmed. Both runs use the
same built backend. The direct matrix follow-on's first two launches
never reach backend readiness; they produce no recording evidence. Its scratch
runner omitted the build's Cargo debug settings while skipping prebuild, so the
dev app's `cargo run` can rebuild a different configuration. Corrected runs must
keep the original build environment and verify binary hashes. No timeouts,
recording budgets or physical acceptance requirements are relaxed.

### Windows replay namespace ownership, 2026-10-30

Required Windows source job `124073766336` on `8af8d97d` passes Clippy, all
25 preview-concurrency runs and all 25 source/audio ownership groups. The
first two full Rust passes each complete with 4,180 backend tests passing and
20 ignored. The third has 4,179 passing, one failing and 20 ignored: the replay
prepare/attach/retire test finds its root still present after cleanup. Later
source gates are skipped, so the required job remains failed. The prior
state-scoped hidden-start fixture passes its repeated Windows filter.

Every in-memory AppState previously used a replay root named only by the
process ID. Independent tests could delete or recreate each other's ring
namespace. The correction stores a lazy unique root on the shared replay
registry: independent states differ; clones keep their owner's root. The
file-backed app path and every cleanup assertion stay unchanged. A regression
creates the same session name in two states and proves cleaning one leaves
the other's segment intact. It and the existing lifecycle test use the
`live_control_` prefix so the existing PowerShell 25-run ownership group
exercises both before the three full Windows suites.

An isolated harness using the exact maintained root, directory and cleanup
functions, with minimal AppState/Database substitutes, fails deterministically
on the old implementation and passes all 25 runs with the correction:
`/tmp/videorc-beta-replay-root-probe-pl4250tk/report.json`. It is not a full
backend build or Windows stability result. The correction is applied after the preceding source's matrix/preview runs
finish. Fresh replay-module and ownership crate tests, Clippy and the Windows
stability/full-suite gates remain required.

The corrected matrix runner keeps the original Cargo environment and verifies
built bytes. On `8af8d97d`, the direct VAAPI 1080p30 case passes. OpenH264
1080p30 fails actual artifact checks: a 167 ms freeze and four repeated frames
against 100 ms and two; its 13 ms A/V tail passes. The bridge records about
21.3 input fps and 17 pre-encode skips. The Linux proof-preview lifecycle gate
passes all 100 cycles. These are development results on that preceding source,
not full profile coverage or an accepted candidate. Evidence:
`/tmp/videorc-beta-matrix-build-env-fixed-VNXs83/report.json`.

### Current-source verification and interrupted build, 2026-10-30

On `294717d0`, replay-module tests pass 30 cases with two ignored, and the
`live_control_` filter passes 17 with no ignores. The filters overlap; these
are not 47 distinct tests. Both replay namespace ownership regressions execute.
Standard Linux Clippy passes with the four existing platform allowances.
Receipt: `/tmp/videorc-beta-replay-ownership-verification-Nz4LMo/report.json`.
The test target alone used opt-level 0; runtime evidence requires the normal
optimized development binaries.

Linux job `124111916053` on that head received a runner shutdown during test
compilation after FFmpeg policy/provisioning and Clippy passed. One exact-job
retry was requested; the interrupted run supplies no test pass. Hosted macOS
Rust job `124111915712` reached its confirmed 75-minute limit during test
compilation. Audit, formatting and Clippy passed, but tests and the sentinel
did not complete. The existing release-runbook exclusion applies to that check;
it is not successful validation. Windows diagnostics job `124111953268` passes
OpenH264 comparison and all 48 controlled-audio cases, but its independent
control fails 36 streaming cases on 117–267 ms tails; five also fail frame-count
tolerance. Its diagnostic-only exclusion does not waive required Windows
source/installer checks or repeated/full-suite stability evidence.

The server restart interrupted the owned normal backend/bridge build before
completion. The predecessor's recorded processes were confirmed gone and its
report remains incomplete. The resumed sequential build and instrumented
Agents smoke use unchanged Rust source and the normal opt-level 2 profile:
`/tmp/videorc-beta-agent-control-trace-build-0TzaGz/report.json`.
The prior reproduction places roughly 13 seconds of the Stop tool's delay
before the backend receives Stop. Event receipt, renderer RPC and timer-gap
traces are being collected to distinguish delivery delay from backend stop
work. No timeout or artifact budget has changed; completion remains pending.

### Public-pointer storage adapter, 2026-10-30

The Beta transaction core now has an S3 adapter with separate caller-supplied
candidate-read and public-origin configurations. It snapshots the verified plan
and configurations; only that plan's immutable destinations, candidate feed and
two public Beta pointers are addressable. Immutable verification streams and
hashes the actual GET bytes. Pointer reads require bounded complete unencoded
bodies and strong ETags. Writes accept only the exact planned bytes and an
explicit create-only or compare-and-swap condition; signed payload checksums
and conditions bind the request. Request/body deadlines close or cancel owned
resources. Lost responses, conflicts and changed readback stop the transaction
without retries, adoption, journal release or success claims.

All 75 focused planner, transaction, journal and storage tests pass with zero
skips (`/tmp/videorc-beta-publication-s3-focused.log`), including integration
through artificial HTTP transports on both origins, mirror-first writes and
ambiguous-result preservation. This adapter has no CLI, ambient credential
fallback, immutable uploader or production execution evidence. Protected
coordination, real storage capability proofs and exact-candidate acceptance
remain mandatory before publication.

The full Node suite passes 2,965 tests with zero skips
(`/tmp/videorc-beta-publication-s3-full-node.log`). Its storage module loaded
before the final streamed-error redaction regression was added; the final
storage-only suite then passes all 25 cases with zero skips
(`/tmp/videorc-beta-publication-s3-storage-final.log`). Focused ESLint,
formatting and diff checks pass. These checks include the preserved local
workflow-exit fix; that workflow/test pair remains excluded from the PR until
workflow-capable authorization is available.

The candidate downloader also rejects a `Content-Range` envelope even when
the server reports HTTP 200. All 20 downloader tests pass after this change
(`/tmp/videorc-beta-download-range-tests.log`), including cleanup restricted
to the newly created partial directory; focused lint/format checks pass.
