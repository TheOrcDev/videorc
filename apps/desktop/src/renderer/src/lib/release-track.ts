import { isWindowsPlatform } from '@/lib/platform'

/**
 * The release track a build belongs to, shown next to the version in
 * Settings → About: macOS ships as a Beta and Windows as an Alpha. An
 * unpackaged build is a development build whatever its package version says.
 */
export function releaseTrackLabel(platform: string | undefined, isPackaged: boolean): string {
  if (!isPackaged) return 'Development'
  return isWindowsPlatform(platform) ? 'Alpha' : 'Beta'
}
