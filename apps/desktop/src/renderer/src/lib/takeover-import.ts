export type TakeoverImportPhase = 'idle' | 'choosing' | 'importing'

/** One picker/import at a time, with late completions fenced across reconnects. */
export function createTakeoverImporter() {
  let operation: object | null = null
  return {
    reset() {
      operation = null
    },
    async run<Selection, Screen>(options: {
      pick: () => Promise<Selection | null>
      importImage: (selection: Selection) => Promise<Screen>
      isCurrent: () => boolean
      onPhase: (phase: TakeoverImportPhase) => void
      onImported: (screen: Screen) => void
      onError: (error: unknown) => void
    }): Promise<void> {
      if (operation) return
      const token = {}
      operation = token
      const current = () => operation === token && options.isCurrent()
      options.onPhase('choosing')
      try {
        const selection = await options.pick()
        if (!selection || !current()) return
        options.onPhase('importing')
        const screen = await options.importImage(selection)
        if (current()) options.onImported(screen)
      } catch (error) {
        if (current()) options.onError(error)
      } finally {
        if (operation === token) {
          operation = null
          options.onPhase('idle')
        }
      }
    }
  }
}
