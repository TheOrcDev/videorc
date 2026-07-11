import type { CaptionStyleId, CaptionsStatus, CaptionsUpdate } from '@/lib/backend'
import type { CaptionBurnTarget } from '@/lib/capture'

/** Lines kept for the captions strip / detached window. */
export const MAX_CAPTION_LINES = 50

/**
 * Generation guard for renderer-owned caption cue raster work. Privacy
 * boundaries and client teardown invalidate older async renders before they
 * can retain or submit more transcript pixels.
 */
export class CaptionCueRenderGuard {
  private generation = 0

  begin(): number {
    this.generation += 1
    return this.generation
  }

  cancel(): void {
    this.generation += 1
  }

  isCurrent(generation: number): boolean {
    return generation === this.generation
  }
}

/** Final-copy work survives ordinary capture boundaries; sign-out purges it. */
export function shouldCancelCaptionCueRender(reason: string | undefined): boolean {
  return reason === 'signed-out'
}

/**
 * Append a caption update: streaming PARTIALS (and the final that settles
 * them) REPLACE the line with the same seq; older seqs are dropped
 * (chunked-retry duplicates); a new caption session resets the buffer.
 * Newest line last; capped to MAX_CAPTION_LINES.
 */
export function appendCaptionLine(
  lines: CaptionsUpdate[],
  update: CaptionsUpdate,
  max = MAX_CAPTION_LINES
): CaptionsUpdate[] {
  if (!update.text.trim()) {
    return lines
  }
  const last = lines.at(-1)
  if (last && last.sessionClientId !== update.sessionClientId) {
    return [update]
  }
  if (last && update.seq === last.seq) {
    // The utterance is still evolving (partial → partial → final).
    return [...lines.slice(0, -1), update]
  }
  if (last && update.seq < last.seq) {
    return lines
  }
  return [...lines, update].slice(-max)
}

/** The strip shows the tail of the transcript, most recent lines only. */
export function captionStripLines(lines: CaptionsUpdate[], count = 3): CaptionsUpdate[] {
  return lines.slice(-count)
}

/** Screen readers announce settled cues only; evolving partials remain visual. */
export function latestFinalCaptionText(lines: CaptionsUpdate[]): string | undefined {
  return [...lines].reverse().find((line) => line.kind !== 'partial')?.text
}

export function captionsStatusIsActive(status: CaptionsStatus): boolean {
  return ['starting', 'listening', 'reconnecting', 'degraded', 'live'].includes(status.state)
}

/**
 * Reconciles persisted caption consent with backend-owned desired intent.
 * Attempts are tracked by StudioProvider per toggle/capture/client scope so a
 * blocked provider cannot spin, while an explicit retry edge can try once.
 */
export function decideCaptionsRuntimeIntent(input: {
  persistedEnabled: boolean
  suppressForSession: boolean
  captureActive: boolean
  status: CaptionsStatus
  startAttempted: boolean
  stopAttempted: boolean
}): 'start' | 'stop' | 'none' {
  const shouldEnable = input.persistedEnabled && !input.suppressForSession
  const backendHasIntent = input.status.state !== 'idle' || input.status.desiredEnabled === true

  if (!shouldEnable) {
    return backendHasIntent && !input.stopAttempted ? 'stop' : 'none'
  }
  if (captionsStatusIsActive(input.status)) {
    return 'none'
  }
  if (
    input.status.state === 'ready' &&
    input.status.desiredEnabled !== false &&
    !input.captureActive
  ) {
    return 'none'
  }
  return input.startAttempted ? 'none' : 'start'
}

export function captionLineIdentity(line: CaptionsUpdate): string {
  return `${line.sessionClientId}:${line.seq}`
}

export interface CaptionOverlaySignature {
  styleId: CaptionStyleId
  styleRevision: number
  position: 'top' | 'bottom'
  textSize: 's' | 'm' | 'l'
  canvasWidth: number
  canvasHeight: number
  outputLeg: 'shared' | 'stream' | 'recording' | 'primary' | 'auxiliary'
}

export interface CaptionOverlayTargetPlan {
  target: 'primary' | 'auxiliary'
  outputLeg: 'recording' | 'stream'
  canvasWidth: number
  canvasHeight: number
}

/** Map user-facing outputs to the backend's session-stable compositor roles. */
export function captionOverlayTargetPlan(input: {
  burnTarget: CaptionBurnTarget
  recordEnabled: boolean
  streamEnabled: boolean
  recordingVideo: { width: number; height: number }
  streamVideo: { width: number; height: number }
}): CaptionOverlayTargetPlan[] {
  const streamRequested =
    input.streamEnabled && (input.burnTarget === 'stream' || input.burnTarget === 'both')

  if (input.recordEnabled && input.streamEnabled) {
    // Recording captions are rendered later into a non-destructive copy. The
    // source recording remains clean, so the only live raster is the split
    // viewer-facing stream leg.
    return streamRequested
      ? [
          {
            target: 'auxiliary' as const,
            outputLeg: 'stream' as const,
            canvasWidth: input.streamVideo.width,
            canvasHeight: input.streamVideo.height
          }
        ]
      : []
  }
  if (streamRequested) {
    return [
      {
        target: 'primary',
        outputLeg: 'stream',
        // Stream-only sessions do not allocate the auxiliary stream canvas:
        // the primary compositor stays at the capture canvas and FFmpeg scales
        // that complete frame to the destination profile. Rasterize at the
        // actual compositor size so text scales with the video instead of
        // becoming a small 1080p island on a 4K primary.
        canvasWidth: input.recordingVideo.width,
        canvasHeight: input.recordingVideo.height
      }
    ]
  }
  return []
}

