// Pure derivations for the Studio dashboard's Session panel (SD1). Kept free of
// React/component imports so they run under the node-only vitest runner. The
// status strings/tones are shared by the Session rows and the Preview badge.

import { sessionIsLive } from '../../../shared/capture-state'

export { sessionIsLive }

export type SessionVideo = { width: number; height: number; fps: number }
export type SessionTarget = { enabled: boolean; label: string; platform: string }
export type SessionStatusTone = 'good' | 'warn' | 'error' | 'live' | 'neutral'
/** The slice of `recording.status` the session chrome reads. */
export type SessionStatusView = { state: string; streamUrl?: string | null }

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

/** "4K · 2160p30" — resolution class + short edge + fps. When the class IS the
 *  resolution ("1080p"), skip the redundant doubling and show "1080p30". */
export function recordingQuality(video: SessionVideo): string {
  const resolution = Math.min(video.width, video.height)
  const name = qualityName(resolution)
  const detail = `${resolution}p${video.fps}`
  return name === `${resolution}p` ? detail : `${name} · ${detail}`
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

/** A live session that also writes a local file: Go Live records by default. */
export function sessionAlsoRecords(status: SessionStatusView): boolean {
  return status.state === 'recording' && sessionIsLive(status)
}

/**
 * Milliseconds since the session started, from `recording.startedAt` (plan
 * 095 S5). The backend sends `durationMs` only in the terminal status, so a
 * running clock counts from the start. Missing or unparsable input is
 * `undefined`; a start in the future (clock skew) reads 0.
 */
export function sessionElapsedMs(
  startedAt: string | null | undefined,
  nowMs: number
): number | undefined {
  const startedMs = startedAt ? Date.parse(startedAt) : Number.NaN
  if (!Number.isFinite(startedMs) || !Number.isFinite(nowMs)) {
    return undefined
  }
  return Math.max(0, nowMs - startedMs)
}

/**
 * The inspector's session clock (plan 050 S12): m:ss under an hour, h:mm:ss
 * after. Fed by `sessionElapsedMs` while a session runs. Missing reads 0:00.
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

/**
 * The Stop button. A live session ends the livestream, and says so when it
 * also stops a recording (Go Live is record+stream by default).
 */
export function sessionStopControl(
  status: SessionStatusView,
  stopRequestPending: boolean
): { label: string; title?: string } {
  if (stopRequestPending) {
    return { label: 'Stopping…' }
  }
  if (status.state === 'stopping') {
    return { label: 'Force stop' }
  }
  if (sessionIsLive(status)) {
    return sessionAlsoRecords(status)
      ? { label: 'End livestream', title: 'Also stops the recording' }
      : { label: 'End livestream' }
  }
  return { label: 'Stop recording' }
}

/**
 * Idle reads as "Ready" (the mockup's resting state); transitions get an
 * ellipsis. An on-air session reads "Streaming" whether or not it also
 * records: the backend calls record+stream `recording` (plan 095 S5).
 */
export function sessionStatusLabel(status: SessionStatusView, wsStatus?: string): string {
  // F-014: never report Ready over a dead backend socket — the app used to
  // zombie with a green Ready badge after a backend crash. Boot-time
  // waiting/connecting reads as "Connecting…", real drops as offline.
  if (wsStatus === 'waiting' || wsStatus === 'connecting') {
    return 'Connecting…'
  }
  if (wsStatus && wsStatus !== 'connected') {
    return 'Backend offline'
  }
  if (sessionIsLive(status)) {
    return 'Streaming'
  }
  switch (status.state) {
    case 'idle':
      return 'Ready'
    case 'starting':
      return 'Starting…'
    case 'recording':
      return 'Recording'
    case 'stopping':
      return 'Stopping…'
    case 'failed':
      return 'Failed'
    default:
      return status.state.charAt(0).toUpperCase() + status.state.slice(1)
  }
}

export function sessionStatusTone(status: SessionStatusView, wsStatus?: string): SessionStatusTone {
  if (wsStatus === 'waiting' || wsStatus === 'connecting') {
    return 'warn'
  }
  if (wsStatus && wsStatus !== 'connected') {
    return 'error'
  }
  if (sessionIsLive(status)) {
    return 'live'
  }
  switch (status.state) {
    case 'idle':
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
