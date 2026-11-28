import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  COMPOSITOR_TIMING_FILENAME,
  audioEnergyTransitions,
  audioToneWindows,
  createRuntimeCaseCollector,
  combinedSourceMarkerFilter,
  evaluateAudioVideoEvents,
  evaluateAudioTail,
  evaluateCompositorTiming,
  evaluateSourceEnvelope,
  evaluateEventAlignment,
  evaluateFrameMarkers,
  readCompositorTiming,
  refinedToneTransitions,
  videoTransitionTimes
} from './separate-source-runtime-gates.mjs'

function pulsePcm(tones, { duration = 2, sampleRate = 48000 } = {}) {
  return Float32Array.from({ length: Math.round(duration * sampleRate) }, (_, index) => {
    const time = index / sampleRate
    return tones.reduce((sum, { frequency, edges, phase = 0, amplitude = 0.25 }) => {
      const hot = edges.filter((edge) => time >= edge).length % 2
      return sum + hot * amplitude * Math.sin(2 * Math.PI * frequency * time + phase)
    }, 0)
  })
}

test('sample-domain tone edges preserve subwindow positions and arbitrary phase for both sources', () => {
  const edges = [0.342, 0.642, 1.0420208333333334, 1.442]
  for (const frequency of [317, 997]) {
    for (const phase of [0, 0.73, 2.9]) {
      const pcm = pulsePcm([{ frequency, edges, phase }])
      const measured = refinedToneTransitions(pcm, { frequency, startTime: 0.125 })
      assert.equal(measured.pass, true, JSON.stringify(measured))
      assert.equal(measured.events.length, edges.length)
      for (const [index, at] of measured.events.entries())
        assert.ok(Math.abs(at - edges[index] - 0.125) <= 2 / 48000, JSON.stringify(measured))
    }
  }
})

test('mixed-tone refinement separates coincident and independently changing nearby sources', () => {
  const microphone = [0.34317, 0.64317, 1.04317, 1.44317]
  for (const shift of [0, -0.0047, 0.0047, 0.02, -0.0347, 0.0347]) {
    const system = microphone.map((at) => at + shift)
    const pcm = pulsePcm([
      { frequency: 997, edges: microphone, phase: 1.7, amplitude: 0.18 },
      { frequency: 317, edges: system, phase: 0.31, amplitude: 0.32 }
    ])
    for (const [frequency, expected] of [
      [997, microphone],
      [317, system]
    ]) {
      const measured = refinedToneTransitions(pcm, { frequency })
      assert.equal(measured.pass, true, JSON.stringify({ shift, measured }))
      assert.equal(measured.events.length, expected.length)
      for (const [index, at] of measured.events.entries())
        assert.ok(Math.abs(at - expected[index]) <= 2 / 48000, JSON.stringify({ shift, measured }))
    }
  }
})

test('refined PCM edges keep the 25ms native-latency case within the unchanged 60fps budget', () => {
  const edges = [0.242, 0.542, 0.942, 1.642, 1.842, 2.242, 3.142, 3.442, 3.842]
  const pcm = pulsePcm([{ frequency: 997, edges, phase: 0.83 }], { duration: 4 })
  const measured = refinedToneTransitions(pcm, { frequency: 997 })
  assert.equal(measured.pass, true, JSON.stringify(measured))
  const video = edges.map((at) => at + 0.025)
  assert.equal(
    evaluateAudioVideoEvents(video, measured.events, { fps: 60, endSeconds: 4 }).pass,
    true
  )
})

test('decoded PCM early and late edges one millisecond beyond each 30/60fps budget fail', () => {
  const video = [0.40137, 0.73137, 1.11137, 1.57137]
  for (const fps of [30, 60]) {
    for (const direction of [-1, 1]) {
      const edges = video.map((at) => at + direction * (1 / fps + 0.01 + 0.001))
      const pcm = pulsePcm([
        { frequency: 997, edges, phase: 2.34, amplitude: 0.22 },
        { frequency: 317, edges: edges.map((at) => at + 0.004), phase: 1.01, amplitude: 0.27 }
      ])
      for (const frequency of [317, 997]) {
        const measured = refinedToneTransitions(pcm, { frequency })
        assert.equal(measured.pass, true, JSON.stringify(measured))
        const sourceVideo = video.map((at) => at + (frequency === 317 ? 0.004 : 0))
        assert.equal(
          evaluateAudioVideoEvents(sourceVideo, measured.events, { fps, endSeconds: 2 }).pass,
          false
        )
      }
    }
  }
})

