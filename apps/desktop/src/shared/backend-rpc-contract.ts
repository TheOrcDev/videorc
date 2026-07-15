import type {
  BackendHealth,
  CompositorFrameReady,
  CompositorStatus,
  DeviceList,
  DiagnosticStats,
  EntitlementsSnapshot,
  FileAssessment,
  GateStatus,
  LiveLayoutApplyStatus,
  NoiseCleanupJob,
  OAuthCallbackResult,
  OAuthCompleteParams,
  PreviewCameraStatus,
  PreviewLiveStatus,
  PreviewScreenStatus,
  PreviewSurfaceStatus,
  RecordingStatus,
  Scene,
  SceneCommitStatus,
  SceneConfigParams,
  ServerEvent,
  ServerResponse,
  SessionCommentsListParams,
  SessionCommentsPage,
  SessionDeletionOperation,
  SessionStorageTotals,
  SessionSummary,
  StartSessionParams,
  VideorcAccountSnapshot
} from './backend'
import { LAYOUT_PRESET_VALUES } from './backend'
import {
  arraySchema,
  boundedJsonValueSchema,
  booleanSchema,
  enumSchema,
  literalSchema,
  nullableSchema,
  numberSchema,
  objectSchema,
  optionalSchema,
  runtimeSchema,
  stringSchema,
  undefinedSchema,
  unionSchema,
  type RuntimeSchema
} from './runtime-schema'

export interface BackendRpcDefinition<TParams, TResult> {
  params: TParams
  result: TResult
}

type LayoutTransactionResult = LiveLayoutApplyStatus & {
  intentId: number
  compositorStatus: CompositorStatus
  presentationProven: boolean
}

/**
 * Compile-time method map for the capture/account/file operations where a
 * misspelled method, request drift, or response drift is most destructive.
 * Less critical methods can remain on BackendClient's compatible untyped
 * overload while they are migrated incrementally.
 */
export interface BackendRpcMethodMap {
  'health.ping': BackendRpcDefinition<{ ffmpegPath?: string } | undefined, BackendHealth>
  'entitlements.get': BackendRpcDefinition<undefined, EntitlementsSnapshot>
  'entitlements.refresh': BackendRpcDefinition<undefined, EntitlementsSnapshot>
  'account.get': BackendRpcDefinition<undefined, VideorcAccountSnapshot>
  'account.complete_sign_in': BackendRpcDefinition<
    { code: string; state: string; verifier: string; intentGeneration: number },
    VideorcAccountSnapshot
  >
  'account.sign_out': BackendRpcDefinition<undefined, VideorcAccountSnapshot>
  'platformAccounts.oauth.complete': BackendRpcDefinition<OAuthCompleteParams, OAuthCallbackResult>
  'devices.list': BackendRpcDefinition<{ ffmpegPath?: string } | undefined, DeviceList>
  'recording.status': BackendRpcDefinition<undefined, RecordingStatus>
  'session.start': BackendRpcDefinition<StartSessionParams, RecordingStatus>
  'session.stop': BackendRpcDefinition<undefined, RecordingStatus>
  'scene.get': BackendRpcDefinition<undefined, Scene>
  'scene.load_from_capture_config': BackendRpcDefinition<SceneConfigParams, SceneCommitStatus>
  'scene.layout.apply_preview': BackendRpcDefinition<
    SceneConfigParams & { intentId: number },
    LayoutTransactionResult
  >
  'scene.layout.apply_live': BackendRpcDefinition<
    SceneConfigParams & { intentId: number },
    LayoutTransactionResult
  >
  'compositor.status': BackendRpcDefinition<undefined, CompositorStatus>
  'preview.live.status': BackendRpcDefinition<undefined, PreviewLiveStatus>
  'preview.surface.status': BackendRpcDefinition<undefined, PreviewSurfaceStatus>
  'preview.camera.status': BackendRpcDefinition<undefined, PreviewCameraStatus>
  'preview.screen.status': BackendRpcDefinition<undefined, PreviewScreenStatus>
  'diagnostics.stats': BackendRpcDefinition<undefined, DiagnosticStats>
  'sessions.list': BackendRpcDefinition<{ limit?: number } | undefined, SessionSummary[]>
  'sessions.storage': BackendRpcDefinition<undefined, SessionStorageTotals>
  'sessions.comments.list': BackendRpcDefinition<SessionCommentsListParams, SessionCommentsPage>
  'sessions.delete': BackendRpcDefinition<{ sessionIds: string[] }, SessionDeletionOperation[]>
  'sessions.delete.pending': BackendRpcDefinition<undefined, SessionDeletionOperation[]>
  'noiseCleanup.start': BackendRpcDefinition<{ sessionId: string }, NoiseCleanupJob>
  'noiseCleanup.cancel': BackendRpcDefinition<{ jobId: string }, NoiseCleanupJob>
  'noiseCleanup.list': BackendRpcDefinition<undefined, NoiseCleanupJob[]>
  'repair.assess_file': BackendRpcDefinition<{ sessionId: string }, FileAssessment>
  'repair.repair_file': BackendRpcDefinition<
    { sessionId: string; expectAudio?: boolean; intendedFps?: number },
    GateStatus
  >
  'repair.restore_file': BackendRpcDefinition<{ sessionId: string }, { restored: boolean }>
}

