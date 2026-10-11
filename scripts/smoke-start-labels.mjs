import assert from 'node:assert/strict'
import { readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { compileCaptureModule, compileRendererModules } from './lib/compile-capture-module.mjs'

// Plan 174 S2.2 (D3, B-31): the start and stop words the app really shows.
// The Studio transport, ⌘K, the Go Live dialog, Settings → Shortcuts and
// Upcoming read them from lib/go-live-copy.ts and the stop control from
// sessionStopControl; this smoke pins both and checks the surfaces use them.

const require = createRequire(import.meta.url)

const RENDERER = 'apps/desktop/src/renderer/src'
const tempDir = join(tmpdir(), `videorc-start-labels-${Date.now()}`)

/**
 * Each surface (its path under the renderer, as segments) and the
 * go-live-copy names it must render.
 */
const SURFACE_LABELS = [
  [
    ['components', 'studio', 'session-panel.tsx'],
    ['RECORD_LABEL', 'GO_LIVE_LABEL']
  ],
  [
    ['components', 'command-palette.tsx'],
    ['START_RECORDING_COMMAND', 'GO_LIVE_COMMAND', 'sessionStopControl']
  ],
  [
    ['components', 'go-live-dialog.tsx'],
    ['GO_LIVE_DIALOG_TITLE', 'goLiveConfirmLabel', 'goLiveOnReadyLabel']
  ],
  [
    ['components', 'scheduled-streams.tsx'],
    ['USE_FOR_GO_LIVE_LABEL', 'GO_LIVE_LABEL']
  ],
  [['lib', 'shortcuts.ts'], ['RECORD_SHORTCUT_LABEL']],
  [
    ['components', 'settings', 'shortcuts-settings.tsx'],
    ['RECORD_SHORTCUT_LABEL', 'GO_LIVE_SHORTCUT_LABEL']
  ]
]

/** The names D3 retired; none of the surfaces may spell them again. */
const RETIRED_LABELS = [
  'Confirm Go Live',
  'Continue With Ready',
  'Resolve Blockers First',
  'Switch to Manual RTMP',
  'Start session',
  'Stop session',
  'Start / stop the session',
  'Go live / end stream',
  'Live session stopped unexpectedly'
]

try {
  const tempModule = await compileCaptureModule(tempDir)
  const compiled = await compileRendererModules(tempDir, [
    `${RENDERER}/lib/go-live-copy.ts`,
    `${RENDERER}/lib/go-live-flow.ts`,
    `${RENDERER}/lib/session-stop.ts`,
    `${RENDERER}/lib/status-word.ts`,
    `${RENDERER}/lib/studio-session-view.ts`,
    'apps/desktop/src/shared/capture-state.ts',
    'apps/desktop/src/shared/timecode.ts'
  ])
  const copy = require(compiled[`${RENDERER}/lib/go-live-copy.ts`])
  const { decideGoLiveStart } = require(compiled[`${RENDERER}/lib/go-live-flow.ts`])
  const { sessionStatusLabel, sessionStopControl } = require(
    compiled[`${RENDERER}/lib/studio-session-view.ts`]
  )

  // The Studio transport: Record (with its Space chip) and Go Live…, which
  // opens the dialog.
  assert.equal(copy.RECORD_LABEL, 'Record')
  assert.equal(copy.GO_LIVE_LABEL, 'Go Live…')

  // Its stop control, per state: "End livestream" on air (with the visible
  // line when the recording stops too), "Stop recording" for a recording,
  // "Cancel livestream" while a Go Live starts.
  const goLive = { state: 'recording', streamUrl: 'rtmp://live.example/app/***' }
  const streamOnly = { state: 'streaming', streamUrl: 'rtmp://live.example/app/***' }
  assert.deepEqual(sessionStopControl(goLive, false), {
    label: 'End livestream',
    note: 'Your recording stops too.'
  })
  assert.deepEqual(sessionStopControl(streamOnly, false), { label: 'End livestream' })
  assert.deepEqual(sessionStopControl({ state: 'recording' }, false), { label: 'Stop recording' })
  assert.deepEqual(sessionStopControl({ state: 'starting' }, false, true), {
    label: 'Cancel livestream'
  })
  assert.deepEqual(sessionStopControl({ state: 'starting' }, false, false), {
    label: 'Stop recording'
  })
  assert.deepEqual(sessionStopControl({ state: 'stopping' }, false), { label: 'Force stop' })
  assert.deepEqual(sessionStopControl(goLive, true), { label: 'Stopping…' })
  assert.equal(sessionStatusLabel(goLive, 'connected'), 'On air')
  assert.equal(sessionStatusLabel({ state: 'recording' }, 'connected'), 'Recording')

  // The Go Live dialog.
  assert.equal(copy.GO_LIVE_DIALOG_TITLE, 'Go live')
  assert.equal(copy.goLiveConfirmLabel(1), 'Go live')
  assert.equal(copy.goLiveConfirmLabel(3), 'Go live on 3 destinations')
  assert.equal(copy.goLiveOnReadyLabel(['Twitch']), 'Go live on Twitch')
  assert.equal(copy.goLiveOnReadyLabel(['Twitch', 'Kick']), 'Go live on 2 destinations')

  // ⌘K, Settings → Shortcuts and Upcoming.
  assert.equal(copy.START_RECORDING_COMMAND, 'Start recording')
  assert.equal(copy.GO_LIVE_COMMAND, 'Go live…')
  assert.equal(copy.RECORD_SHORTCUT_LABEL, 'Record / stop recording')
  assert.equal(copy.GO_LIVE_SHORTCUT_LABEL, 'Go Live / end livestream')
  assert.equal(copy.USE_FOR_GO_LIVE_LABEL, 'Use for Go Live…')

  // Every surface renders these words, and none spells a retired one.
  for (const [segments, names] of SURFACE_LABELS) {
    const file = join(...segments)
    const source = await readFile(join(process.cwd(), RENDERER, file), 'utf8')
    for (const name of names) {
      assert.match(source, new RegExp(`\\b${name}\\b`), `${file} renders ${name}`)
    }
    for (const retired of RETIRED_LABELS) {
      assert.ok(!source.includes(retired), `${file} still says "${retired}"`)
    }
  }

  // Record starts at once; a stream-enabled start opens the Go Live dialog.
  assert.equal(decideGoLiveStart(false), 'start-directly')
  assert.equal(decideGoLiveStart(true), 'open-confirmation')

  const {
    areEnabledStreamTargetsStartReady,
    bridgeStreamingToLegacy,
    defaultCaptureConfig
  } = require(tempModule)

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
  assert.equal(decideGoLiveStart(twitchOauthEnabled.streamEnabled), 'open-confirmation')

  // Kick (plan 063) is Manual RTMP until its OAuth ships: the built-in card
  // carries Kick's public ingest, so a pasted key alone makes it start-ready
  // and it bridges to the legacy `kick` preset.
  const kickManual = bridgeStreamingToLegacy({
    ...defaultCaptureConfig,
    recordEnabled: false,
    streaming: {
      ...defaultCaptureConfig.streaming,
      enabled: true,
      mode: 'single',
      enabledTargetIds: ['kick'],
      targets: defaultCaptureConfig.streaming.targets.map((target) =>
        target.platform === 'kick'
          ? {
              ...target,
              enabled: true,
              authMode: 'manual-rtmp',
              streamKey: 'sk_us-west-2_smoke_key',
              streamKeyPresent: true
            }
          : target
      )
    }
  })
  assert.equal(kickManual.streamEnabled, true)
  assert.equal(kickManual.rtmpPreset, 'kick')
  assert.equal(
    kickManual.rtmpServerUrl,
    'rtmps://fa723fc1b171.global-contribute.live-video.net:443/app'
  )
  assert.equal(areEnabledStreamTargetsStartReady(kickManual.streaming), true)

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
    'Start label smoke OK - transport, stop, Go Live dialog, command, shortcut and Upcoming labels verified.'
  )
} finally {
  await rm(tempDir, { recursive: true, force: true })
}
