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
| First run                          | Linux sharing guidance enabled; reload passes after icon fix, full smoke fails at look commit     | Packaged physical proof and real OAuth still required.                                                      |
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

A silent standalone Electron probe preserves a per-instance property set via
`PULSE_PROP` in both the Pulse stream and its PipeWire node. Setting the
property in Electron's main JavaScript before `app.whenReady()` also works
with the normal out-of-process audio service. The probe matches only the
owned Electron process metrics, routes only that owned silent stream to an
owned null sink, and removes its processes/module afterwards. Receipts:
`/tmp/videorc-beta-electron-audio-marker-izZNmX/report.json` and
`/tmp/videorc-beta-electron-audio-marker-late-env-z15cQa/report.json`.
Both owned cleanup receipts report no forced orphan cleanup. An earlier
probe observed its stream before the requested sink route settled and failed
that check; it is not evidence that `PULSE_SINK` is ignored.

This narrows the self-audio identification design, not the support status.
The marker is an app-owned exclusion tag, not an authenticated process ID.
Production must set it before any playback helper starts, preserve it through
backend/worker environment overrides and audio-service restarts, and verify
both included external audio and excluded Videorc playback in actual capture.
Native PipeWire clients still need server-authenticated ownership checks;
Pulse-server indirection and unknown/transient ownership must be handled
explicitly. No production system-audio capture or desktop routing changed.

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
work. No timeout or artifact budget has changed.

The resumed normal-profile build completed successfully at 16:13:36 UTC.
Its Rust/Cargo digest is
`aed1366346ef41285954ea16b33235e89a2d3097e83e3b319582d7a272c75d45`,
backend SHA-256 is
`e1beae68307e97cfb3c9ad9137b49db8d91b11e96d22d1f9d2794fcd641c16fc`,
and MCP bridge SHA-256 is
`2299810e3546f51e092dec7b114339371bf887de46482ccd5ff0400125247ac2`.
Rust source is unchanged between `294717d0` and `c77db353`.
The trace run completes Record → marker → Stop and a 19.70-second artifact
passes analysis. Recording Stop takes 14.1 seconds; the later local-stream
Stop times out. Renderer timer gaps reach 6,253 ms, and the renderer waits
11.25 seconds between receiving the streaming Stop intent and sending its RPC.
These results locate substantial delay before backend stop work, rather than
establishing an encoder deadlock.

Two subsequent profiles on those verified binaries reproduce Stop timeouts:
`/tmp/videorc-beta-agent-cpu-profile-LqTMLh/report.json` and
`/tmp/videorc-beta-agent-cpu-profile-UZeuCm/report.json`.
React rendering dominates the idle profile; sampled Core context changes
repeatedly name `exportSupportBundle`, plus periodic `previewWindow` updates.
The export callback captures preview telemetry even though its consumers only
need that telemetry when exporting. The correction reads the existing latest
status ref at export time, after refreshing runtime diagnostics, and removes
the telemetry dependency from the Core action. No development checks or
diagnostic updates are disabled. An actual-provider regression must retain
Core/Shell identity across telemetry while proving that an export includes
status received during the asynchronous runtime refresh. That regression fails
on the old callback and passes with the correction.

The first rerun removes the callback churn but still times out on Stop:
`/tmp/videorc-beta-core-telemetry-fixed-Ts7n6k/report.json`.
Its metadata-only context trace identifies the remaining idle invalidations
as `previewWindow.supervisor.updatedAt` alone. The supervisor now timestamps
actual state transitions; repeated frame observations retain the existing
timestamp. The renderer also retains an identical window snapshot received
through IPC. Periodic reconciliation still explicitly re-drives an open window
whose surface was never created. Cross-platform supervisor tests cover repeated
observations, failure and explicit recovery; the real-provider test covers
duplicate IPC and a real failure transition. All five focused regressions pass;
each regression first failed on its corresponding old implementation.

On both fixes, `/tmp/videorc-beta-preview-lifecycle-fixed-vaui4n/report.json`
shows no repeated idle Core changes after the pending privacy transition.
Recording Stop completes in 7,541 ms within the unchanged Agents deadline,
and its 1920×1080, 9.87-second artifact passes analysis. This is not a recording
latency-budget pass. The full Agents smoke remains failed: the combined local
stream/recording session exceeds the OpenH264 raw-frame FIFO delivery budget,
ends before Stop, and the tool correctly refuses an already-ended session.
Its original errors and artifact evidence remain retained. No timeout, frame
delivery limit or artifact threshold has been relaxed.
The failed combined take's persisted diagnostics identify 1920×1080 at 30 fps
for both roles, two active FFmpeg processes, 18.89 compositor fps, 177 pre-encode
skips, 224 output-queue drops and a 1,997 ms queue-age high-water mark. This
is not merely a high-resolution profile failure. The same-profile role
isolation path and its throughput proof need investigation; increasing the
FIFO deadline would not establish cadence or artifact acceptance.

Full desktop verification passes 603 files and 6,653 tests, with the existing
Windows-only OBS test skipped on Linux:
`/tmp/videorc-beta-core-telemetry-checks-ls9Rxn/desktop/run.log`.
After correcting two test-only type annotations, all five focused regressions,
typecheck, lint, repository formatting and the production frontend build pass:
`/tmp/videorc-beta-preview-source-typed-dtc8wr/report.json`.
Production source is unchanged from the complete desktop run. The sequential
Linux preview/remote follow-on is
`/tmp/videorc-beta-preview-quiet-regressions-DfErO3/report.json`.
Both runtime gates pass. The Linux proof-preview probe completes all 100 cycles
with clean owned-process teardown and zero budget failures. Its successful
scratch cleanup removes the wrapper's nested log; the separate generated
performance report is preserved alongside the queue as
`preview-lifecycle-performance.json`, SHA-256
`210e772ab0004261c7ef7c3fc6b8255625fc66f11ba5f4aac00f82d633d8a053`.
Remote control passes discovery, authorization, microphone, debounce, scenes,
explicit Clips enable, successful/refused clip tickets, system-audio refusal
and client revocation. Backend and MCP bridge hashes remain unchanged.
These are development regression results; AppImage, physical and full
recording/performance acceptance remain open.

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

### Windows source-gate path portability, 2026-10-30

Required Windows source job `124111953482` on `294717d0` passes Clippy,
both 25-run stability groups and all three full Rust runs, including the
replay ownership correction. It then fails ten desktop assertions across
three files (599 files and 6,622 tests pass; five tests are skipped).
All later source checks are skipped; the required job remains failed.
Classification: `/tmp/videorc-beta-windows-source-124111953482-classification.json`.

The installer tests used macOS path semantics on Windows temporary paths,
which placed staging files outside their intended directory or refused the
wrong parent. Real-filesystem tests now use the host platform; explicit
macOS/Windows/Linux path-selection cases remain. The Windows unchanged-file
mode test now asserts successful unchanged resolution on a Windows-shaped
mock filesystem, instead of accepting a refusal before reaching that branch.
The Linux-only desktop-entry helper always uses POSIX separators. The smoke
Trash fixture uses native temporary paths and still asserts two distinct
moves with the original basenames. No failure assertions or gate thresholds
are removed. All 56 focused tests pass on Ogre:
`/tmp/videorc-beta-windows-paths-focused.log`.
The broader main-process desktop suite passes all 106 files / 1,058 tests,
with the existing Windows-only OBS test skipped on Linux:
`/tmp/videorc-beta-windows-paths-main-suite.log`.
Typecheck and full lint pass (`/tmp/videorc-beta-windows-paths-typecheck.log`
and `/tmp/videorc-beta-windows-paths-lint.log`). The full formatting scan
reported only the installer test; after formatting it, the changed-file
Prettier check and repository text-integrity check pass:
`/tmp/videorc-beta-windows-paths-format-final.log`.
Fresh Windows desktop/source CI remains required; Linux verification does
not substitute for it. There are no Rust or recording-path changes in this
correction, and no new candidate acceptance or publication evidence.

### Windows candidate-tooling portability, 2026-10-30

Required Windows source job `124210299772` on `0a84338e` passes Clippy,
both 25-run stability groups and all three full Rust runs. Desktop tests now
pass all 602 files / 6,638 tests, with five existing platform skips. This
confirms the earlier desktop path correction. The subsequent Node suite has
2,840 passing, three failing and 94 skipped tests; later source checks do not
run. The required job remains failed. Evidence:
`/tmp/videorc-beta-windows-source-0a84338.log` and
`/tmp/videorc-beta-windows-source-124210299772-classification.json`.

