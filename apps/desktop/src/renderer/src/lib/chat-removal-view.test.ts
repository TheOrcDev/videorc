import { describe, expect, it } from 'vitest'

import type { LiveChatMessage, ModerationOperation } from './backend'
import {
  HIDDEN_IN_VIDEORC_DETAIL,
  REMOVAL_CARD_TITLE,
  REMOVAL_RESULT_VISIBLE_MS,
  REMOVAL_STATUS_LABELS,
  REMOVE_FROM_CHAT_LABEL,
  YOUTUBE_CONFIRM_NOTE,
  removalCardView,
  removalOutcomeToast,
  removalPaneView,
  removalResultView,
  removalStatusView,
  removalToastView,
  removeFromChatAvailable,
  secondsUntil
} from './chat-removal-view'

const NOW = Date.parse('2026-10-04T12:00:10Z')
const HIDDEN_TWITCH =
  'Hidden in Videorc. Viewers on Twitch still see it. Reconnect Twitch to let Buddy remove messages.'

function operation(patch: Partial<ModerationOperation> = {}): ModerationOperation {
  return {
    operationId: 'op-1',
    sessionId: 'session-1',
    messageId: 'session-1:twitch:default:m-1',
    platform: 'twitch',
    authorName: 'coders_x',
    excerpt: 'this stream is trash',
    source: 'orcle-voice',
    phase: 'pending-confirm',
    confirmMode: 'confirm',
    requiresExplicitConfirm: true,
    confirmBy: '2026-10-04T12:00:28Z',
    createdAt: '2026-10-04T12:00:08Z',
    updatedAt: '2026-10-04T12:00:08Z',
    ...patch
  }
}

function row(overrides: Partial<LiveChatMessage> = {}): LiveChatMessage {
  return {
    id: 'session-1:twitch:default:m-1',
    providerMessageId: 'm-1',
    platform: 'twitch',
    sessionId: 'session-1',
    authorName: 'coders_x',
    authorBadges: [],
    authorRoles: [],
    publishedAt: '2026-10-04T12:00:00Z',
    receivedAt: '2026-10-04T12:00:00Z',
    messageText: 'this stream is trash',
    fragments: [],
    eventType: 'message',
    isDeleted: false,
    ...overrides
  }
}

const removedRow = row({
  isDeleted: true,
  eventType: 'deleted',
  messageText: 'Removed by you',
  rawProviderType: 'videorc.removed'
})
const hiddenRow = row({
  isDeleted: true,
  eventType: 'deleted',
  messageText: 'Hidden in Videorc',
  rawProviderType: 'videorc.hidden'
})

describe('the copy (plan 140, S6)', () => {
  it('matches the web guide, plain and in sentence case', () => {
    expect(REMOVE_FROM_CHAT_LABEL).toBe('Remove from chat')
    expect(REMOVAL_STATUS_LABELS).toEqual({
      removing: 'Removing…',
      removed: 'Removed',
      hidden: 'Hidden in Videorc',
      failed: 'Not removed',
      unknown: 'Unconfirmed'
    })
    expect(YOUTUBE_CONFIRM_NOTE).toBe('YouTube asks you to confirm.')
    for (const line of [
      REMOVE_FROM_CHAT_LABEL,
      REMOVAL_CARD_TITLE,
      YOUTUBE_CONFIRM_NOTE,
      HIDDEN_IN_VIDEORC_DETAIL,
      ...Object.values(REMOVAL_STATUS_LABELS)
    ]) {
      expect(line).not.toContain('—')
      expect(line).not.toMatch(/co-?host/i)
    }
  })
})

describe('removalStatusView: the row chip', () => {
  it('says nothing for a row nobody removed', () => {
    expect(removalStatusView(row())).toBeNull()
    expect(
      removalStatusView(row({ isDeleted: true, rawProviderType: 'channel.chat.message_delete' }))
    ).toBeNull()
    // An open card is its own surface; a cancelled or expired one changed nothing.
    for (const phase of ['pending-confirm', 'cancelled', 'expired'] as const) {
      expect(removalStatusView(row(), operation({ phase }))).toBeNull()
    }
  })

  it('shows Removing… while it runs, or while the request is on its way', () => {
    expect(removalStatusView(row(), operation({ phase: 'executing' }))).toEqual({
      kind: 'removing',
      label: 'Removing…',
      detail: null
    })
    expect(removalStatusView(row(), undefined, true)?.label).toBe('Removing…')
  })

  it('trusts the tombstone: Removed, or Hidden in Videorc with the reason', () => {
    expect(removalStatusView(removedRow)?.label).toBe('Removed')
    expect(
      removalStatusView(
        removedRow,
        operation({ phase: 'removed', outcome: 'Removed from Twitch.' })
      )
    ).toEqual({ kind: 'removed', label: 'Removed', detail: 'Removed from Twitch.' })
    expect(
      removalStatusView(hiddenRow, operation({ phase: 'hidden-locally', outcome: HIDDEN_TWITCH }))
    ).toEqual({ kind: 'hidden', label: 'Hidden in Videorc', detail: HIDDEN_TWITCH })
    // Without the operation (older than the relayed list) the tooltip still warns.
    expect(removalStatusView(hiddenRow)?.detail).toBe(HIDDEN_IN_VIDEORC_DETAIL)
  })

  it('shows the outcome before the tombstone lands', () => {
    expect(removalStatusView(row(), operation({ phase: 'removed' }))?.kind).toBe('removed')
    expect(
      removalStatusView(row(), operation({ phase: 'hidden-locally', outcome: HIDDEN_TWITCH }))
    ).toEqual({ kind: 'hidden', label: 'Hidden in Videorc', detail: HIDDEN_TWITCH })
  })

  it('keeps a failure and an unknown outcome quiet, with the reason on hover', () => {
    expect(
      removalStatusView(row(), operation({ phase: 'failed', outcome: 'Twitch refused it.' }))
    ).toEqual({ kind: 'failed', label: 'Not removed', detail: 'Twitch refused it.' })
    const unknown = 'Twitch did not answer in time. Check chat to see whether it was removed.'
    expect(
      removalStatusView(row(), operation({ phase: 'delivery-unknown', outcome: unknown }))
    ).toEqual({ kind: 'unknown', label: 'Unconfirmed', detail: unknown })
  })
})

