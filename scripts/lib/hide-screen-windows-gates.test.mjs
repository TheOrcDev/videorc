import assert from 'node:assert/strict'
import { test } from 'node:test'

import { anchorFromFlash } from './scene-window-switch-frames.mjs'
import { SMART_SCENES_BUDGET, hideSpanVerdict } from './smart-scenes-gate.mjs'
import {
  anchorHideFile,
  FROST_LEAD_MAX_MS,
  captureAlignedHideBudget,
  distinctFrameRate,
  dxgiRefusalCode,
  frostLeadFailure,
  frostLeadMs,
  hideCoverMs,
  selectWindowsHideScreen,
  sessionFrostLeadMs,
  windowsHideOutputsVerdict,
  windowsHideSessionPath,
  windowsScreenStartSkip
} from './hide-screen-windows-gates.mjs'
import { parseWindowsFixtureReady } from './windows-fixture-window-process.mjs'

const dxgi = (status = 'available', detail = 'Display 1') => ({
  id: 'screen:dxgi:0000000000012345:0',
  kind: 'screen',
  name: 'Display 1',
  status,
  detail
})
const gdigrab = {
  id: 'screen:gdigrab:desktop',
  kind: 'screen',
  name: 'Desktop',
  status: 'available'
}

test('the smoke runs on an available DXGI display, never on gdigrab', () => {
  const picked = selectWindowsHideScreen([gdigrab, dxgi()])
  assert.equal(picked.skip, null)
  assert.equal(picked.screen.id, 'screen:dxgi:0000000000012345:0')

  const legacyOnly = selectWindowsHideScreen([gdigrab, { id: 'camera:x', kind: 'camera' }])
  assert.equal(legacyOnly.screen, null)
  assert.equal(legacyOnly.skip.flag, 'no-dxgi-display')
  assert.match(legacyOnly.skip.reason, /gdigrab/)

  assert.equal(selectWindowsHideScreen([]).skip.flag, 'no-dxgi-display')
  assert.equal(selectWindowsHideScreen(undefined).skip.flag, 'no-dxgi-display')
})

test('an unavailable DXGI display is a SKIP that names its status and HRESULT', () => {
  const denied = selectWindowsHideScreen([
    gdigrab,
    dxgi('unavailable', 'DuplicateOutput failed: 0x80070005 Access is denied.')
  ])
  assert.equal(denied.screen, null)
  assert.equal(denied.skip.flag, 'dxgi-refused-0x80070005')
  assert.match(denied.skip.reason, /unavailable \(0x80070005\)/)

  const other = selectWindowsHideScreen([dxgi('unavailable', 'adapter lost')])
  assert.equal(other.skip.flag, 'dxgi-unavailable')
  assert.match(other.skip.reason, /adapter lost/)
})

test('only Desktop Duplication refusals turn a failed screen start into a SKIP', () => {
  assert.equal(dxgiRefusalCode('AcquireNextFrame: E_ACCESSDENIED'), '0x80070005')
  assert.equal(dxgiRefusalCode('HRESULT 0x887A0022'), '0x887A0022')
  assert.equal(dxgiRefusalCode('DXGI_ERROR_SESSION_DISCONNECTED'), '0x887A0026')
  assert.equal(dxgiRefusalCode('device removed'), null)
  assert.equal(dxgiRefusalCode(null), null)

  assert.equal(windowsScreenStartSkip({ state: 'live', message: '0x80070005' }), null)
  assert.equal(windowsScreenStartSkip({ state: 'failed', message: 'shader compile failed' }), null)
  assert.equal(windowsScreenStartSkip(null), null)
  const skip = windowsScreenStartSkip({
    state: 'failed',
    message: 'DXGI Desktop Duplication failed (0x80070005)'
  })
  assert.equal(skip.flag, 'dxgi-refused-0x80070005')
  assert.match(skip.reason, /display is off or the session is locked/)
})

