/** Plan 249 S26 `health` acceptance: the pure part. Never starts media.
 *
 * Each scenario is a state transform on the fake web's managed state (the
 * same JSON the real web answers a desktop's poll with): it injects one
 * fault, names the watchdog alert that must open for it (the check and the
 * layer it names), the alerts that must NOT open (a page that does not
 * report is Unknown, never silence or black), and how it recovers. The heavy
 * runner (`cloud-parity-health.mjs`) applies them to a real desktop backend
 * on the real-page baseline; these checks are unit tested on their own.
 */
import assert from 'node:assert/strict'

/** Short dev-build thresholds for the run (D4: refused by a packaged build). */
export const HEALTH_THRESHOLD_ENV = Object.freeze({
  VIDEORC_WATCHDOG_PROGRAM_UNREPORTED_AFTER_MS: '3000',
  VIDEORC_WATCHDOG_CONTRIBUTION_MISSING_AFTER_MS: '3000',
  VIDEORC_WATCHDOG_PROGRAM_SILENT_AFTER_MS: '3000',
  VIDEORC_WATCHDOG_PICTURE_BLACK_AFTER_MS: '3000',
  VIDEORC_WATCHDOG_PICTURE_STOPPED_AFTER_MS: '3000',
  // Short enough that a missing microphone measurement would open it during
  // the run if it were ever read as silence.
  VIDEORC_WATCHDOG_NO_VOICE_AFTER_MS: '5000',
  VIDEORC_WATCHDOG_STILL_THERE_AFTER_MS: '5000'
})

/** Rust and web tests for what one run cannot show (pure rules, takeover mute). */
export const HEALTH_RUST_FILTERS = Object.freeze([
  'watchdog::checks::tests',
  'watchdog::tests',
  'cloud_show::tests::a_cloud_room_on_air_or_recording_is_live_activity_for_the_guards'
])
export const HEALTH_WEB_TESTS = Object.freeze(['tests/cloud-program-health.test.ts'])
export const HEALTH_DESKTOP_TESTS = Object.freeze([
  'src/shared/cloud-program-health.test.ts',
  'src/main/live-activity.test.ts',
  'src/renderer/src/components/tabs/diagnostics-tab-page.test.ts'
])

/** A fake web leg: the room reads on air with no provider, key or broadcast. */
export const HEALTH_FAKE_LEG = Object.freeze({
  id: 'health-fixture',
  label: 'Health fixture',
  orientation: 'horizontal',
  platform: 'custom',
  since: '2026-11-17T12:00:00.000Z',
  state: 'live'
})

const reporting = (overrides = {}) => ({
  output: 'stream',
  orientation: 'horizontal',
  egress: 'active',
  page: 'reporting',
  pageAgeSeconds: 1,
  joined: true,
  audio: 'measured',
  program: { audioRmsDb: -20, audioSilentSeconds: 0, blackSeconds: 0 },
  ...overrides
})

/** A fixture guest, for a room whose host dropped out. */
export const HEALTH_FIXTURE_GUEST = Object.freeze({
  identity: 'g_health0fixture0guest0A',
  name: 'Guest',
  role: 'guest',
  onStage: false,
  video: false,
  audio: true,
  muted: false,
  screen: false,
  quality: 'good',
  sinceMs: 1000,
  away: false
})

/** The baseline the program layers start from and recover to. The room's
 * participants stay LiveKit's own unless a scenario transforms them. */
export function healthyState(state) {
  state.outputHealth = [reporting()]
  state.program = { audioRmsDb: -20, audioSilentSeconds: 0, blackSeconds: 0 }
}

/** Every injection the done-when names: mic loss, stale beacons, dropped
 * layers, black/frozen frames, silent output and reconnect. */
