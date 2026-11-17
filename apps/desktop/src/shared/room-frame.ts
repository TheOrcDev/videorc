/**
 * Plan 249 S13a: native camera-role frame and clock bridge.
 *
 * A TEST transport, not a room capability or production camera mode. Mirrors
 * `crates/videorc-backend/src/room_frame_bridge.rs` and
 * `protocol-fixtures/room-frame.json`.
 *
 * Camera-role contract (shared with S10 alpha transport and S12 scene geometry):
 * - Presentation role `host-camera`; the LiveKit source stays `camera`. Authority
 *   is this file's own versioned camera-frame publication contract
 *   (`CAMERA_FRAME_CONTRACT`), bound by a trusted controller after SFU
 *   inspection; never frame metadata or a track name. It is deliberately NOT
 *   the S10 `AlphaManifest` (an experimental output-layer envelope); only the
 *   S10 packing and dimension rules are shared.
 * - A frame is the FULL source picture. Native camera processing owns key,
 *   spill and look exactly once; NO scene crop, fit, mirror, radius or mask is
 *   applied. The scene renderer (S12) computes all geometry from the logical,
 *   unpacked size and must not key again.
 * - `packed` alpha uses the S10 packing `rgb-left-alpha-right` with an 8 px
 *   gutter and straight (non-premultiplied) alpha. `opaque` is the named
 *   partial mode until transparent composition is qualified.
 *
 * Clock contract:
 * - `ptsUs`: frame capture time relative to the generation epoch.
 * - `observedAtUs`: actual native pull time relative to the SAME generation
 *   epoch (never process-relative).
 * - `originUs`: generation epoch measured from the process anchor in native
 *   `room_clock`; `null` when unavailable, never zero.
 * - `incarnation`: backend process the origin belongs to. Audio and video may be
 *   paired by origin only within one incarnation.
 * - `VideoFrame.timestamp` = `ptsUs`. Published (encoder) and decoded times are
 *   MEASURED by stamp decoding with explicit uncertainty, never assumed.
 * Not UTC, RTP time, renderer performance time or an archival show clock.
 */
export const ROOM_FRAME = {
  version: 1,
  role: 'host-camera-test',
  cameraRole: 'host-camera',
  packing: 'rgb-left-alpha-right',
  width: 640,
  height: 360,
  gutter: 8,
  packedWidth: 640 * 2 + 8,
  fps: 30,
  leaseSlots: 2,
  headerBytes: 96,
  magic: 0x46435256,
  stampRows: 12,
  stampBits: 32,
  requestTimeoutMs: 2000,
  productionQualified: false
} as const

/**
 * Server-readable, NON-authoritative layout descriptor carried in the LiveKit
 * track name (TrackInfo.name), frozen with S22 ISO. The host grant has no
 * `canUpdateOwnMetadata` and LiveKit has no per-track attributes, so no grant is
 * widened for it. Authority stays the SFU facts plus `bindCameraFramePublication`.
 *
 * Format: `videorc:camera-frame:v1;frameLayout=<layout>;generation=<n>` with
 * layout `opaque` or `rgb-left-alpha-right:g8`. A layout is fixed for the life
 * of one publication: any opaque<->packed change unpublishes and publishes a
 * NEW track (new SID); never replaceTrack or an in-band switch. A camera track
 * without this name is the existing browser camera and carries no descriptor.
 */
export const CAMERA_FRAME_TRACK_NAME_PREFIX = 'videorc:camera-frame:v1'
export const CAMERA_FRAME_LAYOUT_KEY = 'frameLayout'
export type CameraFrameLayout = 'opaque' | 'rgb-left-alpha-right:g8'
export const cameraFrameLayout = (alphaMode: 'opaque' | 'packed'): CameraFrameLayout =>
  alphaMode === 'packed' ? 'rgb-left-alpha-right:g8' : 'opaque'
