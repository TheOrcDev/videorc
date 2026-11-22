import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assessCameraChildCpu,
  assessCameraNativeMode,
  assessCameraPreview,
  assessLinuxDeviceList,
  cameraNativeMode,
  cpuPercent,
  procStatCpuTicks,
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

test('a pegged or DC microphone fails the meter and the recording', () => {
  // ogre 0.20.3, lid shut: the internal mic read a constant -1.0.
  const meter = assessMicMeter({ status: 'ready', peakDb: 0, meanDb: 0 })
  assert.equal(meter.ok, false)
  assert.match(meter.failures[0], /meter mean 0 dB is within 6 dB of full scale/)
  const take = assessMicRecordingAudio({ hasAudio: true, maxVolumeDb: -0.2, meanVolumeDb: -1 })
  assert.equal(take.ok, false)
  assert.match(take.failures[0], /audio mean -1 dB .*pegged or DC microphone/)
  // A loud voice peaks near full scale but averages well below it.
  assert.equal(
    assessMicRecordingAudio({ hasAudio: true, maxVolumeDb: -0.5, meanVolumeDb: -18 }).ok,
    true
  )
  assert.equal(assessMicMeter({ status: 'ready', peakDb: -3, meanDb: -20 }).ok, true)
  // The bound is inclusive and tunable; a missing mean is not a pegged one.
  assert.equal(assessMicMeter({ status: 'ready', peakDb: -1, meanDb: -6 }).ok, true)
  assert.equal(
    assessMicRecordingAudio(
      { hasAudio: true, maxVolumeDb: -1, meanVolumeDb: -4 },
      { maxMeanDb: -3 }
    ).ok,
    true
  )
  assert.equal(assessMicRecordingAudio({ hasAudio: true, maxVolumeDb: -1 }).ok, true)
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

test('plan 257 S2: the camera live message names the native mode it streams', () => {
  assert.deepEqual(
    cameraNativeMode(
      "Linux V4L2 camera preview is using the camera's native NV12 1280x720@30 from /dev/v4l/by-id/x, piped at 1280x720."
    ),
    { format: 'NV12', width: 1280, height: 720, fps: 30 }
  )
  assert.deepEqual(
    cameraNativeMode(
      'Requested 1920x1080@30 was not available; selected native 1280x720 at 1-30 fps. Linux V4L2 camera preview is using MJPG 1280x720@30 from /dev/video2, piped at 1280x720.'
    ),
    { format: 'MJPG', width: 1280, height: 720, fps: 30 }
  )
  const negotiated = {
    message:
      'Linux V4L2 camera preview requested 1920x1080@30 from /dev/video0; the driver streams its nearest mode, piped at 1280x720.'
  }
  assert.equal(cameraNativeMode(negotiated.message), null)
  assert.equal(assessCameraNativeMode(negotiated).ok, false)
  assert.equal(assessCameraNativeMode(null).ok, false)
})

test('plan 257 S2: camera child CPU from /proc stat ticks', () => {
  const stat =
    '4242 (ffmpeg (x) y) S 1 4242 4242 0 -1 4194304 1000 0 0 0 1234 567 0 0 20 0 9 0 100 0 0'
  assert.equal(procStatCpuTicks(stat), 1801)
  assert.equal(procStatCpuTicks('garbage'), null)
  assert.equal(cpuPercent(1000, 1230, 10000, 100), 23)
  assert.equal(cpuPercent(1000, 900, 10000, 100), null)
  assert.equal(cpuPercent(1000, 1100, 0, 100), null)
  assert.equal(assessCameraChildCpu({ cpuPercent: 23.4 }).ok, true)
  assert.match(assessCameraChildCpu({ cpuPercent: 168 }).failures[0], /168\.0 % CPU \(max 40 %\)/)
  assert.equal(assessCameraChildCpu(null).ok, false)
})
