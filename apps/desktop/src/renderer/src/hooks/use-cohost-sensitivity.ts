import { useSyncExternalStore } from 'react'

import {
  cohostSensitivityFromStorage,
  COHOST_SENSITIVITY_STORAGE_KEY,
  DEFAULT_COHOST_SENSITIVITY,
  type CohostSensitivity
} from '@/lib/cohost-view'
import { subscribeUiSetting, uiSettingsStorage } from '@/lib/ui-settings-storage'

// Flag sensitivity is a renderer-owned preference (one string in the UI
// settings store since plan 220 S1.4b, like the co-host nudge flag). Settings
// writes it in the main window; the in-app rail and the detached Comments
// window both read it, so the hook hears the store's changes: another
// window's arrive as `ui.settings.changed`, this window's own write at once.

function readSensitivity(): CohostSensitivity {
  try {
    return cohostSensitivityFromStorage(uiSettingsStorage().getItem(COHOST_SENSITIVITY_STORAGE_KEY))
  } catch {
    return DEFAULT_COHOST_SENSITIVITY
  }
}

function subscribe(listener: () => void): () => void {
  return subscribeUiSetting(COHOST_SENSITIVITY_STORAGE_KEY, listener)
}

export function setCohostSensitivity(next: CohostSensitivity): void {
  try {
    uiSettingsStorage().setItem(COHOST_SENSITIVITY_STORAGE_KEY, next)
  } catch {
    // Not saved: the choice simply does not outlive this window.
  }
}

export function useCohostSensitivity(): CohostSensitivity {
  return useSyncExternalStore(subscribe, readSensitivity, () => DEFAULT_COHOST_SENSITIVITY)
}
