/**
 * The baseline's settings seam for the Electron app of this repository (plan
 * 260 S0.10). Plan 220's shooter wrote through the Rust UI settings store
 * (`window.__videorcUiSettings`); Electron keeps its UI settings in each
 * window's localStorage, so these give the shooter the same three helpers
 * over localStorage.
 *
 * Seeding the saved scenes writes the v1 library (`videorc.scene-presets.v1`)
 * and forgets the v2 one (`videorc.scenes.v2`), so the renderer's own
 * migration builds v2 from it on the next load. Every seed is written again
 * on `pagehide`: the running renderer persists its capture config on each
 * change, and a write between the seed and the reload would undo it (the
 * reason `reloadKeepingSeedJs` exists).
 */

export const LEGACY_SCENES_KEY = 'videorc.scene-presets.v1'
export const SCENES_V2_KEY = 'videorc.scenes.v2'

const STORE_JS = `{
  getItem: (key) => localStorage.getItem(key),
  setItem: (key, value) => localStorage.setItem(key, value),
  removeItem: (key) => localStorage.removeItem(key),
  clear: () => localStorage.clear(),
  flush: async () => true
}`

/** `const settings = await ${UI_SETTINGS_READY_JS};` in an async page script. */
export const UI_SETTINGS_READY_JS = `(async () => (${STORE_JS}))()`

/** Page JavaScript resolving to the stored string for `key`, or null. */
export function readUiSettingJs(key) {
  if (typeof key !== 'string' || !key) throw new Error(`Not a UI settings key: ${key}`)
  return `(async () => localStorage.getItem(${JSON.stringify(key)}))()`
}

/** Page JavaScript resolving to true once `entries` (key to string) are stored. */
export function seedUiSettingsJs(entries, { replace = false } = {}) {
  for (const [key, value] of Object.entries(entries)) {
    if (typeof value !== 'string') throw new Error(`Not a stored string for ${key}: ${value}`)
  }
  const forgetV2 = LEGACY_SCENES_KEY in entries && !(SCENES_V2_KEY in entries)
  return `(async () => {
  const entries = ${JSON.stringify(entries)};
  const write = () => {
    for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value);${forgetV2 ? `\n    localStorage.removeItem(${JSON.stringify(SCENES_V2_KEY)});` : ''}
  };${replace ? '\n  localStorage.clear();' : ''}
  write();
  window.addEventListener('pagehide', write);
  return true;
})()`
}
