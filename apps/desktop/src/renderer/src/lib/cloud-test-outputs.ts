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
