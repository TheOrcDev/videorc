// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { StudioContextProviders } from '@/hooks/use-studio'
import type { RecordingStatus } from '@/lib/backend'
import { sessionStopControl } from '@/lib/studio-session-view'

import { SessionStatusPill, SessionTransport } from './session-panel'

// Plan 095 S5: Go Live is record+stream, which the backend reports as
// `recording`; the inspector must still say On air (plan 174 D4), and its
// clock must tick from startedAt (running statuses carry no durationMs).

const STARTED_AT = '2026-10-02T18:00:00.000Z'
const STREAM_URL = 'rtmp://live.twitch.tv/app/***'
const noop = (): void => {}
const unused = Object.freeze({}) as never

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

function renderTransport(
  recording: RecordingStatus,
  { active = true, wsStatus = 'connected', startBlocked = false } = {}
): void {
  const stop = sessionStopControl(recording, false)
  act(() =>
    root.render(
      createElement(
        StudioContextProviders,
        {
          core: unused,
          recordingState: { recording },
          recording: { recording },
          preview: unused,
          diagnostics: unused,
          chat: unused,
          audio: unused
        },
        createElement(SessionTransport, {
          active,
          canStop: true,
          stopLabel: stop.label,
          stopNote: stop.note,
          startRequestPending: false,
          recordBlockedReason: null,
          liveStreamBlockedReason: null,
          status: createElement(SessionStatusPill, { recording, wsStatus, startBlocked }),
          onRecord: noop,
          onLiveStream: noop,
          onStop: noop
        })
      )
    )
  )
}

const text = (selector: string): string | null | undefined =>
  container.querySelector(selector)?.textContent?.trim()

describe('SessionTransport (plan 095 S5)', () => {
  it('ticks the session clock from startedAt', () => {
    renderTransport({ state: 'recording', sessionId: 's', startedAt: STARTED_AT })
    expect(text('[data-slot=session-clock]')).toBe('0:00')

    act(() => vi.advanceTimersByTime(61_000))
    expect(text('[data-slot=session-clock]')).toBe('1:01')

    act(() => vi.advanceTimersByTime(3_600_000))
    expect(text('[data-slot=session-clock]')).toBe('1:01:01')
  })

  it('reads Go Live as On air in the live tone, with a quiet Rec', () => {
    renderTransport({
      state: 'recording',
      sessionId: 's',
      startedAt: STARTED_AT,
      streamUrl: STREAM_URL
    })
    expect(text('[data-videorc-session-status]')).toBe('On air')
    expect(
      container.querySelector('[data-videorc-session-status] [data-slot=status-badge]')
    ).toHaveProperty('dataset.tone', 'live')
    expect(container.querySelector('[data-videorc-session-status]')?.getAttribute('role')).toBe(
      'status'
    )
    const rec = container.querySelector('[data-testid=session-also-recording]')
    expect(rec?.textContent).toBe('Rec')
    expect(rec?.getAttribute('data-variant')).toBe('outline')

    const stop = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('End livestream')
    )
    // Plan 174 D19: the consequence is a visible line, never a title.
    expect(stop?.getAttribute('title')).toBeNull()
    expect(text('[data-slot=session-stop-note]')).toBe('Your recording stops too.')
  })

  it('keeps stream-only free of Rec and a recording free of On air', () => {
    renderTransport({
      state: 'streaming',
      sessionId: 's',
      startedAt: STARTED_AT,
      streamUrl: STREAM_URL
    })
    expect(text('[data-videorc-session-status]')).toBe('On air')
    expect(container.querySelector('[data-testid=session-also-recording]')).toBeNull()
    expect(container.querySelector('[data-slot=session-stop-note]')).toBeNull()

    renderTransport({ state: 'recording', sessionId: 's', startedAt: STARTED_AT })
    expect(text('[data-videorc-session-status]')).toBe('Recording')
    expect(container.querySelector('[data-testid=session-also-recording]')).toBeNull()
    expect(container.querySelector('[data-slot=session-stop-note]')).toBeNull()
    expect(text('button')).toContain('Stop recording')
  })
})

describe('SessionTransport start reasons (plan 174 S1.1, B-9)', () => {
  it('says why Record is blocked on hover and focus, never in a title', () => {
    act(() =>
      root.render(
        createElement(SessionTransport, {
          active: false,
          canStop: false,
          stopLabel: 'Stop',
          startRequestPending: false,
          recordBlockedReason: 'Pick a screen or a camera first.',
          liveStreamBlockedReason: null,
          status: null,
          onRecord: noop,
          onLiveStream: noop,
          onStop: noop
        })
      )
    )
    const buttons = [...container.querySelectorAll('button')]
    const record = buttons.find((button) => button.textContent?.includes('Record'))
    const stream = buttons.find((button) => button.textContent?.includes('Stream'))
    expect(record?.disabled).toBe(true)
    expect(record?.getAttribute('title')).toBeNull()
    const wrapper = record?.closest<HTMLElement>('[data-slot="disabled-reason"]')
    expect(wrapper?.tabIndex).toBe(0)
    expect(
      document.getElementById(wrapper?.getAttribute('aria-describedby') ?? '')?.textContent
    ).toBe('Pick a screen or a camera first.')
    // Nothing blocks Stream: no wrapper, no extra tab stop.
    expect(stream?.disabled).toBe(false)
    expect(stream?.closest('[data-slot="disabled-reason"]')).toBeNull()
  })
})

// Plan 174 S1.3 (B-17): recording, on air and trouble no longer read as the
// same red chip, and a blocked start no longer reads a green Ready.
describe('SessionStatusPill (plan 174 S1.3)', () => {
  const badge = (): Element | null =>
    container.querySelector('[data-videorc-session-status] [data-slot=status-badge]')
  const iconCount = (): number => badge()?.querySelectorAll('svg').length ?? 0

  it('leads recording, on air and trouble with an icon, and idle with a dot', () => {
    renderTransport({ state: 'recording', sessionId: 's', startedAt: STARTED_AT })
    expect(iconCount()).toBe(1)
    renderTransport({ state: 'streaming', sessionId: 's', streamUrl: STREAM_URL })
    expect(iconCount()).toBe(1)
    renderTransport({ state: 'failed' }, { active: false })
    expect(text('[data-videorc-session-status]')).toBe('Failed')
    expect(badge()).toHaveProperty('dataset.tone', 'error')
    expect(iconCount()).toBe(1)
    renderTransport({ state: 'idle' }, { active: false })
    expect(text('[data-videorc-session-status]')).toBe('Ready')
    expect(iconCount()).toBe(0)
  })

  it('reads a blocked start as a neutral Not ready', () => {
    renderTransport({ state: 'idle' }, { active: false, startBlocked: true })
    expect(text('[data-videorc-session-status]')).toBe('Not ready')
    expect(badge()).toHaveProperty('dataset.tone', 'neutral')
  })

  it('says Videorc is reconnecting when the backend drops, not Backend offline', () => {
    renderTransport({ state: 'idle' }, { active: false, wsStatus: 'closed' })
    expect(text('[data-videorc-session-status]')).toBe('Videorc is reconnecting…')
    expect(badge()).toHaveProperty('dataset.tone', 'warn')
    expect(iconCount()).toBe(1)
  })
})
