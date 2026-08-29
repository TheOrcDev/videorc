# Releasing Videorc (macOS Beta) — Runbook

How to cut a new version and make existing users auto-update to it. This is the
repeatable per-release process. For one-time signing setup see
[macos-signing.md](macos-signing.md); for the broader packaging reference see
[../distribution.md](../distribution.md).

This runbook publishes the **macOS Beta only**. Windows is a separate,
default-deny **Alpha** track. Do not rename these artifacts, reuse the macOS R2
keys, or treat a Windows CI artifact as a release.

## Windows Alpha Is A Separate Gated Track

A Windows 11 x64 candidate stays private until all of the following are recorded
as `PASS` in a dated copy of
[../acceptance/windows-app-acceptance-template.md](../acceptance/windows-app-acceptance-template.md):

1. `pnpm smoke:local-gates:windows` completes on a real Windows 11 x64 machine,
   including the physical-device gates and strict
   `support-bundle:verify --windows-acceptance` step.
2. Authenticode status is valid, the certificate subject exactly matches the
   pinned publisher identity, and a trusted timestamp is present.
3. The release manifest SHA-256 and byte size exactly match a newly downloaded
   installer, and a current Microsoft Defender scan reports no detections.
4. A clean user profile proves install, first launch, real-source recording,
   update/feed behavior, rollback behavior, and uninstall/process cleanup.
5. A sanitized accepted-evidence record, release notes, and known-issues URL are
   public, while recordings, credentials, support bundles, device IDs, and local
   paths remain private.

Any failed or blocked gate keeps the Windows download unavailable. Never mutate
an installer or manifest in place; issue a new Alpha identifier after fixing the
candidate. Development setup and evidence handling are documented in
[../windows-dev-loop.md](../windows-dev-loop.md) and
[../distribution.md](../distribution.md).

## What a macOS release is

Two artifact sets in the same private R2 bucket (`videorc-releases`), fronted by
videorc-web:

| Artifacts                                                     | R2 keys                                             | Web route                                             | Audience                     |
| ------------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------- | ---------------------------- |
| **Download** (dmg + sha256 + release.json)                    | `releases/macos/<releaseId>/`                       | `/api/downloads/macos/latest` (auth-gated, presigned) | New users                    |
| **Update feed** (`latest-mac.yml` + `.zip` + `.zip.blockmap`) | `updates/macos/` (stable, overwritten each release) | `/api/updates/*` (public, presigned)                  | Existing users auto-updating |

The desktop **Settings → About & updates** button — and the automatic launch
check (default in packaged builds since 0.9.10; opt out via
`VIDEORC_DISABLE_AUTO_UPDATE=1`) — read the feed.

## Versioning model

- **`apps/desktop/package.json` `version` is the update key.** electron-updater
  copies it into `latest-mac.yml` and compares it to the installed app's version.
  **A strictly higher version is what triggers an update offer** — to ship an
  update you bump this value. Same version installed = "you're up to date".
- `releaseId = <version>-beta.<N>` (e.g. `0.9.1-beta.1`) names the **download**
  archive path only; set `N` with `VIDEORC_RELEASE_BETA_NUMBER`. The feed compares
  on `<version>`, not the releaseId.
- Bump semver normally: `0.9.0 → 0.9.1` (patch), `→ 0.10.0` (minor).

## Prerequisites (per build machine)

- **Apple signing** — `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` in the env
  (team `C2PA37RB58` is baked by `dist:release`); Developer ID cert in the
  keychain (or `CSC_LINK`). See [macos-signing.md](macos-signing.md).
  **Auto-update requires a signed build** — electron-updater refuses to apply an
  unsigned/ad-hoc update.
- **R2 write creds** — the `VIDEORC_DOWNLOAD_S3_*` values (same bucket as
  videorc-web), with an **Object Read & Write** token. They live in the web app's
  `.env` (`~/projects/videorcweb/.env`).
- **YouTube OAuth paused** — do not require or bundle Google OAuth credentials
  while Videorc awaits Google approval. YouTube remains available through Manual
  RTMP, and `release:validate:macos` does not check for a bundled YouTube OAuth
  secret while this pause is active.
- **⚠️ Bucket-less S3 endpoint** — `VIDEORC_DOWNLOAD_S3_ENDPOINT_URL` must be the
  ACCOUNT host only: `https://<account-id>.r2.cloudflarestorage.com` — **NOT**
  `.../videorc-releases`. The path-style client appends the bucket itself; an
  endpoint that already includes the bucket **doubles** it, so objects land at
  `videorc-releases/updates/...` (where nothing reads them) while the upload still
  reports success. If your `.env` endpoint has the bucket suffix, fix it there or
  override per-run (Step 3 below).

