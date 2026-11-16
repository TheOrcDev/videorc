import type { FrameSource, MeterFrame } from './audio/types'
export type RoomMicrophoneMode = 'browser-aec' | 'native-headphones'
export type RoomMicrophoneObservation = {
  mode: RoomMicrophoneMode
  state: 'off' | 'opening' | 'published' | 'lost'
  reason: string | null
  peakDb: number | null
  rmsDb: number | null
  observedAt: number | null
  nativeQualified: false
}
const empty: RoomMicrophoneObservation = {
  mode: 'browser-aec',
  state: 'off',
  reason: null,
  peakDb: null,
  rmsDb: null,
  observedAt: null,
  nativeQualified: false
}
let snapshot = empty
let owner = 0
const listeners = new Set<() => void>()
const meters = new Set<(frame: MeterFrame) => void>()
export const roomMicrophoneState = {
  getSnapshot: () => snapshot,
  subscribe: (fn: () => void) => {
    listeners.add(fn)
    return () => {
      listeners.delete(fn)
    }
  },
  acquire(mode: RoomMicrophoneMode): {
    update: (patch: Partial<RoomMicrophoneObservation>) => void
    close: () => void
  } {
    const epoch = ++owner
    const update = (patch: Partial<RoomMicrophoneObservation>): void => {
      if (owner !== epoch) return
      snapshot = { ...snapshot, ...patch }
      for (const fn of listeners) fn()
      for (const fn of meters)
        fn({ channels: [{ peakDb: snapshot.peakDb ?? NaN, rmsDb: snapshot.rmsDb ?? undefined }] })
    }
    snapshot = { ...empty, mode, state: 'opening' }
    update({})
    return {
      update,
      close: () => update({ state: 'off', peakDb: null, rmsDb: null, observedAt: null })
    }
  }
}
export const roomMicrophoneMeter: FrameSource<MeterFrame> = {
  subscribe(fn) {
    meters.add(fn)
    return () => {
      meters.delete(fn)
    }
  }
}

let nativeEnabled = false
const resources = new Set<() => Record<string, unknown>>()
export function roomNativeMicrophoneEnabled(): boolean {
  return nativeEnabled
}
export function setRoomNativeMicrophoneEnabled(value: boolean): void {
  if (!import.meta.env.DEV) throw new Error('Native microphone test mode requires development.')
  nativeEnabled = value
}
export function registerRoomMicrophoneResources(read: () => Record<string, unknown>): () => void {
  if (resources.size >= 64) throw new Error('Microphone owner cleanup limit reached.')
  resources.add(read)
  return () => {
    resources.delete(read)
  }
}
export function roomMicrophoneResources(): Record<string, unknown>[] {
  return [...resources].map((read) => read())
}