export function cameraFrameTrackName(layout: CameraFrameLayout, generation: number): string {
  if (!Number.isSafeInteger(generation) || generation < 1) throw new Error('Invalid generation.')
  return `${CAMERA_FRAME_TRACK_NAME_PREFIX};${CAMERA_FRAME_LAYOUT_KEY}=${layout};generation=${generation}`
}
export function parseCameraFrameTrackName(
  name: unknown
): { layout: CameraFrameLayout; generation: number } | null {
  if (typeof name !== 'string' || name.length > 128) return null
  const match =
    /^videorc:camera-frame:v1;frameLayout=(opaque|rgb-left-alpha-right:g8);generation=([1-9][0-9]{0,15})$/.exec(
      name
    )
  const generation = match ? Number(match[2]) : NaN
  return match && Number.isSafeInteger(generation)
    ? { layout: match[1] as CameraFrameLayout, generation }
    : null
}

export const ROOM_FRAME_PAYLOAD_BYTES = ROOM_FRAME.packedWidth * ROOM_FRAME.height * 4
export const ROOM_FRAME_MESSAGE_BYTES = ROOM_FRAME.headerBytes + ROOM_FRAME_PAYLOAD_BYTES

export type CameraRoleAlphaMode = 'opaque' | 'packed'
/** What a scene/program consumer reads about the camera role; geometry stays the scene's. */
export type CameraRoleFrameDescriptor = {
  role: typeof ROOM_FRAME.cameraRole
  alphaMode: CameraRoleAlphaMode
  packing: typeof ROOM_FRAME.packing | null
  logicalWidth: number
  logicalHeight: number
  straightAlpha: true
  keyApplied: 'native-once' | 'none'
  geometryApplied: 'none'
}
export function cameraRoleDescriptor(alphaMode: CameraRoleAlphaMode): CameraRoleFrameDescriptor {
  return {
    role: ROOM_FRAME.cameraRole,
    alphaMode,
    packing: alphaMode === 'packed' ? ROOM_FRAME.packing : null,
    logicalWidth: ROOM_FRAME.width,
    logicalHeight: ROOM_FRAME.height,
    straightAlpha: true,
    keyApplied: alphaMode === 'packed' ? 'native-once' : 'none',
    geometryApplied: 'none'
  }
}

/** Packed camera mode stays disabled and unqualified independently of opaque
 * camera support. A CAMERA grant permits attempting the experiment only. */
export const CAMERA_PACKED_ALPHA_ENABLED = false
export const CAMERA_FRAME_CONTRACT = 'videorc:experimental:camera-frame:v1'

/** S10 logical-dimension rule (even, 64..640 each, at most 640x360 pixels). */
export function cameraAlphaDimensions(width: number, height: number): boolean {
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

/** Trusted controller input after inspecting actual SFU publications. Native
 * frames exist before any SID, so a publication is bound to a native
 * generation here, at the publisher/receiver boundary. */
export type CameraFrameAuthority = {
  contract: typeof CAMERA_FRAME_CONTRACT
  show: string
  hostIdentity: string
  publisherSid: string
  trackSid: string
  epoch: string
  generation: number
  source: 'camera'
  canPublishSources: readonly string[]
}
export type CameraFramePublication = {
  version: 1
  contract: typeof CAMERA_FRAME_CONTRACT
  show: string
  publisherSid: string
  trackSid: string
  epoch: string
  generation: number
  descriptor: CameraRoleFrameDescriptor
}

const sidOf = (value: unknown, prefix: string): value is string =>
  typeof value === 'string' && new RegExp(`^${prefix}_[a-zA-Z0-9_-]{1,96}$`).test(value)

/**
 * Bind one native generation to one actual camera publication. Refuses a
 * mismatched generation, a non-host publisher, a missing CAMERA grant, malformed
 * SIDs/epoch and, unless the caller is an explicit experiment, packed alpha.
 */
export function bindCameraFramePublication(
  authority: CameraFrameAuthority,
  nativeGeneration: number,
  alphaMode: CameraRoleAlphaMode,
  options: { experiment?: boolean } = {}
): CameraFramePublication | null {
  const descriptor = cameraRoleDescriptor(alphaMode)
  if (
    authority.contract !== CAMERA_FRAME_CONTRACT ||
    authority.source !== 'camera' ||
    !authority.canPublishSources.includes('camera') ||
    typeof authority.show !== 'string' ||
    !authority.show ||
    authority.hostIdentity !== `host:${authority.show}` ||
    !sidOf(authority.publisherSid, 'PA') ||
    !sidOf(authority.trackSid, 'TR') ||
    typeof authority.epoch !== 'string' ||
    !authority.epoch ||
    authority.epoch.length > 96 ||
    !frameInteger(authority.generation) ||
    authority.generation === 0 ||
    authority.generation !== nativeGeneration ||
    (alphaMode === 'packed' &&
      ((!CAMERA_PACKED_ALPHA_ENABLED && options.experiment !== true) ||
        !cameraAlphaDimensions(descriptor.logicalWidth, descriptor.logicalHeight)))
  )
    return null
  return {
    version: 1,
    contract: CAMERA_FRAME_CONTRACT,
    show: authority.show,
    publisherSid: authority.publisherSid,
    trackSid: authority.trackSid,
    epoch: authority.epoch,
    generation: authority.generation,
    descriptor
  }
}

/** Strict parse of controller input (exact keys); anything else is no authority. */
export function parseCameraFrameAuthority(value: unknown): CameraFrameAuthority | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  if (
    Object.keys(v).sort().join(',') !==
      'canPublishSources,contract,epoch,generation,hostIdentity,publisherSid,show,source,trackSid' ||
    !Array.isArray(v.canPublishSources) ||
    v.canPublishSources.length > 8 ||
    !v.canPublishSources.every((s) => typeof s === 'string')
  )
    return null
  const authority = {
    ...v,
    canPublishSources: [...v.canPublishSources]
  } as unknown as CameraFrameAuthority
  return bindCameraFramePublication(authority, authority.generation, 'opaque') ? authority : null
}

