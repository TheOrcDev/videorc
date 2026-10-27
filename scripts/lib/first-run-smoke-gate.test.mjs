import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  evaluateFirstRunSmokeStep,
  FIRST_RUN_SMOKE_LIMITS,
  FIRST_RUN_SOURCE_START_PATTERNS,
  firstRunSourceStartLines
} from './first-run-smoke-gate.mjs'

const raw =
  '{"version":1,"status":"skipped","step":"permissions","updatedAt":"2026-10-27T12:00:00.000Z"}'
const record = (status) => ({ ...JSON.parse(raw), status })
const setup = {
  setup: 'open',
  mode: 'first-run',
  cardStep: 'permissions',
  rows: ['granted', 'granted', 'denied', 'denied'],
  loading: false,
  sidebar: false,
  primaryCount: 1,
  primary: 'Skip for now',
  whatsNew: false,
  whatsNewOverSetup: false,
  workspaceBeforeSetup: false,
  record: record('in-progress')
}
const workspace = { setup: null, sidebar: true, canvasCount: 0, setupEver: false }
const observations = {
  fresh: setup,
  moving: { backdrop: 'moving', look: 'polished', mountToMovingMs: 2500 },
  motion: {
    backdrop: 'moving',
    durationMs: 2000,
    frameCount: 60,
    firstLastDiffer: true,
    drawCount: 60,
    drawFps: 30
  },
  'reduced-motion': { backdrop: 'still', reason: 'reduced-motion', canvasCount: 0 },
  finish: {
    ...workspace,
    record: record('skipped'),
    pressedPrimary: 'Skip setup',
    retainedContextsLost: true
  },
  reload: { ...workspace, record: record('skipped'), recordRaw: raw, beforeRecordRaw: raw },
  'existing-install': { ...workspace, record: record('existing-install') },
  resume: setup,
  'replay-open': { ...setup, mode: 'replay', recordRaw: raw, beforeRecordRaw: raw },
  'replay-return': {
    ...workspace,
    settingsGeneral: true,
    recordRaw: raw,
    beforeRecordRaw: raw,
    configRaw: '{}',
    beforeConfigRaw: '{}',
    visitedSteps: ['permissions', 'goal', 'look', 'sound', 'destinations'],
    pressedPrimary: 'Done'
  },
  'whats-new': { ...setup, seededWhatsNew: '0.0.1', watchMs: 1000 }
}

const config = { layout: { layoutPreset: 'camera-only' }, audio: { microphoneGainDb: 1 } }
const registry = { activeSlotId: null, live: { activeId: 'silk' } }
const v2Record = (step, goal = 'record', status = 'in-progress') => ({
  ...record(status),
  version: 2,
  step,
  goal
})
Object.assign(observations, {
  goal: {
    ...setup,
    cardStep: 'goal',
    position: '2/5',
    record: v2Record('goal', null),
    primaryCount: 0,
    goalOptions: ['record', 'stream', 'both']
  },
  'record-look': { ...setup, cardStep: 'look', position: '3/4', record: v2Record('look') },
  look: {
    ...setup,
    cardStep: 'look',
    layout: 'camera-only',
    layoutClicked: 'camera-only',
    layoutOptions: ['camera-only', 'screen-only', 'screen-camera', 'side-by-side'].map(
      (preset) => ({ preset, disabled: false })
    ),
    background: 'silk',
    picture: 'moving',
    config,
    registry,
    committedLayout: 'camera-only',
    committedBackground: 'silk'
  },
  'look-motion': {
    durationMs: 30000,
    backdrop: 'moving',
    picture: 'moving',
    backdropDrawCount: 900,
    pictureDrawCount: 900,
    backdropDrawFps: 30,
    pictureDrawFps: 30,
    gpuCpuPercent: 8
  },
  sound: {
    cardStep: 'sound',
    soundMicrophoneRow: true,
    soundSystemAudioRow: true,
    soundMeter: true,
    soundBlocked: false,
    gainKeyPressed: true,
    gainBefore: 0,
    config
  },
  'workspace-look': {
    ...workspace,
    config,
    registry,
    record: v2Record('sound', 'record', 'done'),
    committedLayout: 'camera-only',
    committedBackground: 'silk',
    chosenLayout: 'camera-only',
    chosenBackground: 'silk',
    watchMs: 10000,
    toasts: [],
    refusedStarts: []
  },
  destinations: {
    cardStep: 'destinations',
    position: '5/5',
    destinationRows: ['youtube', 'twitch', 'kick', 'x'].map((platform) => ({
      platform,
      state: 'not-connected',
      signIn: true
    })),
    streamKeyAction: 'Open Livestream'
  },
  livestream: {
    ...workspace,
    record: v2Record('destinations', 'stream', 'done'),
    livestreamSetup: true
  },
  'skip-look': {
    ...workspace,
    record: v2Record('look', 'both', 'skipped'),
    configRaw: '{}',
    beforeConfigRaw: '{}',
    registryRaw: '{}',
    beforeRegistryRaw: '{}'
  },
  'no-device-starts': {
    backendReady: true,
    startMs: 1,
    endMs: 1000,
    closedObserved: true,
    patterns: FIRST_RUN_SOURCE_START_PATTERNS,
    matches: [],
    previewIdleAtOpen: true,
    previewIdleBeforeLeave: true
  },
  'theme-walk': {
    theme: 'light',
    expectedTheme: 'light',
    visitedSteps: ['permissions', 'goal', 'look', 'sound', 'destinations'],
    screenshots: ['1.png', '2.png', '3.png', '4.png', '5.png']
  }
})

