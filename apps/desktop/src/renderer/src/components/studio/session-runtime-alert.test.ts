import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

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
    expect(markup).toContain('Show in Finder')
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

    expect(markup).toContain('Microphone stopped — recording continues with silence')
    expect(markup).toContain('The selected microphone stopped providing audio.')
    expect(markup).toContain('Dismiss')
    expect(markup).not.toContain('Open Library')
    expect(markup).not.toContain('Show in Finder')
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

    expect(failureMarkup).toContain('Live session stopped unexpectedly')
    expect(failureMarkup).not.toContain('Recording stopped unexpectedly')
    expect(microphoneMarkup).toContain('Microphone stopped — live session continues with silence')
    expect(microphoneMarkup).not.toContain('recording continues')
    expect(failureMarkup).not.toContain('Open Library')
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

    expect(markup).toContain('Microphone stopped — saved recording contains silence')
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

    expect(markup).toContain('Microphone stopped — finishing recording with silence')
    expect(markup).not.toContain('recording continues')
  })
})
