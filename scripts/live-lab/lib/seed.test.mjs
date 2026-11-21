import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CAPTURE_CONFIG_KEY,
  ONBOARDING_DISMISSED_VALUE,
  ONBOARDING_KEY,
  SCENES_KEY,
  SeedRefused,
  WORKING_SCENE_KEY,
  YOUTUBE_RTMPS_URL,
  buildCaptureConfig,
  buildWorkingScene,
  pickLabDevices,
  plannedTargets,
  pickLinuxLabDevices,
  seedProfile,
  verifySeededConfig
} from './seed.mjs'

const KEY = 'abcd-efgh-ijkl-mnop-qrst'
const CONFIG = {
  streamKeys: { horizontal: { label: 'Videorc lab', key: KEY } },
  labDisplay: { name: 'Lab Dummy' }
}
const DEVICES = {
  devices: [
    { id: 'screen:1', name: 'Built-in Retina Display', kind: 'screen', status: 'available' },
    { id: 'screen:2', name: 'Lab Dummy', kind: 'screen', status: 'available' },
    { id: 'mic:room', name: 'MacBook Pro Microphone', kind: 'microphone', status: 'available' },
    { id: 'mic:bh', name: 'BlackHole 2ch', kind: 'microphone', status: 'available' },
    { id: 'cam:1', name: 'FaceTime HD Camera', kind: 'camera', status: 'available' }
  ]
}
const YOUTUBE = { destination: 'youtube', orientations: ['horizontal'] }
const LOCAL = { destination: 'local-sink', orientations: ['horizontal'] }
const SINK = { serverUrl: 'rtmp://127.0.0.1:19350/live', streamKey: 'dry0123456789ab' }

test('only the lab display and BlackHole are picked; anything else is a refusal', () => {
  assert.deepEqual(pickLabDevices(DEVICES, 'Lab Dummy'), {
    screen: { id: 'screen:2', name: 'Lab Dummy' },
    microphone: { id: 'mic:bh', name: 'BlackHole 2ch' }
  })
  const code = (fn) => {
    try {
      fn()
    } catch (error) {
      assert.ok(error instanceof SeedRefused)
      return error.code
    }
    return null
  }
  assert.equal(
    code(() => pickLabDevices(DEVICES, undefined)),
    'no-lab-display'
  )
  assert.equal(
    code(() => pickLabDevices(DEVICES, 'Other')),
    'lab-display-missing'
  )
  assert.equal(
    code(() =>
      pickLabDevices({ devices: DEVICES.devices.filter((d) => d.id !== 'mic:bh') }, 'Lab Dummy')
    ),
    'blackhole-missing'
  )
  assert.equal(
    code(() =>
      pickLabDevices(
        {
          devices: DEVICES.devices.map((d) =>
            d.id === 'screen:2' ? { ...d, status: 'permission-required' } : d
          )
        },
        'Lab Dummy'
      )
    ),
    'lab-display-unavailable'
  )
})

test('plan 213 F1: the lab display is found under its macOS name with its size', () => {
  const sized = {
    devices: DEVICES.devices.map((d) =>
      d.id === 'screen:2' ? { ...d, name: 'Lab Dummy · 1920 × 1080' } : d
    )
  }
  assert.deepEqual(pickLabDevices(sized, 'Lab Dummy').screen, {
    id: 'screen:2',
    name: 'Lab Dummy · 1920 × 1080'
  })
  assert.equal(pickLabDevices(sized, 'Lab Dummy · 1920 × 1080').screen.id, 'screen:2')
  assert.throws(() => pickLabDevices(sized, 'Lab'), { code: 'lab-display-missing' })
})

test('local-sink scenarios stream only to the loopback sink; YouTube ones use the configured keys over RTMPS', () => {
  const local = plannedTargets({
    scenario: LOCAL,
    config: CONFIG,
    sink: SINK,
    titlePrefix: 'Automated test'
  })
  assert.deepEqual(
    local.map((t) => [t.id, t.serverUrl, t.streamKey]),
    [['youtube', SINK.serverUrl, SINK.streamKey]]
  )
  assert.throws(
    () =>
      plannedTargets({
        scenario: LOCAL,
        config: CONFIG,
        sink: { ...SINK, serverUrl: YOUTUBE_RTMPS_URL },
        titlePrefix: 'x'
      }),
    /loopback/
  )
  const live = plannedTargets({ scenario: YOUTUBE, config: CONFIG, sink: null, titlePrefix: 'x' })
  assert.deepEqual(
    live.map((t) => [t.id, t.serverUrl, t.label]),
    [['youtube', YOUTUBE_RTMPS_URL, 'Videorc lab']]
  )
  assert.throws(
    () =>
      plannedTargets({
        scenario: { ...YOUTUBE, orientations: ['vertical'] },
        config: CONFIG,
        titlePrefix: 'x'
      }),
    /No vertical stream key/
  )
})

