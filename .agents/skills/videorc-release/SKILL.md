---
name: videorc-release
description: Execute Videorc desktop releases when the user says "release new version", "ship an update", or asks to cut or publish a release. Coordinates signed macOS Beta and Windows Alpha builds, acceptance, storage publication, updater verification, and release records. Defaults to both platforms; supports explicitly scoped platform-only releases.
---

# Videorc release

Ship one new numeric desktop version on both supported tracks:

- macOS arm64 Beta: `<version>-beta.<N>`;
- Windows 11 x64 Alpha: `<version>-alpha.1`.

Target both platforms unless the user explicitly requests a platform-only
release. Do not silently skip Windows because macOS can be released locally.

## Start here: "release new version"

This is an execution request, not just a request for a plan. Work through the
checkpoints below until the requested platforms are live and verified, or an
explicit human gate blocks further progress. A request to explain, review, or
edit this process authorizes only that work: do not bump versions, load secrets,
dispatch release workflows, publish, or announce a release for such a request.

1. Read repository instructions and inspect the checkout before editing. Fetch
   current `main`; use a clean release branch/worktree from it. Preserve unrelated
   work. Never build a release from whichever feature branch happens to be open.
2. Read the runbooks below. Check current package/changelog/release records,
   selected platforms' public feeds, pending origin-sync records, and in-flight
   release workflows. Do not treat an unreachable feed as proof of a first release.
3. If a release is already prepared or partially published, reconcile its exact
   identity and resume it using "Resume and handoff" below. If it is unclear
   whether the user wants that release or a different one, ask before changing
   versions or publishing a second candidate.
4. For a genuinely new release with no requested version, increment the patch
   component of the highest numeric version in current `main` or the selected
   platforms' published releases. Default to `beta.1` and `alpha.1`. Honor an
   explicit version/Beta number only if it satisfies the versioning rules. Do
   not choose a major/minor bump from a guess about the intended product scope.
5. Announce the proposed version, platforms, and release mode in a short update.
   Verify the prerequisites and named owners below; ask only for missing choices,
   access, or human actions that are actually needed. Never ask for secrets in chat.
6. Check the candidate's required CI and local release evidence. A merge, a prior
   version's passing tests, or a playable MP4 is not proof that this candidate
   passed. Surface failed, missing, or skipped required gates before publication.

Before acting, read both sources of truth in full:

- `docs/releases/release-runbook.md` for macOS, shared versioning, and rollback;
- `docs/releases/windows-alpha-runbook.md` for Windows signing, candidate,
  physical acceptance, pilot, public promotion, and rollback.

Keep this skill as the executable coordinator. Do not weaken or duplicate the
runbooks' detailed gates. Commands below are templates: resolve every placeholder
from verified release state before executing them. Use the maintained scripts,
not hand-written signing, upload, manifest-edit, or promotion replacements.

## Execution checkpoints

Do not advance a platform past a checkpoint without its evidence. The numbered
sections below contain the commands; the runbooks define their detailed gates.

For macOS-only, run sections 1–2 and the macOS parts of section 5; skip Windows
workflows, approvals, and prerequisites. For Windows-only, prepare the version
and Alpha entry, then run sections 3–5 without a macOS build/upload or Beta entry.
Do not block a platform-only request on the other platform's credentials.

| Checkpoint              | AI action                                                               | Required result / human boundary                                                                                     |
| ----------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Prepare                 | Select version, write accurate changelog, validate, open release PR     | Reviewed changes on protected `main`; exact source SHA recorded. Wait for required review, do not bypass protection. |
| macOS build (§2)        | Run the local keychain build and artifact validation                    | Signed, notarized, stapled app plus validated download and updater artifacts.                                        |
| macOS acceptance (§2)   | Run applicable release, installed-app, device, and provider gates       | Recorded PASS. Human supplies physical access and OS permission grants; synthetic checks do not replace them.        |
| macOS publish (§2)      | Preflight storage, upload, follow download/update redirects             | Exact version/checksums verified in production; mirror result recorded.                                              |
| Windows candidate (§3)  | Dispatch the protected-main candidate workflow and monitor both jobs    | Exact immutable signed candidate identity. Wait for protected-environment approval.                                  |
| Windows acceptance (§4) | Coordinate physical acceptance, pilot update, and committed PASS record | Exact-candidate evidence, or the separately defined owner-written waiver route. Never fabricate either.              |
| Windows publish (§4–5)  | Dispatch public promotion of the same bytes, then production checks     | Verified installer/feed/blockmap and visible acceptance status before enabling public web state.                     |
| Finish (§5)             | Record both outcomes and announce only live platforms                   | Production evidence, remaining blockers, and next action; never describe a private candidate as shipped.             |