test('the session path is read from diagnostics.stats', () => {
  assert.deepEqual(windowsHideSessionPath(null), {
    path: 'cpu-bridge',
    captureBackend: null,
    mediaState: null,
    fallbackReason: null,
    d3d11Skip: null
  })
  assert.equal(
    windowsHideSessionPath({ encoderBridgeEncodedOutputInputSubtype: 'NV12-D3D11' }).path,
    'd3d11-media'
  )
  assert.deepEqual(
    windowsHideSessionPath({
      windowsD3d11Media: {
        state: 'live',
        encoderGpuSamples: 12,
        captureBackend: 'desktop-duplication'
      }
    }),
    {
      path: 'd3d11-media',
      captureBackend: 'desktop-duplication',
      mediaState: 'live',
      fallbackReason: null,
      d3d11Skip: null
    }
  )
  assert.equal(
    windowsHideSessionPath({ windowsD3d11Media: { state: 'fallback', encoderGpuSamples: 0 } }).path,
    'cpu-bridge'
  )
})

test('every output leg must hold the frost; only optional legs may skip, with a reason', () => {
  const pass = { ok: true, failures: [] }
  assert.deepEqual(
    windowsHideOutputsVerdict({
      recording: pass,
      stream: pass,
      clip: pass,
      screenFile: { ok: true, skipped: true, reason: 'no camera', failures: [] }
    }),
    { ok: true, failures: [] }
  )

  const leak = windowsHideOutputsVerdict({
    recording: pass,
    stream: { ok: false, failures: ['3 live frame(s) inside the hidden span'] },
    clip: pass
  })
  assert.equal(leak.ok, false)
  assert.match(leak.failures[0], /^stream: 3 live frame/)

  const skippedRequired = windowsHideOutputsVerdict({
    recording: pass,
    stream: pass,
    clip: { ok: true, skipped: true, reason: 'x', failures: [] }
  })
  assert.equal(skippedRequired.ok, false)
  assert.match(skippedRequired.failures[0], /never optional/)

  const silentSkip = windowsHideOutputsVerdict({
    recording: pass,
    stream: pass,
    clip: pass,
    screenFile: { ok: true, skipped: true, failures: [] }
  })
  assert.equal(silentSkip.ok, false)
  assert.match(silentSkip.failures[0], /without a reason/)

  assert.equal(windowsHideOutputsVerdict({ recording: pass, stream: pass }).ok, false)
  assert.equal(
    windowsHideOutputsVerdict(
      { recording: pass, stream: pass, clip: pass },
      { hiddenReason: 'password-manager' }
    ).ok,
    false
  )
})

test('a D3D11 fallback forced by a Desktop Duplication refusal is a named SKIP', () => {
  const refused = windowsHideSessionPath({
    windowsD3d11Media: {
      state: 'fallback',
      captureBackend: 'legacy-ffmpeg',
      fallbackReason: 'IDXGIOutput1::DuplicateOutput failed: Access is denied. (0x80070005)'
    }
  })
  assert.equal(refused.path, 'cpu-bridge')
  assert.equal(refused.d3d11Skip.flag, 'd3d11-dxgi-refused-0x80070005')
  assert.match(refused.d3d11Skip.reason, /display is off or the session is locked/)

  const otherFallback = windowsHideSessionPath({
    windowsD3d11Media: { state: 'fallback', fallbackReason: 'canvas larger than 1080p' }
  })
  assert.equal(otherFallback.d3d11Skip, null)
  assert.equal(otherFallback.fallbackReason, 'canvas larger than 1080p')

  const live = windowsHideSessionPath({
    windowsD3d11Media: { state: 'live', encoderGpuSamples: 3, fallbackReason: 'stale' }
  })
  assert.equal(live.fallbackReason, null)
  assert.equal(live.d3d11Skip, null)
})

/** 30 fps frames; `white` lists the indexes that are white. */
function syntheticFile(count, white, { repeatedEvery = 1 } = {}) {
  const features = Array.from({ length: count }, (_, index) => ({
    index,
    centre: white.includes(index) ? 'white' : 'red',
    repeated: index % repeatedEvery !== 0
  }))
  const ptsMs = features.map((feature) => feature.index * (1000 / 30))
  return { features, ptsMs }
}