The AppImage fixture creates a real extraction directory, but the validator's
raw path comparison mistakes a canonical temporary-parent alias for a payload
symlink. The validator now canonicalizes its owned temporary directory before
copying or extracting. The exact extracted-root comparison, payload-file
containment, ELF/hash checks and environment isolation remain enforced. A
new directory-alias regression fails with the prior comparison and passes
with canonicalization. A separate regression rejects an extracted-root
symlink, removes the owned extraction directory and preserves unrelated data;
directory junctions keep these tests executable on Windows without symlink
privileges.

The two download failures compare Windows mode bits to POSIX `0600`/`0700`.
These permission assertions now apply on POSIX hosts. Windows still exercises
both channels' exact bytes, identity, storage requests and cleanup; this is
not Windows ACL evidence. No Linux permission or artifact requirement changes.
All 23 focused tests pass with no skips:
`/tmp/videorc-beta-candidate-paths-focused.log`.
The original reproduced failure is retained in
`/tmp/videorc-beta-candidate-paths-before.log`.
No Rust, desktop runtime or release identity changes are involved. Fresh
Windows source CI and all physical Beta acceptance remain required.

The broader Node suite passes all 2,969 tests with zero skips:
`/tmp/videorc-beta-candidate-paths-node.log`. This local suite includes the
preserved workflow-exit correction/test pair that remains outside the PR.
After the test import's formatting-only correction, the 23 focused tests,
changed-file formatting and repository text integrity pass again; focused
ESLint also passes. Logs use the `/tmp/videorc-beta-candidate-paths-` prefix
(`focused-final.log`, `format-final.log`, `text.log`, `lint.log`). These are
tooling regressions with artificial candidate bytes, not AppImage acceptance.

### Required CI and combined-output evidence, 2026-10-30

On `3ab0900ebafa1992612cd12d47c3b152909112ac`, required JavaScript
(`124260887567`), Linux compile/tests (`124260856600`), Windows source gates
(`124260859927`) and Windows installer (`124260859540`) pass. Duplicate
skipped jobs are not counted. The existing Windows diagnostic failure and
hosted macOS 75-minute compilation timeout retain their documented runbook
classification; neither is a pass or a new exception. PR #930 remains draft.
This source milestone does not close any physical candidate acceptance row.

A fresh, unprofiled Agents smoke on Ogre reproduces the combined-output
failure. Record-only produces an 18.63-second 1080p artifact that passes its
analyzer. Record plus local RTMP uses matching 1080p30/6000 kbps profiles and
two raw inputs in one FFmpeg process: the clean recording and the auxiliary
stream prepared for live captions. Both FIFO writers stop, and recovery saves
only 5.4 seconds. The original B1 smoke still reports success because its
receiver contains some video; the full smoke later fails a camera scene-change
refusal. Evidence: `/tmp/videorc-beta-combined-no-profiler-KwEs3I/report.json`,
its isolated SQLite/recordings, and its owned FFmpeg command observation.

The maintained Agents smoke now requires normal completion of the exact
recording session, rejects interrupted/recovered takes even when their Library
status is `completed` and their MP4 is finalized, and analyzes both combined
outputs. It observes at least five seconds after confirmed running, checks the
same session is still recording before Stop, and requires each artifact to
cover at least 98% of that observed interval. The existing no-controlled-motion
and no-controlled-audio scope stays explicit; this is not the physical motion,
audible-input, whole-session duration or latency acceptance gate.

All three completion regression tests pass, including the exact recovered-row
shape from this failure. Applying the helper to the retained real row rejects
it. A proposed FFmpeg buffering experiment did not reach session FFmpeg because
main pins the bundled binary; its run is therefore not evidence for or against
that proposed change. No runtime buffering change or production repair is
claimed. The updated real-app smoke now fails at B1 with "the combined
session ended before go_live confirmed it", immediately after the recorded FIFO
failure, rather than accepting the recovered fragment. The failure receipt is
`/tmp/videorc-beta-agent-completion-gate-2Jh6eV/report.json`; original backend
and MCP binary hashes remain unchanged. This is a successful negative control
for the smoke correction, not a passing Agents or recording acceptance run.
The broader local Node suite passes all 2,972 tests with zero skips
(`/tmp/videorc-beta-agent-completion-node.log`), including the preserved
workflow-exit fix/test pair outside this PR. Full lint, full formatting/text
checks, and focused ESLint/Prettier checks for the changed scripts pass. Source
verification receipt: `/tmp/videorc-beta-agent-completion-verification.json`.
No Rust or application runtime code changed in this evidence correction.

### Combined-output attribution and host context, 2026-10-30

The captured production raw-split FFmpeg command completes both 360-frame,
12-second controlled moving-bar outputs with the unchanged two-second FIFO
writer deadline. The original command and a diagnostic variant with
`-shortest_buf_duration 0.25` both pass this limited fixture. This does not
attribute the real-app failure to synchronization buffering and does not
justify changing that policy. Receipt:
`/tmp/videorc-beta-raw-split-command-1b4kw5bl/report.json`.

A subsequent real-app timing diagnostic completes the combined Agents B1
session normally. Its recording still has a 133 ms corroborated freeze and a
three-frame repeat, beyond the full motion gate. Sequential 12-, 4- and
2-worker Rayon diagnostics also complete combined output, but all fail the
full motion constraints. These diagnostic scripts deliberately exit after B1;
they are neither full Agents passes nor physical candidate acceptance. The
failure is intermittent; no runtime repair is established. Receipts:
`/tmp/videorc-beta-media-timing-jtzKgl/report.json` and
`/tmp/videorc-beta-media-pool-dcETnK/report.json`.

During the worker comparison, Ogre reports disconnected mains, a discharging
battery and approximately 800 MHz on every CPU policy despite recording load.
A later read reports connected mains while the clocks remain near 800 MHz.
Clocks were not recorded throughout each earlier case, so this comparison
cannot select a worker count or establish the cause of the earlier failures.
No governor, power setting, worker count, encoder setting or threshold changes.
The latest read-only host receipt is
`/tmp/videorc-beta-host-context-actual.json`.

Linux development gate rows now retain host snapshots before and after each
step. Each Linux recording-matrix case also writes a private host report before
start, before Stop, and after completion or failure; successful case results
link that report. Measurements include mains state, battery state and capacity,
per-policy current/configured/hardware clocks, governor and energy preference.
Unreadable fields remain explicit and unknown; peripheral battery identifiers
are omitted. These are point-in-time diagnostics, not continuous frequency
measurements, a throttle verdict, a waiver or a new path to PASS. Existing
artifact gates still decide recording quality.

Focused snapshot and Linux gate tests pass all seven cases with zero skips.
All 2,976 Node tests pass with zero skips (including the preserved local
workflow-exit fix/test outside this PR); full lint/format and focused script
lint/format pass. Logs:
`/tmp/videorc-beta-host-context-full-node.log`,
`/tmp/videorc-beta-host-context-lint.log`,
`/tmp/videorc-beta-host-context-format-full.log` and
`/tmp/videorc-beta-host-context-script-lint.log`.

The fresh direct OpenH264 1080p30 case passes its strict artifact gates,
including a 13 ms A/V tail. Its private host report retains all three snapshots,
which report connected mains, a charging battery and approximately 800 MHz.
Receipt: `/tmp/videorc-beta-host-context-runtime-Kwi7d3/report.json`;
host-report SHA-256:
`0b6baf891f98e5e351645017810e37bb14a4d17a0cb40d424ff802417240b9bd`.
This is one development recording profile on the unchanged verified backend,
not combined-output stability, the full matrix or a physical candidate pass.
No AppImage, version or public Beta pointer changes.

A second controlled command probe repeats 60 decoded frames from the passing
real-app recording instead of the simple bar pattern. Both video producers
deliver all 360 frames without a writer error; FFmpeg and the local receiver
exit normally. The recording contains 362 frames and the receiver 360 after
wall-clock FPS filtering. The slowest whole-frame write is 65 ms, below the
unchanged two-second delivery limit. This isolates command/content handling
from the app's frame production and scheduling; it does not prove that the
full app or a candidate sustains combined output. Receipt:
`/tmp/videorc-beta-raw-real-content-yi2xm_hl/report.json`.

### Powered combined output and CPU composition, 2026-10-31

The fresh powered baseline at `bef7d50` still fails combined recording and
local RTMP. OpenH264 loses its writers during the session and recovers only
6.833 seconds of recording and 5.154 seconds at the receiver. VAAPI keeps the
receiver running for 31.154 seconds but recovers only 4.267 seconds of recording
after Stop. Both combined cases fail the strict motion gate. AC remains online;
CPU clock snapshots remain near 800 MHz, which does not establish why clocks
are low. The baseline also has different Clips settings between encoders, so
it is not a matched encoder comparison. Receipts:
`/tmp/videorc-beta-powered-combined-Ij3vjS/report.json` and its
`artifact-analysis.json`. No runtime repair or candidate pass follows from
these results.