export type BackendRpcMethod = keyof BackendRpcMethodMap
export type BackendRpcParams<TMethod extends BackendRpcMethod> =
  BackendRpcMethodMap[TMethod]['params']
export type BackendRpcResult<TMethod extends BackendRpcMethod> =
  BackendRpcMethodMap[TMethod]['result']

export interface BackendEventMap {
  'devices.changed': DeviceList
  'entitlements.updated': EntitlementsSnapshot
  'noiseCleanup.status': NoiseCleanupJob
  'platformAccounts.oauth.callback': OAuthCallbackResult
  'recording.status': RecordingStatus
  'scene.changed': Scene
  'compositor.status': CompositorStatus
  'preview.live.status': PreviewLiveStatus
  'preview.surface.status': PreviewSurfaceStatus
  'preview.camera.status': PreviewCameraStatus
  'preview.screen.status': PreviewScreenStatus
  'diagnostics.stats': DiagnosticStats
}

export type BackendEvent = keyof BackendEventMap

type RuntimeBackendRpcContract = {
  params: RuntimeSchema<unknown>
  result: RuntimeSchema<unknown>
}

const boundedString = stringSchema({ minLength: 1, maxLength: 16_384 })
const boundedPath = stringSchema({ minLength: 1, maxLength: 32_768 })
const timestamp = stringSchema({ minLength: 1, maxLength: 128 })
const optionalText = optionalSchema(stringSchema({ maxLength: 16_384 }))
const boundedBackendPayloadSchema = boundedJsonValueSchema()
const boundedBackendParamValueSchema = boundedJsonValueSchema({
  allowUndefinedObjectProperties: true
})
const boundedBackendParamsSchema = optionalSchema(boundedBackendParamValueSchema)
const MAX_BACKEND_WIRE_MESSAGE_CHARS = 16_000_000
const nonNegativeInteger = numberSchema({
  integer: true,
  min: 0,
  max: Number.MAX_SAFE_INTEGER
})

function boundedSemanticValue(
  description: string,
  semanticSchema: RuntimeSchema<unknown>
): RuntimeSchema<unknown> {
  return runtimeSchema(description, (value, path) => {
    boundedBackendPayloadSchema.parse(value, path)
    semanticSchema.parse(value, path)
    return value
  })
}

const accountSchema = objectSchema(
  {
    status: enumSchema(['signed-out', 'signed-in']),
    username: optionalText,
    displayName: optionalText,
    email: optionalText,
    avatarUrl: optionalText
  },
  { allowUnknown: false }
) as RuntimeSchema<VideorcAccountSnapshot>

const toolStatusSchema = objectSchema(
  {
    path: boundedPath,
    available: booleanSchema,
    version: optionalText,
    message: optionalText
  },
  { allowUnknown: false }
)

const backendHealthSchema = objectSchema(
  {
    status: boundedString,
    version: boundedString,
    platform: boundedString,
    ffmpeg: toolStatusSchema,
    databasePath: boundedPath,
    secretStoreBackend: boundedString
  },
  { allowUnknown: false }
) as RuntimeSchema<BackendHealth>

const entitlementCapabilitySchema = objectSchema(
  {
    featureId: enumSchema([
      'local-recording',
      'livestreaming',
      'multistreaming',
      'cloud-ai',
      'noise-cleanup'
    ]),
    state: enumSchema(['enabled', 'disabled', 'developer-override']),
    reason: optionalText
  },
  { allowUnknown: false }
)

