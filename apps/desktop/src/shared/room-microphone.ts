import { pcmInteger, type RoomPcmFrame } from './room-pcm'
/** Private transport extension, not a new LiveKit role or media manifest. */
export type RoomMicrophoneSettings = {
  deviceId: string
  gainDb: number
  muted: boolean
  noise: 'off' | 'rnnoise'
  offsetMs: number
}
export type RoomMicrophoneCommand = {
  action: 'open' | 'update' | 'pull' | 'close' | 'disconnect-test' | 'starve-test' | 'resume-test'
  generation: number
  role: 'host-microphone'
  sampleRate: 48000
  channels: 1
  frames: 480
  showId: string
  settings?: RoomMicrophoneSettings
}
export type RoomMicrophoneApi = (command: RoomMicrophoneCommand) => Promise<RoomPcmFrame | null>
function exactMicrophoneId(id: string): boolean {
  const core = /^microphone:coreaudio:(\+?\d+)$/.exec(id)
  if (core) return Number(core[1]) > 0 && Number(core[1]) <= 0xffff_ffff
  const adapter = /^microphone:(windows-dshow|linux-pulse):((?:[0-9a-fA-F]{2})+)$/.exec(id)
  if (!adapter) return false
  try {
    const bytes = Uint8Array.from(adapter[2].match(/../g)!, (pair) => Number.parseInt(pair, 16))
    const name = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (!name || [...name].some((character) => ['\0', '\r', '\n'].includes(character))) return false
    return (
      adapter[1] !== 'linux-pulse' ||
      (!name.startsWith('@') &&
        !name.startsWith('-') &&
        name !== 'default' &&
        !name.endsWith('.monitor'))
    )
  } catch {
    return false
  }
}
export function parseRoomMicrophoneSettings(value: unknown): RoomMicrophoneSettings {
  if (!value || typeof value !== 'object') throw new Error('Invalid microphone settings.')
  const v = value as RoomMicrophoneSettings
  if (
    Object.keys(v).length !== 5 ||
    typeof v.deviceId !== 'string' ||
    !v.deviceId ||
    v.deviceId.length > 512 ||
    !exactMicrophoneId(v.deviceId) ||
    !Number.isFinite(v.gainDb) ||
    v.gainDb < -24 ||
    v.gainDb > 24 ||
    typeof v.muted !== 'boolean' ||
    !['off', 'rnnoise'].includes(v.noise) ||
    !pcmInteger(v.offsetMs) ||
    v.offsetMs > 1000
  )
    throw new Error('Native microphone requires an exact device and 0–1000 ms delay.')
  return v
}
export function parseRoomMicrophoneCommand(value: unknown): RoomMicrophoneCommand {
  if (!value || typeof value !== 'object') throw new Error('Invalid microphone command.')
  const v = value as RoomMicrophoneCommand
  const settings = v.action === 'open' || v.action === 'update'
  if (
    !['open', 'pull', 'close', 'update', 'disconnect-test', 'starve-test', 'resume-test'].includes(
      v.action
    ) ||
    !pcmInteger(v.generation) ||
    !v.generation ||
    v.role !== 'host-microphone' ||
    v.sampleRate !== 48000 ||
    v.channels !== 1 ||
    v.frames !== 480 ||
    typeof v.showId !== 'string' ||
    !v.showId ||
    v.showId.length > 128 ||
    Object.keys(v).length !== (settings ? 8 : 7)
  )
    throw new Error('Invalid microphone command.')
  if (settings) parseRoomMicrophoneSettings(v.settings)
  else if (v.settings !== undefined) throw new Error('Unexpected microphone settings.')
  return v
}
