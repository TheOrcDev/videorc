import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compileCaptureModule } from './compile-capture-module.mjs'

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
