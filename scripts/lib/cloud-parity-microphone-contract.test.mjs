import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  microphoneAcquisitionConfig,
  microphoneMeasurements,
  assessMicrophoneEvidence
} from './cloud-parity-microphone-contract.mjs'
test('microphone acquisition configuration is bounded and execution modes are explicit', () => {
  assert.equal(microphoneAcquisitionConfig().cycles, 25)
  for (const env of [
    { VIDEORC_MIC_SECONDS: 2 },
    { VIDEORC_MIC_SECONDS: 11 },
    { VIDEORC_MIC_CYCLES: 0 },
    { VIDEORC_MIC_CYCLES: 51 },
    { VIDEORC_PCM_MODE: 'pretend' }
  ])
    assert.throws(() => microphoneAcquisitionConfig(env))
})
test('measurement uses decoded samples, rejects invalid PCM and keeps mute near negative infinity', () => {
  assert.ok(microphoneMeasurements(new Float32Array(48000)).rmsDb < -60)
  const a = microphoneMeasurements(new Float32Array(48000).fill(0.1))
  const b = microphoneMeasurements(new Float32Array(48000).fill(0.1 * 10 ** (-6 / 20)))
  assert.ok(Math.abs(b.rmsDb - a.rmsDb + 6) < 0.001)
  assert.throws(() => microphoneMeasurements(new Float32Array(48000).fill(NaN)))
})
test('missing observations fail their gate; no amount of synthetic unit data qualifies clocks or speaker AEC', () => {
  const evidence = {
    kind: 'native-room-microphone',
    acquisition: 'completed',
    harnessCleanup: Array(4).fill('fulfilled'),
    steps: [
      ['baseline', -20],
      ['gain-minus-six', -26],
      ['muted', -90],
      ['underrun', -90],
      ['underrun-recovered', -20],
      ['none', -90],
      ['disconnected', -90],
      ['noise-on', -30],
      ['switched', -20],
      ['recovered', -20],
      ['reconnected', -20]
    ].map(([name, rmsDb]) => ({
      name,
      measurements: {
        rmsDb,
        tone440: name === 'switched' ? -90 : -20,
        tone880: name === 'switched' ? -20 : -90
      }
    })),
    closeCycles: Array.from({ length: 25 }, (_, i) => ({
      generation: i + 1,
      status: 'closed',
      remaining: Object.fromEntries(
        [
          'nativeSources',
          'sockets',
          'ipcRequests',
          'timers',
          'rendererRequests',
          'worklets',
          'contexts',
          'tracks',
          'publications'
        ].map((k) => [k, 0])
      )
    }))
  }
  const result = assessMicrophoneEvidence(evidence)
  assert.equal(result.gates.gain.status, 'passed')
  assert.equal(result.status, 'failed')
  assert.equal(result.gates.speakerAec.status, 'unavailable')
  evidence.closeCycles[0] = { status: 'unavailable' }
  evidence.steps = []
  const missing = assessMicrophoneEvidence(evidence)
  assert.equal(missing.gates.owners.status, 'failed')
  assert.equal(missing.gates.gain.status, 'failed')
})
test('underrun silence requires a live captured producer and recovery observations', () => {
  const starved = {
    name: 'underrun',
    measurements: { rmsDb: -90 },
    observation: { main: { nativeSources: 1 }, renderer: { state: 'published' } },
    publications: [{ sid: 'fixture' }],
    diagnostics: { events: [{ phase: 'native-frame', droppedFrames: 480 }] }
  }
  const evidence = {
    steps: [starved, { name: 'underrun-recovered', measurements: { tone440: -20 } }]
  }
  assert.equal(assessMicrophoneEvidence(evidence).gates.underrunWithLiveOwner.status, 'passed')
  starved.observation.main.nativeSources = 0
  assert.equal(assessMicrophoneEvidence(evidence).gates.underrunWithLiveOwner.status, 'failed')
  starved.observation.main.nativeSources = 1
  starved.measurements.rmsDb = -20
  assert.equal(assessMicrophoneEvidence(evidence).gates.underrunWithLiveOwner.status, 'failed')
})