for (const [step, observation] of Object.entries(observations)) {
  test(`${step}: accepts real evidence and refuses missing evidence`, () => {
    const result = evaluateFirstRunSmokeStep(step, observation)
    assert.equal(result.pass, true, JSON.stringify(result.failures))
    assert.deepEqual(result.failures, [])
    assert.equal(evaluateFirstRunSmokeStep(step).pass, false)
  })
}

for (const reason of [
  'no-gpu',
  'software-gpu',
  'shader-compile-failed',
  'context-lost',
  'gpu-budget',
  'hardware-acceleration-off'
]) {
  test(`GPU still fails with its reason: ${reason}`, () => {
    const result = evaluateFirstRunSmokeStep('moving', {
      ...observations.moving,
      backdrop: 'still',
      reason
    })
    assert.equal(result.pass, false)
    assert.ok(result.failures.some((message) => message.includes(reason)))
  })
}

for (const [step, change] of [
  ['fresh', { sidebar: true }],
  ['fresh', { primaryCount: 2 }],
  ['fresh', { rows: [] }],
  ['fresh', { workspaceBeforeSetup: true }],
  ['fresh', { record: record('done') }],
  ['moving', { mountToMovingMs: FIRST_RUN_SMOKE_LIMITS.movingWithinMs + 1 }],
  ['motion', { frameCount: 1 }],
  ['motion', { firstLastDiffer: false }],
  ['motion', { drawFps: 31.01 }],
  ['motion', { drawCount: 0 }],
  ['motion', { durationMs: 100 }],
  ['reduced-motion', { reason: 'no-gpu' }],
  ['finish', { retainedContextsLost: false }],
  ['finish', { pressedPrimary: 'Open Studio' }],
  ['reload', { setupEver: true }],
  ['existing-install', { setupEver: true }],
  ['replay-open', { recordRaw: 'changed' }],
  ['replay-return', { recordRaw: 'changed' }],
  ['replay-return', { settingsGeneral: false }],
  ['whats-new', { whatsNewOverSetup: true }],
  ['whats-new', { watchMs: 0 }]
]) {
  test(`${step}: rejects ${JSON.stringify(change)}`, () => {
    assert.equal(evaluateFirstRunSmokeStep(step, { ...observations[step], ...change }).pass, false)
  })
}

test('Open Studio writes done, with the same completion checks as Skip setup', () => {
  assert.equal(
    evaluateFirstRunSmokeStep('finish', {
      ...observations.finish,
      record: record('done'),
      pressedPrimary: 'Open Studio'
    }).pass,
    true
  )
})

test('unknown steps fail closed', () => {
  assert.equal(evaluateFirstRunSmokeStep('typo').pass, false)
})

