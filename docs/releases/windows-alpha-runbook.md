# Releasing Videorc Windows Alpha

This runbook promotes one signed, tested Windows 11 x64 candidate without a
rebuild between physical acceptance and release. macOS Beta storage and updater
keys are separate and must remain unchanged.

## Release invariants

- The candidate is an NSIS x64 `.exe` signed by the exact configured publisher,
  with Authenticode status `Valid` and a timestamp countersignature.
- Candidate identity is the tuple `releaseId + sourceCommit + installer SHA-256`.
- Candidate build always writes `acceptanceStatus: pending` and no acceptance
  record URL.
- The handoff lives only in private R2 at
  `candidates/windows/<releaseId>/<sourceCommit>/`. The public repository's
  one-day GitHub Actions artifact contains only the unsigned `win-unpacked`
  handoff and exact hash manifest; it never contains the signed installer or
  accepted release evidence.
- Promotion downloads that exact private object set and never rebuilds it.
- Pilot promotion preserves `pending`; public promotion requires the strict
  public sanitized JSON `PASS` record.
- Pilot pointers live only at `releases/windows/pilot/` and
  `updates/windows/pilot/`. Pilot can never move the stable Windows updater,
  latest download manifest, or global changelog.
- Only the protected promotion workflow can move Windows download/update
  pointers. The candidate workflow never writes release or updater pointers.
- Windows storage keys remain isolated from all macOS keys.

## 1. Freeze the source

1. Bump the three-part numeric version in `apps/desktop/package.json` and use
   the exact matching `<version>-alpha.1` release ID, for example
   `0.9.45-alpha.1`.
2. Add `changelog/<releaseId>.md` with `channel: alpha` and
   `platforms: [windows]`.
3. Freeze the supported claims and `/windows-alpha` known issues.
4. Commit and push the exact candidate source. Record the full lowercase
   40-character commit SHA.

Do not use a branch name, tag, shortened SHA, or locally modified checkout as a
candidate identity.

Every candidate, correction, or rollback-forward build must bump the numeric
package version. Never attempt `0.9.45-alpha.2` after `0.9.45-alpha.1`: both
would carry updater version `0.9.45`, so Electron cannot advance between them.
Use `0.9.46-alpha.1` instead.

## 2. Build the private candidate

Merge the candidate source to protected `main`, then dispatch **Build Windows
Alpha Candidate** from the current `main` commit and provide `release_id`. The
workflow has two trust-separated jobs:

1. The `unsigned` job has only `contents: read`, no protected environment, and
   no OIDC permission. It checks out `github.sha` with credentials disabled,
   requires `refs/heads/main`, fetches `origin/main`, and refuses a stale
   dispatch.
2. That job runs formatting/text checks, Node and desktop tests/type checks/lint,
   Rust format/tests/clippy, force-downloads the pinned Windows FFmpeg archive,
   and builds resource-edited but unsigned `win-unpacked` bytes.
3. It hashes every staged file plus release ID, source commit, exact update
   publisher, and `app-update.yml`, then uploads only that handoff as a
   compression-free one-day artifact through a commit-pinned action.
4. The protected `sign` job alone has `id-token: write`. After approval it
   rechecks current `main`, downloads the exact artifact through a commit-pinned
   action, verifies the Actions digest and file manifest, rejects a pre-signed
   app, and prewarms NSIS before Azure login.
5. It hash-verifies all pinned Trusted Signing packages, uses commit-pinned
   `azure/login` OIDC with Azure CLI as the only credential, signs and
   timestamps every packaged executable, and builds NSIS from `--prepackaged`.
6. It immediately logs Azure CLI out, then validates the exact signed
   installer/feed/manifest/checksum and scopes candidate-write R2 credentials
   only to the final immutable storage step.

The workflow contains no Azure client secret, certificate credential, or
username/password credential. If protected `main` advances while approval is
pending, the sign job fails and the operator must redispatch.