test('a missed end flash keeps the start anchor instead of re-anchoring on the start flash', () => {
  // Start flash at frame 87 (2.9 s), end flash 9.1 s later inside the file but never captured.
  const { features, ptsMs } = syntheticFile(467, [87, 88])
  const flashes = [
    { label: 'start', drawnAtMs: 100_000 },
    { label: 'end', drawnAtMs: 109_100 }
  ]
  const result = anchorHideFile(anchorFromFlash, features, ptsMs, flashes)
  assert.equal(result.anchor.by, 'start')
  assert.equal(result.anchor.frameIndex, 87)
  assert.equal(result.endSeen, false)
  assert.equal(Math.round(result.anchor.offsetMs), 100_000 - 2900)
})

test('both flashes anchor on the start and measure drift', () => {
  const { features, ptsMs } = syntheticFile(467, [87, 88, 360, 361])
  const flashes = [
    { label: 'start', drawnAtMs: 100_000 },
    { label: 'end', drawnAtMs: 109_100 }
  ]
  const result = anchorHideFile(anchorFromFlash, features, ptsMs, flashes)
  assert.equal(result.anchor.by, 'start')
  assert.equal(result.endSeen, true)
  assert.equal(result.anchorDriftMs, Math.round(109_100 - 12_000 - (100_000 - 2900)))
})

test('a clip that starts after the start flash anchors on the end flash', () => {
  // 6 s clip whose only white run (frame 150, 5 s in) is the end flash.
  const { features, ptsMs } = syntheticFile(180, [150, 151])
  const flashes = [
    { label: 'start', drawnAtMs: 100_000 },
    { label: 'end', drawnAtMs: 109_100 }
  ]
  const result = anchorHideFile(anchorFromFlash, features, ptsMs, flashes)
  assert.equal(result.anchor.by, 'end')
  assert.equal(result.anchor.frameIndex, 150)
  assert.equal(result.endSeen, true)
  assert.equal(anchorHideFile(anchorFromFlash, features, ptsMs, []).anchor, null)
})

test('distinct frame rate reads the capture cadence from repeats', () => {
  const steady = syntheticFile(91, [])
  assert.equal(distinctFrameRate(steady.features, steady.ptsMs), 30)
  const slow = syntheticFile(91, [], { repeatedEvery: 8 })
  assert.equal(distinctFrameRate(slow.features, slow.ptsMs), 3.7)
  assert.equal(distinctFrameRate(slow.features, slow.ptsMs, { untilPts: 0 }), null)
})

test('the slack before Show grows to one capture interval, never below the base', () => {
  const base = { hideEdgeMs: 700, showSlackMs: 70, hideLatencyMaxMs: 1000 }
  assert.deepEqual(captureAlignedHideBudget(base, 3.5), {
    ...base,
    captureIntervalMs: 286,
    showSlackMs: 286
  })
  assert.equal(captureAlignedHideBudget(base, 30).showSlackMs, 70)
  assert.equal(captureAlignedHideBudget(base, 30).hideEdgeMs, 700)
  assert.deepEqual(captureAlignedHideBudget(base, null), { ...base, captureIntervalMs: null })
})

