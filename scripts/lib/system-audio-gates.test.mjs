import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  SYSTEM_AUDIO_GATES,
  SYSTEM_AUDIO_SAMPLE_RATE,
  bandMaxDbfs,
  broadbandPeakDbfs,
  cutoverFileSeconds,
  evaluateClipsIdleCase,
  evaluateRecordAndStreamCase,
  evaluateSelfExclusionCase,
  evaluateSystemAudioOffCase,
  evaluateSystemAudioSyncRun,
  evaluateToggleOffCase,
  evaluateToggleOnCase,
  evaluateToneCapturedCase,
  findToneRegions,
  goertzelAmplitude,
  mixSourcesIncludeSystemAudio,
  parseSystemAudioMixCutover,
  parseSystemAudioSyncOffsetMs,
  summarizeSystemAudioSyncRuns,
  toneEnvelope,
  toneWavArgs,
  wallToFileSeconds
} from './system-audio-gates.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const RATE = SYSTEM_AUDIO_SAMPLE_RATE

describe('clips-idle audio.levels gate (plan 201 S0)', () => {
  const sessionId = 'clips-ring'
  const timing = { sessionId, toneStartAt: 2000, gainChangedAt: 3500, toneEndAt: 5000 }
  function levels({ dropDb = 12, floorDb = -120 } = {}) {
    return Array.from({ length: 140 }, (_, index) => {
      const at = index * 50
      const peakDb = at < 2200 || at >= 5200 ? floorDb : at < 3700 ? -15 : -15 - dropDb
      return { at, payload: { sessionId, systemAudio: { peakDb, rmsDb: peakDb - 3 } } }
    })
  }
  const evaluate = (events) => evaluateClipsIdleCase({ ...timing, levels: events })

  it('requires ring readings, a 12 dB drop and continued readings at the floor', () => {
    const result = evaluate(levels())
    assert.equal(result.pass, true, result.failures.join())
    assert.equal(result.evidence.beforeDbfs, -15)
    assert.equal(result.evidence.afterDbfs, -27)
    assert.equal(result.evidence.dropDb, 12)
    assert.equal(result.evidence.floorPeakDbfs, -120)
    assert.equal(result.evidence.levelEventCount, 140)
  })

  it('allows +/- 2 dB, but rejects unchanged, reversed or out-of-tolerance gain', () => {
    for (const dropDb of [10, 14]) assert.equal(evaluate(levels({ dropDb })).pass, true)
    for (const dropDb of [0, -12, 9.9, 14.1]) {
      assert.match(evaluate(levels({ dropDb })).failures.join(), /gain dropped the peak/)
    }
  })

  it('rejects absent events or microphone/master-only payloads, preserving STOP evidence', () => {
    assert.equal(evaluate([]).pass, false)
    const events = levels().map(({ at }) => ({
      at,
      payload: {
        sessionId,
        microphone: { peakDb: -15, rmsDb: -18 },
        master: { peakDb: -15, rmsDb: -18 }
      }
    }))
    const result = evaluate(events)
    assert.match(result.failures.join(), /only 0 systemAudio readings/)
    assert.deepEqual(result.evidence.levels, events)
  })

  it('rejects missing, invalid or too few readings in either tone window', () => {
    for (const from of [2500, 4000]) {
      const missing = levels().filter(({ at }) => at < from || at >= from + 1000)
      assert.equal(evaluate(missing).pass, false)
      const invalid = levels().map((event) =>
        event.at >= from && event.at < from + 1000
          ? { ...event, payload: { sessionId, systemAudio: { peakDb: Number.NaN } } }
          : event
      )
      assert.equal(evaluate(invalid).pass, false)
    }
    assert.equal(evaluate(levels().filter(({ at }) => at % 1000 === 0)).pass, false)
    const silent = levels().map((event) => ({
      ...event,
      payload: { sessionId, systemAudio: { peakDb: -120 } }
    }))
    assert.match(evaluate(silent).failures.join(), /no systemAudio tone/)
  })

  it('does not mistake a stopped meter for silence after the tone', () => {
    assert.match(evaluate(levels().filter(({ at }) => at < 5500)).failures.join(), /after tone/)
    assert.match(
      evaluate(levels({ floorDb: -60 })).failures.join(),
      /return to the -120 dBFS floor/
    )
  })

  it('requires every event, including microphone-only events, to carry the ring session id', () => {
    for (const id of [undefined, 'other-ring']) {
      const events = [
        ...levels(),
        { at: 1000, payload: { sessionId: id, microphone: { peakDb: -120 } } }
      ]
      assert.match(evaluate(events).failures.join(), /ring session id/)
    }
  })
})

