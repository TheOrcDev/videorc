import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { compileCaptureModule } from './lib/compile-capture-module.mjs'

const require = createRequire(import.meta.url)

const tempDir = join(tmpdir(), `videorc-start-labels-${Date.now()}`)

try {
  const tempModule = await compileCaptureModule(tempDir)

  const {
    areEnabledStreamTargetsStartReady,
    bridgeStreamingToLegacy,
    defaultCaptureConfig,
    startButtonLabel,
    startButtonPendingLabel
  } = require(tempModule)
  assert.equal(startButtonLabel(true, false), 'Start Recording')
  assert.equal(startButtonLabel(false, true), 'Start Livestream')
  assert.equal(startButtonLabel(true, true), 'Start Livestream + Record')
  assert.equal(startButtonLabel(false, false), 'Start Session')
  assert.equal(startButtonPendingLabel(false), 'Starting Recording...')
  assert.equal(startButtonPendingLabel(true), 'Starting Livestream...')

  const twitchOauthEnabled = bridgeStreamingToLegacy({
    ...defaultCaptureConfig,
    recordEnabled: false,
    streaming: {
      ...defaultCaptureConfig.streaming,
      enabled: true,
      mode: 'single',
      enabledTargetIds: ['twitch'],
      targets: defaultCaptureConfig.streaming.targets.map((target) =>
        target.platform === 'twitch'
          ? {
              ...target,
              enabled: true,
              authMode: 'oauth',
              serverUrl: '',
              streamKey: '',
              streamKeyPresent: false
            }
          : target
      )
    }
  })
  assert.equal(twitchOauthEnabled.streamEnabled, true)
  assert.equal(areEnabledStreamTargetsStartReady(twitchOauthEnabled.streaming), true)
  assert.equal(
    startButtonLabel(twitchOauthEnabled.recordEnabled, twitchOauthEnabled.streamEnabled),
    'Start Livestream'
  )

  const youtubeOauthReady = bridgeStreamingToLegacy({
    ...defaultCaptureConfig,
    recordEnabled: false,
    streaming: {
      ...defaultCaptureConfig.streaming,
      enabled: true,
      mode: 'single',
      enabledTargetIds: ['youtube'],
      targets: defaultCaptureConfig.streaming.targets.map((target) =>
        target.platform === 'youtube'
          ? {
              ...target,
              enabled: true,
              authMode: 'oauth',
              serverUrl: '',
              streamKey: '',
              streamKeyPresent: false
            }
          : target
      )
    }
  })
  assert.equal(youtubeOauthReady.streamEnabled, true)
  assert.equal(areEnabledStreamTargetsStartReady(youtubeOauthReady.streaming), true)

  const manualMissingKey = bridgeStreamingToLegacy({
    ...defaultCaptureConfig,
    recordEnabled: false,
    streaming: {
      ...defaultCaptureConfig.streaming,
      enabled: true,
      mode: 'single',
      enabledTargetIds: ['youtube'],
      targets: defaultCaptureConfig.streaming.targets.map((target) =>
        target.platform === 'youtube'
          ? {
              ...target,
              enabled: true,
              authMode: 'manual-rtmp',
              serverUrl: 'rtmp://a.rtmp.youtube.com/live2',
              streamKey: '',
              streamKeyPresent: false
            }
          : target
      )
    }
  })
  assert.equal(manualMissingKey.streamEnabled, true)
  assert.equal(areEnabledStreamTargetsStartReady(manualMissingKey.streaming), false)

  console.log(
    'Start label smoke OK - record, livestream, dual-output, and pending labels verified.'
  )
} finally {
  await rm(tempDir, { recursive: true, force: true })
}
