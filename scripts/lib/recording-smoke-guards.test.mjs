import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'

import {
  assertFinalizedRecordingStop,
  assertNoZeroByteMkvsCreatedAfter,
  assertNoZeroByteScenarioMkvs,
  assertPublishedRecordingMp4,
  assertTerminalRecordingStop,
  snapshotScenarioMkvPaths,
  zeroByteScenarioMkvPaths
} from './recording-smoke-guards.mjs'

const temporaryDirectories = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('recording smoke terminal guard', () => {
  it('accepts terminal idle for the session returned by start', () => {
    assert.doesNotThrow(() =>
      assertTerminalRecordingStop({
        scenarioLabel: 'Camera only',
        started: { sessionId: 'session-camera', state: 'recording' },
        stopped: { sessionId: 'session-camera', state: 'idle' }
      })
    )
  })

  it('rejects a failed stop before artifact checks and includes backend diagnostics', () => {
    assert.throws(
      () =>
        assertTerminalRecordingStop({
          scenarioLabel: 'Camera only',
          started: { sessionId: 'session-camera', state: 'recording' },
          stopped: {
            sessionId: 'session-camera',
            state: 'failed',
            message: 'Recording process did not finalize.'
          },
          healthEvents: [
            {
              level: 'error',
              code: 'ffmpeg-exit',
              message: 'FFmpeg exited with signal 9 (SIGKILL).'
            }
          ]
        }),
      (error) => {
        assert.match(error.message, /Camera only/)
        assert.match(
          error.message,
          /expected session-camera\/idle; received session-camera\/failed/
        )
        assert.match(error.message, /Recording process did not finalize/)
        assert.match(error.message, /ffmpeg-exit/)
        assert.match(error.message, /SIGKILL/)
        return true
      }
    )
  })

  it('rejects an idle response for a different session and surfaces health lookup failure', () => {
    assert.throws(
      () =>
        assertTerminalRecordingStop({
          scenarioLabel: 'Screen only',
          started: { sessionId: 'session-screen', state: 'recording' },
          stopped: { sessionId: 'session-other', state: 'idle' },
          healthLookupError: new Error('database unavailable')
        }),
      /expected session-screen\/idle; received session-other\/idle.*database unavailable/
    )
  })
})

describe('recording smoke orphan MKV guard', () => {
  it('finds only zero-byte MKVs scoped to the current scenario session', () => {
    const directory = makeTemporaryDirectory()
    const currentMkv = join(directory, 'videorc-session-session-camera.mkv')
    const unrelatedMkv = join(directory, 'videorc-session-session-other.mkv')
    const completedMkv = join(directory, 'videorc-session-session-camera-recovery.mkv')
    writeFileSync(currentMkv, '')
    writeFileSync(unrelatedMkv, '')
    writeFileSync(completedMkv, 'recording bytes')

    assert.deepEqual(
      zeroByteScenarioMkvPaths({
        outputDirectory: directory,
        sessionId: 'session-camera',
        outputPaths: []
      }),
      [currentMkv]
    )
  })

  it('checks the exact staged MKV sibling when stop returns an MP4 path', () => {
    const directory = makeTemporaryDirectory()
    const mp4 = join(directory, 'custom-name.mp4')
    const stagedMkv = join(directory, 'custom-name.mkv')
    writeFileSync(mp4, 'recording bytes')
    writeFileSync(stagedMkv, '')

    assert.throws(
      () =>
        assertNoZeroByteScenarioMkvs({
          scenarioLabel: 'Camera only',
          outputDirectory: directory,
          sessionId: 'session-camera',
          outputPaths: [mp4]
        }),
      /Camera only.*zero-byte MKV.*custom-name\.mkv/
    )
  })

  it('allows unrelated zero-byte MKVs and nonempty scenario MKVs', () => {
    const directory = makeTemporaryDirectory()
    const currentMkv = join(directory, 'videorc-session-session-camera.mkv')
    const unrelatedMkv = join(directory, 'videorc-session-session-other.mkv')
    writeFileSync(currentMkv, 'recording bytes')
    writeFileSync(unrelatedMkv, '')

    assert.doesNotThrow(() =>
      assertNoZeroByteScenarioMkvs({
        scenarioLabel: 'Camera only',
        outputDirectory: directory,
        sessionId: 'session-camera',
        outputPaths: [currentMkv]
      })
    )
  })

  it('reports a zero-byte MKV created by a rejected start', () => {
    const directory = makeTemporaryDirectory()
    const existing = join(directory, 'existing.mkv')
    writeFileSync(existing, '')
    const beforePaths = snapshotScenarioMkvPaths({ outputDirectory: directory })
    const orphan = join(directory, 'videorc-session-rejected.mkv')
    writeFileSync(orphan, '')

    assert.throws(
      () =>
        assertNoZeroByteMkvsCreatedAfter({
          scenarioLabel: 'Camera only',
          outputDirectory: directory,
          beforePaths,
          startupError: new Error('FFmpeg output startup failed')
        }),
      /Camera only.*session\.start failed.*rejected\.mkv.*FFmpeg output startup failed/
    )
  })
})