The GitHub-hosted build does not claim physical-device acceptance. In
particular it does not run `smoke:local-gates:windows`, whose installed-app,
screen, microphone, GPU, and cleanup evidence belongs to the physical operator
step below.

The storage step uses conditional creates and hash metadata. A retry may reuse
an existing byte-identical object, but any collision with different bytes fails
closed. The immutable candidate prefix contains:

- installer, checksum, blockmap, `latest.yml`, and pending `release.json`;
- `FFMPEG-LICENSE.txt` and `FFMPEG-SOURCE.txt`;
- the exact unpacked backend, FFmpeg, FFprobe, license, and source-offer files
  required to rerun artifact validation during promotion.

The R2 candidate credentials should have no public-read, delete, stable-release,
or updater-pointer permission. Candidate read and write credentials are
separate. Bucket retention/versioning or an equivalent object-lock policy is
recommended; the workflow itself never overwrites different bytes.

Record the workflow URL, release ID, source commit, installer SHA-256, exact
publisher, and candidate prefix. Those are inputs to all later work.

## 3. Physical acceptance

Retrieve the exact private candidate for the operator without publishing it as
a GitHub artifact. Copy `docs/acceptance/windows-app-acceptance-template.md` to
a dated private-evidence record and complete every required row on clean
physical Windows 11 x64 hardware. At minimum prove:

```powershell
$env:VIDEORC_RELEASE_ID = '<releaseId>'
$env:VIDEORC_RELEASE_SOURCE_COMMIT = '<candidate source commit>'
$env:VIDEORC_RELEASE_EXPECTED_SHA256 = '<installer sha256>'
$env:VIDEORC_WINDOWS_PUBLISHER_NAME = '<exact publisher CN>'
# Load the candidate-read S3 endpoint, bucket, region, access key, and secret
# into the VIDEORC_RELEASE_UPLOAD_S3_* environment names without printing them.
pnpm release:candidate:download:windows
pnpm release:candidate:verify:windows
$env:VIDEORC_WINDOWS_ACCEPTANCE_EXPECTED_APP_SHA256 = `
  (Get-FileHash -Algorithm SHA256 .\apps\desktop\release\win-unpacked\Videorc.exe).Hash.ToLowerInvariant()

