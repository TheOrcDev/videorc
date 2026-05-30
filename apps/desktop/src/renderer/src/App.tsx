import {
  Activity,
  AlertTriangle,
  Brain,
  CheckCircle2,
  CircleStop,
  Database,
  Download,
  FileVideo,
  Folder,
  LayoutTemplate,
  Mic,
  Monitor,
  Play,
  Radio,
  RefreshCcw,
  Settings,
  Wifi
} from 'lucide-react'
import type { Dispatch, ReactElement, ReactNode, SetStateAction } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import type {
  BackendConnection,
  BackendHealth,
  BackendLogEvent,
  AiArtifact,
  AiWorkflowResult,
  AudioMeterResult,
  CameraCorner,
  CameraShape,
  CameraSize,
  Device,
  DeviceList,
  ExportPublishPackResult,
  HealthEvent,
  LayoutSettings,
  PreviewSnapshot,
  RecordingStatus,
  RtmpPreset,
  SessionSummary,
  SourceSelection,
  StartSessionParams,
  StreamHealth,
  VideoPreset,
  VideoSettings
} from '../../shared/backend'
import { BackendClient } from './backendClient'

type SettingsState = {
  outputDirectory: string
  ffmpegPath: string
}

type CaptureConfig = {
  sources: SourceSelection
  layout: LayoutSettings
  video: VideoSettings
  recordEnabled: boolean
  streamEnabled: boolean
  rtmpPreset: RtmpPreset
  rtmpServerUrl: string
  streamKey: string
}

type WsStatus = 'waiting' | 'connecting' | 'connected' | 'failed' | 'closed'
type SetupTone = 'good' | 'warn' | 'neutral'
type SetupStep = {
  label: string
  detail: string
  tone: SetupTone
}

const defaultSettings: SettingsState = {
  outputDirectory: '',
  ffmpegPath: ''
}

const rtmpDefaults: Record<RtmpPreset, string> = {
  youtube: 'rtmp://a.rtmp.youtube.com/live2',
  twitch: 'rtmp://live.twitch.tv/app',
  x: '',
  custom: ''
}

const videoPresets: Record<VideoPreset, VideoSettings> = {
  'tutorial-1080p30': {
    preset: 'tutorial-1080p30',
    width: 1920,
    height: 1080,
    fps: 30,
    bitrateKbps: 6000
  },
  'tutorial-1440p30': {
    preset: 'tutorial-1440p30',
    width: 2560,
    height: 1440,
    fps: 30,
    bitrateKbps: 8000
  },
  'stream-1080p60': {
    preset: 'stream-1080p60',
    width: 1920,
    height: 1080,
    fps: 60,
    bitrateKbps: 9000
  },
  custom: {
    preset: 'custom',
    width: 1920,
    height: 1080,
    fps: 30,
    bitrateKbps: 6000
  }
}

const defaultCaptureConfig: CaptureConfig = {
  sources: {},
  layout: {
    cameraCorner: 'bottom-right',
    cameraSize: 'medium',
    cameraShape: 'rectangle',
    cameraMargin: 32
  },
  video: videoPresets['tutorial-1440p30'],
  recordEnabled: true,
  streamEnabled: false,
  rtmpPreset: 'youtube',
  rtmpServerUrl: rtmpDefaults.youtube,
  streamKey: ''
}

function loadJson<T>(key: string, fallback: T): T {
  const raw = localStorage.getItem(key)
  if (!raw) {
    return fallback
  }

  try {
    return { ...fallback, ...(JSON.parse(raw) as Partial<T>) }
  } catch {
    return fallback
  }
}

function loadCaptureConfig(): CaptureConfig {
  const loaded = loadJson('videogre.captureConfig', defaultCaptureConfig) as Partial<CaptureConfig>

  return {
    ...defaultCaptureConfig,
    ...loaded,
    sources: { ...defaultCaptureConfig.sources, ...(loaded.sources ?? {}) },
    layout: { ...defaultCaptureConfig.layout, ...(loaded.layout ?? {}) },
    video: normalizeVideoSettings(loaded.video),
    recordEnabled: typeof loaded.recordEnabled === 'boolean' ? loaded.recordEnabled : defaultCaptureConfig.recordEnabled,
    streamEnabled: typeof loaded.streamEnabled === 'boolean' ? loaded.streamEnabled : defaultCaptureConfig.streamEnabled,
    rtmpPreset: loaded.rtmpPreset ?? defaultCaptureConfig.rtmpPreset,
    rtmpServerUrl: loaded.rtmpServerUrl ?? defaultCaptureConfig.rtmpServerUrl,
    streamKey: loaded.streamKey ?? defaultCaptureConfig.streamKey
  }
}

function normalizeVideoSettings(video: unknown): VideoSettings {
  const candidate = video && typeof video === 'object' ? (video as Partial<VideoSettings>) : {}
  const preset =
    typeof candidate.preset === 'string' && candidate.preset in videoPresets
      ? (candidate.preset as VideoPreset)
      : defaultCaptureConfig.video.preset
  const fallback = videoPresets[preset]

  return {
    preset,
    width: clampNumber(candidate.width, fallback.width, 640, 3840),
    height: clampNumber(candidate.height, fallback.height, 360, 2160),
    fps: clampNumber(candidate.fps, fallback.fps, 24, 60),
    bitrateKbps: clampNumber(candidate.bitrateKbps, fallback.bitrateKbps, 1000, 50000)
  }
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    return fallback
  }

  return Math.min(max, Math.max(min, Math.round(parsed)))
}

