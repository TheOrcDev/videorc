// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WorkspaceNavContext } from '@/components/workspace-nav'
import { StudioContextProviders } from '@/hooks/use-studio'
import type { RecordingStatus } from '@/lib/backend'
import { OPEN_DESTINATIONS_LABEL } from '@/lib/go-live-copy'
import { START_BLOCKED_COPY } from '@/lib/start-blocked-copy'
import { sessionStopControl } from '@/lib/studio-session-view'

import { SessionTransport } from './session-panel'

// Plan 095 S5: Go Live is record+stream, which the backend reports as
// `recording`; its stop says the recording stops too (plan 174 D19). Since
// plan 235 D1 the transport has no state row: the status bar and the
// sidebar's Studio row say the state and run the clock.

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
  {
    active = true,
    liveStreamBlockedReason = null
  }: { active?: boolean; liveStreamBlockedReason?: string | null } = {}
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
          liveStreamBlockedReason,
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

describe('SessionTransport (plan 095 S5, plan 235 D1)', () => {
  it('has no state row above the buttons: no badge, no Rec and no clock, idle or running', () => {
    for (const [recording, active] of [
      [{ state: 'idle' }, false],
      [{ state: 'recording', sessionId: 's', startedAt: STARTED_AT }, true],
      [{ state: 'recording', sessionId: 's', startedAt: STARTED_AT, streamUrl: STREAM_URL }, true]
    ] as const) {
      renderTransport(recording, { active })
      expect(container.querySelector('[data-videorc-session-status]')).toBeNull()
      expect(container.querySelector('[data-slot=status-badge]')).toBeNull()
      expect(container.querySelector('[data-testid=session-also-recording]')).toBeNull()
      expect(container.querySelector('[data-slot=session-clock]')).toBeNull()
      // The buttons lead the section.
      const transport = container.querySelector('[data-slot=session-transport]')
      expect(transport?.firstElementChild?.querySelector('button')).not.toBeNull()
    }
  })

  it('stops Go Live with End livestream and says the recording stops too', () => {
    renderTransport({
      state: 'recording',
      sessionId: 's',
      startedAt: STARTED_AT,
      streamUrl: STREAM_URL
    })
    const stop = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('End livestream')
    )
    // Plan 174 D19: the consequence is a visible line, never a title.
    expect(stop?.getAttribute('title')).toBeNull()
    expect(text('[data-slot=session-stop-note]')).toBe('Your recording stops too.')
  })

  it('keeps the stop note off a stream-only session and a recording', () => {
    renderTransport({
      state: 'streaming',
      sessionId: 's',
      startedAt: STARTED_AT,
      streamUrl: STREAM_URL
    })
    expect(container.querySelector('[data-slot=session-stop-note]')).toBeNull()

    renderTransport({ state: 'recording', sessionId: 's', startedAt: STARTED_AT })
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
          onRecord: noop,
          onLiveStream: noop,
          onStop: noop
        })
      )
    )
    const buttons = [...container.querySelectorAll('button')]
    const record = buttons.find((button) => button.textContent?.includes('Record'))
    const stream = buttons.find((button) => button.textContent?.includes('Go Live'))
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

// Plan 174 S2.2 (D3): one verb pair. Record shows its Space key; Go Live
// opens the Go Live dialog (no "…" on this button, plan 235 D2); each button
// runs its own start.
describe('SessionTransport start labels (plan 174 S2.2)', () => {
  it('reads Record with its Space key and Go Live, never Stream', () => {
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
    expect(shown(buttons[1])?.textContent?.trim()).toBe('Go Live')
    expect(container.textContent).not.toMatch(/\bStream\b/)

    act(() => buttons[0]?.click())
    act(() => buttons[1]?.click())
    expect(onRecord).toHaveBeenCalledOnce()
    expect(onLiveStream).toHaveBeenCalledOnce()
  })
})

