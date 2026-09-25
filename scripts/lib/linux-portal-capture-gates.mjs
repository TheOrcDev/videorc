// Pure gates for the Linux portal screen-capture smoke (Plan 0006, L4), so
// the state model the box run asserts is unit-tested off the box.

export const PORTAL_MONITOR_SOURCE_ID = 'screen:portal:monitor'
export const PORTAL_WINDOW_SOURCE_ID = 'window:portal:window'

/**
 * The device list on Linux must carry exactly one portal monitor entry and
 * one portal window entry, both available on a working desktop session.
 */
export function assessPortalDeviceList(devices) {
  const failures = []
  const monitor = devices.find((device) => device.id === PORTAL_MONITOR_SOURCE_ID)
  const windowEntry = devices.find((device) => device.id === PORTAL_WINDOW_SOURCE_ID)
  if (!monitor) failures.push(`devices.list lacks ${PORTAL_MONITOR_SOURCE_ID}`)
  else if (monitor.kind !== 'screen')
    failures.push(`${PORTAL_MONITOR_SOURCE_ID} kind=${monitor.kind}`)
  if (!windowEntry) failures.push(`devices.list lacks ${PORTAL_WINDOW_SOURCE_ID}`)
  else if (windowEntry.kind !== 'window') {
    failures.push(`${PORTAL_WINDOW_SOURCE_ID} kind=${windowEntry.kind}`)
  }
  for (const entry of [monitor, windowEntry]) {
    if (entry && entry.status !== 'available') {
      failures.push(`${entry.id} status=${entry.status}: ${entry.detail ?? ''}`)
    }
  }
  return { ok: failures.length === 0, failures }
}

/**
 * The terminal preview.screen state must be one of the named portal
 * outcomes, never a silent black frame: `live` with frames, or a permission /
 * missing-source state whose message names the portal.
 *
 * `expect` is 'granted' (a tester clicked Share, or a restore token was
 * redeemed) or 'any' (an unattended run accepts a truthful refusal too).
 */
export function assessPortalScreenStatus(status, { expect = 'granted', minFrames = 5 } = {}) {
  const failures = []
  const state = status?.state
  const message = status?.message ?? ''
  if (state === 'live') {
    if ((status.framesCaptured ?? 0) < minFrames) {
      failures.push(`live with framesCaptured=${status.framesCaptured ?? 0} < ${minFrames}`)
    }
    if (!(status.width > 0 && status.height > 0)) {
      failures.push(`live without dimensions (${status.width}x${status.height})`)
    }
    if (!/portal/i.test(message))
      failures.push(`live message does not name the portal: "${message}"`)
    return { ok: failures.length === 0, failures, outcome: 'granted' }
  }
  const refusal =
    state === 'permission-needed' ? 'cancelled' : state === 'source-missing' ? 'missing' : null
  if (!refusal) {
    failures.push(`unexpected preview.screen state ${state}: "${message}"`)
    return { ok: false, failures, outcome: 'failed' }
  }
  if (!/portal|share|compositor/i.test(message)) {
    failures.push(`${state} message does not name the reason: "${message}"`)
  }
  if (expect === 'granted') {
    failures.push(`expected a granted portal stream, got ${state}: "${message}"`)
  }
  return { ok: failures.length === 0, failures, outcome: refusal }
}
