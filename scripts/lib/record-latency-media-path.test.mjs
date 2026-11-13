import assert from 'node:assert/strict'
import test from 'node:test'

import { summarizeWindowsMediaPaths, windowsMediaPathFrom } from './record-latency-media-path.mjs'

test('a live D3D11 authority is the d3d11 path', () => {
  assert.deepEqual(windowsMediaPathFrom({ windowsD3d11Media: { state: 'live' } }), {
    path: 'd3d11',
    state: 'live'
  })
})

test('any other authority state is the CPU compositor, with the state named', () => {
  for (const state of ['unavailable', 'probing', 'draining', 'fallback', 'failed']) {
    assert.deepEqual(windowsMediaPathFrom({ windowsD3d11Media: { state } }), {
      path: 'cpu-compositor',
      state
    })
  }
})

test('no snapshot or no D3D11 diagnostics is unknown', () => {
  for (const diagnostics of [null, undefined, {}, { windowsD3d11Media: {} }]) {
    assert.deepEqual(windowsMediaPathFrom(diagnostics), { path: null, state: null })
  }
})

test('the summary counts each path and unknown cycles', () => {
  assert.deepEqual(
    summarizeWindowsMediaPaths([
      { windowsMediaPath: { path: 'd3d11' } },
      { windowsMediaPath: { path: 'd3d11' } },
      { windowsMediaPath: { path: 'cpu-compositor' } },
      { windowsMediaPath: { path: null } },
      {}
    ]),
    { d3d11: 2, 'cpu-compositor': 1, unknown: 2 }
  )
})
