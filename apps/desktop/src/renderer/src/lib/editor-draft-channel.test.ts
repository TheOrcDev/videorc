import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { EditorChrome, SceneEditorDraftParams } from '@/lib/backend'
import {
  EDITOR_DRAFT_HEARTBEAT_MS,
  EDITOR_DRAFT_REFUSED,
  createEditorDraftChannel
} from './editor-draft-channel'

const chrome = (selected: SceneEditorDraftParams['transform']): EditorChrome => ({
  selected,
  handles: true,
  activeHandle: 'se',
  guides: [{ axis: 'x', position: 0.5 }],
  scale: 2.5
})
const rect = (x: number) => ({ x, y: 0.2, width: 0.3, height: 0.3 })
const draft = (x: number) => ({ transform: rect(x), chrome: chrome(rect(x)) })

type Deferred = { resolve: (value?: unknown) => void; reject: (error: unknown) => void }
function harness({ enabled = true } = {}) {
  const sets: SceneEditorDraftParams[] = []
  const deferred: Deferred[] = []
  const set = vi.fn((params: SceneEditorDraftParams) => {
    sets.push(params)
    return new Promise<unknown>((resolve, reject) => {
      deferred.push({ resolve, reject })
    })
  })
  const clear = vi.fn(() => Promise.resolve({ active: false }))
  const log = vi.fn()
  const channel = createEditorDraftChannel({ set, clear, log })
  channel.enabled = enabled
  const settle = async (index = deferred.length - 1, value: unknown = { active: true }) => {
    deferred[index]!.resolve(value)
    await vi.advanceTimersByTimeAsync(0)
  }
  const fail = async (index: number, error: unknown) => {
    deferred[index]!.reject(error)
    await vi.advanceTimersByTimeAsync(0)
  }
  return { channel, set, clear, log, sets, deferred, settle, fail }
}

