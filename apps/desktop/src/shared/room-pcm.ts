/** S7a test transport, NOT a room capability or a production microphone mode. */
export const ROOM_PCM = {
  version: 1,
  role: 'host-microphone-test',
  sampleRate: 48000,
  channels: 1,
  frames: 480,
  queueFrames: 1920,
  marker: { syncHz: 3500, zeroHz: 1500, oneHz: 2500, bitFrames: 960, bits: 12, frames: 13440 },
  productionQualified: false,
  clock: { timeline: 'synthetic', fields: ['originUs', 'incarnation'], absent: null }
} as const
/**
 * Plan 249 S13a common native clock (mirrors `room_frame_bridge` / `room-frame.ts`):
 * - `firstSampleUs` (timeline position) and `observedAtUs` (actual native pull)
 *   are relative to the generation epoch.
 * - `originUs`: that same epoch measured from the native `room_clock` anchor;
 *   `null` when unavailable, never zero. `incarnation`: backend process the
 *   origin belongs to (required when `originUs` is present).
 * - Absolute native time = `originUs + firstSampleUs`. Pair audio with video
 *   origins only when incarnations are equal. For the S7b microphone this is
 *   the PROCESSED timeline position, not raw capture time; for S7a it is the
 *   synthetic fixture timeline.
 */
export type RoomPcmClock = { originUs: number | null; incarnation: number | null }
export type RoomPcmOpened = { generation: number } & RoomPcmClock
export type RoomPcmCommand = {
  action: 'open' | 'pull' | 'close'
  generation: number
  role: typeof ROOM_PCM.role
  sampleRate: 48000
  channels: 1
  frames: 480
}
export type RoomPcmFrame = {
  generation: number
  sequence: number
  firstSample: number
  firstSampleUs: number
  observedAtUs: number
  sampleRate: 48000
  channels: 1
  frames: 480
  droppedFrames: number
  originUs: number | null
  incarnation: number | null
  samples: number[]
}
export function pcmInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
export function parseRoomPcmCommand(value: unknown): RoomPcmCommand {
  if (!value || typeof value !== 'object') throw new Error('Invalid PCM command.')
  const v = value as RoomPcmCommand
  if (
    !['open', 'pull', 'close'].includes(v.action) ||
    !pcmInteger(v.generation) ||
    v.generation === 0 ||
    v.role !== ROOM_PCM.role ||
    v.sampleRate !== 48000 ||
    v.channels !== 1 ||
    v.frames !== 480 ||
    Object.keys(v).length !== 6
  )
    throw new Error('Invalid PCM command.')
  return v
}
/** Nullable origin + incarnation; origin requires a positive incarnation and,
 * when given, `originUs + observedAtUs` must stay a safe integer. */
export function validPcmClock(v: RoomPcmClock, observedAtUs = 0): boolean {
  if (v.incarnation !== null && (!pcmInteger(v.incarnation) || v.incarnation === 0)) return false
  if (v.originUs === null) return true
  return (
    pcmInteger(v.originUs) &&
    v.incarnation !== null &&
    v.originUs + observedAtUs <= Number.MAX_SAFE_INTEGER
  )
}
export function parseRoomPcmOpened(value: unknown, generation?: number): RoomPcmOpened {
  if (!value || typeof value !== 'object') throw new Error('Invalid PCM open reply.')
  const v = value as RoomPcmOpened
  if (
    Object.keys(v).length !== 3 ||
    !pcmInteger(v.generation) ||
    v.generation === 0 ||
    (generation !== undefined && generation !== v.generation) ||
    !validPcmClock(v)
  )
    throw new Error('Invalid PCM open reply.')
  return v
}
/** Absolute native time of the first sample in the anchor domain, or null (never zero). */
export function pcmNativeCaptureUs(frame: RoomPcmFrame): number | null {
  return frame.originUs === null ? null : frame.originUs + frame.firstSampleUs
}
/** Check metadata/epoch/length before traversing or copying sample storage. */
export function parseRoomPcmFrame(value: unknown, generation?: number): RoomPcmFrame {
  if (!value || typeof value !== 'object') throw new Error('Invalid PCM frame.')
  const v = value as RoomPcmFrame
  if (
    !pcmInteger(v.generation) ||
    v.generation === 0 ||
    (generation !== undefined && generation !== v.generation) ||
    !pcmInteger(v.sequence) ||
    !pcmInteger(v.firstSample) ||
    !pcmInteger(v.firstSampleUs) ||
    !pcmInteger(v.observedAtUs) ||
    v.observedAtUs < v.firstSampleUs + 10000 ||
    !pcmInteger(v.droppedFrames) ||
    v.sampleRate !== 48000 ||
    v.channels !== 1 ||
    v.frames !== 480 ||
    v.firstSample !== v.sequence * 480 ||
    v.firstSampleUs !== v.sequence * 10000 ||
    !validPcmClock(v, v.observedAtUs) ||
    !Array.isArray(v.samples) ||
    v.samples.length !== 480
  )
    throw new Error('Invalid PCM frame.')
  for (const sample of v.samples)
    if (!Number.isFinite(sample) || Math.abs(sample) > 1) throw new Error('Invalid PCM sample.')
  return v
}
export const roomPcmCommand = (
  action: RoomPcmCommand['action'],
  generation: number
): RoomPcmCommand => ({
  action,
  generation,
  role: ROOM_PCM.role,
  sampleRate: 48000,
  channels: 1,
  frames: 480
})

export type RoomPcmResources = {
  nativeSources: number
  sockets: number
  ipcRequests: number
  timers: number
}
export function parseRoomPcmResources(value: unknown): RoomPcmResources {
  if (!value || typeof value !== 'object') throw new Error('PCM resource observation unavailable.')
  const v = value as RoomPcmResources
  if (
    !['nativeSources', 'sockets', 'ipcRequests', 'timers'].every((key) =>
      pcmInteger(v[key as keyof RoomPcmResources])
    )
  )
    throw new Error('PCM resource observation unavailable.')
  return v
}