## Cut a release

```sh
cd ~/projects/videorc

# 1. Bump the version (the update key), write the changelog entry, and commit.
#    Edit apps/desktop/package.json -> "version": "0.9.1"
#    Write changelog/<releaseId>.md (user-facing; see changelog/README.md) —
#    validate + upload both FAIL without it (escape: VIDEORC_RELEASE_SKIP_CHANGELOG=1).
pnpm changelog:check
git commit -am "Release: bump desktop to 0.9.1"

# 2. Build + sign + notarize + staple, WITH the update feed, + write release.json.
#    (dist:desktop:release = the signed build incl. the zip/latest-mac.yml feed,
#    unlike dist:desktop:signed which is dmg-only.) Slow: rebuilds backend+ffmpeg.
export APPLE_ID=…  APPLE_APP_SPECIFIC_PASSWORD=…
pnpm dist:desktop:release

# 3. Validate the signed artifact (codesign / Gatekeeper / staple).
pnpm release:validate:macos

# 4. Load R2 creds and upload the download + feed.
set -a; . <(grep -E '^[[:space:]]*VIDEORC_DOWNLOAD_S3_' ~/projects/videorcweb/.env); set +a
# Force a bucket-less endpoint (skip if your .env endpoint is already host-only):
export VIDEORC_RELEASE_UPLOAD_S3_ENDPOINT_URL="https://<account-id>.r2.cloudflarestorage.com"
pnpm release:upload:preflight:macos
pnpm release:upload:macos       # uploads dmg + sha + release.json + latest-mac.yml + zip + blockmap
                                # + the compiled changelog -> changelog/changelog.json
```

`release:upload:macos` fails closed if the feed files are missing,
`latest-mac.yml` points at a stale zip, or there is no valid
`changelog/<releaseId>.md` entry — so a broken feed or an unannounced release
never publishes. The changelog JSON feeds videorc-web `/changelog` and the
desktop "What's new"; `VIDEORC_RELEASE_SKIP_CHANGELOG=1` is the loud emergency
escape.

Newsletter: `pnpm changelog:email <releaseId>` renders the entry to
email-ready HTML + plaintext under `dist/changelog/email/` (sending is manual —
no ESP is wired yet).

Discord announcement: after the feed is verified, `pnpm release:notify:discord`
posts a short "what's new" (release title + up to 4 changelog highlights) to the
Videorc Discord channel. `-- --dry-run` previews without posting; a releaseId
argument re-announces an older release. The webhook is a post-anywhere
credential and this repo is PUBLIC, so it is **never committed** — it lives in
`~/.videorc-release.env` as `VIDEORC_DISCORD_RELEASE_WEBHOOK` (gitignored,
already sourced by the build); the script refuses to run without it and never
echoes the URL.

## Verify (always follow the redirect to R2)

```sh
# Feed serves the NEW version:
curl -sL https://www.videorc.com/api/updates/latest-mac.yml | head
#   -> version: 0.9.1 ...
# The zip it references resolves (200, not 403/404):
curl -s -o /dev/null -w '%{http_code}\n' -L \
  https://www.videorc.com/api/updates/Videorc-0.9.1-mac-arm64.zip
```

The download page follows automatically: the upload also publishes the
manifest to the STABLE key `releases/macos/latest/release.json`, which
videorc-web's `VIDEORC_DOWNLOAD_MANIFEST_OBJECT_KEY` points at (one-time Vercel
setting — do NOT pin it to a versioned key, or the download page freezes on
that release while the update feed moves on).

## macOS acceptance gate

A signed beta is releasable only after a clean-machine pass recorded under
`docs/acceptance/` — use
[../acceptance/macos-release-candidate-template.md](../acceptance/macos-release-candidate-template.md).
Add a per-release note `docs/releases/<version>.md` (see
[0.9.0-beta.1.md](0.9.0-beta.1.md)).

### Capture-decay release gates

`pnpm smoke:local-gates` includes the capture-decay contract test and both
long-uptime sentinels below. Budget at least 75 minutes for them: a 60-minute
idle synthetic soak followed by one 15-minute synthetic hard-content recording.
The recording variant delegates to the maintained session-decay recorder and
must pass final bridge accounting and ffprobe/ffmpeg artifact analysis. It also
samples preview/recovery state and source-surface ownership throughout the same
recording session, fails on a lagged backend event stream, and requires both the
artifact and final-accounting durations to reach at least 97% of the requested
time. A created or non-empty file is not sufficient. The macOS release job has a
four-hour bound so these 75 minutes fit alongside build, Rust, signing, and
packaging work.

