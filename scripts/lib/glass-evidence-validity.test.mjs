import assert from 'node:assert/strict'
import test from 'node:test'

import {
  captureGlassEvidence,
  finalizeGlassEvidence,
  InvalidGlassEvidenceError
} from './glass-evidence-validity.mjs'
import { evaluateFloatPatch } from './float-glass-checks.mjs'
import { parseHexColor } from './image-stats.mjs'

const bounds = { x: 40, y: 50, width: 600, height: 400 }
const area = { x: 0, y: 0, width: 1000, height: 800 }
const raised = { windowId: 21, bounds, primaryWorkArea: area }
const target = {
  id: 21,
  pid: 42,
  order: 0,
  layer: 4,
  alpha: 1,
  ownerCategory: 'target-app',
  ...bounds
}
const backdrop = {
  id: 22,
  pid: 42,
  order: 1,
  layer: 3,
  alpha: 1,
  ownerCategory: 'target-app',
  ...area
}
const dialog = {
  id: 80,
  pid: 900,
  order: 0,
  layer: 10,
  alpha: 1,
  ownerCategory: 'system-dialog',
  x: 100,
  y: 80,
  width: 200,
  height: 100
}
const now = 1000

const snapshot = (windows = [target, backdrop], observedAt = now) => ({ observedAt, windows })
const captureOptions = (overrides = {}) => ({
  role: 'notes',
  raised,
  name: 'fixture',
  now: () => now,
  readWindows: () => snapshot(),
  capture: () => 'fixture.png',
  ...overrides
})
const invalidWith =
  (reason, phase = 'before', ownerCategory = 'unknown') =>
  (error) => {
    assert.ok(error instanceof InvalidGlassEvidenceError)
    assert.equal(error.diagnostic.reason, reason)
    assert.equal(error.diagnostic.phase, phase)
    assert.equal(error.diagnostic.ownerCategory, ownerCategory)
    return true
  }

test('unobstructed pixels have fresh before/after checks and reduced evidence only', async () => {
  const diagnostics = []
  const reads = []
  const captures = []
  const shot = await captureGlassEvidence(
    captureOptions({
      readWindows: () => {
        reads.push('read')
        return snapshot()
      },
      capture: (rect, name) => {
        captures.push({ rect, name })
        reads.push('capture')
        return 'fixture.png'
      },
      recordValidity: (diagnostic) => diagnostics.push(diagnostic)
    })
  )
  assert.deepEqual(reads, ['read', 'capture', 'read'])
  assert.deepEqual(captures, [{ rect: bounds, name: 'fixture' }])
  assert.equal(shot.file, 'fixture.png')
  assert.equal(shot.ownership.targetPid, target.pid)
  assert.equal(shot.ownership.backdropPid, target.pid)
  assert.deepEqual(
    diagnostics,
    ['before', 'after'].map((phase) => ({
      role: 'notes',
      phase,
      status: 'VALID',
      ownerCategory: 'target-app',
      intersection: null,
      timestamp: now
    }))
  )
})

test('intersecting system dialog invalidates capture before pixels can be scored', async () => {
  let captures = 0
  await assert.rejects(
    captureGlassEvidence({
      role: 'notes',
      raised,
      name: 'fixture',
      now: () => now,
      readWindows: () => ({
        observedAt: now,
        windows: [dialog, { ...target, order: 1 }, { ...backdrop, order: 2 }]
      }),
      capture: () => {
        captures += 1
        return 'fixture.png'
      }
    }),
    (error) => {
      invalidWith('capture-obstructed', 'before', 'system-dialog')(error)
      assert.deepEqual(error.diagnostic.intersection, { x: 100, y: 80, width: 200, height: 100 })
      return true
    }
  )
  assert.equal(captures, 0)
})

test('a non-intersecting foreground dialog leaves the actual capture valid', async () => {
  const shot = await captureGlassEvidence(
    captureOptions({
      readWindows: () =>
        snapshot([
          { ...dialog, x: 750 },
          { ...target, order: 1 },
          { ...backdrop, order: 2 }
        ])
    })
  )
  assert.equal(shot.file, 'fixture.png')
})

