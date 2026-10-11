import type { StreamPlatform } from './backend'
import { appPlatform, osSettingsName } from './platform'

// Plan 174 S1.4. Two kinds of platform, one module:
// - platformLabel (D-36): one name per streaming platform, replacing five
//   private maps ("X", never "X / Twitter"; "Custom RTMP", never "Custom").
// - platformCopy (I-9, C-30): copy that names the computer Videorc runs on.
//   A Windows PC was told about "this Mac", "~/Movies/…" and "macOS".

const PLATFORM_LABELS: Readonly<Record<StreamPlatform, string>> = {
  youtube: 'YouTube',
  twitch: 'Twitch',
  kick: 'Kick',
  x: 'X',
  tiktok: 'TikTok',
  instagram: 'Instagram',
  custom: 'Custom RTMP'
}

/** The streaming platform's name: "YouTube", "X", "Custom RTMP". */
export function platformLabel(platform: StreamPlatform): string {
  return PLATFORM_LABELS[platform] ?? platform
}

export interface PlatformCopy {
  /** What to call the computer: "Mac", "PC" or "computer". */
  deviceNoun: 'Mac' | 'PC' | 'computer'
  /** The OS settings app: "System Settings", "Windows Settings". */
  osSettingsName: string
  /** The OS by name, for "macOS asks once" style copy. */
  osName: 'macOS' | 'Windows' | 'Linux'
  /**
   * Where recordings go when no folder is chosen. Mirrors the backend's
   * `default_recordings_dir` (Movies on macOS and Linux, Videos on Windows);
   * the backend does not report the path yet.
   */
  defaultRecordingsPath: string
}

/**
 * Who shows that the microphone is open: "macOS shows its microphone
 * indicator" on a Mac, Windows its own, and only a maybe elsewhere.
 */
export function microphoneIndicatorCopy(platform: string | undefined): string {
  switch (appPlatform(platform)) {
    case 'darwin':
      return 'macOS shows its microphone indicator'
    case 'win32':
      return 'Windows shows its microphone indicator'
    default:
      return 'Your system may show a microphone indicator'
  }
}

export function platformCopy(platform: string | undefined): PlatformCopy {
  switch (appPlatform(platform)) {
    case 'darwin':
      return {
        deviceNoun: 'Mac',
        osSettingsName: osSettingsName(platform),
        osName: 'macOS',
        defaultRecordingsPath: '~/Movies/Videorc/Recordings'
      }
    case 'win32':
      return {
        deviceNoun: 'PC',
        osSettingsName: osSettingsName(platform),
        osName: 'Windows',
        defaultRecordingsPath: 'Videos\\Videorc\\Recordings in your user folder'
      }
    default:
      return {
        deviceNoun: 'computer',
        osSettingsName: osSettingsName(platform),
        osName: 'Linux',
        defaultRecordingsPath: '~/Movies/Videorc/Recordings'
      }
  }
}
