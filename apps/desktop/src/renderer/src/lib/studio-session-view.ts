// Pure derivations for the Studio dashboard's Session panel (SD1). Kept free of
// React/component imports so they run under the node-only vitest runner. The
// status strings/tones are shared by the Session rows and the Preview badge.

export type SessionVideo = { width: number; height: number; fps: number }
export type SessionTarget = { enabled: boolean; label: string; platform: string }
export type SessionStatusTone = 'good' | 'warn' | 'error' | 'neutral'

/** "Local recording" / "Streaming only" / "Recording + streaming" / "No output". */
export function sessionMode(recordEnabled: boolean, streamEnabled: boolean): string {
  if (recordEnabled && streamEnabled) {
    return 'Recording + streaming'
  }
  if (streamEnabled) {
    return 'Streaming only'
  }
  if (recordEnabled) {
    return 'Local recording'
  }
  return 'No output'
}

/** Friendly resolution class from the frame height (2160 → "4K"). */
export function qualityName(height: number): string {
  if (height >= 2160) {
    return '4K'
  }
  if (height >= 1440) {
    return '2K'
  }
  if (height >= 1080) {
    return '1080p'
  }
  if (height >= 720) {
    return '720p'
  }
  return `${height}p`
}

/** "4K · 2160p30" — resolution class + height + fps. When the class IS the
 *  height ("1080p"), skip the redundant doubling and show "1080p30". */
export function recordingQuality(video: SessionVideo): string {
  const name = qualityName(video.height)
  const detail = `${video.height}p${video.fps}`
  return name === `${video.height}p` ? detail : `${name} · ${detail}`
}

/** "3840×2160 · 30fps" — the full output dimensions. */
export function outputSummary(video: SessionVideo): string {
  return `${video.width}×${video.height} · ${video.fps}fps`
}

/** "Disabled" off-air, else the single destination's name or a count. */
export function streamingSummary(streamEnabled: boolean, targets: SessionTarget[]): string {
  if (!streamEnabled) {
    return 'Disabled'
  }
  const enabled = targets.filter((target) => target.enabled)
  if (enabled.length === 0) {
    return 'No destinations'
  }
  if (enabled.length === 1) {
    return enabled[0].label || enabled[0].platform
  }
  return `${enabled.length} destinations`
}

/** Idle reads as "Ready" (the mockup's resting state); transitions get an ellipsis. */
/**
 * True while a session owns the transport — the Stop/Force-stop control must
 * stay reachable through EVERY in-flight state (F-020: excluding starting/
 * stopping flipped the transport back to idle Record/Go Live mid-session).
 */
export function isSessionTransportActive(state: string): boolean {
  return (
    state === 'recording' || state === 'streaming' || state === 'starting' || state === 'stopping'
  )
}

/**
 * The toolbar's session clock (plan 050 S12): m:ss under an hour, h:mm:ss
 * after, from the backend's recording.durationMs. Missing reads 0:00.
 */
export function sessionClockLabel(durationMs?: number): string {
  const total =
    typeof durationMs === 'number' && Number.isFinite(durationMs)
      ? Math.max(0, Math.floor(durationMs / 1000))
      : 0
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = String(total % 60).padStart(2, '0')
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`
}

export function sessionStatusLabel(state: string, wsStatus?: string): string {
  // F-014: never report Ready over a dead backend socket — the app used to
  // zombie with a green Ready badge after a backend crash. Boot-time
  // waiting/connecting reads as "Connecting…", real drops as offline.
  if (wsStatus === 'waiting' || wsStatus === 'connecting') {
    return 'Connecting…'
  }
  if (wsStatus && wsStatus !== 'connected') {
    return 'Backend offline'
  }
  switch (state) {
    case 'idle':
      return 'Ready'
    case 'starting':
      return 'Starting…'
    case 'recording':
      return 'Recording'
    case 'streaming':
      return 'Streaming'
    case 'stopping':
      return 'Stopping…'
    case 'failed':
      return 'Failed'
    default:
      return state.charAt(0).toUpperCase() + state.slice(1)
  }
}

export function sessionStatusTone(state: string, wsStatus?: string): SessionStatusTone {
  if (wsStatus === 'waiting' || wsStatus === 'connecting') {
    return 'warn'
  }
  if (wsStatus && wsStatus !== 'connected') {
    return 'error'
  }
  switch (state) {
    case 'idle':
    case 'streaming':
      return 'good'
    case 'starting':
    case 'stopping':
      return 'warn'
    case 'recording':
    case 'failed':
      return 'error'
    default:
      return 'neutral'
  }
}
