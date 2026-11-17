/**
 * Plan 249 S23 (D10): the room's Program preview as Videorc Camera's picture.
 * Mirrors the native `room_program_camera.rs` and
 * `protocol-fixtures/room-program-camera.json`.
 *
 * - What it is: the Show stage's Program preview (S6 `program-page-report`),
 *   the desktop's reconstruction of what the program page reports drawing. It
 *   is never the encoded stream or a runner return (`encodedOutput: false`).
 * - Opt-in per room: the host turns it on from the Program preview; it never
 *   turns on by itself, is not remembered across rooms and ends with the room.
 *   While it is on, Videorc Camera shows the room program or, when frames stop
 *   (Show stage closed, renderer gone), a black paused still. It never falls
 *   back to the Studio program or to a raw camera while on.
 * - One upload per room generation. The upload is the owner: when it closes,
 *   the camera returns to its Studio source.
 * - Feedback: Videorc Camera is never the room's camera (`pickRoomCameraDevice`).
 * - Disabled and unqualified: `ROOM_PROGRAM_CAMERA_PRODUCTION_ENABLED` is false;
 *   only an unpackaged development run with `VIDEORC_ROOM_PROGRAM_CAMERA=1` (main
 *   and a debug backend) offers it.
 */
// Self-contained (no imports): Node acceptance scripts load this mirror directly.
export const ROOM_PROGRAM_CAMERA_PRODUCTION_ENABLED = false
export const ROOM_PROGRAM_CAMERA_ENV = 'VIDEORC_ROOM_PROGRAM_CAMERA'

/** What Videorc Camera shows while it is on (status `source`). */
export const ROOM_PROGRAM_CAMERA_SOURCE = 'room-program-preview'
export const ROOM_PROGRAM_CAMERA_PAUSED_SOURCE = 'room-program-paused'
/** S6's surface label for the pixels it rasterizes. */
export const ROOM_PROGRAM_CAMERA_VIEW_SOURCE = 'program-page-report'

/** The only frame size: 16:9, the Program preview's own aspect. */
export const ROOM_PROGRAM_CAMERA_WIDTH = 1280
export const ROOM_PROGRAM_CAMERA_HEIGHT = 720
export const ROOM_PROGRAM_CAMERA_FPS = 30
/** Frames older than this pause the camera on a black still. */
export const ROOM_PROGRAM_CAMERA_STALE_MS = 1000

export const ROOM_PROGRAM_CAMERA_HEADER_BYTES = 40
export const ROOM_PROGRAM_CAMERA_FRAME_BYTES =
  ROOM_PROGRAM_CAMERA_WIDTH * ROOM_PROGRAM_CAMERA_HEIGHT * 4
const MAGIC = [0x56, 0x52, 0x50, 0x43] // 'VRPC'
const VERSION = 1
/** Flag bit 0: the payload is straight RGBA (the only payload). */
export const ROOM_PROGRAM_CAMERA_FLAG_RGBA = 1
const MAX_GENERATION = 0xffff_ffff

export interface RoomProgramCameraFrameHeader {
  generation: number
  width: number
  height: number
  /** Strictly increasing within a generation. */
  sequence: number
  /** Renderer wall clock when the frame was drawn, in microseconds. */
  drawnAtUs: number
}

export function validGeneration(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= MAX_GENERATION
}

/**
 * One frame record's 40-byte header (little endian): magic `VRPC`, version 1,
 * flags (bit 0 RGBA), reserved u16, width u32, height u32, generation u32,
 * reserved u32, sequence u64, drawnAtUs u64. Then exactly width x height x 4.
 */
export function encodeRoomProgramCameraHeader(header: RoomProgramCameraFrameHeader): Uint8Array {
  const problem = roomProgramCameraHeaderProblem(header)
  if (problem) throw new Error(problem)
  const bytes = new Uint8Array(ROOM_PROGRAM_CAMERA_HEADER_BYTES)
  const view = new DataView(bytes.buffer)
  MAGIC.forEach((byte, index) => view.setUint8(index, byte))
  view.setUint8(4, VERSION)
  view.setUint8(5, ROOM_PROGRAM_CAMERA_FLAG_RGBA)
  view.setUint32(8, header.width, true)
  view.setUint32(12, header.height, true)
  view.setUint32(16, header.generation, true)
  view.setBigUint64(24, BigInt(header.sequence), true)
  view.setBigUint64(32, BigInt(header.drawnAtUs), true)
  return bytes
}

