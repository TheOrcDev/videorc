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

/**
 * The words a button shows. Record lays out every state's words in one cell
 * to keep its width and shows only the current state's; other buttons show
 * all of theirs.
 */
const shown = (button: Element | null | undefined): Element | null | undefined =>
  button?.querySelector(':scope > span > span:not([aria-hidden])') ?? button

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
    const stream = buttons.find((button) => button.textContent?.includes('Go Live…'))
    expect(record?.disabled).toBe(true)
    expect(record?.getAttribute('title')).toBeNull()
    const wrapper = record?.closest<HTMLElement>('[data-slot="disabled-reason"]')
    expect(wrapper?.tabIndex).toBe(0)
    expect(
      document.getElementById(wrapper?.getAttribute('aria-describedby') ?? '')?.textContent
    ).toBe('Pick a screen or a camera first.')
    // Nothing blocks Go Live: no wrapper, no extra tab stop.
    expect(stream?.disabled).toBe(false)
    expect(stream?.closest('[data-slot="disabled-reason"]')).toBeNull()
  })
})

// Plan 174 S2.2 (D3): one verb pair. Record shows its Space key; Go Live…
// opens the Go Live dialog; each button runs its own start.
describe('SessionTransport start labels (plan 174 S2.2)', () => {
  it('reads Record with its Space key and Go Live…, never Stream', () => {
    const onRecord = vi.fn()
    const onLiveStream = vi.fn()
    act(() =>
      root.render(
        createElement(SessionTransport, {
          active: false,
          canStop: false,
          stopLabel: 'Stop recording',
          startRequestPending: false,
          recordBlockedReason: null,
          liveStreamBlockedReason: null,
          status: null,
          onRecord,
          onLiveStream,
          onStop: noop
        })
      )
    )
    const buttons = [...container.querySelectorAll('button')]
    expect(buttons).toHaveLength(2)
    const key = shown(buttons[0])?.querySelector('[data-slot=kbd]')
    expect(key?.getAttribute('data-accelerator')).toBe('Space')
    expect(
      shown(buttons[0])
        ?.textContent?.replace(key?.textContent ?? '', '')
        .trim()
    ).toBe('Record')
    expect(buttons[1]?.textContent?.trim()).toBe('Go Live…')
    expect(container.textContent).not.toMatch(/\bStream\b/)

    act(() => buttons[0]?.click())
    act(() => buttons[1]?.click())
    expect(onRecord).toHaveBeenCalledOnce()
    expect(onLiveStream).toHaveBeenCalledOnce()
  })
})

// Plan 208 S4 (D8): Record and the stop button are metallic red, unlit at
// idle and lit while the session runs; Go Live… is the chrome primary.
describe('SessionTransport materials (plan 208 D8)', () => {
  const button = (label: string): HTMLButtonElement | undefined =>
    [...container.querySelectorAll('button')].find((candidate) =>
      shown(candidate)?.textContent?.includes(label)
    )

  it('draws Record unlit and Go Live… as the chrome primary', () => {
    renderTransport({ state: 'idle' }, { active: false })
    expect(button('Record')?.dataset.variant).toBe('record')
    expect(button('Record')?.hasAttribute('data-lit')).toBe(false)
    expect(button('Go Live…')?.dataset.variant).toBe('default')
  })

  it('lights the stop button while a recording or livestream runs', () => {
    renderTransport({ state: 'recording', sessionId: 's', startedAt: STARTED_AT })
    expect(button('Stop recording')?.dataset.variant).toBe('record')
    expect(button('Stop recording')?.hasAttribute('data-lit')).toBe(true)
    renderTransport({ state: 'streaming', sessionId: 's', streamUrl: STREAM_URL })
    expect(button('End livestream')?.dataset.variant).toBe('record')
    expect(button('End livestream')?.hasAttribute('data-lit')).toBe(true)
  })
})

