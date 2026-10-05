import type { StreamingSettings, StreamTargetSettings, VideoPreset, VideoSettings } from './backend'
import { videoPresets } from './capture'

export const streamQualityOptions: { value: VideoPreset; label: string }[] = [
  { value: 'stream-safe-1080p30', label: 'Full HD · 30 fps' },
  { value: 'stream-safe-1080p60', label: 'Full HD · 60 fps' },
  { value: 'stream-youtube-4k30', label: 'YouTube 4K · 30 fps' }
]

export function withStreamQuality(
  streaming: StreamingSettings,
  preset: VideoPreset
): StreamingSettings {
  return {
    ...streaming,
    defaultOutputPreset: preset,
    defaultBitrateKbps: videoPresets[preset].bitrateKbps
  }
}

export function streamQualityOverride(
  preset: VideoPreset | 'default'
): Partial<StreamTargetSettings> {
  return preset === 'default'
    ? { outputPreset: undefined, outputBitrateKbps: undefined }
    : { outputPreset: preset, outputBitrateKbps: videoPresets[preset].bitrateKbps }
}

/** Resolution buttons move a standard bitrate with its size; intentional custom rates survive. */
export function recordingResolutionSettings(
  video: VideoSettings,
  width: number,
  height: number
): VideoSettings {
  const sameSize = (candidate: VideoSettings, w: number, h: number): boolean =>
    Math.max(candidate.width, candidate.height) === Math.max(w, h) &&
    Math.min(candidate.width, candidate.height) === Math.min(w, h)
  const recordingPresets = Object.values(videoPresets).filter(
    (candidate) =>
      candidate.preset.startsWith('tutorial-') || candidate.preset.startsWith('record-')
  )
  const standardRate = recordingPresets.some(
    (candidate) =>
      sameSize(candidate, video.width, video.height) &&
      candidate.fps === video.fps &&
      candidate.bitrateKbps === video.bitrateKbps
  )
  const next = recordingPresets.find(
    (candidate) => sameSize(candidate, width, height) && candidate.fps === video.fps
  )
  return {
    ...video,
    width,
    height,
    preset: 'custom',
    bitrateKbps: standardRate && next ? next.bitrateKbps : video.bitrateKbps
  }
}