The branch includes main through `0b238af0` (0.17.2). A local Linux CPU experiment
copies the primary picture into the auxiliary output's own recycled buffer
when both raw-output roles have identical scene and source references, tick,
canvas and timestamps. Cameras, overlays, banners, live backgrounds, editor
chrome, simulcast, native export handles, incomplete frames and aliased stores
keep the existing separate-render path. An invisible Buddy anchor alone adds
no pixels and does not prevent reuse. Each role retains its own store, queue
and encoder. Eight focused tests cover pixel equality, moving content,
retained-buffer ownership, timestamps and refusal cases. The experiment remains
uncommitted: the native logic checks below pass, but no runtime reliability or
performance improvement is established. Fresh runtime checks must use
the current source and rebuilt binary hashes, with identical Clips settings
for the combined encoder cases. Previous-main results cannot establish the
optimization's isolated effect.

The merged web companion is now partially observable in production: a read-only
request to `https://www.videorc.com/linux-beta` returns 200, names Ubuntu 24.04
and Omarchy, and says Beta is being prepared. The Beta pilot feed without a
token returns 401 with the expected authorization error. The public
`/api/updates/latest-linux.yml` request redirects to storage and returns 404
`NoSuchKey`; public updater publication is not verified or ready. This check
does not establish the production commit, signed-in download behavior, pilot
access with a token, or any Beta candidate acceptance. No configuration or
storage objects were changed. Receipt:
`/tmp/videorc-beta-public-readonly-37ehqacm/report.json`.

The current-main verification completed: 605 desktop files pass (6,647 tests
pass, one skipped), all 2,994 Node tests pass with zero skips, and typecheck,
lint, format, dependency audits and the desktop build pass. The native queue
passes Rust format, eight focused CPU reuse tests, Clippy with the existing
four Linux allowances, and the normal optimized development build. A broader
compositor logic run passes 223 tests; it is not physical GPU/device evidence.
The backend SHA-256 is
`4bbdd97316ef94ca765bcda89a13d83011204ae849b96cddfb898889f2673f7f`.
Receipts: `/tmp/videorc-beta-cpu-auxiliary-native-skzdUj/report.json`,
`/tmp/videorc-beta-cpu-auxiliary-source-otUDxt/report.json` and
`/tmp/videorc-beta-cpu-auxiliary-runtime-sR9kj7/report.json`.

Runtime remains failing. OpenH264 combined output recovers an interrupted
recording; VAAPI combined output finalizes normally but its recording has a
167 ms freeze and four repeated frames. Its receiver passes the scoped strict
artifact check, without controlled-audio proof. OpenH264 latency fails startup
motion; VAAPI completes five takes but cold start is 1,811 ms, warm start p95
986 ms and Stop-to-idle p95 737 ms, beyond the unchanged budgets. Preview
lifecycle fails at cycle 34 with a closed surface and an undrained compositor
mutation. None of these results establishes a repair or candidate readiness.

The scratch Linux process supervisor also caused false teardown failures:
adopted zombies were not reaped until the smoke command itself exited, while
that command waited for its process group to disappear. A controlled regression
fails with the old supervisor and passes after reaping adopted children while
the command runs; the command keeps its own wait status and unrelated processes
remain outside the supervisor's ownership. The corrected direct 1080p30 matrix
passes both encoders, including teardown, without any supervisor-forced cleanup.
Receipts: `/tmp/videorc-beta-live-reap-controls-cq_bttrp/report.json` and
`/tmp/videorc-beta-live-reap-matrix-ac9ica/report.json`. The earlier media and
preview failures remain failures.

A matched OpenH264 comparison uses the same source, binary, Clips-off fixture
and corrected supervisor with 12 and four Rayon workers. AC remains connected
and sampled clocks near 800 MHz throughout both. Both combined cases fail the
strict motion limits; the 12-worker receiver also fails take coverage. This
does not select a production worker count. Receipt:
`/tmp/videorc-beta-matched-cpu-workers-70Vxzj/comparison.json`.

A separate preview lifetime change releases pending proof-surface JavaScript
waits when their WebContents is destroyed, so an unresolved call cannot hold
the mutation queue after that renderer retires. Live errors still propagate;
late answers cannot replace the next renderer's state. Six new lifetime tests
and 29 related queue/host tests pass. The full source run passes typecheck, lint,
format, build and 606 desktop files (6,653 tests pass, one skipped). Receipt:
`/tmp/videorc-beta-proof-script-source-aLu29N/report.json`. Runtime results below
remain development evidence; no exact-candidate repair is established.

The Windows diagnostic job on `22ebe0b1` has the same independent FFmpeg control
failure family: 48 controlled-audio cases pass; the independent control has
12 passes and 36 streaming failures, with 114–267 ms tails and seven cases
also failing frame count. No new failure category, threshold change, waiver or
unchanged retry. This remains a failed diagnostic under its existing runbook
classification, not a source-gate or Linux acceptance pass. Receipt:
`/tmp/videorc-beta-windows-diagnostics-124619026380-classification.json`.

### Preview renderer lifetime verification, 2026-10-31

The first 100-cycle run after the proof-script change completed every lifecycle
operation and teardown, but failed the overall process gate because one census
reported two Electron main processes. Raw process rows were not retained, so
that extra row cannot be classified retrospectively. Receipt:
`/tmp/videorc-beta-proof-script-runtime-yroPpP/report.json`. The failure remains
recorded; the process-count limit and classification are unchanged.

The maintained lifecycle probe now saves the original owned process rows at
each checkpoint in an exclusively created, mode-0600 private JSONL sidecar.
The public performance report still contains aggregates. Existing process
census, memory and lifecycle-evidence tests pass all 43 cases; focused script
lint and format pass. Do not commit the private rows, which can contain argv
and local app paths.

A diagnostic repeat passed its 100-cycle probe and process budgets, but the
scratch supervisor failed when writing a receipt inside the probe's already
removed success directory. This is not an overall verification pass. A
controlled reproduction confirms that failure and that an external receipt
survives. The following verification retains scratch with
`VIDEORC_PERF_RETAIN_ARTIFACTS=1` and writes supervisor receipts outside the
app directories. Receipts: `/tmp/videorc-beta-preview-census-runtime-gwaonc/report.json`
and `/tmp/videorc-beta-supervisor-receipt-controls-jvr7ma1g/report.json`.

The retained verification queue passes end to end: two further 100-cycle
Linux proof-preview runs and direct strict 1080p30 recordings with OpenH264
and VAAPI on `/dev/dri/renderD128`. Each preview run has 13 retained censuses
with exactly one Electron main process, zero budget failures and clean
teardown. All four supervisor receipts report command exit zero and no forced
orphan cleanup. OpenH264 records 188 frames over 6.267 seconds with a 16 ms
A/V tail; VAAPI records 186 frames over 6.2 seconds with an 8 ms tail. Both
artifacts have zero corroborated freezes, at most two repeated frames and no
analyzer failures. Silence warnings remain: these synthetic recordings do not
prove microphone or system audio. Receipts and hashes:
`/tmp/videorc-beta-preview-retained-regressions-kjFqKT/report.json` and
`/tmp/videorc-beta-preview-retained-regressions-kjFqKT/summary.json`.

These runs preserve the checked application patch and exact development
backend hash above, which includes the uncommitted CPU experiment. They are
scoped regression evidence, not an isolated CPU comparison, acceptance of a
clean release build or proof that the intermittent combined-output failures
are fixed. The original process-count failure remains unexplained. The full
macOS recording-studio and real-device suite cannot run on Ogre: it requires
ScreenCaptureKit, Metal and macOS device grants. The Linux lifecycle and
artifact probes cover the touched path here; shared-platform runtime and both
physical AppImage acceptance passes remain required. No process, motion,
latency or acceptance threshold changed.

The latest macOS Rust CI job (`124618986046`) passed advisory audit, format and
Clippy, then exceeded GitHub's 75-minute limit while compiling tests. No tests
executed and no performance sentinel ran. It remains in the existing runbook's
hosted-macOS timeout category, not a pass or a new waiver. Receipt:
`/tmp/videorc-beta-macos-rust-124618986046-classification.json`.

### Main preview-isolation integration, 2026-10-31

Main `53049b68` is merged and pushed as `c8685c4d`. The only textual conflict
was the plan index; both entries are retained. The unpublished CPU experiment
and workflow-exit patch/test are preserved in stash
`8ddda55d9b0054b765371c40a49d177b1d092446` and a byte-verified backup at
`/tmp/videorc-beta-before-main-53049b68-lmipn0ow`. The merged compositor matches
main exactly; the CPU experiment is not present in the checked source or
rebuilt binary. The workflow correction still must land before a candidate.

