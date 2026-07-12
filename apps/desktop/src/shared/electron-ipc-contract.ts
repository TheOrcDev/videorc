import type {
  AccountCallbackEnvelope,
  BackendConnection,
  BackendLifecycleEvent,
  BackendLogEvent,
  CaptionWindowSnapshot,
  CaptionsUpdate,
  CaptionsWindowState,
  CommentHighlightCommand,
  CommentHighlightState,
  CommentsClearCommand,
  CommentsSendCommand,
  CommentsSnapshotDelta,
  CommentsViewSnapshot,
  CommentsWindowState,
  GlassWallpaperState,
  NotesDocument,
  NotesWindowState,
  OAuthCallbackEnvelope,
  PreviewWindowState,
  UpdateStatus,
  VideorcApi,
  ViewerSample
} from './backend'
import { LAYOUT_PRESET_VALUES } from './backend'
import {
  arraySchema,
  booleanSchema,
  enumSchema,
  nullableSchema,
  numberSchema,
  objectSchema,
  optionalSchema,
  runtimeSchema,
  stringSchema,
  tupleSchema,
  undefinedSchema,
  RuntimeSchemaError,
  type RuntimeSchema
} from './runtime-schema'

type AsyncApiMethod = (...args: never[]) => Promise<unknown>
type InvokeDefinition<TMethod> = TMethod extends (...args: infer TArgs) => Promise<infer TResult>
  ? { args: TArgs; result: TResult }
  : never

/**
 * Single channel-to-public-method table. It prevents Electron channel strings,
 * preload signatures and renderer-facing API names from drifting independently.
 */
export const electronInvokeApiMethods = {
  'backend:get-connection': 'getBackendConnection',
  'backend:get-logs': 'getBackendLogs',
  'app:get-runtime-info': 'getRuntimeInfo',
  'app:set-native-theme': 'setNativeTheme',
  'screens:pick-image': 'pickScreenImage',
  'backgrounds:import-image': 'importBackgroundImage',
  'backgrounds:asset-exists': 'backgroundAssetExists',
  'backgrounds:bundled-assets': 'getBundledBackgroundAssets',
  'avatars:cache': 'cacheChatAvatar',
  'account:begin-sign-in': 'beginAccountSignIn',
  'account:sign-out': 'signOutAccount',
  'account:callbacks-list': 'getPendingAccountCallbacks',
  'account:callback-ack': 'acknowledgeAccountCallback',
  'oauth:open-url': 'openOAuthUrl',
  'oauth:callback-redirect-uri': 'getOAuthCallbackRedirectUri',
  'oauth:callbacks-list': 'getPendingOAuthCallbacks',
  'oauth:callback-ack': 'acknowledgeOAuthCallback',
  'preview-surface:mode': 'getNativePreviewSurfaceMode',
  'preview-surface:pump-mode': 'getNativePreviewMainPumpActive',
  'preview-surface:create': 'createNativePreviewSurface',
  'preview-surface:update-bounds': 'updateNativePreviewSurfaceBounds',
  'preview-surface:apply-host-commands': 'applyNativePreviewHostCommands',
  'preview-surface:drain-host-commands': 'drainNativePreviewHostCommands',
  'preview-surface:update-scene': 'updateNativePreviewSurfaceScene',
  'preview-surface:update-compositor': 'updateNativePreviewSurfaceCompositor',
  'preview-surface:set-frame-polling-suppressed': 'setNativePreviewSurfaceFramePollingSuppressed',
  'preview-surface:destroy': 'destroyNativePreviewSurface',
  'preview-surface:status': 'getNativePreviewSurfaceStatus',
  'preview-window:open': 'openPreviewWindow',
  'preview-window:close': 'closePreviewWindow',
  'preview-window:toggle': 'togglePreviewWindow',
  'preview-window:get-state': 'getPreviewWindowState',
  'preview-window:permission-required': 'reportPreviewPermissionRequired',
  'preview-window:set-always-on-top': 'setPreviewWindowAlwaysOnTop',
  'preview-window:set-mode': 'setPreviewWindowMode',
  'preview-window:report-dock-slot': 'reportPreviewDockSlot',
  'preview-window:set-dock-overlay': 'setPreviewDockOverlayOpen',
  'preview-window:set-aspect-ratio': 'setPreviewWindowAspectRatio',
  'notes-window:open': 'openNotesWindow',
  'notes-window:close': 'closeNotesWindow',
  'notes-window:get-state': 'getNotesWindowState',
  'notes-window:set-always-on-top': 'setNotesWindowAlwaysOnTop',
  'notes-window:get-document': 'getNotesDocument',
  'notes-window:save-document': 'saveNotesDocument',
  'comments-window:open': 'openCommentsWindow',
  'comments-window:close': 'closeCommentsWindow',
  'comments-window:toggle': 'toggleCommentsWindow',
  'comments-window:get-state': 'getCommentsWindowState',
  'comments-window:set-always-on-top': 'setCommentsWindowAlwaysOnTop',
  'comments-window:push-snapshot': 'pushCommentsSnapshot',
  'comments-window:push-delta': 'pushCommentsDelta',
  'comments-window:get-snapshot': 'getCommentsSnapshot',
  'comments-window:set-view-mode': 'setCommentsViewMode',
  'comments-window:highlight': 'sendCommentHighlight',
  'comments-window:highlight-result-push': 'pushCommentHighlightResult',
  'comments-window:highlight-state-push': 'pushCommentHighlightState',
  'comments-window:highlight-state-get': 'getCommentHighlightState',
  'comments-window:send': 'sendChatFromCommentsWindow',
  'comments-window:send-result-push': 'pushChatSendResult',
  'comments-window:clear': 'clearComments',
  'comments-window:clear-result-push': 'pushCommentsClearResult',
  'comments-window:viewers-push': 'pushViewerSample',
  'comments-window:viewers-get': 'getViewerSample',
  'captions-window:open': 'openCaptionsWindow',
  'captions-window:close': 'closeCaptionsWindow',
  'captions-window:toggle': 'toggleCaptionsWindow',
  'captions-window:get-state': 'getCaptionsWindowState',
  'captions-window:set-always-on-top': 'setCaptionsWindowAlwaysOnTop',
  'captions-window:push-snapshot': 'pushCaptionSnapshot',
  'captions-window:get-snapshot': 'getCaptionSnapshot',
  'captions-window:push-lines': 'pushCaptionLines',
  'captions-window:get-lines': 'getCaptionLines',
  'system:open-permissions': 'openSystemPermissions',
  'system:media-access-status': 'getMediaAccessStatus',
  'system:request-media-access': 'requestMediaAccess',
  'system:reveal-permission-target': 'revealPermissionTarget',
  'resource:reveal-selection': 'revealSelectedResource',
  'resource:authorize-output-directory': 'authorizeOutputDirectory',
  'resource:reveal-session': 'revealSession',
  'resource:reveal-background': 'revealBackgroundAsset',
  'resource:open-session': 'openSession',
  'resource:trash-session-deletion': 'trashSessionDeletion',
  'system:pick-file': 'pickFile',
  'system:pick-directory': 'pickDirectory',
  'system:check-directory': 'checkDirectory',
  'obs:discover': 'obsDiscover',
  'obs:read': 'obsRead',
  'obs:read-stream-key': 'obsReadStreamKey',
  'glass:wallpaper:get': 'getGlassWallpaper',
  'updates:check': 'checkForUpdates',
  'updates:download': 'downloadUpdate',
  'updates:install': 'installUpdate',
  'updates:get-status': 'getUpdateStatus'
} as const satisfies Record<string, keyof VideorcApi>