export function parseRoomProgramCameraHeader(bytes: Uint8Array): RoomProgramCameraFrameHeader {
  if (bytes.byteLength < ROOM_PROGRAM_CAMERA_HEADER_BYTES) throw new Error('Short frame header.')
  const view = new DataView(bytes.buffer, bytes.byteOffset, ROOM_PROGRAM_CAMERA_HEADER_BYTES)
  if (MAGIC.some((byte, index) => view.getUint8(index) !== byte))
    throw new Error('Not a room program frame.')
  if (view.getUint8(4) !== VERSION) throw new Error('Unknown frame version.')
  if (view.getUint8(5) !== ROOM_PROGRAM_CAMERA_FLAG_RGBA) throw new Error('Unknown frame flags.')
  if (view.getUint16(6, true) !== 0 || view.getUint32(20, true) !== 0)
    throw new Error('Reserved bytes are set.')
  const header = {
    width: view.getUint32(8, true),
    height: view.getUint32(12, true),
    generation: view.getUint32(16, true),
    sequence: Number(view.getBigUint64(24, true)),
    drawnAtUs: Number(view.getBigUint64(32, true))
  }
  const problem = roomProgramCameraHeaderProblem(header)
  if (problem) throw new Error(problem)
  return header
}

function roomProgramCameraHeaderProblem(header: RoomProgramCameraFrameHeader): string | null {
  if (header.width !== ROOM_PROGRAM_CAMERA_WIDTH || header.height !== ROOM_PROGRAM_CAMERA_HEIGHT)
    return 'Room program frames are 1280x720.'
  if (!validGeneration(header.generation)) return 'Invalid generation.'
  if (!Number.isSafeInteger(header.sequence) || header.sequence < 1) return 'Invalid sequence.'
  if (!Number.isSafeInteger(header.drawnAtUs) || header.drawnAtUs < 0) return 'Invalid timestamp.'
  return null
}

/** What main accepts from the renderer for one frame. */
export interface RoomProgramCameraFrame {
  generation: number
  sequence: number
  drawnAtUs: number
  /** Straight RGBA, exactly `ROOM_PROGRAM_CAMERA_FRAME_BYTES`. */
  pixels: Uint8Array
}

export function parseRoomProgramCameraFrame(value: unknown): RoomProgramCameraFrame {
  if (!value || typeof value !== 'object') throw new Error('Frame is not an object.')
  const frame = value as Record<string, unknown>
  const keys = Object.keys(frame).sort().join(',')
  if (keys !== 'drawnAtUs,generation,pixels,sequence') throw new Error('Unexpected frame fields.')
  if (!(frame.pixels instanceof Uint8Array)) throw new Error('Frame pixels are not bytes.')
  if (frame.pixels.byteLength !== ROOM_PROGRAM_CAMERA_FRAME_BYTES)
    throw new Error('Frame pixels have the wrong length.')
  const header = {
    generation: frame.generation as number,
    width: ROOM_PROGRAM_CAMERA_WIDTH,
    height: ROOM_PROGRAM_CAMERA_HEIGHT,
    sequence: frame.sequence as number,
    drawnAtUs: frame.drawnAtUs as number
  }
  const problem = roomProgramCameraHeaderProblem(header)
  if (problem) throw new Error(problem)
  return {
    generation: header.generation,
    sequence: header.sequence,
    drawnAtUs: header.drawnAtUs,
    pixels: frame.pixels
  }
}

/** Main's answer to one frame: `busy` and `offline` frames are dropped, never queued. */
export type RoomProgramCameraSendOutcome = 'sent' | 'busy' | 'offline' | 'closed'
export const ROOM_PROGRAM_CAMERA_SEND_OUTCOMES = [
  'sent',
  'busy',
  'offline',
  'closed'
] as const satisfies readonly RoomProgramCameraSendOutcome[]

// --- Feedback guard -----------------------------------------------------------

/** Videorc Camera's device name on every platform (`VIRTUAL_CAMERA_NAME`). */
export const VIDEORC_CAMERA_NAME = 'Videorc Camera'

/**
 * Whether a browser device label is Videorc Camera. Windows appends its own
 * suffix, and Chromium can append a `(vid:pid)` decoration, so a prefix match
 * on the trimmed label (as `is_videorc_camera_windows`).
 */