# Candidate storage/signing authority must never reach the app under test.
Get-ChildItem Env: | Where-Object {
  $_.Name -like 'VIDEORC_RELEASE_UPLOAD_S3_*' -or
  $_.Name -like 'VIDEORC_DOWNLOAD_S3_*' -or
  $_.Name -like 'VIDEORC_WINDOWS_SIGNING_*' -or
  $_.Name -like 'AZURE_*'
} | ForEach-Object { Remove-Item "Env:$($_.Name)" }
```

Run that from a clean checkout of the candidate source. The downloader refuses
to replace local files and verifies the immutable metadata for every object.
The expected app hash above is therefore derived from the verified private
candidate, not from the installed copy. Record it in private evidence, keep the
non-secret identity variables for the installed-app gate, and never obtain the
expected value by hashing the installed executable. Clear storage and signing
authority exactly as shown before launching any candidate code. The smoke
runner and packaged app independently strip those names from child processes as
defense in depth. Then install the downloaded installer and prove:

- clean install, protocol sign-in, sign-out/relaunch, uninstall, and reinstall;
- screen-only, camera-only, and screen + camera + microphone finished artifacts
  inspected with the analyzer;
- normal and fallback GPU paths plus lower-capacity hardware;
- no owned backend/FFmpeg children after normal and forced close;
- strict support-bundle redaction and Microsoft Defender scan;
- exact installer hash, size, publisher, valid signature, and timestamp;
- every advertised RTMP workflow.

Install that exact signed candidate, point the gate at the installed executable,
and require installed-app mode:

```powershell
$env:VIDEORC_WINDOWS_ACCEPTANCE_REQUIRE_INSTALLED = '1'
$env:VIDEORC_WINDOWS_ACCEPTANCE_EXECUTABLE = '<installed Videorc.exe>'
$env:VIDEORC_WINDOWS_ACCEPTANCE_DIR = '<private evidence directory>'
pnpm smoke:local-gates:windows
```

Before any smoke runs, the gate hashes the installed `Videorc.exe` and requires
an exact match with `VIDEORC_WINDOWS_ACCEPTANCE_EXPECTED_APP_SHA256`. It also
requires the candidate release ID, source commit, installer SHA-256, exact
publisher, `Valid` Authenticode status, timestamp countersignature, and matching
file ProductVersion. The sanitized binding is written to
`windows-local-gates.manifest.json`; a mismatch blocks the run. The executable
must resolve outside the repository release-staging tree and match exactly one
HKCU/HKLM Videorc NSIS uninstall registration. The registered DisplayVersion
and timestamped uninstaller signature are checked too, so the unpacked
candidate cannot masquerade as an installed app.

Private evidence may contain logs and hardware detail. It must not be committed.
CI, file size, a VM-only run, or a similarly named local installer is not a
substitute for the exact-candidate physical record.

This is the pre-pilot pass. Keep the overall record pending for the production
download-route and previous-Alpha update rows; those can only be completed after
the protected pilot promotion below. Do not manufacture URLs or mark those rows
`PASS` early.

## 4. Pilot promotion

Dispatch **Promote Windows Alpha Candidate** with:

- `release_id`;
- exact candidate `source_commit`;
- exact lowercase `installer_sha256`;
- `stage: pilot`;
- an empty `acceptance_record_url`.

The protected workflow must be dispatched from `main`. It checks out the exact
current protected-main commit as trusted promotion tooling, refuses a stale
dispatch if `main` advanced, and requires the candidate source commit to be its
ancestor. It then downloads the exact private prefix, verifies every object's
immutable hash metadata, binds artifact validation to the candidate source
input, validates Authenticode and the feed, and invokes the release uploader with
`VIDEORC_WINDOWS_RELEASE_STAGE=pilot`.

macOS and Windows release publication share one non-cancelling concurrency
lock. This prevents an older changelog or mutable latest pointer from racing a
newer release on either platform.

Pilot publishing preserves the pending manifest. It publishes only
`releases/windows/pilot/release.json` and the isolated
`updates/windows/pilot/` feed; it withholds the stable feed, stable latest
manifest, accepted versioned manifest, and global changelog.

Configure the web pilot deployment with
`VIDEORC_WINDOWS_DOWNLOAD_MANIFEST_OBJECT_KEY=releases/windows/pilot/release.json`.
Generate a random `VIDEORC_WINDOWS_PILOT_UPDATE_TOKEN` containing exactly 32–256
visible ASCII characters (`0x21`–`0x7e`), store it as a server-only web secret,
and deliver it to the named physical operator through the release secret
channel. Whitespace, control characters, Unicode, shorter values, and longer
values fail closed. This is an operator acceptance capability, not a customer
cohort mechanism. Launch the previously accepted Alpha from PowerShell with the
same token:

```powershell
$env:VIDEORC_WINDOWS_PILOT_UPDATE = '1'
$env:VIDEORC_WINDOWS_PILOT_UPDATE_TOKEN = '<operator pilot token>'
& '<installed prior Videorc.exe>'
```

The app switches only to
`https://www.videorc.com/api/updates/windows-pilot/`, copies the bearer into the
updater, and deletes it from `process.env` before starting the backend/helpers.
The web route authenticates and proxies pilot bytes without exposing a presign
or token. Complete the account-gated download → install → sign-in → record →
update loop, recheck the downloaded installer hash, and finish the
production-shaped route rows. Then quit every Videorc process and clear both
pilot environment variables:

