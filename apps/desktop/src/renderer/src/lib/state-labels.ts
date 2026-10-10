import type { PreviewCameraState, PreviewLiveState, PreviewScreenState } from '@/lib/backend'
import { statusWordFromValue } from '@/lib/status-word'

// Plan 174 S1.3: one label function per state machine, so a status chip
// shows a word ("Needs permission") and never the backend's value
// ("permission-needed"). "On air" is only ever the session's own word (D4);
// the session's labels live with the rest of its view in
// `studio-session-view.ts` and are re-exported here.

export {
  sessionStatusGlyph,
  sessionStatusLabel,
  sessionStatusPulses,
  sessionStatusTone,
  type SessionStatusGlyph,
  type SessionStatusOptions
} from '@/lib/studio-session-view'

const PREVIEW_STATE_LABELS: Record<PreviewLiveState, string> = {
  connecting: 'Connecting…',
  live: 'Running',
  reconnecting: 'Reconnecting…',
  unavailable: 'Unavailable'
}

/** Health's Preview chip: the live preview pipeline's state as a word. */
export function previewStateLabel(state: PreviewLiveState): string {
  return PREVIEW_STATE_LABELS[state] ?? statusWordFromValue(state)
}

const PREVIEW_SOURCE_STATE_LABELS: Record<PreviewCameraState | PreviewScreenState, string> = {
  starting: 'Starting…',
  // A source producing frames is "Receiving" (plan 174 D4): never "Live".
  live: 'Receiving',
  'permission-needed': 'Needs permission',
  // The preview's `device-missing` / `source-missing` is also its idle state
  // (plan 173): a connected source whose preview is not running reports it,
  // so it reads "Not running", never "Not found".
  'device-missing': 'Not running',
  'source-missing': 'Not running',
  failed: 'Failed'
}

/** Health's Camera and Screen chips: the preview source's state as a word. */
export function previewSourceStateLabel(state: PreviewCameraState | PreviewScreenState): string {
  return PREVIEW_SOURCE_STATE_LABELS[state] ?? statusWordFromValue(state)
}
