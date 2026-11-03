// Plan 214 B5 (shape fixed by spike P0a): what a packaged Videorc.app must show
// about the Videorc Camera extension. Pure: the layout is read through an
// injected `exists`, the signature from `codesign -dv` output, the signed shape
// from injected codesign/plutil readings. Used by scripts/check-packaged-app.mjs;
// the release validator runs the same assertions as shell checks on top
// (scripts/lib/macos-release-artifact-validation.mjs).
import { dirname, join, resolve } from 'node:path'

import {
  cameraExtensionBundleRelativePath,
  cameraExtensionEntitlementProblems,
  cameraExtensionExecutableName,
  restrictedCameraEntitlementKeys
} from './camera-extension-identifiers.mjs'

/** The .app root for a bundle path or its Contents/MacOS executable. */
export function appBundleRootForApp(appPath) {
  const path = resolve(String(appPath))
  if (path.endsWith('.app')) {
    return path
  }
  return resolve(dirname(path), '..', '..')
}

/**
 * Every file the camera needs inside the app, as repo-independent paths, and
 * the one file that must NOT be there: a profile inside the extension (the
 * pre-P0a two-profile shape; the extension embeds none).
 */
export function cameraExtensionPaths(appRoot, identifiers) {
  const extension = join(appRoot, ...cameraExtensionBundleRelativePath(identifiers).split('/'))
  return {
    extension,
    infoPlist: join(extension, 'Contents', 'Info.plist'),
    executable: join(extension, 'Contents', 'MacOS', cameraExtensionExecutableName(identifiers)),
    appProfile: join(appRoot, 'Contents', 'embedded.provisionprofile')
  }
}

export function cameraExtensionForbiddenPaths(appRoot, identifiers) {
  const { extension } = cameraExtensionPaths(appRoot, identifiers)
  return { extensionProfile: join(extension, 'Contents', 'embedded.provisionprofile') }
}

/** Pure (IO injected). Which of the camera files exist, and which forbidden ones do. */
export function cameraExtensionLayout(appRoot, { identifiers, exists }) {
  const paths = cameraExtensionPaths(appRoot, identifiers)
  const forbidden = cameraExtensionForbiddenPaths(appRoot, identifiers)
  return {
    paths,
    forbidden,
    present: Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, exists(path)])),
    stray: Object.fromEntries(Object.entries(forbidden).map(([key, path]) => [key, exists(path)]))
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
  appProfile: "the app's embedded.provisionprofile"
}

/**
 * Pure. One line per problem. A Developer ID build must carry everything
 * (a release without plan 214's app profile is red here, by design); any
 * other build must carry nothing or everything, never half; and no build may
 * carry a profile inside the extension.
 */
export function cameraExtensionLayoutProblems(layout, { identifiers, signature }) {
  const problems = []
  if (layout.stray?.extensionProfile) {
    problems.push(
      `Videorc Camera: the extension carries an embedded.provisionprofile (${relativeToApp(layout.forbidden.extensionProfile, layout.paths.appProfile)}). The extension embeds no profile (plan 214 P0a); rebuild it with pnpm build:camera-extension.`
    )
  }
  const missing = Object.entries(layout.present)
    .filter(([, present]) => !present)
    .map(([key]) => key)
  const developerId = isDeveloperIdBuild(signature, identifiers)
  if (developerId) {
    for (const key of missing) {
      problems.push(
        `Videorc Camera: ${LABELS[key]} is missing (${relativeToApp(layout.paths[key], layout.paths.appProfile)}). A Developer ID build must embed the extension: set VIDEORC_MACOS_PROFILE_APP (plan 214) and rebuild.`
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
      'Videorc Camera: the extension is embedded in a build that is not Developer ID signed by Videorc, so it can never activate. Sign the build or drop the profile.'
    )
  }
  return problems
}

function relativeToApp(path, appProfilePath) {
  const appRoot = dirname(dirname(appProfilePath))
  return path.startsWith(appRoot) ? path.slice(appRoot.length + 1) : path
}

/** Pure. Whether every required camera file is present. */
export function isCameraExtensionEmbedded(layout) {
  return Object.values(layout.present).every(Boolean)
}

/**
 * Pure. The signed shape of an embedded extension, from readings the script
 * takes with codesign and plutil (P0a facts 1 to 6):
 * - `extensionEntitlementKeys`: exactly the app sandbox and the app group;
 * - `extensionSignatureOk`: `codesign --verify --strict` passed;
 * - `packageType`: CFBundlePackageType, SYSX;
 * - `appEntitlementKeys`: the restricted key and the app group on the app;
 * - `nestedEntitlements`: [{ label, keys }] for every other executable, none
 *   of the restricted keys;
 * - `embeddedProfiles`: every embedded.provisionprofile in the bundle,
 *   relative to the app; exactly the app's own.
 */
export function cameraExtensionSignedShapeProblems(
  {
    extensionEntitlementKeys = [],
    extensionSignatureOk = true,
    packageType = null,
    appEntitlementKeys = [],
    nestedEntitlements = [],
    embeddedProfiles = []
  },
  { identifiers }
) {
  const problems = []
  for (const line of cameraExtensionEntitlementProblems(extensionEntitlementKeys, identifiers)) {
    problems.push(`Videorc Camera: ${line}`)
  }
  if (!extensionSignatureOk) {
    problems.push(
      'Videorc Camera: the extension signature does not verify (codesign --verify --strict).'
    )
  }
  if (packageType !== 'SYSX') {
    problems.push(
      `Videorc Camera: the extension's CFBundlePackageType is ${JSON.stringify(packageType)}, expected SYSX.`
    )
  }
  const keys = identifiers.entitlements
  for (const key of [keys.systemExtensionInstall, keys.applicationGroups]) {
    if (!appEntitlementKeys.includes(key)) {
      problems.push(
        `Videorc Camera: the app is signed without ${key}; the extension cannot activate.`
      )
    }
  }
  const restricted = restrictedCameraEntitlementKeys(identifiers)
  for (const { label, keys: nestedKeys } of nestedEntitlements) {
    const carried = restricted.filter((key) => (nestedKeys ?? []).includes(key))
    if (carried.length > 0) {
      problems.push(
        `Videorc Camera: ${label} carries ${carried.join(', ')}; a binary without a profile dies at exec with any of these. Only the main executable may carry them.`
      )
    }
  }
  const expectedProfiles = ['Contents/embedded.provisionprofile']
  if (embeddedProfiles.length !== 1 || embeddedProfiles[0] !== expectedProfiles[0]) {
    problems.push(
      `Videorc Camera: expected exactly one embedded profile at ${expectedProfiles[0]}, found ${embeddedProfiles.length === 0 ? 'none' : embeddedProfiles.join(', ')}.`
    )
  }
  return problems
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
    ? 'absent (Developer ID build without the Videorc Camera profile)'
    : signature.signed
      ? 'absent (ad hoc or non-Videorc signature)'
      : 'absent (unsigned build)'
}
