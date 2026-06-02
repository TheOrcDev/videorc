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
  defaultSettings,
  loadCaptureConfig,
  loadJson,
  rtmpDefaults,
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
  HealthEvent,
  LayoutSettings,
  PreviewLiveStatus,
  RecordingStatus,
  RuntimeInfo,
  RtmpPreset,
  Scene,
  SessionLogEntry,
  SessionSummary,
  StartSessionParams,
  StreamScreen,
  StreamHealth,
  StreamingSettings,
  StreamTargetRuntime,
  StreamTargetSettings,
  StreamTargetsSnapshot,
  SystemPermissionPane,
  VideoPreset,
  VideoSettings
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
  // notices
  lastError: string | null
  runtimeInfo: RuntimeInfo | null
  // actions
  refreshBackend: () => Promise<void>
  refreshScreens: () => Promise<void>
  importScreenImage: () => Promise<void>
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

const StudioContext = createContext<StudioContextValue | null>(null)

const idleDiagnosticStats = (): DiagnosticStats => ({
  skippedFrames: 0,
  droppedFrames: 0,
  micDroppedFrames: 0,
  deviceDisconnected: false,
  bottleneck: 'none',
  updatedAt: new Date().toISOString()
})

function findRememberedSource(
  sourceId: string | undefined,
  sourceName: string | undefined,
  devices: Device[]
): Device | undefined {
  if (sourceId) {
    const exact = devices.find((device) => device.id === sourceId)
    if (exact) {
      return exact
    }
  }

  const normalizedName = sourceName?.trim()
  if (!normalizedName) {
    return undefined
  }

  return devices.find((device) => device.name.trim() === normalizedName)
}

function sourceIdentityFor(device: Device | undefined): Pick<SourceSelectionWithNames, 'id' | 'name'> {
  return { id: device?.id, name: device?.name }
}