test('tone refinement explicitly fails absent, weak, nonfinite or ambiguous evidence', () => {
  assert.equal(refinedToneTransitions(new Float32Array(48000), { frequency: 997 }).pass, false)
  const edges = [0.34, 0.64, 1.04, 1.44]
  const weak = pulsePcm([{ frequency: 997, edges, amplitude: 0.005 }])
  assert.equal(refinedToneTransitions(weak, { frequency: 997 }).pass, false)
  const otherSource = pulsePcm([{ frequency: 317, edges, amplitude: 0.35 }])
  assert.equal(refinedToneTransitions(otherSource, { frequency: 997 }).pass, false)
  const tooClose = pulsePcm([{ frequency: 997, edges: [0.34, 0.36, 0.64, 0.66] }])
  const ambiguous = refinedToneTransitions(tooClose, { frequency: 997 })
  assert.equal(ambiguous.pass, false)
  assert.ok(ambiguous.failures.length)
  assert.throws(
    () => refinedToneTransitions(Float32Array.of(NaN), { frequency: 997 }),
    /finite mono PCM/
  )
})

test('small PCM noise preserves precise edges and large unexplained noise fails confidence', () => {
  const edges = [0.34317, 0.64317, 1.04317, 1.44317]
  const original = pulsePcm([
    { frequency: 997, edges, phase: 1.21 },
    { frequency: 317, edges: edges.map((at) => at - 0.005), phase: 2.03 }
  ])
  for (const [amplitude, expectedPass] of [
    [0.008, true],
    [0.2, false]
  ]) {
    let seed = 17
    const noisy = original.map((value) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return value + (seed / 0x100000000 - 0.5) * 2 * amplitude
    })
    const measured = refinedToneTransitions(noisy, { frequency: 997 })
    assert.equal(measured.pass, expectedPass, JSON.stringify(measured))
    if (expectedPass) {
      assert.equal(measured.events.length, edges.length)
      for (const [index, at] of measured.events.entries())
        assert.ok(Math.abs(at - edges[index]) < 0.0005, JSON.stringify(measured))
    } else {
      assert.ok(measured.diagnostics.some((item) => item.pass === false))
    }
  }
})

test('precision qualification retains genuine startup and terminal gap diagnostics outside consumed events', () => {
  const video = [0.342, 0.642, 1.042, 1.442]
  const pcm = pulsePcm(
    [
      { frequency: 317, edges: [0, 1024 / 48000, 0.03, ...video, 2.012], amplitude: 0.1 },
      { frequency: 997, edges: [0.082, ...video, 2.012], amplitude: 0.25, phase: 1.3 }
    ],
    { duration: 2.02 }
  )
  const measurement = refinedToneTransitions(pcm, { frequency: 317 })
  assert.equal(measurement.pass, false)
  assert.ok(measurement.diagnostics.some((item) => !item.pass && item.candidateTime === 0.02))
  assert.ok(measurement.diagnostics.some((item) => !item.pass && item.candidateTime === 0.03))
  assert.ok(measurement.diagnostics.some((item) => !item.pass && item.candidateTime >= 2))
  for (const fps of [30, 60])
    assert.equal(
      evaluateAudioVideoEvents(video, measurement.events, { fps, endSeconds: 2.012, measurement })
        .pass,
      true
    )
  // Qualification never rewrites the underlying PCM measurement as healthy.
  assert.equal(measurement.pass, false)
  assert.ok(measurement.failures.length >= 3)
})

