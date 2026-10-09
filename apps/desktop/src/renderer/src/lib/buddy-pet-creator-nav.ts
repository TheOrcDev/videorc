import { useSyncExternalStore } from 'react'

/**
 * Whether the Buddy pet creator (plan 168 Phase F) is open: one module-level
 * flag, so the Buddy tab's Create button and the creator agree without a
 * provider. The creator mounts where the Buddy tab reads it.
 *
 * Plan 169 D11: Make it Alive opens it with the kept look as the reference
 * (`persona-idle`) and the look's description as notes for the creator.
 */
export interface BuddyPetCreatorOpenOptions {
  /** Start at the Reference step with the persona's idle picture chosen. */
  reference?: 'persona-idle'
  /** What the streamer described for the look (shown with the reference). */
  notes?: string
}

let creatorOpen = false
let creatorOptions: BuddyPetCreatorOpenOptions = {}
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

/** Only the known options survive, so a click event passed straight in as
 * `onClick={openBuddyPetCreator}` opens it plainly. */
function cleanOptions(options: unknown): BuddyPetCreatorOpenOptions {
  if (typeof options !== 'object' || options === null) return {}
  const { reference, notes } = options as Record<string, unknown>
  const trimmed = typeof notes === 'string' ? notes.trim() : ''
  return {
    ...(reference === 'persona-idle' ? { reference } : {}),
    ...(trimmed ? { notes: trimmed } : {})
  }
}

export function openBuddyPetCreator(options?: BuddyPetCreatorOpenOptions): void
/** As a click handler (`onClick={openBuddyPetCreator}`): opens it plainly. */
export function openBuddyPetCreator(event: { nativeEvent: Event }): void
export function openBuddyPetCreator(options?: unknown): void {
  if (creatorOpen) return
  creatorOpen = true
  creatorOptions = cleanOptions(options)
  emit()
}

export function closeBuddyPetCreator(): void {
  if (!creatorOpen) return
  creatorOpen = false
  creatorOptions = {}
  emit()
}

export function useBuddyPetCreatorOpen(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => creatorOpen,
    () => false
  )
}

/** What the creator was opened with (stable until it closes). */
export function useBuddyPetCreatorOptions(): BuddyPetCreatorOpenOptions {
  return useSyncExternalStore(
    subscribe,
    () => creatorOptions,
    () => creatorOptions
  )
}
