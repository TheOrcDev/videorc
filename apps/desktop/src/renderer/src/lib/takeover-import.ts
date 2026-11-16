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
      onPickError: (error: unknown) => void
      /** Once per batch, after the last image: every image that failed, in order. */
      onImportErrors: (failures: readonly TakeoverImportFailure<Selection>[], total: number) => void
      /** A batch that stopped early: the picked images it never sent to the backend. */
      onUnused: (selections: readonly Selection[]) => void
    }): Promise<void> {
      if (operation) return
      const token = {}
      operation = token
      const current = () => operation === token && options.isCurrent()
      let unused: readonly Selection[] = []
      options.onPhase('choosing')
      try {
        const selections = await options.pick()
        unused = selections
        if (selections.length === 0 || !current()) return
        options.onPhase('importing')
        options.onPending(selections)
        const failures: TakeoverImportFailure<Selection>[] = []
        for (const [index, selection] of selections.entries()) {
          unused = selections.slice(index + 1)
          try {
            const screen = await options.importImage(selection)
            if (!current()) return
            options.onImported(screen)
          } catch (error) {
            if (!current()) return
            failures.push({ error, selection })
          }
          options.onPending(selections.slice(index + 1))
        }
        if (failures.length > 0) options.onImportErrors(failures, selections.length)
      } catch (error) {
        if (current()) options.onPickError(error)
      } finally {
        if (unused.length > 0) options.onUnused(unused)
        if (operation === token) {
          operation = null
          options.onPending([])
          options.onPhase('idle')
        }
      }
    }
  }
}

export type TakeoverImportFailure<Selection> = { error: unknown; selection: Selection }

/** Main's refusals already say what to change, so they reach the toast as written. */
export function screenImportAuthorizationError(error: unknown): unknown {
  const message = ipcErrorMessage(error)
  return isScreenImageRefusal(message) ? new UserFacingError(message) : error
}
