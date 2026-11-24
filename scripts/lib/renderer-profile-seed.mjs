/**
 * Renderer profile seeds for the dev-app smokes. A smoke that wants a
 * deterministic scene writes `videorc.captureConfig` and reloads, but on load
 * the renderer takes the layout (and the visual sources) from the working
 * scene it remembered, `videorc.working-scene.v1`, over the capture config's
 * (use-studio.tsx). A fresh profile writes that working scene once its first
 * layout commits, so a seed that lands after it was silently undone: the
 * "screen-only" scene came back as screen + camera, and on a host with a
 * camera the Clips ring was refused for the camera's missing frames three
 * times and gave up (retest 153: "timed out waiting for replay buffer on").
 * Seeds forget the working scene with the capture config they write.
 *
 * The running renderer also persists its own capture config on every change
 * (use-studio.tsx), so a change in the moments between the seed's write and
 * the reload put the old config back over the seed (retest 154, plan 0008:
 * the seed wrote "screen-only", the renderer wrote "screen-camera" 64 ms
 * later, the reload loaded screen + camera, and the synthetic camera's
 * missing frames refused the Clips ring three times). The seed is written
 * again on `pagehide`, the last script the page runs before the reload.
 *
 * Plan 220 S1.4b: the renderer keeps its product state (the capture config,
 * the working scene, onboarding, consents, the theme...) in the backend's UI
 * settings store, not in localStorage. Smokes reach it in the page through
 * `window.__videorcUiSettings` (`getItem`/`setItem`/`removeItem`/`keys`/
 * `clear`/`flush`), with the same keys and string values. A write lands in
 * the window's cache at once and in its journal (synchronously), so a reload
 * right after it still finds it: the next window replays the journal.
 */
export const CAPTURE_CONFIG_STORAGE_KEY = 'videorc.captureConfig'
export const WORKING_SCENE_STORAGE_KEY = 'videorc.working-scene.v1'
export const SCENES_STORAGE_KEY = 'videorc.scenes.v2'
export const ONBOARDING_STORAGE_KEY = 'videorc.onboardingComplete'

/** The renderer's UI settings store seam, as page JavaScript. */
export const UI_SETTINGS_JS = 'window.__videorcUiSettings'

/**
 * Keys next-themes also keeps in localStorage, the copy theme-bootstrap.js
 * reads to paint frame one before the store is reachable. A seed writes both.
 */
export const PRE_PAINT_COPY_KEYS = Object.freeze(['videorc.theme'])

/**
 * Page JavaScript (an expression resolving to true once the engine holds the
 * writes): writes `entries` (key to string value) into the UI settings store,
 * and the pre-paint copy of the keys that have one. `replace` starts from a
 * fresh profile first: an empty store and an empty localStorage.
 */
export function seedUiSettingsJs(entries, { replace = false } = {}) {
  for (const [key, value] of Object.entries(entries)) {
    if (typeof value !== 'string') throw new Error(`Not a stored string for ${key}: ${value}`)
  }
  const clear = replace ? '\n  localStorage.clear();\n  settings.clear();' : ''
  return `(async () => {
  const settings = ${UI_SETTINGS_JS};
  if (!settings) throw new Error('This window has no UI settings store seam (window.__videorcUiSettings).');${clear}
  for (const [key, value] of Object.entries(${JSON.stringify(entries)})) {
    settings.setItem(key, value);
    if (${JSON.stringify(PRE_PAINT_COPY_KEYS)}.includes(key)) localStorage.setItem(key, value);
  }
  await settings.flush();
  return true;
})()`
}

/**
 * Renderer JS (inside an `eval-js` seed, after it wrote the capture config):
 * keeps the seeded capture config through the reload, and reloads after
 * `delayMs`. By default it also forgets the working scene; a seed that keeps
 * the remembered sources and layout (a real-source run, a seed that only
 * adds destinations) passes `forgetWorkingScene: false`. The v2 scene library
 * follows that choice; `forgetScenes` can override it for migration fixtures.
 */
export function reloadKeepingSeedJs({
  forgetWorkingScene = true,
  forgetScenes = forgetWorkingScene,
  delayMs = 50
} = {}) {
  if (!Number.isInteger(delayMs) || delayMs < 0) throw new Error(`Not a reload delay: ${delayMs}`)
  const forget = forgetWorkingScene
    ? `\n    settings.removeItem(${JSON.stringify(WORKING_SCENE_STORAGE_KEY)});`
    : ''
  const forgetLibrary = forgetScenes
    ? `\n    settings.removeItem(${JSON.stringify(SCENES_STORAGE_KEY)});`
    : ''
  return `{
  const settings = ${UI_SETTINGS_JS};
  const seededCaptureConfig = settings.getItem(${JSON.stringify(CAPTURE_CONFIG_STORAGE_KEY)});
  const writeSeed = () => {
    if (seededCaptureConfig !== null) settings.setItem(${JSON.stringify(CAPTURE_CONFIG_STORAGE_KEY)}, seededCaptureConfig);${forget}${forgetLibrary}
  };
  writeSeed();
  window.addEventListener('pagehide', writeSeed);
  setTimeout(() => location.reload(), ${delayMs});
}`
}

/** The default seed reload: forget the working scene, reload after 50 ms. */
export const RELOAD_KEEPING_SEED_JS = reloadKeepingSeedJs()