function compactTime(timestamp: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    }).format(new Date(timestamp))
  } catch {
    return timestamp
  }
}

function dayLabel(timestamp: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(timestamp))
  } catch {
    return timestamp
  }
}

export function App(): ReactElement {
  const [connection, setConnection] = useState<BackendConnection | null>(null)
  const [client, setClient] = useState<BackendClient | null>(null)
  const [wsStatus, setWsStatus] = useState<WsStatus>('waiting')
  const [health, setHealth] = useState<BackendHealth | null>(null)
  const [deviceList, setDeviceList] = useState<DeviceList>({ devices: [], warnings: [] })
  const [recording, setRecording] = useState<RecordingStatus>({ state: 'idle', message: 'Ready.' })
  const [logs, setLogs] = useState<BackendLogEvent[]>([])
  const [healthEvents, setHealthEvents] = useState<HealthEvent[]>([])
  const [streamHealth, setStreamHealth] = useState<StreamHealth | null>(null)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [audioMeter, setAudioMeter] = useState<AudioMeterResult | null>(null)
  const [audioMeterLoading, setAudioMeterLoading] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [aiConsent, setAiConsent] = useState(false)
  const [aiRunningSessionId, setAiRunningSessionId] = useState<string | null>(null)
  const [exportRunningSessionId, setExportRunningSessionId] = useState<string | null>(null)
  const [startRequestPending, setStartRequestPending] = useState(false)
  const [stopRequestPending, setStopRequestPending] = useState(false)
  const [settings, setSettings] = useState<SettingsState>(() => loadJson('videogre.settings', defaultSettings))
  const [captureConfig, setCaptureConfig] = useState<CaptureConfig>(loadCaptureConfig)
  const [lastError, setLastError] = useState<string | null>(null)
  const [lastNotice, setLastNotice] = useState<string | null>(null)

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
      }
    }),
    [captureConfig, settings]
  )

  const appendLog = useCallback((log: BackendLogEvent) => {
    setLogs((current) => [...current.slice(-79), log])
  }, [])

  const refreshSessions = useCallback(async (activeClient: BackendClient | null) => {
    if (!activeClient) {
      return
    }

    const nextSessions = await activeClient.request<SessionSummary[]>('sessions.list')
    setSessions(nextSessions)
  }, [])

  useEffect(() => {
    localStorage.setItem('videogre.settings', JSON.stringify(settings))
  }, [settings])

  useEffect(() => {
    localStorage.setItem('videogre.captureConfig', JSON.stringify(captureConfig))
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

    window.videogre.getBackendLogs().then((backendLogs) => {
      if (!disposed) {
        setLogs(backendLogs.slice(-80))
      }
    })
    window.videogre.getBackendConnection().then((nextConnection) => {
      if (!disposed && nextConnection) {
        setConnection(nextConnection)
      }
    })

    const offConnection = window.videogre.onBackendConnection(setConnection)
    const offLog = window.videogre.onBackendLog(appendLog)

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

      nextSources.screenId ||= captureDevices[0]?.id
      nextSources.cameraId ||= cameras[0]?.id
      nextSources.microphoneId ||= microphones[0]?.id

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
          void refreshSessions(nextClient)
        }
      }),
      nextClient.on('health.event', (payload) => {
        setHealthEvents((current) => [payload as HealthEvent, ...current].slice(0, 40))
      }),
      nextClient.on('stream.health', (payload) => {
        setStreamHealth((current) => mergeStreamHealth(current, payload as StreamHealth))
      }),
      nextClient.on('ai.artifacts.changed', () => {
        void refreshSessions(nextClient)
      }),
      nextClient.on('log', (payload) => appendLog(payload as BackendLogEvent)),
      nextClient.on('error', (payload) => {
        const error = payload as { message?: string }
        setLastError(error.message ?? 'Backend error.')
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
        await refreshSessions(nextClient)
      })
      .catch((error: unknown) => {
        setWsStatus('failed')
        setLastError(error instanceof Error ? error.message : String(error))
      })

    return () => {
      for (const unsubscribe of unsubscribers) {
        unsubscribe()
      }
      nextClient.close()
      setClient(null)
    }
  }, [appendLog, connection, refreshSessions, settings.ffmpegPath])

  const refreshBackend = useCallback(async () => {
    if (!client) {
      return
    }

    try {
      setLastError(null)
      setLastNotice(null)
      const [nextHealth, nextDevices, nextSessions] = await Promise.all([
        client.request<BackendHealth>('health.ping', { ffmpegPath: settings.ffmpegPath.trim() || undefined }),
        client.request<DeviceList>('devices.list', { ffmpegPath: settings.ffmpegPath.trim() || undefined }),
        client.request<SessionSummary[]>('sessions.list')
      ])
      setHealth(nextHealth)
      setDeviceList(nextDevices)
      setSessions(nextSessions)
    } catch (error) {
      setLastError(error instanceof Error ? error.message : String(error))
    }
  }, [client, settings.ffmpegPath])

  const refreshPreview = useCallback(async () => {
    if (!client || wsStatus !== 'connected') {
      return
    }

    try {
      setPreviewLoading(true)
      setLastNotice(null)
      const snapshot = await client.request<PreviewSnapshot>('preview.snapshot', {
        sources: captureConfig.sources,
        layout: captureConfig.layout,
        ffmpegPath: settings.ffmpegPath.trim() || undefined
      })
      setPreviewUrl(`${snapshot.url}&cache=${Date.now()}`)
    } catch (error) {
      setLastError(error instanceof Error ? error.message : String(error))
    } finally {
      setPreviewLoading(false)
    }
  }, [captureConfig.layout, captureConfig.sources, client, settings.ffmpegPath, wsStatus])

  const sampleAudioMeter = useCallback(async () => {
    if (!client) {
      return
    }

    try {
      setLastError(null)
      setLastNotice(null)
      setAudioMeterLoading(true)
      const result = await client.request<AudioMeterResult>('audio.meter.sample', {
        microphoneId: captureConfig.sources.microphoneId,
        ffmpegPath: settings.ffmpegPath.trim() || undefined
      })
      setAudioMeter(result)
    } catch (error) {
      setLastError(error instanceof Error ? error.message : String(error))
    } finally {
      setAudioMeterLoading(false)
    }
  }, [captureConfig.sources.microphoneId, client, settings.ffmpegPath])

  useEffect(() => {
    if (!client || wsStatus !== 'connected') {
      return
    }

    const timer = window.setTimeout(() => {
      void refreshPreview()
    }, 800)

    return () => window.clearTimeout(timer)
  }, [client, refreshPreview, wsStatus])

  const outputEnabled = captureConfig.recordEnabled || captureConfig.streamEnabled
  const streamReady =
    !captureConfig.streamEnabled ||
    Boolean(captureConfig.rtmpServerUrl.trim() && captureConfig.streamKey.trim())
  const isSessionActive =
    isActiveRecordingState(recording.state) || startRequestPending || stopRequestPending
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
        setLastError(startBlockedReason)
      }
      return
    }

    try {
      setLastError(null)
      setLastNotice(null)
      setStreamHealth(null)
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
      setLastError(error instanceof Error ? error.message : String(error))
      setRecording((current) =>
        current.state === 'starting' && !current.sessionId
          ? { state: 'idle', message: 'Ready to start a capture session.' }
          : current
      )
    } finally {
      setStartRequestPending(false)
    }
  }, [client, isSessionActive, refreshSessions, sessionParams, startBlockedReason])

  const stopSession = useCallback(async () => {
    if (!client || stopRequestPending) {
      return
    }

    try {
      setLastError(null)
      setLastNotice(null)
      setStopRequestPending(true)
      const status = await client.request<RecordingStatus>('session.stop')
      setRecording(status)
    } catch (error) {
      setLastError(error instanceof Error ? error.message : String(error))
    } finally {
      setStopRequestPending(false)
    }
  }, [client, stopRequestPending])

  const remuxSession = useCallback(
    async (sessionId: string) => {
      if (!client) {
        return
      }

      try {
        setLastError(null)
        setLastNotice(null)
        await client.request('session.remux_mp4', {
          sessionId,
          ffmpegPath: settings.ffmpegPath.trim() || undefined
        })
        await refreshSessions(client)
      } catch (error) {
        setLastError(error instanceof Error ? error.message : String(error))
      }
    },
    [client, refreshSessions, settings.ffmpegPath]
  )

  const runAiWorkflow = useCallback(
    async (sessionId: string) => {
      if (!client) {
        return
      }

      try {
        setLastError(null)
        setLastNotice(null)
        setAiRunningSessionId(sessionId)
        await client.request<AiWorkflowResult>('ai.run_post_recording', {
          sessionId,
          consentToUploadAudio: aiConsent,
          ffmpegPath: settings.ffmpegPath.trim() || undefined
        })
        await refreshSessions(client)
      } catch (error) {
        setLastError(error instanceof Error ? error.message : String(error))
      } finally {
        setAiRunningSessionId(null)
      }
    },
    [aiConsent, client, refreshSessions, settings.ffmpegPath]
  )

  const exportPublishPack = useCallback(
    async (sessionId: string) => {
      if (!client) {
        return
      }

      try {
        setLastError(null)
        setLastNotice(null)
        setExportRunningSessionId(sessionId)
        const result = await client.request<ExportPublishPackResult>('ai.publish_pack.export', {
          sessionId
        })
        setLastNotice(`Publish pack exported to ${result.markdownPath}`)
      } catch (error) {
        setLastError(error instanceof Error ? error.message : String(error))
      } finally {
        setExportRunningSessionId(null)
      }
    },
    [client]
  )

  const canStart = !startBlockedReason
  const canStop =
    wsStatus === 'connected' &&
    ['recording', 'streaming', 'starting'].includes(recording.state) &&
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
      if (event.repeat || isEditableTarget(event.target)) {
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
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [canStart, canStop, refreshPreview, startSession, stopSession])

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <div className="brand-row">
            <Radio aria-hidden="true" size={26} />
            <h1>Videogre</h1>
          </div>
          <p className="subhead">Capture session foundation</p>
        </div>
        <div className="topbar-actions">
          <StatusPill label="Backend" value={connection ? `${connection.host}:${connection.port}` : 'launching'} />
          <StatusPill label="Socket" value={wsStatus} tone={wsStatus === 'connected' ? 'good' : 'warn'} />
          <button className="icon-button" type="button" onClick={refreshBackend} title="Refresh backend">
            <RefreshCcw size={18} />
          </button>
        </div>
      </header>

      <section className="studio-grid phase-two-grid">
        <Panel className="control-panel" title="Session" icon={Activity}>
          <div className="recording-state">
            <span className={`record-dot ${recording.state}`} />
            <div>
              <strong>{recording.state}</strong>
              <span>{recording.message ?? 'Idle'}</span>
            </div>
            <time className="recording-timer">{elapsed}</time>
          </div>

          <div className="transport-row">
            <button
              className="primary-action"
              type="button"
              disabled={!canStart}
              onClick={startSession}
              title={startBlockedReason ?? 'Start session'}
            >
              <Play size={18} />
              {startRequestPending ? 'Starting...' : 'Start session'}
            </button>
            <button className="secondary-action" type="button" disabled={!canStop} onClick={stopSession}>
              <CircleStop size={18} />
              {stopRequestPending ? 'Stopping...' : 'Stop'}
            </button>
          </div>

          <div className="output-box">
            <Folder aria-hidden="true" size={18} />
            <span>{recording.outputPath ?? recording.streamUrl ?? 'Output appears after session start.'}</span>
          </div>

          {lastError ? (
            <div className="notice error">
              <AlertTriangle aria-hidden="true" size={18} />
              <span>{lastError}</span>
            </div>
          ) : null}
          {visibleStartBlockedReason ? (
            <div className="notice warn">
              <AlertTriangle aria-hidden="true" size={18} />
              <span>{visibleStartBlockedReason}</span>
            </div>
          ) : null}
          {lastNotice ? (
            <div className="notice good">
              <CheckCircle2 aria-hidden="true" size={18} />
              <span>{lastNotice}</span>
            </div>
          ) : null}
        </Panel>

        <Panel className="setup-panel" title="Setup" icon={Mic}>
          <div className="setup-list">
            {setupSteps.map((step) => (
              <SetupRow key={step.label} step={step} />
            ))}
          </div>
          <div className="meter-card">
            <div className="meter-header">
              <span>Microphone</span>
              <strong>{formatDb(audioMeter?.peakDb)}</strong>
            </div>
            <div className="meter-track">
              <div className={`meter-fill ${audioMeter?.status ?? 'unavailable'}`} style={{ width: `${meterLevel}%` }} />
            </div>
            <p>{audioMeter?.message ?? (selectedMicrophone ? selectedMicrophone.name : 'No microphone selected.')}</p>
            <button className="secondary-action meter-action" disabled={!canSampleAudio || audioMeterLoading} type="button" onClick={sampleAudioMeter}>
              {audioMeterLoading ? 'Checking' : 'Check mic'}
            </button>
          </div>
        </Panel>

        <Panel title="Outputs" icon={Wifi}>
          <div className="toggle-row">
            <label>
              <input
                checked={captureConfig.recordEnabled}
                type="checkbox"
                onChange={(event) =>
                  setCaptureConfig((current) => ({ ...current, recordEnabled: event.target.checked }))
                }
              />
              <span>Record MKV</span>
            </label>
            <label>
              <input
                checked={captureConfig.streamEnabled}
                type="checkbox"
                onChange={(event) =>
                  setCaptureConfig((current) => ({ ...current, streamEnabled: event.target.checked }))
                }
              />
              <span>Stream RTMP</span>
            </label>
          </div>
          <label className="field">
            <span>Video preset</span>
            <select
              value={captureConfig.video.preset}
              onChange={(event) => {
                const preset = event.target.value as VideoPreset
                setCaptureConfig((current) => ({
                  ...current,
                  video: videoPresets[preset]
                }))
              }}
            >
              <option value="tutorial-1440p30">Tutorial 1440p30</option>
              <option value="tutorial-1080p30">Tutorial 1080p30</option>
              <option value="stream-1080p60">Stream 1080p60</option>
              <option value="custom">Custom</option>
            </select>
          </label>
          <div className="video-grid">
            <label className="field">
              <span>Width</span>
              <input
                min={640}
                max={3840}
                type="number"
                value={captureConfig.video.width}
                onChange={(event) => updateVideo(setCaptureConfig, { width: Number(event.target.value) })}
              />
            </label>
            <label className="field">
              <span>Height</span>
              <input
                min={360}
                max={2160}
                type="number"
                value={captureConfig.video.height}
                onChange={(event) => updateVideo(setCaptureConfig, { height: Number(event.target.value) })}
              />
            </label>
            <label className="field">
              <span>FPS</span>
              <input
                min={24}
                max={60}
                type="number"
                value={captureConfig.video.fps}
                onChange={(event) => updateVideo(setCaptureConfig, { fps: Number(event.target.value) })}
              />
            </label>
            <label className="field">
              <span>Bitrate kbps</span>
              <input
                min={1000}
                max={50000}
                step={500}
                type="number"
                value={captureConfig.video.bitrateKbps}
                onChange={(event) => updateVideo(setCaptureConfig, { bitrateKbps: Number(event.target.value) })}
              />
            </label>
          </div>
          <div className="stream-health-card">
            <span>Output health</span>
            <div>
              <strong>{formatMetric(streamHealth?.fps, 'fps')}</strong>
              <strong>{formatDroppedFrames(streamHealth?.droppedFrames)}</strong>
              <strong>{formatMetric(streamHealth?.speed, 'x')}</strong>
            </div>
          </div>
          <label className="field">
            <span>RTMP preset</span>
            <select
              value={captureConfig.rtmpPreset}
              onChange={(event) => {
                const preset = event.target.value as RtmpPreset
                setCaptureConfig((current) => ({
                  ...current,
                  rtmpPreset: preset,
                  rtmpServerUrl: rtmpDefaults[preset] || current.rtmpServerUrl
                }))
              }}
            >
              <option value="youtube">YouTube</option>
              <option value="twitch">Twitch</option>
              <option value="x">X / Twitter</option>
              <option value="custom">Custom RTMP</option>
            </select>
          </label>
          <label className="field">
            <span>RTMP server</span>
            <input
              value={captureConfig.rtmpServerUrl}
              placeholder="rtmp://server/app"
              onChange={(event) => setCaptureConfig((current) => ({ ...current, rtmpServerUrl: event.target.value }))}
            />
          </label>
          <label className="field">
            <span>Stream key</span>
            <input
              value={captureConfig.streamKey}
              placeholder="manual stream key"
              type="password"
              onChange={(event) => setCaptureConfig((current) => ({ ...current, streamKey: event.target.value }))}
            />
          </label>
        </Panel>

        <Panel className="devices-panel" title="Sources" icon={Monitor}>
          {deviceList.warnings.map((warning) => (
            <div className="notice warn" key={warning}>
              <AlertTriangle aria-hidden="true" size={18} />
              <span>{warning}</span>
            </div>
          ))}
          <SourceSelect
            devices={deviceList.devices.filter((device) => ['screen', 'window'].includes(device.kind))}
            label="Screen / window"
            value={captureConfig.sources.screenId}
            onChange={(screenId) =>
              setCaptureConfig((current) => ({
                ...current,
                sources: { ...current.sources, screenId, windowId: undefined }
              }))
            }
          />
          <SourceSelect
            allowNone
            devices={deviceList.devices.filter((device) => device.kind === 'camera')}
            label="Camera"
            value={captureConfig.sources.cameraId}
            onChange={(cameraId) =>
              setCaptureConfig((current) => ({ ...current, sources: { ...current.sources, cameraId } }))
            }
          />
          <SourceSelect
            allowNone
            devices={deviceList.devices.filter((device) => device.kind === 'microphone')}
            label="Microphone"
            value={captureConfig.sources.microphoneId}
            onChange={(microphoneId) =>
              setCaptureConfig((current) => ({ ...current, sources: { ...current.sources, microphoneId } }))
            }
          />
        </Panel>

        <Panel title="Layout" icon={LayoutTemplate}>
          <div className="preview-stage">
            {previewUrl ? (
              <img alt="Selected scene preview" className="preview-image" src={previewUrl} />
            ) : (
              <div className="preview-placeholder">
                <div
                  className={`camera-preview ${captureConfig.layout.cameraCorner} ${captureConfig.layout.cameraSize} ${captureConfig.layout.cameraShape}`}
                  style={{ margin: captureConfig.layout.cameraMargin }}
                />
              </div>
            )}
            {previewLoading ? <div className="preview-badge">Refreshing</div> : null}
          </div>
          <button className="secondary-action preview-refresh" type="button" onClick={refreshPreview}>
            <RefreshCcw size={16} />
            Refresh preview
          </button>
          <div className="layout-grid">
            <label className="field">
              <span>Corner</span>
              <select
                value={captureConfig.layout.cameraCorner}
                onChange={(event) => updateLayout(setCaptureConfig, { cameraCorner: event.target.value as CameraCorner })}
              >
                <option value="top-left">Top-left</option>
                <option value="top-right">Top-right</option>
                <option value="bottom-left">Bottom-left</option>
                <option value="bottom-right">Bottom-right</option>
              </select>
            </label>
            <label className="field">
              <span>Size</span>
              <select
                value={captureConfig.layout.cameraSize}
                onChange={(event) => updateLayout(setCaptureConfig, { cameraSize: event.target.value as CameraSize })}
              >
                <option value="small">Small</option>
                <option value="medium">Medium</option>
                <option value="large">Large</option>
              </select>
            </label>
            <label className="field">
              <span>Shape</span>
              <select
                value={captureConfig.layout.cameraShape}
                onChange={(event) => updateLayout(setCaptureConfig, { cameraShape: event.target.value as CameraShape })}
              >
                <option value="rectangle">Rectangle</option>
                <option value="circle">Circle</option>
              </select>
            </label>
            <label className="field">
              <span>Margin {captureConfig.layout.cameraMargin}px</span>
              <input
                max={96}
                min={8}
                type="range"
                value={captureConfig.layout.cameraMargin}
                onChange={(event) => updateLayout(setCaptureConfig, { cameraMargin: Number(event.target.value) })}
              />
            </label>
          </div>
        </Panel>

        <Panel title="Settings" icon={Settings}>
          <label className="field">
            <span>Output directory</span>
            <input
              value={settings.outputDirectory}
              placeholder="~/Movies/Videogre/Recordings"
              onChange={(event) => setSettings((current) => ({ ...current, outputDirectory: event.target.value }))}
            />
          </label>
          <label className="field">
            <span>FFmpeg path</span>
            <input
              value={settings.ffmpegPath}
              placeholder="ffmpeg"
              onChange={(event) => setSettings((current) => ({ ...current, ffmpegPath: event.target.value }))}
            />
          </label>
          <div className={`tool-status ${health?.ffmpeg.available ? 'good' : 'warn'}`}>
            {health?.ffmpeg.available ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}
            <span>{health?.ffmpeg.version ?? health?.ffmpeg.message ?? 'Waiting for FFmpeg status.'}</span>
          </div>
          <div className="output-box database-path">
            <Database aria-hidden="true" size={18} />
            <span>{health?.databasePath ?? 'Waiting for SQLite path.'}</span>
          </div>
        </Panel>

        <Panel className="health-panel" title="Health" icon={AlertTriangle}>
          <div className="health-list">
            {healthEvents.length === 0 ? (
              <div className="empty-state">No health events yet.</div>
            ) : (
              healthEvents.map((event) => <HealthRow event={event} key={event.id} />)
            )}
          </div>
        </Panel>

        <Panel className="ai-panel" title="AI Publish Pack" icon={Brain}>
          <label className="consent-box">
            <input
              checked={aiConsent}
              type="checkbox"
              onChange={(event) => setAiConsent(event.target.checked)}
            />
            <span>Allow cloud AI to upload extracted audio and transcript for summaries and chapters.</span>
          </label>
          <div className="notice warn">
            <AlertTriangle aria-hidden="true" size={18} />
            <span>Recordings stay local by default. Without consent, Videogre only extracts local audio.</span>
          </div>
          <div className="ai-model-note">
            Uses OPENAI_API_KEY when present. Artifacts are stored locally with each session.
          </div>
        </Panel>

        <Panel className="sessions-panel" title="Session Library" icon={FileVideo}>
          <div className="session-list">
            {sessions.length === 0 ? (
              <div className="empty-state">No sessions yet.</div>
            ) : (
              sessions.map((session) => (
                <SessionRow
                  aiRunning={aiRunningSessionId === session.id}
                  exportRunning={exportRunningSessionId === session.id}
                  key={session.id}
                  onExportPublishPack={() => exportPublishPack(session.id)}
                  onRunAi={() => runAiWorkflow(session.id)}
                  onRemux={() => remuxSession(session.id)}
                  session={session}
                />
              ))
            )}
          </div>
        </Panel>

        <Panel className="logs-panel" title="Backend Log" icon={Activity}>
          <div className="log-list">
            {logs.length === 0 ? (
              <div className="empty-state">Waiting for backend logs.</div>
            ) : (
              logs.map((log, index) => (
                <div className={`log-line ${log.level}`} key={`${log.timestamp}-${index}`}>
                  <time>{compactTime(log.timestamp)}</time>
                  <span>{log.level}</span>
                  <p>{log.message}</p>
                </div>
              ))
            )}
          </div>
        </Panel>
      </section>
    </main>
  )
}

