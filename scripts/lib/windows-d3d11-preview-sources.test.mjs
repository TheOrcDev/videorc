import assert from 'node:assert/strict'
import test from 'node:test'

import {
  windowsD3d11HarnessScreenNotListed,
  windowsD3d11HarnessStateFailures,
  windowsD3d11MediaReady,
  windowsD3d11ProbeScreenId,
  windowsD3d11ScreenOnlyLayoutIntent
} from './windows-d3d11-preview-sources.mjs'

const SCREEN = 'screen:dxgi:0000000000010e89:0'

const configuredState = () => ({
  sources: {
    screenId: SCREEN,
    cameraOff: true,
    microphoneOff: true,
    testPattern: false
  },
  layout: { layoutPreset: 'screen-only' }
})

test('the harness state is accepted only as the one ScreenOnly screen source', () => {
  assert.deepEqual(windowsD3d11HarnessStateFailures(configuredState(), SCREEN), [])
  for (const [mutate, failure] of [
    [(state) => (state.sources.screenId = 'screen:dxgi:0000000000010e89:1'), /screenId=/],
    [(state) => (state.sources.cameraId = 'camera:c920'), /cameraId=camera:c920/],
    [(state) => (state.sources.cameraOff = false), /camera is not off/],
    [(state) => (state.sources.microphoneId = 'mic:c920'), /microphoneId=mic:c920/],
    [(state) => (state.sources.testPattern = true), /test pattern/],
    [(state) => (state.layout.layoutPreset = 'side-by-side'), /layout=side-by-side/]
  ]) {
    const state = configuredState()
    mutate(state)
    assert.match(windowsD3d11HarnessStateFailures(state, SCREEN).join('; '), failure)
  }
  assert.notDeepEqual(windowsD3d11HarnessStateFailures(null, SCREEN), [])
})

test('the probe screen is a DXGI screen, never the gdigrab fallback', () => {
  const dxgi = { id: SCREEN, kind: 'screen', status: 'available' }
  const gdigrab = { id: 'screen:gdigrab:desktop', kind: 'screen', status: 'available' }
  assert.equal(windowsD3d11ProbeScreenId([gdigrab, dxgi]), SCREEN)
  assert.equal(windowsD3d11ProbeScreenId([gdigrab]), null)
  assert.equal(windowsD3d11ProbeScreenId([{ ...dxgi, status: 'unavailable' }]), null)
  assert.equal(windowsD3d11ProbeScreenId([]), null)
})

test('only a not-yet-listed screen is retried', () => {
  assert.equal(
    windowsD3d11HarnessScreenNotListed(
      new Error(`Windows D3D11 preview smoke could not select available screen ${SCREEN}.`)
    ),
    true
  )
  assert.equal(
    windowsD3d11HarnessScreenNotListed(
      new Error('Windows D3D11 preview harness is unavailable in this app mode.')
    ),
    false
  )
})

test('the layout intent commits the probe screen alone in ScreenOnly', () => {
  const video = { preset: 'p1080', width: 1920, height: 1080, fps: 30, bitrateKbps: 6000 }
  const intent = windowsD3d11ScreenOnlyLayoutIntent({ intentId: 7, screenId: SCREEN, video })
  assert.equal(intent.intentId, 7)
  assert.deepEqual(intent.sources, { screenId: SCREEN, testPattern: false })
  assert.equal(intent.layout.layoutPreset, 'screen-only')
  assert.equal(intent.video, video)
  assert.equal(intent.background, null)
})

test('probes start only from a live D3D11 generation without a fallback', () => {
  assert.equal(windowsD3d11MediaReady({ state: 'live' }), true)
  assert.equal(windowsD3d11MediaReady({ state: 'starting' }), false)
  assert.equal(
    windowsD3d11MediaReady({
      state: 'live',
      fallbackReason: 'Live capture replacement uses the existing preview BGRA upload route.'
    }),
    false
  )
  assert.equal(windowsD3d11MediaReady(null), false)
})