const entitlementsSchema = objectSchema(
  {
    schemaVersion: nonNegativeInteger,
    tier: enumSchema(['basic', 'premium', 'developer']),
    source: enumSchema([
      'local-default',
      'env-override',
      'creem',
      'manual',
      'signed-cache',
      'future-license'
    ]),
    capabilities: arraySchema(entitlementCapabilitySchema, { maxLength: 32 }),
    limits: objectSchema(
      {
        recording: objectSchema(
          {
            maxWidth: numberSchema({ integer: true, min: 1, max: 65_536 }),
            maxHeight: numberSchema({ integer: true, min: 1, max: 65_536 }),
            maxFps: numberSchema({ integer: true, min: 1, max: 1000 }),
            maxBitrateKbps: optionalSchema(nonNegativeInteger)
          },
          { allowUnknown: false }
        ),
        streaming: objectSchema(
          {
            maxWidth: numberSchema({ integer: true, min: 1, max: 65_536 }),
            maxHeight: numberSchema({ integer: true, min: 1, max: 65_536 }),
            maxFps: numberSchema({ integer: true, min: 1, max: 1000 }),
            maxBitrateKbps: nonNegativeInteger,
            maxDestinations: numberSchema({ integer: true, min: 1, max: 1000 })
          },
          { allowUnknown: false }
        )
      },
      { allowUnknown: false }
    ),
    checkedAt: optionalSchema(timestamp),
    expiresAt: optionalSchema(timestamp)
  },
  { allowUnknown: false }
) as RuntimeSchema<EntitlementsSnapshot>

const deviceSchema = objectSchema(
  {
    id: boundedString,
    name: boundedString,
    kind: enumSchema(['screen', 'window', 'camera', 'microphone', 'system-audio']),
    status: enumSchema(['available', 'unavailable', 'permission-required']),
    detail: optionalText,
    width: optionalSchema(numberSchema({ integer: true, min: 0, max: 65_536 })),
    height: optionalSchema(numberSchema({ integer: true, min: 0, max: 65_536 }))
  },
  { allowUnknown: false }
)

const deviceListSchema = objectSchema(
  {
    devices: arraySchema(deviceSchema, { maxLength: 10_000 }),
    warnings: arraySchema(stringSchema({ maxLength: 16_384 }), { maxLength: 1000 })
  },
  { allowUnknown: false }
) as RuntimeSchema<DeviceList>

const recordingStatusSchema = objectSchema(
  {
    state: enumSchema(['idle', 'starting', 'recording', 'streaming', 'stopping', 'failed']),
    sessionId: optionalText,
    outputPath: optionalSchema(boundedPath),
    streamUrl: optionalText,
    startedAt: optionalSchema(timestamp),
    audioTracks: optionalSchema(arraySchema(boundedBackendPayloadSchema, { maxLength: 32 })),
    pipeline: optionalSchema(boundedBackendPayloadSchema),
    durationMs: optionalSchema(numberSchema({ min: 0 })),
    message: optionalText
  },
  { allowUnknown: false }
) as RuntimeSchema<RecordingStatus>

const sourceSelectionSchema = objectSchema(
  {
    screenId: optionalText,
    screenName: optionalText,
    windowId: optionalText,
    windowName: optionalText,
    cameraId: optionalText,
    cameraName: optionalText,
    microphoneId: optionalText,
    microphoneName: optionalText,
    testPattern: optionalSchema(booleanSchema)
  },
  { allowUnknown: false }
)

const layoutSchema = objectSchema(
  {
    layoutPreset: enumSchema(LAYOUT_PRESET_VALUES),
    cameraTransformMode: enumSchema(['preset', 'custom']),
    cameraTransform: nullableSchema(boundedBackendParamValueSchema),
    cameraCorner: enumSchema(['top-left', 'top-right', 'bottom-left', 'bottom-right']),
    cameraSize: enumSchema(['small', 'medium', 'large']),
    cameraShape: enumSchema(['rectangle', 'rounded', 'circle']),
    cameraCornerRadiusPct: numberSchema({ min: 0, max: 100 }),
    cameraAspect: enumSchema(['source', 'square', 'portrait']),
    cameraChromaKeyEnabled: booleanSchema,
    cameraChromaKeyColor: stringSchema({ minLength: 1, maxLength: 16 }),
    cameraChromaKeySimilarityPct: numberSchema({ min: 0, max: 100 }),
    cameraChromaKeySmoothnessPct: numberSchema({ min: 0, max: 100 }),
    cameraChromaKeySpillPct: numberSchema({ min: 0, max: 100 }),
    cameraMargin: numberSchema({ min: 0 }),
    cameraFit: enumSchema(['fit', 'fill']),
    cameraMirror: booleanSchema,
    cameraZoom: numberSchema({ min: 0.01, max: 200 }),
    cameraOffsetX: numberSchema({ min: -100, max: 100 }),
    cameraOffsetY: numberSchema({ min: -100, max: 100 }),
    sideBySideSplit: enumSchema(['50-50', '60-40', '70-30']),
    sideBySideCameraSide: enumSchema(['left', 'right'])
  },
  { allowUnknown: false }
)

const sceneConfigSchema = objectSchema(
  {
    sources: sourceSelectionSchema,
    layout: layoutSchema,
    video: optionalSchema(boundedBackendParamValueSchema),
    background: optionalSchema(boundedBackendParamValueSchema),
    protectedOverlayWindowIds: optionalSchema(
      arraySchema(numberSchema({ integer: true, min: 0 }), { maxLength: 16 })
    )
  },
  { allowUnknown: false }
)

