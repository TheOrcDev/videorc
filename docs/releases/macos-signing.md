# macOS Signing And Notarization

Videorc beta DMGs use the same Apple Developer signing shape as AgentPacks:

- `CSC_LINK`
- `CSC_KEY_PASSWORD`
- `APPLE_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `APPLE_TEAM_ID`

`CSC_LINK` should be the base64-encoded Developer ID Application `.p12` export
or another electron-builder supported certificate link. Do not commit the
certificate, password, Apple ID, or app-specific password.

## GitHub Secrets

Verify the source AgentPacks secret names:

```sh
gh secret list --repo TheOrcDev/agent-packs-desktop
```

Install the same named secrets on Videorc after exporting the unused
AgentPacks certificate material from the secure source of truth:

```sh
gh secret set CSC_LINK --repo TheOrcDev/videorc --body-file ./DeveloperIDApplication.p12.base64
gh secret set CSC_KEY_PASSWORD --repo TheOrcDev/videorc
gh secret set APPLE_ID --repo TheOrcDev/videorc
gh secret set APPLE_APP_SPECIFIC_PASSWORD --repo TheOrcDev/videorc
gh secret set APPLE_TEAM_ID --repo TheOrcDev/videorc
```

The local keychain identity currently expected for beta signing is:

```text
Developer ID Application: Uros Miric (C2PA37RB58)
```

## Create `CSC_LINK` From The Local Keychain

First confirm the identity and team id without printing any secret material:

```sh
security find-identity -v -p codesigning
security find-certificate -c "Developer ID Application: Uros Miric" -p \
  | openssl x509 -noout -subject -issuer -serial -dates
```

The expected team id is `C2PA37RB58`.

Recommended exact export path:

1. Open **Keychain Access**.
2. Find `Developer ID Application: Uros Miric (C2PA37RB58)`.
3. Export it as `DeveloperIDApplication.p12`.
4. Use a new random archive password. This value becomes `CSC_KEY_PASSWORD`.
5. Base64 encode the archive for Electron Builder:

   ```sh
   base64 -i DeveloperIDApplication.p12 -o DeveloperIDApplication.p12.base64
   ```

If the signing keychain only contains the intended Developer ID identity, a CLI
export can be used instead. This may prompt for keychain access:

```sh
tmp_dir="$(mktemp -d)"
CSC_KEY_PASSWORD="$(openssl rand -base64 32)"

security export \
  -k "$HOME/Library/Keychains/login.keychain-db" \
  -t identities \
  -f pkcs12 \
  -P "$CSC_KEY_PASSWORD" \
  -o "$tmp_dir/DeveloperIDApplication.p12"

base64 -i "$tmp_dir/DeveloperIDApplication.p12" \
  -o "$tmp_dir/DeveloperIDApplication.p12.base64"