Both release sentinels pin the production macOS preview path and require every
sample to report `native-surface` / `cametal-layer`, at least 1 presented frame
per second, preview-frame age no higher than 1000ms, input-to-present p95 no
higher than 1000ms, and the Metal compositor. The recording sentinel additionally
requires `recordingProtected=true` plus both the requested and effective encoder
bridge output to remain `videotoolbox-h264-mpegts`; a silent fallback is a gate
failure even when the artifact itself is playable.

Run them separately when investigating a candidate:

```sh
pnpm smoke:capture-decay-soak:contract             # deterministic oracle/config tests
pnpm smoke:capture-decay-soak:quick                # 1m harness/oracle preflight
pnpm smoke:capture-decay-soak:gate                 # fixed 60m release sentinel
pnpm smoke:capture-decay-soak:long-recording       # fixed analyzed 15m sentinel
pnpm smoke:capture-decay-soak:long-recording:endurance  # overridable 60m investigation
pnpm smoke:capture-decay-soak:recovery:investigate # real camera+screen debug recovery recording
```

The full `smoke:local-gates` command intentionally invokes the 60-minute idle
gate and the 15-minute recording gate; neither is opt-in there. The separate
60-minute recording endurance command, 8-hour synthetic investigation, and
4-hour real-source investigation are opt-in. Run the one-minute quick profile
first: it uses one-second sampling and evaluates the surface-slope oracle over
the short window, so launch,
incremental artifacts, cadence/coverage/retention verdicts, teardown, and the
terminal checkpoint can fail fast before committing to a long run. A quick
profile pass is harness preflight only and is not release evidence.

The maintained `:gate` and `:long-recording` release commands are hermetic. They
overwrite every evidence-shaping selector, duration, sample interval, launch and
per-RPC timeout, coverage/gap/surface/slope threshold, source-rate/age floor, and
video profile. The script-level `--release-gate` mode also rejects conflicting
values if it is invoked directly. Use the `:investigate`, `:quick`, or
`:long-recording:endurance` commands for focused overrides such as
`VIDEORC_SOAK_MINUTES`, `VIDEORC_SOAK_SAMPLE_SECONDS`,
`VIDEORC_SOAK_LONG_RECORDING_MINUTES`, or `VIDEORC_DECAY_RECORDING_MS`; their
artifacts are not release evidence. The idle soak writes
`capture-decay-soak.csv` incrementally and atomically checkpoints
`capture-decay-soak.json`; interrupted runs keep every completed sample but do
not count as a pass. Synthetic release mode explicitly enables hard moving
content (`VIDEORC_SMOKE_PREVIEW_MOTION=1`) while stopping camera and screen
preview sources. All real-source, debug-executable, and packaged-app selectors
are scrubbed, so inherited shell state cannot contaminate release evidence.

The default evidence contract requires at least 95% of the sample count
scheduled from duration / interval (missing samples do not shrink the
denominator), no gap longer than three sample intervals, per-source surface
live/peak counts no higher than 12/16, no positive live-count trend above 0.05 surfaces/minute over
the qualifying 10-minute-or-longer window, and no end-of-run live-count growth
beyond the active baseline plus two. After capture teardown, both source surface
live counts must return to their exact pre-start baselines within 10 seconds.
The CSV also retains camera/screen callback, frame-store publication,
compositor fresh/held, preview-frame-age, native input-to-present p95, and both
the surface-status and diagnostic transport/backing evidence. Focused probes
may override thresholds with the `VIDEORC_SOAK_MIN_*`,
`VIDEORC_SOAK_MAX_*`, and `VIDEORC_SOAK_SURFACE_*` variables documented at the
top of `scripts/smoke-capture-decay-soak.mjs`; a run shorter than the configured
slope window reports that the slope was not evaluated and is not release
evidence.

Before declaring the real-device decay fixed, also run the installed-app path
on the owner account with Camera and Screen Recording permission. It explicitly
selects native AVFoundation and ScreenCaptureKit devices, opens a visible motion
stimulus, and refuses to start the timed soak until both callback and frame-store
publication counters advance in three consecutive polls about two seconds apart.
Real validation defaults to the field profile, 3840x2160 at 30 fps. The harness
uses the renderer-safe `scene.load_from_capture_config` command, then validates
the exact committed screen/camera scene, returned revision, compositor scene
revision, and rendered-frame revision before time starts. The readiness budget
is 90 seconds. Every successful poll must also report the exact selected source
IDs, a live `native-surface` /
`cametal-layer` preview in both status and diagnostics, and finite
preview-frame-age and source-to-present p95 latency samples. During the run,
camera and screen callback, publication, compositor-fresh, sequence, and age
evidence is checked every two seconds. Producer cadence floors are derived from
the median negotiated `sourceFps` observed across the final three ready polls
(with the requested target only as a compatibility fallback); compositor-fresh
floors use the lower of source and compositor cadence. This prevents a 60 fps
camera decaying to 20 fps from passing merely because the compositor is 30 fps.
Three consecutive failures stop the run within the six-second detection budget.
Real mode refuses inherited synthetic-content flags rather than silently
contaminating the device evidence. It also rejects source zero-copy kill
switches or forced camera/screen CPU-copy modes, and readiness requires positive
camera and screen IOSurface live/peak counts; a copied-source run is not D3
evidence:

