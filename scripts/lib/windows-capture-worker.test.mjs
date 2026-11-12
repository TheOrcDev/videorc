import assert from 'node:assert/strict'
import test from 'node:test'

import { missingWindowsCaptureWorker, windowsCaptureWorkerPath } from './windows-capture-worker.mjs'

test('the worker sits beside the bundled FFmpeg', () => {
  assert.equal(
    windowsCaptureWorkerPath('C:\\repo\\vendor\\ffmpeg\\windows-x64\\bin\\ffmpeg.exe'),
    'C:\\repo\\vendor\\ffmpeg\\windows-x64\\bin\\ffmpeg-capture.exe'
  )
})

test('only Windows needs the worker', () => {
  for (const platform of ['darwin', 'linux']) {
    assert.equal(
      missingWindowsCaptureWorker({ platform, repoRoot: '/r', fileExists: () => false }),
      null
    )
  }
})

test('a Windows checkout without the worker names it and the fix', () => {
  const seen = []
  const reason = missingWindowsCaptureWorker({
    platform: 'win32',
    repoRoot: 'C:\\repo',
    fileExists: (path) => {
      seen.push(path)
      return false
    }
  })
  assert.deepEqual(seen, ['C:\\repo\\vendor\\ffmpeg\\windows-x64\\bin\\ffmpeg-capture.exe'])
  assert.match(reason, /ffmpeg-capture\.exe is missing/)
  assert.match(reason, /pnpm ffmpeg:build:capture:windows/)
})

test('a Windows checkout with the worker passes', () => {
  assert.equal(
    missingWindowsCaptureWorker({
      platform: 'win32',
      repoRoot: 'C:\\repo',
      fileExists: () => true
    }),
    null
  )
})
