import type { AcquireBackendInterruption } from './interruption-actions'
import { runBackendInterruptingAction } from './interruption-actions'

export type UpdateInstallAdmission =
  | 'blocked-by-local-capture-state'
  | 'blocked-by-backend'
  | 'installing'

/** Keeps the existing immediate sampled-state guard for UX, then closes its
 * start-event race with backend-authoritative admission before quitting. */
export async function installUpdateWithInterruptionLease(
  captureInstallBlocked: () => boolean,
  acquire: AcquireBackendInterruption,
  quitAndInstall: () => void
): Promise<UpdateInstallAdmission> {
  if (captureInstallBlocked()) {
    return 'blocked-by-local-capture-state'
  }
  const admitted = await runBackendInterruptingAction(acquire, quitAndInstall)
  return admitted ? 'installing' : 'blocked-by-backend'
}