Merged-source verification passes typecheck, lint, format, desktop build,
442 focused desktop tests, all 606 desktop test files (6,669 pass, one
skipped) and all 2,990 Node tests without skips. This Node run excludes the
stashed workflow regression test. Rust format, Clippy with the existing four
Linux allowances and the normal optimized backend/MCP build pass. The focused
native filters plus the corrected frame-lease module run pass 34 unique tests.
The original `compositor_preview_frame_lease::tests::` filter matched zero
cases and supplies no evidence; its replacement runs all four Linux frame-store
cases. The macOS native-surface case remains unavailable on Ogre. Receipts:
`/tmp/videorc-beta-main53049-source-2mQrbm/report.json`,
`/tmp/videorc-beta-main53049-native-sFuiNM/report.json` and
`/tmp/videorc-beta-main53049-frame-lease-ffsbuja9/report.json`.

The fresh backend SHA-256 is
`056f6d148c0e00129a571d070c63664454c9b799e95cafe572febfd833422f77`.
Runtime verification on that exact merged build is **FAIL**, with individual
results retained in `/tmp/videorc-beta-main53049-runtime-v5dwWB/summary.json`:
100 Linux proof-preview cycles pass, with 13 censuses showing one Electron
main, zero budget failures and clean teardown. VAAPI 1080p30 passes its
artifact gates (186 frames, 6.2 seconds, 13 ms A/V tail). OpenH264 writes a
normally finalized 186-frame, 6.2-second artifact with a 13 ms tail, but fails
because three consecutive frames are identical at 4.133 seconds. A separate
full-resolution decode confirms that burst. Neither encoder case supplies
controlled microphone/system-audio proof. All four commands finished without
supervisor-forced cleanup.

First-run setup passes the initial Linux guidance check, then fails with a
CDP evaluation timeout during renderer reload. The guarded navigation trace
shows a request waiting 16.581 seconds in the new document's default context;
it is not a stale-context failure. A matched diagnostic fails with the first-run
performance check active and passes when that check is cancelled before reload.
Both CPU profiles are dominated by React element creation during evaluation of
the entire Phosphor icon barrel: 14,988 ms self time with the check active and
7,542 ms with it cancelled. These are development reload diagnostics, not
packaged startup measurements. The original deadlines remain unchanged.
Receipts: `/tmp/videorc-beta-first-run-reload-guarded-YtIWyJ/report.json` and
`/tmp/videorc-beta-first-run-reload-profile-Sjksgp/report.json`. Both comparison
cases shut down without supervisor-forced cleanup. The initial trace launch
with missing Cargo profile settings was cancelled and supplies no app evidence.

Commit `97b739cf` changes the two icon registries to the package's published
per-icon exports. All 88 semantic slots, seven activity glyphs, icon weights,
SVG props and custom marks are preserved; production lazy chunk ownership
remains tested. A real Vite development optimizer regression fails against the
old barrel and passes after this change. Lint rejects both root and deep package
imports outside the two registries. Source verification passes 78 focused tests,
typecheck, lint, format, the production desktop build and all 606 desktop files
(6,670 passing tests, one existing skip). Receipt:
`/tmp/videorc-beta-icon-startup-source-0gsoFR/report.json`. The matched reload
now passes with the performance check confirmed active and original deadlines:
React element-creation self time is 40.498 ms in the retained profile. This
comparison preserves the native source and optimized backend bytes. Receipt:
`/tmp/videorc-beta-icon-startup-runtime-UorTPA/summary.json`.

The full maintained first-run smoke still **fails**, now at the later look
commit. Fresh setup, reload, motion, reduced motion and theme checks pass;
selecting Silk changes the card but not the registry or committed scene.
A targeted trace confirms a second defect: before reload the backend reports
a benchmark recording while the renderer is idle; after reload the renderer
believes a session is running. Before the look choice, the backend is idle and
the check finished, but the renderer remains blocked by the stale recording
state. The event relay suppresses benchmark lifecycle events, including Idle,
while the bootstrap `recording.status` query previously exposed that internal
session. Both verification queues close without forced orphan cleanup.
Diagnostic receipt:
`/tmp/videorc-beta-first-run-benchmark-state-CfN3s3/report.json`.

Commit `b687c8d3` excludes benchmark sessions from client recording-status
queries while leaving their internal status and owner intact. Real recording,
streaming and replay-only sessions retain their authoritative status, including
Stopping. A performance check is refused while a user's finalization lease is
active. The first native check failed compilation because the test module
lacked `Arc` qualification; pushed follow-up `6212803e` corrects those three
test references. Its runtime dispatcher refused the failed prerequisite.

Review found that a global benchmark-running flag could also hide a user's
finalization during takeover. The follow-up binds visibility to each
finalization lease instead. The monitor marks its lease from the session's
purpose before removing that session; a user's finalization stays visible
even while a benchmark flag remains set, and benchmark finalization stays
hidden after that flag clears. Counted leases keep capture, maintenance and
shutdown fenced until every owner releases its permit. The RPC regressions
cover both visibility directions; a synchronous coordinator regression polls
the actual admission and shutdown futures for all four user/benchmark owner
pairs, with no sleeps or child-process handshakes.

All 21 maintained `ffmpeg_work` tests pass in an isolated Rust harness that
imports the exact production module and cached project dependencies. A separate
ownership regression fails against `6212803e` and passes with the follow-up.
Receipt: `/tmp/videorc-beta-finalization-coordinator-gbanl11_/report.json`.
This does not replace full backend tests. The earlier native queue was stopped
before changing source; its runtime dispatcher again refused to launch. The
owned compiler PIDs were confirmed gone. The coordinator and RPC filters,
Clippy and optimized build will run before the maintained first-run,
100-cycle Linux preview, both direct 1080p30 matrices and both enforced
record-latency runs. No first-run deadline, quality budget or capture policy
was relaxed; this is not yet a verified runtime repair.

The native run on `3192134b` compiled in 6 minutes 31 seconds but then aborted
in the benchmark reload RPC regression with a stack overflow. Both real-session
and user-finalization takeover tests passed before the abort; the entire
filter is still a failure, and the runtime dispatcher did not launch any app.
The native supervisor reports no orphan cleanup. GDB reproduces the fault in
`handle_text_message_with_role` called directly by the test, with no recursive
call chain in the captured trace; no saved core or contemporaneous OOM event
was found. A one-off 8 MiB test-stack diagnostic passes the assertions, but
that is not gate evidence and the larger stack is not retained.

Test-only follow-up `2679ed95` uses the existing production boxed RPC dispatcher
instead of retaining multiple inline router futures in the test. The current
native queue explicitly unsets `RUST_MIN_STACK`, so the regression must pass
with the original default stack. Production status/finalization behavior and
all timing/artifact limits are unchanged. Diagnostic receipt:
`/tmp/videorc-beta-status-stack-classification.json`. All 56 actual backend tests selected by the four status, performance-check
and finalization filters now pass at the default stack size, with zero failures
or ignored cases. Receipt:
`/tmp/videorc-beta-status-rpc-stack-focused-summary.json`. Rust formatting also
passes, as does Clippy with the existing four Linux allowances. The optimized
backend/MCP build also passes; the runtime queue is superseded by the main
integration below.

The Windows diagnostic on `c8685c4d` passes all 48 controlled-audio cases and
fails 36 of the 48 independent FFmpeg control cases. Tails are 117–234 ms;
four cases also fail frame count. The failure remains in the documented
independent-control category, without a waiver, threshold change or retry.
Receipt: `/tmp/videorc-beta-windows-diagnostics-124647562663-classification.json`.

The full macOS recording-studio/device suite and main's new
`smoke:preview-check-invisible` require macOS/ScreenCaptureKit and cannot run
here. The Linux probes above are scoped development evidence. Combined-output,
latency, physical AppImage, endurance, pilot, update/rollback and publication
gates remain open; there is no accepted or published Linux Beta.

### CI and smoke-process integration, 2026-10-31

Main `e66c5cd4` is merged. The two conflicts overlap test corrections already
on this branch: retain the Settings tag parser that rejects scroll overrides
regardless of prop order, and the reviewed Plan 210 remote-command pin with
its explicit leak argument. Main contributes its CI build-profile and Windows
recovery-package fixes, plus owned cargo process-group cleanup. Native source
and Cargo inputs are byte-identical to `2679ed95` after this merge.

