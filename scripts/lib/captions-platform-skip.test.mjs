import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  CAPTIONS_PLATFORM_PROBE_JS,
  captionsPlatformReasonFromProbe,
  captionsPlatformUnavailableReason,
  captionsSkipLine
} from './captions-platform-skip.mjs'

const LINUX_REASON =
  "Live captions aren't available on Linux yet. Videorc can't pass the microphone to captions here. Recordings and livestreams start without them, and your setting is kept."

test('a platform that can caption answers null: nothing is skipped', () => {
  assert.equal(captionsPlatformReasonFromProbe({ platform: 'darwin', reason: null }), null)
  assert.equal(captionsPlatformReasonFromProbe({ platform: 'win32', reason: null }), null)
})

test("the product's named reason is passed through as given", () => {
  assert.equal(
    captionsPlatformReasonFromProbe({ platform: 'linux', reason: LINUX_REASON }),
    LINUX_REASON
  )
})

test('an answer the probe cannot vouch for fails instead of skipping', () => {
  for (const answer of [
    null,
    undefined,
    'linux',
    {},
    { platform: '', reason: null },
    { platform: 'linux' },
    { platform: 'linux', reason: '' },
    { platform: 'linux', reason: '   ' },
    { platform: 'linux', reason: true },
    { platform: null, reason: LINUX_REASON }
  ]) {
    assert.throws(() => captionsPlatformReasonFromProbe(answer), /captions platform probe/)
  }
})

test("the probe asks the renderer's own module and runtime info", async () => {
  assert.match(CAPTIONS_PLATFORM_PROBE_JS, /window\.videorc\.getRuntimeInfo\(\)/)
  assert.match(CAPTIONS_PLATFORM_PROBE_JS, /import\('\/src\/lib\/captions-preflight\.ts'\)/)
  assert.match(CAPTIONS_PLATFORM_PROBE_JS, /captionsPlatformUnavailableReason\(info\?\.platform\)/)
  let sent
  const reason = await captionsPlatformUnavailableReason(async (code) => {
    sent = code
    return { platform: 'linux', reason: LINUX_REASON }
  })
  assert.equal(sent, CAPTIONS_PLATFORM_PROBE_JS)
  assert.equal(reason, LINUX_REASON)
})

test('a failed eval fails the smoke rather than skipping', async () => {
  await assert.rejects(
    captionsPlatformUnavailableReason(async () => {
      throw new Error('eval-js failed')
    }),
    /eval-js failed/
  )
})

test('the SKIP line names the part and the reason, and never says PASS', () => {
  const line = captionsSkipLine('captions-live smoke', 'every check', LINUX_REASON)
  assert.equal(line, `captions-live smoke SKIP every check: ${LINUX_REASON}`)
  assert.doesNotMatch(line, /PASS/)
  assert.throws(() => captionsSkipLine('x', 'y', null), /product reason/)
})
