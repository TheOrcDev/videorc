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
/**
 * What React shows of the room microphone: its state and words, and whether
 * levels arrive. The 20 Hz levels themselves go to `roomMicrophoneMeter`
 * only, so a level never re-renders the Audio section (PH-12).
 */
export type RoomMicrophoneView = Pick<RoomMicrophoneObservation, 'mode' | 'state' | 'reason'> & {
  /** Levels arrive: the last tick measured one (`observedAt` is set). */
  levels: boolean
}
const viewOf = (observation: RoomMicrophoneObservation): RoomMicrophoneView => ({
  mode: observation.mode,
  state: observation.state,
  reason: observation.reason,
  levels: observation.observedAt !== null
})
let snapshot = empty
let view = viewOf(empty)
let owner = 0
const listeners = new Set<() => void>()
const meters = new Set<(frame: MeterFrame) => void>()
export const roomMicrophoneState = {
  /** The latest observation, levels included: read it, never subscribe to it. */
  getSnapshot: () => snapshot,
  /** For `useSyncExternalStore` with `subscribe`: changes only when the view does. */
  getView: () => view,
  /** Called when the view changes, never for a level alone. */
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
      const next = viewOf(snapshot)
      if (
        next.mode !== view.mode ||
        next.state !== view.state ||
        next.reason !== view.reason ||
        next.levels !== view.levels
      ) {
        view = next
        for (const fn of listeners) fn()
      }
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
