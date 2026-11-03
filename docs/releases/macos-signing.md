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
embedded in the app. A restricted key signed without its profile gets the app
killed by AMFI at launch, so the build embeds nothing until the profile is
present, and a release without it fails validation instead of shipping a
camera-less build by accident.

What spike P0a proved on real hardware (macOS 26.5.1, SIP on, notarized, seen
in Chrome), and what every script below enforces:

- There is exactly **one** profile, for the app. The extension embeds none.
- The extension's entitlements are exactly `com.apple.security.app-sandbox`
  and `com.apple.security.application-groups`
  (`C2PA37RB58.dev.theorcdev.videorc`). It must not claim
  `com.apple.application-identifier` or `com.apple.developer.team-identifier`:
  without an embedded profile those are restricted keys and the binary is
  killed at exec, silently, with no crash report.
- The profile does not list the app group. The signature alone carries it and
  AMFI accepts that.
- Every binary other than the main executable keeps the five pre-camera keys
  only, and the app is never signed with `--deep`.

### Secret

| Name                        | Holds                                                                                                                                       | Where                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `VIDEORC_MACOS_PROFILE_APP` | The Developer ID profile for `dev.theorcdev.videorc` with `com.apple.developer.system-extension.install` (App Groups enabled on the App ID) | GitHub secret (base64); `~/.videorc-release.env` (base64 or path) |

The value is either the base64 of the `.provisionprofile`
(`base64 -i videorc-app.provisionprofile | tr -d '\n'`) or an absolute path to
it (`~/` is expanded; the owner's copy lives at
`~/.videorc-signing/videorc-app.provisionprofile`). `VIDEORC_MACOS_PROFILE_CAMERA`
from the original plan is retired: the packaging hook, `package:preflight:macos`,
`release:preflight:macos` and `sign:desktop:local` fail when it is still set,
so remove it from `~/.videorc-release.env`.

What the profile looks like when decoded, and what the packaging hook checks
before embedding it:

```sh
security cms -D -i videorc-app.provisionprofile | plutil -extract Entitlements xml1 -o - -
```

- `Name`: `Mac Team Direct Provisioning Profile: dev.theorcdev.videorc`
  (Xcode-managed, `ProvisionsAllDevices`, no `ProvisionedDevices`).
- `Entitlements`: `com.apple.developer.system-extension.install` true,
  `com.apple.application-identifier` `C2PA37RB58.dev.theorcdev.videorc`,
  `com.apple.developer.team-identifier` `C2PA37RB58`, and
  `keychain-access-groups`. No `com.apple.security.application-groups`.
- `ExpirationDate`: the portal date (the current profile expires 2044-10-29).
- `DeveloperCertificates`: must contain the Developer ID Application
  certificate that signs the build. The hook compares the SHA-1 of each entry
  with the signing identity's hash (`security find-identity -v -p codesigning`)
  and refuses a profile generated for another certificate, naming the hash and
  pointing at "Renewal" below.

The hook refuses a profile with another team or App ID, without the restricted
key, expired (it warns 30 days ahead), or a Development profile (one listing
devices). Install the secret:

```sh
base64 -i videorc-app.provisionprofile | tr -d '\n' | gh secret set VIDEORC_MACOS_PROFILE_APP --repo TheOrcDev/videorc --body-file -
```

and add the same name to `~/.videorc-release.env`.

### What changes in the signed app

- `Contents/Library/SystemExtensions/dev.theorcdev.videorc.camera.systemextension`
  (bundle and executable named after the bundle identifier), signed before the
  app with exactly two entitlements, `com.apple.security.app-sandbox` and the
  app group, hardened runtime on, and **no** `embedded.provisionprofile`. Its
  `Info.plist` carries `CFBundlePackageType` `SYSX`, `CMIOExtension` →
  `CMIOExtensionMachServiceName` `C2PA37RB58.dev.theorcdev.videorc.camera`,
  and `NSSystemExtensionUsageDescription`. The app's `Info.plist` needs no new
  key.
- `Contents/embedded.provisionprofile` on the app, the only profile in the
  bundle.
- The main executable: the five pre-camera keys plus
  `com.apple.developer.system-extension.install` and the app group, and the
  `com.apple.application-identifier` and `com.apple.developer.team-identifier`
  the profile carries (optional for launch; kept because the hook has checked
  they match the profile). Generated at pack time into
  `apps/desktop/build/camera-extension/entitlements.mac.app.plist`.
- Every other binary (Electron's helpers, frameworks, dylibs, crashpad
  handler, ShipIt, and the bare tools in `Contents/Resources`: backend,
  preview helper, `videorc-mcp`, the `.node` addon, ffmpeg, ffprobe):
  `entitlements.mac.inherit.plist`, the five keys only.
- Signing order, inside out, never `--deep`: the bare tools; the Electron
  Framework dylibs and the crashpad handler; ShipIt; the frameworks; the
  helper apps; the extension; the app last, with the profile already copied
  in. `scripts/sign-macos-local-app.mjs` walks the bundle the way
  `@electron/osx-sign` does (every Mach-O deepest first, then frameworks, then
  helper apps) and runs exactly that plan; electron-builder passes
  `entitlementsInherit` to every nested object and `entitlements` to the app
  only, and `mac.signIgnore` keeps osx-sign away from the extension the hook
  already signed. `--deep` with one plist pushed the restricted key into the
  helpers, which is a silent SIGKILL at exec.
