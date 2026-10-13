import { ipcErrorMessage } from '@/lib/ipc-error-message'
import { UserFacingError } from '@/lib/user-error'

import { isScreenImageRefusal } from '../../../shared/screen-image-files'

export type TakeoverImportPhase = 'idle' | 'choosing' | 'importing'

/** One picker/batch at a time, with late completions fenced across reconnects. */
export function createTakeoverImporter() {
  let operation: object | null = null
  return {
    reset() {
      operation = null
    },
    async run<Selection, Screen>(options: {
      pick: () => Promise<readonly Selection[]>
      importImage: (selection: Selection) => Promise<Screen>
      isCurrent: () => boolean
      onPhase: (phase: TakeoverImportPhase) => void
      onPending: (selections: readonly Selection[]) => void
      onImported: (screen: Screen) => void
      /** Without a selection, the pick itself failed. */
      onError: (error: unknown, selection?: Selection) => void
    }): Promise<void> {
      if (operation) return
      const token = {}
      operation = token
      const current = () => operation === token && options.isCurrent()
      options.onPhase('choosing')
      try {
        const selections = await options.pick()
        if (selections.length === 0 || !current()) return
        options.onPhase('importing')
        options.onPending(selections)
        for (const [index, selection] of selections.entries()) {
          try {
            const screen = await options.importImage(selection)
            if (!current()) return
            options.onImported(screen)
          } catch (error) {
            if (!current()) return
            options.onError(error, selection)
          }
          options.onPending(selections.slice(index + 1))
        }
      } catch (error) {
        if (current()) options.onError(error)
      } finally {
        if (operation === token) {
          operation = null
          options.onPending([])
          options.onPhase('idle')
        }
      }
    }
  }
}

/** Main's refusals already say what to change, so they reach the toast as written. */
export function screenImportAuthorizationError(error: unknown): unknown {
  const message = ipcErrorMessage(error)
  return isScreenImageRefusal(message) ? new UserFacingError(message) : error
}