```sh
VIDEORC_SOAK_REAL_SOURCES=1 VIDEORC_SOAK_MINUTES=240 \
  pnpm smoke:capture-decay-soak
```

This captures the real screen. Preserve the CSV/JSON evidence outside the
temporary directory named by the harness, or set `VIDEORC_SMOKE_OUTPUT_DIR` to
an explicit evidence directory. The release decision requires three consecutive
four-hour real-source passes after a capture-retention or restart fix.

Every raw recovery RPC sample and every `capture.recovery.status` event is
retained in the JSON checkpoint; revision, phase, stage, retryability, source
generation, attempts, last duration, and last error are also columns in the CSV.
The verdict follows first-seen strictly increasing backend revisions,
deduplicates identical equal revisions, and fails equal revisions with
conflicting payloads. An older status RPC that arrives after a newer event is
retained but cannot roll the verdict backward. Any `events.lagged` signal fails
the run because the phase history is then incomplete. A normal soak fails on any
recovery attempt, even if it later returns to idle.

The focused recovery investigation invokes the smoke-only
`test.captureRecovery.injectCameraDeliveryDegradation` and
`test.captureRecovery.injectScreenDeliveryDegradation` seams, in that order,
while one real-source recording remains active. Each successful arm
acknowledgement starts its own six-second detection clock. Each source must then
expose one complete old-generation degraded/restarting -> new-generation
verifying -> new-generation recovered flow, exactly one automatic attempt,
positive safe-integer generations, recovery within four seconds, return to idle,
and three exact-generation cadence samples at no less than 90% of the negotiated
producer and compositor rates. The camera recovery must finish before the screen
fault is armed. App PID, backend PID, and recording session ID are shared across
both source proofs, and recording status is sampled immediately before and after
each source recovery.

The injection arms the production cadence detector; it does not publish a
synthetic recovery status. Both RPCs exist only in a debug backend and require
the smoke capability. The command therefore fails up front unless
`VIDEORC_SOAK_DEBUG_APP_EXECUTABLE` points to the exact TCC-authorized debug
Videorc executable; it never silently tries the installed release app. On the
owner Mac, unlock the session and personally grant that debug app Camera,
Screen & System Audio Recording, and Microphone access before starting the run.
Do not accept a permission prompt remotely or infer a grant from a synthetic
pass. Keep the selected display visible so the owned motion stimulus can prove
real ScreenCaptureKit progress.

After both recoveries the harness explicitly stops the same session and requires
the backend to confirm that same ID is idle. It then requires a finalized MP4
whose duration is at least 97% of the requested recording, plus passing motion,
corroborated-freeze, repeated-frame, microphone-gap, A/V-skew, and stop-tail
analysis. The checkpoint retains SHA-256 and byte-size descriptors for the MP4
and incremental CSV, as well as the raw ordered recovery observations. A leftover
MKV, a changed process/session identity, a missing screen recovery, an event gap,
or a media-analysis failure is a hard failure.

#### One-time D3 acceptance and publication

The D3 acceptance record is a one-time fail-closed state machine:
`pending -> accepted -> satisfied`. Do not edit an accepted or satisfied record
by hand. The transition command takes an exclusive lock, verifies the current
canonical state, and atomically replaces it exactly once.

Build, sign, notarize, and validate the macOS candidate once before any evidence
attempt. Its release directory must already contain the DMG, its `.sha256`,
`release.json`, the update ZIP, its blockmap, and `latest-mac.yml`. Stage those
exact six files to immutable private candidate storage with
`pnpm release:candidate:stage:macos-d3`. The command also stages the canonical
`candidate.json` manifest and exclusively creates a local
`candidate-seal-receipt.json`. That receipt binds the candidate, all six file
hashes and sizes, the immutable storage coordinates, and the preconfigured
publication-destination commitment. The seal must exist before the first
attempt starts; never rebuild, re-sign, restage, or mutate the sealed candidate
during the ceremony.

Electron Builder normally lists both the ZIP and DMG in `latest-mac.yml`, even
though the updater publication contains only the ZIP. The stage command first
verifies both entries against the sealed files, then atomically canonicalizes
the feed to its single published ZIP entry before hashing or uploading it.

