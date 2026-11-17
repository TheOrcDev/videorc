import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CAMERA,
  CASE_LOOK,
  CASE_LAYOUT_PATCH,
  assessCameraCase,
  assessLifecycle,
  assessSample,
  cameraCaseConfig,
  logicalSizeFor,
  lookRgb,
  markerPoints
} from './cloud-parity-camera-contract.mjs'

const shared = await import('../../apps/desktop/src/shared/room-camera.ts')

test('mirrors stay pinned to the shared TS module and fixture', () => {
  for (const v of CAMERA.logicalSizes)
    assert.deepEqual(
      logicalSizeFor(v.sourceWidth, v.sourceHeight),
      shared.logicalSizeFor(v.sourceWidth, v.sourceHeight)
    )
  assert.deepEqual(
    lookRgb([128, 128, 128], { brightness: 0, contrast: 1, saturation: 1 }),
    [128, 128, 128]
  )
  assert.equal(CASE_LAYOUT_PATCH.cameraMirror, true)
  assert.equal(CAMERA.productionQualified, false)
})

function goodSample(source = { width: 1280, height: 720 }) {
  const { width, height } = logicalSizeFor(source.width, source.height)
  const points = markerPoints()
  const subject = lookRgb(CAMERA.zones.subject.rgb, CASE_LOOK)
  return {
    width,
    height,
    packedWidth: width * 2 + 8,
    points: {
      ground: { rgb: [0, 0, 0], alpha: 0 },
      subject: { rgb: subject, alpha: 255 },
      fringe: { rgb: [170, 168, 140], alpha: 250 },
      look: { rgb: lookRgb(CAMERA.zones.look.rgb, CASE_LOOK), alpha: 255 },
      mirror: { rgb: [230, 40, 40], alpha: 255 },
      mirrored: { rgb: subject, alpha: 255 }
    },
    edge: points.edge.map((p) => ({
      fx: p.fx,
      alpha:
        p.fx < CAMERA.zones.subject.x0 - 0.005
          ? 0
          : p.fx < CAMERA.zones.subject.x0 + 0.01
            ? 128
            : 255
    }))
  }
}

test('a correctly processed frame passes every marker at each source size', () => {
  for (const source of [
    { width: 1280, height: 720 },
    { width: 640, height: 480 }
  ])
    assert.deepEqual(assessSample(goodSample(source), source), [])
})

test('each processing or ownership defect is caught', () => {
  const source = { width: 1280, height: 720 }
  const cases = {
    'mirror baked': (s) => (
      (s.points.mirror.rgb = s.points.mirrored.rgb),
      (s.points.mirrored.rgb = [230, 40, 40])
    ),
    'look missing': (s) => (s.points.look.rgb = [128, 128, 128]),
    'spill left': (s) => (s.points.fringe.rgb = [150, 200, 110]),
    'wrong size': (s) => (s.width = 554),
    'soft edge': (s) => s.edge.forEach((e, i) => (e.alpha = Math.min(255, i * 11))),
    'subject holes': (s) => (s.edge[s.edge.length - 1].alpha = 10),
    'key off': (s) => (s.points.ground.alpha = 255)
  }
  for (const [name, mutate] of Object.entries(cases)) {
    const sample = goodSample(source)
    mutate(sample)
    assert.ok(assessSample(sample, source).length > 0, name)
  }
  const ok = { pausedWithinMs: 1200, rawCameraPublished: false, reopenedGeneration: true }
  assert.deepEqual(assessLifecycle({ off: ok, switch: ok, unplug: ok }), [])
  assert.ok(
    assessLifecycle({ off: ok, switch: { ...ok, rawCameraPublished: true }, unplug: ok }).length
  )
  assert.ok(assessLifecycle({ off: ok, switch: ok }).some((f) => f.startsWith('unplug')))
})

test('qualification needs markers, stamps, ownership and lifecycle; device items stay unavailable', () => {
  const run = {
    source: { width: 1280, height: 720 },
    samples: [goodSample()],
    stamped: 120,
    ownership: { keptForRoom: true, lentToBrowserRoom: false, browserCamera: false }
  }
  const ok = { pausedWithinMs: 1000, rawCameraPublished: false, reopenedGeneration: true }
  const passing = assessCameraCase({ runs: [run], lifecycle: { off: ok, switch: ok, unplug: ok } })
  assert.equal(passing.status, 'passed')
  const withDevice = assessCameraCase({
    runs: [run],
    lifecycle: { off: ok, switch: ok, unplug: ok },
    unavailable: [{ measurement: 'windowsLowLightDevice', reason: 'needs a Windows device' }]
  })
  assert.equal(withDevice.status, 'failed')
  assert.equal(withDevice.productionQualified, false)
  assert.equal(
    assessCameraCase({ runs: [{ ...run, ownership: { ...run.ownership, browserCamera: true } }] })
      .gates['ownership.1280x720'].status,
    'failed'
  )
  assert.throws(() => cameraCaseConfig({ VIDEORC_CAMERA_SOURCES: '1281x720' }))
  assert.deepEqual(cameraCaseConfig({}).sources, [
    { width: 1280, height: 720 },
    { width: 640, height: 480 }
  ])
})

test('analysis refuses an incomplete acquisition and never qualifies production', async () => {
  const { analyzeCameraCase } = await import('./cloud-parity-camera.mjs')
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const file = join(mkdtempSync(join(tmpdir(), 'camera-case-')), 'evidence.json')
  writeFileSync(
    file,
    JSON.stringify({ kind: 'local-livekit-processed-camera', acquisition: 'failed', runs: [] })
  )
  const result = await analyzeCameraCase(file)
  assert.equal(result.status, 'failed')
  assert.equal(result.productionQualified, false)
  writeFileSync(file, JSON.stringify({ kind: 'other', acquisition: 'completed' }))
  await assert.rejects(analyzeCameraCase(file), /Not processed-camera evidence/)
})