export type ElectronInvokeChannel = keyof typeof electronInvokeApiMethods
export type ElectronIpcInvokeMap = {
  [TChannel in ElectronInvokeChannel]: InvokeDefinition<
    NonNullable<VideorcApi[(typeof electronInvokeApiMethods)[TChannel]]>
  >
}
export type ElectronInvokeArgs<TChannel extends ElectronInvokeChannel> =
  ElectronIpcInvokeMap[TChannel]['args']
export type ElectronInvokeResult<TChannel extends ElectronInvokeChannel> =
  ElectronIpcInvokeMap[TChannel]['result']

export interface ElectronIpcEventMap {
  'account:callback': AccountCallbackEnvelope
  'backend:connection': BackendConnection
  'backend:lifecycle': BackendLifecycleEvent
  'backend:log': BackendLogEvent
  'preview-window:state': PreviewWindowState
  'notes-window:state': NotesWindowState
  'notes-window:document': NotesDocument
  'notes-window:flush-request': undefined
  'comments-window:state': CommentsWindowState
  'comments-window:snapshot': CommentsViewSnapshot
  'comments-window:delta': CommentsSnapshotDelta
  'comments-window:highlight-request': CommentHighlightCommand
  'comments-window:highlight-state': CommentHighlightState
  'comments-window:send-request': CommentsSendCommand
  'comments-window:clear-request': CommentsClearCommand
  'comments-window:viewers': ViewerSample | null
  'captions-window:state': CaptionsWindowState
  'captions-window:snapshot': CaptionWindowSnapshot
  'captions-window:lines': CaptionsUpdate[]
  'oauth:callback-url': OAuthCallbackEnvelope
  'shortcut:navigate': string
  'preview-surface:pump-mode': boolean
  'preview-surface:resync-scene': undefined
  'glass:wallpaper': GlassWallpaperState
  'glass:geometry': Pick<GlassWallpaperState, 'window' | 'display'>
  'app:update-status': UpdateStatus
}

export type ElectronEventChannel = keyof ElectronIpcEventMap

export const electronEventChannels = [
  'account:callback',
  'backend:connection',
  'backend:lifecycle',
  'backend:log',
  'preview-window:state',
  'notes-window:state',
  'notes-window:document',
  'notes-window:flush-request',
  'comments-window:state',
  'comments-window:snapshot',
  'comments-window:delta',
  'comments-window:highlight-request',
  'comments-window:highlight-state',
  'comments-window:send-request',
  'comments-window:clear-request',
  'comments-window:viewers',
  'captions-window:state',
  'captions-window:snapshot',
  'captions-window:lines',
  'oauth:callback-url',
  'shortcut:navigate',
  'preview-surface:pump-mode',
  'preview-surface:resync-scene',
  'glass:wallpaper',
  'glass:geometry',
  'app:update-status'
] as const satisfies readonly ElectronEventChannel[]

type MissingElectronEventChannel = Exclude<
  ElectronEventChannel,
  (typeof electronEventChannels)[number]
>
export type ElectronEventChannelInvariant = MissingElectronEventChannel extends never ? true : never

type IpcRuntimeContract = {
  args: RuntimeSchema<unknown[]>
  result: RuntimeSchema<unknown>
}

