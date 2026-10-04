import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  RECORDING_MATRIX_PROFILES,
  selectRecordingMatrixProfiles
} from './recording-matrix-profiles.mjs'

const originalLabels = [
  '540p30',
  '720p30',
  '1080p30',
  '1080p60',
  '1440p30',
  '1440p60',
  '4K30',
  '4K60',
  'vertical-1080p30',
  'vertical-1440p30',
  'vertical-4K30',
  'floor-360p24'
]
const original1080p30 = { label: '1080p30', width: 1920, height: 1080, fps: 30, bitrateKbps: 6000 }
const original1080p60 = { label: '1080p60', width: 1920, height: 1080, fps: 60, bitrateKbps: 12000 }

const requiredPortraitProfiles = [
  { label: 'vertical-1080p60', width: 1080, height: 1920, fps: 60, bitrateKbps: 12000 },
  { label: 'vertical-1440p60', width: 1440, height: 2560, fps: 60, bitrateKbps: 16000 }
]

function assertRequiredProfile(profiles, required) {
  assert.deepEqual(
    profiles.find((profile) => profile.label === required.label),
    required
  )
}

function assertUniqueLabels(profiles) {
  assert.equal(new Set(profiles.map((profile) => profile.label)).size, profiles.length)
}

describe('recording matrix profile inventory', () => {
  it('preserves every original profile and its relative order', () => {
    assert.deepEqual(
      RECORDING_MATRIX_PROFILES.slice(0, originalLabels.length).map((profile) => profile.label),
      originalLabels
    )
  })

  it('keeps unique labels and refuses a duplicate inventory label', () => {
    assertUniqueLabels(RECORDING_MATRIX_PROFILES)
    assert.throws(() =>
      assertUniqueLabels([...RECORDING_MATRIX_PROFILES, { ...RECORDING_MATRIX_PROFILES[0] }])
    )
  })

  it('keeps the experimental 4K60 tuple pinned and excludes unsupported portrait 4K60', () => {
    assert.deepEqual(
      RECORDING_MATRIX_PROFILES.find((profile) => profile.label === '4K60'),
      {
        label: '4K60',
        width: 3840,
        height: 2160,
        fps: 60,
        bitrateKbps: 50000,
        preset: 'record-4k60-experimental'
      }
    )
    assert.equal(
      RECORDING_MATRIX_PROFILES.some(
        (profile) => profile.width === 2160 && profile.height === 3840 && profile.fps === 60
      ),
      false
    )
  })

  for (const required of requiredPortraitProfiles) {
    it(`includes the supported Custom ${required.label} tuple in the actual inventory and selector`, () => {
      assertRequiredProfile(RECORDING_MATRIX_PROFILES, required)
      assert.deepEqual(selectRecordingMatrixProfiles(required.label), [required])
    })

    it(`rejects omission or 30fps substitution after a valid ${required.label} contract`, () => {
      const present = [
        ...RECORDING_MATRIX_PROFILES.filter((profile) => profile.label !== required.label),
        required
      ]
      assertRequiredProfile(present, required)
      assert.throws(() =>
        assertRequiredProfile(
          present.filter((profile) => profile.label !== required.label),
          required
        )
      )
      assert.throws(() =>
        assertRequiredProfile(
          present.map((profile) =>
            profile.label === required.label ? { ...profile, fps: 30 } : profile
          ),
          required
        )
      )
    })
  }

  it('selects the full inventory for absent or empty filters', () => {
    assert.deepEqual(selectRecordingMatrixProfiles(undefined), RECORDING_MATRIX_PROFILES)
    assert.deepEqual(selectRecordingMatrixProfiles(''), RECORDING_MATRIX_PROFILES)
  })

  it('selects both portrait labels in inventory order with the original comma filter', () => {
    assert.deepEqual(
      selectRecordingMatrixProfiles('vertical-1440p60,vertical-1080p60'),
      RECORDING_MATRIX_PROFILES.filter((profile) =>
        ['vertical-1080p60', 'vertical-1440p60'].includes(profile.label)
      )
    )
  })

  it('retains exact existing-label filtering without trimming or admitting unknown labels', () => {
    assert.deepEqual(selectRecordingMatrixProfiles('1080p60'), [original1080p60])
    assert.deepEqual(selectRecordingMatrixProfiles('1080p30, 1080p60'), [original1080p30])
    assert.deepEqual(selectRecordingMatrixProfiles('unknown'), [])
  })
})
