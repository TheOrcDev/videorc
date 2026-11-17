import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  ROOM_FRAME,
  CAMERA_BRIDGE_BUDGETS,
  assessCameraBridge,
  assessPatches,
  cameraBridgeConfig,
  cameraPublication,
  cameraRemaining,
  decodeFrameStamp,
  deriveCameraClocks,
  driftGrowth,
  memoryRise,
  stampCellCenters,
  STAMP_ROW,
  PATCH_ROW,
  ALPHA_PATCH_PROBES,
  FLASH_X,
  alphaX,
  compositeProbes,
  captureRgb,
  assessComposite,
  blendPixel,
  decodeHealth,
  matchBaseline,
  analyzeCameraBridgeEvidence,
  assessSceneCase
} from './cloud-parity-camera-bridge-contract.mjs'
import { cameraSceneCases } from './cloud-parity-camera-bridge-scenes.mjs'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Node 24 strips types natively; the shared TS module is the mirror source.
const shared = await import('../../apps/desktop/src/shared/room-frame.ts')

test('script mirror matches the shared TS contract and fixture vectors', () => {
  for (const key of ['role', 'cameraRole', 'packing', 'width', 'height', 'gutter', 'packedWidth'])
    assert.equal(ROOM_FRAME[key], shared.ROOM_FRAME[key], key)
  assert.equal(ROOM_FRAME.productionQualified, false)
  for (const sequence of [0, 1, 29, 30, 4095, 0x123456]) {
    const stamp = shared.frameStampBits(sequence)
    const samples = stampCellCenters().map(
      (x) => shared.packedPixel(x, STAMP_ROW, sequence, stamp)[0]
    )
    assert.equal(decodeFrameStamp(samples), sequence)
    assert.equal(shared.decodeFrameStamp(samples), sequence)
  }
  assert.equal(decodeFrameStamp(Array(32).fill(128)), null)
  const flipped = shared.frameStampBits(77).map((bit) => (bit ? 255 : 0))
  flipped[3] = 255 - flipped[3]
  assert.equal(decodeFrameStamp(flipped), null)
  for (const probe of ALPHA_PATCH_PROBES) {
    const stamp = shared.frameStampBits(1)
    assert.deepEqual(shared.packedPixel(probe.x, PATCH_ROW, 1, stamp).slice(0, 3), [
      ...(probe.rgba[3] ? probe.rgba.slice(0, 3) : [0, 0, 0])
    ])
    assert.equal(shared.packedPixel(alphaX(probe.x), PATCH_ROW, 1, stamp)[0], probe.rgba[3])
  }
  assert.equal(shared.packedPixel(FLASH_X, PATCH_ROW, 30, shared.frameStampBits(30))[0], 255)
  assert.equal(shared.packedPixel(FLASH_X, PATCH_ROW, 31, shared.frameStampBits(31))[0], 0)
  const fixture = JSON.parse(
    readFileSync(new URL('../../protocol-fixtures/room-frame.json', import.meta.url), 'utf8')
  )
  for (const v of fixture.pixels)
    assert.deepEqual(
      shared.packedPixel(v.px, v.y, v.sequence, shared.frameStampBits(v.sequence)),
      v.rgba
    )
})

test('configuration bounds and defaults are the acceptance contract', () => {
  const config = cameraBridgeConfig({})
  assert.equal(config.mode, 'acquire-analyze')
  assert.equal(config.durationMs, 1_805_000)
  assert.equal(config.cycles, 25)
  assert.equal(config.guests, 5)
  assert.throws(() => cameraBridgeConfig({ VIDEORC_CAMERA_BRIDGE_GUESTS: '8' }))
  assert.throws(() => cameraBridgeConfig({ VIDEORC_CAMERA_BRIDGE_MODE: 'pretend' }))
  assert.throws(() => cameraBridgeConfig({ VIDEORC_CAMERA_BRIDGE_SECONDS: '1.5' }))
})

test('patch tolerances follow S10 and a transparent patch ignores color', () => {
  const good = {
    color: { 80: [250, 4, 251], 240: [6, 250, 3], 400: [90, 10, 10] },
    alpha: { 80: 252, 240: 131, 400: 6 }
  }
  assert.deepEqual(assessPatches(good), [])
  assert.equal(assessPatches({ ...good, alpha: { ...good.alpha, 240: 100 } }).length, 1)
  assert.equal(assessPatches({ color: {}, alpha: {} }).length, 3)
})

