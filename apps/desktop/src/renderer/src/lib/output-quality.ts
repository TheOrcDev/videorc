import type { StreamingSettings, StreamTargetSettings, VideoPreset, VideoSettings } from './backend'
import { videoPresets, type LayoutOrientation } from './capture'

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

/**
 * The recording settings for a picked resolution. A standard bitrate moves
 * with its size; an intentional custom rate survives. The Output page's
 * resolution buttons and the Studio's Output row both pick through here, so
 * one size never gets two bitrates (plan 174, D-8).
 */
export function pickRecordingResolution(
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

/** The Output page's typed fields (plan 174, D-1). */
export type OutputNumberField = 'width' | 'height' | 'fps' | 'bitrateKbps'

export type OutputFieldLimits = { min: number; max: number; step: number }

/**
 * A typed field's bounds. The canvas sides follow the scene's orientation with
 * the bounds the saved settings are clamped to at launch
 * (`normalizeVideoSettings`), so a committed size is still the size after a
 * relaunch.
 */
export function outputFieldLimits(
  field: OutputNumberField,
  orientation: LayoutOrientation
): OutputFieldLimits {
  const vertical = orientation === 'vertical'
  switch (field) {
    case 'width':
      return vertical ? { min: 360, max: 2160, step: 1 } : { min: 640, max: 3840, step: 1 }
    case 'height':
      return vertical ? { min: 640, max: 3840, step: 1 } : { min: 360, max: 2160, step: 1 }
    case 'fps':
      return { min: 24, max: 60, step: 1 }
    case 'bitrateKbps':
      return { min: 1000, max: 50000, step: 500 }
  }
}

export const LANDSCAPE_CANVAS_RULE =
  'A landscape scene needs a width at least as large as the height.'
export const VERTICAL_CANVAS_RULE =
  'A vertical scene needs a height at least as large as the width.'

export type OutputFieldCommit =
  | { kind: 'commit'; patch: Partial<VideoSettings> }
  /** Nothing to save: an empty or unchanged entry. The field shows the setting again. */
  | { kind: 'unchanged' }
  /** The size would contradict the scene's orientation; the rule says why. */
  | { kind: 'refused'; message: string }

/**
 * What a typed Output value does when the field is left or Enter is pressed
 * (plan 174, D-1). Typing commits nothing, so a half-typed number never
 * reaches the canvas; the value is rounded and clamped to the field's bounds.
 * A size that would contradict the scene's orientation is refused with the
 * rule instead of being transposed (typing 2560 into Width used to give
 * 1080×2).
 */
export function commitOutputField(
  video: VideoSettings,
  field: OutputNumberField,
  draft: string,
  orientation: LayoutOrientation
): OutputFieldCommit {
  const typed = draft.trim()
  const parsed = Number(typed)
  if (typed === '' || !Number.isFinite(parsed)) return { kind: 'unchanged' }
  const { min, max } = outputFieldLimits(field, orientation)
  const value = Math.min(max, Math.max(min, Math.round(parsed)))
  if (value === video[field]) return { kind: 'unchanged' }
  if (field === 'width' || field === 'height') {
    const width = field === 'width' ? value : video.width
    const height = field === 'height' ? value : video.height
    if (orientation === 'vertical' ? width > height : height > width) {
      return {
        kind: 'refused',
        message: orientation === 'vertical' ? VERTICAL_CANVAS_RULE : LANDSCAPE_CANVAS_RULE
      }
    }
  }
  const patch: Partial<VideoSettings> = {}
  patch[field] = value
  return { kind: 'commit', patch }
}
