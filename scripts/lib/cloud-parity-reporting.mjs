/** Plan 249 S25 `reporting` acceptance runner. Heavy: never import it from a
 * unit test. It drives the real dev app over the managed fake web, whose
 * observer endpoints keep reports, usage events, /live beats and interval
 * claims by the web's rules, and whose loopback Discord sink takes the
 * announcement (VIDEORC_DISCORD_API_BASE_URL; refused in packaged builds).
 *
 * Interval 1 (opted in): a room Go Live, a host killed and relaunched, a
 * Resume, End livestream after the report minimum. Interval 2 (opted out:
 * reports, usage and Discord off): Go Live again in the same show, End.
 * `assertReportingOnce` then requires one report, one usage start and stop
 * and one Discord post for interval 1, timed by the server's interval, and
 * nothing at all for interval 2. No real provider, Discord, email or paid
 * call is ever reached.
 */
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { holdFor, managedHarness, OUTPUT, waitFor } from './cloud-managed-smoke.mjs'
import { assertReportingOnce, REPORTING_MIN_SECONDS } from './cloud-parity-reporting-contract.mjs'

/** Unit tests for what one run cannot show (another computer, a relaunch
 * after the end, the lower-bound end, the solo session binding). */
export const REPORTING_RUST_FILTERS = Object.freeze([
  'cloud_output_session::tests',
  'stream_report_email::tests::a_cloud_interval_is_one_report_across_a_resume_with_a_derived_id',
  'usage_stats::tests::a_cloud_interval_is_one_start_and_one_stop_with_derived_ids',
  'live_status::sender_tests::a_talk_show_beats_from_its_live_interval_and_names_its_show'
])
export const REPORTING_WEB_TESTS = Object.freeze(['tests/cloud-interval-effects.test.ts'])

/** The webhook the case saves; the dev build sends it to the loopback sink. */
const WEBHOOK = 'https://discord.com/api/webhooks/123456789012345678/parity-token-abcdefghijklmnop'

function run(cwd, command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`Reporting fixture failed: ${command}, exit ${code}, signal ${signal}`))
    })
  })
}

const revision = (cwd) =>
  execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim()

