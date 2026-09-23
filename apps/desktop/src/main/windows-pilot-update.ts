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

// Signed-in pilot access. While Windows is in pilot, /account/download hands
// every signed-in user the pilot installer, so a signed-in install follows the
// pilot feed too. The backend exchanges the account session for a short-lived
// token that reads only this feed; the session never reaches main.

export type WindowsPilotUpdateGrant = { token: string; expiresAt: string }

export type PublicFeedOutcome = 'available' | 'not-available' | 'missing-feed' | 'failed'

const ACCOUNT_PILOT_TOKEN_PATTERN = /^wpu1\.[\x21-\x7e]{1,507}$/

export function isWindowsPilotUpdateGrant(value: unknown): value is WindowsPilotUpdateGrant {
  if (!value || typeof value !== 'object') return false
  const { token, expiresAt } = value as Record<string, unknown>
  return (
    typeof token === 'string' &&
    ACCOUNT_PILOT_TOKEN_PATTERN.test(token) &&
    typeof expiresAt === 'string'
  )
}

export function accountPilotUpdaterConfig(
  grant: WindowsPilotUpdateGrant
): WindowsPilotUpdaterConfig {
  return {
    disableDifferentialDownload: true,
    requestHeaders: { Authorization: `Bearer ${grant.token}` },
    url: WINDOWS_PILOT_UPDATE_URL
  }
}

// The public feed always wins when it has something newer; the pilot feed is
// only consulted when public has nothing for this install (no feed yet, or
// already up to date with it). The pilot pointer can trail public after a
// promotion, so it is never the only feed checked. A transport failure is not
// a reason to probe: the check reports it as-is.
export function shouldProbeAccountPilotFeed(input: {
  operatorPilot: boolean
  platform: NodeJS.Platform
  publicOutcome: PublicFeedOutcome
}): boolean {
  return (
    input.platform === 'win32' &&
    !input.operatorPilot &&
    (input.publicOutcome === 'missing-feed' || input.publicOutcome === 'not-available')
  )
}
