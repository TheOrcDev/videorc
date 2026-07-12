import type { BackendInterruptionLease } from './backend-interruption'

export type AcquireBackendInterruption = () => Promise<BackendInterruptionLease | null>

function renewalIntervalMs(lease: BackendInterruptionLease): number {
  return Math.max(250, Math.min(2_000, Math.floor(lease.expiresInMs / 3)))
}

/**
 * Runs an action only after backend-authoritative admission and consumption.
 * The consumed lease has a bounded TTL and is renewed while the operation is
 * in flight. On success it remains held for its final TTL while the action
 * stops the backend/app; if that never happens, expiry recovers future starts.
 */
export async function runBackendInterruptingAction(
  acquire: AcquireBackendInterruption,
  action: () => void | Promise<void>
): Promise<boolean> {
  const lease = await acquire()
  if (!lease) {
    return false
  }
  let renewalTimer: ReturnType<typeof setInterval> | null = null
  try {
    await lease.consume()
    let renewalInFlight = false
    renewalTimer = setInterval(() => {
      if (renewalInFlight) {
        return
      }
      renewalInFlight = true
      void lease
        .renew()
        // A lost renew response is ambiguous, but never permanent: the
        // consumed backend lease retains its longer TTL and eventually expires.
        .catch(() => undefined)
        .finally(() => {
          renewalInFlight = false
        })
    }, renewalIntervalMs(lease))
    renewalTimer.unref?.()
    await action()
    return true
  } catch (error) {
    await lease.release().catch(() => undefined)
    throw error
  } finally {
    if (renewalTimer) {
      clearInterval(renewalTimer)
    }
  }
}
