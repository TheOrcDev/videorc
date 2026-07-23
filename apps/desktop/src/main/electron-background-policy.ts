export type ElectronWindowRole =
  | 'main'
  | 'preview'
  | 'notes'
  | 'comments'
  | 'captions'
  | 'proof-surface'

/**
 * Main owns capture orchestration and the detached preview must keep presenting
 * while occluded. Auxiliary text windows consume pushed snapshots and can use
 * Chromium's normal background scheduling policy.
 */
export function backgroundThrottlingFor(role: ElectronWindowRole): boolean {
  return role !== 'main' && role !== 'preview'
}

/**
 * The global occlusion switches exist for the detached macOS CAMetalLayer path.
 * Windows uses the bounded Electron proof surface and must retain Chromium's
 * normal process-wide background policy.
 */
export function shouldDisableOcclusionThrottling(platform: NodeJS.Platform): boolean {
  return platform === 'darwin'
}
