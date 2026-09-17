import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { evaluateMicrophoneLossContinuity } from './microphone-loss-gates.mjs'

describe('microphone source-loss recording continuity gate', () => {
  it('accepts one loss event, an active session, idle finalization, and a silent tail', () => {
    assert.deepEqual(
      evaluateMicrophoneLossContinuity({
        sessionId: 'session-1',
        disconnectResult: { disconnected: true },
        healthEvents: [
          {
            sessionId: 'session-1',
            code: 'microphone-input-lost',
            level: 'warn',
            message: 'Microphone stopped.'
          }
        ],
        statusAfterLoss: { state: 'recording', sessionId: 'session-1' },
        stoppedStatus: {
          state: 'idle',
          sessionId: 'session-1',
          outputPath: '/tmp/recording.mp4'
        },
        postLossAudio: { sampleCount: 16_000, peak: 0.0001, rms: 0.00001 }
      }),
      []
    )
  })

  it('rejects a disconnect that kills recording or leaves a recovery MKV', () => {
    const failures = evaluateMicrophoneLossContinuity({
      sessionId: 'session-1',
      disconnectResult: { disconnected: false },
      healthEvents: [],
      statusAfterLoss: { state: 'failed', message: 'audio FIFO closed' },
      stoppedStatus: { state: 'failed', outputPath: '/tmp/recording.mkv' },
      postLossAudio: { sampleCount: 0, peak: 0, rms: 0 }
    })

    assert.ok(failures.some((failure) => failure.includes('did not disconnect')))
    assert.ok(failures.some((failure) => failure.includes('exactly one')))
    assert.ok(failures.some((failure) => failure.includes('did not remain active')))
    assert.ok(failures.some((failure) => failure.includes('did not return to idle')))
    assert.ok(failures.some((failure) => failure.includes('finalized MP4')))
    assert.ok(failures.some((failure) => failure.includes('no decodable samples')))
  })

  it('rejects non-silent padded audio and duplicate source-loss events', () => {
    const loss = {
      sessionId: 'session-1',
      code: 'microphone-input-lost',
      level: 'warn',
      message: 'Microphone stopped.'
    }
    const failures = evaluateMicrophoneLossContinuity({
      sessionId: 'session-1',
      disconnectResult: { disconnected: true },
      healthEvents: [loss, { ...loss, id: 'duplicate' }],
      statusAfterLoss: { state: 'recording' },
      stoppedStatus: { state: 'idle', outputPath: '/tmp/recording.mp4' },
      postLossAudio: { sampleCount: 16_000, peak: 0.02, rms: 0.01 }
    })

    assert.ok(failures.some((failure) => failure.includes('exactly one')))
    assert.ok(failures.some((failure) => failure.includes('not silent')))
  })
})