test('the saved Studio config never holds the raw key and disables every other destination', () => {
  const existing = {
    sources: { cameraId: 'cam:1', screenId: 'screen:1' },
    layout: { layoutPreset: 'screen-camera', cameraSize: 'large' },
    streaming: {
      targets: [
        { id: 'twitch', enabled: true, serverUrl: 'rtmp://live.twitch.tv/app' },
        { id: 'youtube', enabled: false, createdAt: '2026-01-01T00:00:00.000Z' }
      ]
    },
    captions: { enabled: true, styleId: 'glass' }
  }
  const config = buildCaptureConfig({
    existing,
    devices: pickLabDevices(DEVICES, 'Lab Dummy'),
    targets: plannedTargets({ scenario: YOUTUBE, config: CONFIG, titlePrefix: 'x' }),
    stored: {
      youtube: {
        streamKeyPresent: true,
        streamKeySecretRef: 'stream-target:youtube:manual-stream-key',
        streamKeyHint: '••••qrst'
      }
    },
    now: new Date('2026-10-12T06:00:00.000Z')
  })
  assert.ok(!JSON.stringify(config).includes(KEY))
  assert.deepEqual(config.sources, {
    screenId: 'screen:2',
    screenName: 'Lab Dummy',
    cameraOff: true,
    microphoneId: 'mic:bh',
    microphoneName: 'BlackHole 2ch',
    testPattern: false
  })
  assert.equal(config.layout.layoutPreset, 'screen-only')
  assert.equal(config.layout.cameraSize, 'large')
  assert.equal(config.captions.enabled, false)
  assert.equal(config.streamEnabled, true)
  assert.equal(config.recordEnabled, false)
  assert.deepEqual(config.streaming.enabledTargetIds, ['youtube'])
  const youtube = config.streaming.targets.find((t) => t.id === 'youtube')
  assert.equal(youtube.streamKey, '')
  assert.equal(youtube.streamKeySecretRef, 'stream-target:youtube:manual-stream-key')
  assert.equal(youtube.createdAt, '2026-01-01T00:00:00.000Z')
  assert.equal(config.streaming.targets.find((t) => t.id === 'twitch').enabled, false)
  assert.throws(
    () =>
      buildCaptureConfig({
        existing: null,
        devices: pickLabDevices(DEVICES, 'Lab Dummy'),
        targets: plannedTargets({ scenario: YOUTUBE, config: CONFIG, titlePrefix: 'x' }),
        stored: {}
      }),
    /did not confirm/
  )
})

test('verifySeededConfig catches a seed that did not take', () => {
  const devices = pickLabDevices(DEVICES, 'Lab Dummy')
  const targets = plannedTargets({ scenario: LOCAL, config: CONFIG, sink: SINK, titlePrefix: 'x' })
  const good = {
    sources: { screenId: 'screen:2', microphoneId: 'mic:bh' },
    layout: { layoutPreset: 'screen-only' },
    streamEnabled: true,
    streaming: {
      targets: [{ id: 'youtube', enabled: true, serverUrl: SINK.serverUrl, streamKey: '' }]
    }
  }
  assert.deepEqual(verifySeededConfig(good, { targets, devices, scenario: LOCAL }), [])
  const bad = {
    sources: { screenId: 'screen:1', microphoneId: 'mic:room', cameraId: 'cam:1' },
    streamEnabled: false,
    streaming: {
      targets: [
        { id: 'youtube', enabled: true, serverUrl: YOUTUBE_RTMPS_URL, streamKey: KEY },
        { id: 'twitch', enabled: true }
      ]
    }
  }
  const problems = verifySeededConfig(bad, { targets, devices, scenario: LOCAL })
  for (const expected of [
    /lab display/,
    /BlackHole/,
    /camera/,
    /streaming is off/,
    /enabled destinations/,
    /raw key/,
    /not the loopback sink/
  ]) {
    assert.ok(
      problems.some((problem) => expected.test(problem)),
      String(expected)
    )
  }
})