/** Builds mono f32 PCM from [{from, to, hz, amplitude}] segments (seconds). */
function synth(seconds, segments = []) {
  const samples = new Float32Array(Math.round(seconds * RATE))
  for (const { from, to, hz = 1000, amplitude = 0.25 } of segments) {
    const first = Math.round(from * RATE)
    const last = Math.min(samples.length, Math.round(to * RATE))
    for (let index = first; index < last; index += 1) {
      samples[index] += amplitude * Math.sin((2 * Math.PI * hz * index) / RATE)
    }
  }
  return samples
}

function analyze(samples, timeOffsetSeconds = 0) {
  const envelope = toneEnvelope(samples, { timeOffsetSeconds })
  return { envelope, regions: findToneRegions(envelope) }
}

describe('goertzelAmplitude', () => {
  it('reads a whole-cycle 1 kHz tone at its true amplitude', () => {
    const samples = synth(0.02, [{ from: 0, to: 0.02, amplitude: 0.5 }])
    const amplitude = goertzelAmplitude(samples, 0, samples.length, 1000, RATE)
    assert.ok(Math.abs(amplitude - 0.5) < 1e-4, `amplitude ${amplitude}`)
  })

  it('rejects other frequencies (the measure is 1 kHz-selective)', () => {
    const samples = synth(0.02, [
      { from: 0, to: 0.02, hz: 440, amplitude: 0.9 },
      { from: 0, to: 0.02, hz: 3000, amplitude: 0.9 }
    ])
    const amplitude = goertzelAmplitude(samples, 0, samples.length, 1000, RATE)
    assert.ok(20 * Math.log10(amplitude) < -50, `leak ${amplitude}`)
  })
})

describe('findToneRegions', () => {
  it('finds one tone with edges accurate to a few ms', () => {
    const { regions } = analyze(synth(4, [{ from: 1, to: 3 }]))
    assert.equal(regions.length, 1)
    assert.ok(Math.abs(regions[0].start - 1) < 0.003, `start ${regions[0].start}`)
    assert.ok(Math.abs(regions[0].end - 3) < 0.003, `end ${regions[0].end}`)
    assert.ok(Math.abs(regions[0].medianDbfs - 20 * Math.log10(0.25)) < 0.1)
    assert.ok(regions[0].minInteriorDbfs > regions[0].medianDbfs - 0.5)
  })

  it('applies the file-time offset (audio start minus video start)', () => {
    const { regions } = analyze(synth(3, [{ from: 1, to: 2 }]), 0.25)
    assert.ok(Math.abs(regions[0].start - 1.25) < 0.003)
  })

  it('ignores loud music away from 1 kHz', () => {
    const samples = synth(3, [
      { from: 0, to: 3, hz: 440, amplitude: 0.5 },
      { from: 0, to: 3, hz: 2500, amplitude: 0.3 }
    ])
    const { envelope, regions } = analyze(samples)
    assert.equal(regions.length, 0)
    assert.ok(bandMaxDbfs(envelope) < SYSTEM_AUDIO_GATES.bandSilenceDbfs)
    assert.ok(broadbandPeakDbfs(samples) > -10)
  })

  it('merges a short dropout into one region but reports it', () => {
    const { regions } = analyze(
      synth(4, [
        { from: 1, to: 2 },
        { from: 2.02, to: 3 }
      ])
    )
    assert.equal(regions.length, 1)
    assert.ok(regions[0].minInteriorDbfs < regions[0].medianDbfs - SYSTEM_AUDIO_GATES.dropoutDb)
  })

  it('drops blips shorter than the minimum tone', () => {
    const { regions } = analyze(synth(2, [{ from: 1, to: 1.05 }]))
    assert.equal(regions.length, 0)
  })
})

