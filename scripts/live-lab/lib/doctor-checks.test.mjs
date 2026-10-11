import assert from 'node:assert/strict'
import test from 'node:test'

import { emptyConfig } from './config.mjs'
import {
  evaluateQuota,
  FAIL,
  PASS,
  SKIP,
  WARN,
  check,
  evaluateBlackHole,
  evaluateChannelIdentity,
  evaluateClient,
  evaluateLabDisplay,
  evaluatePermissions,
  evaluateStreamKeys,
  evaluateTokenAge,
  evaluateTool,
  formatResult,
  summarize
} from './doctor-checks.mjs'

const PATH = '/Users/x/.videorc-live-lab/config.json'

function display(name, overrides = {}) {
  return {
    _name: name,
    _spdisplays_resolution: '1920 x 1080 @ 60.00Hz',
    spdisplays_connection_type: 'spdisplays_virtual',
    spdisplays_online: 'spdisplays_yes',
    ...overrides
  }
}

function displaysJson(...entries) {
  return { SPDisplaysDataType: [{ _name: 'Apple M4', spdisplays_ndrvs: entries }] }
}

const BUILT_IN = display('Color LCD', {
  spdisplays_connection_type: 'spdisplays_internal',
  spdisplays_main: 'spdisplays_yes'
})

test('permissions: 0600 passes, 0644 and a loose dir fail, missing fails', () => {
  assert.equal(evaluatePermissions({ dirMode: 0o700, fileMode: 0o600 }, PATH).status, PASS)
  const loose = evaluatePermissions({ dirMode: 0o700, fileMode: 0o644 }, PATH)
  assert.equal(loose.status, FAIL)
  assert.match(loose.detail, /file is 0644, must be 0600/)
  const looseDir = evaluatePermissions({ dirMode: 0o755, fileMode: 0o600 }, PATH)
  assert.equal(looseDir.status, FAIL)
  assert.match(looseDir.detail, /dir is 0755/)
  assert.match(evaluatePermissions({ dirMode: null, fileMode: null }, PATH).detail, /missing/)
})

test('client and stream keys fail clearly when missing and show fingerprints when set', () => {
  assert.equal(evaluateClient(null).status, FAIL)
  assert.equal(evaluateClient(emptyConfig()).status, FAIL)
  const config = {
    ...emptyConfig(),
    client: { id: '123-abc.apps.googleusercontent.com', secret: 'GOCSPX-secretvalue9876' },
    streamKeys: { horizontal: { key: 'abcd-efgh-ijkl-mnop-1234' } }
  }
  const client = evaluateClient(config)
  assert.equal(client.status, PASS)
  assert.ok(!client.detail.includes('GOCSPX'))
  const [horizontal, vertical] = evaluateStreamKeys(config)
  assert.equal(horizontal.status, PASS)
  assert.equal(horizontal.detail, '"Videorc lab" ****1234')
  assert.equal(vertical.status, FAIL)
  assert.match(vertical.detail, /--stream-key vertical --from-clipboard/)
})

test('token age passes under 6 days, warns on day 6, fails at 7 and without a date', () => {
  const now = new Date('2026-10-12T12:00:00.000Z')
  const daysAgo = (days) => new Date(now.getTime() - days * 86_400_000).toISOString()
  assert.equal(evaluateTokenAge('broadcaster', daysAgo(1), now).status, PASS)
  assert.equal(evaluateTokenAge('broadcaster', daysAgo(6.2), now).status, WARN)
  const expired = evaluateTokenAge('viewer', daysAgo(7), now)
  assert.equal(expired.status, FAIL)
  assert.match(expired.detail, /--role viewer/)
  assert.equal(evaluateTokenAge('viewer', undefined, now).status, FAIL)
})

test('channel identity: broadcaster must be the lab channel, viewer must not be', () => {
  const lab = { channelId: 'UC1', channelTitle: 'Videorc', channelHandle: '@videorcapp' }
  const other = { channelId: 'UC2', channelTitle: 'Orc', channelHandle: '@orcdev' }
  const context = { expectedHandle: '@VideorcApp', broadcasterChannelId: 'UC1' }
  assert.equal(evaluateChannelIdentity('broadcaster', lab, context).status, PASS)
  const wrong = evaluateChannelIdentity('broadcaster', other, context)
  assert.equal(wrong.status, FAIL)
  assert.match(wrong.detail, /is not @VideorcApp/)
  assert.equal(evaluateChannelIdentity('viewer', other, context).status, PASS)
  assert.equal(evaluateChannelIdentity('viewer', lab, context).status, FAIL)
  assert.equal(
    evaluateChannelIdentity('viewer', { ...lab, channelHandle: null }, context).status,
    FAIL
  )
})