Prepare one immutable evidence directory outside the Git checkout and keep the
seal receipt in that directory. Keep the same clean candidate commit, Git tree,
complete signed `.app` bundle, DMG, seal receipt, owner-host ID, camera ID, and
display ID for the whole ceremony. Each run directory must be new and
write-once. Before a run, the wrapper builds a deterministic manifest of every
bundle directory, regular file, and symlink. It binds relative paths,
regular-file bytes, safe relative symlink targets, and normalized
set-ID/sticky/execute mode bits. Read/write mode presentation can differ on a
read-only mounted image; resource forks and extended attributes are not treated
as portable bundle identity, and the separate codesign/notarization checks
remain authoritative for signature validity. The wrapper mounts the supplied
DMG read-only at an owned temporary mountpoint, requires exactly one top-level
app bundle with the same name and manifest digest, and always detaches the image
before removing that mountpoint.

After every successful evidence child exits, the wrapper recomputes the full
candidate and executed-runner bundle identities before it reads the checkpoint
or writes an attestation. Any file, path, significant-mode, symlink-target,
executable, backend, or DMG mutation makes the run unattestable. The wrapper
also hashes the raw checkpoint and CSV, records their exact sizes, and emits a
canonical attestation no more than five minutes after the checkpoint finishes.
A retry uses a new directory; it never overwrites an interrupted or failed
attempt. Before it starts the evidence child, the wrapper appends and syncs a
canonical start entry under the common evidence root's `attempt-ledger/`. It
then appends exactly one passed, failed, or interrupted result. A passed result
is written only after the canonical attestation is durable, and the attestation
and ledger result bind each other through the ceremony ID, attempt ID,
start-entry hash, sealed-candidate binding, attestation path, byte size, and
SHA-256. Every start, result, ledger manifest, and run attestation must carry the
same `sealedCandidateBindingSha256`. If a process died without a result, the
next invocation first closes that start as interrupted.

1. On a clean checkout of the candidate commit, run the normal signed and
   notarized `pnpm dist:desktop:release` build followed by
   `pnpm release:validate:macos`. Set
   `VIDEORC_CAPTURE_DECAY_SOURCE_COMMIT`,
   `VIDEORC_CAPTURE_DECAY_CANDIDATE_EXECUTABLE`,
   `VIDEORC_CAPTURE_DECAY_CANDIDATE_DMG`, `VIDEORC_RELEASE_DIR`, and
   `VIDEORC_RELEASE_MANIFEST_PATH`. Create one evidence root outside the Git
   checkout, set its absolute path as
   `VIDEORC_CAPTURE_DECAY_EVIDENCE_ROOT`, and set
   `VIDEORC_CAPTURE_DECAY_CANDIDATE_SEAL_RECEIPT` to the new
   `candidate-seal-receipt.json` path inside that root. Before loading any
   publication writer access key or secret, load only the final publication
   bucket, region, HTTPS endpoint/path-style setting, and TLS allowlist in the
   `VIDEORC_RELEASE_UPLOAD_S3_*` destination variables. Derive the commitment
   from the built release directory (the default plan includes the global
   changelog route):

   ```sh
   export VIDEORC_CAPTURE_DECAY_D3_DESTINATION_BINDING_SHA256="$(
     pnpm --silent release:derive:capture-decay-d3-destination-binding
   )"
   ```

   This command performs no network request or write and does not use or
   require publication writer credentials. It uses the exact promotion's route,
   endpoint, TLS-policy, and reservation-route normalization and fails if the
   DMG, checksum, release manifest, ZIP, blockmap, or update feed disagree. Keep
   that exact 64-character value for sealing, acceptance, the protected GitHub
   variable, and promotion; acceptance records the publication destination
   commitment. With the candidate-storage
   `VIDEORC_MACOS_D3_CANDIDATE_S3_*` credentials and TLS policy present, seal
   the candidate exactly once:

   ```sh
   pnpm release:candidate:stage:macos-d3 -- \
     --source-commit "$VIDEORC_CAPTURE_DECAY_SOURCE_COMMIT" \
     --candidate-executable "$VIDEORC_CAPTURE_DECAY_CANDIDATE_EXECUTABLE" \
     --candidate-dmg "$VIDEORC_CAPTURE_DECAY_CANDIDATE_DMG" \
     --release-dir "$VIDEORC_RELEASE_DIR" \
     --manifest "$VIDEORC_RELEASE_MANIFEST_PATH" \
     --destination-binding-sha256 "$VIDEORC_CAPTURE_DECAY_D3_DESTINATION_BINDING_SHA256" \
     --receipt "$VIDEORC_CAPTURE_DECAY_CANDIDATE_SEAL_RECEIPT"
   ```

   The command verifies the clean checkout and candidate identity both before
   and after the immutable upload and refuses to replace an existing receipt.
   Clear all `VIDEORC_MACOS_D3_CANDIDATE_S3_*` credentials before starting an
   evidence attempt. They must never enter the launched Videorc process; the
   wrapper also strips candidate-storage and other credential-like variables
   from the app child's environment as a fail-closed defense.

