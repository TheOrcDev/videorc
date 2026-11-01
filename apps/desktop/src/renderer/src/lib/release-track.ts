import { isWindowsPlatform } from '@/lib/platform'

/**
 * The release track a build belongs to, shown next to the version in
 * Settings → About: macOS ships as a Beta, Windows and Linux as Alphas
 * (release test 146, plan 0006: Linux read "Beta"). An unpackaged build is a
 * development build whatever its package version says.
 */
export function releaseTrackLabel(platform: string | undefined, isPackaged: boolean): string {
  if (!isPackaged) return 'Development'
  return isWindowsPlatform(platform) || platform === 'linux' ? 'Alpha' : 'Beta'
}