export function isVideorcCameraLabel(label: string): boolean {
  return label.trim().startsWith(VIDEORC_CAMERA_NAME)
}

/**
 * The room camera for a Sources camera name, by its exact label, and never
 * Videorc Camera: it would carry the room program back into the room. The
 * room opens only an exact named device, so `undefined` means no camera
 * ("The selected camera is unavailable"), never Chromium's default.
 */
export function pickRoomCameraDevice(
  inputs: readonly { deviceId: string; label: string }[],
  cameraName: string | null
): string | undefined {
  if (!cameraName || isVideorcCameraLabel(cameraName)) return undefined
  const wanted = cameraName.trim().toLowerCase()
  return inputs.find(
    (input) => !isVideorcCameraLabel(input.label) && input.label.trim().toLowerCase() === wanted
  )?.deviceId
}

// --- Copy ----------------------------------------------------------------------

export type RoomProgramCameraLineInput = {
  on: boolean
  source?: string | null
  cameraOn: boolean
  cameraAvailable: boolean
}

/** The Program preview's line about Videorc Camera, or null when there is nothing to say. */
export function roomProgramCameraLine(input: RoomProgramCameraLineInput): string | null {
  if (!input.on) return null
  if (!input.cameraAvailable) return "Videorc Camera isn't available on this computer"
  if (!input.cameraOn) return 'Turn on Videorc Camera in Output to send the Program preview'
  if (input.source === ROOM_PROGRAM_CAMERA_SOURCE)
    return 'Videorc Camera shows this Program preview · Not the encoded stream'
  if (input.source === ROOM_PROGRAM_CAMERA_PAUSED_SOURCE)
    return 'Videorc Camera paused · Open the Show stage to send the Program preview'
  return 'Starting Videorc Camera…'
}

// --- Inspection (acceptance evidence) ----------------------------------------

/** `room-program-camera:inspect`: the backend feed plus main's uplink. */
export interface RoomProgramCameraResources {
  enabled: boolean
  owned: boolean
  generation?: number
  lastGeneration: number
  lastFrameAgeMs?: number
  source?: typeof ROOM_PROGRAM_CAMERA_SOURCE | typeof ROOM_PROGRAM_CAMERA_PAUSED_SOURCE
  width: number
  height: number
  viewSource: typeof ROOM_PROGRAM_CAMERA_VIEW_SOURCE
  encodedOutput: false
  counters: {
    uploadsOpened: number
    uploadsRefused: number
    framesAccepted: number
    framesRefused: number
    pauses: number
  }
  /** The camera's `VirtualCameraStatus` as the backend reports it now. */
  camera: Record<string, unknown>
  uplink: {
    generation: number
    framesSent: number
    framesDroppedBusy: number
    bytesSent: number
    closed: boolean
  } | null
}

export function parseRoomProgramCameraResources(value: unknown): RoomProgramCameraResources {
  if (!value || typeof value !== 'object') throw new Error('Resources are not an object.')
  const resources = value as Record<string, unknown>
  const counters = resources.counters as Record<string, unknown> | undefined
  const count = (field: unknown): boolean => Number.isSafeInteger(field) && (field as number) >= 0
  if (
    typeof resources.enabled !== 'boolean' ||
    typeof resources.owned !== 'boolean' ||
    !count(resources.lastGeneration) ||
    resources.width !== ROOM_PROGRAM_CAMERA_WIDTH ||
    resources.height !== ROOM_PROGRAM_CAMERA_HEIGHT ||
    resources.viewSource !== ROOM_PROGRAM_CAMERA_VIEW_SOURCE ||
    resources.encodedOutput !== false ||
    !counters ||
    !['uploadsOpened', 'uploadsRefused', 'framesAccepted', 'framesRefused', 'pauses'].every((key) =>
      count(counters[key])
    ) ||
    !resources.camera ||
    typeof resources.camera !== 'object' ||
    (resources.uplink !== null && typeof resources.uplink !== 'object')
  )
    throw new Error('Unexpected room program resources.')
  if (
    resources.source !== undefined &&
    resources.source !== ROOM_PROGRAM_CAMERA_SOURCE &&
    resources.source !== ROOM_PROGRAM_CAMERA_PAUSED_SOURCE
  )
    throw new Error('Unknown room program source.')
  return resources as unknown as RoomProgramCameraResources
}