test('lab display: a virtual non-main display passes', () => {
  const result = evaluateLabDisplay(displaysJson(BUILT_IN, display('BetterDisplay Lab')))
  assert.equal(result.status, PASS)
  assert.match(result.detail, /BetterDisplay Lab/)
})

test('lab display: none, asleep, main or ambiguous fails; a configured name wins', () => {
  const none = evaluateLabDisplay(displaysJson(BUILT_IN))
  assert.equal(none.status, FAIL)
  assert.match(none.detail, /Install BetterDisplay/)
  assert.match(none.detail, /"Color LCD"/)
  assert.equal(evaluateLabDisplay(null).status, FAIL)

  const asleep = evaluateLabDisplay(
    displaysJson(BUILT_IN, display('Virtual 1', { spdisplays_online: 'spdisplays_no' }))
  )
  assert.equal(asleep.status, FAIL)
  assert.match(asleep.detail, /asleep or offline/)

  const main = evaluateLabDisplay(
    displaysJson(display('Virtual 1', { spdisplays_main: 'spdisplays_yes' }))
  )
  assert.equal(main.status, FAIL)
  assert.match(main.detail, /main display/)

  const two = evaluateLabDisplay(displaysJson(BUILT_IN, display('Virtual 1'), display('Dummy 2')))
  assert.equal(two.status, FAIL)
  assert.match(two.detail, /Several candidates/)

  const named = evaluateLabDisplay(
    displaysJson(
      BUILT_IN,
      display('Virtual 1'),
      display('LG HDR', { spdisplays_connection_type: 'spdisplays_hdmi' })
    ),
    'LG HDR'
  )
  assert.equal(named.status, PASS)
  assert.equal(evaluateLabDisplay(displaysJson(BUILT_IN), 'LG HDR').status, FAIL)
})

test('blackhole must be present with input channels', () => {
  const audio = (items) => ({ SPAudioDataType: [{ _items: items }] })
  assert.equal(evaluateBlackHole(audio([{ _name: 'MacBook Pro Microphone' }])).status, FAIL)
  assert.equal(evaluateBlackHole(null).status, FAIL)
  assert.equal(
    evaluateBlackHole(audio([{ _name: 'BlackHole 2ch', coreaudio_device_input: 2 }])).status,
    PASS
  )
  assert.equal(evaluateBlackHole(audio([{ _name: 'BlackHole 2ch' }])).status, FAIL)
})

test('tools pass on version output and fail with an install hint', () => {
  assert.deepEqual(
    evaluateTool('ffmpeg', 'ffmpeg version 7.1\nbuilt with', 'brew install ffmpeg'),
    {
      name: 'ffmpeg',
      status: PASS,
      detail: 'ffmpeg version 7.1'
    }
  )
  assert.match(evaluateTool('yt-dlp', '', 'brew install yt-dlp').detail, /brew install yt-dlp/)
})

test('summary fails on any FAIL and ignores WARN and SKIP', () => {
  const results = [check('a', PASS, ''), check('b', WARN, ''), check('c', SKIP, '')]
  assert.deepEqual(summarize(results), {
    counts: { PASS: 1, WARN: 1, FAIL: 0, SKIP: 1 },
    ok: true
  })
  assert.equal(summarize([...results, check('d', FAIL, '')]).ok, false)
  assert.match(formatResult(check('config', PASS, 'ok')), /^PASS {2}config/)
})

test('lab quota: pass under 75%, warn from 75%, fail when spent or unreadable', () => {
  const day = { day: '2026-10-12', max: 8000 }
  assert.equal(evaluateQuota({ ...day, units: 120, remaining: 7880 }).status, PASS)
  assert.equal(evaluateQuota({ ...day, units: 6000, remaining: 2000 }).status, WARN)
  const spent = evaluateQuota({ ...day, units: 8000, remaining: 0 })
  assert.equal(spent.status, FAIL)
  assert.match(spent.detail, /8000 of 8000 units spent \(Pacific day 2026-10-12\)/)
  assert.equal(evaluateQuota(null, new Error('ledger is not valid JSON')).status, FAIL)
})