That source now passes all 56 focused backend tests with the original stack,
Rust formatting, Clippy with the four existing Linux allowances, and the
optimized backend/MCP build. The native supervisor reports no forced orphan
cleanup. Receipt: `/tmp/videorc-beta-status-rpc-stack-native-wtwbZP/report.json`.
The old runtime dispatcher was held before launch because main changes the
smoke harness. Source and runtime verification of this integration is pending;
these build results are not a first-run or Beta acceptance pass.

The merged `ac5af551` source verification is complete: 457 focused desktop
tests pass, all 606 desktop test files pass (6,670 passing tests, one existing
skip), all 3,000 Node tests pass without skips, and typecheck, lint, formatting
and the production frontend build pass. The source supervisor reaped only
its owned descendants and required no forced orphan cleanup. Receipt:
`/tmp/videorc-beta-main-e66c5cd4-source-To38gH/summary.json`. Runtime checks
wait for the separate diagnostic Rust compile below before launching, so the
compiler does not contend with app performance measurements.

The Linux hosted job `124684626545` passed FFmpeg policy/provisioning and
Clippy, then received a runner shutdown signal during test compilation after
about 6 minutes 40 seconds. It exited 143 without a test result; the external
cause is unknown and this was not the 45-minute job limit. One fresh attempt
was requested. The macOS job `124684715557` now compiles tests in 11 minutes
4 seconds, then fails both Metal golden-image cases and aborts on a stack
overflow in `live_chat::tests::session_chat_totals_fake_provider_rpc`. Its
84 MCP helper tests pass, but the backend suite and process/memory sentinel
do not complete. The abort loses the captured Metal failure measurements;
their magnitude and cause remain unknown. The existing image tolerances and
default test stack are unchanged. Classification receipts:
`/tmp/videorc-beta-linux-124684626545-classification.json` and
`/tmp/videorc-beta-rust-124684715557-classification.json`. The local chat RPC reproduction also aborts with the same stack overflow at
the default stack after a successful compile. Its supervisor reports no
forced orphan cleanup, and no saved core or OOM evidence was found. The
test-only shared helper now uses the production boxed Admin dispatcher;
verification of the original failing case and the other helper callers is
pending. No production router, assertion, readiness channel or stack limit
is changed. Before-failure receipt:
`/tmp/videorc-beta-chat-rpc-before-owned-cleanup.json`.

The first merged-source runtime attempt was stopped before readiness: the dev
app invoked `cargo run` and started compiling the backend despite the existing
verified binary. No first-run assertion ran, and the preview, recording and
latency steps never started. This interrupted setup is not runtime evidence.
The owned supervisor terminated and reaped only descendants of this run; the
queue and compiler PIDs are gone. The follow-up native queue puts the optimized
backend/MCP build after all tests, with no later compile before app launch.
Stopped-run receipt:
`/tmp/videorc-beta-main-e66c5cd4-runtime-27o6QR/report.json`.

### RPC stack regression, 2026-11-01

Local commit `13f7ad4f` fixes the original chat fixture at the default stack:
all 72 live-chat tests and eight other distinct shared-helper RPC tests pass,
with no skips or forced child cleanup. The broader native queue then aborts
in `preview_layout_public_api_cancels_an_older_in_flight_warmup`; the fresh
runtime dispatcher refuses that failed prerequisite and launches no app.
Receipt: `/tmp/videorc-beta-chat-helper-focused-summary.json`.

GDB reproduces the new failure while polling the real preview-layout handler.
The monolithic RPC dispatcher consumes 1,763,056 bytes of stack in this
unoptimized test build; its wrapper consumes another 109,536 bytes. Nested
scene-readiness calls cross the default test thread's stack boundary. The
captured call chain is not recursive, no core was retained, and no concurrent
OOM event was found. Trace: `/tmp/videorc-beta-preview-stack-frames.log`.

The follow-up constructs one boxed future for each authorized command instead
of polling every method through one large async match. Authorization and
input sanitization still precede dispatch; renderer resource redaction still
follows it. A syntax-tree comparison preserves all 309 method/fallback entries,
feature guards and command bodies; the fallback now owns its method string.
The exhaustive execution-policy test reads the new dispatcher. No stack size,
assertion, timing or artifact limit changes. The backend and test targets pass
`cargo check --locked -p videorc-backend --bin videorc-backend --tests` with
the existing unoptimized test-profile override; the owned supervisor reports
exit 0 with no interruption, forced cleanup or leaked children. All 54 desktop
RPC contract tests and Rust formatting also pass. Default-stack behavior
verification is next; this is not yet a runtime or Beta acceptance pass.
Comparison receipt: `/tmp/videorc-beta-rpc-router-equivalence.json`.
Compile receipt: `/tmp/videorc-beta-rpc-router-check-owned-cleanup.json`.

### Windows OAuth fixture failure, 2026-11-01

Windows source job `124684664664` on `ac5af551` passes Clippy and all 25
preview-bounds stability runs. The first source/audio ownership iteration
passes its Rust filters, then all 12 OAuth launch fixture cases fail: the mock
recognizes `cargo`, while the production Windows launcher correctly selects
`cargo.exe`. It consequently mistakes the build for the app. The remaining
24 ownership iterations, three full Rust runs and downstream source gates do
not run. This is a required source-gate failure, not the separate FFmpeg
incident diagnostic or a timeout.

A two-line fixture correction recognizes both executable names and asserts
the expected platform command. Its copied fixture reproduces all 12 failures
before the change and passes all 12 cases afterward, both on Linux and with
the Windows launcher branch exercised on Linux. Those simulated results do
not replace the required PowerShell 7 stability runs. Production launch code,
readiness assertions and deadlines are unchanged. The correction is now integrated after the native dispatcher verification
completed. Verification of the checked-in fixture and the full Node suite is
pending; the app queue remains held until that source evidence passes. Receipts: `/tmp/videorc-beta-windows-source-124684664664-classification.json`
and `/tmp/videorc-beta-oauth-launch-fix-receipt.json`.

The separate Windows incident diagnostic `124684664544` on the same source
passes all 48 controlled-audio cases. Its independent FFmpeg controls pass
12 cases and fail 36 streaming cases: packet A/V tails are 117–234 ms against
100 ms, and seven cases also miss the 2% frame-count tolerance. These are the
previously observed independent-control failure categories. The release
runbook's existing diagnostic exclusion does not turn them into acceptance
passes or exclude the required Windows source gates above. No threshold or
waiver changes, and no unchanged rerun. Receipt:
`/tmp/videorc-beta-windows-diagnostics-124684664544-classification.json`.

The per-command dispatcher now passes the default-stack preview-layout and
chat regressions, dispatch ordering/inventory, role/resource authority, the
remaining selected RPC tests, Clippy with the four existing Linux allowances,
and the optimized backend/MCP build. All 20 Linux-applicable filters execute passing tests (169 executions, 168
distinct tests, zero ignored). One additional filter selects a macOS-only Metal
frame-lease test: it executed zero tests on Linux and remains owed on macOS;
it is not counted as a pass. Platform classification:
`/tmp/videorc-beta-rpc-native-platform-classification.json`. The native
supervisor reports no interruption or forced child cleanup.
Receipt: `/tmp/videorc-beta-rpc-dispatch-native-2wqVBG/report.json`. The subsequent OAuth fixture change alters
no native input or production app code. Its source verification and the app
runtime gates remain separate prerequisites, not Beta acceptance.

### Fresh runtime classification, 2026-11-01

The checked-in OAuth fixture correction on `b3352a61` passes all 12 Linux
cases and all 12 Windows-branch simulations. The complete Node suite passes
3,000 tests with zero failures/skips; full lint and formatting pass. The source
supervisor exits successfully without forced cleanup. This closes the pending
source verification above, but does not supply native Windows stability evidence.
Receipt: `/tmp/videorc-beta-oauth-fixture-source-84BucV/report.json`.

The subsequent isolated development runtime queue completes all eight steps:

| Gate                         | Result and evidence                                                                                                                                                   |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First-run setup              | FAIL before its first acceptance step: the initial setup UI does not mount within the unchanged 15-second readiness deadline.                                         |
| Linux preview lifecycle      | PASS, 100 cycles and clean owned teardown.                                                                                                                            |
| Remote control               | PASS.                                                                                                                                                                 |
| Agents MCP                   | FAIL after local Go Live confirmation: the combined session's recording encoder FIFO exceeds its complete-frame delivery budget, and confirmed state returns to idle. |
| OpenH264 1080p30 matrix      | FAIL: exact-repeat-correlated freeze up to 1,133 ms and repeated-frame run 33, against 100 ms and two frames.                                                         |
| Intel VAAPI 1080p30 matrix   | FAIL: exact-repeat-correlated freeze up to 600 ms and repeated-frame run nine.                                                                                        |
| OpenH264 enforced latency    | FAIL: the first recording needs forced FFmpeg shutdown after Stop. No complete passing latency sample set.                                                            |
| Intel VAAPI enforced latency | FAIL: the first-cycle startup artifact repeats nine frames against the two-frame limit.                                                                               |

