// @vitest-environment happy-dom
import { act, createElement, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BuddyPreviewCell, BuddyPreviewPack } from '@/lib/buddy-pet-preview-pack'

import { BuddyPetPreview, type BuddyPetPreviewHandle } from './buddy-pet-preview'

const mocked = vi.hoisted(() => ({ load: vi.fn() }))
vi.mock('@/lib/buddy-pet-preview-pack', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/buddy-pet-preview-pack')>()),
  loadBuddyPreviewPack: mocked.load
}))

function cell(): BuddyPreviewCell {
  return {
    image: { source: {} as CanvasImageSource, width: 64, height: 64, close: vi.fn() },
    rect: [0, 0, 64, 64],
    box: [0, 0, 1, 1]
  }
}

/** Three gaze cells on one row and two reactions. */
function fakePack(): BuddyPreviewPack {
  const frames = [
    { id: 'left', kind: 'gaze' as const, gaze: [-1, 0] as const },
    { id: 'ahead', kind: 'gaze' as const, gaze: [0, 0] as const },
    { id: 'right', kind: 'gaze' as const, gaze: [1, 0] as const },
    { id: 'laugh', kind: 'reaction' as const },
    { id: 'blink', kind: 'reaction' as const }
  ]
  return {
    packId: 'bundled:buddy',
    name: 'Pebble',
    neutral: 'ahead',
    pivot: [0.5, 0.9],
    frames,
    cells: new Map(frames.map((frame) => [frame.id, cell()])),
    reactions: ['laugh', 'blink'],
    gazeCount: 3,
    headTop: 0.2,
    notes: []
  }
}

// rAF under test control: queued callbacks run only on `flush()`.
let frames: Map<number, FrameRequestCallback>
let nextFrame: number
const cancelled: number[] = []
// IntersectionObserver under test control.
let observerCallback: IntersectionObserverCallback | null = null
const transforms: number[][] = []

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  frames = new Map()
  nextFrame = 1
  cancelled.length = 0
  transforms.length = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextFrame++
    frames.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    cancelled.push(id)
    frames.delete(id)
  })
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: IntersectionObserverCallback) {
        observerCallback = callback
      }
      observe(): void {}
      disconnect(): void {
        observerCallback = null
      }
    }
  )
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () =>
      ({
        setTransform: () => undefined,
        clearRect: () => undefined,
        translate: () => undefined,
        transform: (...args: number[]) => transforms.push(args),
        drawImage: () => undefined,
        imageSmoothingEnabled: true,
        imageSmoothingQuality: 'high'
      }) as unknown as CanvasRenderingContext2D
  )
  mocked.load.mockReset()
  mocked.load.mockImplementation(async () => fakePack())
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

async function flush(): Promise<void> {
  await act(async () => {
    const pending = [...frames]
    frames.clear()
    for (const [, callback] of pending) callback(performance.now())
  })
}

function preview(): HTMLElement {
  return container.querySelector('[data-testid="buddy-pet-preview"]') as HTMLElement
}

async function render(props: Partial<Parameters<typeof BuddyPetPreview>[0]> = {}): Promise<void> {
  await act(async () =>
    root.render(
      createElement(BuddyPetPreview, {
        personaId: 'p-1',
        packId: 'bundled:buddy',
        size: 160,
        ...props
      })
    )
  )
}