describe('removeFromChatAvailable: the row menu', () => {
  it('offers a removable row with nothing in flight, and a retry after a failure', () => {
    expect(removeFromChatAvailable(row())).toBe(true)
    for (const phase of ['failed', 'delivery-unknown', 'cancelled', 'expired'] as const) {
      expect(removeFromChatAvailable(row(), operation({ phase }))).toBe(true)
    }
  })

  it('never while one is open, in flight, or for a row that cannot be removed', () => {
    expect(removeFromChatAvailable(row(), operation({ phase: 'pending-confirm' }))).toBe(false)
    expect(removeFromChatAvailable(row(), operation({ phase: 'executing' }))).toBe(false)
    expect(removeFromChatAvailable(row(), undefined, true)).toBe(false)
    expect(removeFromChatAvailable(removedRow)).toBe(false)
    expect(removeFromChatAvailable(row({ authorRoles: ['owner'] }))).toBe(false)
    expect(removeFromChatAvailable(row({ eventType: 'follow' }))).toBe(false)
    expect(removeFromChatAvailable(row({ rawProviderType: 'channel.chat.notification.sub' }))).toBe(
      false
    )
  })
})

describe('removalCardView: Buddy removal cards', () => {
  it('confirm first: Remove, then Cancel, and the time left to answer', () => {
    expect(removalCardView(operation({ reason: 'toxic' }), NOW)).toEqual({
      operationId: 'op-1',
      platform: 'twitch',
      platformLabel: 'Twitch',
      authorName: 'coders_x',
      excerpt: 'this stream is trash',
      reason: 'toxic',
      mode: 'confirm',
      title: 'Remove from chat?',
      timer: 'Expires in 18s',
      note: null,
      busy: false,
      primary: 'confirm',
      confirmLabel: 'Remove'
    })
    expect(removalCardView(operation({ confirmBy: '2026-10-04T12:00:10Z' }), NOW)?.timer).toBe(
      'Expiring…'
    )
  })

  it('countdown: Removing in Ns, Cancel first, then Remove now', () => {
    const card = removalCardView(
      operation({
        confirmMode: 'countdown',
        requiresExplicitConfirm: false,
        confirmBy: undefined,
        executeAt: '2026-10-04T12:00:13Z'
      }),
      NOW
    )
    expect(card).toMatchObject({
      mode: 'countdown',
      title: 'Removing in 3s',
      timer: null,
      primary: 'cancel',
      confirmLabel: 'Remove now',
      busy: false
    })
  })

  it('YouTube: always confirm first, and says why', () => {
    const card = removalCardView(
      operation({
        platform: 'youtube',
        confirmMode: 'countdown',
        requiresExplicitConfirm: true,
        confirmBy: '2026-10-04T12:00:30Z'
      }),
      NOW
    )
    expect(card).toMatchObject({
      mode: 'confirm',
      title: 'Remove from chat?',
      timer: 'Expires in 20s',
      note: 'YouTube asks you to confirm.',
      primary: 'confirm',
      platformLabel: 'YouTube'
    })
  })

  it('waits while running or answering, and never exists for a manual removal', () => {
    expect(removalCardView(operation({ phase: 'executing' }), NOW)).toMatchObject({
      title: 'Removing…',
      busy: true,
      timer: null
    })
    expect(removalCardView(operation(), NOW, true)?.busy).toBe(true)
    expect(removalCardView(operation({ source: 'manual', phase: 'executing' }), NOW)).toBeNull()
    expect(removalCardView(operation({ phase: 'removed' }), NOW)).toBeNull()
  })

  it('counts whole seconds and never below zero', () => {
    expect(secondsUntil('2026-10-04T12:00:12.200Z', NOW)).toBe(3)
    expect(secondsUntil('2026-10-04T11:59:00Z', NOW)).toBe(0)
    expect(secondsUntil(undefined, NOW)).toBeNull()
    expect(secondsUntil('not a time', NOW)).toBeNull()
  })
})

