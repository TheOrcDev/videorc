import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { videoPresets } from '@/lib/capture'

import {
  GoLiveCaptionsStatus,
  GoLiveCommentsStatus,
  GoLiveDestinationSummary,
  GoLiveOutputAdvice
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

    expect(markup).toContain('aria-label="Chat read and send status"')
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

  it('keeps video ready while summarizing non-blocking chat limitations', () => {
    const markup = renderToStaticMarkup(
      createElement(GoLiveDestinationSummary, { issueCount: 0, warningCount: 2 })
    )

    expect(markup).toContain('Ready · 2 chat limitations')
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

describe('Go Live output advice (plan 090)', () => {
  const stream = videoPresets['stream-safe-1080p30']
  const floor = videoPresets['tutorial-720p30']

  it('is quiet when the saved settings go out as they are', () => {
    expect(
      renderToStaticMarkup(
        createElement(GoLiveOutputAdvice, { advice: null, recordEnabled: true, sharedVideo: null })
      )
    ).toBe('')
  })

  it('says what a stepped-down session will stream at, and that settings are kept', () => {
    const markup = renderToStaticMarkup(
      createElement(GoLiveOutputAdvice, {
        advice: { kind: 'step-down', requested: stream, video: floor },
        recordEnabled: true,
        sharedVideo: null
      })
    )
    expect(markup).toContain('Streaming at 720p 30')
    expect(markup).toContain('1080p 30')
    expect(markup).toContain('for the recording too')
    expect(markup).toContain('Your saved settings stay as they are.')
    expect(markup).not.toContain('data-variant="warning"')
  })

  it('warns when nothing held steady instead of promising a step-down', () => {
    const markup = renderToStaticMarkup(
      createElement(GoLiveOutputAdvice, {
        advice: { kind: 'below-floor', floor },
        recordEnabled: false,
        sharedVideo: null
      })
    )
    expect(markup).toContain('This computer may not keep up')
    expect(markup).toContain('not even 720p 30')
    expect(markup).not.toContain('Streaming at')
  })

  it('explains a recording that takes the stream profile, without error codes', () => {
    const markup = renderToStaticMarkup(
      createElement(GoLiveOutputAdvice, {
        advice: null,
        recordEnabled: true,
        sharedVideo: stream
      })
    )
    expect(markup).toContain('Recording will match the stream')
    expect(markup).toContain('1080p 30 at 6000 kbps')
    expect(markup).not.toMatch(/HRESULT|Media Foundation/)
  })
})
