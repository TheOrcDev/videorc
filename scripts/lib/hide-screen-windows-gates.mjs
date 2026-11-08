// Pure gates for the Windows Hide screen smoke (issue #1088, plan 210 D8):
// which screen source it may run on, which refusals are a named SKIP rather
// than a FAIL, which recording path the session took, and the verdict over
// every output leg. The frame-level judgement is the macOS smoke's own
// (`hideSpanVerdict` in smart-scenes-gate.mjs), so both platforms are held to
// one bar.

/** A DXGI display id as devices.list lists it on Windows. */
export const WINDOWS_DXGI_SCREEN_ID = /^screen:dxgi:[0-9a-f]+:\d+$/i

/**
 * Desktop Duplication refusals that mean "this process may not read the
 * desktop" rather than "Hide screen is broken": E_ACCESSDENIED (an agent or
 * service session, a secure desktop), DXGI_ERROR_NOT_CURRENTLY_AVAILABLE
 * (another app holds every duplication slot) and DXGI_ERROR_SESSION_DISCONNECTED
 * (a locked or disconnected RDP session).
 */
const DXGI_REFUSALS = [
  { pattern: /0x80070005|E_ACCESSDENIED|access is denied|access denied/i, code: '0x80070005' },
  {
    pattern: /0x887A0022|DXGI_ERROR_NOT_CURRENTLY_AVAILABLE/i,
    code: '0x887A0022'
  },
  {
    pattern: /0x887A0026|DXGI_ERROR_SESSION_DISCONNECTED/i,
    code: '0x887A0026'
  }
]

/**
 * The Desktop Duplication refusal named in `text`, or null.
 * @param {string|null|undefined} text
 * @returns {string|null} the HRESULT, e.g. "0x80070005"
 */
export function dxgiRefusalCode(text) {
  if (!text) return null
  return DXGI_REFUSALS.find(({ pattern }) => pattern.test(String(text)))?.code ?? null
}

/**
 * The DXGI display the smoke records, or a named SKIP. gdigrab is never a
 * stand-in: a session that reads the desktop through FFmpeg itself refuses
 * Hide screen by design (SCREEN_HIDE_UNAVAILABLE_LEGACY), so it proves
 * nothing about the frost.
 * @param {Array<{id:string,kind:string,status:string,name?:string,detail?:string}>} devices
 * @returns {{screen:object|null, skip:{reason:string, flag:string}|null}}
 */
export function selectWindowsHideScreen(devices) {
  const screens = (devices ?? []).filter((device) => device?.kind === 'screen')
  const dxgi = screens.filter((device) => WINDOWS_DXGI_SCREEN_ID.test(String(device.id)))
  const available = dxgi.find((device) => device.status === 'available')
  if (available) return { screen: available, skip: null }
  if (dxgi.length > 0) {
    const first = dxgi[0]
    const code = dxgiRefusalCode(first.detail)
    return {
      screen: null,
      skip: {
        reason: `the DXGI display ${first.id} is ${first.status}${code ? ` (${code})` : ''}: ${first.detail ?? 'no detail'}`,
        flag: code ? `dxgi-refused-${code}` : 'dxgi-unavailable'
      }
    }
  }
  const legacy = screens.find((device) => device.id === 'screen:gdigrab:desktop')
  return {
    screen: null,
    skip: {
      reason: legacy
        ? 'devices.list offers only the gdigrab desktop; Hide screen needs a DXGI display (a gdigrab session refuses it by design)'
        : 'devices.list offers no screen at all',
      flag: 'no-dxgi-display'
    }
  }
}

/**
 * A screen preview that did not go live: a named SKIP when Desktop
 * Duplication refused this process, otherwise null (the caller fails).
 * @param {{state?:string,message?:string|null}|null} status
 * @returns {{reason:string, flag:string}|null}
 */
export function windowsScreenStartSkip(status) {
  if (!status || status.state === 'live') return null
  const code = dxgiRefusalCode(status.message)
  if (!code) return null
  return {
    reason: `DXGI Desktop Duplication refused this process (${code}) with the screen ${status.state}: ${status.message}. Run the smoke from an interactive desktop session (the user's own terminal), not an agent or service session.`,
    flag: `dxgi-refused-${code}`
  }
}

/**
 * Which compositor and encoder path the record+stream session took, from
 * `diagnostics.stats`: the direct D3D11/Media Foundation path or the CPU
 * compositor and FFmpeg bridge. Both must hold the frost; the summary names
 * which one this run proved.
 *
 * `d3d11Skip` names why the D3D11 path was not proven when the session fell
 * back because Desktop Duplication refused this process (an agent or
 * service session): the CPU legs are still judged, and the D3D11 path is a
 * named SKIP, never a silent pass.
 * @returns {{path:'d3d11-media'|'cpu-bridge', captureBackend:string|null, mediaState:string|null,
 *   fallbackReason:string|null, d3d11Skip:{reason:string, flag:string}|null}}
 */
export function windowsHideSessionPath(diagnostics) {
  const media = diagnostics?.windowsD3d11Media ?? null
  const d3d11 =
    diagnostics?.encoderBridgeEncodedOutputInputSubtype === 'NV12-D3D11' ||
    (media?.state === 'live' && (media.encoderGpuSamples ?? 0) > 0)
  const fallbackReason = d3d11 ? null : (media?.fallbackReason ?? null)
  const code = dxgiRefusalCode(fallbackReason)
  return {
    path: d3d11 ? 'd3d11-media' : 'cpu-bridge',
    captureBackend: media?.captureBackend ?? null,
    mediaState: media?.state ?? null,
    fallbackReason,
    d3d11Skip: code
      ? {
          reason: `the D3D11 media path fell back because Desktop Duplication refused this process (${code}): ${fallbackReason}. Run the smoke from an interactive desktop session to prove that path.`,
          flag: `d3d11-dxgi-refused-${code}`
        }
      : null
  }
}

