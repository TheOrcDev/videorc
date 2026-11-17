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
