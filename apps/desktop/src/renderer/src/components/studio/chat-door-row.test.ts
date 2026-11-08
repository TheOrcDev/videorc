// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { LiveChatProviderState } from '@/lib/backend'

import { ChatDoorRow } from './quick-settings'

// Plan 213 B1: a new streamer found no chat in the idle Studio. The Chat row
// under Captions is its door: the Stream Manager and its key while idle,
// "{n} new" while a livestream with chat is on air, and a click opens the
// Stream Manager. It is never a switch.

const LIVE = { state: 'streaming', streamUrl: 'rtmp://example.test/live' }
const provider: LiveChatProviderState = {
  id: 'youtube:main',
  platform: 'youtube',
  read: 'ready',
  write: 'ready',
  state: 'connected',
  message: 'Connected.'
}

const mocked = vi.hoisted(() => ({
  chat: {} as Record<string, unknown>,
  recording: {} as Record<string, unknown>,
  shell: {} as Record<string, unknown>,
  openCommentsWindow: vi.fn(async () => undefined)
}))
vi.mock('@/hooks/use-studio', () => ({
  useStudioChat: () => mocked.chat,
  useStudioRecordingState: () => mocked.recording,
  useStudioShell: () => mocked.shell
}))

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  mocked.openCommentsWindow.mockClear()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

function renderRow({
  recording = { state: 'idle' } as Record<string, unknown>,
  sessionId = undefined as string | undefined,
  providers = [] as LiveChatProviderState[],
  chatNewCount = 0,
  commentsWindowEnabled = true
} = {}): HTMLButtonElement | null {
  mocked.chat = {
    liveChatSnapshot: { sessionId, providers, messages: [], unreadCount: 0, updatedAt: '' },
    chatNewCount
  }
  mocked.recording = { recording }
  mocked.shell = {
    openCommentsWindow: mocked.openCommentsWindow,
    runtimeInfo: { platform: 'darwin', commentsWindowEnabled }
  }
  act(() => root.render(createElement(ChatDoorRow)))
  return container.querySelector('button[data-slot="navigable-row"]')
}

describe('the Studio Chat row (plan 213 B1)', () => {
  it('reads "Stream Manager · ⇧⌘J" while idle, and a click opens the Stream Manager', () => {
    const row = renderRow()
    expect(row?.textContent).toBe('ChatStream Manager·⇧⌘J')
    expect(row?.querySelector('[data-accelerator]')?.getAttribute('data-accelerator')).toBe(
      'CmdOrCtrl+Shift+J'
    )
    act(() => row?.click())
    expect(mocked.openCommentsWindow).toHaveBeenCalledTimes(1)
  })

  it('reads "{n} new" while a livestream with chat is on air, and still opens the Stream Manager', () => {
    const row = renderRow({
      recording: LIVE,
      sessionId: 's1',
      providers: [provider],
      chatNewCount: 12
    })
    expect(row?.textContent).toBe('Chat12 new')
    act(() => row?.click())
    expect(mocked.openCommentsWindow).toHaveBeenCalledTimes(1)
  })

  it('stays the door on air when no destination has chat', () => {
    const row = renderRow({ recording: LIVE, sessionId: 's1', chatNewCount: 3 })
    expect(row?.textContent).toBe('ChatStream Manager·⇧⌘J')
  })

  it('is a door, never a switch', () => {
    const row = renderRow()
    expect(row?.getAttribute('role')).toBeNull()
    expect(row?.hasAttribute('aria-pressed')).toBe(false)
    expect(container.querySelector('[role="switch"]')).toBeNull()
  })

  it('is absent when this build has no Stream Manager, like the status bar hint', () => {
    expect(renderRow({ commentsWindowEnabled: false })).toBeNull()
    expect(container.innerHTML).toBe('')
  })
})
