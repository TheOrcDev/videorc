import { afterEach, describe, expect, it, vi } from 'vitest'
import { RoomSceneResender, createRoomSceneEditSync } from './room-scene-resender'

afterEach(() => vi.useRealTimers())

type Layout = { x: number; visibleCamera: boolean }
type Result = { ok: boolean; state: 'applied' | 'failed' | 'superseded' | 'waiting' }

/** The Studio as the edit sync sees it: a room, a scene on it, the working layout. */
function studio() {
  const rooms = { a: { name: 'a' }, b: { name: 'b' } }
  const state = {
    room: rooms.a as { name: string } | null,
    live: true,
    layout: { x: 0, visibleCamera: true } as Layout,
    sent: [] as Layout[],
    committed: [] as Layout[],
    warned: [] as string[],
    answer: { ok: true, state: 'applied' } as Result,
    gate: null as null | (() => void)
  }
  const sync = createRoomSceneEditSync<{ name: string }, Layout, Result>({
    live: () => state.live,
    room: () => state.room,
    target: () => ({ ...state.layout }),
    send: async (target, current) => {
      state.sent.push(target)
      if (state.gate) await new Promise<void>((resolve) => (state.gate = resolve))
      // The adapter checks `current()` in the same tick as its commit.
      if (!current()) return { ok: false, state: 'superseded' }
      state.committed.push(target)
      return state.answer
    },
    failed: (r) => (r.ok || r.state === 'superseded' || r.state === 'waiting' ? null : 'failed'),
    warn: (message) => state.warned.push(message),
    now: () => Date.now(),
    minIntervalMs: 120
  })
  return { state, sync, rooms }
}

describe('S12 room scene edit sync', () => {
  it('a burst of drags is one send of the latest box, then one more for what came during it', async () => {
    vi.useFakeTimers()
    const { state, sync } = studio()
    for (let x = 1; x <= 20; x++) {
      state.layout = { ...state.layout, x }
      sync.request()
    }
    await vi.advanceTimersByTimeAsync(0)
    expect(state.sent.map((l) => l.x)).toEqual([20])
    // Edits while a send is in flight wait, bounded to one, and use the latest state.
    state.gate = () => {}
    state.layout = { ...state.layout, x: 21 }
    sync.request()
    await vi.advanceTimersByTimeAsync(200)
    state.layout = { ...state.layout, x: 22 }
    sync.request()
    state.layout = { ...state.layout, x: 23 }
    sync.request()
    expect(state.sent.map((l) => l.x)).toEqual([20, 21])
    const release = state.gate
    state.gate = null
    release?.()
    await vi.advanceTimersByTimeAsync(200)
    expect(state.sent.map((l) => l.x)).toEqual([20, 21, 23])
  })

  it('Show/Hide reaches the room with the rest of the scene as it is now', async () => {
    vi.useFakeTimers()
    const { state, sync } = studio()
    state.layout = { x: 5, visibleCamera: false }
    sync.request()
    await vi.advanceTimersByTimeAsync(0)
    expect(state.sent).toEqual([{ x: 5, visibleCamera: false }])
  })

  it('rapid edits then a clear send nothing more', async () => {
    vi.useFakeTimers()
    const { state, sync } = studio()
    sync.request()
    await vi.advanceTimersByTimeAsync(0)
    for (let i = 0; i < 5; i++) sync.request()
    state.live = false // the host chose a room layout: the scene is gone
    await vi.advanceTimersByTimeAsync(500)
    expect(state.sent).toHaveLength(1)
    sync.request()
    await vi.advanceTimersByTimeAsync(500)
    expect(state.sent).toHaveLength(1)
  })

  it('a clear while an edit is still on its way commits nothing after the clear', async () => {
    vi.useFakeTimers()
    const { state, sync } = studio()
    state.gate = () => {}
    sync.request()
    await vi.advanceTimersByTimeAsync(0)
    expect(state.sent).toHaveLength(1)
    state.live = false // cleared while the edit was resolving
    state.gate?.()
    await vi.advanceTimersByTimeAsync(500)
    expect(state.committed).toEqual([])
    expect(state.warned).toEqual([])
  })

  it('rapid edits then another room send nothing to it, and a late answer is ignored', async () => {
    vi.useFakeTimers()
    const { state, sync, rooms } = studio()
    for (let i = 0; i < 5; i++) sync.request()
    state.room = rooms.b
    await vi.advanceTimersByTimeAsync(500)
    expect(state.sent).toHaveLength(0)
    // An answer that lands after the room changed warns nobody.
    state.room = rooms.a
    state.answer = { ok: false, state: 'failed' }
    state.gate = () => {}
    sync.request()
    await vi.advanceTimersByTimeAsync(0)
    state.room = rooms.b
    state.gate?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(state.warned).toEqual([])
  })

  it('a scene chosen meanwhile cancels the waiting edit and silences the running one', async () => {
    vi.useFakeTimers()
    const { state, sync } = studio()
    state.answer = { ok: false, state: 'failed' }
    state.gate = () => {}
    sync.request()
    await vi.advanceTimersByTimeAsync(0)
    sync.request() // waits behind the running send
    sync.cancel()
    const release = state.gate
    state.gate = null
    release?.()
    await vi.advanceTimersByTimeAsync(500)
    expect(state.sent).toHaveLength(1)
    expect(state.warned).toEqual([])
  })

  it('warns once for a real failure, never for superseded or unconfirmed sends', async () => {
    vi.useFakeTimers()
    const { state, sync } = studio()
    for (const answer of [
      { ok: false, state: 'superseded' },
      { ok: false, state: 'waiting' },
      { ok: false, state: 'failed' }
    ] as Result[]) {
      state.answer = answer
      sync.request()
      await vi.advanceTimersByTimeAsync(200)
    }
    expect(state.warned).toEqual(['failed'])
  })

  it('off, no request starts a timer', () => {
    vi.useFakeTimers()
    const { state, sync } = studio()
    state.live = false
    sync.request()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('S12 resender bounds', () => {
  it('spaces sends by the interval and never runs two at once', async () => {
    vi.useFakeTimers()
    let running = 0
    let peak = 0
    const starts: number[] = []
    const resender = new RoomSceneResender({
      now: () => Date.now(),
      minIntervalMs: 100,
      send: async () => {
        running++
        peak = Math.max(peak, running)
        starts.push(Date.now())
        await new Promise((resolve) => setTimeout(resolve, 30))
        running--
      }
    })
    for (let i = 0; i < 10; i++) {
      resender.request()
      await vi.advanceTimersByTimeAsync(20)
    }
    await vi.advanceTimersByTimeAsync(500)
    expect(peak).toBe(1)
    for (let i = 1; i < starts.length; i++)
      expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(100)
    expect(resender.pending).toBe(false)
  })
})