```

Install the generated values:

```sh
gh secret set CSC_LINK --repo TheOrcDev/videorc --body-file "$tmp_dir/DeveloperIDApplication.p12.base64"
printf '%s' "$CSC_KEY_PASSWORD" | gh secret set CSC_KEY_PASSWORD --repo TheOrcDev/videorc --body-file -
```

Then set the notarization credentials:

```sh
gh secret set APPLE_ID --repo TheOrcDev/videorc
gh secret set APPLE_APP_SPECIFIC_PASSWORD --repo TheOrcDev/videorc
printf '%s' 'C2PA37RB58' | gh secret set APPLE_TEAM_ID --repo TheOrcDev/videorc --body-file -
```

Confirm the remote repository has the required release secrets before spending
an Actions run:

```sh
pnpm release:secrets:macos
```

Clean up local certificate artifacts immediately after the secrets are installed:

```sh
rm -rf "$tmp_dir"
unset CSC_KEY_PASSWORD
```

Run the preflight before cutting a beta:

```sh
pnpm release:preflight:macos
```

The release workflow also runs this preflight before the expensive verification
and packaging steps, so missing signing or notarization secrets fail early.

## Videorc Camera (plan 214)

The Videorc Camera system extension (`apps/desktop/camera-extension/`) needs
`com.apple.developer.system-extension.install` on the app. That entitlement is
restricted: Apple honours it only with a Developer ID provisioning profile
embedded in the app, and the sandboxed extension needs a profile of its own for
the app group. A restricted key signed without its profile gets the app killed
by AMFI at launch, so the build embeds nothing until both profiles are present,
and a release without them fails validation instead of shipping a camera-less
build by accident.

### Secrets

| Name                           | Holds                                                                                                                      | Where                                                             |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `VIDEORC_MACOS_PROFILE_APP`    | Developer ID profile for `dev.theorcdev.videorc` with System Extension and App Groups (`C2PA37RB58.dev.theorcdev.videorc`) | GitHub secret (base64); `~/.videorc-release.env` (base64 or path) |
| `VIDEORC_MACOS_PROFILE_CAMERA` | Developer ID profile for `dev.theorcdev.videorc.camera` with App Groups (`C2PA37RB58.dev.theorcdev.videorc`)               | same                                                              |

Each value is either the base64 of the `.provisionprofile`
(`base64 -i Videorc.provisionprofile | tr -d '\n'`) or an absolute path to it
(`~/` is expanded). Set both or neither: one without the other is an error in
the packaging hook, `package:preflight:macos` and `sign:desktop:local`.

Creating them (B0, the owner, once, in the Apple Developer portal): enable
System Extension and App Groups on the `dev.theorcdev.videorc` App ID, register
`dev.theorcdev.videorc.camera` with App Groups, create the app group
`C2PA37RB58.dev.theorcdev.videorc`, then create one Developer ID provisioning
profile per App ID. Check each before installing it:

```sh
security cms -D -i Videorc.provisionprofile | plutil -extract Entitlements xml1 -o - -
```

The app profile must show `com.apple.developer.team-identifier` `C2PA37RB58`,
`com.apple.application-identifier` `C2PA37RB58.dev.theorcdev.videorc`, the app
group and `com.apple.developer.system-extension.install`; the camera profile the
same team, `C2PA37RB58.dev.theorcdev.videorc.camera` and the app group. The
packaging hook repeats these checks and refuses swapped, foreign or expired
profiles. Install them:

```sh
base64 -i Videorc.provisionprofile | tr -d '\n' | gh secret set VIDEORC_MACOS_PROFILE_APP --repo TheOrcDev/videorc --body-file -
base64 -i VideorcCamera.provisionprofile | tr -d '\n' | gh secret set VIDEORC_MACOS_PROFILE_CAMERA --repo TheOrcDev/videorc --body-file -
```

and add the same two names to `~/.videorc-release.env`.

### What changes in the signed app

- `Contents/Library/SystemExtensions/VideorcCamera.systemextension`, signed
  before the app with its own entitlements (app sandbox, the app group, its
  application and team identifiers) and its own `Contents/embedded.provisionprofile`.
- `Contents/embedded.provisionprofile` on the app.
- The app's entitlements: the five pre-camera keys plus
  `com.apple.developer.system-extension.install`,
  `com.apple.security.application-groups`, `com.apple.application-identifier`
  and `com.apple.developer.team-identifier`, generated at pack time into
  `apps/desktop/build/camera-extension/entitlements.mac.app.plist`.
- Every helper and bare binary (backend, preview helper, `videorc-mcp`, the
  `.node` addon, ffmpeg, ffprobe): `entitlements.mac.inherit.plist`, the five
  keys only. A bare binary cannot carry a profile.
- One build log line: `Videorc Camera embedded at Contents/Library/SystemExtensions/...`,
  or `Videorc Camera skipped: ...` with the reason. A release must never show
  the second.

### Renewal

Developer ID provisioning profiles expire (the portal shows the date; the
packaging hook warns 30 days ahead and refuses an expired one). Regenerate both
profiles in the portal against the same App IDs and capabilities, re-set both
GitHub secrets and the two lines in `~/.videorc-release.env`, and rebuild. The
Developer ID certificate's own expiry bounds the profiles: renewing the
certificate (`CSC_LINK`) means regenerating both profiles too.

### The validator's lines

`pnpm release:validate:macos` adds, for the `.app`:

```text
[ok] Videorc Camera extension Info.plist bundle identifier
[ok] Videorc Camera extension CMIOExtensionMachServiceName
[ok] Videorc Camera extension usage description
[ok] Videorc Camera extension signature
[ok] Videorc Camera extension entitlements
[ok] Videorc Camera extension embedded profile
[ok] app embedded profile (Videorc Camera)
[ok] system extension entitlements (app)
[ok] no system extension entitlement (videorc-backend)
[ok] no system extension entitlement (native_preview_host_helper)
[ok] no system extension entitlement (videorc-mcp)
[ok] no system extension entitlement (ffmpeg)
[ok] no system extension entitlement (ffprobe)
[ok] no system extension entitlement (videorc_native_preview.node)
```

`pnpm check:packaged-app` reports `cameraExtension` (`embedded`, `partial`, or
`absent (...)`) and fails a Developer ID build that lacks any part of it; an
unsigned or ad hoc local build without the camera only reports it.

### Rollback

A build without the profiles fails `release:preflight:macos` and
`release:validate:macos` and never ships. Do not work around that by unsetting
the secrets: shipping without the camera means removing the packaging hook, the
entitlements split and the validator checks together in one reviewed PR. A Beta
whose camera misbehaves rolls forward with a higher version like any other
(never overwrite release bytes); the installed extension is replaced by the next
activation and removed when the app is deleted.
