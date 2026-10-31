import { readFileSync } from 'node:fs'

import { describe, expect, expectTypeOf, it } from 'vitest'

import { LIVE_BACKGROUND_DEFAULT_LOOKS, LIVE_BACKGROUND_IDS } from './live-background-ids'
import { STREAM_PLATFORMS } from './stream-platforms'

import type {
  Banner,
  CompositorStatus,
  DiagnosticStats,
  SceneEditorDraftAck,
  ScreenSwitchStatus,
  SceneEditorDraftParams,
  OAuthCallbackResult,
  OAuthCompleteParams,
  NoiseCleanupJob,
  SessionAiArtifactsPage,
  SessionCommentsPage,
  SessionDeletionOperation,
  SessionHealthEventsPage,
  SessionListPage,
  SessionLogsPage,
  SessionViewersPage,
  AudienceSnapshot,
  StreamOutputTopologyProbeParams,
  StreamOutputTopologyProbeResult,
  StreamTargetsSnapshot
} from './backend'
import {
  parseBackendWireMessage,
  runtimeValidatedBackendRpcMethods,
  validateMainOwnedPreviewSurfaceBoundsParams,
  validateBackendEventPayload,
  validateBackendRpcParams,
  validateBackendRpcResult,
  type BackendEventMap,
  type BackendRpcParams,
  type BackendRpcResult
} from './backend-rpc-contract'

const requiredCapturePressureDiagnosticFields = [
  'compositorSourceCaptureTextureReuses',
  'compositorCameraSourceCaptureTextureReuses',
  'compositorScreenSourceCaptureTextureReuses',
  'compositorSourceTextureCacheFlushes',
  'previewCameraCaptureCallbackCount',
  'previewCameraDidDropCallbackCount',
  'previewCameraFrameStorePublications',
  'previewCameraDropReasons',
  'previewCameraSurfaceBacking',
  'previewScreenCaptureCallbackCount',
  'previewScreenFrameStorePublications',
  'previewScreenFrameStatuses',
  'previewScreenSurfaceBacking'
] as const satisfies readonly (keyof DiagnosticStats)[]

const idleCapturePressureDiagnostics = {
  compositorSourceCaptureTextureReuses: 0,
  compositorCameraSourceCaptureTextureReuses: 0,
  compositorScreenSourceCaptureTextureReuses: 0,
  compositorSourceTextureCacheFlushes: 0,
  previewCameraCaptureCallbackCount: 0,
  previewCameraDidDropCallbackCount: 0,
  previewCameraFrameStorePublications: 0,
  previewCameraDropReasons: {
    frameWasLate: 0,
    outOfBuffers: 0,
    discontinuity: 0,
    unknown: 0
  },
  previewCameraSurfaceBacking: {
    liveCount: 0,
    peakCount: 0,
    estimatedBytes: 0,
    peakEstimatedBytes: 0
  },
  previewScreenCaptureCallbackCount: 0,
  previewScreenFrameStorePublications: 0,
  previewScreenFrameStatuses: {
    complete: 0,
    idle: 0,
    blank: 0,
    suspended: 0,
    started: 0,
    stopped: 0,
    unknown: 0
  },
  previewScreenSurfaceBacking: {
    liveCount: 0,
    peakCount: 0,
    estimatedBytes: 0,
    peakEstimatedBytes: 0
  }
} satisfies Pick<DiagnosticStats, (typeof requiredCapturePressureDiagnosticFields)[number]>

