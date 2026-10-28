import type { RecordingStatus } from './backend'
import { sessionIsLive } from './capture-state'

export type OverlayAuxLeg = 'none' | 'stream' | 'vertical-simulcast'

export interface OverlaySessionShape {
  recordEnabled: boolean
  streamEnabled: boolean
  auxLeg: OverlayAuxLeg
}

/** The Preview shows every running output's items, or either switch at idle. */
export function programShows(
  shape: OverlaySessionShape | null,
  showOnStream: boolean,
  showInRecording: boolean
): boolean {
  if (!shape || (!shape.recordEnabled && !shape.streamEnabled)) {
    return showOnStream || showInRecording
  }
  return (shape.recordEnabled && showInRecording) || (shape.streamEnabled && showOnStream)
}

/** Clips keeps the recording plan, but its Preview follows the idle program. */
export function previewProgramShape(status: RecordingStatus): OverlaySessionShape | null {
  if (status.replayOnly || (status.state !== 'recording' && status.state !== 'streaming')) {
    return null
  }
  return {
    recordEnabled: status.state === 'recording',
    streamEnabled: sessionIsLive(status),
    auxLeg: 'none'
  }
}
