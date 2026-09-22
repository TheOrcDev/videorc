import { describe, expect, it, vi } from 'vitest'
import type { Scene, SceneCommitStatus } from '@/lib/backend'
import {
  StageEdits,
  StageGesture,
  visibleStageHandles,
  stageHandleOffset,
  type TransformCommitResult
} from './stage-gesture'
import { stageSnapTargets, type StageRect } from './stage-transform'
const rect: StageRect = { x: 0.3, y: 0.3, width: 0.3, height: 0.3 }
const modifiers = { shiftKey: false, altKey: false }
const empty = { x: [], y: [] }
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const scene = (box: StageRect): Scene => ({
  id: 'scene',
  name: 'Scene',
  outputs: [],
  sources: [
    {
      id: 'screen',
      name: 'Screen',
      kind: 'screen',
      locked: false,
      visible: true,
      transform: {
        ...box,
        cropTop: 0,
        cropRight: 0,
        cropBottom: 0,
        cropLeft: 0
      },
      defaultTransform: {
        ...box,
        cropTop: 0,
        cropRight: 0,
        cropBottom: 0,
        cropLeft: 0
      }
    }
  ]
})
// Only scene identity/revision is read by this editor; compositor fields remain
// backend-owned and are exercised in the real-app smoke.
const result = (box: StageRect, revision = 1): TransformCommitResult => ({
  ok: true,
  status: {
    applied: true,
    mode: 'idle',
    sceneRevision: revision,
    scene: scene(box),
    compositorStatus: {} as SceneCommitStatus['compositorStatus']
  }
})
const tick = async () => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('gesture geometry ownership', () => {
  it.each([
    { width: 480, height: 270 },
    { width: 236.25, height: 420 }
  ])('moves 1:1 with Snap off in %j', (pixels) => {
    const gesture = new StageGesture(
      'screen',
      1,
      'move',
      rect,
      { x: 0.35, y: 0.35 },
      pixels,
      stageSnapTargets([]),
      false,
      true,
      false
    )
    const next = gesture.sample(
      { x: 0.35 + 17 / pixels.width, y: 0.35 + 9 / pixels.height },
      modifiers
    )
    expect((next.rect.x - rect.x) * pixels.width).toBeCloseTo(17)
    expect((next.rect.y - rect.y) * pixels.height).toBeCloseTo(9)
    expect(next.guides).toEqual([])
  })
  it('latches Shift in CSS pixels and does not switch on noisy ties', () => {
    const gesture = new StageGesture(
      'screen',
      1,
      'move',
      rect,
      { x: 0, y: 0 },
      { width: 480, height: 270 },
      empty,
      false,
      true,
      false
    )
    gesture.sample({ x: 0, y: 0 }, { ...modifiers, shiftKey: true })
    expect(gesture.sample({ x: 0.02, y: 0.03 }, { ...modifiers, shiftKey: true }).rect.y).toBe(0.3)
    expect(gesture.sample({ x: 0.02, y: 0.1 }, { ...modifiers, shiftKey: true }).rect.y).toBe(0.3)
  })
  it('holds a snap target under boundary noise and releases through tiny samples', () => {
    const gesture = new StageGesture(
      'screen',
      1,
      'move',
      { ...rect, x: 0.1 },
      { x: 0, y: 0 },
      { width: 500, height: 500 },
      { x: [0.2], y: [] },
      true,
      true,
      false
    )
    const sample = (x: number) => gesture.sample({ x, y: 0 }, modifiers).rect.x
    expect(sample(0.092)).toBeCloseTo(0.2)
    for (const x of [0.101, 0.099, 0.101, 0.099]) expect(sample(x)).toBeCloseTo(0.2)
    const positions = Array.from({ length: 31 }, (_, i) => sample(0.1 + i * 0.002))
    expect(positions.at(-1)).toBeGreaterThan(0.23)
    for (let i = 1; i < positions.length; i++)
      expect(Math.abs(positions[i] - positions[i - 1]) * 500).toBeLessThanOrEqual(1.001)
  })
  it('rebases Alt when releasing the magnet', () => {
    const gesture = new StageGesture(
      'screen',
      1,
      'move',
      { ...rect, x: 0.1 },
      { x: 0, y: 0 },
      { width: 500, height: 500 },
      { x: [0.2], y: [] },
      true,
      true,
      false
    )
    const held = gesture.sample({ x: 0.092, y: 0 }, modifiers)
    const bypass = gesture.sample({ x: 0.092, y: 0 }, { ...modifiers, altKey: true })
    expect(bypass.rect).toEqual(held.rect)
    expect(bypass.guides).toEqual([])
    expect(gesture.sample({ x: 0.094, y: 0 }, { ...modifiers, altKey: true }).rect.x).toBeCloseTo(
      0.202
    )
  })
  it('a rebased pointer loop may end at its origin with a real geometry edit', () => {
    const initial = { ...rect, x: 0.1 }
    const gesture = new StageGesture(
      'screen',
      1,
      'move',
      initial,
      { x: 0, y: 0 },
      { width: 500, height: 500 },
      { x: [0.2], y: [] },
      true,
      true,
      false
    )
    gesture.sample({ x: 0.092, y: 0 }, modifiers)
    gesture.sample({ x: 0.092, y: 0 }, { ...modifiers, altKey: true })
    const final = gesture.sample({ x: 0, y: 0 }, { ...modifiers, altKey: true })
    expect(final.rect.x).toBeCloseTo(0.108)
    expect(final.rect.x).not.toBe(initial.x)
  })
  it('shares inspector aspect choice while preserving forced shape constraints', () => {
    const sample = (locked: boolean, forced: boolean) =>
      new StageGesture(
        'screen',
        1,
        'se',
        rect,
        { x: 0, y: 0 },
        { width: 480, height: 270 },
        empty,
        false,
        locked,
        forced
      ).sample({ x: 0.1, y: 0 }, modifiers).rect
    expect(sample(false, false).width).toBeCloseTo(0.4)
    expect(sample(false, false).height).toBeCloseTo(0.3)
    expect(sample(true, false).width / sample(true, false).height).toBeCloseTo(1)
    expect(sample(false, true).width / sample(false, true).height).toBeCloseTo(1)
  })
  it('keeps adaptive targets separated', () => {
    expect(visibleStageHandles(15, 30)).toEqual(['se'])
    expect(visibleStageHandles(30, 30)).toEqual(['nw', 'ne', 'se', 'sw'])
    expect(visibleStageHandles(60, 60)).toHaveLength(8)
  })
})

