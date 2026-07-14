import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  assertLiveAudioUpdate,
  evaluateLiveAudioEvidence,
  liveAudioEvidenceWindows,
  parseCaptureMediaClock,
  parseFfmpegMaxVolume,
  projectWallTimeToMediaSeconds,
  selectWindowsDshowCamera,
  selectWindowsDshowMicrophone
} from './windows-live-audio-gates.mjs'

describe('selectWindowsDshowMicrophone', () => {
  const devices = [
    {
      id: 'microphone:windows-dshow:6d69632d31',
      name: 'Mic 1',
      kind: 'microphone',
      status: 'available'
    },
    {
      id: 'microphone:windows-dshow:6d69632d32',
      name: 'Mic 2',
      kind: 'microphone',
      status: 'available'
    }
  ]

  it('selects an explicitly requested available DirectShow microphone', () => {
    assert.equal(
      selectWindowsDshowMicrophone(devices, 'microphone:windows-dshow:6d69632d32')?.name,
      'Mic 2'
    )
  })

  it('falls back to the first available DirectShow microphone', () => {
    assert.equal(selectWindowsDshowMicrophone(devices)?.name, 'Mic 1')
  })

  it('rejects an explicit unavailable or non-DirectShow microphone', () => {
    assert.throws(
      () => selectWindowsDshowMicrophone(devices, 'microphone:coreaudio:42'),
      /was not available as a Windows DirectShow microphone/
    )
  })
})

describe('selectWindowsDshowCamera', () => {
  const devices = [
    {
      id: 'camera:windows-dshow:63616d2d31',
      name: 'Camera 1',
      kind: 'camera',
      status: 'available'
    },
    {
      id: 'camera:windows-dshow:63616d2d32',
      name: 'Camera 2',
      kind: 'camera',
      status: 'available'
    }
  ]

  it('selects an explicit camera or the first available DirectShow camera', () => {
    assert.equal(
      selectWindowsDshowCamera(devices, 'camera:windows-dshow:63616d2d32')?.name,
      'Camera 2'
    )
    assert.equal(selectWindowsDshowCamera(devices)?.name, 'Camera 1')
  })

  it('rejects an explicit unavailable or non-DirectShow camera', () => {
    assert.throws(
      () => selectWindowsDshowCamera(devices, 'camera:avfoundation-native:42'),
      /was not available as a Windows DirectShow camera/
    )
  })
})

describe('assertLiveAudioUpdate', () => {
  it('accepts only the requested applied state for the active session', () => {
    assert.doesNotThrow(() =>
      assertLiveAudioUpdate(
        {
          applied: true,
          sessionId: 'session-1',
          microphoneGainDb: 6,
          microphoneMuted: false
        },
        { sessionId: 'session-1', microphoneGainDb: 6, microphoneMuted: false }
      )
    )
    assert.throws(
      () =>
        assertLiveAudioUpdate(
          {
            applied: false,
            sessionId: 'session-1',
            microphoneGainDb: 6,
            microphoneMuted: false,
            reasonCode: 'live-audio-control-state-unknown'
          },
          { sessionId: 'session-1', microphoneGainDb: 6, microphoneMuted: false }
        ),
      /was not applied/
    )
  })
})

describe('liveAudioEvidenceWindows', () => {
  it('places analysis after acknowledged filter application and before the next command', () => {
    assert.deepEqual(
      liveAudioEvidenceWindows({
        gainAckSeconds: 12,
        muteAckSeconds: 17,
        unmuteAckSeconds: 22,
        stopSeconds: 27
      }),
      {
        baseline: { startSeconds: 7.5, durationSeconds: 1 },
        gained: { startSeconds: 13, durationSeconds: 1 },
        muted: { startSeconds: 18, durationSeconds: 1 },
        restored: { startSeconds: 23, durationSeconds: 1 }
      }
    )
  })

  it('rejects command timings that leave no stable artifact window', () => {
    assert.throws(
      () =>
        liveAudioEvidenceWindows({
          gainAckSeconds: 2,
          muteAckSeconds: 2.5,
          unmuteAckSeconds: 3,
          stopSeconds: 3.5
        }),
      /stable audio evidence window/
    )
  })
})

describe('evaluateLiveAudioEvidence', () => {
  it('passes a six-decibel gain, digital mute, and restored baseline', () => {
    assert.deepEqual(
      evaluateLiveAudioEvidence({
        baselineDb: -24,
        gainedDb: -18.1,
        mutedDb: Number.NEGATIVE_INFINITY,
        restoredDb: -24.2
      }),
      []
    )
  })

  it('reports weak gain, audible mute, and failed restoration independently', () => {
    const failures = evaluateLiveAudioEvidence({
      baselineDb: -24,
      gainedDb: -22,
      mutedDb: -35,
      restoredDb: -18
    })
    assert.equal(failures.length, 3)
    assert.match(failures.join('\n'), /gain delta/)
    assert.match(failures.join('\n'), /mute window/)
    assert.match(failures.join('\n'), /restored window/)
  })
})

describe('parseFfmpegMaxVolume', () => {
  it('parses finite and silent volumedetect output', () => {
    assert.equal(parseFfmpegMaxVolume('[Parsed_volumedetect] max_volume: -18.4 dB'), -18.4)
    assert.equal(
      parseFfmpegMaxVolume('[Parsed_volumedetect] max_volume: -inf dB'),
      Number.NEGATIVE_INFINITY
    )
  })

  it('rejects output without max_volume evidence', () => {
    assert.throws(() => parseFfmpegMaxVolume('no audio'), /did not report max_volume/)
  })
})

describe('capture media clock', () => {
  it('projects wall-clock acknowledgements onto final media PTS', () => {
    const clock = parseCaptureMediaClock('mediaSeconds=2.500', 10_000)
    assert.deepEqual(clock, { mediaSeconds: 2.5, receivedAtMs: 10_000 })
    assert.equal(projectWallTimeToMediaSeconds(clock, 13_250), 5.75)
  })

  it('rejects missing or invalid clock evidence', () => {
    assert.throws(() => parseCaptureMediaClock('progress=continue', 10_000), /was invalid/)
    assert.throws(
      () => projectWallTimeToMediaSeconds({ mediaSeconds: 0, receivedAtMs: 0 }, 10_000),
      /finite timestamps/
    )
  })
})
