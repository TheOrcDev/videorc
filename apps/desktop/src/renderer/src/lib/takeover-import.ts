import { ipcErrorMessage } from '@/lib/ipc-error-message'
import { UserFacingError, type UserErrorContext } from '@/lib/user-error'

import { isScreenImageRefusal } from '../../../shared/screen-image-files'

// Lazy: the Studio provider loads this on the first takeover import (the
// eager renderer budget has no room for a batch importer), so the provider
// imports only its types. Banners keep their own one-image importer.

export type TakeoverImportPhase = 'idle' | 'choosing' | 'importing'

export type TakeoverImporter = ReturnType<typeof createTakeoverImporter>

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

type TakeoverSelection = { capabilityId: string; displayName: string }

/**
 * The Studio's takeover batch: main's refusals reach the toast as written,
 * a batch raises one toast however many images fail (a lone failure names
 * its file, several say how many of the batch failed), and a batch that
 * stops early hands its unused capabilities back to main.
 */
export function runTakeoverBatch<Selection extends TakeoverSelection, Screen>(
  importer: TakeoverImporter,
  options: {
    authorize: () => Promise<readonly Selection[]>
    importImage: (selection: Selection) => Promise<Screen>
    isCurrent: () => boolean
    onPhase: (phase: TakeoverImportPhase) => void
    onPending: (selections: readonly Selection[]) => void
    onImported: (screen: Screen) => void
    report: (error: unknown, context: UserErrorContext) => void
    release: (capabilityIds: string[]) => Promise<void> | undefined
  }
): Promise<void> {
  return importer.run<Selection, Screen>({
    pick: options.authorize,
    importImage: options.importImage,
    isCurrent: options.isCurrent,
    onPhase: options.onPhase,
    onPending: options.onPending,
    onImported: options.onImported,
    onPickError: (error) =>
      options.report(screenImportAuthorizationError(error), {
        action: 'import',
        object: 'the images'
      }),
    onImportErrors: (failures, total) => {
      const [first] = failures
      if (!first) return
      options.report(first.error, {
        action: 'import',
        object:
          failures.length === 1
            ? first.selection.displayName
            : `${failures.length} of ${total} images`
      })
    },
    onUnused: (selections) => {
      void options
        .release(selections.map((selection) => selection.capabilityId))
        ?.catch((error: unknown) =>
          console.warn('[takeovers] could not hand back unused images', error)
        )
    }
  })
}

/** Said when the connection drops with images of a batch still to import. */
export function takeoverConnectionDropError(stopped: number): UserFacingError {
  return new UserFacingError(
    stopped === 1
      ? 'The connection dropped before the last image was imported. Add it again if it is missing.'
      : `The connection dropped before the last ${stopped} images were imported. Add any missing ones again.`
  )
}
