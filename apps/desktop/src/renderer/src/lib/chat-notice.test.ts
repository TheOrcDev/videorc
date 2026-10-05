import { describe, expect, it } from 'vitest'

import { noticeViewerWords } from '@/lib/chat-notice'

describe('noticeViewerWords (plan 151, D3)', () => {
  const notice = {
    rawProviderType: 'channel.chat.notification:watch_streak',
    messageText: 'Snowy77x watched 20 consecutive streams and sparked a watch streak!',
    fragments: [{ type: 'text', text: 'welcome back hands <3' }]
  }

  it("returns the viewer's words beside Twitch's sentence", () => {
    expect(noticeViewerWords(notice)).toBe('welcome back hands <3')
  })

  it('joins emote and text fragments into one line', () => {
    expect(
      noticeViewerWords({
        ...notice,
        fragments: [
          { type: 'emote', text: 'Kappa', imageUrl: 'https://static-cdn.jtvnw.net/e/1' },
          { type: 'text', text: ' see you ' }
        ]
      })
    ).toBe('Kappa see you')
  })

  it('is undefined without words, for announcements, and for plain chat', () => {
    expect(noticeViewerWords({ ...notice, fragments: [] })).toBeUndefined()
    expect(
      noticeViewerWords({ ...notice, fragments: [{ type: 'text', text: '  ' }] })
    ).toBeUndefined()
    expect(
      noticeViewerWords({
        ...notice,
        rawProviderType: 'channel.chat.notification:announcement',
        details: { kind: 'announcement' }
      })
    ).toBeUndefined()
    expect(
      noticeViewerWords({ ...notice, rawProviderType: 'channel.chat.message' })
    ).toBeUndefined()
    // The words already are the row's text: nothing to add.
    expect(noticeViewerWords({ ...notice, messageText: 'welcome back hands <3' })).toBeUndefined()
  })
})
