// Run: node --test scripts/lib/replay-clip-path.test.mjs
import assert from 'node:assert/strict'
import { posix, win32 } from 'node:path'
import test from 'node:test'

import { isClipUnderRecordingsClips, isReplayClipFileName } from './replay-clip-path.mjs'

test('a clip under <state>/app-data/recordings/Clips matches on POSIX', () => {
  const state = '/tmp/videorc-replay-smoke'
  const clip = `${state}/app-data/recordings/Clips/Clip 2026-11-04 10-00-00.mp4`
  assert.equal(isClipUnderRecordingsClips(clip, state, posix), true)
  assert.equal(isReplayClipFileName(clip, posix), true)
})

test('a clip under the same folder matches with Windows separators (#1081)', () => {
  const state = 'C:\\Users\\tester\\AppData\\Local\\Temp\\videorc-replay-smoke'
  const clip = `${state}\\app-data\\recordings\\Clips\\Clip 2026-11-04 10-00-00 (2).mp4`
  assert.equal(isClipUnderRecordingsClips(clip, state, win32), true)
  assert.equal(isReplayClipFileName(clip, win32), true)
})

test('a clip outside the state directory or outside Clips is refused', () => {
  const state = '/tmp/videorc-replay-smoke'
  assert.equal(
    isClipUnderRecordingsClips('/Users/me/Movies/Videorc/Clips/Clip 1.mp4', state, posix),
    false
  )
  assert.equal(
    isClipUnderRecordingsClips(`${state}/app-data/recordings/Clip.mp4`, state, posix),
    false
  )
  assert.equal(
    isClipUnderRecordingsClips(`${state}/app-data/recordings/Clips/nested/Clip.mp4`, state, posix),
    false
  )
  assert.equal(
    isClipUnderRecordingsClips(`${state}-other/app-data/recordings/Clips/Clip.mp4`, state, posix),
    false
  )
  assert.equal(
    isClipUnderRecordingsClips('D:\\elsewhere\\recordings\\Clips\\Clip.mp4', 'C:\\state', win32),
    false
  )
})

test('only the Clip timestamp name is accepted', () => {
  assert.equal(isReplayClipFileName('/x/Clip 2026-11-04 10-00-00.mp4', posix), true)
  assert.equal(isReplayClipFileName('/x/Clip 2026-11-04 10-00-00.mkv', posix), false)
  assert.equal(isReplayClipFileName('/x/Recording 2026-11-04 10-00-00.mp4', posix), false)
})