test('a foreign window behind the controlled backdrop cannot contaminate the capture', async () => {
  const shot = await captureGlassEvidence(
    captureOptions({
      readWindows: () => snapshot([target, backdrop, { ...dialog, order: 2 }])
    })
  )
  assert.equal(shot.file, 'fixture.png')
})

test('an intersecting window between target and backdrop invalidates transmitted pixels', async () => {
  await assert.rejects(
    captureGlassEvidence(
      captureOptions({
        readWindows: () => snapshot([target, { ...dialog, order: 1 }, { ...backdrop, order: 2 }])
      })
    ),
    invalidWith('controlled-backdrop-obstructed', 'before', 'system-dialog')
  )
})

test('foreign Electron ownership is reduced to other-app while our auxiliary window is owned-app', async (t) => {
  for (const [name, pid, category] of [
    ['foreign Electron', 901, 'other-app'],
    ['owned auxiliary', target.pid, 'owned-app']
  ]) {
    await t.test(name, async () => {
      await assert.rejects(
        captureGlassEvidence(
          captureOptions({
            readWindows: () =>
              snapshot([
                { ...dialog, pid, ownerCategory: 'target-app' },
                { ...target, order: 1 },
                { ...backdrop, order: 2 }
              ])
          })
        ),
        invalidWith('capture-obstructed', 'before', category)
      )
    })
  }
})

test('reference-only obstruction invalidates reference pixels without discarding the target shot', async () => {
  const windows = [
    { ...dialog, x: 750 },
    { ...target, order: 1 },
    { ...backdrop, order: 2 }
  ]
  const captures = []
  const options = captureOptions({
    readWindows: () => snapshot(windows),
    capture: (rect) => {
      captures.push(rect)
      return 'target.png'
    }
  })
  const shot = await captureGlassEvidence(options)
  await assert.rejects(
    captureGlassEvidence({
      ...options,
      referenceRect: { x: 760, y: 80, width: 40, height: 40 },
      expectedOwnership: shot.ownership
    }),
    invalidWith('capture-obstructed', 'before', 'system-dialog')
  )
  assert.equal(shot.file, 'target.png')
  assert.deepEqual(captures, [bounds])
})

test('an unobstructed reference keeps the same exact target and backdrop ownership', async () => {
  const shot = await captureGlassEvidence(captureOptions())
  const referenceRect = { x: 750, y: 80, width: 40, height: 40 }
  const diagnostics = []
  const reference = await captureGlassEvidence(
    captureOptions({
      referenceRect,
      expectedOwnership: shot.ownership,
      recordValidity: (diagnostic) => diagnostics.push(diagnostic),
      capture: (rect) => {
        assert.deepEqual(rect, referenceRect)
        return 'reference.png'
      }
    })
  )
  assert.equal(reference.file, 'reference.png')
  assert.deepEqual(reference.ownership, shot.ownership)
  assert.equal(diagnostics.length, 2)
  assert.ok(diagnostics.every((row) => row.ownerCategory === 'controlled-backdrop'))
})

test('a dialog appearing during capture invalidates the shot and retains its raw evidence', async () => {
  const diagnostics = []
  const rawShots = []
  let reads = 0
  await assert.rejects(
    captureGlassEvidence(
      captureOptions({
        readWindows: () =>
          ++reads === 1
            ? snapshot()
            : snapshot([dialog, { ...target, order: 1 }, { ...backdrop, order: 2 }]),
        capture: () => {
          rawShots.push('raw-shot.png')
          return rawShots[0]
        },
        recordValidity: (diagnostic) => diagnostics.push(diagnostic)
      })
    ),
    invalidWith('capture-obstructed', 'after', 'system-dialog')
  )
  assert.deepEqual(rawShots, ['raw-shot.png'])
  assert.deepEqual(
    diagnostics.map(({ phase, status }) => ({ phase, status })),
    [
      { phase: 'before', status: 'VALID' },
      { phase: 'after', status: 'INVALID' }
    ]
  )
})

