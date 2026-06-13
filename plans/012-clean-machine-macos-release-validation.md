# Plan 012: Validate a signed macOS release candidate on a clean machine

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the next
> step. If a STOP condition occurs, stop and report; do not improvise.
>
> **Drift check (run first)**:
> `git diff --stat 0ea3c66c..HEAD -- package.json apps/desktop/package.json apps/desktop/electron-builder.yml .github/workflows/release-macos.yml docs/distribution.md scripts/smoke-packaged-app.mjs scripts/smoke-preview-surface-app.mjs`
> If any in-scope file changed since this plan was written, compare the current
> excerpts below against live code before proceeding. On mismatch, treat it as a
> STOP condition.

## Status

- **Priority**: P0
- **Effort**: L
- **Risk**: MED
- **Depends on**: Plans 004, 006, 008, 009, and 011
- **Category**: dx, security, docs
- **Planned at**: commit `0ea3c66c`, 2026-06-13
- **Current status**: IN PROGRESS, 2026-06-13. Step 1 landed as a
  behavior-free release-preflight slice: `pnpm release:preflight:macos` checks
  signed-release credentials/tools/paths with redacted output, and
  `pnpm dist:desktop:signed` runs it before packaging. Artifact validation,
  workflow validation, and clean-machine release evidence remain pending.

## Why this matters

The app can build and pass packaged smokes locally, but a public macOS release
needs signed, notarized, stapled, Gatekeeper-accepted behavior on a clean
machine. This is the difference between "developer build works here" and "a
creator can download it and trust it." The release gate must prove the bundled
backend, bundled FFmpeg, native preview helper, permissions, and OAuth readiness
survive packaging.

## Current state

Relevant files:

- `apps/desktop/electron-builder.yml` - macOS signing/notarization config and
  packaged resources.
- `.github/workflows/release-macos.yml` - signed DMG workflow.
- `docs/distribution.md` - current release notes and checklist.
- `scripts/smoke-packaged-app.mjs` - packaged app boot/record smoke.
- `scripts/smoke-preview-surface-app.mjs` - packaged native preview smoke when
  `VIDEORC_SMOKE_PACKAGED_APP=1`.

Current macOS config already enables hardened runtime, entitlements, and
notarization:

```yaml
# apps/desktop/electron-builder.yml:43
hardenedRuntime: true
icon: build-resources/icon.icns
entitlements: build-resources/entitlements.mac.plist
entitlementsInherit: build-resources/entitlements.mac.plist
notarize: true
```

The release workflow builds a signed DMG but does not yet validate the produced
artifact on a clean account:

```yaml
# .github/workflows/release-macos.yml:46
- name: Verify
  run: |
    cargo fmt --check --all
    pnpm smoke:local-gates

# .github/workflows/release-macos.yml:51
- name: Build signed and notarized macOS DMG
  run: pnpm dist:desktop:signed
```

Distribution docs list clean-machine validation as still needed:

```md
<!-- docs/distribution.md:103 -->
- Gatekeeper validation on a clean macOS account
```

Repo conventions:

- Packaged native preview must prove `previewSurfaceBacking = cametal-layer`.
- Do not silently downgrade to JPEG polling when a session claims native
  preview.
- Release artifacts must not include secrets or generated media evidence unless
  explicitly documented.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Local gates | `pnpm smoke:local-gates` | exits 0 |
| Package dir | `pnpm package:desktop` | unsigned app dir built |
| Release DMG | `pnpm dist:desktop:signed` | signed/notarized DMG built when secrets are present |
| Packaged boot | `pnpm smoke:packaged:bundled` | packaged backend and bundled FFmpeg work |
| Packaged preview | `pnpm smoke:packaged:native-preview` | native CAMetalLayer preview works |
| macOS assessment | `spctl --assess --type execute --verbose <Videorc.app>` | accepted |
| Signature inspect | `codesign --verify --deep --strict --verbose=2 <Videorc.app>` | valid |

## Scope

**In scope**:

- `apps/desktop/electron-builder.yml`
- `.github/workflows/release-macos.yml`
- `package.json` and `apps/desktop/package.json` release scripts
- `scripts/smoke-packaged-app.mjs`
- `scripts/smoke-preview-surface-app.mjs`
- new release validation script under `scripts/` if useful
- `docs/distribution.md`

**Out of scope**:

