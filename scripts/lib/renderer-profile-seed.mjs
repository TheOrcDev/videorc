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
 */
export const CAPTURE_CONFIG_STORAGE_KEY = 'videorc.captureConfig'
export const WORKING_SCENE_STORAGE_KEY = 'videorc.working-scene.v1'

/**
 * Renderer JS (inside an `eval-js` seed, after it wrote the capture config):
 * forgets the working scene, keeps the seeded capture config through the
 * reload, and reloads.
 */
export const RELOAD_KEEPING_SEED_JS = `{
  const seededCaptureConfig = localStorage.getItem(${JSON.stringify(CAPTURE_CONFIG_STORAGE_KEY)});
  const writeSeed = () => {
    if (seededCaptureConfig !== null) localStorage.setItem(${JSON.stringify(CAPTURE_CONFIG_STORAGE_KEY)}, seededCaptureConfig);
    localStorage.removeItem(${JSON.stringify(WORKING_SCENE_STORAGE_KEY)});
  };
  writeSeed();
  window.addEventListener('pagehide', writeSeed);
  setTimeout(() => location.reload(), 50);
}`
