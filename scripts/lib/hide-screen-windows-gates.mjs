// Pure gates for the Windows Hide screen smoke (issue #1088, plan 210 D8):
// which screen source it may run on, which refusals are a named SKIP rather
// than a FAIL, which recording path the session took, and the verdict over
// every output leg. The frame-level judgement is the macOS smoke's own
// (`hideSpanVerdict` in smart-scenes-gate.mjs), so both platforms are held to
// one bar.

import { SHARP_HIDDEN_MAX } from './smart-scenes-gate.mjs'

/** A DXGI display id as devices.list lists it on Windows. */
export const WINDOWS_DXGI_SCREEN_ID = /^screen:dxgi:[0-9a-f]+:\d+$/i

/**
 * Desktop Duplication refusals that mean "this process may not read the
 * desktop" rather than "Hide screen is broken": E_ACCESSDENIED (the display
 * is off or the session is locked, when Windows refuses every process, as
 * issue #1088 measured with FFmpeg's ddagrab; or a service session), DXGI_ERROR_NOT_CURRENTLY_AVAILABLE
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

/** What to do about a refusal: the cause is almost always the display. */
export const DXGI_REFUSAL_HINT =
  'Windows refuses Desktop Duplication to every process while the display is off or the session is locked: wake and unlock the screen and run again (the smoke keeps an awake display on, but cannot wake one).'

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
    reason: `DXGI Desktop Duplication refused this process (${code}) with the screen ${status.state}: ${status.message}. ${DXGI_REFUSAL_HINT}`,
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
          reason: `the D3D11 media path fell back because Desktop Duplication refused this process (${code}): ${fallbackReason}. ${DXGI_REFUSAL_HINT} The CPU-bridge legs are still judged.`,
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
 * The most a frost may read ahead of the hide press before the file's
 * alignment, not the capture's latency, is the likelier cause (issue #1329
 * measured 140 to 170 ms on a D3D11 Desktop Duplication session).
 */
export const FROST_LEAD_MAX_MS = 500

/**
 * How far ahead of the hide press the frost reads in this file's flash-aligned
 * wall time (issue #1329). The flashes date a frame by the live content in it,
 * which reaches the file a capture latency after it was drawn; the frost is
 * built at the capture source from the latest frame and has no such latency.
 * So the frost reads early by that latency less the hide's own delay, and it
 * cannot really precede the press: a positive lead is the alignment's error,
 * measured. The Show edge is published the same way (the held live frame goes
 * back into the store at the press), so its live frames read early by the same
 * amount.
 *
 * The frost run is the run of frosted frames around the middle of the hidden
 * span, walked back to its first frame. `null` when the middle is not frosted
 * (the verdict names that as a leak on its own).
 * @returns {number|null} ms the run's first frame reads before `hideAtMs`
 *   (negative when it lands after the press)
 */
export function frostLeadMs({
  features,
  ptsMs,
  offsetMs,
  hideAtMs,
  showAtMs,
  sharpHiddenMax = SHARP_HIDDEN_MAX
}) {
  const middle = (hideAtMs + showAtMs) / 2
  const ordered = (features ?? [])
    .filter((feature) => Number.isFinite(ptsMs[feature.index]))
    .sort((a, b) => ptsMs[a.index] - ptsMs[b.index])
  let at = ordered.findIndex((feature) => ptsMs[feature.index] + offsetMs >= middle)
  if (at < 0 || !(ordered[at].sharp <= sharpHiddenMax)) return null
  while (at > 0 && ordered[at - 1].sharp <= sharpHiddenMax) at -= 1
  return Math.round(hideAtMs - (ptsMs[ordered[at].index] + offsetMs))
}

/**
 * The hide-span budget for a file whose picture changes `liveFps` times a
 * second. The flashes align a file only to within one capture interval (the
 * first white frame lands up to an interval after the flash was drawn), so
 * every frame's wall time can read up to one interval early. The slack
 * before Show grows to that interval; the frost must still cover every frame
 * of the span outside the edges, and `hideEdgeMs` is never shortened.
 *
 * With `frostLeadMs` (issue #1329), the slack also grows to the measured lead
 * plus the hide's cover time (press to the backend's `screen.privacy.changed`,
 * sent once the stills are in the stores; the lead took that delay off, and
 * Show has none: the held live frame goes back at once) plus one canvas frame
 * (the compositor samples each edge on its own tick). That bounds the
 * un-frost against the Show press on the file's own clock, on either capture
 * path: a frost lifted more than about two frames before Show is still a
 * leak, whatever the capture latency.
 * @param {typeof import('./smart-scenes-gate.mjs').SMART_SCENES_BUDGET} budget
 * @param {number|null} liveFps
 * @param {{frostLeadMs?:number|null, canvasFrameMs?:number, hideCoverMs?:number|null}} [edge]
 */
export function captureAlignedHideBudget(
  budget,
  liveFps,
  { frostLeadMs = null, canvasFrameMs = 0, hideCoverMs = 0 } = {}
) {
  const captureIntervalMs = liveFps > 0 ? Math.ceil(1000 / liveFps) : null
  const frostAlignedSlackMs =
    frostLeadMs != null
      ? Math.ceil(Math.max(0, frostLeadMs + canvasFrameMs + Math.max(0, hideCoverMs ?? 0)))
      : null
  const out = {
    ...budget,
    captureIntervalMs,
    showSlackMs: Math.max(budget.showSlackMs, captureIntervalMs ?? 0, frostAlignedSlackMs ?? 0)
  }
  if (frostLeadMs != null) out.frostLeadMs = frostLeadMs
  return out
}

/**
 * The session's frost lead: the largest of the legs' leads within
 * `FROST_LEAD_MAX_MS`. The legs read one compositor, so the frost reached it
 * no later than the earliest leg shows it; a leg that shows it later only
 * repeated its last live frame (issue #1329's CPU-bridge stream leg). Null
 * when no leg measured one.
 * @param {Array<number|null|undefined>} leads
 */
export function sessionFrostLeadMs(leads) {
  const usable = (leads ?? []).filter((lead) => Number.isFinite(lead) && lead <= FROST_LEAD_MAX_MS)
  return usable.length ? Math.max(...usable) : null
}

/**
 * How long the backend took to cover the stores after the hide press: the
 * first `screen.privacy.changed` saying hidden at or after `hideAtMs`, which
 * `screen.hide` emits only once its stills are published. Null when no such
 * event arrived.
 * @param {Array<{event:string, payload?:{hidden?:boolean}, atMs:number}>} events
 * @param {number} hideAtMs
 */
export function hideCoverMs(events, hideAtMs) {
  const changed = (events ?? []).find(
    (entry) =>
      entry?.event === 'screen.privacy.changed' &&
      entry.payload?.hidden === true &&
      entry.atMs >= hideAtMs
  )
  return changed ? changed.atMs - hideAtMs : null
}

/**
 * A frost that reads more than `FROST_LEAD_MAX_MS` ahead of the hide press is
 * not a capture latency; the file's alignment is broken, and widening the
 * Show slack by it would hide a real early un-frost. Null when it is in range.
 * @param {number|null} leadMs
 */
export function frostLeadFailure(leadMs) {
  if (!(leadMs > FROST_LEAD_MAX_MS)) return null
  return `the frost reads ${leadMs} ms before the hide press (> ${FROST_LEAD_MAX_MS}): the flashes misalign this file by more than a capture latency`
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
