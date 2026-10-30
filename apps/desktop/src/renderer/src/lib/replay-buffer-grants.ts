import type { MediaAccessSnapshot, PreviewScreenStatus } from '@/lib/backend'
import {
  isPortalScreenSourceId,
  isPortalWindowSourceId,
  layoutPresetNeedsScreen,
  type CaptureConfig
} from '@/lib/capture'
import { SCREEN_SHARE_DIALOG_PENDING_MESSAGE } from '@/lib/source-status'

/**
 * Clips arm at launch (plan 199), and a buffer-only session opens the same
 * devices a recording does. On a never-asked Mac that raised the OS prompts
 * cold, before Videorc had explained anything (plan 203 S2). The ring waits
 * while any device the scene uses has a grant macOS has not asked for yet,
 * or while the exact snapshot has not loaded; a denied grant is not waited
 * for (the start fails as it always did, and the Output page says why).
 */
// A smoke's synthetic device (`camera:synthetic-preview-smoke`) never touches
// the OS, so it never waits for a grant.
function needsGrant(id: string | undefined): boolean {
  return Boolean(id) && !id?.includes(':synthetic')
}

export function replayStartWaitsForGrant({
  mediaAccess,
  sources,
  layoutPreset
}: {
  mediaAccess: Pick<MediaAccessSnapshot, 'camera' | 'microphone' | 'screen'> | null | undefined
  sources: Pick<
    CaptureConfig['sources'],
    | 'screenId'
    | 'windowId'
    | 'captureOff'
    | 'cameraId'
    | 'cameraOff'
    | 'microphoneId'
    | 'microphoneOff'
  >
  layoutPreset: string
}): string | null {
  const usesScreen = sources.captureOff !== true && needsGrant(sources.screenId ?? sources.windowId)
  const usesCamera =
    sources.cameraOff !== true && needsGrant(sources.cameraId) && layoutPreset !== 'screen-only'
  const usesMicrophone = sources.microphoneOff !== true && needsGrant(sources.microphoneId)
  if (!usesScreen && !usesCamera && !usesMicrophone) return null
  if (!mediaAccess) return 'Waiting for the permission state.'
  if (usesScreen && mediaAccess.screen === 'not-determined') {
    return 'Screen Recording has not been allowed yet.'
  }
  if (usesCamera && mediaAccess.camera === 'not-determined') {
    return 'Camera access has not been allowed yet.'
  }
  if (usesMicrophone && mediaAccess.microphone === 'not-determined') {
    return 'Microphone access has not been allowed yet.'
  }
  return null
}

/**
 * Plan 207 S2: the default layout shows a screen, and a fresh profile with
 * no Screen Recording grant chooses none. The backend still adds a visible
 * Screen source with no device, so a start is refused ("the screen preview
 * source(s) produced no frames") three times, then the ring gives up with a
 * toast. A scene whose layout needs a screen that nobody has chosen waits
 * the way it waits for a grant: no attempt, no retry, no toast. Screen set to
 * None on purpose is `recordBlockedReason`'s (sceneSourceOffBlockedReason);
 * a chosen screen that produces no frames is a real failure and still fails
 * as today; Freeform shows only what it has; a test pattern stands in for
 * the screen (the smokes' synthetic source).
 */
export const REPLAY_WAITS_FOR_SCREEN =
  'No screen is chosen. Choose one in Sources to use this scene.'

/**
 * Linux: the portal's placeholder id (`screen:portal:monitor`,
 * `window:portal:window`) is a KIND of source, not a screen anyone picked;
 * the desktop portal's share dialog does the picking. A fresh profile
 * carries the placeholder from the first device list, and a profile that
 * shared before restores its share silently at launch, after the ring may
 * already have tried. Either way the share is not there yet, so the ring
 * waits until this run's portal share is granted (the preview reports it)
 * and never opens the dialog itself. A granted share with no picture is a
 * real failure and still fails as today.
 */
export const REPLAY_WAITS_FOR_PORTAL_SHARE =
  'No screen is shared yet. Choose one in Sources to use this scene.'