/**
 * Aligns one decoded file to wall time on the fixture's flashes
 * (`wall = pts + offsetMs`). The start flash anchors; the end flash measures
 * drift. A file holding a single white run is anchored on the end flash only
 * when, anchored on the start, the end flash would fall past the file's last
 * frame (a clip that begins after the start flash). Otherwise the end flash
 * was missed (a capture slower than the flash) and the start anchor stands,
 * with `endSeen: false`.
 *
 * @param {(features:object[], ptsMs:number[], flashWallMs:number, options?:{afterPtsMs?:number})=>({offsetMs:number,frameIndex:number}|null)} anchorFromFlash
 * @param {object[]} features
 * @param {number[]} ptsMs
 * @param {Array<{label:string, drawnAtMs:number}>} flashes
 * @returns {{anchor:{offsetMs:number,frameIndex:number,by:'start'|'end'}|null, anchorDriftMs:number|null, endSeen:boolean}}
 */
export function anchorHideFile(anchorFromFlash, features, ptsMs, flashes) {
  const start = flashes.find((flash) => flash.label === 'start')
  const end = flashes.find((flash) => flash.label === 'end')
  const first = start ? anchorFromFlash(features, ptsMs, start.drawnAtMs) : null
  if (!first) return { anchor: null, anchorDriftMs: null, endSeen: false }
  if (!end) return { anchor: { ...first, by: 'start' }, anchorDriftMs: null, endSeen: false }
  const gapMs = end.drawnAtMs - start.drawnAtMs
  const firstPts = ptsMs[first.frameIndex]
  const endAnchor = anchorFromFlash(features, ptsMs, end.drawnAtMs, {
    afterPtsMs: firstPts + Math.min(1000, gapMs / 2)
  })
  if (endAnchor)
    return {
      anchor: { ...first, by: 'start' },
      anchorDriftMs: Math.round(endAnchor.offsetMs - first.offsetMs),
      endSeen: true
    }
  const lastPts = Math.max(...ptsMs.filter((pts) => Number.isFinite(pts)))
  if (firstPts + gapMs > lastPts) {
    // The end flash would lie past the file: this white run is the end flash.
    const byEnd = anchorFromFlash(features, ptsMs, end.drawnAtMs)
    return { anchor: byEnd ? { ...byEnd, by: 'end' } : null, anchorDriftMs: null, endSeen: true }
  }
  return { anchor: { ...first, by: 'start' }, anchorDriftMs: null, endSeen: false }
}

/**
 * The hide-span budget for a file whose picture changes `liveFps` times a
 * second. The flashes align a file only to within one capture interval (the
 * first white frame lands up to an interval after the flash was drawn), so
 * every frame's wall time can read up to one interval early. The slack
 * before Show grows to that interval; the frost must still cover every frame
 * of the span outside the edges, and `hideEdgeMs` is never shortened.
 * @param {typeof import('./smart-scenes-gate.mjs').SMART_SCENES_BUDGET} budget
 * @param {number|null} liveFps
 */
export function captureAlignedHideBudget(budget, liveFps) {
  if (!(liveFps > 0)) return { ...budget, captureIntervalMs: null }
  const captureIntervalMs = Math.ceil(1000 / liveFps)
  return {
    ...budget,
    captureIntervalMs,
    showSlackMs: Math.max(budget.showSlackMs, captureIntervalMs)
  }
}

/**
 * The program's real picture cadence: distinct (non-repeated) frames per
 * second over the frames before `untilPts`. A capture slower than the
 * canvas shows as repeats; the summary names it so a slow capture is never
 * mistaken for a frozen one.
 */
export function distinctFrameRate(features, ptsMs, { untilPts = Number.POSITIVE_INFINITY } = {}) {
  const inside = features.filter((feature) => {
    const pts = ptsMs[feature.index]
    return Number.isFinite(pts) && pts < untilPts
  })
  if (inside.length < 2) return null
  const spanMs = ptsMs[inside.at(-1).index] - ptsMs[inside[0].index]
  if (!(spanMs > 0)) return null
  const distinct = inside.slice(1).filter((feature) => !feature.repeated).length
  return Number(((distinct * 1000) / spanMs).toFixed(1))
}

/**
 * The step's verdict over every output leg. A leg is `{ok, skipped?,
 * reason?, failures}`; a skipped leg names its reason and never passes
 * silently, and the recording, the stream and the clip may never be skipped.
 * @param {Record<string, {ok:boolean, skipped?:boolean, reason?:string, failures?:string[]}>} outputs
 * @param {{hiddenReason?:string|null}} [context]
 */
export function windowsHideOutputsVerdict(outputs, { hiddenReason = 'you' } = {}) {
  const failures = []
  for (const required of ['recording', 'stream', 'clip']) {
    const output = outputs?.[required]
    if (!output) failures.push(`${required}: not analysed`)
    else if (output.skipped) failures.push(`${required}: skipped, but it is never optional`)
    else if (!output.ok) failures.push(`${required}: ${(output.failures ?? []).join('; ')}`)
  }
  for (const [name, output] of Object.entries(outputs ?? {})) {
    if (['recording', 'stream', 'clip'].includes(name)) continue
    if (output.skipped) {
      if (!output.reason) failures.push(`${name}: skipped without a reason`)
    } else if (!output.ok) failures.push(`${name}: ${(output.failures ?? []).join('; ')}`)
  }
  if (hiddenReason !== 'you')
    failures.push(`hidden reason "${hiddenReason}", expected "you" (a manual hide)`)
  return { ok: failures.length === 0, failures }
}
