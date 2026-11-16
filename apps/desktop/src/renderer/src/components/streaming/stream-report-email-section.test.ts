import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { StreamReportEmailState } from '@/lib/backend'

import {
  STREAM_HISTORY_DESCRIPTION,
  STREAM_REPORT_SIGNED_OUT_REASON,
  streamHistoryDescription,
  StreamReportEmailSectionView,
  streamReportSendLine,
  type StreamReportSendView
} from './stream-report-email-section'

const render = (
  state: StreamReportEmailState | null,
  send: StreamReportSendView = 'idle'
): string =>
  renderToStaticMarkup(
    createElement(StreamReportEmailSectionView, {
      state,
      send,
      onEnabledChange: () => undefined,
      onHistoryChange: () => undefined,
      onRetry: () => undefined,
      onSendLast: () => undefined
    })
  )

/** React escapes an apostrophe in markup. */
const html = (text: string): string => text.replaceAll("'", '&#x27;')

const SWITCH_DISABLED = /<span(?=[^>]*role="switch")[^>]*aria-disabled="true"/
const SEND_DISABLED = /<button(?=[^>]*data-slot="button")[^>]*disabled=""[^>]*>Send/

const ON: StreamReportEmailState = {
  signedIn: true,
  email: 'ada@example.com',
  enabled: true,
  history: true,
  envDisabled: false
}

/** The markup of one SettingsRow, by its test id. */
const row = (markup: string, testId: string): string => {
  const start = markup.indexOf(`data-testid="${testId}"`)
  expect(start).toBeGreaterThan(-1)
  const next = markup.indexOf('data-testid="', start + testId.length + 14)
  return markup.slice(start, next === -1 ? undefined : next)
}

describe('Livestream → After the stream (plan 237)', () => {
  it('waits for the backend with both controls disabled', () => {
    const markup = render(null)
    expect(markup).toContain('After the stream')
    expect(markup).toContain('Email me a report after each stream')
    expect(markup).toMatch(SWITCH_DISABLED)
    expect(markup).not.toContain('data-testid="stream-report-email-lock"')
  })

  it('says where the email goes and what it never carries', () => {
    const markup = render(ON)
    expect(markup).toContain('aria-checked="true"')
    expect(markup).not.toMatch(SWITCH_DISABLED)
    expect(markup).toContain('To ada@example.com.')
    expect(markup).toContain('never chat messages or viewer names')
    expect(markup).toContain('Streams of 5 minutes or more.')
    expect(render({ ...ON, enabled: false })).toContain('aria-checked="false"')
  })

  it('signed out: one Sign in lock leads, and everything under it is disabled', () => {
    const markup = render({ signedIn: false, enabled: null, envDisabled: false })
    expect(markup).toContain('data-testid="stream-report-email-lock"')
    expect(markup).toContain(html(STREAM_REPORT_SIGNED_OUT_REASON))
    expect(markup).toContain('Sign in')
    expect(markup.indexOf('stream-report-email-lock')).toBeLessThan(
      markup.indexOf('Email me a report after each stream')
    )
    expect(markup).toMatch(SWITCH_DISABLED)
    expect(markup).toMatch(SEND_DISABLED)
  })

  it('an unread choice offers another read; a run with the email off keeps the switch still', () => {
    const unknown = render({ ...ON, enabled: null })
    // No email switch: it would show "off" for an account that may be on.
    expect(row(unknown, 'stream-report-email')).not.toContain('role="switch"')
    expect(unknown).toMatch(/<button(?=[^>]*data-slot="button")[^>]*>Try again<\/button>/)
    expect(unknown).toContain(html("Couldn't reach videorc.com."))
    const off = render({ ...ON, enabled: false, envDisabled: true })
    expect(off).toMatch(SWITCH_DISABLED)
    expect(off).toMatch(SEND_DISABLED)
    expect(off).toContain('Turned off when Videorc started. Reopen Videorc to change it.')
  })

  it('Send the last one says what it did', () => {
    expect(render(ON)).toContain(html("Emails your latest live stream's report now."))
    const sending = render(ON, 'sending')
    expect(sending).toContain('Sending…')
    expect(sending).toMatch(/<button[^>]*disabled=""[^>]*>Sending…/)
    expect(render(ON, { status: 'sent', email: 'ada@example.com' })).toContain(
      'Sent to ada@example.com.'
    )
    expect(streamReportSendLine({ status: 'already-sent' })).toBe('Already sent.')
    expect(streamReportSendLine({ status: 'disabled' })).toBe(
      'Stream reports are off for your account.'
    )
    expect(streamReportSendLine({ status: 'no-stream' })).toBe('No finished live stream yet.')
    expect(streamReportSendLine({ status: 'signed-out' })).toBe('Sign in to Videorc first.')
    expect(streamReportSendLine({ status: 'rate-limited' })).toBe(
      "That's 10 reports today. Try again tomorrow."
    )
    expect(streamReportSendLine({ status: 'unavailable' })).toBe(
      "videorc.com can't send stream reports right now."
    )
    expect(streamReportSendLine({ status: 'failed' })).toBe("Couldn't send it. Try again.")
  })

  it('Save my streams on videorc.com is its own switch (plan 241 D7)', () => {
    const on = row(render(ON), 'stream-history')
    expect(on).toContain('Save my streams on videorc.com')
    expect(on).toContain('aria-checked="true"')
    expect(on).toContain(html(STREAM_HISTORY_DESCRIPTION))
    // Email off, history on: each switch shows its own choice.
    const mixed = render({ ...ON, enabled: false })
    expect(row(mixed, 'stream-report-email')).toContain('aria-checked="false"')
    expect(row(mixed, 'stream-history')).toContain('aria-checked="true"')
    expect(row(render({ ...ON, history: false }), 'stream-history')).toContain(
      'aria-checked="false"'
    )
  })

  it('an unknown history choice keeps its switch still and says why', () => {
    const unknown = row(render({ ...ON, history: undefined }), 'stream-history')
    expect(unknown).toMatch(SWITCH_DISABLED)
    expect(unknown).toContain(html("Couldn't reach videorc.com."))
    expect(row(render(null), 'stream-history')).toMatch(SWITCH_DISABLED)
    const signedOut = row(
      render({ signedIn: false, enabled: null, envDisabled: false }),
      'stream-history'
    )
    expect(signedOut).toMatch(SWITCH_DISABLED)
    expect(streamHistoryDescription({ ...ON, envDisabled: true })).toBe(
      'Turned off when Videorc started. Reopen Videorc to change it.'
    )
  })

  it('Your streams opens videorc.com/live', () => {
    const open = row(render(ON), 'stream-history-open')
    expect(open).toContain('Your streams')
    expect(open).toMatch(/<button(?=[^>]*data-slot="button")[^>]*>Open<\/button>/)
  })
})
