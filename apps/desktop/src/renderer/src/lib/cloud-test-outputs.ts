import type { CloudTestOutput } from '@/lib/backend'
import {
  buildSimulcastParams,
  type CaptureConfig,
  streamOutputVideoForTarget,
  streamOutputVideoSettings
} from '@/lib/capture'

/**
 * The outputs a Test cloud pushes (plan 184 C6b): the shape a show would be
 * created with, so the test measures the upload the stream needs. Horizontal
 * at the quality the enabled horizontal destinations stream at (the lowest
 * bitrate when they differ, as the backend's cloud output specs pick), or at
 * the default stream profile when no destination is set up yet, so the test
 * works before the first one. Vertical only when the dual-orientation leg is
 * armed, at that leg's profile.
 */
export function cloudTestOutputs(config: CaptureConfig): CloudTestOutput[] {
  const streaming = config.streaming
  const horizontal = streaming.targets
    .filter(
      (target) =>
        target.enabled &&
        streaming.enabledTargetIds.includes(target.id) &&
        target.outputOrientation !== 'vertical'
    )
    .map((target) => streamOutputVideoForTarget(config.video, streaming, target))
  const first = horizontal[0] ?? streamOutputVideoSettings(config.video, streaming)
  const outputs: CloudTestOutput[] = [
    {
      orientation: 'horizontal',
      width: first.width,
      height: first.height,
      fps: first.fps,
      videoKbps: Math.min(first.bitrateKbps, ...horizontal.map((video) => video.bitrateKbps))
    }
  ]
  const vertical = buildSimulcastParams(config)?.video
  if (vertical) {
    outputs.push({
      orientation: 'vertical',
      width: vertical.width,
      height: vertical.height,
      fps: vertical.fps,
      videoKbps: vertical.bitrateKbps
    })
  }
  return outputs
}

/**
 * What going through Videorc Cloud uploads against streaming directly
 * (plan 222 U2, U3), from the enabled destinations and their bitrates:
 * through the cloud, one feed per orientation in use, at the shape a show
 * is created with; directly, every destination's own stream. Video bitrates
 * only, like Test. Null with no destination enabled.
 */
export type CloudUploadPlan = {
  /** The cloud's feeds, one per orientation in use: horizontal first. */
  feedsKbps: number[]
  /** The same destinations streamed directly from this computer. */
  directKbps: number
  destinations: number
}

export function cloudUploadPlan(config: CaptureConfig): CloudUploadPlan | null {
  const streaming = config.streaming
  const enabled = streaming.targets.filter(
    (target) => target.enabled && streaming.enabledTargetIds.includes(target.id)
  )
  if (enabled.length === 0) return null
  const horizontal = enabled.filter((target) => target.outputOrientation !== 'vertical')
  const vertical = enabled.filter((target) => target.outputOrientation === 'vertical')
  const outputs = cloudTestOutputs(config)
  const horizontalFeed = outputs.find((output) => output.orientation === 'horizontal')
  const verticalFeed = outputs.find((output) => output.orientation === 'vertical')
  const feedsKbps: number[] = []
  if (horizontal.length > 0 && horizontalFeed) feedsKbps.push(horizontalFeed.videoKbps)
  if (vertical.length > 0 && verticalFeed) feedsKbps.push(verticalFeed.videoKbps)
  if (feedsKbps.length === 0) return null
  const directKbps =
    horizontal.reduce(
      (sum, target) =>
        sum + streamOutputVideoForTarget(config.video, streaming, target).bitrateKbps,
      0
    ) +
    vertical.length * (verticalFeed?.videoKbps ?? 0)
  return { feedsKbps, directKbps, destinations: enabled.length }
}
