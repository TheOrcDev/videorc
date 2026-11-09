import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { CAMERA_LOOK_FFMPEG_FILTERS, GPL_ONLY_EQ_FILTER } from './camera-look-ffmpeg-filters.mjs'
import { REQUIRED_LINUX_FFMPEG_FILTERS } from './ffmpeg-linux-pin.mjs'
import { REQUIRED_MACOS_FFMPEG_FILTERS } from './repair-encoder-capabilities.mjs'
import { REQUIRED_WINDOWS_FFMPEG_FILTERS } from './windows-ffmpeg-capabilities.mjs'

const fixture = JSON.parse(
  readFileSync(new URL('../../protocol-fixtures/camera-look.json', import.meta.url), 'utf8')
)

test('the camera look filter list mirrors the protocol fixture the backend chain is tested against', () => {
  assert.deepEqual(CAMERA_LOOK_FFMPEG_FILTERS, fixture.ffmpegFilters)
})

test('the camera look chain never names the GPL-only eq filter (0.18.0 regression)', () => {
  assert.equal(GPL_ONLY_EQ_FILTER, 'eq')
  assert.ok(!CAMERA_LOOK_FFMPEG_FILTERS.includes(GPL_ONLY_EQ_FILTER))
})

test('every bundle policy requires the camera look filters and none requires eq', () => {
  for (const [platform, required] of [
    ['macOS', REQUIRED_MACOS_FFMPEG_FILTERS],
    ['Windows', REQUIRED_WINDOWS_FFMPEG_FILTERS],
    ['Linux', REQUIRED_LINUX_FFMPEG_FILTERS]
  ]) {
    for (const filter of CAMERA_LOOK_FFMPEG_FILTERS) {
      assert.ok(required.includes(filter), `${platform} policy must require ${filter}`)
    }
    assert.ok(!required.includes(GPL_ONLY_EQ_FILTER), `${platform} policy must not require eq`)
    assert.equal(new Set(required).size, required.length, `${platform} policy lists a filter twice`)
  }
})