describe('backend RPC contract', () => {
  it('validates audio.levels and rejects malformed readings (plan 092 Phase C)', () => {
    const levels = {
      sessionId: 'session-1',
      microphone: { peakDb: -12.5, rmsDb: -20 },
      master: { peakDb: -1, rmsDb: -9 },
      masterClippedSamples: 3
    }
    expect(validateBackendEventPayload('audio.levels', levels)).toEqual(levels)
    // Gain can push the processed microphone past full scale.
    const hot = { ...levels, microphone: { peakDb: 25.5, rmsDb: 12 } }
    expect(validateBackendEventPayload('audio.levels', hot)).toEqual(hot)
    expect(
      validateBackendEventPayload('audio.levels', { sessionId: 's', masterClippedSamples: 0 })
    ).toEqual({ sessionId: 's', masterClippedSamples: 0 })
    // The standby microphone between sessions carries no session.
    const standby = { microphone: { peakDb: -30, rmsDb: -36 }, masterClippedSamples: 0 }
    expect(validateBackendEventPayload('audio.levels', standby)).toEqual(standby)
    for (const malformed of [
      { ...levels, sessionId: null },
      { ...levels, microphone: { peakDb: -12, rmsDb: -20, extra: 1 } },
      { ...levels, microphone: { peakDb: -200, rmsDb: -20 } },
      { ...levels, microphone: { peakDb: 60, rmsDb: -20 } },
      { ...levels, microphone: null },
      { ...levels, masterClippedSamples: -1 },
      { ...levels, unknown: true }
    ]) {
      expect(() => validateBackendEventPayload('audio.levels', malformed)).toThrow()
    }
  })

  it('accepts redacted recovery candidates and rejects ingest credentials in renderer results', () => {
    const candidate = {
      candidateKind: 'ingest',
      id: 'owned-stream',
      snippet: { title: 'Owned stream', scheduledStartTime: null },
      profile: { resolution: '1080p', frameRate: '30fps' }
    }
    expect(validateBackendRpcResult('scheduledStreams.candidates', [candidate])).toEqual([
      candidate
    ])
    expect(() =>
      validateBackendRpcResult('scheduledStreams.candidates', [
        { ...candidate, cdn: { ingestionInfo: { streamName: 'secret' } } }
      ])
    ).toThrow()
    expect(() =>
      validateBackendRpcParams('scheduledStreams.recover', {
        operationId: '11111111-1111-4111-8111-111111111111',
        eventId: '11111111-1111-4111-8111-111111111111',
        expectedRevision: 1,
        candidateKind: 'automatic'
      })
    ).toThrow()
  })
  it('validates the generation-bound capture recovery status and retry surface', () => {
    const recovering = {
      revision: 4,
      phase: 'verifying',
      retryable: false,
      attempts: 1,
      stage: 'camera-delivery',
      source: 'camera',
      trigger: 'automatic',
      sourceGeneration: 8,
      detectedAt: '2026-08-28T10:00:00Z',
      updatedAt: '2026-08-28T10:00:02Z',
      message: 'Camera restarted; verifying cadence.'
    } as const

    expect(validateBackendRpcResult('capture.recovery.status', recovering)).toEqual(recovering)
    expect(
      validateBackendRpcResult('capture.recovery.status', { ...recovering, revision: 0 })
    ).toEqual({ ...recovering, revision: 0 })
    expect(validateBackendRpcResult('capture.recovery.retry', recovering)).toEqual(recovering)
    expect(validateBackendEventPayload('capture.recovery.status', recovering)).toEqual(recovering)
    expect(validateBackendRpcParams('capture.recovery.retry', undefined)).toBeUndefined()

    const recoveringScreen = {
      ...recovering,
      stage: 'screen-delivery',
      source: 'screen',
      message: 'Screen capture restarted; verifying cadence.'
    } as const
    expect(validateBackendRpcResult('capture.recovery.status', recoveringScreen)).toEqual(
      recoveringScreen
    )
    expect(validateBackendEventPayload('capture.recovery.status', recoveringScreen)).toEqual(
      recoveringScreen
    )

    for (const invalid of [
      { ...recovering, revision: Number.POSITIVE_INFINITY },
      { ...recovering, phase: 'repairing' },
      { ...recovering, attempts: -1 },
      { ...recovering, sourceGeneration: 0 },
      { ...recovering, sourceGeneration: 1.5 },
      { ...recovering, sourceGeneration: Number.MAX_SAFE_INTEGER + 1 },
      { ...recovering, lastDurationMs: null }
    ]) {
      expect(() => validateBackendRpcResult('capture.recovery.status', invalid)).toThrow()
      expect(() => validateBackendEventPayload('capture.recovery.status', invalid)).toThrow()
    }
    const { revision: _revision, ...missingRevision } = recovering
    expect(() => validateBackendRpcResult('capture.recovery.status', missingRevision)).toThrow()
    expect(() => validateBackendEventPayload('capture.recovery.status', missingRevision)).toThrow()
    expect(() => validateBackendRpcParams('capture.recovery.retry', {})).toThrow()
  })

  it('keeps the Windows HWND in an exact generation-bound main-owned request', () => {
    const request = {
      bounds: {
        screenX: 10,
        screenY: 20,
        width: 1280,
        height: 720,
        scaleFactor: 1.25,
        visible: true,
        orderAboveWindowHandle: '0x000000000000abcd',
        elevated: false
      },
      generation: 7
    }
    expect(validateMainOwnedPreviewSurfaceBoundsParams(request)).toEqual(request)

    for (const malformed of [
      { ...request, generation: undefined },
      { ...request, generation: Number.MAX_SAFE_INTEGER + 1 },
      {
        ...request,
        bounds: { ...request.bounds, orderAboveWindowHandle: '0x0000000000000000' }
      },
      { ...request, bounds: { ...request.bounds, orderAboveWindowHandle: '0x1234' } },
      { ...request, bounds: { ...request.bounds, nativeWindowHandle: '0x0000000000000001' } }
    ]) {
      expect(() => validateMainOwnedPreviewSurfaceBoundsParams(malformed)).toThrow()
    }
  })

  it('types role-authoritative encoder bridge process diagnostics', () => {
    expectTypeOf<
      DiagnosticStats['encoderBridgeRecordingRawVideoCopiedFrames']
    >().toEqualTypeOf<number>()
    expectTypeOf<
      DiagnosticStats['encoderBridgeStreamRawVideoCopiedFrames']
    >().toEqualTypeOf<number>()
    expectTypeOf<DiagnosticStats['encoderBridgeRecordingDroppedFrames']>().toEqualTypeOf<number>()
    expectTypeOf<DiagnosticStats['encoderBridgeStreamDroppedFrames']>().toEqualTypeOf<number>()
    expectTypeOf<DiagnosticStats['encoderBridgeRecordingEncoderSpeed']>().toEqualTypeOf<
      number | undefined
    >()
    expectTypeOf<DiagnosticStats['encoderBridgeStreamEncoderSpeed']>().toEqualTypeOf<
      number | undefined
    >()
  })

  it('types and exactly validates the secret-free stream output topology probe', () => {
    expectTypeOf<
      BackendRpcParams<'stream.output.topology.probe'>
    >().toEqualTypeOf<StreamOutputTopologyProbeParams>()
    expectTypeOf<
      BackendRpcResult<'stream.output.topology.probe'>
    >().toEqualTypeOf<StreamOutputTopologyProbeResult>()

    const params: StreamOutputTopologyProbeParams = {
      streamProfile: {
        preset: 'stream-safe-1080p60',
        width: 1920,
        height: 1080,
        fps: 60,
        bitrateKbps: 6000
      },
      recordingProfile: {
        preset: 'tutorial-1080p30',
        width: 1920,
        height: 1080,
        fps: 30,
        bitrateKbps: 6000
      },
      outputRoles: ['stream', 'recording']
    }
    expect(validateBackendRpcParams('stream.output.topology.probe', params)).toEqual(params)
    expect(() =>
      validateBackendRpcParams('stream.output.topology.probe', {
        ...params,
        streamKey: 'must-never-cross-this-contract'
      })
    ).toThrow('streamKey must be a known field')
    expect(() =>
      validateBackendRpcParams('stream.output.topology.probe', {
        ...params,
        recordingProfile: undefined,
        outputRoles: ['recording', 'stream']
      })
    ).toThrow('recordingProfile')
    expect(() =>
      validateBackendRpcParams('stream.output.topology.probe', {
        ...params,
        outputRoles: ['stream', 'stream']
      })
    ).toThrow('outputRoles')

    const result: StreamOutputTopologyProbeResult = {
      capabilityKey: `stream-output-topology-v1:${'a'.repeat(64)}`,
      streamProfile: params.streamProfile,
      recordingProfile: params.recordingProfile,
      outputRoles: ['recording', 'stream'],
      requestedBridgeOutput: 'windows-media-foundation-h264-mpegts',
      effectiveBridgeOutput: 'raw-yuv420p',
      effectiveEncodeBackend: 'software-open-h264',
      probeState: 'rejected',
      fallbackReason: 'Media Foundation stream output probe rejected this profile.'
    }
    expect(validateBackendRpcResult('stream.output.topology.probe', result)).toEqual(result)
    for (const malformed of [
      { ...result, capabilityKey: 'not-a-capability-key' },
      { ...result, fallbackReason: undefined },
      { ...result, outputRoles: ['stream', 'recording'] },
      { ...result, streamKey: 'must-never-come-back' }
    ]) {
      expect(() => validateBackendRpcResult('stream.output.topology.probe', malformed)).toThrow()
    }

    // Plan 0015: Linux OpenH264 / VAAPI raw path. The encoder note is
    // informational in every state; a fallbackReason on a healthy topology is
    // still a contract violation.
    const linux: StreamOutputTopologyProbeResult = {
      capabilityKey: `stream-output-topology-v1:${'b'.repeat(64)}`,
      streamProfile: params.streamProfile,
      outputRoles: ['shared'],
      requestedBridgeOutput: 'raw-yuv420p',
      effectiveBridgeOutput: 'raw-yuv420p',
      effectiveEncodeBackend: 'software-open-h264',
      probeState: 'not-required',
      encoderSelectionReason: 'OpenH264 software encoding was selected explicitly for this session.'
    }
    expect(validateBackendRpcResult('stream.output.topology.probe', linux)).toEqual(linux)
    const vaapi = { ...linux, effectiveEncodeBackend: 'hardware-vaapi' as const }
    delete (vaapi as Partial<StreamOutputTopologyProbeResult>).encoderSelectionReason
    expect(validateBackendRpcResult('stream.output.topology.probe', vaapi)).toEqual(vaapi)
    expect(
      validateBackendRpcResult('stream.output.topology.probe', {
        ...result,
        encoderSelectionReason: 'Intel Quick Sync was selected but its check failed.'
      })
    ).toMatchObject({ probeState: 'rejected' })
    expect(() =>
      validateBackendRpcResult('stream.output.topology.probe', {
        ...linux,
        fallbackReason: linux.encoderSelectionReason
      })
    ).toThrow('fallbackReason')
    expect(() =>
      validateBackendRpcResult('stream.output.topology.probe', {
        ...linux,
        encoderSelectionReason: ''
      })
    ).toThrow('encoderSelectionReason')
  })

  it('types and exactly validates authoritative secret-free stream-target snapshots', () => {
    expectTypeOf<BackendRpcParams<'stream.targets.snapshot'>>().toEqualTypeOf<undefined>()
    expectTypeOf<
      BackendRpcResult<'stream.targets.snapshot'>
    >().toEqualTypeOf<StreamTargetsSnapshot>()
    expectTypeOf<BackendEventMap['stream.targets']>().toEqualTypeOf<StreamTargetsSnapshot>()

    const snapshot: StreamTargetsSnapshot = {
      sessionId: 'stream-generation-a',
      targets: [
        {
          targetId: 'youtube',
          platform: 'youtube',
          label: 'YouTube',
          state: 'live',
          redactedUrl: 'rtmp://youtube.example/live/••••'
        },
        {
          targetId: 'twitch',
          platform: 'twitch',
          label: 'Twitch',
          state: 'failed',
          message: 'Connection refused'
        }
      ]
    }

    expect(validateBackendRpcParams('stream.targets.snapshot', undefined)).toBeUndefined()
    expect(validateBackendRpcResult('stream.targets.snapshot', snapshot)).toEqual(snapshot)
    expect(validateBackendEventPayload('stream.targets', snapshot)).toEqual(snapshot)
    expect(() => validateBackendRpcParams('stream.targets.snapshot', {})).toThrow(
      'stream.targets.snapshot.params'
    )

    for (const malformed of [
      {
        ...snapshot,
        targets: [{ ...snapshot.targets[0], streamKey: 'must-never-cross-this-contract' }]
      },
      {
        ...snapshot,
        targets: [{ ...snapshot.targets[0], url: 'rtmp://youtube.example/live/actual-secret' }]
      },
      {
        ...snapshot,
        targets: [snapshot.targets[0], { ...snapshot.targets[1], targetId: 'youtube' }]
      },
      {
        ...snapshot,
        targets: [{ ...snapshot.targets[0], state: 'healthy' }]
      },
      { ...snapshot, unexpected: true }
    ]) {
      expect(() => validateBackendRpcResult('stream.targets.snapshot', malformed)).toThrow()
      expect(() => validateBackendEventPayload('stream.targets', malformed)).toThrow()
    }
  })

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
    // Plan 094 (S3): a terminal YouTube connect carries its reason and retry time.
    const quota = {
      ...event,
      status: 'failed',
      retryable: false,
      reason: 'youtube-quota',
      retryAt: '2026-10-03T07:00:00Z'
    }
    expect(validateBackendEventPayload('platformAccounts.oauth.callback', quota)).toEqual(quota)
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
    expect(
      validateBackendRpcResult('sessions.delete.pending', [
        { operationId: 'op-1', sessionId: 'session-1', pathCount: 2, blockedPathCount: 1 }
      ])
    ).toEqual([{ operationId: 'op-1', sessionId: 'session-1', pathCount: 2, blockedPathCount: 1 }])
    expect(() =>
      validateBackendRpcParams('sessions.delete', {
        sessionIds: ['session-1'],
        deleteFiles: true
      })
    ).toThrow('deleteFiles must be a known field')
  })

  it('rejects private deletion paths from renderer-safe delete results', () => {
    const operation = {
      operationId: 'op-1',
      sessionId: 'session-1',
      pathCount: 2,
      blockedPathCount: 1
    }

    for (const method of ['sessions.delete', 'sessions.delete.pending']) {
      expect(() =>
        validateBackendRpcResult(method, [{ ...operation, paths: ['/private/quarantine.mp4'] }])
      ).toThrow('paths must be a known field')
      expect(() =>
        validateBackendRpcResult(method, [{ ...operation, blockedPaths: ['/private/blocked.mp4'] }])
      ).toThrow('blockedPaths must be a known field')
    }
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

  it('types a session viewer history and rejects forged sample fields', () => {
    expectTypeOf<BackendRpcResult<'sessions.viewers.list'>>().toEqualTypeOf<SessionViewersPage>()
    const sample = {
      sessionId: 'session-1',
      platforms: [
        { platform: 'twitch', count: 40 },
        { platform: 'x', count: 2 }
      ],
      total: 42,
      at: '2026-09-24T10:00:00Z'
    }
    expect(validateBackendRpcParams('sessions.viewers.list', { sessionId: 'session-1' })).toEqual({
      sessionId: 'session-1'
    })
    expect(validateBackendRpcResult('sessions.viewers.list', { samples: [sample] })).toEqual({
      samples: [sample]
    })
    expect(() =>
      validateBackendRpcResult('sessions.viewers.list', {
        samples: [{ ...sample, platforms: [{ platform: 'myspace', count: 1 }] }]
      })
    ).toThrow()
    expect(() =>
      validateBackendRpcResult('sessions.viewers.list', { samples: [{ ...sample, total: -1 }] })
    ).toThrow()
  })

  it('types audience snapshots and never accepts a forged capability', () => {
    expectTypeOf<
      BackendRpcResult<'stream.audience.snapshot'>
    >().toEqualTypeOf<AudienceSnapshot | null>()
    const snapshot = {
      sessionId: 'session-1',
      platforms: [
        {
          platform: 'twitch',
          metric: 'followers',
          capability: 'available',
          total: 61_942,
          baseline: 61_930,
          delta: 12,
          at: '2026-09-24T10:02:00Z'
        },
        { platform: 'youtube', metric: 'subscribers', capability: 'hidden' },
        {
          platform: 'x',
          metric: 'followers',
          capability: 'needs-reconnect',
          message: 'Reconnect X to show followers.'
        }
      ],
      updatedAt: '2026-09-24T10:02:00Z'
    }
    expect(validateBackendRpcResult('stream.audience.snapshot', snapshot)).toEqual(snapshot)
    expect(validateBackendRpcResult('stream.audience.snapshot', null)).toBeNull()
    expect(validateBackendRpcResult('sessions.audience.get', snapshot)).toEqual(snapshot)
    expect(() =>
      validateBackendRpcResult('stream.audience.snapshot', {
        ...snapshot,
        platforms: [{ ...snapshot.platforms[0], capability: 'guessed' }]
      })
    ).toThrow()
    expect(() =>
      validateBackendRpcResult('stream.audience.snapshot', {
        ...snapshot,
        platforms: [{ ...snapshot.platforms[0], total: null }]
      })
    ).toThrow()
  })

  it('keeps Library summaries slim and types each paginated detail collection', () => {
    expectTypeOf<BackendRpcResult<'sessions.list'>>().toEqualTypeOf<SessionListPage>()
    expectTypeOf<
      BackendRpcResult<'sessions.healthEvents.list'>
    >().toEqualTypeOf<SessionHealthEventsPage>()
    expectTypeOf<BackendRpcResult<'sessions.logs.list'>>().toEqualTypeOf<SessionLogsPage>()
    expectTypeOf<
      BackendRpcResult<'sessions.aiArtifacts.list'>
    >().toEqualTypeOf<SessionAiArtifactsPage>()

    const item = {
      id: 'session-1',
      title: 'Session 1',
      startedAt: '2026-07-18T10:00:00Z',
      status: 'completed',
      mode: 'record',
      mp4Path: '/recordings/session-1.mp4',
      container: 'mkv',
      durationMs: 1_000,
      fileSizeBytes: 2_048,
      sceneLabel: 'Screen only',
      healthEventCount: 1,
      sessionLogCount: 1,
      aiArtifactCount: 1,
      readyAiArtifactKinds: ['transcript'],
      commentCount: 0
    }
    expect(validateBackendRpcResult('sessions.list', { items: [item] })).toEqual({
      items: [item]
    })
    expect(() =>
      validateBackendRpcResult('sessions.list', {
        items: [{ ...item, healthEvents: [] }]
      })
    ).toThrow('healthEvents must be a known field')

    // Plan 119 S13: a Clean cut output names its source and mode; the
    // processingKind literal stays closed (decision 12).
    const cleanCutOutput = {
      ...item,
      id: 'session-1-clean-cut',
      derivedFromSessionId: 'session-1',
      sourceTitle: 'Session 1',
      cleanCutOfSessionId: 'session-1',
      cleanCutMode: 'clean'
    }
    expect(validateBackendRpcResult('sessions.list', { items: [cleanCutOutput] })).toEqual({
      items: [cleanCutOutput]
    })
    expect(() =>
      validateBackendRpcResult('sessions.list', {
        items: [{ ...cleanCutOutput, cleanCutMode: 'tight' }]
      })
    ).toThrow()
    expect(() =>
      validateBackendRpcResult('sessions.list', {
        items: [{ ...cleanCutOutput, processingKind: 'clean-cut' }]
      })
    ).toThrow()

    // An interrupted take recovered on the next start (plan 0003).
    const recovered = { ...item, interruptionRecovery: 'recovered' }
    expect(validateBackendRpcResult('sessions.list', { items: [recovered] })).toEqual({
      items: [recovered]
    })
    expect(() =>
      validateBackendRpcResult('sessions.list', {
        items: [{ ...item, interruptionRecovery: 'pending' }]
      })
    ).toThrow()
    const finalized = {
      sessionId: 'session-1',
      state: 'finalized',
      mp4Path: '/recordings/session-1.mp4',
      interruptionRecovery: 'recovered',
      updatedAt: '2026-10-28T00:00:00Z'
    }
    expect(validateBackendEventPayload('recording.finalization', finalized)).toEqual(finalized)

    const params = { sessionId: 'session-1', cursor: 'created\nid', limit: 120 }
    for (const method of [
      'sessions.healthEvents.list',
      'sessions.logs.list',
      'sessions.aiArtifacts.list'
    ] as const) {
      expect(validateBackendRpcParams(method, params)).toEqual(params)
      expect(() => validateBackendRpcParams(method, { ...params, limit: 121 })).toThrow(
        'less than or equal to 120'
      )
    }

    expect(
      validateBackendRpcResult('sessions.healthEvents.list', {
        events: [
          {
            id: 'health-1',
            sessionId: 'session-1',
            level: 'warn',
            code: 'fixture-health',
            message: 'Fixture health event.',
            permissionPane: null,
            createdAt: '2026-07-18T10:00:01Z'
          }
        ]
      })
    ).toMatchObject({ events: [{ id: 'health-1' }] })
    expect(
      validateBackendRpcResult('sessions.logs.list', {
        entries: [
          {
            id: 'log-1',
            sessionId: 'session-1',
            level: 'info',
            code: 'fixture-log',
            message: 'Fixture log.',
            sourceId: null,
            permissionPane: null,
            createdAt: '2026-07-18T10:00:02Z'
          }
        ]
      })
    ).toMatchObject({ entries: [{ id: 'log-1' }] })
    expect(
      validateBackendRpcResult('sessions.aiArtifacts.list', {
        artifacts: [
          {
            id: 'artifact-1',
            sessionId: 'session-1',
            kind: 'transcript',
            status: 'ready',
            content: { text: 'hello' },
            filePath: null,
            createdAt: '2026-07-18T10:00:03Z'
          }
        ]
      })
    ).toMatchObject({ artifacts: [{ id: 'artifact-1' }] })
  })

  it('accepts transitionMs on layout transactions and rejects out-of-range values', () => {
    // transitionMs crosses exactly one wire validator (this allowUnknown:false
    // schema) — issue #232 class: a field added to N−1 of N layers throws
    // RuntimeSchemaError in production. Pin the one layer here.
    const layoutParams = {
      intentId: 7,
      sources: { cameraId: 'cam-1', screenId: 'screen-1' },
      layout: {
        layoutPreset: 'screen-camera',
        cameraTransformMode: 'preset',
        cameraTransform: null,
        cameraCorner: 'bottom-right',
        cameraSize: 'medium',
        cameraShape: 'rounded',
        cameraCornerRadiusPct: 12,
        cameraAspect: 'source',
        cameraChromaKeyEnabled: false,
        cameraChromaKeyColor: '#00ff00',
        cameraChromaKeySimilarityPct: 40,
        cameraChromaKeySmoothnessPct: 10,
        cameraChromaKeySpillPct: 10,
        cameraMargin: 16,
        cameraFit: 'fill',
        cameraMirror: false,
        cameraZoom: 100,
        cameraOffsetX: 0,
        cameraOffsetY: 0,
        sideBySideSplit: '50-50',
        sideBySideCameraSide: 'left',
        verticalScreenFraming: 'fill'
      },
      transitionMs: 320
    }
    const hidden = {
      ...layoutParams,
      layout: { ...layoutParams.layout, sourceVisibility: { camera: false, capture: true } }
    }
    expect(validateBackendRpcParams('scene.layout.apply_live', hidden)).toEqual(hidden)
    for (const sourceVisibility of [{ camera: 'false' }, { microphone: false }, null]) {
      expect(() =>
        validateBackendRpcParams('scene.layout.apply_live', {
          ...layoutParams,
          layout: { ...layoutParams.layout, sourceVisibility }
        })
      ).toThrow()
    }
    expect(validateBackendRpcParams('scene.layout.apply_live', layoutParams)).toEqual(layoutParams)
    expect(validateBackendRpcParams('scene.layout.apply_preview', layoutParams)).toEqual(
      layoutParams
    )
    expect(() =>
      validateBackendRpcParams('scene.layout.apply_live', { ...layoutParams, transitionMs: 2000 })
    ).toThrow()
    expect(() =>
      validateBackendRpcParams('scene.layout.apply_live', { ...layoutParams, transitionMs: 0.5 })
    ).toThrow()
    // Only a live transaction may target the vertical simulcast leg.
    const legParams = { ...layoutParams, simulcastLeg: true }
    expect(validateBackendRpcParams('scene.layout.apply_live', legParams)).toEqual(legParams)
    expect(() =>
      validateBackendRpcParams('scene.layout.apply_live', { ...layoutParams, simulcastLeg: 'yes' })
    ).toThrow()
    expect(() => validateBackendRpcParams('scene.layout.apply_preview', legParams)).toThrow()
  })

  it('accepts the optional record-latency click timestamps on session start and stop', () => {
    expect(validateBackendRpcParams('session.stop', undefined)).toBeUndefined()
    expect(validateBackendRpcParams('session.stop', { requestedAtMs: 1_700_000_000_000 })).toEqual({
      requestedAtMs: 1_700_000_000_000
    })
    expect(() => validateBackendRpcParams('session.stop', { requestedAtMs: -1 })).toThrow()
    expect(() => validateBackendRpcParams('session.stop', { unexpected: true })).toThrow()
  })

  it('validates every destructive contract named in the runtime registry', () => {
    expect(runtimeValidatedBackendRpcMethods).toEqual(
      expect.arrayContaining([
        'account.complete_sign_in',
        'platformAccounts.oauth.complete',
        'stream.output.topology.probe',
        'stream.targets.snapshot',
        'session.start',
        'session.stop',
        'scene.layout.apply_preview',
        'scene.layout.apply_live',
        'sessions.delete',
        'sessions.delete.pending',
        'repair.repair_file',
        'scene.editor.draft.set',
        'scene.editor.draft.clear',
        'liveChat.moderation.request',
        'liveChat.moderation.confirm',
        'liveChat.moderation.cancel',
        'cohost.command.choose',
        'cohost.command.confirm',
        'cohost.command.cancel'
      ])
    )
  })

  it('types and exactly validates the Scene editor draft RPCs (plan 058)', () => {
    const transform = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }
    const params = {
      sourceId: 'source:camera',
      transform,
      chrome: {
        selected: transform,
        handles: true,
        activeHandle: 'se',
        guides: [
          { axis: 'x', position: 0.5 },
          { axis: 'y', position: 0.25 }
        ],
        scale: 1.5,
        slotCssWidth: 512
      }
    } satisfies SceneEditorDraftParams
    expectTypeOf<
      BackendRpcParams<'scene.editor.draft.set'>
    >().toEqualTypeOf<SceneEditorDraftParams>()
    expectTypeOf<BackendRpcResult<'scene.editor.draft.set'>>().toEqualTypeOf<SceneEditorDraftAck>()
    expectTypeOf<BackendRpcParams<'scene.editor.draft.clear'>>().toEqualTypeOf<undefined>()
    expectTypeOf<
      BackendRpcResult<'scene.editor.draft.clear'>
    >().toEqualTypeOf<SceneEditorDraftAck>()

    expect(validateBackendRpcParams('scene.editor.draft.set', params)).toEqual(params)
    // The renderer omits activeHandle when no handle is dragged; an older
    // caller may omit slotCssWidth and the backend falls back to scale.
    const moving = {
      ...params,
      chrome: { selected: transform, handles: false, guides: [], scale: 2 }
    }
    expect(validateBackendRpcParams('scene.editor.draft.set', moving)).toEqual(moving)
    // The idle selection: chrome only, no rect override (absent, never null).
    const held = {
      sourceId: 'source:camera',
      chrome: { selected: transform, handles: true, guides: [], scale: 2 }
    } satisfies SceneEditorDraftParams
    expect(validateBackendRpcParams('scene.editor.draft.set', held)).toEqual(held)
    expect(() =>
      validateBackendRpcParams('scene.editor.draft.set', { ...held, transform: null })
    ).toThrow()
    expect(validateBackendRpcParams('scene.editor.draft.clear', undefined)).toBeUndefined()
    expect(() => validateBackendRpcParams('scene.editor.draft.clear', {})).toThrow()

    // Every level is exact: unknown fields never ride along into the backend.
    expect(() =>
      validateBackendRpcParams('scene.editor.draft.set', { ...params, snap: 'none' })
    ).toThrow('snap must be a known field')
    expect(() =>
      validateBackendRpcParams('scene.editor.draft.set', {
        ...params,
        transform: { ...transform, cropLeft: 0.1 }
      })
    ).toThrow('cropLeft must be a known field')
    expect(() =>
      validateBackendRpcParams('scene.editor.draft.set', {
        ...params,
        chrome: { ...params.chrome, color: '#ff0000' }
      })
    ).toThrow('color must be a known field')
    expect(() =>
      validateBackendRpcParams('scene.editor.draft.set', {
        ...params,
        chrome: { ...params.chrome, guides: [{ axis: 'x', position: 0.5, label: 'centre' }] }
      })
    ).toThrow('label must be a known field')
    for (const malformed of [
      { ...params, sourceId: '' },
      { ...params, transform: { x: 0.1, y: 0.2, width: 0.3 } },
      { ...params, transform: { ...transform, x: Number.NaN } },
      { ...params, chrome: { ...params.chrome, activeHandle: 'north' } },
      { ...params, chrome: { ...params.chrome, handles: 'yes' } },
      { ...params, chrome: { ...params.chrome, guides: [{ axis: 'z', position: 0.5 }] } },
      { ...params, chrome: { ...params.chrome, scale: -1 } },
      { ...params, chrome: { ...params.chrome, slotCssWidth: 0 } },
      { ...params, chrome: { ...params.chrome, slotCssWidth: null } },
      { ...params, chrome: { ...params.chrome, slotCssWidth: '512' } },
      { ...params, chrome: { selected: transform, handles: true, scale: 1 } }
    ]) {
      expect(() => validateBackendRpcParams('scene.editor.draft.set', malformed)).toThrow()
    }

    const draft = { sourceId: 'source:camera', transform, releaseAtRevision: 42 }
    const ack = { active: true, editorDraft: draft } satisfies SceneEditorDraftAck
    for (const method of ['scene.editor.draft.set', 'scene.editor.draft.clear'] as const) {
      expect(validateBackendRpcResult(method, ack)).toEqual(ack)
      expect(validateBackendRpcResult(method, { active: false })).toEqual({ active: false })
      expect(validateBackendRpcResult(method, { active: false, editorDraft: null })).toEqual({
        active: false,
        editorDraft: null
      })
      expect(
        validateBackendRpcResult(method, {
          active: true,
          editorDraft: { sourceId: 'source:camera', transform }
        })
      ).toEqual({ active: true, editorDraft: { sourceId: 'source:camera', transform } })
      // A chrome-only draft reports no transform at all.
      expect(
        validateBackendRpcResult(method, {
          active: true,
          editorDraft: { sourceId: 'source:camera' }
        })
      ).toEqual({ active: true, editorDraft: { sourceId: 'source:camera' } })
      expect(() =>
        validateBackendRpcResult(method, {
          active: true,
          editorDraft: { sourceId: 'source:camera', transform: null }
        })
      ).toThrow()
      expect(() =>
        validateBackendRpcResult(method, { ...ack, editorDraft: { ...draft, chrome: {} } })
      ).toThrow('chrome must be a known field')
      expect(() => validateBackendRpcResult(method, { ...ack, generation: 3 })).toThrow(
        'generation must be a known field'
      )
      expect(() => validateBackendRpcResult(method, { editorDraft: draft })).toThrow()
      expect(() =>
        validateBackendRpcResult(method, {
          ...ack,
          editorDraft: { ...draft, releaseAtRevision: -1 }
        })
      ).toThrow()
    }
  })

  it('reports how the last screen switch changed the capture (plan 210 S3)', () => {
    const status = {
      state: 'live',
      targetFps: 30,
      width: 1280,
      height: 720,
      sceneSources: [],
      sources: [],
      framesRendered: 12,
      repeatedFrames: 0,
      droppedFrames: 0,
      updatedAt: '2026-10-29T00:00:00Z'
    } satisfies CompositorStatus
    const inPlace = {
      mode: 'in-place',
      sourceId: 'window:screencapturekit:42',
      generation: 7,
      firstFrameMs: 61,
      updatedAt: '2026-10-29T00:00:01Z'
    } satisfies ScreenSwitchStatus
    const restart = {
      mode: 'restart',
      reason: 'the canvas changed',
      sourceId: 'screen:screencapturekit:1',
      generation: 8,
      updatedAt: '2026-10-29T00:00:02Z'
    } satisfies ScreenSwitchStatus
    expect(validateBackendRpcResult('compositor.status', status)).toEqual(status)
    expect(
      validateBackendRpcResult('compositor.status', { ...status, screenSwitch: inPlace })
    ).toEqual({ ...status, screenSwitch: inPlace })
    expect(
      validateBackendEventPayload('compositor.status', { ...status, screenSwitch: restart })
    ).toEqual({ ...status, screenSwitch: restart })
    expect(() =>
      validateBackendRpcResult('compositor.status', {
        ...status,
        screenSwitch: { ...inPlace, mode: 'warm' }
      })
    ).toThrow()
    expect(() =>
      validateBackendRpcResult('compositor.status', {
        ...status,
        screenSwitch: { ...inPlace, pixels: 'no' }
      })
    ).toThrow('pixels must be a known field')
  })

  it('carries the Preview hold of a performance check and nothing else (plan 212)', () => {
    const status = {
      state: 'live',
      targetFps: 30,
      width: 1280,
      height: 720,
      sceneSources: [],
      sources: [],
      framesRendered: 12,
      repeatedFrames: 0,
      droppedFrames: 0,
      updatedAt: '2026-10-31T00:00:00Z'
    } satisfies CompositorStatus
    expect(validateBackendRpcResult('compositor.status', status)).toEqual(status)
    expect(
      validateBackendRpcResult('compositor.status', { ...status, previewHold: 'performance-check' })
    ).toEqual({ ...status, previewHold: 'performance-check' })
    expect(
      validateBackendEventPayload('compositor.status', {
        ...status,
        previewHold: 'performance-check'
      })
    ).toEqual({ ...status, previewHold: 'performance-check' })
    expect(() =>
      validateBackendRpcResult('compositor.status', { ...status, previewHold: 'recording' })
    ).toThrow()
    expect(() =>
      validateBackendRpcResult('compositor.status', { ...status, previewHold: null })
    ).toThrow()
  })

  it('reports the effective editor draft on compositor status and never a forged one', () => {
    const status = {
      state: 'live',
      targetFps: 30,
      width: 1280,
      height: 720,
      sceneRevision: 7,
      sceneSources: [],
      sources: [],
      framesRendered: 12,
      repeatedFrames: 0,
      droppedFrames: 0,
      updatedAt: '2026-09-25T00:00:00Z'
    } satisfies CompositorStatus
    const draft = {
      sourceId: 'source:camera',
      transform: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
      releaseAtRevision: 8
    }
    // Absent (the idle shape Rust emits), null, and a live draft all pass.
    expect(validateBackendRpcResult('compositor.status', status)).toEqual(status)
    expect(validateBackendRpcResult('compositor.status', { ...status, editorDraft: null })).toEqual(
      {
        ...status,
        editorDraft: null
      }
    )
    expect(
      validateBackendRpcResult('compositor.status', { ...status, editorDraft: draft })
    ).toEqual({ ...status, editorDraft: draft })
    expect(
      validateBackendEventPayload('compositor.status', { ...status, editorDraft: draft })
    ).toEqual({ ...status, editorDraft: draft })
    expect(() =>
      validateBackendRpcResult('compositor.status', {
        ...status,
        editorDraft: { ...draft, handles: true }
      })
    ).toThrow('handles must be a known field')
    // The idle selection's hold: a draft with chrome only, no transform.
    expect(
      validateBackendRpcResult('compositor.status', {
        ...status,
        editorDraft: { sourceId: 'source:camera' }
      })
    ).toEqual({ ...status, editorDraft: { sourceId: 'source:camera' } })
    expect(() =>
      validateBackendRpcResult('compositor.status', {
        ...status,
        editorDraft: { transform: draft.transform }
      })
    ).toThrow()
    expect(() =>
      validateBackendRpcResult('compositor.status', {
        ...status,
        editorDraft: { sourceId: 'source:camera', transform: { x: 0.1, y: 0.2 } }
      })
    ).toThrow()
  })

  it('accepts the live background on compositor status (plan 190) and nothing forged', () => {
    const status = {
      state: 'live',
      targetFps: 30,
      width: 1280,
      height: 720,
      sceneSources: [],
      sources: [],
      framesRendered: 12,
      repeatedFrames: 0,
      droppedFrames: 0,
      framePipeline: {
        gpuReadbacks: 0,
        bgraBytesCopied: 0,
        yuvFramesConverted: 0,
        immutableTextureUploads: 0,
        immutableTextureReuses: 0,
        liveBackgroundPrograms: 2,
        liveBackgroundScratchBytes: 8_294_400,
        // Plan 205 S6: the Preview's own picture, inside the bounded
        // pipeline payload, never a top-level field the strict schema
        // would reject.
        previewProgramLeg: true
      },
      updatedAt: '2026-10-24T00:00:00Z'
    } satisfies CompositorStatus
    const shader = { id: 'silk', look: 'satin', rendering: 'shader', p95Ms: 0.4 } as const
    const still = {
      id: 'plasma-wave',
      look: 'plasma',
      rendering: 'still',
      reason: 'gpu-budget',
      p95Ms: 5.1,
      requestedLook: 'lava'
    } as const
    for (const liveBackground of [shader, still]) {
      // The event a running compositor publishes, and the status a read returns.
      expect(
        validateBackendEventPayload('compositor.status', { ...status, liveBackground })
      ).toEqual({ ...status, liveBackground })
      expect(validateBackendRpcResult('compositor.status', { ...status, liveBackground })).toEqual({
        ...status,
        liveBackground
      })
    }
    // Every catalogue id passes, the plan 194 five included: the strict
    // contract once rejected a status by omission (plan 190 S11).
    expect(LIVE_BACKGROUND_IDS).toHaveLength(10)
    for (const id of LIVE_BACKGROUND_IDS) {
      const liveBackground = { ...shader, id, look: LIVE_BACKGROUND_DEFAULT_LOOKS[id] }
      expect(validateBackendRpcResult('compositor.status', { ...status, liveBackground })).toEqual({
        ...status,
        liveBackground
      })
    }
    expect(() =>
      validateBackendRpcResult('compositor.status', {
        ...status,
        liveBackground: { ...shader, id: 'lava-lamp' }
      })
    ).toThrow()
    expect(() =>
      validateBackendRpcResult('compositor.status', {
        ...status,
        liveBackground: { ...shader, shader: 'void main() {}' }
      })
    ).toThrow('shader must be a known field')
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
      nativePreviewIosurfaceImportLiveCount: 2,
      nativePreviewIosurfaceImportPeakCount: 3,
      nativePreviewIosurfaceImportCeiling: 3,
      framePollingSuppressed: false,
      sourcePixelsPresent: true,
      pendingHostCommandCount: 0,
      updatedAt: '2026-07-12T00:00:00.000Z'
    }

    expect(validateBackendRpcResult('preview.surface.status', surfaceStatus)).toEqual(surfaceStatus)
    expect(validateBackendEventPayload('preview.surface.status', surfaceStatus)).toEqual(
      surfaceStatus
    )
    for (const field of [
      'nativePreviewIosurfaceImportLiveCount',
      'nativePreviewIosurfaceImportPeakCount',
      'nativePreviewIosurfaceImportCeiling'
    ] as const) {
      expect(() =>
        validateBackendRpcResult('preview.surface.status', {
          ...surfaceStatus,
          [field]: -1
        })
      ).toThrow(field)
      expect(() =>
        validateBackendEventPayload('preview.surface.status', {
          ...surfaceStatus,
          [field]: null
        })
      ).toThrow(field)
    }
    const d3d11SurfaceStatus = {
      ...surfaceStatus,
      transport: 'd3d11-shared-texture',
      backing: 'directcomposition-swapchain',
      nativePreviewHostKind: 'backend-d3d11-presenter',
      windowsD3d11Presenter: {
        layered: true,
        transparent: true,
        noActivate: true,
        excludedFromCapture: true,
        windowActive: false,
        windowFocused: false,
        previewGeneration: 7,
        mediaGeneration: 11,
        generationMatches: true,
        ownerProcessMatches: true,
        sameAdapter: true,
        sourceLive: true,
        firstPresentSucceeded: true,
        successfulPresents: 42,
        lastPresentedSequence: 42,
        latestWinsDrops: 2,
        hiddenDrops: 0,
        busyDrops: 1,
        staleFrameDrops: 0,
        actualBounds: { x: 10, y: 20, width: 1280, height: 720 }
      }
    }
    expect(validateBackendRpcResult('preview.surface.status', d3d11SurfaceStatus)).toEqual(
      d3d11SurfaceStatus
    )
    const { mediaGeneration: _mediaGeneration, ...generationlessPresenter } =
      d3d11SurfaceStatus.windowsD3d11Presenter
    expect(() =>
      validateBackendEventPayload('preview.surface.status', {
        ...d3d11SurfaceStatus,
        windowsD3d11Presenter: generationlessPresenter
      })
    ).toThrow('mediaGeneration')
    expect(() =>
      validateBackendRpcResult('preview.surface.status', {
        ...d3d11SurfaceStatus,
        windowsD3d11Presenter: {
          ...d3d11SurfaceStatus.windowsD3d11Presenter,
          mediaGeneration: -1
        }
      })
    ).toThrow('mediaGeneration')
    for (const leaked of [
      { ...d3d11SurfaceStatus, nativeWindowHandle: '0x0000000000000001' },
      { ...d3d11SurfaceStatus, processId: 42 },
      { ...d3d11SurfaceStatus, sharedTextureHandle: '0x0000000000000002' },
      {
        ...d3d11SurfaceStatus,
        windowsD3d11Presenter: {
          ...d3d11SurfaceStatus.windowsD3d11Presenter,
          processId: 42
        }
      },
      {
        ...d3d11SurfaceStatus,
        windowsD3d11Presenter: {
          ...d3d11SurfaceStatus.windowsD3d11Presenter,
          resourceHandle: '0x0000000000000003'
        }
      },
      {
        ...d3d11SurfaceStatus,
        bounds: {
          screenX: 0,
          screenY: 0,
          width: 1280,
          height: 720,
          scaleFactor: 1,
          orderAboveWindowHandle: '0x0000000000000001'
        }
      }
    ]) {
      expect(() => validateBackendRpcResult('preview.surface.status', leaked)).toThrow(
        /renderer-facing/
      )
      expect(() => validateBackendEventPayload('preview.surface.status', leaked)).toThrow(
        /renderer-facing/
      )
    }
    for (const malformed of [{}, null]) {
      expect(() => validateBackendRpcResult('preview.surface.status', malformed)).toThrow(
        'backend.preview.surface.status.result'
      )
      expect(() => validateBackendEventPayload('preview.surface.status', malformed)).toThrow(
        'backend.event.preview.surface.status'
      )
    }
  })

  it('validates the optional system audio diagnostics and tolerates the serde-null trap', () => {
    const idle = { skippedFrames: 0, droppedFrames: 0, ...idleCapturePressureDiagnostics }
    // Absent while no system source is attached: the Rust side skips None.
    expect(validateBackendEventPayload('diagnostics.stats', idle)).toEqual(idle)
    const live = {
      ...idle,
      systemAudioLiveLevel: 0.62,
      systemAudioLivePeakDb: -14.5,
      systemAudioCapturedFrames: 96_000,
      systemAudioActive: true,
      audioMixClippedSamples: 0
    }
    expect(validateBackendRpcResult('diagnostics.stats', live)).toEqual(live)
    expect(validateBackendEventPayload('diagnostics.stats', live)).toEqual(live)
    for (const field of [
      'systemAudioLiveLevel',
      'systemAudioLivePeakDb',
      'systemAudioCapturedFrames',
      'systemAudioActive',
      'audioMixClippedSamples'
    ] as const) {
      // A regressed skip_serializing_if emits null; that must never drop the
      // whole stats event (0.9.68 / 0.9.79 / 0.9.80 outage class).
      const nullable = { ...live, [field]: null }
      expect(validateBackendRpcResult('diagnostics.stats', nullable)).toEqual(nullable)
      expect(validateBackendEventPayload('diagnostics.stats', nullable)).toEqual(nullable)
    }
    for (const [field, invalid] of [
      ['systemAudioLiveLevel', 1.5],
      ['systemAudioLiveLevel', -0.1],
      ['systemAudioLivePeakDb', Number.NEGATIVE_INFINITY],
      ['systemAudioCapturedFrames', -1],
      ['systemAudioCapturedFrames', 1.5],
      ['systemAudioActive', 'yes'],
      ['audioMixClippedSamples', -3]
    ] as const) {
      expect(() =>
        validateBackendEventPayload('diagnostics.stats', { ...live, [field]: invalid })
      ).toThrow(field)
    }
  })

  it('accepts real diagnostic wire payloads without renderer-only timestamps', () => {
    const diagnostics = {
      skippedFrames: 0,
      droppedFrames: 2,
      ...idleCapturePressureDiagnostics,
      compositorBackend: 'cpu',
      compositorCpuFrames: 214,
      compositorCpuFallbackFrames: 0,
      compositorTicks: 214,
      compositorTickSkipped: 188,
      encoderBridgeFreshFrames: 116,
      encoderBridgeMfSubmittedFrames: 119,
      encoderBridgeMfInputCreditTimeouts: 2,
      encoderBridgeMfInputCreditWaitP95Ms: 12.5,
      encoderBridgeOutputQueueHighWaterFrames: 16,
      encoderBridgeOutputQueueOldestFrameAgeMs: 240,
      encoderBridgeOutputQueueOldestFrameAgeHighWaterMs: 528,
      encoderBridgeOutputLastProgressAgeMs: 12,
      encoderBridgeOutputPressureRecoveryEvents: 1,
      encoderBridgeOutputPreEncodeSkippedFrames: 4,
      encoderBridgeVideoToolboxPendingEncodeFrames: 2,
      encoderBridgeVideoToolboxPendingFifoFrames: 14,
      encoderBridgeEncodedAccessUnitDroppedFrames: 0,
      compositorMetalCachedCaptureSourceImportsLiveCount: 2,
      compositorMetalCachedCaptureSourceImportsPeakCount: 3,
      compositorMetalCachedCaptureSourceImportsCeiling: 4,
      compositorMetalTargetRingSlotsLiveCount: 3,
      compositorMetalTargetRingSlotsPeakCount: 5,
      compositorMetalTargetRingSlotsCeiling: 5,
      encoderBridgeMetalTargetRefsInFlightLiveCount: 1,
      encoderBridgeMetalTargetRefsInFlightPeakCount: 2,
      encoderBridgeMetalTargetRefsInFlightCeiling: 5,
      nativePreviewIosurfaceImportLiveCount: 2,
      nativePreviewIosurfaceImportPeakCount: 3,
      nativePreviewIosurfaceImportCeiling: 3,
      previewImagePollCounts: {
        cameraPng: 0,
        screenPng: 0,
        productionPng: 0,
        cameraBmp: 3,
        screenBmp: 4,
        liveJpeg: 0,
        liveMjpeg: 0
      }
    }
    expect(validateBackendRpcResult('diagnostics.stats', diagnostics)).toEqual(diagnostics)
    expect(validateBackendEventPayload('diagnostics.stats', diagnostics)).toEqual(diagnostics)
    for (const field of [
      'compositorMetalCachedCaptureSourceImportsLiveCount',
      'compositorMetalCachedCaptureSourceImportsPeakCount',
      'compositorMetalCachedCaptureSourceImportsCeiling',
      'compositorMetalTargetRingSlotsLiveCount',
      'compositorMetalTargetRingSlotsPeakCount',
      'compositorMetalTargetRingSlotsCeiling',
      'encoderBridgeMetalTargetRefsInFlightLiveCount',
      'encoderBridgeMetalTargetRefsInFlightPeakCount',
      'encoderBridgeMetalTargetRefsInFlightCeiling',
      'nativePreviewIosurfaceImportLiveCount',
      'nativePreviewIosurfaceImportPeakCount',
      'nativePreviewIosurfaceImportCeiling'
    ] as const) {
      expect(() =>
        validateBackendRpcResult('diagnostics.stats', {
          ...diagnostics,
          [field]: -1
        })
      ).toThrow(field)
      const nullablePayload = { ...diagnostics, [field]: null }
      expect(validateBackendRpcResult('diagnostics.stats', nullablePayload)).toEqual(
        nullablePayload
      )
      expect(validateBackendEventPayload('diagnostics.stats', nullablePayload)).toEqual(
        nullablePayload
      )
    }
    // capturePipelineDegradedStage: absent while healthy (the wire omits it),
    // a stage label while degraded, and null tolerated for defense in depth
    // against the serde-null trap (0.9.68 / 0.9.79 outage class).
    for (const degradedStage of ['camera-delivery', 'screen-delivery', 'compositor-render', null]) {
      const flagged = { ...diagnostics, capturePipelineDegradedStage: degradedStage }
      expect(validateBackendEventPayload('diagnostics.stats', flagged)).toEqual(flagged)
    }
    const failedRecovery = {
      ...diagnostics,
      captureRecoveryPhase: 'failed',
      captureRecoverySource: 'camera',
      captureRecoveryAttempts: 1,
      captureRecoveryLastError: 'Camera cadence did not recover.',
      captureRecoveryLastDurationMs: 2_104
    }
    expect(validateBackendRpcResult('diagnostics.stats', failedRecovery)).toEqual(failedRecovery)
    expect(validateBackendEventPayload('diagnostics.stats', failedRecovery)).toEqual(failedRecovery)
    const failedScreenRecovery = {
      ...failedRecovery,
      captureRecoverySource: 'screen'
    } as const
    expect(validateBackendRpcResult('diagnostics.stats', failedScreenRecovery)).toEqual(
      failedScreenRecovery
    )
    for (const field of [
      'captureRecoveryPhase',
      'captureRecoverySource',
      'captureRecoveryAttempts',
      'captureRecoveryLastError',
      'captureRecoveryLastDurationMs'
    ] as const) {
      const nullable = { ...failedRecovery, [field]: null }
      expect(validateBackendRpcResult('diagnostics.stats', nullable)).toEqual(nullable)
      expect(validateBackendEventPayload('diagnostics.stats', nullable)).toEqual(nullable)
    }
    expect(() =>
      validateBackendEventPayload('diagnostics.stats', {
        ...diagnostics,
        capturePipelineDegradedStage: ''
      })
    ).toThrow('capturePipelineDegradedStage')
    for (const field of [
      'encoderBridgeOutputQueueOldestFrameAgeMs',
      'encoderBridgeOutputQueueOldestFrameAgeHighWaterMs',
      'encoderBridgeOutputLastProgressAgeMs'
    ]) {
      const nullable = { ...diagnostics, [field]: null }
      expect(validateBackendRpcResult('diagnostics.stats', nullable)).toEqual(nullable)
      expect(validateBackendEventPayload('diagnostics.stats', nullable)).toEqual(nullable)
      for (const invalid of [-1, Number.POSITIVE_INFINITY]) {
        expect(() =>
          validateBackendRpcResult('diagnostics.stats', {
            ...diagnostics,
            [field]: invalid
          })
        ).toThrow(field)
        expect(() =>
          validateBackendEventPayload('diagnostics.stats', {
            ...diagnostics,
            [field]: invalid
          })
        ).toThrow(field)
      }
    }
    for (const field of requiredCapturePressureDiagnosticFields) {
      const missing = { ...diagnostics }
      Reflect.deleteProperty(missing, field)
      expect(() => validateBackendRpcResult('diagnostics.stats', missing)).toThrow(field)
      expect(() => validateBackendEventPayload('diagnostics.stats', missing)).toThrow(field)
    }
    const misspelled = {
      ...diagnostics,
      previewScreenFrameStatues: diagnostics.previewScreenFrameStatuses
    }
    Reflect.deleteProperty(misspelled, 'previewScreenFrameStatuses')
    expect(() => validateBackendRpcResult('diagnostics.stats', misspelled)).toThrow(
      'previewScreenFrameStatuses'
    )
    expect(() => validateBackendEventPayload('diagnostics.stats', misspelled)).toThrow(
      'previewScreenFrameStatuses'
    )
    expect(() => validateBackendRpcResult('diagnostics.stats', { skippedFrames: -1 })).toThrow(
      'diagnostics.stats'
    )
    expect(() =>
      validateBackendRpcResult('diagnostics.stats', { ...diagnostics, compositorCpuFrames: -1 })
    ).toThrow('compositorCpuFrames')
    expect(() =>
      validateBackendRpcResult('diagnostics.stats', {
        ...diagnostics,
        compositorTickSkipped: 1.5
      })
    ).toThrow('compositorTickSkipped')
    expect(() =>
      validateBackendEventPayload('diagnostics.stats', {
        ...diagnostics,
        encoderBridgeEncodedAccessUnitDroppedFrames: -1
      })
    ).toThrow('encoderBridgeEncodedAccessUnitDroppedFrames')
    expect(() =>
      validateBackendRpcResult('diagnostics.stats', {
        ...diagnostics,
        previewImagePollCounts: {
          ...diagnostics.previewImagePollCounts,
          productionPng: -1
        }
      })
    ).toThrow('productionPng')
  })

  it('carries the maximal capture-pressure fixture through the diagnostics mirror', () => {
    type CapturePressureFields = Required<
      Pick<
        DiagnosticStats,
        | 'compositorSourceCaptureTextureReuses'
        | 'compositorCameraSourceCaptureTextureReuses'
        | 'compositorScreenSourceCaptureTextureReuses'
        | 'compositorSourceTextureCacheFlushes'
        | 'previewCameraCaptureCallbackCount'
        | 'previewCameraDidDropCallbackCount'
        | 'previewCameraFrameStorePublications'
        | 'previewCameraCaptureCallbackAgeMs'
        | 'previewCameraLatestSequence'
        | 'previewCameraCapturePixelFormat'
        | 'previewCameraDropReasons'
        | 'previewCameraSurfaceBacking'
        | 'previewScreenCaptureCallbackCount'
        | 'previewScreenFrameStorePublications'
        | 'previewScreenCaptureCallbackAgeMs'
        | 'previewScreenLatestSequence'
        | 'previewScreenFrameStatuses'
        | 'previewScreenSurfaceBacking'
      >
    >
    const capturePressure: CapturePressureFields = {
      compositorSourceCaptureTextureReuses: 120,
      compositorCameraSourceCaptureTextureReuses: 70,
      compositorScreenSourceCaptureTextureReuses: 50,
      compositorSourceTextureCacheFlushes: 6,
      previewCameraCaptureCallbackCount: 1_001,
      previewCameraDidDropCallbackCount: 17,
      previewCameraFrameStorePublications: 984,
      previewCameraCaptureCallbackAgeMs: 12,
      previewCameraLatestSequence: 984,
      previewCameraCapturePixelFormat: 'BGRA',
      previewCameraDropReasons: {
        frameWasLate: 3,
        outOfBuffers: 5,
        discontinuity: 7,
        unknown: 2
      },
      previewCameraSurfaceBacking: {
        liveCount: 2,
        peakCount: 4,
        estimatedBytes: 66_355_200,
        peakEstimatedBytes: 132_710_400,
        oldestAgeMs: 42
      },
      previewScreenCaptureCallbackCount: 1_010,
      previewScreenFrameStorePublications: 990,
      previewScreenCaptureCallbackAgeMs: 9,
      previewScreenLatestSequence: 990,
      previewScreenFrameStatuses: {
        complete: 990,
        idle: 4,
        blank: 3,
        suspended: 2,
        started: 1,
        stopped: 1,
        unknown: 9
      },
      previewScreenSurfaceBacking: {
        liveCount: 3,
        peakCount: 6,
        estimatedBytes: 99_532_800,
        peakEstimatedBytes: 199_065_600,
        oldestAgeMs: 31
      }
    }
    const diagnostics = {
      skippedFrames: 0,
      droppedFrames: 0,
      ...capturePressure
    }

    expect(validateBackendRpcResult('diagnostics.stats', diagnostics)).toEqual(diagnostics)
    expect(validateBackendEventPayload('diagnostics.stats', diagnostics)).toEqual(diagnostics)
    expect(() =>
      validateBackendRpcResult('diagnostics.stats', {
        ...diagnostics,
        compositorSourceTextureCacheFlushes: -1
      })
    ).toThrow('compositorSourceTextureCacheFlushes')
    expect(() =>
      validateBackendRpcResult('diagnostics.stats', {
        ...diagnostics,
        previewCameraCaptureCallbackAgeMs: null
      })
    ).toThrow('previewCameraCaptureCallbackAgeMs')
    expect(() =>
      validateBackendRpcResult('diagnostics.stats', {
        ...diagnostics,
        previewCameraDropReasons: {
          ...diagnostics.previewCameraDropReasons,
          outOfBuffers: -1
        }
      })
    ).toThrow('outOfBuffers')
    expect(() =>
      validateBackendRpcResult('diagnostics.stats', {
        ...diagnostics,
        previewScreenFrameStatuses: {
          ...diagnostics.previewScreenFrameStatuses,
          stale: 1
        }
      })
    ).toThrow('stale must be a known field')
  })

  it('validates scalar-only Windows D3D11 media diagnostics', () => {
    const windowsD3d11Media = {
      state: 'live',
      requested: true,
      required: true,
      adapterLuid: '00000000:00001234',
      captureAdapterLuid: '00000000:00001234',
      compositorAdapterLuid: '00000000:00001234',
      primaryEncoderAdapterLuid: '00000000:00001234',
      auxiliaryEncoderAdapterLuid: '00000000:00001234',
      generation: 3,
      captureBackend: 'desktop-duplication',
      cursorMode: 'separate',
      cursorRequested: true,
      cursorPixelsSource: 'desktop-duplication-shape',
      cursorExclusionGuaranteed: false,
      captureReadbackFrames: 0,
      protectedContentMaskedFrames: 3,
      textureImportFrames: 120,
      cameraUploadFrames: 0,
      cursorShapeUploads: 2,
      cursorCompositedFrames: 30,
      compositorCpuFallbackFrames: 0,
      previewPresents: 120,
      previewDrops: 1,
      previewBmpRequests: 0,
      previewBmpBytes: 0,
      messagePumpLagP95Ms: 2,
      messagePumpLagMaxMs: 8,
      mediaCommandLagP95Ms: 3,
      mediaCommandLagMaxMs: 9,
      maximumConsecutiveMessageBatch: 4,
      maximumConsecutiveMediaBatch: 8,
      encoderGpuSamples: 120,
      encoderSystemMemorySamples: 0,
      rawVideoCopiedFrames: 0,
      texturePoolCapacity: 8,
      texturePoolInUse: 3,
      texturePoolPressureEvents: 0,
      adapterMismatches: 0,
      deviceResets: 0,
      synchronizationTimeouts: 0,
      staleGenerationCallbacks: 0,
      renderTickOverruns: 2,
      renderTickLagMaxMs: 4.5,
      renderComposeStageMaxMs: 1.25
    }
    const diagnostics = {
      skippedFrames: 0,
      droppedFrames: 0,
      ...idleCapturePressureDiagnostics,
      compositorBackend: 'd3d11',
      windowsD3d11Media
    }

    expect(validateBackendRpcResult('diagnostics.stats', diagnostics)).toEqual(diagnostics)
    const switchedCapture = JSON.parse(
      JSON.stringify({
        ...diagnostics,
        windowsD3d11Media: {
          ...windowsD3d11Media,
          captureBackend: 'preview-bgra-upload',
          captureAdapterLuid: undefined,
          cursorMode: undefined,
          cursorPixelsSource: undefined,
          cursorRequested: false,
          captureReadbackFrames: 60,
          rawVideoCopiedFrames: 60,
          compositorCpuFallbackFrames: 0
        }
      })
    )
    expect(validateBackendRpcResult('diagnostics.stats', switchedCapture)).toEqual(switchedCapture)

    expect(() =>
      validateBackendRpcResult('diagnostics.stats', {
        ...diagnostics,
        windowsD3d11Media: {
          ...windowsD3d11Media,
          protectedContentMaskedFrames: -1
        }
      })
    ).toThrow('protectedContentMaskedFrames')
    const diagnosticsWithoutWindowsMedia = {
      skippedFrames: 0,
      droppedFrames: 0,
      ...idleCapturePressureDiagnostics
    }
    expect(validateBackendRpcResult('diagnostics.stats', diagnosticsWithoutWindowsMedia)).toEqual(
      diagnosticsWithoutWindowsMedia
    )
    expect(() =>
      validateBackendRpcResult('diagnostics.stats', {
        skippedFrames: 0,
        droppedFrames: 0,
        compositorBackend: null
      })
    ).toThrow('compositorBackend')
    expect(() =>
      validateBackendRpcResult('diagnostics.stats', {
        ...diagnostics,
        windowsD3d11Media: {
          ...windowsD3d11Media,
          sharedTextureHandle: '0x0000000000000001'
        }
      })
    ).toThrow('sharedTextureHandle')
    expect(() =>
      validateBackendRpcResult('diagnostics.stats', {
        ...diagnostics,
        windowsD3d11Media: {
          ...windowsD3d11Media,
          synchronizationTimeouts: -1
        }
      })
    ).toThrow('synchronizationTimeouts')
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

  it('validates clip marks: the mark reply, the marked event, and the list (plan 068 D6)', () => {
    const saved = { sessionId: 'session-1', atSeconds: 754.2, source: 'manual', saved: true }
    expect(validateBackendRpcResult('clip.mark', saved)).toEqual(saved)
    expect(validateBackendEventPayload('clip.marked', saved)).toEqual(saved)
    const unsaved = {
      sessionId: 'session-1',
      atSeconds: 61.5,
      source: 'voice',
      saved: false,
      reason: 'recording-off'
    }
    expect(validateBackendEventPayload('clip.marked', unsaved)).toEqual(unsaved)
    // The serde-null trap: an absent reason is omitted, never null.
    expect(() => validateBackendEventPayload('clip.marked', { ...saved, reason: null })).toThrow(
      'clip.marked'
    )
    expect(() => validateBackendEventPayload('clip.marked', { ...saved, source: 'chat' })).toThrow(
      'clip.marked'
    )
    expect(() => validateBackendEventPayload('clip.marked', { ...saved, extra: 1 })).toThrow(
      'clip.marked'
    )

    expect(validateBackendRpcParams('clip.marks.list', { sessionId: 'session-1' })).toEqual({
      sessionId: 'session-1'
    })
    const marks = [
      {
        id: 'mark-1',
        sessionId: 'session-1',
        atSeconds: 61.5,
        source: 'voice',
        phrase: 'clip that',
        createdAt: '2026-09-27T10:01:01Z'
      },
      {
        id: 'mark-2',
        sessionId: 'session-1',
        atSeconds: 754.2,
        source: 'manual',
        createdAt: '2026-09-27T10:12:34Z'
      }
    ]
    expect(validateBackendRpcResult('clip.marks.list', marks)).toEqual(marks)
    expect(() =>
      validateBackendRpcResult('clip.marks.list', [{ ...marks[1], phrase: null }])
    ).toThrow('clip.marks.list')
  })

  it('validates the Buddy report RPCs and the saved event (plan 119 S1)', () => {
    const report = {
      version: 1,
      sessionId: 'session-1',
      startedAt: '2026-10-04T10:00:00Z',
      endedAt: '2026-10-04T11:00:00Z',
      segments: 1,
      streamTitle: 'Rust night',
      messagesSeen: 84,
      shownOnStream: 2,
      questions: {
        total: 5,
        markedAnswered: 1,
        dismissed: 1,
        replied: 1,
        answeredOnAir: 1,
        restored: 0,
        shownOnStream: 1,
        items: [
          {
            id: 'q_1',
            text: 'What keyboard is that?',
            askers: ['Viewer'],
            platforms: ['twitch'],
            priority: 'high',
            firstSeenAt: '2026-10-04T10:00:00Z',
            outcome: 'replied'
          },
          {
            id: 'q_2',
            text: 'Which editor?',
            priority: 'normal',
            firstSeenAt: '2026-10-04T10:20:00Z',
            outcome: 'open'
          }
        ]
      },
      flags: {
        raised: 1,
        dismissed: 1,
        byKind: [{ kind: 'spam', count: 1 }],
        bySeverity: [{ severity: 'low', count: 1 }]
      },
      promises: {
        heard: 2,
        kept: 1,
        dismissed: 0,
        reminded: 1,
        open: [{ text: 'Giveaway at 100 viewers', firstSeenAt: '2026-10-04T10:05:00Z' }]
      },
      greetings: {
        firstTimers: 3,
        firstTimersGreeted: 2,
        byVoice: 1,
        byChat: 1,
        onStream: 0,
        manual: 1
      },
      alerts: [
        { kind: 'audio', peakViewers: 2, active: true, firstSeenAt: '2026-10-04T10:40:00Z' }
      ],
      recap: { offered: 1, drafted: 0, dismissed: 1 }
    }
    const payload = {
      sessionId: 'session-1',
      report,
      moments: [
        {
          startMs: 275_400,
          endMs: 312_000,
          reason: "You said 'clip that'",
          excerpt: 'and it actually works first try clip that',
          source: 'voice'
        }
      ],
      chat: { messages: 84, byPlatform: [{ platform: 'twitch', messages: 84 }] }
    }
    expect(validateBackendRpcParams('cohost.report.get', { sessionId: 'session-1' })).toEqual({
      sessionId: 'session-1'
    })
    expect(validateBackendRpcResult('cohost.report.get', payload)).toEqual(payload)
    expect(validateBackendRpcResult('cohost.report.latest', payload)).toEqual(payload)
    expect(validateBackendRpcResult('cohost.report.latest', null)).toBeNull()
    const noReport = {
      sessionId: 'session-1',
      report: null,
      moments: [],
      chat: { messages: 0, byPlatform: [] }
    }
    expect(validateBackendRpcResult('cohost.report.get', noReport)).toEqual(noReport)
    expect(validateBackendEventPayload('cohost.report.saved', { sessionId: 'session-1' })).toEqual({
      sessionId: 'session-1'
    })

    // The serde-null trap: optional fields are absent, never null.
    for (const broken of [
      { ...report, streamTitle: null },
      { ...report, alerts: null },
      { ...report, questions: { ...report.questions, items: null } },
      { ...report, promises: { ...report.promises, open: null } }
    ]) {
      expect(() =>
        validateBackendRpcResult('cohost.report.get', { ...payload, report: broken })
      ).toThrow('cohost.report.get')
    }
    // Closed shapes, a pinned version and a closed outcome vocabulary.
    expect(() =>
      validateBackendRpcResult('cohost.report.get', {
        ...payload,
        report: { ...report, version: 2 }
      })
    ).toThrow('cohost.report.get')
    expect(() =>
      validateBackendRpcResult('cohost.report.get', { ...payload, report: { ...report, extra: 1 } })
    ).toThrow('cohost.report.get')
    expect(() =>
      validateBackendRpcResult('cohost.report.get', {
        ...payload,
        report: {
          ...report,
          questions: {
            ...report.questions,
            items: [{ ...report.questions.items[0], outcome: 'teleported' }]
          }
        }
      })
    ).toThrow('cohost.report.get')
    expect(() =>
      validateBackendRpcResult('cohost.report.get', {
        ...payload,
        moments: [{ ...payload.moments[0], source: null }]
      })
    ).toThrow('cohost.report.get')
    expect(() =>
      validateBackendEventPayload('cohost.report.saved', { sessionId: 'session-1', extra: true })
    ).toThrow('cohost.report.saved')
  })

  it('carries Greetings AI, the welcomes and why greetings were skipped (plan 192)', () => {
    const oldAutoChat = {
      mode: 'auto',
      greetings: { enabled: true, templates: [] },
      answers: { enabled: false, cooldownSeconds: 20 },
      banter: { enabled: false, cooldownSeconds: 240 }
    }
    const settings = {
      enabled: true,
      tone: 'friendly',
      notes: '',
      autoHighlight: false,
      voiceHighlight: false,
      rules: [],
      listen: false,
      wakeWordRequired: false,
      removeConfirm: 'confirm',
      persona: {
        id: 'default',
        name: 'Buddy',
        personality: '',
        bubbleStyle: 'speech',
        images: {},
        source: 'default',
        avatar: { kind: 'still' },
        motion: { intensity: 0.45, sleepAfterSeconds: 180, breathing: true },
        reactions: {}
      },
      autoChat: oldAutoChat
    }
    // An older backend sends neither field: its settings still load.
    expect(validateBackendRpcResult('cohost.settings.get', settings)).toEqual(settings)
    expect(validateBackendRpcParams('cohost.settings.set', { autoChat: oldAutoChat })).toEqual({
      autoChat: oldAutoChat
    })
    // Plan 211 D3: `talk` is the mode (three values, absent never null); the
    // legacy `mode` rides along.
    for (const talk of ['off', 'bubble', 'suggest']) {
      const block = { ...oldAutoChat, mode: 'off', talk }
      expect(
        validateBackendRpcResult('cohost.settings.get', { ...settings, autoChat: block })
      ).toEqual({ ...settings, autoChat: block })
      expect(validateBackendRpcParams('cohost.settings.set', { autoChat: block })).toEqual({
        autoChat: block
      })
    }
    for (const talk of ['auto', 'loud', null, 1]) {
      const block = { ...oldAutoChat, talk }
      expect(() => validateBackendRpcParams('cohost.settings.set', { autoChat: block })).toThrow(
        'cohost.settings.set'
      )
      expect(() =>
        validateBackendRpcResult('cohost.settings.get', { ...settings, autoChat: block })
      ).toThrow('cohost.settings.get')
    }

    const welcomes = {
      firstTime: { enabled: true },
      returning: { enabled: false, text: 'Yo {name}!', state: 'laugh', reaction: 'wave' }
    }
    const greetings = { enabled: true, templates: [], ai: true, welcomes }
    const autoChat = { ...oldAutoChat, greetings, answers: { enabled: true, cooldownSeconds: 20 } }
    expect(validateBackendRpcResult('cohost.settings.get', { ...settings, autoChat })).toEqual({
      ...settings,
      autoChat
    })
    expect(validateBackendRpcParams('cohost.settings.set', { autoChat })).toEqual({ autoChat })

    // Absent, never null (the serde-null trap); closed shapes; an empty line
    // is absent, not ''.
    for (const broken of [
      { ...greetings, ai: null },
      { ...greetings, ai: 'yes' },
      { ...greetings, welcomes: null },
      { ...greetings, welcomes: { firstTime: welcomes.firstTime } },
      { ...greetings, welcomes: { ...welcomes, everyone: { enabled: true } } },
      { ...greetings, welcomes: { ...welcomes, firstTime: {} } },
      { ...greetings, welcomes: { ...welcomes, firstTime: { enabled: true, text: null } } },
      { ...greetings, welcomes: { ...welcomes, firstTime: { enabled: true, text: '' } } },
      {
        ...greetings,
        welcomes: { ...welcomes, firstTime: { enabled: true, text: 'x'.repeat(201) } }
      },
      { ...greetings, welcomes: { ...welcomes, firstTime: { enabled: true, state: 'idle' } } },
      { ...greetings, welcomes: { ...welcomes, firstTime: { enabled: true, reaction: null } } },
      { ...greetings, welcomes: { ...welcomes, firstTime: { enabled: true, extra: 1 } } },
      { ...greetings, extra: true }
    ]) {
      const broke = { ...autoChat, greetings: broken }
      expect(() => validateBackendRpcParams('cohost.settings.set', { autoChat: broke })).toThrow(
        'cohost.settings.set'
      )
      expect(() =>
        validateBackendRpcResult('cohost.settings.get', { ...settings, autoChat: broke })
      ).toThrow('cohost.settings.get')
    }
    // The welcome kinds never ride templates[] (S1.1): an older app would
    // load defaults and its next save would wipe the persona.
    expect(() =>
      validateBackendRpcParams('cohost.settings.set', {
        autoChat: {
          ...autoChat,
          greetings: {
            ...greetings,
            templates: [
              { id: 't', kind: 'first-time', text: 'Hi {name}', state: 'talk', enabled: true }
            ]
          }
        }
      })
    ).toThrow('cohost.settings.set')

    const report = {
      version: 1,
      sessionId: 'session-1',
      startedAt: '2026-10-24T16:20:00Z',
      endedAt: '2026-10-24T17:43:00Z',
      segments: 1,
      messagesSeen: 300,
      shownOnStream: 0,
      questions: {
        total: 0,
        markedAnswered: 0,
        dismissed: 0,
        replied: 0,
        answeredOnAir: 0,
        restored: 0,
        shownOnStream: 0
      },
      flags: { raised: 0, dismissed: 0 },
      promises: { heard: 0, kept: 0, dismissed: 0, reminded: 0 },
      greetings: {
        firstTimers: 4,
        firstTimersGreeted: 4,
        byVoice: 0,
        byChat: 4,
        onStream: 0,
        manual: 0,
        skipped: { noLine: 3, held: 2 }
      },
      recap: { offered: 0, drafted: 0, dismissed: 0 },
      posts: [
        {
          id: 'u-1',
          at: '2026-10-24T16:21:00Z',
          trigger: 'greeting',
          text: 'Hi Ana, welcome to the stream!',
          destinations: ['twitch'],
          result: 'sent',
          source: 'ai'
        },
        {
          id: 'u-2',
          at: '2026-10-24T16:22:00Z',
          trigger: 'greeting',
          text: 'Welcome back, Bo!',
          destinations: ['youtube'],
          result: 'sent',
          source: 'line'
        },
        {
          id: 'u-3',
          at: '2026-10-24T16:23:00Z',
          trigger: 'manual',
          text: 'hello',
          destinations: ['twitch'],
          result: 'sent'
        }
      ]
    }
    const payload = {
      sessionId: 'session-1',
      report,
      moments: [],
      chat: { messages: 300, byPlatform: [{ platform: 'twitch', messages: 300 }] }
    }
    expect(validateBackendRpcResult('cohost.report.get', payload)).toEqual(payload)
    expect(
      validateBackendRpcResult('cohost.report.get', {
        ...payload,
        report: {
          ...report,
          greetings: {
            ...report.greetings,
            skipped: {
              noLine: 1,
              modeOff: 2,
              stale: 3,
              deduped: 4,
              held: 5,
              destinationFailed: 6,
              youtubePaused: 7
            }
          }
        }
      })
    ).toBeTruthy()
    // An older report has neither field.
    const { skipped: _skipped, ...oldGreetings } = report.greetings
    const oldReport = {
      ...report,
      greetings: oldGreetings,
      posts: report.posts.map(({ source: _source, ...post }) => post)
    }
    expect(
      validateBackendRpcResult('cohost.report.get', { ...payload, report: oldReport })
    ).toEqual({ ...payload, report: oldReport })
    for (const broken of [
      { ...report, greetings: { ...report.greetings, skipped: null } },
      { ...report, greetings: { ...report.greetings, skipped: { noLine: null } } },
      { ...report, greetings: { ...report.greetings, skipped: { noLine: -1 } } },
      { ...report, greetings: { ...report.greetings, skipped: { muted: 1 } } },
      { ...report, posts: [{ ...report.posts[0], source: null }] },
      { ...report, posts: [{ ...report.posts[0], source: 'human' }] }
    ]) {
      expect(() =>
        validateBackendRpcResult('cohost.report.get', { ...payload, report: broken })
      ).toThrow('cohost.report.get')
    }
  })

  it('validates the Live Co-host RPCs and state event against the wire contract', () => {
    const state = {
      sessionId: 'session-1',
      status: 'listening',
      reason: null,
      questions: [
        {
          id: 'q_1',
          text: 'What keyboard is that?',
          messageIds: ['session-1:twitch:default:m-1'],
          askers: ['Viewer'],
          platforms: ['twitch', 'youtube'],
          priority: 'high',
          suggestedReply: 'Keychron Q1!',
          fromNotes: true,
          firstSeenAt: '2026-08-22T10:00:00Z',
          updatedAt: '2026-08-22T10:00:20Z'
        }
      ],
      flags: [
        {
          messageId: 'session-1:twitch:default:m-2',
          kind: 'spam',
          severity: 'medium',
          reason: 'Link spam.',
          at: '2026-08-22T10:00:20Z'
        }
      ],
      mood: 'hype',
      lastTickAt: '2026-08-22T10:00:20Z',
      tickSeq: 2,
      partial: false
    }
    expect(validateBackendEventPayload('cohost.state', state)).toEqual(state)
    expect(validateBackendRpcResult('cohost.status', state)).toEqual(state)

    // One question can gather askers from every platform, Kick included. The
    // cap is the platform count, never a literal (plan 206: an 8th platform
    // failed every audience, viewer and co-host event against `maxLength: 7`).
    const everyPlatform = [...STREAM_PLATFORMS]
    expect(everyPlatform).toContain('facebook')
    const widest = { ...state, questions: [{ ...state.questions[0], platforms: everyPlatform }] }
    expect(validateBackendEventPayload('cohost.state', widest)).toEqual(widest)
    expect(() =>
      validateBackendEventPayload('cohost.state', {
        ...state,
        questions: [{ ...state.questions[0], platforms: [...everyPlatform, 'kick'] }]
      })
    ).toThrow()
    const audience = {
      sessionId: 'every-platform',
      platforms: everyPlatform.map((platform) => ({
        platform,
        metric: 'followers',
        capability: 'unavailable'
      })),
      updatedAt: '2026-10-27T00:00:00Z'
    }
    expect(validateBackendRpcResult('stream.audience.snapshot', audience)).toEqual(audience)
    expect(() =>
      validateBackendRpcResult('stream.audience.snapshot', {
        ...audience,
        platforms: [...audience.platforms, audience.platforms[0]]
      })
    ).toThrow()
    const viewers = {
      sessionId: 'every-platform',
      platforms: everyPlatform.map((platform) => ({ platform, count: 1 })),
      total: everyPlatform.length,
      at: '2026-10-27T00:00:00Z'
    }
    expect(validateBackendRpcResult('sessions.viewers.list', { samples: [viewers] })).toEqual({
      samples: [viewers]
    })
    expect(() =>
      validateBackendRpcResult('sessions.viewers.list', {
        samples: [{ ...viewers, platforms: [...viewers.platforms, viewers.platforms[0]] }]
      })
    ).toThrow()

    // Presence fields (W1): optional so a pre-presence backend still
    // validates (`state` above omits them), typed when present.
    const working = {
      ...state,
      tickInFlight: true,
      pendingMessages: 4,
      nextTickAt: '2026-08-22T10:00:28Z',
      messagesSeen: 84,
      questionsTotal: 5
    }
    expect(validateBackendEventPayload('cohost.state', working)).toEqual(working)

    // Tick wire v2: every flag kind the backend can emit validates — including
    // `unknown`, its catch-all for a kind newer than this build — and the
    // optional extras are absent-or-typed, never null.
    const v2 = {
      ...working,
      flags: [
        {
          ...state.flags[0],
          kind: 'unknown',
          confidence: 0.4,
          target: 'group',
          action: 'hide',
          alsoKinds: ['scam', 'unknown'],
          rule: 'No spoilers'
        }
      ],
      highlights: [{ messageId: 'session-1:twitch:default:m-3', score: 0.8, type: 'joke' }],
      alerts: [{ kind: 'audio', viewers: 2, lastSeenAt: '2026-08-22T10:00:20Z', active: true }],
      moodScores: { hype: 0.2, tension: 0.7, confusion: 0.1 }
    }
    expect(validateBackendEventPayload('cohost.state', v2)).toEqual(v2)
    expect(() =>
      validateBackendEventPayload('cohost.state', {
        ...v2,
        flags: [{ ...v2.flags[0], confidence: null }]
      })
    ).toThrow('cohost.state')
    expect(() => validateBackendEventPayload('cohost.state', { ...v2, moodScores: null })).toThrow(
      'cohost.state'
    )
    // Plan 060 S3: spotlight + recently resolved are absent-or-typed, never
    // null; the spotlight's questionId is optional; at most three resolved.
    const spotlit = {
      ...v2,
      spotlight: {
        messageId: 'session-1:twitch:default:m-3',
        score: 0.9,
        at: '2026-08-22T10:00:21Z',
        expiresAt: '2026-08-22T10:00:36Z'
      },
      recentlyResolved: [
        { question: state.questions[0], reason: 'voice', resolvedAt: '2026-08-22T10:00:21Z' }
      ]
    }
    expect(validateBackendEventPayload('cohost.state', spotlit)).toEqual(spotlit)
    expect(validateBackendRpcResult('cohost.question.restore', spotlit)).toEqual(spotlit)
    expect(
      validateBackendRpcParams('cohost.question.restore', {
        sessionId: 'live-1',
        questionId: 'q-1'
      })
    ).toEqual({ sessionId: 'live-1', questionId: 'q-1' })
    expect(() => validateBackendEventPayload('cohost.state', { ...v2, spotlight: null })).toThrow(
      'cohost.state'
    )
    expect(() =>
      validateBackendEventPayload('cohost.state', { ...v2, recentlyResolved: null })
    ).toThrow('cohost.state')
    expect(() =>
      validateBackendEventPayload('cohost.state', {
        ...spotlit,
        spotlight: { ...spotlit.spotlight, score: 1.5 }
      })
    ).toThrow('cohost.state')
    expect(() =>
      validateBackendEventPayload('cohost.state', {
        ...spotlit,
        recentlyResolved: Array(4).fill(spotlit.recentlyResolved[0])
      })
    ).toThrow('cohost.state')
    expect(validateBackendRpcResult('cohost.status', working)).toEqual(working)
    expect(validateBackendEventPayload('cohost.state', { ...working, nextTickAt: null })).toEqual({
      ...working,
      nextTickAt: null
    })
    expect(() =>
      validateBackendEventPayload('cohost.state', { ...working, pendingMessages: -1 })
    ).toThrow('cohost.state')
    expect(() =>
      validateBackendEventPayload('cohost.state', { ...working, pendingMessages: 1.5 })
    ).toThrow('cohost.state')
    expect(() =>
      validateBackendEventPayload('cohost.state', { ...working, tickInFlight: 'yes' })
    ).toThrow('cohost.state')
    expect(() =>
      validateBackendEventPayload('cohost.state', { ...working, nextTickAt: 12 })
    ).toThrow('cohost.state')
    expect(() =>
      validateBackendEventPayload('cohost.state', { ...working, messagesSeen: -4 })
    ).toThrow('cohost.state')
    const off = {
      sessionId: null,
      status: 'off',
      reason: null,
      questions: [],
      flags: [],
      mood: null,
      lastTickAt: null,
      tickSeq: 0,
      partial: false
    }
    expect(validateBackendRpcResult('cohost.stop', off)).toEqual(off)
    expect(() =>
      validateBackendEventPayload('cohost.state', { ...state, status: 'running' })
    ).toThrow('cohost.state')
    expect(() =>
      validateBackendEventPayload('cohost.state', { ...state, reason: 'unknown-reason' })
    ).toThrow('cohost.state')
    expect(() => validateBackendEventPayload('cohost.state', { ...state, extra: 1 })).toThrow(
      'cohost.state'
    )

    // `detail` names the failed tick; it is optional (older backend), nullable,
    // and closed: a bad code/status shape fails the event like any other.
    const detail = {
      code: 'ai-gateway-error',
      message: 'The Buddy tick failed on every configured model.',
      status: 502
    }
    const errored = { ...state, status: 'error', reason: 'gateway-error', detail }
    expect(validateBackendEventPayload('cohost.state', errored)).toEqual(errored)
    expect(validateBackendRpcResult('cohost.status', errored)).toEqual(errored)
    const timedOut = {
      ...state,
      status: 'error',
      reason: 'network',
      detail: { code: 'timeout', message: 'No answer within 12 s.', status: null }
    }
    expect(validateBackendEventPayload('cohost.state', timedOut)).toEqual(timedOut)
    expect(validateBackendEventPayload('cohost.state', { ...state, detail: null })).toEqual({
      ...state,
      detail: null
    })
    expect(() =>
      validateBackendEventPayload('cohost.state', { ...errored, detail: { ...detail, code: '' } })
    ).toThrow('cohost.state')
    expect(() =>
      validateBackendEventPayload('cohost.state', {
        ...errored,
        detail: { ...detail, status: '502' }
      })
    ).toThrow('cohost.state')
    expect(() =>
      validateBackendEventPayload('cohost.state', {
        ...errored,
        detail: { ...detail, extra: true }
      })
    ).toThrow('cohost.state')

    const start = { sessionId: 'session-1', consentToProcessChat: true, streamTitle: 'Rust night' }
    expect(validateBackendRpcParams('cohost.start', start)).toEqual(start)
    expect(validateBackendRpcParams('cohost.start', { sessionId: 'session-1' })).toEqual({
      sessionId: 'session-1'
    })
    expect(() => validateBackendRpcParams('cohost.start', { sessionId: '' })).toThrow(
      'cohost.start'
    )
    expect(validateBackendRpcParams('cohost.status', undefined)).toBeUndefined()
    const question = { sessionId: 'session-1', questionId: 'q_1' }
    expect(validateBackendRpcParams('cohost.question.answered', question)).toEqual(question)
    expect(validateBackendRpcParams('cohost.question.dismiss', question)).toEqual(question)
    const flag = { sessionId: 'session-1', messageId: 'session-1:twitch:default:m-2' }
    expect(validateBackendRpcParams('cohost.flag.dismiss', flag)).toEqual(flag)

    const settings = {
      enabled: true,
      tone: 'short',
      notes: 'Keychron Q1',
      autoHighlight: false,
      voiceHighlight: false,
      rules: ['No spoilers'],
      listen: false,
      wakeWordRequired: false,
      removeConfirm: 'confirm',
      persona: {
        id: 'default',
        name: 'Buddy',
        personality: '',
        bubbleStyle: 'speech',
        images: {},
        source: 'default',
        avatar: { kind: 'still' },
        motion: { intensity: 0.45, sleepAfterSeconds: 180, breathing: true },
        reactions: {}
      },
      autoChat: {
        mode: 'off',
        greetings: { enabled: false, templates: [] },
        answers: { enabled: false, cooldownSeconds: 20 },
        banter: { enabled: false, cooldownSeconds: 240 }
      }
    }
    expect(validateBackendRpcResult('cohost.settings.get', settings)).toEqual(settings)
    expect(validateBackendRpcParams('cohost.settings.set', { listen: true })).toEqual({
      listen: true
    })
    expect(validateBackendRpcParams('cohost.settings.set', { rules: [' English only '] })).toEqual({
      rules: [' English only ']
    })
    // The backend normalises rules to <= 10 x 120 before it answers.
    expect(() =>
      validateBackendRpcResult('cohost.settings.get', { ...settings, rules: Array(11).fill('r') })
    ).toThrow('cohost.settings.get')
    expect(validateBackendRpcParams('cohost.settings.set', { tone: 'professional' })).toEqual({
      tone: 'professional'
    })
    expect(() => validateBackendRpcParams('cohost.settings.set', { tone: 'angry' })).toThrow(
      'cohost.settings.set'
    )
    expect(() =>
      validateBackendRpcParams('cohost.settings.set', { notes: 'n'.repeat(4001) })
    ).toThrow('cohost.settings.set')
    expectTypeOf<BackendRpcResult<'cohost.start'>>().toEqualTypeOf<
      BackendEventMap['cohost.state']
    >()
    expectTypeOf<BackendRpcParams<'cohost.start'>['sessionId']>().toEqualTypeOf<string>()
  })

  it('validates the anonymous usage stats switch', () => {
    const on = { enabled: true, envDisabled: false }
    expect(validateBackendRpcResult('usageStats.get', on)).toEqual(on)
    const forcedOff = { enabled: false, envDisabled: true }
    expect(validateBackendRpcResult('usageStats.set', forcedOff)).toEqual(forcedOff)
    expect(validateBackendRpcParams('usageStats.set', { enabled: false })).toEqual({
      enabled: false
    })
    expect(() => validateBackendRpcParams('usageStats.set', {})).toThrow('usageStats.set')
    expect(() => validateBackendRpcParams('usageStats.set', { enabled: 'no' })).toThrow(
      'usageStats.set'
    )
    expect(() =>
      validateBackendRpcParams('usageStats.set', { enabled: true, installId: 'x' })
    ).toThrow('usageStats.set')
    expect(() => validateBackendRpcResult('usageStats.get', { enabled: true })).toThrow(
      'usageStats.get'
    )
  })

  it('validates the 7TV emote switch, its status and its event (plan 089)', () => {
    const linked = {
      sevenTv: true,
      sevenTvStatus: {
        state: 'linked',
        setName: 'Halloween Emotes 2026',
        emoteCount: 986,
        globalCount: 45,
        platforms: ['twitch', 'kick', 'youtube']
      },
      twitchGifs: 'animated'
    }
    expect(validateBackendRpcResult('liveChat.emotes.get', linked)).toEqual(linked)
    expect(validateBackendEventPayload('liveChat.emotes', linked)).toEqual(linked)
    const off = { sevenTv: false, sevenTvStatus: { state: 'off' }, twitchGifs: 'still' }
    expect(validateBackendRpcResult('liveChat.emotes.set', off)).toEqual(off)
    expect(validateBackendRpcParams('liveChat.emotes.set', { sevenTv: false })).toEqual({
      sevenTv: false
    })
    // Plan 155: the GIF mode is one of three words, and always present.
    expect(validateBackendRpcParams('liveChat.emotes.set', { twitchGifs: 'off' })).toEqual({
      twitchGifs: 'off'
    })
    expect(() => validateBackendRpcParams('liveChat.emotes.set', { twitchGifs: 'paused' })).toThrow(
      'liveChat.emotes.set'
    )
    expect(() =>
      validateBackendRpcResult('liveChat.emotes.get', {
        sevenTv: false,
        sevenTvStatus: { state: 'off' }
      })
    ).toThrow('liveChat.emotes.get')
    // The backend never sends null or unknown keys; refuse them loudly.
    expect(() =>
      validateBackendRpcResult('liveChat.emotes.get', {
        ...linked,
        sevenTvStatus: { state: 'linked', setName: null }
      })
    ).toThrow('liveChat.emotes.get')
    expect(() =>
      validateBackendRpcResult('liveChat.emotes.get', {
        ...linked,
        sevenTvStatus: { state: 'paused' }
      })
    ).toThrow('liveChat.emotes.get')
    expect(() =>
      validateBackendRpcParams('liveChat.emotes.set', { sevenTv: true, bttv: true })
    ).toThrow('liveChat.emotes.set')
  })

  it('accepts the youtube.quota event with and without a pause end', () => {
    const paused = { pausedUntil: '2026-10-03T07:00:00Z' }
    expect(validateBackendEventPayload('youtube.quota', paused)).toEqual(paused)
    expect(validateBackendEventPayload('youtube.quota', {})).toEqual({})
    expect(validateBackendRpcResult('youtube.quota.status', paused)).toEqual(paused)
    expect(() => validateBackendEventPayload('youtube.quota', { pausedUntil: null })).toThrow()
    // Plan 094 (S6): the per-install budget rides along, every step named.
    const budgeted = { budget: { units: 2000, limit: 2500, step: 'shed-extras' } }
    expect(validateBackendEventPayload('youtube.quota', budgeted)).toEqual(budgeted)
    expect(validateBackendRpcResult('youtube.quota.status', { ...paused, ...budgeted })).toEqual({
      ...paused,
      ...budgeted
    })
    expect(() =>
      validateBackendEventPayload('youtube.quota', {
        budget: { units: 1, limit: 2500, step: 'panic' }
      })
    ).toThrow()
    expect(() =>
      validateBackendEventPayload('youtube.quota', {
        budget: { units: -1, limit: 2500, step: 'normal' }
      })
    ).toThrow()
  })

  it('types and exactly validates the chat moderation RPCs and event (plan 140)', () => {
    const operation = {
      operationId: '0f1e2d3c-4b5a-4968-8777-66554433aabb',
      sessionId: 'session-1',
      messageId: 'session-1:twitch:default:m-1',
      platform: 'twitch',
      authorName: 'coders_x',
      excerpt: 'this stream is trash',
      source: 'orcle-voice',
      reason: 'toxic',
      phase: 'pending-confirm',
      confirmMode: 'confirm',
      requiresExplicitConfirm: true,
      confirmBy: '2026-10-04T12:00:20Z',
      createdAt: '2026-10-04T12:00:00Z',
      updatedAt: '2026-10-04T12:00:00Z'
    }
    expectTypeOf<BackendEventMap['liveChat.moderationOperation']>().toEqualTypeOf<
      BackendRpcResult<'liveChat.moderation.request'>
    >()
    expect(validateBackendEventPayload('liveChat.moderationOperation', operation)).toEqual(
      operation
    )
    expect(validateBackendRpcResult('liveChat.moderation.request', operation)).toEqual(operation)
    const request = {
      operationId: operation.operationId,
      messageId: operation.messageId,
      source: 'orcle-voice',
      reason: 'toxic',
      confirmMode: 'countdown'
    }
    expect(validateBackendRpcParams('liveChat.moderation.request', request)).toEqual(request)
    // The manual row action: no reason, no mode (the backend defaults it).
    const manual = {
      operationId: operation.operationId,
      messageId: operation.messageId,
      source: 'manual'
    }
    expect(validateBackendRpcParams('liveChat.moderation.request', manual)).toEqual(manual)
    for (const method of ['liveChat.moderation.confirm', 'liveChat.moderation.cancel'] as const) {
      expect(validateBackendRpcParams(method, { operationId: operation.operationId })).toEqual({
        operationId: operation.operationId
      })
      expect(() => validateBackendRpcParams(method, { operationId: '' })).toThrow(method)
      expect(() =>
        validateBackendRpcParams(method, { operationId: operation.operationId, force: true })
      ).toThrow(method)
    }
    expect(
      validateBackendRpcParams('liveChat.moderationOperations.list', { sessionId: 'session-1' })
    ).toEqual({ sessionId: 'session-1' })
    expect(
      validateBackendRpcResult('liveChat.moderationOperations.list', [
        { ...operation, phase: 'removed', outcome: 'Removed from Twitch.', outcomeCode: 'removed' }
      ])
    ).toHaveLength(1)
    // Closed enums and closed objects: a phase, source, code or key this build
    // does not know is refused instead of rendered.
    for (const bad of [
      { ...operation, phase: 'deleting' },
      { ...operation, source: 'viewer' },
      { ...operation, outcomeCode: 'banned' },
      { ...operation, confirmMode: 'auto' },
      { ...operation, confirmBy: null },
      { ...operation, attempts: 2 },
      { ...operation, requiresExplicitConfirm: 'yes' }
    ]) {
      expect(() => validateBackendEventPayload('liveChat.moderationOperation', bad)).toThrow(
        'liveChat.moderationOperation'
      )
    }
    expect(() =>
      validateBackendRpcParams('liveChat.moderation.request', { ...request, source: 'cloud' })
    ).toThrow('liveChat.moderation.request')
    expect(() =>
      validateBackendRpcParams('liveChat.moderation.request', { ...request, sessionId: 'x' })
    ).toThrow('liveChat.moderation.request')
  })

  it('types and exactly validates Buddy voice commands, their answers and the kill switches (plan 140 S3)', () => {
    const base = {
      sessionId: 'session-1',
      status: 'listening',
      reason: null,
      questions: [],
      flags: [],
      mood: null,
      lastTickAt: null,
      tickSeq: 1,
      partial: false
    }
    const target = {
      messageId: 'session-1:twitch:default:m-1',
      authorName: 'coders_x',
      platform: 'twitch',
      excerpt: 'this stream is trash'
    }
    const card = {
      id: 'cmd-1',
      heard: 'this one is toxic remove it from our chat',
      kind: 'remove',
      status: 'confirm',
      message: "Remove coders_x's comment?",
      target,
      operationId: '0f1e2d3c-4b5a-4968-8777-66554433aabb',
      reason: 'toxic',
      at: '2026-10-04T12:00:00Z',
      expiresAt: '2026-10-04T12:00:20Z'
    }
    const withCard = {
      ...base,
      command: card,
      commandAvailability: { voiceCommands: 'on', remove: 'paused' }
    }
    expect(validateBackendEventPayload('cohost.state', withCard)).toEqual(withCard)
    expect(validateBackendRpcResult('cohost.status', withCard)).toEqual(withCard)
    const chooser = {
      ...base,
      command: {
        id: 'cmd-2',
        heard: 'buddy highlight the comment from coders',
        kind: 'highlight',
        status: 'ambiguous',
        message: "Which comment? Say 'the first one' or press 1 or 2.",
        candidates: [
          target,
          {
            ...target,
            messageId: 'session-1:youtube:default:m-2',
            authorName: 'coders_y',
            platform: 'youtube'
          }
        ],
        at: '2026-10-04T12:00:00Z',
        expiresAt: '2026-10-04T12:00:20Z'
      }
    }
    expect(validateBackendEventPayload('cohost.state', chooser)).toEqual(chooser)
    // Every status and kind of the contract validates; the minimal command
    // carries no optional key at all.
    const minimal = {
      id: 'cmd-3',
      heard: 'what is the weather',
      kind: 'unknown',
      status: 'not-found',
      message: "Buddy didn't catch that: 'what is the weather'.",
      at: '2026-10-04T12:00:00Z'
    }
    for (const status of [
      'done',
      'not-found',
      'ambiguous',
      'confirm',
      'refused',
      'unavailable',
      'cancelled',
      'expired'
    ]) {
      const state = { ...base, command: { ...minimal, status } }
      expect(validateBackendEventPayload('cohost.state', state)).toEqual(state)
    }
    for (const kind of [
      'highlight',
      'clear',
      'remove',
      'confirm',
      'cancel',
      'unknown',
      // Plan 186 S11: banner commands finish at once, without a target.
      'show-banner',
      'hide-banner',
      'hide-banners'
    ]) {
      const state = { ...base, command: { ...minimal, kind } }
      expect(validateBackendEventPayload('cohost.state', state)).toEqual(state)
    }
    // Closed: a status, kind, platform or key this build does not know is
    // refused, null is never an absent optional, and a chooser holds three.
    for (const bad of [
      { ...card, status: 'removing' },
      { ...card, kind: 'ban' },
      { ...card, extra: true },
      { ...card, operationId: null },
      { ...card, expiresAt: null },
      { ...card, message: '' },
      { ...card, target: { ...target, platform: 'myspace' } },
      { ...card, target: { ...target, color: 'red' } },
      { ...card, candidates: [target, target, target, target] }
    ]) {
      expect(() => validateBackendEventPayload('cohost.state', { ...base, command: bad })).toThrow(
        'cohost.state'
      )
    }
    for (const bad of [
      { command: null },
      { commandAvailability: null },
      { commandAvailability: { voiceCommands: 'off', remove: 'on' } },
      { commandAvailability: { voiceCommands: 'on' } }
    ]) {
      expect(() => validateBackendEventPayload('cohost.state', { ...base, ...bad })).toThrow(
        'cohost.state'
      )
    }
    // A command highlight is an automatic card with source `command`.
    const highlighted = {
      ...base,
      autoHighlight: {
        generation: 7,
        messageId: target.messageId,
        source: 'command',
        refresh: false
      }
    }
    expect(validateBackendEventPayload('cohost.state', highlighted)).toEqual(highlighted)

    // The answers: closed params, the state back.
    expect(
      validateBackendRpcParams('cohost.command.choose', { commandId: 'cmd-2', index: 1 })
    ).toEqual({ commandId: 'cmd-2', index: 1 })
    for (const bad of [
      { commandId: 'cmd-2', index: 3 },
      { commandId: 'cmd-2', index: -1 },
      { commandId: 'cmd-2', index: 0.5 },
      { commandId: '', index: 0 },
      { commandId: 'cmd-2' },
      { commandId: 'cmd-2', index: 0, sessionId: 'session-1' }
    ]) {
      expect(() => validateBackendRpcParams('cohost.command.choose', bad)).toThrow(
        'cohost.command.choose'
      )
    }
    for (const method of ['cohost.command.confirm', 'cohost.command.cancel'] as const) {
      expect(validateBackendRpcParams(method, { commandId: 'cmd-1' })).toEqual({
        commandId: 'cmd-1'
      })
      expect(() => validateBackendRpcParams(method, { commandId: '' })).toThrow(method)
      expect(() => validateBackendRpcParams(method, { commandId: 'cmd-1', index: 0 })).toThrow(
        method
      )
      expect(validateBackendRpcResult(method, withCard)).toEqual(withCard)
    }
    expect(validateBackendRpcResult('cohost.command.choose', chooser)).toEqual(chooser)
    expectTypeOf<BackendRpcResult<'cohost.command.confirm'>>().toEqualTypeOf<
      BackendEventMap['cohost.state']
    >()
    expectTypeOf<BackendRpcParams<'cohost.command.choose'>['index']>().toEqualTypeOf<number>()

    // The settings: both new fields ride every answer; the patch takes them.
    expect(
      validateBackendRpcParams('cohost.settings.set', {
        wakeWordRequired: true,
        removeConfirm: 'countdown'
      })
    ).toEqual({ wakeWordRequired: true, removeConfirm: 'countdown' })
    expect(() =>
      validateBackendRpcParams('cohost.settings.set', { removeConfirm: 'auto' })
    ).toThrow('cohost.settings.set')
    const settings = {
      enabled: true,
      tone: 'short',
      notes: '',
      autoHighlight: false,
      voiceHighlight: false,
      rules: [],
      listen: true,
      wakeWordRequired: true,
      removeConfirm: 'countdown',
      persona: {
        id: 'default',
        name: 'Buddy',
        personality: '',
        bubbleStyle: 'speech',
        images: {},
        source: 'default',
        avatar: { kind: 'still' },
        motion: { intensity: 0.45, sleepAfterSeconds: 180, breathing: true },
        reactions: {}
      },
      autoChat: {
        mode: 'off',
        greetings: { enabled: false, templates: [] },
        answers: { enabled: false, cooldownSeconds: 20 },
        banter: { enabled: false, cooldownSeconds: 240 }
      }
    }
    expect(validateBackendRpcResult('cohost.settings.get', settings)).toEqual(settings)
    const withoutWakeWord: Record<string, unknown> = { ...settings }
    delete withoutWakeWord.wakeWordRequired
    expect(() => validateBackendRpcResult('cohost.settings.get', withoutWakeWord)).toThrow(
      'cohost.settings.get'
    )
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

describe('session source backend wire results', () => {
  it('accepts Rust null source IDs for GET and switch without relaxing preference parameters', () => {
    const result = {
      sessionId: 'session',
      sourceRevision: 4,
      outputProcessId: 123,
      confirmed: {
        screenId: null,
        windowId: null,
        cameraId: null,
        microphoneId: 'microphone:coreaudio:81',
        testPattern: false
      },
      health: [{ kind: 'microphone', deviceId: 'microphone:coreaudio:81', health: 'ready' }],
      pending: null,
      lastOperation: {
        requestId: 'request',
        kind: 'microphone',
        deviceId: 'microphone:coreaudio:81',
        stage: 'applied',
        reason: null,
        previousSource: 'preserved',
        outputObserved: true,
        outputSuperseded: false
      },
      capabilities: [{ kind: 'microphone', supported: true, allowsNone: true, reason: null }],
      audio: {
        sampleCursor: 240000,
        generation: 4,
        deviceId: 'microphone:coreaudio:81',
        deviceName: 'Microphone',
        selectedInput: true,
        counters: {
          capturedFrames: 240000,
          generatedFrames: 0,
          discardedFrames: 0,
          droppedFrames: 0
        },
        lastCommit: {
          sessionId: 'session',
          requestId: 'request',
          generation: 4,
          cutoverSample: 0,
          deviceId: 'microphone:coreaudio:81',
          outputObserved: true
        }
      }
    }
    for (const method of ['session.sources.get', 'session.source.switch'] as const) {
      expect(validateBackendRpcResult(method, result)).toEqual(result)
      expect(() =>
        validateBackendRpcResult(method, {
          ...result,
          confirmed: { ...result.confirmed, cameraId: 42 }
        })
      ).toThrow()
      expect(
        validateBackendRpcResult(method, {
          ...result,
          confirmed: { ...result.confirmed, microphoneId: null }
        })
      ).toBeTruthy()
    }
    expect(() =>
      validateBackendRpcParams('session.start', { sources: { cameraId: null } })
    ).toThrow(/cameraId/)
  })
})

describe('banner backend wire contract (plan 186)', () => {
  const banner = {
    id: '5c1e2b8a-7d3f-4e61-9a0b-2f4c6d8e1a3b',
    name: 'Sponsor',
    imageFile: '5c1e2b8a-7d3f-4e61-9a0b-2f4c6d8e1a3b.png',
    thumbnailFile: '5c1e2b8a-7d3f-4e61-9a0b-2f4c6d8e1a3b.thumb.png',
    width: 2400,
    height: 400,
    hasAlpha: true,
    sortOrder: 0,
    shown: false,
    horizontal: { x: 0.2, y: 0.782222, w: 0.6, h: 0.177778 },
    vertical: { x: 0.071111, y: 0.699583, w: 0.857778, h: 0.080417 },
    showOnStream: true,
    showInRecording: true,
    opacity: 1,
    createdAt: '2026-10-20T18:00:00Z',
    updatedAt: '2026-10-20T18:00:00Z'
  }

  it('registers every banner method and the changed event with a strict schema', () => {
    expect(runtimeValidatedBackendRpcMethods).toEqual(
      expect.arrayContaining([
        'banners.list',
        'banners.importImage',
        'banners.update',
        'banners.reorder',
        'banners.delete',
        'banners.show',
        'banners.hide'
      ])
    )
    expectTypeOf<BackendRpcResult<'banners.list'>>().toEqualTypeOf<Banner[]>()
    expectTypeOf<BackendRpcResult<'banners.show'>>().toEqualTypeOf<Banner>()
    expectTypeOf<BackendRpcParams<'banners.hide'>>().toEqualTypeOf<{ id?: string }>()
    expectTypeOf<BackendEventMap['banners.changed']>().toEqualTypeOf<Banner[]>()

    expect(validateBackendRpcParams('banners.list', undefined)).toBeUndefined()
    expect(validateBackendRpcResult('banners.list', [banner])).toStrictEqual([banner])
    expect(validateBackendRpcResult('banners.show', banner)).toStrictEqual(banner)
    expect(validateBackendRpcResult('banners.importImage', banner)).toStrictEqual(banner)
    expect(validateBackendRpcResult('banners.update', banner)).toStrictEqual(banner)
    for (const method of ['banners.reorder', 'banners.delete', 'banners.hide'] as const) {
      expect(validateBackendRpcResult(method, [])).toStrictEqual([])
      expect(validateBackendRpcResult(method, [banner])).toStrictEqual([banner])
    }
    expect(validateBackendEventPayload('banners.changed', [banner])).toStrictEqual([banner])
    expect(() => validateBackendEventPayload('banners.changed', banner)).toThrow('banners.changed')
  })

  it('refuses unknown fields, paths for files, nulls and out-of-range values', () => {
    expect(() => validateBackendRpcResult('banners.show', { ...banner, extra: 1 })).toThrow()
    expect(() =>
      validateBackendRpcResult('banners.show', { ...banner, imageFile: '/tmp/x.png' })
    ).toThrow('banner file basename')
    expect(() =>
      validateBackendRpcResult('banners.show', { ...banner, thumbnailFile: '../x.png' })
    ).toThrow('banner file basename')
    expect(() => validateBackendRpcResult('banners.show', { ...banner, id: 'a/b' })).toThrow(
      'banner id'
    )
    expect(() =>
      validateBackendRpcResult('banners.show', { ...banner, hideAfterSec: null })
    ).toThrow()
    expect(() =>
      validateBackendRpcResult('banners.show', { ...banner, repeatEveryMin: null })
    ).toThrow()
    expect(() => validateBackendRpcResult('banners.show', { ...banner, opacity: 1.5 })).toThrow()
    expect(() => validateBackendRpcResult('banners.show', { ...banner, width: 0 })).toThrow()
    expect(() =>
      validateBackendRpcResult('banners.show', {
        ...banner,
        horizontal: { x: 0, y: 0, w: 1.2, h: 1 }
      })
    ).toThrow()
    const { createdAt: _createdAt, ...withoutCreatedAt } = banner
    expect(() => validateBackendRpcResult('banners.show', withoutCreatedAt)).toThrow()
    expect(() =>
      validateBackendRpcResult(
        'banners.list',
        Array.from({ length: 25 }, (_, index) => ({ ...banner, sortOrder: index }))
      )
    ).toThrow('at most 24')
  })

  it('validates params exactly, with 0 turning a timer off', () => {
    expect(
      validateBackendRpcParams('banners.importImage', { sourceCapability: 'cap-1' })
    ).toStrictEqual({ sourceCapability: 'cap-1' })
    expect(() => validateBackendRpcParams('banners.importImage', { path: '/tmp/x.png' })).toThrow()
    expect(() =>
      validateBackendRpcParams('banners.importImage', { sourceCapability: '' })
    ).toThrow()

    const update = {
      id: banner.id,
      name: 'Follow me',
      horizontal: { x: 0.1, y: 0.1, w: 0.3, h: 0.05 },
      vertical: { x: 0.1, y: 0.1, w: 0.8, h: 0.05 },
      showOnStream: true,
      showInRecording: false,
      opacity: 0.2,
      hideAfterSec: 0,
      repeatEveryMin: 0
    }
    expect(validateBackendRpcParams('banners.update', update)).toStrictEqual(update)
    expect(validateBackendRpcParams('banners.update', { id: banner.id, opacity: 1 })).toStrictEqual(
      {
        id: banner.id,
        opacity: 1
      }
    )
    expect(() => validateBackendRpcParams('banners.update', { ...update, opacity: 0.1 })).toThrow()
    expect(() =>
      validateBackendRpcParams('banners.update', { ...update, hideAfterSec: null })
    ).toThrow()
    expect(() => validateBackendRpcParams('banners.update', { ...update, shown: true })).toThrow()
    expect(() => validateBackendRpcParams('banners.update', { name: 'No id' })).toThrow()

    expect(validateBackendRpcParams('banners.reorder', { ids: [banner.id] })).toStrictEqual({
      ids: [banner.id]
    })
    expect(() =>
      validateBackendRpcParams('banners.reorder', {
        ids: Array.from({ length: 25 }, (_, index) => `banner-${index}`)
      })
    ).toThrow('at most 24')
    for (const method of ['banners.delete', 'banners.show'] as const) {
      expect(validateBackendRpcParams(method, { id: banner.id })).toStrictEqual({ id: banner.id })
      expect(() => validateBackendRpcParams(method, {})).toThrow()
      expect(() => validateBackendRpcParams(method, { id: banner.id, all: true })).toThrow()
    }
    expect(validateBackendRpcParams('banners.hide', {})).toStrictEqual({})
    expect(validateBackendRpcParams('banners.hide', { id: banner.id })).toStrictEqual({
      id: banner.id
    })
    expect(() => validateBackendRpcParams('banners.hide', { id: null })).toThrow()
  })

  it('validates the secret-free Discord announcement surface (plan 187)', () => {
    const webhook = {
      id: '123456789012345678',
      name: 'Stream alerts',
      hint: '…/9xyz',
      lastPost: {
        at: '2026-10-22T18:02:00+00:00',
        messageUrl: 'https://discord.com/channels/1/2/3',
        state: 'live'
      },
      lastError: { code: 'unreachable', at: '2026-10-22T18:03:00+00:00' }
    }
    const snapshot = {
      // Several webhooks, one per server; a bare one has only its id and tail.
      webhooks: [webhook, { id: '2', hint: '…/a1B2' }],
      enabled: true,
      ping: 'everyone',
      branding: true,
      postAs: { kind: 'platform', accountId: 'acct-1' },
      excludedTargetIds: ['youtube-1'],
      linkOverrides: { tiktok: 'https://www.tiktok.com/@orc/live' },
      identities: [
        {
          postAs: { kind: 'platform', accountId: 'acct-1' },
          name: 'OrcDev',
          platform: 'twitch',
          avatarUrl: 'https://static-cdn.jtvnw.net/a.png'
        },
        { postAs: { kind: 'videorc' }, name: 'Orc' }
      ]
    }
    for (const method of [
      'discord.announce.get',
      'discord.announce.update',
      'discord.webhook.save',
      'discord.webhook.remove'
    ] as const) {
      expect(validateBackendRpcResult(method, snapshot)).toStrictEqual(snapshot)
    }
    expect(validateBackendEventPayload('discord.announce.changed', snapshot)).toStrictEqual(
      snapshot
    )
    // Rust omits None; a null would mean the serde trap is back.
    expect(() =>
      validateBackendRpcResult('discord.announce.get', {
        ...snapshot,
        webhooks: [{ ...webhook, name: null }]
      })
    ).toThrow()
    // A webhook URL never travels back to the renderer, on the snapshot or a row.
    expect(() =>
      validateBackendRpcResult('discord.announce.get', {
        ...snapshot,
        webhookUrl: 'https://discord.com/api/webhooks/1/secret'
      })
    ).toThrow()
    expect(() =>
      validateBackendRpcResult('discord.announce.get', {
        ...snapshot,
        webhooks: [{ ...webhook, url: 'https://discord.com/api/webhooks/1/secret' }]
      })
    ).toThrow()
    expect(() =>
      validateBackendRpcResult('discord.announce.get', {
        ...snapshot,
        webhooks: [{ ...webhook, token: 'secret' }]
      })
    ).toThrow()
    // Ten servers is the cap; the renderer never has to draw more.
    expect(() =>
      validateBackendRpcResult('discord.announce.get', {
        ...snapshot,
        webhooks: Array.from({ length: 11 }, (_, index) => ({ id: String(index), hint: '…/a' }))
      })
    ).toThrow()
    expect(() =>
      validateBackendRpcResult('discord.announce.get', {
        ...snapshot,
        webhooks: [{ hint: '…/a1B2' }]
      })
    ).toThrow()
    // Remove and the test name one webhook by its id.
    expect(validateBackendRpcParams('discord.webhook.remove', { webhookId: '2' })).toStrictEqual({
      webhookId: '2'
    })
    expect(() => validateBackendRpcParams('discord.webhook.remove', {})).toThrow()
    expect(() => validateBackendRpcParams('discord.webhook.remove', undefined)).toThrow()
    expect(() =>
      validateBackendRpcParams('discord.announce.update', { url: 'https://discord.com/x' })
    ).toThrow()
    expect(
      validateBackendRpcParams('discord.announce.update', { linkOverride: { targetId: 't' } })
    ).toStrictEqual({ linkOverride: { targetId: 't' } })
    expect(() =>
      validateBackendRpcParams('discord.announce.update', { postAs: { kind: 'someone' } })
    ).toThrow()

    const targets = {
      targets: [
        {
          id: 'yt',
          platform: 'youtube',
          label: 'YouTube',
          authMode: 'oauth',
          outputOrientation: 'vertical',
          platformBroadcastId: 'abc'
        }
      ]
    }
    expect(validateBackendRpcParams('discord.links.preview', targets)).toStrictEqual(targets)
    expect(() =>
      validateBackendRpcParams('discord.links.preview', {
        targets: [{ ...targets.targets[0], streamKey: 'live_123' }]
      })
    ).toThrow()
    const test = { ...targets, webhookId: '123456789012345678' }
    expect(validateBackendRpcParams('discord.webhook.sendTest', test)).toStrictEqual(test)
    expect(() => validateBackendRpcParams('discord.webhook.sendTest', targets)).toThrow()
    const preview = {
      links: [
        { targetId: 'yt', label: 'YouTube · Vertical', linkKind: 'at-go-live', included: true },
        {
          targetId: 'tw',
          label: 'Twitch',
          linkKind: 'auto',
          link: 'https://www.twitch.tv/orcdev',
          included: true
        }
      ],
      sender: { name: 'OrcDev' }
    }
    expect(validateBackendRpcResult('discord.links.preview', preview)).toStrictEqual(preview)
    expect(validateBackendRpcResult('discord.webhook.sendTest', {})).toStrictEqual({})
  })
})

describe('app window source contracts (plan 210 S1)', () => {
  it('accepts legacy and app-aware devices, rejecting null metadata', () => {
    const device = {
      id: 'window:screencapturekit:7',
      name: 'App - Editor',
      kind: 'window',
      status: 'available'
    }
    for (const extra of [
      {},
      { app: { bundleId: 'test.app', name: 'App', pid: 42 }, windowTitle: 'Editor' }
    ]) {
      const payload = { devices: [{ ...device, ...extra }], warnings: [] }
      expect(validateBackendRpcResult('devices.list', payload)).toEqual(payload)
      expect(validateBackendEventPayload('devices.changed', payload)).toEqual(payload)
    }
    for (const extra of [
      { app: null },
      { windowTitle: null },
      { app: { bundleId: 'test.app', name: 'App', pid: 42, secret: true } }
    ]) {
      expect(() =>
        validateBackendRpcResult('devices.list', {
          devices: [{ ...device, ...extra }],
          warnings: []
        })
      ).toThrow()
    }
  })

  it('registers the resolver and validates params and both result variants strictly', () => {
    expect(runtimeValidatedBackendRpcMethods).toContain('sources.resolve_app_window')
    const params = {
      bundleId: 'test.app',
      preferWindowId: 'window:screencapturekit:7',
      minWidth: 400,
      minHeight: 300
    }
    expect(validateBackendRpcParams('sources.resolve_app_window', params)).toEqual(params)
    expect(
      validateBackendRpcParams('sources.resolve_app_window', { bundleId: 'test.app' })
    ).toEqual({ bundleId: 'test.app' })
    for (const bad of [
      { bundleId: '' },
      { ...params, minWidth: -1 },
      { ...params, minHeight: 0.5 },
      { ...params, minSize: {} }
    ]) {
      expect(() => validateBackendRpcParams('sources.resolve_app_window', bad)).toThrow()
    }
    const found = {
      ok: true,
      windowId: 'window:screencapturekit:7',
      title: '',
      width: 800,
      height: 600
    }
    expect(validateBackendRpcResult('sources.resolve_app_window', found)).toEqual(found)
    for (const reason of ['not-running', 'no-window', 'minimized']) {
      expect(validateBackendRpcResult('sources.resolve_app_window', { ok: false, reason })).toEqual(
        { ok: false, reason }
      )
    }
    for (const bad of [
      { ok: false, reason: 'unsupported' },
      { ...found, reason: 'no-window' },
      { ok: true }
    ]) {
      expect(() => validateBackendRpcResult('sources.resolve_app_window', bad)).toThrow()
    }
  })

  // Plan 210 S4/S5: New scene…'s picker. S5 builds against this shape first.
  it('registers app previews and validates their pictures strictly', () => {
    expect(runtimeValidatedBackendRpcMethods).toContain('sources.app_previews')
    expect(validateBackendRpcParams('sources.app_previews', { maxWidth: 320 })).toEqual({
      maxWidth: 320
    })
    expect(validateBackendRpcParams('sources.app_previews', undefined)).toBeUndefined()
    for (const bad of [{ maxWidth: 0 }, { maxWidth: 4_000 }, { maxWidth: 320, extra: true }]) {
      expect(() => validateBackendRpcParams('sources.app_previews', bad)).toThrow()
    }
    const figma = {
      bundleId: 'com.figma.Desktop',
      name: 'Figma',
      pid: 42,
      windowCount: 3,
      frontWindowId: 'window:screencapturekit:7',
      frontWindowTitle: 'Untitled',
      picture: 'data:image/jpeg;base64,/9j/4AAQ',
      width: 320,
      height: 200
    }
    const iconOnly = { bundleId: 'com.t3.code', name: 'T3 Code', pid: 7, windowCount: 1 }
    expect(validateBackendRpcResult('sources.app_previews', { apps: [figma, iconOnly] })).toEqual({
      apps: [figma, iconOnly]
    })
    for (const bad of [
      { ...figma, picture: 'data:image/png;base64,AAAA' },
      { ...figma, picture: 'https://example.com/a.jpg' },
      { ...figma, windowCount: -1 },
      { ...figma, secret: true }
    ]) {
      expect(() => validateBackendRpcResult('sources.app_previews', { apps: [bad] })).toThrow()
    }
  })
})

describe('Hide screen wire contract (plan 210 S7)', () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL('../../../../protocol-fixtures/screen-privacy.json', import.meta.url),
      'utf8'
    )
  ) as {
    visible: unknown
    hiddenByYou: unknown
    hiddenByPasswordManager: unknown
    unavailableOnLegacySession: unknown
    hideParams: unknown
    rejected: unknown[]
  }

  it('accepts every fixture state on the RPC results and the event, field for field', () => {
    for (const state of [
      fixture.visible,
      fixture.hiddenByYou,
      fixture.hiddenByPasswordManager,
      fixture.unavailableOnLegacySession
    ]) {
      expect(validateBackendRpcResult('screen.privacy.get', state)).toEqual(state)
      expect(validateBackendRpcResult('screen.hide', state)).toEqual(state)
      expect(validateBackendRpcResult('screen.show', state)).toEqual(state)
      expect(validateBackendEventPayload('screen.privacy.changed', state)).toEqual(state)
    }
    expect(validateBackendRpcParams('screen.hide', fixture.hideParams)).toEqual(fixture.hideParams)
    expect(validateBackendRpcParams('screen.hide', { reason: 'you' })).toEqual({ reason: 'you' })
  })

  it('rejects a null field, an unknown reason, a forged field and a missing flag', () => {
    for (const bad of fixture.rejected) {
      expect(() => validateBackendRpcResult('screen.privacy.get', bad)).toThrow()
      expect(() => validateBackendEventPayload('screen.privacy.changed', bad)).toThrow()
    }
    expect(() =>
      validateBackendRpcResult('screen.privacy.get', { hidden: true, reason: 'you', extra: 1 })
    ).toThrow()
    for (const bad of [{}, { reason: 'agent' }, { reason: null }, { reason: 'you', extra: true }]) {
      expect(() => validateBackendRpcParams('screen.hide', bad)).toThrow()
    }
  })

  it('types the three methods and the event', () => {
    expectTypeOf<BackendRpcParams<'screen.hide'>>().toEqualTypeOf<{
      reason: 'you' | 'password-manager'
    }>()
    expectTypeOf<BackendRpcResult<'screen.show'>>().toEqualTypeOf<
      BackendEventMap['screen.privacy.changed']
    >()
    expect(runtimeValidatedBackendRpcMethods).toEqual(
      expect.arrayContaining(['screen.hide', 'screen.show', 'screen.privacy.get'])
    )
  })
})