/**
 * A chosen screen whose preview has not started for any source yet: the
 * backend's idle status (never started, or stopped) names no source. Closing
 * first-run setup starts the preview half a second later and arms the ring
 * at once; a start then waited behind the barrier for frames the queued
 * preview start could not give, was refused ("the screen preview source(s)
 * produced no frames") and opened the microphone twice. The ring waits for
 * the preview the way it waits for setup. Only where the app starts that
 * preview itself (`previewStarts`); once the preview names the source, a
 * chosen screen without frames still fails as today.
 */
export const REPLAY_WAITS_FOR_PREVIEW = 'Waiting for the screen preview to start.'
export const REPLAY_WAITS_FOR_SHARE_DIALOG =
  'Waiting for you to choose a screen in the share dialog.'

/**
 * The Starting message the backend publishes once the portal grants a share
 * (`ScreenStartupPhase::AwaitingFirstFrame` in preview_screen.rs).
 */
export const SCREEN_SHARE_GRANTED_MESSAGE = 'Screen share granted. Waiting for its first frame.'

function isPortalSourceId(sourceId: string | undefined): boolean {
  return isPortalScreenSourceId(sourceId) || isPortalWindowSourceId(sourceId)
}

/**
 * The portal source whose share this run granted, after one screen preview
 * status. A grant (first frame, or the granted phase) sets it; a new share
 * dialog, a cancelled or abandoned one clears it, so the ring waits for the
 * person again. Anything else (idle, revoked, failed) keeps it: a chosen
 * share that stops producing frames is a real failure.
 */
export function nextPortalShareGrant(
  current: string | null,
  status: Pick<PreviewScreenStatus, 'state' | 'sourceId' | 'message' | 'framesCaptured'>
): string | null {
  const sourceId = status.sourceId
  if (!sourceId || !isPortalSourceId(sourceId)) return current
  if (
    status.state === 'live' ||
    status.framesCaptured > 0 ||
    (status.state === 'starting' && status.message === SCREEN_SHARE_GRANTED_MESSAGE)
  ) {
    return sourceId
  }
  if (
    status.state === 'permission-needed' ||
    (status.state === 'starting' && status.message === SCREEN_SHARE_DIALOG_PENDING_MESSAGE)
  ) {
    return current === sourceId ? null : current
  }
  return current
}

export function replayStartWaitsForScreen({
  sources,
  layout,
  portalShareGrantedSourceId = null,
  previewScreen,
  previewStarts = false
}: {
  sources: Pick<CaptureConfig['sources'], 'screenId' | 'windowId' | 'captureOff' | 'testPattern'>
  layout: Pick<CaptureConfig['layout'], 'layoutPreset' | 'arrangementMode'>
  /** `nextPortalShareGrant`'s latch. */
  portalShareGrantedSourceId?: string | null
  previewScreen?: Pick<PreviewScreenStatus, 'state' | 'message' | 'sourceId'>
  /** The app starts the screen preview itself (no smoke or auto-preview opt-out). */
  previewStarts?: boolean
}): string | null {
  if (layout.arrangementMode === 'freeform') return null
  if (!layoutPresetNeedsScreen(layout.layoutPreset)) return null
  if (sources.captureOff === true) return null
  if (sources.testPattern) return null
  const sourceId = sources.windowId ?? sources.screenId
  if (!sourceId) return REPLAY_WAITS_FOR_SCREEN
  if (isPortalSourceId(sourceId) && portalShareGrantedSourceId !== sourceId) {
    return previewScreen?.state === 'starting' &&
      previewScreen.message === SCREEN_SHARE_DIALOG_PENDING_MESSAGE
      ? REPLAY_WAITS_FOR_SHARE_DIALOG
      : REPLAY_WAITS_FOR_PORTAL_SHARE
  }
  if (previewStarts && previewScreen?.state === 'source-missing' && !previewScreen.sourceId) {
    return REPLAY_WAITS_FOR_PREVIEW
  }
  return null
}
