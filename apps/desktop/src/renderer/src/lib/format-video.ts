// Plan 174 S1.4 (D-22, B-15, V-X2): one spelling per video fact. Resolution
// and frame rate were written at least eight ways ("1920×1080 · 30fps",
// "1080p30", "Full HD · 30 fps", "4K · 2160p30", "1920x1080 @ 30 FPS",
// "1080p 30", "2K" for 1440p). Every surface now formats through here:
//
//   short  "1080p · 30 fps"         (rows, chips, sentences)
//   full   "1920 × 1080 · 30 fps"   (where the exact size matters)
//   +rate  "1080p · 30 fps · 6 Mbps"

export interface VideoSize {
  width: number
  height: number
}

export interface VideoQuality extends VideoSize {
  fps: number
  bitrateKbps?: number
}

export interface VideoQualityOptions {
  /** `short` names the class ("1080p"); `full` spells both sides ("1920 × 1080"). */
  size?: 'short' | 'full'
  /** Append the bitrate ("6 Mbps") when the video carries one. */
  bitrate?: boolean
}

/**
 * The resolution class from the short edge, whatever the orientation: 2160
 * is "4K", everything else its short edge ("1440p", "1080p", "720p"). No
 * "2K" or "Full HD": one name per size.
 */
export function resolutionName(video: VideoSize): string {
  const short = Math.round(Math.min(video.width, video.height))
  return short === 2160 ? '4K' : `${short}p`
}

/** "1920 × 1080": width first, the multiplication sign with spaces. */
export function formatResolution(video: VideoSize): string {
  return `${Math.round(video.width)} × ${Math.round(video.height)}`
}

/** "30 fps", "29.97 fps": a configured rate keeps up to two decimals. */
export function formatFrameRate(fps: number): string {
  const rounded = Math.round(fps * 100) / 100
  return `${rounded.toLocaleString(undefined, { maximumFractionDigits: 2 })} fps`
}

/** "6 Mbps", "4.5 Mbps", "0.8 Mbps": always megabits, one decimal at most. */
export function formatBitrate(kbps: number | undefined): string {
  if (typeof kbps !== 'number' || !Number.isFinite(kbps) || kbps < 0) return ''
  const mbps = Math.round(kbps / 100) / 10
  return `${mbps.toLocaleString(undefined, { maximumFractionDigits: 1 })} Mbps`
}

/**
 * The one way to say what a video is. A portrait canvas keeps both sides
 * even in the short form ("1080 × 1920"): "1080p" reads as landscape.
 */
export function formatVideoQuality(
  video: VideoQuality,
  { size = 'short', bitrate = false }: VideoQualityOptions = {}
): string {
  const portrait = video.height > video.width
  const parts = [
    size === 'full' || portrait ? formatResolution(video) : resolutionName(video),
    formatFrameRate(video.fps)
  ]
  if (bitrate) {
    const rate = formatBitrate(video.bitrateKbps)
    if (rate) parts.push(rate)
  }
  return parts.join(' · ')
}
