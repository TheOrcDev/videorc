import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  describeWindowsMicrophoneRoute,
  windowsDevMicrophoneRoute,
  workerFallbackCount
} from './windows-microphone-route.mjs'

const ROOT = 'D:\\videorc\\.claude\\worktrees\\slot'
const BIN = `${ROOT}\\vendor\\ffmpeg\\windows-x64\\bin`

function existing(...paths) {
  const set = new Set(paths)
  return (path) => set.has(path)
}

test('a bundled FFmpeg with its capture worker takes the packaged route', () => {
  const route = windowsDevMicrophoneRoute(ROOT, {
    exists: existing(`${BIN}\\ffmpeg.exe`, `${BIN}\\ffmpeg-capture.exe`)
  })
  assert.equal(route.route, 'capture-worker')
  assert.equal(route.bundledFfmpeg, `${BIN}\\ffmpeg.exe`)
  assert.equal(route.worker, `${BIN}\\ffmpeg-capture.exe`)
  assert.equal(route.reason, null)
  assert.match(describeWindowsMicrophoneRoute(route), /capture worker/)
})

test('a bundled FFmpeg without the worker is the DirectShow fallback', () => {
  const route = windowsDevMicrophoneRoute(ROOT, { exists: existing(`${BIN}\\ffmpeg.exe`) })
  assert.equal(route.route, 'directshow')
  assert.equal(route.bundledFfmpeg, `${BIN}\\ffmpeg.exe`)
  assert.match(route.reason, /ffmpeg-capture\.exe is missing/)
  assert.match(describeWindowsMicrophoneRoute(route), /DirectShow FALLBACK/)
})

test('no bundled FFmpeg means PATH ffmpeg, which never has the worker', () => {
  // Even a worker file in the bin dir does not help: the dev app only passes
  // the bundled path when ffmpeg.exe itself is there.
  const route = windowsDevMicrophoneRoute(ROOT, {
    exists: existing(`${BIN}\\ffmpeg-capture.exe`)
  })
  assert.equal(route.route, 'directshow')
  assert.equal(route.bundledFfmpeg, null)
  assert.match(route.reason, /from PATH/)
})

test('worker fallbacks are counted from health events only', () => {
  const events = [
    { event: 'health.event', payload: { code: 'microphone-capture-worker-fallback' } },
    { event: 'session.log', payload: { code: 'microphone-capture-worker-fallback' } },
    { event: 'health.event', payload: { code: 'system-audio-lost' } },
    { event: 'health.event', payload: { code: 'microphone-capture-worker-fallback' } }
  ]
  assert.equal(workerFallbackCount(events), 2)
})
