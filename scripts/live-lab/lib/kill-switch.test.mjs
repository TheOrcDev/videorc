import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  CONTROL_FETCH_INTERVAL_MS,
  CONTROL_UNREACHABLE_LIMIT_MS,
  STOP_FILE,
  createKillSwitch,
  fetchControlFromUrl,
  parseControl,
  stopFilePath
} from './kill-switch.mjs'
import { examplePolicy } from './policy.test.mjs'
import { validatePolicy } from './policy.mjs'

// The live lab runs on macOS and Linux only (POSIX paths, modes and shells).
const posixOnly = {
  skip: process.platform === 'win32' && 'the live lab runs on macOS and Linux only'
}

const T0 = Date.parse('2026-10-12T06:00:00.000Z')
const MINUTE = 60_000

function policy(overrides) {
  const { policy: validated, problems } = validatePolicy(examplePolicy(overrides))
  assert.deepEqual(problems, [])
  return validated
}

// A kill switch with a fake clock, a scripted control fetch and a STOP file
// flag. `control` is a function returning { enabled } or throwing.
function rig(overrides = {}) {
  let at = T0
  const stops = []
  const fetches = []
  const state = {
    stopFile: false,
    control: () => ({ enabled: true }),
    ...overrides.state
  }
  const sw = createKillSwitch({
    policy: 'policy' in overrides ? overrides.policy : policy(),
    stopFilePath: '/lab/STOP',
    fetchControl: async () => {
      fetches.push(at)
      return state.control()
    },
    now: () => at,
    onStop: async (reason) => {
      stops.push(reason)
    },
    run: {
      trigger: 'on-demand',
      build: 'release',
      privacy: 'unlisted',
      plannedMinutes: 20,
      startedAt: T0,
      ...overrides.run
    },
    exists: async (path) => {
      assert.equal(path, '/lab/STOP')
      return state.stopFile
    },
    reloadPolicy: overrides.reloadPolicy,
    quota: overrides.quota
  })
  return {
    sw,
    stops,
    fetches,
    state,
    advance(ms) {
      at += ms
    }
  }
}

test('parseControl accepts exactly { enabled } and rejects everything else', () => {
  assert.deepEqual(parseControl('{"enabled": true}'), { enabled: true })
  assert.deepEqual(parseControl('{"enabled": false, "note": "paused"}'), { enabled: false })
  assert.throws(() => parseControl('nope'), /not valid JSON/)
  assert.throws(() => parseControl('{"enabled": "yes"}'), /must be \{ "enabled": true \| false \}/)
  assert.throws(() => parseControl('[]'), /must be/)
  assert.throws(() => parseControl('null'), /must be/)
})

test('stop file lives in the work dir as STOP', posixOnly, () => {
  assert.equal(STOP_FILE, 'STOP')
  assert.equal(
    stopFilePath('/Users/videorc-lab/videorc-live-lab'),
    '/Users/videorc-lab/videorc-live-lab/STOP'
  )
})

test('a healthy run keeps going and control.json is fetched once per minute', async () => {
  const r = rig()
  assert.deepEqual(await r.sw.check(), { stop: false, reason: null })
  assert.equal(r.fetches.length, 1)
  r.advance(10_000)
  await r.sw.check()
  assert.equal(r.fetches.length, 1, 'no refetch inside the interval')
  r.advance(CONTROL_FETCH_INTERVAL_MS)
  await r.sw.check()
  assert.equal(r.fetches.length, 2)
  assert.deepEqual(r.stops, [])
  assert.equal(r.sw.snapshot().controlEnabled, true)
})

test('STOP file stops within one check and onStop runs once', async () => {
  const r = rig()
  await r.sw.check()
  r.state.stopFile = true
  assert.deepEqual(await r.sw.check(), { stop: true, reason: 'STOP file present' })
  assert.deepEqual(await r.sw.check(), { stop: true, reason: 'STOP file present' })
  assert.deepEqual(r.stops, ['STOP file present'])
  assert.equal(r.sw.snapshot().stopped.reason, 'STOP file present')
})

