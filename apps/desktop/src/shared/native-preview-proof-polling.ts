export interface NativePreviewProofPollingProfile {
  intervalMs: number
  maxWidth: number
}

/**
 * Documented quality floor: even a tiny proof window keeps at least this many
 * source pixels of width so text in a screen share stays legible when the
 * window is enlarged again before the next profile push lands.
 */
export const PROOF_POLLING_MIN_MAX_WIDTH = 640

/**
 * Geometry quantization for the DPR-aware cap. Widths round UP to this step so
 * live resizes only re-push a profile when they cross a bucket, not per pixel,
 * and a mid-bucket surface is never undersupplied.
 */
export const PROOF_POLLING_WIDTH_STEP = 160

const IDLE_PROOF_POLLING_PROFILE: NativePreviewProofPollingProfile = {
  intervalMs: 40,
  // Absolute ceiling — a 4K proof window still never asks for more than this.
  maxWidth: 1920
}

const RECORDING_PROOF_POLLING_PROFILE: NativePreviewProofPollingProfile = {
  // Windows' proof surface is production preview, so it must stay live while
  // recording. Keep it useful without spending the recording's CPU budget on
  // 25 full-resolution channel swaps, Lanczos resizes, and PNG encodes/sec.
  intervalMs: 125,
  maxWidth: 960
}

/**
 * DPR-aware image cap (issue #157): the surface never needs more source
 * pixels than it can physically display, so the requested width follows the
 * proof-window content width × devicePixelRatio, quantized up to
 * {@link PROOF_POLLING_WIDTH_STEP}, floored at
 * {@link PROOF_POLLING_MIN_MAX_WIDTH}, and ceilinged by the profile's own
 * cap. An unknown geometry keeps the full profile cap (fail open on quality).
 */
export function nativePreviewProofPollingMaxWidth(
  profileCap: number,
  surfacePixelWidth: number | undefined
): number {
  if (
    typeof surfacePixelWidth !== 'number' ||
    !Number.isFinite(surfacePixelWidth) ||
    surfacePixelWidth <= 0
  ) {
    return profileCap
  }
  const quantized =
    Math.ceil(surfacePixelWidth / PROOF_POLLING_WIDTH_STEP) * PROOF_POLLING_WIDTH_STEP
  return Math.min(profileCap, Math.max(PROOF_POLLING_MIN_MAX_WIDTH, quantized))
}

export function nativePreviewProofFrameUrl(url: string, maxWidth?: number): string {
  if (typeof maxWidth !== 'number' || !Number.isFinite(maxWidth) || maxWidth <= 0) {
    return url
  }
  try {
    const parsed = new URL(url)
    parsed.searchParams.set('maxWidth', String(Math.max(1, Math.round(maxWidth))))
    return parsed.toString()
  } catch {
    return url
  }
}

export function nativePreviewProofPollingProfile(
  recordingActive: boolean,
  surfacePixelWidth?: number
): NativePreviewProofPollingProfile {
  const base = recordingActive ? RECORDING_PROOF_POLLING_PROFILE : IDLE_PROOF_POLLING_PROFILE
  return {
    intervalMs: base.intervalMs,
    maxWidth: nativePreviewProofPollingMaxWidth(base.maxWidth, surfacePixelWidth)
  }
}

export function nativePreviewProofPollingProfileKey(
  surfaceWindowId: number,
  profile: NativePreviewProofPollingProfile
): string {
  return `${surfaceWindowId}:${profile.intervalMs}:${profile.maxWidth}`
}

/**
 * The compact proof-present payload (issue #157). The proof surface script
 * consumes exactly these fields per accepted update; the full compositor
 * status — scene sources, image cache, frame pipeline, layouts — stays on the
 * normal status/diagnostics channel and must not ride the present hot path.
 */
export interface NativePreviewProofPresentStatus {
  state: string
  framesRendered: number
  frameAgeMs?: number
  width: number
  sceneRevision?: number
  sources: Array<{ kind: string; state: string }>
}

export function nativePreviewProofPresentStatus(status: {
  state: string
  framesRendered: number
  frameAgeMs?: number
  width: number
  sceneRevision?: number
  sources?: Array<{ kind: string; state: string }>
}): NativePreviewProofPresentStatus {
  return {
    state: status.state,
    framesRendered: status.framesRendered,
    ...(typeof status.frameAgeMs === 'number' ? { frameAgeMs: status.frameAgeMs } : {}),
    width: status.width,
    ...(typeof status.sceneRevision === 'number' ? { sceneRevision: status.sceneRevision } : {}),
    sources: (status.sources ?? []).map((source) => ({
      kind: source.kind,
      state: source.state
    }))
  }
}
