// Preview/recording frame-parity check.
//
// The shared compositor is the single source of program frames: the recording encoder bridge
// consumes the *latest* composited frame (paced by the output clock), and the preview presents
// composited frames too. So a preview that stays within a small frame budget of the latest
// composited frame is in lockstep with what recording is encoding, and a divergent scene
// revision means the preview is showing a different committed scene than the recording.
//
// This formalizes the plan's parity acceptance: fail if preview is *consistently* behind the
// encoded frames, or if preview and recording reference different scene revisions.

export const DEFAULT_MAX_PREVIEW_LAG_FRAMES = 3

/** Evaluate parity for a single diagnostics sample. */
export function evaluatePreviewRecordingParity(sample = {}, options = {}) {
  const maxLagFrames = options.maxLagFrames ?? DEFAULT_MAX_PREVIEW_LAG_FRAMES
  const reasons = []

  const lagFrames =
    typeof sample.previewCompositorFrameLag === 'number' ? sample.previewCompositorFrameLag : null
  const previewRevision = sample.previewSceneRevision ?? sample.activeSceneRevision ?? null
  const recordingRevision = sample.recordingSceneRevision ?? sample.activeSceneRevision ?? null

  const revisionMismatch =
    previewRevision != null && recordingRevision != null && previewRevision !== recordingRevision
  if (revisionMismatch) {
    reasons.push(
      `preview scene revision ${previewRevision} != recording scene revision ${recordingRevision}`
    )
  }

  const lagExceeded = lagFrames != null && lagFrames > maxLagFrames
  if (lagExceeded) {
    reasons.push(
      `preview is ${lagFrames} frame(s) behind the composited frame recording encodes (budget ${maxLagFrames})`
    )
  }

  const measured = lagFrames != null || previewRevision != null
  return {
    measured,
    inParity: measured && !revisionMismatch && !lagExceeded,
    lagFrames,
    revisionMismatch,
    reasons
  }
}

/**
 * Summarize parity over a window of samples. In parity only if no sample has a scene-revision
 * mismatch and the preview is not *consistently* behind (a one-off spike over budget is
 * tolerated; a majority of samples over budget is not).
 */
export function summarizePreviewRecordingParity(samples = [], options = {}) {
  const maxLagFrames = options.maxLagFrames ?? DEFAULT_MAX_PREVIEW_LAG_FRAMES
  const behindRatioLimit = options.behindRatioLimit ?? 0.5

  const evaluated = samples
    .map((sample) => evaluatePreviewRecordingParity(sample, { maxLagFrames }))
    .filter((result) => result.measured)

  if (evaluated.length === 0) {
    return {
      measured: false,
      inParity: false,
      sampleCount: 0,
      maxLagFrames: null,
      revisionMismatches: 0,
      behindRatio: 0,
      reasons: ['no measured parity samples']
    }
  }

  const maxLag = evaluated.reduce((max, result) => Math.max(max, result.lagFrames ?? 0), 0)
  const revisionMismatches = evaluated.filter((result) => result.revisionMismatch).length
  const behind = evaluated.filter((result) => (result.lagFrames ?? 0) > maxLagFrames).length
  const behindRatio = behind / evaluated.length
  const consistentlyBehind = behindRatio > behindRatioLimit

  const reasons = []
  if (revisionMismatches > 0) {
    reasons.push(`${revisionMismatches} sample(s) had a preview/recording scene-revision mismatch`)
  }
  if (consistentlyBehind) {
    reasons.push(
      `preview was over the ${maxLagFrames}-frame lag budget in ${Math.round(behindRatio * 100)}% of samples`
    )
  }

  return {
    measured: true,
    inParity: revisionMismatches === 0 && !consistentlyBehind,
    sampleCount: evaluated.length,
    maxLagFrames: maxLag,
    revisionMismatches,
    behindRatio,
    reasons
  }
}
