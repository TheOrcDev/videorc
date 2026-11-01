// Plan 179. The live lab runs on two kinds of machine: the macOS lab Mac
// (plan 178) and a Linux box (ogre). Everything that differs between them is
// chosen from labPlatform(); every caller takes `platform` as an argument
// (default process.platform) so the tests pin it and never depend on the host
// that runs them (CI runs the scripts tests on Linux).

export const MACOS = 'macos'
export const LINUX = 'linux'
export const LAB_PLATFORMS = Object.freeze([MACOS, LINUX])

/** 'macos', 'linux', or null for a machine the lab does not run on. */
export function labPlatform(platform = process.platform) {
  if (platform === 'darwin') return MACOS
  if (platform === 'linux') return LINUX
  return null
}

/** labPlatform(), or a clear error naming the command that refused. */
export function requireLabPlatform(platform = process.platform, what = 'The live lab') {
  const lab = labPlatform(platform)
  if (!lab) throw new Error(`${what} runs on macOS or Linux only (this is ${platform}).`)
  return lab
}

export function isLinux(platform = process.platform) {
  return labPlatform(platform) === LINUX
}

// The owner's root-owned folder on Linux: policy.json and nothing the lab
// user can write. The macOS twin is /Library/Application Support/VideorcLab.
export const LINUX_LAB_ETC = '/etc/videorc-lab'
