import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import {
  SessionPlayer,
  SessionPlayerControls,
  SessionPlayerStatus
} from '@/components/media/session-player'

const noop = (): void => undefined

describe('SessionPlayer (plan 119, S11)', () => {
  it('mounts a metadata-only video with the app controls and no browser chrome', () => {
    const markup = renderToStaticMarkup(createElement(SessionPlayer, { sessionId: 'session-1' }))
    expect(markup).toContain('data-slot="session-player"')
    expect(markup).toMatch(/<video[^>]*preload="metadata"/)
    expect(markup).toMatch(/<video[^>]*playsinline/i)
    expect(markup).not.toMatch(/<video[^>]*\scontrols/)
    // No grant before the effect runs: nothing to load yet.
    expect(markup).not.toMatch(/<video[^>]*\ssrc=/)
    expect(markup).toContain('Loading recording…')
    expect(markup).toMatch(/aria-label="Play"[^>]*disabled|disabled[^>]*aria-label="Play"/)
    expect(markup).toContain('role="slider"')
    expect(markup).toContain('aria-label="Playhead"')
    expect(markup).toContain('tabindex="0"')
    expect(markup.toLowerCase()).not.toContain('fullscreen')
  })

  it('frames the video on the dark video ground, never a colour literal', () => {
    const markup = renderToStaticMarkup(createElement(SessionPlayer, { sessionId: 'session-1' }))
    expect(markup).toContain('bg-video-ground')
    expect(markup).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/)
  })
})

describe('SessionPlayerStatus', () => {
  it('says why a recording cannot play, and offers a retry only when one could help', () => {
    const refused = renderToStaticMarkup(
      createElement(SessionPlayerStatus, {
        grant: { kind: 'refused', error: 'not-ready' },
        mediaError: null,
        onRetry: noop
      })
    )
    expect(refused).toContain('Still finalizing')
    expect(refused).not.toContain('Try again')
    expect(refused).not.toContain('Open in default player')

    const missing = renderToStaticMarkup(
      createElement(SessionPlayerStatus, {
        grant: { kind: 'refused', error: 'not-found' },
        mediaError: null,
        onRetry: noop
      })
    )
    expect(missing).toContain('Recording file missing')

    const failed = renderToStaticMarkup(
      createElement(SessionPlayerStatus, {
        grant: { kind: 'error', message: 'Renderer is not authorized to invoke this operation.' },
        mediaError: null,
        onRetry: noop
      })
    )
    expect(failed).toContain('Playback failed')
    expect(failed).toContain('Renderer is not authorized to invoke this operation.')
    expect(failed).toContain('Try again')

    const decode = renderToStaticMarkup(
      createElement(SessionPlayerStatus, {
        grant: { kind: 'granted', url: 'videorc-asset://session-media/x', expiresAt: 1 },
        mediaError: 'Playback was interrupted.',
        onRetry: noop
      })
    )
    expect(decode).toContain('Playback was interrupted.')
    expect(decode).toContain('Try again')
  })

  // Plan 174 S3.12 (E-30): a refusal offers what to do instead.
  it('offers another player and the file when this one cannot play it', () => {
    const notMp4 = renderToStaticMarkup(
      createElement(SessionPlayerStatus, {
        grant: { kind: 'refused', error: 'not-mp4' },
        mediaError: null,
        onRetry: noop,
        onOpenExternally: noop,
        onReveal: noop
      })
    )
    expect(notMp4).toContain('Open in default player')
    expect(notMp4).toMatch(/Show in (Finder|folder)/)
    expect(notMp4).not.toContain('Try again')

    const decode = renderToStaticMarkup(
      createElement(SessionPlayerStatus, {
        grant: { kind: 'granted', url: 'videorc-asset://session-media/x', expiresAt: 1 },
        mediaError: 'Playback was interrupted.',
        onRetry: noop,
        onOpenExternally: noop,
        onReveal: noop
      })
    )
    expect(decode).toContain('Try again')
    expect(decode).toContain('Open in default player')

    const missing = renderToStaticMarkup(
      createElement(SessionPlayerStatus, {
        grant: { kind: 'refused', error: 'not-found' },
        mediaError: null,
        onRetry: noop,
        onOpenExternally: noop,
        onReveal: noop
      })
    )
    expect(missing).not.toContain('Open in default player')
  })

  it('covers nothing while a granted recording plays', () => {
    expect(
      renderToStaticMarkup(
        createElement(SessionPlayerStatus, {
          grant: { kind: 'granted', url: 'videorc-asset://session-media/x', expiresAt: 1 },
          mediaError: null,
          onRetry: noop
        })
      )
    ).toBe('')
  })
})

