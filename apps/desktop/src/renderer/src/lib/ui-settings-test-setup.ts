// Vitest setup (plan 220 S1.4b): every test starts with a fresh, hydrated UI
// settings store as its window's, the way a window renders once its store
// holds the engine's snapshot. The key families read and write through it.

import { afterEach, beforeEach } from 'vitest'

import { setWindowUiSettingsStoreForTests } from './ui-settings-storage'
import { installTestUiSettingsStore } from './ui-settings-test-store'

beforeEach(async () => {
  await installTestUiSettingsStore()
})

afterEach(() => {
  setWindowUiSettingsStoreForTests(null)
})