type SourceSelectionWithNames = {
  id?: string
  name?: string
}

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
  const [settings, setSettings] = useState<SettingsState>(() => loadJson(STORAGE_KEYS.settings, defaultSettings))
  const [captureConfig, setCaptureConfig] = useState<CaptureConfig>(loadCaptureConfig)
  const [lastError, setLastError] = useState<string | null>(null)
  const [runtimeInfo, setRuntimeInfo] = useState<RuntimeInfo | null>(null)
  const previewRequestPending = useRef(false)
  const previewRefreshQueued = useRef(false)
  const toastedFailedTargets = useRef<Set<string>>(new Set())
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

    const nextScreens = await activeClient.request<StreamScreen[]>('screens.list')
    setScreens(nextScreens)
  }, [])

  const refreshScreens = useCallback(async () => {
    try {
      await refreshScreensForClient(client)
    } catch (error) {
      reportError(error)
    }
  }, [client, refreshScreensForClient, reportError])

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(settings))
  }, [settings])

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.captureConfig, JSON.stringify(captureConfig))
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
      const nextSources = { ...current.sources }
      const captureDevices = deviceList.devices.filter(
        (device) => ['screen', 'window'].includes(device.kind) && device.status === 'available'
      )
      const cameras = deviceList.devices.filter((device) => device.kind === 'camera' && device.status === 'available')
      const microphones = deviceList.devices.filter(
        (device) => device.kind === 'microphone' && device.status === 'available'
      )

      const selectedCapture = nextSources.windowId
        ? (findRememberedSource(nextSources.windowId, nextSources.windowName, captureDevices) ?? captureDevices[0])
        : (findRememberedSource(nextSources.screenId, nextSources.screenName, captureDevices) ?? captureDevices[0])
      nextSources.screenId = selectedCapture?.kind === 'screen' ? selectedCapture.id : undefined
      nextSources.screenName = selectedCapture?.kind === 'screen' ? selectedCapture.name : undefined
      nextSources.windowId = selectedCapture?.kind === 'window' ? selectedCapture.id : undefined
      nextSources.windowName = selectedCapture?.kind === 'window' ? selectedCapture.name : undefined

      const selectedCamera = findRememberedSource(nextSources.cameraId, nextSources.cameraName, cameras) ?? cameras[0]
      const selectedMicrophone =
        findRememberedSource(nextSources.microphoneId, nextSources.microphoneName, microphones) ?? microphones[0]

      const cameraIdentity = sourceIdentityFor(selectedCamera)
      nextSources.cameraId = cameraIdentity.id
      nextSources.cameraName = cameraIdentity.name
      const microphoneIdentity = sourceIdentityFor(selectedMicrophone)
      nextSources.microphoneId = microphoneIdentity.id
      nextSources.microphoneName = microphoneIdentity.name

      if (JSON.stringify(nextSources) === JSON.stringify(current.sources)) {
        return current
      }

      return { ...current, sources: nextSources }
    })
  }, [deviceList])

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
    refreshScreensForClient,
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
      const [nextHealth, nextDevices, nextSessions, nextDiagnostics, nextScreens] = await Promise.all([
        client.request<BackendHealth>('health.ping', { ffmpegPath: settings.ffmpegPath.trim() || undefined }),
        client.request<DeviceList>('devices.list', { ffmpegPath: settings.ffmpegPath.trim() || undefined }),
        client.request<SessionSummary[]>('sessions.list'),
        client.request<DiagnosticStats>('diagnostics.stats'),
        client.request<StreamScreen[]>('screens.list')
      ])
      setHealth(nextHealth)
      setDeviceList(nextDevices)
      setSessions(nextSessions)
      setDiagnosticStats(nextDiagnostics)
      setScreens(nextScreens)
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
      setPreviewLoading(true)
      const status = await client.request<PreviewLiveStatus>('preview.live.start', {
        sources: captureConfig.sources,
        layout: captureConfig.layout,
        ffmpegPath: settings.ffmpegPath.trim() || undefined,
        video: captureConfig.video
      })
      applyPreviewLiveStatus(status)
    } catch (error) {
      reportError(error)
      setPreviewLiveStatus({
        state: 'unavailable',
        source: 'unavailable',
        message: error instanceof Error ? error.message : 'Live preview failed.'
      })
      setPreviewUrl(null)
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
    captureConfig.layout,
    captureConfig.sources,
    captureConfig.video,
    client,
    reportError,
    settings.ffmpegPath,
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
    !captureConfig.streamEnabled || Boolean(captureConfig.rtmpServerUrl.trim() && captureConfig.streamKey.trim())
  const isSessionActive = isActiveRecordingState(recording.state) || startRequestPending || stopRequestPending

  useEffect(() => {
    if (!client || wsStatus !== 'connected' || isSessionActive || !health?.ffmpeg.available || !deviceList.devices.length) {
      return
    }

    const timer = window.setTimeout(() => {
      void refreshPreview()
    }, 500)

    return () => window.clearTimeout(timer)
  }, [client, deviceList.devices.length, health?.ffmpeg.available, isSessionActive, previewRefreshNonce, refreshPreview, wsStatus])

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
    if (captureConfig.streamEnabled && !captureConfig.rtmpServerUrl.trim()) {
      return 'Enter an RTMP server before streaming.'
    }
    if (captureConfig.streamEnabled && !captureConfig.streamKey.trim()) {
      return 'Enter a stream key before streaming, or turn Stream RTMP off.'
    }
    if (!health) {
      return 'Checking FFmpeg before starting.'
    }
    if (!health.ffmpeg.available) {
      return health.ffmpeg.message ?? 'FFmpeg is not available.'
    }

    return null
  })()

  const startSession = useCallback(async () => {
    if (!client || startBlockedReason) {
      if (startBlockedReason && !isSessionActive) {
        reportError(new Error(startBlockedReason))
      }
      return
    }

    try {
      setLastError(null)
      setStreamHealth(null)
      setStreamTargets([])
      setStartRequestPending(true)
      setRecording((current) =>
        isActiveRecordingState(current.state)
          ? current
          : { state: 'starting', message: 'Starting capture session.' }
      )
      const status = await client.request<RecordingStatus>('session.start', sessionParams)
      setRecording(status)
      await refreshSessions(client)
    } catch (error) {
      reportError(error)
      setRecording((current) =>
        current.state === 'starting' && !current.sessionId
          ? { state: 'idle', message: 'Ready to start a capture session.' }
          : current
      )
    } finally {
      setStartRequestPending(false)
    }
  }, [client, isSessionActive, refreshSessions, reportError, sessionParams, startBlockedReason])

  const stopSession = useCallback(async () => {
    if (!client || stopRequestPending) {
      return
    }

    try {
      setLastError(null)
      setStopRequestPending(true)
      const status = await client.request<RecordingStatus>('session.stop')
      setRecording(status)
    } catch (error) {
      reportError(error)
    } finally {
      setStopRequestPending(false)
    }
  }, [client, reportError, stopRequestPending])

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
        const next: StreamTargetSettings = { ...target, ...patch, updatedAt: now }
        if (typeof patch.streamKey === 'string') {
          next.streamKeyPresent = patch.streamKey.trim().length > 0
        }
        return next
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
    settings,
    setSettings,
    captureConfig,
    setCaptureConfig,
    patchLayout,
    patchVideo,
    applyVideoPreset,
    applyRtmpPreset,
    patchStreamingTarget,
    lastError,
    runtimeInfo,
    refreshBackend,
    refreshScreens,
    importScreenImage,
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