For macOS, distinguish ordinary Beta publication from the one-time D3 exact
promotion using the runbook's "Publication policy" section and current D3 state.
Do not launch the D3 ceremony merely because the user asked for a release, or
use the ordinary path to evade an `accepted` sealed-candidate state. The D3
exception does not waive ordinary release/device/provider gates.

## Stop and escalation rules

- A failed required gate stops publication for the affected platform. Inspect
  the error and preserve evidence; do not lower thresholds, ignore an audit,
  enable changelog/acceptance skip switches, bypass TLS, or use an admin merge
  to continue. If a fix requires product/dependency changes, report it and obtain
  direction; accepted candidate bytes must not be patched in place.
- Missing credentials, named owners, physical evidence, OS grants, or protected
  approval are human gates. Report the exact missing input and the next command
  that can run after it arrives. Continue an independently eligible platform;
  do not silently drop the blocked one or claim overall completion.
- For a transient transport error, retry read-only verification once. Retry an
  upload/promotion only under the runbook's exact-identity/idempotency rules,
  after inspecting remote state. A repeated failure or uncertain partial write
  requires an owner handoff, not blind redispatch or deleting remote objects.
- Check the actual configured storage origins and production primary. Neon is
  the target, not proof that cutover has happened. Do not migrate storage, switch
  the primary, or enable mirror-only emergency publication as part of a routine
  release without the explicit owner decision required by the runbook.
- Keep credential values, bearer/presigned URLs, raw recordings, and private
  acceptance evidence out of tool output, Git, PRs, and the final response.

## Resume and handoff

Maintain the sanitized release note at `docs/releases/<version>.md` as checkpoints
finish or block. Record requested platforms, release IDs, each source SHA,
workflow run URLs, candidate hashes, acceptance record URL/status, completed
gates, public verification, pending storage mirrors, announcement status, and
the exact next action. Keep raw evidence in private release storage.
Keep pending documentation edits separate from the frozen, clean artifact
checkout. Do not advance protected `main` with checkpoint commits while a
workflow or exact-promotion stage requires it to remain unchanged.

On resume, read that record and reconcile it with workflow and remote artifact
state before taking any write action. Reverify completed public steps instead
of rebuilding, reuploading, redispatching, or reannouncing them. A receipt or a
successful command alone does not replace production verification. Never move a
mutable latest pointer backward to finish an older release after a newer one.

Final response: one short line per platform with version, `live`, `candidate`,
`blocked`, or `not requested`, plus acceptance status (`PASS` or `waived` for
Windows), evidence link, and any remaining human action. Disclose pending mirror
sync even when the primary is live. Use "complete" only under the contract below.

## Completion contract

- Prepare both release IDs from one strictly higher three-part numeric package
  version. Record the exact macOS source commit and the later Windows candidate
  source commit separately. If a rejected Windows candidate must roll forward
  after macOS is live, allow the platform versions to diverge rather than
  republishing macOS merely for version parity.
- Publish and verify the macOS Beta independently of the Windows Alpha gates.
- Build Windows only from current protected `main`; never release a PR artifact,
  locally signed substitute, or rebuilt post-acceptance installer.
