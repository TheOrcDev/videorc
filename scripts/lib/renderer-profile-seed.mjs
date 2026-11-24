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
 *
 * S1.4b.2: the seam refuses a write until the window's store holds its
 * snapshot, and a smoke's first seed often runs while the window is still
 * hydrating (or before its entry even installed the seam). Every seed gets
 * the seam through `uiSettingsReadyJs` (`UI_SETTINGS_READY_JS`), which waits
 * for both; `seedUiSettingsJs` and `reloadKeepingSeedJs` do it themselves.
 * Scripts never write through `window.__videorcUiSettings` directly (the
 * guard in `smoke-command-callers.test.mjs`).
 */
export const CAPTURE_CONFIG_STORAGE_KEY = 'videorc.captureConfig'
export const WORKING_SCENE_STORAGE_KEY = 'videorc.working-scene.v1'
export const SCENES_STORAGE_KEY = 'videorc.scenes.v2'
export const ONBOARDING_STORAGE_KEY = 'videorc.onboardingComplete'

/** The renderer's UI settings store seam, as page JavaScript (only through the wait below). */
const UI_SETTINGS_JS = 'window.__videorcUiSettings'

/**
 * How long a seed waits for the seam and the snapshot: the window's own
 * hydrate deadline (15 s, `UI_SETTINGS_HYDRATE_TIMEOUT_MS`) after its entry
 * ran, plus the bundle's load on a cold dev server.
 */
export const UI_SETTINGS_READY_TIMEOUT_MS = 45_000

/**
 * Page JavaScript (an expression resolving to the seam, for `await`): waits
 * until this window installed `window.__videorcUiSettings` and its store holds
 * the engine's snapshot (`ready()`), then hands the seam over for the seed's
 * reads and writes. Rejects naming what it last saw: no seam yet, the store's
 * state at the deadline, or the reason the window rendered without its
 * snapshot.
 */
export function uiSettingsReadyJs({ timeoutMs = UI_SETTINGS_READY_TIMEOUT_MS } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`Not a UI settings wait: ${timeoutMs}`)
  }
  return `(async () => {
  const deadline = Date.now() + ${timeoutMs};
  let settings = ${UI_SETTINGS_JS};
  while (!settings) {
    if (Date.now() >= deadline) {
      throw new Error('This window has no UI settings store seam (window.__videorcUiSettings) after ${timeoutMs} ms: its entry never started hydrating.');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    settings = ${UI_SETTINGS_JS};
  }
  let timer = null;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error('This window\\'s UI settings store did not hydrate within ${timeoutMs} ms (last seen: ' + settings.status().hydration.state + ').'));
    }, Math.max(0, deadline - Date.now()));
  });
  try {
    await Promise.race([settings.ready(), late]);
  } finally {
    clearTimeout(timer);
  }
  return settings;
})()`
}

/** The default wait: `const settings = await ${UI_SETTINGS_READY_JS};` in an async page script. */
export const UI_SETTINGS_READY_JS = uiSettingsReadyJs()

/**
 * Page JavaScript (an expression resolving to the stored string, or null):
 * reads `key` once the window's store holds its snapshot. A read that feeds a
 * seed must wait too: before the snapshot every key reads null, and a seed
 * built on that would write a fresh profile over the real one.
 */
export function readUiSettingJs(key, { readyTimeoutMs = UI_SETTINGS_READY_TIMEOUT_MS } = {}) {
  if (typeof key !== 'string' || !key) throw new Error(`Not a UI settings key: ${key}`)
  return `(async () => (await ${uiSettingsReadyJs({ timeoutMs: readyTimeoutMs })}).getItem(${JSON.stringify(key)}))()`
}

/**
 * Keys next-themes also keeps in localStorage, the copy theme-bootstrap.js
 * reads to paint frame one before the store is reachable. A seed writes both.
 */
export const PRE_PAINT_COPY_KEYS = Object.freeze(['videorc.theme'])

/**
 * Page JavaScript (an expression resolving to true once the engine holds the
 * writes): waits for the window's store (`uiSettingsReadyJs`), then writes
 * `entries` (key to string value) into it, and the pre-paint copy of the
 * keys that have one. `replace` starts from a fresh profile first: an empty
 * store and an empty localStorage. `readyTimeoutMs` bounds the wait (keep it
 * under the caller's own request timeout, so the page's answer names why).
 */
export function seedUiSettingsJs(
  entries,
  { replace = false, readyTimeoutMs = UI_SETTINGS_READY_TIMEOUT_MS } = {}
) {
  for (const [key, value] of Object.entries(entries)) {
    if (typeof value !== 'string') throw new Error(`Not a stored string for ${key}: ${value}`)
  }
  const clear = replace ? '\n  localStorage.clear();\n  settings.clear();' : ''
  return `(async () => {
  const settings = await ${uiSettingsReadyJs({ timeoutMs: readyTimeoutMs })};${clear}
  for (const [key, value] of Object.entries(${JSON.stringify(entries)})) {
    settings.setItem(key, value);
    if (${JSON.stringify(PRE_PAINT_COPY_KEYS)}.includes(key)) localStorage.setItem(key, value);
  }
  await settings.flush();
  return true;
})()`
}

/**
 * Renderer JS (statements inside an `eval-js` seed's async body, after it
 * wrote the capture config): keeps the seeded capture config through the
 * reload, and reloads after `delayMs`. By default it also forgets the working
 * scene; a seed that keeps the remembered sources and layout (a real-source
 * run, a seed that only adds destinations) passes `forgetWorkingScene: false`.
 * It waits for the store like every seed (at once after the caller's wait);
 * the `pagehide` re-write runs in this same, hydrated window. The v2 scene
 * library follows the working-scene choice; `forgetScenes` can override it
 * for migration fixtures.
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
  const settings = await ${UI_SETTINGS_READY_JS};
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
