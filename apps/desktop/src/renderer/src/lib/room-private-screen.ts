import type { ScreenPrivacyDecision } from './room-screen-privacy'

// The host's private screen (plan 224): the gate between the raw capture and
// the published track. Its own module, loaded with the room client, so the
// eager privacy decision (room-screen-privacy.ts) stays small (PH-13).

/** The timer runs at twice the capture's 30 fps, so a new frame waits at most one tick. */
const TICK_MS = 1000 / 60
/**
 * Ticks with no new frame before the still-screen repaint: about 100 ms,
 * longer than any gap between frames of moving content.
 */
const STILL_TICKS = 6

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
  const paint = (): void => {
    try {
      if (blocked || decision.hidden) frost()
      else if (video.readyState >= 2) {
        context.drawImage(video, 0, 0, canvas.width, canvas.height)
      }
    } catch (error) {
      track.stop()
      failed(error)
    }
  }
  // PH-13: draw each captured frame once. A 30 Hz timer blind to the
  // capture's own clock sent some frames twice and skipped the next. A timer,
  // not a frame callback: frame callbacks wait for the window to render, so a
  // busy or hidden Studio lost more frames with them. After about 100 ms with
  // no new frame (a still screen, or no frame count) it repaints at 30 Hz, as
  // before, so the published track never goes quiet.
  let tick = 0
  let drawnTick = -2
  let lastFrames = -1
  let stillTicks = STILL_TICKS
  const timer = window.setInterval(() => {
    if (closed) return
    tick += 1
    const frames = video.getVideoPlaybackQuality?.().totalVideoFrames
    const fresh = frames !== undefined && frames !== lastFrames
    if (fresh) stillTicks = 0
    else if (stillTicks < STILL_TICKS) {
      stillTicks += 1
      return
    }
    // At most every other tick: the 30 fps the publication carries. A new
    // frame seen too soon is drawn on the next tick.
    if (tick - drawnTick < 2) return
    drawnTick = tick
    if (frames !== undefined) lastFrames = frames
    paint()
  }, TICK_MS)
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
