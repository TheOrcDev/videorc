// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

import {
  WINDOW_TOAST_POLICY,
  WindowProviders,
  windowToasterOffset,
  type VideorcWindow
} from './window-providers'

// Plan 174 S1.1 (J1-6, J1-17): every window entry mounts the same providers,
// so a Tooltip works in all four windows and toasts clear each status bar.

const WINDOWS: readonly VideorcWindow[] = ['main', 'stream-manager', 'captions', 'notes']

/** Each window's entry module, and the `window` it passes (relative to this file). */
const ENTRIES: Record<VideorcWindow, string> = {
  main: '../App.tsx',
  'stream-manager': '../../comments/main.tsx',
  captions: '../../captions/main.tsx',
  notes: '../../notes/main.tsx'
}

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('windowToasterOffset', () => {
  it('lifts toasts 12 px above each status bar, or 16 px from the corner without one', () => {
    expect(windowToasterOffset('main')).toEqual({ bottom: 38, right: 16 })
    expect(windowToasterOffset('stream-manager')).toEqual({ bottom: 44, right: 16 })
    expect(windowToasterOffset('captions')).toEqual({ bottom: 16, right: 16 })
    expect(windowToasterOffset('notes')).toEqual({ bottom: 16, right: 16 })
  })

  it('keeps one toast policy for every window', () => {
    expect(WINDOW_TOAST_POLICY).toEqual({ visibleToasts: 3, closeButton: true })
  })
})

describe('WindowProviders', () => {
  it.each(WINDOWS)('mounts a Tooltip and the toast host in the %s window', async (window) => {
    await act(async () =>
      root.render(
        createElement(WindowProviders, {
          window,
          children: createElement(
            Tooltip,
            { defaultOpen: true },
            createElement(TooltipTrigger, null, 'Keep on top'),
            createElement(TooltipContent, null, 'Pin this window')
          )
        })
      )
    )
    expect(document.querySelector('[data-slot="tooltip-content"]')?.textContent).toContain(
      'Pin this window'
    )
    expect(document.querySelector('section[aria-label^="Notifications"]')).not.toBeNull()
  })
})

describe('Tooltip outside a window provider', () => {
  it('still mounts (its own provider), so a stray root never throws', async () => {
    await act(async () =>
      root.render(
        createElement(
          Tooltip,
          { defaultOpen: true },
          createElement(TooltipTrigger, null, 'Keep on top'),
          createElement(TooltipContent, null, 'Pin this window')
        )
      )
    )
    expect(document.querySelector('[data-slot="tooltip-content"]')?.textContent).toContain(
      'Pin this window'
    )
  })
})

describe('window entries', () => {
  it.each(WINDOWS)('the %s entry wraps its tree in its own WindowProviders', (window) => {
    const source = readFileSync(new URL(ENTRIES[window], import.meta.url), 'utf8')
    expect(source).toContain(`<WindowProviders window="${window}">`)
    // One host per window: no entry mounts its own provider or toaster.
    expect(source).not.toMatch(/<Toaster\b/)
    expect(source).not.toMatch(/<TooltipProvider\b/)
  })
})