describe('BuddyPetPreview (plan 168 S-D1)', () => {
  it('loads the pack through the loader at the drawn pixel size and draws its neutral cell', async () => {
    const onLoad = vi.fn()
    await render({ onLoad })
    expect(mocked.load).toHaveBeenCalledWith(
      expect.objectContaining({ personaId: 'p-1', packId: 'bundled:buddy', pixelSize: 160 })
    )
    expect(onLoad).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Pebble',
        reactions: ['laugh', 'blink'],
        frameCount: 5,
        neutral: 'ahead',
        gazes: [
          { id: 'left', gaze: [-1, 0] },
          { id: 'ahead', gaze: [0, 0] },
          { id: 'right', gaze: [1, 0] }
        ],
        headTop: 0.2
      })
    )
    expect(preview().dataset.status).toBe('ready')
    await flush()
    expect(preview().dataset.frame).toBe('ahead')
  })

  it('stops its frame loop on unmount and asks for no frame after it', async () => {
    await render()
    await flush()
    expect(frames.size + vi.getTimerCount()).toBeGreaterThan(0)
    const pending = [...frames.keys()]
    await act(async () => root.unmount())
    for (const id of pending) expect(cancelled).toContain(id)
    expect(frames.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    await act(async () => vi.advanceTimersByTime(1000))
    expect(frames.size).toBe(0)
    root = createRoot(container)
  })

  it('stops while offscreen and starts again when it scrolls back', async () => {
    await render()
    await flush()
    await act(async () =>
      observerCallback?.(
        [{ isIntersecting: false } as IntersectionObserverEntry],
        {} as IntersectionObserver
      )
    )
    expect(frames.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    await act(async () =>
      observerCallback?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver
      )
    )
    expect(frames.size).toBe(1)
  })

  it('follows the pointer anywhere in the window and reacts to a click', async () => {
    await render()
    await flush()
    await act(async () =>
      window.dispatchEvent(
        new PointerEvent('pointermove', { clientX: 400, clientY: 0, pointerType: 'mouse' })
      )
    )
    await flush()
    expect(preview().dataset.frame).toBe('right')
    await act(async () => container.querySelector('button')!.click())
    await flush()
    expect(preview().dataset.frame).toBe('laugh')
  })

  it('honours reduced motion: no tracking, no transform, drawn reactions still on click', async () => {
    await render({ reducedMotion: true })
    await flush()
    await act(async () =>
      window.dispatchEvent(
        new PointerEvent('pointermove', { clientX: 400, clientY: 0, pointerType: 'mouse' })
      )
    )
    await flush()
    expect(preview().dataset.frame).toBe('ahead')
    await act(async () => container.querySelector('button')!.click())
    await flush()
    expect(preview().dataset.frame).toBe('laugh')
    expect(transforms.length).toBeGreaterThan(0)
    for (const matrix of transforms) expect(matrix).toEqual([1, 0, 0, 1, 0, 0])
  })

  it('plays a reaction from its handle, and hops for one the pack lacks', async () => {
    const ref = createRef<BuddyPetPreviewHandle>()
    await render({ ref })
    await flush()
    let played = false
    await act(async () => {
      played = ref.current!.react('wave')
    })
    expect(played).toBe(true)
    await flush()
    expect(preview().dataset.frame).toBe('ahead')
    await act(async () => {
      played = ref.current!.react('laugh')
    })
    expect(played).toBe(true)
    await flush()
    expect(preview().dataset.frame).toBe('laugh')

    await render({ ref, reducedMotion: true })
    await act(async () => {
      played = ref.current!.react('wave')
    })
    expect(played).toBe(false)
  })

  it('holds a pose, plays a reaction over it and returns to it (plan 169 D14)', async () => {
    const ref = createRef<BuddyPetPreviewHandle>()
    await render({ ref, pose: 'right', interactive: false })
    await flush()
    expect(preview().dataset.frame).toBe('right')
    await act(async () => {
      ref.current!.react('laugh')
    })
    await flush()
    expect(preview().dataset.frame).toBe('laugh')
    await render({ ref, pose: null, interactive: false })
    await flush()
    expect(preview().dataset.frame).toBe('ahead')
  })

  it('cycles talk frames while talking and stops when told (D12)', async () => {
    mocked.load.mockImplementation(async () => {
      const pack = fakePack()
      const frames = [
        ...pack.frames,
        { id: 'talk-a', kind: 'reaction' as const },
        { id: 'talk-b', kind: 'reaction' as const }
      ]
      return { ...pack, frames, cells: new Map(frames.map((frame) => [frame.id, cell()])) }
    })
    await render({ talking: true, interactive: false })
    await flush()
    expect(preview().dataset.frame).toBe('talk-a')
    // Talking runs the loop every frame, not on the idle tick.
    expect(frames.size).toBe(1)
    await render({ talking: false, interactive: false })
    await flush()
    expect(preview().dataset.frame).toBe('ahead')
  })

  it('keeps the placeholder and names the reason when the pack cannot load', async () => {
    mocked.load.mockImplementation(async () => {
      throw new Error('This pack is missing pet.webp. Import it again.')
    })
    const onError = vi.fn()
    await render({ onError, placeholder: createElement('img', { alt: 'Golem' }) })
    expect(onError).toHaveBeenCalledWith('This pack is missing pet.webp. Import it again.')
    expect(preview().dataset.status).toBe('error')
    expect(preview().getAttribute('title')).toBe('This pack is missing pet.webp. Import it again.')
    expect(preview().querySelector('img')).toBeTruthy()
    expect(frames.size).toBe(0)
  })
})
