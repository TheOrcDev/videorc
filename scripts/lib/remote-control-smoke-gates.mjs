export function syntheticCompositorReady(compositor, before = {}) {
  const sameRun =
    typeof compositor?.runId === 'string' &&
    compositor.runId.length > 0 &&
    compositor.runId === before?.runId
  const frameAdvanced = sameRun
    ? (compositor.framesRendered ?? 0) > (before?.framesRendered ?? 0)
    : (compositor?.framesRendered ?? 0) > 0

  return Boolean(
    compositor?.state === 'live' &&
    frameAdvanced &&
    compositor.sceneRevision != null &&
    compositor.frameSceneRevision === compositor.sceneRevision &&
    compositor.sceneSources?.some(
      (source) => source?.id === 'source:test-pattern' || source?.kind === 'test-pattern'
    )
  )
}

// The software encoder guard's refusal (plan 181: `replay_buffer::
// auto_start_refusal`). The ring never runs on its own on a raw CPU encode
// path (OpenH264, software Media Foundation, x264), and `replay.status`
// carries the reason; the user can still turn Clips on.
export const SOFTWARE_ENCODER_GUARD_PREFIX = 'This computer encodes video on its processor'

/**
 * The default ring at launch: `on`, or `guarded` with the guard's reason
 * (off by design on this host), or null while it is still settling. Any
 * other `off` (no reason, a failed start) is not an answer: the smoke keeps
 * waiting and fails on its deadline with the last status.
 */
export function defaultRingVerdict(ring) {
  if (ring?.state === 'on') return { kind: 'on' }
  if (
    ring?.state === 'off' &&
    typeof ring.reason === 'string' &&
    ring.reason.startsWith(SOFTWARE_ENCODER_GUARD_PREFIX)
  ) {
    return { kind: 'guarded', reason: ring.reason }
  }
  return null
}
