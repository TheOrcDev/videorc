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

/**
 * Timer ticks (at 30 Hz) with no frame callback before the timer paints
 * again: about 100 ms, longer than any gap between frames of moving content.
 */
const FRAME_CALLBACK_IDLE_TICKS = 3
/**
 * The shortest gap between two drawn frames. A 30 fps capture can land 25 ms
 * apart on a 120 Hz display, so this is not 33 ms; a 60 fps one draws every
 * other frame.
 */
const MIN_FRAME_GAP_MS = 20

/** Raw capture is NEVER passed to LiveKit. All output frames pass this synchronous gate.
 * Neutral opaque frost matches the native no-picture frost. We deliberately do not
 * sample a potentially sensitive frame to make a blurred still for the wire. A canvas
 * failure stops the output immediately; the owner unpublishes and reports paused.
 * Receivers draw the designed hidden still (hidden-still.ts) over this grey.
 */
export function createPrivateScreen(
  raw: MediaStreamTrack,
  decision: ScreenPrivacyDecision,
  failed: (error: unknown) => void
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
  const block = () => {
    blocked = true
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
  // One gate for every output frame: the frost while hidden, else the capture.
  const paint = (): boolean => {
    try {
      if (blocked || decision.hidden) frost()
      else if (video.readyState >= 2) {
        context.drawImage(video, 0, 0, canvas.width, canvas.height)
      }
      return true
    } catch (error) {
      track.stop()
      failed(error)
      return false
    }
  }
  // PH-13: one draw per captured frame, so a 30 Hz timer and the capture's
  // own clock never beat (a frame sent twice, the next one skipped). The
  // timer below keeps today's 30 Hz output whenever no frame callback comes:
  // a still screen, a window whose rendering stopped, or no callback API.
  let frameHandle = 0
  let lastFrameAt = -Infinity
  let frameSeen = false
  const onFrame = (now: number): void => {
    frameHandle = 0
    if (closed) return
    frameSeen = true
    // The capture may run faster than the 30 fps the publication carries.
    if (now - lastFrameAt >= MIN_FRAME_GAP_MS) {
      lastFrameAt = now
      if (!paint()) return
    }
    frameHandle = video.requestVideoFrameCallback(onFrame)
  }
  if (typeof video.requestVideoFrameCallback === 'function') {
    frameHandle = video.requestVideoFrameCallback(onFrame)
  }
  let idleTicks = FRAME_CALLBACK_IDLE_TICKS
  const timer = window.setInterval(() => {
    if (closed) return
    if (frameSeen) {
      frameSeen = false
      idleTicks = 0
      return
    }
    if (idleTicks < FRAME_CALLBACK_IDLE_TICKS) {
      idleTicks += 1
      return
    }
    paint()
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
      if (frameHandle) video.cancelVideoFrameCallback(frameHandle)
      frameHandle = 0
      track.stop()
      video.pause()
      video.srcObject = null
    }
  }
}
