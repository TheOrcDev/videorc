import type { StreamDeliveryState } from '@/lib/backend'

// Plan 218's two stream figures, for Health's Recording and encoder group.
// Their own module: the attribution module sits in the eager entry, and only
// the lazy Health page reads these.

/**
 * Plan 218: what the stream encoder delivered over its 30 s window, against
 * the target, e.g. "21 of 30 fps". FFmpeg's own fps describes the recording
 * file when one is written, so the stream's figure wins when it exists.
 */
export function formatDeliveredFps(delivery?: StreamDeliveryState): string {
  if (!delivery || !Number.isFinite(delivery.deliveredFps) || delivery.windowSeconds <= 0) {
    return ''
  }
  return `${Math.round(delivery.deliveredFps)} of ${delivery.targetFps} fps`
}

/**
 * Plan 218 S3a: "4.8 of 6 Mbps" while Videorc holds the stream under its
 * chosen bitrate to fit the connection; empty once it is back.
 */
export function formatLoweredBitrate(delivery?: StreamDeliveryState): string {
  const current = delivery?.bitrateKbps
  const chosen = delivery?.chosenBitrateKbps
  if (!finite(current) || !finite(chosen) || current >= chosen) {
    return ''
  }
  const mbps = (kbps: number): string => {
    const value = kbps / 1000
    return Number.isInteger(value) ? `${value}` : value.toFixed(1)
  }
  return `${mbps(current)} of ${mbps(chosen)} Mbps`
}

function finite(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}