test('geometry and ownership changes during capture cannot validate the earlier pixels', async (t) => {
  for (const [name, windows, reason] of [
    ['target geometry', [{ ...target, x: 41 }, backdrop], 'target-identity-or-geometry-mismatch'],
    [
      'target PID',
      [
        { ...target, pid: 43 },
        { ...backdrop, pid: 43 }
      ],
      'capture-owner-changed'
    ],
    ['backdrop identity', [target, { ...backdrop, id: 23 }], 'capture-owner-changed'],
    ['target layer', [{ ...target, layer: 5 }, backdrop], 'capture-owner-changed'],
    [
      'backdrop geometry',
      [target, { ...backdrop, width: 999 }],
      'controlled-backdrop-missing-or-ambiguous'
    ]
  ]) {
    await t.test(name, async () => {
      let reads = 0
      await assert.rejects(
        captureGlassEvidence(
          captureOptions({
            readWindows: () => snapshot(++reads === 1 ? [target, backdrop] : windows)
          })
        ),
        invalidWith(reason, 'after')
      )
    })
  }
})

test('reference ownership cannot be replaced between target and reference captures', async () => {
  const shot = await captureGlassEvidence(captureOptions())
  await assert.rejects(
    captureGlassEvidence(
      captureOptions({
        referenceRect: { x: 750, y: 80, width: 40, height: 40 },
        expectedOwnership: shot.ownership,
        readWindows: () => snapshot([target, { ...backdrop, id: 23 }])
      })
    ),
    invalidWith('capture-owner-changed')
  )
})

test('missing, stale and ambiguous metadata cannot establish acceptance', async (t) => {
  for (const [name, value, reason] of [
    ['missing snapshot', null, 'metadata-missing-or-stale'],
    ['stale snapshot', snapshot(undefined, now - 1001), 'metadata-missing-or-stale'],
    ['future snapshot', snapshot(undefined, now + 1), 'metadata-missing-or-stale'],
    ['missing target', snapshot([backdrop]), 'target-not-visible'],
    ['missing backdrop', snapshot([target]), 'controlled-backdrop-missing-or-ambiguous'],
    [
      'ambiguous backdrop',
      snapshot([target, backdrop, { ...backdrop, id: 23, order: 2 }]),
      'controlled-backdrop-missing-or-ambiguous'
    ],
    ['duplicate order', snapshot([target, { ...backdrop, order: 0 }]), 'window-metadata-ambiguous'],
    [
      'unknown window bounds',
      snapshot([target, backdrop, { ...dialog, order: 2, width: undefined }]),
      'window-metadata-ambiguous'
    ],
    [
      'foreign backdrop PID',
      snapshot([target, { ...backdrop, pid: 43 }]),
      'controlled-backdrop-missing-or-ambiguous'
    ]
  ]) {
    await t.test(name, async () => {
      let captures = 0
      await assert.rejects(
        captureGlassEvidence(
          captureOptions({
            readWindows: () => value,
            capture: () => {
              captures += 1
            }
          })
        ),
        invalidWith(reason)
      )
      assert.equal(captures, 0)
    })
  }
})

test('a cached pre-capture snapshot cannot serve as the after check', async () => {
  let clock = now
  await assert.rejects(
    captureGlassEvidence(
      captureOptions({
        now: () => clock,
        capture: () => {
          clock += 10
          return 'raw.png'
        }
      })
    ),
    invalidWith('metadata-missing-or-stale', 'after')
  )
})

