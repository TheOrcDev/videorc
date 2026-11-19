import type { ScreenPrivacy } from '@/lib/backend'

/** Eager, SDK-free bridge. Unknown backend state is closed, never permission to publish. */
export class ScreenPrivacyDecision {
  hidden = true
  revision = 0
  #generation = -1
  #pending = 0
  #listeners = new Set<() => void>()
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }
  #notify(): void {
    for (const listener of this.#listeners) listener()
  }
  hide(): number {
    this.#pending = ++this.revision
    this.hidden = true
    this.#notify()
    return this.revision
  }
  showIntent(): number {
    return this.revision
  }
  apply(value: ScreenPrivacy, intent?: number, explicitShow = false): void {
    const generation = value.generation
    // Old backends may hide, but cannot authorize browser Show.
    const validShow = explicitShow && intent === this.revision
    if (generation === undefined) {
      if (value.hidden) {
        this.hidden = true
        this.#notify()
      }
      return
    }
    if (generation < this.#generation && !validShow) return
    if (generation === this.#generation && this.hidden && !value.hidden && !validShow) return
    if (intent !== undefined && (intent === this.#pending || validShow)) this.#pending = 0
    if (!value.hidden && this.#pending !== 0) return
    if (generation === this.#generation && value.hidden === this.hidden) return
    this.#generation = generation
    this.hidden = value.hidden
    ++this.revision
    this.#notify()
  }
}
export const roomScreenPrivacy = new ScreenPrivacyDecision()

export type ScreenPrivacyPublication = {
  epoch: string
  generation: number
  hidden: boolean
}
export const PRIVACY_ACK_TOPIC = 'videorc.screen-privacy.ack.v1'
export const PRIVACY_TOPIC = 'videorc.screen-privacy.v1'
export function privacyTrackName(value: ScreenPrivacyPublication): string {
  return `vrc-privacy:${value.epoch}:${value.generation}:${value.hidden ? 1 : 0}`
}
export function privacyObservationMatches(
  value: unknown,
  expected: ScreenPrivacyPublication
): value is ScreenPrivacyPublication & {
  receiver: string
  receiverSession?: string
  appliedAt: number
} {
  if (!value || typeof value !== 'object') return false
  const one = value as Record<string, unknown>
  return (
    one.epoch === expected.epoch &&
    one.generation === expected.generation &&
    one.hidden === true &&
    typeof one.receiver === 'string' &&
    Number.isSafeInteger(one.appliedAt) &&
    Number(one.appliedAt) > 0
  )
}

/** Raw capture is NEVER passed to LiveKit. All output frames pass this synchronous gate.
 * Neutral opaque frost matches the native no-picture frost. We deliberately do not
 * sample a potentially sensitive frame to make a blurred still for the wire. A canvas
 * failure stops the output immediately; the owner unpublishes and reports paused.
 *
 * `lastFrame` (plan 210 D8 in a room) is handed the canvas once, on the first
 * block after a raw frame was drawn, before the frost covers it: the frame
 * already published while visible, for the host's own frosted look. It must
 * copy synchronously and never publish what it copies.
 */
export function createPrivateScreen(
  raw: MediaStreamTrack,
  decision: ScreenPrivacyDecision,
  failed: (error: unknown) => void,
  lastFrame?: (canvas: HTMLCanvasElement) => void
): { track: MediaStreamTrack; block(): void; pixels(): number[]; close(): void } {
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.srcObject = new MediaStream([raw])
  const canvas = document.createElement('canvas')
  const settings = raw.getSettings()
  canvas.width = Math.max(2, settings.width ?? 1920)
  canvas.height = Math.max(2, settings.height ?? 1080)
  const context = canvas.getContext('2d', { alpha: false })
  if (!context) throw new Error('Screen privacy canvas unavailable')
  const frost = () => {
    context.fillStyle = '#808080'
    context.fillRect(0, 0, canvas.width, canvas.height)
  }
  frost()
  const [track] = canvas.captureStream(30).getVideoTracks()
  if (!track) throw new Error('Screen privacy capture unavailable')
  let closed = false
  let blocked = decision.hidden
  /** A raw frame reached the canvas, so it holds something to hand on. */
  let drawn = false
  const block = () => {
    const first = !blocked && drawn
    blocked = true
    if (first && lastFrame) {
      try {
        lastFrame(canvas)
      } catch {
        // The look only: the frost below covers either way.
      }
    }
    frost()
  }
  const off = decision.subscribe(() => {
    // Never reopen an existing publication. Show requires a fresh generation.
    if (decision.hidden) {
      try {
        block()
      } catch (error) {
        track.stop()
        failed(error)
      }
    }
  })
  const timer = window.setInterval(() => {
    if (closed) return
    try {
      if (blocked || decision.hidden) frost()
      else if (video.readyState >= 2) {
        context.drawImage(video, 0, 0, canvas.width, canvas.height)
        drawn = true
      }
    } catch (error) {
      track.stop()
      failed(error)
    }
  }, 1000 / 30)
  void video.play().catch((error) => {
    track.stop()
    failed(error)
  })
  return {
    track,
    block,
    pixels: () => Array.from(context.getImageData(0, 0, 32, 32).data),
    close() {
      closed = true
      off()
      window.clearInterval(timer)
      track.stop()
      video.pause()
      video.srcObject = null
    }
  }
}
