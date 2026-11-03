// Plan 214 B5: what a packaged Videorc.app must show about the Videorc Camera
// extension. Pure: the layout is read through an injected `exists`, the
// signature from `codesign -dv` output. Used by scripts/check-packaged-app.mjs;
// the release validator runs the codesign/security/plutil checks on top
// (scripts/lib/macos-release-artifact-validation.mjs).
import { dirname, join, resolve } from 'node:path'

import { cameraExtensionBundleRelativePath } from './camera-extension-identifiers.mjs'

/** The .app root for a bundle path or its Contents/MacOS executable. */
export function appBundleRootForApp(appPath) {
  const path = resolve(String(appPath))
  if (path.endsWith('.app')) {
    return path
  }
  return resolve(dirname(path), '..', '..')
}

/** Every file the camera needs inside the app, as repo-independent paths. */
export function cameraExtensionPaths(appRoot, identifiers) {
  const extension = join(appRoot, ...cameraExtensionBundleRelativePath(identifiers).split('/'))
  return {
    extension,
    infoPlist: join(extension, 'Contents', 'Info.plist'),
    executable: join(extension, 'Contents', 'MacOS', identifiers.extensionBundleName),
    extensionProfile: join(extension, 'Contents', 'embedded.provisionprofile'),
    appProfile: join(appRoot, 'Contents', 'embedded.provisionprofile')
  }
}

/** Pure (IO injected). Which of the camera files exist. */
export function cameraExtensionLayout(appRoot, { identifiers, exists }) {
  const paths = cameraExtensionPaths(appRoot, identifiers)
  return {
    paths,
    present: Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, exists(path)]))
  }
}

/**
 * Pure. Reads `codesign -dv --verbose=4` output: whether the app is signed,
 * ad hoc, and by which team.
 */
export function appSignatureFromCodesignDisplay(output, { exitCode = 0 } = {}) {
  const text = String(output ?? '')
  if (exitCode !== 0 || /code object is not signed at all/.test(text)) {
    return { signed: false, adhoc: false, teamIdentifier: null }
  }
  const team = /^TeamIdentifier=(.+)$/m.exec(text)?.[1]?.trim() ?? null
  return {
    signed: true,
    adhoc: /^Signature=adhoc$/m.test(text),
    teamIdentifier: team && team !== 'not set' ? team : null
  }
}

/** Pure. A Developer ID build by Videorc's team: the shape that ships. */
export function isDeveloperIdBuild(signature, identifiers) {
  return signature.signed && !signature.adhoc && signature.teamIdentifier === identifiers.teamId
}

const LABELS = {
  extension: 'the extension bundle',
  infoPlist: "the extension's Info.plist",
  executable: "the extension's executable",
  extensionProfile: "the extension's embedded.provisionprofile",
  appProfile: "the app's embedded.provisionprofile"
}

/**
 * Pure. One line per problem. A Developer ID build must carry everything
 * (a release without plan 214 B0's profiles is red here, by design); any
 * other build must carry nothing or everything, never half.
 */
export function cameraExtensionLayoutProblems(layout, { identifiers, signature }) {
  const problems = []
  const missing = Object.entries(layout.present)
    .filter(([, present]) => !present)
    .map(([key]) => key)
  const developerId = isDeveloperIdBuild(signature, identifiers)
  if (developerId) {
    for (const key of missing) {
      problems.push(
        `Videorc Camera: ${LABELS[key]} is missing (${relativeToApp(layout.paths[key], layout.paths.appProfile)}). A Developer ID build must embed the extension: set VIDEORC_MACOS_PROFILE_APP and VIDEORC_MACOS_PROFILE_CAMERA (plan 214 B0) and rebuild.`
      )
    }
    return problems
  }
  const presentCount = Object.keys(layout.present).length - missing.length
  if (presentCount > 0 && missing.length > 0) {
    problems.push(
      `Videorc Camera: half-embedded; missing ${missing.map((key) => LABELS[key]).join(', ')}. Rebuild rather than ship a partial extension.`
    )
  } else if (presentCount > 0) {
    problems.push(
      'Videorc Camera: the extension is embedded in a build that is not Developer ID signed by Videorc, so it can never activate. Sign the build or drop the profiles.'
    )
  }
  return problems
}

function relativeToApp(path, appProfilePath) {
  const appRoot = dirname(dirname(appProfilePath))
  return path.startsWith(appRoot) ? path.slice(appRoot.length + 1) : path
}

/** Pure. One word for the report. */
export function describeCameraExtensionLayout(layout, signature, identifiers) {
  const values = Object.values(layout.present)
  if (values.every(Boolean)) {
    return 'embedded'
  }
  if (values.some(Boolean)) {
    return 'partial'
  }
  return isDeveloperIdBuild(signature, identifiers)
    ? 'absent (Developer ID build without the Videorc Camera profiles)'
    : signature.signed
      ? 'absent (ad hoc or non-Videorc signature)'
      : 'absent (unsigned build)'
}