const MAX_IPC_ARGUMENTS = 32
const MAX_IPC_DEPTH = 16
const MAX_IPC_NODES = 100_000
const MAX_IPC_ARRAY_ITEMS = 10_000
const MAX_IPC_OBJECT_KEYS = 10_000
const MAX_IPC_KEY_LENGTH = 256
const MAX_IPC_STRING_CHARACTERS = 32 * 1024 * 1024
export const MAX_NOTES_TEXT_LENGTH = 1_000_000

type IpcValueBudget = {
  nodes: number
  stringCharacters: number
}

function parseBoundedIpcValue(value: unknown, path: string): unknown {
  const budget: IpcValueBudget = {
    nodes: MAX_IPC_NODES,
    stringCharacters: MAX_IPC_STRING_CHARACTERS
  }
  const activeObjects = new WeakSet<object>()

  const visit = (entry: unknown, entryPath: string, depth: number): void => {
    budget.nodes -= 1
    if (budget.nodes < 0 || depth > MAX_IPC_DEPTH) {
      throw new RuntimeSchemaError(entryPath, 'a bounded structured-clone value')
    }
    if (entry === null || entry === undefined || typeof entry === 'boolean') {
      return
    }
    if (typeof entry === 'number') {
      if (!Number.isFinite(entry)) {
        throw new RuntimeSchemaError(entryPath, 'a finite number')
      }
      return
    }
    if (typeof entry === 'string') {
      budget.stringCharacters -= entry.length
      if (budget.stringCharacters < 0) {
        throw new RuntimeSchemaError(entryPath, 'bounded string data')
      }
      return
    }
    if (typeof entry !== 'object') {
      throw new RuntimeSchemaError(entryPath, 'a structured-clone value')
    }
    if (activeObjects.has(entry)) {
      throw new RuntimeSchemaError(entryPath, 'an acyclic structured-clone value')
    }
    activeObjects.add(entry)
    try {
      if (Array.isArray(entry)) {
        if (entry.length > MAX_IPC_ARRAY_ITEMS) {
          throw new RuntimeSchemaError(
            entryPath,
            `an array with at most ${MAX_IPC_ARRAY_ITEMS} items`
          )
        }
        entry.forEach((item, index) => visit(item, `${entryPath}[${index}]`, depth + 1))
        return
      }

      const prototype = Object.getPrototypeOf(entry)
      if (prototype !== Object.prototype && prototype !== null) {
        throw new RuntimeSchemaError(entryPath, 'a plain object')
      }
      const entries = Object.entries(entry)
      if (entries.length > MAX_IPC_OBJECT_KEYS) {
        throw new RuntimeSchemaError(
          entryPath,
          `an object with at most ${MAX_IPC_OBJECT_KEYS} fields`
        )
      }
      for (const [key, nested] of entries) {
        if (
          key.length > MAX_IPC_KEY_LENGTH ||
          key === '__proto__' ||
          key === 'prototype' ||
          key === 'constructor'
        ) {
          throw new RuntimeSchemaError(entryPath, 'an object with safe bounded field names')
        }
        budget.stringCharacters -= key.length
        if (budget.stringCharacters < 0) {
          throw new RuntimeSchemaError(entryPath, 'bounded string data')
        }
        visit(nested, `${entryPath}.${key}`, depth + 1)
      }
    } finally {
      activeObjects.delete(entry)
    }
  }

  visit(value, path, 0)
  return value
}

const boundedIpcValueSchema = runtimeSchema<unknown>(
  'a bounded structured-clone value',
  parseBoundedIpcValue
)
const boundedIpcArgsSchema = runtimeSchema<unknown[]>('bounded IPC arguments', (value, path) => {
  if (!Array.isArray(value) || value.length > MAX_IPC_ARGUMENTS) {
    throw new RuntimeSchemaError(path, `an argument list with at most ${MAX_IPC_ARGUMENTS} items`)
  }
  parseBoundedIpcValue(value, path)
  return value
})

function invokeContract(
  args: RuntimeSchema<unknown[]>,
  result: RuntimeSchema<unknown> = boundedIpcValueSchema
): IpcRuntimeContract {
  return { args, result }
}

const pathSchema = stringSchema({ minLength: 1, maxLength: 32_768 })
const boundedIdentifier = stringSchema({ minLength: 1, maxLength: 1024 })
const boundedStatusText = stringSchema({ maxLength: 16_384 })
const nonNegativeSafeIntegerSchema = runtimeSchema<number>(
  'a non-negative safe integer',
  (value, path) => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new RuntimeSchemaError(path, 'a non-negative safe integer')
    }
    return value
  }
)
const positiveSafeIntegerSchema = runtimeSchema<number>(
  'a positive safe integer',
  (value, path) => {
    const parsed = nonNegativeSafeIntegerSchema.parse(value, path)
    if (parsed === 0) {
      throw new RuntimeSchemaError(path, 'a positive safe integer')
    }
    return parsed
  }
)
const boundedUrl = runtimeSchema<string>('an allowed URL', (value, path) => {
  const input = stringSchema({ minLength: 1, maxLength: 16_384 }).parse(value, path)
  let parsed: URL
  try {
    parsed = new URL(input)
  } catch {
    throw new Error(`${path} must be an allowed URL.`)
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`${path} must be an allowed URL.`)
  }
  if (
    parsed.username ||
    parsed.password ||
    (parsed.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))
  ) {
    throw new Error(`${path} must be an allowed URL.`)
  }
  return input
})

