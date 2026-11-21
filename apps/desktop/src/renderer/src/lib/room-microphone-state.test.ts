import { expect, it } from 'vitest'
import { roomMicrophoneState, roomMicrophoneMeter } from './room-microphone-state'
it('fences late meter and close events from a retired microphone epoch', () => {
  const previous = roomMicrophoneState.acquire('browser-aec')
  previous.update({ state: 'published', peakDb: -12, rmsDb: -20, observedAt: 1 })
  const current = roomMicrophoneState.acquire('native-headphones')
  current.update({ state: 'published', peakDb: -6, rmsDb: -9, observedAt: 2 })
  previous.close()
  previous.update({ state: 'lost', peakDb: -1, observedAt: 3 })
  expect(roomMicrophoneState.getSnapshot()).toMatchObject({
    mode: 'native-headphones',
    state: 'published',
    peakDb: -6,
    observedAt: 2,
    nativeQualified: false
  })
  let peak: number | undefined
  const detach = roomMicrophoneMeter.subscribe((frame) => {
    peak = frame.channels[0].peakDb
  })
  current.close()
  expect(peak).toBeNaN()
  expect(roomMicrophoneState.getSnapshot().observedAt).toBeNull()
  detach()
})

// PH-12 (perf hunt 11-20): the source measures a level every 50 ms. React
// hears only a change it shows (state, mode, words, levels arriving or not);
// every level still reaches the meter and the snapshot.
it('notifies React only when the view changes, never for a level alone', () => {
  const owner = roomMicrophoneState.acquire('browser-aec')
  let notified = 0
  const unsubscribe = roomMicrophoneState.subscribe(() => {
    notified += 1
  })
  const peaks: number[] = []
  const detach = roomMicrophoneMeter.subscribe((frame) => {
    peaks.push(frame.channels[0].peakDb)
  })

  owner.update({ state: 'published' })
  expect(notified).toBe(1)
  expect(roomMicrophoneState.getView()).toEqual({
    mode: 'browser-aec',
    state: 'published',
    reason: null,
    levels: false
  })

  owner.update({ peakDb: -20, rmsDb: -30, observedAt: 1 })
  expect(notified).toBe(2)
  expect(roomMicrophoneState.getView().levels).toBe(true)
  const view = roomMicrophoneState.getView()
  for (let tick = 2; tick <= 21; tick += 1)
    owner.update({ peakDb: -20 + tick / 10, rmsDb: -30, observedAt: tick })
  expect(notified).toBe(2)
  expect(roomMicrophoneState.getView()).toBe(view)
  expect(roomMicrophoneState.getSnapshot().observedAt).toBe(21)
  expect(roomMicrophoneState.getSnapshot().peakDb).toBeCloseTo(-17.9)
  expect(peaks).toHaveLength(22)

  // Levels stop (a null tick), the words change, the close: each one is news.
  owner.update({ peakDb: null, rmsDb: null, observedAt: null })
  expect(notified).toBe(3)
  owner.update({ reason: 'Browser echo cancellation.' })
  expect(notified).toBe(4)
  owner.close()
  expect(notified).toBe(5)
  expect(roomMicrophoneState.getView()).toMatchObject({ state: 'off', levels: false })
  unsubscribe()
  detach()
})