function records({ seconds, latencyMs, growthMs = 0 }) {
  // Synthetic brackets in three domains; native epoch at renderer 1000 ms.
  const out = []
  for (let s = 0; s <= seconds; s += 0.5) {
    const nodeUs = 10_000_000 + s * 1e6
    out.push({
      kind: 'renderer',
      beforeUs: nodeUs - 200,
      afterUs: nodeUs + 200,
      reply: {
        performanceMs: 1000 + s * 1000,
        events: [0, 1].map((k) => {
          const sequence = Math.round(s * 30) + k
          const ptsUs = Math.floor((sequence * 1e6) / 30)
          return {
            phase: 'native-frame',
            generation: 7,
            sequence,
            ptsUs,
            observedAtUs: ptsUs + 1000,
            pullRequestedAtMs: 1000 + ptsUs / 1000,
            pullReceivedAtMs: 1000 + ptsUs / 1000 + 2,
            nativeCaptureUs: 5000 + ptsUs
          }
        })
      }
    })
    const extra = latencyMs + (growthMs * s) / seconds
    out.push({
      kind: 'program',
      beforeUs: nodeUs - 300,
      afterUs: nodeUs + 300,
      reply: {
        performanceMs: 500 + s * 1000,
        events: [
          {
            phase: 'decoded',
            sequence: Math.round(s * 30),
            presentationTimeMs: 500 + s * 1000 + extra
          }
        ]
      }
    })
  }
  return out
}

test('clock mapping brackets latency without extrapolation and measures drift', () => {
  const steady = deriveCameraClocks(records({ seconds: 20, latencyMs: 90 }))
  assert.equal(steady.generation, 7)
  assert.ok(steady.samples.length > 30)
  for (const s of steady.samples) {
    assert.ok(s.latency.lowUs <= 90_000 && s.latency.highUs >= 90_000)
    assert.ok(s.latency.highUs - s.latency.lowUs < 5_000)
  }
  // The last decoded stamp lies past the final program anchor: refused, not guessed.
  assert.ok(steady.unavailable.every((u) => /extrapolation|native write/.test(u.reason)))
  assert.ok(Math.abs(driftGrowth(steady.samples).growthMs) < 1)
  const drifting = deriveCameraClocks(records({ seconds: 20, latencyMs: 90, growthMs: 120 }))
  assert.ok(driftGrowth(drifting.samples).growthMs > 100)
})

test('resource observations require every owner closed and keep unavailable distinct', () => {
  const main = { nativeSources: 0, nativeLeases: 0, sockets: 0, ipcRequests: 0, timers: 0 }
  assert.equal(cameraRemaining(main, { owners: [] }, []).status, 'closed')
  assert.equal(cameraRemaining({ ...main, nativeLeases: 1 }, { owners: [] }, []).status, 'live')
  assert.equal(
    cameraRemaining({ ...main, nativeLeases: undefined }, { owners: [] }, []).status,
    'unavailable'
  )
  assert.equal(
    cameraRemaining(main, { owners: [{ generators: 0, timers: 0, leasesHeld: 0 }] }, []).status,
    'unavailable'
  )
  assert.equal(
    cameraPublication({ tracks: [{ source: 'CAMERA', muted: false }] })?.source,
    'CAMERA'
  )
  assert.equal(cameraPublication({ tracks: [{ source: 'CAMERA' }, { source: 'CAMERA' }] }), null)
})

test('memory rise judges post-warm-up growth', () => {
  assert.equal(memoryRise([1, 2]), null)
  assert.equal(memoryRise(Array.from({ length: 40 }, () => 100)).passed, true)
  assert.equal(memoryRise(Array.from({ length: 40 }, (_, i) => 100 + i * 5)).passed, false)
})

