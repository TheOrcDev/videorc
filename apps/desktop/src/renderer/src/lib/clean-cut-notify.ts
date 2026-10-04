import type { CleanCutJob } from './backend'
import { openCleanCut } from './clean-cut-events'
import { cleanCutReadyTitle } from './clean-cut-view'
import { toast } from './toast'

// Plan 119 S15: "Your clean cut is ready (42:10 → 31:05)", once per job and
// cut-list revision, with Review. The render finishes out of view, which is
// what a success toast is for. Loaded lazily from use-studio on a completed
// `cleanCut.status`.

/** Job revisions already announced, newest last. */
export const CLEAN_CUT_ANNOUNCED_STORAGE_KEY = 'videorc.cleanCutAnnounced'
const ANNOUNCED_MAX = 50

const announcedInWindow = new Set<string>()

/** Tests only. */
export function resetCleanCutAnnouncements(): void {
  announcedInWindow.clear()
}

/** One toast per job id per revision: a re-render after edits is news again. */
export function cleanCutAnnouncementKey(job: Pick<CleanCutJob, 'id' | 'edlRevision'>): string {
  return `${job.id}:${job.edlRevision}`
}

function parseKeys(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((key): key is string => typeof key === 'string')
      : []
  } catch {
    return []
  }
}

function readKeys(storage: AnnouncementStorage | null): string[] {
  try {
    return parseKeys(storage?.getItem(CLEAN_CUT_ANNOUNCED_STORAGE_KEY) ?? null)
  } catch {
    return []
  }
}

interface AnnouncementStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function browserStorage(): AnnouncementStorage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

/** Shows the ready toast unless this revision was announced. True when shown. */
export function announceCleanCutReady(
  job: CleanCutJob,
  storage: AnnouncementStorage | null = browserStorage()
): boolean {
  if (job.state !== 'completed') return false
  const key = cleanCutAnnouncementKey(job)
  const stored = readKeys(storage)
  if (announcedInWindow.has(key) || stored.includes(key)) return false
  announcedInWindow.add(key)
  try {
    storage?.setItem(
      CLEAN_CUT_ANNOUNCED_STORAGE_KEY,
      JSON.stringify([...stored.filter((entry) => entry !== key), key].slice(-ANNOUNCED_MAX))
    )
  } catch {
    // The in-window set still holds.
  }
  toast.success(cleanCutReadyTitle(job), {
    id: `clean-cut-ready-${job.id}`,
    description: 'The original is kept.',
    duration: 15_000,
    action: {
      label: 'Review',
      onClick: () =>
        openCleanCut({
          sessionId: job.sourceSessionId,
          jobId: job.id,
          mode: job.mode,
          review: true
        })
    }
  })
  return true
}
