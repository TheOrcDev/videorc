// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CHAT_ON_STREAM_LABEL } from '@/components/stream-manager/chat-on-stream-switch'
import { StreamManager, type StreamManagerProps } from '@/components/stream-manager/stream-manager'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { LiveChatSnapshot } from '@/lib/backend'

// Plan 215 G (D5): the chat pane's Chat on stream switch, like the Buddy's.

const snapshot: LiveChatSnapshot = {
  sessionId: 's1',
  providers: [],
  messages: [],
  unreadCount: 0,
  updatedAt: '2026-11-03T10:00:00Z'
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function render(props: Partial<StreamManagerProps>): Promise<void> {
  await act(async () => {
    root.render(
      createElement(
        TooltipProvider,
        null,
        createElement(StreamManager, {
          snapshot,
          dashboard: null,
          highlightState: { generation: 0, phase: 'idle' },
          onHighlight: () => undefined,
          ...props
        })
      )
    )
  })
}

const toggle = (): HTMLElement | null =>
  container.querySelector<HTMLElement>('[data-slot="chat-filters"] [data-testid="chat-on-stream"]')

describe('Chat on stream in the Stream Manager (plan 215 G)', () => {
  it('sits in the chat filter bar, off by default, and relays a click to Studio', async () => {
    const onChatOnStream = vi.fn()
    await render({ chatOnStream: false, onChatOnStream })
    await vi.waitFor(() => expect(toggle()).not.toBeNull())
    expect(toggle()!.getAttribute('aria-checked')).toBe('false')
    expect(toggle()!.getAttribute('aria-label')).toBe(CHAT_ON_STREAM_LABEL)
    expect(container.querySelector('[data-slot="chat-on-stream"]')?.textContent).toBe(
      CHAT_ON_STREAM_LABEL
    )
    await act(async () => toggle()!.click())
    expect(onChatOnStream).toHaveBeenCalledWith(true)
  })

  it('shows what Studio says is on', async () => {
    await render({ chatOnStream: true, onChatOnStream: () => undefined })
    await vi.waitFor(() => expect(toggle()?.getAttribute('aria-checked')).toBe('true'))
  })

  it('stays away without the relay, before Studio says, and in history', async () => {
    await render({ chatOnStream: false })
    await render({ onChatOnStream: () => undefined })
    await act(async () => {
      await import('@/components/stream-manager/chat-on-stream-switch')
    })
    expect(toggle()).toBeNull()
    await render({
      chatOnStream: true,
      onChatOnStream: () => undefined,
      viewMode: { kind: 'history', sessionId: 's0' }
    })
    await act(async () => {
      await import('@/components/stream-manager/chat-on-stream-switch')
    })
    expect(toggle()).toBeNull()
  })
})
