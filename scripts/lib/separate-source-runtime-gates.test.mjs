import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  audioEnergyTransitions,
  evaluateAudioVideoEvents,
  evaluateAudioTail,
  evaluateSourceEnvelope,
  evaluateEventAlignment,
  evaluateFrameMarkers,
  videoTransitionTimes
} from './separate-source-runtime-gates.mjs'

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
