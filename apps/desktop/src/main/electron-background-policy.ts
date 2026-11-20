export type ElectronWindowRole =
  | 'main'
  | 'preview'
  | 'notes'
  | 'comments'
  | 'captions'
  | 'proof-surface'
  | 'scene-hud'

export type ElectronBackgroundPolicy = 'scoped' | 'legacy-unthrottled'

export function electronBackgroundPolicyFromEnv(
  env: Partial<Pick<NodeJS.ProcessEnv, 'VIDEORC_ELECTRON_BACKGROUND_POLICY'>>
): ElectronBackgroundPolicy {
  return env.VIDEORC_ELECTRON_BACKGROUND_POLICY === 'legacy-unthrottled'
    ? 'legacy-unthrottled'
    : 'scoped'
}

/**
 * Main owns capture orchestration and the detached preview must keep presenting
 * while occluded. Auxiliary text windows consume pushed snapshots and can use
 * Chromium's normal background scheduling policy. The key HUD (plan 231 D20)
 * times its hold and fade while another app is in front, so it is never
 * throttled either.
 */
export function backgroundThrottlingFor(
  role: ElectronWindowRole,
  policy: ElectronBackgroundPolicy = 'scoped'
): boolean {
  return (
    policy !== 'legacy-unthrottled' && role !== 'main' && role !== 'preview' && role !== 'scene-hud'
  )
}

/**
 * The global occlusion switches exist for the detached macOS CAMetalLayer path.
 * Windows uses the bounded Electron proof surface and must retain Chromium's
 * normal process-wide background policy.
 */
export function shouldDisableOcclusionThrottling(
  platform: NodeJS.Platform,
  policy: ElectronBackgroundPolicy = 'scoped'
): boolean {
  return policy === 'legacy-unthrottled' || platform === 'darwin'
}