test('verifySeededConfig reads the working scene, the scene on stream and the backend scene', () => {
  const devices = pickLabDevices(DEVICES, 'Lab Dummy')
  const targets = plannedTargets({ scenario: LOCAL, config: CONFIG, sink: SINK, titlePrefix: 'x' })
  const saved = {
    sources: { screenId: 'screen:2', microphoneId: 'mic:bh' },
    layout: { layoutPreset: 'screen-only' },
    streamEnabled: true,
    streaming: { targets: [{ id: 'youtube', enabled: true, serverUrl: SINK.serverUrl }] }
  }
  const working = {
    visual: { layout: { layoutPreset: 'screen-only' }, sources: { cameraOff: true } }
  }
  const check = (overrides) =>
    verifySeededConfig(saved, {
      targets,
      devices,
      scenario: LOCAL,
      working,
      onStreamId: 'default-screen-only',
      labSceneId: 'default-screen-only',
      sceneSources: [{ kind: 'screen', deviceId: 'screen:2', name: 'Lab Dummy' }],
      ...overrides
    })
  assert.deepEqual(check({}), [])
  assert.deepEqual(
    check({
      working: {
        visual: {
          layout: { layoutPreset: 'screen-camera' },
          sources: { cameraId: 'cam:1', cameraOff: false }
        }
      },
      onStreamId: 'default-screen-camera',
      sceneSources: [
        { kind: 'screen', deviceId: 'screen:2', name: 'Lab Dummy' },
        { kind: 'camera', deviceId: 'cam:1', name: 'FaceTime HD Camera' }
      ]
    }),
    [
      'the working scene keeps a camera',
      "the working scene's layout is screen-camera",
      'the scene on stream is default-screen-camera, not default-screen-only',
      "the backend's scene shows a camera"
    ]
  )
  assert.deepEqual(check({ working: null, sceneSources: null }), [
    'the Studio has no working scene',
    'the backend has no scene'
  ])
})

// A new profile's scenes v2 library (scenes-migration.ts defaultScenes): the
// first scene, "Screen + camera", is on stream with the first camera.
const SCREEN_CAMERA_LIBRARY = {
  version: 2,
  onStreamId: 'default-screen-camera',
  scenes: [
    {
      id: 'default-screen-camera',
      name: 'Screen + camera',
      shows: { kind: 'display', screenId: 'screen:2' },
      layouts: {
        horizontal: {
          layoutPreset: 'screen-camera',
          arrangementMode: 'preset',
          cameraSize: 'medium'
        },
        vertical: { layoutPreset: 'vertical-camera-top', arrangementMode: 'preset' }
      },
      background: null
    },
    {
      id: 'default-screen-only',
      name: 'Screen only',
      shows: { kind: 'display', screenId: 'screen:2' },
      layouts: {
        horizontal: {
          layoutPreset: 'screen-only',
          arrangementMode: 'preset',
          cameraSize: 'medium'
        },
        vertical: { layoutPreset: 'vertical-screen-only', arrangementMode: 'preset' }
      },
      background: { kind: 'color', value: '#000000' }
    }
  ]
}
const CAMERA_WORKING = {
  version: 1,
  origin: 'builtin',
  sceneId: 'default-screen-camera',
  visual: {
    layout: { layoutPreset: 'screen-camera', arrangementMode: 'preset', cameraSize: 'medium' },
    sources: {
      cameraId: 'cam:1',
      cameraName: 'FaceTime HD Camera',
      cameraOff: false,
      screenId: 'screen:2'
    },
    background: null
  }
}

test('the working scene puts Screen only on stream with no camera', () => {
  const devices = pickLabDevices(DEVICES, 'Lab Dummy')
  const { working, library } = buildWorkingScene({
    existingWorking: CAMERA_WORKING,
    library: SCREEN_CAMERA_LIBRARY,
    devices
  })
  assert.deepEqual(working, {
    version: 1,
    origin: 'saved',
    sceneId: 'default-screen-only',
    visual: {
      layout: { layoutPreset: 'screen-only', arrangementMode: 'preset', cameraSize: 'medium' },
      sources: {
        screenId: 'screen:2',
        screenName: 'Lab Dummy',
        cameraOff: true,
        captureOff: false,
        testPattern: false
      },
      background: { kind: 'color', value: '#000000' }
    }
  })
  assert.equal(library.onStreamId, 'default-screen-only')
  assert.deepEqual(library.scenes, SCREEN_CAMERA_LIBRARY.scenes)
  // Before the app made a library: a built-in working scene, no library write.
  const bare = buildWorkingScene({ existingWorking: null, library: null, devices })
  assert.equal(bare.working.sceneId, null)
  assert.equal(bare.working.visual.layout.layoutPreset, 'screen-only')
  assert.equal(bare.library, null)
  assert.throws(
    () =>
      buildWorkingScene({
        existingWorking: null,
        library: { version: 2, scenes: [SCREEN_CAMERA_LIBRARY.scenes[0]] },
        devices
      }),
    /no "Screen only" scene/
  )
})