test('extended startup dropout and an extra interior gap remain failures at 30/60fps', () => {
  const video = [0.342, 0.642, 1.042, 1.442]
  for (const extra of [
    [0, 1024 / 48000, 0.33],
    [0, 0.82, 0.83]
  ]) {
    const edges = [...extra, ...video].sort((a, b) => a - b)
    const measurement = refinedToneTransitions(pulsePcm([{ frequency: 317, edges }]), {
      frequency: 317
    })
    for (const fps of [30, 60])
      assert.equal(
        evaluateAudioVideoEvents(video, measurement.events, { fps, endSeconds: 2, measurement })
          .pass,
        false
      )
  }
})

test('confidence intervals crossing consumed timing bounds stay fatal, and malformed ranges fail fast', () => {
  const video = [0.342, 0.642, 1.042, 1.442]
  for (const fps of [30, 60]) {
    const tolerance = 1 / fps + 0.01
    for (const candidateTime of [video[0] - tolerance - 0.005, video.at(-1) + tolerance + 0.005]) {
      const measurement = {
        pass: false,
        events: video,
        failures: ['uncertain transition'],
        diagnostics: [
          {
            pass: false,
            candidateTime,
            candidateIntervalStart: candidateTime - 0.01,
            candidateIntervalEnd: candidateTime + 0.01
          }
        ]
      }
      const verdict = evaluateAudioVideoEvents(video, video, { fps, endSeconds: 2, measurement })
      assert.equal(verdict.pass, false)
      assert.ok(verdict.failures.some((failure) => failure.includes('confidence overlaps')))
      for (const interval of [
        { candidateIntervalStart: NaN },
        { candidateIntervalEnd: Infinity },
        { candidateIntervalStart: candidateTime + 1 }
      ]) {
        assert.throws(
          () =>
            evaluateAudioVideoEvents(video, video, {
              fps,
              endSeconds: 2,
              measurement: {
                ...measurement,
                diagnostics: [{ ...measurement.diagnostics[0], ...interval }]
              }
            }),
          /finite ordered candidate interval/
        )
      }
    }
  }
  const absent = refinedToneTransitions(new Float32Array(48000), { frequency: 997 })
  const missing = evaluateAudioVideoEvents(video, absent.events, { fps: 30, measurement: absent })
  assert.ok(missing.failures.includes('audio measurement has a global confidence failure'))
  assert.throws(
    () =>
      evaluateAudioVideoEvents(video, video.slice(1), {
        fps: 30,
        measurement: { pass: true, events: video, diagnostics: [], failures: [] }
      }),
    /complete supplied event measurement/
  )
})

test('combined circular marker samples an isolated source and refuses a changed layout', () => {
  const layout = {
    layoutPreset: 'screen-camera',
    cameraTransformMode: 'preset',
    cameraCorner: 'bottom-right',
    cameraSize: 'medium'
  }
  assert.match(combinedSourceMarkerFilter(layout), /^crop=/)
  for (const changed of [
    { cameraCorner: 'top-left' },
    { cameraTransformMode: 'freeform' },
    { layoutPreset: 'camera-only' },
    { cameraSize: 'large' }
  ])
    assert.throws(() => combinedSourceMarkerFilter({ ...layout, ...changed }), /fixture layout/)
})

test('partial tone windows do not turn a 38.9167ms edge into a false 47ms mismatch', () => {
  const sampleRate = 48000
  const edge = 1.5280833333333332
  const pcm = Float32Array.from({ length: sampleRate * 3 }, (_, index) =>
    index / sampleRate >= edge ? Math.sin((index / sampleRate) * 997 * Math.PI * 2) * 0.25 : 0
  )
  const windows = audioToneWindows(pcm, { frequency: 997, sampleRate, startTime: 0 })
  const partial = windows.find((window) => window.time === 1.52)
  assert.equal(partial.endTime, 1.53)
  assert.ok(partial.amplitude > 0.04)
  for (const [fps, transition] of [
    [30, 1.567],
    [60, 1.55]
  ]) {
    const transitionIndex = Math.round(transition * fps)
    const video = Array.from({ length: fps * 3 }, (_, index) => ({
      time: index === transitionIndex ? transition : index / fps,
      hot: index >= transitionIndex
    }))
    assert.equal(evaluateSourceEnvelope(video, windows, { fps, endSeconds: 3 }).pass, true)
  }
})

