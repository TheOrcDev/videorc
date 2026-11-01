import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { BuddyLiveSwitch, CohostListeningIndicator, CohostStatus } from '@/components/cohost-status'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { CohostListening, CohostQuestion, CohostState } from '@/lib/backend'
import { offCohostState } from '@/lib/backend'

const NOW = Date.parse('2026-08-24T12:00:00.000Z')

function question(overrides: Partial<CohostQuestion> = {}): CohostQuestion {
  return {
    id: 'q-1',
    text: 'What keyboard is that?',
    messageIds: ['twitch:m-1'],
    askers: ['Ada'],
    platforms: ['twitch'],
    priority: 'normal',
    suggestedReply: 'Keychron Q1.',
    fromNotes: false,
    firstSeenAt: '2026-08-24T11:59:00.000Z',
    updatedAt: '2026-08-24T11:59:00.000Z',
    ...overrides
  }
}

function listening(overrides: Partial<CohostState> = {}): CohostState {
  return {
    ...offCohostState(),
    sessionId: 'sess-1',
    status: 'listening',
    lastTickAt: '2026-08-24T11:59:48.000Z',
    tickSeq: 4,
    messagesSeen: 84,
    questionsTotal: 5,
    ...overrides
  }
}

function renderStatus(props: Partial<Parameters<typeof CohostStatus>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(CohostStatus, {
      nowMs: NOW,
      state: listening(),
      ...props
    })
  )
}

describe('CohostStatus', () => {
  it('always renders, including for an off engine', () => {
    const markup = renderStatus({ state: offCohostState() })
    expect(markup).toContain('data-testid="cohost-status"')
    expect(markup).toContain('data-state-kind="off"')
    expect(markup).toContain('>Off<')
    expect(markup).toContain('data-tone="muted"')
    // Plan 174 S3.14a: no popover and no switch of its own; turning Buddy on
    // is the BuddyLiveSwitch beside it.
    expect(markup).not.toContain('cohost-status-enable')
    expect(markup).not.toContain('role="switch"')
  })

  it('renders the same element for a null state — presence is unconditional', () => {
    expect(renderStatus({ state: null })).toContain('>Off<')
  })

  it('is a button only when there is a pane to go to, else a status line', () => {
    expect(renderStatus({ onOpenPane: () => undefined })).toMatch(
      /<button[^>]*data-testid="cohost-status"/
    )
    expect(renderStatus()).toMatch(/<span[^>]*data-testid="cohost-status"[^>]*role="status"/)
  })

  it('earns the live dot only while listening', () => {
    const markup = renderStatus({ state: listening({ questions: [question()] }) })
    expect(markup).toContain('data-state-kind="listening"')
    expect(markup).toContain('data-tone="live"')
    expect(markup).toContain('tone-success')
    expect(markup).toContain('glass-dot')
    expect(markup).toContain('1 question')
    expect(markup).not.toContain('cohost-typing-dots')
  })

  it('shows the typing shimmer while reading queued chat', () => {
    const markup = renderStatus({ state: listening({ pendingMessages: 4 }) })
    expect(markup).toContain('Reading 4 new…')
    expect(markup).toContain('data-slot="cohost-typing-dots"')
    expect(markup).toContain('typing-dot')
    expect(markup).not.toContain('typing-dot-fast')
  })

  it('runs the shimmer faster and pulses the dot while a tick is in flight', () => {
    const markup = renderStatus({ state: listening({ tickInFlight: true, pendingMessages: 4 }) })
    expect(markup).toContain('Thinking…')
    expect(markup).toContain('typing-dot-fast')
    expect(markup).toContain('animate-pulse')
  })

  it('uses destructive red only for a real error', () => {
    const markup = renderStatus({
      state: listening({
        status: 'error',
        reason: 'gateway-error',
        detail: { code: 'ai-gateway-error', message: 'Every model failed.', status: 502 }
      })
    })
    expect(markup).toContain('data-state-kind="error"')
    expect(markup).toContain('data-tone="destructive"')
    expect(markup).toContain('Stopped: Videorc AI error')
    // The server's own words live in the tooltip, not in the label.
    expect(markup).toContain('ai-gateway-error (HTTP 502)')
  })

  it('names the pause reason without colour', () => {
    const markup = renderStatus({
      state: listening({ status: 'paused', reason: 'quota-exhausted' })
    })
    expect(markup).toContain('Paused: daily AI allowance used up')
    expect(markup).toContain('data-tone="muted"')
    expect(markup).not.toContain('tone-destructive')
  })

  it('flashes the grouped delta in place of the label', () => {
    const markup = renderStatus({
      flash: 'grouped 2 questions',
      state: listening({ questions: [question()] })
    })
    expect(markup).toContain('grouped 2 questions')
    expect(markup).not.toContain('>1 question<')
  })

  it('carries the collapsed-pane unread count', () => {
    const markup = renderStatus({ unread: 3 })
    expect(markup).toContain('3 new questions')
  })

  it('renders the tooltip as one fact per line', () => {
    const markup = renderStatus({
      state: listening({ pendingMessages: 2, nextTickAt: '2026-08-24T12:00:07.000Z' })
    })
    expect(markup).toContain('last pass 12s ago')
    expect(markup).toContain('84 messages read')
    expect(markup).toContain('next pass in ~7s')
  })

  it('shrinks to its dot in a narrow Chat header without losing the label', () => {
    const markup = renderStatus({
      state: listening({ status: 'paused', reason: 'quota-exhausted' })
    })
    // The trigger may shrink; the label truncates, then leaves the eye only.
    expect(markup).toContain('min-w-0')
    expect(markup).not.toMatch(/data-testid="cohost-status"[^>]*shrink-0/)
    expect(markup).toMatch(
      /class="[^"]*@max-\[330px\]\/chat-header:sr-only[^"]*"[^>]*data-slot="cohost-status-label"/
    )
    expect(markup).toContain('aria-label="Paused: daily AI allowance used up')
    // Hovering the lone dot still says what Buddy is doing: a tooltip, never
    // a native title (plan 174 S1.10).
    expect(markup).not.toContain('title=')
    expect(markup).toMatch(
      /<span(?=[^>]*data-testid="cohost-status")(?=[^>]*data-base-ui-tooltip-trigger)/
    )
  })

  it('keeps the trigger draggable-safe in the frameless window header', () => {
    expect(renderStatus()).toContain('[-webkit-app-region:no-drag]')
  })
})

