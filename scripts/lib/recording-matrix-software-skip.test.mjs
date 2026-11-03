import assert from 'node:assert/strict'
import test from 'node:test'

import {
  hardContentStressReason,
  OPENH264_ENCODE_BACKEND,
  softwareSkipWarning
} from './recording-matrix-software-skip.mjs'

test('a declared stress combo stays under the stress contract on any backend', () => {
  assert.equal(
    hardContentStressReason({ stress: true, hardContent: true, encodeBackend: 'videotoolbox' }),
    'stress combo'
  )
})

test('hard content on OpenH264 runs under the stress contract with the reason named', () => {
  assert.match(
    hardContentStressReason({
      stress: false,
      hardContent: true,
      encodeBackend: OPENH264_ENCODE_BACKEND
    }),
    /OpenH264 skips frames/
  )
})

test('easy content on OpenH264 and hard content on a hardware encoder keep full cadence', () => {
  assert.equal(
    hardContentStressReason({
      stress: false,
      hardContent: false,
      encodeBackend: OPENH264_ENCODE_BACKEND
    }),
    null
  )
  for (const encodeBackend of ['videotoolbox', 'vaapi', 'media-foundation', undefined]) {
    assert.equal(hardContentStressReason({ stress: false, hardContent: true, encodeBackend }), null)
  }
})

test('the warning names the observed and requested cadence', () => {
  assert.equal(
    softwareSkipWarning({ label: '1080p60:hard', requestedFps: 60, observedFps: 8.5 }),
    '1080p60:hard: OpenH264 held 8.50 fps of 60 under per-frame noise; frame skipping on overshoot is the software encoder posture, so cadence is not gated here'
  )
  assert.match(
    softwareSkipWarning({ label: 'x', requestedFps: 60, observedFps: null }),
    /unknown fps/
  )
})
