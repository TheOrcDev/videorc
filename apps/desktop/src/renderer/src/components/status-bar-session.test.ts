// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TooltipProvider } from '@/components/ui/tooltip'
import { WORKSPACE_NAVIGATE_EVENT } from '@/lib/workspace-navigation'

import { StatusBarSessionState } from './status-bar-session'

// Plan 174 S1.3 (A-4, I-6, D9): the status bar said the socket's enum
// ("connected", "closed"), pulsed red while starting, had no clock off Studio,
// and was not a way into Health.

const STARTED_AT = '2026-10-02T18:00:00.000Z'
const STREAM_URL = 'rtmp://live.twitch.tv/app/***'

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
  vi.setSystemTime(new Date(STARTED_AT))
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function renderState(
  recording: { state: string; streamUrl?: string; startedAt?: string },
  wsStatus = 'connected'
): void {
  act(() =>
    root.render(
      createElement(
        TooltipProvider,
        null,
        createElement(StatusBarSessionState, { recording, wsStatus })
      )
    )
  )
}

const button = (): HTMLButtonElement | null =>
  container.querySelector<HTMLButtonElement>('[data-slot=status-bar-state]')
const dot = (): HTMLElement | null => container.querySelector<HTMLElement>('[data-slot=status-dot]')

describe('StatusBarSessionState', () => {
  it('reads On air with the elapsed time, pulsing, in a polite live region', () => {
    renderState({ state: 'recording', streamUrl: STREAM_URL, startedAt: STARTED_AT })
    expect(button()?.textContent).toBe('On air0:00')
    expect(dot()?.dataset.tone).toBe('live')
    expect(dot()?.innerHTML).toContain('animate-ping')
    expect(container.querySelector('[role=status]')?.contains(button())).toBe(true)

    act(() => vi.advanceTimersByTime(12 * 60_000 + 4_000))
    expect(button()?.textContent).toBe('On air12:04')
    // The clock is hidden from the live region, or every tick is read out.
    expect(button()?.querySelector('[aria-hidden=true]')?.textContent).toBe('12:04')
  })

  it('reads a recording as Recording, pulsing, with its clock', () => {
    renderState({ state: 'recording', startedAt: STARTED_AT })
    expect(button()?.textContent).toBe('Recording0:00')
    expect(dot()?.innerHTML).toContain('animate-ping')
  })

  it('stays still and clockless while idle, starting or stopping', () => {
    for (const [state, label] of [
      ['idle', 'Ready'],
      ['starting', 'Starting…'],
      ['stopping', 'Stopping…']
    ] as const) {
      renderState({ state, startedAt: STARTED_AT })
      expect(button()?.textContent).toBe(label)
      expect(dot()?.innerHTML).not.toContain('animate-ping')
    }
  })

  it('says Videorc is reconnecting when the backend is gone, never the socket enum', () => {
    renderState({ state: 'idle' }, 'closed')
    expect(button()?.textContent).toBe('Videorc is reconnecting…')
    expect(dot()?.dataset.tone).toBe('warn')
    renderState({ state: 'idle' }, 'waiting')
    expect(button()?.textContent).toBe('Connecting…')
  })

  it('opens Health', () => {
    renderState({ state: 'idle' })
    const navigations: unknown[] = []
    const onNavigate = (event: Event): void => {
      navigations.push((event as CustomEvent<unknown>).detail)
    }
    window.addEventListener(WORKSPACE_NAVIGATE_EVENT, onNavigate)
    act(() => button()?.click())
    window.removeEventListener(WORKSPACE_NAVIGATE_EVENT, onNavigate)
    expect(navigations).toEqual([{ tab: 'diagnostics' }])
    expect(button()?.getAttribute('type')).toBe('button')
  })
})