test('a frame one capture interval before Show is alignment, a mid-span live frame is a leak', () => {
  // 3.5 fps capture: new pictures every 9th frame at 30 fps.
  const count = 400
  const hideAtMs = 5000
  const showAtMs = 9000
  const features = Array.from({ length: count }, (_, index) => {
    const wall = (index * 1000) / 30
    const hidden = wall >= hideAtMs + 100 && wall < showAtMs - 150
    // The still never changes: every hidden frame after the first repeats.
    return { index, sharp: hidden ? 0 : 0.003, repeated: hidden || index % 9 !== 0, centre: 'red' }
  })
  const ptsMs = features.map((feature) => (feature.index * 1000) / 30)
  const input = { features, ptsMs, offsetMs: 0, hideAtMs, showAtMs, untilMs: 12_000 }
  const loose = hideSpanVerdict({
    ...input,
    budget: captureAlignedHideBudget(SMART_SCENES_BUDGET, 3.5)
  })
  assert.equal(loose.ok, true, loose.failures.join('; '))
  assert.equal(hideSpanVerdict(input).ok, false)

  const leak = features.map((feature) =>
    feature.index === 200 ? { ...feature, sharp: 0.003 } : feature
  )
  const leaked = hideSpanVerdict({
    ...input,
    features: leak,
    budget: captureAlignedHideBudget(SMART_SCENES_BUDGET, 3.5)
  })
  assert.equal(leaked.ok, false)
  assert.equal(leaked.hidden.leaks[0].index, 200)
})

// Issue #1329: a D3D11 Desktop Duplication file whose live content reaches
// the file `latencyMs` after it was drawn, while the frost, built at the
// source, lands on the next canvas tick after each press. Flash-aligned wall
// time dates the live content, so both edges read `latencyMs` early.
function sourceFrostFile({
  latencyMs,
  coverMs = 0,
  unfrostEarlyMs = 0,
  hideAtMs = 5000,
  showAtMs = 9000
}) {
  const frameMs = 1000 / 30
  const count = 420
  const ptsMs = Array.from({ length: count }, (_, index) => index * frameMs)
  // Output wall time of each frame; the flash anchor maps it `latencyMs` early.
  const frostFrom = Math.ceil((hideAtMs + coverMs) / frameMs) * frameMs
  const frostUntil = Math.ceil((showAtMs - unfrostEarlyMs) / frameMs) * frameMs
  const features = ptsMs.map((output, index) => {
    const hidden = output >= frostFrom && output < frostUntil
    return {
      index,
      sharp: hidden ? 0 : 0.0011,
      repeated: hidden && output > frostFrom,
      centre: 'red'
    }
  })
  return { features, ptsMs, offsetMs: -latencyMs, hideAtMs, showAtMs, untilMs: 12_000 }
}

test('the frost lead reads how early a source-frosted file is aligned', () => {
  const file = sourceFrostFile({ latencyMs: 150 })
  const lead = frostLeadMs(file)
  assert.ok(lead >= 140 && lead <= 150, `lead ${lead}`)
  // A frost that lands after the press reads as a negative lead.
  assert.ok(frostLeadMs(sourceFrostFile({ latencyMs: -40 })) < 0)
  // No frost in the middle of the span: no lead to measure.
  const live = { ...file, features: file.features.map((f) => ({ ...f, sharp: 0.0011 })) }
  assert.equal(frostLeadMs(live), null)
})

test('the Show slack grows by the frost lead, the hide cover and a canvas frame', () => {
  const base = { hideEdgeMs: 700, showSlackMs: 70, hideLatencyMaxMs: 1000 }
  const budget = captureAlignedHideBudget(base, 13.6, {
    frostLeadMs: 140,
    canvasFrameMs: 1000 / 30,
    hideCoverMs: 5
  })
  assert.equal(budget.captureIntervalMs, 74)
  assert.equal(budget.showSlackMs, 179)
  assert.equal(budget.frostLeadMs, 140)
  assert.equal(budget.hideEdgeMs, 700)
  // A frost after the press never shrinks the slack below the base.
  assert.equal(captureAlignedHideBudget(base, 30, { frostLeadMs: -30 }).showSlackMs, 70)
  // A slow cover reads as a late frost (a negative lead); the cover gives it back.
  assert.equal(
    captureAlignedHideBudget(base, 24, {
      frostLeadMs: -20,
      canvasFrameMs: 1000 / 30,
      hideCoverMs: 120
    }).showSlackMs,
    134
  )
  assert.equal(captureAlignedHideBudget(base, null, { frostLeadMs: null }).showSlackMs, 70)
})