test('interval-aware envelope exclusion cannot excuse early or late out-of-budget events', () => {
  const video = [0.5, 0.9, 1.6, 2.1]
  for (const fps of [30, 60]) {
    const tolerance = 1 / fps + 0.01
    for (const direction of [-1, 1]) {
      const shift = direction * (tolerance + 0.001)
      const audio = video.map((at) => at + shift)
      // The 10ms analysis window intersects the uncertainty band, but the
      // independently measured edge is still rejected without a new margin.
      assert.equal(evaluateAudioVideoEvents(video, audio, { fps, endSeconds: 3 }).pass, false)
    }
  }
})

test('decoded event timing rejects shifted, frozen and truncated roles at 30 and 60fps', () => {
  for (const fps of [30, 60]) {
    const events = [0.5, 1, 1.5, 2]
    const healthy = { combined: events, screen: events, camera: events.map((at) => at + 1 / fps) }
    assert.equal(evaluateEventAlignment(healthy, fps).pass, true)
    assert.equal(
      evaluateEventAlignment({ ...healthy, camera: events.map((at) => at + 0.2) }, fps).pass,
      false
    )
    assert.equal(evaluateEventAlignment({ ...healthy, camera: [] }, fps).pass, false)
    assert.equal(
      evaluateEventAlignment({ ...healthy, camera: events.slice(0, 2) }, fps).pass,
      false
    )
  }
})

test('video transitions use decoded role pixels', () => {
  const pixels = Buffer.from([0, 100, 0, 0, 101, 0, 0, 255, 0, 0, 254, 0])
  assert.deepEqual(
    videoTransitionTimes(pixels, { timestamps: [0, 1 / 30, 0.5, 0.6], channel: 1 }),
    [0.5]
  )
})

test('video transitions refuse missing frame timestamps', () => {
  assert.throws(
    () => videoTransitionTimes(Buffer.alloc(6), { timestamps: [0], channel: 1 }),
    /one finite media timestamp/
  )
})

test('audio energy events preserve offsets and reject silent or delayed audio', () => {
  const pcm = Float32Array.from({ length: 48000 * 4 }, (_, index) =>
    index % 48000 < 24000 ? 0.2 : 0
  )
  const audio = audioEnergyTransitions(pcm)
  assert.deepEqual(audio, [0.5, 1, 1.5, 2, 2.5, 3, 3.5])
  for (const fps of [30, 60]) {
    for (const offsetMs of [-120, 0, 120]) {
      const video = audio.map((at) => at - offsetMs / 1000)
      assert.equal(evaluateAudioVideoEvents(video, audio, { fps, offsetMs }).pass, true)
      assert.equal(
        evaluateAudioVideoEvents(
          video,
          audio.map((at) => at + 0.2),
          { fps, offsetMs }
        ).pass,
        false
      )
      assert.equal(evaluateAudioVideoEvents(video, [], { fps, offsetMs }).pass, false)
    }
  }
})

test('frame markers expose first-content shift and held content between pulse edges', () => {
  const frames = Array.from({ length: 30 }, (_, index) => ({
    time: index / 30,
    value: (index % 16) * 6
  }))
  const healthy = { screen: frames, camera: frames, combined: frames }
  assert.equal(evaluateFrameMarkers(healthy, 30).pass, true)
  assert.equal(
    evaluateFrameMarkers(
      { ...healthy, camera: frames.map((frame) => ({ ...frame, value: 0 })) },
      30
    ).pass,
    false
  )
  assert.equal(
    evaluateFrameMarkers({ ...healthy, camera: [{ time: 0, value: 90 }, ...frames.slice(1)] }, 30)
      .pass,
    false
  )
})

test('audio tail refuses a shortened track and missing last real samples at30/60fps', () => {
  const reference = Array.from({ length: 400 }, (_, index) => ({
    time: index / 100,
    amplitude: 0.2
  }))
  for (const fps of [30, 60]) {
    assert.equal(evaluateAudioTail(reference, reference, fps).pass, true)
    assert.equal(evaluateAudioTail(reference, reference.slice(0, -20), fps).pass, false)
    assert.equal(
      evaluateAudioTail(
        reference,
        reference.map((window, index) => ({
          ...window,
          amplitude: index > 382 ? 0 : window.amplitude
        })),
        fps
      ).pass,
      false
    )
  }
})

