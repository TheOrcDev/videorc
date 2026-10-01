import type {
  EncodeBackend,
  PerformanceCheckProgress,
  PerformanceCheckResult,
  PerformanceCheckRunParams,
  PerformanceCheckState,
  StreamingSettings,
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
  'tutorial-720p30',
  'tutorial-540p30'
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

/**
 * Linux v1 `belowFloor` + every measured rung `did-not-start` is a failed
 * ladder, not a machine class (ogre / Omarchy 2026-09-28). Do not apply it
 * or show "too heavy" from it. Packaged auto-run still fires once.
 */
export function isUntrustedPerformanceCheckResult(
  result: PerformanceCheckResult | undefined
): boolean {
  if (!result?.belowFloor || !result.capabilityKey.startsWith('performance-check-v1:')) {
    return false
  }
  const measured = result.rungs.filter((rung) => rung.verdict !== 'skipped')
  return (
    measured.length > 0 &&
    measured.every((rung) => rung.verdict === 'failed' && rung.reasons.includes('did-not-start'))
  )
}

export function outputVerdict(
  video: VideoSettings,
  result: PerformanceCheckResult | undefined
): OutputVerdict {
  if (!result || isUntrustedPerformanceCheckResult(result)) {
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
  if (isUntrustedPerformanceCheckResult(result)) {
    return undefined
  }
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
  return (
    state !== undefined &&
    !state.running &&
    (state.result === undefined || state.stale || isUntrustedPerformanceCheckResult(state.result))
  )
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

/** Toast for a user-chosen output this computer measurably cannot hold. */
export function performanceCheckTooHeavyToast(
  chosen: VideoSettings,
  result: PerformanceCheckResult
): { title: string; description: string } | undefined {
  // The floor is recommended even when it failed. Do not claim it held.
  if (
    result.belowFloor ||
    isShippedDefaultOutput(chosen) ||
    outputVerdict(chosen, result) !== 'too-heavy'
  ) {
    return undefined
  }
  return {
    title: `${outputLabel(chosen)} is too heavy for this computer`,
    description: `Recordings will stutter. ${outputLabel(result.recommended)} held steady. Switch in Recording → Output.`
  }
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

/** What the measured machine means for a livestream about to start. */
export type SoftwareStreamAdvice =
  | {
      /** The stream goes out at the largest output that held steady. */
      kind: 'step-down'
      requested: VideoSettings
      video: VideoSettings
    }
  | {
      /** Nothing held steady, not even the floor: warn, never pretend. */
      kind: 'below-floor'
      floor: VideoSettings
    }

const SOFTWARE_ENCODE_BACKENDS: readonly EncodeBackend[] = [
  'software-open-h264',
  'software-media-foundation',
  'software-x264'
]

/**
 * Plan 090 D2 / B3. Only a session that will encode on the CPU is advised:
 * a hardware encoder's stream profile is the user's call, and a stale or
 * untrusted measurement advises nothing. Portrait streams are left alone;
 * the ladder is landscape.
 */
export function softwareStreamAdvice({
  streamVideo,
  encodeBackend,
  state
}: {
  streamVideo: VideoSettings
  encodeBackend: EncodeBackend | undefined
  state: PerformanceCheckState | undefined
}): SoftwareStreamAdvice | null {
  const result = state?.result
  if (
    !result ||
    state.stale ||
    isUntrustedPerformanceCheckResult(result) ||
    !encodeBackend ||
    !SOFTWARE_ENCODE_BACKENDS.includes(encodeBackend) ||
    streamVideo.width < streamVideo.height
  ) {
    return null
  }
  if (result.belowFloor) {
    return { kind: 'below-floor', floor: result.recommended }
  }
  const recommended = videoPresets[result.recommended.preset]
  if (
    result.recommended.preset === 'custom' ||
    !recommended ||
    outputVerdict(streamVideo, result) !== 'too-heavy' ||
    !dominates(streamVideo, recommended) ||
    (pixels(streamVideo) === pixels(recommended) && streamVideo.fps === recommended.fps)
  ) {
    return null
  }
  // A stream never goes out above the provider-safe rate, whatever the
  // recording preset of that size uses.
  return {
    kind: 'step-down',
    requested: streamVideo,
    video: { ...recommended, bitrateKbps: Math.min(recommended.bitrateKbps, 6000) }
  }
}

/**
 * The same destinations at the stepped-down profile, for one session. Every
 * enabled landscape destination gets the profile explicitly, so no
 * per-destination or provider default can pull one of them back up. Saved
 * settings are never written.
 */
export function streamingAtSteppedDownProfile(
  streaming: StreamingSettings,
  video: VideoSettings
): StreamingSettings {
  return {
    ...streaming,
    defaultOutputPreset: video.preset,
    defaultBitrateKbps: video.bitrateKbps,
    targets: streaming.targets.map((target) =>
      target.enabled && target.outputOrientation !== 'vertical'
        ? { ...target, outputPreset: video.preset, outputBitrateKbps: video.bitrateKbps }
        : target
    )
  }
}
