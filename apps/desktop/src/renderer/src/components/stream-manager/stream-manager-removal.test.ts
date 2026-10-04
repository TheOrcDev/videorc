// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { StreamManager, type StreamManagerProps } from '@/components/stream-manager/stream-manager'
import type { LiveChatMessage, LiveChatSnapshot, ModerationOperation } from '@/lib/backend'
import { EMPTY_COHOST_STATE } from '@/lib/cohost-view'

const chat: LiveChatMessage = {
  id: 's1:twitch:t:m-chat',
  providerMessageId: 'm-chat',
  platform: 'twitch',
  sessionId: 's1',
  authorName: 'coders_x',
  authorBadges: [],
  authorRoles: [],
  publishedAt: '2026-10-04T12:00:00Z',
  receivedAt: '2026-10-04T12:00:00Z',
  messageText: 'this stream is trash',
  fragments: [],
  eventType: 'message',
  isDeleted: false
}

const snapshot: LiveChatSnapshot = {
  sessionId: 's1',
  providers: [],
  messages: [chat],
  unreadCount: 0,
  updatedAt: '2026-10-04T12:00:05Z'
}

const pending: ModerationOperation = {
  operationId: '6f1c2e9a-3b7d-4c51-9e2f-0a1b2c3d4e5f',
  sessionId: 's1',
  messageId: chat.id,
  platform: 'twitch',
  authorName: 'coders_x',
  excerpt: 'this stream is trash',
  source: 'orcle-voice',
  phase: 'pending-confirm',
  confirmMode: 'confirm',
  requiresExplicitConfirm: true,
  confirmBy: '2099-01-01T00:00:00Z',
  createdAt: '2026-10-04T12:00:06Z',
  updatedAt: '2026-10-04T12:00:06Z'
}

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

async function render(patch: Partial<StreamManagerProps>): Promise<void> {
  await act(async () =>
    root.render(
      createElement(StreamManager, {
        snapshot,
        dashboard: null,
        cohostGate: { allowed: true },
        cohostConsented: true,
        cohostEnabled: true,
        cohostState: { ...EMPTY_COHOST_STATE, sessionId: 's1', status: 'listening' },
        onAnswerRemoval: () => undefined,
        onRemoveFromChat: () => undefined,
        ...patch
      })
    )
  )
}

function activeTab(slot: 'pane-tabs-narrow' | 'pane-tabs-wide'): string | null {
  const tab = container.querySelector<HTMLElement>(
    `[data-slot="${slot}"] [role="tab"][data-state="active"]`
  )
  return tab?.textContent?.trim().toLowerCase() ?? null
}

describe('StreamManager: an Orcle removal card comes forward (plan 140, S6)', () => {
  it('brings the Orcle pane forward for a new card, then returns to where you were', async () => {
    await render({ moderationOperations: [] })
    expect(activeTab('pane-tabs-narrow')).toBe('chat')
    expect(activeTab('pane-tabs-wide')).toBe('activity')

    await render({ moderationOperations: [pending] })
    expect(activeTab('pane-tabs-narrow')).toBe('orcle')
    expect(activeTab('pane-tabs-wide')).toBe('orcle')
    expect(container.querySelector('[data-slot="removal-card"]')).toBeTruthy()
    // It never takes focus from wherever the streamer is typing.
    expect(document.activeElement).toBe(document.body)

    // The card ended long ago: no result line is left, so the panes go back.
    await render({
      moderationOperations: [{ ...pending, phase: 'cancelled', updatedAt: '2020-01-01T00:00:00Z' }]
    })
    expect(container.querySelector('[data-slot="removal-card"]')).toBeNull()
    expect(activeTab('pane-tabs-narrow')).toBe('chat')
    expect(activeTab('pane-tabs-wide')).toBe('activity')
  })

  it('answers the card through the Stream Manager with the operation', async () => {
    const onAnswerRemoval = vi.fn()
    await render({ moderationOperations: [pending], onAnswerRemoval })
    const cancel = container.querySelector<HTMLButtonElement>('[data-slot="removal-cancel"]')
    await act(async () => cancel!.click())
    expect(onAnswerRemoval).toHaveBeenCalledWith(pending, 'cancel')
  })
})
