// Plan 210: what a saved scene's switch needs beyond the state the Studio
// holds: its app window's resolution (D5) and its strict preflight (S3). The
// Studio loads this chunk once, warmed at connect, and reads it synchronously
// from then on, so no switch pays the import and the first paint never does.

export {
  rememberSceneWindowApp,
  resolveSceneWindowForApply,
  savedSceneApplyRetryAllowed,
  sceneWindowRefusal
} from './scene-window-resolution'
export { judgeSceneSources, runSavedScenePreflight } from './scene-apply-preflight'
