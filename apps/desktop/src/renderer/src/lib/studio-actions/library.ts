// The Library's own file actions for agents (plan 209 S15): `delete_recording`
// and `export_recording`. A delete is the Library's two-phase delete (the
// backend's durable tombstone, then Electron main moves the files to the
// Trash, `main/trash-paths.ts`), so it is recoverable there. An export is the
// row menu's "Export MP4" (plan 200's export options are chosen per take by
// the backend). Both wait while a capture runs, like the menu, and say why.

import type { SessionSummary } from '@/lib/backend'
import { CAPTURE_HOLD_REASON, canExportMp4 } from '@/lib/library-view'
import { trashName } from '@/lib/platform'
import {
  SEPARATE_FILE_NOTHING_TO_EXPORT,
  separateFileStopped
} from '@/lib/separate-source-recordings-view'
import { isFinalizingSession } from '@/lib/session-finalization'
import type { AgentToolExecutor } from './agent'

/** How long `export_recording` waits for a short export before answering
 * that it runs on: the Studio relay gives a tool 15 s. */
export const EXPORT_ANSWER_WAIT_MS = 10_000

export const LIBRARY_TOOL_COPY = {
  unavailable: "The Library isn't available in this Studio.",
  missingId: 'Say which recording: recordingId from list_recordings.',
  missing: "That recording isn't in the Library.",
  hold: CAPTURE_HOLD_REASON,
  finalizing: 'This recording is still exporting its MP4 in the background.',
  notExportable: "That recording has no MP4 to make: it isn't a finished recording.",
  exporting: 'Exporting the MP4 now. get_recording shows its file when it is done.'
} as const

function recordingId(args: Readonly<Record<string, unknown>>): string | undefined {
  const value = args.recordingId
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function errorText(error: unknown, fallback: string): string {
  const text = error instanceof Error ? error.message.trim() : ''
  if (/not found/i.test(text)) return LIBRARY_TOOL_COPY.missing
  return text || fallback
}

export const deleteRecording: AgentToolExecutor = async (context, args) => {
  const library = context.library
  if (!library) return { ok: false, message: LIBRARY_TOOL_COPY.unavailable }
  const id = recordingId(args)
  if (!id) return { ok: false, message: LIBRARY_TOOL_COPY.missingId }
  // The Library holds every delete while a capture runs.
  if (context.sessionActive) return { ok: false, message: LIBRARY_TOOL_COPY.hold }
  const row = library.recordings.find((session) => session.id === id)
  try {
    await library.deleteRecordings([id])
  } catch (error) {
    return { ok: false, message: errorText(error, "Videorc couldn't delete that recording.") }
  }
  const trash = trashName()
  return {
    ok: true,
    message: row
      ? `Moved "${row.title}" to the ${trash}. It can be put back from there.`
      : `Moved the recording to the ${trash}. It can be put back from there.`,
    result: { recordingId: id, trashed: true }
  }
}

/** The menu's own answer for a row it can see; null to let the backend decide. */
function exportRefusal(row: SessionSummary): string | null {
  if (isFinalizingSession(row)) return LIBRARY_TOOL_COPY.finalizing
  const stopped = separateFileStopped(row)
  if (stopped && !stopped.exportable) return SEPARATE_FILE_NOTHING_TO_EXPORT
  return canExportMp4(row) ? null : LIBRARY_TOOL_COPY.notExportable
}

export const exportRecording: AgentToolExecutor = async (context, args) => {
  const library = context.library
  if (!library) return { ok: false, message: LIBRARY_TOOL_COPY.unavailable }
  const id = recordingId(args)
  if (!id) return { ok: false, message: LIBRARY_TOOL_COPY.missingId }
  const row = library.recordings.find((session) => session.id === id)
  if (row?.mp4Path) {
    return {
      ok: true,
      message: 'That recording is already an MP4.',
      result: { recordingId: id, exported: true, path: row.mp4Path }
    }
  }
  if (context.sessionActive) return { ok: false, message: LIBRARY_TOOL_COPY.hold }
  const refusal = row ? exportRefusal(row) : null
  if (refusal) return { ok: false, message: refusal }
  // A long take keeps exporting after the answer; the Library row and
  // get_recording show its file when it lands.
  const exporting = library.exportMp4(id)
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'running'>((resolve) => {
    timer = setTimeout(() => resolve('running'), EXPORT_ANSWER_WAIT_MS)
  })
  try {
    const path = await Promise.race([exporting, timeout])
    if (path === 'running') {
      exporting.catch(() => undefined)
      return {
        ok: true,
        message: LIBRARY_TOOL_COPY.exporting,
        result: { recordingId: id, exported: false }
      }
    }
    return {
      ok: true,
      message: 'Exported the MP4.',
      result: { recordingId: id, exported: true, ...(path ? { path } : {}) }
    }
  } catch (error) {
    return { ok: false, message: errorText(error, "Videorc couldn't export that recording.") }
  } finally {
    clearTimeout(timer)
  }
}
