// @vitest-environment happy-dom
import { act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { LiveChatMessage, LiveChatSnapshot } from '@/lib/backend'

import { useChatNewCount } from './use-chat-new-count'

// Plan 213 B1: the Chat row's "{n} new" counts chat since the Stream Manager
// last showed, from renderer state alone.

let root: Root
let container: HTMLDivElement

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

const message = (id: string): LiveChatMessage => ({
  id,
  providerMessageId: id,
  platform: 'youtube',
  sessionId: 's1',
  authorName: 'Ada',
  authorBadges: [],
  authorRoles: [],
  publishedAt: '2026-11-01T12:00:00.000Z',
  receivedAt: '2026-11-01T12:00:00.000Z',
  messageText: 'Hi',
  fragments: [],
  eventType: 'message',
  isDeleted: false
})

const snapshot = (ids: string[]): LiveChatSnapshot => ({
  sessionId: 's1',
  providers: [],
  messages: ids.map(message),
  unreadCount: 0,
  updatedAt: '2026-11-01T12:00:00.000Z'
})

function Count({ chat, showing }: { chat: LiveChatSnapshot; showing: boolean }): ReactElement {
  return createElement('output', null, useChatNewCount(chat, showing))
}

const render = (ids: string[], showing: boolean): string | null | undefined => {
  act(() => root.render(createElement(Count, { chat: snapshot(ids), showing })))
  return container.textContent
}

describe('useChatNewCount (plan 213 B1)', () => {
  it('counts the livestream until the Stream Manager shows, then nothing while it shows', () => {
    expect(render(['m1', 'm2'], false)).toBe('2')
    expect(render(['m1', 'm2', 'm3'], true)).toBe('0')
  })

  it('counts only what arrives after the Stream Manager hides', () => {
    render(['m1'], true)
    expect(render(['m1', 'm2'], true)).toBe('0')
    expect(render(['m1', 'm2'], false)).toBe('0')
    expect(render(['m1', 'm2', 'm3', 'm4'], false)).toBe('2')
    // Showing it again sees them.
    expect(render(['m1', 'm2', 'm3', 'm4'], true)).toBe('0')
    expect(render(['m1', 'm2', 'm3', 'm4'], false)).toBe('0')
  })
})
