import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  SOUNDBOARD_GATES,
  evaluateControlHeard,
  evaluateIdlePress,
  evaluateMonitorOnlyClip,
  evaluateMonitorPlayed,
  evaluateNotDoubled,
  evaluatePressedTone,
  parseMonitorVoiceLine,
  runningMedianMax
} from './soundboard-gates.mjs'

const region = (start, durationMs, medianDbfs = -15) => ({
  start,
  end: start + durationMs / 1000,
  durationMs,
  medianDbfs
})

describe('soundboard smoke gates (plan 189 S8)', () => {
  it('passes one region of the right length near the press', () => {
    const result = evaluatePressedTone({ regions: [region(3.08, 598)], pressFileSeconds: 3 })
    assert.equal(result.pass, true)
    assert.equal(Math.round(result.offsetMs), 80)
  })

  it('fails a missing, doubled, misplaced or stretched sound', () => {
    assert.equal(evaluatePressedTone({ regions: [], pressFileSeconds: 3 }).pass, false)
    assert.equal(
      evaluatePressedTone({ regions: [region(3, 600), region(4, 600)], pressFileSeconds: 3 }).pass,
      false
    )
    const late = evaluatePressedTone({ regions: [region(3.4, 600)], pressFileSeconds: 3 })
    assert.match(late.failures[0], /starts 400 ms from the press/)
    const early = evaluatePressedTone({ regions: [region(2.6, 600)], pressFileSeconds: 3 })
    assert.equal(early.pass, false)
    const long = evaluatePressedTone({ regions: [region(3, 700)], pressFileSeconds: 3 })
    assert.match(long.failures[0], /lasts 700 ms/)
    assert.equal(SOUNDBOARD_GATES.toneSeconds, 0.6)
  })

  it('fails a sound that came back louder through System audio', () => {
    const reference = evaluatePressedTone({ regions: [region(3, 600, -15)], pressFileSeconds: 3 })
    const same = evaluatePressedTone({ regions: [region(3, 610, -14.5)], pressFileSeconds: 3 })
    assert.equal(evaluateNotDoubled({ withSystemAudio: same, reference }).pass, true)
    const louder = evaluatePressedTone({ regions: [region(3, 620, -11)], pressFileSeconds: 3 })
    const doubled = evaluateNotDoubled({ withSystemAudio: louder, reference })
    assert.equal(doubled.pass, false)
    assert.match(doubled.failures[0], /second copy came back/)
  })

  it('needs the idle press listed, and never on air', () => {
    const voice = { voiceId: 'v', soundId: 's', startedAtMs: 1, durationMs: 600, loop: false }
    assert.equal(
      evaluateIdlePress({ playback: { voices: [{ ...voice, onAir: false }] }, soundId: 's' }).pass,
      true
    )
    assert.equal(
      evaluateIdlePress({ playback: { voices: [{ ...voice, onAir: true }] }, soundId: 's' }).pass,
      false
    )
    assert.equal(evaluateIdlePress({ playback: { voices: [] }, soundId: 's' }).pass, false)
  })
})