// Plan 208 S4 (D8): Record and the stop button are metallic red, unlit at
// idle and lit while the session runs; Go Live is polished copper (plan 240).
describe('SessionTransport materials (plan 208 D8)', () => {
  const button = (label: string): HTMLButtonElement | undefined =>
    [...container.querySelectorAll('button')].find((candidate) =>
      shown(candidate)?.textContent?.includes(label)
    )

  it('draws Record unlit and Go Live in copper', () => {
    renderTransport({ state: 'idle' }, { active: false })
    expect(button('Record')?.dataset.variant).toBe('record')
    expect(button('Record')?.hasAttribute('data-lit')).toBe(false)
    expect(button('Go Live')?.dataset.variant).toBe('go-live')
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

// Record and Go Live both keep "End livestream" in their width, and side by
// side in flex the pair outgrew the 20rem inspector: Go Live ran past the
// right gutter (0.28.0). Each button gets one equal column it can't outgrow,
// with or without a DisabledReason wrapper around it.
describe('SessionTransport row', () => {
  const row = (): Element | null | undefined =>
    container.querySelector('[data-slot=session-transport]')?.firstElementChild
  const columns = (): string[] =>
    [...(row()?.children ?? [])]
      .filter((child) => !child.hasAttribute('hidden'))
      .map((child) => child.className)

  it('splits Record and Go Live into equal columns that never outgrow the row', () => {
    renderTransport({ state: 'idle' }, { active: false })
    expect(row()?.className).toContain('grid auto-cols-fr grid-flow-col')
    expect(columns()).toHaveLength(2)
    for (const column of columns()) expect(column.split(' ')).toContain('min-w-0')
  })

  it('keeps the split when Go Live is blocked and wrapped for its reason', () => {
    renderTransport(
      { state: 'idle' },
      { active: false, liveStreamBlockedReason: 'Add a destination.' }
    )
    const wrapper = row()?.querySelector('[data-slot=disabled-reason]')
    expect(wrapper?.className.split(' ')).toContain('min-w-0')
    expect(wrapper?.querySelector('button')?.className.split(' ')).toEqual(
      expect.arrayContaining(['min-w-0', 'flex-1'])
    )
  })

  it('gives Record the whole row while a session runs', () => {
    renderTransport({ state: 'recording', sessionId: 's', startedAt: STARTED_AT })
    expect(columns()).toHaveLength(1)
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

  it('keeps Record off while a Go Live start is in flight', () => {
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
          onRecord: noop,
          onLiveStream: noop,
          onStop: noop
        })
      )
    )
    const buttons = [...container.querySelectorAll('button')]
    // Record is off; Go Live holds its click but stays copper and keeps its
    // focus (aria-disabled, not dimmed), as Record does while it starts.
    expect(buttons[0]?.disabled).toBe(true)
    expect(buttons[1]?.disabled).toBe(false)
    expect(buttons[1]?.getAttribute('aria-disabled')).toBe('true')
    expect(buttons[1]?.dataset.state).toBe('checking')
    expect(shown(buttons[1])?.textContent?.trim()).toBe('Checking…')
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

  // Owner call, 2026-11-27: with no destination on, the row is one "Open
  // Destinations" button, and the reason is its hover and its description.
  const renderBlocked = (reason: string, setActive: (tab: string) => void): void =>
    act(() =>
      root.render(
        createElement(
          WorkspaceNavContext.Provider,
          { value: { setActive } as never },
          createElement(
            StudioContextProviders,
            {
              core: unused,
              recordingState: { recording: { state: 'idle' } },
              recording: { recording: { state: 'idle' } },
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
              liveStreamBlockedReason: reason,
              blockedReason: reason,
              blockedJump: { label: OPEN_DESTINATIONS_LABEL, to: 'live' },
              onRecord: noop,
              onLiveStream: noop,
              onStop: noop
            })
          )
        )
      )
    )

  it('is one Open Destinations button, described by the reason, with no destination on', () => {
    const setActive = vi.fn()
    renderBlocked(START_BLOCKED_COPY.noDestination, setActive)
    const row = container.querySelector('[data-slot="session-blocked-reason"]')
    const buttons = row?.querySelectorAll('button') ?? []
    expect(buttons).toHaveLength(1)
    const button = buttons[0]
    expect(button.textContent).toBe('Open Destinations')
    expect(button.dataset.variant).toBe('default')
    expect(button.dataset.size).toBe('lg')
    // The reason is not a line of the row: it is the button's description.
    expect(row?.querySelector('svg')).toBeNull()
    const description = document.getElementById(button.getAttribute('aria-describedby') ?? '')
    expect(description?.textContent).toBe(
      'Turn on a destination in Destinations before you go live.'
    )
    expect(description?.hidden).toBe(true)
    act(() => button.click())
    expect(setActive).toHaveBeenCalledExactlyOnceWith('live')
  })

  it('is the same button, with its own reason, for a destination still to finish', () => {
    const setActive = vi.fn()
    renderBlocked(START_BLOCKED_COPY.destinationSetup, setActive)
    const row = container.querySelector('[data-slot="session-blocked-reason"]')
    const buttons = row?.querySelectorAll('button') ?? []
    expect(buttons).toHaveLength(1)
    expect(buttons[0].textContent).toBe('Open Destinations')
    expect(row?.querySelector('svg')).toBeNull()
    const description = document.getElementById(buttons[0].getAttribute('aria-describedby') ?? '')
    expect(description?.textContent).toBe(START_BLOCKED_COPY.destinationSetup)
    act(() => buttons[0].click())
    expect(setActive).toHaveBeenCalledExactlyOnceWith('live')
  })

  it('keeps the reason line and its jump for every other reason', () => {
    const setActive = vi.fn()
    const reason = 'You can stream to up to 5 destinations at once.'
    renderBlocked(reason, setActive)
    const row = container.querySelector('[data-slot="session-blocked-reason"]')
    expect(row?.textContent).toContain(reason)
    const jump = row?.querySelector('button')
    expect(jump?.textContent).toBe('Open Destinations')
    expect(jump?.dataset.slot).toBeUndefined()
    act(() => jump?.click())
    expect(setActive).toHaveBeenCalledExactlyOnceWith('live')
  })
})

it.each([false, true])(
  'keeps both talk-show output controls available (recording=%s)',
  (recording) => {
    const onRecord = vi.fn()
    const onLiveStream = vi.fn()
    const onStopRecording = vi.fn()
    const onStop = vi.fn()
    act(() =>
      root.render(
        createElement(
          StudioContextProviders,
          {
            core: unused,
            recordingState: { recording: { state: 'streaming' } },
            recording: { recording: { state: 'streaming' } },
            preview: unused,
            diagnostics: unused,
            chat: unused,
            audio: unused
          },
          createElement(SessionTransport, {
            active: true,
            canStop: true,
            stopLabel: 'End livestream',
            startRequestPending: false,
            recordBlockedReason: null,
            liveStreamBlockedReason: null,
            onRecord,
            onLiveStream,
            onStop,
            talkShowOutputs: { recording, live: !recording, onStopRecording }
          })
        )
      )
    )
    const buttons = [...container.querySelectorAll('button')]
    const recordButton = buttons.find((button) =>
      button.textContent?.includes(recording ? 'Stop recording' : 'Record')
    )!
    const liveButton = buttons.find((button) =>
      button.textContent?.includes(recording ? 'Go Live' : 'End livestream')
    )!
    expect(recordButton.disabled).toBe(false)
    expect(liveButton.disabled).toBe(false)
    act(() => {
      recordButton.click()
      liveButton.click()
    })
    expect(recording ? onStopRecording : onRecord).toHaveBeenCalledOnce()
    expect(recording ? onLiveStream : onStop).toHaveBeenCalledOnce()
  }
)
