// Plan 189: the starter sounds. Once per profile, the main window imports
// the twelve bundled sounds through the same decode, trim and level path as
// any import, then marks the board seeded; a starter the streamer removed
// stays removed. "Restore starter sounds" in Assets imports the missing ones.
// Loaded on demand by the shell's host and by Assets.

import type { SoundboardState, SoundHotkey, SoundImportParams } from './backend'
import { ipcErrorMessage } from './ipc-error-message'
import { isSoundLimitRefusal, missingStarterSlugs, soundRefusal } from './sounds'
import type { SoundboardStore } from './soundboard-store'
import type { StarterSoundFile } from '../../../shared/sound-commands'

type StarterApi = Pick<
  NonNullable<typeof window.videorc>,
  'getStarterSounds' | 'getStarterSoundFiles'
>

/** What a run of starter imports came to. */
export interface StarterImportOutcome {
  imported: number
  /** Imports that failed for another reason (logged). */
  failed: number
  /** A limit refusal that ended the run, verbatim. */
  refusal: string | null
  /** Videorc's connection went away mid-run. */
  offline: boolean
}

const isOffline = (error: unknown): boolean =>
  /reconnecting|isn't connected|connection closed|shut down|Couldn't connect/i.test(
    ipcErrorMessage(error)
  )

/**
 * Imports `files` one after the other (the backend's one AssetImport lane).
 * A key another sound already has is left off, so a restore never takes one
 * from the streamer's own sound; a limit refusal or a lost connection ends
 * the run.
 */
export async function importStarterFiles(
  store: SoundboardStore,
  files: readonly StarterSoundFile[]
): Promise<StarterImportOutcome> {
  const outcome: StarterImportOutcome = { imported: 0, failed: 0, refusal: null, offline: false }
  for (const file of files) {
    const client = store.client()
    if (!client) return { ...outcome, offline: true }
    const taken = new Set<SoundHotkey | undefined>(
      store.getSnapshot().board?.sounds.map((sound) => sound.hotkey) ?? []
    )
    const params: SoundImportParams = {
      sourceCapability: file.selection.capabilityId,
      starter: {
        slug: file.slug,
        name: file.name,
        ...(file.hotkey && !taken.has(file.hotkey) ? { hotkey: file.hotkey } : {})
      }
    }
    try {
      await client.request('sounds.import', params)
      outcome.imported += 1
    } catch (error) {
      const refusal = soundRefusal(error)
      if (isSoundLimitRefusal(refusal)) return { ...outcome, refusal }
      if (isOffline(error)) return { ...outcome, offline: true }
      outcome.failed += 1
      console.warn(`[sounds] the starter sound ${file.slug} was not added:`, error)
    }
  }
  return outcome
}

/**
 * The once-per-profile seeding (plan 189 "Starter sounds"). Quiet: nothing
 * toasts at first launch. The board is marked seeded once every starter was
 * tried; a run cut short, or a build without the starter files, tries again
 * on the next connection.
 */
export async function seedStarterSounds(
  store: SoundboardStore,
  api: StarterApi | undefined = window.videorc
): Promise<void> {
  if (!api?.getStarterSoundFiles || !api.getStarterSounds) return
  const board = store.getSnapshot().board
  if (!board || board.startersSeeded) return
  // No manifest (a broken install, a checkout without the files): nothing is
  // marked, so a build that has them seeds on its first connection.
  const starters = await api.getStarterSounds()
  if (!starters.length) return
  const missing = missingStarterSlugs(starters, board.sounds)
  const files = missing.length ? await api.getStarterSoundFiles(missing) : []
  if (missing.length && !files.length) return
  const outcome = await importStarterFiles(store, files)
  if (outcome.offline) return
  const client = store.client()
  if (!client) return
  store.acceptBoard(
    await client.request<SoundboardState>('sounds.settings', { startersSeeded: true })
  )
}

/** Assets → Restore starter sounds: the starters the board no longer has. */
export async function restoreStarterSounds(
  store: SoundboardStore,
  api: StarterApi | undefined = window.videorc
): Promise<StarterImportOutcome> {
  const none: StarterImportOutcome = { imported: 0, failed: 0, refusal: null, offline: false }
  if (!api?.getStarterSoundFiles || !api.getStarterSounds) return none
  const sounds = store.getSnapshot().board?.sounds ?? []
  const missing = missingStarterSlugs(await api.getStarterSounds(), sounds)
  if (!missing.length) return none
  return importStarterFiles(store, await api.getStarterSoundFiles(missing))
}
