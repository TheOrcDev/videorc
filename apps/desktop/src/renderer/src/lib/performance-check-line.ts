import type {
  PerformanceCheckProgress,
  PerformanceCheckState,
  VideoPreset,
  VideoSettings
} from '../../../shared/backend'
import { isUntrustedPerformanceCheckResult, outputLabel, outputVerdict } from './performance-check'

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
  if (!result || isUntrustedPerformanceCheckResult(result)) {
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