Both matrix artifacts retain the expected dimensions, 30 fps timestamps,
BT.709/video-range tags and H.264 level; their stop tails are 21 ms and 4 ms.
Those passing properties do not override the motion failures. Host receipts
show AC online with CPU-policy readings still near 800 MHz; the cause remains
unresolved, and the host observation is not a waiver. Only `renderD128` was
probed. Every owned supervisor completed without leaked or force-cleaned
orphans. Queue receipt:
`/home/orcdev/.cache/videorc-linux-beta-evidence/oauth-fixture-runtime-4qSAtG/report.json`.
Sanitized classification: `/tmp/videorc-beta-b3352a61-runtime-classification.json`.

A bounded startup trace reproduces the first-run failure and then observes the
Permissions screen about 15 seconds after the failed deadline. The blank
window is the shell's setup-loading placeholder, with no renderer exception.
The trace captures 340 module requests, including background Sources, Layout
and Settings imports while setup itself is still loading. The renderer remains
responsive. The trace's extra observation period is diagnostic only and does
not change the failed gate. Owned cleanup is complete. Receipt:
`/home/orcdev/.cache/videorc-linux-beta-evidence/first-run-import-trace-5jnn26m4/dispatch.json`.

A focused shell correction defers workspace prefetch and the active-page
loader until the workspace is visible, cancelling a pending prefetch when
setup replaces it. The existing page-loading hook otherwise preloads Studio
even though setup hides the workspace. The initial setup deadline and all
artifact/performance limits stay unchanged. The exact updated source passes
typecheck, lint and formatting. Its full desktop suite reaches 460 passing
file results, including all 142 first-run tests, before the scratch runner's
20-minute deadline expires (exit 143). No assertion failure is logged, but this
is an incomplete suite, not a pass; the subsequent production build does not
run. Owned cleanup completes without leaked or force-cleaned orphans. The
separate page-loading filter passes all three tests, bringing focused setup
and page-loading coverage to 145 passing tests. Receipt:
`/home/orcdev/.cache/videorc-linux-beta-evidence/setup-loading-source-CO6YLT/report.json`.
Classification: `/tmp/videorc-beta-setup-loading-source-classification.json`.

The matched startup recheck never launches an app: its 15-minute admission
wait expires while two compiler processes from a different checkout remain
active. No runtime assertion runs and no startup deadline is extended.
That checkout and its processes remain untouched. The full desktop suite and
production build remain required in CI; the maintained first-run app gate
remains owed when the shared host can admit it. No fresh full runtime or
candidate acceptance pass is claimed. Admission receipt:
`/tmp/videorc-beta-prefetch-host-block-classification.json`.

### Current macOS and Windows CI evidence, 2026-11-01

Hosted macOS job `124708363101` on `b3352a61` passes the Rust advisory audit,
format, Clippy and test compilation. All 84 library tests pass; the backend
suite completes with 4,328 passed, two failed and 22 ignored. Both reproduced
stack regressions, all 72 live-chat tests, the benchmark-status reload test
and the macOS-only Admin/frame-lease/disconnect test pass. The latter supplies
separate macOS execution evidence; it does not change the earlier Linux
zero-test classification. The two existing Beams/Ghost Fibers Metal golden
comparisons still fail. Their shader and reference inputs are unchanged from
integrated main, and pixel limits remain unchanged. The downstream
process/memory sentinel does not execute. This is not a complete macOS gate
or physical-device acceptance pass. Receipt:
`/tmp/videorc-beta-rust-124708363101-classification.json`.

Windows diagnostic job `124708368797` on the same source passes all 48
controlled-audio cases. Its independent FFmpeg controls pass 12 record-only
cases and fail 36 streaming cases: packet A/V tails span 117–267 ms against
100 ms, and five cases also exceed the 2% frame-count tolerance. These are the
existing independent-control failure categories. No unchanged rerun, limit
change or acceptance waiver is made. The runbook's existing diagnostic
exclusion does not waive required Windows source gates or provide Beta
acceptance. Receipt:
`/tmp/videorc-beta-windows-diagnostics-124708368797-classification.json`.

### Startup fix runtime and migration handshake, 2026-11-01

On pushed source `90b87533`, the maintained first-run smoke passes its original
initial readiness check and 31 checkpoints, including recording setup,
completion, reload, and replay. The backdrop starts moving 448 ms after setup
mount, within the unchanged 3,000 ms limit. No renderer exception is recorded.
The run then fails the existing-install migration assertion: the workspace is
visible, but the persisted record is still absent. Production startup
intentionally shows an existing workspace immediately and waits for runtime
information before writing that record. Receipt:
`/tmp/videorc-beta-setup-loading-runtime-classification.json`.

The smoke now waits for the persisted record within its existing 15-second
observation timeout before applying the unchanged migration assertions. New
Linux/macOS tests prove the ordering; negative analyzer cases still reject
missing and wrong-status records. Focused checks pass 121 desktop and 123 Node
tests. The complete Node suite passes 3,002 tests with zero failures or skips;
lint and full formatting pass. Production app and native inputs are unchanged
by this follow-up. Receipt:
`/tmp/videorc-beta-migration-source-classification.json`.

The corrected app rerun is **blocked before launch**. Host memory admission
reports 3–8% available memory, with a subsequent read below 400 MiB while
unrelated compilers run. The owned attempt is cancelled through its recorded
parent process handle before Electron launches. No runtime assertion executes;
cleanup leaves no leaked or force-cleaned orphan processes. This cancellation
is not a migration or startup result. The full rerun remains owed. Receipt:
`/tmp/videorc-beta-migration-admission-stop.json`.

The earlier 31-check run explicitly skips real OAuth sign-in. Its owned
cleanup also records an adopted Electron process ending with SIGTRAP. No saved
core or matching kernel OOM/trap event is available, so the cause remains
unresolved. Neither partial checks, the OAuth skip, nor completed process
reaping establish a healthy full first-run or physical acceptance pass.

The updated instructions' `pnpm ui:check` is now included in the Linux source
gate manifest. Its actual run fails: the published Record-button variant has
advanced from `chrome-led border-0` to a chrome-bezel recipe while this checkout
retains its older theme. Registry CLI documentation, dry-run and file diff are
inspected; no component, theme, dependency or registry manifest is overwritten.
A matching registry/theme update and a clean drift check remain required.

CI on `90b87533` reproduces the two existing Metal golden failures after 84
library and 4,328 backend test passes; audit, format, Clippy and compilation
pass, and the downstream sentinel does not run. Windows diagnostics pass all
48 controlled-audio cases and 12 independent record-only cases; 36 independent
streaming cases fail 117–267 ms tails, with six also failing frame count.
Limits and release exclusions are unchanged. Receipts:
`/tmp/videorc-beta-rust-124721181458-classification.json` and
`/tmp/videorc-beta-windows-diagnostics-124721205478-classification.json`.

### First-run look isolation, Windows glob paths and quit evidence, 2026-11-01

The idle capture-config reload now permits a user scene commit beside a private
performance check. Real active and stopping sessions still refuse that reload
without mutating the scene. Native regressions cover both states, no unnecessary
device startup, and fresh/in-place benchmark encoder isolation. Before the fix,
the private-check test fails and the real-session fence passes. After the fix,
164 native test executions covering 162 distinct tests pass with zero ignores.
Rust formatting, Clippy with the four existing Linux allowances and the optimized
backend/MCP build pass. Native report:
`/home/orcdev/.cache/videorc-linux-beta-evidence/idle-scene-fix-RC93ZH/report.json`.

Windows source CI on `036eb06e` executes merge tree `5564f307` against
`f80f63d6`: Clippy, the required 25-repetition stability groups and three full
Rust runs pass. Each Rust run passes 4,202 backend tests (20 ignored), 24 bridge
tests and both one-test targets. Desktop tests pass 6,674 and fail only the icon
optimizer entry scan (five skipped). Vite treats entries as globs; Windows
backslashes match no files. Both paths now use Vite's `normalizePath`, retaining
the real optimizer and original assertions/timeouts. All ten icon tests and
full typecheck/lint/format pass locally; native Windows revalidation is owed.
Complete job classification: `/tmp/videorc-beta-windows-source-124736625614-classification.json`.