const layoutTransactionParamsSchema = runtimeSchema<unknown>(
  'a valid layout transaction',
  (value, path) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return sceneConfigSchema.parse(value, path)
    }
    const { intentId, ...sceneConfig } = value as Record<string, unknown>
    numberSchema({ integer: true, min: 1 }).parse(intentId, `${path}.intentId`)
    sceneConfigSchema.parse(sceneConfig, path)
    return value
  }
)

const sceneSchema = objectSchema(
  {
    id: boundedString,
    name: boundedString,
    sources: arraySchema(boundedBackendPayloadSchema, { maxLength: 64 }),
    outputs: arraySchema(boundedBackendPayloadSchema, { maxLength: 16 }),
    background: optionalSchema(boundedBackendPayloadSchema)
  },
  { allowUnknown: false }
) as RuntimeSchema<Scene>

const compositorStatusSchema = objectSchema(
  {
    state: enumSchema(['stopped', 'starting', 'live', 'failed']),
    targetFps: numberSchema({ min: 0, max: 480 }),
    width: numberSchema({ integer: true, min: 0, max: 32_768 }),
    height: numberSchema({ integer: true, min: 0, max: 32_768 }),
    runId: optionalText,
    sceneRevision: optionalSchema(numberSchema({ integer: true, min: 0 })),
    frameSceneRevision: optionalSchema(numberSchema({ integer: true, min: 0 })),
    sceneId: optionalText,
    sceneLayout: optionalSchema(layoutSchema),
    activeScreenId: optionalText,
    sceneSources: arraySchema(boundedBackendPayloadSchema, { maxLength: 64 }),
    sources: arraySchema(boundedBackendPayloadSchema, { maxLength: 64 }),
    renderFps: optionalSchema(numberSchema({ min: 0, max: 1000 })),
    framesRendered: numberSchema({ integer: true, min: 0 }),
    repeatedFrames: numberSchema({ integer: true, min: 0 }),
    droppedFrames: numberSchema({ integer: true, min: 0 }),
    frameAgeMs: optionalSchema(numberSchema({ min: 0 })),
    frameTimeP95Ms: optionalSchema(numberSchema({ min: 0 })),
    metalTargetIosurfaceId: optionalSchema(numberSchema({ integer: true, min: 0 })),
    metalTargetWidth: optionalSchema(numberSchema({ integer: true, min: 0 })),
    metalTargetHeight: optionalSchema(numberSchema({ integer: true, min: 0 })),
    imageCache: optionalSchema(boundedBackendPayloadSchema),
    framePipeline: optionalSchema(boundedBackendPayloadSchema),
    updatedAt: timestamp,
    message: optionalText
  },
  { allowUnknown: false }
) as RuntimeSchema<CompositorStatus>

const compositorFrameReadySchema = boundedSemanticValue(
  'a compositor frame-ready event',
  objectSchema(
    {
      targetFps: numberSchema({ min: 0, max: 1000 }),
      width: nonNegativeInteger,
      height: nonNegativeInteger,
      framesRendered: nonNegativeInteger,
      frameAgeMs: optionalSchema(nonNegativeInteger),
      updatedAt: timestamp
    },
    { allowUnknown: true }
  )
) as RuntimeSchema<CompositorFrameReady>

const previewLiveStatusSchema = objectSchema(
  {
    state: enumSchema(['connecting', 'live', 'reconnecting', 'unavailable']),
    source: enumSchema(['idle-preview', 'recording-session', 'unavailable']),
    transport: enumSchema([
      'native-surface',
      'electron-proof-surface',
      'latest-jpeg-polling',
      'mjpeg-stream',
      'unavailable'
    ]),
    backing: enumSchema(['cametal-layer', 'electron-browser-window', 'none']),
    targetFps: optionalSchema(numberSchema({ min: 0, max: 1000 })),
    width: optionalSchema(nonNegativeInteger),
    height: optionalSchema(nonNegativeInteger),
    url: optionalText,
    message: optionalText
  },
  { allowUnknown: false }
) as RuntimeSchema<PreviewLiveStatus>

const previewSurfaceStatusSchema = boundedSemanticValue(
  'a native preview surface status',
  objectSchema(
    {
      state: enumSchema(['unavailable', 'starting', 'live', 'stopped', 'failed']),
      source: enumSchema(['synthetic', 'camera', 'screen', 'window']),
      transport: enumSchema([
        'native-surface',
        'electron-proof-surface',
        'latest-jpeg-polling',
        'mjpeg-stream',
        'unavailable'
      ]),
      backing: enumSchema(['cametal-layer', 'electron-browser-window', 'none']),
      targetFps: numberSchema({ min: 0, max: 1000 }),
      width: nonNegativeInteger,
      height: nonNegativeInteger,
      framesRendered: nonNegativeInteger,
      droppedFrames: nonNegativeInteger,
      framePollingSuppressed: booleanSchema,
      sourcePixelsPresent: booleanSchema,
      pendingHostCommandCount: nonNegativeInteger,
      updatedAt: timestamp
    },
    { allowUnknown: true }
  )
) as RuntimeSchema<PreviewSurfaceStatus>

