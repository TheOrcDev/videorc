/**
 * Plan 249 S13b: processed camera contributions. Mirrors the native
 * `room_frame_bridge.rs` processed role and `protocol-fixtures/room-camera.json`.
 *
 * - One camera owner: while the room publishes a processed camera, the native
 *   camera keeps the device; the browser never opens it.
 * - Frames are the native compositor's own camera-source processing (key,
 *   speck cleanup, despill, camera look). Low-light compensation is a device
 *   setting the native owner applies when it opens the camera. Scene crop,
 *   fit, mirror and mask stay S12's: never baked into the frame.
 * - Logical size: the source aspect, scaled down to S10's limits, never
 *   cropped. `ptsUs` is native observation time (no per-frame capture time).
 * - Disabled and unqualified: `ROOM_PROCESSED_CAMERA_ENABLED` is false; only an
 *   unpackaged development run with every gate set can open it.
 */
// Self-contained (no imports): Node acceptance scripts load this mirror directly.
export const ROOM_PROCESSED_CAMERA_ENABLED = false
/** Same value as `ROOM_CAMERA_ROLE` in `room-frame.ts` (a test pins them). */
export const ROOM_CAMERA_ROLE = 'host-camera'

/** S10's logical-dimension rule (as `cameraAlphaDimensions` in `room-frame.ts`). */
function cameraAlphaDimensions(width: number, height: number): boolean {
  return (
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    width >= 64 &&
    height >= 64 &&
    width <= 640 &&
    height <= 640 &&
    width % 2 === 0 &&
    height % 2 === 0 &&
    width * height <= 640 * 360
  )
}
export const ROOM_CAMERA_MAX_FPS = 30

/** The largest even size with the source aspect within S10's limits. */
export function logicalSizeFor(
  sourceWidth: number,
  sourceHeight: number
): { width: number; height: number } | null {
  if (!(sourceWidth > 0 && sourceHeight > 0)) return null
  const scale = Math.min(
    640 / sourceWidth,
    640 / sourceHeight,
    Math.sqrt((640 * 360) / (sourceWidth * sourceHeight)),
    1
  )
  // A tiny epsilon keeps 1920 x (640 / 1920) from flooring to 638.
  const even = (value: number): number => Math.floor((value + 1e-6) / 2) * 2
  const size = { width: even(sourceWidth * scale), height: even(sourceHeight * scale) }
  return cameraAlphaDimensions(size.width, size.height) ? size : null
}

/** Fixture camera zones, as fractions of the source (debug acceptance only). */
export const FIXTURE_CAMERA = Object.freeze({
  key: [0, 255, 0],
  subject: { x0: 0.3, x1: 0.7, y0: 0.25, y1: 0.85, rgb: [200, 150, 120] },
  fringe: { width: 0.03, rgb: [150, 200, 110] },
  look: { x0: 0.05, x1: 0.2, y0: 0.05, y1: 0.2, rgb: [128, 128, 128] },
  mirror: { x0: 0.32, x1: 0.4, y0: 0.7, y1: 0.8, rgb: [220, 30, 30] },
  stampFrom: 0.94
})

/** The fixture camera's source RGB at one pixel (native mirror). */
export function fixtureCameraRgb(
  x: number,
  y: number,
  width: number,
  height: number,
  stamp: readonly boolean[]
): [number, number, number] {
  const fx = (x + 0.5) / width
  const fy = (y + 0.5) / height
  const f = FIXTURE_CAMERA
  const inside = (r: { x0: number; x1: number; y0: number; y1: number }): boolean =>
    fx >= r.x0 && fx < r.x1 && fy >= r.y0 && fy < r.y1
  if (fy >= f.stampFrom)
    return stamp[Math.min(31, Math.floor(fx * 32))] ? [255, 255, 255] : [0, 0, 0]
  if (inside(f.look)) return [...f.look.rgb] as [number, number, number]
  if (inside(f.subject)) {
    if (inside(f.mirror)) return [...f.mirror.rgb] as [number, number, number]
    const edge = Math.min(
      fx - f.subject.x0,
      f.subject.x1 - fx,
      fy - f.subject.y0,
      f.subject.y1 - fy
    )
    return [...(edge < f.fringe.width ? f.fringe.rgb : f.subject.rgb)] as [number, number, number]
  }
  return [...f.key] as [number, number, number]
}

export type RoomCameraResources = {
  nativeSources: number
  nativeLeases: number
  sockets: number
  ipcRequests: number
  timers: number
  /** The size a new processed generation must open at; null without a frame. */
  logicalWidth: number | null
  logicalHeight: number | null
  /** The layout the producer processes with: the scene's, or the default. */
  layoutSource?: 'scene' | 'default'
  keyOn?: boolean
  /** The native layout's mirror; never baked into the camera-role frame. */
  nativeMirror?: boolean
  look?: { brightness: number; contrast: number; saturation: number }
  /** The open room kept the native camera instead of lending it. */
  keptForRoom: boolean
  /** The browser room holds the camera (never together with keptForRoom). */
  lentToBrowserRoom: boolean
  /** The debug fixture substitutes the device. */
  fixture: boolean
}
const count = (value: unknown): boolean =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
export function parseRoomCameraResources(value: unknown): RoomCameraResources {
  if (!value || typeof value !== 'object') throw new Error('Camera resources unavailable.')
  const v = value as RoomCameraResources
  if (
    !(['nativeSources', 'nativeLeases', 'sockets', 'ipcRequests', 'timers'] as const).every((key) =>
      count(v[key])
    ) ||
    !(['keptForRoom', 'lentToBrowserRoom', 'fixture'] as const).every(
      (key) => typeof v[key] === 'boolean'
    ) ||
    (v.logicalWidth === null) !== (v.logicalHeight === null) ||
    (v.logicalWidth !== null && !cameraAlphaDimensions(v.logicalWidth, v.logicalHeight as number))
  )
    throw new Error('Camera resources unavailable.')
  return v
}
export type RoomCameraFixtureAction = 'fixture-switch' | 'fixture-unplug'