/** What a receiver itself observed about the subscribed or published track. */
export type CameraFramePublicationFacts = {
  identity: string
  participantSid: string
  trackSid: string
  source: string
}
/** The authority applies only to that exact publication. */
export function cameraFrameBinds(
  authority: CameraFrameAuthority | null,
  facts: CameraFramePublicationFacts
): boolean {
  return (
    !!authority &&
    facts.source === 'camera' &&
    facts.identity === authority.hostIdentity &&
    facts.participantSid === authority.publisherSid &&
    facts.trackSid === authority.trackSid
  )
}

/** LiveKit `TrackSource` numbers in a participant's publish permission. */
export function publishSourceNames(sources: readonly number[] | undefined): string[] {
  const names = ['unknown', 'camera', 'microphone', 'screen_share', 'screen_share_audio']
  return (sources ?? []).map((source) => names[source] ?? 'unknown')
}

/** Platform capabilities are separate and none is qualified. Electron 39.8 has no
 * renderer import for a native shared texture (only offscreen-paint handles), so
 * the measured candidate is a bounded raw-frame copy, never BMP/JPEG polling. */
export type RoomFramePlatformCapability = {
  platform: 'darwin' | 'win32' | 'linux'
  transport: 'frame-copy' | 'unsupported'
  sharedTexture: 'unavailable-in-electron-39'
  qualified: false
  reason: string
}
export function roomFrameCapability(platform: string): RoomFramePlatformCapability {
  if (platform === 'darwin' || platform === 'win32')
    return {
      platform,
      transport: 'frame-copy',
      sharedTexture: 'unavailable-in-electron-39',
      qualified: false,
      reason: `Camera bridge on ${platform === 'darwin' ? 'macOS' : 'Windows'} is unmeasured; acquisition and managed budgets have not run.`
    }
  return {
    platform: 'linux',
    transport: 'unsupported',
    sharedTexture: 'unavailable-in-electron-39',
    qualified: false,
    reason: `Camera bridge is unsupported on ${platform}: no platform acceptance is planned.`
  }
}

