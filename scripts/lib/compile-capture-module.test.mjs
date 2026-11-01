import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  compileCaptureModule,
  compileRendererModules,
  withRelativeAliases
} from './compile-capture-module.mjs'

test('capture smoke compilation includes runtime layout memory dependencies', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'videorc-capture-module-'))
  try {
    const path = await compileCaptureModule(directory)
    const capture = createRequire(import.meta.url)(path)
    const normalized = capture.normalizeLayoutSettings({
      layoutPreset: 'camera-only',
      cameraZoom: 140
    })
    assert.equal(normalized.layoutPreset, 'camera-only')
    assert.equal(normalized.cameraZoom, 140)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('renderer module compilation keeps relative imports resolvable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'videorc-renderer-modules-'))
  const view = 'apps/desktop/src/renderer/src/lib/studio-session-view.ts'
  try {
    const compiled = await compileRendererModules(directory, [
      view,
      'apps/desktop/src/renderer/src/lib/session-stop.ts',
      'apps/desktop/src/renderer/src/lib/status-word.ts',
      'apps/desktop/src/shared/capture-state.ts',
      'apps/desktop/src/shared/timecode.ts'
    ])
    const { sessionStopControl } = createRequire(import.meta.url)(compiled[view])
    assert.deepEqual(sessionStopControl({ state: 'recording' }, false), {
      label: 'Stop recording'
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('rewrites the renderer @/ alias relative to the compiled file', () => {
  // lib/platform, synced from the @videorc registry, imports through the alias.
  assert.equal(
    withRelativeAliases(
      'const accelerator_1 = require("@/lib/accelerator");',
      'apps/desktop/src/renderer/src/lib/platform.ts'
    ),
    'const accelerator_1 = require("./accelerator");'
  )
  assert.equal(
    withRelativeAliases(
      "const kbd_1 = require('@/components/ui/kbd');",
      'apps/desktop/src/shared/backend.ts'
    ),
    "const kbd_1 = require('../renderer/src/components/ui/kbd');"
  )
  assert.equal(
    withRelativeAliases('const x = "@/not-a-specifier"', 'a/b.ts'),
    'const x = "@/not-a-specifier"'
  )
})