test('qualification fails while any gate is unavailable or over budget', () => {
  const clock = deriveCameraClocks(records({ seconds: 20, latencyMs: 90 }))
  const evidence = {
    platform: 'darwin',
    clock,
    patchSamples: [],
    unavailable: [{ measurement: 'managedRecorderBudgets', owner: 'managed', reason: 'not run' }]
  }
  const result = assessCameraBridge(evidence)
  assert.equal(result.status, 'failed')
  assert.equal(result.productionQualified, false)
  assert.equal(result.gates.nativeToDecodedLatency.status, 'passed')
  // 20 s of synthetic data cannot satisfy the 30-minute span.
  assert.equal(result.gates.drift30Minutes.status, 'failed')
  assert.equal(result.gates.transportAlphaPatches.status, 'unavailable')
  assert.equal(result.gates['unpackedPatches.program'].status, 'unavailable')
  assert.equal(result.gates.packedNeverShown.status, 'unavailable')
  assert.equal(result.gates.managedRecorderBudgets.status, 'unavailable')
  assert.equal(CAMERA_BRIDGE_BUDGETS.minimumGenerations, 25)
})

test('unpacked adapter samples, packed exposure and SFU authority are separate gates', () => {
  const good = {
    color: { 80: [250, 4, 251], 240: [6, 250, 3], 400: [0, 0, 0] },
    alpha: { 80: 255, 240: 128, 400: 0 }
  }
  const result = assessCameraBridge({
    guestSurfaces: ['guest1'],
    unpackedSamples: [
      { surface: 'program', ...good },
      { surface: 'monitor', ...good },
      { surface: 'guest1', ...good, alpha: { ...good.alpha, 240: 60 } }
    ],
    packedExposure: [
      { surface: 'program', visible: false },
      { surface: 'monitor', visible: true }
    ],
    authorityChecks: [{ participantSid: true, trackSid: true, packedDescriptor: true }]
  })
  assert.equal(result.gates['unpackedPatches.program'].status, 'passed')
  assert.equal(result.gates['unpackedPatches.monitor'].status, 'passed')
  assert.equal(result.gates['unpackedPatches.guest1'].status, 'failed')
  assert.equal(result.gates.packedNeverShown.status, 'failed')
  assert.equal(result.gates.authorityMatchesSfu.status, 'passed')
  assert.equal(result.status, 'failed')
})

// A synthetic compositor: draws the fixture's patch row over a ground, honouring
// alpha, a tile clip and an optional corner mask, into an RGBA capture.
function composite({
  geometry,
  ground,
  ignoreAlpha = false,
  doubleBlend = false,
  maskCorner = true
}) {
  const width = 900,
    height = 600
  const rgba = new Uint8Array(width * height * 4)
  const g = geometry
  const page = [20, 20, 20]
  for (let py = 0; py < height; py++)
    for (let px = 0; px < width; px++) {
      const i = (py * width + px) * 4
      let rgb = page
      const t = g.tile
      const insideTile = px >= t.x && px < t.x + t.w && py >= t.y && py < t.y + t.h
      const corner = maskCorner && px < t.x + 6 && py < t.y + 6
      if (insideTile && !corner) {
        rgb = ground
        let fx = (px + 0.5 - g.content.x) / g.content.w
        if (g.mirrored) fx = 1 - fx
        const lx = Math.floor(fx * 640),
          ly = Math.floor(((py + 0.5 - g.content.y) / g.content.h) * 360)
        if (lx >= 0 && lx < 640 && ly >= 0 && ly < 90) {
          const src =
            lx < 160
              ? [255, 0, 255, 255]
              : lx < 320
                ? [0, 255, 0, 128]
                : lx < 480
                  ? [0, 0, 0, 0]
                  : [0, 0, 0, 255]
          const a = ignoreAlpha ? 255 : src[3]
          const under = doubleBlend ? blendPixel(src, a, ground) : ground
          rgb = blendPixel(src, a, under)
        }
      }
      rgba.set([...rgb, 255], i)
    }
  return { width, height, rgba, clip: { x: 0, y: 0 }, scale: 1 }
}
const geometry = {
  content: { x: 40, y: 50, w: 800, h: 450 },
  logical: { w: 640, h: 360 },
  mirrored: false,
  tile: { x: 60, y: 60, w: 760, h: 430 },
  radius: 12,
  clipPath: 'none',
  ground: [30, 60, 90]
}
const assessFor = (options) => {
  const probes = compositeProbes(options.geometry ?? geometry)
  const capture = composite({ geometry, ground: geometry.ground, ...options })
  return assessComposite({
    ground: geometry.ground,
    probes,
    samples: probes.map((p) => ({ name: p.name, rgb: captureRgb(capture, p.page) }))
  })
}

