import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { BackendClient } from '@/backendClient'
import type { YouTubeThumbnailResult } from '@/lib/backend'
import {
  publishChatNeedsSignIn,
  publishChatNotConnected,
  publishDiscordFailure,
  publishSignInExpired,
  publishStreamKeyMigration,
  publishStreamOutputAdjusted,
  publishXBroadcastProblem,
  publishXPlayback,
  publishXStartBroadcast,
  publishYouTubeBroadcastProblem,
  publishYouTubeBudget,
  publishYouTubeThumbnailFailure,
  resolveChatNotConnected,
  resolveSignedIn
} from '@/lib/notifications/sources/platforms'
import { createNotificationStore, type NotificationStore } from '@/lib/notifications/store'

describe('platforms as notifications (plan 250 S6)', () => {
  let store: NotificationStore
  let live = false
  const door = { show: vi.fn(), resolved: vi.fn(), dismiss: vi.fn() }
  const entry = (key: string) => store.snapshot().find((item) => item.key === key)

  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    live = false
    store = createNotificationStore({ live: () => live })
    store.setPopUpDoor(door)
  })

  describe('chat', () => {
    it("a chat that didn't connect is one entry per destination, and resolves when it does", () => {
      publishChatNotConnected(
        { id: 'tw-1', message: 'Twitch refused the chat token.' },
        'Twitch',
        store
      )
      publishChatNotConnected(
        { id: 'tw-1', message: 'Twitch refused the chat token.' },
        'Twitch',
        store
      )
      expect(store.snapshot()).toHaveLength(1)
      expect(entry('chat:tw-1')).toMatchObject({
        state: 'open',
        tone: 'warning',
        title: "Twitch chat isn't connected",
        detail: 'Twitch refused the chat token.',
        actions: [{ label: 'Open Destinations', kind: 'door' }]
      })
      resolveChatNotConnected('tw-1', 'Twitch', store)
      expect(entry('chat:tw-1')).toMatchObject({
        state: 'resolved',
        title: 'Twitch chat is connected'
      })
    })
  })

  // Plan 215 A3 and A5 (D7): the Videorc sign-in, named. A streamer read
  // "Sign in to your Videorc account" as an X failure and was sent to
  // Destinations, where X looked fine; Sign in is the fix, so it is the button.
  describe('the Videorc sign-in', () => {
    it('names the account with Sign in as the fix, never Open Destinations', () => {
      publishChatNeedsSignIn('X', store)
      publishChatNeedsSignIn('Kick', store)
      expect(entry('chat-sign-in:X')).toMatchObject({
        title: 'X chat needs your Videorc sign-in',
        detail: 'Your stream is fine. Sign in to read chat.',
        actions: [{ id: 'sign-in', label: 'Sign in', kind: 'fix' }]
      })
      expect(entry('chat-sign-in:Kick')?.title).toBe('Kick chat needs your Videorc sign-in')
    })

    it('says when the server signed the desktop out, and resolves on the next sign-in', () => {
      publishSignInExpired(store)
      publishChatNeedsSignIn('X', store)
      expect(entry('account-session')).toMatchObject({
        title: 'Your Videorc sign-in expired',
        detail: 'Sign in again.',
        actions: [{ label: 'Sign in' }]
      })
      resolveSignedIn(['X', 'Kick'], store)
      expect(entry('account-session')?.state).toBe('resolved')
      expect(entry('chat-sign-in:X')?.state).toBe('resolved')
      expect(store.snapshot()).toHaveLength(2)
    })
  })

  describe('X', () => {
    const target = { id: 'x-1', label: 'X' }

    it('a broadcast step that failed warns in plain words, never with the raw text', () => {
      publishXBroadcastProblem('start', target, new Error('HTTP 503 {"errors":[]}'), store)
      expect(entry('x-broadcast-start:x-1')).toMatchObject({
        tone: 'warning',
        title: "Couldn't start the X broadcast",
        detail: 'Try again. If it keeps happening, export a support bundle from Health.'
      })
      publishXBroadcastProblem('end', target, new Error('HTTP 500'), store)
      expect(entry('x-broadcast-end:x-1')).toMatchObject({
        title: "Couldn't end the X broadcast",
        detail: 'End it in X Media Studio.',
        actions: [{ label: 'Open Media Studio' }]
      })
      publishXBroadcastProblem('chat', target, new Error('chat 401'), store)
      expect(entry('chat:x-1')).toMatchObject({
        title: "X chat isn't connected for X",
        actions: [{ label: 'Open Destinations' }]
      })
    })

    it('"start the broadcast on X" is a step of Go Live: it pops up while live and quiet', () => {
      live = true
      publishXStartBroadcast(store)
      expect(entry('x-start-broadcast')).toMatchObject({
        tone: 'news',
        title: 'X feed is connected: start the broadcast on X',
        actions: [{ label: 'Open Media Studio' }]
      })
      expect(door.show).toHaveBeenCalledTimes(1)
      expect(door.show.mock.calls[0][1]).toBe(8_000)
    })

    it('the next Go Live raises the reminder again: unread, and it pops up', () => {
      live = true
      publishXStartBroadcast(store)
      store.markRead('x-start-broadcast')
      publishXStartBroadcast(store)
      expect(store.snapshot()).toHaveLength(1)
      expect(entry('x-start-broadcast')).toMatchObject({ read: false, occurrences: 2 })
      expect(door.show).toHaveBeenCalledTimes(2)
    })

    it('playback is one subject: preparing, then viewers can watch', () => {
      publishXPlayback({ status: 'pending', shareUrl: 'https://x.com/i/broadcasts/1' }, store)
      expect(entry('x-playback')).toMatchObject({
        state: 'open',
        tone: 'warning',
        title: 'X is still preparing your stream'
      })
      publishXPlayback({ status: 'verified', shareUrl: 'https://x.com/i/broadcasts/1' }, store)
      expect(store.snapshot()).toHaveLength(1)
      expect(entry('x-playback')).toMatchObject({
        state: 'resolved',
        title: 'Viewers can watch your X broadcast'
      })
    })

    it('"viewers can watch" with nothing wrong is the late answer to Go Live', () => {
      live = true
      publishXPlayback({ status: 'verified', shareUrl: 'https://x.com/i/broadcasts/1' }, store)
      expect(entry('x-live')).toMatchObject({
        tone: 'done',
        title: 'Viewers can watch your X broadcast',
        detail: 'https://x.com/i/broadcasts/1'
      })
      expect(door.show).toHaveBeenCalledTimes(1)
    })

    it('X ending the broadcast is urgent', () => {
      live = true
      publishXPlayback({ status: 'unavailable', shareUrl: '' }, store)
      expect(entry('x-playback')).toMatchObject({
        state: 'open',
        tone: 'urgent',
        title: 'X ended your broadcast'
      })
      expect(door.show.mock.calls[0][1]).toBe(15_000)
    })
  })

  describe('YouTube and Discord', () => {
    it('a broadcast step, the budget and a Discord post each have their entry', () => {
      publishYouTubeBroadcastProblem(
        'start',
        { id: 'yt-1' },
        { title: "Couldn't start the YouTube broadcast", description: 'YouTube said no.' },
        store
      )
      publishYouTubeBudget('paused', { title: 'YouTube is paused until tomorrow' }, store)
      publishYouTubeBudget('paused', { title: 'YouTube is paused until tomorrow' }, store)
      publishDiscordFailure(
        { title: "Couldn't post to Discord", description: 'Paste a new webhook.' },
        store
      )
      expect(entry('youtube-broadcast-start:yt-1')).toMatchObject({
        tone: 'warning',
        actions: [{ label: 'Open Destinations' }]
      })
      // One quiet notice per step, never counted and never a pop-up.
      expect(entry('youtube-budget:paused')).toMatchObject({ tone: 'news', occurrences: 1 })
      expect(entry('discord-announce')).toMatchObject({
        tone: 'warning',
        title: "Couldn't post to Discord",
        actions: [{ label: 'Open Destinations' }]
      })
      expect(store.snapshot()).toHaveLength(3)
    })

    const failure: YouTubeThumbnailResult = {
      platform: 'youtube',
      accountId: 'acct',
      broadcastId: 'b1',
      targetId: 'youtube',
      state: 'error',
      code: 'forbidden',
      message: 'YouTube refused the thumbnail.',
      retryable: true
    }

    it('a thumbnail warns once per broadcast, and a retry that works resolves it silently', async () => {
      const request = vi.fn(async () => ({ ...failure, state: 'uploaded' }))
      const client = { request } as unknown as BackendClient
      publishYouTubeThumbnailFailure(client, failure, store)
      publishYouTubeThumbnailFailure(client, failure, store)
      expect(store.snapshot()).toHaveLength(1)
      expect(entry('youtube-thumbnail:b1')).toMatchObject({
        state: 'open',
        title: 'Thumbnail not set on YouTube',
        detail: 'YouTube refused the thumbnail.',
        actions: [{ id: 'retry', label: 'Retry', kind: 'fix' }]
      })
      await store.runAction('youtube-thumbnail:b1', 'retry')
      expect(request).toHaveBeenCalledWith('streamTargets.youtube.thumbnail.retry', {
        accountId: 'acct',
        broadcastId: 'b1',
        targetId: 'youtube'
      })
      expect(entry('youtube-thumbnail:b1')).toMatchObject({
        state: 'resolved',
        title: 'Thumbnail set on YouTube'
      })
    })

    it('a retry that fails again keeps the entry, with why', async () => {
      const client = {
        request: vi.fn(async () => {
          throw new Error('offline')
        })
      } as unknown as BackendClient
      publishYouTubeThumbnailFailure(client, failure, store)
      await store.runAction('youtube-thumbnail:b1', 'retry')
      expect(entry('youtube-thumbnail:b1')).toMatchObject({
        state: 'open',
        title: 'Thumbnail not set on YouTube',
        actions: [{ label: 'Retry' }]
      })
    })

    it('offers no Retry at the daily limit', () => {
      publishYouTubeThumbnailFailure(
        { request: vi.fn() } as unknown as BackendClient,
        { ...failure, code: 'uploadRateLimitExceeded', retryable: false },
        store
      )
      expect(entry('youtube-thumbnail:b1')?.actions).toEqual([])
    })
  })

  describe("Go Live's own notes", () => {
    it('a stream key to save again and an adjusted output', () => {
      live = true
      publishStreamKeyMigration('Twitch', 'tw-1', store)
      publishStreamOutputAdjusted(
        { title: 'Streaming at 1080p30', description: 'Twitch takes 1080p at most.' },
        store
      )
      expect(entry('stream-key-migration:tw-1')).toMatchObject({
        tone: 'warning',
        title: 'Save your Twitch stream key again',
        actions: [{ label: 'Open Destinations' }]
      })
      expect(entry('stream-output-adjusted')).toMatchObject({
        tone: 'news',
        title: 'Streaming at 1080p30'
      })
      // The output note answers Go Live, so it shows; the key notice waits.
      expect(door.show).toHaveBeenCalledTimes(1)
      expect(door.show.mock.calls[0][0]).toMatchObject({ key: 'stream-output-adjusted' })
    })
  })
})