test('reader and capture failures retain reduced diagnostics without arbitrary contents', async (t) => {
  for (const [name, override, reason, phase] of [
    [
      'reader failure',
      {
        readWindows: () => {
          throw new Error('private native window title')
        }
      },
      'window-metadata-unavailable',
      'before'
    ],
    [
      'capture failure',
      {
        capture: () => {
          throw new Error('private native window title')
        }
      },
      'capture-unavailable',
      'capture'
    ]
  ]) {
    await t.test(name, async () => {
      const diagnostics = []
      await assert.rejects(
        captureGlassEvidence(
          captureOptions({
            ...override,
            recordValidity: (row) => diagnostics.push(row)
          })
        ),
        (error) => {
          invalidWith(reason, phase)(error)
          assert.equal(JSON.stringify(error).includes('private native window title'), false)
          return true
        }
      )
      assert.equal(JSON.stringify(diagnostics).includes('private native window title'), false)
      assert.deepEqual(Object.keys(diagnostics.at(-1)).sort(), [
        'intersection',
        'ownerCategory',
        'phase',
        'reason',
        'role',
        'status',
        'timestamp'
      ])
    })
  }
})

test('invalid run cannot preserve earlier PASS or product FAIL labels in report mode', () => {
  const tone = parseHexColor('#232324')
  const measured = evaluateFloatPatch({
    surfaceMeans: Object.fromEntries(
      ['red', 'blue', 'white', 'black', 'text'].map((variant) => [variant, tone])
    ),
    text: { primary: parseHexColor('#F5F5F6'), secondary: parseHexColor('#A1A1A6') },
    expected: tone
  })
  assert.equal(measured.pass, true)
  const report = {
    validity: { status: 'INVALID', samples: [{ role: 'notes', status: 'INVALID' }] },
    results: [
      { role: 'main', ...measured },
      { role: 'captions', metrics: {}, checks: { contrast: false }, pass: false }
    ],
    persistence: [{ step: 'baseline', pass: true }]
  }
  const result = finalizeGlassEvidence(report)
  assert.equal(result.status, 'INVALID')
  assert.equal(result.exitCode, 1)
  assert.equal(
    result.report.results.every((row) => row.status === 'INVALID' && row.pass === null),
    true
  )
  assert.equal(result.report.persistence[0].pass, null)
  assert.deepEqual(
    result.report.results.map((row) => row.checks),
    [{}, {}]
  )
  assert.equal(report.results[0].pass, true)
  assert.equal(report.results[1].pass, false)
})

test('clean genuine contrast failures retain FAIL and unchanged gate/report behavior', () => {
  const tone = parseHexColor('#686868')
  const measured = evaluateFloatPatch({
    surfaceMeans: Object.fromEntries(
      ['red', 'blue', 'white', 'black', 'text'].map((variant) => [variant, tone])
    ),
    text: { primary: parseHexColor('#F5F5F6'), secondary: parseHexColor('#A1A1A6') },
    expected: tone
  })
  assert.equal(measured.checks.secondaryContrast, false)
  const report = {
    validity: { status: 'VALID', samples: [{ role: 'main', status: 'VALID' }] },
    results: [{ role: 'main', ...measured }]
  }
  for (const gate of [false, true]) {
    const result = finalizeGlassEvidence(report, { gate })
    assert.equal(result.status, 'FAIL')
    assert.equal(result.report.results[0].status, 'FAIL')
    assert.deepEqual(result.report.results[0].checks, measured.checks)
    assert.equal(result.exitCode, gate ? 1 : 0)
  }
})

test('invalid or absent capture validity overrides a passing metric in both modes', () => {
  for (const validity of [
    undefined,
    { status: 'VALID', samples: [] },
    { status: 'VALID', samples: [{ status: 'INVALID' }] },
    { status: 'INVALID', samples: [{ status: 'VALID' }] }
  ]) {
    for (const gate of [false, true]) {
      const result = finalizeGlassEvidence(
        {
          validity,
          results: [{ role: 'main', pass: true, checks: {}, metrics: {} }]
        },
        { gate }
      )
      assert.equal(result.status, 'INVALID')
      assert.equal(result.exitCode, 1)
      assert.equal(result.report.results[0].status, 'INVALID')
      assert.equal(result.report.results[0].pass, null)
    }
  }
})
