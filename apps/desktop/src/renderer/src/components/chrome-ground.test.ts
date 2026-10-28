// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  CHROME_GROUND_ASSETS,
  CHROME_GROUND_DRIFT,
  ChromeGround,
  chromeGroundDriftAt
} from './chrome-ground'

// Plan 208 S2: the chrome ground is decoration under every window, sized to
// the display, swapped by the theme class, and never filtered. It drifts
// (owner, 2026-10-28) on a 20-a-second timer whenever the window is on
// screen, and holds still while minimised, during a take or under Reduce Motion.

let root: Root
let container: HTMLDivElement

function setDisplay(width: number, height: number): void {
  Object.defineProperty(window, 'screen', { value: { width, height }, configurable: true })
}

function setViewport(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true })
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true })
}

async function render(): Promise<void> {
  await act(async () => root.render(createElement(ChromeGround)))
}

function ground(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-chrome-ground]')
}

function drift(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[data-chrome-ground-drift]')
  if (!element) throw new Error('no drift layer')
  return element
}

let reducedMotion = false
const motionListeners = new Set<() => void>()
const windowVisibleListeners = new Set<(visible: boolean) => void>()
const takeRunningListeners = new Set<(running: boolean) => void>()

function stubWindowState(): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      get matches() {
        return query.includes('prefers-reduced-motion') && reducedMotion
      },
      media: query,
      addEventListener: (_: string, listener: () => void) => motionListeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => motionListeners.delete(listener)
    }))
  )
  // Main's signals, as the preload exposes them.
  Object.defineProperty(window, 'videorc', {
    configurable: true,
    value: {
      onWindowVisible: (callback: (visible: boolean) => void) => {
        windowVisibleListeners.add(callback)
        return () => windowVisibleListeners.delete(callback)
      },
      onTakeRunning: (callback: (running: boolean) => void) => {
        takeRunningListeners.add(callback)
        return () => takeRunningListeners.delete(callback)
      }
    }
  })
}

function image(theme: 'dark' | 'light'): HTMLImageElement {
  const element = document.querySelector<HTMLImageElement>(
    `img[data-chrome-ground-image="${theme}"]`
  )
  if (!element) throw new Error(`no ${theme} ground image`)
  return element
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  reducedMotion = false
  motionListeners.clear()
  windowVisibleListeners.clear()
  takeRunningListeners.clear()
  stubWindowState()
  setDisplay(1728, 1117)
  setViewport(1180, 780)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  delete document.documentElement.dataset.ground
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
  Reflect.deleteProperty(window, 'videorc')
})

