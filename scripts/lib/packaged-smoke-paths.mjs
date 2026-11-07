import { dirname, resolve } from 'node:path'

// electron-builder `linux.executableName`.
const LINUX_EXECUTABLE_NAME = 'videorc'

export function defaultPackagedAppExecutable({ repoRoot, platform = process.platform } = {}) {
  if (!repoRoot) {
    throw new Error('repoRoot is required.')
  }
  if (platform === 'darwin') {
    return resolve(repoRoot, 'apps/desktop/release/mac-arm64/Videorc.app/Contents/MacOS/Videorc')
  }
  if (platform === 'win32') {
    return resolve(repoRoot, 'apps/desktop/release/win-unpacked/Videorc.exe')
  }
  if (platform === 'linux') {
    // The unpacked dir target (electron-builder `linux.executableName`); the
    // AppImage wraps the same payload and is exercised through
    // VIDEORC_PACKAGED_APP_EXECUTABLE=<path>.AppImage (Plan 0008).
    return resolve(repoRoot, 'apps/desktop/release/linux-unpacked', LINUX_EXECUTABLE_NAME)
  }
  throw new Error(`Packaged app smoke test does not support ${platform}.`)
}

export function bundledFfmpegPathForPackagedApp({ appExecutable, platform = process.platform } = {}) {
  if (!appExecutable) {
    throw new Error('appExecutable is required.')
  }
  if (platform === 'darwin') {
    return resolve(dirname(appExecutable), '..', 'Resources', 'ffmpeg', 'bin', 'ffmpeg')
  }
  if (platform === 'win32') {
    return resolve(dirname(appExecutable), 'resources', 'ffmpeg', 'bin', 'ffmpeg.exe')
  }
  if (platform === 'linux') {
    return resolve(dirname(appExecutable), 'resources', 'ffmpeg', 'bin', 'ffmpeg')
  }
  throw new Error(`Packaged app smoke test does not support ${platform}.`)
}

/**
 * An AppImage mounts itself under a private squashfs root at run time, so the
 * bundled FFmpeg cannot be located beside the executable path the smoke was
 * given. The smoke then reads the bundled path from the app's own
 * `[smoke] backend-ready` evidence instead; this only says whether that is
 * the situation.
 */
export function isLinuxAppImageExecutable(appExecutable, platform = process.platform) {
  return platform === 'linux' && /\.AppImage$/i.test(String(appExecutable ?? ''))
}

/**
 * What `check:packaged-app` reads from an AppImage. The Electron binary (its
 * fuse wire) and `app.asar` (the build flags) sit inside the squashfs, where
 * the fuse sentinel cannot be found; the AppImage runtime's
 * `--appimage-extract <member>` writes each member under `squashfs-root` in
 * its working directory without starting the app.
 */
export function linuxAppImageCheckPayload(extractDirectory) {
  return {
    members: [LINUX_EXECUTABLE_NAME, 'resources/app.asar'],
    executable: resolve(extractDirectory, 'squashfs-root', LINUX_EXECUTABLE_NAME)
  }
}

/**
 * The `launchDevApp` options that run a packaged build instead of the dev app,
 * or none when no executable is given. A packaged build serves the smoke
 * command server only to the holder of this per-launch capability, and still
 * refuses the dev-only commands (`authorize-smoke-resource`, `eval-js`), so a
 * smoke that records lets the isolated profile pick the recordings folder.
 */
export function packagedSmokeLaunchOptions({ appExecutable, capability } = {}) {
  if (!appExecutable) return { env: {} }
  if (!capability) {
    throw new Error('capability is required with appExecutable.')
  }
  return {
    env: {
      VIDEORC_SMOKE_PACKAGED_APP: '1',
      VIDEORC_PACKAGED_SMOKE_TEST: '1',
      VIDEORC_SMOKE_COMMAND_CAPABILITY: capability,
      VIDEORC_SMOKE_PRINT_BACKEND_READY: '1'
    },
    packagedSmokeCommandCapability: capability,
    spawnSpec: { command: resolve(appExecutable), args: [] }
  }
}

export function assertPackagedSmokePlatform(platform = process.platform) {
  if (platform !== 'darwin' && platform !== 'win32' && platform !== 'linux') {
    throw new Error(
      `Packaged app smoke test supports macOS, Windows and Linux only, not ${platform}.`
    )
  }
}
