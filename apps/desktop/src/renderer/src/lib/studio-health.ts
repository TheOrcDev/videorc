import type { StatusTone } from '@/components/status-badge'
import type { DiagnosticStats } from '@/lib/backend'
import type { NativePreviewHostKind } from '../../../shared/backend'
import { isNativePreviewCapability } from '../../../shared/native-preview-capability'

/** The slice of diagnostics the compact Studio health badge reads. Full stats live in the
 * Diagnostics tab; this is the at-a-glance "is the live program healthy" signal. */
export type StudioHealthInput = Pick<
  DiagnosticStats,
  | 'compositorBackend'
  | 'compositorCpuFallbackFrames'
  | 'compositorFallbackReason'
  | 'previewInputToPresentLatencyP95Ms'
  | 'previewInputToPresentLatencyP99Ms'
  | 'previewSurfaceBacking'
  | 'previewTransport'
>

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
