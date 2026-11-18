// @vitest-environment happy-dom
import { act, createElement, type ReactElement } from 'react'
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

describe('section focus (plan 250 S4)', () => {
  let root: Root
  let container: HTMLDivElement
  const scrolled = vi.fn()

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', () => {})
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
    expect(scrolled).toHaveBeenCalledTimes(1)
    expect(scrolled).toHaveBeenCalledWith({ behavior: 'auto', block: 'start' })
    expect(document.activeElement).toBe(container.querySelector('[data-first]'))
  })

  it('a second mount does not scroll again', async () => {
    requestSectionFocus('output-clips')
    await act(async () => root.render(createElement(Section, { id: 'output-clips' })))
    await act(async () => root.render(null))
    await act(async () => root.render(createElement(Section, { id: 'output-clips' })))
    expect(scrolled).toHaveBeenCalledTimes(1)
  })

  it('a page that is already open answers the request, and only its own', async () => {
    await act(async () => root.render(createElement(Section, { id: 'output-clips' })))
    expect(scrolled).not.toHaveBeenCalled()
    await act(async () => requestSectionFocus('output-recordings'))
    expect(scrolled).not.toHaveBeenCalled()
    takeSectionFocus('output-recordings')
    await act(async () => requestSectionFocus('output-clips'))
    expect(scrolled).toHaveBeenCalledTimes(1)
  })
})
