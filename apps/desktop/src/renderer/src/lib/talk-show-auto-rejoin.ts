import type { CloudStatus } from '@/lib/backend'

// Back in the room after a backend restart (owner call, 2026-11-19). The
// backend restarted in the middle of a live talk show: the renderer left the
// room with the old connection, and the host stayed out of their own show
// until they pressed Resume. Now the renderer asks for that same Resume
// itself, once per backend, when the room it had open is still this
// computer's to go back to.
//
// The rule is `autoRejoinDecision` (pure); `runAutoRejoin` is one backend's
// attempt: it waits for the new backend to report the show and its
// controller, resumes, and backs off twice before it gives up. A show
// another device took over is never resumed here: `cloud.room.resume` is an
// explicit takeover (plan 249 S24), so that case keeps Continue here.

/** The room this renderer had open when its backend connection went away. */
export type AutoRejoinHeld = { showId: string }

/** How long the new backend gets to find the show and renew its controller. */
export const AUTO_REJOIN_WAIT_MS = 1_000
export const AUTO_REJOIN_WAITS = 30
/** The pause after each failed resume; one more failure than this gives up. */
export const AUTO_REJOIN_RETRY_MS: readonly number[] = [2_000, 5_000]

export type AutoRejoinStop =
  /** No room was open here when the backend went away, or the host closed it. */
  | 'nothing-held'
  /** This backend already failed as often as it may: Resume is the host's now. */
  | 'gave-up'
  /** The backend still holds the room (a reconnect, not a restart): the join runs itself. */
  | 'room-open'
  | 'other-show'
  /** Ended, ending, failed, or not a talk show to rejoin. */
  | 'show-over'
  /** Another device is on air or controls the show: Continue here stays explicit. */
  | 'elsewhere'
  /** The show waits for a device after a hand-off: Continue here stays explicit. */
  | 'handed-off'

export type AutoRejoinDecision =
  | { action: 'resume' }
  /** The new backend has not said enough yet: ask it again. */
  | { action: 'wait'; on: 'backend' | 'show' | 'controller' }
  | { action: 'stop'; reason: AutoRejoinStop }

/**
 * Whether this renderer asks the backend to resume the room by itself. Pure.
 *
 * `status` is what the current backend reported (never the one before it).
 * It resumes only a show that backend confirmed as this computer's: the same
 * talk show, resumable, with this computer's controller epoch renewed and
 * not lost, and no other device on air.
 */
export function autoRejoinDecision(input: {
  held: AutoRejoinHeld | null
  /** Resumes this backend already refused or failed. */
  failures: number
  status: CloudStatus | null
}): AutoRejoinDecision {
  const { held, failures, status } = input
  const stop = (reason: AutoRejoinStop): AutoRejoinDecision => ({ action: 'stop', reason })
  if (!held) return stop('nothing-held')
  if (status?.room?.phase === 'open') return stop('room-open')
  if (failures > AUTO_REJOIN_RETRY_MS.length) return stop('gave-up')
  if (!status) return { action: 'wait', on: 'backend' }
  const show = status.show
  // The launch check has not found the show yet (or it is gone: the wait ends).
  if (!show) return { action: 'wait', on: 'show' }
  if (show.id !== held.showId) return stop('other-show')
  if (show.kind !== 'talk' || !show.resumable) return stop('show-over')
  if (status.phase === 'off' || status.phase === 'ending' || status.phase === 'failed') {
    return stop('show-over')
  }
  const onAir = status.onAir
  if (status.stoppedBy === 'hand-off' || onAir?.waiting) return stop('handed-off')
  if (status.stoppedBy === 'taken-over' || (onAir && !onAir.thisDevice)) return stop('elsewhere')
  const controller = status.controller
  if (controller?.lost || controller?.takenOverFrom === 'another-device') return stop('elsewhere')
  // Only a renewed epoch says videorc.com still has this computer as the
  // show's controller. Without it, a resume could take the show from another.
  if (!controller || controller.controllerEpoch <= 0) return { action: 'wait', on: 'controller' }
  return { action: 'resume' }
}

export type AutoRejoinOutcome =
  /** The backend holds the room again; the renderer's join follows. */
  | { result: 'resumed'; status: CloudStatus }
  /** Not this computer's to rejoin by itself. Nothing is said. */
  | { result: 'stopped'; reason: AutoRejoinStop }
  /** It tried and could not: the Studio's Resume is the way back in. */
  | { result: 'failed'; reason: 'unconfirmed' | 'resume-failed'; error?: unknown }
  /** The backend connection changed again meanwhile. */
  | { result: 'cancelled' }

export type AutoRejoinIo = {
  held: AutoRejoinHeld
  readStatus: () => Promise<CloudStatus>
  resume: () => Promise<CloudStatus>
  sleep: (ms: number) => Promise<void>
  cancelled: () => boolean
  /** Each status the backend answered, for the Studio to show. */
  onStatus?: (status: CloudStatus) => void
  /** Once, when there is a show to go back to: the host is told from here. */
  onReconnecting?: () => void
}

/** One backend's attempt. It ends by itself: bounded waits, bounded retries. */
export async function runAutoRejoin(io: AutoRejoinIo): Promise<AutoRejoinOutcome> {
  let waits = 0
  let failures = 0
  let told = false
  let lastError: unknown
  for (;;) {
    let status: CloudStatus | null = null
    try {
      status = await io.readStatus()
    } catch {
      // The connection is not up yet, or the read was dropped: ask again.
    }
    if (io.cancelled()) return { result: 'cancelled' }
    if (status) io.onStatus?.(status)
    const decision = autoRejoinDecision({ held: io.held, failures, status })
    if (decision.action === 'stop') {
      return decision.reason === 'gave-up'
        ? { result: 'failed', reason: 'resume-failed', error: lastError }
        : { result: 'stopped', reason: decision.reason }
    }
    if (!told && (decision.action === 'resume' || decision.on === 'controller')) {
      told = true
      io.onReconnecting?.()
    }
    if (decision.action === 'wait') {
      waits += 1
      if (waits > AUTO_REJOIN_WAITS) {
        // No show: it ended while the backend was away. A show whose
        // controller never came back is not confirmed as this computer's.
        return status?.show
          ? { result: 'failed', reason: 'unconfirmed' }
          : { result: 'stopped', reason: 'show-over' }
      }
      await io.sleep(AUTO_REJOIN_WAIT_MS)
      if (io.cancelled()) return { result: 'cancelled' }
      continue
    }
    try {
      const resumed = await io.resume()
      if (io.cancelled()) return { result: 'cancelled' }
      if (resumed.room?.phase === 'open') return { result: 'resumed', status: resumed }
      lastError = new Error('The room did not open.')
    } catch (error) {
      if (io.cancelled()) return { result: 'cancelled' }
      lastError = error
    }
    failures += 1
    const pause = AUTO_REJOIN_RETRY_MS[failures - 1]
    if (pause === undefined) continue
    await io.sleep(pause)
    if (io.cancelled()) return { result: 'cancelled' }
  }
}
