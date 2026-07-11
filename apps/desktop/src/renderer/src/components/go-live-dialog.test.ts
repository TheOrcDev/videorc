import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import {
  GoLiveCaptionsStatus,
  GoLiveCommentsStatus,
  GoLiveDestinationSummary
} from './go-live-dialog'

describe('Go Live comments status', () => {
  it('states that native X comments attach after publish and remain receive-only', () => {
    const markup = renderToStaticMarkup(
      createElement(GoLiveCommentsStatus, {
        read: 'waiting-for-broadcast-context',
        write: 'read-only',
        message:
          'X comments attach after the native broadcast is published; X live chat is receive-only.'
      })
    )

    expect(markup).toContain('aria-label="Comments read and send status"')
    expect(markup).toContain('Read: After publish')
    expect(markup).toContain('Send: Receive only')
    expect(markup).toContain('X comments attach after the native broadcast is published')
  })

  it('shows Twitch read and write scope state independently', () => {
    const markup = renderToStaticMarkup(
      createElement(GoLiveCommentsStatus, {
        read: 'ready',
        write: 'missing-scope',
        message: 'Twitch comments are readable. Reconnect Twitch to send from Videorc.'
      })
    )

    expect(markup).toContain('Read: Ready')
    expect(markup).toContain('Send: Reconnect needed')
    expect(markup).toContain('data-variant="success"')
    expect(markup).toContain('data-variant="warning"')
  })

  it('keeps video ready while summarizing non-blocking comment limitations', () => {
    const markup = renderToStaticMarkup(
      createElement(GoLiveDestinationSummary, { issueCount: 0, warningCount: 2 })
    )

    expect(markup).toContain('Ready · 2 comment limitations')
    expect(markup).toContain('data-variant="warning"')
    expect(markup).not.toContain('data-variant="destructive"')
  })
})

describe('Go Live captions status', () => {
  it('shows a compact ready transport row', () => {
    const markup = renderToStaticMarkup(
      createElement(GoLiveCaptionsStatus, {
        pending: false,
        readiness: {
          kind: 'ready',
          blocksStart: false,
          title: 'Captions ready',
          description: 'Realtime microphone transcription is ready.',
          transport: 'realtime'
        },
        onContinueWithoutCaptions: () => {}
      })
    )

    expect(markup).toContain('Captions')
    expect(markup).toContain('Realtime microphone transcription is ready.')
    expect(markup).toContain('data-variant="success"')
    expect(markup).not.toContain('Continue without captions')
  })

  it('offers an explicit one-session bypass when deployment readiness is unavailable', () => {
    const markup = renderToStaticMarkup(
      createElement(GoLiveCaptionsStatus, {
        pending: false,
        readiness: {
          kind: 'blocked',
          blocksStart: true,
          title: 'Captions unavailable',
          description: 'Videorc could not verify live-caption readiness for this deployment.',
          transport: null
        },
        onContinueWithoutCaptions: () => {}
      })
    )

    expect(markup).toContain('Continue without captions')
    expect(markup).toContain('deployment')
    expect(markup).toContain('data-variant="warning"')
  })
})
