import type {
  PerformanceCheckProgress,
  PerformanceCheckResult,
  PerformanceCheckRunParams,
  PerformanceCheckState,
  VideoPreset,
  VideoSettings
} from '../../../shared/backend'
import { videoPresets } from './capture'
import { formatVideoQuality } from './format-video'

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
 * When the next take also writes the Screen and Camera files, the check is
 * told so and counts their encoders (plan 200 D4).
 */
export function performanceCheckCeiling(
  selected: VideoSettings,
  display?: { width: number; height: number },
  separateSourceRecordings = false
): PerformanceCheckRunParams {
  const ceilingFps = Math.max(30, selected.fps)
  const separate = separateSourceRecordings ? { separateSourceRecordings: true } : {}
  if (!display || pixels(display) <= pixels(selected)) {
    return { ceilingWidth: selected.width, ceilingHeight: selected.height, ceilingFps, ...separate }
  }
  if (pixels(display) > MAX_CEILING_PIXELS) {
    return { ceilingWidth: 3840, ceilingHeight: 2160, ceilingFps, ...separate }
  }
  return {
    ceilingWidth: Math.round(display.width),
    ceilingHeight: Math.round(display.height),
    ceilingFps,
    ...separate
  }
}

/**
 * Linux v1 `belowFloor` + every measured rung `did-not-start` is a failed
 * ladder, not a machine class (ogre / Omarchy 2026-09-28). Do not apply it
 * or show "too heavy" from it; `shouldRunPerformanceCheck` asks for a new one.
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

/**
 * Plan 212 D1: the check runs once per machine, never at launch and never
 * after an update. First-run setup starts it as it opens, behind the setup
 * card, so the Studio's Preview never shows the measurement; otherwise only
 * Recording → Output's "Check this computer" does. A replay of setup (from
 * Settings) is not a first run. A take that is running keeps its studio: the
 * default Clips ring is replay-only and not a take, so it does not count.
 */
export function firstRunSetupStartsPerformanceCheck(
  mode: { kind: string },
  state: PerformanceCheckState | undefined,
  sessionActive: boolean
): boolean {
  return mode.kind === 'first-run' && !sessionActive && shouldRunPerformanceCheck(state)
}

/**
 * Plan 212 S5: the words under the Preview while a check runs. The backend
 * holds the Preview's last picture for the whole check, so this says why it
 * stopped moving: "Checking this computer · 2 of 3", then nothing.
 */
export function previewHoldLabel(
  state: PerformanceCheckState | undefined,
  progress: PerformanceCheckProgress | null
): string | null {
  if (!state?.running) {
    return null
  }
  return progress && progress.rungCount > 0
    ? `Checking this computer · ${progress.rungIndex + 1} of ${progress.rungCount}`
    : 'Checking this computer'
}

/** "1080p · 30 fps": the one video spelling (plan 174 S1.4). */
export function outputLabel(video: Pick<VideoSettings, 'width' | 'height' | 'fps'>): string {
  return formatVideoQuality(video)
}

/** Toast for a user-chosen output this computer measurably cannot hold. */
export function performanceCheckTooHeavyToast(
  chosen: VideoSettings,
  result: PerformanceCheckResult
): { title: string; description: string; actionLabel: string; preset: VideoPreset } | undefined {
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
    description: `Recordings will stutter. ${outputLabel(result.recommended)} held steady.`,
    actionLabel: `Use ${outputLabel(result.recommended)}`,
    preset: result.recommended.preset
  }
}