- Call the coordinated release complete only after macOS is live and verified
  and the exact Windows candidate has completed the physical acceptance/pilot
  route (or the runbook's owner-waiver route), public promotion, and production
  smoke. Report a waiver as `waived`, never as a physical acceptance PASS. For
  an explicitly platform-only request, complete only that requested track.
- If an external Windows gate cannot be completed, preserve the candidate and
  report the release as partial with the exact missing gate. Never describe a
  private candidate or pilot pointer as a public Windows release.
- Keep the web Windows state `disabled` until public promotion and production
  smoke succeed. Never change macOS availability while gating Windows.

## Prerequisites

### Shared

- Use a clean checkout based on current protected `main`.
- Confirm GitHub access can dispatch and inspect Actions workflows.
- Confirm storage credentials are scoped as documented (R2 per platform
  prefix; Neon and Hetzner per dedicated release-only project). Never
  run the local macOS upload concurrently with Windows public promotion because
  both may update the merged global changelog. A pending Windows Alpha changelog
  entry on `main` does not block macOS uploads: each uploader only introduces
  entries for its own platform, and logs the ones it withholds.
- Name release, Windows acceptance, support, and rollback owners before starting.

### macOS

- Load `APPLE_ID` and `APPLE_APP_SPECIFIC_PASSWORD` from
  `~/.videorc-release.env`.
- Load the allow-listed X OAuth consumer key and secret required by the packaged
  backend from the same file. Do not reintroduce the paused YouTube OAuth secret
  unless the runbook explicitly restores that requirement.
- Verify the Developer ID identity `Uros Miric (C2PA37RB58)` is available in the
  keychain, or provide the documented `CSC_LINK` alternative.
- Load `VIDEORC_RELEASE_UPLOAD_NEON_S3_*`, `VIDEORC_RELEASE_UPLOAD_HETZNER_S3_*`
  and `VIDEORC_DOWNLOAD_STORAGE_PRIMARY` from `~/.videorc-release.env`
  (whichever origins are still configured). The upload publishes to **every
  configured** storage origin, mirrors first, primary last. Target: Neon is the
  single origin; Hetzner and R2 stay read-only until the soak ends, and
  `VIDEORC_DOWNLOAD_STORAGE_PRIMARY=hetzner` in videorc-web is the rollback.
- Only while R2 is still an origin: load `VIDEORC_DOWNLOAD_S3_*` from
  `~/projects/videorcweb/.env` and normalize the upload endpoint to the
  bucket-less R2 account host. A Neon-only setup needs no R2 env.
- Every Neon release credential needs both `storage:read` and `storage:write`;
  a write-only key gets 403 on the uploader's HEAD/GET checks.
- Read "Storage origins" in the release runbook: a blocked mirror degrades the
  release and leaves a pending record to replay with
  `pnpm release:sync:origins -- --pending`; a blocked primary stops it unless
  `VIDEORC_RELEASE_ALLOW_MIRROR_ONLY=1`.

### Windows

- Verify the protected `windows-alpha-release` environment, required reviewers,
  protected-main deployment rule, GitHub OIDC federation, Azure Trusted Signing
  publisher/profile values, and least-privilege candidate/promotion storage
  credentials (including the `VIDEORC_RELEASE_UPLOAD_NEON_S3_*` origin) are
  configured.
- For the physical acceptance route, verify a named operator has clean physical
  Windows 11 x64 hardware, private candidate-read access, a release secret
  channel, and the acceptance template. An owner-waiver route instead requires
  the owner's committed exact-candidate record described in section 4.
- Verify the web pilot bearer secret and the disabled/pilot/public release-state
  values are ready. Do not place Windows signing or storage credentials in a
  local release env file.

## 1. Freeze the numeric version and macOS source

1. Bump `apps/desktop/package.json` to a strictly higher numeric version.
2. Choose the macOS Beta number and derive `<version>-beta.<N>`.
3. Derive the Windows release ID as exactly `<version>-alpha.1`. A correction
   requires another numeric version bump; never issue same-version `alpha.2`.
4. When macOS is requested, write `changelog/<version>-beta.<N>.md` with
   `channel: beta` and `platforms: [macos]`. For Windows-only, write the Alpha
   entry from section 3 instead.
5. Run `pnpm changelog:check`, commit the version and requested platform entry,
   push through a reviewed PR, and merge to protected `main`.

Record the full lowercase 40-character source commit for the requested platform.
For a coordinated release, this is the macOS source; record the later Windows
candidate source separately. The Windows Alpha changelog entry may be added
before or after the macOS upload:
`release:upload:macos` withholds Windows-only entries that are not public yet,
so a held Windows release is never disclosed by a macOS upload. Confirm the
`withholding <releaseId>` line in the upload log.

## 2. Publish and verify macOS Beta

Follow `docs/releases/release-runbook.md`. For the established local keychain
path, load release secrets, set `APPLE_TEAM_ID=C2PA37RB58`, set the exact Beta
number, and normalize every origin endpoint to its host-only form before running:

```sh
pnpm package:backend:macos && pnpm ffmpeg:build:macos \
  && pnpm package:preflight:macos \
  && pnpm --filter @videorc/desktop dist:release \
  && pnpm release:manifest:macos \
  && pnpm release:validate:macos
```

This local path intentionally bypasses `release:preflight:macos`, whose
`CSC_LINK` requirement does not apply to the keychain identity. Do not bypass
artifact validation, signing, notarization, stapling, changelog, or upload
preflight behavior.

Complete the macOS clean-machine acceptance template, required real-device
screen/camera/microphone gates, installed-app checks, and strict provider
readiness with an overall `PASS`. Only then publish:

```sh
pnpm release:upload:preflight:macos && pnpm release:upload:macos
```

Follow the redirects and verify:

```sh
curl -sL https://www.videorc.com/api/updates/latest-mac.yml | head
curl -s -o /dev/null -w '%{http_code}\n' -L \
  https://www.videorc.com/api/updates/Videorc-<version>-mac-arm64.zip
```

Also verify the signed-in macOS download page shows the exact new version and
checksum. The stable manifest must remain
`releases/macos/latest/release.json`; never pin the web environment to one
versioned object.

## 3. Build the private Windows Alpha candidate

For a coordinated release, continue after macOS upload and verification succeed.
For Windows-only, start here after version preparation; macOS is not a dependency.
Reuse the already prepared version/Alpha entry rather than bumping twice:

1. Add `changelog/<version>-alpha.1.md` with `channel: alpha` and
   `platforms: [windows]` on top of current `main`.
2. State only Windows capabilities that the acceptance plan can prove. Keep
   internal gate details out of the public entry.
3. Run `pnpm changelog:check`, push through a reviewed PR, and merge to protected
   `main` without changing the numeric package version.
4. Record this new full lowercase 40-character Windows candidate source commit.

From the current protected-main Windows source commit, dispatch the exact release
ID:

```sh
gh workflow run release-windows-alpha.yml --ref main \
  -f release_id=<version>-alpha.1
```

Wait for both trust-separated jobs. The unprivileged job builds and hashes the
unsigned handoff; only the protected OIDC job may sign, validate, and upload the
immutable private candidate. Record the workflow URL, release ID, source commit,
installer SHA-256, exact publisher, and candidate prefix.

Any stale-main, signing, timestamp, publisher, manifest, feed, checksum, or
immutable-object failure blocks the release. A transient retry may reuse the
same release ID only when the source commit and all candidate bytes are
unchanged. Any source or candidate correction must remove the abandoned,
unpublished Windows changelog entry from current `main`, bump the numeric
package version, add the replacement `<new-version>-alpha.1` entry, and begin a
new candidate. Keep the already-published macOS release; do not republish it
merely to restore version parity. Never mutate or bless failed bytes.

If the rejected candidate reached pilot, keep the web state `disabled`, rotate
the pilot bearer token immediately, and use the named release-owner rollback
procedure to restore the last accepted pilot pointer only when that recovery is
supported and verified. Otherwise, including the first pilot, leave the rejected
immutable objects preserved but make the pilot route inaccessible until a
replacement is authorized.

If an out-of-order upload already exposed the abandoned Windows changelog entry,
stop and treat it as a content incident. The normal macOS and Windows uploaders
merge remote entries additively, so deleting the file from Git does not retract
the published entry. Preserve the current object/version, use a release-owner
approved full-document recovery path to replace `changelog/changelog.json`, and
verify the website and installed-app changelog before continuing. Never use an
ad-hoc unvalidated object edit or the changelog skip escape as a purge mechanism.

## 4. Accept and promote Windows

Follow every command and evidence rule in
`docs/releases/windows-alpha-runbook.md`:

The default is the physical acceptance and pilot route below. The runbook also
allows an owner-waiver route: read "Owner waiver instead of a PASS record" and
`docs/acceptance/windows-alpha-acceptance-record.md` before using it. Only the
release owner may write and commit that exact-candidate waiver. The AI must not
author it, infer it from "release new version", or turn a failing test into a
waiver. Once the owner's record is on protected `main`, verify its identity and
commit-pinned URL, use the public-promotion command below, and run the production
smoke. Preserve `acceptanceStatus: waived` on download surfaces and in reporting.
The waiver does not bypass signing, hashes, protected approvals, or production
verification. Without PASS evidence or an owner-committed waiver, stop Windows
before public promotion and report the missing gate.

1. Download and verify the exact private candidate on clean physical Windows 11
   x64 hardware.
2. Strip all storage, signing, and Azure authority before launching candidate
   code.
3. Run installed-app acceptance with the expected executable hash and complete
   every required install, sign-in, capture, recording, GPU, process-cleanup,
   Defender, signature, timestamp, updater, and uninstall row.
4. Promote the exact identity to the isolated pilot lane:

   ```sh
   gh workflow run promote-windows-alpha.yml --ref main \
     -f release_id=<releaseId> \
     -f source_commit=<40-character-source-commit> \
     -f installer_sha256=<64-character-installer-sha256> \
     -f stage=pilot
   ```

5. Verify the authenticated account download and bearer-protected pilot updater
   round trip. Clear the pilot token from the operator environment afterward.
6. Commit the strict sanitized PASS record at
   `docs/acceptance/windows-alpha/<releaseId>.json`. Use a commit-pinned GitHub
   URL; never publish private evidence.
7. Promote the same candidate identity to public:

   ```sh
   gh workflow run promote-windows-alpha.yml --ref main \
     -f release_id=<releaseId> \
     -f source_commit=<40-character-source-commit> \
     -f installer_sha256=<64-character-installer-sha256> \
     -f stage=public \
     -f acceptance_record_url=<commit-pinned-github-record-url>
   ```

Never rebuild between acceptance and either promotion. Never substitute CI,
VM-only, file-size, branch URL, or mutable-tag evidence for the exact physical
record.

## 5. Verify the coordinated production release

- Verify the signed-in Windows download returns the accepted installer and
  visible SHA-256.
- Verify the Windows public `latest.yml`, installer, and blockmap resolve through
  the production updater route and update the prior accepted Alpha.
- Recheck the Windows Authenticode publisher, valid status, timestamp, and
  downloaded SHA-256.
- Verify the macOS DMG, checksum, `latest-mac.yml`, zip, and blockmap still point
  to the macOS release prepared above.
- Authorize the web Windows `public` state only after those checks pass, deploy,
  and rerun the two-platform smoke matrix.
- Update `docs/releases/<version>.md` with both platform outcomes, workflow and
  evidence links, rollback status, and any explicitly incomplete external gate.
- Render/send announcements from the exact platform changelog entry only after
  that platform is live. Preview with
  `pnpm release:notify:discord <releaseId> --dry-run`, then send with
  `pnpm release:notify:discord <releaseId>`. Hold all Windows announcements
  until public promotion.

## Hard-won rules

- Use a bucket-less (host-only) endpoint for every origin, R2 account host or
  Neon `<branch-id>.storage.c-<N>.<region>.aws.neon.tech`. A bucket suffix
  causes doubled keys that upload successfully and then 404.
- Do not source process substitution under macOS Bash 3.2; write filtered env
  lines to a temporary file and source that file, or run the documented command
  under zsh.
- Follow every web redirect to the final storage response; a `302` alone is not
  proof. Verify the mirror route `/api/updates/mirror/` too: while a mirror is
  configured its final host differs from the primary's; with Neon as the single
  origin it serves the primary, never a 5xx.
- A forged TLS issuer on a storage host is a network block (Spain, matchday
  evenings), not an outage. Never bypass TLS; publish around it.
- Keep presigned updater redirects short-lived; never restore immutable caching.
- macOS updater order uses the numeric package version, not the Beta release ID.
- Windows updater order also uses the numeric package version; this is why every
  Alpha correction must bump it and return to `alpha.1`.
- Keep all macOS and Windows release, updater, pilot, and candidate prefixes
  isolated. A Windows action must never move a macOS pointer.
- Roll forward installed clients with a higher numeric version. Disable or
  restore web pointers for rollback; never overwrite immutable release bytes.
