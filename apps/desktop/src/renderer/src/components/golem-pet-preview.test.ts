// @vitest-environment happy-dom
import { act, createElement, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { GolemPreviewCell, GolemPreviewPack } from '@/lib/golem-pet-preview-pack'

import { GolemPetPreview, type GolemPetPreviewHandle } from './golem-pet-preview'

const mocked = vi.hoisted(() => ({ load: vi.fn() }))
vi.mock('@/lib/golem-pet-preview-pack', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/golem-pet-preview-pack')>()),
  loadGolemPreviewPack: mocked.load
}))

function cell(): GolemPreviewCell {
  return {
    image: { source: {} as CanvasImageSource, width: 64, height: 64, close: vi.fn() },
    rect: [0, 0, 64, 64],
    box: [0, 0, 1, 1]
  }
}

/** Three gaze cells on one row and two reactions. */
function fakePack(): GolemPreviewPack {
  const frames = [
    { id: 'left', kind: 'gaze' as const, gaze: [-1, 0] as const },
    { id: 'ahead', kind: 'gaze' as const, gaze: [0, 0] as const },
    { id: 'right', kind: 'gaze' as const, gaze: [1, 0] as const },
    { id: 'laugh', kind: 'reaction' as const },
    { id: 'blink', kind: 'reaction' as const }
  ]
  return {
    packId: 'bundled:golem',
    name: 'Pebble',
    neutral: 'ahead',
    pivot: [0.5, 0.9],
    frames,
    cells: new Map(frames.map((frame) => [frame.id, cell()])),
    reactions: ['laugh', 'blink'],
    gazeCount: 3,
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
  return container.querySelector('[data-testid="golem-pet-preview"]') as HTMLElement
}

async function render(props: Partial<Parameters<typeof GolemPetPreview>[0]> = {}): Promise<void> {
  await act(async () =>
    root.render(
      createElement(GolemPetPreview, {
        personaId: 'p-1',
        packId: 'bundled:golem',
        size: 160,
        ...props
      })
    )
  )
}

describe('GolemPetPreview (plan 168 S-D1)', () => {
  it('loads the pack through the loader at the drawn pixel size and draws its neutral cell', async () => {
    const onLoad = vi.fn()
    await render({ onLoad })
    expect(mocked.load).toHaveBeenCalledWith(
      expect.objectContaining({ personaId: 'p-1', packId: 'bundled:golem', pixelSize: 160 })
    )
    expect(onLoad).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Pebble', reactions: ['laugh', 'blink'], frameCount: 5 })
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
    const ref = createRef<GolemPetPreviewHandle>()
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
