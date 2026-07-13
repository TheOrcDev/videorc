import { describe, expect, expectTypeOf, it } from 'vitest'

import type {
  OAuthCallbackResult,
  OAuthCompleteParams,
  NoiseCleanupJob,
  SessionCommentsPage,
  SessionDeletionOperation
} from './backend'
import {
  parseBackendWireMessage,
  runtimeValidatedBackendRpcMethods,
  validateBackendEventPayload,
  validateBackendRpcParams,
  validateBackendRpcResult,
  type BackendEventMap,
  type BackendRpcParams,
  type BackendRpcResult
} from './backend-rpc-contract'

describe('backend RPC contract', () => {
  it('types and strictly validates Noise Cleanup commands and status events', () => {
    expectTypeOf<BackendRpcParams<'noiseCleanup.start'>>().toEqualTypeOf<{ sessionId: string }>()
    expectTypeOf<BackendRpcParams<'noiseCleanup.cancel'>>().toEqualTypeOf<{ jobId: string }>()
    expectTypeOf<BackendRpcResult<'noiseCleanup.list'>>().toEqualTypeOf<NoiseCleanupJob[]>()
    expectTypeOf<BackendEventMap['noiseCleanup.status']>().toEqualTypeOf<NoiseCleanupJob>()

    const job: NoiseCleanupJob = {
      id: 'cleanup-1',
      sourceSessionId: 'session-1',
      status: 'processing',
      progressPercent: 42,
      preset: 'speech-v1',
      createdAt: '2026-07-13T10:00:00.000Z',
      updatedAt: '2026-07-13T10:00:01.000Z'
    }

    expect(validateBackendRpcParams('noiseCleanup.start', { sessionId: 'session-1' })).toEqual({
      sessionId: 'session-1'
    })
    expect(validateBackendRpcResult('noiseCleanup.start', job)).toEqual(job)
    expect(validateBackendRpcResult('noiseCleanup.list', [job])).toEqual([job])
    expect(validateBackendEventPayload('noiseCleanup.status', job)).toEqual(job)

    expect(() =>
      validateBackendRpcParams('noiseCleanup.start', {
        sessionId: 'session-1',
        path: '/renderer-must-not-send-path.mp4'
      })
    ).toThrow('path must be a known field')
    for (const malformed of [
      { ...job, status: 'running' },
      { ...job, progressPercent: 42.5 },
      { ...job, progressPercent: 101 },
      { ...job, preset: 'speech-v2' },
      { ...job, status: 'completed', progressPercent: 100 },
      { ...job, status: 'failed', errorCode: undefined, errorMessage: undefined },
      { ...job, unexpected: true }
    ]) {
      expect(() => validateBackendEventPayload('noiseCleanup.status', malformed)).toThrow()
    }
  })

  it('strictly validates entitlement refresh results and update events', () => {
    const snapshot = {
      schemaVersion: 1,
      tier: 'premium',
      source: 'creem',
      capabilities: [
        { featureId: 'noise-cleanup', state: 'enabled' },
        { featureId: 'cloud-ai', state: 'enabled' }
      ],
      limits: {
        recording: { maxWidth: 3840, maxHeight: 2160, maxFps: 60 },
        streaming: {
          maxWidth: 3840,
          maxHeight: 2160,
          maxFps: 30,
          maxBitrateKbps: 30_000,
          maxDestinations: 3
        }
      },
      checkedAt: '2026-07-13T10:00:00.000Z'
    }

    expect(validateBackendRpcParams('entitlements.refresh', undefined)).toBeUndefined()
    expect(validateBackendRpcResult('entitlements.refresh', snapshot)).toEqual(snapshot)
    expect(validateBackendEventPayload('entitlements.updated', snapshot)).toEqual(snapshot)
    expect(() =>
      validateBackendEventPayload('entitlements.updated', {
        ...snapshot,
        capabilities: [{ featureId: 'noise-cleanup', state: 'maybe' }]
      })
    ).toThrow('state')
    expect(() =>
      validateBackendEventPayload('entitlements.updated', { ...snapshot, unexpected: true })
    ).toThrow('unexpected must be a known field')
    expect(() =>
      validateBackendEventPayload('entitlements.updated', {
        ...snapshot,
        limits: { ...snapshot.limits, recording: { maxWidth: 3840 } }
      })
    ).toThrow('maxHeight')
  })

  it('types and exactly validates provider OAuth callback completion', () => {
    expectTypeOf<
      BackendRpcParams<'platformAccounts.oauth.complete'>
    >().toEqualTypeOf<OAuthCompleteParams>()
    expectTypeOf<
      BackendRpcResult<'platformAccounts.oauth.complete'>
    >().toEqualTypeOf<OAuthCallbackResult>()

    const params: OAuthCompleteParams = {
      state: 'provider-state',
      code: 'single-use-code'
    }
    const result: OAuthCallbackResult = {
      platform: 'twitch',
      state: params.state,
      status: 'success',
      codePresent: true,
      tokenStored: true,
      accountConnected: true,
      retryable: false,
      receivedAt: '2026-07-12T00:00:00.000Z'
    }

    expect(validateBackendRpcParams('platformAccounts.oauth.complete', params)).toEqual(params)
    expect(validateBackendRpcResult('platformAccounts.oauth.complete', result)).toEqual(result)
    const unknownState: OAuthCallbackResult = {
      state: params.state,
      status: 'unknown-state',
      codePresent: true,
      message: 'OAuth state was not found.',
      tokenStored: false,
      accountConnected: false,
      retryable: false,
      receivedAt: '2026-07-12T00:00:00.000Z'
    }
    expect(validateBackendRpcResult('platformAccounts.oauth.complete', unknownState)).toEqual(
      unknownState
    )
    expect(() =>
      validateBackendRpcResult('platformAccounts.oauth.complete', {
        ...unknownState,
        platform: null
      })
    ).toThrow('platform')
    expect(() =>
      validateBackendRpcResult('platformAccounts.oauth.complete', {
        ...result,
        retryable: undefined
      })
    ).toThrow('retryable')
    expect(() =>
      validateBackendRpcResult('platformAccounts.oauth.complete', {
        ...result,
        retryable: 'yes'
      })
    ).toThrow('retryable')
    expect(() =>
      validateBackendRpcResult('platformAccounts.oauth.complete', {
        ...result,
        unexpected: true
      })
    ).toThrow('unexpected must be a known field')
  })

  it('types and exactly validates provider OAuth callback events', () => {
    expectTypeOf<
      BackendEventMap['platformAccounts.oauth.callback']
    >().toEqualTypeOf<OAuthCallbackResult>()

    const event: OAuthCallbackResult = {
      platform: 'youtube',
      state: 'provider-state',
      status: 'success',
      codePresent: true,
      tokenStored: true,
      accountConnected: true,
      retryable: false,
      receivedAt: '2026-07-12T00:00:00.000Z'
    }
    expect(validateBackendEventPayload('platformAccounts.oauth.callback', event)).toEqual(event)
    const xOAuth1Event: OAuthCallbackResult = {
      platform: 'x',
      state: '',
      status: 'success',
      codePresent: true,
      tokenStored: true,
      accountConnected: true,
      retryable: false,
      receivedAt: '2026-07-12T00:00:00.000Z'
    }
    expect(validateBackendEventPayload('platformAccounts.oauth.callback', xOAuth1Event)).toEqual(
      xOAuth1Event
    )
    expect(() =>
      validateBackendEventPayload('platformAccounts.oauth.callback', {
        ...xOAuth1Event,
        platform: 'twitch'
      })
    ).toThrow('state')
    expect(() =>
      validateBackendEventPayload('platformAccounts.oauth.callback', {
        ...event,
        retryable: undefined
      })
    ).toThrow('retryable')
    expect(() =>
      validateBackendEventPayload('platformAccounts.oauth.callback', {
        ...event,
        unexpected: true
      })
    ).toThrow('unexpected must be a known field')
  })

  it('types the durable two-phase delete protocol', () => {
    expectTypeOf<BackendRpcParams<'sessions.delete'>>().toEqualTypeOf<{
      sessionIds: string[]
    }>()
    expectTypeOf<BackendRpcResult<'sessions.delete'>>().toEqualTypeOf<SessionDeletionOperation[]>()
    expectTypeOf<BackendRpcResult<'sessions.delete.pending'>>().toEqualTypeOf<
      SessionDeletionOperation[]
    >()
    expect(
      validateBackendRpcResult('sessions.delete', [
        { operationId: 'op-1', sessionId: 'session-1', pathCount: 1, blockedPathCount: 0 }
      ])
    ).toEqual([{ operationId: 'op-1', sessionId: 'session-1', pathCount: 1, blockedPathCount: 0 }])
    expect(() =>
      validateBackendRpcParams('sessions.delete', {
        sessionIds: ['session-1'],
        deleteFiles: true
      })
    ).toThrow('deleteFiles must be a known field')
  })

  it('types and bounds cursor pagination for recorded comments', () => {
    expectTypeOf<BackendRpcResult<'sessions.comments.list'>>().toEqualTypeOf<SessionCommentsPage>()
    expect(
      validateBackendRpcParams('sessions.comments.list', {
        sessionId: 'session-1',
        cursor: 'cursor-1',
        limit: 200
      })
    ).toEqual({ sessionId: 'session-1', cursor: 'cursor-1', limit: 200 })
    expect(() =>
      validateBackendRpcParams('sessions.comments.list', {
        sessionId: 'session-1',
        limit: 1001
      })
    ).toThrow('less than or equal to 1000')
  })

  it('validates every destructive contract named in the runtime registry', () => {
    expect(runtimeValidatedBackendRpcMethods).toEqual(
      expect.arrayContaining([
        'account.complete_sign_in',
        'platformAccounts.oauth.complete',
        'session.start',
        'session.stop',
        'scene.layout.apply_preview',
        'scene.layout.apply_live',
        'sessions.delete',
        'sessions.delete.pending',
        'repair.repair_file'
      ])
    )
  })

  it('semantically rejects malformed preview state responses and events', () => {
    const surfaceStatus = {
      state: 'live',
      source: 'screen',
      transport: 'electron-proof-surface',
      backing: 'electron-browser-window',
      targetFps: 30,
      width: 1280,
      height: 720,
      framesRendered: 42,
      droppedFrames: 0,
      framePollingSuppressed: false,
      sourcePixelsPresent: true,
      pendingHostCommandCount: 0,
      updatedAt: '2026-07-12T00:00:00.000Z'
    }

    expect(validateBackendRpcResult('preview.surface.status', surfaceStatus)).toEqual(surfaceStatus)
    expect(validateBackendEventPayload('preview.surface.status', surfaceStatus)).toEqual(
      surfaceStatus
    )
    for (const malformed of [{}, null]) {
      expect(() => validateBackendRpcResult('preview.surface.status', malformed)).toThrow(
        'backend.preview.surface.status.result'
      )
      expect(() => validateBackendEventPayload('preview.surface.status', malformed)).toThrow(
        'backend.event.preview.surface.status'
      )
    }
  })

  it('accepts real diagnostic wire payloads without renderer-only timestamps', () => {
    const diagnostics = { skippedFrames: 0, droppedFrames: 2 }
    expect(validateBackendRpcResult('diagnostics.stats', diagnostics)).toEqual(diagnostics)
    expect(validateBackendEventPayload('diagnostics.stats', diagnostics)).toEqual(diagnostics)
    expect(() => validateBackendRpcResult('diagnostics.stats', { skippedFrames: -1 })).toThrow(
      'diagnostics.stats'
    )
  })

  it('parses response and event envelopes before dispatch', () => {
    expect(parseBackendWireMessage('{"id":"1","ok":true,"payload":{"pong":true}}')).toEqual({
      id: '1',
      ok: true,
      payload: { pong: true }
    })
    expect(parseBackendWireMessage('{"event":"backend.ready","payload":null}')).toEqual({
      event: 'backend.ready',
      payload: null
    })
    expect(() => parseBackendWireMessage('{"id":"1","ok":"yes"}')).toThrow('backend.response.ok')
    expect(() => parseBackendWireMessage('{"id":"1","ok":true}')).toThrow(
      'backend.response.payload is required'
    )
    expect(() =>
      parseBackendWireMessage('{"event":"backend.ready","payload":null,"extra":true}')
    ).toThrow('backend.event.extra must be a known field')
    expect(() => parseBackendWireMessage('null')).toThrow('invalid websocket envelope')
  })

  it('bounds unregistered method and event payloads instead of passing arbitrary values', () => {
    expect(validateBackendRpcParams('screens.rename', { screenId: '1', name: 'Demo' })).toEqual({
      screenId: '1',
      name: 'Demo'
    })
    expect(validateBackendRpcParams('liveChat.status', undefined)).toBeUndefined()
    expect(validateBackendRpcResult('liveChat.status', { messages: [] })).toEqual({ messages: [] })
    expect(validateBackendEventPayload('backend.ready', null)).toBeNull()

    expect(() => validateBackendRpcParams('unknown.method', { bad: BigInt(1) })).toThrow(
      'JSON-compatible value'
    )
    expect(() => validateBackendRpcResult('unknown.method', undefined)).toThrow(
      'JSON-compatible value'
    )
    expect(() => validateBackendEventPayload('unknown.event', new Date())).toThrow(
      'plain JSON object'
    )
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => validateBackendRpcParams('unknown.method', cyclic)).toThrow('acyclic JSON value')
  })

  it('rejects oversized backend websocket envelopes before parsing JSON', () => {
    expect(() => parseBackendWireMessage(' '.repeat(16_000_001))).toThrow(
      'oversized websocket message'
    )
  })
})