describe('released gesture acknowledgement', () => {
  it.each([50, 250])(
    'holds final geometry for a %sms delayed acknowledgement, including cloned props',
    async (delay) => {
      vi.useFakeTimers()
      const next = { ...rect, x: 0.46 }
      const response = result(next)
      const commit = vi.fn(
        () =>
          new Promise<TransformCommitResult>((resolve) =>
            setTimeout(() => resolve(response), delay)
          )
      )
      const edits = new StageEdits(
        commit,
        () => {},
        () => {}
      )
      edits.observe(scene(rect))
      edits.submit('screen', next)
      await tick()
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(edits.draft?.rect).toEqual(next)
      expect(commit).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(edits.draft?.rect.x).toBe(next.x)
      edits.observe(structuredClone(response.ok ? response.status.scene : scene(rect)))
      expect(edits.draft).toBeNull()
      vi.useRealTimers()
    }
  )
  it('serializes two quick releases and ignores the older acknowledgement for presentation', async () => {
    const first = deferred<TransformCommitResult>(),
      second = deferred<TransformCommitResult>()
    const commit = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const edits = new StageEdits(
      commit,
      () => {},
      () => {}
    )
    const a = { ...rect, x: 0.4 },
      b = { ...rect, x: 0.5 }
    edits.observe(scene(rect))
    edits.submit('screen', a)
    edits.submit('screen', b)
    await tick()
    expect(commit).toHaveBeenCalledTimes(1)
    first.resolve(result(a, 1))
    await tick()
    edits.observe(scene(a))
    expect(edits.draft?.rect).toEqual(b)
    expect(commit).toHaveBeenCalledTimes(2)
    second.resolve(result(b, 2))
    await tick()
    edits.observe(scene(b))
    expect(edits.draft).toBeNull()
  })
  it('a rejected/disconnected dependency invalidates newer releases once', async () => {
    const pending = deferred<TransformCommitResult>(),
      failed = vi.fn()
    const commit = vi.fn(() => pending.promise)
    const edits = new StageEdits(commit, () => {}, failed)
    edits.observe(scene(rect))
    edits.submit('screen', { ...rect, x: 0.4 })
    edits.submit('screen', { ...rect, x: 0.5 })
    await tick()
    pending.resolve({ ok: false })
    await tick()
    expect(edits.draft).toBeNull()
    expect(failed).toHaveBeenCalledTimes(1)
    expect(commit).toHaveBeenCalledTimes(1)
  })
  it('scene replacement discards a stale acknowledgement and queued work', async () => {
    const pending = deferred<TransformCommitResult>()
    const commit = vi.fn(() => pending.promise)
    const edits = new StageEdits(
      commit,
      () => {},
      () => {}
    )
    edits.observe(scene(rect))
    edits.submit('screen', { ...rect, x: 0.4 })
    edits.submit('screen', { ...rect, x: 0.5 })
    await tick()
    edits.invalidate()
    edits.observe({ ...scene(rect), id: 'replacement' })
    pending.resolve(result({ ...rect, x: 0.4 }))
    await tick()
    expect(edits.draft).toBeNull()
    expect(commit).toHaveBeenCalledTimes(1)
  })
  it('does not clear a newer in-flight drag when a previous draft reaches props', async () => {
    const pending = deferred<TransformCommitResult>(),
      failed = vi.fn()
    const edits = new StageEdits(
      () => pending.promise,
      () => {},
      failed
    )
    const a = { ...rect, x: 0.4 }
    edits.observe(scene(rect))
    edits.submit('screen', a)
    await tick()
    const drag = new StageGesture(
      'screen',
      1,
      'move',
      edits.draft!.rect,
      { x: 0, y: 0 },
      { width: 480, height: 270 },
      empty,
      false,
      true,
      false
    )
    const next = drag.sample({ x: 0.03, y: 0 }, modifiers)
    pending.resolve(result(a))
    await tick()
    edits.observe(scene(a))
    expect(edits.draft).toBeNull()
    expect(next.rect.x).toBeCloseTo(0.43)
    expect(failed).not.toHaveBeenCalled()
  })
})

it.each([
  { width: 160, height: 90 },
  { width: 90, height: 160 }
])('tiny source keeps its move body at every corner of %j', (canvas) => {
  const width = canvas.width * 0.05,
    height = canvas.height * 0.05
  const offset = stageHandleOffset(width, height)
  expect(visibleStageHandles(width, height)).toEqual(['se'])
  for (const x of [0, canvas.width - width])
    for (const y of [0, canvas.height - height]) {
      const hit = { x: x + width + offset - 12, y: y + height + offset - 12, width: 24, height: 24 }
      // The entire tiny source body remains free of the resize hit box.
      expect(hit.x).toBeGreaterThanOrEqual(x + width)
      expect(hit.y).toBeGreaterThanOrEqual(y + height)
      expect(hit.x + hit.width).toBeLessThanOrEqual(canvas.width + 28)
      expect(hit.y + hit.height).toBeLessThanOrEqual(canvas.height + 28)
    }
})