test('control.json enabled: false stops at the next fetch', async () => {
  const r = rig()
  await r.sw.check()
  r.state.control = () => ({ enabled: false })
  r.advance(CONTROL_FETCH_INTERVAL_MS)
  const verdict = await r.sw.check()
  assert.equal(verdict.reason, 'control.json says enabled: false')
  assert.deepEqual(r.stops, ['control.json says enabled: false'])
})

test('control.json unreachable: tolerated under 5 minutes, stop at 5 minutes', async () => {
  const r = rig()
  await r.sw.check()
  r.state.control = () => {
    throw new Error('HTTP 503')
  }
  for (let minute = 1; minute < 5; minute += 1) {
    r.advance(MINUTE)
    const verdict = await r.sw.check()
    assert.equal(verdict.stop, false, `minute ${minute}`)
  }
  assert.equal(r.sw.snapshot().controlLastError, 'HTTP 503')
  r.advance(MINUTE)
  const verdict = await r.sw.check()
  assert.equal(verdict.stop, true)
  assert.equal(verdict.reason, 'control.json unreachable for 5 min')
  assert.equal(r.fetches.length, 6)
  assert.equal(CONTROL_UNREACHABLE_LIMIT_MS, 5 * MINUTE)
})

test('a bad control body counts as unreachable', async () => {
  const r = rig({ state: { control: () => ({ enabled: 'yes' }) } })
  assert.equal((await r.sw.check()).stop, false)
  assert.match(r.sw.snapshot().controlLastError, /must return \{ enabled: boolean \}/)
  r.advance(CONTROL_UNREACHABLE_LIMIT_MS)
  assert.match((await r.sw.check()).reason, /unreachable for 5 min/)
})

test('control never reachable since the start stops 5 minutes after the start', async () => {
  const r = rig({
    state: {
      control: () => {
        throw new Error('ECONNREFUSED')
      }
    }
  })
  assert.equal((await r.sw.check()).stop, false)
  r.advance(CONTROL_UNREACHABLE_LIMIT_MS - 1)
  assert.equal((await r.sw.check()).stop, false)
  r.advance(1)
  assert.equal((await r.sw.check()).stop, true)
})

test('ended from YouTube Studio is an incident: stop, no restart', async () => {
  const r = rig()
  await r.sw.check()
  const verdict = await r.sw.notifyStudioEnded()
  assert.equal(verdict.reason, 'ended from YouTube Studio (incident, no restart)')
  assert.deepEqual(r.stops, [verdict.reason])
  assert.equal((await r.sw.check()).stop, true)
})

test('SIGINT and SIGTERM stop through the same path, once, and detach cleanly', async () => {
  const r = rig()
  const fakeProcess = new EventEmitter()
  const detach = r.sw.attachSignals(fakeProcess)
  assert.equal(fakeProcess.listenerCount('SIGINT'), 1)
  assert.equal(fakeProcess.listenerCount('SIGTERM'), 1)
  fakeProcess.emit('SIGINT', 'SIGINT')
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(r.stops, ['interrupted (signal)'])
  fakeProcess.emit('SIGTERM', 'SIGTERM')
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(r.stops, ['interrupted (signal)'])
  detach()
  assert.equal(fakeProcess.listenerCount('SIGINT'), 0)
  assert.equal(fakeProcess.listenerCount('SIGTERM'), 0)
  assert.equal(r.sw.snapshot().interrupted, 'SIGINT')
})

test('over the planned minutes, or the policy cap for on-demand runs, stops', async () => {
  const planned = rig()
  planned.advance(21 * MINUTE)
  assert.equal((await planned.sw.check()).reason, 'over time (21 min of 20 allowed)')

  const capped = rig({ run: { plannedMinutes: 120 } })
  capped.advance(61 * MINUTE)
  assert.equal((await capped.sw.check()).reason, 'over time (61 min of 60 allowed)')

  const scheduled = rig({ run: { trigger: 'schedule', plannedMinutes: 480 } })
  scheduled.advance(479 * MINUTE)
  assert.equal((await scheduled.sw.check()).stop, false)
})

