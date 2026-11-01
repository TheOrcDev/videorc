import type { Sound, SoundboardSettingsParams, SoundboardState, SoundUpdateParams } from './backend'
import { holdUndoableAction } from './undoable-action'
import { toast } from './toast'
import { UserFacingError, toastOffline, toastUserError, type UserErrorContext } from './user-error'
import {
  isSoundLimitRefusal,
  requestSoundAction,
  soundActionContext,
  soundActionError,
  soundOrderAfterMove,
  soundRefusal,
  type SoundImportPhase
} from './sounds'
import { restoreStarterSounds } from './sound-starters'
import type { SoundboardStore } from './soundboard-store'
import type { SoundRelayAction } from '../../../shared/sound-commands'

// Plan 189: every soundboard action a page runs, on Studio's backend
// connection through the store. A refusal is a warning toast with the
// backend's sentence, never an error (plan 174 S2.4); nothing toasts when an
// action works, because the board and the pads are the confirmation. One
// toast id per kind, so the same news never stacks. Loaded with the pages.

/** How long "Removed Airhorn" waits for Undo before the sound is deleted (plan 189). */
export const SOUND_REMOVE_UNDO_MS = 5_000

const ACTION_TOAST = 'sound-action'
const CHANGE_TOAST = 'sound-change'
const IMPORT_TOAST = 'sound-import'
const RESTORE_TOAST = 'sound-restore'

const CHANGE_CONTEXT: UserErrorContext = { action: 'change', object: 'the sound' }

/** A pad, a key, ⌘K: play, press or stop. Resolves false after saying why. */
export async function runSoundboardAction(
  store: SoundboardStore,
  action: SoundRelayAction
): Promise<boolean> {
  const client = store.client()
  if (!client) {
    toastOffline(soundActionContext(action.action))
    return false
  }
  try {
    await requestSoundAction(client, action)
    return true
  } catch (error) {
    toastUserError(soundActionError(error), soundActionContext(action.action), {
      id: ACTION_TOAST
    })
    return false
  }
}

async function change<T>(
  store: SoundboardStore,
  context: UserErrorContext,
  request: (client: NonNullable<ReturnType<SoundboardStore['client']>>) => Promise<T>
): Promise<T | null> {
  const client = store.client()
  if (!client) {
    toastOffline(context)
    return null
  }
  try {
    return await request(client)
  } catch (error) {
    toastUserError(soundActionError(error), context, { id: CHANGE_TOAST })
    return null
  }
}

/** Rename, Mode, Volume or Key: only the fields to change; `hotkey: ''` clears it. */
export function updateSound(
  store: SoundboardStore,
  id: string,
  patch: Omit<SoundUpdateParams, 'id'>
): Promise<Sound | null> {
  return change(store, CHANGE_CONTEXT, (client) =>
    client.request<Sound>('sounds.update', { id, ...patch })
  )
}

/** Move up and Move down: every id in the new board order. */
export async function moveSound(
  store: SoundboardStore,
  id: string,
  targetIndex: number
): Promise<boolean> {
  const sounds = store.getSnapshot().board?.sounds ?? []
  const ids = soundOrderAfterMove(sounds, id, targetIndex)
  if (!ids) return false
  const reordered = await change(store, { action: 'move', object: 'the sound' }, (client) =>
    client.request<Sound[]>('sounds.reorder', { ids })
  )
  return reordered !== null
}

/** The board's Level and "Hear sounds yourself" (Sources → Sounds). */
export async function changeSoundboardSettings(
  store: SoundboardStore,
  settings: SoundboardSettingsParams
): Promise<boolean> {
  const board = await change(store, { action: 'change', object: 'the soundboard' }, (client) =>
    client.request<SoundboardState>('sounds.settings', settings)
  )
  if (board) store.acceptBoard(board)
  return board !== null
}

/** Leaves `id` out of every surface while its Undo is up. */
export function hideSound(store: SoundboardStore, id: string): void {
  const { hidden } = store.getSnapshot()
  if (!hidden.has(id)) store.setHidden(new Set([...hidden, id]))
}

/** Puts `id` back: Undo, a kept sound, or one the backend deleted. */
export function unhideSound(store: SoundboardStore, id: string): void {
  const { hidden } = store.getSnapshot()
  if (!hidden.has(id)) return
  const next = new Set(hidden)
  next.delete(id)
  store.setHidden(next)
}

