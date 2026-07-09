import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import {
  nativePreviewAddonArtifact,
  nativePreviewAddonUniversalPlan
} from './native-preview-addon-build.mjs'

test('native preview addon build maps the Rust dylib to a Node addon', () => {
  const workspaceRoot = '/repo'
  assert.deepEqual(
    nativePreviewAddonArtifact({
      platform: 'darwin',
      profile: 'debug',
      workspaceRoot
    }),
    {
      source: join(workspaceRoot, 'target', 'debug', 'libvideorc_native_preview_addon.dylib'),
      destination: join(workspaceRoot, 'target', 'debug', 'videorc_native_preview.node')
    }
  )
  assert.equal(
    nativePreviewAddonArtifact({
      platform: 'win32',
      profile: 'release',
      workspaceRoot: '/repo'
    }),
    null
  )
})

test('universal release build combines arm64 and x64 dylibs into the packaged addon', () => {
  const workspaceRoot = '/repo'
  const library = 'libvideorc_native_preview_addon.dylib'
  assert.deepEqual(
    nativePreviewAddonUniversalPlan({
      platform: 'darwin',
      profile: 'release',
      workspaceRoot
    }),
    {
      targets: [
        {
          rustTarget: 'aarch64-apple-darwin',
          source: join(workspaceRoot, 'target', 'aarch64-apple-darwin', 'release', library)
        },
        {
          rustTarget: 'x86_64-apple-darwin',
          source: join(workspaceRoot, 'target', 'x86_64-apple-darwin', 'release', library)
        }
      ],
      destination: join(workspaceRoot, 'target', 'release', 'videorc_native_preview.node')
    }
  )
  assert.equal(
    nativePreviewAddonUniversalPlan({
      platform: 'linux',
      profile: 'release',
      workspaceRoot: '/repo'
    }),
    null
  )
})
