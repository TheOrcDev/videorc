// Release-note checks start after runtime discovery, outside the first paint.
import { toast } from 'sonner'
import {
  changelogPlatformForRuntime,
  resolveWhatsNewAction,
  type ChangelogEntry
} from './whats-new'
import { fetchChangelogEntries } from './whats-new-fetch'
import { WHATS_NEW_STORAGE_KEY } from './whats-new-storage'

type ShowEntry = (entry: ChangelogEntry) => void

export async function checkWhatsNew(
  version: string | undefined,
  runtimePlatform: string | undefined,
  cancelled: () => boolean,
  show: ShowEntry
): Promise<void> {
  const lastSeen = localStorage.getItem(WHATS_NEW_STORAGE_KEY)
  const action = resolveWhatsNewAction({ version, lastSeen })
  if (cancelled() || action === 'idle' || !version) return
  if (action === 'initialize') {
    localStorage.setItem(WHATS_NEW_STORAGE_KEY, version)
    return
  }
  const platform = changelogPlatformForRuntime(runtimePlatform)
  if (!platform) return
  const entries = await fetchChangelogEntries({ platform, since: lastSeen ?? undefined })
  if (cancelled() || entries === null) return
  if (entries.length === 0) localStorage.setItem(WHATS_NEW_STORAGE_KEY, version)
  else show(entries[0])
}

export async function showLatestWhatsNew(
  runtimePlatform: string | undefined,
  show: ShowEntry
): Promise<void> {
  const platform = changelogPlatformForRuntime(runtimePlatform)
  const entries = platform ? await fetchChangelogEntries({ platform }) : null
  if (!entries?.length) toast.info('Release notes are not available right now.')
  else show(entries[0])
}