- One build log line: `Videorc Camera embedded at Contents/Library/SystemExtensions/...`,
  or `Videorc Camera skipped: ...` with the reason. A release must never show
  the second.

### Approval on the user's Mac

The user approves the extension once, in System Settings → General → Login
Items & Extensions → Camera Extensions (macOS 15 to 26; on 13 and 14 the
prompt lives in Privacy & Security). Replacing the extension with a newer
version needs no re-approval and no reboot. Activation works only from a
Developer ID signed, notarized Videorc.app in `/Applications`.

### Renewal

The profile embeds the Developer ID Application certificate, so it must be
regenerated whenever that certificate is renewed. The current certificate
(`Developer ID Application: Uros Miric (C2PA37RB58)`) expires **2027-02-01**;
after it is renewed, `CSC_LINK`, the keychain identity and
`VIDEORC_MACOS_PROFILE_APP` must all be refreshed together, or the packaging
hook stops the build with "does not embed the Developer ID Application
certificate signing this build". The portal date on the profile itself is
2044-10-29.

The recipe that produced the current profile (the Apple portal alone did not
offer a Developer ID profile for the System Extension capability; Xcode did):

1. Keep a throwaway Xcode project with a macOS app target whose bundle id is
   `dev.theorcdev.videorc`, team `C2PA37RB58`, automatic signing, with the
   System Extension and App Groups capabilities, and a Camera Extension
   target `dev.theorcdev.videorc.camera`. The spike's copy is
   `~/videorc-vcam-spike/xcode/` (`project.yml`, Info.plist and entitlements).
2. Archive it development-signed. That needs a registered device (this Mac is
   registered):

   ```sh
   xcodebuild archive -project VideorcCameraSpike.xcodeproj -scheme VideorcCameraSpike \
     -archivePath build/spike.xcarchive -allowProvisioningUpdates \
     -allowProvisioningDeviceRegistration
   ```

   Do not pass `CODE_SIGN_IDENTITY="Developer ID Application"`: xcodebuild
   rejects it under automatic signing.

3. Export with the Developer ID method; this is the step that creates the
   profile in the portal and downloads it:

   ```sh
   xcodebuild -exportArchive -archivePath build/spike.xcarchive \
     -exportOptionsPlist ExportOptions.plist -exportPath build/export \
     -allowProvisioningUpdates
   ```

   with `ExportOptions.plist` holding `method` `developer-id`, `signingStyle`
   `automatic`, `teamID` `C2PA37RB58`, `destination` `export`.

4. Take `Contents/embedded.provisionprofile` from the exported app, decode it
   as above, confirm the entitlements and that `DeveloperCertificates`
   contains the renewed certificate, copy it to
   `~/.videorc-signing/videorc-app.provisionprofile`, and re-set the GitHub
   secret and the env file line. Rebuild; the hook's "ok (... embeds the
   signing certificate)" line confirms it.

### The validator's lines

`pnpm release:validate:macos` adds, for the `.app`:

```text
[ok] Videorc Camera extension Info.plist bundle identifier
[ok] Videorc Camera extension package type (SYSX)
[ok] Videorc Camera extension CMIOExtensionMachServiceName
[ok] Videorc Camera extension usage description
[ok] Videorc Camera extension signature
[ok] Videorc Camera extension entitlements (exactly sandbox + app group)
[ok] Videorc Camera extension embeds no profile
[ok] app embedded profile (Videorc Camera)
[ok] one embedded profile, in the app only
[ok] system extension entitlements (app)
[ok] inherit entitlements only (videorc-backend)
[ok] inherit entitlements only (native_preview_host_helper)
[ok] inherit entitlements only (videorc-mcp)
[ok] inherit entitlements only (ffmpeg)
[ok] inherit entitlements only (ffprobe)
[ok] no restricted entitlement (videorc_native_preview.node)
[ok] inherit entitlements only (Videorc Helper.app)
[ok] inherit entitlements only (Videorc Helper (GPU).app)
[ok] inherit entitlements only (Videorc Helper (Plugin).app)
[ok] inherit entitlements only (Videorc Helper (Renderer).app)
[ok] inherit entitlements only (chrome_crashpad_handler)
[ok] inherit entitlements only (ShipIt)
```

"inherit entitlements only" means exactly the five keys of
`entitlements.mac.inherit.plist`, none of the four restricted ones. The
`.node` addon is a Mach-O bundle, not an executable, and codesign embeds no
entitlements into it at all, so it is checked for the restricted keys only.
`pnpm check:packaged-app` reports `cameraExtension` (`embedded`, `partial`, or
`absent (...)`), fails a Developer ID build that lacks any part of it, and on
an embedded extension repeats the shape checks: the two entitlement keys, a
valid signature, `SYSX`, no profile in the extension, the restricted keys on
the main executable only, and exactly one embedded profile in the bundle. An
unsigned or ad hoc local build without the camera only reports it.

### Rollback

A build without the profile fails `release:preflight:macos` and
`release:validate:macos` and never ships. Do not work around that by unsetting
the secret: shipping without the camera means removing the packaging hook, the
entitlements split and the validator checks together in one reviewed PR. A Beta
whose camera misbehaves rolls forward with a higher version like any other
(never overwrite release bytes); the installed extension is replaced by the next
activation, without re-approval or a reboot, and removed when the app is deleted.