- Changing media quality behavior. Plan 006 owns split output.
- Changing secret storage internals. Plan 009 owns credentials.
- New auto-update infrastructure.
- Website release/download page changes.

## Git workflow

- Branch: `codex/012-clean-machine-macos-release`
- Commit style: scripts first, workflow second, docs/evidence template last.
- Do not push unless instructed.

## Steps

### Step 1: Add a redacted release preflight

Create a script such as `scripts/preflight-macos-release.mjs` that checks:

- required signing/notarization env vars are present, without printing values
- `xcrun notarytool` and `stapler` are available
- `codesign` and `spctl` are available
- `apps/desktop/build-resources/entitlements.mac.plist` exists
- release output directory is writable

Add a root script, for example:

```json
"release:preflight:macos": "node scripts/preflight-macos-release.mjs"
```

**Verify**: `pnpm release:preflight:macos` exits 0 when credentials/tools are
present, or exits non-zero with only redacted missing-prerequisite names.

### Step 2: Add artifact validation after build

Create a script such as `scripts/validate-macos-release-artifact.mjs` that accepts
an app path or discovers the latest packaged `.app`/DMG under
`apps/desktop/release/`. It should run or instruct the operator to run:

- `codesign --verify --deep --strict --verbose=2`
- `codesign -dv --verbose=4`
- `spctl --assess --type execute --verbose`
- `xcrun stapler validate`

Do not parse secrets or print full local usernames from paths if avoidable.

**Verify**: after `pnpm dist:desktop:signed`, the validator exits 0 for the
signed `.app` and DMG.

### Step 3: Wire release workflow validation

Update `.github/workflows/release-macos.yml` so the release job runs:

- dependency/security gates from Plan 008, if they exist
- release preflight before `dist:desktop:signed`
- artifact validation after `dist:desktop:signed`

Keep uploaded artifacts unchanged unless validation needs a small redacted
markdown report.

**Verify**: `pnpm format:check` exits 0.

### Step 4: Define the clean-machine smoke procedure

Update `docs/distribution.md` with a release-candidate procedure:

1. Download or copy the signed DMG to a clean macOS user or clean Mac.
2. Mount the DMG and launch `Videorc.app`.
3. Confirm Gatekeeper accepts it without override.
4. Grant camera, microphone, and screen permissions.
5. Run packaged recording and native preview smokes.
6. Run one real-source manual recording.
7. Record evidence paths, screenshots, and failures in a dated note.

If fully automating this requires device permissions not available in CI, keep
the clean-machine part manual but scripted enough that the operator records the
same evidence every time.

**Verify**: docs include exact commands and expected evidence.

### Step 5: Run the release candidate gate

Run:

```sh
pnpm smoke:local-gates
pnpm dist:desktop:signed
pnpm smoke:packaged:bundled
pnpm smoke:packaged:native-preview
```

Then run the new artifact validator and clean-machine checklist.

Expected:

- signed artifact is accepted by `codesign`, `spctl`, and `stapler`
- packaged backend emits `READY`
- bundled FFmpeg is used
- packaged native preview reports CAMetalLayer
- no fallback preview path is presented as production

## Test plan

- Unit/script tests if pure validation helpers are added.
- `pnpm format:check`
- `pnpm smoke:local-gates`
- `pnpm dist:desktop:signed`
- `pnpm smoke:packaged:bundled`
- `pnpm smoke:packaged:native-preview`
- manual clean-machine launch and permission grant

## Done criteria

- [x] Release preflight exists and prints only redacted credential status.
- [ ] Signed artifact validation exists and checks signature, notarization, and
      Gatekeeper acceptance.
- [ ] Release workflow runs the new validation.
- [ ] `docs/distribution.md` has a clean-machine release-candidate checklist.
- [ ] Packaged bundled FFmpeg and native CAMetalLayer preview smokes pass.
- [ ] A dated clean-machine evidence note exists under `docs/acceptance/`.
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report if:

- Signing/notarization credentials are unavailable.
- Gatekeeper rejects a signed artifact.
- Packaged native preview falls back to JPEG polling.
- The artifact includes secrets, local app data, or generated recordings.
- A fix requires changing Plan 006 media behavior or Plan 009 credential
  storage internals.

## Maintenance notes

This plan should become the release train gate. Future release work should add
checks to the validator rather than relying on memory or local-only commands.
