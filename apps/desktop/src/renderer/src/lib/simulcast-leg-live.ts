import type { LayoutPreset, SceneConfigParams } from '../../../shared/backend'
import type { CaptureConfig } from './capture'
import {
  coerceVideoToOrientation,
  simulcastArmed,
  simulcastLegLayout,
  simulcastLegPreset
} from './capture'

/**
 * The scene transaction that moves the vertical simulcast leg of a RUNNING
 * dual-orientation session, or null when there is nothing to send.
 *
 * Loaded lazily by the Studio hook: it is only needed mid-stream, so it stays
 * out of the initial renderer bundle. The backend lands a vertical scene
 * transaction on the leg only and registers no layout intent, so `intentId`
 * is an echo value — callers pass the current one and never bump it.
 *
 * `afterProgramSwitchTo` is the follow case: the horizontal program just
 * committed that scene, and a request is built only when the switch changes
 * the leg's paired vertical scene (camera-only and screen-only have twins).
 */
export function simulcastLegLiveRequest({
  config,
  intentId,
  background,
  protectedOverlayWindowIds,
  afterProgramSwitchTo
}: {
  config: CaptureConfig
  intentId: number
  background: SceneConfigParams['background']
  protectedOverlayWindowIds: number[]
  afterProgramSwitchTo?: LayoutPreset
}): (SceneConfigParams & { intentId: number }) | null {
  if (!simulcastArmed(config)) {
    return null
  }
  if (
    afterProgramSwitchTo !== undefined &&
    simulcastLegPreset(config) === simulcastLegPreset(config, afterProgramSwitchTo)
  ) {
    return null
  }
  return {
    intentId: Math.max(1, intentId),
    sources: config.sources,
    layout: simulcastLegLayout(config, afterProgramSwitchTo),
    video: coerceVideoToOrientation(config.video, 'vertical'),
    background,
    protectedOverlayWindowIds
  }
}