const previewCameraStatusSchema = boundedSemanticValue(
  'a preview camera status',
  objectSchema(
    {
      state: enumSchema(['starting', 'live', 'permission-needed', 'device-missing', 'failed']),
      targetFps: numberSchema({ min: 0, max: 1000 }),
      framesCaptured: nonNegativeInteger,
      droppedFrames: nonNegativeInteger,
      frameAgeMs: optionalSchema(nonNegativeInteger),
      updatedAt: timestamp
    },
    { allowUnknown: true }
  )
) as RuntimeSchema<PreviewCameraStatus>

const previewScreenStatusSchema = boundedSemanticValue(
  'a preview screen status',
  objectSchema(
    {
      state: enumSchema(['starting', 'live', 'permission-needed', 'source-missing', 'failed']),
      targetFps: numberSchema({ min: 0, max: 1000 }),
      framesCaptured: nonNegativeInteger,
      droppedFrames: nonNegativeInteger,
      frameAgeMs: optionalSchema(nonNegativeInteger),
      includeCursor: booleanSchema,
      excludeCurrentProcessWindows: booleanSchema,
      updatedAt: timestamp
    },
    { allowUnknown: true }
  )
) as RuntimeSchema<PreviewScreenStatus>

const diagnosticStatsSchema = boundedSemanticValue(
  'bounded diagnostic statistics',
  objectSchema(
    {
      skippedFrames: nonNegativeInteger,
      droppedFrames: nonNegativeInteger,
      updatedAt: optionalSchema(timestamp)
    },
    { allowUnknown: true }
  )
) as RuntimeSchema<DiagnosticStats>

const layoutTransactionResultSchema = runtimeSchema<unknown>(
  'a committed layout transaction result',
  (value, path) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`${path} must be a committed layout transaction result.`)
    }
    const record = value as Record<string, unknown>
    booleanSchema.parse(record.applied, `${path}.applied`)
    enumSchema(['idle', 'hot', 'warm']).parse(record.mode, `${path}.mode`)
    numberSchema({ integer: true, min: 0 }).parse(record.sceneRevision, `${path}.sceneRevision`)
    numberSchema({ integer: true, min: 1 }).parse(record.intentId, `${path}.intentId`)
    booleanSchema.parse(record.presentationProven, `${path}.presentationProven`)
    sceneSchema.parse(record.scene, `${path}.scene`)
    compositorStatusSchema.parse(record.compositorStatus, `${path}.compositorStatus`)
    optionalText.parse(record.message, `${path}.message`)
    return value
  }
)

const sceneCommitStatusSchema = boundedSemanticValue(
  'a committed scene result',
  objectSchema(
    {
      applied: booleanSchema,
      mode: enumSchema(['idle', 'hot', 'warm']),
      sceneRevision: nonNegativeInteger,
      scene: sceneSchema,
      compositorStatus: compositorStatusSchema,
      message: optionalText
    },
    { allowUnknown: false }
  )
)

const sessionSummarySchema = boundedSemanticValue(
  'a session summary',
  objectSchema(
    {
      id: boundedString,
      title: stringSchema({ maxLength: 16_384 }),
      startedAt: timestamp,
      status: boundedString,
      mode: boundedString,
      commentCount: nonNegativeInteger,
      derivedFromSessionId: optionalSchema(boundedString),
      sourceTitle: optionalSchema(stringSchema({ maxLength: 16_384 })),
      processingKind: optionalSchema(literalSchema('noise-cleanup'))
    },
    { allowUnknown: true }
  )
)

const sessionDeletionOperationSchema: RuntimeSchema<SessionDeletionOperation> = objectSchema(
  {
    operationId: boundedString,
    sessionId: boundedString,
    pathCount: numberSchema({ integer: true, min: 0, max: 16 }),
    blockedPathCount: numberSchema({ integer: true, min: 0, max: 16 })
  },
  { allowUnknown: false }
)

