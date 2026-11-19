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

// Plan 230: the Stream Manager Screen key's tap refusal in a Wayland session
// (studio-actions/copy.ts). Wayland drops every window position, so the tap
// does nothing there; only the hold works.
export const STREAM_MANAGER_WAYLAND_REFUSAL =
  "Wayland doesn't let Videorc move windows. Hold the key to bring the Stream Manager up."

/**
 * What the smoke can check of the Screen key's tap on this host, from what
 * the app reports in `remote.describe` (`screenMoves`, from Electron's
 * resolved ozone platform) and the screen count: `move` with two screens
 * where the tap moves the window, `wayland` with two screens in a Wayland
 * session (the tap must be refused with the Wayland copy), `one-screen`
 * otherwise. Anything but `supported` or `wayland` is a projection bug: null.
 * Wayland is a Linux session only, so `wayland` reported on another platform
 * is a projection bug too (null), never a licence to skip the move check.
 */
export function streamManagerScreenKeyPlan(describe, platform = process.platform) {
  const moves = describe?.screenMoves
  if (moves !== 'supported' && moves !== 'wayland') return null
  if (moves === 'wayland' && platform !== 'linux') return null
  const count = Array.isArray(describe?.screens) ? describe.screens.length : 0
  if (count < 2) return 'one-screen'
  return moves === 'wayland' ? 'wayland' : 'move'
}
