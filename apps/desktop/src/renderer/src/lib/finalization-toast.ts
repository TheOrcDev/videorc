import { revealInFileManagerLabel } from '@/lib/platform'
import { toast } from '@/lib/toast'

// Plan 174 S2.4 (J2-13): the MP4 export's toasts, one id per recording and
// one wording each, whether the export ran after Stop or from Library's
// "Export MP4". The ready toast always keeps its reveal action.
//
// Each state replaces the last one in place, and sonner merges an update into
// the toast it replaces: a field a state does not use is cleared explicitly.

export function finalizationToastId(sessionId: string): string {
  return `finalization-${sessionId}`
}

export function showMp4Finalizing(sessionId: string, label: string): void {
  toast.loading(label, {
    id: finalizationToastId(sessionId),
    duration: Infinity,
    description: 'Your recording is safe. Long recordings can take several minutes to save as MP4.',
    action: undefined
  })
}

export function showMp4Ready(sessionId: string): void {
  toast.success('MP4 ready', {
    id: finalizationToastId(sessionId),
    duration: 15_000,
    description: undefined,
    action: {
      label: revealInFileManagerLabel(),
      onClick: () => void window.videorc?.revealSession(sessionId)
    }
  })
}

export function showMp4ExportFailed(
  sessionId: string,
  retry: () => void,
  reason: string | undefined
): void {
  if (reason) console.warn('[finalization] MP4 export failed:', reason)
  toast.error('MP4 export failed', {
    id: finalizationToastId(sessionId),
    duration: Infinity,
    description: 'Your original recording is safe.',
    action: { label: 'Retry export', onClick: retry }
  })
}
