import { afterEach, expect, it } from 'vitest'
import {
  roomAudioRouting,
  systemControllerEnabled,
  systemControllerStep
} from './room-audio-routing'
afterEach(() => roomAudioRouting.reset())
it('Disarms on owner loss and never restores capture consent from gain or program changes', () => {
  roomAudioRouting.system({ enabled: true, muted: true, gainDb: -6 })
  roomAudioRouting.status('capturing', null)
  roomAudioRouting.disarmSystem()
  roomAudioRouting.program({ speechMuted: true })
  roomAudioRouting.system({ gainDb: 0 })
  expect(roomAudioRouting.getSnapshot().system).toEqual({ enabled: false, muted: true, gainDb: 0 })
  expect(roomAudioRouting.getSnapshot().systemState).toBe('off')
  roomAudioRouting.takeover(true)
  roomAudioRouting.takeover(false)
  expect(roomAudioRouting.getSnapshot().program.speechMuted).toBe(true)
})
it('Requires bounded finite source and recipient gains', () => {
  expect(() => roomAudioRouting.system({ gainDb: Infinity })).toThrow()
  expect(() => roomAudioRouting.program({ speechGain: -1 })).toThrow()
  expect(() => roomAudioRouting.program({ auxiliaryGain: 2 })).toThrow()
})

it('S24: system capture starts off on a takeover, any later epoch and a loss; no epoch of its own', () => {
  // No controller (a node show or an older web): nothing to follow.
  expect(systemControllerStep(0, undefined, undefined)).toEqual({ disarm: false, epoch: 0 })
  // A first claim keeps the streamer's choice; a first epoch that is a takeover does not.
  expect(systemControllerStep(0, { controllerEpoch: 1 }, undefined)).toEqual({
    disarm: false,
    epoch: 1
  })
  expect(
    systemControllerStep(0, { controllerEpoch: 3, takenOverFrom: 'another-device' }, undefined)
  ).toEqual({ disarm: true, epoch: 3 })
  // The same epoch again changes nothing; any new one disarms, the same show too.
  expect(systemControllerStep(3, { controllerEpoch: 3 }, undefined).disarm).toBe(false)
  expect(systemControllerStep(3, { controllerEpoch: 4 }, undefined)).toEqual({
    disarm: true,
    epoch: 4
  })
  // A loss disarms whatever the epoch says.
  expect(systemControllerStep(4, { controllerEpoch: 4, lost: true }, undefined).disarm).toBe(true)
  expect(systemControllerStep(4, { controllerEpoch: 4 }, 'taken-over').disarm).toBe(true)
})

it('S24: reports system on only while it captures in an open room', () => {
  roomAudioRouting.system({ enabled: true })
  expect(systemControllerEnabled(roomAudioRouting.getSnapshot(), true)).toBe(false)
  roomAudioRouting.status('capturing', null)
  expect(systemControllerEnabled(roomAudioRouting.getSnapshot(), true)).toBe(true)
  expect(systemControllerEnabled(roomAudioRouting.getSnapshot(), false)).toBe(false)
  roomAudioRouting.disarmSystem()
  expect(systemControllerEnabled(roomAudioRouting.getSnapshot(), true)).toBe(false)
})
