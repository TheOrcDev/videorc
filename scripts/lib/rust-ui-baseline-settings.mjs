/**
 * The baseline's settings seam for the Electron app of this repository (plan
 * 260 S0.10). Since plan 260 S1.4 Electron keeps its UI settings in the
 * backend store too, so these hand the shooter the shared waits from
 * renderer-profile-seed.mjs: every read and write waits until the window's
 * store holds its snapshot.
 *
 * Seeding the saved scenes writes the v1 library (`videorc.scene-presets.v1`)
 * and forgets the v2 one (`videorc.scenes.v2`), so the renderer's own
 * migration builds v2 from it on the next load. Every seed is written again
 * on `pagehide`: the running renderer persists its capture config on each
 * change, and a write between the seed and the reload would undo it (the
 * reason `reloadKeepingSeedJs` exists).
 */
import {
  PRE_PAINT_COPY_KEYS,
  readUiSettingJs,
  UI_SETTINGS_READY_JS
} from './renderer-profile-seed.mjs'

export { readUiSettingJs, UI_SETTINGS_READY_JS }

export const LEGACY_SCENES_KEY = 'videorc.scene-presets.v1'
export const SCENES_V2_KEY = 'videorc.scenes.v2'

/** Page JavaScript resolving to true once `entries` (key to string) are stored. */
export function seedUiSettingsJs(entries, { replace = false } = {}) {
  for (const [key, value] of Object.entries(entries)) {
    if (typeof value !== 'string') throw new Error(`Not a stored string for ${key}: ${value}`)
  }
  const forgetV2 = LEGACY_SCENES_KEY in entries && !(SCENES_V2_KEY in entries)
  return `(async () => {
  const settings = await ${UI_SETTINGS_READY_JS};
  const entries = ${JSON.stringify(entries)};
  const write = () => {
    for (const [key, value] of Object.entries(entries)) {
      settings.setItem(key, value);
      if (${JSON.stringify(PRE_PAINT_COPY_KEYS)}.includes(key)) localStorage.setItem(key, value);
    }${forgetV2 ? `\n    settings.removeItem(${JSON.stringify(SCENES_V2_KEY)});` : ''}
  };${replace ? '\n  localStorage.clear();\n  settings.clear();' : ''}
  write();
  window.addEventListener('pagehide', write);
  await settings.flush();
  return true;
})()`
}