for (const step of ['fresh', 'finish', 'reload', 'existing-install', 'resume']) {
  test(`${step}: accepts the v2 record alongside legacy v1 smoke seeds`, () => {
    const observation = observations[step]
    assert.equal(
      evaluateFirstRunSmokeStep(step, {
        ...observation,
        record: { ...observation.record, version: 2, goal: null }
      }).pass,
      true
    )
    assert.equal(
      evaluateFirstRunSmokeStep(step, {
        ...observation,
        record: { ...observation.record, version: 3 }
      }).pass,
      false
    )
  })
}

for (const [step, change] of [
  ['goal', { position: '2/4' }],
  ['goal', { primaryCount: 1 }],
  ['goal', { record: v2Record('permissions') }],
  ['record-look', { position: '3/5' }],
  ['record-look', { record: v2Record('look', 'stream') }],
  ['look', { layoutClicked: null }],
  ['look', { registry: { live: { activeId: null } } }],
  ['look', { config: { layout: { layoutPreset: 'screen-only' } } }],
  ['look', { committedLayout: 'screen-only' }],
  ['look', { committedBackground: null }],
  ['look', { picture: 'still', reason: 'shader-compile-failed' }],
  ['look-motion', { backdropDrawFps: 31.01 }],
  ['look-motion', { pictureDrawFps: 31.01 }],
  ['look-motion', { durationMs: 29999 }],
  ['look-motion', { gpuCpuPercent: null }],
  ['look-motion', { picture: 'still', reason: 'gpu-budget' }],
  ['sound', { soundMeter: false }],
  ['sound', { config: { audio: { microphoneGainDb: 0 } } }],
  ['sound', { soundBlocked: true, microphoneGrant: 'granted' }],
  ['workspace-look', { watchMs: 9999 }],
  ['workspace-look', { toasts: ["Clips couldn't start"] }],
  ['workspace-look', { refusedStarts: ['Session start refused'] }],
  ['workspace-look', { committedBackground: 'plasma' }],
  ['destinations', { destinationRows: [] }],
  ['destinations', { streamKeyAction: 'Continue' }],
  ['livestream', { livestreamSetup: false }],
  ['skip-look', { registryRaw: 'changed' }],
  ['skip-look', { record: v2Record('look', 'both', 'done') }],
  ['replay-return', { configRaw: 'changed' }],
  ['replay-return', { visitedSteps: ['permissions'] }],
  ['replay-return', { pressedPrimary: 'Open Studio' }],
  [
    'no-device-starts',
    { matches: ['[capture-generation] source=camera generation=1 reason=normal-start config=1234'] }
  ],
  ['no-device-starts', { patterns: [] }],
  ['no-device-starts', { closedObserved: false }],
  ['no-device-starts', { previewIdleAtOpen: false }],
  ['no-device-starts', { previewIdleBeforeLeave: false }],
  ['theme-walk', { theme: 'dark' }],
  ['theme-walk', { screenshots: ['1.png'] }]
]) {
  test(`${step}: rejects ${JSON.stringify(change)}`, () => {
    assert.equal(evaluateFirstRunSmokeStep(step, { ...observations[step], ...change }).pass, false)
  })
}

test('no-grant look records a skipped layout click, with actual disabled reasons required', () => {
  const observation = {
    ...observations.look,
    layoutClicked: null,
    layoutOptions: observations.look.layoutOptions.map((option) => ({
      ...option,
      disabled: true,
      reason: 'Allow the camera first.'
    }))
  }
  const result = evaluateFirstRunSmokeStep('look', observation)
  assert.equal(result.pass, true)
  assert.match(result.skipped[0], /layout click/)
  assert.equal(
    evaluateFirstRunSmokeStep('look', {
      ...observation,
      layoutOptions: observation.layoutOptions.map((option) => ({ ...option, reason: '' }))
    }).pass,
    false
  )
})

test('missing microphone grant explicitly skips Gain; granted meter cannot silently skip', () => {
  const result = evaluateFirstRunSmokeStep('sound', {
    ...observations.sound,
    soundBlocked: true,
    microphoneGrant: 'denied',
    gainKeyPressed: false
  })
  assert.equal(result.pass, true)
  assert.match(result.skipped[0], /microphone denied/)
  assert.equal(
    evaluateFirstRunSmokeStep('sound', { ...observations.sound, gainKeyPressed: false }).pass,
    false
  )
})

