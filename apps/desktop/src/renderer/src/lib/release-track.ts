import { isWindowsPlatform } from '@/lib/platform'

/**
 * The release track a build belongs to, shown next to the version in
 * Settings → About. Linux's channel is frozen at build time; old/default
 * builds remain Alpha. An unpackaged build always says Development.
 */
declare const __VIDEORC_LINUX_RELEASE_CHANNEL__: 'alpha' | 'beta'

const linuxBuildChannel =
  typeof __VIDEORC_LINUX_RELEASE_CHANNEL__ === 'undefined'
    ? 'alpha'
    : __VIDEORC_LINUX_RELEASE_CHANNEL__

export function releaseTrackLabel(
  platform: string | undefined,
  isPackaged: boolean,
  linuxChannel: 'alpha' | 'beta' = linuxBuildChannel
): string {
  if (!isPackaged) return 'Development'
  if (platform === 'linux') return linuxChannel === 'beta' ? 'Beta' : 'Alpha'
  return isWindowsPlatform(platform) ? 'Alpha' : 'Beta'
}
