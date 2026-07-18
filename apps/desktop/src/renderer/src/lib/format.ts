import type {
  AiArtifact,
  AudioMeterResult,
  BackendHealth,
  Device,
  RecordingStatus,
  SessionWithDetails,
  StreamHealth
} from '../../../shared/backend'
import { isActiveRecordingState as isSharedActiveRecordingState } from '../../../shared/capture-state'
import type { CaptureConfig, SetupStep, SetupTone, WsStatus } from './capture'

export function compactTime(timestamp: string): string {
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

export function dayLabel(timestamp: string): string {
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

export function durationLabel(startedAt: string, now: number): string {
  const started = new Date(startedAt).getTime()
  if (!Number.isFinite(started)) {
    return '00:00'
  }

  const totalSeconds = Math.max(0, Math.floor((now - started) / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
}

export function durationMsLabel(durationMs?: number): string {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs)) {
    return '--:--'
  }

  const totalSeconds = Math.max(0, Math.round(durationMs / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  if (hours > 0) {
    const minutes = Math.floor((totalSeconds % 3600) / 60)
    const hourLabel = formatDurationUnit(hours, 'hour')
    return minutes > 0 ? `${hourLabel} and ${formatDurationUnit(minutes, 'minute')}` : hourLabel
  }

  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
}

function formatDurationUnit(value: number, unit: 'hour' | 'minute'): string {
  return `${value} ${unit}${value === 1 ? '' : 's'}`
}

export function formatDb(value?: number): string {
  return typeof value === 'number' ? `${value.toFixed(1)} dB` : 'Not checked'
}

export function formatMetric(value: number | undefined, suffix: string): string {
  return typeof value === 'number'
    ? `${value.toFixed(suffix === 'fps' ? 1 : 2)} ${suffix}`
    : `-- ${suffix}`
}

export function formatDroppedFrames(value: number | undefined): string {
  return typeof value === 'number' ? `${value} drop` : '-- drop'
}

export function mergeStreamHealth(
  current: StreamHealth | null,
  update: StreamHealth
): StreamHealth {
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

export function isActiveRecordingState(state: RecordingStatus['state']): boolean {
  return isSharedActiveRecordingState(state)
}

export function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    ? Boolean(target.closest('input, textarea, select, button, [contenteditable="true"]'))
    : false
}

export function findDevice(devices: Device[], id?: string): Device | undefined {
  return id ? devices.find((device) => device.id === id) : undefined
}

export function setupChecklist({
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
      : audioMeter?.status === 'silent' ||
          audioMeter?.status === 'no-frames' ||
          audioMeter?.status === 'permission-required' ||
          !selectedMicrophone
        ? 'warn'
        : 'neutral'

  return [
    {
      label: 'Backend',
      detail:
        wsStatus === 'connected'
          ? 'Local backend is connected.'
          : wsStatus === 'waiting' || wsStatus === 'connecting'
            ? 'Connecting to the local backend…'
            : 'Backend not connected — it restarts automatically; give it a moment.',
      tone: wsStatus === 'connected' ? 'good' : 'warn'
    },
    {
      label: 'FFmpeg',
      detail: health?.ffmpeg.available
        ? (health.ffmpeg.version ?? 'FFmpeg is available.')
        : (health?.ffmpeg.message ?? 'Waiting for FFmpeg.'),
      tone: health?.ffmpeg.available ? 'good' : 'warn'
    },
    {
      label: 'Capture',
      detail: selectedCaptureDevice
        ? selectedCaptureDevice.name
        : 'No screen or window source selected.',
      tone: selectedCaptureDevice?.status === 'available' ? 'good' : 'warn'
    },
    {
      label: 'Camera',
      detail: selectedCamera ? selectedCamera.name : 'Camera overlay is off.',
      tone: selectedCamera?.status === 'available' || !selectedCamera ? 'good' : 'warn'
    },
    {
      label: 'Microphone',
      detail:
        audioMeter?.message ??
        (selectedMicrophone ? selectedMicrophone.name : 'No microphone selected.'),
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
      detail: captureConfig.streamEnabled
        ? streamReady
          ? 'RTMP target is set.'
          : 'Manual RTMP credentials are required.'
        : 'Streaming is off.',
      tone: streamReady ? 'good' : 'warn'
    }
  ]
}

export function latestArtifact(
  session: SessionWithDetails,
  kind: AiArtifact['kind']
): AiArtifact | undefined {
  return session.aiArtifacts
    .filter((artifact) => artifact.kind === kind && artifact.status === 'ready')
    .at(-1)
}

// The pipeline cards need the run's OUTCOME even when a step produced no
// reviewable content — a pending-consent or failed stub is the proof a run
// happened. The ready-only lookup above made finished runs read as "Not run".
export function latestArtifactAnyStatus(
  session: SessionWithDetails,
  kind: AiArtifact['kind']
): AiArtifact | undefined {
  return session.aiArtifacts.filter((artifact) => artifact.kind === kind).at(-1)
}

export function artifactField(artifact: AiArtifact, field: string): string {
  if (typeof artifact.content !== 'object' || artifact.content === null) {
    return ''
  }

  const value = (artifact.content as Record<string, unknown>)[field]
  return typeof value === 'string' ? value : ''
}

export function artifactChapters(
  artifact: AiArtifact
): Array<{ timestamp: string; title: string }> {
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

export function artifactText(artifact: AiArtifact): string {
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

export function artifactObjects(
  artifact: AiArtifact | undefined,
  field: string
): Record<string, unknown>[] {
  if (!artifact || typeof artifact.content !== 'object' || artifact.content === null) {
    return []
  }

  const value = (artifact.content as Record<string, unknown>)[field]
  if (!Array.isArray(value)) {
    return []
  }

  return value.filter(isObjectRecord)
}

export function objectField(item: Record<string, unknown>, field: string): string {
  const value = item[field]
  return typeof value === 'string' ? value : ''
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** "742 MB" / "1.2 GB" — the Library's size column and storage footer. */
export function formatBytes(bytes?: number | null): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) {
    return '—'
  }
  if (bytes < 1024) {
    return `${Math.round(bytes)} B`
  }
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 'B'
  for (const candidate of units) {
    value /= 1024
    unit = candidate
    if (value < 1024) {
      break
    }
  }
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10
  return `${rounded} ${unit}`
}
