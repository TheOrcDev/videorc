import { describe, expect, expectTypeOf, it } from 'vitest'

import type {
  DiagnosticStats,
  OAuthCallbackResult,
  OAuthCompleteParams,
  NoiseCleanupJob,
  SessionAiArtifactsPage,
  SessionCommentsPage,
  SessionDeletionOperation,
  SessionHealthEventsPage,
  SessionListPage,
  SessionLogsPage,
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
        sideBySideCameraSide: 'left'
      },
      transitionMs: 320
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
      expect(() =>
        validateBackendEventPayload('diagnostics.stats', {
          ...diagnostics,
          [field]: null
        })
      ).toThrow(field)
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
      message: 'The co-host tick failed on every configured model.',
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

    const settings = { enabled: true, tone: 'short', notes: 'Keychron Q1', autoHighlight: false }
    expect(validateBackendRpcResult('cohost.settings.get', settings)).toEqual(settings)
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