describe('time alignment helpers', () => {
  it('parses the backend cutover log line, ANSI colours included', () => {
    assert.deepEqual(
      parseSystemAudioMixCutover(
        '[backend:info] \u001b[2mvideorc_backend::system_audio_session\u001b[0m: System audio left the session mix at sample 234240.'
      ),
      { kind: 'detach', sample: 234240 }
    )
    assert.deepEqual(
      parseSystemAudioMixCutover('System audio joined the session mix at sample 1920.'),
      { kind: 'attach', sample: 1920 }
    )
    assert.equal(parseSystemAudioMixCutover('System audio capture started'), null)
  })

  it('maps a bus sample to file time through the stream start times', () => {
    assert.equal(cutoverFileSeconds(240000), 5)
    assert.equal(
      cutoverFileSeconds(240000, { audioStartSeconds: 0.1, videoStartSeconds: 0.04 }),
      5.06
    )
  })

  it('maps wall time from the recording anchor', () => {
    assert.equal(wallToFileSeconds(13500, { wallMs: 10000 }), 3.5)
  })

  it('reads mixSources from recording.status', () => {
    assert.equal(
      mixSourcesIncludeSystemAudio({
        audioTracks: [{ id: 'microphone', mixSources: ['microphone', 'system-audio'] }]
      }),
      true
    )
    assert.equal(
      mixSourcesIncludeSystemAudio({ audioTracks: [{ mixSources: ['microphone'] }] }),
      false
    )
    assert.equal(mixSourcesIncludeSystemAudio({}), false)
  })

  it('generates a -6 dBFS stereo tone (lavfi sine is too quiet)', () => {
    const args = toneWavArgs('/tmp/tone.wav', { seconds: 3 })
    assert.ok(args.includes('aevalsrc=0.5*sin(1000*2*PI*t):s=48000:d=3'))
    assert.equal(args.at(-1), '/tmp/tone.wav')
  })
})

