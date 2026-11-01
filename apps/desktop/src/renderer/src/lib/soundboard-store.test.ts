import { describe, expect, it, vi } from 'vitest'

import type { Sound, SoundboardState, SoundVoice } from './backend'
import { createSoundboardStore, type SoundboardClient } from './soundboard-store'

// Plan 189: the soundboard outside React. A board read on a connection never
// beats a newer `sounds.changed`, and nothing plays without a connection.

const sound = (id: string): Sound => ({
  id,
  name: id,
  file: `${id}.wav`,
  durationMs: 1000,
  loudnessLufs: -18,
  levelDb: 0,
  volumeDb: 0,
  mode: 'oneShot',
  sortOrder: 0,
  createdAt: '2026-10-23T09:00:00Z',
  updatedAt: '2026-10-23T09:00:00Z'
})
const board = (...ids: string[]): SoundboardState => ({
  sounds: ids.map(sound),
  volumeDb: 0,
  monitor: true,
  startersSeeded: true
})
const voice: SoundVoice = {
  voiceId: 'v-1',
  soundId: 'a',
  startedAtMs: 1,
  durationMs: 1000,
  loop: false,
  onAir: false
}

function deferredClient(): SoundboardClient & { answer: (board: SoundboardState) => void } {
  let resolve: (board: SoundboardState) => void = () => undefined
  return {
    request: vi.fn(
      () =>
        new Promise((done) => {
          resolve = done as (board: SoundboardState) => void
        })
    ) as SoundboardClient['request'],
    answer: (next) => resolve(next)
  }
}

describe('the soundboard store (plan 189)', () => {
  it('reads the board on connect, and an event that lands first wins over the read', async () => {
    const store = createSoundboardStore()
    expect(store.getSnapshot()).toMatchObject({ board: null, online: false })
    const client = deferredClient()
    store.connect(client)
    expect(client.request).toHaveBeenCalledWith('sounds.list')
    expect(store.getSnapshot().online).toBe(true)
    store.acceptBoard(board('a', 'b'))
    client.answer(board('stale'))
    await Promise.resolve()
    expect(store.getSnapshot().board?.sounds.map((entry) => entry.id)).toEqual(['a', 'b'])

    const fresh = createSoundboardStore()
    const second = deferredClient()
    fresh.connect(second)
    second.answer(board('a'))
    await Promise.resolve()
    expect(fresh.getSnapshot().board?.sounds.map((entry) => entry.id)).toEqual(['a'])
  })

  it('drops the voices and the client when its connection goes, keeping the board', () => {
    const store = createSoundboardStore()
    const client = deferredClient()
    store.connect(client)
    store.acceptBoard(board('a'))
    store.acceptPlayback({ voices: [voice] })
    expect(store.getSnapshot().voices).toEqual([voice])
    store.disconnect(deferredClient())
    expect(store.client()).toBe(client)
    store.disconnect(client)
    expect(store.client()).toBeNull()
    expect(store.getSnapshot()).toMatchObject({ online: false, voices: [] })
    expect(store.getSnapshot().board?.sounds).toHaveLength(1)
  })

  it('follows whether a running session can carry sounds (release test 147)', () => {
    const store = createSoundboardStore()
    const client = deferredClient()
    store.connect(client)
    expect(store.getSnapshot().sessionWithoutSounds).toBe(false)
    store.acceptPlayback({ voices: [], sessionWithoutSounds: true })
    expect(store.getSnapshot().sessionWithoutSounds).toBe(true)
    store.acceptPlayback({ voices: [voice] })
    expect(store.getSnapshot().sessionWithoutSounds).toBe(false)
    store.acceptPlayback({ voices: [], sessionWithoutSounds: true })
    store.disconnect(client)
    expect(store.getSnapshot().sessionWithoutSounds).toBe(false)
  })

  it('tells its listeners about every change', () => {
    const store = createSoundboardStore()
    const listener = vi.fn()
    store.subscribe(listener)
    store.acceptBoard(board('a', 'b'))
    store.setHidden(new Set(['a']))
    expect([...store.getSnapshot().hidden]).toEqual(['a'])
    store.acceptPlayback({ voices: [voice] })
    expect(listener).toHaveBeenCalledTimes(3)
  })
})