const oauthCallbackIdentifierSchema = runtimeSchema<string>(
  'a provider OAuth callback identifier',
  (value, path) => {
    const input = stringSchema({ minLength: 43, maxLength: 43 }).parse(value, path)
    if (!/^[A-Za-z0-9_-]{43}$/.test(input)) {
      throw new RuntimeSchemaError(path, 'a 43-character base64url callback identifier')
    }
    return input
  }
)

const oauthCallbackUrlSchema = runtimeSchema<string>(
  'a provider OAuth callback URL',
  (value, path) => {
    const input = stringSchema({ minLength: 1, maxLength: 16_384 }).parse(value, path)
    let parsed: URL
    try {
      parsed = new URL(input)
    } catch {
      throw new RuntimeSchemaError(path, 'a provider OAuth callback URL')
    }
    if (
      parsed.protocol !== 'videorc:' ||
      parsed.hostname !== 'oauth' ||
      parsed.pathname !== '/callback' ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      parsed.hash
    ) {
      throw new RuntimeSchemaError(path, 'a provider OAuth callback URL')
    }
    const state = parsed.searchParams.get('state')?.trim()
    const code = parsed.searchParams.get('code')?.trim()
    const error = parsed.searchParams.get('error')?.trim()
    if (!state || state.length < 8 || state.length > 2048 || (!code && !error)) {
      throw new RuntimeSchemaError(path, 'a complete provider OAuth callback URL')
    }
    if ((code?.length ?? 0) > 8192 || (error?.length ?? 0) > 1024) {
      throw new RuntimeSchemaError(path, 'a bounded provider OAuth callback URL')
    }
    return input
  }
)

const oauthCallbackEnvelopeShapeSchema = objectSchema(
  {
    id: oauthCallbackIdentifierSchema,
    url: oauthCallbackUrlSchema,
    state: stringSchema({ minLength: 8, maxLength: 2048 }),
    receivedAtMs: numberSchema({ integer: true, min: 0, max: 8_640_000_000_000_000 })
  },
  { allowUnknown: false }
)

const oauthCallbackEnvelopeSchema = runtimeSchema<OAuthCallbackEnvelope>(
  'a provider OAuth callback envelope',
  (value, path) => {
    const envelope = oauthCallbackEnvelopeShapeSchema.parse(value, path)
    const urlState = new URL(envelope.url).searchParams.get('state')?.trim()
    if (urlState !== envelope.state) {
      throw new RuntimeSchemaError(`${path}.state`, 'the state from the callback URL')
    }
    return envelope
  }
)

