import { useSyncExternalStore } from 'react'

import {
  cohostSensitivityFromStorage,
  COHOST_SENSITIVITY_STORAGE_KEY,
  DEFAULT_COHOST_SENSITIVITY,
  type CohostSensitivity
} from '@/lib/cohost-view'

// Flag sensitivity is a renderer-local preference (one localStorage string,
// like the co-host nudge flag). Settings writes it in the main window; the
// in-app rail and the detached Comments window both read it, so the store
// listens to `storage` for the other window and to its own writes for this one.

const listeners = new Set<() => void>()

function readSensitivity(): CohostSensitivity {
  try {
    return cohostSensitivityFromStorage(localStorage.getItem(COHOST_SENSITIVITY_STORAGE_KEY))
  } catch {
    return DEFAULT_COHOST_SENSITIVITY
  }
}

function subscribe(listener: () => void): () => void {
  const onStorage = (event: StorageEvent): void => {
    if (event.key === null || event.key === COHOST_SENSITIVITY_STORAGE_KEY) listener()
  }
  listeners.add(listener)
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', onStorage)
  }
}

export function setCohostSensitivity(next: CohostSensitivity): void {
  try {
    localStorage.setItem(COHOST_SENSITIVITY_STORAGE_KEY, next)
  } catch {
    // Storage unavailable: the choice simply does not outlive this window.
  }
  for (const listener of listeners) listener()
}

export function useCohostSensitivity(): CohostSensitivity {
  return useSyncExternalStore(subscribe, readSensitivity, () => DEFAULT_COHOST_SENSITIVITY)
}
