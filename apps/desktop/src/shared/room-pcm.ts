/** S7a test transport, NOT a room capability or a production microphone mode. */
export const ROOM_PCM = {
  version: 1,
  role: 'host-microphone-test',
  sampleRate: 48000,
  channels: 1,
  frames: 480,
  queueFrames: 1920,
  marker: { syncHz: 3500, zeroHz: 1500, oneHz: 2500, bitFrames: 960, bits: 12, frames: 13440 },
  productionQualified: false
} as const
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