/**
 * Remove (plan 189): the sound leaves every surface now and is deleted when
 * its "Removed {name}" toast closes, unless Undo comes first. The toast's own
 * lifecycle drives it (plan 174 S3.12), so Undo is never on screen for a
 * delete that already ran.
 */
export function removeSoundWithUndo(
  store: SoundboardStore,
  sound: Pick<Sound, 'id' | 'name'>
): void {
  if (store.getSnapshot().hidden.has(sound.id)) return
  hideSound(store, sound.id)
  const toastId = `sound-remove-${sound.id}`
  const pending = holdUndoableAction(() => {
    void change(store, { action: 'remove', object: sound.name }, (client) =>
      client.request<Sound[]>('sounds.delete', { id: sound.id })
    ).then((remaining) => {
      // Deleted: the board the answer carries, so the row never flashes
      // back before `sounds.changed`. Kept (or Videorc went away): it returns.
      const board = store.getSnapshot().board
      if (remaining && board) store.acceptBoard({ ...board, sounds: remaining })
      unhideSound(store, sound.id)
    })
  })
  toast.message(`Removed ${sound.name}`, {
    id: toastId,
    duration: SOUND_REMOVE_UNDO_MS,
    onAutoClose: () => pending.flush(),
    onDismiss: () => pending.flush(),
    action: {
      label: 'Undo',
      onClick: () => {
        pending.undo()
        unhideSound(store, sound.id)
        toast.dismiss(toastId)
      }
    }
  })
}

/**
 * Import sounds… (plan 189): the picker, then one `sounds.import` per file,
 * one after the other. Each refusal is a warning with its sentence; the cap
 * and the total end the batch, since no later file gets in either.
 */
export async function importSounds(
  store: SoundboardStore,
  setPhase: (phase: SoundImportPhase) => void
): Promise<void> {
  if (!store.client()) {
    toastOffline({ action: 'import', object: 'sounds' })
    return
  }
  setPhase('choosing')
  let picked: Awaited<ReturnType<NonNullable<typeof window.videorc>['pickSoundFiles']>>
  try {
    picked = (await window.videorc?.pickSoundFiles?.()) ?? { selections: [], leftOut: [] }
  } catch (error) {
    setPhase('idle')
    toastUserError(error, { action: 'choose', object: 'the sounds' }, { id: IMPORT_TOAST })
    return
  }
  const { selections, leftOut } = picked
  // A picked file main couldn't open is said, never dropped in silence
  // (release test 147, plan 0006).
  const picks = selections.length + leftOut.length
  for (const file of leftOut) {
    toastUserError(
      new UserFacingError(file.reason, 'warning'),
      { action: 'import', object: `“${file.displayName}”` },
      { id: `${IMPORT_TOAST}:${file.displayName}` }
    )
  }
  if (!selections.length) {
    setPhase('idle')
    return
  }
  setPhase('importing')
  try {
    for (const selection of selections) {
      const client = store.client()
      if (!client) {
        toastOffline({ action: 'import', object: 'the sounds' })
        return
      }
      try {
        await client.request<Sound>('sounds.import', { sourceCapability: selection.capabilityId })
      } catch (error) {
        const refusal = soundRefusal(error)
        toastUserError(
          refusal ? new UserFacingError(refusal, 'warning') : error,
          {
            action: 'import',
            object: picks > 1 ? `“${selection.displayName}”` : 'the sound'
          },
          { id: IMPORT_TOAST }
        )
        if (isSoundLimitRefusal(refusal)) return
      }
    }
  } finally {
    setPhase('idle')
  }
}

/** Restore starter sounds: the missing ones, quietly unless something stopped it. */
export async function restoreStarters(store: SoundboardStore): Promise<void> {
  const context: UserErrorContext = { action: 'restore', object: 'the starter sounds' }
  try {
    const outcome = await restoreStarterSounds(store)
    if (outcome.refusal) {
      toastUserError(new UserFacingError(outcome.refusal, 'warning'), context, {
        id: RESTORE_TOAST
      })
    } else if (outcome.offline) {
      toastOffline(context)
    } else if (outcome.failed) {
      toastUserError(new Error('A starter sound import failed.'), context, { id: RESTORE_TOAST })
    }
  } catch (error) {
    toastUserError(error, context, { id: RESTORE_TOAST })
  }
}
