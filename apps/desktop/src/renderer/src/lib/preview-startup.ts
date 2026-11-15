// Plan 238 S2: the sources the startup card waits for, read from the capture
// choice and the live preview statuses. The steps and their words live in
// shared/preview-startup.ts, so main's floating-window hint says the same.

import type { PreviewCameraStatus, PreviewScreenStatus, SourceSelection } from '@/lib/backend'
import type { PreviewStartupSource } from '../../../shared/preview-startup'

const BLOCKED_SCREEN_STATES: ReadonlySet<PreviewScreenStatus['state']> = new Set([
  'permission-needed',
  'source-missing',
  'failed'
])

const BLOCKED_CAMERA_STATES: ReadonlySet<PreviewCameraStatus['state']> = new Set([
  'permission-needed',
  'device-missing',
  'failed'
])

/**
 * The screen (or window) and camera the scene uses, each with the name the
 * Studio's Sources rows show and whether it has sent a picture. The test
 * pattern needs no device, so it is never waited for.
 */
export function previewStartupSources(
  sources: SourceSelection,
  screenStatus: Pick<PreviewScreenStatus, 'state'> | undefined,
  cameraStatus: Pick<PreviewCameraStatus, 'state' | 'noVideo'> | undefined
): PreviewStartupSource[] {
  const result: PreviewStartupSource[] = []
  const screenChosen = Boolean(
    sources.screenId || sources.windowId || sources.wantedScreenId || sources.wantedWindowId
  )
  if (screenChosen && !sources.testPattern && !sources.captureOff) {
    result.push({
      kind: 'screen',
      name:
        sources.screenName ??
        sources.windowName ??
        sources.wantedWindowName ??
        sources.wantedScreenName ??
        null,
      live: screenStatus?.state === 'live',
      blocked: screenStatus ? BLOCKED_SCREEN_STATES.has(screenStatus.state) : false
    })
  }
  if ((sources.cameraId || sources.wantedCameraId) && !sources.cameraOff) {
    result.push({
      kind: 'camera',
      name: sources.cameraName ?? sources.wantedCameraName ?? null,
      live: cameraStatus?.state === 'live' && cameraStatus.noVideo !== true,
      blocked: cameraStatus ? BLOCKED_CAMERA_STATES.has(cameraStatus.state) : false
    })
  }
  return result
}
