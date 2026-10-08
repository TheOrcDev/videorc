// Chromium features the Electron main process disables at startup.
//
// Plan 069 (system audio), decision 9 as amended by the S0 spike: on macOS,
// Chromium plays renderer audio (Library playback, Golem's voice, UI sounds)
// from an out-of-process audio service helper that ScreenCaptureKit neither
// lists nor attributes to Videorc, so the backend's own-app exclusion cannot
// keep that audio out of recordings. Disabling AudioServiceOutOfProcess moves
// the audio service into the main process, which the backend excludes by its
// parent pid. Evidence: docs/acceptance/2026-09-27-system-audio-spike.md (Q5).

export const DISABLE_FEATURES_SWITCH = 'disable-features'

export function chromiumFeaturesToDisable(platform: NodeJS.Platform): string[] {
  return platform === 'darwin' ? ['AudioServiceOutOfProcess'] : []
}

/**
 * Merges `additions` into an existing comma-separated `disable-features`
 * value. Chromium honours only one value for the switch, so appending a
 * second one would silently drop whatever a harness or user passed.
 * Returns undefined when there is nothing to add.
 */
export function mergeDisabledFeatures(
  existing: string,
  additions: readonly string[]
): string | undefined {
  const current = existing
    .split(',')
    .map((feature) => feature.trim())
    .filter((feature) => feature.length > 0)
  const missing = additions.filter((feature) => !current.includes(feature))
  if (missing.length === 0) return undefined
  return [...current, ...missing].join(',')
}
