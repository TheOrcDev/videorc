import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { StreamReportEmailState } from '@/lib/backend'

import {
  STREAM_REPORT_SIGNED_OUT_REASON,
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
  envDisabled: false
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
    // No switch: it would show "off" for an account that may be on.
    expect(unknown).not.toContain('role="switch"')
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
})