/** Everything that can change pixels belongs in the key. */
export function captionOverlayKey(
  line: CaptionsUpdate,
  signature: CaptionOverlaySignature
): string {
  return [
    captionLineIdentity(line),
    line.text,
    signature.styleId,
    signature.styleRevision,
    signature.position,
    signature.textSize,
    `${signature.canvasWidth}x${signature.canvasHeight}`,
    signature.outputLeg
  ].join(':')
}

/** Readable dwell for a settled line: two seconds minimum, six maximum. */
export function captionDwellMs(text: string): number {
  return Math.min(6000, Math.max(2000, 1800 + text.trim().length * 45))
}

/**
 * Serial, bounded latest-wins work queue. At most one request is rendering and
 * one newest request is pending; intermediate partials are deliberately
 * coalesced, while a final/style update can never be stranded behind a busy ref.
 */
export class LatestWinsScheduler<T> {
  private running = false
  private pending: T | null = null
  private idleResolvers: Array<() => void> = []

  constructor(private readonly worker: (value: T) => Promise<void>) {}

  enqueue(value: T): void {
    this.pending = value
    if (!this.running) {
      void this.drain()
    }
  }

  clearPending(): void {
    this.pending = null
  }

  whenIdle(): Promise<void> {
    if (!this.running && this.pending === null) {
      return Promise.resolve()
    }
    return new Promise((resolve) => this.idleResolvers.push(resolve))
  }

  private async drain(): Promise<void> {
    this.running = true
    try {
      while (this.pending !== null) {
        const next = this.pending
        this.pending = null
        try {
          await this.worker(next)
        } catch {
          // One failed render/push must not strand the newest queued request.
        }
      }
    } finally {
      this.running = false
      const resolvers = this.idleResolvers.splice(0)
      resolvers.forEach((resolve) => resolve())
    }
  }
}

/**
 * Session boundary marker for the caption display state. Captions belong to
 * the video they were spoken in: at each capture-session start the buffer is
 * cleared AND this floor is recorded, so a transcript of PREVIOUS-video audio
 * that arrives late (chunk uploads finish after the boundary) can never show
 * up — or get burned — in the new video. The caption session and its
 * sessionClientId outlive recordings, so seq is the only usable watermark.
 */
export interface CaptionSessionFloor {
  sessionClientId: string
  seq: number
}

export function captionSessionFloor(lines: CaptionsUpdate[]): CaptionSessionFloor | null {
  const last = lines.at(-1)
  return last ? { sessionClientId: last.sessionClientId, seq: last.seq } : null
}

/** A line clears the floor when it starts a new caption session or advances
 * past the last seq seen before the current capture session began. */
export function captionLineAboveFloor(
  line: CaptionsUpdate,
  floor: CaptionSessionFloor | null
): boolean {
  if (!floor || line.sessionClientId !== floor.sessionClientId) {
    return true
  }
  return line.seq > floor.seq
}

/**
 * One decision for the burn-in overlay driver, pure so the two-consecutive-
 * sessions regression is unit-testable: 'clear' takes the bar down (burn off,
 * captions stopped, or no active session), 'push' rasterizes the latest line,
 * 'none' leaves the compositor untouched. A line at or below the session
 * floor is never pushed — re-pushing the previous video's last caption at the
 * next session start is exactly the carry-over bug (2026-07-04).
 */
export function decideOverlayPush(input: {
  burnIn: boolean
  captionsRunning: boolean
  sessionActive: boolean
  latest: CaptionsUpdate | undefined
  floor: CaptionSessionFloor | null
  pushedKey: string | null
  candidateKey?: string
  expiredLineId?: string | null
  /** Legacy caller compatibility; the latest-wins scheduler replaces this gate. */
  busy?: boolean
}): { action: 'push' | 'clear' | 'none'; key: string | null } {
  if (!input.burnIn || !input.captionsRunning || !input.sessionActive) {
    return { action: input.pushedKey !== null ? 'clear' : 'none', key: null }
  }
  if (
    !input.latest ||
    input.busy ||
    !captionLineAboveFloor(input.latest, input.floor) ||
    input.expiredLineId === captionLineIdentity(input.latest)
  ) {
    return { action: 'none', key: input.pushedKey }
  }
  // Streaming partials share a seq while the text evolves — key on both so
  // the live bar refreshes with every refinement.
  const key = input.candidateKey ?? `${input.latest.seq}:${input.latest.text}`
  if (input.pushedKey === key) {
    return { action: 'none', key }
  }
  return { action: 'push', key }
}
