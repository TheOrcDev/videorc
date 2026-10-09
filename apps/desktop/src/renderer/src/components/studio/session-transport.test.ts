// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { StudioContextProviders } from '@/hooks/use-studio'
import type { RecordingStatus } from '@/lib/backend'
import { sessionStopControl } from '@/lib/studio-session-view'

import { SessionStatusPill, SessionTransport } from './session-panel'

// Plan 095 S5: Go Live is record+stream, which the backend reports as
// `recording`; the inspector must still say Streaming, and its clock must tick
// from startedAt (running statuses carry no durationMs).

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

function renderTransport(recording: RecordingStatus): void {
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
          active: true,
          canStop: true,
          stopLabel: stop.label,
          stopTitle: stop.title,
          startRequestPending: false,
          recordBlockedReason: null,
          liveStreamBlockedReason: null,
          status: createElement(SessionStatusPill, { recording, wsStatus: 'connected' }),
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

  it('reads Go Live as Streaming in the live tone, with a quiet Rec', () => {
    renderTransport({
      state: 'recording',
      sessionId: 's',
      startedAt: STARTED_AT,
      streamUrl: STREAM_URL
    })
    expect(text('[data-videorc-session-status]')).toBe('Streaming')
    expect(
      container.querySelector('[data-videorc-session-status] [data-slot=status-badge]')
    ).toHaveProperty('dataset.tone', 'live')
    const rec = container.querySelector('[data-testid=session-also-recording]')
    expect(rec?.textContent).toBe('Rec')
    expect(rec?.getAttribute('data-variant')).toBe('outline')

    const stop = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('End livestream')
    )
    expect(stop?.getAttribute('title')).toBe('Also stops the recording')
  })

  it('keeps stream-only free of Rec and a recording free of Streaming', () => {
    renderTransport({
      state: 'streaming',
      sessionId: 's',
      startedAt: STARTED_AT,
      streamUrl: STREAM_URL
    })
    expect(text('[data-videorc-session-status]')).toBe('Streaming')
    expect(container.querySelector('[data-testid=session-also-recording]')).toBeNull()
    expect(container.querySelector('button[title]')).toBeNull()

    renderTransport({ state: 'recording', sessionId: 's', startedAt: STARTED_AT })
    expect(text('[data-videorc-session-status]')).toBe('Recording')
    expect(container.querySelector('[data-testid=session-also-recording]')).toBeNull()
    expect(text('button')).toContain('Stop recording')
  })
})
