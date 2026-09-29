// In-app "What's new": pulls the published changelog from videorc-web
// (/api/changelog, fed by videorc changelog/ on each release) and decides
// when the post-update dialog should appear.

export { WHATS_NEW_STORAGE_KEY } from './whats-new-storage'

export const CHANGELOG_PLATFORMS = ['macos', 'windows', 'linux'] as const

export type ChangelogPlatform = (typeof CHANGELOG_PLATFORMS)[number]

export interface ChangelogEntry {
  version: string
  date: string
  channel: string
  platforms: ChangelogPlatform[]
  title: string
  summary: string
  highlights: string[]
}

// What the startup check should do given the running app version and the
// persisted last-seen version. 'initialize' = first run with this feature:
// remember the current version silently (never greet existing state with a
// backlog of releases); 'check' = we updated since last seen, ask the API.
export function resolveWhatsNewAction({
  version,
  lastSeen
}: {
  version: string | undefined
  lastSeen: string | null
}): 'idle' | 'initialize' | 'check' {
  if (!version) {
    return 'idle'
  }
  if (lastSeen === null) {
    return 'initialize'
  }
  return lastSeen === version ? 'idle' : 'check'
}

export function changelogPlatformForRuntime(
  runtimePlatform: string | undefined
): ChangelogPlatform | null {
  if (runtimePlatform === 'darwin') {
    return 'macos'
  }
  if (runtimePlatform === 'win32') {
    return 'windows'
  }
  if (runtimePlatform === 'linux') {
    return 'linux'
  }
  return null
}

export function filterChangelogEntriesByPlatform(
  entries: ChangelogEntry[],
  platform: ChangelogPlatform
): ChangelogEntry[] {
  return entries.filter((entry) => entry.platforms.includes(platform))
}

// "0.9.2-beta.1" -> "0.9.2 Beta 1", for the dialog title.
export function formatChangelogVersion(version: string): string {
  const [core = '', preRelease] = version.split('-')
  if (!preRelease) {
    return core
  }
  const [tag = '', number] = preRelease.split('.')
  const capitalized = tag.charAt(0).toUpperCase() + tag.slice(1)
  return number ? `${core} ${capitalized} ${number}` : `${core} ${capitalized}`
}