describe('SessionPlayerControls', () => {
  const controls = (props: Partial<Parameters<typeof SessionPlayerControls>[0]> = {}): string =>
    renderToStaticMarkup(
      createElement(SessionPlayerControls, {
        playing: false,
        muted: false,
        positionMs: 754_000,
        durationMs: 1_800_000,
        disabled: false,
        onToggle: noop,
        onToggleMute: noop,
        onScrub: noop,
        onScrubCommit: noop,
        ...props
      })
    )

  it('shows mm:ss under an hour and h:mm:ss for long recordings', () => {
    const short = controls()
    expect(short).toContain('>12:34<')
    expect(short).toContain('>30:00<')
    const long = controls({ positionMs: 3_661_000, durationMs: 7_200_000 })
    expect(long).toContain('>1:01:01<')
    expect(long).toContain('>2:00:00<')
  })

  it('swaps the play glyph for pause while playing, with its key in a tooltip, never a title', () => {
    expect(controls()).toContain('aria-label="Play"')
    expect(controls({ playing: true })).toContain('aria-label="Pause"')
    expect(controls({ playing: true })).not.toContain('title=')
  })

  // Plan 174 S3.12 (E-30): a mute button beside the duration.
  it('mutes and unmutes, saying which', () => {
    expect(controls()).toContain('aria-label="Mute"')
    expect(controls({ muted: true })).toContain('aria-label="Unmute"')
  })

  // Plan 174 S3.12 (E-7): the pins sit on the scrubber, not on a row of their own.
  it('lays marker pins over the scrubber once the duration is known', () => {
    const marker = {
      id: 'm1',
      sessionId: 's1',
      atSeconds: 900,
      label: 'Intro',
      source: 'manual' as const,
      createdAt: '2026-10-05T12:00:00Z',
      revision: 1
    }
    const markup = controls({ markers: [marker], onSelectMarker: noop })
    const scrubber = markup.indexOf('role="slider"')
    const pins = markup.indexOf('data-slot="marker-timeline"')
    expect(pins).toBeGreaterThan(scrubber)
    expect(markup).toContain('data-variant="overlay"')
    expect(markup).toContain('aria-label="Intro · 15:00"')
    // Halfway: under the thumb's centre, which runs 8 px in from each end.
    expect(markup).toContain('left:calc(50% + 0px)')
    expect(controls({ markers: [marker], onSelectMarker: noop, durationMs: 0 })).not.toContain(
      'data-slot="marker-timeline"'
    )
  })

  it('bounds the scrubber by the recording and disables it until playback is ready', () => {
    // Radix writes aria-valuenow after mount, so server markup carries the bounds only.
    const markup = controls({ positionMs: 5_000_000, durationMs: 1_800_000 })
    expect(markup).toContain('aria-valuemin="0"')
    expect(markup).toContain('aria-valuemax="1800000"')
    // An unknown duration still leaves a valid, non-empty track.
    expect(controls({ positionMs: 0, durationMs: 0 })).toContain('aria-valuemax="100"')
    expect(controls({ disabled: true })).toMatch(/data-disabled/)
  })

  it('names the scrubber thumb and speaks its time, never raw milliseconds (plan 174 S0.5)', () => {
    const markup = controls({ positionMs: 125_000, durationMs: 2_470_000 })
    expect(markup).toMatch(/<span[^>]*role="slider"[^>]*aria-label="Playhead"/)
    expect(markup).toMatch(/<span[^>]*role="slider"[^>]*aria-valuetext="2:05 of 41:10"/)
  })
})
