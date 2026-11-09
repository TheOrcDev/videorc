import type { VideoSettings } from './backend'
import { formatResolution, resolutionName } from './format-video'
import { isWindowsPlatform } from './platform'

// The encoder bridge's proven envelopes above 30 fps, mirrored from
// recording.rs (`RECORD_ONLY_BRIDGE_60FPS_MAX_SIDES`,
// `STREAMING_BRIDGE_60FPS_MAX_SIDES`): record-only runs to 1440p60, a
// livestream to 1080p60 across the recording and every destination. A
// request outside them takes the legacy FFmpeg path, which on Windows is
// software OpenH264: 4K60 ran at a third of realtime and wrote a truncated
// file with no warning (issue #1062). The backend now refuses such a start on
// Windows, and these helpers say so before it is pressed.

type VideoSides = { longSide: number; shortSide: number }
type VideoSize = Pick<VideoSettings, 'width' | 'height'>
type VideoProfile = Pick<VideoSettings, 'width' | 'height' | 'fps'>

export const RECORD_ONLY_BRIDGE_60FPS_MAX_SIDES: VideoSides = { longSide: 2560, shortSide: 1440 }
/** The livestream envelope, for reference; the backend alone judges it. */
export const STREAMING_BRIDGE_60FPS_MAX_SIDES: VideoSides = { longSide: 1920, shortSide: 1080 }
export const BRIDGE_60FPS_MAX_FPS = 60

function fitsSides(video: VideoSize, { longSide, shortSide }: VideoSides): boolean {
  return (
    Math.max(video.width, video.height) <= longSide &&
    Math.min(video.width, video.height) <= shortSide
  )
}

/** A recording with no stream rides the bridge: 30 fps anywhere, 60 fps up to 1440p. */
export function recordOnlyBridgeEnvelopeFits(video: VideoProfile): boolean {
  return (
    video.fps <= 30 ||
    (video.fps <= BRIDGE_60FPS_MAX_FPS && fitsSides(video, RECORD_ONLY_BRIDGE_60FPS_MAX_SIDES))
  )
}

/** "4K", "1440p", or both sides for a portrait canvas: the backend's spelling too. */
function sizeName(video: VideoSize): string {
  return video.height > video.width ? formatResolution(video) : resolutionName(video)
}

/** The largest canvas of `video`'s orientation inside an envelope, named. */
function envelopeSizeName(video: VideoSize, { longSide, shortSide }: VideoSides): string {
  return sizeName(
    video.height > video.width
      ? { width: shortSide, height: longSide }
      : { width: longSide, height: shortSide }
  )
}

/**
 * Why Windows refuses this output, in the backend's words, or null when it
 * rides the bridge (or the computer is not a Windows PC). A livestream is
 * never judged here: above 30 fps the Go Live sheet shares one encode at the
 * destinations' profile, inside the envelope, or refuses the split itself.
 */
export function windowsBridgeEnvelopeRefusal({
  platform,
  recordEnabled,
  streamEnabled,
  video
}: {
  platform: string | undefined
  recordEnabled: boolean
  streamEnabled: boolean
  video: VideoProfile
}): string | null {
  if (
    !isWindowsPlatform(platform) ||
    !recordEnabled ||
    streamEnabled ||
    recordOnlyBridgeEnvelopeFits(video)
  ) {
    return null
  }
  const name = sizeName(video)
  const cap = envelopeSizeName(video, RECORD_ONLY_BRIDGE_60FPS_MAX_SIDES)
  return `${name} at ${video.fps} fps isn't supported on Windows yet. Choose ${name} at 30 fps or ${cap} at ${video.fps} fps.`
}
