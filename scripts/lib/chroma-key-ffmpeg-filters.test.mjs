import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { CHROMA_KEY_FFMPEG_FILTERS } from './chroma-key-ffmpeg-filters.mjs'
import { REQUIRED_LINUX_FFMPEG_FILTERS } from './ffmpeg-linux-pin.mjs'
import { REQUIRED_MACOS_FFMPEG_FILTERS } from './repair-encoder-capabilities.mjs'
import { REQUIRED_WINDOWS_FFMPEG_FILTERS } from './windows-ffmpeg-capabilities.mjs'

const fixture = JSON.parse(
  readFileSync(new URL('../../protocol-fixtures/chroma-key.json', import.meta.url), 'utf8')
)

test('the camera key filter list mirrors the protocol fixture the backend chain is tested against', () => {
  assert.deepEqual(CHROMA_KEY_FFMPEG_FILTERS, fixture.ffmpegFilters)
})

test('every bundle policy requires the camera key filters (plan 227)', () => {
  for (const [platform, required] of [
    ['macOS', REQUIRED_MACOS_FFMPEG_FILTERS],
    ['Windows', REQUIRED_WINDOWS_FFMPEG_FILTERS],
    ['Linux', REQUIRED_LINUX_FFMPEG_FILTERS]
  ]) {
    for (const filter of CHROMA_KEY_FFMPEG_FILTERS) {
      assert.ok(required.includes(filter), `${platform} policy must require ${filter}`)
    }
    assert.equal(new Set(required).size, required.length, `${platform} policy lists a filter twice`)
  }
})