test('known no-GPU posters report skipped motion; unexpected stills fail', () => {
  const result = evaluateFirstRunSmokeStep('look-motion', {
    ...observations['look-motion'],
    backdrop: 'still',
    picture: 'still',
    reason: 'no-gpu',
    backdropDrawCount: 0,
    pictureDrawCount: 0,
    backdropDrawFps: 0,
    pictureDrawFps: 0
  })
  assert.equal(result.pass, true)
  assert.equal(result.skipped.length, 2)
})

test('a no-GPU host has no GPU process to sample; other stills still need the measurement', () => {
  const stills = {
    ...observations['look-motion'],
    backdrop: 'still',
    picture: 'still',
    backdropDrawCount: 0,
    pictureDrawCount: 0,
    backdropDrawFps: 0,
    pictureDrawFps: 0,
    gpuCpuPercent: null
  }
  const result = evaluateFirstRunSmokeStep('look-motion', { ...stills, reason: 'no-gpu' })
  assert.equal(result.pass, true)
  assert.match(result.skipped.at(-1), /GPU process CPU: no-gpu/)
  assert.equal(
    evaluateFirstRunSmokeStep('look-motion', { ...stills, reason: 'software-gpu' }).pass,
    false
  )
})

test('resume at Sound check preserves its config and saved step', () => {
  const observation = {
    ...setup,
    cardStep: 'sound',
    expectedStep: 'sound',
    record: v2Record('sound'),
    config,
    beforeConfig: config,
    registry,
    beforeBackground: 'silk'
  }
  assert.equal(evaluateFirstRunSmokeStep('resume', observation).pass, true)
  assert.equal(
    evaluateFirstRunSmokeStep('resume', {
      ...observation,
      config: { ...config, audio: { microphoneGainDb: 3 } }
    }).pass,
    false
  )
})

test('source log scan catches camera, screen, window admissions and reuse, not shutdown or idle commits', () => {
  const starts = ['camera', 'screen', 'window'].flatMap((source) =>
    ['normal-start', 'force-recovery', 'force-recovery-retry', 'reuse'].map(
      (reason) =>
        `[capture-generation] source=${source} generation=1 reason=${reason} config=0123456789abcdef`
    )
  )
  starts.push(
    'screen capture startup phase',
    '[videorc-capture-sizing] kind=Screen native=1920x1080'
  )
  assert.deepEqual(
    firstRunSourceStartLines([
      ...starts,
      '[capture-generation] source=camera generation=1 reason=stop stop_join_ms=2',
      'scene.load_from_capture_config',
      'Backend ready'
    ]),
    starts
  )
})

test('unavailable dev OAuth rows are evidence, rows with neither sign-in nor a reason fail', () => {
  const unavailable = observations.destinations.destinationRows.map((row) => ({
    ...row,
    signIn: false,
    unavailable: true
  }))
  assert.equal(
    evaluateFirstRunSmokeStep('destinations', {
      ...observations.destinations,
      destinationRows: unavailable
    }).pass,
    true
  )
  assert.equal(
    evaluateFirstRunSmokeStep('destinations', {
      ...observations.destinations,
      destinationRows: unavailable.map((row) => ({ ...row, unavailable: false }))
    }).pass,
    false
  )
})

test('replay can retain an existing source, but never admits a new source', () => {
  const observation = {
    ...observations['no-device-starts'],
    previewIdleAtOpen: false,
    previewIdleBeforeLeave: false,
    allowExistingSources: true,
    previewIdentityUnchanged: true
  }
  assert.equal(evaluateFirstRunSmokeStep('no-device-starts', observation).pass, true)
  assert.equal(
    evaluateFirstRunSmokeStep('no-device-starts', {
      ...observation,
      previewIdentityUnchanged: false
    }).pass,
    false
  )
  assert.equal(
    evaluateFirstRunSmokeStep('no-device-starts', {
      ...observation,
      matches: ['[capture-generation] source=camera generation=1 reason=normal-start config=1234']
    }).pass,
    false
  )
})
