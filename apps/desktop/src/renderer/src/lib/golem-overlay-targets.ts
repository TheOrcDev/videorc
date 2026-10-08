import type {
  CohostAvatarState,
  CohostBubbleStyle,
  OverlayItemLayout,
  OverlayRect,
  OverlayTarget
} from '@/lib/backend'
import { overlayOrientationForCanvas } from '@/lib/overlay-layout'

// Which output canvases the Golem is rasterized for (plan 164 S-C2) and the
// key that dedupes a push. Pure and asset-free, so the Studio can import it
// eagerly; the rasterizer itself (`golem-overlay.ts`) stays a lazy chunk.

export interface GolemOverlayTargetPlan {
  target: OverlayTarget
  canvasWidth: number
  canvasHeight: number
  rect: OverlayRect
}

/**
 * Which output canvases get a Golem raster. The primary is the capture
 * canvas (the recording's; a stream-only session composites at that size
 * too, see `captionOverlayTargets`). A streaming session also gets the
 * auxiliary leg: the vertical simulcast canvas when one is armed, else the
 * split stream profile. The backend's per-leg flags decide what is drawn;
 * an unused auxiliary raster is harmless. Nothing when both switches are off.
 */
export function golemOverlayTargetPlan(input: {
  streamEnabled: boolean
  recordingVideo: { width: number; height: number }
  streamVideo: { width: number; height: number }
  verticalLeg?: { width: number; height: number }
  layout: OverlayItemLayout
}): GolemOverlayTargetPlan[] {
  if (!input.layout.showOnStream && !input.layout.showInRecording) return []
  const plan = (target: OverlayTarget, video: { width: number; height: number }) => ({
    target,
    canvasWidth: video.width,
    canvasHeight: video.height,
    rect: input.layout[overlayOrientationForCanvas(video.width, video.height)]
  })
  const targets = [plan('primary', input.recordingVideo)]
  if (input.streamEnabled) targets.push(plan('auxiliary', input.verticalLeg ?? input.streamVideo))
  return targets
}

/** Everything that changes pixels, for the push dedupe. */
export function golemOverlayKey(params: {
  personaId: string
  imagesKey: string
  state: CohostAvatarState
  bubble: string | null
  style: CohostBubbleStyle
  targets: GolemOverlayTargetPlan[]
}): string {
  return JSON.stringify([
    params.personaId,
    params.imagesKey,
    params.state,
    params.bubble,
    params.style,
    params.targets
  ])
}
