import { type ProgramAudioSettings } from '../../../shared/program-audio-routing'

export type RoomAudioRouting = {
  takeover: boolean
  system: { enabled: boolean; gainDb: number; muted: boolean }
  program: ProgramAudioSettings
  systemState: 'off' | 'opening' | 'capturing' | 'blocked'
  reason: string | null
}
export const DEFAULT_PROGRAM_AUDIO: ProgramAudioSettings = {
  speechGain: 1,
  auxiliaryGain: 1,
  speechMuted: false,
  auxiliaryMuted: false
}
const initial = (): RoomAudioRouting => ({
  takeover: false,
  system: { enabled: false, gainDb: 0, muted: false },
  program: { ...DEFAULT_PROGRAM_AUDIO },
  systemState: 'off',
  reason: null
})
let snapshot = initial()
const listeners = new Set<() => void>()
function publish(next: RoomAudioRouting) {
  if (JSON.stringify(next) === JSON.stringify(snapshot)) return
  snapshot = next
  for (const listener of listeners) listener()
}
export const roomAudioRouting = {
  getSnapshot: () => snapshot,
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  system(patch: Partial<RoomAudioRouting['system']>) {
    const next = { ...snapshot.system, ...patch }
    if (!Number.isFinite(next.gainDb) || next.gainDb < -24 || next.gainDb > 12)
      throw new Error('Invalid system gain.')
    publish({
      ...snapshot,
      system: next,
      ...(!next.enabled ? { systemState: 'off' as const, reason: null } : {})
    })
  },
  program(patch: Partial<ProgramAudioSettings>) {
    const next = { ...snapshot.program, ...patch }
    if (![next.speechGain, next.auxiliaryGain].every((v) => Number.isFinite(v) && v >= 0 && v <= 1))
      throw new Error('Invalid program gain.')
    publish({ ...snapshot, program: next })
  },
  status(systemState: RoomAudioRouting['systemState'], reason: string | null) {
    publish({ ...snapshot, systemState, reason })
  },
  disarmSystem() {
    publish({
      ...snapshot,
      system: { ...snapshot.system, enabled: false },
      systemState: 'off',
      reason: null
    })
  },
  takeover(active: boolean) {
    publish({ ...snapshot, takeover: active })
  },
  reset() {
    publish(initial())
  }
}

/** Plan 249 S24: the controller facts system audio follows (`CloudStatus.controller`). */
export type SystemControllerFacts =
  | { controllerEpoch: number; takenOverFrom?: string; lost?: boolean }
  | undefined

/**
 * Plan 249 S8 on S24's controller epoch (no epoch of its own). System capture
 * starts off on any new epoch after the first one seen, on a first epoch that
 * is a takeover, and whenever this computer lost the show (`lost`, or a
 * `stoppedBy` hand-off/take-over). The streamer turns it on again explicitly;
 * the previous controller's `system` is in `needsEnable`.
 */
export function systemControllerStep(
  seenEpoch: number,
  facts: SystemControllerFacts,
  stoppedBy: unknown
): { disarm: boolean; epoch: number } {
  if (facts?.lost === true || (stoppedBy !== undefined && stoppedBy !== null))
    return { disarm: true, epoch: seenEpoch }
  const epoch = facts?.controllerEpoch ?? 0
  if (epoch === 0 || epoch === seenEpoch) return { disarm: false, epoch: seenEpoch }
  return { disarm: seenEpoch !== 0 || facts?.takenOverFrom !== undefined, epoch }
}

/** What `cloud.controller.desired` reports as `system`: capturing in an open room. */
export function systemControllerEnabled(snapshot: RoomAudioRouting, roomOpen: boolean): boolean {
  return roomOpen && snapshot.system.enabled && snapshot.systemState === 'capturing'
}