const accountAuthorizeUrl = runtimeSchema<string>('a desktop authorization URL', (value, path) => {
  const input = boundedUrl.parse(value, path)
  const parsed = new URL(input)
  const productionOrigin = parsed.origin === 'https://www.videorc.com'
  const developmentLoopbackOrigin =
    (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
    ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
  if (
    parsed.pathname !== '/desktop/authorize/v2' ||
    (!productionOrigin && !developmentLoopbackOrigin)
  ) {
    throw new Error(`${path} must be a desktop authorization URL.`)
  }
  return input
})

const notesPatchSchema = objectSchema(
  {
    text: optionalSchema(stringSchema({ maxLength: MAX_NOTES_TEXT_LENGTH })),
    fontScale: optionalSchema(enumSchema(['sm', 'md', 'lg'])),
    updatedAt: optionalSchema(stringSchema({ maxLength: 128 }))
  },
  { allowUnknown: false }
)

const notesDocumentSchema = objectSchema(
  {
    text: stringSchema({ maxLength: MAX_NOTES_TEXT_LENGTH }),
    fontScale: enumSchema(['sm', 'md', 'lg']),
    updatedAt: stringSchema({ minLength: 1, maxLength: 128 })
  },
  { allowUnknown: false }
)

const previewBoundsSchema = objectSchema(
  {
    screenX: numberSchema(),
    screenY: numberSchema(),
    width: numberSchema({ min: 0, max: 65_536 }),
    height: numberSchema({ min: 0, max: 65_536 }),
    scaleFactor: numberSchema({ min: 0.1, max: 16 }),
    screenHeight: optionalSchema(numberSchema({ min: 0, max: 65_536 })),
    clipX: optionalSchema(numberSchema()),
    clipY: optionalSchema(numberSchema()),
    clipWidth: optionalSchema(numberSchema({ min: 0, max: 65_536 })),
    clipHeight: optionalSchema(numberSchema({ min: 0, max: 65_536 })),
    visible: optionalSchema(booleanSchema),
    orderAboveWindowId: optionalSchema(nonNegativeSafeIntegerSchema),
    elevated: optionalSchema(booleanSchema)
  },
  { allowUnknown: false }
)

function boundedSemanticValue(
  description: string,
  semanticSchema: RuntimeSchema<unknown>
): RuntimeSchema<unknown> {
  return runtimeSchema(description, (value, path) => {
    boundedIpcValueSchema.parse(value, path)
    semanticSchema.parse(value, path)
    // Semantic object schemas intentionally inspect only authoritative core
    // fields. Return the original bounded value so optional telemetry added by
    // a newer main/renderer is not silently stripped at the IPC boundary.
    return value
  })
}

const cameraTransformSchema = objectSchema(
  {
    x: numberSchema(),
    y: numberSchema(),
    width: numberSchema(),
    height: numberSchema()
  },
  { allowUnknown: false }
)

const layoutSettingsSchema = objectSchema(
  {
    layoutPreset: enumSchema(LAYOUT_PRESET_VALUES),
    cameraTransformMode: enumSchema(['preset', 'custom']),
    cameraTransform: nullableSchema(cameraTransformSchema),
    cameraCorner: enumSchema(['top-left', 'top-right', 'bottom-left', 'bottom-right']),
    cameraSize: enumSchema(['small', 'medium', 'large']),
    cameraShape: enumSchema(['rectangle', 'rounded', 'circle']),
    cameraCornerRadiusPct: numberSchema(),
    cameraAspect: enumSchema(['source', 'square', 'portrait']),
    cameraMargin: numberSchema(),
    cameraFit: enumSchema(['fit', 'fill']),
    cameraMirror: booleanSchema,
    cameraZoom: numberSchema(),
    cameraOffsetX: numberSchema(),
    cameraOffsetY: numberSchema(),
    sideBySideSplit: enumSchema(['50-50', '60-40', '70-30']),
    sideBySideCameraSide: enumSchema(['left', 'right'])
  },
  { allowUnknown: false }
)

const sceneTransformSchema = objectSchema(
  {
    x: numberSchema(),
    y: numberSchema(),
    width: numberSchema(),
    height: numberSchema(),
    cropLeft: numberSchema(),
    cropTop: numberSchema(),
    cropRight: numberSchema(),
    cropBottom: numberSchema()
  },
  { allowUnknown: false }
)

const sceneSourceSchema = objectSchema(
  {
    id: boundedIdentifier,
    name: boundedStatusText,
    kind: enumSchema(['screen', 'window', 'camera', 'test-pattern']),
    transform: sceneTransformSchema,
    defaultTransform: sceneTransformSchema,
    visible: booleanSchema,
    locked: booleanSchema
  },
  { allowUnknown: true }
)

const sceneOutputSchema = objectSchema(
  {
    id: boundedIdentifier,
    kind: enumSchema(['preview', 'recording', 'stream']),
    width: numberSchema({ min: 0, max: 65_536 }),
    height: numberSchema({ min: 0, max: 65_536 }),
    fps: numberSchema({ min: 0, max: 1_000 })
  },
  { allowUnknown: true }
)

const sceneSchema = objectSchema(
  {
    id: boundedIdentifier,
    name: boundedStatusText,
    sources: arraySchema(sceneSourceSchema, { maxLength: 256 }),
    outputs: arraySchema(sceneOutputSchema, { maxLength: 32 })
  },
  { allowUnknown: true }
)

const streamScreenSchema = objectSchema(
  {
    id: boundedIdentifier,
    name: boundedStatusText,
    imagePath: pathSchema,
    sortOrder: numberSchema({ integer: true }),
    status: enumSchema(['ready', 'missing']),
    createdAt: stringSchema({ minLength: 1, maxLength: 128 }),
    updatedAt: stringSchema({ minLength: 1, maxLength: 128 })
  },
  { allowUnknown: true }
)

const previewSceneUpdateSchema = boundedSemanticValue(
  'a native preview scene update',
  objectSchema(
    {
      revision: nonNegativeSafeIntegerSchema,
      scene: nullableSchema(sceneSchema),
      layout: layoutSettingsSchema,
      activeScreen: optionalSchema(nullableSchema(streamScreenSchema))
    },
    { allowUnknown: false }
  )
)

const compositorSceneSourceSchema = objectSchema(
  {
    id: boundedIdentifier,
    name: boundedStatusText,
    kind: enumSchema([
      'screen',
      'window',
      'camera',
      'test-pattern',
      'screen-image',
      'background-image'
    ]),
    state: boundedStatusText,
    visible: booleanSchema,
    transform: sceneTransformSchema,
    fit: enumSchema(['contain', 'cover']),
    mirror: booleanSchema
  },
  { allowUnknown: true }
)

const compositorSourceSchema = objectSchema(
  {
    kind: enumSchema(['camera', 'screen', 'window']),
    state: boundedStatusText,
    sourceId: optionalSchema(boundedIdentifier),
    sequence: optionalSchema(nonNegativeSafeIntegerSchema),
    width: optionalSchema(numberSchema({ min: 0, max: 65_536 })),
    height: optionalSchema(numberSchema({ min: 0, max: 65_536 })),
    sourceFps: optionalSchema(numberSchema({ min: 0, max: 1_000 })),
    frameAgeMs: optionalSchema(nonNegativeSafeIntegerSchema),
    message: optionalSchema(boundedStatusText)
  },
  { allowUnknown: true }
)

const previewCompositorUpdateSchema = boundedSemanticValue(
  'a native preview compositor update',
  objectSchema(
    {
      state: enumSchema(['stopped', 'starting', 'live', 'failed']),
      targetFps: numberSchema({ min: 0, max: 1_000 }),
      width: numberSchema({ min: 0, max: 65_536 }),
      height: numberSchema({ min: 0, max: 65_536 }),
      runId: optionalSchema(boundedIdentifier),
      sceneRevision: optionalSchema(nonNegativeSafeIntegerSchema),
      frameSceneRevision: optionalSchema(nonNegativeSafeIntegerSchema),
      sceneId: optionalSchema(boundedIdentifier),
      sceneLayout: optionalSchema(layoutSettingsSchema),
      activeScreenId: optionalSchema(boundedIdentifier),
      sceneSources: arraySchema(compositorSceneSourceSchema, { maxLength: 256 }),
      sources: arraySchema(compositorSourceSchema, { maxLength: 32 }),
      framesRendered: nonNegativeSafeIntegerSchema,
      repeatedFrames: nonNegativeSafeIntegerSchema,
      droppedFrames: nonNegativeSafeIntegerSchema,
      metalTargetIosurfaceId: optionalSchema(nonNegativeSafeIntegerSchema),
      metalTargetWidth: optionalSchema(numberSchema({ min: 0, max: 65_536 })),
      metalTargetHeight: optionalSchema(numberSchema({ min: 0, max: 65_536 })),
      updatedAt: stringSchema({ minLength: 1, maxLength: 128 }),
      message: optionalSchema(boundedStatusText),
      suppressFramePolling: optionalSchema(booleanSchema)
    },
    { allowUnknown: true }
  )
)

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
      targetFps: numberSchema({ min: 0, max: 1_000 }),
      width: numberSchema({ min: 0, max: 65_536 }),
      height: numberSchema({ min: 0, max: 65_536 }),
      framesRendered: nonNegativeSafeIntegerSchema,
      droppedFrames: nonNegativeSafeIntegerSchema,
      framePollingSuppressed: booleanSchema,
      sourcePixelsPresent: booleanSchema,
      pendingHostCommandCount: nonNegativeSafeIntegerSchema,
      bounds: optionalSchema(previewBoundsSchema),
      updatedAt: stringSchema({ minLength: 1, maxLength: 128 })
    },
    { allowUnknown: true }
  )
)