// Plan 005 in videorc-ui: Record and the stop button are one RecordButton. It
// answers from the click, lit and focusable but taking no click while the
// start or the stop is in flight, and stays mounted from Record to Stop.
describe('SessionTransport record button (videorc-ui plan 005)', () => {
  const renderBare = (props: Partial<Parameters<typeof SessionTransport>[0]>): void => {
    const recording: RecordingStatus = { state: 'recording', sessionId: 's', startedAt: STARTED_AT }
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
            active: false,
            canStop: false,
            stopLabel: 'Stop recording',
            startRequestPending: false,
            recordBlockedReason: null,
            liveStreamBlockedReason: null,
            status: null,
            onRecord: noop,
            onLiveStream: noop,
            onStop: noop,
            ...props
          })
        )
      )
    )
  }
  const record = (): HTMLButtonElement | null =>
    container.querySelector<HTMLButtonElement>('button[data-variant=record]')

  it('keeps one button, and its focus, from the click to the stop', () => {
    renderBare({})
    const button = record()
    button?.focus()
    expect(button?.dataset.state).toBe('idle')

    // The click: lit at once, no second click, nothing dims, focus stays.
    renderBare({ startRequestPending: true })
    expect(record()).toBe(button)
    expect(button?.dataset.state).toBe('starting')
    expect(button?.hasAttribute('data-lit')).toBe(true)
    expect(button?.getAttribute('aria-disabled')).toBe('true')
    expect(button?.disabled).toBe(false)
    expect(document.activeElement).toBe(button)

    // The session runs: the same button stops it, in the stop's words.
    renderBare({ active: true, canStop: true })
    expect(record()).toBe(button)
    expect(button?.dataset.state).toBe('running')
    expect(shown(button)?.textContent).toBe('Stop recording')
    expect(button?.getAttribute('aria-disabled')).toBeNull()
    expect(container.querySelectorAll('button')).toHaveLength(1)

    // The stop is in flight: still lit and focused, taking no click.
    renderBare({ active: true, canStop: false, stopLabel: 'Stopping…', stopRequestPending: true })
    expect(record()).toBe(button)
    expect(button?.dataset.state).toBe('stopping')
    expect(shown(button)?.textContent).toBe('Stopping…')
    expect(button?.getAttribute('aria-disabled')).toBe('true')
    expect(document.activeElement).toBe(button)
  })

  it('keeps Record off while a Go Live… start is in flight', () => {
    renderBare({ startRequestPending: true, startingLivestream: true })
    expect(record()?.disabled).toBe(true)
    expect(record()?.hasAttribute('data-lit')).toBe(false)
    expect(record()?.dataset.state).toBe('idle')
  })

  it('lays out every state words, so the button never changes width', () => {
    renderBare({ stopLabel: 'End livestream' })
    const layers = [...(record()?.querySelectorAll(':scope > span > span') ?? [])]
    expect(layers.map((layer) => layer.textContent)).toEqual([
      'RecordSpace',
      'RecordSpace',
      'End livestream',
      'Stopping…'
    ])
    expect(layers.filter((layer) => layer.getAttribute('aria-hidden') === 'true')).toHaveLength(3)
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

// Plan 174 S3.1: Go Live reads "Checking…" from the first click (B-7), and a
// stop that overran its finalize window explains Force stop (B-16).
describe('SessionTransport in flight (plan 174 S3.1)', () => {
  it('reads Checking… while the Go Live preflight runs and holds both starts', () => {
    act(() =>
      root.render(
        createElement(SessionTransport, {
          active: false,
          canStop: false,
          stopLabel: 'Stop recording',
          startRequestPending: false,
          goLivePending: true,
          recordBlockedReason: null,
          liveStreamBlockedReason: null,
          status: null,
          onRecord: noop,
          onLiveStream: noop,
          onStop: noop
        })
      )
    )
    const buttons = [...container.querySelectorAll('button')]
    expect(buttons.map((button) => button.disabled)).toEqual([true, true])
    expect(buttons[1]?.textContent?.trim()).toBe('Checking…')
    expect(container.querySelector('[data-slot="disabled-reason"]')).toBeNull()
  })

  it('explains Force stop once the stop overran, as a polite warning', () => {
    const stopping = { state: 'stopping', sessionId: 's', startedAt: STARTED_AT } as const
    act(() =>
      root.render(
        createElement(
          StudioContextProviders,
          {
            core: unused,
            recordingState: { recording: stopping },
            recording: { recording: stopping },
            preview: unused,
            diagnostics: unused,
            chat: unused,
            audio: unused
          },
          createElement(SessionTransport, {
            active: true,
            canStop: true,
            stopLabel: 'Force stop',
            stopOverrun: true,
            startRequestPending: false,
            recordBlockedReason: null,
            liveStreamBlockedReason: null,
            status: null,
            onRecord: noop,
            onLiveStream: noop,
            onStop: noop
          })
        )
      )
    )
    const alert = container.querySelector('[data-testid="session-stop-overrun"]')
    expect(alert?.getAttribute('role')).toBe('status')
    expect(alert?.getAttribute('data-variant')).toBe('warning')
    expect(alert?.textContent).toContain('Stopping is taking longer than expected')
    expect(alert?.textContent).toContain('Force stop ends it now; the last seconds may be lost.')
    expect(text('button')).toContain('Force stop')
  })
})

// Plan 174 S3.2 (B-9): one inline line under the transport says why whichever
// button is off is off. Without the shell's navigation the line stands alone.
describe('SessionTransport reason line (plan 174 S3.2)', () => {
  it('shows the one reason under the buttons while idle, and never while a session runs', () => {
    const recording = { state: 'recording', sessionId: 's', startedAt: STARTED_AT } as const
    const render = (active: boolean): void =>
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
              canStop: active,
              stopLabel: 'Stop recording',
              startRequestPending: false,
              recordBlockedReason: null,
              liveStreamBlockedReason:
                'Enable at least one livestream destination before streaming.',
              blockedReason: 'Enable at least one livestream destination before streaming.',
              blockedJump: { label: 'Open Livestream', to: 'live' },
              status: null,
              onRecord: noop,
              onLiveStream: noop,
              onStop: noop
            })
          )
        )
      )
    render(false)
    const line = container.querySelector('[data-slot="session-blocked-reason"]')
    expect(line?.textContent).toContain(
      'Enable at least one livestream destination before streaming.'
    )
    // No navigation provider here: the jump button is left out, not broken.
    expect(line?.querySelector('button')).toBeNull()
    render(true)
    expect(container.querySelector('[data-slot="session-blocked-reason"]')).toBeNull()
  })
})