describe("the backend's monitor (plan 220 S1.3b)", () => {
  it('reads the report line the monitor logs, colours and all', () => {
    assert.deepEqual(
      parseMonitorVoiceLine(
        '\u001b[2m2026-11-09T10:00:00Z\u001b[0m \u001b[32m INFO\u001b[0m videorc_backend::sound_monitor: Sound monitor played voice v-12 for 28800 of 28800 frames from frame 0.'
      ),
      { voiceId: 'v-12', rendered: 28800, frames: 28800, offset: 0, stopped: false }
    )
    assert.equal(
      parseMonitorVoiceLine(
        'Sound monitor played voice v-3 for 900 of 28800 frames from frame 0, then faded out.'
      ).stopped,
      true
    )
    assert.equal(parseMonitorVoiceLine('System audio joined the session mix at sample 4800.'), null)
  })

  it('passes a voice played through from the top, and nothing less', () => {
    const report = (overrides) => ({
      voiceId: 'v-1',
      rendered: 28800,
      frames: 28800,
      offset: 0,
      stopped: false,
      ...overrides
    })
    assert.equal(evaluateMonitorPlayed({ reports: [report()], voiceId: 'v-1' }).pass, true)
    assert.equal(evaluateMonitorPlayed({ reports: [report()], voiceId: 'v-2' }).pass, false)
    assert.equal(
      evaluateMonitorPlayed({ reports: [report({ rendered: 9000 })], voiceId: 'v-1' }).pass,
      false
    )
    assert.equal(
      evaluateMonitorPlayed({ reports: [report({ stopped: true })], voiceId: 'v-1' }).pass,
      false
    )
    assert.equal(
      evaluateMonitorPlayed({ reports: [report({ offset: 4800 })], voiceId: 'v-1' }).pass,
      false
    )
  })

  const envelope = (dbfs) => [
    { t: 0, amplitude: 0, dbfs: -Infinity },
    { t: 1, amplitude: 0, dbfs }
  ]

  it('needs the control tone in the capture, or the silence proves nothing', () => {
    assert.equal(evaluateControlHeard({ envelope: envelope(-26) }).pass, true)
    const deaf = evaluateControlHeard({ envelope: envelope(-70) })
    assert.equal(deaf.pass, false)
    assert.match(deaf.failures[0], /never reached System audio/)
    assert.equal(evaluateControlHeard({ envelope: [] }).pass, false)
  })

  /** A 5 ms 1 kHz envelope over `seconds`, `dbfs(t)` at each point. */
  const band = (seconds, dbfs) =>
    Array.from({ length: Math.round(seconds / 0.005) }, (_, index) => {
      const t = index * 0.005
      return { t, amplitude: 10 ** (dbfs(t) / 20), dbfs: dbfs(t) }
    })

  it('finds the loudest running median, not a transient', () => {
    const noisy = band(4, (t) => (Math.abs(t - 2) < 0.01 ? -20 : -50))
    assert.equal(runningMedianMax(noisy, 0, 4, 0.3), -50)
    const toned = band(4, (t) => (t >= 2 && t < 2.6 ? -21 : -50))
    assert.equal(runningMedianMax(toned, 0, 4, 0.3), -21)
  })

  it('fails a monitor-only press that came back into the Clips ring', () => {
    // A 6 s clip saved 3.5 s after the press: the press at 2.5 s clip time.
    const judge = (dbfs, overrides = {}) =>
      evaluateMonitorOnlyClip({
        toneEnvelope: band(6, dbfs),
        regions: [],
        controlEnvelope: envelope(-26),
        clipSeconds: 6,
        coveredSeconds: 6,
        pressAgoSeconds: 3.5,
        toneSeconds: 0.6,
        ...overrides
      })
    // Host audio leaks into the band, with a loud transient: still clean.
    const clean = judge((t) => (Math.abs(t - 5) < 0.01 ? -25 : -49))
    assert.equal(clean.pass, true, clean.failures.join('; '))
    assert.equal(clean.evidence.pressBandDbfs, -49)
    assert.equal(clean.evidence.pressClipSeconds, 2.5)
    // A copy of the press, 20 ms late at -21 dBFS.
    const leaked = judge((t) => (t >= 2.52 && t < 3.12 ? -21 : -49))
    assert.equal(leaked.pass, false)
    assert.match(leaked.failures[0], /came back through System audio/)
    // A louder host (-36 dBFS in the band everywhere) is not a copy...
    const loudHost = judge(() => -36)
    assert.equal(loudHost.pass, true, loudHost.failures.join('; '))
    assert.equal(loudHost.evidence.allowedDbfs, -30)
    // ...but a copy over it still fails, even a quiet one under the detector.
    assert.equal(judge((t) => (t >= 2.52 && t < 3.12 ? -21 : -36)).pass, false)
    assert.equal(judge((t) => (t >= 2.52 && t < 3.12 ? -31 : -45)).pass, false)
    // Never above the detector's threshold, however loud the host.
    assert.equal(judge(() => -28).pass, false)
    // The tone detector's own region fails it too.
    const region = { start: 2.52, end: 3.12, durationMs: 600, medianDbfs: -21 }
    assert.equal(judge(() => -60, { regions: [region] }).pass, false)
    // Digital silence passes, but only inside the clip.
    assert.equal(judge(() => -Infinity).pass, true)
    const outside = judge(() => -Infinity, { clipSeconds: 6.6, pressAgoSeconds: 0.2 })
    assert.equal(outside.pass, false)
    assert.match(outside.failures.join(' '), /not inside the clip/)
    // A clip that does not reach the press, or a deaf capture, proves nothing.
    assert.equal(judge(() => -60, { coveredSeconds: 2 }).pass, false)
    assert.equal(judge(() => -60, { controlEnvelope: envelope(-90) }).pass, false)
  })
})
