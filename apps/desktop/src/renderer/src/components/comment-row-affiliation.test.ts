// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CommentRow } from '@/components/comment-row'
import type { LiveChatMessage } from '@/lib/backend'

// Plan 086: the organization badge X shows beside an affiliated name.

let root: Root
let container: HTMLDivElement
const cacheChatAvatar = vi.fn(
  async (url: string) => `videorc-asset://avatar/${encodeURIComponent(url)}`
)

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('videorc', { cacheChatAvatar })
  cacheChatAvatar.mockClear()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

function message(overrides: Partial<LiveChatMessage> = {}): LiveChatMessage {
  return {
    id: 'session-1:x:message-1',
    providerMessageId: 'message-1',
    platform: 'x',
    sessionId: 'session-1',
    authorId: 'author-1',
    authorName: 'Dominik Koch',
    authorBadges: [],
    authorRoles: [],
    publishedAt: '2026-10-01T12:00:00.000Z',
    receivedAt: '2026-10-01T12:00:01.000Z',
    messageText: 'Does it display my neon twitter badge?',
    fragments: [],
    eventType: 'message',
    isDeleted: false,
    ...overrides
  }
}

async function render(row: LiveChatMessage): Promise<void> {
  await act(async () => root.render(createElement(CommentRow, { message: row })))
}

const badge = (): HTMLImageElement | null =>
  container.querySelector('[data-slot="comment-affiliation"]')

describe('CommentRow affiliation badge', () => {
  it('shows the organization logo beside the name, through the avatar cache', async () => {
    const badgeUrl = 'https://pbs.twimg.com/profile_images/2/neon_badge_affiliation.jpg'
    await render(
      message({
        authorAffiliation: { badgeUrl, description: 'Neon', url: 'https://x.com/neondatabase' }
      })
    )

    expect(cacheChatAvatar).toHaveBeenCalledWith(badgeUrl)
    const image = badge()
    expect(image).not.toBeNull()
    expect(image!.getAttribute('src')).toBe(
      `videorc-asset://avatar/${encodeURIComponent(badgeUrl)}`
    )
    expect(image!.getAttribute('alt')).toBe('Neon')
    expect(image!.getAttribute('title')).toBe('Neon')
    // Directly after the author's name.
    expect(image!.previousElementSibling?.textContent).toBe('Dominik Koch')
  })

  it('names the badge generically when X sent no organization name', async () => {
    await render(
      message({ authorAffiliation: { badgeUrl: 'https://pbs.twimg.com/b_unnamed.jpg' } })
    )
    expect(badge()?.getAttribute('alt')).toBe('Affiliated organization')
  })

  it('renders nothing without an affiliation, or until the image resolves', async () => {
    await render(message())
    expect(badge()).toBeNull()

    cacheChatAvatar.mockResolvedValueOnce(null as unknown as string)
    await render(
      message({ authorAffiliation: { badgeUrl: 'https://pbs.twimg.com/b_unresolved.jpg' } })
    )
    expect(badge()).toBeNull()
  })
})