test('frame marker gate rejects shifted first media timestamp', () => {
  const frames = Array.from({ length: 30 }, (_, index) => ({
    time: index / 30,
    value: (index % 16) * 6
  }))
  assert.equal(
    evaluateFrameMarkers(
      {
        screen: frames,
        combined: frames,
        camera: frames.map((frame) => ({ ...frame, time: frame.time + 0.2 }))
      },
      30
    ).pass,
    false
  )
})

test('audio timing cannot excuse a premature tail by shortening its own comparison interval', () => {
  const video = [0.5, 1, 1.5, 2, 2.5, 3, 3.5]
  assert.equal(
    evaluateAudioVideoEvents(video, video.slice(0, 4), { fps: 30, endSeconds: 4 }).pass,
    false
  )
})

test('nonperiodic source events reject omitted or doubled offset extrema', () => {
  const video = [0.5, 0.8, 1.2, 1.9, 2.1, 2.5, 3.4, 3.7, 4.1, 4.8]
  for (const offsetMs of [-1000, 1000]) {
    const healthy = video.map((at) => at + offsetMs / 1000)
    assert.equal(
      evaluateAudioVideoEvents(video, healthy, { fps: 30, offsetMs, endSeconds: 5 }).pass,
      true
    )
    assert.equal(
      evaluateAudioVideoEvents(video, video, { fps: 30, offsetMs, endSeconds: 5 }).pass,
      false
    )
    assert.equal(
      evaluateAudioVideoEvents(
        video,
        video.map((at) => at + offsetMs / 500),
        { fps: 30, offsetMs, endSeconds: 5 }
      ).pass,
      false
    )
  }
})

test('source-clock envelope catches equally padded tails and intentional unavailable advanced tail', () => {
  const video = Array.from({ length: 120 }, (_, index) => ({ time: index / 30, hot: true }))
  const healthy = Array.from({ length: 400 }, (_, index) => ({ time: index / 100, amplitude: 0.2 }))
  assert.equal(evaluateSourceEnvelope(video, healthy, { fps: 30, endSeconds: 4 }).pass, true)
  const lost = healthy.map((window) => ({ ...window, amplitude: window.time > 3.8 ? 0 : 0.2 }))
  assert.equal(evaluateSourceEnvelope(video, lost, { fps: 30, endSeconds: 4 }).pass, false)
  const advanced = healthy.map((window) => ({ ...window, amplitude: window.time >= 3 ? 0 : 0.2 }))
  assert.equal(
    evaluateSourceEnvelope(video, advanced, { fps: 30, endSeconds: 4, offsetMs: -1000 }).pass,
    true
  )
  assert.equal(
    evaluateSourceEnvelope(video, healthy, { fps: 30, endSeconds: 4, offsetMs: -1000 }).pass,
    false
  )
})

test('source-clock Stop boundary ignores held CFR padding but refuses 150ms of lost PCM', () => {
  for (const fps of [30, 60]) {
    const endSeconds = 4.02
    const video = Array.from({ length: Math.ceil(4.066 * fps) }, (_, index) => ({
      time: index / fps,
      hot: true
    }))
    const healthy = Array.from({ length: 402 }, (_, index) => ({
      time: index / 100,
      amplitude: 0.2
    }))
    assert.equal(evaluateSourceEnvelope(video, healthy, { fps, endSeconds }).pass, true)
    const truncated = healthy.filter((window) => window.time < endSeconds - 0.15)
    assert.equal(evaluateSourceEnvelope(video, truncated, { fps, endSeconds }).pass, false)
    const padded = healthy.map((window) => ({
      ...window,
      amplitude: window.time < endSeconds - 0.15 ? 0.2 : 0
    }))
    assert.equal(evaluateSourceEnvelope(video, padded, { fps, endSeconds }).pass, false)
  }
})

