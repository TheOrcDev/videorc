import { useSyncExternalStore } from 'react'

import {
  CLEAN_CUT_AUTO_STORAGE_KEY,
  cleanCutAutoFromStorage,
  cleanCutAutoToStorage
} from '@/lib/clean-cut-auto'

// "Make a clean cut of every recording" is a renderer-local preference (one
// localStorage flag, off by default), like the Orcle sensitivity. The Clean
// cut card writes it; the auto-run reads the same key when a recording
// finalizes (lib/clean-cut-auto.ts), so there is no second copy to sync.

const listeners = new Set<() => void>()

function readCleanCutAuto(): boolean {
  try {
    return cleanCutAutoFromStorage(localStorage.getItem(CLEAN_CUT_AUTO_STORAGE_KEY))
  } catch {
    return false
  }
}

function subscribe(listener: () => void): () => void {
  const onStorage = (event: StorageEvent): void => {
    if (event.key === null || event.key === CLEAN_CUT_AUTO_STORAGE_KEY) listener()
  }
  listeners.add(listener)
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', onStorage)
  }
}

export function setCleanCutAuto(enabled: boolean): void {
  try {
    localStorage.setItem(CLEAN_CUT_AUTO_STORAGE_KEY, cleanCutAutoToStorage(enabled))
  } catch {
    // Storage unavailable: the choice simply does not outlive this window.
  }
  for (const listener of listeners) listener()
}

export function useCleanCutAuto(): boolean {
  return useSyncExternalStore(subscribe, readCleanCutAuto, () => false)
}
