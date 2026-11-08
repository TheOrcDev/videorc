// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { StudioContextProviders } from '@/hooks/use-studio'
import type { RecordingStatus } from '@/lib/backend'
import { sessionStopControl } from '@/lib/studio-session-view'

import { RetroSessionStatus, RetroSessionTransport } from './retro-lcd-studio'

// Plan 197: the Retro LCD transport keeps the inspector's words, hooks and
// handlers; only the drawing is a screen with keys.

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
  { active = true, blockedReason = null as string | null } = {}
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
        createElement(RetroSessionTransport, {
          active,
          blockedReason,
          canStop: true,
          stopLabel: stop.label,
          stopNote: stop.note,
          startRequestPending: false,
          recordBlockedReason: null,
          liveStreamBlockedReason: blockedReason,
          status: createElement(RetroSessionStatus, { recording, wsStatus: 'connected' }),
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
const screen = (): Element | null => container.querySelector('[data-slot=lcd-display]')

describe('Retro LCD transport (plan 197)', () => {
  it('reads Go Live as On air in the live tone, with a lit Rec and the clock, on the screen', () => {
    renderTransport({
      state: 'recording',
      sessionId: 's',
      startedAt: STARTED_AT,
      streamUrl: STREAM_URL
    })
    // The smokes read these words from this hook.
    expect(text('[data-videorc-session-status]')).toBe('On air')
    expect(container.querySelector('[data-videorc-session-status]')?.getAttribute('role')).toBe(
      'status'
    )
    expect(container.querySelector('[data-slot=session-status]')).toHaveProperty(
      'dataset.tone',
      'live'
    )
    expect(text('[data-testid=session-also-recording]')).toBe('Rec')
    expect(text('[data-slot=session-clock]')).toBe('0:00')
    for (const part of ['[data-videorc-session-status]', '[data-slot=session-clock]']) {
      expect(container.querySelector(part)?.closest('[data-slot=lcd-display]')).toBe(screen())
    }
    // Stop is a key on the screen, in the record red, with its note under it.
    const stop = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('End livestream')
    )
    expect(stop?.closest('[data-slot=lcd-display]')).toBe(screen())
    expect(stop?.className).toContain('border-(--live)')
    expect(text('[data-slot=session-stop-note]')).toBe('Your recording stops too.')
  })

  it('draws Record with its Space key and Go Live as keys, and says why Go Live is off', () => {
    renderTransport(
      { state: 'idle' },
      { active: false, blockedReason: 'Turn on a destination in Livestream before you go live.' }
    )
    expect(text('[data-videorc-session-status]')).toBe('Ready')
    const record = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.startsWith('Record')
    )
    expect(record?.className).toContain('border-(--live)')
    expect(record?.querySelector('[data-accelerator]')?.textContent).toBe('Space')
    const goLive = container.querySelector('[data-testid=go-live-button]')
    expect(goLive?.closest('[data-slot=lcd-display]')).toBe(screen())
    expect(goLive?.hasAttribute('disabled')).toBe(true)
    // The reason is a sentence on the screen, never a title.
    expect(text('[data-slot=session-blocked-reason]')).toBe(
      'Turn on a destination in Livestream before you go live.'
    )
    expect(
      container
        .querySelector('[data-slot=session-blocked-reason]')
        ?.closest('[data-slot=lcd-display]')
    ).toBe(screen())
    expect(goLive?.getAttribute('title')).toBeNull()
  })
})
