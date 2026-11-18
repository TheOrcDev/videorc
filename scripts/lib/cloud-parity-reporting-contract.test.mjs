import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertReportingOnce, derivedId } from './cloud-parity-reporting-contract.mjs'

// Plan 249 S25: the `reporting` judge. Pure evidence only.

const SHOW = 'sh_parity'
const ONE = {
  id: 'iv-1',
  liveSince: '2026-11-17T18:00:30.000Z',
  endedAt: '2026-11-17T18:10:30.000Z',
  optedIn: { report: true, usage: true, discord: true }
}
const TWO = {
  id: 'iv-2',
  liveSince: '2026-11-17T18:20:00.000Z',
  endedAt: '2026-11-17T18:26:00.000Z',
  optedIn: { report: false, usage: false, discord: false }
}

function evidence() {
  return {
    showId: SHOW,
    platforms: ['youtube'],
    intervals: [ONE, TWO],
    reports: [
      {
        reportId: derivedId('stream-report', SHOW, ONE.id),
        startedAt: '2026-11-17T18:00:30Z',
        endedAt: '2026-11-17T18:10:30Z',
        platforms: ['youtube']
      }
    ],
    events: [
      {
        eventId: derivedId('usage-start', SHOW, ONE.id),
        event: 'stream_start',
        platforms: ['youtube']
      },
      {
        eventId: derivedId('usage-stop', SHOW, ONE.id),
        event: 'stream_stop',
        platforms: ['youtube'],
        durationSeconds: 600
      }
    ],
    effects: [{ key: `${SHOW}/${ONE.id}/discord-announce`, epoch: '1' }],
    discordPosts: [{ kind: 'post', atMs: Date.parse('2026-11-17T18:00:45.000Z') }],
    beats: [ONE, TWO].map((interval) => ({
      method: 'PUT',
      body: {
        sessionId: interval.id,
        showId: SHOW,
        cloud: true,
        startedAt: interval.liveSince.replace('.000Z', 'Z')
      }
    }))
  }
}

test('one stream per interval, nothing for an opted-out one, passes', () => {
  assert.doesNotThrow(() => assertReportingOnce(evidence()))
})

test('derived ids are stable version 8 UUIDs per purpose', () => {
  const id = derivedId('stream-report', SHOW, 'iv-1')
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.equal(id, derivedId('stream-report', SHOW, 'iv-1'))
  assert.notEqual(id, derivedId('usage-start', SHOW, 'iv-1'))
  assert.notEqual(id, derivedId('stream-report', SHOW, 'iv-2'))
})

test('a resume that reported again, or reported a local session, fails', () => {
  const twice = evidence()
  twice.reports.push({ ...twice.reports[0] })
  assert.throws(() => assertReportingOnce(twice), /one report/)
  const local = evidence()
  local.reports.push({
    reportId: '9b6f6b1c-3a0e-8a1b-9c2d-1e2f3a4b5c6d',
    startedAt: '2026-11-17T18:05:00Z',
    endedAt: '2026-11-17T18:10:30Z',
    platforms: ['youtube']
  })
  assert.throws(() => assertReportingOnce(local), /belongs to no interval/)
})

test('room time off air, or a restarted clock, is not the interval', () => {
  const early = evidence()
  early.reports[0].startedAt = '2026-11-17T17:58:00Z'
  assert.throws(() => assertReportingOnce(early), /starts when it went live/)
  const long = evidence()
  long.events[1].durationSeconds = 900
  assert.throws(() => assertReportingOnce(long), /usage duration is the interval/)
})

test('an opted-out interval with any effect fails, and so does a cloud platform', () => {
  const leaked = evidence()
  leaked.discordPosts.push({ kind: 'post', atMs: Date.parse('2026-11-17T18:21:00.000Z') })
  assert.throws(() => assertReportingOnce(leaked), /no Discord post/)
  const counted = evidence()
  counted.events.push({
    eventId: derivedId('usage-start', SHOW, TWO.id),
    event: 'stream_start',
    platforms: ['youtube']
  })
  assert.throws(() => assertReportingOnce(counted), /no usage when sharing is off/)
  const cloud = evidence()
  cloud.events[0].platforms = ['videorc-cloud']
  assert.throws(() => assertReportingOnce(cloud), /no cloud platform/)
})

test('a beat that does not name its show, or no beat at all, fails', () => {
  const unnamed = evidence()
  unnamed.beats[0].body.showId = 'sh_other'
  assert.throws(() => assertReportingOnce(unnamed), /names its show/)
  const silent = evidence()
  silent.beats = silent.beats.slice(1)
  assert.throws(() => assertReportingOnce(silent), /heard the interval/)
})
