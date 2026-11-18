/** Plan 249 S25 `reporting` judge. Pure: no app, web or file access.
 *
 * Every live interval the server ended is one stream: one report (when the
 * account opted in), one usage start and one stop (when sharing is on), one
 * Discord announcement (when a webhook is set), however often the host was
 * killed, relaunched or resumed during it. Durations are the server's
 * interval, never the room's open time. An opted-out interval produces
 * nothing. No platform is ever "Videorc Cloud".
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

/** The desktop's minimum for a report (stream_report.rs MIN_STREAM_SECONDS). */
export const REPORTING_MIN_SECONDS = 5 * 60
const NOT_A_PLATFORM = /cloud|videorc/i

/** The ids the desktop derives from show and interval
 * (cloud_output_session::derived_id): RFC 9562 version 8 from SHA-256. */
export function derivedId(purpose, showId, intervalId) {
  const bytes = createHash('sha256')
    .update(`videorc/249-s25/${purpose}/${showId}/${intervalId}`)
    .digest()
    .subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x80
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const seconds = (iso) => Math.floor(Date.parse(iso) / 1000)
const wire = (iso) => new Date(seconds(iso) * 1000).toISOString().replace('.000Z', 'Z')

/**
 * `evidence`:
 * - `showId`
 * - `intervals`: the server's intervals of the show, `{ id, liveSince,
 *   endedAt, optedIn: { report, usage, discord } }`
 * - `reports`, `events`, `effects`, `discordPosts`, `beats`: what the web
 *   (and the Discord sink) kept, as the fake web's `reporting()` hook gives it
 * - `platforms`: the destinations the show really went live to
 */
export function assertReportingOnce(evidence) {
  const { showId, intervals } = evidence
  assert.ok(intervals.length > 0, 'the run streamed at least one interval')
  for (const interval of intervals) {
    assert.ok(interval.liveSince && interval.endedAt, `interval ${interval.id} went live and ended`)
    const lived = seconds(interval.endedAt) - seconds(interval.liveSince)
    const label = `interval ${interval.id}`

    const reportId = derivedId('stream-report', showId, interval.id)
    const reports = evidence.reports.filter((report) => report.reportId === reportId)
    if (interval.optedIn.report && lived >= REPORTING_MIN_SECONDS) {
      assert.equal(reports.length, 1, `${label}: one report`)
      const [report] = reports
      // The server's interval: off-air room time never counts, and a resume
      // inside it never starts a new one.
      assert.equal(report.startedAt, wire(interval.liveSince), `${label}: starts when it went live`)
      assert.ok(
        Math.abs(seconds(report.endedAt) - seconds(interval.endedAt)) <= 1,
        `${label}: ends when the server ended it`
      )
      for (const platform of report.platforms)
        assert.ok(evidence.platforms.includes(platform), `${label}: ${platform} was a real leg`)
      for (const platform of report.views?.byPlatform ?? [])
        assert.ok(!NOT_A_PLATFORM.test(platform.platform), `${label}: no cloud platform`)
    } else {
      assert.equal(reports.length, 0, `${label}: no report (opted out or too short)`)
    }

    const ids = {
      start: derivedId('usage-start', showId, interval.id),
      stop: derivedId('usage-stop', showId, interval.id)
    }
    const start = evidence.events.filter((event) => event.eventId === ids.start)
    const stop = evidence.events.filter((event) => event.eventId === ids.stop)
    if (interval.optedIn.usage) {
      assert.equal(start.length, 1, `${label}: one usage start`)
      assert.equal(stop.length, 1, `${label}: one usage stop`)
      assert.equal(stop[0].event, 'stream_stop')
      assert.ok(
        Math.abs(stop[0].durationSeconds - lived) <= 2,
        `${label}: the usage duration is the interval (${stop[0].durationSeconds} vs ${lived})`
      )
      for (const platform of [...start[0].platforms, ...stop[0].platforms])
        assert.ok(!NOT_A_PLATFORM.test(platform), `${label}: no cloud platform in usage`)
    } else {
      assert.equal(start.length + stop.length, 0, `${label}: no usage when sharing is off`)
    }

    const claims = evidence.effects.filter(
      (effect) => effect.key === `${showId}/${interval.id}/discord-announce`
    )
    const posts = evidence.discordPosts.filter(
      (post) =>
        post.atMs >= Date.parse(interval.liveSince) && post.atMs <= Date.parse(interval.endedAt)
    )
    if (interval.optedIn.discord) {
      assert.equal(claims.length, 1, `${label}: the announcement is claimed once`)
      assert.equal(posts.length, 1, `${label}: one Discord post`)
    } else {
      assert.equal(posts.length, 0, `${label}: no Discord post when announcing is off`)
    }

    const beats = evidence.beats.filter(
      (beat) => beat.method === 'PUT' && beat.body.sessionId === interval.id
    )
    assert.ok(beats.length > 0, `${label}: /live heard the interval`)
    for (const beat of beats) {
      assert.equal(beat.body.showId, showId, `${label}: the beat names its show`)
      assert.equal(beat.body.cloud, true)
      assert.equal(beat.body.startedAt, wire(interval.liveSince))
    }
  }
  // Nothing about the show was reported under any other id: no per-session
  // report, usage event or second announcement of a resumed local session.
  const known = new Set(
    intervals.flatMap((interval) => [
      derivedId('stream-report', showId, interval.id),
      derivedId('usage-start', showId, interval.id),
      derivedId('usage-stop', showId, interval.id)
    ])
  )
  for (const report of evidence.reports)
    assert.ok(known.has(report.reportId), `report ${report.reportId} belongs to no interval`)
  for (const event of evidence.events)
    assert.ok(known.has(event.eventId), `usage event ${event.eventId} belongs to no interval`)
  assert.equal(
    evidence.discordPosts.length,
    intervals.filter((interval) => interval.optedIn.discord).length,
    'one Discord post per announced interval, none other'
  )
}
