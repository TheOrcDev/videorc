import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveExistingSiblingFfprobe, siblingFfprobePath } from './ffmpeg-sibling-paths.mjs'

test('derives ffprobe for POSIX and Windows ffmpeg paths', () => {
  assert.equal(siblingFfprobePath('/opt/videorc/bin/ffmpeg'), '/opt/videorc/bin/ffprobe')
  assert.equal(
    siblingFfprobePath('C:\\Program Files\\Videorc\\resources\\ffmpeg\\bin\\ffmpeg.exe'),
    'C:\\Program Files\\Videorc\\resources\\ffmpeg\\bin\\ffprobe.exe'
  )
  assert.equal(siblingFfprobePath('D:\\tools\\FFMPEG.EXE'), 'D:\\tools\\ffprobe.exe')
})

test('supports bare commands and rejects unrelated binaries', () => {
  assert.equal(siblingFfprobePath('ffmpeg'), 'ffprobe')
  assert.equal(siblingFfprobePath('ffmpeg.exe'), 'ffprobe.exe')
  assert.equal(siblingFfprobePath('/opt/bin/avconv'), null)
  assert.equal(siblingFfprobePath(null), null)
})

test('only resolves a derived sibling that exists', () => {
  const visited = []
  assert.equal(
    resolveExistingSiblingFfprobe('C:\\Videorc\\ffmpeg.exe', (candidate) => {
      visited.push(candidate)
      return candidate.endsWith('ffprobe.exe')
    }),
    'C:\\Videorc\\ffprobe.exe'
  )
  assert.deepEqual(visited, ['C:\\Videorc\\ffprobe.exe'])
  assert.equal(
    resolveExistingSiblingFfprobe('/opt/bin/ffmpeg', () => false),
    null
  )
})
