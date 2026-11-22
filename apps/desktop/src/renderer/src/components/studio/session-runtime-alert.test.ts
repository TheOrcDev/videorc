import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { revealInFileManagerLabel } from '@/lib/platform'
import { SessionRuntimeAlert } from './session-runtime-alert'

describe('SessionRuntimeAlert', () => {
  it('renders an unexpected recording failure with recovery and dismiss actions', () => {
    const markup = renderToStaticMarkup(
      createElement(SessionRuntimeAlert, {
        notice: {
          kind: 'recording-failed',
          sessionId: 'session-failed',
          outputPath: '/recordings/session-failed.mkv',
          activity: 'recording',
          message: 'Encoder FIFO write exceeded the delivery budget.',
          at: 1
        },
        onDismiss: vi.fn(),
        onOpenLibrary: vi.fn(),
        onRevealOutput: vi.fn()
      })
    )

    expect(markup).toContain('role="alert"')
    expect(markup).toContain('data-testid="session-runtime-notice"')
    expect(markup).toContain('Recording stopped unexpectedly')
    expect(markup).toContain('Encoder FIFO write exceeded the delivery budget.')
    expect(markup).toContain('Open Library')
    expect(markup).toContain(revealInFileManagerLabel())
    expect(markup).toContain('Dismiss')
  })

  it('renders microphone loss as degraded without recovery-file actions', () => {
    const markup = renderToStaticMarkup(
      createElement(SessionRuntimeAlert, {
        notice: {
          kind: 'microphone-input-lost',
          sessionId: 'session-with-silence',
          activity: 'recording',
          phase: 'active',
          message: 'The selected microphone stopped providing audio.',
          at: 2
        },
        onDismiss: vi.fn(),
        onOpenLibrary: vi.fn(),
        onRevealOutput: vi.fn()
      })
    )

    expect(markup).toContain('Microphone stopped: recording continues with silence')
    expect(markup).toContain('The selected microphone stopped providing audio.')
    expect(markup).toContain('Dismiss')
    expect(markup).not.toContain('Open Library')
    expect(markup).not.toContain(revealInFileManagerLabel())
  })

  it('uses live-session copy when stream-only output is active', () => {
    const failureMarkup = renderToStaticMarkup(
      createElement(SessionRuntimeAlert, {
        notice: {
          kind: 'recording-failed',
          activity: 'live-stream',
          message: 'The streaming encoder stopped.',
          at: 3
        },
        onDismiss: vi.fn()
      })
    )
    const microphoneMarkup = renderToStaticMarkup(
      createElement(SessionRuntimeAlert, {
        notice: {
          kind: 'microphone-input-lost',
          activity: 'live-stream',
          phase: 'active',
          message: 'The selected microphone stopped providing audio.',
          at: 4
        },
        onDismiss: vi.fn()
      })
    )

    expect(failureMarkup).toContain('Livestream stopped unexpectedly')
    expect(failureMarkup).not.toContain('Recording stopped unexpectedly')
    expect(microphoneMarkup).toContain('Microphone stopped: livestream continues with silence')
    expect(microphoneMarkup).not.toContain('recording continues')
    expect(failureMarkup).not.toContain('Open Library')
  })

  // Plan 174 B-6: Go Live records too, so its failure speaks of the live
  // session and still opens the saved file.
  it('uses live-session copy for Go Live and keeps the saved file actions', () => {
    const markup = renderToStaticMarkup(
      createElement(SessionRuntimeAlert, {
        notice: {
          kind: 'recording-failed',
          sessionId: 'go-live',
          outputPath: '/recordings/go-live.mkv',
          activity: 'record+stream',
          message: 'The encoder stopped.',
          at: 7
        },
        onDismiss: vi.fn(),
        onOpenLibrary: vi.fn(),
        onRevealOutput: vi.fn()
      })
    )

    expect(markup).toContain('Livestream stopped unexpectedly')
    expect(markup).not.toContain('Recording stopped unexpectedly')
    expect(markup).toContain('Open Library')
    expect(markup).toContain(revealInFileManagerLabel())
  })

  it('switches a persistent microphone warning to past tense after a take is saved', () => {
    const markup = renderToStaticMarkup(
      createElement(SessionRuntimeAlert, {
        notice: {
          kind: 'microphone-input-lost',
          activity: 'recording',
          phase: 'ended',
          message: 'The selected microphone stopped providing audio.',
          at: 5
        },
        onDismiss: vi.fn()
      })
    )

    expect(markup).toContain('Microphone stopped: saved recording contains silence')
    expect(markup).not.toContain('recording continues')
  })

  it('does not claim a stopping session is still actively recording', () => {
    const markup = renderToStaticMarkup(
      createElement(SessionRuntimeAlert, {
        notice: {
          kind: 'microphone-input-lost',
          activity: 'recording',
          phase: 'ending',
          message: 'The selected microphone stopped providing audio.',
          at: 6
        },
        onDismiss: vi.fn()
      })
    )

    expect(markup).toContain('Microphone stopped: finishing recording with silence')
    expect(markup).not.toContain('recording continues')
  })

  // Silent-mic report 2026-11-22: this notice hides the watchdog card while
  // it is up, so it carries the card's door. Only for a microphone that can
  // still be fixed.
  describe('Open Audio', () => {
    const silent = {
      kind: 'microphone-input-lost' as const,
      audioIssues: [{ code: 'microphone-silent', message: 'Shure MV7+ is sending only silence.' }],
      activity: 'recording' as const,
      phase: 'active' as const,
      message:
        "Shure MV7+ is sending only silence. Check its own mute button or switch, and its cable. If it's still silent, choose it again.",
      at: 8
    }

    it('a silent microphone gets the door, first, beside Dismiss', () => {
      const markup = renderToStaticMarkup(
        createElement(SessionRuntimeAlert, {
          notice: silent,
          onDismiss: vi.fn(),
          onOpenAudio: vi.fn()
        })
      )
      expect(markup).toContain('Your microphone is silent in the recording')
      expect(markup).toContain('Check its own mute button or switch, and its cable.')
      expect(markup).toContain('data-testid="session-runtime-open-audio"')
      expect(markup.indexOf('Open Audio')).toBeLessThan(markup.indexOf('Dismiss'))
    })

    it('a stopped microphone gets it too, a system-audio loss and a finished take do not', () => {
      const door = (notice: Parameters<typeof SessionRuntimeAlert>[0]['notice']): boolean =>
        renderToStaticMarkup(
          createElement(SessionRuntimeAlert, { notice, onDismiss: vi.fn(), onOpenAudio: vi.fn() })
        ).includes('Open Audio')
      expect(door({ ...silent, audioIssues: undefined })).toBe(true)
      expect(
        door({ ...silent, audioIssues: [{ code: 'microphone-timeline-lost', message: 'x' }] })
      ).toBe(true)
      expect(door({ ...silent, audioIssues: [{ code: 'system-audio-lost', message: 'x' }] })).toBe(
        false
      )
      expect(door({ ...silent, phase: 'ended' })).toBe(false)
      expect(door({ kind: 'recording-failed', activity: 'recording', message: 'x', at: 9 })).toBe(
        false
      )
      // No handler, no button: never a dead one.
      expect(
        renderToStaticMarkup(
          createElement(SessionRuntimeAlert, { notice: silent, onDismiss: vi.fn() })
        )
      ).not.toContain('Open Audio')
    })
  })
})
