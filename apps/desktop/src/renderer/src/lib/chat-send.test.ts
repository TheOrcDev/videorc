import { describe, expect, it } from 'vitest'

import type { CommentsSendOperation, LiveChatProviderState } from '@/lib/backend'
import {
  CHAT_SEND_MAX_CHARS,
  chatSendFailures,
  chatSendRetryPlan,
  destinationDelivery,
  pendingCommentsSendOperation,
  sendablePlatforms,
  validateChatDraft
} from './chat-send'

const provider = (
  platform: LiveChatProviderState['platform'],
  state: LiveChatProviderState['state'],
  write: LiveChatProviderState['write'] = 'ready'
): LiveChatProviderState => ({ id: platform, platform, state, write }) as LiveChatProviderState

describe('sendablePlatforms', () => {
  it('uses backend write truth and de-duplicates platforms', () => {
    expect(
      sendablePlatforms([
        provider('youtube', 'connected'),
        provider('twitch', 'connected'),
        provider('x', 'connected', 'read-only'),
        provider('youtube', 'failed')
      ])
    ).toEqual(['youtube', 'twitch'])
  })

  it('keeps an independently writable destination sendable while its reader reconnects', () => {
    expect(sendablePlatforms([provider('twitch', 'reconnecting')])).toEqual(['twitch'])
  })
})

describe('chatSendFailures', () => {
  const operation = (
    destinations: CommentsSendOperation['destinations']
  ): CommentsSendOperation => ({
    id: 'operation-1',
    sessionId: 'session-1',
    text: 'hello',
    phase: 'partial',
    destinations,
    createdAt: 'now',
    updatedAt: 'now'
  })

  it('surfaces failed platforms with their reasons', () => {
    const failures = chatSendFailures(
      operation([
        { destinationId: 'youtube', platform: 'youtube', phase: 'sent' },
        {
          destinationId: 'twitch',
          platform: 'twitch',
          phase: 'failed',
          reason: 'Twitch rejected the send. Reconnect Twitch.'
        }
      ])
    )
    expect(failures).toEqual([
      {
        destinationId: 'twitch',
        platform: 'twitch',
        reason: 'Twitch rejected the send. Reconnect Twitch.'
      }
    ])
  })

  it('keeps read-only rows out of the failure list', () => {
    expect(
      chatSendFailures(
        operation([
          { destinationId: 'youtube', platform: 'youtube', phase: 'sent' },
          { destinationId: 'x', platform: 'x', phase: 'read-only', reason: 'Receive only.' }
        ])
      )
    ).toEqual([])
  })

  it('surfaces ambiguous timeouts without encouraging an automatic retry', () => {
    const value = operation([
      {
        destinationId: 'youtube',
        platform: 'youtube',
        phase: 'timed-out-unknown'
      }
    ])
    const failures = chatSendFailures(value)
    expect(failures).toHaveLength(1)
    expect(failures[0]!.reason).toMatch(/unknown/)
    expect(destinationDelivery(value, 'youtube')?.phase).toBe('timed-out-unknown')
  })
})

describe('pendingCommentsSendOperation', () => {
  it('shows every destination without inventing a successful local echo', () => {
    expect(
      pendingCommentsSendOperation({
        id: 'operation-1',
        sessionId: 'session-1',
        text: 'hello',
        now: 'now',
        providers: [
          provider('youtube', 'connected'),
          provider('twitch', 'connected', 'missing-scope'),
          provider('x', 'connected', 'read-only')
        ]
      })
    ).toMatchObject({
      phase: 'sending',
      destinations: [
        { platform: 'youtube', phase: 'pending' },
        { platform: 'twitch', phase: 'unavailable' },
        { platform: 'x', phase: 'read-only' }
      ]
    })
  })

  it('keeps write-ready destinations pending while their read connector reconnects', () => {
    expect(
      pendingCommentsSendOperation({
        id: 'operation-2',
        sessionId: 'session-1',
        text: 'still sending',
        now: 'now',
        providers: [provider('twitch', 'reconnecting')]
      })
    ).toMatchObject({
      phase: 'sending',
      destinations: [{ platform: 'twitch', phase: 'pending' }]
    })
  })
})

describe('validateChatDraft', () => {
  it('trims, rejects empty and over-long drafts', () => {
    expect(validateChatDraft('  hi  ')).toBe('hi')
    expect(validateChatDraft('   ')).toBeNull()
    expect(validateChatDraft('x'.repeat(CHAT_SEND_MAX_CHARS + 1))).toBeNull()
    expect(validateChatDraft('x'.repeat(CHAT_SEND_MAX_CHARS))).toHaveLength(CHAT_SEND_MAX_CHARS)
  })
})

describe('chatSendRetryPlan (plan 174 S3.16a, H-26)', () => {
  const operation = (
    destinations: CommentsSendOperation['destinations']
  ): CommentsSendOperation => ({
    id: 'op',
    sessionId: 's1',
    text: 'hello',
    phase: 'partial',
    destinations,
    createdAt: '2026-10-11T10:00:00Z',
    updatedAt: '2026-10-11T10:00:01Z'
  })

  it('is nothing without a failure', () => {
    expect(chatSendRetryPlan(null, [])).toBeNull()
  })

  it('restores the draft and retries everything when nobody got the message', () => {
    expect(
      chatSendRetryPlan(null, [
        { destinationId: 'comments-command', platform: 'custom', reason: 'x' }
      ])
    ).toEqual({ destinationIds: null, restoreDraft: true })
    const failed = operation([
      { destinationId: 'yt', platform: 'youtube', phase: 'failed', reason: 'no' },
      { destinationId: 'tw', platform: 'twitch', phase: 'failed', reason: 'no' }
    ])
    expect(chatSendRetryPlan(failed, chatSendFailures(failed))).toEqual({
      destinationIds: null,
      restoreDraft: true
    })
  })

  it('retries only the destinations that failed after a partial send', () => {
    const partial = operation([
      { destinationId: 'yt', platform: 'youtube', phase: 'sent' },
      { destinationId: 'tw', platform: 'twitch', phase: 'failed', reason: 'no' }
    ])
    expect(chatSendRetryPlan(partial, chatSendFailures(partial))).toEqual({
      destinationIds: ['tw'],
      restoreDraft: false
    })
  })
})
