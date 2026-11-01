// Which password store Chromium's safeStorage uses on Linux.
//
// Chromium picks a real store only for desktops it recognizes. It reads
// XDG_CURRENT_DESKTOP (colon-separated, first known value wins), then
// DESKTOP_SESSION, GNOME_DESKTOP_SESSION_ID and KDE_FULL_SESSION
// (base::nix::GetDesktopEnvironment), and maps KDE to KWallet and GNOME,
// Unity, Cinnamon, Deepin, Pantheon, UKUI, XFCE and COSMIC to libsecret
// (os_crypt::SelectBackend, Chromium 142 / Electron 39). Everything else —
// Hyprland, Sway, i3, LXQt — gets basic_text, so safeStorage reports
// encryption unavailable and SecurePersistenceCodec refuses: the Recordings
// folder picker, sign-in and provider OAuth all fail there, even with
// gnome-keyring or KeePassXC answering org.freedesktop.secrets.
//
// For those desktops Videorc asks for libsecret explicitly. This never makes
// things worse: when libsecret cannot initialise (no Secret Service on the
// bus), Chromium logs "OSCrypt tried Libsecret but couldn't initialise." and
// falls back to the same basic_text store it would have picked anyway
// (KeyStorageLinux::CreateServiceInternal).

export const PASSWORD_STORE_SWITCH = 'password-store'
export const LIBSECRET_PASSWORD_STORE = 'gnome-libsecret'

/** XDG_CURRENT_DESKTOP values Chromium maps to KWallet or libsecret. */
const KNOWN_XDG_DESKTOPS = new Set([
  'Unity',
  'Deepin',
  'GNOME',
  'X-Cinnamon',
  'KDE',
  'Pantheon',
  'XFCE',
  'UKUI',
  'COSMIC'
])

type DesktopEnv = Partial<
  Record<
    | 'XDG_CURRENT_DESKTOP'
    | 'DESKTOP_SESSION'
    | 'GNOME_DESKTOP_SESSION_ID'
    | 'KDE_FULL_SESSION'
    | 'KDE_SESSION_VERSION',
    string | undefined
  >
>

/**
 * True when Chromium already picks KWallet or libsecret for this session.
 * Mirrors GetDesktopEnvironment + SelectBackend; LXQt and KDE3 are known to
 * Chromium but still get basic_text, so they count as unmapped.
 */
export function chromiumMapsPasswordStore(env: DesktopEnv): boolean {
  const xdg = env.XDG_CURRENT_DESKTOP
  if (xdg !== undefined) {
    for (const value of xdg.split(':').map((entry) => entry.trim())) {
      if (!value) continue
      if (KNOWN_XDG_DESKTOPS.has(value)) return true
      // Chromium stops at the first value it knows, even when it maps to basic_text.
      if (value === 'LXQt') return false
    }
  }
  const session = env.DESKTOP_SESSION ?? ''
  if (['deepin', 'gnome', 'mate', 'kde4', 'kde-plasma', 'xubuntu', 'ukui'].includes(session)) {
    return true
  }
  if (session.includes('xfce')) return true
  // DESKTOP_SESSION=kde is KDE4 (KWallet) with KDE_SESSION_VERSION, else KDE3.
  if (session === 'kde') return env.KDE_SESSION_VERSION !== undefined
  if (env.GNOME_DESKTOP_SESSION_ID !== undefined) return true
  if (env.KDE_FULL_SESSION !== undefined) return env.KDE_SESSION_VERSION !== undefined
  return false
}

/**
 * The `password-store` value to append before app ready, or null to leave
 * Chromium's choice alone: off Linux, when the user passed the switch, or
 * when Chromium already maps this desktop to a real store.
 */
export function linuxPasswordStoreSwitch(
  platform: NodeJS.Platform,
  env: DesktopEnv,
  userPassedSwitch: boolean
): string | null {
  if (platform !== 'linux' || userPassedSwitch) return null
  return chromiumMapsPasswordStore(env) ? null : LIBSECRET_PASSWORD_STORE
}