test('runtime failure collection preserves cleanup and latches failures across later gates', async () => {
  const order = []
  const collector = createRuntimeCaseCollector({
    collectFailures: true,
    onFailure: () => order.push('reported')
  })
  await collector.run('profile', '/evidence/profile', async () => {
    try {
      throw new Error('artifact failed')
    } finally {
      order.push('reaped')
    }
  })
  for (const name of ['profile-next', 'lifecycle', 'crash', 'latency'])
    await collector.run(name, `/evidence/${name}`, async () => order.push(name))
  assert.deepEqual(order, ['reaped', 'reported', 'profile-next', 'lifecycle', 'crash', 'latency'])
  assert.equal(collector.failures.length, 1)
  assert.equal(collector.failures[0].name, 'profile')
  assert.equal(collector.failures[0].message, 'artifact failed')
})

test('runtime remains fail-fast by default and interruptions never collect', async () => {
  const failure = new Error('failed')
  await assert.rejects(
    createRuntimeCaseCollector().run('case', '/evidence', async () => {
      throw failure
    }),
    (error) => error === failure
  )
  const collector = createRuntimeCaseCollector({ collectFailures: true })
  const interrupted = new Error('interrupted')
  interrupted.name = 'AbortError'
  await assert.rejects(
    collector.run('case', '/evidence', async () => {
      throw interrupted
    }),
    (error) => error === interrupted
  )
  assert.deepEqual(collector.failures, [])
})

function smoothCompositorTrace({
  fps = 30,
  frames = 90,
  startMs = 100,
  roles = [0, 3, 1, 2]
} = {}) {
  const intervalMs = 1000 / fps
  const entries = []
  for (let sequence = 1; sequence <= frames; sequence++) {
    const baseMs = startMs + (sequence - 1) * intervalMs
    for (const [roleOffset, role] of roles.entries()) {
      entries.push({
        role,
        sequence,
        beganMs: baseMs + roleOffset * 2,
        completedMs: baseMs + roleOffset * 2 + 1.5,
        outcome: 'native',
        targetRefs: 4,
        sourceTextureMs: 0.9,
        commandWaitMs: 0.6
      })
    }
  }
  return entries
}

