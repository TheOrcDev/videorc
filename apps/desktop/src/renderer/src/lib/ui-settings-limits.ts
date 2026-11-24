// The UI settings store's names and limits (plan 220 S1.4a), apart from the
// store itself so eager code can read them without pulling the store and its
// transport into the first-paint bundle; the window entry loads those lazily.

import { UI_SETTINGS_KEY_MAX_CHARS, UI_SETTINGS_VALUE_MAX_BYTES } from '../../../shared/backend'

/** Every migrated key starts with this. */
export const UI_SETTINGS_LOCAL_STORAGE_PREFIX = 'videorc.'
/** A window's journal of writes the engine has not confirmed: `<prefix><writer>`. */
export const UI_SETTINGS_JOURNAL_PREFIX = 'videorc.uiSettings.journal.v1:'
/** How long a window waits for its first snapshot before rendering without it. */
export const UI_SETTINGS_HYDRATE_TIMEOUT_MS = 15_000

export function utf8Length(text: string): number {
  return typeof TextEncoder === 'undefined'
    ? text.length
    : new TextEncoder().encode(text).byteLength
}

/** Why the store would refuse this key or value, or null: mirrors `ui_settings.rs`. */
export function migrationRefusal(key: string, value: string): string | null {
  if (key.length > UI_SETTINGS_KEY_MAX_CHARS) {
    return `the key is ${key.length} characters; the limit is ${UI_SETTINGS_KEY_MAX_CHARS}`
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(key)) return 'the key contains a control character'
  if (key.trim() !== key) return 'the key starts or ends with whitespace'
  const bytes = utf8Length(JSON.stringify(value))
  if (bytes > UI_SETTINGS_VALUE_MAX_BYTES) {
    return `the value is ${bytes} bytes; the limit is ${UI_SETTINGS_VALUE_MAX_BYTES}`
  }
  return null
}