test('a policy that goes bad mid-run stops: removed, loosened to writable, or disabled', async () => {
  let loaded = { policy: policy(), problems: [] }
  const r = rig({ reloadPolicy: async () => loaded })
  assert.equal((await r.sw.check()).stop, false)

  loaded = {
    policy: null,
    problems: ['/Library/Application Support/VideorcLab/policy.json is 0666']
  }
  r.advance(CONTROL_FETCH_INTERVAL_MS)
  assert.equal(
    (await r.sw.check()).reason,
    'policy invalid: /Library/Application Support/VideorcLab/policy.json is 0666'
  )

  loaded = { policy: policy({ enabled: false }), problems: [] }
  const disabled = rig({ reloadPolicy: async () => loaded })
  assert.equal((await disabled.sw.check()).reason, 'policy disabled (enabled is false)')

  const throwing = rig({
    reloadPolicy: async () => {
      throw new Error('EACCES')
    }
  })
  assert.equal((await throwing.sw.check()).reason, 'policy invalid: policy reload failed: EACCES')
})

test('quota over the cap mid-run stops', async () => {
  let units = { quotaUnitsToday: 7999, bundledUnitsToday: 0 }
  const r = rig({ quota: () => units })
  assert.equal((await r.sw.check()).stop, false)
  units = { quotaUnitsToday: 8001, bundledUnitsToday: 0 }
  assert.equal((await r.sw.check()).reason, 'over lab quota (8001 > 8000)')
})

test('a missing policy at construction stops on the first check', async () => {
  const r = rig({ policy: null })
  const verdict = await r.sw.check()
  assert.equal(verdict.reason, 'policy invalid: policy missing or invalid')
})

test('createKillSwitch demands its collaborators', () => {
  const base = {
    policy: policy(),
    stopFilePath: '/lab/STOP',
    fetchControl: async () => ({ enabled: true }),
    onStop: async () => {},
    run: {
      trigger: 'on-demand',
      build: 'release',
      privacy: 'unlisted',
      plannedMinutes: 1,
      startedAt: T0
    }
  }
  assert.throws(() => createKillSwitch({ ...base, stopFilePath: '' }), /stopFilePath/)
  assert.throws(() => createKillSwitch({ ...base, fetchControl: null }), /fetchControl/)
  assert.throws(() => createKillSwitch({ ...base, onStop: null }), /onStop/)
  assert.throws(() => createKillSwitch({ ...base, run: {} }), /startedAt/)
})

test('the default STOP file check reads the real file system', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'live-lab-stop-'))
  const stops = []
  const sw = createKillSwitch({
    policy: policy(),
    stopFilePath: stopFilePath(dir),
    fetchControl: async () => ({ enabled: true }),
    now: () => T0,
    onStop: async (reason) => stops.push(reason),
    run: {
      trigger: 'manual',
      build: 'release',
      privacy: 'unlisted',
      plannedMinutes: 5,
      startedAt: T0
    }
  })
  assert.equal((await sw.check()).stop, false)
  await writeFile(stopFilePath(dir), '')
  assert.equal((await sw.check()).reason, 'STOP file present')
  assert.deepEqual(stops, ['STOP file present'])
})

test('fetchControlFromUrl reads a raw GitHub URL through gh api and other URLs through fetch', async () => {
  const calls = []
  const viaGh = await fetchControlFromUrl(
    'https://raw.githubusercontent.com/example-org/lab-reports/main/control.json',
    {
      exec: async (command, args) => {
        calls.push([command, args])
        return { stdout: '{"enabled": false}\n' }
      }
    }
  )
  assert.deepEqual(viaGh, { enabled: false })
  assert.equal(calls[0][0], 'gh')
  assert.deepEqual(calls[0][1].slice(0, 2), [
    'api',
    'repos/example-org/lab-reports/contents/control.json?ref=main'
  ])

  const viaFetch = await fetchControlFromUrl('https://example.com/control.json', {
    fetchFn: async () => ({ ok: true, status: 200, text: async () => '{"enabled": true}' })
  })
  assert.deepEqual(viaFetch, { enabled: true })
  await assert.rejects(
    fetchControlFromUrl('https://example.com/control.json', {
      fetchFn: async () => ({ ok: false, status: 404, text: async () => '' })
    }),
    /HTTP 404/
  )
})
