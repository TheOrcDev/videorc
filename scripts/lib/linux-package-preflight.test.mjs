import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, it } from 'node:test'

import { validateLinuxPackagePreflight } from './linux-package-preflight.mjs'

function withTempDir(callback) {
  const dir = mkdtempSync(join(tmpdir(), 'videorc-linux-preflight-'))
  try {
    return callback(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('validateLinuxPackagePreflight', () => {
  it('passes when every required input path exists and is executable', () => {
    withTempDir((dir) => {
      const backend = join(dir, 'videorc-backend')
      const ffmpeg = join(dir, 'ffmpeg')
      const ffprobe = join(dir, 'ffprobe')
      for (const file of [backend, ffmpeg, ffprobe]) {
        writeFileSync(file, '#!/bin/sh\necho ok')
        chmodSync(file, 0o755)
      }

      const failures = validateLinuxPackagePreflight({
        backendPath: backend,
        ffmpegPath: ffmpeg,
        ffprobePath: ffprobe
      })

      assert.equal(failures.length, 0)
    })
  })

  it('fails when backend binary is missing', () => {
    const failures = validateLinuxPackagePreflight({
      backendPath: join(tmpdir(), `no-backend-${Date.now()}`),
      ffmpegPath: join(tmpdir(), `ffmpeg-${Date.now()}`),
      ffprobePath: join(tmpdir(), `ffprobe-${Date.now()}`)
    })

    assert.equal(failures.length >= 3, true)
    assert.match(failures[0], /missing: backend binary/)
  })
})