export type RoomFrameAction = 'open' | 'pull' | 'reset' | 'close'
export type RoomFrameRelease = { sequence: number; surfaceEpoch: number }
export type RoomFrameCommand = {
  action: RoomFrameAction
  generation: number
  role: typeof ROOM_FRAME.role
  width: 640
  height: 360
  fps: 30
  packing: typeof ROOM_FRAME.packing
  serial: number
  release?: RoomFrameRelease | null
}
export type RoomFrameOpened = {
  generation: number
  surfaceEpoch: number
  originUs: number | null
  incarnation: number | null
}
export type RoomFrameReset = { generation: number; surfaceEpoch: number; revokedLeases: number }
export type RoomFrameIdle = {
  frame: null
  reason: 'not-due' | 'lease-stalled'
  staleReleases: number
  leaseStalls: number
}
export type RoomFrameHeader = {
  serial: number
  packed: boolean
  width: number
  height: number
  surfaceEpoch: number
  leaseSlot: number
  generation: number
  sequence: number
  ptsUs: number
  observedAtUs: number
  originUs: number | null
  incarnation: number | null
  droppedFrames: number
  leaseStalls: number
}
export type RoomFrame = { header: RoomFrameHeader; pixels: Uint8Array<ArrayBuffer> }
export type RoomFrameReply = RoomFrameOpened | RoomFrameReset | RoomFrameIdle | RoomFrame | null

export const frameInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const u32 = (value: unknown): value is number => frameInteger(value) && value <= 0xffff_ffff

export function roomFrameCommand(
  action: RoomFrameAction,
  generation: number,
  serial: number,
  release?: RoomFrameRelease
): RoomFrameCommand {
  return {
    action,
    generation,
    role: ROOM_FRAME.role,
    width: ROOM_FRAME.width,
    height: ROOM_FRAME.height,
    fps: ROOM_FRAME.fps,
    packing: ROOM_FRAME.packing,
    serial,
    ...(release ? { release } : {})
  }
}

export function parseRoomFrameCommand(value: unknown): RoomFrameCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid frame command.')
  const v = value as RoomFrameCommand
  const keys = Object.keys(v)
  const release = v.release
  if (
    !['open', 'pull', 'reset', 'close'].includes(v.action) ||
    !frameInteger(v.generation) ||
    v.generation === 0 ||
    v.role !== ROOM_FRAME.role ||
    v.width !== ROOM_FRAME.width ||
    v.height !== ROOM_FRAME.height ||
    v.fps !== ROOM_FRAME.fps ||
    v.packing !== ROOM_FRAME.packing ||
    !u32(v.serial) ||
    keys.length > 9 ||
    keys.some(
      (key) =>
        ![
          'action',
          'generation',
          'role',
          'width',
          'height',
          'fps',
          'packing',
          'serial',
          'release'
        ].includes(key)
    ) ||
    (release !== undefined &&
      release !== null &&
      (v.action !== 'pull' ||
        typeof release !== 'object' ||
        Object.keys(release).length !== 2 ||
        !frameInteger(release.sequence) ||
        !u32(release.surfaceEpoch)))
  )
    throw new Error('Invalid frame command.')
  return v
}

const LIMIT = Number.MAX_SAFE_INTEGER
function readU64(view: DataView, at: number): number | null {
  const value = view.getBigUint64(at, true)
  return value <= BigInt(LIMIT) ? Number(value) : null
}

/**
 * Validates the complete header and exact length BEFORE any pixel copy or
 * VideoFrame allocation. Sums used later (originUs + observedAtUs) are checked.
 */
