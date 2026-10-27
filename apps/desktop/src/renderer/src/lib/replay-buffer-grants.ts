import type { MediaAccessSnapshot } from '@/lib/backend'
import { layoutPresetNeedsScreen, type CaptureConfig } from '@/lib/capture'

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

export function replayStartWaitsForScreen({
  sources,
  layout
}: {
  sources: Pick<CaptureConfig['sources'], 'screenId' | 'windowId' | 'captureOff' | 'testPattern'>
  layout: Pick<CaptureConfig['layout'], 'layoutPreset' | 'arrangementMode'>
}): string | null {
  if (layout.arrangementMode === 'freeform') return null
  if (!layoutPresetNeedsScreen(layout.layoutPreset)) return null
  if (sources.captureOff === true) return null
  if (sources.screenId || sources.windowId || sources.testPattern) return null
  return REPLAY_WAITS_FOR_SCREEN
}