function updateLayout(
  setCaptureConfig: Dispatch<SetStateAction<CaptureConfig>>,
  patch: Partial<LayoutSettings>
): void {
  setCaptureConfig((current) => ({ ...current, layout: { ...current.layout, ...patch } }))
}

function updateVideo(
  setCaptureConfig: Dispatch<SetStateAction<CaptureConfig>>,
  patch: Partial<VideoSettings>
): void {
  setCaptureConfig((current) => ({
    ...current,
    video: {
      ...current.video,
      ...patch,
      preset: 'custom'
    }
  }))
}

function Panel({
  children,
  className,
  icon: Icon,
  title
}: {
  children: ReactNode
  className?: string
  icon: typeof Activity
  title: string
}): ReactElement {
  return (
    <section className={`panel ${className ?? ''}`}>
      <header className="panel-header">
        <Icon aria-hidden="true" size={18} />
        <h2>{title}</h2>
      </header>
      {children}
    </section>
  )
}

function StatusPill({
  label,
  tone = 'neutral',
  value
}: {
  label: string
  tone?: 'good' | 'warn' | 'neutral'
  value: string
}): ReactElement {
  return (
    <div className={`status-pill ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function SetupRow({ step }: { step: SetupStep }): ReactElement {
  return (
    <article className={`setup-row ${step.tone}`}>
      <span className="setup-dot" />
      <div>
        <strong>{step.label}</strong>
        <p>{step.detail}</p>
      </div>
    </article>
  )
}

function setupChecklist({
  audioMeter,
  captureConfig,
  health,
  selectedCamera,
  selectedCaptureDevice,
  selectedMicrophone,
  streamReady,
  wsStatus
}: {
  audioMeter: AudioMeterResult | null
  captureConfig: CaptureConfig
  health: BackendHealth | null
  selectedCamera?: Device
  selectedCaptureDevice?: Device
  selectedMicrophone?: Device
  streamReady: boolean
  wsStatus: WsStatus
}): SetupStep[] {
  const microphoneTone: SetupTone =
    audioMeter?.status === 'ready'
      ? 'good'
      : audioMeter?.status === 'silent' || audioMeter?.status === 'permission-required' || !selectedMicrophone
        ? 'warn'
        : 'neutral'

  return [
    {
      label: 'Backend',
      detail: wsStatus === 'connected' ? 'Local backend is connected.' : `Socket is ${wsStatus}.`,
      tone: wsStatus === 'connected' ? 'good' : 'warn'
    },
    {
      label: 'FFmpeg',
      detail: health?.ffmpeg.available ? health.ffmpeg.version ?? 'FFmpeg is available.' : health?.ffmpeg.message ?? 'Waiting for FFmpeg.',
      tone: health?.ffmpeg.available ? 'good' : 'warn'
    },
    {
      label: 'Capture',
      detail: selectedCaptureDevice ? selectedCaptureDevice.name : 'No screen or window source selected.',
      tone: selectedCaptureDevice?.status === 'available' ? 'good' : 'warn'
    },
    {
      label: 'Camera',
      detail: selectedCamera ? selectedCamera.name : 'Camera overlay is off.',
      tone: selectedCamera?.status === 'available' || !selectedCamera ? 'good' : 'warn'
    },
    {
      label: 'Microphone',
      detail: audioMeter?.message ?? (selectedMicrophone ? selectedMicrophone.name : 'No microphone selected.'),
      tone: microphoneTone
    },
    {
      label: 'Output',
      detail: captureConfig.recordEnabled
        ? captureConfig.streamEnabled
          ? `${captureConfig.video.width}x${captureConfig.video.height} ${captureConfig.video.fps} FPS record+stream.`
          : `${captureConfig.video.width}x${captureConfig.video.height} ${captureConfig.video.fps} FPS recording.`
        : captureConfig.streamEnabled
          ? `${captureConfig.video.width}x${captureConfig.video.height} ${captureConfig.video.fps} FPS streaming.`
          : 'No output is enabled.',
      tone: captureConfig.recordEnabled || captureConfig.streamEnabled ? 'good' : 'warn'
    },
    {
      label: 'Stream',
      detail: captureConfig.streamEnabled ? (streamReady ? 'RTMP target is set.' : 'RTMP server and stream key are required.') : 'Streaming is off.',
      tone: streamReady ? 'good' : 'warn'
    }
  ]
}

function SourceSelect({
  allowNone = false,
  devices,
  label,
  onChange,
  value
}: {
  allowNone?: boolean
  devices: Device[]
  label: string
  onChange: (value: string | undefined) => void
  value?: string
}): ReactElement {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value ?? ''} onChange={(event) => onChange(event.target.value || undefined)}>
        {allowNone ? <option value="">None</option> : null}
        {devices.map((device) => (
          <option disabled={device.status !== 'available'} key={device.id} value={device.id}>
            {device.name} {device.status !== 'available' ? `(${device.status})` : ''}
          </option>
        ))}
      </select>
    </label>
  )
}

function findDevice(devices: Device[], id?: string): Device | undefined {
  return id ? devices.find((device) => device.id === id) : undefined
}

function durationLabel(startedAt: string, now: number): string {
  const started = new Date(startedAt).getTime()
  if (!Number.isFinite(started)) {
    return '00:00'
  }

  const totalSeconds = Math.max(0, Math.floor((now - started) / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
}

function formatDb(value?: number): string {
  return typeof value === 'number' ? `${value.toFixed(1)} dB` : 'Not checked'
}

function formatMetric(value: number | undefined, suffix: string): string {
  return typeof value === 'number' ? `${value.toFixed(suffix === 'fps' ? 1 : 2)} ${suffix}` : `-- ${suffix}`
}

function formatDroppedFrames(value: number | undefined): string {
  return typeof value === 'number' ? `${value} drop` : '-- drop'
}

function mergeStreamHealth(current: StreamHealth | null, update: StreamHealth): StreamHealth {
  if (!current || current.sessionId !== update.sessionId) {
    return update
  }

  return {
    ...current,
    ...update,
    fps: update.fps ?? current.fps,
    droppedFrames: update.droppedFrames ?? current.droppedFrames,
    speed: update.speed ?? current.speed
  }
}

function isActiveRecordingState(state: RecordingStatus['state']): boolean {
  return ['recording', 'streaming', 'starting', 'stopping'].includes(state)
}

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    ? Boolean(target.closest('input, textarea, select, button, [contenteditable="true"]'))
    : false
}

function HealthRow({ event }: { event: HealthEvent }): ReactElement {
  return (
    <article className={`health-row ${event.level}`}>
      <span>{event.level}</span>
      <div>
        <strong>{event.code}</strong>
        <p>{event.message}</p>
      </div>
      <time>{compactTime(event.createdAt)}</time>
    </article>
  )
}

function SessionRow({
  aiRunning,
  exportRunning,
  onExportPublishPack,
  onRunAi,
  onRemux,
  session
}: {
  aiRunning: boolean
  exportRunning: boolean
  onExportPublishPack: () => void
  onRunAi: () => void
  onRemux: () => void
  session: SessionSummary
}): ReactElement {
  const canRemux = Boolean(session.status === 'completed' && session.outputPath?.endsWith('.mkv') && !session.mp4Path)
  const canRunAi = Boolean(session.status === 'completed' && session.outputPath)
  const titleDescription = latestArtifact(session, 'title-description')
  const transcript = latestArtifact(session, 'transcript')
  const latestSummary = latestArtifact(session, 'summary')
  const chapters = latestArtifact(session, 'chapters')
  const artifactStatus = session.aiArtifacts.at(-1)?.status
  const canExportPublishPack = Boolean(
    session.aiArtifacts.some((artifact) => artifact.status === 'ready' && artifact.kind !== 'audio-extract')
  )
  const titleSuggestion = titleDescription ? artifactField(titleDescription, 'title') : ''
  const descriptionSuggestion = titleDescription ? artifactField(titleDescription, 'description') : ''
  const chapterItems = chapters ? artifactChapters(chapters) : []

  return (
    <article className="session-row">
      <div className="session-main">
        <strong>{session.title}</strong>
        <span>
          {dayLabel(session.startedAt)} · {session.mode} · {session.status}
        </span>
        <p>{session.outputPath ?? session.streamPreset ?? 'No local file'}</p>
        {titleSuggestion ? <p className="session-title-suggestion">Suggested: {titleSuggestion}</p> : null}
        {latestSummary ? <p className="session-summary">{artifactText(latestSummary)}</p> : null}
        {session.aiArtifacts.length ? (
          <details className="publish-pack">
            <summary>Publish pack</summary>
            <div className="publish-pack-content">
              {titleSuggestion || descriptionSuggestion ? (
                <section className="pack-section">
                  <strong>Title and description</strong>
                  {titleSuggestion ? <p>{titleSuggestion}</p> : null}
                  {descriptionSuggestion ? <p>{descriptionSuggestion}</p> : null}
                </section>
              ) : null}
              {latestSummary ? (
                <section className="pack-section">
                  <strong>Summary</strong>
                  <p>{artifactText(latestSummary)}</p>
                </section>
              ) : null}
              {chapterItems.length ? (
                <section className="pack-section">
                  <strong>Chapters</strong>
                  <ol className="chapter-list">
                    {chapterItems.map((chapter) => (
                      <li key={`${chapter.timestamp}-${chapter.title}`}>
                        <time>{chapter.timestamp}</time>
                        <span>{chapter.title}</span>
                      </li>
                    ))}
                  </ol>
                </section>
              ) : null}
              {transcript ? (
                <section className="pack-section">
                  <strong>Transcript</strong>
                  <p className="transcript-preview">{artifactText(transcript)}</p>
                </section>
              ) : null}
            </div>
          </details>
        ) : null}
      </div>
      <div className="session-actions">
        {session.healthEvents.length ? <span className="health-count">{session.healthEvents.length} health</span> : null}
        {session.aiArtifacts.length ? (
          <span className={`ai-chip ${artifactStatus ?? 'pending-consent'}`}>
            {session.aiArtifacts.length} AI
          </span>
        ) : null}
        {session.mp4Path ? <span className="mp4-chip">MP4</span> : null}
        <button className="small-action ai-action" disabled={!canRunAi || aiRunning} type="button" onClick={onRunAi}>
          {aiRunning ? 'AI...' : 'AI'}
        </button>
        <button
          className="small-action export-action"
          disabled={!canExportPublishPack || exportRunning}
          title="Export publish pack"
          type="button"
          onClick={onExportPublishPack}
        >
          <Download aria-hidden="true" size={14} />
          {exportRunning ? '...' : 'Pack'}
        </button>
        <button className="small-action" disabled={!canRemux} type="button" onClick={onRemux}>
          MP4
        </button>
      </div>
    </article>
  )
}

function latestArtifact(session: SessionSummary, kind: AiArtifact['kind']): AiArtifact | undefined {
  return session.aiArtifacts.filter((artifact) => artifact.kind === kind && artifact.status === 'ready').at(-1)
}

function artifactField(artifact: AiArtifact, field: string): string {
  if (typeof artifact.content !== 'object' || artifact.content === null) {
    return ''
  }

  const value = (artifact.content as Record<string, unknown>)[field]
  return typeof value === 'string' ? value : ''
}

function artifactChapters(artifact: AiArtifact): Array<{ timestamp: string; title: string }> {
  if (typeof artifact.content !== 'object' || artifact.content === null) {
    return []
  }

  const chapters = (artifact.content as Record<string, unknown>).chapters
  if (!Array.isArray(chapters)) {
    return []
  }

  return chapters.flatMap((chapter) => {
    if (typeof chapter !== 'object' || chapter === null) {
      return []
    }

    const item = chapter as Record<string, unknown>
    return typeof item.timestamp === 'string' && typeof item.title === 'string'
      ? [{ timestamp: item.timestamp, title: item.title }]
      : []
  })
}

function artifactText(artifact: AiArtifact): string {
  if (typeof artifact.content !== 'object' || artifact.content === null) {
    return ''
  }

  const content = artifact.content as Record<string, unknown>
  const text = content.text
  const message = content.message

  if (typeof text === 'string') {
    return text
  }

  if (typeof message === 'string') {
    return message
  }

  return artifact.status
}
