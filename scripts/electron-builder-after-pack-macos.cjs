// Plan 214 B2: electron-builder `afterPack` hook (apps/desktop/electron-builder.yml).
//
// Runs after the app is packed and BEFORE electron-builder signs it. On macOS
// it writes the app entitlements electron-builder will sign with
// (build/camera-extension/entitlements.mac.app.plist) and, only when
// VIDEORC_MACOS_PROFILE_APP is set, embeds the Videorc Camera extension and
// signs it with its own two entitlements (app sandbox, app group; no profile),
// copies the app profile to Contents/embedded.provisionprofile, and widens the
// app entitlements with the restricted system-extension key. @electron/osx-sign
// then signs every nested Mach-O, framework and helper with the inherit plist
// and the app last with the app plist (never --deep); `mac.signIgnore` keeps it
// away from the extension's binary, which it would otherwise re-sign as a bare
// file with the inherit entitlements and break the already sealed bundle.
//
// Without the profile the hook logs one line and the build is exactly what it
// was before the camera. The retired VIDEORC_MACOS_PROFILE_CAMERA is an error.
'use strict'

const path = require('node:path')
const { spawnSync } = require('node:child_process')

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') {
    return
  }
  const { cameraProfileDecision, embedCameraExtension, pickSigningIdentity } =
    await import('./lib/camera-extension-packaging.mjs')
  const repoRoot = path.resolve(__dirname, '..')
  const packager = context.packager
  const appPath = path.join(context.appOutDir, `${packager.appInfo.productFilename}.app`)
  const log = (line) => console.log(`  • ${line}`)

  const decision = cameraProfileDecision(process.env)
  if (decision.mode === 'error') {
    throw new Error(`Videorc Camera: ${decision.reason}`)
  }

  const identityOption = packager.platformSpecificBuildOptions?.identity
  let identity = null
  let keychain = null
  let unsignedReason = null
  if (identityOption === null) {
    unsignedReason = 'unsigned build (mac.identity=null)'
  } else if (decision.mode === 'embed') {
    // Same keychain electron-builder signs with (CSC_LINK imports into a
    // temporary one); resolving it here creates it before osx-sign runs.
    const signing = await packager.codeSigningInfo.value
    keychain = signing?.keychainFile ?? null
    const found = spawnSync(
      'security',
      ['find-identity', '-v', '-p', 'codesigning', ...(keychain ? [keychain] : [])],
      { encoding: 'utf8' }
    )
    const picked = pickSigningIdentity(found.stdout, {
      preferred:
        process.env.CSC_NAME || (typeof identityOption === 'string' ? identityOption : undefined)
    })
    if (!picked) {
      throw new Error(
        'Videorc Camera: no Developer ID Application identity is available to sign the extension (keychain or CSC_LINK).'
      )
    }
    // The hash: codesign accepts it, and it is the certificate's SHA-1, which
    // the profile check compares against DeveloperCertificates.
    identity = picked.hash
    log(`Videorc Camera: signing the extension as ${picked.name}`)
  }

  await embedCameraExtension({
    appPath,
    repoRoot,
    env: process.env,
    version: packager.appInfo.version,
    buildVersion: packager.appInfo.buildVersion,
    identity,
    keychain,
    unsignedReason,
    log
  })
}