export function parseRoomFrameHeader(
  bytes: Uint8Array,
  expected?: { generation?: number; serial?: number }
): RoomFrameHeader {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== ROOM_FRAME_MESSAGE_BYTES)
    throw new Error('Invalid frame length.')
  const view = new DataView(bytes.buffer, bytes.byteOffset, ROOM_FRAME.headerBytes)
  if (
    view.getUint32(0, true) !== ROOM_FRAME.magic ||
    view.getUint16(4, true) !== ROOM_FRAME.version
  )
    throw new Error('Invalid frame header.')
  const flags = view.getUint16(6, true)
  const rawOrigin = view.getBigUint64(64, true)
  const header: RoomFrameHeader = {
    serial: view.getUint32(8, true),
    packed: (flags & 1) === 1,
    width: view.getUint32(12, true),
    height: view.getUint32(16, true),
    surfaceEpoch: view.getUint32(20, true),
    leaseSlot: view.getUint32(24, true),
    generation: readU64(view, 32) ?? -1,
    sequence: readU64(view, 40) ?? -1,
    ptsUs: readU64(view, 48) ?? -1,
    observedAtUs: readU64(view, 56) ?? -1,
    originUs: rawOrigin === 0xffff_ffff_ffff_ffffn ? null : (readU64(view, 64) ?? -1),
    incarnation: readU64(view, 72) || null,
    droppedFrames: readU64(view, 80) ?? -1,
    leaseStalls: readU64(view, 88) ?? -1
  }
  if (
    flags !== 1 ||
    view.getUint32(28, true) !== 0 ||
    header.width !== ROOM_FRAME.packedWidth ||
    header.height !== ROOM_FRAME.height ||
    header.surfaceEpoch === 0 ||
    header.leaseSlot >= ROOM_FRAME.leaseSlots ||
    ![
      header.generation,
      header.sequence,
      header.ptsUs,
      header.observedAtUs,
      header.droppedFrames,
      header.leaseStalls
    ].every(frameInteger) ||
    header.generation === 0 ||
    header.ptsUs !== framePtsUs(header.sequence) ||
    header.observedAtUs < header.ptsUs ||
    (header.originUs !== null &&
      (!frameInteger(header.originUs) ||
        header.incarnation === null ||
        header.originUs + header.observedAtUs > LIMIT)) ||
    (expected?.generation !== undefined && header.generation !== expected.generation) ||
    (expected?.serial !== undefined && header.serial !== expected.serial)
  )
    throw new Error('Invalid frame header.')
  return header
}

export function parseRoomFrameReply(value: unknown, generation?: number): RoomFrameReply {
  if (value === null) return null
  if (!value || typeof value !== 'object') throw new Error('Invalid frame reply.')
  const v = value as Record<string, unknown>
  if ('header' in v && 'pixels' in v) {
    const pixels = v.pixels
    if (!(pixels instanceof Uint8Array) || pixels.byteLength !== ROOM_FRAME_PAYLOAD_BYTES)
      throw new Error('Invalid frame pixels.')
    const h = v.header as RoomFrameHeader
    if (
      !h ||
      typeof h !== 'object' ||
      h.width !== ROOM_FRAME.packedWidth ||
      h.height !== ROOM_FRAME.height ||
      !frameInteger(h.generation) ||
      (generation !== undefined && h.generation !== generation) ||
      !frameInteger(h.sequence) ||
      h.ptsUs !== framePtsUs(h.sequence) ||
      !frameInteger(h.observedAtUs) ||
      h.observedAtUs < h.ptsUs ||
      !u32(h.surfaceEpoch) ||
      !frameInteger(h.leaseSlot) ||
      h.leaseSlot >= ROOM_FRAME.leaseSlots ||
      !frameInteger(h.droppedFrames) ||
      !frameInteger(h.leaseStalls) ||
      (h.originUs !== null &&
        (!frameInteger(h.originUs) ||
          !frameInteger(h.incarnation) ||
          h.originUs + h.observedAtUs > LIMIT))
    )
      throw new Error('Invalid frame header.')
    return { header: h, pixels: pixels as Uint8Array<ArrayBuffer> }
  }
  if ('revokedLeases' in v) {
    if (
      !frameInteger(v.generation) ||
      !u32(v.surfaceEpoch) ||
      !frameInteger(v.revokedLeases) ||
      (v.revokedLeases as number) > ROOM_FRAME.leaseSlots
    )
      throw new Error('Invalid frame reset.')
    return v as RoomFrameReset
  }
  if ('reason' in v) {
    if (
      v.frame !== null ||
      !['not-due', 'lease-stalled'].includes(v.reason as string) ||
      !frameInteger(v.staleReleases) ||
      !frameInteger(v.leaseStalls)
    )
      throw new Error('Invalid frame idle reply.')
    return v as RoomFrameIdle
  }
  if (
    !frameInteger(v.generation) ||
    (generation !== undefined && v.generation !== generation) ||
    !u32(v.surfaceEpoch) ||
    !(v.originUs === null || frameInteger(v.originUs)) ||
    !(v.incarnation === null || frameInteger(v.incarnation)) ||
    (v.originUs !== null && v.incarnation === null)
  )
    throw new Error('Invalid frame open reply.')
  return v as RoomFrameOpened
}

export const isRoomFrame = (reply: RoomFrameReply): reply is RoomFrame =>
  !!reply && 'header' in reply

