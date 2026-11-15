// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PREVIEW_STARTUP_STALL_MS, type PreviewStartupStep } from '../../../shared/preview-startup'
import { usePreviewStartupStalled } from './preview-startup-card'

let root: Root
let container: HTMLDivElement

function Clock({ step }: { step: PreviewStartupStep }) {
  return createElement('output', null, usePreviewStartupStalled(step) ? 'stalled' : 'starting')
}

function render(step: PreviewStartupStep): void {
  act(() => root.render(createElement(Clock, { step })))
}

function advance(ms: number): void {
  act(() => vi.advanceTimersByTime(ms))
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('the Preview startup stall clock', () => {
  it.each<PreviewStartupStep>([1, 2, 3])(
    'gives step %s a fresh budget when startup returns to it',
    (step) => {
      render(step)
      advance(PREVIEW_STARTUP_STALL_MS)
      expect(container.textContent).toBe('stalled')

      render(step === 1 ? 2 : 1)
      expect(container.textContent).toBe('starting')
      advance(1000)
      render(step)
      expect(container.textContent).toBe('starting')
      advance(PREVIEW_STARTUP_STALL_MS - 1)
      expect(container.textContent).toBe('starting')
      advance(1)
      expect(container.textContent).toBe('stalled')
    }
  )

  it('cancels the previous step deadline without restarting on ordinary renders', () => {
    render(1)
    advance(PREVIEW_STARTUP_STALL_MS - 1000)
    render(2)
    advance(1000)
    expect(container.textContent).toBe('starting')
    render(2)
    advance(PREVIEW_STARTUP_STALL_MS - 1000)
    expect(container.textContent).toBe('stalled')
  })

  it('cancels the clock when the startup card leaves the stage', () => {
    render(2)
    act(() => root.render(null))
    expect(vi.getTimerCount()).toBe(0)
    advance(PREVIEW_STARTUP_STALL_MS)
    render(2)
    expect(container.textContent).toBe('starting')
  })
})
