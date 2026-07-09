import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { resolveNativePreviewInProcessModule } from './native-preview-in-process-module-path'

describe('native preview in-process module path', () => {
  it('uses the packaged addon by default and preserves an explicit override', () => {
    const resourcesPath = '/Applications/Videorc.app/Contents/Resources'
    const addon = join(resourcesPath, 'videorc_native_preview.node')
    const exists = (path: string): boolean => path === addon

    expect(
      resolveNativePreviewInProcessModule({
        explicitPath: '/tmp/custom-preview.node',
        isPackaged: true,
        resourcesPath,
        workspaceRoot: '/repo',
        exists
      })
    ).toEqual({ path: '/tmp/custom-preview.node', source: 'explicit' })
    expect(
      resolveNativePreviewInProcessModule({
        isPackaged: true,
        resourcesPath,
        workspaceRoot: '/repo',
        exists
      })
    ).toEqual({
      path: addon,
      source: 'packaged'
    })
  })

  it('uses the built development addon from the workspace target directory', () => {
    const workspaceRoot = '/repo'
    const addon = join(workspaceRoot, 'target', 'debug', 'videorc_native_preview.node')

    expect(
      resolveNativePreviewInProcessModule({
        isPackaged: false,
        resourcesPath: '/unused',
        workspaceRoot,
        exists: (path) => path === addon
      })
    ).toEqual({ path: addon, source: 'development' })
  })
})
