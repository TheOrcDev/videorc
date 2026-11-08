import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const state = vi.hoisted(() => ({
  recording: {
    state: 'recording',
    sessionId: 'session',
    message: 'This recording opens the camera again while Preview is using it.',
    replayOnly: false
  },
  diagnosticStats: { sessionId: 'session', duplicateCaptureSources: Array<string>() }
}))

vi.mock('@/hooks/use-studio', () => ({
  useStudioChat: vi.fn(),
  useStudioCore: vi.fn(),
  useStudioDiagnostics: () => ({ diagnosticStats: state.diagnosticStats }),
  useStudioRecording: () => ({ recording: state.recording }),
  useStudioShell: vi.fn()
}))
vi.mock('@/components/workspace-nav', async () => {
  const { createContext } = await import('react')
  return {
    WorkspaceNavContext: createContext(null),
    useWorkspaceNav: () => ({ setActive: vi.fn() })
  }
})

import { SessionNotices } from './session-panel'

const render = (active = true) =>
  renderToStaticMarkup(createElement(SessionNotices, { active, startRequestPending: false }))

beforeEach(() => {
  state.recording.state = 'recording'
  state.recording.replayOnly = false
  state.diagnosticStats.sessionId = 'session'
  state.diagnosticStats.duplicateCaptureSources = ['camera:avfoundation-native:1234']
})

describe('legacy camera ownership notice', () => {
  it('shows the session camera message visibly in the warning Alert', () => {
    const html = render()
    expect(html).toContain('data-testid="session-camera-shared"')
    expect(html).toContain('data-variant="warning"')
    expect(html).toContain('Camera opened twice')
    expect(html).toContain(state.recording.message)
  })

  it('names a stream-only session without claiming a recording file', () => {
    state.recording.state = 'streaming'
    const html = render()
    expect(html).toContain('Preview and your livestream both have the camera open.')
    expect(html).not.toContain('This recording')
  })

  it('also explains a camera held by Clips while Studio is idle', () => {
    state.recording.replayOnly = true
    const html = render(false)
    expect(html).toContain('Camera opened twice')
    expect(html).toContain('Preview and Clips both have the camera open.')
    expect(html).not.toContain('This recording')
  })

  it('does not show camera ownership for a screen duplicate or stale session stats', () => {
    state.diagnosticStats.duplicateCaptureSources = ['screen:screencapturekit:1']
    expect(render()).not.toContain('session-camera-shared')
    state.diagnosticStats.duplicateCaptureSources = ['camera:avfoundation-native:1234']
    state.diagnosticStats.sessionId = 'previous-session'
    expect(render()).not.toContain('session-camera-shared')
  })

  it('clears the notice after stopping or failing', () => {
    for (const status of ['idle', 'stopping', 'stopped', 'failed']) {
      state.recording.state = status
      expect(render()).not.toContain('session-camera-shared')
    }
  })
})
