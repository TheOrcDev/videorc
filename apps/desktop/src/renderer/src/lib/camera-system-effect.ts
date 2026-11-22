import type { CameraSystemEffect } from '@/lib/backend'

/**
 * Plan 258 S4 (D12): the line under the Studio's Camera row when the
 * operating system is changing the camera's background itself. macOS Video
 * Effects and Windows Studio Effects run before Videorc sees a frame, so
 * viewers get them too, and with Videorc's own background they stack. The
 * line names the system menu that turns them off (apps can't on macOS). A
 * status line, never a toast: the camera's picture already shows it.
 *
 * Studio Light gets no line: it changes the light on a face, not the room
 * behind it, so it neither hides the room nor fights Videorc's background.
 * Null when there is nothing to say.
 */
export function cameraSystemEffectLine(effect: CameraSystemEffect | undefined): string | null {
  if (!effect) return null
  if (effect.provider === 'macos-video-effects') {
    if (effect.backgroundReplacement) {
      return "macOS is replacing this camera's background (Video menu, Background). Turn it off there to use Videorc's background."
    }
    if (effect.backgroundBlur) {
      return "macOS is blurring this camera (Video menu, Portrait). Turn it off there to use Videorc's background."
    }
    return null
  }
  if (effect.turnedOffByVideorc) {
    return "Windows Studio Effects blur is off while Videorc's background is on."
  }
  if (effect.backgroundBlur) {
    return "Windows Studio Effects is blurring this camera (Quick Settings, Studio effects). Turn it off there to use Videorc's background."
  }
  return null
}
