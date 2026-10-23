import { describe, expect, it, vi } from 'vitest'

import type { Sound, SoundboardState } from './backend'
import { startSoundboardHost, type SoundboardHostDeps } from './soundboard-host'
import { createSoundboardStore, type SoundboardClient } from './soundboard-store'

// Plan 189: the main window's soundboard host. It pushes the Stream Manager a
// read-only board (never a file), loads the monitor only on the first voice,
// seeds the starters once per connection, and answers a relayed press.

const sound = (id: string): Sound => ({
  id,
  name: id.toUpperCase(),
  file: `${id}.wav`,
  durationMs: 1000,
  loudnessLufs: -18,
  levelDb: 0,
  volumeDb: 0,
  mode: 'toggle',
  sortOrder: 0,
  createdAt: '2026-10-23T09:00:00Z',
  updatedAt: '2026-10-23T09:00:00Z'
})
const board = (startersSeeded = true): SoundboardState => ({
  sounds: [sound('a')],
  volumeDb: 0,
  monitor: true,
  startersSeeded
})
const client = { request: vi.fn(() => new Promise(() => undefined)) } as unknown as SoundboardClient

function host(overrides: Partial<SoundboardHostDeps> = {}) {
  const store = createSoundboardStore()
  let relay: ((command: never) => void) | null = null
  const monitor = { update: vi.fn(), dispose: vi.fn() }
  const deps: SoundboardHostDeps = {
    api: {
      pushCommentsSounds: vi.fn(async () => true),
      onSoundRequest: vi.fn((callback) => {
        relay = callback as never
        return () => undefined
      }),
      pushSoundResult: vi.fn(async () => true)
    },
    loadMonitor: vi.fn(async () => ({ createSoundMonitor: () => monitor })),
    seedStarters: vi.fn(async () => undefined),
    runAction: vi.fn(async () => ({ ok: true })),
    ...overrides
  }
  const stop = startSoundboardHost(store, deps)
  return { store, deps, monitor, stop, relay: (command: unknown) => relay?.(command as never) }
}

const flush = async (): Promise<void> => {
  for (let index = 0; index < 5; index += 1) await Promise.resolve()
}

describe('the soundboard host (plan 189)', () => {
  it('pushes the board summary to the Stream Manager once per change', () => {
    const { store, deps } = host()
    expect(deps.api?.pushCommentsSounds).toHaveBeenLastCalledWith(null)
    store.acceptBoard(board())
    store.acceptBoard(board())
    expect(deps.api?.pushCommentsSounds).toHaveBeenCalledTimes(2)
    expect(deps.api?.pushCommentsSounds).toHaveBeenLastCalledWith({
      sounds: [{ id: 'a', name: 'A', mode: 'toggle' }],
      voices: []
    })
    store.setHidden(new Set(['a']))
    expect(deps.api?.pushCommentsSounds).toHaveBeenLastCalledWith({ sounds: [], voices: [] })
  })

  it('loads the monitor on the first voice only, then feeds it every change', async () => {
    const { store, deps, monitor, stop } = host()
    store.acceptBoard(board())
    expect(deps.loadMonitor).not.toHaveBeenCalled()
    const voice = {
      voiceId: 'v-1',
      soundId: 'a',
      startedAtMs: 1,
      durationMs: 1000,
      loop: false,
      onAir: false
    }
    store.acceptPlayback({ voices: [voice] })
    store.acceptPlayback({ voices: [voice] })
    await flush()
    expect(deps.loadMonitor).toHaveBeenCalledTimes(1)
    expect(monitor.update).toHaveBeenCalled()
    store.acceptPlayback({ voices: [] })
    expect(monitor.update).toHaveBeenLastCalledWith(expect.objectContaining({ voices: [] }))
    stop()
    expect(monitor.dispose).toHaveBeenCalled()
  })

  it('seeds the starters once per connection while the board says it has not', () => {
    const { store, deps } = host()
    store.acceptBoard(board(false))
    expect(deps.seedStarters).not.toHaveBeenCalled()
    store.connect(client)
    store.acceptBoard(board(false))
    expect(deps.seedStarters).toHaveBeenCalledTimes(1)
    const next = {
      request: vi.fn(() => new Promise(() => undefined))
    } as unknown as SoundboardClient
    store.connect(next)
    expect(deps.seedStarters).toHaveBeenCalledTimes(2)
    store.acceptBoard(board(true))
    store.connect(client)
    expect(deps.seedStarters).toHaveBeenCalledTimes(2)
  })

  it('answers a relayed press with done, or the sentence that says why not', async () => {
    const runAction = vi
      .fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, message: "That sound isn't available anymore." })
      .mockRejectedValueOnce(new Error('boom'))
    const { deps, relay } = host({ runAction })
    relay({ requestId: 'r1', action: 'play', id: 'a' })
    relay({ requestId: 'r2', action: 'press', id: 'gone' })
    relay({ requestId: 'r3', action: 'stopAll' })
    await flush()
    expect(runAction).toHaveBeenNthCalledWith(1, expect.anything(), { action: 'play', id: 'a' })
    expect(deps.api?.pushSoundResult).toHaveBeenCalledWith({
      requestId: 'r1',
      ok: true,
      value: true
    })
    expect(deps.api?.pushSoundResult).toHaveBeenCalledWith({
      requestId: 'r2',
      ok: false,
      error: "That sound isn't available anymore."
    })
    expect(deps.api?.pushSoundResult).toHaveBeenCalledWith({
      requestId: 'r3',
      ok: false,
      error: "Couldn't play the sound."
    })
  })
})
