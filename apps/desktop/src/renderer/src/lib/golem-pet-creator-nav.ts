import { useSyncExternalStore } from 'react'

/**
 * Whether the Golem pet creator (plan 168 Phase F) is open: one module-level
 * flag, so the Golem tab's Create button and the creator agree without a
 * provider. The creator mounts where the Golem tab reads it.
 */
let creatorOpen = false
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function openGolemPetCreator(): void {
  if (creatorOpen) return
  creatorOpen = true
  emit()
}

export function closeGolemPetCreator(): void {
  if (!creatorOpen) return
  creatorOpen = false
  emit()
}

export function useGolemPetCreatorOpen(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => creatorOpen,
    () => false
  )
}