describe('case verdicts', () => {
  it('on: passes a tone in place and fails a missing, misplaced or lossy one', () => {
    const good = analyze(synth(12, [{ from: 3.2, to: 6.2 }]))
    const expectedPlay = { start: 3, end: 6 }
    assert.equal(evaluateToneCapturedCase({ ...good, expectedPlay }).pass, true)

    const none = analyze(synth(12))
    assert.match(evaluateToneCapturedCase({ ...none, expectedPlay }).failures.join(), /exactly one/)

    const early = analyze(synth(12, [{ from: 2, to: 5 }]))
    assert.match(evaluateToneCapturedCase({ ...early, expectedPlay }).failures.join(), /tone start/)

    const leaky = analyze(
      synth(12, [
        { from: 3.2, to: 6.2 },
        { from: 9, to: 9.1, amplitude: 0.01 }
      ])
    )
    assert.match(
      evaluateToneCapturedCase({ ...leaky, expectedPlay }).failures.join(),
      /outside the tone/
    )
  })

  it('toggle off: the tone must stop at the cutover, before the player ends', () => {
    const expectedPlay = { start: 2, end: 8 }
    const cut = analyze(synth(12, [{ from: 2.2, to: 4.88 }]))
    const pass = evaluateToggleOffCase({ ...cut, expectedPlay, cutoverSeconds: 4.88 })
    assert.equal(pass.pass, true, pass.failures.join())
    assert.equal(pass.evidence.stopDeltaMs, 0)

    const late = evaluateToggleOffCase({ ...cut, expectedPlay, cutoverSeconds: 4.8 })
    assert.match(late.failures.join(), /tone stop/)

    const noCutover = evaluateToggleOffCase({ ...cut, expectedPlay, cutoverSeconds: null })
    assert.match(noCutover.failures.join(), /no confirmed/)

    const ranOut = analyze(synth(12, [{ from: 2.2, to: 8.2 }]))
    const player = evaluateToggleOffCase({ ...ranOut, expectedPlay, cutoverSeconds: 8.2 })
    assert.match(player.failures.join(), /player ending/)
  })

  it('toggle on: the tone enters at the cutover, within the playout delay, never before', () => {
    const expectedPlay = { start: 2, end: 10 }
    const entered = analyze(synth(12, [{ from: 5.125, to: 10.2 }]))
    const pass = evaluateToggleOnCase({ ...entered, expectedPlay, cutoverSeconds: 5.04 })
    assert.equal(pass.pass, true, pass.failures.join())

    const before = evaluateToggleOnCase({ ...entered, expectedPlay, cutoverSeconds: 5.2 })
    assert.match(before.failures.join(), /BEFORE the attach/)

    const slow = evaluateToggleOnCase({ ...entered, expectedPlay, cutoverSeconds: 4.8 })
    assert.match(slow.failures.join(), /after the attach cutover/)
  })

  it('off (privacy): no tone, digital silence, nothing mixed', () => {
    const silent = synth(12)
    const zero = analyze(silent)
    const pass = evaluateSystemAudioOffCase({
      ...zero,
      broadbandPeak: broadbandPeakDbfs(silent),
      mixedStatusCount: 0
    })
    assert.equal(pass.pass, true, pass.failures.join())

    const leaked = synth(12, [{ from: 3, to: 6 }])
    const fail = evaluateSystemAudioOffCase({
      ...analyze(leaked),
      broadbandPeak: broadbandPeakDbfs(leaked),
      mixedStatusCount: 1
    })
    assert.equal(fail.failures.length, 4)

    const hiss = synth(12, [{ from: 0, to: 12, hz: 5000, amplitude: 0.001 }])
    const noisy = evaluateSystemAudioOffCase({
      ...analyze(hiss),
      broadbandPeak: broadbandPeakDbfs(hiss),
      mixedStatusCount: 0
    })
    assert.match(noisy.failures.join(), /digital silence/)
  })

  it('self-exclusion: renderer tone absent, control present, renderer proven playing', () => {
    const renderer = { contextState: 'running', analyserPeak: 0.5 }
    const rendererPlay = { start: 3, end: 6 }
    const controlPlay = { start: 8, end: 10 }
    const excluded = analyze(synth(12, [{ from: 8.2, to: 10.2 }]))
    const pass = evaluateSelfExclusionCase({ ...excluded, rendererPlay, controlPlay, renderer })
    assert.equal(pass.pass, true, pass.failures.join())

    const leaked = analyze(
      synth(12, [
        { from: 3.05, to: 6.05 },
        { from: 8.2, to: 10.2 }
      ])
    )
    const fail = evaluateSelfExclusionCase({ ...leaked, rendererPlay, controlPlay, renderer })
    assert.match(fail.failures.join(), /Videorc's own tone/)

    const silentRenderer = evaluateSelfExclusionCase({
      ...excluded,
      rendererPlay,
      controlPlay,
      renderer: { contextState: 'suspended', analyserPeak: 0 }
    })
    assert.match(silentRenderer.failures.join(), /did not demonstrably play/)

    const deadCapture = evaluateSelfExclusionCase({
      ...analyze(synth(12)),
      rendererPlay,
      controlPlay,
      renderer
    })
    assert.match(deadCapture.failures.join(), /control: expected exactly one/)
  })

  it('record+stream: the tone in both artifacts', () => {
    const expectedPlay = { start: 3, end: 6 }
    const file = analyze(synth(10, [{ from: 3.5, to: 6.5 }]))
    const stream = analyze(synth(10, [{ from: 3.37, to: 6.37 }]))
    assert.equal(evaluateRecordAndStreamCase({ file, stream, expectedPlay }).pass, true)
    const empty = analyze(synth(10))
    assert.match(
      evaluateRecordAndStreamCase({ file, stream: empty, expectedPlay }).failures.join(),
      /record\+stream stream/
    )
  })
})

describe('o_sys end to end', () => {
  it('reads SYSTEM_AUDIO_SYNC_OFFSET_MS from the backend source', () => {
    const source = readFileSync(
      join(repoRoot, 'crates', 'videorc-backend', 'src', 'system_audio_session.rs'),
      'utf8'
    )
    assert.equal(parseSystemAudioSyncOffsetMs(source), 0)
    assert.equal(
      parseSystemAudioSyncOffsetMs('pub(crate) const SYSTEM_AUDIO_SYNC_OFFSET_MS: i32 = -12;'),
      -12
    )
    assert.throws(() => parseSystemAudioSyncOffsetMs('nothing here'), /not found/)
  })

  const pairsAt = (levels) => levels.flatMap(([value, count]) => Array(count).fill(value))
  const run = (levels, frameMs = 16.7) => {
    const offsetsMs = pairsAt(levels)
    const sorted = [...offsetsMs].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    const medianOffsetMs = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
    return evaluateSystemAudioSyncRun(
      { offsetsMs, medianOffsetMs },
      { systemAudioSyncOffsetMs: 0, frameMs }
    )
  }

  it('allows one video frame of sampling phase in a single run', () => {
    const phased = run([
      [-25.9, 8],
      [-9.9, 4]
    ])
    assert.equal(phased.pass, true, phased.failures.join())
    assert.equal(phased.residualMs, -25.9)
    assert.equal(phased.meanMs, -20.6)

    const broken = run([[-60, 12]])
    assert.equal(broken.pass, false)
    assert.match(broken.failures.join(), /60\.0 ms ahead of the screen/)

    const empty = evaluateSystemAudioSyncRun(
      { offsetsMs: [1, 2], medianOffsetMs: 1.5 },
      { systemAudioSyncOffsetMs: 0, frameMs: 16.7 }
    )
    assert.match(empty.failures.join(), /only 2 flash\/click pair/)
  })

  it('gates o_sys on the pooled mean of every pair over the runs', () => {
    const summary = summarizeSystemAudioSyncRuns([
      run([
        [-25.9, 8],
        [-9.9, 4]
      ]),
      run([
        [8.3, 6],
        [-8.1, 6]
      ]),
      run([
        [-7.1, 5],
        [-24.2, 7]
      ])
    ])
    assert.equal(summary.pass, true, summary.failures.join())
    assert.equal(summary.pairs, 36)
    assert.equal(summary.pooledMeanMs, -12.5)
    assert.equal(summary.impliedOffsetMs, 13)
    assert.equal(summary.stop, false)
  })

  it('fails a pooled mean beyond 25 ms and flags a consistent bias beyond 15 ms as a STOP', () => {
    const late = summarizeSystemAudioSyncRuns([run([[30, 12]]), run([[28, 12]]), run([[31, 12]])])
    assert.equal(late.pass, false)
    assert.equal(late.stop, true)
    assert.match(late.stopReason, /behind the screen/)

    const biased = summarizeSystemAudioSyncRuns([run([[18, 12]]), run([[21, 12]]), run([[17, 12]])])
    assert.equal(biased.pass, true)
    assert.equal(biased.stop, true)

    const mixed = summarizeSystemAudioSyncRuns([run([[18, 12]]), run([[-20, 12]]), run([[17, 12]])])
    assert.equal(mixed.stop, false)
    assert.equal(mixed.spreadMs, 38)
  })
})

describe('static-screen startup evidence', () => {
  it('requires held source pixels, a fresh presentation epoch, and zero ahead-cap loss', async () => {
    const { evaluateStaticScreenEpoch } = await import('./system-audio-gates.mjs')
    const evidence = {
      sourceAgeMs: 10000,
      presentationAgeMs: 20,
      // Measured on a 10 s-static display: 33-37 ms.
      epochAgeMs: 37,
      aheadCapDrops: 0
    }
    assert.equal(evaluateStaticScreenEpoch(evidence).pass, true)
    for (const patch of [
      { sourceAgeMs: 20 },
      { presentationAgeMs: 9000 },
      // The 0.9.119 incident: epoch taken from 8.8 s-old screen pixels.
      { epochAgeMs: 8849 },
      // Audio would sit about 100 ms late once the screen moves.
      { epochAgeMs: 120 },
      { epochAgeMs: undefined },
      { aheadCapDrops: 480 },
      { presentationAgeMs: undefined }
    ]) {
      assert.equal(evaluateStaticScreenEpoch({ ...evidence, ...patch }).pass, false)
    }
  })
  it('reads the startup epoch record with or without ANSI field colours', async () => {
    const { parseRecordingEpochLine } = await import('./system-audio-gates.mjs')
    const plain =
      'INFO videorc_backend::encoder_bridge: Recording audio epoch established from first video presentation source_age_ms=10231 presentation_age_ms=4 epoch_age_ms=104'
    const expected = { sourceAgeMs: 10231, presentationAgeMs: 4, epochAgeMs: 104 }
    assert.deepEqual(parseRecordingEpochLine(plain), expected)
    const colored = plain.replace(
      /(\w+_ms)=(\d+)/g,
      (_, name, value) => `\u001b[3m${name}\u001b[0m\u001b[2m=\u001b[0m${value}`
    )
    assert.deepEqual(parseRecordingEpochLine(colored), expected)
    assert.equal(parseRecordingEpochLine('System audio joined the session mix at sample 1'), null)
  })
  it('cannot accept silence as a mixed-input test tone', async () => {
    const { evaluateMixedToneCapturedCase } = await import('./system-audio-gates.mjs')
    assert.equal(
      evaluateMixedToneCapturedCase({ envelope: [], expectedPlay: { start: 3, end: 6 } }).pass,
      false
    )
  })
})