2. Set the stable 64-character `VIDEORC_CAPTURE_DECAY_HOST_ID` and choose one
   stable, filesystem-safe `VIDEORC_CAPTURE_DECAY_CEREMONY_ID`; retain both for
   every attempt. Every `VIDEORC_SMOKE_OUTPUT_DIR` must be a new child directory
   of the evidence root and must not be inside `attempt-ledger/`. The executable
   path must be the signed bundle's exact `Contents/MacOS/<executable>` entry.
   The wrapper derives the `.app` root from this path and non-recovery runs
   launch this bound entry; helper binaries or copied launchers are rejected.
   The wrapper resolves
   `VIDEORC_CAPTURE_DECAY_CANDIDATE_SEAL_RECEIPT` under the evidence root and
   rejects a missing, replaced, noncanonical, late, or mismatched seal.
3. Run `pnpm smoke:capture-decay-soak:real-release` until the ledger ends in
   three consecutive passed soak attempts, using
   `VIDEORC_CAPTURE_DECAY_RUN_ORDINAL=1`, then `2`, then `3`. Point
   `VIDEORC_SMOKE_OUTPUT_DIR` at `run-1`, `run-2`, and `run-3`. Run 1 has no
   previous hash; runs 2 and 3 set
   `VIDEORC_CAPTURE_DECAY_PREVIOUS_ATTESTATION_SHA256` to the exact preceding
   canonical attestation SHA-256. All three passes must be non-overlapping,
   at least 240 minutes, real 3840x2160@30, and at least 90% cadence, with all
   four keyed native-retention and sizing/reconfiguration proofs bounded. Any
   failed or interrupted soak resets the qualifying streak: retain its output
   and ledger entries, choose new directories, and restart the attestation
   chain at ordinal 1. Never delete, rename, or renumber ledger entries. All
   three starts, results, and attestations must bind the seal made in step 1.
4. Still on that exact clean candidate source, choose a new debug app bundle
   path whose internal executable name matches the candidate, for example
   `Videorc-D3-Debug.app/Contents/MacOS/Videorc`. Set it as
   `VIDEORC_SOAK_DEBUG_APP_EXECUTABLE`, choose a new
   `VIDEORC_CAPTURE_DECAY_DEBUG_RUNNER_PROVENANCE` path, and run
   `pnpm release:create:capture-decay-debug-provenance`. This command—not a
   later assertion—executes the locked shell-free build, copies the candidate
   app into a new bundle, replaces only its backend with the debug backend,
   ad-hoc signs the result, hashes the complete debug app bundle plus its
   runner/backend/build program, and binds the receipt to the clean candidate
   commit and tree before and after building. The existing debug-runner build
   source, executable, backend, and canonical sidecar proofs remain required.
5. Unlock the owner session and personally grant the new debug app Camera,
   Screen & System Audio Recording, and Microphone access. Then point
   `VIDEORC_SMOKE_OUTPUT_DIR` at `run-4`, set
   `VIDEORC_CAPTURE_DECAY_QUALIFIED_SOAK_ATTESTATION_SHA256` to run 3's exact
   attestation hash, retain the debug runner/provenance variables, and run
   `pnpm smoke:capture-decay-soak:real-release:recovery`. It must record one
   uninterrupted session with strict camera-before/after then
   screen-before/after boundaries, the same app/backend/session identity, a
   verified idle stop, and a finalized analyzed MP4. The selected recovery pass
   must be the final completed ceremony attempt; retain failed/interrupted
   recovery attempts and retry in a new directory. The selected recovery must
   bind the same seal as all three qualifying soaks.
6. Copy
   `docs/acceptance/macos-capture-decay-d3-evidence-manifest.template.json` to
   the evidence root. Replace every placeholder and zero size with the exact
   candidate, seal-receipt descriptor, app-bundle manifest summary, and
   canonical attestation hashes/sizes. Replace the template's entire
   `attemptLedger` example with the object from the newest immutable
   `attempt-ledger/manifest-<head-sha256>.json` snapshot. That object must retain
   every attempt, including failures and interruptions; an eight-entry ledger
   is only the no-retry example. Select only the exact three qualifying soak
   attestation paths and the final passed recovery path in `soaks` and
   `recovery`. The validator rejects an omitted/reordered ledger entry, an open
   attempt, a failed soak inside the latest streak, a non-final recovery, or an
   attestation copied to a path other than the one bound by its result.
   Validate without writing first:

   ```sh
   pnpm release:validate:capture-decay-d3-evidence -- \
     --evidence-manifest /absolute/evidence/manifest.json
   ```