test('compositor stall fixture fails with compositor stalled message before A/V event comparison', () => {
  const dir = mkdtempSync(join(tmpdir(), 'videorc-compositor-stall-'))
  try {
    const trace = smoothCompositorTrace({ fps: 30, frames: 60, startMs: 100 })
    // Inject a 434 ms compositor freeze before frame 50 (like the dual-stream run).
    for (const entry of trace) {
      if (entry.sequence >= 50) {
        entry.beganMs += 400.6667
        entry.completedMs += 400.6667
      }
    }
    writeFileSync(join(dir, COMPOSITOR_TIMING_FILENAME), JSON.stringify(trace))
    const exactAudio = [0.5, 1.0, 1.5, 2.0, 2.5]
    // Video events after the freeze shifted late, which previously looked like an audio miss.
    const stalledVideo = [0.5, 1.0, 1.5, 2.434, 2.5]
    const verdict = evaluateAudioVideoEvents(stalledVideo, exactAudio, {
      fps: 30,
      endSeconds: 3,
      evidenceDir: dir
    })
    assert.equal(verdict.pass, false)
    assert.equal(verdict.failures.length, 1)
    assert.match(verdict.failures[0], /^compositor stalled 434 ms at \d+\.\d{3}s \(frame 50\)$/)
    assert.ok(verdict.failures.every((failure) => !failure.includes('audio misses')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('exact audio with smooth compositor passes at 30 and 60fps, including sequence resets and auxiliary skips', () => {
  const dir = mkdtempSync(join(tmpdir(), 'videorc-compositor-smooth-'))
  try {
    for (const fps of [30, 60]) {
      const cancelledTake = smoothCompositorTrace({ fps, frames: 5, startMs: 100 })
      // Real cancel/precommit runs restart the compositor with sequence = 1 after a pause.
      const realTake = smoothCompositorTrace({ fps, frames: 90, startMs: 500 }).filter(
        // A single contended auxiliary role skip must not trigger a primary compositor stall.
        (entry) => !(entry.role === 2 && entry.sequence === 40)
      )
      writeFileSync(
        join(dir, COMPOSITOR_TIMING_FILENAME),
        JSON.stringify([...cancelledTake, ...realTake])
      )
      const events = [0.5, 1.0, 1.5, 2.0, 2.5]
      const verdict = evaluateAudioVideoEvents(events, events, {
        fps,
        endSeconds: 3,
        evidenceDir: dir
      })
      assert.equal(verdict.pass, true, JSON.stringify(verdict))
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('real audio miss with smooth compositor keeps the existing audio misses video event message', () => {
  const dir = mkdtempSync(join(tmpdir(), 'videorc-compositor-audio-miss-'))
  try {
    writeFileSync(
      join(dir, COMPOSITOR_TIMING_FILENAME),
      JSON.stringify(smoothCompositorTrace({ fps: 30, frames: 90, startMs: 100 }))
    )
    const video = [0.5, 1.0, 1.5, 2.0, 2.5]
    const delayedAudio = [0.5, 1.0, 1.62, 2.0, 2.5]
    const verdict = evaluateAudioVideoEvents(video, delayedAudio, {
      fps: 30,
      endSeconds: 3,
      evidenceDir: dir
    })
    assert.equal(verdict.pass, false)
    assert.ok(
      verdict.failures.some((failure) =>
        failure.includes('audio misses ordered video event 2 at 1.500s')
      )
    )
    assert.ok(verdict.failures.every((failure) => !failure.includes('compositor stalled')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('missing compositor-timing.json logs one line and keeps existing A/V gate behaviour', () => {
  const dir = mkdtempSync(join(tmpdir(), 'videorc-compositor-missing-'))
  try {
    const video = [0.5, 1.0, 1.5, 2.0, 2.5]
    const passLogs = []
    const passVerdict = evaluateAudioVideoEvents(video, video, {
      fps: 30,
      endSeconds: 3,
      evidenceDir: dir,
      log: (line) => passLogs.push(line)
    })
    assert.equal(passVerdict.pass, true)
    assert.equal(passLogs.length, 1)
    assert.match(passLogs[0], /compositor-timing\.json.*missing/i)

    const failLogs = []
    const failVerdict = evaluateAudioVideoEvents(video, [0.5, 1.0, 1.62, 2.0, 2.5], {
      fps: 30,
      endSeconds: 3,
      evidenceDir: dir,
      log: (line) => failLogs.push(line)
    })
    assert.equal(failVerdict.pass, false)
    assert.equal(failLogs.length, 1)
    assert.match(failLogs[0], /compositor-timing\.json.*missing/i)
    assert.ok(
      failVerdict.failures.some((failure) => failure.includes('audio misses ordered video event 2'))
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('compositor timing gate enforces one frame interval plus 10ms boundary and validates input', () => {
  for (const fps of [30, 60]) {
    const budget = 1000 / fps + 10
    const withinBudget = [
      { sequence: 1, beganMs: 100 },
      { sequence: 2, beganMs: 100 + budget - 0.5 }
    ]
    assert.equal(evaluateCompositorTiming(withinBudget, { fps }).pass, true)
    const overBudget = [
      { sequence: 1, beganMs: 100 },
      { sequence: 2, beganMs: 100 + budget + 1 }
    ]
    const verdict = evaluateCompositorTiming(overBudget, { fps })
    assert.equal(verdict.pass, false)
    assert.match(
      verdict.failures[0],
      new RegExp(
        `^compositor stalled ${Math.round(budget + 1)} ms at \\d+\\.\\d{3}s \\(frame 2\\)$`
      )
    )
  }
  assert.throws(
    () => evaluateCompositorTiming([{ sequence: 1, beganMs: NaN }], { fps: 30 }),
    /finite beganMs/
  )
  const badDir = mkdtempSync(join(tmpdir(), 'videorc-compositor-bad-'))
  try {
    writeFileSync(join(badDir, COMPOSITOR_TIMING_FILENAME), JSON.stringify({ not: 'an array' }))
    assert.throws(() => readCompositorTiming(badDir), /JSON array/)
  } finally {
    rmSync(badDir, { recursive: true, force: true })
  }
})
