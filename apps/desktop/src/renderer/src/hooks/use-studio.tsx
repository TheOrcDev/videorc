import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactElement,
  type ReactNode,
  type SetStateAction
} from 'react'
import { toast } from 'sonner'

import { BackendClient } from '@/backendClient'
import {
  bridgeStreamingToLegacy,
  areEnabledStreamTargetsStartReady,
  defaultSettings,
  loadCaptureConfig,
  loadJson,
  patchPreparedStreamTarget,
  patchStreamTargetForEdit,
  persistableCaptureConfig,
  preparedYouTubeActivationTargets,
  preparedYouTubeCompletionTargets,
  reconcileSourceSelection,
  rtmpDefaults,
  sourceSelectionChangeMessages,
  STORAGE_KEYS,
  videoPresets,
  type CaptureConfig,
  type SettingsState,
  type SetupStep,
  type WsStatus
} from '@/lib/capture'
import type {
  AiWorkflowResult,
  AudioMeterResult,
  BackendConnection,
  BackendHealth,
  BackendLogEvent,
  DiagnosticStats,
  Device,
  DeviceList,
  ExportPublishPackResult,
  GoLivePreflight,
  HealthEvent,
  LayoutSettings,
  PreviewLiveStatus,
  PlatformAccount,
  PlatformAccountValidation,
  PreparedTwitchBroadcast,
  PreparedYouTubeBroadcast,
  OAuthCompleteParams,
  OAuthStartResult,
  OAuthProviderCredentialStatus,
  RecordingStatus,
  RuntimeInfo,
  RtmpPreset,
  Scene,
  SessionLogEntry,
  SessionSummary,
  StartSessionParams,
  StreamMetadataDraft,
  StreamMetadataValidation,
  StreamScreen,
  StreamHealth,
  StoreManualStreamKeyResult,
  StreamingSettings,
  StreamTargetRuntime,
  StreamTargetSettings,
  StreamTargetsSnapshot,
  SystemPermissionPane,
  TwitchCategory,
  VideoPreset,
  VideoSettings,
  XNativeLiveCapability,
  YouTubeBroadcastTransitionResult,
  YouTubeChannel,
  YouTubeStreamStatusResult
} from '@/lib/backend'
import {
  findDevice,
  durationLabel,
  isActiveRecordingState,
  mergeStreamHealth,
  setupChecklist
} from '@/lib/format'

export type StudioContextValue = {
  // connection + backend state
  connection: BackendConnection | null
  wsStatus: WsStatus
  health: BackendHealth | null
  deviceList: DeviceList
  recording: RecordingStatus
  logs: BackendLogEvent[]
  healthEvents: HealthEvent[]
  streamHealth: StreamHealth | null
  streamTargets: StreamTargetRuntime[]
  diagnosticStats: DiagnosticStats
  sessions: SessionSummary[]
  screens: StreamScreen[]
  activeScreen: StreamScreen | null
  platformAccounts: PlatformAccount[]
  platformAccountValidations: PlatformAccountValidation[]
  oauthProviderCredentials: OAuthProviderCredentialStatus[]
  youtubeChannels: YouTubeChannel[]
  youtubeChannelsLoading: boolean
  twitchCategories: TwitchCategory[]
  twitchCategorySearchPending: boolean
  xNativeCapability: XNativeLiveCapability | null
  xNativeCapabilityLoading: boolean
  streamMetadataDraft: StreamMetadataDraft | null
  streamMetadataValidation: StreamMetadataValidation | null
  goLivePreflight: GoLivePreflight | null
  goLiveConfirmationOpen: boolean
  goLiveConfirmationPending: boolean
  goLivePartialSetup: GoLivePartialSetup | null
  // preview + audio
  previewUrl: string | null
  previewLoading: boolean
  previewLiveStatus: PreviewLiveStatus
  scene: Scene | null
  sceneEditMode: boolean
  selectedSceneSourceId: string | null
  setSceneEditMode: Dispatch<SetStateAction<boolean>>
  setSelectedSceneSourceId: Dispatch<SetStateAction<string | null>>
  audioMeter: AudioMeterResult | null
  audioMeterLoading: boolean
  // ai + jobs
  aiConsent: boolean
  setAiConsent: Dispatch<SetStateAction<boolean>>
  aiRunningSessionId: string | null
  exportRunningSessionId: string | null
  startRequestPending: boolean
  stopRequestPending: boolean
  screenImportPending: boolean
  streamMetadataSavePending: boolean
  // settings + capture config
  settings: SettingsState
  setSettings: Dispatch<SetStateAction<SettingsState>>
  captureConfig: CaptureConfig
  setCaptureConfig: Dispatch<SetStateAction<CaptureConfig>>
  patchLayout: (patch: Partial<LayoutSettings>) => void
  applyCameraPreset: (patch: Partial<LayoutSettings>) => void
  patchVideo: (patch: Partial<VideoSettings>) => void
  applyVideoPreset: (preset: VideoPreset) => void
  applyRtmpPreset: (preset: RtmpPreset) => void
  patchStreamingTarget: (targetId: string, patch: Partial<StreamTargetSettings>) => void
  saveManualStreamKey: (targetId: string, streamKey: string) => Promise<void>
  patchStreamMetadataDraft: (patch: Partial<StreamMetadataDraft>) => void
  patchStreamTargetMetadataDraft: (
    platform: StreamMetadataDraft['targetOverrides'][number]['platform'],
    patch: Partial<StreamMetadataDraft['targetOverrides'][number]>
  ) => void
  // notices
  lastError: string | null
  runtimeInfo: RuntimeInfo | null
  // actions
  refreshBackend: () => Promise<void>
  refreshPlatformAccounts: () => Promise<void>
  validatePlatformAccounts: () => Promise<PlatformAccountValidation[]>
  connectPlatformAccount: (platform: PlatformAccount['platform']) => Promise<void>
  disconnectPlatformAccount: (platform: PlatformAccount['platform']) => Promise<void>
  refreshYouTubeChannels: (accountId?: string) => Promise<void>
  selectYouTubeChannel: (channelId: string, accountId?: string) => Promise<void>
  searchTwitchCategories: (query: string) => Promise<void>
  refreshXNativeCapability: (accountId?: string) => Promise<void>
  refreshStreamMetadata: () => Promise<void>
  saveStreamMetadataDraft: () => Promise<void>
  cancelGoLiveConfirmation: () => void
  confirmGoLive: () => Promise<void>
  continueGoLiveWithReadyDestinations: () => Promise<void>
  refreshScreens: () => Promise<void>
  importScreenImage: () => Promise<void>
  renameScreen: (screenId: string, name: string) => Promise<void>
  deleteScreen: (screenId: string) => Promise<void>
  moveScreen: (screenId: string, direction: -1 | 1) => Promise<void>
  activateScreen: (screenId: string) => Promise<void>
  clearActiveScreen: () => Promise<void>
  refreshPreview: () => Promise<void>
  reloadSceneFromCaptureConfig: () => Promise<void>
  resetSceneSource: (sourceId?: string) => Promise<void>
  nudgeSceneSource: (sourceId: string, directionX: number, directionY: number, large?: boolean) => Promise<void>
  commitCameraTransform: (sourceId: string, x: number, y: number) => Promise<void>
  setSceneSourceVisible: (sourceId: string, visible: boolean) => Promise<void>
  moveSceneSource: (sourceId: string, direction: -1 | 1) => Promise<void>
  openSystemPermission: (pane: SystemPermissionPane) => Promise<void>
  openPreviewPermissions: () => Promise<void>
  revealPermissionTarget: () => Promise<void>
  sampleAudioMeter: () => Promise<void>
  startSession: () => Promise<void>
  stopSession: () => Promise<void>
  remuxSession: (sessionId: string) => Promise<void>
  runAiWorkflow: (sessionId: string) => Promise<void>
  exportPublishPack: (sessionId: string) => Promise<void>
  // derived
  outputEnabled: boolean
  streamReady: boolean
  isSessionActive: boolean
  startBlockedReason: string | null
  canStart: boolean
  canStop: boolean
  visibleStartBlockedReason: string | null
  selectedCaptureDevice?: Device
  selectedCamera?: Device
  selectedMicrophone?: Device
  setupSteps: SetupStep[]
  elapsed: string
  meterLevel: number
  canSampleAudio: boolean
}

export type GoLiveSetupFailure = {
  targetId: string
  platform: StreamTargetSettings['platform']
  label: string
  message: string
}

export type GoLivePartialSetup = {
  streaming: StreamingSettings
  failures: GoLiveSetupFailure[]
  readyLabels: string[]
}

const StudioContext = createContext<StudioContextValue | null>(null)

const idleDiagnosticStats = (): DiagnosticStats => ({
  skippedFrames: 0,
  droppedFrames: 0,
  previewDroppedFrames: 0,
  micDroppedFrames: 0,
  deviceDisconnected: false,
  bottleneck: 'none',
  updatedAt: new Date().toISOString()
})

export function useStudio(): StudioContextValue {
  const value = useContext(StudioContext)
  if (!value) {
    throw new Error('useStudio must be used within a StudioProvider')
  }
  return value
}