/** Absolute native capture time in the anchor domain, or null (never zero). */
export function nativeCaptureUs(header: RoomFrameHeader): number | null {
  return header.originUs === null ? null : header.originUs + header.ptsUs
}

export function framePtsUs(sequence: number): number {
  return Math.floor((sequence * 1_000_000) / ROOM_FRAME.fps)
}

/** 24-bit frame SEQUENCE plus an 8-bit check, least significant bit first. Not
 * S10's `stampBits` (wall-clock milliseconds) and not a clock: timing comes only
 * from measured brackets, never from equal VideoFrame timestamps. */
export function frameStampBits(sequence: number): boolean[] {
  const n = sequence % 0x1000000
  const check = ((n >>> 16) ^ (n >>> 8) ^ n) & 255
  return Array.from({ length: 32 }, (_, i) =>
    i < 24 ? ((n >>> i) & 1) === 1 : ((check >>> (i - 24)) & 1) === 1
  )
}

/** Luma samples at the 32 stamp cell centers. Ambiguous cells refuse decoding. */
export function decodeFrameStamp(samples: readonly number[]): number | null {
  if (samples.length !== 32 || samples.some((v) => !Number.isFinite(v) || (v > 96 && v < 160)))
    return null
  let n = 0
  let check = 0
  for (let i = 0; i < 32; i++)
    if (samples[i]! >= 160) {
      if (i < 24) n |= 1 << i
      else check |= 1 << (i - 24)
    }
  return (((n >>> 16) ^ (n >>> 8) ^ n) & 255) === check ? n : null
}

export type Rgba = [number, number, number, number]
/** The logical straight-alpha pixel the camera role carries (native mirror). */
export function fixturePixel(x: number, y: number, sequence: number, stamp: boolean[]): Rgba {
  const { width: w, height: h, stampRows, stampBits, fps } = ROOM_FRAME
  if (y >= h - stampRows) {
    const v = stamp[Math.min(stampBits - 1, Math.floor((x * stampBits) / w))] ? 255 : 0
    return [v, v, v, 255]
  }
  if (y < h / 4) {
    if (x < w / 4) return [255, 0, 255, 255]
    if (x < w / 2) return [0, 255, 0, 128]
    if (x < (w * 3) / 4) return [0, 0, 0, 0]
    return sequence % fps === 0 ? [255, 255, 255, 255] : [0, 0, 0, 255]
  }
  const bar = (sequence * 8) % w
  return (x + w - bar) % w < 16 ? [255, 255, 0, 255] : [64, 64, 64, 255]
}

/** The opaque transport pixel: color left, black gutter, alpha as gray right. */
export function packedPixel(px: number, y: number, sequence: number, stamp: boolean[]): Rgba {
  const { width: w, gutter } = ROOM_FRAME
  if (px < w) {
    const [r, g, b] = fixturePixel(px, y, sequence, stamp)
    return [r, g, b, 255]
  }
  if (px < w + gutter) return [0, 0, 0, 255]
  const a = fixturePixel(px - w - gutter, y, sequence, stamp)[3]
  return [a, a, a, 255]
}

/** Logical-pixel probes for decoded packed frames: solid, half and clear alpha. */
export const CAMERA_ALPHA_PATCHES = [
  { x: 80, y: 45, rgba: [255, 0, 255, 255] },
  { x: 240, y: 45, rgba: [0, 255, 0, 128] },
  { x: 400, y: 45, rgba: [0, 0, 0, 0] }
] as const
export const CAMERA_FLASH_PROBE = { x: 560, y: 45 } as const

export type RoomFrameResources = {
  nativeSources: number
  nativeLeases: number
  sockets: number
  ipcRequests: number
  timers: number
}
export function parseRoomFrameResources(value: unknown): RoomFrameResources {
  if (!value || typeof value !== 'object')
    throw new Error('Frame resource observation unavailable.')
  const v = value as RoomFrameResources
  if (
    !(['nativeSources', 'nativeLeases', 'sockets', 'ipcRequests', 'timers'] as const).every((key) =>
      frameInteger(v[key])
    )
  )
    throw new Error('Frame resource observation unavailable.')
  return v
}
