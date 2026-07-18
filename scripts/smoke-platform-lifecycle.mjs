import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { compileCaptureModule } from './lib/compile-capture-module.mjs'

const require = createRequire(import.meta.url)

const tempDir = join(tmpdir(), `videorc-platform-lifecycle-${Date.now()}`)

try {
  const tempModule = await compileCaptureModule(tempDir)

  const {
    defaultCaptureConfig,
    patchPreparedStreamTarget,
    preparedYouTubeActivationTargets,
    preparedYouTubeCompletionTargets,
    readyStreamTargetLabels
  } = require(tempModule)

  const streaming = {
    ...defaultCaptureConfig.streaming,
    enabled: true,
    mode: 'multi',
    enabledTargetIds: [
      'youtube-ready',
      'youtube-no-stream',
      'twitch-ready',
      'youtube-disabled',
      'youtube-manual',
      'x-missing'
    ],
    targets: [
      target('youtube-ready', 'youtube', 'oauth', true, {
        platformBroadcastId: 'broadcast-ready',
        platformStreamId: 'stream-ready',
        status: { state: 'live', message: 'YouTube broadcast is live.' }
      }),
      target('youtube-no-stream', 'youtube', 'oauth', true, {
        platformBroadcastId: 'broadcast-no-stream'
      }),
      target('twitch-ready', 'twitch', 'oauth', true, {
        platformBroadcastId: undefined,
        platformStreamId: undefined
      }),
      target('youtube-disabled', 'youtube', 'oauth', false, {
        platformBroadcastId: 'broadcast-disabled',
        platformStreamId: 'stream-disabled'
      }),
      target('youtube-manual', 'youtube', 'manual-rtmp', true, {
        platformBroadcastId: 'broadcast-manual',
        platformStreamId: 'stream-manual'
      }),
      target('x-missing', 'x', 'manual-rtmp', true, {
        serverUrl: '',
        streamKeyPresent: false,
        streamKeySecretRef: undefined
      })
    ]
  }

  assert.deepEqual(
    preparedYouTubeActivationTargets(streaming).map((item) => item.id),
    ['youtube-ready']
  )
  assert.deepEqual(
    preparedYouTubeCompletionTargets(streaming).map((item) => item.id),
    ['youtube-ready']
  )
  assert.deepEqual(readyStreamTargetLabels(streaming), [
    'youtube-ready',
    'youtube-no-stream',
    'twitch-ready',
    'youtube-manual'
  ])

  const patched = patchPreparedStreamTarget(
    streaming,
    'youtube-ready',
    {
      status: {
        state: 'live',
        message: 'YouTube broadcast is live.'
      }
    },
    '2026-06-03T00:00:00.000Z'
  )
  const patchedTarget = patched.targets.find((item) => item.id === 'youtube-ready')
  assert.equal(patchedTarget.status.state, 'live')
  assert.equal(patchedTarget.status.message, 'YouTube broadcast is live.')
  assert.equal(patchedTarget.updatedAt, '2026-06-03T00:00:00.000Z')
  assert.equal(
    patched.targets.find((item) => item.id === 'twitch-ready').updatedAt,
    '2026-06-02T00:00:00.000Z'
  )

  const failed = patchPreparedStreamTarget(
    streaming,
    'youtube-no-stream',
    {
      enabled: false,
      status: {
        state: 'failed',
        message: 'YouTube setup failed.'
      }
    },
    '2026-06-03T00:00:00.000Z'
  )
  const failedTarget = failed.targets.find((item) => item.id === 'youtube-no-stream')
  assert.equal(failedTarget.enabled, false)
  assert.equal(failedTarget.status.state, 'failed')
  assert.equal(failedTarget.status.message, 'YouTube setup failed.')

  console.log(
    'Platform lifecycle smoke OK - available YouTube OAuth, ready labels, and status patching verified.'
  )
} finally {
  await rm(tempDir, { recursive: true, force: true })
}

function target(id, platform, authMode, enabled, patch = {}) {
  return {
    id,
    platform,
    label: id,
    enabled,
    serverUrl: 'rtmp://example.test/live',
    urlMode: 'server-and-key',
    streamKey: '',
    streamKeyPresent: true,
    streamKeySecretRef: `stream-target:${id}:manual-stream-key`,
    authMode,
    accountId: `${platform}-account`,
    accountLabel: `${platform} account`,
    status: { state: 'ready', message: 'Prepared.' },
    createdAt: '2026-06-02T00:00:00.000Z',
    updatedAt: '2026-06-02T00:00:00.000Z',
    ...patch
  }
}