describe('BuddyLiveSwitch (plan 174 S3.14a, D7)', () => {
  const render = (props: Partial<Parameters<typeof BuddyLiveSwitch>[0]> = {}): string =>
    renderToStaticMarkup(
      createElement(
        TooltipProvider,
        null,
        createElement(BuddyLiveSwitch, {
          checked: false,
          onCheckedChange: () => undefined,
          ...props
        })
      )
    )

  it('is one labelled switch named Buddy Live', () => {
    const markup = render({ checked: true })
    expect(markup).toContain('data-slot="buddy-live-switch"')
    expect(markup).toMatch(/<label[^>]*for="buddy-live-switch"[^>]*>Buddy Live<\/label>/)
    expect(markup).toMatch(/role="switch"[^>]*aria-checked="true"/)
    // Base UI puts the id on the switch's hidden input, which the label points at.
    expect(markup).toMatch(/<input[^>]*id="buddy-live-switch"[^>]*type="checkbox"/)
    expect(markup).not.toContain('disabled=""')
  })

  it('says why it cannot move while it cannot, and is otherwise undescribed', () => {
    const locked = render({ disabledReason: 'Buddy Live is part of Videorc Premium.' })
    expect(locked).toContain('disabled=""')
    expect(locked).toContain('data-slot="disabled-reason"')
    expect(locked).toContain('Buddy Live is part of Videorc Premium.')
    expect(render()).not.toContain('data-slot="disabled-reason"')
  })
})

describe('CohostListeningIndicator (plan 068)', () => {
  const render = (listening: CohostListening | undefined): string =>
    renderToStaticMarkup(createElement(CohostListeningIndicator, { listening }))

  it('shows nothing while listening is off', () => {
    expect(render(undefined)).toBe('')
    expect(render({ state: 'off' })).toBe('')
  })

  it('says Listening with a green microphone', () => {
    const markup = render({ state: 'on' })
    expect(markup).toContain('data-slot="cohost-listening"')
    expect(markup).toContain('data-listening-state="on"')
    expect(markup).toContain('>Listening<')
    expect(markup).toContain('text-success')
    expect(markup).not.toContain('title=')
    expect(markup).toContain('. Buddy hears your microphone as text.')
  })

  it('says Starting to listen without a tone', () => {
    const markup = render({ state: 'starting' })
    expect(markup).toContain('>Starting to listen<')
    expect(markup).not.toContain('text-success')
    expect(markup).not.toContain('text-warning')
  })

  it('names a block plainly and keeps the backend sentence on hover', () => {
    const markup = render({
      state: 'blocked',
      reasonCode: 'no-microphone',
      message: 'Select a microphone so Buddy can hear you.'
    })
    expect(markup).toContain('>Not listening: no microphone selected<')
    expect(markup).toContain('text-warning')
    expect(markup).not.toContain('title=')
    expect(markup).toContain('. Select a microphone so Buddy can hear you.')
  })

  it('keeps only the microphone in a tight header', () => {
    expect(render({ state: 'on' })).toMatch(
      /class="[^"]*@max-\[330px\]\/chat-header:sr-only[^"]*">Listening</
    )
  })

  it('adds the listening sentence to the status tooltip', () => {
    const markup = renderStatus({ state: listening({ listening: { state: 'on' } }) })
    expect(markup).toContain('Buddy hears your microphone as text.')
  })
})
