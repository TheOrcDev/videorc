import { useSyncExternalStore } from 'react'

// Whether the Golem pet creator (plan 168 S-F5) is open: one module-level
// flag the Golem tab's Avatar section sets and the wizard clears.

let open = false
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

function snapshot(): boolean {
  return open
}

export function openGolemPetCreator(): void {
  if (open) return
  open = true
  emit()
}

export function closeGolemPetCreator(): void {
  if (!open) return
  open = false
  emit()
}

export function useGolemPetCreatorOpen(): boolean {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