describe('ChromeGround', () => {
  it('mounts nothing unless the root says data-ground="chrome" (the escape hatches)', async () => {
    await render()
    expect(ground()).toBeNull()
    for (const value of ['glass', 'solid', 'anything']) {
      document.documentElement.dataset.ground = value
      await render()
      expect(ground(), value).toBeNull()
    }
  })

  it('paints both themes’ stills under a coat, hidden from assistive tech and the pointer', async () => {
    document.documentElement.dataset.ground = 'chrome'
    await render()
    const element = ground()
    expect(element).not.toBeNull()
    expect(element?.getAttribute('aria-hidden')).toBe('true')
    for (const utility of ['fixed', 'inset-0', '-z-10', 'pointer-events-none', 'overflow-hidden']) {
      expect(element?.classList.contains(utility), utility).toBe(true)
    }
    const light = image('light')
    const dark = image('dark')
    expect(light.getAttribute('src')).toBe(CHROME_GROUND_ASSETS.light)
    expect(dark.getAttribute('src')).toBe(CHROME_GROUND_ASSETS.dark)
    expect(CHROME_GROUND_ASSETS.light).toMatch(/chrome-ground-light/)
    expect(CHROME_GROUND_ASSETS.dark).toMatch(/chrome-ground-dark/)
    for (const img of [light, dark]) {
      expect(img.getAttribute('alt')).toBe('')
      expect(img.getAttribute('decoding')).toBe('sync')
      expect(img.getAttribute('draggable')).toBe('false')
      expect(img.classList.contains('object-cover')).toBe(true)
      expect(img.classList.contains('max-w-none')).toBe(true)
    }
    // The theme class picks the still, so a toggle swaps it with the coats.
    expect(light.classList.contains('dark:hidden')).toBe(true)
    expect(dark.classList.contains('hidden')).toBe(true)
    expect(dark.classList.contains('dark:block')).toBe(true)
    // The window coat frosts the still from inside the ground layer.
    const coat = element?.querySelector('[data-chrome-ground-coat]')
    expect(coat?.classList.contains('bg-glass-window')).toBe(true)
    expect(coat?.classList.contains('inset-0')).toBe(true)
    // Last in the layer: over both images.
    expect(element?.lastElementChild).toBe(coat)
  })

  it('sizes the still to the display plus the drift margin, re-read on resize, never to the window (D11)', async () => {
    document.documentElement.dataset.ground = 'chrome'
    await render()
    // 128 px on every side for the drift to slide into.
    expect(image('dark').style.width).toBe('1984px')
    expect(image('dark').style.height).toBe('1373px')
    expect(image('light').style.width).toBe('1984px')
    // A resize alone changes nothing: the window's size is not the still's.
    setViewport(1400, 900)
    await act(async () => window.dispatchEvent(new Event('resize')))
    expect(image('dark').style.width).toBe('1984px')
    // A new display is read on the next resize.
    setDisplay(2560, 1440)
    await act(async () => window.dispatchEvent(new Event('resize')))
    expect(image('dark').style.width).toBe('2816px')
    expect(image('dark').style.height).toBe('1696px')
  })

  it('never lets the still be smaller than the viewport: a window can outgrow its screen', async () => {
    document.documentElement.dataset.ground = 'chrome'
    setDisplay(1440, 900)
    setViewport(2000, 1200)
    await render()
    expect(image('dark').style.width).toBe('2256px')
    expect(image('dark').style.height).toBe('1456px')
  })

  it('has no CSS filter, transition, keyframes, blur or backdrop, and no per-frame loop', () => {
    const source = readFileSync(join(__dirname, 'chrome-ground.tsx'), 'utf8')
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    // The drift moves one composited layer by its transform, nothing else.
    expect(code).not.toMatch(/\bfilter\b|\btransition|\banimat|\bkeyframes|\bbackdrop|blur\(/)
    expect(code).toMatch(/setInterval\(tick, CHROME_GROUND_DRIFT\.tickMs\)/)
  })

  it('drifts clearly but calmly and never shows an edge: the margin outruns the offset', () => {
    const { amplitudePx, marginPx, tickMs } = CHROME_GROUND_DRIFT
    // The drift layer is the window plus the margin on every side, and the
    // stills fill it, so an offset under the margin never uncovers the window.
    expect(marginPx).toBe(128)
    expect(marginPx).toBeGreaterThan(Math.max(amplitudePx.x, amplitudePx.y))
    let largestStepPx = 0
    let previous = chromeGroundDriftAt(0)
    for (let ms = tickMs; ms <= 10 * 60 * 1000; ms += tickMs) {
      const next = chromeGroundDriftAt(ms / 1000)
      expect(Math.abs(next.x)).toBeLessThanOrEqual(amplitudePx.x)
      expect(Math.abs(next.y)).toBeLessThanOrEqual(amplitudePx.y)
      largestStepPx = Math.max(largestStepPx, Math.hypot(next.x - previous.x, next.y - previous.y))
      previous = next
    }
    // Clear but calm: it covers its whole range, under 2 px per update.
    expect(largestStepPx).toBeLessThan(2)
    const reach = Array.from({ length: 6600 }, (_, s) => chromeGroundDriftAt(s / 20).x)
    expect(Math.max(...reach)).toBeGreaterThan(0.99 * amplitudePx.x)
  })

  it('moves whenever the window is on screen, holds still while minimised, during a take or under Reduce Motion, and resumes without a jump', async () => {
    vi.useFakeTimers()
    document.documentElement.dataset.ground = 'chrome'
    await render()
    const layer = drift()
    // Another app being focused does not matter: on screen is enough.
    expect(layer.dataset.chromeGroundDrift).toBe('moving')
    const start = layer.style.transform
    await act(async () => vi.advanceTimersByTime(2000))
    const moved = layer.style.transform
    expect(moved).not.toBe(start)
    // Its own compositor layer while moving.
    expect(moved).toMatch(/^translate3d\(-?\d+\.\d\dpx, -?\d+\.\d\dpx, 0\)$/)
    expect(layer.style.inset).toBe(`-${CHROME_GROUND_DRIFT.marginPx}px`)
    expect(layer.classList.contains('overflow-hidden')).toBe(true)

    const offset = (transform: string): number[] =>
      (transform.match(/-?\d+\.\d+/g) ?? []).slice(0, 2).map(Number)
    const holdsStill = async (pause: () => void, resume: () => void): Promise<void> => {
      const before = layer.style.transform
      await act(async () => pause())
      expect(layer.dataset.chromeGroundDrift).toBe('paused')
      // The same place, as a 2D translate: the layer is handed back.
      const paused = layer.style.transform
      expect(offset(paused)).toEqual(offset(before))
      expect(paused.startsWith('translate(')).toBe(true)
      await act(async () => vi.advanceTimersByTime(60_000))
      expect(layer.style.transform).toBe(paused)
      // Back: it picks up from where it stopped, not 60 s later.
      await act(async () => resume())
      expect(layer.dataset.chromeGroundDrift).toBe('moving')
      await act(async () => vi.advanceTimersByTime(CHROME_GROUND_DRIFT.tickMs))
      const [x0, y0] = offset(paused)
      const [x1, y1] = offset(layer.style.transform)
      expect(Math.hypot(x1 - x0, y1 - y0)).toBeLessThan(2)
    }

    // Minimised or hidden (main's window:visible, for the main window).
    await holdsStill(
      () => windowVisibleListeners.forEach((listener) => listener(false)),
      () => windowVisibleListeners.forEach((listener) => listener(true))
    )
    // A recording or livestream (main's session:take-running).
    await holdsStill(
      () => takeRunningListeners.forEach((listener) => listener(true)),
      () => takeRunningListeners.forEach((listener) => listener(false))
    )
    // Reduce Motion.
    await holdsStill(
      () => {
        reducedMotion = true
        motionListeners.forEach((listener) => listener())
      },
      () => {
        reducedMotion = false
        motionListeners.forEach((listener) => listener())
      }
    )
  })

  it('stops its timer and listeners when the ground unmounts', async () => {
    vi.useFakeTimers()
    document.documentElement.dataset.ground = 'chrome'
    await render()
    expect(vi.getTimerCount()).toBe(1)
    await act(async () => root.render(null))
    expect(vi.getTimerCount()).toBe(0)
    expect(motionListeners.size).toBe(0)
    expect(windowVisibleListeners.size).toBe(0)
    expect(takeRunningListeners.size).toBe(0)
  })

  it('hides under Reduce Transparency and while first-run setup is open, from the stylesheet', () => {
    const styles = readFileSync(join(__dirname, '../styles.css'), 'utf8')
    const reduced = styles.slice(styles.indexOf('@media (prefers-reduced-transparency: reduce)'))
    expect(reduced).toMatch(/\[data-chrome-ground\]\s*\{\s*display:\s*none;\s*\}/)
    expect(styles).toMatch(
      /html:has\(\[data-first-run-backdrop\],\s*\[data-first-run-surface\]\)\s*\[data-chrome-ground\]\s*\{\s*display:\s*none;\s*\}/
    )
  })
})
