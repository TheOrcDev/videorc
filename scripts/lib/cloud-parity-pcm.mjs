/** Final-artifact qualification for machine-acquired S7a evidence. No runtime
 * measurement is synthesized from fixture values or absent counters. */
import assert from 'node:assert/strict'
import { createReadStream, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, dirname } from 'node:path'
import { PcmMarkerDecoder } from './cloud-parity-pcm-marker.mjs'

export class PcmContinuityAnalyzer {
  samples = 0
  markers = []
  nonFinite = 0
  clipped = 0
  longestSilence = 0
  #silence = 0
  #decoder = new PcmMarkerDecoder()
  push(samples) {
    assert.ok(
      this.samples + samples.length <= 3600 * 48000,
      'Acceptance artifact exceeds the one-hour analysis bound'
    )
    this.#decoder.push(samples, this.samples, (marker) => this.markers.push(marker))
    for (const sample of samples) {
      if (!Number.isFinite(sample)) this.nonFinite++
      if (Math.abs(sample) >= 1) this.clipped++
      if (Math.abs(sample) < 0.0001) this.#silence++
      else this.#silence = 0
      this.longestSilence = Math.max(this.longestSilence, this.#silence)
      this.samples++
    }
  }
  summary() {
    return {
      samples: this.samples,
      markers: this.markers,
      nonFinite: this.nonFinite,
      clipped: this.clipped,
      longestSilence: this.longestSilence,
      rejectedMarkers: this.#decoder.rejected
    }
  }
}
const p95 = (values) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]
const finite = (value) => typeof value === 'number' && Number.isFinite(value)
export function assessPcmAcceptance(audio, evidence) {
  assert.equal(
    evidence.schemaVersion,
    2,
    'Use the maintained acquisition driver, not hand-authored v1 evidence'
  )
  assert.equal(evidence.kind, 'local-livekit-program-pcm')
  const gates = {}
  const check = (name, fn) => {
    try {
      gates[name] = { status: 'passed', ...fn() }
    } catch (error) {
      gates[name] = { status: 'failed', reason: error.message }
    }
  }
  check('provenance', () => {
    assert.equal(evidence.acquisition, 'completed')
    for (const name of ['desktop', 'web'])
      assert.match(evidence.revisions?.[name] ?? '', /^[0-9a-f]{40}$/)
    assert.equal(evidence.sampleRate, 48000)
    assert.equal(evidence.channels, 1)
    assert.ok(evidence.harnessCleanup?.every((value) => value === 'fulfilled'))
    return {}
  })
  check('artifactContinuityAndDrift', () => {
    assert.ok(audio.samples >= 1800 * 48000, 'Need 30 minutes of actual program audio')
    assert.equal(audio.nonFinite, 0)
    assert.equal(audio.clipped, 0)
    assert.ok(audio.longestSilence <= 480, 'Program silence exceeds one 10 ms source block')
    assert.ok(audio.markers.length >= 1800, 'Missing decoded timestamp identities')
    const first = audio.markers[0],
      drift = []
    for (let i = 0; i < audio.markers.length; i++) {
      const marker = audio.markers[i]
      if (i)
        assert.equal(
          marker.second,
          audio.markers[i - 1].second + 1,
          'Lost, replayed or reordered marker ID'
        )
      drift.push(
        (marker.audioFrame - first.audioFrame) / 48 - (marker.second - first.second) * 1000
      )
    }
    const maxDriftMs = Math.max(...drift.map(Math.abs))
    assert.ok(maxDriftMs <= 80, 'Program sample drift exceeds 80 ms')
    return {
      maxDriftMs,
      decodedMarkers: audio.markers.length,
      rejectedMarkers: audio.rejectedMarkers
    }
  })
  check('nativeToDecodedProgramClock', () => {
    assert.equal(evidence.clock?.dropped, 0, 'Clock observer dropped evidence')
    const samples = evidence.clock?.samples
    assert.ok(samples?.length >= 1800, 'Missing measured bracketing events over 30 minutes')
    const artifactIds = new Set(audio.markers.map((marker) => marker.second))
    const latency = [],
      worklet = [],
      uncertainty = []
    for (const sample of samples) {
      assert.ok(artifactIds.has(sample.second), 'Live observation absent from encoded artifact')
      for (const key of ['capture', 'worklet', 'program']) {
        assert.ok(
          finite(sample[key]?.lowUs) &&
            finite(sample[key]?.highUs) &&
            sample[key].highUs >= sample[key].lowUs,
          'Missing measured clock interval'
        )
        uncertainty.push((sample[key].highUs - sample[key].lowUs) / 2000)
      }
      const lower = sample.program.lowUs - sample.capture.highUs
      const upper = sample.program.highUs - sample.capture.lowUs
      assert.ok(upper >= 0, 'Inconsistent clock ordering')
      latency.push(upper / 1000) // Gate the conservative upper bound, not a fabricated exact sample.
      worklet.push((sample.worklet.highUs - sample.capture.lowUs) / 1000)
      assert.ok(lower <= upper)
    }
    assert.ok(samples.at(-1).second - samples[0].second >= 1799)
    assert.ok(p95(latency) <= 250, 'Local native-to-final-bus latency upper bound exceeds 250 ms')
    assert.ok(
      Math.abs(p95(latency.slice(-60)) - p95(latency.slice(0, 60))) <= 80,
      'Latency grows beyond 80 ms'
    )
    return {
      p95ProgramLatencyUpperMs: p95(latency),
      p95WorkletLatencyUpperMs: p95(worklet),
      maximumUncertaintyMs: Math.max(...uncertainty),
      method: evidence.clock.model
    }
  })
  check('boundedQueues', () => {
    assert.ok(evidence.diagnostics?.length >= 1800)
    const generations = new Map()
    for (const observation of evidence.diagnostics) {
      assert.ok(
        Number.isSafeInteger(observation.queuedFrames) &&
          observation.queuedFrames >= 0 &&
          observation.queuedFrames <= 1920
      )
      for (const key of [
        'underrunFrames',
        'overrunFrames',
        'gapFrames',
        'staleFrames',
        'discontinuities',
        'nativeDroppedFrames'
      ]) {
        assert.ok(
          Number.isSafeInteger(observation.counters?.[key]) && observation.counters[key] >= 0
        )
        assert.ok(
          observation.counters[key] >= (generations.get(observation.generation)?.[key] ?? 0)
        )
      }
      generations.set(observation.generation, observation.counters)
    }
    return { countersByGeneration: Object.fromEntries(generations) }
  })
  check('ownerCloseReopen', () => {
    assert.ok(evidence.closeCycles?.length >= 25, 'Need 25 actual owner close/reopen cycles')
    const generations = new Set()
    for (const cycle of evidence.closeCycles) {
      assert.ok(Number.isSafeInteger(cycle.generation) && !generations.has(cycle.generation))
      generations.add(cycle.generation)
      assert.equal(cycle.status, 'closed', 'Cleanup unavailable or resources remain')
      for (const key of [
        'nativeSources',
        'sockets',
        'ipcRequests',
        'timers',
        'rendererRequests',
        'worklets',
        'contexts',
        'tracks',
        'publications'
      ])
        assert.equal(cycle.remaining?.[key], 0, `${key} cleanup unavailable or nonzero`)
      assert.equal(cycle.browserContexts, 0)
    }
    return { cycles: generations.size }
  })
  // Explicitly missing APIs cannot be replaced by timestamps from a separate
  // recorder or by receipt time. Even perfect audio-only evidence stays partial.
  for (const measurement of ['encoderDeliveryLatency', 'finalAvSync']) {
    const unavailable = evidence.unavailable?.find((item) => item.measurement === measurement)
    gates[measurement] = {
      status: 'unavailable',
      reason: unavailable?.reason ?? 'No maintained measurement adapter supplied this observation',
      owner: unavailable?.owner,
      api: unavailable?.api
    }
  }
  return {
    status: Object.values(gates).every((gate) => gate.status === 'passed') ? 'passed' : 'failed',
    gates,
    productionQualified: false
  }
}
async function sha(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}
export async function analyzePcmEvidence(file) {
  assert.ok(file, 'A real capture evidence file from acquisition is required')
  const evidence = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(evidence.schemaVersion, 2)
  assert.match(evidence.decodedSha256 ?? '', /^[0-9a-f]{64}$/)
  for (const artifact of evidence.artifacts ?? [])
    assert.equal(
      await sha(resolve(dirname(file), artifact.file)),
      artifact.sha256,
      `Artifact hash changed: ${artifact.kind}`
    )
  const audio = new PcmContinuityAnalyzer(),
    hash = createHash('sha256')
  let carry = Buffer.alloc(0)
  for await (const chunk of createReadStream(resolve(dirname(file), evidence.decodedF32le))) {
    hash.update(chunk)
    const bytes = Buffer.concat([carry, chunk]),
      count = Math.floor(bytes.length / 4),
      samples = new Float32Array(count)
    for (let i = 0; i < count; i++) samples[i] = bytes.readFloatLE(i * 4)
    audio.push(samples)
    carry = Buffer.from(bytes.subarray(count * 4))
  }
  assert.equal(carry.length, 0, 'Truncated float sample')
  assert.equal(hash.digest('hex'), evidence.decodedSha256)
  return assessPcmAcceptance(audio.summary(), evidence)
}