const nativePreviewHostCommandSchema = runtimeSchema<unknown>(
  'a native preview host command',
  (value, path) => {
    const command = objectSchema(
      {
        kind: enumSchema(['create', 'update-bounds', 'destroy']),
        bounds: optionalSchema(previewBoundsSchema)
      },
      { allowUnknown: false }
    ).parse(value, path)
    const needsBounds = command.kind === 'create' || command.kind === 'update-bounds'
    if (needsBounds !== Boolean(command.bounds)) {
      throw new RuntimeSchemaError(
        `${path}.bounds`,
        needsBounds ? `preview bounds for ${command.kind}` : 'undefined for destroy'
      )
    }
    return command
  }
)

const nativePreviewHostCommandsArgs = runtimeSchema<unknown[]>(
  'native preview host commands and generation',
  (value, path) => {
    if (!Array.isArray(value) || value.length < 1 || value.length > 2) {
      throw new RuntimeSchemaError(path, 'host commands and an optional generation')
    }
    arraySchema(nativePreviewHostCommandSchema, { maxLength: 64 }).parse(value[0], `${path}[0]`)
    optionalSchema(nonNegativeSafeIntegerSchema).parse(value[1], `${path}[1]`)
    return value
  }
)

const optionalGenerationArgs = runtimeSchema<unknown[]>(
  'preview bounds and generation',
  (value, path) => {
    if (!Array.isArray(value) || value.length < 1 || value.length > 2) {
      throw new Error(`${path} must contain preview bounds and an optional generation.`)
    }
    previewBoundsSchema.parse(value[0], `${path}[0]`)
    optionalSchema(nonNegativeSafeIntegerSchema).parse(value[1], `${path}[1]`)
    return value
  }
)

const optionalGenerationOnlyArgs = tupleSchema([optionalSchema(nonNegativeSafeIntegerSchema)])

const noArgs = tupleSchema([])
const boundedFallbackInvokeContract = invokeContract(boundedIpcArgsSchema)
const specificRuntimeInvokeContracts = {
  'account:begin-sign-in': invokeContract(tupleSchema([accountAuthorizeUrl])),
  'account:sign-out': invokeContract(noArgs),
  'account:callback-ack': invokeContract(tupleSchema([boundedIdentifier])),
  'account:callbacks-list': invokeContract(noArgs),
  'oauth:callback-ack': invokeContract(tupleSchema([oauthCallbackIdentifierSchema]), booleanSchema),
  'oauth:callbacks-list': invokeContract(
    noArgs,
    arraySchema(oauthCallbackEnvelopeSchema, { maxLength: 32 })
  ),
  'oauth:open-url': invokeContract(tupleSchema([boundedUrl])),
  'notes-window:get-document': invokeContract(noArgs, notesDocumentSchema),
  'notes-window:save-document': invokeContract(
    tupleSchema([notesPatchSchema]),
    notesDocumentSchema
  ),
  'preview-surface:create': invokeContract(optionalGenerationArgs, previewSurfaceStatusSchema),
  'preview-surface:update-bounds': invokeContract(
    optionalGenerationArgs,
    previewSurfaceStatusSchema
  ),
  'preview-surface:apply-host-commands': invokeContract(
    nativePreviewHostCommandsArgs,
    previewSurfaceStatusSchema
  ),
  'preview-surface:drain-host-commands': invokeContract(
    optionalGenerationOnlyArgs,
    previewSurfaceStatusSchema
  ),
  'preview-surface:update-scene': invokeContract(
    tupleSchema([previewSceneUpdateSchema]),
    previewSurfaceStatusSchema
  ),
  'preview-surface:update-compositor': invokeContract(
    tupleSchema([previewCompositorUpdateSchema]),
    previewSurfaceStatusSchema
  ),
  'preview-surface:set-frame-polling-suppressed': invokeContract(
    tupleSchema([booleanSchema, optionalSchema(booleanSchema)]),
    previewSurfaceStatusSchema
  ),
  'preview-surface:destroy': invokeContract(optionalGenerationOnlyArgs, previewSurfaceStatusSchema),
  'preview-surface:status': invokeContract(noArgs, previewSurfaceStatusSchema),
  'preview-window:set-aspect-ratio': invokeContract(
    tupleSchema([numberSchema({ min: 1, max: 65_536 }), numberSchema({ min: 1, max: 65_536 })])
  ),
  'resource:reveal-selection': invokeContract(tupleSchema([boundedIdentifier])),
  'resource:authorize-output-directory': invokeContract(tupleSchema([boundedIdentifier])),
  'resource:reveal-session': invokeContract(tupleSchema([boundedIdentifier])),
  'resource:reveal-background': invokeContract(tupleSchema([boundedIdentifier])),
  'resource:open-session': invokeContract(tupleSchema([boundedIdentifier])),
  'resource:trash-session-deletion': invokeContract(tupleSchema([boundedIdentifier])),
  'system:check-directory': invokeContract(tupleSchema([boundedIdentifier])),
  'backgrounds:asset-exists': invokeContract(tupleSchema([boundedIdentifier])),
  'updates:install': invokeContract(noArgs, undefinedSchema)
} satisfies Partial<Record<ElectronInvokeChannel, IpcRuntimeContract>>

