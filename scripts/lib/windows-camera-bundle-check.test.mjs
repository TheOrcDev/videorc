import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  WINDOWS_CAMERA_DLL_FILE_NAME,
  WINDOWS_CAMERA_SETUP_EXE_FILE_NAME,
  describeWindowsCameraLayout,
  windowsCameraLayout,
  windowsCameraLayoutProblems,
  windowsResourcesDirForApp
} from './windows-camera-bundle-check.mjs'

const RESOURCES = join('C:', 'Videorc', 'win-unpacked', 'resources')

describe('windows camera bundle check', () => {
  it('finds resources/ beside the packaged exe', () => {
    assert.equal(
      windowsResourcesDirForApp(join('C:', 'Videorc', 'win-unpacked', 'Videorc.exe')),
      join('C:', 'Videorc', 'win-unpacked', 'resources')
    )
  })

  it('passes when the media source DLL and the setup exe ship', () => {
    const layout = windowsCameraLayout(RESOURCES, { exists: () => true })
    assert.deepEqual(layout.paths, {
      dll: join(RESOURCES, WINDOWS_CAMERA_DLL_FILE_NAME),
      setupExe: join(RESOURCES, WINDOWS_CAMERA_SETUP_EXE_FILE_NAME)
    })
    assert.deepEqual(windowsCameraLayoutProblems(layout), [])
    assert.match(describeWindowsCameraLayout(layout), /^bundled/)
  })

  it('names each missing file', () => {
    const dllOnly = windowsCameraLayout(RESOURCES, {
      exists: (path) => path.endsWith(WINDOWS_CAMERA_DLL_FILE_NAME)
    })
    assert.deepEqual(windowsCameraLayoutProblems(dllOnly), [
      `Videorc Camera setup exe is missing: ${join(RESOURCES, WINDOWS_CAMERA_SETUP_EXE_FILE_NAME)}`
    ])
    assert.equal(
      describeWindowsCameraLayout(dllOnly),
      'incomplete (dll present, setup exe missing)'
    )
    const nothing = windowsCameraLayout(RESOURCES, { exists: () => false })
    assert.equal(windowsCameraLayoutProblems(nothing).length, 2)
  })
})
