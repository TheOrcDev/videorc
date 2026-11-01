import type { DirectoryFacts } from '@/lib/backend'
import { formatBytes } from '@/lib/format'

/**
 * The Output page's "Recordings folder" row (plan 174 S3.6, I-22/I-23): the
 * folder as words, never a fake input. A recording goes to the chosen folder
 * only while Videorc holds its grant (`outputDirectoryHandle`); without one it
 * goes to the default folder, whose path the app spells the way the backend
 * resolves it (`platformCopy().defaultRecordingsPath`, S1.4).
 */
export type RecordingsFolderView = {
  /** Where recordings go: the chosen folder's name, or the default path. */
  path: string
  /** A folder was chosen, so "Use default" applies. */
  custom: boolean
  /** Free space, once Videorc has checked the chosen folder. */
  detail: string | null
  /** Why recordings can't be saved there, and the fix. */
  problem: string | null
  /** The chosen folder exists, so it can be shown in Finder. */
  canReveal: boolean
}

export const RECORDINGS_FOLDER_EXPIRED =
  'Videorc lost access to this folder. Choose it again, or use the default.'
export const RECORDINGS_FOLDER_NOT_WRITABLE =
  "Videorc can't save to this folder, so recordings would fail. Choose another folder."

export function recordingsFolderView({
  displayName,
  handle,
  facts,
  defaultPath
}: {
  displayName: string
  handle: string | undefined
  facts: DirectoryFacts | null
  defaultPath: string
}): RecordingsFolderView {
  if (!handle) {
    return { path: defaultPath, custom: false, detail: null, problem: null, canReveal: false }
  }
  const path = displayName.trim() || 'Chosen folder'
  if (!facts) return { path, custom: true, detail: null, problem: null, canReveal: false }
  if (!facts.exists) {
    return {
      path,
      custom: true,
      detail: null,
      problem: RECORDINGS_FOLDER_EXPIRED,
      canReveal: false
    }
  }
  if (!facts.writable) {
    return {
      path,
      custom: true,
      detail: null,
      problem: RECORDINGS_FOLDER_NOT_WRITABLE,
      canReveal: true
    }
  }
  return {
    path,
    custom: true,
    detail: typeof facts.freeBytes === 'number' ? `${formatBytes(facts.freeBytes)} free` : null,
    problem: null,
    canReveal: true
  }
}
