// Plan 214 B2: electron-builder `afterPack` hook (apps/desktop/electron-builder.yml).
//
// Runs after the app is packed and BEFORE electron-builder signs it. On macOS
// it writes the app entitlements electron-builder will sign with
// (build/camera-extension/entitlements.mac.app.plist) and, only when both
// VIDEORC_MACOS_PROFILE_APP and VIDEORC_MACOS_PROFILE_CAMERA are set, embeds
// the Videorc Camera extension with its profile and signs it with its own
// entitlements, so the app's signature seals an already signed extension.
// `mac.signIgnore` keeps osx-sign away from the extension's binary (it would
// re-sign it as a bare file with the inherit entitlements).
//
// Without profiles the hook logs one line and the build is exactly what it
// was before the camera. One profile without the other is an error.
'use strict'

const path = require('node:path')
const { spawnSync } = require('node:child_process')

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') {
    return
  }
  const { embedCameraExtension, pickSigningIdentity } =
    await import('./lib/camera-extension-packaging.mjs')
  const repoRoot = path.resolve(__dirname, '..')
  const packager = context.packager
  const appPath = path.join(context.appOutDir, `${packager.appInfo.productFilename}.app`)
  const log = (line) => console.log(`  • ${line}`)

  const identityOption = packager.platformSpecificBuildOptions?.identity
  let identity = null
  let keychain = null
  let unsignedReason = null
  if (identityOption === null) {
    unsignedReason = 'unsigned build (mac.identity=null)'
  } else if (
    process.env.VIDEORC_MACOS_PROFILE_APP?.trim() ||
    process.env.VIDEORC_MACOS_PROFILE_CAMERA?.trim()
  ) {
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
