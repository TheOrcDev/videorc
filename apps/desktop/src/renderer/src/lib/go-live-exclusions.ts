import type { StreamingSettings } from './backend'

// "Go live without {destination}" is for this livestream only (plan 174 S3.4,
// B-8). It used to switch the destination off in the saved settings, so the
// next Go Live silently skipped it too. Now the Go Live dialog keeps a list of
// destinations left out of this attempt, and every step of the start (the
// preflight, the output check, platform setup, the start itself) sends the
// saved settings minus that list. Nothing here is ever written back.

/**
 * The livestream this Go Live sends: `streaming` with the left-out
 * destinations off, exactly as switching them off would (the `enabled` flag
 * and `enabledTargetIds`, which the backend's preflight both reads). Returns
 * the same object when nothing is left out, and never mutates its input.
 */
export function streamingWithoutTargets(
  streaming: StreamingSettings,
  excludedTargetIds: readonly string[]
): StreamingSettings {
  if (excludedTargetIds.length === 0) return streaming
  const excluded = new Set(excludedTargetIds)
  const targets = streaming.targets.map((target) =>
    excluded.has(target.id) && target.enabled ? { ...target, enabled: false } : target
  )
  const enabledTargetIds = streaming.enabledTargetIds.filter((id) => !excluded.has(id))
  return {
    ...streaming,
    targets,
    enabled: enabledTargetIds.length > 0,
    mode: enabledTargetIds.length > 1 ? 'multi' : 'single',
    enabledTargetIds
  }
}

/** The exclusion list after a "Go live without" (add) or an "Add back" (remove). */
export function updateGoLiveExclusions(
  excludedTargetIds: readonly string[],
  targetId: string,
  excluded: boolean
): readonly string[] {
  const has = excludedTargetIds.includes(targetId)
  if (excluded === has) return excludedTargetIds
  return excluded
    ? [...excludedTargetIds, targetId]
    : excludedTargetIds.filter((id) => id !== targetId)
}