test('issue #1329: capture latency at Show is alignment, an early un-frost is still a leak', () => {
  const judge = (file) => {
    const budget = captureAlignedHideBudget(SMART_SCENES_BUDGET, 13.6, {
      frostLeadMs: frostLeadMs(file),
      canvasFrameMs: 1000 / 30,
      hideCoverMs: file.coverMs ?? 0
    })
    return hideSpanVerdict({ ...file, budget })
  }
  const latent = sourceFrostFile({ latencyMs: 150 })
  // The interval-only slack (#1088) reads the Show edge as a leak.
  assert.equal(
    hideSpanVerdict({ ...latent, budget: captureAlignedHideBudget(SMART_SCENES_BUDGET, 13.6) }).ok,
    false
  )
  const ok = judge(latent)
  assert.equal(ok.ok, true, ok.failures.join('; '))
  // The frost lifted 150 ms before Show, on the file's own clock: a leak,
  // whatever the capture latency.
  const early = judge(sourceFrostFile({ latencyMs: 150, unfrostEarlyMs: 150 }))
  assert.equal(early.ok, false)
  assert.match(early.failures.join('; '), /live frame\(s\) inside the hidden span/)
  // The CPU bridge (issue #1329): 100 ms of content latency and a 120 ms
  // cover, so the frost reads late and the Show edge early. The cover
  // measured off the event keeps it alignment; without it, it reads as a leak.
  const slowCover = { ...sourceFrostFile({ latencyMs: 100, coverMs: 120 }), coverMs: 120 }
  assert.ok(frostLeadMs(slowCover) < 0)
  const covered = judge(slowCover)
  assert.equal(covered.ok, true, covered.failures.join('; '))
  assert.equal(judge({ ...slowCover, coverMs: 0 }).ok, false)
  const earlyCovered = judge({
    ...sourceFrostFile({ latencyMs: 100, coverMs: 120, unfrostEarlyMs: 150 }),
    coverMs: 120
  })
  assert.equal(earlyCovered.ok, false)
})

test('the session frost lead is the earliest frost any leg shows, within the cap', () => {
  assert.equal(sessionFrostLeadMs([46, -21, 46]), 46)
  assert.equal(sessionFrostLeadMs([-30, null, -5]), -5)
  assert.equal(sessionFrostLeadMs([80, FROST_LEAD_MAX_MS + 1]), 80)
  assert.equal(sessionFrostLeadMs([null, undefined]), null)
  assert.equal(sessionFrostLeadMs(undefined), null)
})

test('the hide cover is the first hidden privacy event after the press', () => {
  const events = [
    { event: 'screen.privacy.changed', payload: { hidden: false }, atMs: 900 },
    { event: 'screen.privacy.changed', payload: { hidden: true }, atMs: 950 },
    { event: 'replay.status', payload: {}, atMs: 1010 },
    { event: 'screen.privacy.changed', payload: { hidden: true }, atMs: 1042 },
    { event: 'screen.privacy.changed', payload: { hidden: true }, atMs: 1300 }
  ]
  assert.equal(hideCoverMs(events, 1000), 42)
  assert.equal(hideCoverMs(events, 2000), null)
  assert.equal(hideCoverMs(undefined, 0), null)
})

test('a frost far ahead of the hide press is a misaligned file, not slack', () => {
  assert.equal(frostLeadFailure(null), null)
  assert.equal(frostLeadFailure(FROST_LEAD_MAX_MS), null)
  assert.match(frostLeadFailure(FROST_LEAD_MAX_MS + 1), /misalign/)
})

test('the Windows fixture ready line parses', () => {
  assert.deepEqual(
    parseWindowsFixtureReady(
      'ready pid=4242 window_number=1311234 bounds=0,0,1280x720 scale=1.5 control_port=51234'
    ),
    {
      pid: 4242,
      hwnd: '1311234',
      bounds: { x: 0, y: 0, width: 1280, height: 720 },
      scale: 1.5,
      controlPort: 51234
    }
  )
  assert.equal(parseWindowsFixtureReady('flash drawn_at_ms=1'), null)
})