test('composited pixels prove blending over the ground, crop and mask', () => {
  const probes = compositeProbes(geometry).filter((p) => !p.name.startsWith('edge-'))
  assert.deepEqual(
    probes.map((p) => [p.name, p.expect]),
    [
      ['patch-80', 'camera'],
      ['patch-240', 'camera'],
      ['patch-400', 'camera'],
      ['mask-corner', 'not-camera'],
      ['crop-left', 'not-camera'],
      ['crop-top', 'not-camera']
    ]
  )
  assert.deepEqual(assessFor({}).failures, [])
  assert.ok(assessFor({ ignoreAlpha: true }).failures.some((f) => /ground|blend/.test(f)))
  assert.ok(assessFor({ doubleBlend: true }).failures.some((f) => /blend/.test(f)))
  assert.ok(assessFor({ maskCorner: false }).failures.some((f) => /mask-corner/.test(f)))
  const unclipped = composite({
    geometry: { ...geometry, tile: { x: 0, y: 0, w: 900, h: 600 } },
    ground: geometry.ground
  })
  const crop = compositeProbes(geometry).filter((p) => p.name.startsWith('crop'))
  for (const probe of crop) assert.deepEqual(captureRgb(unclipped, probe.page), [255, 0, 255])
})

test('mirrored geometry maps logical patches to the mirrored side', () => {
  const mirrored = compositeProbes({ ...geometry, mirrored: true, tile: null })
  const plain = compositeProbes({ ...geometry, tile: null })
  assert.ok(mirrored[0].page.x > plain[0].page.x)
  assert.equal(
    mirrored.some((p) => p.expect === 'not-camera'),
    false
  )
})

test('decode health and the matched baseline gate the dropped-frame delta', () => {
  const windows = (fps, key = 1) =>
    Array.from({ length: 20 }, () => ({
      phase: 'rate',
      surface: 'program',
      key,
      frames: fps,
      windowMs: 1000
    }))
  assert.equal(decodeHealth(windows(30)).dropRate, 0)
  assert.ok(Math.abs(decodeHealth(windows(27)).dropRate - 0.1) < 1e-9)
  const base = {
    variant: 'baseline',
    platform: 'darwin',
    revisions: { desktop: 'd', desktopDiffSha256: 'h', web: 'w', programBundleSha256: 'p' },
    workload: { programViewport: { width: 1280, height: 720 }, layout: 'side-by-side' },
    config: { guests: 5, durationMs: 1_805_000 },
    rateEvents: windows(30)
  }
  const bridge = { ...base, variant: 'bridge', rateEvents: windows(29.8) }
  assert.deepEqual(matchBaseline(bridge, base), [])
  assert.deepEqual(
    matchBaseline(
      { ...bridge, revisions: { ...bridge.revisions, desktopDiffSha256: 'other' } },
      base
    ),
    ['desktopDiffSha256 differs']
  )
  assert.deepEqual(
    matchBaseline({ ...bridge, workload: { ...bridge.workload, layout: 'solo' } }, base),
    ['workload layout differs']
  )
  assert.ok(
    matchBaseline({ ...bridge, revisions: {} }, { ...base, revisions: {} }).includes(
      'missing desktop provenance'
    )
  )
  assert.deepEqual(
    matchBaseline({ ...bridge, config: { guests: 2, durationMs: 1_805_000 } }, base),
    ['guest count differs']
  )
  assert.equal(
    assessCameraBridge(bridge, undefined, { baseline: base }).gates.droppedFrameDelta.status,
    'passed'
  )
  assert.equal(
    assessCameraBridge({ ...bridge, rateEvents: windows(28) }, undefined, { baseline: base }).gates
      .droppedFrameDelta.status,
    'failed'
  )
  assert.equal(assessCameraBridge(bridge).gates.droppedFrameDelta.status, 'unavailable')
})

test('a baseline evidence file is acquisition evidence, never qualification', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'camera-bridge-'))
  const file = join(dir, 'evidence.json')
  writeFileSync(
    file,
    JSON.stringify({
      kind: 'local-livekit-camera-bridge',
      acquisition: 'completed',
      variant: 'baseline',
      artifacts: [],
      rateEvents: []
    })
  )
  const result = await analyzeCameraBridgeEvidence(file)
  assert.equal(result.status, 'baseline-acquired')
  assert.equal(result.productionQualified, false)
})

