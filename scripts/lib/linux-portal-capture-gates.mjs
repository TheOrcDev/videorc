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

/**
 * Phase D: a granted portal stream plus ScreenOnly must feed the Linux
 * Electron CPU/BMP proof surface. Synthetic stripes with compositorState
 * stopped is the failure ogre hit after PR #435.
 */
export function assessPortalPreviewProof({ compositor, surface } = {}) {
  const failures = []
  const compositorState = compositor?.state
  if (compositorState !== 'live') {
    failures.push(
      `compositorState=${compositorState ?? 'missing'} (proof path must run, not stay stopped)`
    )
  }
  if (!(compositor?.runId || compositor?.run_id)) {
    failures.push('compositor runId is missing')
  }
  const surfaceSource = surface?.source ?? surface?.surfaceSource
  if (!surfaceSource || surfaceSource === 'synthetic') {
    failures.push(
      `surfaceSource=${surfaceSource ?? 'missing'} (must be screen/window, not synthetic)`
    )
  }
  if (surface?.sourcePixelsPresent !== true) {
    failures.push(
      `sourcePixelsPresent=${String(surface?.sourcePixelsPresent)} (portal pixels required)`
    )
  }
  const transport = surface?.transport
  if (transport && transport !== 'electron-proof-surface') {
    failures.push(`transport=${transport} (Linux proof must stay electron-proof-surface)`)
  }
  const backing = surface?.backing
  if (backing && backing !== 'electron-browser-window') {
    failures.push(`backing=${backing} claims a native surface`)
  }
  const hostKind = surface?.nativePreviewHostKind
  if (hostKind && hostKind !== 'proof-surface') {
    failures.push(`nativePreviewHostKind=${hostKind} claims a native host`)
  }
  const sceneSources = compositor?.sceneSources ?? compositor?.scene_sources ?? []
  const portalLayer = sceneSources.find(
    (source) =>
      source?.visible &&
      (source.kind === 'screen' || source.kind === 'window') &&
      String(source.deviceId ?? source.device_id ?? source.id ?? '').includes(':portal:')
  )
  if (!portalLayer) {
    failures.push('compositor sceneSources lack a visible portal screen/window layer')
  }
  return { ok: failures.length === 0, failures }
}
