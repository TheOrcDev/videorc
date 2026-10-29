import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assessCameraPreview,
  assessLinuxDeviceList,
  assessLinuxRecordingQuality,
  assessMicMeter,
  assessMicRecordingAudio,
  parseVolumedetect
} from './linux-av-device-gates.mjs'

const devices = [
  { id: 'screen:portal:monitor', kind: 'screen', status: 'available' },
  {
    id: 'microphone:linux-pulse:616c73615f696e707574',
    kind: 'microphone',
    status: 'available',
    name: 'Apple Audio Device Internal Microphone'
  },
  { id: 'camera:linux-v4l2:2f6465762f766964656f30', kind: 'camera', status: 'available' },
  {
    id: 'microphone:linux-pulse-unavailable',
    kind: 'microphone',
    status: 'unavailable',
    detail: 'no pulse'
  }
]

test('device acceptance rejects missing and failing artifact verdicts', () => {
  for (const quality of [null, {}, { verdict: {} }]) {
    assert.equal(assessLinuxRecordingQuality(quality).ok, false)
  }
  for (const failure of ['video froze', 'audio gap', 'A/V skew', 'invalid cadence']) {
    const result = assessLinuxRecordingQuality({ verdict: { failures: [failure] } })
    assert.equal(result.ok, false)
    assert.match(result.failures[0], new RegExp(failure))
  }
  assert.equal(assessLinuxRecordingQuality({ verdict: { failures: [] } }).ok, false)
  assert.deepEqual(
    assessLinuxRecordingQuality({ verdict: { pass: true, failures: [], warnings: [] } }),
    {
      ok: true,
      failures: []
    }
  )
})

test('Linux device lists need an available prefixed row of the kind', () => {
  const mics = assessLinuxDeviceList(devices, 'microphone')
  assert.equal(mics.ok, true)
  assert.equal(mics.devices.length, 1)
  assert.equal(assessLinuxDeviceList(devices, 'camera').ok, true)
  const none = assessLinuxDeviceList(devices.slice(0, 1).concat(devices[3]), 'microphone')
  assert.equal(none.ok, false)
  assert.match(none.failures[0], /microphone:linux-pulse-unavailable \(unavailable: no pulse\)/)
  assert.equal(assessLinuxDeviceList([], 'camera').ok, false)
})

test('the mic meter must measure the device, not report unavailable', () => {
  assert.equal(assessMicMeter({ status: 'ready', peakDb: -30 }).ok, true)
  assert.equal(assessMicMeter({ status: 'silent', peakDb: -60 }).ok, true)
  const old = assessMicMeter({ status: 'unavailable', peakDb: null, message: 'only macOS' })
  assert.equal(old.ok, false)
  assert.match(old.failures.join(';'), /unavailable: only macOS/)
})

test('recorded mic audio must be above digital silence', () => {
  assert.equal(assessMicRecordingAudio({ hasAudio: true, maxVolumeDb: -44.8 }).ok, true)
  const zero = assessMicRecordingAudio({ hasAudio: true, maxVolumeDb: -91, meanVolumeDb: -91 })
  assert.equal(zero.ok, false)
  assert.match(zero.failures[0], /silence, not the microphone/)
  assert.equal(assessMicRecordingAudio({ hasAudio: false, maxVolumeDb: -20 }).ok, false)
  assert.equal(
    assessMicRecordingAudio({ hasAudio: true, maxVolumeDb: Number.NEGATIVE_INFINITY }).ok,
    false
  )
})

test('volumedetect output parses, including -inf', () => {
  const text =
    '[Parsed_volumedetect_0 @ 0x1] mean_volume: -57.7 dB\n[Parsed_volumedetect_0 @ 0x1] max_volume: -44.8 dB\n'
  assert.deepEqual(parseVolumedetect(text), { maxVolumeDb: -44.8, meanVolumeDb: -57.7 })
  assert.deepEqual(parseVolumedetect('max_volume: -inf dB'), {
    maxVolumeDb: Number.NEGATIVE_INFINITY,
    meanVolumeDb: null
  })
  assert.deepEqual(parseVolumedetect(''), { maxVolumeDb: null, meanVolumeDb: null })
})

test('a live camera preview needs frames and dimensions', () => {
  assert.equal(
    assessCameraPreview({ state: 'live', framesCaptured: 40, width: 1280, height: 720 }).ok,
    true
  )
  assert.equal(assessCameraPreview({ state: 'device-missing', message: 'x' }).ok, false)
  assert.match(
    assessCameraPreview({ state: 'live', framesCaptured: 2, width: 1280, height: 720 }).failures[0],
    /framesCaptured=2/
  )
})