// S12's committed geometry (desktop mirror of the web scenePicture).
const { scenePicture } = await import('../../apps/desktop/src/shared/cloud-scene.ts')

function sceneGeometry({ fit, crop, mirror, mask, source = { w: 640, h: 360 } }) {
  const frame = { x: 100, y: 80, w: 400, h: 300 }
  const { clip, full } = scenePicture(frame, source, crop, fit)
  return {
    content: full,
    logical: { w: 640, h: 360 },
    mirrored: mirror,
    tile: clip,
    radius: mask === 'rounded' ? Math.round(Math.min(clip.w, clip.h) * 0.18) : 0,
    clipPath: mask === 'circle' ? 'circle(50%)' : 'none',
    ground: [30, 60, 90]
  }
}
function sceneCapture(probeGeometry, drawnGeometry = probeGeometry, maskCorner = true) {
  const probes = compositeProbes(probeGeometry)
  const capture = composite({ geometry: drawnGeometry, ground: probeGeometry.ground, maskCorner })
  return {
    surface: 'program',
    geometry: probeGeometry,
    ground: probeGeometry.ground,
    probes,
    samples: probes.map((p) => ({ name: p.name, rgb: captureRgb(capture, p.page) }))
  }
}
const SCENES = {
  'camera:cover-crop-rounded': {
    fit: 'cover',
    crop: { l: 0.2, t: 0.1, r: 0, b: 0 },
    mirror: false,
    mask: 'rounded'
  },
  'camera:contain-mirror': {
    fit: 'contain',
    crop: { l: 0, t: 0, r: 0, b: 0 },
    mirror: true,
    mask: 'rectangle'
  },
  'camera:circle': {
    fit: 'cover',
    crop: { l: 0, t: 0, r: 0, b: 0 },
    mirror: false,
    mask: 'circle'
  }
}
const applied = { status: { state: 'applied', generation: 2 } }

test('S12 scene geometry on the unpacked camera passes when composited as S12 lays it out', () => {
  for (const one of cameraSceneCases()) {
    const spec = SCENES[one.id]
    const g = sceneGeometry(spec)
    const capture = sceneCapture(g, g, spec.mask !== 'rectangle')
    const result = assessSceneCase({ id: one.id, expect: one.expect, receipt: applied }, [capture])
    assert.equal(result.status, 'passed', `${one.id}: ${result.failures}`)
  }
})

test('wrong renderers are caught: ignored mirror, packed size, missing mask or crop', () => {
  const crop = SCENES['camera:cover-crop-rounded']
  const g = sceneGeometry(crop)
  // Mirror ignored by the renderer while S12 asked for it.
  const mirroredSpec = SCENES['camera:contain-mirror']
  const mirrored = sceneGeometry(mirroredSpec)
  assert.equal(
    assessSceneCase({ expect: { mirror: true }, receipt: applied }, [
      sceneCapture(mirrored, { ...mirrored, mirrored: false }, false)
    ]).status,
    'failed'
  )
  // Geometry computed from the packed 1288x360 track instead of the logical size.
  const packed = sceneGeometry({ ...crop, source: { w: 1288, h: 360 } })
  assert.equal(
    assessSceneCase({ expect: {}, receipt: applied }, [
      sceneCapture(g, { ...g, content: packed.content })
    ]).status,
    'failed'
  )
  // Mask missing on a rounded scene.
  assert.equal(
    assessSceneCase({ expect: { mask: 'rounded' }, receipt: applied }, [sceneCapture(g, g, false)])
      .status,
    'failed'
  )
  // Crop not applied: the drawn picture is not clipped to S12's clip box.
  const unclipped = { ...g, tile: { x: 0, y: 0, w: 900, h: 600 } }
  assert.equal(
    assessSceneCase({ expect: {}, receipt: applied }, [sceneCapture(g, unclipped)]).status,
    'failed'
  )
  // No applied receipt is never a pass.
  assert.equal(assessSceneCase({ expect: {} }, [sceneCapture(g)]).status, 'failed')
})
