import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CAPTURE_CONFIG_KEY,
  SeedRefused,
  YOUTUBE_RTMPS_URL,
  buildCaptureConfig,
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

test('seedProfile stores the key through the backend, writes the config over CDP, reloads and checks', async () => {
  const calls = []
  let saved = null
  const result = await seedProfile({
    platform: 'darwin',
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
      throw new Error(method)
    },
    evaluate: async (expression) => {
      if (expression.startsWith('localStorage.getItem')) return saved
      const match = /localStorage\.setItem\("videorc\.captureConfig", ("(?:[^"\\]|\\.)*")\)/.exec(
        expression
      )
      if (match) saved = JSON.parse(match[1])
      return true
    },
    reloadAndWait: async () => calls.push({ method: 'reload' }),
    scenario: LOCAL,
    config: CONFIG,
    sink: SINK,
    titlePrefix: 'Automated test'
  })
  assert.deepEqual(
    calls.map((call) => call.method),
    ['devices.list', 'streamTargets.manualKey.store', 'remote.control.enable', 'reload']
  )
  assert.deepEqual(calls[1].params, { targetId: 'youtube', streamKey: SINK.streamKey })
  assert.deepEqual(result.targetIds, ['youtube'])
  assert.deepEqual(result.remote, { host: '127.0.0.1', port: 51234, token: 'remote-token-value' })
  assert.equal(JSON.parse(saved).streaming.targets[0].serverUrl, SINK.serverUrl)
  assert.equal(CAPTURE_CONFIG_KEY, 'videorc.captureConfig')
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
