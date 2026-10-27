import assert from 'node:assert/strict'
import { test } from 'node:test'

import { evaluateFirstRunSmokeStep, FIRST_RUN_SMOKE_LIMITS } from './first-run-smoke-gate.mjs'

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
  tone: {
    setup: 'open',
    backdrop: 'moving',
    theme: 'light',
    tone: 'inverse',
    moreContrast: false,
    pictureFilter: 'invert(1)',
    posterFilter: 'none',
    toneFlipMs: 40
  },
  'reduced-motion': { backdrop: 'still', reason: 'reduced-motion', canvasCount: 0 },
  finish: {
    ...workspace,
    record: record('skipped'),
    pressedPrimary: 'Skip for now',
    retainedContextsLost: true
  },
  reload: { ...workspace, record: record('skipped'), recordRaw: raw, beforeRecordRaw: raw },
  'existing-install': { ...workspace, record: record('existing-install') },
  resume: setup,
  'replay-open': { ...setup, mode: 'replay', recordRaw: raw, beforeRecordRaw: raw },
  'replay-return': { ...workspace, settingsGeneral: true, recordRaw: raw, beforeRecordRaw: raw },
  'whats-new': { ...setup, seededWhatsNew: '0.0.1', watchMs: 1000 }
}

for (const [step, observation] of Object.entries(observations)) {
  test(`${step}: accepts real evidence and refuses missing evidence`, () => {
    assert.deepEqual(evaluateFirstRunSmokeStep(step, observation), { pass: true, failures: [] })
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
  ['tone', { tone: 'normal' }],
  ['tone', { theme: null }],
  ['tone', { setup: null }],
  ['tone', { pictureFilter: 'none' }],
  ['tone', { pictureFilter: 'invert(1) brightness(0.85)' }],
  ['tone', { posterFilter: 'brightness(0.7)' }],
  ['tone', { toneFlipMs: FIRST_RUN_SMOKE_LIMITS.toneFlipWithinMs + 1 }],
  ['tone', { toneFlipMs: null }],
  ['tone', { tonesSeen: ['normal', 'inverse'] }],
  ['tone', { tonesSeen: [] }],
  ['reduced-motion', { reason: 'no-gpu' }],
  ['finish', { retainedContextsLost: false }],
  ['finish', { pressedPrimary: 'Continue' }],
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

test('Continue writes done, with the same completion checks as Skip for now', () => {
  assert.equal(
    evaluateFirstRunSmokeStep('finish', {
      ...observations.finish,
      record: record('done'),
      pressedPrimary: 'Continue'
    }).pass,
    true
  )
})

test('tone: dark draws the chrome as it is, its poster dimmed like the shader', () => {
  const dark = {
    ...observations.tone,
    theme: 'dark',
    tone: 'normal',
    pictureFilter: 'none',
    posterFilter: 'brightness(0.7)'
  }
  assert.deepEqual(evaluateFirstRunSmokeStep('tone', dark), { pass: true, failures: [] })
  assert.equal(evaluateFirstRunSmokeStep('tone', { ...dark, tone: 'inverse' }).pass, false)
  assert.equal(
    evaluateFirstRunSmokeStep('tone', { ...dark, pictureFilter: 'invert(1)' }).pass,
    false
  )
  assert.equal(evaluateFirstRunSmokeStep('tone', { ...dark, posterFilter: 'none' }).pass, false)
})

test('tone: light under more contrast tones the chrome down after the invert', () => {
  const more = {
    ...observations.tone,
    moreContrast: true,
    pictureFilter: 'invert(1) brightness(0.85)'
  }
  assert.deepEqual(evaluateFirstRunSmokeStep('tone', more), { pass: true, failures: [] })
  assert.equal(
    evaluateFirstRunSmokeStep('tone', { ...more, pictureFilter: 'invert(1)' }).pass,
    false
  )
})

test('tone: a cold open shows only its own theme', () => {
  const cold = { ...observations.tone, tonesSeen: ['inverse'] }
  delete cold.toneFlipMs
  assert.equal(evaluateFirstRunSmokeStep('tone', cold).pass, true)
})

test('unknown steps fail closed', () => {
  assert.equal(evaluateFirstRunSmokeStep('typo').pass, false)
})