export async function runReporting({ desktopRoot, webRoot }) {
  await run(desktopRoot, process.execPath, [
    '--test',
    'scripts/lib/cloud-parity-reporting-contract.test.mjs',
    'scripts/lib/fake-cloud-web-reporting.test.mjs'
  ])
  await run(webRoot, process.execPath, ['--import', 'tsx', '--test', ...REPORTING_WEB_TESTS])
  for (const filter of REPORTING_RUST_FILTERS)
    await run(desktopRoot, 'cargo', ['test', '-p', 'videorc-backend', filter])

  const h = await managedHarness('talk', 1, { youtube: true })
  const output = join(h.root, 'parity')
  mkdirSync(output, { recursive: true })
  const report = {
    slice: 'S25',
    case: 'reporting',
    revisions: { desktop: revision(desktopRoot), web: revision(webRoot) },
    steps: [],
    managed: 'not-run',
    productionQualified: false
  }
  const step = (name, detail = {}) => report.steps.push({ name, atMs: Date.now(), ...detail })
  const writeReport = () =>
    writeFileSync(join(output, 'reporting.json'), JSON.stringify(report, null, 2) + '\n')
  const state = () => h.web.snapshot(h.showId).state
  const intervals = []
  const platforms = new Set()
  const goLive = async (label) => {
    await h.eval('await window.__videorcSmokeScenePresets.start(); return true')
    await waitFor(
      () => h.eval('return window.__videorcSmokeScenePresets.streamingState().confirmationOpen'),
      `${label}: Go Live confirmation`
    )
    await h.eval('await window.__videorcSmokeScenePresets.confirmGoLive(); return true')
    await h.status((s) => s.room?.live, `${label}: the room is on air`, 60000)
    await waitFor(
      () => state().liveInterval?.liveSince && !state().liveInterval.endedAt,
      `${label}: the server's interval went live`,
      60000
    )
    for (const leg of state().legs ?? []) if (leg.state === 'live') platforms.add(leg.platform)
    return state().liveInterval.id
  }
  const endLivestream = async (label) => {
    await h.rpc('cloud.show.legs.end', {})
    await waitFor(() => state().liveInterval?.endedAt, `${label}: the server ended the interval`)
    await h.status((s) => s.liveInterval?.endedAt, `${label}: the desktop sees the end`, 30000)
  }
  const liveFor = async (interval, label) => {
    const since = Date.parse(interval.liveSince)
    const until = since + (REPORTING_MIN_SECONDS + 20) * 1000
    await holdFor(
      () => state().liveInterval?.id === interval.id && !state().liveInterval.endedAt,
      `${label}: the interval stays one interval`,
      Math.max(0, until - Date.now())
    )
  }
  try {
    writeReport()
    h.env.VIDEORC_DISCORD_API_BASE_URL = h.web.httpOrigin
    await h.destinations(1)
    await h.launch()
    await h.addYouTube()
    await h.rpc('discord.webhook.save', { url: WEBHOOK })
    await h.rpc('usageStats.set', { enabled: true })
    const opened = await h.rpc('cloud.room.open', {
      outputs: [OUTPUT],
      title: 'Plan 249 reporting',
      platforms: []
    })
    h.showId = opened.show.id
    await h.status((s) => s.room?.client === 'connected', 'desktop publisher joins')
    await h.configureStudio()
    // Time in the open room before Go Live is never counted.
    await new Promise((resolve) => setTimeout(resolve, 15000))

    // Interval 1: opted in; a host loss and a Resume inside it.
    const first = await goLive('interval 1')
    step('interval-1-live')
    await new Promise((resolve) => setTimeout(resolve, 30000))
    await h.kill()
    await h.launch()
    await h.status((s) => s.show?.id === h.showId, 'the relaunched app holds the show', 45000)
    await h.rpc('cloud.room.resume')
    await h.status((s) => s.room?.client === 'connected', 'host reconnected')
    step('resumed')
    await liveFor(state().liveInterval, 'interval 1')
    await endLivestream('interval 1')
    const one = state().liveInterval
    intervals.push({
      id: first,
      liveSince: one.liveSince,
      endedAt: one.endedAt,
      optedIn: { report: true, usage: true, discord: true }
    })
    // The report waits a minute for the last viewer read, then sends.
    await waitFor(
      () => h.web.hooks.reporting().reports.length === 1,
      'interval 1: its report reaches the web',
      240000
    )
    await waitFor(
      () => h.web.hooks.reporting().events.length === 2,
      'interval 1: its usage start and stop reach the web',
      120000
    )
    step('interval-1-reported')

    // Interval 2: the same show live again, everything opted out.
    h.web.hooks.setReportPreference({ enabled: false, history: false })
    await h.rpc('usageStats.set', { enabled: false })
    await h.rpc('discord.announce.update', { enabled: false })
    const second = await goLive('interval 2')
    assert(second !== first, 'Go Live again is another interval')
    await liveFor(state().liveInterval, 'interval 2')
    await endLivestream('interval 2')
    const two = state().liveInterval
    intervals.push({
      id: second,
      liveSince: two.liveSince,
      endedAt: two.endedAt,
      optedIn: { report: false, usage: false, discord: false }
    })
    await holdFor(
      () =>
        h.web.hooks.reporting().reports.length === 1 && h.web.hooks.reporting().events.length === 2,
      'interval 2: nothing is reported, counted or announced',
      120000
    )
    step('interval-2-quiet')

    const kept = h.web.hooks.reporting()
    const evidence = {
      showId: h.showId,
      platforms: [...platforms],
      intervals,
      reports: kept.reports,
      events: kept.events,
      effects: kept.effects,
      discordPosts: kept.discord.filter((entry) => entry.kind === 'post'),
      beats: kept.beats
    }
    report.evidence = {
      intervals,
      reportIds: kept.reports.map((r) => r.reportId),
      eventIds: kept.events.map((e) => e.eventId),
      reportPosts: kept.reportPosts.length,
      eventPosts: kept.eventPosts.length,
      effectPosts: kept.effectPosts.length,
      discord: kept.discord.map((entry) => entry.kind),
      beats: kept.beats.length
    }
    assertReportingOnce(evidence)
    report.result = 'passed'
  } catch (error) {
    report.result = 'failed'
    report.error = String(error?.stack ?? error)
    throw error
  } finally {
    writeReport()
    await h.close?.()
  }
  return { output }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}
