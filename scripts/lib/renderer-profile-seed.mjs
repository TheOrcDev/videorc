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
 */
export const CAPTURE_CONFIG_STORAGE_KEY = 'videorc.captureConfig'
export const WORKING_SCENE_STORAGE_KEY = 'videorc.working-scene.v1'

/** Renderer JS (inside an `eval-js` seed, before its reload). */
export const FORGET_WORKING_SCENE_JS = `localStorage.removeItem(${JSON.stringify(WORKING_SCENE_STORAGE_KEY)});`
