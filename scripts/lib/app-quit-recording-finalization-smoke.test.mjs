import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  appQuitRecordingSessionParams,
  isMp4FinalizationExport,
  readFinalizationRecoveryRecords
} from '../smoke-app-quit-recording-finalization.mjs'

test('recognizes only the private MKV-to-MP4 finalization export', () => {
  const exportArgs = [
    '-n',
    '-hide_banner',
    '-loglevel',
    'warning',
    '-i',
    '/tmp/recording.mkv',
    '-map',
    '0',
    '-c:v',
    'copy',
    '-c:a',
    'aac',
    '-b:a',
    '256k',
    '-movflags',
    '+faststart',
    '/tmp/.videorc-export-abc.partial/export.mp4'
  ]

  assert.equal(isMp4FinalizationExport(exportArgs), true)
  assert.equal(isMp4FinalizationExport(['-version']), false)
  assert.equal(
    isMp4FinalizationExport([...exportArgs.slice(0, -1), '/tmp/ordinary-user-selected-output.mp4']),
    false
  )
  assert.equal(
    isMp4FinalizationExport(
      exportArgs.map((argument) =>
        argument === '/tmp/recording.mkv' ? '/tmp/input.mp4' : argument
      )
    ),
    false
  )
  assert.equal(
    isMp4FinalizationExport(
      exportArgs.map((argument) => (argument === 'copy' ? 'libx264' : argument))
    ),
    false
  )
})

test('builds a synthetic recording with a one-shot output directory capability', () => {
  const params = appQuitRecordingSessionParams({
    outputDirectoryCapability: 'capability-1'
  })

  assert.equal(params.sources.testPattern, true)
  assert.equal(params.layout.layoutPreset, 'screen-only')
  assert.equal(params.output.recordEnabled, true)
  assert.equal(params.output.streamEnabled, false)
  assert.equal(params.output.outputDirectoryCapability, 'capability-1')
  assert.equal(Object.hasOwn(params.output, 'outputDirectory'), false)
  assert.equal(Object.hasOwn(params.output, 'ffmpegPath'), false)
  assert.deepEqual(params.output.video, {
    preset: 'custom',
    width: 640,
    height: 360,
    fps: 30,
    bitrateKbps: 2000
  })
})

test('reads only published JSON finalization recovery records', () => {
  const root = join(tmpdir(), `videorc-app-quit-recovery-contract-${process.pid}-${Date.now()}`)
  try {
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, '.pending.tmp'), '{}')
    writeFileSync(join(root, 'readme.txt'), 'not a recovery')
    writeFileSync(
      join(root, 'session-1.json'),
      JSON.stringify({ sessionId: 'session-1', status: 'completed' })
    )

    assert.deepEqual(readFinalizationRecoveryRecords(root), [
      {
        path: join(root, 'session-1.json'),
        value: { sessionId: 'session-1', status: 'completed' }
      }
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