const noiseCleanupJobFieldsSchema = objectSchema(
  {
    id: boundedString,
    sourceSessionId: boundedString,
    status: enumSchema(['queued', 'processing', 'validating', 'completed', 'failed', 'cancelled']),
    progressPercent: numberSchema({ integer: true, min: 0, max: 100 }),
    preset: literalSchema('speech-v1'),
    outputSessionId: optionalSchema(boundedString),
    outputPath: optionalSchema(boundedPath),
    errorCode: optionalText,
    errorMessage: optionalText,
    createdAt: timestamp,
    updatedAt: timestamp
  },
  { allowUnknown: false }
)
const noiseCleanupJobSchema = runtimeSchema<NoiseCleanupJob>(
  'a Noise Cleanup job',
  (value, path) => {
    const job = noiseCleanupJobFieldsSchema.parse(value, path) as NoiseCleanupJob
    if (job.status === 'completed' && (!job.outputSessionId || !job.outputPath)) {
      throw new Error(`${path} must identify the completed output session and path.`)
    }
    if (job.status === 'failed' && (!job.errorCode || !job.errorMessage)) {
      throw new Error(`${path} must include a stable failure code and message.`)
    }
    return job
  }
)

const fileAssessmentSchema = boundedSemanticValue(
  'a file assessment',
  objectSchema(
    {
      path: boundedPath,
      verdict: enumSchema(['clean', 'repairable', 'needs-review']),
      issues: arraySchema(boundedBackendPayloadSchema, { maxLength: 1000 }),
      reasons: arraySchema(stringSchema({ maxLength: 16_384 }), { maxLength: 1000 }),
      repairable: booleanSchema,
      hasBackup: booleanSchema
    },
    { allowUnknown: false }
  )
)

const gateStatusSchema = boundedSemanticValue(
  'a repair gate status',
  runtimeSchema('a repair gate status', (value, path) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`${path} must be a repair gate status.`)
    }
    const record = value as Record<string, unknown>
    enumSchema(['ready', 'repaired', 'not-hundred-percent', 'failed']).parse(
      record.status,
      `${path}.status`
    )
    boundedPath.parse(record.path, `${path}.path`)
    return value
  })
)

const sessionStartParamsSchema = objectSchema(
  {
    sources: sourceSelectionSchema,
    layout: layoutSchema,
    scene: optionalSchema(sceneSchema),
    output: objectSchema(
      {
        recordEnabled: booleanSchema,
        streamEnabled: booleanSchema,
        outputDirectoryCapability: optionalSchema(boundedString),
        keepOriginalMkv: optionalSchema(booleanSchema),
        video: boundedBackendParamValueSchema,
        rtmp: boundedBackendParamValueSchema
      },
      { allowUnknown: false }
    ),
    audio: optionalSchema(boundedBackendParamValueSchema),
    streaming: optionalSchema(boundedBackendParamValueSchema),
    captions: optionalSchema(boundedBackendParamValueSchema)
  },
  { allowUnknown: false }
)

const undefinedOrFfmpegPathSchema = unionSchema([
  undefinedSchema,
  objectSchema({ ffmpegPath: optionalSchema(boundedPath) }, { allowUnknown: false })
])

const oauthStateSchema = stringSchema({ minLength: 8, maxLength: 2048 })
const oauthCompleteParamsSchema = objectSchema(
  {
    state: oauthStateSchema,
    code: optionalSchema(stringSchema({ maxLength: 8192 })),
    error: optionalSchema(stringSchema({ maxLength: 1024 })),
    errorDescription: optionalSchema(stringSchema({ maxLength: 16_384 }))
  },
  { allowUnknown: false }
) as RuntimeSchema<OAuthCompleteParams>

const oauthCallbackResultFields = {
  status: enumSchema(['success', 'failed', 'expired', 'unknown-state']),
  codePresent: booleanSchema,
  error: optionalSchema(stringSchema({ maxLength: 1024 })),
  message: optionalSchema(stringSchema({ maxLength: 16_384 })),
  tokenStored: booleanSchema,
  accountConnected: booleanSchema,
  retryable: booleanSchema,
  receivedAt: timestamp
}
const oauth2CallbackResultSchema = objectSchema(
  {
    ...oauthCallbackResultFields,
    platform: optionalSchema(enumSchema(['youtube', 'twitch', 'x', 'custom'])),
    state: oauthStateSchema
  },
  { allowUnknown: false }
)
const xOAuth1CallbackResultSchema = objectSchema(
  {
    ...oauthCallbackResultFields,
    platform: literalSchema('x'),
    // X live uses OAuth 1.0a's request-token/verifier pair rather than an
    // OAuth2 state value. Keep that exception exact to X instead of
    // weakening state validation for every provider event.
    state: literalSchema('')
  },
  { allowUnknown: false }
)
const oauthCallbackResultSchema = runtimeSchema<OAuthCallbackResult>(
  'an OAuth2 or X OAuth1 callback result',
  (value, path) => {
    const record =
      typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null
    return record?.platform === 'x' && record.state === ''
      ? xOAuth1CallbackResultSchema.parse(value, path)
      : oauth2CallbackResultSchema.parse(value, path)
  }
)

