import assert from 'node:assert/strict'
export function microphoneAcquisitionConfig(env = {}) {
  const seconds = Number(env.VIDEORC_MIC_SECONDS ?? 4),
    cycles = Number(env.VIDEORC_MIC_CYCLES ?? 25)
  assert.ok(Number.isInteger(seconds) && seconds >= 3 && seconds <= 10)
  assert.ok(Number.isInteger(cycles) && cycles >= 1 && cycles <= 50)
  const mode = env.VIDEORC_PCM_MODE ?? 'acquire-analyze'
  assert.ok(['acquire', 'analyze', 'acquire-analyze'].includes(mode))
  return { seconds, cycles, mode }
}
export function microphoneMeasurements(samples) {
  assert.ok(samples.length >= 48000)
  let energy = 0,
    peak = 0
  for (const sample of samples) {
    assert.ok(Number.isFinite(sample))
    energy += sample * sample
    peak = Math.max(peak, Math.abs(sample))
  }
  return { rmsDb: 10 * Math.log10(Math.max(1e-20, energy / samples.length)), peak }
}
export function assessMicrophoneEvidence(evidence) {
  const gates = {}
  const check = (name, fn) => {
    try {
      fn()
      gates[name] = { status: 'passed' }
    } catch (error) {
      gates[name] = { status: 'failed', reason: error.message }
    }
  }
  const step = (name) => {
    const s = evidence.steps?.find((s) => s.name === name)
    assert.ok(s?.measurements, `Missing measured ${name}`)
    return s.measurements
  }
  check('acquisition', () => {
    assert.equal(evidence.kind, 'native-room-microphone')
    assert.equal(evidence.acquisition, 'completed')
    assert.equal(evidence.harnessCleanup?.length, 4)
    assert.ok(evidence.harnessCleanup.every((s) => s === 'fulfilled'))
  })
  check('provenance', () => {
    for (const key of ['desktop', 'web'])
      assert.match(evidence.revisions?.[key] ?? '', /^[a-f0-9]{40}$/)
    for (const key of ['desktopDiff', 'programBundle'])
      assert.match(evidence.revisions?.[key] ?? '', /^[a-f0-9]{64}$/)
    assert.ok(Array.isArray(evidence.revisions.untrackedSources))
    assert.ok(evidence.artifacts?.length > 0)
    for (const step of evidence.steps ?? []) {
      assert.ok(
        step.ffprobe?.streams?.some(
          (stream) => stream.codec_type === 'audio' && Number(stream.sample_rate) === 48000
        )
      )
      assert.ok(step.decode?.executable && Array.isArray(step.decode.args))
      for (const file of [step.encodedFile, step.decodedFile])
        assert.ok(
          evidence.artifacts.some((artifact) => artifact.file === file),
          'Unregistered audio artifact'
        )
    }
  })
  check('underrunWithLiveOwner', () => {
    const captured = evidence.steps?.find((step) => step.name === 'underrun')
    assert.equal(captured?.observation?.main?.nativeSources, 1)
    assert.equal(captured?.observation?.renderer?.state, 'published')
    assert.equal(captured?.publications?.length, 1)
    assert.ok(step('underrun').rmsDb < -60, 'Starved timeline repeats stale audio')
    assert.ok(step('underrun-recovered').tone440 > -50)
    assert.ok(
      captured.diagnostics?.events?.some(
        (event) => event.phase === 'native-frame' && event.droppedFrames > 0
      )
    )
  })
  check('gain', () => {
    const difference = step('gain-minus-six').rmsDb - step('baseline').rmsDb
    assert.ok(Math.abs(difference + 6) <= 1, 'Measured gain differs from -6 dB')
  })
  check('muteAndNone', () => {
    for (const name of ['muted', 'none', 'disconnected', 'underrun'])
      assert.ok(step(name).rmsDb < -60, `${name} is audible`)
  })
  check('nativeNoiseResponse', () => {
    assert.ok(
      Math.abs(step('noise-on').rmsDb - step('baseline').rmsDb) >= 1,
      'No measured native denoiser response'
    )
  })
  check('switchAndRecovery', () => {
    assert.ok(step('switched').tone880 > -50 && step('switched').tone440 < -60)
    for (const name of ['recovered', 'reconnected', 'underrun-recovered'])
      assert.ok(step(name).tone440 > -50)
  })
  check('owners', () => {
    assert.ok(evidence.closeCycles?.length >= 25)
    const generations = new Set()
    for (const c of evidence.closeCycles) {
      assert.ok(
        Number.isSafeInteger(c.generation) && c.generation > 0 && !generations.has(c.generation)
      )
      generations.add(c.generation)
      assert.equal(c.status, 'closed')
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
        assert.equal(c.remaining?.[key], 0, `Missing or live ${key}`)
    }
  })
  gates.physicalUnplug = {
    status: 'unavailable',
    reason:
      'Synthetic capture EOF exercises loss ownership; a physical device unplug was not measured.'
  }
  for (const name of ['clockAndFinalAv', 'speakerAec', 'offsetTiming'])
    gates[name] = {
      status: 'unavailable',
      reason:
        name === 'speakerAec'
          ? 'Native processing has no qualified speaker echo reference.'
          : 'S13a timestamped video mapping and encoder completion measurement remain unavailable; a configured offset is not measured sync.'
    }
  return {
    status: Object.values(gates).every((g) => g.status === 'passed') ? 'passed' : 'failed',
    gates,
    productionQualified: false
  }
}
