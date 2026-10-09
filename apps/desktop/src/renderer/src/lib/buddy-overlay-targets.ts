import type {
  CohostBubbleStyle,
  OverlayItemLayout,
  OverlayRect,
  OverlayTarget
} from '@/lib/backend'
import { overlayOrientationForCanvas } from '@/lib/overlay-layout'

// Which output canvases the Buddy's bubble is rasterized for (plan 164 S-C2;
// the bubble only since plan 168) and the key that dedupes a push. Pure and
// asset-free, so the Studio can import it eagerly; the rasterizer itself
// (`buddy-overlay.ts`) stays a lazy chunk.

export interface BuddyOverlayTargetPlan {
  target: OverlayTarget
  canvasWidth: number
  canvasHeight: number
  rect: OverlayRect
}

/**
 * Which output canvases get a Buddy bubble raster. The primary is the capture
 * canvas (the recording's; a stream-only session composites at that size
 * too, see `captionOverlayTargets`). A streaming session also gets the
 * auxiliary leg: the vertical simulcast canvas when one is armed, else the
 * split stream profile. The backend's per-leg flags decide what is drawn;
 * an unused auxiliary raster is harmless. Nothing when both switches are off.
 */
export function buddyOverlayTargetPlan(input: {
  streamEnabled: boolean
  recordingVideo: { width: number; height: number }
  streamVideo: { width: number; height: number }
  verticalLeg?: { width: number; height: number }
  layout: OverlayItemLayout
}): BuddyOverlayTargetPlan[] {
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

/** Everything that changes the bubble's pixels, for the push dedupe. The
 * pet is drawn by the backend (plan 168 S-B1), so the persona's images and
 * state no longer change what the renderer pushes. */
export function buddyOverlayKey(params: {
  bubble: string | null
  style: CohostBubbleStyle
  targets: BuddyOverlayTargetPlan[]
}): string {
  return JSON.stringify([params.bubble, params.style, params.targets])
}