const runtimeContracts = {
  'health.ping': { params: undefinedOrFfmpegPathSchema, result: backendHealthSchema },
  'entitlements.get': { params: undefinedSchema, result: entitlementsSchema },
  'entitlements.refresh': { params: undefinedSchema, result: entitlementsSchema },
  'account.get': { params: undefinedSchema, result: accountSchema },
  'account.complete_sign_in': {
    params: objectSchema(
      {
        code: stringSchema({ minLength: 16, maxLength: 16_384 }),
        state: stringSchema({ minLength: 16, maxLength: 512 }),
        verifier: stringSchema({ minLength: 43, maxLength: 128 }),
        intentGeneration: numberSchema({ integer: true, min: 1, max: Number.MAX_SAFE_INTEGER })
      },
      { allowUnknown: false }
    ),
    result: accountSchema
  },
  'account.sign_out': { params: undefinedSchema, result: accountSchema },
  'platformAccounts.oauth.complete': {
    params: oauthCompleteParamsSchema,
    result: oauthCallbackResultSchema
  },
  'devices.list': { params: undefinedOrFfmpegPathSchema, result: deviceListSchema },
  'recording.status': { params: undefinedSchema, result: recordingStatusSchema },
  'session.start': { params: sessionStartParamsSchema, result: recordingStatusSchema },
  'session.stop': { params: undefinedSchema, result: recordingStatusSchema },
  'scene.get': { params: undefinedSchema, result: sceneSchema },
  'scene.load_from_capture_config': {
    params: sceneConfigSchema,
    result: sceneCommitStatusSchema
  },
  'scene.layout.apply_preview': {
    params: layoutTransactionParamsSchema,
    result: layoutTransactionResultSchema
  },
  'scene.layout.apply_live': {
    params: layoutTransactionParamsSchema,
    result: layoutTransactionResultSchema
  },
  'compositor.status': { params: undefinedSchema, result: compositorStatusSchema },
  'preview.live.status': { params: undefinedSchema, result: previewLiveStatusSchema },
  'preview.surface.status': { params: undefinedSchema, result: previewSurfaceStatusSchema },
  'preview.camera.status': { params: undefinedSchema, result: previewCameraStatusSchema },
  'preview.screen.status': { params: undefinedSchema, result: previewScreenStatusSchema },
  'diagnostics.stats': { params: undefinedSchema, result: diagnosticStatsSchema },
  'sessions.list': {
    params: unionSchema([
      undefinedSchema,
      objectSchema(
        { limit: optionalSchema(numberSchema({ integer: true, min: 1, max: 1000 })) },
        { allowUnknown: false }
      )
    ]),
    result: arraySchema(sessionSummarySchema, { maxLength: 1000 })
  },
  'sessions.storage': {
    params: undefinedSchema,
    result: objectSchema(
      {
        count: numberSchema({ integer: true, min: 0 }),
        totalBytes: numberSchema({ integer: true, min: 0 })
      },
      { allowUnknown: false }
    )
  },
  'sessions.comments.list': {
    params: objectSchema(
      {
        sessionId: boundedString,
        cursor: optionalSchema(stringSchema({ minLength: 1, maxLength: 4096 })),
        limit: optionalSchema(numberSchema({ integer: true, min: 1, max: 1000 }))
      },
      { allowUnknown: false }
    ),
    result: objectSchema(
      {
        messages: arraySchema(boundedBackendPayloadSchema, { maxLength: 1000 }),
        nextCursor: optionalSchema(stringSchema({ minLength: 1, maxLength: 4096 }))
      },
      { allowUnknown: false }
    )
  },
  'sessions.delete': {
    params: objectSchema(
      {
        sessionIds: arraySchema(boundedString, { maxLength: 500 })
      },
      { allowUnknown: false }
    ),
    result: arraySchema(sessionDeletionOperationSchema, { maxLength: 500 })
  },
  'sessions.delete.pending': {
    params: undefinedSchema,
    result: arraySchema(sessionDeletionOperationSchema, { maxLength: 500 })
  },
  'noiseCleanup.start': {
    params: objectSchema({ sessionId: boundedString }, { allowUnknown: false }),
    result: noiseCleanupJobSchema
  },
  'noiseCleanup.cancel': {
    params: objectSchema({ jobId: boundedString }, { allowUnknown: false }),
    result: noiseCleanupJobSchema
  },
  'noiseCleanup.list': {
    params: undefinedSchema,
    result: arraySchema(noiseCleanupJobSchema, { maxLength: 1000 })
  },
  'repair.assess_file': {
    params: objectSchema({ sessionId: boundedString }, { allowUnknown: false }),
    result: fileAssessmentSchema
  },
  'repair.repair_file': {
    params: objectSchema(
      {
        sessionId: boundedString,
        expectAudio: optionalSchema(booleanSchema),
        intendedFps: optionalSchema(numberSchema({ min: 1, max: 480 }))
      },
      { allowUnknown: false }
    ),
    result: gateStatusSchema
  },
  'repair.restore_file': {
    params: objectSchema({ sessionId: boundedString }, { allowUnknown: false }),
    result: objectSchema({ restored: booleanSchema }, { allowUnknown: false })
  }
} satisfies Record<BackendRpcMethod, RuntimeBackendRpcContract>

