import type { PreviewScreenState } from '@/lib/backend'
import type { SourceStatus } from '@/lib/source-status'

// Linux portal share recovery (C1, retest 154). Only the lazy Sources page
// imports this, so it stays out of the eager renderer chunk.

/**
 * The Permission needed message the backend publishes when a Linux portal
 * share dialog closed without an answer (the portal crashed or restarted;
 * `PortalCaptureState::PortalLost` in linux_portal_capture.rs).
 */
export const SCREEN_SHARE_DIALOG_LOST_MESSAGE =
  'The screen share dialog closed unexpectedly. Choose your screen again.'

/**
 * The Screen row's chip for a share dialog that went away: no OS permission
 * is missing, so it must not read "Needs permission". Null otherwise, and the
 * row falls back to `videoSourceStatus`.
 */
export function screenShareLostStatus(input: {
  selected: boolean
  switching: boolean
  preview?: { state?: PreviewScreenState; message?: string }
}): SourceStatus | null {
  return input.selected &&
    !input.switching &&
    input.preview?.state === 'permission-needed' &&
    input.preview.message === SCREEN_SHARE_DIALOG_LOST_MESSAGE
    ? {
        label: 'Not shared',
        tone: 'warn',
        hint: 'The share dialog closed unexpectedly. Select Refresh to choose your screen again.'
      }
    : null
}

/**
 * Linux portal sources (`screen:portal:monitor`, `window:portal:window`) ask
 * the person through a share dialog. A selected one that is neither live nor
 * waiting on its dialog (cancelled, the dialog closed unexpectedly, the portal
 * did not answer) is asked again by Sources → Refresh: re-picking the same row
 * changes nothing, so Refresh is the way back.
 */
export function screenShareNeedsAsking(input: {
  /** The selected screen or window id. */
  selectedId: string | undefined
  state: PreviewScreenState | undefined
}): boolean {
  return (
    /^(screen|window):portal:/.test(input.selectedId ?? '') &&
    input.state !== 'live' &&
    input.state !== 'starting'
  )
}
