import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { repoRoot } from './app-launcher.mjs'

const previewLaunchers = [
  {
    file: 'smoke-preview-motion-app.mjs',
    requiredHelpers: ['devAppSpawnSpec']
  },
  {
    file: 'smoke-preview-real-launch-app.mjs',
    requiredHelpers: ['devAppSpawnSpec']
  },
  {
    file: 'smoke-preview-surface-app.mjs',
    requiredHelpers: ['appSpawnSpec', 'devAppSpawnSpec']
  }
]

test('maintained preview smokes use the shared Windows-safe spawn policy', () => {
  for (const launcher of previewLaunchers) {
    const source = readFileSync(join(repoRoot, 'scripts', launcher.file), 'utf8')

    assert.doesNotMatch(
      source,
      /spawn\(\s*['"]pnpm['"]/,
      `${launcher.file} bypasses the shared Windows-safe pnpm spawn policy.`
    )
    for (const helper of launcher.requiredHelpers) {
      assert.match(
        source,
        new RegExp(`\\b${helper}\\(`),
        `${launcher.file} does not build its launch options with ${helper}.`
      )
    }
  }
})
