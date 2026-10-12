import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import {
  OUTPUT_PROFILES,
  chatArrivals,
  evaluateYoutubeHealth,
  liveHoldStep,
  matchCaption,
  needsEyes,
  recordFeature,
  runSubSteps,
  sceneSwitchStep
} from './scenario-steps.mjs'
import { createEventBus, createWaitFor } from './step-engine.mjs'
import { createFakeClock } from './harness-test-fakes.mjs'

const scenariosDir = join(import.meta.dirname, '..', 'scenarios')

test('output profiles name app presets and plan 166 bitrates', () => {
  assert.equal(OUTPUT_PROFILES['1080p30'].preset, 'tutorial-1080p30')
  assert.equal(OUTPUT_PROFILES['1080p30'].bitrateKbps, 6000)
  assert.equal(OUTPUT_PROFILES['4k30'].preset, 'stream-youtube-4k30')
  assert.equal(OUTPUT_PROFILES['4k30'].width, 3840)
  assert.equal(OUTPUT_PROFILES['4k30'].bitrateKbps, 30000)
})

test('chatArrivals matches by text, measures latency and ignores deleted copies', () => {
  const sent = [
    { kind: 'plain', text: '[lab r] hello', sentAt: '2026-10-12T06:00:00.000Z' },
    { kind: 'long', text: '[lab r] long', sentAt: '2026-10-12T06:00:30.000Z' }
  ]
  const events = [
    {
      kind: 'chat',
      id: 'a',
      text: '[lab r] hello',
      ts: '2026-10-12T06:00:02.500Z',
      isDeleted: false
    },
    {
      kind: 'chat',
      id: 'b',
      text: '[lab r] long',
      ts: '2026-10-12T06:00:40.000Z',
      isDeleted: true
    },
    { kind: 'chat', id: 'c', text: null, ts: '2026-10-12T06:00:41.000Z', isDeleted: false }
  ]
  assert.deepEqual(chatArrivals(sent, events), [
    { kind: 'plain', arrived: true, appMessageId: 'a', latencyMs: 2500 },
    { kind: 'long', arrived: false, appMessageId: null, latencyMs: null }
  ])
})

test('matchCaption wants a final caption after the phrase with enough shared words', () => {
  const since = Date.parse('2026-10-12T06:00:00.000Z')
  const captions = [
    {
      captionKind: 'partial',
      ts: '2026-10-12T06:00:01.000Z',
      text: 'the quick brown fox jumps over the lazy dog'
    },
    {
      captionKind: 'final',
      ts: '2026-10-12T05:59:59.000Z',
      text: 'the quick brown fox jumps over the lazy dog'
    },
    {
      captionKind: 'final',
      ts: '2026-10-12T06:00:03.000Z',
      text: 'the quick brown fox jumped over a lazy dog'
    }
  ]
  const match = matchCaption('The quick brown fox jumps over the lazy dog.', captions, since)
  assert.equal(match.latencyMs, 3000)
  assert.ok(match.overlap >= 0.6)
  assert.equal(matchCaption('Seven hundred and twenty frames', captions, since), null)
})

test('evaluateYoutubeHealth compares the stream reading with the profile', () => {
  const good = {
    stream: {
      streamStatus: 'active',
      healthStatus: 'good',
      resolution: '1080p',
      frameRate: '30fps'
    }
  }
  assert.deepEqual(evaluateYoutubeHealth(good, OUTPUT_PROFILES['1080p30']), {
    ok: true,
    problems: [],
    matches: { resolution: true, frameRate: true },
    healthStatus: 'good'
  })
  const variable = evaluateYoutubeHealth(
    {
      stream: {
        streamStatus: 'active',
        healthStatus: 'ok',
        resolution: 'variable',
        frameRate: 'variable'
      }
    },
    OUTPUT_PROFILES['720p30']
  )
  assert.equal(variable.ok, true)
  assert.deepEqual(variable.matches, { resolution: null, frameRate: null })
  const wrong = evaluateYoutubeHealth(good, OUTPUT_PROFILES['4k30'])
  assert.deepEqual(wrong.problems, ['resolution 1080p'])
  assert.deepEqual(
    evaluateYoutubeHealth({ stream: { streamStatus: 'inactive', healthStatus: 'noData' } })
      .problems,
    ['streamStatus inactive', 'healthStatus noData']
  )
  assert.deepEqual(evaluateYoutubeHealth(null).problems, ['no stream reading'])
})

function fakeCtx({ clock, bus, runDir, remoteState = {} }) {
  let state = { layoutPreset: 'screen-only', ...remoteState }
  const intents = []
  const journal = []
  return {
    runDir,
    clock,
    events: bus,
    log: () => {},
    params: {},
    intents,
    journal,
    remote: {
      state: () => state,
      async intent(kind, fields) {
        intents.push({ kind, ...fields })
        if (kind === 'sceneApply') {
          state = { ...state, layoutPreset: fields.layoutPreset }
          bus.emit('remote.state', state)
        }
        return { accepted: true, ok: true }
      }
    },
    observe: { latestJournal: () => journal.at(-1) ?? null },
    waitFor: createWaitFor({ bus, clock, defaultDeadlineMs: 60_000 }),
    pushJournal(line) {
      journal.push(line)
      bus.emit('journal', line)
    }
  }
}

