import {
  Activity,
  AlertTriangle,
  Brain,
  CheckCircle2,
  CircleStop,
  Database,
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
  CameraCorner,
  CameraShape,
  CameraSize,
  Device,
  DeviceList,
  HealthEvent,
  LayoutSettings,
  PreviewSnapshot,
  RecordingStatus,
  RtmpPreset,
  SessionSummary,
  SourceSelection,
  StartSessionParams
} from '../../shared/backend'
import { BackendClient } from './backendClient'

type SettingsState = {
  outputDirectory: string
  ffmpegPath: string
}

type CaptureConfig = {
  sources: SourceSelection
  layout: LayoutSettings
  recordEnabled: boolean
  streamEnabled: boolean
  rtmpPreset: RtmpPreset
  rtmpServerUrl: string
  streamKey: string
}

type WsStatus = 'waiting' | 'connecting' | 'connected' | 'failed' | 'closed'

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

const defaultCaptureConfig: CaptureConfig = {
  sources: {},
  layout: {
    cameraCorner: 'bottom-right',
    cameraSize: 'medium',
    cameraShape: 'rectangle',
    cameraMargin: 32
  },
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
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [aiConsent, setAiConsent] = useState(false)
  const [aiRunningSessionId, setAiRunningSessionId] = useState<string | null>(null)
  const [settings, setSettings] = useState<SettingsState>(() => loadJson('videogre.settings', defaultSettings))
  const [captureConfig, setCaptureConfig] = useState<CaptureConfig>(() =>
    loadJson('videogre.captureConfig', defaultCaptureConfig)
  )
  const [lastError, setLastError] = useState<string | null>(null)

  const sessionParams = useMemo<StartSessionParams>(
    () => ({
      sources: captureConfig.sources,
      layout: captureConfig.layout,
      output: {
        recordEnabled: captureConfig.recordEnabled,
        streamEnabled: captureConfig.streamEnabled,
        outputDirectory: settings.outputDirectory.trim() || undefined,
        ffmpegPath: settings.ffmpegPath.trim() || undefined,
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

  useEffect(() => {
    if (!client || wsStatus !== 'connected') {
      return
    }

    const timer = window.setTimeout(() => {
      void refreshPreview()
    }, 800)

    return () => window.clearTimeout(timer)
  }, [client, refreshPreview, wsStatus])

  const startSession = useCallback(async () => {
    if (!client) {
      return
    }

    try {
      setLastError(null)
      const status = await client.request<RecordingStatus>('session.start', sessionParams)
      setRecording(status)
      await refreshSessions(client)
    } catch (error) {
      setLastError(error instanceof Error ? error.message : String(error))
    }
  }, [client, refreshSessions, sessionParams])

  const stopSession = useCallback(async () => {
    if (!client) {
      return
    }

    try {
      setLastError(null)
      const status = await client.request<RecordingStatus>('session.stop')
      setRecording(status)
    } catch (error) {
      setLastError(error instanceof Error ? error.message : String(error))
    }
  }, [client])

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

  const canStart =
    wsStatus === 'connected' &&
    !['recording', 'streaming', 'starting', 'stopping'].includes(recording.state) &&
    (captureConfig.recordEnabled || captureConfig.streamEnabled)
  const canStop = wsStatus === 'connected' && ['recording', 'streaming', 'starting'].includes(recording.state)

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
          </div>

          <div className="transport-row">
            <button className="primary-action" type="button" disabled={!canStart} onClick={startSession}>
              <Play size={18} />
              Start session
            </button>
            <button className="secondary-action" type="button" disabled={!canStop} onClick={stopSession}>
              <CircleStop size={18} />
              Stop
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
                  key={session.id}
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
  onRunAi,
  onRemux,
  session
}: {
  aiRunning: boolean
  onRunAi: () => void
  onRemux: () => void
  session: SessionSummary
}): ReactElement {
  const canRemux = Boolean(session.status === 'completed' && session.outputPath?.endsWith('.mkv') && !session.mp4Path)
  const canRunAi = Boolean(session.status === 'completed' && session.outputPath)
  const summaryArtifacts = session.aiArtifacts.filter((artifact) => artifact.kind === 'summary')
  const latestSummary = summaryArtifacts[summaryArtifacts.length - 1]
  const artifactStatus = session.aiArtifacts.at(-1)?.status

  return (
    <article className="session-row">
      <div className="session-main">
        <strong>{session.title}</strong>
        <span>
          {dayLabel(session.startedAt)} · {session.mode} · {session.status}
        </span>
        <p>{session.outputPath ?? session.streamPreset ?? 'No local file'}</p>
        {latestSummary ? <p className="session-summary">{artifactText(latestSummary)}</p> : null}
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
        <button className="small-action" disabled={!canRemux} type="button" onClick={onRemux}>
          MP4
        </button>
      </div>
    </article>
  )
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