export function isTypedBackendRpcMethod(method: string): method is BackendRpcMethod {
  return method in runtimeContracts
}

export function validateBackendRpcParams(method: string, params: unknown): unknown {
  const contract = runtimeContracts[method as keyof typeof runtimeContracts] as
    | RuntimeBackendRpcContract
    | undefined
  return (contract?.params ?? boundedBackendParamsSchema).parse(params, `backend.${method}.params`)
}

export function validateBackendRpcResult(method: string, result: unknown): unknown {
  const contract = runtimeContracts[method as keyof typeof runtimeContracts] as
    | RuntimeBackendRpcContract
    | undefined
  return (contract?.result ?? boundedBackendPayloadSchema).parse(result, `backend.${method}.result`)
}

/** Runtime-validated method names, exported for protocol coverage tests. */
export const runtimeValidatedBackendRpcMethods = Object.freeze(
  Object.keys(runtimeContracts) as BackendRpcMethod[]
)

const runtimeEventSchemas = {
  'devices.changed': deviceListSchema,
  'entitlements.updated': entitlementsSchema,
  'noiseCleanup.status': noiseCleanupJobSchema,
  'platformAccounts.oauth.callback': oauthCallbackResultSchema,
  'recording.status': recordingStatusSchema,
  'scene.changed': sceneSchema,
  'compositor.status': compositorStatusSchema,
  'preview.live.status': previewLiveStatusSchema,
  'preview.surface.status': previewSurfaceStatusSchema,
  'preview.camera.status': previewCameraStatusSchema,
  'preview.screen.status': previewScreenStatusSchema,
  'diagnostics.stats': diagnosticStatsSchema
} satisfies Record<BackendEvent, RuntimeSchema<unknown>>

export function validateBackendEventPayload(event: string, payload: unknown): unknown {
  const schema = runtimeEventSchemas[event as keyof typeof runtimeEventSchemas] as
    | RuntimeSchema<unknown>
    | undefined
  return (schema ?? boundedBackendPayloadSchema).parse(payload, `backend.event.${event}`)
}

export function validateCompositorFrameReadyPayload(payload: unknown): CompositorFrameReady {
  return compositorFrameReadySchema.parse(payload, 'backend.event.preview.frameReady')
}

/** Parse the websocket envelope before any `in` checks or payload dispatch. */
export function parseBackendWireMessage(raw: string): ServerResponse | ServerEvent {
  if (typeof raw !== 'string' || raw.length > MAX_BACKEND_WIRE_MESSAGE_CHARS) {
    throw new Error('Backend sent an oversized websocket message.')
  }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error('Backend sent invalid JSON.')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Backend sent an invalid websocket envelope.')
  }
  const record = value as Record<string, unknown>
  if ('id' in record) {
    const id = boundedString.parse(record.id, 'backend.response.id')
    const ok = booleanSchema.parse(record.ok, 'backend.response.ok')
    if (ok) {
      assertExactEnvelopeFields(record, ['id', 'ok', 'payload'], 'backend.response')
      return { id, ok, payload: record.payload }
    }
    assertExactEnvelopeFields(record, ['id', 'ok', 'error'], 'backend.response')
    const error = objectSchema(
      {
        code: stringSchema({ minLength: 1, maxLength: 1024 }),
        message: stringSchema({ minLength: 1, maxLength: 16_384 })
      },
      { allowUnknown: false }
    ).parse(record.error, 'backend.response.error')
    return { id, ok, error }
  }
  assertExactEnvelopeFields(record, ['event', 'payload'], 'backend.event')
  const event = boundedString.parse(record.event, 'backend.event.name')
  return { event, payload: record.payload }
}

function assertExactEnvelopeFields(
  record: Record<string, unknown>,
  expectedFields: readonly string[],
  path: string
): void {
  const expected = new Set(expectedFields)
  for (const field of Object.keys(record)) {
    if (!expected.has(field)) {
      throw new Error(`${path}.${field} must be a known field.`)
    }
  }
  for (const field of expectedFields) {
    if (!Object.hasOwn(record, field)) {
      throw new Error(`${path}.${field} is required.`)
    }
  }
}
