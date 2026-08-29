import type { StatusTone } from '@/components/status-badge'
import type { CaptureRecoveryStage, DiagnosticStats, HealthEvent } from '@/lib/backend'
import {
  SESSION_START_FAILED_TOAST_ID,
  SESSION_START_FAILED_TOAST_TITLE
} from '@/lib/session-start-failure'
import type { NativePreviewHostKind } from '../../../shared/backend'
import { isNativePreviewCapability } from '../../../shared/native-preview-capability'

/** Backend health-event codes for the recording startup barrier (recording.rs). */
export const RECORDING_STARTUP_BARRIER_TIMEOUT_CODE = 'recording-startup-barrier-timeout'
export const RECORDING_STARTUP_CADENCE_UNSTEADY_CODE = 'recording-startup-cadence-unsteady'
/** Sonner key for the unsteady-start warning: one per start, never a stack. */
export const RECORDING_STARTUP_UNSTEADY_TOAST_ID = 'recording-startup-cadence-unsteady'

export interface HealthEventToast {
  variant: 'warning' | 'error'
  /** Sonner id — keyed so a repeat updates in place instead of stacking. */
  id: string
  title: string
  description: string
  duration: number
}

/**
 * Toast copy for the two recording-startup health events (B0). Both used to be
 * stored in the session record and shown nowhere persistent.
 *
 * - `recording-startup-cadence-unsteady` (warn): the session STARTED, but the
 *   compositor never settled during the startup barrier and its retry — the
 *   first seconds of the file deserve a look. Warning variant, 15s.
 * - `recording-startup-barrier-timeout` (error): the session was refused. It
 *   shares the start-failure toast key, so the start RPC rejection that
 *   follows updates this toast in place (adding Retry) instead of stacking a
 *   second red toast for the same failure. Persistent.
 *
 * Returns null for every other event; the caller keeps its own policies.
 */
export function recordingStartupHealthToast(
  event: Pick<HealthEvent, 'code' | 'level' | 'message'>
): HealthEventToast | null {
  if (event.code === RECORDING_STARTUP_CADENCE_UNSTEADY_CODE) {
    return {
      variant: 'warning',
      id: RECORDING_STARTUP_UNSTEADY_TOAST_ID,
      title: 'Recording started on an unsteady compositor',
      description: event.message,
      duration: 15000
    }
  }
  if (event.code === RECORDING_STARTUP_BARRIER_TIMEOUT_CODE && event.level === 'error') {
    return {
      variant: 'error',
      id: SESSION_START_FAILED_TOAST_ID,
      title: SESSION_START_FAILED_TOAST_TITLE,
      description: event.message,
      duration: Infinity
    }
  }
  return null
}

/** The slice of diagnostics the compact Studio health badge reads. Full stats live in the
 * Diagnostics tab; this is the at-a-glance "is the live program healthy" signal. */
export type StudioHealthInput = Pick<
  DiagnosticStats,
  | 'compositorBackend'
  | 'compositorCpuFallbackFrames'
  | 'compositorFallbackReason'
  | 'captureRecoveryLastError'
  | 'captureRecoveryPhase'
  | 'captureRecoverySource'
  | 'previewInputToPresentLatencyP95Ms'
  | 'previewInputToPresentLatencyP99Ms'
  | 'previewSurfaceBacking'
  | 'previewTransport'
> & {
  captureRecoveryStage?: CaptureRecoveryStage | null
}

export interface StudioHealth {
  tone: StatusTone
  /** Compact chip text shown in the Studio action bar. */
  value: string
  /** Full explanation for the degraded strip / tooltip. */
  detail?: string
}

// Live preview present-latency budget (ms) from the preview/recording parity plan.
const PREVIEW_PRESENT_BUDGET_P95_MS = 75
const PREVIEW_PRESENT_BUDGET_P99_MS = 150

/**
 * Derive a compact preview/recording health signal for the Studio badge.
 *
 * Degraded ("Preview may not match recording") whenever the compositor drops to CPU
 * fallback — the Metal program path failed, so preview quality and parity with the recording
 * are no longer guaranteed. Warn when preview presentation drifts past the live latency
 * budget or is on a non-native fallback transport.
 *
 * There is deliberately NO red "requires native CAMetalLayer" state anymore
 * (owner, 2026-07-07): it fired for transient startup states ("unavailable /
 * none") and read as jargon. The preview window's presenting watch (plan 021
 * F1) owns truthful preview-path health with self-healing; the Studio badge
 * only reports states a user can act on.
 */
