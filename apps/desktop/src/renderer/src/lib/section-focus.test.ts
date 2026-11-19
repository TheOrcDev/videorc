// @vitest-environment happy-dom
import { act, createElement, StrictMode, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/hooks/use-reduced-motion', () => ({ smoothScrollBehavior: () => 'auto' }))

import { useSectionFocus } from '@/hooks/use-section-focus'
import {
  requestSectionFocus,
  SECTION_FOCUS_TTL_MS,
  takeSectionFocus,
  type SectionFocusId
} from '@/lib/section-focus'

function Section({ id }: { id: SectionFocusId }): ReactElement {
  useSectionFocus(id)
  return createElement(
    'section',
    { 'data-section-focus': id },
    createElement('h2', null, 'Clips'),
    createElement('button', { type: 'button', 'data-first': '' }, 'First control'),
    createElement('button', { type: 'button' }, 'Second control')
  )
}

/** A section that draws nothing until it knows its state (Videorc Camera). */
function LateSection({ id, shown }: { id: SectionFocusId; shown: boolean }): ReactElement | null {
  useSectionFocus(id, shown)
  if (!shown) return null
  return createElement(
    'section',
    { 'data-section-focus': id },
    createElement('button', { type: 'button', 'data-first': '' }, 'First control')
  )
}

describe('section focus (plan 250 S4)', () => {
  let root: Root
  let container: HTMLDivElement
  const scrolled = vi.fn()

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    // A real frame: later, and cancellable.
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(0), 0)
    )
    vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id))
    scrolled.mockClear()
    Element.prototype.scrollIntoView = scrolled
    // Nothing left over from another test.
    takeSectionFocus('output-clips')
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  it('a request is taken once, and goes stale if nobody takes it', () => {
    requestSectionFocus('output-clips', 1_000)
    expect(takeSectionFocus('output-recordings', 1_000)).toBe(false)
    expect(takeSectionFocus('output-clips', 1_500)).toBe(true)
    expect(takeSectionFocus('output-clips', 1_500)).toBe(false)
    requestSectionFocus('output-clips', 1_000)
    expect(takeSectionFocus('output-clips', 1_000 + SECTION_FOCUS_TTL_MS)).toBe(false)
  })

  it('a section that mounts takes the request: it scrolls into view and focuses its first control', async () => {
    requestSectionFocus('output-clips')
    await act(async () => root.render(createElement(Section, { id: 'output-clips' })))
    await act(async () => new Promise((resolve) => setTimeout(resolve, 5)))
    expect(scrolled).toHaveBeenCalledTimes(1)
    expect(scrolled).toHaveBeenCalledWith({ behavior: 'auto', block: 'start' })
    expect(document.activeElement).toBe(container.querySelector('[data-first]'))
  })

  // Seen by eye in the dev app: StrictMode ran the effect's cleanup at once,
  // and the one scroll that was asked for was cancelled.
  it('still scrolls once under StrictMode', async () => {
    requestSectionFocus('output-clips')
    await act(async () =>
      root.render(createElement(StrictMode, null, createElement(Section, { id: 'output-clips' })))
    )
    await act(async () => new Promise((resolve) => setTimeout(resolve, 5)))
    expect(scrolled).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(container.querySelector('[data-first]'))
  })

  it('a section that draws nothing yet keeps the request until it appears', async () => {
    requestSectionFocus('output-clips')
    await act(async () =>
      root.render(createElement(LateSection, { id: 'output-clips', shown: false }))
    )
    await act(async () => new Promise((resolve) => setTimeout(resolve, 5)))
    expect(scrolled).not.toHaveBeenCalled()
    await act(async () =>
      root.render(createElement(LateSection, { id: 'output-clips', shown: true }))
    )
    await act(async () => new Promise((resolve) => setTimeout(resolve, 5)))
    expect(scrolled).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(container.querySelector('[data-first]'))

    // And on a page already open while the section is hidden.
    await act(async () =>
      root.render(createElement(LateSection, { id: 'output-clips', shown: false }))
    )
    await act(async () => requestSectionFocus('output-clips'))
    await act(async () => new Promise((resolve) => setTimeout(resolve, 5)))
    expect(scrolled).toHaveBeenCalledTimes(1)
    await act(async () =>
      root.render(createElement(LateSection, { id: 'output-clips', shown: true }))
    )
    await act(async () => new Promise((resolve) => setTimeout(resolve, 5)))
    expect(scrolled).toHaveBeenCalledTimes(2)
  })

  it('a second mount does not scroll again', async () => {
    requestSectionFocus('output-clips')
    await act(async () => root.render(createElement(Section, { id: 'output-clips' })))
    await act(async () => new Promise((resolve) => setTimeout(resolve, 5)))
    expect(scrolled).toHaveBeenCalledTimes(1)
    await act(async () => root.render(null))
    await act(async () => root.render(createElement(Section, { id: 'output-clips' })))
    await act(async () => new Promise((resolve) => setTimeout(resolve, 5)))
    expect(scrolled).toHaveBeenCalledTimes(1)
  })

  it('a page that is already open answers the request, and only its own', async () => {
    await act(async () => root.render(createElement(Section, { id: 'output-clips' })))
    await act(async () => new Promise((resolve) => setTimeout(resolve, 5)))
    expect(scrolled).not.toHaveBeenCalled()
    await act(async () => requestSectionFocus('output-recordings'))
    await act(async () => new Promise((resolve) => setTimeout(resolve, 5)))
    expect(scrolled).not.toHaveBeenCalled()
    takeSectionFocus('output-recordings')
    await act(async () => requestSectionFocus('output-clips'))
    await act(async () => new Promise((resolve) => setTimeout(resolve, 5)))
    expect(scrolled).toHaveBeenCalledTimes(1)
  })
})