export const HEALTH_SCENARIOS = Object.freeze([
  {
    id: 'mic-loss',
    // The room lists the host with no microphone track.
    participants: (list) =>
      list.map((person) => (person.role === 'host' ? { ...person, audio: false } : person)),
    alert: { check: 'contribution-missing', targetId: 'host-microphone' },
    forbidden: ['no-voice', 'program-unreported']
  },
  {
    id: 'stale-beacon',
    inject: (state) => {
      state.outputHealth = [
        reporting({
          page: 'stale',
          pageAgeSeconds: 40,
          joined: false,
          audio: 'unknown',
          program: undefined
        })
      ]
      delete state.program
    },
    alert: { check: 'program-unreported', targetId: 'stream-horizontal' },
    // Unknown is never "viewers hear nothing" or "black".
    forbidden: ['program-silent', 'picture-black', 'picture-stopped', 'no-voice']
  },
  {
    id: 'dropped-layers',
    inject: (state) => {
      state.outputHealth = [reporting({ faults: { asset: 1, drop: 3 } })]
    },
    // A diagnostic, not an alarm: Health's page row counts them.
    status: (status) =>
      status.outputHealth?.[0]?.faults?.drop === 3 && status.outputHealth[0].faults.asset === 1,
    forbidden: ['program-unreported', 'picture-black']
  },
  {
    id: 'black',
    inject: (state) => {
      state.program = { audioRmsDb: -20, audioSilentSeconds: 0, blackSeconds: 15 }
      state.outputHealth = [reporting({ program: state.program })]
    },
    alert: { check: 'picture-black' },
    forbidden: ['program-unreported']
  },
  {
    id: 'frozen',
    inject: (state) => {
      state.program = { audioRmsDb: -20, audioSilentSeconds: 0, blackSeconds: 0, frozenSeconds: 6 }
      state.outputHealth = [reporting({ program: state.program })]
    },
    alert: { check: 'picture-stopped' },
    forbidden: ['program-unreported']
  },
  {
    id: 'silent-output',
    inject: (state) => {
      state.program = { audioRmsDb: -100, audioSilentSeconds: 25, blackSeconds: 0 }
      state.outputHealth = [reporting({ program: state.program })]
    },
    alert: { check: 'program-silent' },
    forbidden: ['program-unreported', 'contribution-missing']
  },
  {
    id: 'reconnect',
    // The host's connection dropped: the room lists only a guest (a list
    // that is not empty, so absence is a fact, not Unknown).
    participants: (list) => {
      const rest = list.filter((person) => person.role !== 'host')
      return rest.length > 0 ? rest : [structuredClone(HEALTH_FIXTURE_GUEST)]
    },
    alert: { check: 'contribution-missing', targetId: 'host-room' },
    forbidden: ['no-voice']
  }
])

/** The open alert a scenario names, from a `watchdog.alerts` view. */
export function alertFor(view, expected) {
  return (view?.alerts ?? []).find(
    (alert) =>
      alert.check === expected.check &&
      (expected.targetId === undefined || alert.targetId === expected.targetId)
  )
}

/** Alerts that opened although the scenario forbids them. */
export function falseAlarms(view, forbidden) {
  return (view?.alerts ?? []).filter((alert) => forbidden.includes(alert.check))
}

/** The checks that may never open on a room that is not measured. */
export const NEVER_ON_AN_UNMEASURED_ROOM = Object.freeze(['no-voice', 'still-there'])

const LEAKS = Object.freeze([
  [/\bvc[sp]1\.[A-Za-z0-9_-]+/u, 'a Videorc page or show token'],
  [/[?&](?:pt|token|key|access_token)=/iu, 'a credential query parameter'],
  [/\bwss?:\/\//iu, 'a room address'],
  [/\brtmps?:\/\//iu, 'a stream address'],
  [/data:image\//iu, 'an inline frame or image'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/u, 'a private key'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/u, 'a JWT']
])

/** Pure: what the health surfaces said must carry no credential or frame. */
export function scanForLeaks(text, secrets = []) {
  const found = []
  for (const [pattern, what] of LEAKS) if (pattern.test(text)) found.push(what)
  for (const secret of secrets)
    if (secret && secret.length >= 8 && text.includes(secret)) found.push('a known secret')
  return found
}

export function assertNoLeaks(text, secrets = [], label = 'health surfaces') {
  const found = scanForLeaks(text, secrets)
  assert.deepEqual(found, [], `${label} leaked ${found.join(', ')}`)
}
