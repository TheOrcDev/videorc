import type { DiagnosticStats } from '@/lib/backend'

// Camera format shortfall detection (plan 024 S5).
//
// A camera can enumerate a format matrix that cannot satisfy the requested
// resolution/fps — e.g. an Elgato Cam Link mirroring a 4K/25p (PAL) HDMI source
// offers ONLY 3840x2160@25, so a 1080p30 request silently falls back to 4K@25
// and every recording is 25fps with no in-app hint why. The backend already
// records the mismatch in previewCameraStatusMessage, but that is a status
// line, not an actionable warning. This pure helper turns the diagnostics into
// a structured shortfall so the Sources tab can name it.

export interface CameraFormatShortfall {
  /** The framerate is the actionable gap (requested fps unmet). */
  fpsUnmet: boolean
  /** The resolution is the actionable gap (requested dimensions unmet). */
  resolutionUnmet: boolean
  requestedWidth: number
  requestedHeight: number
  requestedFps: number
  selectedWidth: number
  selectedHeight: number
  selectedMaxFps: number
  /** True when the camera enumerated exactly one format — nothing else to pick. */
  singleFormat: boolean
}

const FPS_TOLERANCE = 1

/**
 * Detect whether the selected camera format falls short of what was requested.
 * Returns null when there is no camera preview, the diagnostics are incomplete,
 * or the selected format meets the request (the healthy case).
 */
export function cameraFormatShortfall(stats: DiagnosticStats): CameraFormatShortfall | null {
  if (stats.previewCameraState !== 'live') {
    return null
  }
  const requestedWidth = stats.previewCameraRequestedWidth
  const requestedHeight = stats.previewCameraRequestedHeight
  const selectedWidth = stats.previewCameraSelectedFormatWidth
  const selectedHeight = stats.previewCameraSelectedFormatHeight
  const selectedMaxFps = stats.previewCameraSelectedFormatMaxFps
  const requestedFps = requestedCameraFps(stats)
  if (
    requestedWidth == null ||
    requestedHeight == null ||
    selectedWidth == null ||
    selectedHeight == null ||
    selectedMaxFps == null ||
    requestedFps == null
  ) {
    return null
  }

  // The camera can't reach the requested fps at all — its best format tops out
  // below the ask (beyond a rounding tolerance).
  const fpsUnmet = selectedMaxFps + FPS_TOLERANCE < requestedFps
  // The camera's selected format can't deliver the requested resolution — only
  // flag when it is SMALLER; a larger native format that gets downscaled is fine.
  const resolutionUnmet = selectedWidth < requestedWidth || selectedHeight < requestedHeight

  if (!fpsUnmet && !resolutionUnmet) {
    return null
  }

  return {
    fpsUnmet,
    resolutionUnmet,
    requestedWidth,
    requestedHeight,
    requestedFps,
    selectedWidth,
    selectedHeight,
    selectedMaxFps,
    singleFormat: (stats.previewCameraCapabilityFormats?.length ?? 0) === 1
  }
}

function requestedCameraFps(stats: DiagnosticStats): number | null {
  // The requested camera fps isn't a dedicated field; the selected format's max
  // is compared against the session target fps, which the status message
  // records as "Requested WxH@FPS". Parse it as the source of truth for the ask.
  const match = /Requested\s+\d+x\d+@(\d+(?:\.\d+)?)/.exec(stats.previewCameraStatusMessage ?? '')
  if (match) {
    const fps = Number.parseFloat(match[1])
    return Number.isFinite(fps) && fps > 0 ? fps : null
  }
  return null
}

/** Actionable one-line guidance for a detected shortfall. */
export function cameraFormatShortfallMessage(shortfall: CameraFormatShortfall): string {
  const selected = `${shortfall.selectedWidth}×${shortfall.selectedHeight} at ${Math.round(
    shortfall.selectedMaxFps
  )} fps`
  if (shortfall.fpsUnmet && shortfall.singleFormat) {
    return `This camera only offers ${selected}, so it can't reach ${shortfall.requestedFps} fps. If it's a capture device, set the connected HDMI source to a 60Hz/30Hz (NTSC) mode.`
  }
  if (shortfall.fpsUnmet) {
    return `This camera's closest format is ${selected} — below the requested ${shortfall.requestedFps} fps. Recording will run at ${Math.round(shortfall.selectedMaxFps)} fps.`
  }
  // Name the consequence, not just the mismatch: a resolution shortfall means
  // every frame is enlarged to fill the canvas, which is what the user
  // actually sees. Saying only "below the requested 3840×2160" left people
  // believing they were recording 4K because the OUTPUT is 4K.
  return `This camera's closest format is ${selected}, so the image is upscaled to fill the ${shortfall.requestedWidth}×${shortfall.requestedHeight} canvas.`
}
