import type {
  PerformanceCheckProgress,
  PerformanceCheckResult,
  PerformanceCheckRunParams,
  PerformanceCheckState,
  VideoPreset,
  VideoSettings
} from '../../../shared/backend'
import { videoPresets } from './capture'

/** How a given output stands against what this computer measured. */
export type OutputVerdict = 'verified' | 'too-heavy' | 'unknown'

const MAX_CEILING_PIXELS = 3840 * 2160
// The pre-check default. An automatic apply never goes above it: a machine
// that can hold 4K is told so, not silently moved to 30 Mbps files.
const AUTO_APPLY_CEILING = videoPresets['tutorial-1440p30']
// Top-down, mirrors the backend ladder (performance_check.rs `full_ladder`).
const LADDER_PRESETS: VideoPreset[] = [
  'record-4k30',
  'tutorial-1440p30',
  'stream-safe-1080p60',
  'tutorial-1080p30',
  'tutorial-720p30'
]

const pixels = (video: Pick<VideoSettings, 'width' | 'height'>): number =>
  video.width * video.height

/** `a` is at least as demanding as `b` in both resolution and frame rate. */
const dominates = (a: VideoSettings, b: VideoSettings): boolean =>
  pixels(a) >= pixels(b) && a.fps >= b.fps

/**
 * The largest output worth testing: whatever is selected, or the display's
 * native size when that is larger (capped at 4K). A 1080p laptop never spends
 * time on 4K rungs; a 1440p selection on that laptop still gets its verdict.
 */
export function performanceCheckCeiling(
  selected: VideoSettings,
  display?: { width: number; height: number }
): PerformanceCheckRunParams {
  const ceilingFps = Math.max(30, selected.fps)
  if (!display || pixels(display) <= pixels(selected)) {
    return { ceilingWidth: selected.width, ceilingHeight: selected.height, ceilingFps }
  }
  if (pixels(display) > MAX_CEILING_PIXELS) {
    return { ceilingWidth: 3840, ceilingHeight: 2160, ceilingFps }
  }
  return {
    ceilingWidth: Math.round(display.width),
    ceilingHeight: Math.round(display.height),
    ceilingFps
  }
}

export function outputVerdict(
  video: VideoSettings,
  result: PerformanceCheckResult | undefined
): OutputVerdict {
  if (!result) {
    return 'unknown'
  }
  if (result.rungs.some((rung) => rung.verdict === 'passed' && dominates(rung.video, video))) {
    return 'verified'
  }
  if (result.rungs.some((rung) => rung.verdict === 'failed' && dominates(video, rung.video))) {
    return 'too-heavy'
  }
  return 'unknown'
}

/** The preset an untouched install is moved to, or undefined to leave it. */
export function autoApplyPreset(result: PerformanceCheckResult): VideoPreset | undefined {
  if (result.belowFloor) {
    return result.recommended.preset
  }
  return LADDER_PRESETS.find((preset) => {
    const video = videoPresets[preset]
    return (
      video.fps <= 30 &&
      dominates(AUTO_APPLY_CEILING, video) &&
      outputVerdict(video, result) === 'verified'
    )
  })
}

/**
 * Only an output nobody picked may be moved. Installs older than the
 * "chosen by user" flag are judged by value: still on a shipped default
 * (1440p30 before the check existed, 1080p30 since) means never chosen.
 */
export function isShippedDefaultOutput(video: VideoSettings): boolean {
  return (['tutorial-1440p30', 'tutorial-1080p30'] as const).some((preset) => {
    const shipped = videoPresets[preset]
    return (
      pixels(video) === pixels(shipped) &&
      video.fps === shipped.fps &&
      video.bitrateKbps === shipped.bitrateKbps
    )
  })
}

/** Run when nothing was ever measured, or it was measured on other hardware. */
export function shouldRunPerformanceCheck(state: PerformanceCheckState | undefined): boolean {
  return state !== undefined && !state.running && (state.result === undefined || state.stale)
}

export function outputLabel(video: Pick<VideoSettings, 'width' | 'height' | 'fps'>): string {
  const short = Math.min(video.width, video.height)
  const name = short === 2160 ? '4K' : `${short}p`
  return `${name} ${video.fps}`
}

export interface PerformanceCheckLine {
  tone: 'muted' | 'warning'
  busy: boolean
  text: string
  /** Offer "Use <recommended>" next to the text. */
  applyPreset?: VideoPreset
  applyLabel?: string
  checkLabel?: 'Check this computer' | 'Check again'
}

/** The one line under the preset select in Recording → Output. */
export function performanceCheckLine({
  state,
  progress,
  video
}: {
  state: PerformanceCheckState | undefined
  progress: PerformanceCheckProgress | null
  video: VideoSettings
}): PerformanceCheckLine | null {
  if (!state) {
    return null
  }
  if (state.running) {
    return {
      tone: 'muted',
      busy: true,
      text: progress
        ? `Checking what this computer can record… ${outputLabel(progress.video)}`
        : 'Checking what this computer can record…'
    }
  }
  const result = state.result
  if (!result) {
    return {
      tone: 'muted',
      busy: false,
      text: 'This computer has not been measured yet.',
      checkLabel: 'Check this computer'
    }
  }
  if (result.belowFloor) {
    return {
      tone: 'warning',
      busy: false,
      text: `Nothing held steady on this computer, not even ${outputLabel(result.recommended)}. Close other apps and check again.`,
      checkLabel: 'Check again'
    }
  }
  const recommended = outputLabel(result.recommended)
  const offer =
    pixels(video) === pixels(result.recommended) && video.fps === result.recommended.fps
      ? {}
      : { applyPreset: result.recommended.preset, applyLabel: `Use ${recommended}` }
  switch (outputVerdict(video, result)) {
    case 'verified':
      return {
        tone: 'muted',
        busy: false,
        text: `${outputLabel(video)} is verified for this computer.`,
        checkLabel: 'Check again'
      }
    case 'too-heavy':
      return {
        tone: 'warning',
        busy: false,
        text: `${outputLabel(video)} is too heavy for this computer. Recordings will stutter. ${recommended} held steady.`,
        checkLabel: 'Check again',
        ...offer
      }
    case 'unknown':
      return {
        tone: 'muted',
        busy: false,
        text: `${outputLabel(video)} has not been measured. ${recommended} held steady.`,
        checkLabel: 'Check again',
        ...offer
      }
  }
}