describe('editor draft channel', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps one set in flight and sends only the newest sample when it returns', async () => {
    const h = harness()
    h.channel.begin('source:camera')
    h.channel.sample(draft(0.1))
    expect(h.set).toHaveBeenCalledTimes(1)
    expect(h.sets[0]).toEqual({
      sourceId: 'source:camera',
      transform: rect(0.1),
      chrome: chrome(rect(0.1))
    })
    h.channel.sample(draft(0.2))
    h.channel.sample(draft(0.3))
    expect(h.set).toHaveBeenCalledTimes(1)
    await h.settle(0)
    expect(h.set).toHaveBeenCalledTimes(2)
    expect(h.sets[1]!.transform).toEqual(rect(0.3))
    await h.settle(1)
    expect(h.set).toHaveBeenCalledTimes(2)
  })

  it('heartbeats the last draft every 500 ms while nothing else is sent', async () => {
    const h = harness()
    h.channel.begin('source:camera')
    h.channel.sample(draft(0.1))
    await h.settle(0)
    await vi.advanceTimersByTimeAsync(EDITOR_DRAFT_HEARTBEAT_MS - 1)
    expect(h.set).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.set).toHaveBeenCalledTimes(2)
    expect(h.sets[1]).toEqual(h.sets[0])
    await h.settle(1)
    // A fresh sample restarts the cadence from its own send.
    await vi.advanceTimersByTimeAsync(300)
    h.channel.sample(draft(0.2))
    await h.settle(2)
    await vi.advanceTimersByTimeAsync(EDITOR_DRAFT_HEARTBEAT_MS - 1)
    expect(h.set).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.set).toHaveBeenCalledTimes(4)
    expect(h.sets[3]!.transform).toEqual(rect(0.2))
    await h.settle(3)
    // Never more than one in flight: a slow heartbeat response defers the next
    // beat until it returns, then the cadence restarts from that return.
    await vi.advanceTimersByTimeAsync(EDITOR_DRAFT_HEARTBEAT_MS * 3)
    expect(h.set).toHaveBeenCalledTimes(5)
    await h.settle(4)
    expect(h.set).toHaveBeenCalledTimes(5)
    await vi.advanceTimersByTimeAsync(EDITOR_DRAFT_HEARTBEAT_MS)
    expect(h.set).toHaveBeenCalledTimes(6)
    h.channel.dispose()
  })

  it('sends clear exactly once on cancel and ignores later samples', async () => {
    const h = harness()
    h.channel.begin('source:camera')
    h.channel.sample(draft(0.1))
    await h.settle(0)
    h.channel.sample(draft(0.2))
    h.channel.sample(draft(0.3))
    expect(h.set).toHaveBeenCalledTimes(2)
    h.channel.cancel()
    h.channel.cancel()
    expect(h.clear).toHaveBeenCalledTimes(1)
    expect(h.channel.active).toBe(false)
    await h.settle(1)
    // The pending 0.3 was dropped, no heartbeat survives, samples are ignored.
    h.channel.sample(draft(0.4))
    await vi.advanceTimersByTimeAsync(EDITOR_DRAFT_HEARTBEAT_MS * 2)
    expect(h.set).toHaveBeenCalledTimes(2)
    expect(h.clear).toHaveBeenCalledTimes(1)
  })

  it('sends exactly the four transform keys even when the ghost carries crop fields', async () => {
    const h = harness()
    h.channel.begin('source:camera')
    const scene = { ...rect(0.1), cropX: 0.1, cropWidth: 0.8, zoom: 1.5 } as never
    h.channel.sample({ transform: scene, chrome: chrome(scene) })
    expect(Object.keys(h.sets[0]!.transform).sort()).toEqual(['height', 'width', 'x', 'y'])
    expect(Object.keys(h.sets[0]!.chrome.selected).sort()).toEqual(['height', 'width', 'x', 'y'])
    h.channel.release(scene)
    await h.settle(0)
    expect(Object.keys(h.sets[1]!.transform).sort()).toEqual(['height', 'width', 'x', 'y'])
    expect(Object.keys(h.sets[1]!.chrome.selected).sort()).toEqual(['height', 'width', 'x', 'y'])
  })

  it('does not clear on cancel when nothing reached the wire', () => {
    const h = harness()
    h.channel.begin('source:camera')
    h.channel.cancel()
    expect(h.clear).not.toHaveBeenCalled()
  })

  it('release sends one final set with the rounded rect and never clears', async () => {
    const h = harness()
    h.channel.begin('source:camera')
    h.channel.sample(draft(0.123456))
    await h.settle(0)
    const rounded = rect(0.1235)
    h.channel.release(rounded)
    expect(h.set).toHaveBeenCalledTimes(2)
    expect(h.sets[1]).toEqual({
      sourceId: 'source:camera',
      transform: rounded,
      chrome: { selected: rounded, handles: true, guides: [], scale: 2.5 }
    })
    expect('activeHandle' in h.sets[1]!.chrome).toBe(false)
    expect(h.channel.active).toBe(false)
    await h.settle(1)
    h.channel.sample(draft(0.5))
    h.channel.cancel()
    await vi.advanceTimersByTimeAsync(EDITOR_DRAFT_HEARTBEAT_MS * 3)
    expect(h.set).toHaveBeenCalledTimes(2)
    expect(h.clear).not.toHaveBeenCalled()
  })

  it('release while a set is in flight supersedes the pending sample', async () => {
    const h = harness()
    h.channel.begin('source:camera')
    h.channel.sample(draft(0.1))
    h.channel.sample(draft(0.2))
    const rounded = rect(0.25)
    h.channel.release(rounded)
    expect(h.set).toHaveBeenCalledTimes(1)
    await h.settle(0)
    expect(h.set).toHaveBeenCalledTimes(2)
    expect(h.sets[1]!.transform).toEqual(rounded)
    await h.settle(1)
    await vi.advanceTimersByTimeAsync(EDITOR_DRAFT_HEARTBEAT_MS * 2)
    expect(h.set).toHaveBeenCalledTimes(2)
  })

  it('release without any sample sends nothing', () => {
    const h = harness()
    h.channel.begin('source:camera')
    h.channel.release(rect(0.1))
    expect(h.set).not.toHaveBeenCalled()
    expect(h.clear).not.toHaveBeenCalled()
  })

  it('a disabled channel never sends anything', async () => {
    const h = harness({ enabled: false })
    h.channel.begin('source:camera')
    h.channel.sample(draft(0.1))
    h.channel.release(rect(0.1))
    h.channel.begin('source:camera')
    h.channel.sample(draft(0.2))
    h.channel.cancel()
    await vi.advanceTimersByTimeAsync(EDITOR_DRAFT_HEARTBEAT_MS * 3)
    expect(h.set).not.toHaveBeenCalled()
    expect(h.clear).not.toHaveBeenCalled()
  })

  it('disabling mid-gesture clears the draft that reached the wire', async () => {
    const h = harness()
    h.channel.begin('source:camera')
    h.channel.sample(draft(0.1))
    await h.settle(0)
    h.channel.enabled = false
    expect(h.clear).toHaveBeenCalledTimes(1)
    h.channel.sample(draft(0.2))
    expect(h.set).toHaveBeenCalledTimes(1)
  })

  it('a refusal disables the rest of the gesture without retries or throws', async () => {
    const h = harness()
    h.channel.begin('source:camera')
    h.channel.sample(draft(0.1))
    h.channel.sample(draft(0.2))
    const refusal = Object.assign(new Error('A recording is running.'), {
      code: EDITOR_DRAFT_REFUSED
    })
    await h.fail(0, refusal)
    expect(h.set).toHaveBeenCalledTimes(1)
    expect(h.log).not.toHaveBeenCalled()
    h.channel.sample(draft(0.3))
    await vi.advanceTimersByTimeAsync(EDITOR_DRAFT_HEARTBEAT_MS * 2)
    expect(h.set).toHaveBeenCalledTimes(1)
    h.channel.release(rect(0.3))
    expect(h.set).toHaveBeenCalledTimes(1)
    expect(h.clear).not.toHaveBeenCalled()
    // The next gesture starts clean.
    h.channel.begin('source:camera')
    h.channel.sample(draft(0.4))
    expect(h.set).toHaveBeenCalledTimes(2)
  })

  it('swallows other rejections after one debug log and keeps going', async () => {
    const h = harness()
    h.channel.begin('source:camera')
    h.channel.sample(draft(0.1))
    await h.fail(0, new Error('socket closed'))
    expect(h.log).toHaveBeenCalledTimes(1)
    h.channel.sample(draft(0.2))
    expect(h.set).toHaveBeenCalledTimes(2)
    await h.settle(1)
    expect(h.channel.active).toBe(true)
  })

  it('a new gesture cancels an open one and starts fresh', async () => {
    const h = harness()
    h.channel.begin('source:camera')
    h.channel.sample(draft(0.1))
    await h.settle(0)
    h.channel.begin('source:screen')
    expect(h.clear).toHaveBeenCalledTimes(1)
    h.channel.sample(draft(0.2))
    expect(h.sets[1]!.sourceId).toBe('source:screen')
  })

  it('dispose cancels and makes the channel inert', async () => {
    const h = harness()
    h.channel.begin('source:camera')
    h.channel.sample(draft(0.1))
    await h.settle(0)
    h.channel.dispose()
    expect(h.clear).toHaveBeenCalledTimes(1)
    h.channel.begin('source:camera')
    h.channel.sample(draft(0.2))
    await vi.advanceTimersByTimeAsync(EDITOR_DRAFT_HEARTBEAT_MS * 2)
    expect(h.set).toHaveBeenCalledTimes(1)
  })
})
