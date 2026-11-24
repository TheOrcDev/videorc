import { useSyncExternalStore } from 'react'

import {
  CLEAN_CUT_AUTO_STORAGE_KEY,
  cleanCutAutoFromStorage,
  cleanCutAutoToStorage
} from '@/lib/clean-cut-auto'
import { subscribeUiSetting, uiSettingsStorage } from '@/lib/ui-settings-storage'

// "Make a clean cut of every recording" is a renderer-owned preference (one
// flag in the UI settings store since plan 220 S1.4b, off by default), like
// the Buddy sensitivity. The Clean cut card writes it; the auto-run reads the
// same key when a recording finalizes (lib/clean-cut-auto.ts), so there is no
// second copy to sync. The hook hears the store's changes, every window's.

function readCleanCutAuto(): boolean {
  try {
    return cleanCutAutoFromStorage(uiSettingsStorage().getItem(CLEAN_CUT_AUTO_STORAGE_KEY))
  } catch {
    return false
  }
}

function subscribe(listener: () => void): () => void {
  return subscribeUiSetting(CLEAN_CUT_AUTO_STORAGE_KEY, listener)
}

export function setCleanCutAuto(enabled: boolean): void {
  try {
    uiSettingsStorage().setItem(CLEAN_CUT_AUTO_STORAGE_KEY, cleanCutAutoToStorage(enabled))
  } catch {
    // Not saved: the choice simply does not outlive this window.
  }
}

export function useCleanCutAuto(): boolean {
  return useSyncExternalStore(subscribe, readCleanCutAuto, () => false)
}
