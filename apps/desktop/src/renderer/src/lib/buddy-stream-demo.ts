import type { CohostAvatarState, OverlayRect } from './backend'
import { buddyOverlayMetrics } from './buddy-overlay'

// Step 1's live demo (plan 170 D14): the Buddy in the corner of a stream,
// idle, then a follower arrives and it greets them, answers a question and
// laughs. Built from the four poses and the stream's own bubble rasterizer,
// no video file. Pure: the component plays it.

export interface BuddyDemoFrame {
  pose: CohostAvatarState
  /** Which of the copy document's three bubbles shows (in order), or none. */
  bubble: 0 | 1 | 2 | null
  /** "New follower: Mira" shows. */
  chip: boolean
  ms: number
}

/** Idle between bubbles; the chip arrives just before the first one. */
export const BUDDY_DEMO_TIMELINE: readonly BuddyDemoFrame[] = [
  { pose: 'idle', bubble: null, chip: false, ms: 1400 },
  { pose: 'idle', bubble: null, chip: true, ms: 1000 },
  { pose: 'talk', bubble: 0, chip: true, ms: 2800 },
  { pose: 'idle', bubble: null, chip: false, ms: 1100 },
  { pose: 'talk', bubble: 1, chip: false, ms: 3400 },
  { pose: 'idle', bubble: null, chip: false, ms: 800 },
  { pose: 'laugh', bubble: 2, chip: false, ms: 2200 },
  { pose: 'idle', bubble: null, chip: false, ms: 1200 }
]

/** With reduced motion, one still: the greeting, the chip still up. */
export const BUDDY_DEMO_STILL_FRAME = 2

export function buddyDemoNextFrame(index: number): number {
  return (index + 1) % BUDDY_DEMO_TIMELINE.length
}

/**
 * The bubble is drawn by the overlay's own rasterizer on a 4K-sized canvas
 * (36 px type, crisp on Retina) for an avatar 330 px wide, so the copy
 * wraps to two or three lines, then shown at about 2.7 times its stream
 * scale so it reads in a small frame.
 */
export const BUDDY_DEMO_CANVAS = { width: 3840, height: 2160 } as const
const DEMO_AVATAR_PX = 330
export const BUDDY_DEMO_RECT: OverlayRect = {
  x: 0,
  y: 0,
  w: DEMO_AVATAR_PX / BUDDY_DEMO_CANVAS.width,
  h: DEMO_AVATAR_PX / BUDDY_DEMO_CANVAS.height
}
/** The bubble's type as a fraction of the frame's width. */
const DEMO_FONT_FRACTION = 0.026

/** The bubble bitmap's width as a percentage of the frame's width. */
export function buddyDemoBubbleWidthPercent(): number {
  const metrics = buddyOverlayMetrics(
    BUDDY_DEMO_CANVAS.width,
    BUDDY_DEMO_CANVAS.height,
    Math.floor(BUDDY_DEMO_RECT.w * BUDDY_DEMO_CANVAS.width),
    'speech'
  )
  const bitmapWidth = metrics.avatarPx + metrics.padPx * 2
  return (bitmapWidth * DEMO_FONT_FRACTION * 100) / metrics.fontPx
}
