import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  appQuitRecordingSessionParams,
  barrierNeverEngagedError,
  finalizationBarrierSessionFfmpegPath,
  finalizationBarrierShimFiles,
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

test('recognizes the plan 200 export that copies AAC and adds chapters', () => {
  const copyAudioExport = [
    '-n',
    '-hide_banner',
    '-loglevel',
    'warning',
    '-i',
    '/tmp/recording.mkv',
    '-f',
    'ffmetadata',
    '-i',
    '/tmp/chapters.txt',
    '-map',
    '0',
    '-map_chapters',
    '1',
    '-c:v',
    'copy',
    '-c:a',
    'copy',
    '-movflags',
    '+faststart',
    '-metadata',
    'creation_time=2026-10-31T00:00:00Z',
    '/tmp/.videorc-export-abc.partial/export.mp4'
  ]

  assert.equal(isMp4FinalizationExport(copyAudioExport), true)
  assert.equal(
    isMp4FinalizationExport(
      copyAudioExport.map((argument, index) =>
        argument === 'copy' && copyAudioExport[index - 1] === '-c:a' ? 'opus' : argument
      )
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

test('the POSIX barrier shim stays one executable `ffmpeg` node script', () => {
  const shim = finalizationBarrierShimFiles({
    platform: 'darwin',
    moduleUrl: 'file:///repo/scripts/smoke-app-quit-recording-finalization.mjs'
  })
  assert.equal(shim.entry, 'ffmpeg')
  assert.equal(shim.files.length, 1)
  assert.equal(shim.files[0].name, 'ffmpeg')
  assert.match(shim.files[0].content, /^#!\/usr\/bin\/env node\n/)
  assert.match(
    shim.files[0].content,
    /import \{ runFfmpegFinalizationBarrierShim \} from "file:\/\/\/repo\/scripts\/smoke-app-quit-recording-finalization\.mjs"/
  )
  assert.equal(
    finalizationBarrierSessionFfmpegPath('/state/finalization-barrier-bin/ffmpeg', 'darwin'),
    undefined
  )
})

test('the Windows barrier shim is ffmpeg.cmd running a sibling module, named as the session FFmpeg (#1081)', () => {
  const shim = finalizationBarrierShimFiles({
    platform: 'win32',
    moduleUrl: 'file:///C:/repo/scripts/smoke-app-quit-recording-finalization.mjs',
    nodePath: 'C:\\Program Files\\nodejs\\node.exe'
  })
  assert.equal(shim.entry, 'ffmpeg.cmd')
  const files = Object.fromEntries(shim.files.map((file) => [file.name, file.content]))
  assert.deepEqual(Object.keys(files).sort(), ['ffmpeg.cmd', 'shim.mjs'])
  assert.equal(files['ffmpeg.cmd'], '@"C:\\Program Files\\nodejs\\node.exe" "%~dp0shim.mjs" %*\r\n')
  assert.doesNotMatch(files['shim.mjs'], /^#!/)
  assert.match(files['shim.mjs'], /runFfmpegFinalizationBarrierShim\(process\.argv\.slice\(2\)\)/)

  const shimPath = 'C:\\state\\finalization-barrier-bin\\ffmpeg.cmd'
  const ffmpegPath = finalizationBarrierSessionFfmpegPath(shimPath, 'win32')
  assert.equal(ffmpegPath, shimPath)
  const params = appQuitRecordingSessionParams({ outputDirectoryCapability: 'c', ffmpegPath })
  assert.equal(params.output.ffmpegPath, shimPath)
})

test('a process lost before the barrier engaged is reported as the barrier, not finalization', () => {
  const error = barrierNeverEngagedError(new Error('Original backend pid 7 exited.'), '/s/ffmpeg')
  assert.match(error.message, /never entered the barrier/)
  assert.match(error.message, /\/s\/ffmpeg/)
  assert.match(error.message, /Original backend pid 7 exited\./)
})
