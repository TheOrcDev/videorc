import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { CohostStatus } from '@/components/cohost-status'
import type { CohostQuestion, CohostState } from '@/lib/backend'
import { offCohostState } from '@/lib/backend'
import type { EntitlementUiGate } from '@/lib/entitlement-ui'

const NOW = Date.parse('2026-08-24T12:00:00.000Z')
const ALLOWED: EntitlementUiGate = { allowed: true }

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
      consented: true,
      enabled: true,
      gate: ALLOWED,
      nowMs: NOW,
      state: listening(),
      ...props
    })
  )
}

describe('CohostStatus', () => {
  it('always renders, including for an off engine', () => {
    const markup = renderStatus({ state: offCohostState(), enabled: false })
    expect(markup).toContain('data-slot="cohost-status"')
    expect(markup).toContain('data-state-kind="off"')
    expect(markup).toContain('Co-host off')
    expect(markup).toContain('data-tone="muted"')
  })

  it('renders the same element for a null state — presence is unconditional', () => {
    expect(renderStatus({ state: null, enabled: false })).toContain('Co-host off')
  })

  it('earns the live dot only while listening', () => {
    const markup = renderStatus({ state: listening({ questions: [question()] }) })
    expect(markup).toContain('data-state-kind="listening"')
    expect(markup).toContain('data-tone="live"')
    expect(markup).toContain('bg-success')
    expect(markup).toContain('Co-host · 1 q')
    expect(markup).not.toContain('cohost-typing-dots')
  })

  it('shows the typing shimmer while reading queued chat', () => {
    const markup = renderStatus({ state: listening({ pendingMessages: 4 }) })
    expect(markup).toContain('Co-host · reading 4 new…')
    expect(markup).toContain('data-slot="cohost-typing-dots"')
    expect(markup).toContain('typing-dot')
    expect(markup).not.toContain('typing-dot-fast')
  })

  it('runs the shimmer faster and pulses the dot while a tick is in flight', () => {
    const markup = renderStatus({ state: listening({ tickInFlight: true, pendingMessages: 4 }) })
    expect(markup).toContain('Co-host · thinking…')
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
    expect(markup).toContain('Co-host error')
    // The server's own words live in the tooltip, not in the label.
    expect(markup).toContain('ai-gateway-error (HTTP 502)')
  })

  it('names the pause reason without colour', () => {
    const markup = renderStatus({
      state: listening({ status: 'paused', reason: 'quota-exhausted' })
    })
    expect(markup).toContain('Co-host paused · quota')
    expect(markup).toContain('data-tone="muted"')
    expect(markup).not.toContain('bg-destructive')
  })

  it('flashes the grouped delta in place of the label', () => {
    const markup = renderStatus({
      flash: 'grouped 2 questions',
      state: listening({ questions: [question()] })
    })
    expect(markup).toContain('grouped 2 questions')
    expect(markup).not.toContain('>Co-host · 1 q<')
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

  it('keeps the trigger draggable-safe in the frameless window header', () => {
    expect(renderStatus()).toContain('[-webkit-app-region:no-drag]')
  })
})
