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
    expect(markup).toContain('Loading recording')
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
        mediaError: 'This recording could not be decoded.',
        onRetry: noop
      })
    )
    expect(decode).toContain('This recording could not be decoded.')
    expect(decode).toContain('Try again')
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
        positionMs: 754_000,
        durationMs: 1_800_000,
        disabled: false,
        onToggle: noop,
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

  it('swaps the play glyph for pause while playing', () => {
    expect(controls()).toContain('aria-label="Play"')
    expect(controls({ playing: true })).toContain('aria-label="Pause"')
    expect(controls({ playing: true })).toContain('Pause (Space)')
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
})
