import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  assessFfmpegWindowsPin,
  autobuildDurability,
  lastDayOfMonth
} from './ffmpeg-windows-pin.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

const DURABLE_URL =
  'https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-07-31-14-10/ffmpeg-n8.1.2-34-g9b6c8969e0-win64-lgpl-8.1.zip'
const SHA = '089e4169e93b2b3f3acbfced3c0704d24276a225641bdda04d796d28b07a2a38'

describe('lastDayOfMonth', () => {
  it('handles 30/31-day months and leap Februaries', () => {
    assert.equal(lastDayOfMonth(2026, 7), 31)
    assert.equal(lastDayOfMonth(2026, 6), 30)
    assert.equal(lastDayOfMonth(2026, 2), 28)
    assert.equal(lastDayOfMonth(2028, 2), 29)
  })
})

describe('autobuildDurability', () => {
  it('accepts a month-end autobuild', () => {
    assert.deepEqual(autobuildDurability(DURABLE_URL), {
      tagDate: '2026-07-31',
      durable: true
    })
  })

  it('rejects the mid-month daily that broke the August 2026 Windows build', () => {
    assert.deepEqual(
      autobuildDurability(
        'https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-07-23-14-16/ffmpeg-n8.1.2-30-g45f1910444-win64-lgpl-8.1.zip'
      ),
      { tagDate: '2026-07-23', durable: false }
    )
  })

  it('does not apply the rule to a non-BtbN URL', () => {
    assert.equal(autobuildDurability('https://mirror.example.com/ffmpeg-win64-lgpl.zip'), null)
  })
})

describe('assessFfmpegWindowsPin', () => {
  it('passes a well-formed durable pin', () => {
    assert.deepEqual(assessFfmpegWindowsPin({ url: DURABLE_URL, sha256: SHA }), {
      ok: true,
      problems: []
    })
  })

  it('reports a prunable pin with the fix in the message', () => {
    const { ok, problems } = assessFfmpegWindowsPin({
      url: DURABLE_URL.replace('autobuild-2026-07-31-14-10', 'autobuild-2026-07-23-14-16'),
      sha256: SHA
    })
    assert.equal(ok, false)
    assert.match(problems.join('\n'), /mid-month daily build/)
    assert.match(problems.join('\n'), /last autobuild of a month/)
  })

  it('rejects a non-LGPL build, keeping the repo ffmpeg licence policy', () => {
    const { ok, problems } = assessFfmpegWindowsPin({
      url: DURABLE_URL.replace('lgpl', 'gpl'),
      sha256: SHA
    })
    assert.equal(ok, false)
    assert.match(problems.join('\n'), /LGPL-only/)
  })

  it('rejects missing and malformed checksums', () => {
    assert.match(assessFfmpegWindowsPin({ url: DURABLE_URL }).problems.join(), /missing "sha256"/)
    assert.match(
      assessFfmpegWindowsPin({ url: DURABLE_URL, sha256: 'ABC123' }).problems.join(),
      /64 lowercase hex/
    )
    assert.match(assessFfmpegWindowsPin({ sha256: SHA }).problems.join(), /missing "url"/)
  })
})

describe('the committed pin', () => {
  it('is durable, so a Windows release cannot be blocked by upstream pruning', async () => {
    const pin = JSON.parse(
      await readFile(join(repoRoot, 'vendor', 'ffmpeg', 'windows-pin.json'), 'utf8')
    )
    const { ok, problems } = assessFfmpegWindowsPin(pin)
    assert.equal(ok, true, problems.join('\n'))
  })
})
