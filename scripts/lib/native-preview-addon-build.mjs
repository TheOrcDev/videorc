import { join } from 'node:path'

export function nativePreviewAddonArtifact({ platform, profile, workspaceRoot }) {
  if (platform !== 'darwin') {
    return null
  }
  const targetDirectory = join(workspaceRoot, 'target', profile)
  return {
    source: join(targetDirectory, 'libvideorc_native_preview_addon.dylib'),
    destination: join(targetDirectory, 'videorc_native_preview.node')
  }
}

export function nativePreviewAddonUniversalPlan({ platform, profile, workspaceRoot }) {
  if (platform !== 'darwin') {
    return null
  }
  const library = 'libvideorc_native_preview_addon.dylib'
  return {
    targets: ['aarch64-apple-darwin', 'x86_64-apple-darwin'].map((rustTarget) => ({
      rustTarget,
      source: join(workspaceRoot, 'target', rustTarget, profile, library)
    })),
    destination: join(workspaceRoot, 'target', profile, 'videorc_native_preview.node')
  }
}