export function StudioProvider({ children }: { children: ReactNode }): ReactElement {
  const [connection, setConnection] = useState<BackendConnection | null>(null)
  const [client, setClient] = useState<BackendClient | null>(null)
  const [wsStatus, setWsStatus] = useState<WsStatus>('waiting')
  const [health, setHealth] = useState<BackendHealth | null>(null)
  const [deviceList, setDeviceList] = useState<DeviceList>({ devices: [], warnings: [] })
  const [recording, setRecording] = useState<RecordingStatus>({ state: 'idle', message: 'Ready.' })
  const [logs, setLogs] = useState<BackendLogEvent[]>([])
  const [healthEvents, setHealthEvents] = useState<HealthEvent[]>([])
  const [streamHealth, setStreamHealth] = useState<StreamHealth | null>(null)
  const [streamTargets, setStreamTargets] = useState<StreamTargetRuntime[]>([])
  const [diagnosticStats, setDiagnosticStats] = useState<DiagnosticStats>(idleDiagnosticStats)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [screens, setScreens] = useState<StreamScreen[]>([])
  const [activeScreen, setActiveScreen] = useState<StreamScreen | null>(null)
  const [platformAccounts, setPlatformAccounts] = useState<PlatformAccount[]>([])
  const [platformAccountValidations, setPlatformAccountValidations] = useState<PlatformAccountValidation[]>([])
  const [oauthProviderCredentials, setOauthProviderCredentials] = useState<OAuthProviderCredentialStatus[]>([])
  const [youtubeChannels, setYoutubeChannels] = useState<YouTubeChannel[]>([])
  const [youtubeChannelsLoading, setYoutubeChannelsLoading] = useState(false)
  const [twitchCategories, setTwitchCategories] = useState<TwitchCategory[]>([])
  const [twitchCategorySearchPending, setTwitchCategorySearchPending] = useState(false)
  const [xNativeCapability, setXNativeCapability] = useState<XNativeLiveCapability | null>(null)
  const [xNativeCapabilityLoading, setXNativeCapabilityLoading] = useState(false)
  const [streamMetadataDraft, setStreamMetadataDraft] = useState<StreamMetadataDraft | null>(null)
  const [streamMetadataValidation, setStreamMetadataValidation] = useState<StreamMetadataValidation | null>(null)
  const [goLivePreflight, setGoLivePreflight] = useState<GoLivePreflight | null>(null)
  const [goLiveConfirmationOpen, setGoLiveConfirmationOpen] = useState(false)
  const [goLiveConfirmationPending, setGoLiveConfirmationPending] = useState(false)
  const [goLivePartialSetup, setGoLivePartialSetup] = useState<GoLivePartialSetup | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewLiveStatus, setPreviewLiveStatus] = useState<PreviewLiveStatus>({
    state: 'unavailable',
    source: 'unavailable',
    message: 'Live preview is not running.'
  })
  const [scene, setScene] = useState<Scene | null>(null)
  const [sceneEditMode, setSceneEditMode] = useState(false)
  const [selectedSceneSourceId, setSelectedSceneSourceId] = useState<string | null>(null)
  const [audioMeter, setAudioMeter] = useState<AudioMeterResult | null>(null)
  const [audioMeterLoading, setAudioMeterLoading] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [aiConsent, setAiConsent] = useState(false)
  const [aiRunningSessionId, setAiRunningSessionId] = useState<string | null>(null)
  const [exportRunningSessionId, setExportRunningSessionId] = useState<string | null>(null)
  const [startRequestPending, setStartRequestPending] = useState(false)
  const [stopRequestPending, setStopRequestPending] = useState(false)
  const [screenImportPending, setScreenImportPending] = useState(false)
  const [streamMetadataSavePending, setStreamMetadataSavePending] = useState(false)
  const [settings, setSettings] = useState<SettingsState>(() => loadJson(STORAGE_KEYS.settings, defaultSettings))
  const [captureConfig, setCaptureConfig] = useState<CaptureConfig>(loadCaptureConfig)
  const [lastError, setLastError] = useState<string | null>(null)
  const [runtimeInfo, setRuntimeInfo] = useState<RuntimeInfo | null>(null)
  const latestPreviewConfig = useRef({
    ffmpegPath: settings.ffmpegPath,
    layout: captureConfig.layout,
    sources: captureConfig.sources,
    video: captureConfig.video
  })
  const previewRequestPending = useRef(false)
  const previewRefreshQueued = useRef(false)
  const previewRequestRun = useRef(0)
  const sourceReconciliationMessages = useRef<string[]>([])
  const toastedFailedTargets = useRef<Set<string>>(new Set())
  const platformLifecycleRun = useRef(0)
  const [previewRefreshNonce, setPreviewRefreshNonce] = useState(0)

  // Surface a per-target stream drop from any tab (the Streaming tab has the full
  // banner + badges). Each failed destination toasts once per session; the set is
  // cleared whenever streaming returns to an empty snapshot (session start/idle).
  useEffect(() => {
    if (streamTargets.length === 0) {
      toastedFailedTargets.current = new Set()
      return
    }
    for (const target of streamTargets) {
      if (target.state === 'failed' && !toastedFailedTargets.current.has(target.targetId)) {
        toastedFailedTargets.current.add(target.targetId)
        toast.error(`Streaming to ${target.label} stopped`, {
          description: target.message ?? 'The other destinations keep streaming.'
        })
      }
    }
  }, [streamTargets])

  const sessionParams = useMemo<StartSessionParams>(
    () => ({
      sources: captureConfig.sources,
      layout: captureConfig.layout,
      output: {
        recordEnabled: captureConfig.recordEnabled,
        streamEnabled: captureConfig.streamEnabled,
        outputDirectory: settings.outputDirectory.trim() || undefined,
        ffmpegPath: settings.ffmpegPath.trim() || undefined,
        video: captureConfig.video,
        rtmp: {
          preset: captureConfig.rtmpPreset,
          serverUrl: captureConfig.rtmpServerUrl.trim(),
          streamKey: captureConfig.streamKey.trim()
        }
      },
      audio: captureConfig.audio,
      streaming: captureConfig.streaming
    }),
    [captureConfig, settings]
  )

  const previewRestartKey = useMemo(
    () =>
      JSON.stringify({
        ffmpegPath: settings.ffmpegPath.trim(),
        sources: captureConfig.sources,
        video: captureConfig.video
      }),
    [captureConfig.sources, captureConfig.video, settings.ffmpegPath]
  )

  useEffect(() => {
    latestPreviewConfig.current = {
      ffmpegPath: settings.ffmpegPath,
      layout: captureConfig.layout,
      sources: captureConfig.sources,
      video: captureConfig.video
    }
  }, [captureConfig.layout, captureConfig.sources, captureConfig.video, settings.ffmpegPath])

  const reportError = useCallback((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    setLastError(message)
    toast.error(message)
  }, [])

  const appendLog = useCallback((log: BackendLogEvent) => {
    setLogs((current) => [...current.slice(-79), log])
  }, [])

  const applyPreviewLiveStatus = useCallback((status: PreviewLiveStatus) => {
    setPreviewLiveStatus(status)
    setPreviewLoading(status.state === 'connecting' || status.state === 'reconnecting')
    setPreviewUrl(status.url ? `${status.url}${status.url.includes('?') ? '&' : '?'}cache=${Date.now()}` : null)
  }, [])

  const applyScene = useCallback((nextScene: Scene) => {
    setScene(nextScene)
    setSelectedSceneSourceId((current) =>
      current && nextScene.sources.some((source) => source.id === current)
        ? current
        : (nextScene.sources.at(-1)?.id ?? null)
    )
  }, [])

  const refreshSessions = useCallback(async (activeClient: BackendClient | null) => {
    if (!activeClient) {
      return
    }

    const nextSessions = await activeClient.request<SessionSummary[]>('sessions.list')
    setSessions(nextSessions)
  }, [])

  const refreshScreensForClient = useCallback(async (activeClient: BackendClient | null) => {
    if (!activeClient) {
      return
    }

    const [nextScreens, nextActiveScreen] = await Promise.all([
      activeClient.request<StreamScreen[]>('screens.list'),
      activeClient.request<StreamScreen | null>('screens.active')
    ])
    setScreens(nextScreens)
    setActiveScreen(nextActiveScreen)
  }, [])

  const refreshScreens = useCallback(async () => {
    try {
      await refreshScreensForClient(client)
    } catch (error) {
      reportError(error)
    }
  }, [client, refreshScreensForClient, reportError])

  const refreshPlatformAccountsForClient = useCallback(async (activeClient: BackendClient | null) => {
    if (!activeClient) {
      setPlatformAccounts([])
      setOauthProviderCredentials([])
      return
    }

    const [accounts, credentials] = await Promise.all([
      activeClient.request<PlatformAccount[]>('platformAccounts.list'),
      activeClient.request<OAuthProviderCredentialStatus[]>('platformAccounts.oauth.providerCredentials')
    ])
    setPlatformAccounts(accounts)
    setOauthProviderCredentials(credentials)
  }, [])

  const refreshPlatformAccounts = useCallback(async () => {
    try {
      await refreshPlatformAccountsForClient(client)
    } catch (error) {
      reportError(error)
    }
  }, [client, refreshPlatformAccountsForClient, reportError])

  const validatePlatformAccountsForClient = useCallback(async (activeClient: BackendClient | null) => {
    if (!activeClient) {
      setPlatformAccountValidations([])
      return []
    }

    const validations = await activeClient.request<PlatformAccountValidation[]>('platformAccounts.validate')
    setPlatformAccountValidations(validations)
    return validations
  }, [])

  const validatePlatformAccounts = useCallback(async () => {
    try {
      return await validatePlatformAccountsForClient(client)
    } catch (error) {
      reportError(error)
      return []
    }
  }, [client, reportError, validatePlatformAccountsForClient])

  const refreshYouTubeChannels = useCallback(
    async (accountId?: string) => {
      if (!client) {
        setYoutubeChannels([])
        return
      }

      try {
        setLastError(null)
        setYoutubeChannelsLoading(true)
        const result = await client.request<{ channels: YouTubeChannel[] }>('platformAccounts.youtube.channels', {
          accountId
        })
        setYoutubeChannels(result.channels)
      } catch (error) {
        setYoutubeChannels([])
        reportError(error)
      } finally {
        setYoutubeChannelsLoading(false)
      }
    },
    [client, reportError]
  )

  const selectYouTubeChannel = useCallback(
    async (channelId: string, accountId?: string) => {
      if (!client || wsStatus !== 'connected') {
        toast.error('Backend socket is not connected.')
        return
      }

      try {
        setLastError(null)
        const selected = await client.request<PlatformAccount>('platformAccounts.youtube.selectChannel', {
          accountId,
          channelId
        })
        await Promise.all([refreshPlatformAccountsForClient(client), validatePlatformAccountsForClient(client)])
        setCaptureConfig((current) => {
          const targets = current.streaming.targets.map((target) => {
            if (target.platform !== 'youtube') {
              return target
            }
            const sameAccount = target.accountId === selected.accountId
            return {
              ...target,
              accountId: selected.accountId,
              accountLabel: selected.accountLabel,
              streamKeySecretRef: sameAccount ? target.streamKeySecretRef : undefined,
              streamKeyPresent: sameAccount ? target.streamKeyPresent : false,
              platformBroadcastId: sameAccount ? target.platformBroadcastId : undefined,
              platformStreamId: sameAccount ? target.platformStreamId : undefined,
              status: sameAccount ? target.status : undefined
            }
          })
          return bridgeStreamingToLegacy({ ...current, streaming: { ...current.streaming, targets } })
        })
        await refreshYouTubeChannels(selected.accountId)
        toast.success(`YouTube channel set to ${selected.accountLabel}.`)
      } catch (error) {
        reportError(error)
      }
    },
    [
      client,
      refreshPlatformAccountsForClient,
      refreshYouTubeChannels,
      reportError,
      validatePlatformAccountsForClient,
      wsStatus
    ]
  )

  useEffect(() => {
    const account = platformAccounts.find((item) => item.platform === 'youtube')
    if (!account) {
      setYoutubeChannels([])
      return
    }
    void refreshYouTubeChannels(account.accountId)
  }, [platformAccounts, refreshYouTubeChannels])

  const searchTwitchCategories = useCallback(
    async (query: string) => {
      const trimmed = query.trim()
      if (!client || trimmed.length < 2) {
        setTwitchCategories([])
        return
      }

      try {
        setLastError(null)
        setTwitchCategorySearchPending(true)
        const account = platformAccounts.find((item) => item.platform === 'twitch')
        const result = await client.request<{ categories: TwitchCategory[] }>('streamTargets.twitch.searchCategories', {
          accountId: account?.accountId,
          query: trimmed,
          first: 10
        })
        setTwitchCategories(result.categories)
      } catch (error) {
        setTwitchCategories([])
        reportError(error)
      } finally {
        setTwitchCategorySearchPending(false)
      }
    },
    [client, platformAccounts, reportError]
  )

  useEffect(() => {
    if (!platformAccounts.some((item) => item.platform === 'twitch')) {
      setTwitchCategories([])
    }
  }, [platformAccounts])

  const refreshXNativeCapability = useCallback(
    async (accountId?: string) => {
      if (!client) {
        setXNativeCapability(null)
        return
      }

      try {
        setLastError(null)
        setXNativeCapabilityLoading(true)
        const capability = await client.request<XNativeLiveCapability>('streamTargets.x.capability', { accountId })
        setXNativeCapability(capability)
      } catch (error) {
        setXNativeCapability(null)
        reportError(error)
      } finally {
        setXNativeCapabilityLoading(false)
      }
    },
    [client, reportError]
  )

  useEffect(() => {
    const account = platformAccounts.find((item) => item.platform === 'x')
    if (!account) {
      setXNativeCapability(null)
      return
    }
    void refreshXNativeCapability(account.accountId)
  }, [platformAccounts, refreshXNativeCapability])

  const refreshStreamMetadataForClient = useCallback(async (activeClient: BackendClient | null) => {
    if (!activeClient) {
      setStreamMetadataDraft(null)
      setStreamMetadataValidation(null)
      return
    }

    const draft = await activeClient.request<StreamMetadataDraft>('streamTargets.metadata.get')
    const validation = await activeClient.request<StreamMetadataValidation>('streamTargets.metadata.validate', draft)
    setStreamMetadataDraft(draft)
    setStreamMetadataValidation(validation)
  }, [])

  const refreshStreamMetadata = useCallback(async () => {
    try {
      await refreshStreamMetadataForClient(client)
    } catch (error) {
      reportError(error)
    }
  }, [client, refreshStreamMetadataForClient, reportError])

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(settings))
  }, [settings])

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.captureConfig, JSON.stringify(persistableCaptureConfig(captureConfig)))
  }, [captureConfig])

  useEffect(() => {
    if (!['recording', 'streaming', 'starting', 'stopping'].includes(recording.state)) {
      return
    }

    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [recording.state])

  useEffect(() => {
    setAudioMeter(null)
  }, [captureConfig.sources.microphoneId])

  useEffect(() => {
    let disposed = false

    if (typeof window === 'undefined' || !window.videorc) {
      // The preload bridge is unavailable (e.g. rendered outside Electron).
      return
    }

    window.videorc.getBackendLogs().then((backendLogs) => {
      if (!disposed) {
        setLogs(backendLogs.slice(-80))
      }
    })
    window.videorc.getRuntimeInfo?.().then((nextRuntimeInfo) => {
      if (!disposed) {
        setRuntimeInfo(nextRuntimeInfo)
      }
    })
    window.videorc.getBackendConnection().then((nextConnection) => {
      if (!disposed && nextConnection) {
        setConnection(nextConnection)
      }
    })

    const offConnection = window.videorc.onBackendConnection(setConnection)
    const offLog = window.videorc.onBackendLog(appendLog)

    return () => {
      disposed = true
      offConnection()
      offLog()
    }
  }, [appendLog])

  useEffect(() => {
    setCaptureConfig((current) => {
      const nextSources = reconcileSourceSelection(current.sources, deviceList.devices)

      if (JSON.stringify(nextSources) === JSON.stringify(current.sources)) {
        return current
      }

      sourceReconciliationMessages.current.push(...sourceSelectionChangeMessages(current.sources, nextSources))
      return { ...current, sources: nextSources }
    })
  }, [deviceList])

  useEffect(() => {
    const messages = sourceReconciliationMessages.current.splice(0)
    for (const message of new Set(messages)) {
      toast.warning(message)
    }
  }, [captureConfig.sources])

  useEffect(() => {
    if (!connection) {
      return
    }

    const nextClient = new BackendClient(connection)
    setClient(nextClient)
    setWsStatus('connecting')
    setLastError(null)

    const unsubscribers = [
      nextClient.on('backend.ready', () => setWsStatus('connected')),
      nextClient.on('devices.changed', (payload) => setDeviceList(payload as DeviceList)),
      nextClient.on('recording.status', (payload) => {
        const status = payload as RecordingStatus
        setRecording(status)
        if (['idle', 'failed'].includes(status.state)) {
          setStreamTargets([])
          void refreshSessions(nextClient)
        }
      }),
      nextClient.on('health.event', (payload) => {
        const event = payload as HealthEvent
        setHealthEvents((current) => [event, ...current].slice(0, 40))
        setSessions((current) =>
          current.map((session) =>
            session.id === event.sessionId
              ? { ...session, healthEvents: [...session.healthEvents, event] }
              : session
          )
        )
      }),
      nextClient.on('session.log', (payload) => {
        const entry = payload as SessionLogEntry
        setSessions((current) =>
          current.map((session) =>
            session.id === entry.sessionId
              ? { ...session, sessionLogs: [...session.sessionLogs, entry] }
              : session
          )
        )
      }),
      nextClient.on('stream.health', (payload) => {
        setStreamHealth((current) => mergeStreamHealth(current, payload as StreamHealth))
      }),
      nextClient.on('stream.targets', (payload) => {
        setStreamTargets((payload as StreamTargetsSnapshot).targets)
      }),
      nextClient.on('diagnostics.stats', (payload) => {
        setDiagnosticStats(payload as DiagnosticStats)
      }),
      nextClient.on('preview.live.status', (payload) => {
        applyPreviewLiveStatus(payload as PreviewLiveStatus)
      }),
      nextClient.on('scene.changed', (payload) => {
        applyScene(payload as Scene)
      }),
      nextClient.on('screens.changed', (payload) => {
        setScreens(payload as StreamScreen[])
      }),
      nextClient.on('screens.active.changed', (payload) => {
        setActiveScreen(payload as StreamScreen | null)
      }),
      nextClient.on('platformAccounts.changed', (payload) => {
        setPlatformAccounts(payload as PlatformAccount[])
      }),
      nextClient.on('streamTargets.metadata.changed', (payload) => {
        const draft = payload as StreamMetadataDraft
        setStreamMetadataDraft(draft)
        void nextClient
          .request<StreamMetadataValidation>('streamTargets.metadata.validate', draft)
          .then(setStreamMetadataValidation)
      }),
      nextClient.on('platformAccounts.oauth.callback', (payload) => {
        const result = payload as {
          status?: string
          message?: string
          accountConnected?: boolean
        }
        if (result.status === 'success' && result.accountConnected) {
          void refreshPlatformAccountsForClient(nextClient)
          void validatePlatformAccountsForClient(nextClient)
          toast.success('Account connected.')
        } else if (result.status === 'success') {
          toast.success('OAuth callback received.')
        } else {
          toast.error('OAuth callback failed.', {
            description: result.message ?? result.status ?? 'Connection could not be completed.'
          })
        }
      }),
      nextClient.on('ai.artifacts.changed', () => {
        void refreshSessions(nextClient)
      }),
      nextClient.on('log', (payload) => appendLog(payload as BackendLogEvent)),
      nextClient.on('error', (payload) => {
        const error = payload as { message?: string }
        const message = error.message ?? 'Backend error.'
        setLastError(message)
        toast.error(message)
      }),
      nextClient.on('connection.closed', () => setWsStatus('closed'))
    ]

    nextClient
      .connect()
      .then(async () => {
        setWsStatus('connected')
        const nextHealth = await nextClient.request<BackendHealth>('health.ping', {
          ffmpegPath: settings.ffmpegPath.trim() || undefined
        })
        setHealth(nextHealth)
        const nextDevices = await nextClient.request<DeviceList>('devices.list', {
          ffmpegPath: settings.ffmpegPath.trim() || undefined
        })
        setDeviceList(nextDevices)
        const nextRecording = await nextClient.request<RecordingStatus>('recording.status')
        setRecording(nextRecording)
        const nextDiagnostics = await nextClient.request<DiagnosticStats>('diagnostics.stats')
        setDiagnosticStats(nextDiagnostics)
        const nextPreview = await nextClient.request<PreviewLiveStatus>('preview.live.status')
        applyPreviewLiveStatus(nextPreview)
        const nextScene = await nextClient.request<Scene>('scene.get')
        if (nextScene.sources.length) {
          applyScene(nextScene)
        }
        await refreshScreensForClient(nextClient)
        await refreshPlatformAccountsForClient(nextClient)
        await validatePlatformAccountsForClient(nextClient)
        await refreshStreamMetadataForClient(nextClient)
        await refreshSessions(nextClient)
      })
      .catch((error: unknown) => {
        setWsStatus('failed')
        reportError(error)
      })

    return () => {
      for (const unsubscribe of unsubscribers) {
        unsubscribe()
      }
      nextClient.close()
      setClient(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    appendLog,
    applyPreviewLiveStatus,
    connection,
    refreshPlatformAccountsForClient,
    refreshScreensForClient,
    refreshStreamMetadataForClient,
    validatePlatformAccountsForClient,
    refreshSessions,
    reportError,
    settings.ffmpegPath
  ])

  const loadScene = useCallback(
    async (config: Pick<CaptureConfig, 'sources' | 'layout' | 'video'>) => {
      if (!client || wsStatus !== 'connected') {
        return
      }

      const nextScene = await client.request<Scene>('scene.load_from_capture_config', config)
      applyScene(nextScene)
    },
    [applyScene, client, wsStatus]
  )

  const reloadSceneFromCaptureConfig = useCallback(async () => {
    await loadScene({
      sources: captureConfig.sources,
      layout: captureConfig.layout,
      video: captureConfig.video
    })
  }, [captureConfig.layout, captureConfig.sources, captureConfig.video, loadScene])

  const patchLayout = useCallback((patch: Partial<LayoutSettings>) => {
    setCaptureConfig((current) => ({ ...current, layout: { ...current.layout, ...patch } }))
  }, [])

  const syncCameraTransformToLayout = useCallback(
    (nextScene: Scene) => {
      const camera = nextScene.sources.find((source) => source.kind === 'camera')
      if (!camera) {
        return
      }

      patchLayout({
        cameraTransformMode: 'custom',
        cameraTransform: {
          x: camera.transform.x,
          y: camera.transform.y,
          width: camera.transform.width,
          height: camera.transform.height
        }
      })
    },
    [patchLayout]
  )

  const refreshBackend = useCallback(async () => {
    if (!client) {
      return
    }

    try {
      setLastError(null)
      const [
        nextHealth,
        nextDevices,
        nextSessions,
        nextDiagnostics,
        nextScreens,
        nextActiveScreen,
        nextPlatformAccounts,
        nextOauthProviderCredentials,
        nextPlatformAccountValidations,
        nextStreamMetadataDraft
      ] = await Promise.all([
        client.request<BackendHealth>('health.ping', { ffmpegPath: settings.ffmpegPath.trim() || undefined }),
        client.request<DeviceList>('devices.list', { ffmpegPath: settings.ffmpegPath.trim() || undefined }),
        client.request<SessionSummary[]>('sessions.list'),
        client.request<DiagnosticStats>('diagnostics.stats'),
        client.request<StreamScreen[]>('screens.list'),
        client.request<StreamScreen | null>('screens.active'),
        client.request<PlatformAccount[]>('platformAccounts.list'),
        client.request<OAuthProviderCredentialStatus[]>('platformAccounts.oauth.providerCredentials'),
        client.request<PlatformAccountValidation[]>('platformAccounts.validate'),
        client.request<StreamMetadataDraft>('streamTargets.metadata.get')
      ])
      const nextStreamMetadataValidation = await client.request<StreamMetadataValidation>(
        'streamTargets.metadata.validate',
        nextStreamMetadataDraft
      )
      setHealth(nextHealth)
      setDeviceList(nextDevices)
      setSessions(nextSessions)
      setDiagnosticStats(nextDiagnostics)
      setScreens(nextScreens)
      setActiveScreen(nextActiveScreen)
      setPlatformAccounts(nextPlatformAccounts)
      setOauthProviderCredentials(nextOauthProviderCredentials)
      setPlatformAccountValidations(nextPlatformAccountValidations)
      setStreamMetadataDraft(nextStreamMetadataDraft)
      setStreamMetadataValidation(nextStreamMetadataValidation)
      if (!sceneEditMode) {
        await reloadSceneFromCaptureConfig()
      }
    } catch (error) {
      reportError(error)
    }
  }, [client, reloadSceneFromCaptureConfig, reportError, sceneEditMode, settings.ffmpegPath])

  useEffect(() => {
    if (!client || wsStatus !== 'connected' || sceneEditMode) {
      return
    }

    const timer = window.setTimeout(() => {
      void reloadSceneFromCaptureConfig().catch(reportError)
    }, 250)

    return () => window.clearTimeout(timer)
  }, [client, reloadSceneFromCaptureConfig, reportError, sceneEditMode, wsStatus])

  const resetSceneSource = useCallback(
    async (sourceId = selectedSceneSourceId ?? undefined) => {
      if (!client || !sourceId) {
        return
      }

      try {
        const nextScene = await client.request<Scene>('scene.source.transform.reset', { sourceId })
        applyScene(nextScene)
        if (nextScene.sources.find((source) => source.id === sourceId)?.kind === 'camera') {
          patchLayout({ cameraTransformMode: 'preset', cameraTransform: null })
        }
      } catch (error) {
        reportError(error)
      }
    },
    [applyScene, client, patchLayout, reportError, selectedSceneSourceId]
  )

  const nudgeSceneSource = useCallback(
    async (sourceId: string, directionX: number, directionY: number, large = false) => {
      if (!client) {
        return
      }

      try {
        const nextScene = await client.request<Scene>('scene.source.nudge', {
          sourceId,
          directionX,
          directionY,
          large
        })
        applyScene(nextScene)
        if (nextScene.sources.find((source) => source.id === sourceId)?.kind === 'camera') {
          syncCameraTransformToLayout(nextScene)
        }
      } catch (error) {
        reportError(error)
      }
    },
    [applyScene, client, reportError, syncCameraTransformToLayout]
  )

  const setSceneSourceVisible = useCallback(
    async (sourceId: string, visible: boolean) => {
      if (!client) {
        return
      }

      try {
        const nextScene = await client.request<Scene>('scene.source.visibility.update', {
          sourceId,
          visible
        })
        applyScene(nextScene)
      } catch (error) {
        reportError(error)
      }
    },
    [applyScene, client, reportError]
  )

  const moveSceneSource = useCallback(
    async (sourceId: string, direction: -1 | 1) => {
      if (!client || !scene) {
        return
      }

      const currentIndex = scene.sources.findIndex((source) => source.id === sourceId)
      const nextIndex = currentIndex + direction
      if (currentIndex === -1 || nextIndex < 0 || nextIndex >= scene.sources.length) {
        return
      }

      const sourceIds = scene.sources.map((source) => source.id)
      const [moved] = sourceIds.splice(currentIndex, 1)
      if (!moved) {
        return
      }
      sourceIds.splice(nextIndex, 0, moved)

      try {
        const nextScene = await client.request<Scene>('scene.sources.reorder', { sourceIds })
        applyScene(nextScene)
      } catch (error) {
        reportError(error)
      }
    },
    [applyScene, client, reportError, scene]
  )

  const commitCameraTransform = useCallback(
    async (sourceId: string, x: number, y: number) => {
      if (!client) {
        return
      }

      try {
        const nextScene = await client.request<Scene>('scene.source.transform.update', {
          sourceId,
          transform: { x, y }
        })
        applyScene(nextScene)
        syncCameraTransformToLayout(nextScene)
      } catch (error) {
        reportError(error)
      }
    },
    [applyScene, client, reportError, syncCameraTransformToLayout]
  )

  const applyCameraPreset = useCallback(
    (patch: Partial<LayoutSettings>) => {
      const layout: LayoutSettings = {
        ...captureConfig.layout,
        ...patch,
        cameraTransformMode: 'preset',
        cameraTransform: null
      }
      setCaptureConfig((current) => ({
        ...current,
        layout: { ...current.layout, ...patch, cameraTransformMode: 'preset', cameraTransform: null }
      }))
      if (sceneEditMode) {
        void loadScene({ sources: captureConfig.sources, layout, video: captureConfig.video }).catch(reportError)
      }
    },
    [captureConfig.layout, captureConfig.sources, captureConfig.video, loadScene, reportError, sceneEditMode]
  )

  const refreshPreview = useCallback(async () => {
    if (!client || wsStatus !== 'connected') {
      return
    }

    if (previewRequestPending.current) {
      previewRefreshQueued.current = true
      return
    }

    try {
      previewRequestPending.current = true
      const requestRun = ++previewRequestRun.current
      const previewConfig = latestPreviewConfig.current
      setPreviewLoading(true)
      const status = await client.request<PreviewLiveStatus>('preview.live.start', {
        sources: previewConfig.sources,
        layout: previewConfig.layout,
        ffmpegPath: previewConfig.ffmpegPath.trim() || undefined,
        video: previewConfig.video
      })
      if (requestRun === previewRequestRun.current) {
        applyPreviewLiveStatus(status)
      }
    } catch (error) {
      reportError(error)
      if (!previewRefreshQueued.current) {
        setPreviewLiveStatus({
          state: 'unavailable',
          source: 'unavailable',
          message: error instanceof Error ? error.message : 'Live preview failed.'
        })
      }
    } finally {
      previewRequestPending.current = false
      setPreviewLoading(false)
      if (previewRefreshQueued.current) {
        previewRefreshQueued.current = false
        setPreviewRefreshNonce((current) => current + 1)
      }
    }
  }, [
    applyPreviewLiveStatus,
    client,
    reportError,
    wsStatus
  ])

  const importScreenImage = useCallback(async () => {
    if (!client || wsStatus !== 'connected') {
      toast.error('Backend socket is not connected.')
      return
    }
    if (!window.videorc?.pickScreenImage) {
      toast.error('Screen image picker is unavailable outside Electron.')
      return
    }

    try {
      setLastError(null)
      const path = await window.videorc.pickScreenImage()
      if (!path) {
        return
      }

      setScreenImportPending(true)
      const screen = await client.request<StreamScreen>('screens.importImage', {
        path,
        ffmpegPath: settings.ffmpegPath.trim() || undefined
      })
      setScreens((current) => {
        const withoutExisting = current.filter((item) => item.id !== screen.id)
        return [...withoutExisting, screen].sort((a, b) => a.sortOrder - b.sortOrder)
      })
      await refreshScreensForClient(client)
      toast.success(`Imported ${screen.name}.`)
    } catch (error) {
      reportError(error)
    } finally {
      setScreenImportPending(false)
    }
  }, [client, refreshScreensForClient, reportError, settings.ffmpegPath, wsStatus])

  const openSystemPermission = useCallback(async (pane: SystemPermissionPane) => {
    if (!window.videorc?.openSystemPermissions) {
      toast.error('Permission shortcut is unavailable outside Electron.')
      return
    }

    try {
      await window.videorc.openSystemPermissions(pane)
    } catch (error) {
      reportError(error)
    }
  }, [reportError])

  const openPreviewPermissions = useCallback(async () => {
    await openSystemPermission('screen-recording')
  }, [openSystemPermission])

  const revealPermissionTarget = useCallback(async () => {
    if (!window.videorc?.revealPermissionTarget) {
      toast.error('Permission target shortcut is unavailable outside Electron.')
      return
    }

    try {
      await window.videorc.revealPermissionTarget()
    } catch (error) {
      reportError(error)
    }
  }, [reportError])

  const sampleAudioMeter = useCallback(async () => {
    if (!client) {
      return
    }

    try {
      setLastError(null)
      setAudioMeterLoading(true)
      const result = await client.request<AudioMeterResult>('audio.meter.sample', {
        microphoneId: captureConfig.sources.microphoneId,
        ffmpegPath: settings.ffmpegPath.trim() || undefined,
        microphoneGainDb: captureConfig.audio.microphoneGainDb,
        microphoneMuted: captureConfig.audio.microphoneMuted
      })
      setAudioMeter(result)
    } catch (error) {
      reportError(error)
    } finally {
      setAudioMeterLoading(false)
    }
  }, [captureConfig.audio.microphoneGainDb, captureConfig.audio.microphoneMuted, captureConfig.sources.microphoneId, client, reportError, settings.ffmpegPath])

  const outputEnabled = captureConfig.recordEnabled || captureConfig.streamEnabled
  const streamReady =
    !captureConfig.streamEnabled || areEnabledStreamTargetsStartReady(captureConfig.streaming)
  const isSessionActive = isActiveRecordingState(recording.state) || startRequestPending || stopRequestPending

  const renameScreen = useCallback(
    async (screenId: string, name: string) => {
      if (!client || isSessionActive) {
        toast.error(isSessionActive ? 'Screen management is locked while live.' : 'Backend socket is not connected.')
        return
      }

      try {
        setLastError(null)
        const screen = await client.request<StreamScreen>('screens.rename', { screenId, name })
        setScreens((current) => current.map((item) => (item.id === screen.id ? screen : item)))
        toast.success(`Renamed ${screen.name}.`)
      } catch (error) {
        reportError(error)
      }
    },
    [client, isSessionActive, reportError]
  )

  const deleteScreen = useCallback(
    async (screenId: string) => {
      if (!client || isSessionActive) {
        toast.error(isSessionActive ? 'Screen management is locked while live.' : 'Backend socket is not connected.')
        return
      }

      try {
        setLastError(null)
        const nextScreens = await client.request<StreamScreen[]>('screens.delete', { screenId })
        setScreens(nextScreens)
        toast.success('Deleted Screen.')
      } catch (error) {
        reportError(error)
      }
    },
    [client, isSessionActive, reportError]
  )

  const moveScreen = useCallback(
    async (screenId: string, direction: -1 | 1) => {
      if (!client || isSessionActive) {
        toast.error(isSessionActive ? 'Screen management is locked while live.' : 'Backend socket is not connected.')
        return
      }

      const currentIndex = screens.findIndex((screen) => screen.id === screenId)
      const nextIndex = currentIndex + direction
      if (currentIndex === -1 || nextIndex < 0 || nextIndex >= screens.length) {
        return
      }

      const screenIds = screens.map((screen) => screen.id)
      const [moved] = screenIds.splice(currentIndex, 1)
      if (!moved) {
        return
      }
      screenIds.splice(nextIndex, 0, moved)

      try {
        setLastError(null)
        const nextScreens = await client.request<StreamScreen[]>('screens.reorder', { screenIds })
        setScreens(nextScreens)
      } catch (error) {
        reportError(error)
      }
    },
    [client, isSessionActive, reportError, screens]
  )

  const activateScreen = useCallback(
    async (screenId: string) => {
      if (!client) {
        toast.error('Backend socket is not connected.')
        return
      }

      try {
        setLastError(null)
        const screen = await client.request<StreamScreen>('screens.activate', { screenId })
        setActiveScreen(screen)
      } catch (error) {
        reportError(error)
      }
    },
    [client, reportError]
  )

  const clearActiveScreen = useCallback(async () => {
    if (!client) {
      toast.error('Backend socket is not connected.')
      return
    }

    try {
      setLastError(null)
      await client.request<StreamScreen | null>('screens.clear')
      setActiveScreen(null)
    } catch (error) {
      reportError(error)
    }
  }, [client, reportError])

  const disconnectPlatformAccount = useCallback(
    async (platform: PlatformAccount['platform']) => {
      if (!client || wsStatus !== 'connected') {
        toast.error('Backend socket is not connected.')
        return
      }

      try {
        setLastError(null)
        await client.request<PlatformAccount | null>('platformAccounts.disconnect', { platform })
        await refreshPlatformAccountsForClient(client)
        setCaptureConfig((current) => {
          const targets = current.streaming.targets.map((target) =>
            target.platform === platform
              ? {
                  ...target,
                  accountId: undefined,
                  accountLabel: undefined,
                  streamKeySecretRef: undefined,
                  platformBroadcastId: undefined,
                  platformStreamId: undefined
                }
              : target
          )
          return bridgeStreamingToLegacy({ ...current, streaming: { ...current.streaming, targets } })
        })
        toast.success('Disconnected account.')
      } catch (error) {
        reportError(error)
      }
    },
    [client, refreshPlatformAccountsForClient, reportError, wsStatus]
  )

  const connectPlatformAccount = useCallback(
    async (platform: PlatformAccount['platform']) => {
      if (!client || wsStatus !== 'connected') {
        toast.error('Backend socket is not connected.')
        return
      }
      if (!window.videorc?.openOAuthUrl) {
        toast.error('OAuth browser launch is unavailable outside Electron.')
        return
      }

      try {
        setLastError(null)
        const redirectUri = await window.videorc.getOAuthCallbackRedirectUri()
        const params = redirectUri ? { platform, redirectUri } : { platform }
        const result = await client.request<OAuthStartResult>('platformAccounts.oauth.startProvider', params)
        await window.videorc.openOAuthUrl(result.authUrl)
        toast.success('OAuth browser opened.')
      } catch (error) {
        reportError(error)
      }
    },
    [client, reportError, wsStatus]
  )

  useEffect(() => {
    if (!window.videorc?.onOAuthCallbackUrl) {
      return
    }

    return window.videorc.onOAuthCallbackUrl((callbackUrl) => {
      if (!client || wsStatus !== 'connected') {
        toast.error('OAuth callback received before the backend was connected.')
        return
      }

      let parsed: URL
      try {
        parsed = new URL(callbackUrl)
      } catch (error) {
        reportError(error)
        return
      }

      const state = parsed.searchParams.get('state')?.trim()
      if (!state) {
        toast.error('OAuth callback was missing state.')
        return
      }

      const params: OAuthCompleteParams = {
        state,
        code: parsed.searchParams.get('code') ?? undefined,
        error: parsed.searchParams.get('error') ?? undefined,
        errorDescription: parsed.searchParams.get('error_description') ?? undefined
      }

      void client.request('platformAccounts.oauth.complete', params).catch(reportError)
    })
  }, [client, reportError, wsStatus])

  const patchStreamMetadataDraft = useCallback((patch: Partial<StreamMetadataDraft>) => {
    setStreamMetadataDraft((current) => (current ? { ...current, ...patch } : current))
    setStreamMetadataValidation(null)
  }, [])

  const patchStreamTargetMetadataDraft = useCallback(
    (
      platform: StreamMetadataDraft['targetOverrides'][number]['platform'],
      patch: Partial<StreamMetadataDraft['targetOverrides'][number]>
    ) => {
      setStreamMetadataDraft((current) =>
        current
          ? {
              ...current,
              targetOverrides: current.targetOverrides.map((target) =>
                target.platform === platform ? { ...target, ...patch } : target
              )
            }
          : current
      )
      setStreamMetadataValidation(null)
    },
    []
  )

  const saveStreamMetadataDraft = useCallback(async () => {
    if (!client || wsStatus !== 'connected') {
      toast.error('Backend socket is not connected.')
      return
    }
    if (!streamMetadataDraft) {
      toast.error('Metadata draft is not loaded yet.')
      return
    }

    try {
      setLastError(null)
      setStreamMetadataSavePending(true)
      const validation = await client.request<StreamMetadataValidation>(
        'streamTargets.metadata.validate',
        streamMetadataDraft
      )
      setStreamMetadataValidation(validation)
      const saved = await client.request<StreamMetadataDraft>(
        'streamTargets.metadata.update',
        streamMetadataDraft
      )
      setStreamMetadataDraft(saved)
      if (validation.valid) {
        toast.success('Saved stream metadata.')
      } else {
        toast.warning('Saved stream metadata with warnings.')
      }
    } catch (error) {
      reportError(error)
    } finally {
      setStreamMetadataSavePending(false)
    }
  }, [client, reportError, streamMetadataDraft, wsStatus])

  useEffect(() => {
    if (!client || wsStatus !== 'connected' || isSessionActive || !health?.ffmpeg.available || !deviceList.devices.length) {
      return
    }

    const timer = window.setTimeout(() => {
      void refreshPreview()
    }, 500)

    return () => window.clearTimeout(timer)
  }, [
    client,
    deviceList.devices.length,
    health?.ffmpeg.available,
    isSessionActive,
    previewRefreshNonce,
    previewRestartKey,
    refreshPreview,
    wsStatus
  ])

  const startBlockedReason = (() => {
    if (wsStatus !== 'connected') {
      return `Backend socket is ${wsStatus}.`
    }
    if (isSessionActive) {
      return 'A capture session is already active.'
    }
    if (!outputEnabled) {
      return 'Enable Record MKV, Stream RTMP, or both before starting.'
    }
    if (captureConfig.streamEnabled && !streamReady) {
      return captureConfig.streaming.targets.some((target) => target.enabled)
        ? 'Finish manual livestream destination setup before streaming.'
        : 'Enable at least one livestream destination before streaming.'
    }
    if (!health) {
      return 'Checking FFmpeg before starting.'
    }
    if (!health.ffmpeg.available) {
      return health.ffmpeg.message ?? 'FFmpeg is not available.'
    }

    return null
  })()

  const activatePreparedYouTubeBroadcasts = useCallback(
    async (streamingForStart: StreamingSettings, runId: number) => {
      if (!client) {
        return
      }

      const youtubeTargets = preparedYouTubeActivationTargets(streamingForStart)

      for (const target of youtubeTargets) {
        const broadcastId = target.platformBroadcastId
        const streamId = target.platformStreamId
        if (!broadcastId || !streamId) {
          continue
        }
        if (platformLifecycleRun.current !== runId) {
          return
        }

        try {
          setCaptureConfig((current) =>
            bridgeStreamingToLegacy({
              ...current,
              streaming: patchPreparedStreamTarget(current.streaming, target.id, {
                status: {
                  state: 'connecting',
                  message: 'Waiting for YouTube ingest.'
                }
              })
            })
          )

          let lastStatus: YouTubeStreamStatusResult | null = null
          for (let attempt = 0; attempt < 8; attempt += 1) {
            if (platformLifecycleRun.current !== runId) {
              return
            }
            lastStatus = await client.request<YouTubeStreamStatusResult>('streamTargets.youtube.streamStatus', {
              accountId: target.accountId,
              streamId
            })
            const statusSnapshot = lastStatus
            setCaptureConfig((current) =>
              bridgeStreamingToLegacy({
                ...current,
                streaming: patchPreparedStreamTarget(current.streaming, target.id, {
                  status: {
                    state: statusSnapshot.active ? 'connecting' : 'warning',
                    message: statusSnapshot.message
                  }
                })
              })
            )
            if (statusSnapshot.active) {
              break
            }
            await delay(2000)
          }

          if (!lastStatus?.active) {
            throw new Error(lastStatus?.message ?? 'YouTube ingest did not become active yet.')
          }
          if (platformLifecycleRun.current !== runId) {
            return
          }

          const transition = await client.request<YouTubeBroadcastTransitionResult>(
            'streamTargets.youtube.transition',
            {
              accountId: target.accountId,
              broadcastId,
              status: 'live'
            }
          )
          setCaptureConfig((current) =>
            bridgeStreamingToLegacy({
              ...current,
              streaming: patchPreparedStreamTarget(current.streaming, target.id, {
                status: {
                  state: 'live',
                  message: transition.lifecycleStatus
                    ? `YouTube broadcast is live (${transition.lifecycleStatus}).`
                    : 'YouTube broadcast is live.'
                }
              })
            })
          )
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          setCaptureConfig((current) =>
            bridgeStreamingToLegacy({
              ...current,
              streaming: patchPreparedStreamTarget(current.streaming, target.id, {
                status: {
                  state: 'warning',
                  message: `YouTube go-live needs review: ${message}`
                }
              })
            })
          )
          toast.warning(`Could not transition ${target.label} live on YouTube.`, {
            description: message
          })
        }
      }
    },
    [client]
  )

  const completePreparedPlatformBroadcasts = useCallback(
    async (streamingForCleanup: StreamingSettings = captureConfig.streaming) => {
      if (!client) {
        return
      }

      const youtubeTargets = preparedYouTubeCompletionTargets(streamingForCleanup)
      for (const target of youtubeTargets) {
        const broadcastId = target.platformBroadcastId
        if (!broadcastId) {
          continue
        }
        try {
          setCaptureConfig((current) =>
            bridgeStreamingToLegacy({
              ...current,
              streaming: patchPreparedStreamTarget(current.streaming, target.id, {
                status: {
                  state: 'connecting',
                  message: 'Completing YouTube broadcast.'
                }
              })
            })
          )
          const result = await client.request<YouTubeBroadcastTransitionResult>('streamTargets.youtube.transition', {
            accountId: target.accountId,
            broadcastId,
            status: 'complete'
          })
          setCaptureConfig((current) =>
            bridgeStreamingToLegacy({
              ...current,
              streaming: patchPreparedStreamTarget(current.streaming, target.id, {
                status: {
                  state: 'stopped',
                  message: result.lifecycleStatus
                    ? `YouTube broadcast ended (${result.lifecycleStatus}).`
                    : 'YouTube broadcast ended.'
                }
              })
            })
          )
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          setCaptureConfig((current) =>
            bridgeStreamingToLegacy({
              ...current,
              streaming: patchPreparedStreamTarget(current.streaming, target.id, {
                status: {
                  state: 'warning',
                  message: `YouTube cleanup needs review: ${message}`
                }
              })
            })
          )
          toast.warning(`Could not complete ${target.label} on YouTube.`, {
            description: message
          })
        }
      }
    },
    [captureConfig.streaming, client]
  )

  const runStartSession = useCallback(async (streamingOverride?: StreamingSettings) => {
    if (!client || startBlockedReason) {
      if (startBlockedReason && !isSessionActive) {
        reportError(new Error(startBlockedReason))
      }
      return
    }

    let streamingForStart: StreamingSettings | null = null
    try {
      setLastError(null)
      setStreamHealth(null)
      setStreamTargets([])
      setStartRequestPending(true)
      streamingForStart = streamingOverride ?? captureConfig.streaming
      const lifecycleRunId = platformLifecycleRun.current + 1
      platformLifecycleRun.current = lifecycleRunId
      const enabledOauthTargets = streamingForStart.targets.filter(
        (target) => target.enabled && target.authMode === 'oauth'
      )
      if (enabledOauthTargets.length) {
        const validations = await validatePlatformAccountsForClient(client)
        const unhealthy = enabledOauthTargets.find((target) => {
          const validation = validations.find((item) => item.platform === target.platform)
          return !validation || !['valid', 'refreshed'].includes(validation.state)
        })
        if (unhealthy) {
          throw new Error(`Reconnect ${unhealthy.label} before starting an OAuth livestream.`)
        }
      }
      setRecording((current) =>
        isActiveRecordingState(current.state)
          ? current
          : { state: 'starting', message: 'Starting capture session.' }
      )
      const nextSessionParams: StartSessionParams = streamingOverride
        ? {
            ...sessionParams,
            output: { ...sessionParams.output, streamEnabled: true },
            streaming: streamingOverride
          }
        : sessionParams
      const status = await client.request<RecordingStatus>('session.start', nextSessionParams)
      setRecording(status)
      await refreshSessions(client)
      await activatePreparedYouTubeBroadcasts(streamingForStart, lifecycleRunId)
    } catch (error) {
      if (streamingOverride && streamingForStart) {
        await completePreparedPlatformBroadcasts(streamingForStart)
      }
      reportError(error)
      setRecording((current) =>
        current.state === 'starting' && !current.sessionId
          ? { state: 'idle', message: 'Ready to start a capture session.' }
          : current
      )
    } finally {
      setStartRequestPending(false)
    }
  }, [
    activatePreparedYouTubeBroadcasts,
    captureConfig.streaming,
    client,
    completePreparedPlatformBroadcasts,
    isSessionActive,
    refreshSessions,
    reportError,
    sessionParams,
    startBlockedReason,
    validatePlatformAccountsForClient
  ])

  const prepareOauthTargetsForGoLive = useCallback(async (): Promise<GoLivePartialSetup> => {
    if (!client) {
      throw new Error('Backend socket is not connected.')
    }

    let nextStreaming = captureConfig.streaming
    const failures: GoLiveSetupFailure[] = []
    for (const target of captureConfig.streaming.targets.filter(
      (target) => target.enabled && target.authMode === 'oauth'
    )) {
      try {
        if (target.platform === 'youtube') {
          const prepared = await client.request<PreparedYouTubeBroadcast>('streamTargets.youtube.prepare', {
            accountId: target.accountId,
            video: captureConfig.video
          })
          nextStreaming = patchPreparedStreamTarget(nextStreaming, target.id, {
            accountId: prepared.accountId,
            accountLabel: prepared.accountLabel,
            serverUrl: prepared.serverUrl,
            streamKeySecretRef: prepared.streamKeySecretRef,
            streamKeyPresent: true,
            platformBroadcastId: prepared.broadcastId,
            platformStreamId: prepared.streamId,
            status: {
              state: 'ready',
              message: 'YouTube broadcast prepared.'
            }
          })
        } else if (target.platform === 'twitch') {
          const prepared = await client.request<PreparedTwitchBroadcast>('streamTargets.twitch.prepare', {
            accountId: target.accountId
          })
          nextStreaming = patchPreparedStreamTarget(nextStreaming, target.id, {
            accountId: prepared.accountId,
            accountLabel: prepared.accountLabel,
            serverUrl: prepared.serverUrl,
            streamKeySecretRef: prepared.streamKeySecretRef,
            streamKeyPresent: true,
            platformBroadcastId: undefined,
            platformStreamId: undefined,
            status: {
              state: 'ready',
              message: 'Twitch channel prepared.'
            }
          })
        } else if (target.platform === 'x') {
          await client.request('streamTargets.x.prepare', { accountId: target.accountId })
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        failures.push({
          targetId: target.id,
          platform: target.platform,
          label: target.label,
          message
        })
        nextStreaming = patchPreparedStreamTarget(nextStreaming, target.id, {
          enabled: false,
          status: {
            state: 'failed',
            message
          }
        })
      }
    }

    setCaptureConfig((current) => bridgeStreamingToLegacy({ ...current, streaming: nextStreaming }))
    await refreshPlatformAccountsForClient(client)
    return {
      streaming: nextStreaming,
      failures,
      readyLabels: nextStreaming.targets.filter((target) => target.enabled).map((target) => target.label)
    }
  }, [captureConfig.streaming, captureConfig.video, client, refreshPlatformAccountsForClient])

  const openGoLiveConfirmation = useCallback(async () => {
    if (!client || startBlockedReason) {
      if (startBlockedReason && !isSessionActive) {
        reportError(new Error(startBlockedReason))
      }
      return
    }

    try {
      setLastError(null)
      setGoLivePartialSetup(null)
      setGoLiveConfirmationPending(true)
      if (streamMetadataDraft) {
        const saved = await client.request<StreamMetadataDraft>(
          'streamTargets.metadata.update',
          streamMetadataDraft
        )
        setStreamMetadataDraft(saved)
        const validation = await client.request<StreamMetadataValidation>(
          'streamTargets.metadata.validate',
          saved
        )
        setStreamMetadataValidation(validation)
      }
      const preflight = await client.request<GoLivePreflight>('streamTargets.confirmation.validate', {
        streaming: captureConfig.streaming
      })
      setGoLivePreflight(preflight)
      setGoLiveConfirmationOpen(true)
    } catch (error) {
      reportError(error)
    } finally {
      setGoLiveConfirmationPending(false)
    }
  }, [captureConfig.streaming, client, isSessionActive, reportError, startBlockedReason, streamMetadataDraft])

  const startSession = useCallback(async () => {
    if (captureConfig.streamEnabled) {
      await openGoLiveConfirmation()
      return
    }
    await runStartSession()
  }, [captureConfig.streamEnabled, openGoLiveConfirmation, runStartSession])

  const cancelGoLiveConfirmation = useCallback(() => {
    if (goLiveConfirmationPending || startRequestPending) {
      return
    }
    if (goLivePartialSetup) {
      void completePreparedPlatformBroadcasts(goLivePartialSetup.streaming)
    }
    setGoLivePartialSetup(null)
    setGoLiveConfirmationOpen(false)
  }, [completePreparedPlatformBroadcasts, goLiveConfirmationPending, goLivePartialSetup, startRequestPending])

  const confirmGoLive = useCallback(async () => {
    if (!client || goLiveConfirmationPending || startRequestPending) {
      return
    }

    try {
      setLastError(null)
      setGoLiveConfirmationPending(true)
      if (streamMetadataDraft) {
        const saved = await client.request<StreamMetadataDraft>(
          'streamTargets.metadata.update',
          streamMetadataDraft
        )
        setStreamMetadataDraft(saved)
        const validation = await client.request<StreamMetadataValidation>(
          'streamTargets.metadata.validate',
          saved
        )
        setStreamMetadataValidation(validation)
      }
      const preflight = await client.request<GoLivePreflight>('streamTargets.confirmation.validate', {
        streaming: captureConfig.streaming
      })
      setGoLivePreflight(preflight)
      if (!preflight.valid) {
        toast.error('Resolve Go Live issues before starting.')
        return
      }
      const setup = await prepareOauthTargetsForGoLive()
      if (setup.failures.length) {
        if (!setup.readyLabels.length) {
          throw new Error('No livestream destinations are ready after platform setup.')
        }
        setGoLivePartialSetup(setup)
        toast.warning('Some destinations failed setup.', {
          description: 'Continue with the ready destinations or cancel this Go Live.'
        })
        return
      }
      setGoLiveConfirmationOpen(false)
      await runStartSession(setup.streaming)
    } catch (error) {
      reportError(error)
    } finally {
      setGoLiveConfirmationPending(false)
    }
  }, [
    captureConfig.streaming,
    client,
    goLiveConfirmationPending,
    prepareOauthTargetsForGoLive,
    reportError,
    runStartSession,
    startRequestPending,
    streamMetadataDraft
  ])

  const continueGoLiveWithReadyDestinations = useCallback(async () => {
    if (!goLivePartialSetup || goLiveConfirmationPending || startRequestPending) {
      return
    }

    try {
      setLastError(null)
      setGoLiveConfirmationPending(true)
      const setup = goLivePartialSetup
      setGoLivePartialSetup(null)
      setGoLiveConfirmationOpen(false)
      await runStartSession(setup.streaming)
    } catch (error) {
      reportError(error)
    } finally {
      setGoLiveConfirmationPending(false)
    }
  }, [goLiveConfirmationPending, goLivePartialSetup, reportError, runStartSession, startRequestPending])

  const stopSession = useCallback(async () => {
    if (!client || stopRequestPending) {
      return
    }

    try {
      setLastError(null)
      platformLifecycleRun.current += 1
      setStopRequestPending(true)
      const status = await client.request<RecordingStatus>('session.stop')
      setRecording(status)
      await completePreparedPlatformBroadcasts()
    } catch (error) {
      reportError(error)
    } finally {
      setStopRequestPending(false)
    }
  }, [client, completePreparedPlatformBroadcasts, reportError, stopRequestPending])

  const remuxSession = useCallback(
    async (sessionId: string) => {
      if (!client) {
        return
      }

      try {
        setLastError(null)
        await client.request('session.remux_mp4', {
          sessionId,
          ffmpegPath: settings.ffmpegPath.trim() || undefined
        })
        await refreshSessions(client)
        toast.success('Remuxed recording to MP4.')
      } catch (error) {
        reportError(error)
      }
    },
    [client, refreshSessions, reportError, settings.ffmpegPath]
  )

  const runAiWorkflow = useCallback(
    async (sessionId: string) => {
      if (!client) {
        return
      }

      try {
        setLastError(null)
        setAiRunningSessionId(sessionId)
        await client.request<AiWorkflowResult>('ai.run_post_recording', {
          sessionId,
          consentToUploadAudio: aiConsent,
          ffmpegPath: settings.ffmpegPath.trim() || undefined
        })
        await refreshSessions(client)
        toast.success(aiConsent ? 'AI workflow finished.' : 'Extracted local audio. Enable consent for cloud AI.')
      } catch (error) {
        reportError(error)
      } finally {
        setAiRunningSessionId(null)
      }
    },
    [aiConsent, client, refreshSessions, reportError, settings.ffmpegPath]
  )

  const exportPublishPack = useCallback(
    async (sessionId: string) => {
      if (!client) {
        return
      }

      try {
        setLastError(null)
        setExportRunningSessionId(sessionId)
        const result = await client.request<ExportPublishPackResult>('ai.publish_pack.export', {
          sessionId
        })
        toast.success(`Publish pack exported to ${result.markdownPath}`)
      } catch (error) {
        reportError(error)
      } finally {
        setExportRunningSessionId(null)
      }
    },
    [client, reportError]
  )

  const patchVideo = useCallback((patch: Partial<VideoSettings>) => {
    setCaptureConfig((current) => ({
      ...current,
      video: { ...current.video, ...patch, preset: 'custom' }
    }))
  }, [])

  const applyVideoPreset = useCallback((preset: VideoPreset) => {
    setCaptureConfig((current) => ({ ...current, video: videoPresets[preset] }))
  }, [])

  const applyRtmpPreset = useCallback((preset: RtmpPreset) => {
    setCaptureConfig((current) => ({
      ...current,
      rtmpPreset: preset,
      rtmpServerUrl: rtmpDefaults[preset] || current.rtmpServerUrl,
      // Stream keys are platform-specific — never carry one across a platform switch.
      streamKey: ''
    }))
  }, [])

  const patchStreamingTarget = useCallback((targetId: string, patch: Partial<StreamTargetSettings>) => {
    setCaptureConfig((current) => {
      const now = new Date().toISOString()
      const targets = current.streaming.targets.map((target) => {
        if (target.id !== targetId) {
          return target
        }
        return patchStreamTargetForEdit(target, patch, now)
      })
      const enabledTargetIds = targets.filter((target) => target.enabled).map((target) => target.id)
      const streaming: StreamingSettings = {
        ...current.streaming,
        targets,
        enabled: enabledTargetIds.length > 0,
        mode: enabledTargetIds.length > 1 ? 'multi' : 'single',
        enabledTargetIds
      }
      return bridgeStreamingToLegacy({ ...current, streaming })
    })
  }, [])

  const saveManualStreamKey = useCallback(
    async (targetId: string, streamKey: string) => {
      if (!client) {
        toast.error('Backend socket is not connected.')
        return
      }

      try {
        setLastError(null)
        const result = await client.request<StoreManualStreamKeyResult>('streamTargets.manualKey.store', {
          targetId,
          streamKey
        })
        setCaptureConfig((current) => {
          const target = current.streaming.targets.find((item) => item.id === targetId)
          const streaming = patchPreparedStreamTarget(current.streaming, targetId, {
            serverUrl: target?.urlMode === 'full-url' ? '' : target?.serverUrl,
            streamKey: '',
            streamKeySecretRef: result.streamKeySecretRef,
            streamKeyPresent: result.streamKeyPresent
          })
          return bridgeStreamingToLegacy({ ...current, streaming })
        })
      } catch (error) {
        reportError(error)
      }
    },
    [client, reportError]
  )

  const canStart = !startBlockedReason
  const canStop =
    wsStatus === 'connected' &&
    ['recording', 'streaming', 'starting', 'stopping'].includes(recording.state) &&
    !stopRequestPending
  const visibleStartBlockedReason =
    startBlockedReason &&
    !lastError &&
    !isActiveRecordingState(recording.state) &&
    !startRequestPending &&
    !stopRequestPending
      ? startBlockedReason
      : null
  const selectedCaptureDevice = findDevice(
    deviceList.devices,
    captureConfig.sources.screenId ?? captureConfig.sources.windowId
  )
  const selectedCamera = findDevice(deviceList.devices, captureConfig.sources.cameraId)
  const selectedMicrophone = findDevice(deviceList.devices, captureConfig.sources.microphoneId)
  const setupSteps = setupChecklist({
    audioMeter,
    captureConfig,
    health,
    selectedCaptureDevice,
    selectedCamera,
    selectedMicrophone,
    streamReady,
    wsStatus
  })
  const elapsed = recording.startedAt ? durationLabel(recording.startedAt, now) : '00:00'
  const meterLevel = Math.round((audioMeter?.level ?? 0) * 100)
  const canSampleAudio = Boolean(wsStatus === 'connected' && selectedMicrophone && !isSessionActive)

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || isEditableTargetSafe(event.target)) {
        return
      }

      if (event.code === 'Space') {
        event.preventDefault()
        if (canStop) {
          void stopSession()
          return
        }
        if (canStart) {
          void startSession()
        }
        return
      }

      if (event.key.toLowerCase() === 'p') {
        event.preventDefault()
        void refreshPreview()
      }

      if (sceneEditMode && selectedSceneSourceId && !isSessionActive) {
        const large = event.shiftKey
        if (event.key === 'ArrowUp') {
          event.preventDefault()
          void nudgeSceneSource(selectedSceneSourceId, 0, -1, large)
          return
        }
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          void nudgeSceneSource(selectedSceneSourceId, 0, 1, large)
          return
        }
        if (event.key === 'ArrowLeft') {
          event.preventDefault()
          void nudgeSceneSource(selectedSceneSourceId, -1, 0, large)
          return
        }
        if (event.key === 'ArrowRight') {
          event.preventDefault()
          void nudgeSceneSource(selectedSceneSourceId, 1, 0, large)
          return
        }
        if (event.key.toLowerCase() === 'r') {
          event.preventDefault()
          void resetSceneSource(selectedSceneSourceId)
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [
    canStart,
    canStop,
    isSessionActive,
    nudgeSceneSource,
    refreshPreview,
    resetSceneSource,
    sceneEditMode,
    selectedSceneSourceId,
    startSession,
    stopSession
  ])

  const value: StudioContextValue = {
    connection,
    wsStatus,
    health,
    deviceList,
    recording,
    logs,
    healthEvents,
    streamHealth,
    streamTargets,
    diagnosticStats,
    sessions,
    screens,
    activeScreen,
    platformAccounts,
    platformAccountValidations,
    oauthProviderCredentials,
    youtubeChannels,
    youtubeChannelsLoading,
    twitchCategories,
    twitchCategorySearchPending,
    xNativeCapability,
    xNativeCapabilityLoading,
    streamMetadataDraft,
    streamMetadataValidation,
    goLivePreflight,
    goLiveConfirmationOpen,
    goLiveConfirmationPending,
    goLivePartialSetup,
    previewUrl,
    previewLoading,
    previewLiveStatus,
    scene,
    sceneEditMode,
    selectedSceneSourceId,
    setSceneEditMode,
    setSelectedSceneSourceId,
    audioMeter,
    audioMeterLoading,
    aiConsent,
    setAiConsent,
    aiRunningSessionId,
    exportRunningSessionId,
    startRequestPending,
    stopRequestPending,
    screenImportPending,
    streamMetadataSavePending,
    settings,
    setSettings,
    captureConfig,
    setCaptureConfig,
    patchLayout,
    patchVideo,
    applyVideoPreset,
    applyRtmpPreset,
    patchStreamingTarget,
    saveManualStreamKey,
    patchStreamMetadataDraft,
    patchStreamTargetMetadataDraft,
    lastError,
    runtimeInfo,
    refreshBackend,
    refreshPlatformAccounts,
    validatePlatformAccounts,
    connectPlatformAccount,
    disconnectPlatformAccount,
    refreshYouTubeChannels,
    selectYouTubeChannel,
    searchTwitchCategories,
    refreshXNativeCapability,
    refreshStreamMetadata,
    saveStreamMetadataDraft,
    cancelGoLiveConfirmation,
    confirmGoLive,
    continueGoLiveWithReadyDestinations,
    refreshScreens,
    importScreenImage,
    renameScreen,
    deleteScreen,
    moveScreen,
    activateScreen,
    clearActiveScreen,
    refreshPreview,
    reloadSceneFromCaptureConfig,
    resetSceneSource,
    nudgeSceneSource,
    commitCameraTransform,
    applyCameraPreset,
    setSceneSourceVisible,
    moveSceneSource,
    openSystemPermission,
    openPreviewPermissions,
    revealPermissionTarget,
    sampleAudioMeter,
    startSession,
    stopSession,
    remuxSession,
    runAiWorkflow,
    exportPublishPack,
    outputEnabled,
    streamReady,
    isSessionActive,
    startBlockedReason,
    canStart,
    canStop,
    visibleStartBlockedReason,
    selectedCaptureDevice,
    selectedCamera,
    selectedMicrophone,
    setupSteps,
    elapsed,
    meterLevel,
    canSampleAudio
  }

  return <StudioContext.Provider value={value}>{children}</StudioContext.Provider>
}

function isEditableTargetSafe(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    ? Boolean(target.closest('input, textarea, select, button, [contenteditable="true"]'))
    : false
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}
