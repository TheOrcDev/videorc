import assert from 'node:assert/strict'
import test from 'node:test'

import {
  configureWindowsD3d11RendererSourcesWhenListed,
  windowsD3d11CommandNotApplied,
  windowsD3d11HarnessScreenNotListed,
  windowsD3d11HarnessStateFailures,
  windowsD3d11MediaReady,
  windowsD3d11ProbeScreenId,
  windowsD3d11SceneScreenOnlyFailures,
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

test('configuring waits for the renderer to list the screen, and only for that', async () => {
  const notListed = new Error(
    `Windows D3D11 preview smoke could not select available screen ${SCREEN}.`
  )
  let calls = 0
  const listedOnThirdTry = async () => {
    calls += 1
    if (calls < 3) throw notListed
    return configuredState()
  }
  const state = await configureWindowsD3d11RendererSourcesWhenListed(
    listedOnThirdTry,
    SCREEN,
    Date.now() + 10_000,
    1
  )
  assert.equal(calls, 3)
  assert.equal(state.sources.screenId, SCREEN)

  const unavailable = new Error('Windows D3D11 preview harness is unavailable in this app mode.')
  calls = 0
  await assert.rejects(
    configureWindowsD3d11RendererSourcesWhenListed(
      async () => {
        calls += 1
        throw unavailable
      },
      SCREEN,
      Date.now() + 10_000,
      1
    ),
    unavailable
  )
  assert.equal(calls, 1)

  await assert.rejects(
    configureWindowsD3d11RendererSourcesWhenListed(
      async () => {
        throw notListed
      },
      SCREEN,
      Date.now() - 1,
      1
    ),
    notListed
  )
})

test('configuring refuses a deadline that is not a finite time', async () => {
  let calls = 0
  for (const deadline of [Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(
      configureWindowsD3d11RendererSourcesWhenListed(
        async () => {
          calls += 1
          return configuredState()
        },
        SCREEN,
        deadline,
        1
      ),
      /not a finite time/
    )
  }
  assert.equal(calls, 0)
})

test('a retry wait longer than the time left still ends at the deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })
  const notListed = new Error(
    `Windows D3D11 preview smoke could not select available screen ${SCREEN}.`
  )
  let calls = 0
  const configuring = configureWindowsD3d11RendererSourcesWhenListed(
    async () => {
      calls += 1
      throw notListed
    },
    SCREEN,
    50,
    10_000
  )
  // Let the first attempt fail and the retry wait start.
  await new Promise((resolve) => setImmediate(resolve))
  t.mock.timers.tick(50)
  const settled = await Promise.race([
    configuring.then(
      () => 'resolved',
      (error) => error
    ),
    new Promise((resolve) => setImmediate(() => resolve('still waiting')))
  ])
  assert.equal(settled, notListed)
  assert.equal(calls, 1)
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

test('a command the backend never applied is resent; other failures are not', () => {
  for (const message of [
    'The command expired while awaiting its reconciliation fence and was not applied.',
    'The ordered command expired before dispatch and was not applied.'
  ]) {
    assert.equal(windowsD3d11CommandNotApplied(new Error(message)), true)
  }
  assert.equal(
    windowsD3d11CommandNotApplied(new Error('Timed out waiting for scene.layout.apply_preview.')),
    false
  )
  assert.equal(
    windowsD3d11CommandNotApplied(new Error('Backend did not commit ScreenOnly layout intent 1')),
    false
  )
})

test('the committed scene must be the probe screen alone', () => {
  const screen = { kind: 'screen', deviceId: SCREEN, visible: true }
  assert.deepEqual(windowsD3d11SceneScreenOnlyFailures({ sources: [screen] }, SCREEN), [])
  // The renderer's synthetic-source scene that landed after the ScreenOnly commit.
  assert.deepEqual(
    windowsD3d11SceneScreenOnlyFailures(
      {
        sources: [
          { kind: 'test-pattern' },
          { kind: 'camera', deviceId: 'camera:windows-dshow:c920' }
        ]
      },
      SCREEN
    ),
    ['unexpected test-pattern source', 'unexpected camera source', '0 screen sources']
  )
  assert.deepEqual(
    windowsD3d11SceneScreenOnlyFailures(
      { sources: [screen, { kind: 'camera', deviceId: 'camera:windows-dshow:c920' }] },
      SCREEN
    ),
    ['unexpected camera source']
  )
  assert.deepEqual(
    windowsD3d11SceneScreenOnlyFailures(
      { sources: [{ ...screen, deviceId: 'screen:dxgi:other:0' }] },
      SCREEN
    ),
    ['screen=screen:dxgi:other:0']
  )
  assert.deepEqual(windowsD3d11SceneScreenOnlyFailures(null, SCREEN), ['scene has no sources'])
})
