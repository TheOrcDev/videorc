import { describe, expect, it } from 'vitest'
import type { SessionChatTotals } from './backend'
import {
  validateBackendEventPayload,
  validateBackendRpcParams,
  validateBackendRpcResult
} from './backend-rpc-contract'
import { validateElectronEventPayload, validateElectronInvokeArgs } from './electron-ipc-contract'
import {
  emptyLiveDashboardState,
  normalizeLiveDashboardState,
  reduceDashboardChatTotals,
  reduceDashboardRecording
} from './live-dashboard'
import { sessionChatTotalsSchema } from './session-chat-totals'

const totals: SessionChatTotals = {
  status: 'available',
  sessionId: 's',
  revision: 6003,
  messageCount: 6003,
  chatters: 6002,
  platforms: ['twitch', 'youtube', 'x'],
  follows: 0,
  supporters: 1,
  bits: 1500,
  tips: [{ currency: 'USD', amountMicros: 20_000_000 }],
  raids: 0
}

describe('durable whole-session chat totals contract', () => {
  it('carries bounded accounting facts through RPC and backend events', () => {
    expect(validateBackendRpcParams('sessions.comments.totals', { sessionId: 's' })).toEqual({
      sessionId: 's'
    })
    expect(validateBackendRpcResult('sessions.comments.totals', totals)).toEqual(totals)
    expect(validateBackendEventPayload('liveChat.totals', totals)).toEqual(totals)
    expect(validateBackendRpcResult('sessions.comments.totals', null)).toBeNull()
  })
  it('uses the exact identifier/currency UTF-16 bounds on every new transport', () => {
    const multibyte = {
      ...totals,
      sessionId: '😀'.repeat(2048),
      tips: [{ currency: '😀'.repeat(32), amountMicros: 1 }]
    }
    expect(
      validateBackendRpcParams('sessions.comments.totals', { sessionId: multibyte.sessionId })
    ).toEqual({ sessionId: multibyte.sessionId })
    expect(sessionChatTotalsSchema.parse(multibyte)).toEqual(multibyte)
    for (const params of [
      { sessionId: '' },
      { sessionId: 'x'.repeat(4097) },
      { sessionId: '😀'.repeat(2049) },
      { sessionId: 's', unknown: true }
    ])
      expect(() => validateBackendRpcParams('sessions.comments.totals', params)).toThrow()
    expect(() =>
      sessionChatTotalsSchema.parse({
        ...totals,
        tips: [{ currency: '😀'.repeat(33), amountMicros: 1 }]
      })
    ).toThrow()
  })

  it('carries explicit unavailable history without fabricated numeric totals', () => {
    const legacy = { status: 'legacy-unavailable', sessionId: 'old' }
    expect(sessionChatTotalsSchema.parse(legacy)).toEqual(legacy)
    expect(() => sessionChatTotalsSchema.parse({ ...legacy, supporters: 1 })).toThrow()
  })
  it.each([NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, null])(
    'rejects unsafe or missing numeric facts (%s)',
    (revision) => {
      expect(() =>
        validateBackendEventPayload('liveChat.totals', { ...totals, revision })
      ).toThrow()
      expect(() =>
        validateBackendRpcResult('sessions.comments.totals', { ...totals, revision })
      ).toThrow()
    }
  )
  it('rejects unbounded, repeated and unknown facts', () => {
    for (const value of [
      { ...totals, messages: [] },
      { ...totals, sessionId: '' },
      { ...totals, platforms: ['twitch', 'twitch'] },
      { ...totals, platforms: ['unknown'] },
      {
        ...totals,
        tips: Array.from({ length: 257 }, (_, index) => ({
          currency: `C${index}`,
          amountMicros: 1
        }))
      },
      {
        ...totals,
        tips: [
          { currency: 'USD', amountMicros: 1 },
          { currency: 'USD', amountMicros: 2 }
        ]
      },
      { ...totals, tips: [{ currency: 'x'.repeat(65), amountMicros: 1 }] }
    ])
      expect(() => sessionChatTotalsSchema.parse(value)).toThrow()
  })
  it('validates IPC/cache ownership and never lets totals establish or rewind a session', () => {
    const empty = emptyLiveDashboardState('now')
    expect(reduceDashboardChatTotals(empty, totals, 'now')).toBe(empty)
    const current = reduceDashboardRecording(empty, { state: 'recording', sessionId: 's' }, 'now')
    const advanced = reduceDashboardChatTotals(current, totals, 'now')
    expect(reduceDashboardChatTotals(advanced, { ...totals, revision: 1 }, 'later')).toBe(advanced)
    expect(reduceDashboardChatTotals(advanced, { ...totals, sessionId: 'other' }, 'later')).toBe(
      advanced
    )
    expect(validateElectronInvokeArgs('comments-window:dashboard-push', [advanced])).toEqual([
      advanced
    ])
    expect(validateElectronEventPayload('comments-window:dashboard', advanced)).toEqual(advanced)
    const wrong = { ...advanced, chatTotals: { ...totals, sessionId: 'other' } }
    expect(normalizeLiveDashboardState(wrong)).toBeNull()
    expect(() => validateElectronInvokeArgs('comments-window:dashboard-push', [wrong])).toThrow()
    expect(() =>
      validateElectronEventPayload('comments-window:dashboard', {
        ...advanced,
        chatTotals: { ...totals, revision: -1 }
      })
    ).toThrow()
  })
  it('rejects a historical total belonging to another selected view', () => {
    const view = {
      mode: { kind: 'history', sessionId: 's', title: 'Stream', startedAt: 'now' },
      snapshot: { sessionId: 's', messages: [], providers: [], unreadCount: 0, updatedAt: 'now' },
      history: { viewers: [], audience: null, chatTotals: totals }
    }
    expect(validateElectronEventPayload('comments-window:snapshot', view)).toEqual(view)
    expect(() =>
      validateElectronEventPayload('comments-window:snapshot', {
        ...view,
        history: { ...view.history, chatTotals: { ...totals, sessionId: 'other' } }
      })
    ).toThrow()
  })
})
