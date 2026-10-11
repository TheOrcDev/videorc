import assert from 'node:assert/strict'
import test from 'node:test'

import { emptyConfig } from './config.mjs'
import {
  FAIL,
  PASS,
  SKIP,
  WARN,
  check,
  evaluateAutoLogin,
  evaluateBlackHole,
  evaluateChannelIdentity,
  evaluateClient,
  evaluateDiskFree,
  evaluateDisplayAwake,
  evaluateFocus,
  evaluateGhAuth,
  evaluateKillSwitch,
  evaluateLabDisplay,
  evaluatePermissions,
  evaluatePolicyFile,
  evaluateRunLock,
  evaluateScreenLock,
  evaluateSigningIdentities,
  evaluateSleep,
  evaluateStopFile,
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

// Plan 178 U3: machine section. Each check fails clearly when broken on
// purpose, from the text the command prints.

test('auto-login: the lab user passes, another user or off fails', () => {
  assert.equal(evaluateAutoLogin('videorc-lab\n', 'videorc-lab').status, PASS)
  const other = evaluateAutoLogin('orc\n', 'videorc-lab')
  assert.equal(other.status, FAIL)
  assert.match(other.detail, /"orc", must be videorc-lab/)
  const off = evaluateAutoLogin('', 'videorc-lab')
  assert.equal(off.status, FAIL)
  assert.match(off.detail, /Auto-login is off/)
  assert.equal(
    evaluateAutoLogin(
      'The domain/default pair of (/Library/Preferences/com.apple.loginwindow, autoLoginUser) does not exist',
      'videorc-lab'
    ).status,
    FAIL
  )
})

test('screen lock: off passes; a delay, immediate or unreadable fails', () => {
  assert.equal(evaluateScreenLock('screenLock is off\n').status, PASS)
  const delay = evaluateScreenLock('screenLock delay is 300 seconds\n')
  assert.equal(delay.status, FAIL)
  assert.match(delay.detail, /delay is 300 seconds. Turn it off/)
  assert.equal(evaluateScreenLock('screenLock is immediate').status, FAIL)
  assert.equal(evaluateScreenLock('').status, FAIL)
})

test('sleep: display and system never pass; either set fails; unreadable fails', () => {
  const never =
    'Currently in use:\n displaysleep         0\n sleep                0 (sleep prevented by powerd)\n'
  assert.equal(evaluateSleep(never).status, PASS)
  const display = evaluateSleep(' displaysleep         10\n sleep                0\n')
  assert.equal(display.status, FAIL)
  assert.match(display.detail, /displaysleep is 10 min. Fix: sudo pmset -a displaysleep 0 sleep 0/)
  const system = evaluateSleep(' displaysleep         0\n sleep                1\n')
  assert.equal(system.status, FAIL)
  assert.match(system.detail, /sleep is 1 min/)
  assert.equal(evaluateSleep(' disksleep 10\n').status, FAIL)
})

test('display awake: an online display passes, none or all asleep fails', () => {
  assert.equal(evaluateDisplayAwake(displaysJson(display('Dummy'))).status, PASS)
  assert.equal(
    evaluateDisplayAwake(displaysJson(display('Dummy', { spdisplays_online: undefined }))).status,
    PASS
  )
  const none = evaluateDisplayAwake(displaysJson())
  assert.equal(none.status, FAIL)
  assert.match(none.detail, /No display attached. Plug in the HDMI dummy/)
  assert.equal(evaluateDisplayAwake(null).status, FAIL)
  const asleep = evaluateDisplayAwake(
    displaysJson(display('Dummy', { spdisplays_online: 'spdisplays_no' }))
  )
  assert.equal(asleep.status, FAIL)
  assert.match(asleep.detail, /asleep or offline \("Dummy"\)/)
})

test('focus: an active assertion passes, an empty store or missing file fails', () => {
  const on = JSON.stringify({
    data: [
      {
        storeAssertionRecords: [
          {
            assertionDetails: {
              assertionDetailsModeIdentifier: 'com.apple.donotdisturb.mode.default'
            }
          }
        ]
      }
    ]
  })
  const result = evaluateFocus(on)
  assert.equal(result.status, PASS)
  assert.match(result.detail, /com.apple.donotdisturb.mode.default on/)
  const off = evaluateFocus(JSON.stringify({ data: [{ storeAssertionRecords: [] }] }))
  assert.equal(off.status, FAIL)
  assert.match(off.detail, /Focus is off. Turn on Do Not Disturb/)
  assert.equal(evaluateFocus('').status, FAIL)
  assert.equal(evaluateFocus(null).status, FAIL)
})

test('disk free: 100 GB or more passes, less fails with the number, garbage fails', () => {
  const df = (availableKb) =>
    `Filesystem   1024-blocks      Used Available Capacity iused ifree %iused  Mounted on\n/dev/disk3s5  971350180 200000000 ${availableKb}    21%  1000 2000    0%   /System/Volumes/Data\n`
  assert.equal(evaluateDiskFree(df(200 * 1024 * 1024)).status, PASS)
  assert.equal(evaluateDiskFree(df(100 * 1024 * 1024)).status, PASS)
  const low = evaluateDiskFree(df(42 * 1024 * 1024))
  assert.equal(low.status, FAIL)
  assert.match(low.detail, /42 GB free, need 100 GB/)
  assert.equal(evaluateDiskFree('').status, FAIL)
  assert.equal(evaluateDiskFree('Filesystem only\n').status, FAIL)
})

test('signing identity: a Developer ID in the keychain fails, others warn, none passes', () => {
  assert.equal(evaluateSigningIdentities('     0 valid identities found\n').status, PASS)
  assert.equal(evaluateSigningIdentities('').status, PASS)
  const devId = evaluateSigningIdentities(
    '  1) ABCDEF0123456789 "Developer ID Application: Example Co (TEAMID1234)"\n     1 valid identities found\n'
  )
  assert.equal(devId.status, FAIL)
  assert.match(devId.detail, /1 Developer ID identity in the keychain. Delete it/)
  const dev = evaluateSigningIdentities(
    '  1) ABCDEF0123456789 "Apple Development: someone (ABC123)"\n     1 valid identities found\n'
  )
  assert.equal(dev.status, WARN)
})

test('policy file: problems fail, a valid policy passes with its limits, disabled warns', () => {
  const path = '/Library/Application Support/VideorcLab/policy.json'
  const bad = evaluatePolicyFile({
    policy: null,
    problems: ['policy.json is 0666', 'camera must be false'],
    path
  })
  assert.equal(bad.status, FAIL)
  assert.match(bad.detail, /policy.json is 0666; camera must be false/)
  const policy = {
    enabled: true,
    visibility: { default: 'unlisted', allowPublic: false },
    onDemand: { maxRunsPerDay: 8, maxRunMinutes: 60 },
    quota: { labProjectMaxUnitsPerDay: 8000 },
    schedule: { enabled: true }
  }
  const good = evaluatePolicyFile({ policy, problems: [], path })
  assert.equal(good.status, PASS)
  assert.match(
    good.detail,
    /enabled, unlisted, 8 runs\/day, 60 min max, 8000 lab units\/day, schedule on, clip pull off/
  )
  assert.equal(
    evaluatePolicyFile({ policy: { ...policy, enabled: false }, problems: [], path }).status,
    WARN
  )
})

test('gh auth: logged out, missing repo scope, no write on the reports repo fail; otherwise pass', () => {
  const loggedIn =
    "github.com\n  ✓ Logged in to github.com account lab-bot (keyring)\n  - Active account: true\n  - Token scopes: 'repo', 'read:org'\n"
  const reports = {
    name: 'example-org/lab-reports',
    json: '{"viewerPermission":"WRITE"}',
    needWrite: true
  }
  const main = { name: 'example-org/app', json: '{"viewerPermission":"READ"}', needWrite: false }
  const ok = evaluateGhAuth(loggedIn, [reports, main])
  assert.equal(ok.status, PASS)
  assert.match(ok.detail, /lab-bot; example-org\/lab-reports write, example-org\/app read/)

  const out = evaluateGhAuth(
    'You are not logged into any GitHub hosts. Run gh auth login to authenticate.',
    []
  )
  assert.equal(out.status, FAIL)
  assert.match(out.detail, /not logged in/)

  const scope = evaluateGhAuth(loggedIn.replace("'repo', ", ''), [reports])
  assert.equal(scope.status, FAIL)
  assert.match(scope.detail, /lacks the repo scope/)

  const readOnly = evaluateGhAuth(loggedIn, [{ ...reports, json: '{"viewerPermission":"READ"}' }])
  assert.equal(readOnly.status, FAIL)
  assert.match(readOnly.detail, /lab-reports is READ, need WRITE/)

  const unreachable = evaluateGhAuth(loggedIn, [{ ...reports, json: '' }])
  assert.equal(unreachable.status, FAIL)
  assert.match(unreachable.detail, /lab-reports not reachable/)
})

test('kill switch, run lock and stop file verdicts', () => {
  const url = 'https://raw.githubusercontent.com/example-org/lab-reports/main/control.json'
  assert.equal(evaluateKillSwitch(url, { enabled: true }).status, PASS)
  const off = evaluateKillSwitch(url, { enabled: false })
  assert.equal(off.status, WARN)
  assert.match(off.detail, /enabled: false. Runs are refused/)
  const down = evaluateKillSwitch(url, { error: 'HTTP 404' })
  assert.equal(down.status, FAIL)
  assert.match(down.detail, /unreachable: HTTP 404/)

  assert.equal(evaluateRunLock(null).status, PASS)
  const held = evaluateRunLock(
    { runId: 'churn', pid: 42, startedAt: '2026-10-12T04:30:00.000Z' },
    true
  )
  assert.equal(held.status, WARN)
  assert.match(held.detail, /held by churn \(pid 42/)
  const stale = evaluateRunLock(
    { runId: 'churn', pid: 42, startedAt: '2026-10-12T04:30:00.000Z' },
    false
  )
  assert.equal(stale.status, WARN)
  assert.match(stale.detail, /stale: churn \(pid 42 is dead\)/)
  const corrupt = evaluateRunLock({
    corrupt: true,
    path: '/lab/run.lock',
    reason: 'not valid JSON'
  })
  assert.equal(corrupt.status, FAIL)
  assert.match(corrupt.detail, /unreadable \(not valid JSON\)/)

  assert.equal(evaluateStopFile('/lab/STOP', false).status, PASS)
  const stop = evaluateStopFile('/lab/STOP', true)
  assert.equal(stop.status, WARN)
  assert.match(stop.detail, /\/lab\/STOP present. Every run is refused/)
})
