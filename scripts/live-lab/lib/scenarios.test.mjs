import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { defineScenario, resolveScenario } from './step-engine.mjs'

// Plan 178 U6: every file in scripts/live-lab/scenarios/ must load and pass
// defineScenario (U9 and U13 add scenarios there; live:run loads them by name).

const dir = join(import.meta.dirname, '..', 'scenarios')

test('every scenario file loads through defineScenario and resolves with no params', async () => {
  const files = (await readdir(dir)).filter((name) => name.endsWith('.mjs')).sort()
  assert.ok(files.includes('dry.mjs'))
  for (const file of files) {
    const module = await import(pathToFileURL(join(dir, file)).href)
    const scenario = module.default
    assert.ok(scenario, `${file} has a default export`)
    assert.equal(`${scenario.name}.mjs`, file, `${file}: name matches the file`)
    // Re-validating a defined scenario must be a no-op (it is already frozen and valid).
    assert.doesNotThrow(() => defineScenario({ ...scenario, steps: [...scenario.steps] }), file)
    assert.doesNotThrow(() => resolveScenario(scenario, {}), file)
  }
})

test('dry streams only to the local sink and spends nothing', async () => {
  const { default: dry } = await import(pathToFileURL(join(dir, 'dry.mjs')).href)
  assert.equal(dry.destination, 'local-sink')
  assert.equal(dry.estimatedQuotaUnits, 0)
  assert.equal(dry.usesLabYoutubeClient, false)
  assert.deepEqual(
    dry.steps.map((step) => step.id),
    [
      'card-up',
      'open-go-live',
      'fill-details',
      'destinations',
      'go-live',
      'sink-receives',
      'scene-switch',
      'live-after-switch',
      'stop'
    ]
  )
})
