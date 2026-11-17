import { pcmInteger, validPcmClock, type RoomPcmClock } from './room-pcm'
/** Private opt-in system transport; the public publication remains host-aux. */
export const ROOM_SYSTEM_AUDIO = {
  role: 'host-system-audio',
  sampleRate: 48000,
  channels: 2,
  frames: 480,
  queueFrames: 1920,
  ownAppExcluded: true,
  productionQualified: false,
  clock: { timeline: 'capture', fields: ['originUs', 'incarnation'], absent: null }
} as const
/**
 * Plan 249 S13a common native clock, shared with the microphone and the camera
 * frame bridge: `firstSampleUs` and `observedAtUs` are relative to the
 * generation epoch; `originUs` is that epoch on the native `room_clock` anchor
 * (null when unavailable, never zero) and `incarnation` the backend process it
 * belongs to. For system audio `originUs + firstSampleUs` is the CAPTURE
 * timeline (native capture time of the first sample; a discontinuity stays a
 * jump), not the microphone's processed timeline. Pair with other sources only
 * inside one incarnation. Drift, latency and A/V alignment stay unmeasured.
 */
export const ROOM_SYSTEM_AUDIO_TIMELINE = 'capture' as const
export type RoomSystemAudioCommand = {
  action: 'open' | 'pull' | 'close'
  generation: number
  showId: string
  role: 'host-system-audio'
  sampleRate: 48000
  channels: 2
  frames: 480
}
export type RoomSystemAudioFrame = {
  generation: number
  sequence: number
  firstSample: number
  firstSampleUs: number
  observedAtUs: number
  droppedFrames: number
  sampleRate: 48000
  channels: 2
  frames: 480
  samples: number[]
} & RoomPcmClock
export function parseRoomSystemAudioCommand(value: unknown): RoomSystemAudioCommand {
  if (!value || typeof value !== 'object') throw new Error('Invalid system audio command.')
  const v = value as RoomSystemAudioCommand
  if (
    Object.keys(v).length !== 7 ||
    !['open', 'pull', 'close'].includes(v.action) ||
    !pcmInteger(v.generation) ||
    !v.generation ||
    typeof v.showId !== 'string' ||
    !v.showId ||
    v.showId.length > 128 ||
    v.role !== ROOM_SYSTEM_AUDIO.role ||
    v.sampleRate !== 48000 ||
    v.channels !== 2 ||
    v.frames !== 480
  )
    throw new Error('Invalid system audio command.')
  return v
}
export function parseRoomSystemAudioFrame(
  value: unknown,
  generation?: number
): RoomSystemAudioFrame {
  if (!value || typeof value !== 'object') throw new Error('Invalid system audio frame.')
  const v = value as RoomSystemAudioFrame
  if (
    !pcmInteger(v.generation) ||
    !v.generation ||
    (generation !== undefined && generation !== v.generation) ||
    !pcmInteger(v.sequence) ||
    !pcmInteger(v.firstSample) ||
    !pcmInteger(v.firstSampleUs) ||
    !pcmInteger(v.observedAtUs) ||
    !pcmInteger(v.droppedFrames) ||
    v.firstSampleUs !== Math.floor((v.firstSample * 1000000) / 48000) ||
    v.originUs === undefined ||
    v.incarnation === undefined ||
    !validPcmClock(v, v.observedAtUs) ||
    v.sampleRate !== 48000 ||
    v.channels !== 2 ||
    v.frames !== 480 ||
    !Array.isArray(v.samples) ||
    v.samples.length !== 960
  )
    throw new Error('Invalid system audio frame.')
  for (const sample of v.samples)
    if (!Number.isFinite(sample) || Math.abs(sample) > 1)
      throw new Error('Invalid system audio sample.')
  return v
}
/** Native capture time of the first sample on the shared anchor, or null (never zero). */
export function systemNativeCaptureUs(frame: RoomSystemAudioFrame): number | null {
  return frame.originUs === null ? null : frame.originUs + frame.firstSampleUs
}
export const roomSystemAudioCommand = (
  action: RoomSystemAudioCommand['action'],
  generation: number,
  showId: string
): RoomSystemAudioCommand => ({
  action,
  generation,
  showId,
  role: 'host-system-audio',
  sampleRate: 48000,
  channels: 2,
  frames: 480
})
