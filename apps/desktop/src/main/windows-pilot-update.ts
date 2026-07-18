export const WINDOWS_PILOT_UPDATE_URL = 'https://www.videorc.com/api/updates/windows-pilot/'

export type WindowsPilotUpdaterConfig = {
  disableDifferentialDownload: true
  requestHeaders: { Authorization: string }
  url: string
}

export type WindowsUpdaterStartupConfig = {
  backgroundUpdatesDisabled: boolean
  pilot: WindowsPilotUpdaterConfig | null
}

export function consumeWindowsUpdaterStartupConfig(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform
): WindowsUpdaterStartupConfig {
  try {
    return {
      backgroundUpdatesDisabled: env.VIDEORC_DISABLE_AUTO_UPDATE === '1',
      pilot: getWindowsPilotUpdaterConfig(env, platform)
    }
  } finally {
    // The configured updater owns the only required in-memory copy. Never
    // expose the bearer to the backend, helpers, renderer, FFmpeg, or support
    // bundles—even when background checks are disabled or config is invalid.
    delete env.VIDEORC_WINDOWS_PILOT_UPDATE_TOKEN
  }
}

export function getWindowsPilotUpdaterConfig(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform
): WindowsPilotUpdaterConfig | null {
  const mode = env.VIDEORC_WINDOWS_PILOT_UPDATE?.trim()
  if (!mode) return null
  if (mode !== '1') {
    throw new Error('VIDEORC_WINDOWS_PILOT_UPDATE must be 1 when configured.')
  }
  if (platform !== 'win32') {
    throw new Error('The pilot updater override is Windows-only.')
  }
  const token = env.VIDEORC_WINDOWS_PILOT_UPDATE_TOKEN?.trim() ?? ''
  if (!/^[\x21-\x7e]{32,256}$/.test(token)) {
    throw new Error(
      'VIDEORC_WINDOWS_PILOT_UPDATE_TOKEN must contain 32-256 visible ASCII characters.'
    )
  }
  return {
    disableDifferentialDownload: true,
    requestHeaders: { Authorization: `Bearer ${token}` },
    url: WINDOWS_PILOT_UPDATE_URL
  }
}
