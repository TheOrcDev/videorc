// Plan 214 C4: what a packaged Windows Videorc must carry for Videorc
// Camera: the Media Foundation media source DLL and the elevated setup exe,
// both in `resources/` beside videorc-backend.exe (electron-builder.yml,
// win.extraResources). Pure: the layout is read through an injected
// `exists`. Used by scripts/check-packaged-app.mjs on win32; their
// Authenticode signatures are the release validator's job.
import { dirname, join } from 'node:path'

/** Cargo's name for the cdylib, and the setup exe (crates/videorc-virtual-camera-windows). */
export const WINDOWS_CAMERA_DLL_FILE_NAME = 'videorc_virtual_camera_windows.dll'
export const WINDOWS_CAMERA_SETUP_EXE_FILE_NAME = 'videorc-camera-setup.exe'

/** The `resources/` folder for a packaged Videorc.exe. */
export function windowsResourcesDirForApp(appPath) {
  return join(dirname(String(appPath)), 'resources')
}

/** Every file the camera needs inside the package. */
export function windowsCameraPaths(resourcesDir) {
  return {
    dll: join(resourcesDir, WINDOWS_CAMERA_DLL_FILE_NAME),
    setupExe: join(resourcesDir, WINDOWS_CAMERA_SETUP_EXE_FILE_NAME)
  }
}

/** Pure (IO injected). Which of the camera files exist. */
export function windowsCameraLayout(resourcesDir, { exists }) {
  const paths = windowsCameraPaths(resourcesDir)
  return {
    paths,
    present: Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, exists(path)]))
  }
}

/** Pure. One problem per missing file; empty when both ship. */
export function windowsCameraLayoutProblems(layout) {
  const problems = []
  if (!layout.present.dll) {
    problems.push(`Videorc Camera media source is missing: ${layout.paths.dll}`)
  }
  if (!layout.present.setupExe) {
    problems.push(`Videorc Camera setup exe is missing: ${layout.paths.setupExe}`)
  }
  return problems
}

/** Pure. One line for the check's report. */
export function describeWindowsCameraLayout(layout) {
  if (layout.present.dll && layout.present.setupExe) {
    return 'bundled (media source DLL and setup exe present; hidden in the app until plan 214 P0b passes)'
  }
  return `incomplete (dll ${layout.present.dll ? 'present' : 'missing'}, setup exe ${
    layout.present.setupExe ? 'present' : 'missing'
  })`
}