describe('recording smoke MP4 publication guard', () => {
  it('accepts a finalized MP4 without diagnostics', () => {
    assert.doesNotThrow(() =>
      assertPublishedRecordingMp4({
        scenarioLabel: 'Camera only',
        stopped: { state: 'idle', outputPath: '/tmp/camera.mp4' }
      })
    )
  })

  it('rejects an idle MKV recovery and surfaces the export failure', () => {
    assert.throws(
      () =>
        assertPublishedRecordingMp4({
          scenarioLabel: 'Camera only',
          stopped: { state: 'idle', outputPath: '/tmp/camera.mkv' },
          healthEvents: [
            {
              level: 'warn',
              code: 'mp4-export-failed',
              message: 'The MKV recovery file was preserved.'
            }
          ]
        }),
      /Camera only.*required MP4.*camera\.mkv.*mp4-export-failed.*MKV recovery/
    )
  })
})

describe('recording smoke finalized-stop guard', () => {
  it('rejects a nonempty MKV recovery and includes mp4-export-failed health context', async () => {
    const directory = makeTemporaryDirectory()
    const recoveryPath = join(directory, 'camera.mkv')
    writeFileSync(recoveryPath, 'preserved recording bytes')

    await assert.rejects(
      () =>
        assertFinalizedRecordingStop({
          scenarioLabel: 'Long recording',
          started: { sessionId: 'session-camera', state: 'recording' },
          stopped: {
            sessionId: 'session-camera',
            state: 'idle',
            outputPath: recoveryPath
          },
          loadHealthEvents: async () => [
            {
              level: 'warn',
              code: 'mp4-export-failed',
              message: 'The MKV recovery file was preserved.'
            }
          ]
        }),
      /Long recording.*required MP4.*camera\.mkv.*mp4-export-failed.*MKV recovery/
    )
  })

  it('rejects an idle MP4 response for a different session with health context', async () => {
    let healthSessionId

    await assert.rejects(
      () =>
        assertFinalizedRecordingStop({
          scenarioLabel: 'Long recording',
          started: { sessionId: 'session-started', state: 'recording' },
          stopped: {
            sessionId: 'session-other',
            state: 'idle',
            outputPath: '/tmp/recording.mp4'
          },
          loadHealthEvents: async (sessionId) => {
            healthSessionId = sessionId
            return [
              {
                level: 'error',
                code: 'session-stop-mismatch',
                message: 'Unexpected terminal session response.'
              }
            ]
          }
        }),
      /Long recording.*expected session-started\/idle; received session-other\/idle.*session-stop-mismatch/
    )
    assert.equal(healthSessionId, 'session-started')
  })

  it('accepts a terminal MP4 for the started session without loading failure diagnostics', async () => {
    let healthLookupCalled = false

    await assert.doesNotReject(() =>
      assertFinalizedRecordingStop({
        scenarioLabel: 'Long recording',
        started: { sessionId: 'session-started', state: 'recording' },
        stopped: {
          sessionId: 'session-started',
          state: 'idle',
          outputPath: '/tmp/recording.mp4'
        },
        loadHealthEvents: async () => {
          healthLookupCalled = true
          return []
        }
      })
    )
    assert.equal(healthLookupCalled, false)
  })
})

function makeTemporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'videorc-recording-smoke-guards-'))
  temporaryDirectories.push(directory)
  return directory
}