```powershell
Remove-Item Env:VIDEORC_WINDOWS_PILOT_UPDATE -ErrorAction SilentlyContinue
Remove-Item Env:VIDEORC_WINDOWS_PILOT_UPDATE_TOKEN -ErrorAction SilentlyContinue
```

For the first public Windows Alpha only, no accepted predecessor exists. Test
the isolated pilot feed itself, but record `alphaToAlphaUpdate` as
`NOT_APPLICABLE` with reason `first-public-alpha` and use release sequence
`first-public-alpha`. The promotion script permits that exception only when the
trusted checkout contains no other committed Windows Alpha acceptance record.
Every later release must identify the immediately preceding validated PASS
release and pass the real Alpha-to-Alpha update from that version. Promotion
validates the complete committed chain and rejects a skipped predecessor.

## 5. Publish the sanitized PASS record

After all physical and pilot gates pass, copy
`docs/acceptance/windows-alpha-acceptance-record.template.json` to
`docs/acceptance/windows-alpha/<releaseId>.json`. Follow
[the public record contract](../acceptance/windows-alpha-acceptance-record.md).
Replace every placeholder, keep all required gate statuses at `PASS` except the
strict first-public-Alpha bootstrap case above, and do not add logs, names,
hardware IDs, local paths, presigned URLs, or other fields.

Commit the JSON. The public promotion input must be an immutable URL such as:

```text
https://github.com/TheOrcDev/videorc/blob/<40-character-record-commit>/docs/acceptance/windows-alpha/<releaseId>.json
```

There is no `www.videorc.com/.../acceptance` route. Branch URLs, tags, redirects,
query strings, other repositories, and other directories are rejected. The
record commit must also be reachable from and an ancestor of current protected
`main`.

## 6. Public promotion

Dispatch **Promote Windows Alpha Candidate** again with the same release ID,
candidate source commit, and installer SHA-256, plus:

- `stage: public`;
- the commit-pinned GitHub acceptance-record URL.

The workflow downloads the same private candidate without rebuilding, reruns
hash/feed/Authenticode validation, safely resolves the fixed public GitHub raw
URL without redirects, and verifies the strict acceptance contract. It changes
only `acceptanceStatus` and `acceptanceRecordUrl` in `release.json`, then invokes
the stable uploader with `VIDEORC_WINDOWS_RELEASE_STAGE=public`.

The stable uploader revalidates the staged exact files immediately before its
PUT operations. Public promotion reuses/verifies the existing immutable
installer/feed objects, adds the accepted versioned manifest, then updates the
merged global changelog, `updates/windows/latest.yml`, and finally
`releases/windows/latest/release.json`. Storage credentials exist only in this
step and should be scoped to the Windows release/update prefixes.

Both pilot and public uploads bind the feed version to the current trusted-main
desktop package version and to validated public acceptance history. A missing
public `latest.yml` after an earlier accepted release fails closed and requires
explicit recovery; it is never treated as a new bootstrap release. The feed
parser rejects duplicate keys, alternate/absolute files, and every schema other
than one canonical relative x64 installer with its exact SHA-512 and byte size.

## 7. Production smoke and rollout

Before changing the web state, verify:

- signed-in Windows download returns this exact installer and visible SHA-256;
- update manifest, installer, and blockmap resolve through the production route;
- the pilot install updates through that route;
- macOS DMG and `latest-mac.yml` are unchanged.

Authorize the web `public` state only after the public promotion and production
smoke pass. Publish held GitHub, Discord, email, and social drafts afterward.

## Rollback

1. Set the web Windows state to `disabled`; do not change macOS.
2. Preserve all immutable candidate and versioned objects.
3. Restore the last accepted Windows latest manifest/feed pointers when safe.
4. Never downgrade installed clients by replacing a feed with a lower version;
   ship a corrected higher numeric package version with the `-alpha.1` suffix.
5. Preserve workflow URLs, candidate identity, storage keys, pointer history,
   and private acceptance evidence in the incident record.
