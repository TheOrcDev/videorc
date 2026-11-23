export interface NativePreviewProofPollingProfile {
  intervalMs: number
  maxWidth: number
  /**
   * The profile's own cap with no geometry applied. A source layer that
   * measures its drawn width asks for exactly that, bounded only by this, so
   * a stale or quantized surface width never undersupplies it.
   */
  ceilingWidth: number
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

const IDLE_PROOF_POLLING_PROFILE: Omit<NativePreviewProofPollingProfile, 'ceilingWidth'> = {
  intervalMs: 40,
  // Absolute ceiling — a 4K proof window still never asks for more than this.
  maxWidth: 1920
}

const RECORDING_PROOF_POLLING_PROFILE: Omit<NativePreviewProofPollingProfile, 'ceilingWidth'> = {
  // The proof surface is the production Preview on Linux and Windows, so a
  // recording keeps the idle profile: a stream's operator watches it the
  // whole time. It used to drop to 960 px at 8 fps to spare the recording
  // 25 Lanczos resizes and PNG encodes a second; the transport is now an
  // uncompressed BMP with plan 191's integer triangle resize, measured in
  // release at 5.2 ms per 1920x1080 -> 1320 frame (about 13% of one core
  // at 25 fps) and 0.2 ms when the frame needs no resize. Kept separate so
  // a platform that needs containment can set it here.
  intervalMs: 40,
  maxWidth: 1920
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

/**
 * Plan 257 S3: how the proof surface fetches and shows source frames.
 * `interval` polls a BGRA BMP every `intervalMs` into an <img> (the Windows
 * proof surface, unchanged). `wait-i420` (Linux) asks the backend to hold each
 * request until the source publishes a newer frame, as planar BT.709 I420
 * shrunk only by whole box factors, and draws it into a canvas with WebGL; the
 * spike (`docs/acceptance/2026-11-23-linux-preview-transport-spike.md`) took
 * the camera from 8 to 30 shown fps for less CPU.
 */
export type NativePreviewProofFrameTransport = 'interval' | 'wait-i420'

/**
 * The transport for this platform. `VIDEORC_PROOF_FRAME_TRANSPORT` overrides
 * it (support and comparison runs), but only with a known value.
 */
export function nativePreviewProofFrameTransport(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>
): NativePreviewProofFrameTransport {
  const requested = env.VIDEORC_PROOF_FRAME_TRANSPORT
  if (requested === 'interval' || requested === 'wait-i420') {
    return requested
  }
  return platform === 'linux' ? 'wait-i420' : 'interval'
}

/**
 * Plan 257 S3: the compositor rate the Preview surface asks for. On Linux the
 * idle compositor composes no preview pixels (the proof surface draws each
 * source's own frames), so its ticks are status only and every one crosses
 * main and the proof page: at 60 Hz that cost about a third of a core with no
 * picture at all. 30 matches the sources; elsewhere the native presenters keep
 * 60.
 */
export function previewSurfaceCreateTargetFps(platform: string | undefined): number {
  return platform === 'linux' ? 30 : 60
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
    maxWidth: nativePreviewProofPollingMaxWidth(base.maxWidth, surfacePixelWidth),
    ceilingWidth: base.maxWidth
  }
}

export function nativePreviewProofPollingProfileKey(
  surfaceWindowId: number,
  profile: NativePreviewProofPollingProfile
): string {
  return `${surfaceWindowId}:${profile.intervalMs}:${profile.maxWidth}:${profile.ceilingWidth}`
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