/** Channels deliberately using structural bounds instead of a semantic schema.
 * This list is explicit: adding an IPC channel must classify it here or in the
 * specific-contract map above before TypeScript and the coverage test pass. */
export const boundedPassthroughElectronInvokeChannels = [
  'backend:get-connection',
  'backend:get-logs',
  'app:get-runtime-info',
  'app:set-native-theme',
  'screens:pick-image',
  'backgrounds:import-image',
  'backgrounds:bundled-assets',
  'avatars:cache',
  'oauth:callback-redirect-uri',
  'preview-surface:mode',
  'preview-surface:pump-mode',
  'preview-window:open',
  'preview-window:close',
  'preview-window:toggle',
  'preview-window:get-state',
  'preview-window:permission-required',
  'preview-window:set-always-on-top',
  'preview-window:set-mode',
  'preview-window:report-dock-slot',
  'preview-window:set-dock-overlay',
  'notes-window:open',
  'notes-window:close',
  'notes-window:get-state',
  'notes-window:set-always-on-top',
  'comments-window:open',
  'comments-window:close',
  'comments-window:toggle',
  'comments-window:get-state',
  'comments-window:set-always-on-top',
  'comments-window:push-snapshot',
  'comments-window:push-delta',
  'comments-window:get-snapshot',
  'comments-window:set-view-mode',
  'comments-window:highlight',
  'comments-window:highlight-result-push',
  'comments-window:highlight-state-push',
  'comments-window:highlight-state-get',
  'comments-window:send',
  'comments-window:send-result-push',
  'comments-window:clear',
  'comments-window:clear-result-push',
  'comments-window:viewers-push',
  'comments-window:viewers-get',
  'captions-window:open',
  'captions-window:close',
  'captions-window:toggle',
  'captions-window:get-state',
  'captions-window:set-always-on-top',
  'captions-window:push-snapshot',
  'captions-window:get-snapshot',
  'captions-window:push-lines',
  'captions-window:get-lines',
  'system:open-permissions',
  'system:media-access-status',
  'system:request-media-access',
  'system:reveal-permission-target',
  'system:pick-file',
  'system:pick-directory',
  'obs:discover',
  'obs:read',
  'obs:read-stream-key',
  'glass:wallpaper:get',
  'updates:check',
  'updates:download',
  'updates:get-status'
] as const satisfies readonly ElectronInvokeChannel[]

type SpecificRuntimeInvokeChannel = keyof typeof specificRuntimeInvokeContracts
type BoundedRuntimeInvokeChannel = (typeof boundedPassthroughElectronInvokeChannels)[number]
type MissingRuntimeInvokeChannel = Exclude<
  ElectronInvokeChannel,
  SpecificRuntimeInvokeChannel | BoundedRuntimeInvokeChannel
>
type DuplicateRuntimeInvokeChannel = Extract<
  SpecificRuntimeInvokeChannel,
  BoundedRuntimeInvokeChannel
>
export const electronInvokeRuntimeClassificationComplete: Record<
  MissingRuntimeInvokeChannel | DuplicateRuntimeInvokeChannel,
  never
> = {}

const runtimeInvokeContracts = Object.fromEntries(
  boundedPassthroughElectronInvokeChannels.map((channel) => [
    channel,
    boundedFallbackInvokeContract
  ])
) as Record<ElectronInvokeChannel, IpcRuntimeContract>
Object.assign(runtimeInvokeContracts, specificRuntimeInvokeContracts)

const accountCallbackSchema = runtimeSchema<unknown>(
  'a durable account callback',
  (value, path) => {
    const callback = objectSchema(
      {
        id: boundedIdentifier,
        url: stringSchema({ minLength: 1, maxLength: 16_384 }),
        state: stringSchema({ minLength: 32, maxLength: 512 }),
        intentGeneration: positiveSafeIntegerSchema,
        receivedAtMs: numberSchema({ integer: true, min: 0 }),
        expiresAtMs: numberSchema({ integer: true, min: 0 })
      },
      { allowUnknown: false }
    ).parse(value, path)
    if (callback.expiresAtMs < callback.receivedAtMs) {
      throw new RuntimeSchemaError(`${path}.expiresAtMs`, 'a callback deadline after receipt')
    }
    return callback
  }
)

