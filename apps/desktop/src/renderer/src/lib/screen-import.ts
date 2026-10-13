import type { ResourceSelection } from '@/lib/backend'
import { ipcErrorMessage } from '@/lib/ipc-error-message'
import { UserFacingError } from '@/lib/user-error'

import { isScreenImageRefusal } from '../../../shared/screen-image-files'

export async function importEachSelection(
  selections: readonly ResourceSelection[],
  importOne: (selection: ResourceSelection) => Promise<void>,
  onFailure: (error: unknown, selection: ResourceSelection) => void
): Promise<void> {
  for (const selection of selections) {
    try {
      await importOne(selection)
    } catch (error) {
      onFailure(error, selection)
    }
  }
}

/** Main's refusals already say what to change, so they reach the toast as written. */
export function screenImportAuthorizationError(error: unknown): unknown {
  const message = ipcErrorMessage(error)
  return isScreenImageRefusal(message) ? new UserFacingError(message) : error
}
