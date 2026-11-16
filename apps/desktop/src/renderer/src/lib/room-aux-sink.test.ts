import { expect, it } from 'vitest'
import { auxiliaryVoices } from './room-aux-sink'
import type { SoundboardSnapshot } from './soundboard-store'
it('reconnect skips prior one-shots and joins loops using backend voice ids', () => {
  const voices = [
    { voiceId: 'v-old', loop: false, startedAtMs: 10 },
    { voiceId: 'v-loop', loop: true },
    { voiceId: 'v-new', loop: false, startedAtMs: 30 }
  ]
  expect(
    auxiliaryVoices({ voices } as unknown as SoundboardSnapshot, new Set(['v-old', 'v-loop'])).map(
      (v) => v.voiceId
    )
  ).toEqual(['v-loop', 'v-new'])
})

it('a delayed backend snapshot cannot replay a one-shot from before the new epoch', () => {
  const voices = [
    { voiceId: 'v-delayed', loop: false, startedAtMs: 10 },
    { voiceId: 'v-loop', loop: true, startedAtMs: 10 }
  ]
  expect(
    auxiliaryVoices({ voices } as unknown as SoundboardSnapshot, new Set(), 20).map(
      (v) => v.voiceId
    )
  ).toEqual(['v-loop'])
})