The first-run smoke now requests authenticated normal app quit before checking
owned process retirement and empty ledgers. A refused quit, timeout, fallback
termination, stale ledger or unsuccessful controller exit fails the smoke.
Overall PASS is printed only after final teardown. All 160 focused shutdown,
first-run and process-evidence tests pass; the full Node suite passes 3,007 with
zero skips, and lint/format pass. Source receipt:
`/home/orcdev/.cache/videorc-linux-beta-evidence/first-run-graceful-source-classification.json`.

The matched app run passes all 51 behavior assertions, including look changes,
migration and Skip setup, with zero renderer exceptions. Recording and
livestream setup profiles quit normally with clean ownership. The Skip setup
profile fails the existing ten-second shutdown deadline while its private
performance check is finalizing; fallback cleanup records Electron SIGTRAP and
backend SIGKILL. All owned descendants are reaped, but the run correctly fails.
Real OAuth sign-in remains skipped and preview lifecycle does not execute.
Receipt: `/home/orcdev/.cache/videorc-linux-beta-evidence/first-run-graceful-runtime-classification.json`.

The same process census shows Chromium selecting quarantined `renderD129` even
though backend VAAPI uses `renderD128`. Further app runs are blocked until an
app-scoped Chromium override explicitly selects the permitted node and launch
evidence confirms it. No desktop configuration or GPU policy is changed. These
are development results, not AppImage or physical Beta acceptance; existing
quality, latency, endurance and publication gates remain open.

### Intel-only command isolation and fresh setup result, 2026-11-01

`pnpm linux:with-render-node <command> [args...]` now requires an explicit
permitted render node and uses Bubblewrap to expose only that node and its
matching DRM card under `/dev/dri` for the command and descendants. It derives
Mesa's PCI preference from the permitted device; ambiguous nodes, aliases,
non-devices and unavailable isolation fail before unrestricted execution. The
wrapper replaces itself with Bubblewrap to preserve caller PID/signal ownership.
It changes no host desktop configuration. The named-box procedure is in
`docs/linux-dev-loop.md`.

All 45 focused isolation, launcher, first-run teardown and Linux gate tests
pass with zero skips. The actual wrapper on Ogre exposes exactly `card1` and
`renderD128` with Mesa preference `pci-0000_00_02_0`. A minimal Electron probe
under the same mount restriction renders WebGL through Intel UHD 630, has only
`renderD128` GPU handles, and exits normally with no forced cleanup. Probe:
`/home/orcdev/.cache/videorc-linux-beta-evidence/intel-electron-probe-syMJZu/report.json`.

The full maintained first-run run on `a015a8ea` under Intel-only isolation
passes 36 assertions and fails the next no-device-starts assertion during
resumed setup after the What's New case. Its guard begins at 05:58:07.737 UTC
before reload; a camera generation starts at 05:58:07.881 UTC, and the
pre-leave snapshot has 406 captured frames. The source transitions from
`device-missing` at guard entry to `live`. Whether an already-admitted old
workspace request crossed the reload boundary remains under investigation;
the failure is retained without weakening the privacy contract.

All 90 sampled owned-process GPU observations use the allowed node. Normal
quit and all owned child exits are clean. Livestream setup, Skip setup shutdown
and preview lifecycle do not execute after the assertion failure. This run
does not resolve the earlier private-benchmark shutdown overrun. Receipt:
`/home/orcdev/.cache/videorc-linux-beta-evidence/intel-first-run-classification.json`.

The additional Electron recheck through the promoted wrapper is blocked by
host memory admission (about 5%, 831 MiB available). The exact recorded owner
is stopped before launch: it has no children and no app/cleanup report. No
GPU/app test runs in that attempt, and the memory guard remains enabled.
Receipt: `/home/orcdev/.cache/videorc-linux-beta-evidence/intel-wrapper-admission-stop.json`.

### Source-request attribution across setup reloads, 2026-11-01

The first-run smoke now records source-affecting WebSocket send attempts with
their renderer document identity, timestamp and visible setup state. Reload
receipts retain the previous and next document identity, and each capture guard
records its opening document. This distinguishes an old workspace request from
a request made by the newly loaded setup document. The trace retains no RPC
payloads, credentials, socket URLs or device identifiers. It is diagnostic;
backend capture-generation and preview-state assertions remain unchanged.

All 3,014 Node script tests pass with zero skips, including four new observer
tests for document attribution, payload exclusion, transparent forwarding and
native send errors. Formatting, syntax and diff checks pass. Owned test cleanup
needs no supervisor signals and leaves no descendants. Logs and cleanup receipt:
`/home/orcdev/.cache/videorc-linux-beta-evidence/source-request-trace-tests.log`
and `source-request-trace-tests-cleanup.json` in the same directory.

The maintained Intel-only wrapper launches the instrumented real app on Ogre.
Fourteen assertions pass before the Welcome backdrop switches to a still with
reason `gpu-budget` when motion is restored. This is the player's frame-cadence
guard; the run does not establish whether CPU scheduling or GPU work caused it.
The motion assertion correctly fails. All 34 GPU observations use only the
permitted node, renderer exceptions are absent, and normal quit succeeds with
empty process ledgers and no forced child cleanup. The trace records idle scene
configuration requests across two documents without retaining their arguments.

The resumed setup/reload scenario and later profiles do not execute, so neither
the prior camera-start failure nor private-benchmark shutdown overrun is resolved.
No identical retry or relaxed motion/privacy/shutdown limit is used. This remains
development evidence, not physical candidate acceptance. Classification:
`/home/orcdev/.cache/videorc-linux-beta-evidence/source-request-trace-runtime-classification.json`.

### Windows installer recovery-probe handshake, 2026-11-01

The Windows installer job on `5017bf97` builds successfully and passes packaged
capture-worker validation, live microphone controls, 1080p recording duration/A/V,
native DXGI/GDI ScreenOnly capture/BMP preview, and preview during recording.
The separate CDP-enabled test package passes five window scenarios, but its
crash-recovery case fails. Installer upload does not run. Job:
<https://github.com/TheOrcDev/videorc/actions/runs/41279177796/job/124767487650>.

The failed probe reports `crashed: true` despite having no renderer-exit or
reload log, and the retained desktop screenshot still shows a mounted UI. Its
implementation returned true after a 500 ms sleep and discarded the `Page.crash`
response/error. Actual crash injection is unproven; these observations alone do
not establish a product recovery regression.

The probe now enables CDP Inspector observations before requesting the crash,
keeps its connection until an explicit `Inspector.targetCrashed` event or bounded
deadline, and retains protocol errors. An ordinary command response, socket
closure, refused command or elapsed time cannot count as a crash. Remount and
both backend log witnesses remain required, with the same 45-second recovery
budget. Production recovery code and the installer-under-test bytes are unchanged.

The 28 focused gate, package-isolation and observer tests pass. All 11 observer
tests pass in 25 Linux repetitions; the full Node suite passes 3,025 tests with
zero skips. Formatting, syntax and diff checks pass. These portable results are
not native Windows stability evidence: the PowerShell 7 repetitions, three full
Windows Rust suites and corrected packaged recovery smoke remain owed on the new
head. No superseded-head retry or waiver is used.

Failed-run artifact, log hashes and classification:
`/home/orcdev/.cache/videorc-linux-beta-evidence/windows-installer-job-124767487650-classification.json`.
Local verification: `renderer-crash-observer-tests.log`,
`renderer-crash-observer-tests-cleanup.json` and
`renderer-crash-observer-repeat.json` in the same directory.

### Windows source-gate portability correction, 2026-11-01

The current `c335e9ac` Windows source job, tested on merge tree `62a91d9`,
passes Clippy, the existing 25-pass preview/source/audio stability groups, and
three full Rust suites. Each full suite passes 4,205 backend tests with 20
ignored, 24 bridge tests and both single-test targets. All 609 desktop test
files pass: 6,682 tests pass and five are skipped. This confirms the earlier
Windows icon-glob correction. These skips remain explicit, not acceptance.

The Node gate passes 2,911 tests, skips 99 and fails one: the Linux render-node
planner uses host-native `node:path.join` for its Linux sysfs path. On Windows,
that produces backslashes even though the fixture selects a Linux target. The
planner now explicitly uses `node:path/posix`; device authorization, card
ownership checks and mount isolation remain unchanged. The existing fixture
reproduces the exact Windows path mismatch locally when `node:path` is routed
to `node:path/win32`, and all three fixture tests pass after the correction.
That controlled reproduction is not a native Windows run.

All 3,025 Node tests pass locally with zero skips after the correction. The
owned test supervisor sends no cleanup signals and leaves no descendants;
focused path tests and explicit module/document formatting checks also pass.

