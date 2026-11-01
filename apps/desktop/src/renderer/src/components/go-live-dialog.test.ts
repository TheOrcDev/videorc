import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { videoPresets } from '@/lib/capture'

import { GoLiveCaptionsStatus, GoLiveCommentsStatus, GoLiveOutputAdvice } from './go-live-dialog'

describe('Go Live comments status', () => {
  it('shows ready X chat as ready to read and send', () => {
    const markup = renderToStaticMarkup(
      createElement(GoLiveCommentsStatus, {
        read: 'ready',
        write: 'ready',
        message: 'X chat is ready to read and send.'
      })
    )

    expect(markup).toContain('aria-label="Chat read and send status"')
    expect(markup).toMatch(/>Read<\/span><span[^>]*>Ready</)
    expect(markup).toMatch(/>Send<\/span><span[^>]*>Ready</)
    expect(markup).toContain('X chat is ready to read and send.')
  })

  it('names chat states in the glossary words', () => {
    const markup = renderToStaticMarkup(
      createElement(GoLiveCommentsStatus, {
        read: 'waiting-for-broadcast-context',
        write: 'read-only',
        message: ''
      })
    )

    expect(markup).toMatch(/>Read<\/span><span[^>]*>After publish</)
    // The glossary's word (plan 174 D4), never "Receive only".
    expect(markup).toMatch(/>Send<\/span><span[^>]*>Read-only</)
    expect(markup).not.toContain('Receive only')
  })

  // Plan 213 J1 and J3: a stream-key X destination reads as the choice it is,
  // in the Stream Manager's words, never Failed and never Authorize X Live.
  it('says X chat needs Sign in for a stream key, as the Stream Manager does', () => {
    const words =
      'X chat needs Sign in. Your stream key still streams; X shares chat only with apps you sign in to.'
    const markup = renderToStaticMarkup(
      createElement(GoLiveCommentsStatus, {
        read: 'needs-sign-in',
        write: 'unavailable',
        message: words
      })
    )

    expect(markup).toMatch(/>Read<\/span><span[^>]*>Needs Sign in</)
    expect(markup).toMatch(/>Send<\/span><span[^>]*>Unavailable</)
    expect(markup).toContain(words)
    expect(markup).not.toContain('Failed')
    expect(markup).not.toContain('Authorize X Live')
  })

  it('shows Twitch read and write scope state independently', () => {
    const markup = renderToStaticMarkup(
      createElement(GoLiveCommentsStatus, {
        read: 'ready',
        write: 'missing-scope',
        message: 'Twitch comments are readable. Reconnect Twitch to send from Videorc.'
      })
    )

    expect(markup).toMatch(/>Read<\/span><span[^>]*>Ready</)
    expect(markup).toMatch(/>Send<\/span><span[^>]*>Reconnect to send</)
    // Status chips carry the tone; the words stay monochrome (plan 174 S1.8).
    expect(markup).toContain('data-tone="good"')
    expect(markup).toContain('data-tone="warn"')
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
    expect(markup).toContain('data-tone="good"')
    expect(markup).not.toContain('Go live without captions')
    expect(markup).not.toContain('data-slot="alert"')
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

    // A blocker is a destructive Alert with its one-livestream way out (S3.4).
    expect(markup).toContain('Go live without captions')
    expect(markup).toContain('deployment')
    expect(markup).toContain('data-variant="destructive"')
  })

  it('says captions are skipped for this livestream as advice, not a warning', () => {
    const markup = renderToStaticMarkup(
      createElement(GoLiveCaptionsStatus, {
        pending: false,
        readiness: {
          kind: 'skipped',
          blocksStart: false,
          title: 'Captions skipped',
          description:
            'This livestream will start without captions. Your saved setting is unchanged.',
          transport: null
        },
        onContinueWithoutCaptions: () => {}
      })
    )
    expect(markup).toContain('data-variant="default"')
    expect(markup).toContain('Your saved setting is unchanged.')
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
        advice: { kind: 'step-down', reason: 'encoder', requested: stream, video: floor },
        recordEnabled: true,
        sharedVideo: null
      })
    )
    expect(markup).toContain('Streaming at 720p · 30 fps')
    expect(markup).toContain('1080p · 30 fps')
    expect(markup).toContain('for the recording too')
    expect(markup).toContain('Your saved settings stay as they are.')
    expect(markup).not.toContain('data-variant="warning"')
  })

  it('says why a headroom step-down happened and how to keep the pick', () => {
    const markup = renderToStaticMarkup(
      createElement(GoLiveOutputAdvice, {
        advice: { kind: 'step-down', reason: 'go-live-headroom', requested: stream, video: floor },
        recordEnabled: true,
        sharedVideo: null
      })
    )
    expect(markup).toContain('Streaming at 720p · 30 fps')
    expect(markup).toContain('about twice the work of a recording')
    expect(markup).toContain('Pick 1080p · 30 fps in Livestream')
    expect(markup).toContain('The recording uses it too.')
  })

  it('warns about a picked stream quality without moving it', () => {
    const markup = renderToStaticMarkup(
      createElement(GoLiveOutputAdvice, {
        advice: { kind: 'go-live-heavy', requested: stream, video: floor },
        recordEnabled: true,
        sharedVideo: null
      })
    )
    expect(markup).toContain('1080p · 30 fps may stutter while live')
    expect(markup).toContain('720p · 30 fps holds steady.')
    expect(markup).toContain('data-variant="warning"')
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
    expect(markup).toContain('not even 720p · 30 fps')
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
    expect(markup).toContain('1080p · 30 fps · 6 Mbps')
    expect(markup).not.toMatch(/HRESULT|Media Foundation/)
  })
})