7. Re-run that command with
   `--write-record docs/acceptance/macos-capture-decay-d3.json`. Commit only the
   changed acceptance record after the tested candidate commit. This acceptance
   commit changes the record only; it must not change, rebuild, or re-sign the
   candidate. The regular `.github/workflows/release-macos.yml` workflow
   deliberately rejects an `accepted` D3 state because rebuilding that release
   would break the seal.
8. After the acceptance-record-only commit is on protected current `main`,
   dispatch the dedicated exact-promotion workflow:

   ```sh
   gh workflow run promote-macos-capture-decay-d3.yml --ref main
   ```

   `.github/workflows/promote-macos-capture-decay-d3.yml` downloads the
   immutable `candidate.json`, seal receipt, and all six sealed files with
   candidate-read `VIDEORC_MACOS_D3_CANDIDATE_S3_*` credentials. It rechecks the
   protected current `main`, accepted record, signatures, notarization, feed
   relationships, filenames, sizes, and hashes, then promotes the exact six
   byte strings with separate publication-write `VIDEORC_RELEASE_UPLOAD_S3_*`
   credentials. It neither builds nor signs and has no Apple, signing,
   notarization, or build credentials. Candidate-read credentials are absent
   from the publication step, and publication-write credentials are absent from
   the candidate-download step. Before publication credentials exist, full
   verification writes a canonical bounded
   `candidate-publication-verification.json` descriptor. The publication step
   reopens that descriptor and all eight candidate inputs with no-follow
   semantics and rehashes their exact bounded bytes; it does not remount the DMG,
   rerun code-signing tools, or extract the ZIP while writer credentials are in
   scope. The upload path remotely rereads every object and emits the canonical
   `capture-decay-d3-publication-receipt.json` only after the destination bytes
   match the seal.

   Keep protected `main` unchanged from the accepted-record commit until the
   record is transitioned to `satisfied`. If a promotion stops after creating
   the immutable publication reservation, rerun the same workflow or dispatch
   a fresh run from that unchanged commit. A fresh run adopts the existing
   reservation only when the sealed candidate, accepted commit, release,
   destination, TLS policy, and complete upload plan are identical. The receipt
   retains the original reservation creator and records the current publisher
   separately; any other drift fails closed. Once the record is `satisfied`,
   the exact-promotion workflow exits before requesting candidate-read or
   publication-write credentials.

   A separate isolated job attests the publication receipt and the exact eight
   publication subjects: `candidate.json`, `candidate-seal-receipt.json`, and
   the six sealed files. Retain the exact-promotion artifact and the offline
   `capture-decay-d3-publication-attestation.json` artifact.

9. Download the exact-promotion artifact without renaming any file into one
   publication-subject directory. Its root must contain the canonical
   `candidate.json`, `candidate-seal-receipt.json`, and all six sealed payload
   filenames. Independently download all six objects from the public release
   destination into one published-release directory under those same sealed
   filenames. Load dedicated object-read-only credentials into the
   `VIDEORC_CAPTURE_DECAY_D3_PUBLIC_READ_S3_*` namespace for the exact receipt
   destination. Unset every `VIDEORC_RELEASE_UPLOAD_S3_*` and
   `VIDEORC_DOWNLOAD_S3_*` writer credential first: satisfaction rejects those
   credentials and strips all S3 credentials from the `gh attestation verify`
   child. From the accepted publication commit, transition to satisfied:

   ```sh
   pnpm release:validate:capture-decay-d3-evidence -- \
     --satisfy-with /absolute/download/exact-promotion/capture-decay-d3-publication-receipt.json \
     --publication-attestation /absolute/download/capture-decay-d3-publication-attestation.json \
     --publication-subject-dir /absolute/download/exact-promotion \
     --published-release-dir /absolute/download/public-release \
     --write-record docs/acceptance/macos-capture-decay-d3.json
   ```