/**
 * A fake Studio over a Map-backed localStorage. On reload it starts the way
 * use-studio.tsx does: the working scene's sources and layout override the
 * saved config, and its scene goes to the backend. `settleAfterPolls` delays
 * that, like the real re-persist a few seconds after the reload.
 */
function fakeStudio({ storage = {}, settleAfterPolls = 2, ignoresWorkingScene = false } = {}) {
  const store = new Map(Object.entries(storage).map(([k, v]) => [k, JSON.stringify(v)]))
  const localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value))
  }
  const calls = []
  let backendScene = { sources: [{ kind: 'camera', deviceId: 'cam:1', name: 'FaceTime' }] }
  let pending = null
  const restart = () => {
    const config = JSON.parse(store.get('videorc.captureConfig'))
    const working = ignoresWorkingScene
      ? CAMERA_WORKING
      : JSON.parse(store.get('videorc.working-scene.v1') ?? 'null')
    if (!working) return
    const sources = { ...config.sources, ...working.visual.sources }
    store.set(
      'videorc.captureConfig',
      JSON.stringify({ ...config, sources, layout: working.visual.layout })
    )
    backendScene = {
      sources: [
        { kind: 'screen', deviceId: sources.screenId, name: 'screen' },
        ...(sources.cameraId && !sources.cameraOff
          ? [{ kind: 'camera', deviceId: sources.cameraId, name: 'camera' }]
          : [])
      ]
    }
  }
  return {
    store,
    calls,
    rpc: async (method, params) => {
      calls.push({ method, params })
      if (method === 'devices.list') return DEVICES
      if (method === 'streamTargets.manualKey.store')
        return {
          streamKeyPresent: true,
          streamKeySecretRef: `stream-target:${params.targetId}:manual-stream-key`,
          streamKeyHint: '••••'
        }
      if (method === 'remote.control.enable')
        return { enabled: true, port: 51234, token: 'remote-token-value', discoveryPath: '/x' }
      if (method === 'scene.get') {
        if (pending !== null && --pending <= 0) {
          pending = null
          restart()
        }
        return backendScene
      }
      throw new Error(method)
    },
    evaluate: async (expression) =>
      new Function('localStorage', `return ${expression}`)(localStorage),
    reloadAndWait: async () => {
      calls.push({ method: 'reload' })
      pending = settleAfterPolls
    }
  }
}

function fakeTime() {
  let at = 0
  return { now: () => at, sleep: async (ms) => void (at += ms) }
}

test('seedProfile stores the key, writes the Studio over CDP, reloads and waits for what the app does', async () => {
  const studio = fakeStudio({
    storage: {
      'videorc.captureConfig': {
        sources: { cameraId: 'cam:1', screenId: 'screen:2' },
        layout: { layoutPreset: 'screen-camera' }
      },
      'videorc.working-scene.v1': CAMERA_WORKING,
      'videorc.scenes.v2': SCREEN_CAMERA_LIBRARY
    }
  })
  const result = await seedProfile({
    platform: 'darwin',
    rpc: studio.rpc,
    evaluate: studio.evaluate,
    reloadAndWait: studio.reloadAndWait,
    scenario: LOCAL,
    config: CONFIG,
    sink: SINK,
    titlePrefix: 'Automated test',
    ...fakeTime()
  })
  assert.deepEqual(
    studio.calls.map((call) => call.method),
    [
      'devices.list',
      'streamTargets.manualKey.store',
      'remote.control.enable',
      'reload',
      'scene.get',
      'scene.get'
    ]
  )
  assert.deepEqual(studio.calls[1].params, { targetId: 'youtube', streamKey: SINK.streamKey })
  assert.deepEqual(result.targetIds, ['youtube'])
  assert.deepEqual(result.remote, { host: '127.0.0.1', port: 51234, token: 'remote-token-value' })
  const saved = JSON.parse(studio.store.get(CAPTURE_CONFIG_KEY))
  assert.equal(saved.streaming.targets[0].serverUrl, SINK.serverUrl)
  assert.equal(saved.sources.cameraId, undefined)
  assert.equal(saved.layout.layoutPreset, 'screen-only')
  assert.equal(JSON.parse(studio.store.get(SCENES_KEY)).onStreamId, 'default-screen-only')
  assert.equal(JSON.parse(studio.store.get(WORKING_SCENE_KEY)).sceneId, 'default-screen-only')
  assert.equal(studio.store.get(ONBOARDING_KEY), ONBOARDING_DISMISSED_VALUE)
  assert.equal(CAPTURE_CONFIG_KEY, 'videorc.captureConfig')
})

