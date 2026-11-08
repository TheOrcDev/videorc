import type {
  PerformanceCheckProgress,
  PerformanceCheckState,
  VideoPreset,
  VideoSettings
} from '../../../shared/backend'
import { isUntrustedPerformanceCheckResult, outputLabel, outputVerdict } from './performance-check'
import { platformCopy } from './platform-copy'

// The Recording → Output line. Kept apart from performance-check.ts so its
// copy loads with that panel instead of riding in the startup bundle.

const pixels = (video: Pick<VideoSettings, 'width' | 'height'>): number =>
  video.width * video.height

export interface PerformanceCheckLine {
  tone: 'muted' | 'warning'
  busy: boolean
  text: string
  /** Offer "Use <recommended>" next to the text. */
  applyPreset?: VideoPreset
  applyLabel?: string
  checkLabel?: 'Check this computer' | 'Check again'
  /** What pressing the check button costs, for its tooltip. */
  checkHint?: string
}

/** The one line under the preset select in Recording → Output. */
export function performanceCheckLine({
  state,
  progress,
  video,
  platform,
  clipsOn = false
}: {
  state: PerformanceCheckState | undefined
  progress: PerformanceCheckProgress | null
  video: VideoSettings
  platform?: string
  /** The Clips ring steps aside while the check runs (plan 212 S5). */
  clipsOn?: boolean
}): PerformanceCheckLine | null {
  const line = performanceCheckLineWords(state, progress, video, platformCopy(platform).deviceNoun)
  if (!line?.checkLabel) {
    return line
  }
  return {
    ...line,
    checkHint: clipsOn
      ? 'Takes about 20 seconds. Clips pauses while it runs.'
      : 'Takes about 20 seconds.'
  }
}

function performanceCheckLineWords(
  state: PerformanceCheckState | undefined,
  progress: PerformanceCheckProgress | null,
  video: VideoSettings,
  deviceNoun: string
): PerformanceCheckLine | null {
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
  // Plan 212 D3: a check on a busy computer records nothing and keeps the
  // previous verdict; say why before anything that verdict says.
  if (state.lastRunNotRecorded === 'host-busy') {
    return {
      tone: 'warning',
      busy: false,
      text: `Your ${deviceNoun} was busy, so the check stopped. Try again when it's quieter.`,
      checkLabel: 'Check again'
    }
  }
  const result = state.result
  if (!result || isUntrustedPerformanceCheckResult(result)) {
    return {
      tone: 'muted',
      busy: false,
      text: `Not checked on this ${deviceNoun} yet.`,
      checkLabel: 'Check this computer'
    }
  }
  // Plan 212 D1: the check never reruns on its own, so a verdict measured on
  // other graphics or another OS is offered again here instead.
  if (state.stale) {
    return {
      tone: 'muted',
      busy: false,
      text: `Your ${deviceNoun} changed since the last check.`,
      checkLabel: 'Check again'
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
        text: `${outputLabel(video)} hasn't been measured. ${recommended} held steady.`,
        checkLabel: 'Check again',
        ...offer
      }
  }
}