describe('removalResultView and removalPaneView: the brief result', () => {
  it('replaces a finished card with its outcome for a few seconds', () => {
    const removed = operation({
      phase: 'removed',
      outcome: 'Removed from Twitch.',
      updatedAt: '2026-10-04T12:00:09Z'
    })
    expect(removalResultView(removed, NOW)).toEqual({
      operationId: 'op-1',
      platform: 'twitch',
      authorName: 'coders_x',
      text: 'Removed from Twitch.'
    })
    expect(removalResultView(removed, NOW + REMOVAL_RESULT_VISIBLE_MS)).toBeNull()
    expect(
      removalResultView(operation({ phase: 'expired', updatedAt: '2026-10-04T12:00:09Z' }), NOW)
        ?.text
    ).toBe('No answer. Nothing was removed.')
    expect(removalResultView(operation({ source: 'manual', phase: 'removed' }), NOW)).toBeNull()
  })

  it('lists cards oldest first and results newest first', () => {
    const view = removalPaneView(
      [
        operation({ operationId: 'b', createdAt: '2026-10-04T12:00:09Z' }),
        operation({ operationId: 'a', createdAt: '2026-10-04T12:00:05Z' }),
        operation({
          operationId: 'done',
          phase: 'cancelled',
          outcome: 'Cancelled. Nothing was removed.',
          updatedAt: '2026-10-04T12:00:09Z'
        })
      ],
      NOW,
      new Set(['b'])
    )
    expect(view.cards.map((card) => [card.operationId, card.busy])).toEqual([
      ['a', false],
      ['b', true]
    ])
    expect(view.results.map((result) => result.text)).toEqual(['Cancelled. Nothing was removed.'])
    expect(view.active).toBe(true)
    expect(removalPaneView([], NOW).active).toBe(false)
  })
})

describe('removalToastView: the main window mirrors an open card', () => {
  it('confirm first: who, where, the words, and Remove or Cancel', () => {
    expect(removalToastView(operation({ reason: 'toxic' }), NOW)).toEqual({
      title: "Remove coders_x's message?",
      description: 'Twitch: “this stream is trash” Reason: toxic. Expires in 18s.',
      action: { label: 'Remove', answer: 'confirm' },
      secondary: { label: 'Cancel', answer: 'cancel' }
    })
  })

  it('countdown: Cancel is the primary escape', () => {
    expect(
      removalToastView(
        operation({
          confirmMode: 'countdown',
          requiresExplicitConfirm: false,
          confirmBy: undefined,
          executeAt: '2026-10-04T12:00:14Z'
        }),
        NOW
      )
    ).toEqual({
      title: "Removing coders_x's message in 4s",
      description: 'Twitch: “this stream is trash”',
      action: { label: 'Cancel', answer: 'cancel' },
      secondary: { label: 'Remove now', answer: 'confirm' }
    })
  })

  it('YouTube says why it asks, and only open cards are mirrored', () => {
    expect(removalToastView(operation({ platform: 'youtube' }), NOW)?.description).toContain(
      'YouTube asks you to confirm.'
    )
    expect(removalToastView(operation({ phase: 'executing' }), NOW)).toBeNull()
  })
})

describe('removalOutcomeToast', () => {
  it('always speaks when viewers may still see the message', () => {
    expect(
      removalOutcomeToast(operation({ phase: 'hidden-locally', outcome: HIDDEN_TWITCH }), {
        includeSuccess: false
      })
    ).toEqual({ kind: 'warning', text: HIDDEN_TWITCH })
    expect(
      removalOutcomeToast(operation({ phase: 'failed', outcome: 'Twitch refused it.' }), {
        includeSuccess: false
      })
    ).toEqual({ kind: 'error', text: 'Twitch refused it.' })
    expect(
      removalOutcomeToast(operation({ phase: 'delivery-unknown' }), { includeSuccess: false })?.kind
    ).toBe('warning')
  })

  it('says a plain success or expiry only where nothing else shows it, never a cancel', () => {
    const removed = operation({ phase: 'removed', outcome: 'Removed from Twitch.' })
    expect(removalOutcomeToast(removed, { includeSuccess: false })).toBeNull()
    expect(removalOutcomeToast(removed, { includeSuccess: true })).toEqual({
      kind: 'success',
      text: 'Removed from Twitch.'
    })
    expect(
      removalOutcomeToast(operation({ phase: 'expired' }), { includeSuccess: true })?.kind
    ).toBe('message')
    expect(
      removalOutcomeToast(operation({ phase: 'cancelled' }), { includeSuccess: true })
    ).toBeNull()
  })
})