The actual corrected wrapper on Ogre still exposes exactly `card1` and
`renderD128`, with Mesa preference `pci-0000_00_02_0`; no other GPU is probed.
The source job did not reach formatting, TypeScript, ESLint or advisory audits
after the Node failure. Fresh CI must complete the source gate. Job:
<https://github.com/TheOrcDev/videorc/actions/runs/41281490434/job/124774256529>.

The separate current-head installer job passes build/upload, packaged capture,
audio and preview checks, plus all six recovery scenarios. The crash case has
an explicit `Inspector.targetCrashed` event, both renderer-exit/reload log
witnesses and a remounted UI. This proves the corrected probe on the separate
CDP test package; it does not replace native repeated observer verification or
Linux candidate acceptance. Job:
<https://github.com/TheOrcDev/videorc/actions/runs/41281490434/job/124774256442>.

Windows diagnostics still fail 36 independent streaming controls on
114–264 ms audio tails against the unchanged 100 ms limit, with six cases
also failing frame count. The 48 controlled-audio cases and 50 standalone
PCM EOF candidates pass; the earlier 10.219-second encoder-start outlier is
retained as unresolved. Linux runtime, physical acceptance and publication
gates remain open. Evidence and hashes are under
`/home/orcdev/.cache/videorc-linux-beta-evidence/`.

### Preview smoke failure identity, 2026-11-01

Windows installer job `124789364448` on `03a1a479` passes the installer build,
capture-worker checks, live microphone controls, packaged recording A/V and
native screen/BMP preview. Preview during recording fails: the first attempt's
steady p99 is 525 ms against 500 ms. The second direct measurement is within
budget, but its sampled diagnostics reach p95 452 ms against 350 ms. Recovery
and installer upload do not run; the recovery upload finds no files. Job:
<https://github.com/TheOrcDev/videorc/actions/runs/41286687491/job/124789364448>.

The app, native code, preview smoke and workflow inputs are unchanged from the
prior passing `c335e9ac` job, and both CI merge trees use main `196360f0`. That
does not establish the cause of the latency. Both failed attempts remain
evidence; the previous green result does not override them.

The smoke has a confirmed error-handling defect: `assertStatsHealthy` passes
only `error.message` to the failure policy, replacing `PreviewLatencyGateBreach`
with a generic `Error`. The existing retry driver checks the original error
type, so this run exits after attempt two despite four configured attempts.
The extracted production wrapper reproduces that loss without launching an app.

A shared synchronous failure policy now preserves the original error across
the statistics wrapper, including its type, stack and cause. Direct-measurement
and diagnostic latency failures reach the same existing retry policy. Generic
and combined failures remain fatal; report-only warnings still require explicit
configuration. The attempt count, latency limits, warmup, artifact analyzers,
process cleanup and production preview code are unchanged.

All 35 focused failure-policy, preview diagnostics, source and window gate tests
pass, including six new failure-policy regressions. The actual wrapper
reproduction preserves the typed error after the fix. The packaged Windows
smoke cannot run on Ogre; fresh native CI is required to verify the complete
runner. This correction does not resolve the measured latency or qualify a
Linux Beta candidate. Classification and wrapper reproduction:
`/home/orcdev/.cache/videorc-linux-beta-evidence/windows-installer-job-124789364448-classification.json`
and `preview-failure-policy-wrapper-repro.json` in the same directory.

The initial full Node run passes 3,030 tests and fails one when FFmpeg receives
`EDQUOT` writing a noise-cleanup fixture on quota-limited `/tmp`. The failure is
retained. With only `TMPDIR` moved to an isolated disk-backed directory, the
affected artifact test and all 3,031 Node tests pass with zero skips. Owned
cleanup completes without supervisor signals or leaked descendants. Full
formatting, explicit changed-file formatting, syntax and diff checks pass.
Verification: `preview-failure-policy-fix-classification.json` in the evidence
directory above.

### Benchmark cancellation during process shutdown, 2026-11-01

The shutdown latch was absent from the performance check's cancellation
predicate. Quitting during setup could therefore leave its private encoder
flushing while shutdown held the session-publication fence. The runner now
checks shutdown before and after capture-slot admission, before holding the
Preview, and at every measurement/drain cancellation boundary. A timed-out
benchmark start uses the same cancellation-aware stop path. Only the existing
benchmark-only encoder termination path is used; the production recording
monitor remains responsible for terminal finalization.

Five regressions cover shutdown before admission, shutdown while admission
waits, preserving the prior verdict and Preview before a ladder starts,
interrupting measurement, and drain cancellation while shutdown holds the
publication fence. The drain test owns a directly spawned stdin sink, bounds
its wait/kill/reap, and exercises the production monitor's permit handoff.
Their `ffmpeg_` names put them in the existing Windows 25-pass ownership filter;
the required three full Windows Rust runs still apply.

Verification is **pending CI**. The local test-only baseline compilation was
stopped after more than ten minutes on battery with all cores near 800 MHz;
its compiler used about 6.4 GiB and host available memory fell to about 2.4 GiB.
The owned supervisor reaped the compiler after termination. No regression test
executed, and no passing baseline, fixed runtime result, or fresh production
binary is claimed. Matching first-run, recording-studio/Linux equivalents,
encoder matrices and enforced latency remain required on a powered host.

The completed preceding source head `8679de73` has Linux, JS, Windows source
and Windows installer passes. Windows source ran all 38 existing ownership
groups 25 times and three Rust suites (4,233 passed / 20 ignored each), 6,707
desktop tests (5 skipped), and 2,929 Node tests (99 skipped). The two macOS Metal
goldens and 36 Windows independent streaming controls remain failed. Those
results qualify that preceding tree only. Local evidence classifications are
in `~/.cache/videorc-linux-beta-evidence/ci-8679de73-classification.json` and
`windows-source-job-124841524543-classification.json`.

No Linux Beta candidate has been accepted or published. Physical Ubuntu and
Hyprland AppImage acceptance, endurance, the seven-day pilot, updates/rollback,
and protected publication remain open alongside the feature/runtime ledger.


### Main integration and macOS CI follow-up, 2026-11-01

The shutdown fix `c22bb0c1` was tested on merge `45420f99` with newer main
`d3bac98c`. macOS job `124924319031` passes the advisory audit, formatting,
Clippy, compilation, 84 library tests and all five new shutdown regressions.
The backend suite has 4,357 passes, four failures and 22 ignored tests. The
process/memory sentinel does not run after those failures. Job:
<https://github.com/TheOrcDev/videorc/actions/runs/41332117573/job/124924319031>.

Two failures come from the newer main changes. The Pulse matching test sleeps
130 ms in real time; on a busy runner its capture packet can pass the unchanged
250 ms age limit and correctly be dropped before the assertion. The raw-byte
matching loop now has injectable receipt/time, allowing the actual Pulse,
AVFoundation and DirectShow budgets to be exercised without scheduler sleeps.
Tests cover delayed PCM, timeout, cancellation, partial disconnect and bytes
buffered for the next packet. The existing assembler timestamp/sample tests
remain. Production polling, match/age limits and stale-packet handling are
unchanged. This does not prove physical microphone or final-artifact A/V quality.

The remote page's copied chrome LED tokens lagged the desktop's metallic LED
change. Both remote themes now use the desktop's gradient, flat color,
highlight and glow values. All six existing served-page palette tests pass
when compiled directly from the maintained test module; before the correction,
five pass and the chrome parity test fails. An isolated extraction of the
production PCM matcher, protocol budgets and five tests also passes. Restoring
Pulse's old 100 ms match budget in that scratch harness fails the delayed-PCM
regression. Full backend compilation/execution of these corrections is still
required in CI; the extraction is only focused evidence.

The other two macOS failures remain the Metal golden comparisons: Beams worst
mean/max-cell 21.723/229 and GhostFibers 1.677/88. No shader, golden, tolerance
or waiver change is made. Windows shutdown stability repetitions and matching
real-app shutdown evidence remain pending.

Linux job `124924298778` passes FFmpeg policy (7/7), provisioning and Clippy,
then receives a runner shutdown signal during test compilation (exit 143),
before any Rust test executes. One targeted rerun was requested; this is an
interrupted gate, not a pass. Job:
<https://github.com/TheOrcDev/videorc/actions/runs/41332117474/job/124924298778>.

Main `8f2bdf03` is integrated without conflicts. Its 0.17.4 package version is
upstream release state, not a selected or accepted Linux Beta candidate.
Local full native/runtime verification remains blocked by the current host:
Ogre is on battery at approximately 800 MHz with about 2 GiB available memory.
Fresh binaries, recording-studio/Linux equivalents, both encoder matrices,
latency and physical AppImage acceptance remain required. Classification and
focused logs are under `~/.cache/videorc-linux-beta-evidence/`.
