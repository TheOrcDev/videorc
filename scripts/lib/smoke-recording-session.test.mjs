import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'

import { recordScenario } from '../smoke-recording-session.mjs'

const temporaryDirectories = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('recordScenario terminal contract', () => {
  it('surfaces stop message and session health before inspecting a failed artifact', async () => {
    const directory = makeTemporaryDirectory()
    const outputPath = join(directory, 'videorc-session-session-camera.mkv')
    writeFileSync(outputPath, '')
    const ws = fakeSocket({
      'session.start': {
        sessionId: 'session-camera',
        state: 'recording',
        outputPath
      },
      'session.stop': {
        sessionId: 'session-camera',
        state: 'failed',
        outputPath,
        message: 'Recording process did not finalize.'
      },
      'sessions.healthEvents.list': {
        events: [
          {
            level: 'error',
            code: 'ffmpeg-exit',
            message: 'FFmpeg exited with signal 9 (SIGKILL).'
          }
        ]
      }
    })

    await assert.rejects(
      recordScenario({
        ws,
        timeoutMs: 1000,
        recordingMs: 0,
        label: 'App',
        outputDirectory: directory,
        ffmpegPath: 'ffmpeg',
        ffprobePath: 'ffprobe',
        analyze: false,
        scenario: { preset: 'camera-only', label: 'Camera only' }
      }),
      (error) => {
        assert.match(error.message, /session\.stop did not confirm terminal idle/)
        assert.match(error.message, /Recording process did not finalize/)
        assert.match(error.message, /ffmpeg-exit/)
        assert.match(error.message, /SIGKILL/)
        assert.doesNotMatch(error.message, /Recording output is empty/)
        return true
      }
    )
    assert.deepEqual(ws.requestedMethods, [
      'session.start',
      'session.stop',
      'sessions.healthEvents.list'
    ])
  })

  it('checks for a scenario-scoped zero-byte MKV after terminal idle', async () => {
    const directory = makeTemporaryDirectory()
    const outputPath = join(directory, 'videorc-session-session-camera.mkv')
    const publishedPath = join(directory, 'videorc-session-session-camera.mp4')
    writeFileSync(outputPath, '')
    writeFileSync(publishedPath, 'published recording')
    const ws = fakeSocket({
      'session.start': {
        sessionId: 'session-camera',
        state: 'recording',
        outputPath
      },
      'session.stop': {
        sessionId: 'session-camera',
        state: 'idle',
        outputPath: publishedPath
      }
    })

    await assert.rejects(
      recordScenario({
        ws,
        timeoutMs: 1000,
        recordingMs: 0,
        label: 'App',
        outputDirectory: directory,
        ffmpegPath: 'ffmpeg',
        ffprobePath: 'ffprobe',
        analyze: false,
        scenario: { preset: 'camera-only', label: 'Camera only' }
      }),
      /Camera only.*zero-byte MKV.*session-camera\.mkv/
    )
    assert.deepEqual(ws.requestedMethods, ['session.start', 'session.stop'])
  })

  it('rejects terminal idle when MP4 export fell back to a nonempty MKV', async () => {
    const directory = makeTemporaryDirectory()
    const outputPath = join(directory, 'videorc-session-session-camera.mkv')
    writeFileSync(outputPath, 'recoverable recording')
    const ws = fakeSocket({
      'session.start': {
        sessionId: 'session-camera',
        state: 'recording',
        outputPath
      },
      'session.stop': {
        sessionId: 'session-camera',
        state: 'idle',
        outputPath
      },
      'sessions.healthEvents.list': {
        events: [
          {
            level: 'warn',
            code: 'mp4-export-failed',
            message: 'The MKV recovery file was preserved.'
          }
        ]
      }
    })

    await assert.rejects(
      recordScenario({
        ws,
        timeoutMs: 1000,
        recordingMs: 0,
        label: 'App',
        outputDirectory: directory,
        ffmpegPath: 'ffmpeg',
        ffprobePath: 'ffprobe',
        analyze: false,
        scenario: { preset: 'camera-only', label: 'Camera only' }
      }),
      /required MP4.*mp4-export-failed/
    )
    assert.deepEqual(ws.requestedMethods, [
      'session.start',
      'session.stop',
      'sessions.healthEvents.list'
    ])
  })

  it('reports a zero-byte MKV left by a rejected session.start', async () => {
    const directory = makeTemporaryDirectory()
    const orphan = join(directory, 'videorc-session-rejected.mkv')
    const ws = fakeSocket({
      'session.start': () => {
        writeFileSync(orphan, '')
        return { errorMessage: 'FFmpeg output startup failed' }
      }
    })

    await assert.rejects(
      recordScenario({
        ws,
        timeoutMs: 1000,
        recordingMs: 0,
        label: 'App',
        outputDirectory: directory,
        ffmpegPath: 'ffmpeg',
        ffprobePath: 'ffprobe',
        analyze: false,
        scenario: { preset: 'camera-only', label: 'Camera only' }
      }),
      /session\.start failed.*rejected\.mkv.*FFmpeg output startup failed/
    )
    assert.deepEqual(ws.requestedMethods, ['session.start'])
  })
})

function fakeSocket(responses) {
  const listeners = new Set()
  return {
    requestedMethods: [],
    addEventListener(type, listener) {
      if (type === 'message') listeners.add(listener)
    },
    removeEventListener(type, listener) {
      if (type === 'message') listeners.delete(listener)
    },
    send(serializedRequest) {
      const request = JSON.parse(serializedRequest)
      this.requestedMethods.push(request.method)
      const configured = responses[request.method]
      if (configured === undefined) {
        throw new Error(`Unexpected smoke request: ${request.method}`)
      }
      const payload = typeof configured === 'function' ? configured() : configured
      queueMicrotask(() => {
        const event = {
          data: JSON.stringify(
            payload?.errorMessage
              ? { id: request.id, ok: false, error: { message: payload.errorMessage } }
              : { id: request.id, ok: true, payload }
          )
        }
        for (const listener of [...listeners]) listener(event)
      })
    }
  }
}

function makeTemporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'videorc-recording-session-'))
  temporaryDirectories.push(directory)
  return directory
}