export function studioHealth(
  stats: StudioHealthInput,
  active: boolean,
  platform?: string,
  nativePreviewHostKind?: NativePreviewHostKind
): StudioHealth {
  const recoverySource =
    stats.captureRecoverySource ??
    (stats.captureRecoveryStage === 'screen-delivery'
      ? 'screen'
      : stats.captureRecoveryStage === 'camera-delivery'
        ? 'camera'
        : undefined)

  if (stats.captureRecoveryPhase === 'failed') {
    const sourceName =
      recoverySource === 'screen'
        ? 'screen capture'
        : recoverySource === 'camera'
          ? 'camera'
          : 'capture source'
    return {
      tone: 'error',
      value: 'Capture stalled',
      detail:
        stats.captureRecoveryLastError?.trim() ||
        `Automatic capture repair did not restore the ${sourceName}.`
    }
  }

  if (
    stats.captureRecoveryPhase === 'degraded' ||
    stats.captureRecoveryPhase === 'restarting' ||
    stats.captureRecoveryPhase === 'verifying'
  ) {
    if (
      stats.captureRecoveryPhase === 'degraded' &&
      stats.captureRecoveryStage === 'compositor-render'
    ) {
      return {
        tone: 'warn',
        value: 'Capture degraded',
        detail: 'Video rendering slowed. Videorc left the capture sources unchanged.'
      }
    }
    return {
      tone: 'warn',
      value: 'Repairing capture',
      detail:
        stats.captureRecoveryPhase === 'verifying'
          ? recoverySource === 'screen'
            ? 'Screen capture restarted. Checking that live video is moving normally.'
            : recoverySource === 'camera'
              ? 'Camera restarted. Checking that live video is moving normally.'
              : 'Capture restarted. Checking that live video is moving normally.'
          : recoverySource === 'screen'
            ? 'Screen capture stalled. Videorc is restarting it without stopping your session.'
            : recoverySource === 'camera'
              ? 'The camera stalled. Videorc is restarting capture without stopping your session.'
              : 'Capture stalled. Videorc is restarting it without stopping your session.'
    }
  }

  if (stats.captureRecoveryPhase === 'recovered') {
    if (stats.captureRecoveryStage === 'compositor-render') {
      return {
        tone: 'good',
        value: 'Video recovered',
        detail: 'Video rendering recovered. Capture sources were left unchanged.'
      }
    }
    return {
      tone: 'good',
      value: 'Capture recovered',
      detail:
        recoverySource === 'screen'
          ? 'Screen capture recovered without restarting your session.'
          : recoverySource === 'camera'
            ? 'Camera capture recovered without restarting your session.'
            : 'Capture recovered without restarting your session.'
    }
  }

  const effectivePlatform = platform ?? 'darwin'
  const nativePreviewExpected = effectivePlatform === 'darwin' || effectivePlatform === 'win32'
  const nativePreviewLive = isNativePreviewCapability(
    {
      transport: stats.previewTransport,
      backing: stats.previewSurfaceBacking,
      nativePreviewHostKind
    },
    effectivePlatform
  )

  if (
    stats.compositorBackend === 'cpu-fallback' ||
    (active && nativePreviewExpected && stats.compositorCpuFallbackFrames > 0)
  ) {
    return {
      tone: 'error',
      value: 'Degraded',
      detail: stats.compositorFallbackReason
        ? `Preview may not match recording — ${stats.compositorFallbackReason}`
        : 'Preview may not match recording — compositor is on CPU fallback'
    }
  }

  // A fallback transport is the dominant, stable state, so surface it before borderline latency.
  // Otherwise the badge flaps between "Fallback" and "Lagging" while the preview sits on the
  // polling path and its present latency oscillates around the budget. On platforms without a
  // native surface, polling is not a fallback — it is the preview path — so it stays quiet.
  if (
    nativePreviewExpected &&
    !nativePreviewLive &&
    (stats.previewTransport === 'latest-jpeg-polling' ||
      stats.previewTransport === 'mjpeg-stream' ||
      stats.previewTransport === 'electron-proof-surface' ||
      stats.previewTransport === 'native-surface' ||
      stats.previewTransport === 'd3d11-shared-texture')
  ) {
    return {
      tone: 'warn',
      value: 'Fallback',
      detail: `Preview is on the ${stats.previewTransport} fallback instead of the native surface`
    }
  }

  const p95 = stats.previewInputToPresentLatencyP95Ms
  const p99 = stats.previewInputToPresentLatencyP99Ms
  if (
    (typeof p95 === 'number' && p95 > PREVIEW_PRESENT_BUDGET_P95_MS) ||
    (typeof p99 === 'number' && p99 > PREVIEW_PRESENT_BUDGET_P99_MS)
  ) {
    return {
      tone: 'warn',
      value: 'Lagging',
      detail: `Preview behind the live budget — present p95 ${Math.round(p95 ?? 0)}ms / p99 ${Math.round(
        p99 ?? 0
      )}ms`
    }
  }

  if (!stats.compositorBackend) {
    return { tone: 'neutral', value: 'Idle' }
  }

  return { tone: 'good', value: active ? 'Live' : 'Ready' }
}