const backendConnectionSchema = objectSchema(
  {
    host: enumSchema(['127.0.0.1', 'localhost', '::1']),
    port: numberSchema({ integer: true, min: 1, max: 65_535 }),
    token: stringSchema({ minLength: 16, maxLength: 4096 }),
    pid: optionalSchema(numberSchema({ integer: true, min: 1 })),
    parentPid: optionalSchema(numberSchema({ integer: true, min: 1 }))
  },
  { allowUnknown: false }
)

const specificRuntimeEventSchemas = {
  'account:callback': accountCallbackSchema,
  'backend:connection': backendConnectionSchema,
  'notes-window:document': notesDocumentSchema,
  'notes-window:flush-request': undefinedSchema,
  'oauth:callback-url': oauthCallbackEnvelopeSchema,
  'shortcut:navigate': enumSchema(['1', '2', '3', '4', '5', '6', '7', '8', '9', ',']),
  'preview-surface:pump-mode': booleanSchema,
  'preview-surface:resync-scene': undefinedSchema,
  'captions-window:lines': runtimeSchema<unknown[]>('bounded caption lines', (value, path) => {
    if (!Array.isArray(value) || value.length > 500) {
      throw new RuntimeSchemaError(path, 'an array with at most 500 items')
    }
    boundedIpcValueSchema.parse(value, path)
    return value
  })
} satisfies Partial<Record<ElectronEventChannel, RuntimeSchema<unknown>>>

/** Explicitly reviewed event payloads that use structural bounds. */
export const boundedPassthroughElectronEventChannels = [
  'backend:lifecycle',
  'backend:log',
  'preview-window:state',
  'notes-window:state',
  'comments-window:state',
  'comments-window:snapshot',
  'comments-window:delta',
  'comments-window:highlight-request',
  'comments-window:highlight-state',
  'comments-window:send-request',
  'comments-window:clear-request',
  'comments-window:viewers',
  'captions-window:state',
  'captions-window:snapshot',
  'glass:wallpaper',
  'glass:geometry',
  'app:update-status'
] as const satisfies readonly ElectronEventChannel[]

type SpecificRuntimeEventChannel = keyof typeof specificRuntimeEventSchemas
type BoundedRuntimeEventChannel = (typeof boundedPassthroughElectronEventChannels)[number]
type MissingRuntimeEventChannel = Exclude<
  ElectronEventChannel,
  SpecificRuntimeEventChannel | BoundedRuntimeEventChannel
>
type DuplicateRuntimeEventChannel = Extract<SpecificRuntimeEventChannel, BoundedRuntimeEventChannel>
export const electronEventRuntimeClassificationComplete: Record<
  MissingRuntimeEventChannel | DuplicateRuntimeEventChannel,
  never
> = {}

const runtimeEventSchemas = Object.fromEntries(
  boundedPassthroughElectronEventChannels.map((channel) => [channel, boundedIpcValueSchema])
) as Record<ElectronEventChannel, RuntimeSchema<unknown>>
Object.assign(runtimeEventSchemas, specificRuntimeEventSchemas)

export function isElectronInvokeChannel(channel: string): channel is ElectronInvokeChannel {
  return Object.prototype.hasOwnProperty.call(electronInvokeApiMethods, channel)
}

export function assertElectronInvokeChannel(
  channel: string
): asserts channel is ElectronInvokeChannel {
  if (!isElectronInvokeChannel(channel)) {
    throw new Error(`Electron IPC channel is not declared: ${channel}`)
  }
}

export function validateElectronInvokeArgs<TChannel extends ElectronInvokeChannel>(
  channel: TChannel,
  args: unknown[]
): ElectronInvokeArgs<TChannel>
export function validateElectronInvokeArgs(channel: string, args: unknown[]): unknown[]
export function validateElectronInvokeArgs(channel: string, args: unknown[]): unknown[] {
  assertElectronInvokeChannel(channel)
  return runtimeInvokeContracts[channel].args.parse(args, `ipc.${channel}.args`)
}

export function validateElectronInvokeResult<TChannel extends ElectronInvokeChannel>(
  channel: TChannel,
  result: unknown
): ElectronInvokeResult<TChannel>
export function validateElectronInvokeResult(channel: string, result: unknown): unknown
export function validateElectronInvokeResult(channel: string, result: unknown): unknown {
  assertElectronInvokeChannel(channel)
  return runtimeInvokeContracts[channel].result.parse(result, `ipc.${channel}.result`)
}

export function validateElectronEventPayload<TChannel extends ElectronEventChannel>(
  channel: TChannel,
  payload: unknown
): ElectronIpcEventMap[TChannel] {
  return runtimeEventSchemas[channel].parse(
    payload,
    `ipc.${channel}.payload`
  ) as ElectronIpcEventMap[TChannel]
}

export const runtimeValidatedElectronInvokeChannels = Object.freeze(
  Object.keys(runtimeInvokeContracts) as ElectronInvokeChannel[]
)
export const runtimeValidatedElectronEventChannels = Object.freeze(
  Object.keys(runtimeEventSchemas) as ElectronEventChannel[]
)

// Compile-time assertion: every mapped API entry really is an async method.
type InvalidInvokeMappings = {
  [TChannel in ElectronInvokeChannel]: NonNullable<
    VideorcApi[(typeof electronInvokeApiMethods)[TChannel]]
  > extends AsyncApiMethod
    ? never
    : TChannel
}[ElectronInvokeChannel]
export type ElectronInvokeMappingInvariant = InvalidInvokeMappings extends never ? true : never
