import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PcmContinuityAnalyzer,
  assessPcmAcceptance,
  analyzePcmEvidence
} from './cloud-parity-pcm.mjs'
import { fixtureSample } from './cloud-parity-pcm-marker.mjs'
// Deterministic analyzer vectors, NEVER runtime evidence or an acquisition pass.
function fixture() {
  const audio = {
    samples: 1800 * 48000,
    markers: Array.from({ length: 1800 }, (_, i) => ({ second: i, audioFrame: i * 48000 })),
    nonFinite: 0,
    clipped: 0,
    longestSilence: 0,
    rejectedMarkers: 0
  }
  const evidence = {
    schemaVersion: 2,
    kind: 'local-livekit-program-pcm',
    acquisition: 'completed',
    sampleRate: 48000,
    channels: 1,
    revisions: { desktop: 'a'.repeat(40), web: 'b'.repeat(40) },
    harnessCleanup: ['fulfilled'],
    clock: {
      dropped: 0,
      model: 'unit vector',
      samples: Array.from({ length: 1800 }, (_, i) => ({
        second: i,
        capture: { lowUs: i * 1e6, highUs: i * 1e6 + 1000 },
        worklet: { lowUs: i * 1e6 + 20000, highUs: i * 1e6 + 21000 },
        program: { lowUs: i * 1e6 + 100000, highUs: i * 1e6 + 110000 }
      }))
    },
    diagnostics: Array.from({ length: 1800 }, () => ({
      generation: 1,
      queuedFrames: 480,
      counters: {
        underrunFrames: 0,
        overrunFrames: 0,
        gapFrames: 0,
        staleFrames: 0,
        discontinuities: 0,
        nativeDroppedFrames: 0
      }
    })),
    closeCycles: Array.from({ length: 25 }, (_, i) => ({
      generation: i + 1,
      status: 'closed',
      browserContexts: 0,
      remaining: {
        nativeSources: 0,
        sockets: 0,
        ipcRequests: 0,
        timers: 0,
        rendererRequests: 0,
        worklets: 0,
        contexts: 0,
        tracks: 0,
        publications: 0
      }
    }))
  }
  return { audio, evidence }
}
test('streaming final-artifact analyzer reads actual marker IDs across arbitrary chunks', () => {
  const analyzer = new PcmContinuityAnalyzer(),
    samples = Float32Array.from({ length: 96000 }, (_, i) => fixtureSample(i))
  for (let i = 0; i < samples.length; i += 127) analyzer.push(samples.subarray(i, i + 127))
  assert.deepEqual(
    analyzer.summary().markers.map((m) => m.second),
    [0, 1]
  )
  assert.equal(analyzer.summary().samples, 96000)
})
test('reports measured upper bounds independently and never passes missing encoder or A/V evidence', () => {
  const { audio, evidence } = fixture(),
    result = assessPcmAcceptance(audio, evidence)
  assert.equal(result.gates.nativeToDecodedProgramClock.p95ProgramLatencyUpperMs, 110)
  assert.equal(result.gates.nativeToDecodedProgramClock.p95WorkletLatencyUpperMs, 21)
  assert.equal(result.gates.artifactContinuityAndDrift.status, 'passed')
  assert.equal(result.gates.finalAvSync.status, 'unavailable')
  assert.equal(result.gates.encoderDeliveryLatency.status, 'unavailable')
  assert.equal(result.status, 'failed')
  assert.equal(result.productionQualified, false)
})
test('fails the applicable gate for incomplete capture, drift, replay, bad clocks or leaked resources', async () => {
  await assert.rejects(analyzePcmEvidence(), /real capture evidence/)
  for (const [gate, mutate] of [
    [
      'artifactContinuityAndDrift',
      (a) => {
        a.samples = 48000
      }
    ],
    [
      'artifactContinuityAndDrift',
      (a) => {
        a.markers = a.markers.map((m, i) => ({ ...m, audioFrame: m.audioFrame + i * 10 }))
      }
    ],
    [
      'artifactContinuityAndDrift',
      (a) => {
        a.markers[15].second = 14
      }
    ],
    [
      'nativeToDecodedProgramClock',
      (_a, e) => {
        e.clock.samples[0].program.lowUs = NaN
      }
    ],
    [
      'ownerCloseReopen',
      (_a, e) => {
        e.closeCycles[0].remaining.worklets = 1
      }
    ],
    [
      'ownerCloseReopen',
      (_a, e) => {
        delete e.closeCycles[0].remaining.nativeSources
      }
    ],
    [
      'boundedQueues',
      (_a, e) => {
        e.diagnostics[0].queuedFrames = 1921
      }
    ]
  ]) {
    const { audio, evidence } = fixture()
    mutate(audio, evidence)
    assert.equal(assessPcmAcceptance(audio, evidence).gates[gate].status, 'failed')
  }
})