The satisfaction transition verifies the canonical receipt, the full
eight-subject directory, the isolated GitHub attestation, and all six
independently downloaded public byte strings against the accepted seal and
receipt mappings. The satisfied record retains the complete embedded
attestation bundle, not only its digest. Commit that satisfied record. Later
macOS releases must descend from the exact first publication and must not change
native capture, retention, recovery, diagnostics, dependencies, or the D3 gate
definitions without collecting and publishing fresh D3 evidence. Committed
edits, deletions, and both sides of renames are checked from the first
publication commit. Release documentation and a reviewed, named allowlist of
unrelated paths (UI surfaces, account/provider/chat integrations, updater and
import helpers, and the two cfg-gated Windows-only backend capture modules)
stay allowed; any other production path fails closed until it is deliberately
added to that allowlist or fresh D3 evidence is collected. Case-variant paths
that collide with guarded files on a case-insensitive filesystem classify as
sensitive. Later releases still run the recurring 60-minute idle and
15-minute recording synthetic gates. The
acceptance record stores hashes and bounded summaries, not twelve hours of raw
media; retain the immutable raw evidence, seal receipt, publication receipt,
exact subject directory, public downloads, and attestation bundle in protected
release storage. The first publication is the tested, signed, notarized sealed
candidate: all six published payloads, including the DMG, are the exact bytes
staged before the first attempt.

The release workflow mechanically checks the recovery schema/state machine and
this evidence oracle through Rust tests plus
`smoke:capture-decay-soak:contract`. Hosted macOS runners do not have stable
camera hardware or the owner's TCC grants, so those checks are not a real-device
D3 claim. Before marking D3 verified in a release acceptance note, attach the
owner-run recovery checkpoint and the required three consecutive four-hour
real-source soak artifacts. Missing hardware evidence must be recorded as
missing, not inferred from the synthetic release sentinels.

### Release-candidate device + provider gates (plan 022)

Two gate groups are advisory in day-to-day runs but REQUIRED for a
release candidate:

- **Real-device screen gates** (host must have Screen Recording AND Camera
  TCC granted to the dev Electron and `target/debug/videorc-backend`, and
  the target display must not be otherwise in use). Run in order:
  1. `pnpm smoke:screen-recording-real`
  2. `pnpm smoke:notes-window-invisible`
  3. `pnpm smoke:recording-studio:devices`
     If the motion-stimulus signature fails, fix stimulus placement on the
     SELECTED display (`VIDEORC_SCREEN_MOTION_*`) — never loosen the
     signature assertion.
- **Provider live readiness, strict**: with the smoke-only provider
  credentials from [../oauth-live-smoke.md](../oauth-live-smoke.md) in the
  environment, run readiness with `VIDEORC_SMOKE_REQUIRE_PROVIDER_READY=1`
  so missing prerequisites FAIL the gate instead of printing advice.

## How macOS users get the update

1. On launch — and on **Settings → About & updates → Check for updates** — the
   app GETs `latest-mac.yml` and compares `version` to its own.
2. If the feed is higher it downloads the `.zip` (302 → presigned R2) with
   progress.
3. It applies on the next quit (background path) or immediately via **Restart &
   install**, which is **blocked while a recording/stream is live**.

The installed app checks whichever feed URL was baked at **build time**
(`apps/desktop/electron-builder.yml` `publish.url`) — since 2026-07-07 that is
`https://www.videorc.com` (launch flip; builds ≤0.9.14 still check the old
Vercel host, so that host's `/api/updates/*` must KEEP working until those
installs age out). WWW is load-bearing: the apex 307-redirects every path to
www, and redirect hops drop Authorization headers in some clients. If the host
ever changes again, update `publish.url`, `videorc-web-links.ts`, and the Rust
`PRODUCTION_API_BASE_URL` together, then cut a build so the new URL ships.

## Gotchas (hard-won)

- **Bucket-less endpoint** (above) — the #1 silent failure: a doubled key uploads
  "successfully" but the feed/download then 404. Verify by _following the
  redirect_ to R2, not just checking the route returns a 302.
- **Never cache the presigned redirect** — `/api/updates/*` 302s to a ~15-min
  presigned URL and is intentionally cached `max-age=60`. Do not restore a long /
  `immutable` cache, or the CDN serves an expired redirect (403). (videorc-web
  `lib/updates-route.ts`.)
- **Signed builds only** — unsigned/ad-hoc builds won't self-update.
- **arm64 only** — `latest-mac.yml` is arm64; Intel Macs are not served or
  updated. Add x64/universal before claiming Intel support.
- **Feed = package.json `version`, not `releaseId`** — bump `version` to ship an
  update; the `-beta.N` suffix only names the download archive.

## macOS rollback

Fail closed instead of mutating a bad release — see "Beta Download Rollback" in
[../distribution.md](../distribution.md): set
`VIDEORC_DOWNLOAD_STORAGE_PROVIDER=none` or repoint the manifest and redeploy, and
cut a `-beta.N+1` rather than overwriting. For the feed, publish a corrected build
with a **higher** version; the bad one stops being offered once a higher version
exists. (The flat `updates/macos/` prefix is overwritten each release, so the
feed always reflects the latest upload.)
