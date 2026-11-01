import type { RelaunchForPermissionResult } from '../shared/backend'
import type { AcquireBackendInterruption } from './interruption-actions'
import { runBackendInterruptingAction } from './interruption-actions'

export type { RelaunchForPermissionResult }

/**
 * Reopen Videorc after a grant macOS only honours per launch (plan 203 S2).
 * Same admission as installing an update: the immediate sampled capture
 * guard first, then the backend-authoritative interruption lease, and the
 * relaunch runs only while that lease is held. With no backend connected
 * there is nothing to interrupt, so the relaunch goes straight through the
 * normal quit path (which still stops an owned backend if one is starting).
 */
export async function relaunchForPermissionWithInterruptionLease(
  captureBlocked: () => boolean,
  backendConnected: () => boolean,
  acquire: AcquireBackendInterruption,
  relaunch: () => void
): Promise<RelaunchForPermissionResult> {
  if (captureBlocked()) {
    return { relaunched: false, reason: 'capture-active' }
  }
  if (!backendConnected()) {
    relaunch()
    return { relaunched: true }
  }
  const admitted = await runBackendInterruptingAction(acquire, relaunch)
  return admitted ? { relaunched: true } : { relaunched: false, reason: 'backend-busy' }
}
