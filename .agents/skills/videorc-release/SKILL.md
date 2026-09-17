---
name: videorc-release
description: Cut and publish coordinated Videorc desktop releases for the signed and notarized macOS Beta and the signed Windows 11 x64 Alpha, including version/changelog preparation, protected Windows candidate and promotion workflows, R2 publication, updater verification, and release records. Use when the user asks to cut, ship, publish, deploy, or make a new Videorc desktop release or update. Target both macOS and Windows by default unless the user explicitly narrows the platform.
---

# Videorc release

Ship one new numeric desktop version on both supported tracks:

- macOS arm64 Beta: `<version>-beta.<N>`;
- Windows 11 x64 Alpha: `<version>-alpha.1`.

Target both platforms unless the user explicitly requests a platform-only
release. Do not silently skip Windows because macOS can be released locally.

Before acting, read both sources of truth in full:

- `docs/releases/release-runbook.md` for macOS, shared versioning, and rollback;
- `docs/releases/windows-alpha-runbook.md` for Windows signing, candidate,
  physical acceptance, pilot, public promotion, and rollback.

Keep this skill as the executable coordinator. Do not weaken or duplicate the
runbooks' detailed gates.

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
  and the exact Windows candidate has passed physical acceptance, pilot, public
  promotion, and production smoke.
- If an external Windows gate cannot be completed, preserve the candidate and
  report the release as partial with the exact missing gate. Never describe a
  private candidate or pilot pointer as a public Windows release.
- Keep the web Windows state `disabled` until public promotion and production
  smoke succeed. Never change macOS availability while gating Windows.

## Prerequisites

### Shared

- Use a clean checkout based on current protected `main`.
- Confirm GitHub access can dispatch and inspect Actions workflows.
- Confirm R2 credentials are scoped to the documented platform prefixes. Never
  run the local macOS upload concurrently with Windows public promotion because
  both may update the merged global changelog. After merging a pending Windows
  Alpha changelog entry, do not run another macOS upload until that Windows
  release is public or the release owner explicitly resolves the held entry.
- Name release, Windows acceptance, support, and rollback owners before starting.

### macOS

- Load `APPLE_ID` and `APPLE_APP_SPECIFIC_PASSWORD` from
  `~/.videorc-release.env`.
- Load the allow-listed X OAuth consumer key and secret required by the packaged
  backend from the same file. Do not reintroduce the paused YouTube OAuth secret
  unless the runbook explicitly restores that requirement.
- Verify the Developer ID identity `Uros Miric (C2PA37RB58)` is available in the
  keychain, or provide the documented `CSC_LINK` alternative.
- Load `VIDEORC_DOWNLOAD_S3_*` from `~/projects/videorcweb/.env` and normalize
  the upload endpoint to the bucket-less R2 account host.

### Windows

- Verify the protected `windows-alpha-release` environment, required reviewers,
  protected-main deployment rule, GitHub OIDC federation, Azure Trusted Signing
  publisher/profile values, and least-privilege candidate/promotion R2
  credentials are configured.
- Verify a named operator has clean physical Windows 11 x64 hardware, private
  candidate-read access, a release secret channel, and the acceptance template.
- Verify the web pilot bearer secret and the disabled/pilot/public release-state
  values are ready. Do not place Windows signing or storage credentials in a
  local release env file.

## 1. Freeze the numeric version and macOS source

1. Bump `apps/desktop/package.json` to a strictly higher numeric version.
2. Choose the macOS Beta number and derive `<version>-beta.<N>`.
3. Derive the Windows release ID as exactly `<version>-alpha.1`. A correction
   requires another numeric version bump; never issue same-version `alpha.2`.
4. Write `changelog/<version>-beta.<N>.md` with `channel: beta` and
   `platforms: [macos]`.
5. Run `pnpm changelog:check`, commit the version and macOS entry, push through a
   reviewed PR, and merge to protected `main`.

Record the full lowercase 40-character macOS source commit. Do not add the
Windows Alpha changelog entry yet: `release:upload:macos` publishes every
committed changelog entry, so adding it now would disclose the held Windows
release before physical acceptance.

## 2. Publish and verify macOS Beta

Follow `docs/releases/release-runbook.md`. For the established local keychain
path, load release secrets, set `APPLE_TEAM_ID=C2PA37RB58`, set the exact Beta
number, and normalize the R2 endpoint before running:

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

After the macOS upload and verification succeed:

1. Add `changelog/<version>-alpha.1.md` with `channel: alpha` and
   `platforms: [windows]` on top of current `main`.
2. State only Windows capabilities that the acceptance plan can prove. Keep
   internal gate details out of the public entry.
3. Run `pnpm changelog:check`, push through a reviewed PR, and merge to protected
   `main` without changing the numeric package version.
4. Record this new full lowercase 40-character Windows candidate source commit.

Do not run another macOS upload while this unpromoted Windows entry is committed,
because the macOS uploader would publish it in the global changelog. From the
current protected-main Windows source commit, dispatch the exact release ID:

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

- Use a bucket-less R2 endpoint. A bucket suffix causes doubled keys that upload
  successfully and then 404.
- Do not source process substitution under macOS Bash 3.2; write filtered env
  lines to a temporary file and source that file, or run the documented command
  under zsh.
- Follow every web redirect to the final R2 response; a `302` alone is not proof.
- Keep presigned updater redirects short-lived; never restore immutable caching.
- macOS updater order uses the numeric package version, not the Beta release ID.
- Windows updater order also uses the numeric package version; this is why every
  Alpha correction must bump it and return to `alpha.1`.
- Keep all macOS and Windows release, updater, pilot, and candidate prefixes
  isolated. A Windows action must never move a macOS pointer.
- Roll forward installed clients with a higher numeric version. Disable or
  restore web pointers for rollback; never overwrite immutable release bytes.
