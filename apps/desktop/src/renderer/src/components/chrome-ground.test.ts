// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CHROME_GROUND_ASSETS, ChromeGround } from './chrome-ground'

// Plan 208 S2: the chrome ground is decoration under every window, sized to
// the display, swapped by the theme class, and never filtered or animated.

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

function image(theme: 'dark' | 'light'): HTMLImageElement {
  const element = document.querySelector<HTMLImageElement>(
    `img[data-chrome-ground-image="${theme}"]`
  )
  if (!element) throw new Error(`no ${theme} ground image`)
  return element
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
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

  it('sizes the still to the display and re-reads it on resize, never to the window (D11)', async () => {
    document.documentElement.dataset.ground = 'chrome'
    await render()
    expect(image('dark').style.width).toBe('1728px')
    expect(image('dark').style.height).toBe('1117px')
    expect(image('light').style.width).toBe('1728px')
    // A resize alone changes nothing: the window's size is not the still's.
    setViewport(1400, 900)
    await act(async () => window.dispatchEvent(new Event('resize')))
    expect(image('dark').style.width).toBe('1728px')
    // A new display is read on the next resize.
    setDisplay(2560, 1440)
    await act(async () => window.dispatchEvent(new Event('resize')))
    expect(image('dark').style.width).toBe('2560px')
    expect(image('dark').style.height).toBe('1440px')
  })

  it('never lets the still be smaller than the viewport: a window can outgrow its screen', async () => {
    document.documentElement.dataset.ground = 'chrome'
    setDisplay(1440, 900)
    setViewport(2000, 1200)
    await render()
    expect(image('dark').style.width).toBe('2000px')
    expect(image('dark').style.height).toBe('1200px')
  })

  it('has no CSS filter, transition, animation or backdrop-filter (plan 208 D5)', () => {
    const source = readFileSync(join(__dirname, 'chrome-ground.tsx'), 'utf8')
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toMatch(/\bfilter\b|\btransition|\banimat|\bbackdrop|\bblur/)
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