test('sceneSwitchStep applies the preset and records a feature with the scene id', async () => {
  const runDir = await mkdtemp(join(tmpdir(), 'videorc-steps-'))
  try {
    const clock = createFakeClock()
    const bus = createEventBus()
    const ctx = fakeCtx({ clock, bus, runDir })
    const step = sceneSwitchStep({ id: 'scene-a', preset: 'screen-camera' })
    assert.equal(step.sceneId, 2)
    const evidence = await step.run(ctx)
    assert.equal(step.expect(evidence), true)
    assert.deepEqual(ctx.intents, [{ kind: 'sceneApply', layoutPreset: 'screen-camera' }])
    const lines = (await readFile(join(runDir, 'features.ndjson'), 'utf8'))
      .trim()
      .split('\n')
      .map(JSON.parse)
    assert.equal(lines.length, 1)
    assert.equal(lines[0].kind, 'scene')
    assert.equal(lines[0].sceneId, 2)
    assert.equal(lines[0].at, new Date(clock.now()).toISOString())
    await needsEyes(ctx, { id: 'q', question: 'ok?' })
    await recordFeature(ctx, { id: 'x', kind: 'mic', muted: true })
    const all = (await readFile(join(runDir, 'features.ndjson'), 'utf8')).trim().split('\n')
    assert.equal(all.length, 3)
  } finally {
    await rm(runDir, { recursive: true, force: true })
  }
})

test('liveHoldStep ends on the first sample past the hold and fails when the app leaves live', async () => {
  const runDir = await mkdtemp(join(tmpdir(), 'videorc-steps-'))
  try {
    const clock = createFakeClock()
    const bus = createEventBus()
    const ctx = fakeCtx({ clock, bus, runDir })
    const step = liveHoldStep({ id: 'hold', minutes: 1 })
    const start = clock.now()
    const running = step.run(ctx)
    ctx.pushJournal({ tsMs: start + 30_000, ts: 'a', state: 'live' })
    await clock.advance(1)
    ctx.pushJournal({ tsMs: start + 61_000, ts: 'b', state: 'live' })
    const evidence = await running
    assert.deepEqual(evidence, { minutes: 1, samples: 2, notLive: null })
    assert.equal(step.expect(evidence), true)

    const ctx2 = fakeCtx({ clock, bus, runDir })
    const run2 = step.run(ctx2)
    ctx2.pushJournal({ tsMs: clock.now() + 5000, ts: 'c', state: 'idle' })
    const bad = await run2
    assert.match(step.expect(bad), /left the live state \(idle\)/)
  } finally {
    await rm(runDir, { recursive: true, force: true })
  }
})

test('runSubSteps keeps values, records skips and throws on the first failed expectation', async () => {
  const results = await runSubSteps({}, [
    { id: 'a', run: async () => ({ ok: true, liveAfterMs: 1200 }), expect: (v) => v.ok },
    { id: 'b', run: async () => ({ skipped: true, reason: 'nope' }) }
  ])
  assert.deepEqual(results, [
    { id: 'a', status: 'pass', value: { ok: true, liveAfterMs: 1200 } },
    { id: 'b', status: 'skipped', reason: 'nope' }
  ])
  await assert.rejects(
    runSubSteps({}, [
      { id: 'c', run: async () => ({ ok: false }), expect: (v) => v.ok || 'refused' }
    ]),
    /c: refused/
  )
})

test('the U9 suites: metadata, quota estimates and step order', async () => {
  const load = async (name) =>
    (await import(pathToFileURL(join(scenariosDir, `${name}.mjs`)).href)).default
  const faults = await load('faults')
  assert.equal(faults.steps[0].id, 'card-up')
  assert.ok(faults.steps.some((step) => step.id === 'go-live'))
  assert.equal(faults.steps.at(-1).id, 'stop')
  assert.ok(
    faults.steps.findIndex((s) => s.id === 'network-loss-30s') >
      faults.steps.findIndex((s) => s.id === 'go-live')
  )

  const firstLight = await load('first-light')
  assert.equal(firstLight.destination, 'youtube')
  assert.equal(firstLight.plannedMinutes({ minutes: 10 }), 22)
  assert.ok(firstLight.estimatedQuotaUnits({ minutes: 10 }) > 0)
  assert.equal(firstLight.steps[0].id, 'output-profile')
  assert.equal(firstLight.steps.at(-1).id, 'vod')

  const idle = await load('idle')
  assert.equal(idle.destination, 'local-sink')
  assert.equal(idle.estimatedQuotaUnits, 0)

  const marathon = await load('marathon')
  assert.equal(marathon.plannedMinutes({ marathonHours: 4 }), 255)
  assert.equal(marathon.estimatedQuotaUnits({ marathonHours: 4 }), 510)

  const churn = await load('churn')
  assert.equal(churn.plannedMinutes({ cycles: 40 }), 110)
  assert.equal(churn.plannedMinutes({}), 110)

  const vertical = await load('vertical')
  assert.deepEqual([...vertical.orientations], ['horizontal', 'vertical'])

  for (const name of ['oauth-golive', 'scheduled']) {
    const scenario = await load(name)
    assert.equal(scenario.usesLabYoutubeClient, true, name)
  }
  const release = await load('release')
  assert.equal(release.usesBundledClient, false, 'the bundled client is its own U15 run')
  for (const name of ['chat', 'features', 'resilience', 'release', 'vertical']) {
    const scenario = await load(name)
    assert.equal(scenario.usesBundledClient, false)
    assert.ok(
      scenario.steps.some((step) => step.id === 'go-live'),
      `${name} goes live`
    )
  }
})