test('a Studio that puts its camera back after the reload is a refusal, at the deadline', async () => {
  // The pre-fix race: the first read after the reload still sees the seed's
  // own write; the app's camera comes back a moment later.
  const studio = fakeStudio({
    storage: {
      'videorc.working-scene.v1': CAMERA_WORKING,
      'videorc.scenes.v2': SCREEN_CAMERA_LIBRARY
    },
    ignoresWorkingScene: true
  })
  await assert.rejects(
    seedProfile({
      platform: 'darwin',
      rpc: studio.rpc,
      evaluate: studio.evaluate,
      reloadAndWait: studio.reloadAndWait,
      scenario: LOCAL,
      config: CONFIG,
      sink: SINK,
      titlePrefix: 'Automated test',
      settleDeadlineMs: 5000,
      ...fakeTime()
    }),
    (error) =>
      error.code === 'seed-not-applied' &&
      /a camera is selected/.test(error.message) &&
      /the backend's scene shows a camera/.test(error.message)
  )
})

// Plan 179: Linux lists one portal screen row and Pulse microphones whose
// detail names the source. Only the lab remap source is ever picked.
const LINUX_DEVICES = {
  devices: [
    {
      id: 'screen:portal:monitor',
      name: 'Screen (portal)',
      kind: 'screen',
      status: 'available'
    },
    { id: 'window:portal:window', name: 'Window (portal)', kind: 'window', status: 'available' },
    {
      id: 'microphone:linux-pulse:616c7361',
      name: 'Built-in Audio Analog Stereo',
      kind: 'microphone',
      status: 'available',
      detail:
        'PulseAudio/PipeWire source alsa_input.pci-0000_00_1f.3.analog-stereo (system default)'
    },
    {
      id: 'microphone:linux-pulse:766964',
      name: 'Videorc-Lab-Mic',
      kind: 'microphone',
      status: 'available',
      detail: 'PulseAudio/PipeWire source videorc_lab_mic'
    }
  ]
}

test('plan 179: Linux picks the portal screen and the lab remap source, nothing else', () => {
  assert.deepEqual(pickLinuxLabDevices(LINUX_DEVICES), {
    screen: { id: 'screen:portal:monitor', name: 'Screen (portal)' },
    microphone: { id: 'microphone:linux-pulse:766964', name: 'Videorc-Lab-Mic' }
  })
  const code = (list) => {
    try {
      pickLinuxLabDevices(list)
      return null
    } catch (error) {
      return error.code
    }
  }
  const without = (predicate) => ({ devices: LINUX_DEVICES.devices.filter((d) => !predicate(d)) })
  assert.equal(code(without((d) => d.kind === 'screen')), 'lab-display-missing')
  assert.equal(code(without((d) => d.name === 'Videorc-Lab-Mic')), 'lab-mic-missing')
  // A description that looks right is not enough: the source name decides.
  const lookalike = {
    devices: LINUX_DEVICES.devices.map((d) =>
      d.name === 'Videorc-Lab-Mic'
        ? { ...d, detail: 'PulseAudio/PipeWire source videorc_lab_mic_room' }
        : d
    )
  }
  assert.equal(code(lookalike), 'lab-mic-missing')
  const unavailable = {
    devices: LINUX_DEVICES.devices.map((d) =>
      d.kind === 'screen' ? { ...d, status: 'unavailable', detail: 'no portal' } : d
    )
  }
  assert.equal(code(unavailable), 'lab-display-unavailable')
})

test('a backend scene the seed cannot read is no confirmation: a refusal at the deadline', async () => {
  const studio = fakeStudio({
    storage: {
      'videorc.working-scene.v1': CAMERA_WORKING,
      'videorc.scenes.v2': SCREEN_CAMERA_LIBRARY
    },
    settleAfterPolls: 0
  })
  const rpc = async (method, params) => {
    if (method === 'scene.get') throw new Error('scene.get timed out')
    return studio.rpc(method, params)
  }
  await assert.rejects(
    seedProfile({
      platform: 'darwin',
      rpc,
      evaluate: studio.evaluate,
      reloadAndWait: studio.reloadAndWait,
      scenario: LOCAL,
      config: CONFIG,
      sink: SINK,
      titlePrefix: 'Automated test',
      settleDeadlineMs: 2000,
      ...fakeTime()
    }),
    (error) => error.code === 'seed-not-applied' && /the backend has no scene/.test(error.message)
  )
})
