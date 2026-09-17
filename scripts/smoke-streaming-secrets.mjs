import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { compileCaptureModule } from './lib/compile-capture-module.mjs'

const require = createRequire(import.meta.url)

const tempDir = join(tmpdir(), `videorc-streaming-secrets-${Date.now()}`)

try {
  const tempModule = await compileCaptureModule(tempDir)

  const {
    defaultCaptureConfig,
    normalizeStreamingSettings,
    patchStreamTargetForEdit,
    persistableCaptureConfig
  } = require(tempModule)
  const normalized = normalizeStreamingSettings({
    enabled: true,
    mode: 'single',
    enabledTargetIds: ['youtube'],
    targets: [
      {
        id: 'youtube',
        platform: 'youtube',
        label: 'YouTube',
        enabled: true,
        serverUrl: 'rtmp://a.rtmp.youtube.com/live2',
        urlMode: 'server-and-key',
        streamKey: '',
        streamKeySecretRef: 'secret://youtube-stream-key',
        streamKeyPresent: true,
        authMode: 'oauth',
        accountId: 'youtube-account',
        accountLabel: 'Videorc',
        platformBroadcastId: 'broadcast-123',
        platformStreamId: 'stream-123',
        createdAt: '2026-06-03T00:00:00.000Z',
        updatedAt: '2026-06-03T00:00:00.000Z'
      }
    ]
  })

  const youtube = normalized.targets.find((target) => target.platform === 'youtube')
  assert.ok(youtube)
  assert.equal(youtube.authMode, 'oauth')
  assert.equal(youtube.streamKey, '')
  assert.equal(youtube.streamKeySecretRef, 'secret://youtube-stream-key')
  assert.equal(youtube.streamKeyPresent, true)
  assert.equal(youtube.accountId, 'youtube-account')
  assert.equal(youtube.platformBroadcastId, 'broadcast-123')
  assert.equal(youtube.platformStreamId, 'stream-123')

  const twitch = normalized.targets.find((target) => target.platform === 'twitch')
  assert.ok(twitch)
  assert.equal(twitch.streamKeyPresent, false)
  assert.equal(twitch.streamKeySecretRef, undefined)

  const persisted = persistableCaptureConfig({
    ...defaultCaptureConfig,
    rtmpPreset: 'youtube',
    streamKey: 'raw-oauth-key',
    streaming: {
      ...defaultCaptureConfig.streaming,
      targets: defaultCaptureConfig.streaming.targets.map((target) =>
        target.platform === 'youtube'
          ? {
              ...target,
              enabled: true,
              authMode: 'oauth',
              streamKey: 'raw-oauth-key',
              streamKeySecretRef: 'secret://youtube-stream-key',
              streamKeyPresent: true
            }
          : target.platform === 'twitch'
            ? {
                ...target,
                enabled: true,
                authMode: 'manual-rtmp',
                streamKey: 'manual-key',
                streamKeyPresent: true
              }
            : target
      )
    }
  })
  const persistedYoutube = persisted.streaming.targets.find(
    (target) => target.platform === 'youtube'
  )
  const persistedTwitch = persisted.streaming.targets.find((target) => target.platform === 'twitch')
  assert.equal(persisted.streamKey, '')
  assert.equal(persistedYoutube.authMode, 'oauth')
  assert.equal(persistedYoutube.streamKey, '')
  assert.equal(persistedYoutube.streamKeySecretRef, 'secret://youtube-stream-key')
  assert.equal(persistedYoutube.streamKeyPresent, true)
  assert.equal(persistedTwitch.streamKey, 'manual-key')

  const persistedManualSecret = persistableCaptureConfig({
    ...defaultCaptureConfig,
    rtmpPreset: 'twitch',
    streamKey: 'raw-manual-key',
    streaming: {
      ...defaultCaptureConfig.streaming,
      targets: defaultCaptureConfig.streaming.targets.map((target) =>
        target.platform === 'twitch'
          ? {
              ...target,
              enabled: true,
              authMode: 'manual-rtmp',
              streamKey: 'raw-manual-key',
              streamKeySecretRef: 'stream-target:twitch:manual-stream-key',
              streamKeyPresent: true
            }
          : target
      )
    }
  })
  const persistedManualTwitch = persistedManualSecret.streaming.targets.find(
    (target) => target.platform === 'twitch'
  )
  assert.equal(persistedManualSecret.streamKey, '')
  assert.equal(persistedManualTwitch.streamKey, '')
  assert.equal(persistedManualTwitch.streamKeySecretRef, 'stream-target:twitch:manual-stream-key')
  assert.equal(persistedManualTwitch.streamKeyPresent, true)

  const persistedManualDraft = persistableCaptureConfig({
    ...defaultCaptureConfig,
    rtmpPreset: 'twitch',
    streamKey: 'manual-key',
    streaming: {
      ...defaultCaptureConfig.streaming,
      targets: defaultCaptureConfig.streaming.targets.map((target) =>
        target.platform === 'twitch'
          ? {
              ...target,
              enabled: true,
              authMode: 'manual-rtmp',
              streamKey: 'manual-key',
              streamKeyPresent: true
            }
          : target
      )
    }
  })
  const persistedManualDraftTwitch = persistedManualDraft.streaming.targets.find(
    (target) => target.platform === 'twitch'
  )
  assert.equal(persistedManualDraft.streamKey, 'manual-key')
  assert.equal(persistedManualDraftTwitch.streamKey, 'manual-key')

  const persistedFullUrlSecret = persistableCaptureConfig({
    ...defaultCaptureConfig,
    rtmpPreset: 'custom',
    rtmpServerUrl: 'rtmp://example.test/live/full-url-secret',
    streamKey: '',
    streaming: {
      ...defaultCaptureConfig.streaming,
      targets: defaultCaptureConfig.streaming.targets.map((target) =>
        target.platform === 'custom'
          ? {
              ...target,
              enabled: true,
              urlMode: 'full-url',
              authMode: 'manual-rtmp',
              serverUrl: 'rtmp://example.test/live/full-url-secret',
              streamKey: '',
              streamKeySecretRef: 'stream-target:custom:manual-stream-key',
              streamKeyPresent: true
            }
          : target
      )
    }
  })
  const persistedFullUrlCustom = persistedFullUrlSecret.streaming.targets.find(
    (target) => target.platform === 'custom'
  )
  assert.equal(persistedFullUrlSecret.rtmpServerUrl, '')
  assert.equal(persistedFullUrlCustom.serverUrl, '')
  assert.equal(persistedFullUrlCustom.streamKey, '')
  assert.equal(persistedFullUrlCustom.streamKeySecretRef, 'stream-target:custom:manual-stream-key')
  assert.equal(persistedFullUrlCustom.streamKeyPresent, true)

  const manualYouTube = {
    ...defaultCaptureConfig.streaming.targets.find((target) => target.platform === 'youtube'),
    authMode: 'manual-rtmp',
    streamKey: '',
    streamKeySecretRef: 'stream-target:youtube:manual-stream-key',
    streamKeyPresent: true,
    platformBroadcastId: 'old-broadcast',
    platformStreamId: 'old-stream',
    status: { state: 'ready', message: 'Old manual key.' }
  }
  const oauthYouTube = patchStreamTargetForEdit(
    manualYouTube,
    { authMode: 'oauth' },
    '2026-06-03T00:00:00.000Z'
  )
  assert.equal(oauthYouTube.authMode, 'oauth')
  assert.equal(oauthYouTube.streamKey, '')
  assert.equal(oauthYouTube.streamKeySecretRef, undefined)
  assert.equal(oauthYouTube.streamKeyPresent, false)
  assert.equal(oauthYouTube.platformBroadcastId, undefined)
  assert.equal(oauthYouTube.platformStreamId, undefined)

  const customFullUrl = patchStreamTargetForEdit(
    {
      ...defaultCaptureConfig.streaming.targets.find((target) => target.platform === 'custom'),
      urlMode: 'server-and-key',
      serverUrl: 'rtmp://example.test/live',
      streamKeySecretRef: 'stream-target:custom:manual-stream-key',
      streamKeyPresent: true
    },
    { urlMode: 'full-url' },
    '2026-06-03T00:00:00.000Z'
  )
  assert.equal(customFullUrl.urlMode, 'full-url')
  assert.equal(customFullUrl.serverUrl, '')
  assert.equal(customFullUrl.streamKeySecretRef, undefined)
  assert.equal(customFullUrl.streamKeyPresent, false)

  console.log(
    'Streaming secret smoke OK - available YouTube OAuth and manual secret refs persist without raw keys.'
  )
} finally {
  await rm(tempDir, { recursive: true, force: true })
}
