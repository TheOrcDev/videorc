#!/usr/bin/env node
// No-device acceptance through the real Rust session coordinator. The test
// replaces capture producers only; encoders, muxers, Stop and export are real.
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { once } from 'node:events'
import { mkdirSync } from 'node:fs'
import { waitForOwnedTcpListener } from './lib/live-control-recycle-smoke.mjs'
import { summarizeRecordCycles, evaluateRecordLatencyBudget } from './lib/record-latency-gate.mjs'
import { evaluateRoleAudioSources, takeSiblingPaths } from './lib/separate-source-take-gates.mjs'
import {
  audioToneWindows,
  createRuntimeCaseCollector,
  combinedSourceMarkerFilter,
  maximumToneAmplitude,
  refinedToneTransitions,
  evaluateAudioTail,
  evaluateSourceEnvelope,
  evaluateAudioVideoEvents,
  evaluateEventAlignment,
  evaluateFrameMarkers,
  videoTransitionTimes
} from './lib/separate-source-runtime-gates.mjs'

if (process.platform !== 'darwin') {
  console.log('separate-source-runtime: SKIP (production separate-source capture requires macOS)')
  process.exit(0)
}
const root = resolve(import.meta.dirname, '..')
const directory = mkdtempSync(join(tmpdir(), 'videorc-separate-source-runtime-'))
const ffmpeg = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
const ffprobe = process.env.VIDEORC_SMOKE_FFPROBE_PATH ?? 'ffprobe'
const quick = process.env.VIDEORC_SOURCE_ISO_RUNTIME_QUICK === '1'
const controlsOnly = process.argv.includes('--controls-only')
const crashOnly = process.argv.includes('--crash-only')
const lifecycleOnly = process.argv.includes('--lifecycle-only')
const lifecycleCase = process.env.VIDEORC_SOURCE_ISO_RUNTIME_CASE
if (lifecycleOnly && (quick || crashOnly || controlsOnly))
  throw new Error('--lifecycle-only cannot be combined with another partial runtime mode')
if (lifecycleCase && !lifecycleOnly)
  throw new Error('A runtime case filter requires --lifecycle-only')
const quickOffset = Number(process.env.VIDEORC_SOURCE_ISO_RUNTIME_OFFSET ?? 0)
if (quick && (!Number.isInteger(quickOffset) || Math.abs(quickOffset) > 1000))
  throw new Error('Quick runtime offset must be an integer between -1000 and 1000ms')
const quickWidth = Number(process.env.VIDEORC_SOURCE_ISO_RUNTIME_WIDTH ?? 1920)
const quickFps = Number(process.env.VIDEORC_SOURCE_ISO_RUNTIME_FPS ?? 30)
const quickVariant = process.env.VIDEORC_SOURCE_ISO_RUNTIME_VARIANT ?? 'normal'
if (
  quick &&
  (![1920, 3840].includes(quickWidth) ||
    ![30, 60].includes(quickFps) ||
    !['normal', 'shared-stream'].includes(quickVariant))
)
  throw new Error(
    'Quick runtime requires 1920/3840 width, 30/60fps and normal/shared-stream variant'
  )
const skip4K = process.env.VIDEORC_SOURCE_ISO_RUNTIME_SKIP_4K === '1'
const allProfiles = quick
  ? [[quickWidth, quickFps, quickOffset, quickVariant]]
  : [
      [1920, 30, 0],
      ...['no-microphone', 'muted', 'system-off', 'gains', 'stereo'].map((name) => [
        1920,
        30,
        0,
        name,
        { VIDEORC_SOURCE_ISO_RUNTIME_AUDIO: name }
      ]),
      [
        1920,
        30,
        0,
        'silent',
        {
          VIDEORC_SOURCE_ISO_RUNTIME_AUDIO: 'system-off',
          VIDEORC_SOURCE_ISO_RUNTIME_CANCEL: 'writers'
        }
      ],
      [1920, 30, -120],
      [1920, 30, -120, 'active-stop', { VIDEORC_SOURCE_ISO_RUNTIME_DURATION_MS: '3500' }],
      [1920, 30, 120],
      [1920, 30, -1000],
      [1920, 30, 1000],
      [1920, 30, 0, 'native-latency', { VIDEORC_SOURCE_ISO_RUNTIME_CAPTURE_LATENCY_MS: '72' }],
      [1920, 60, 0],
      [1920, 60, -1000],
      [1920, 60, 1000],
      [3840, 30, 0],
      [1920, 30, 0, 'dual-stream'],
      [1920, 30, -1000, 'shared-stream'],
      ...['combined', 'screen'].map((role) => [
        1920,
        30,
        0,
        `prep-delay-${role}`,
        {
          VIDEORC_SOURCE_ISO_RUNTIME_PREP_DELAY_MS: '300',
          VIDEORC_SOURCE_ISO_RUNTIME_PREP_DELAY_ROLE: role
        }
      ]),
      [1920, 30, 0, 'prep-delay', { VIDEORC_SOURCE_ISO_RUNTIME_PREP_DELAY_MS: '300' }],
      [1920, 30, 0, 'reader-delay', { VIDEORC_SOURCE_ISO_RUNTIME_READER_DELAY_MS: '300' }],
      ...['combined', 'screen', 'camera'].map((role) => [
        1920,
        60,
        0,
        `prep-delay-${role}`,
        {
          VIDEORC_SOURCE_ISO_RUNTIME_PREP_DELAY_MS: '300',
          VIDEORC_SOURCE_ISO_RUNTIME_PREP_DELAY_ROLE: role
        }
      ]),
      [1920, 60, 0, 'reader-delay', { VIDEORC_SOURCE_ISO_RUNTIME_READER_DELAY_MS: '300' }],
      [1920, 60, 0, 'native-latency', { VIDEORC_SOURCE_ISO_RUNTIME_CAPTURE_LATENCY_MS: '72' }],
      ...[30, 60].map((fps) => [
        1920,
        fps,
        0,
        'native-latency-active-stop',
        {
          VIDEORC_SOURCE_ISO_RUNTIME_CAPTURE_LATENCY_MS: '72',
          VIDEORC_SOURCE_ISO_RUNTIME_DURATION_MS: '3500'
        }
      ])
    ]
const profiles = allProfiles.filter(([width]) => !skip4K || width < 3840)
if (profiles.length === 0) throw new Error('Runtime selection omitted every requested profile')
const coverage = {
  partial: quick || skip4K || controlsOnly || crashOnly || lifecycleOnly,
  lifecycleOnly,
  lifecycleCase: lifecycleCase ?? null,
  crashOnly,
  quick,
  controlsOnly,
  omittedProfiles: skip4K ? ['3840x2160-30-0-normal'] : []
}
writeFileSync(join(directory, 'coverage.json'), JSON.stringify(coverage, null, 2))
if (skip4K)
  console.log('PARTIAL runtime: 4K explicitly omitted; full matrix acceptance remains pending')
console.log(`Production separate-source evidence: ${directory}`)
if (quick)
  console.log(
    `PARTIAL quick runtime: ${quickWidth}x${(quickWidth * 9) / 16}@${quickFps} ${quickVariant}, offset ${quickOffset}ms; full matrix not run`
  )
const results = []
const latency = []
const cases = createRuntimeCaseCollector({
  collectFailures: process.env.VIDEORC_SOURCE_ISO_RUNTIME_COLLECT_FAILURES === '1',
  onFailure(failure, failures) {
    mkdirSync(failure.evidence, { recursive: true })
    writeFileSync(join(failure.evidence, 'case-failure.json'), JSON.stringify(failure, null, 2))
    writeFileSync(join(directory, 'failures.json'), JSON.stringify(failures, null, 2))
    console.error(`separate-source-runtime case FAILED: ${failure.name}: ${failure.message}`)
  }
})
await verifyPcmShortestPacketBoundary()
await verifyCircularMarkerSampling()
await verifyRefinedAacEdges()
if (controlsOnly) {
  console.log(
    'separate-source-runtime: PARTIAL PASS (encoded measurement controls only; runtime matrix not run)'
  )
  process.exit(0)
}
const suppliedExecutable = process.env.VIDEORC_SOURCE_ISO_RUNTIME_EXECUTABLE
const build = suppliedExecutable
  ? null
  : await run(
      'cargo',
      [
        'test',
        '-p',
        'videorc-backend',
        '--bin',
        'videorc-backend',
        '--no-run',
        '--message-format=json'
      ],
      process.env,
      true
    )
const executable =
  suppliedExecutable ??
  build
    .toString()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .findLast(
      (message) =>
        message.reason === 'compiler-artifact' && message.profile?.test && message.executable
    )?.executable
if (!executable) throw new Error('Cargo did not report the owned runtime test executable')
if (crashOnly) {
  await cases.run('process-interruption', join(directory, 'process-interruption'), () =>
    verifyCrashRecovery(join(directory, 'process-interruption'))
  )
  console.log(
    `separate-source-runtime: ${cases.failures.length ? 'FAIL' : 'PARTIAL PASS'} (owned crash/restart only; runtime matrix not run)`
  )
  process.exit(cases.failures.length ? 1 : 3)
}
for (const [width, fps, offset, variant = 'normal', overrides = {}] of lifecycleOnly
  ? []
  : profiles) {
  const evidence = join(directory, `${width}x${(width * 9) / 16}-${fps}-${offset}-${variant}`)
  await cases.run(
    `${width}x${(width * 9) / 16}-${fps}-${offset}-${variant}`,
    evidence,
    async () => {
      const receivers = ['dual-stream', 'shared-stream'].includes(variant)
        ? await startReceivers(evidence, variant === 'shared-stream' ? 1 : 2)
        : null
      try {
        await run(
          executable,
          ['recording::tests::source_iso_runtime_artifacts', '--ignored', '--exact', '--nocapture'],
          {
            ...process.env,
            VIDEORC_SOURCE_ISO_RUNTIME_DIR: evidence,
            VIDEORC_SOURCE_ISO_RUNTIME_WIDTH: String(width),
            VIDEORC_SOURCE_ISO_RUNTIME_FPS: String(fps),
            VIDEORC_SOURCE_ISO_RUNTIME_OFFSET: String(offset),
            ...overrides,
            ...(variant === 'shared-stream'
              ? { VIDEORC_TEST_FORCE_SHARED_ENCODER_OUTPUT: '1', VIDEORC_ENABLE_SMOKE_RPC: '1' }
              : {}),
            ...(receivers ? { VIDEORC_SOURCE_ISO_RUNTIME_STREAM_PORT: String(receivers.port) } : {})
          }
        )
      } finally {
        if (receivers) await stopReceivers(receivers)
      }
      const manifest = JSON.parse(readFileSync(join(evidence, 'runtime-take.json'), 'utf8'))
      // Sampled from the capture epoch immediately before the real Stop request.
      // A held final CFR frame can extend beyond this source-clock boundary.
      if (variant === 'shared-stream' && manifest.sharedStream !== true)
        throw new Error('Shared-stream case did not select the shared encoder topology')
      const stopBoundarySeconds = manifest.stopBoundarySeconds
      if (!Number.isFinite(stopBoundarySeconds) || stopBoundarySeconds <= 0)
        throw new Error('Runtime manifest is missing its source-clock Stop-request boundary')
      const controlContract = {
        'no-microphone': manifest.microphoneSelected === false,
        muted: manifest.audio.microphoneMuted === true,
        'system-off': manifest.systemAudio === false,
        silent: manifest.microphoneSelected === false && manifest.systemAudio === false,
        gains: manifest.audio.microphoneGainDb === -6 && manifest.audio.systemAudioGainDb === 3,
        stereo: manifest.stereoRightGain === 0.5
      }
      if (variant in controlContract && !controlContract[variant])
        throw new Error(`Runtime did not apply requested ${variant} controls`)
      if (manifest.latency && variant === 'normal') latency.push(manifest.latency)
      if (receivers) await verifyStreams(receivers)
      for (const extension of ['mkv', 'mp4']) {
        const combined = manifest.combinedPath.replace(/\.mkv$/, `.${extension}`)
        await run(process.execPath, [
          'scripts/smoke-separate-source-take.mjs',
          combined,
          '--no-motion'
        ])
        const paths = takeSiblingPaths(combined)
        const events = {}
        const audioEvents = {}
        const audioEdgeDiagnostics = {}
        const markers = {}
        const tones = {}
        const levels = {}
        for (const [role, file] of Object.entries(paths)) {
          const pixels = await run(
            ffmpeg,
            [
              '-v',
              'error',
              '-i',
              file,
              '-map',
              '0:v:0',
              '-vf',
              'scale=1:1',
              '-pix_fmt',
              'rgb24',
              '-fps_mode',
              'passthrough',
              '-f',
              'rawvideo',
              'pipe:1'
            ],
            process.env,
            true
          )
          const markerPixels =
            role === 'combined'
              ? await run(
                  ffmpeg,
                  [
                    '-v',
                    'error',
                    '-i',
                    file,
                    '-map',
                    '0:v:0',
                    '-vf',
                    combinedSourceMarkerFilter(manifest.layout),
                    '-pix_fmt',
                    'rgb24',
                    '-fps_mode',
                    'passthrough',
                    '-f',
                    'rawvideo',
                    'pipe:1'
                  ],
                  process.env,
                  true
                )
              : pixels
          if (markerPixels.length !== pixels.length)
            throw new Error(`${role} marker ROI has a different decoded frame count`)
          const probe = JSON.parse(
            await run(
              ffprobe,
              [
                '-v',
                'error',
                '-select_streams',
                'v:0',
                '-show_frames',
                '-show_entries',
                'frame=best_effort_timestamp_time',
                '-of',
                'json',
                file
              ],
              process.env,
              true
            )
          )
          const timestamps = probe.frames.map((frame) => Number(frame.best_effort_timestamp_time))
          markers[role] = timestamps.map((time, index) => ({
            time,
            value: markerPixels[index * 3 + 2],
            hot: pixels[index * 3 + (role === 'camera' ? 0 : 1)] > 180
          }))
          events[role] = videoTransitionTimes(pixels, {
            timestamps,
            channel: role === 'camera' ? 0 : 1
          })
          const audioProbe = JSON.parse(
            await run(
              ffprobe,
              [
                '-v',
                'error',
                '-select_streams',
                'a:0',
                '-show_entries',
                'stream=start_time',
                '-of',
                'json',
                file
              ],
              process.env,
              true
            )
          )
          const pcmBytes = await run(
            ffmpeg,
            [
              '-v',
              'error',
              '-i',
              file,
              '-map',
              '0:a:0',
              '-ac',
              '2',
              '-ar',
              '48000',
              '-f',
              'f32le',
              'pipe:1'
            ],
            process.env,
            true
          )
          const stereoPcm = new Float32Array(
            pcmBytes.buffer.slice(pcmBytes.byteOffset, pcmBytes.byteOffset + pcmBytes.byteLength)
          )
          const left = stereoPcm.filter((_, index) => index % 2 === 0)
          const right = stereoPcm.filter((_, index) => index % 2 === 1)
          const pcm = left.map((value, index) => (value + right[index]) / 2)
          for (const frequency of [997, 317]) {
            const leftLevel = maximumToneAmplitude(left, frequency)
            const rightLevel = maximumToneAmplitude(right, frequency)
            if (
              leftLevel > 0.02 &&
              Math.abs(
                rightLevel / leftLevel - (frequency === 997 ? 1 : (manifest.stereoRightGain ?? 1))
              ) > 0.1
            ) {
              throw new Error(
                `${role} does not preserve centered microphone / stereo system policy at ${frequency} Hz`
              )
            }
          }
          tones[role] = Object.fromEntries(
            [
              ['microphone', 997],
              ['system', 317]
            ].map(([source, frequency]) => [
              source,
              audioToneWindows(pcm, {
                frequency,
                startTime: Number(audioProbe.streams[0].start_time) || 0
              })
            ])
          )
          audioEvents[role] = {}
          audioEdgeDiagnostics[role] = {}
          for (const [source, frequency] of [
            ['microphone', 997],
            ['system', 317]
          ]) {
            const expectedActive =
              source === 'microphone'
                ? role !== 'screen' &&
                  manifest.microphoneSelected !== false &&
                  !manifest.audio.microphoneMuted
                : role !== 'camera' && manifest.systemAudio === true
            if (!expectedActive) {
              audioEvents[role][source] = []
              continue
            }
            const refined = refinedToneTransitions(pcm, {
              frequency,
              startTime: Number(audioProbe.streams[0].start_time) || 0
            })
            audioEdgeDiagnostics[role][source] = refined
            audioEvents[role][source] = refined.events
          }
          levels[role] = {
            microphone: maximumToneAmplitude(pcm, 997),
            system: maximumToneAmplitude(pcm, 317)
          }
        }
        writeFileSync(
          join(evidence, `decoded-events-${extension}.json`),
          JSON.stringify(
            { events, audioEvents, audioEdgeDiagnostics, markers, levels, tones },
            null,
            2
          )
        )
        const frameVerdict = evaluateFrameMarkers(markers, fps)
        if (!frameVerdict.pass) throw new Error(`${extension}: ${frameVerdict.failures.join('; ')}`)
        const verdict = evaluateEventAlignment(events, fps)
        if (!verdict.pass) throw new Error(`${extension}: ${verdict.failures.join('; ')}`)
        const monoGain = (1 + (manifest.stereoRightGain ?? 1)) / 2
        const expectedLevels = {
          microphone:
            manifest.microphoneSelected === false || manifest.audio.microphoneMuted
              ? 0
              : monoGain * 0.25 * 10 ** (manifest.audio.microphoneGainDb / 20),
          system:
            manifest.systemAudio === false
              ? 0
              : monoGain * 0.2 * 10 ** (manifest.audio.systemAudioGainDb / 20)
        }
        if (manifest.runtimeDurationMs === 3500 && expectedLevels.system > 0) {
          for (const role of ['combined', 'screen']) {
            const endWindow = tones[role].system.findLast(
              (window) => window.time <= stopBoundarySeconds - 0.03
            )
            if (
              !endWindow ||
              endWindow.time < stopBoundarySeconds - 0.05 ||
              endWindow.amplitude < 0.04
            )
              throw new Error(
                `${role}: active-stop fixture must retain audible system tone through Stop`
              )
          }
        }
        const routing = evaluateRoleAudioSources(levels, expectedLevels)
        if (!routing.pass) throw new Error(routing.failures.join('; '))
        for (const [role, source, offsetMs] of [
          ['combined', 'microphone', offset],
          ['camera', 'microphone', offset],
          ['combined', 'system', 0],
          ['screen', 'system', 0]
        ]) {
          if (!expectedLevels[source]) continue
          const av = evaluateAudioVideoEvents(events[role], audioEvents[role][source], {
            fps,
            offsetMs,
            endSeconds: stopBoundarySeconds + Math.min(0, offsetMs / 1000),
            measurement: audioEdgeDiagnostics[role][source]
          })
          if (!av.pass) throw new Error(`${extension} ${role}/${source}: ${av.failures.join('; ')}`)
          const envelope = evaluateSourceEnvelope(markers[role], tones[role][source], {
            fps,
            offsetMs,
            endSeconds: stopBoundarySeconds
          })
          if (!envelope.pass)
            throw new Error(`${extension} ${role}/${source}: ${envelope.failures.join('; ')}`)
        }
        for (const [role, source] of [
          ['camera', 'microphone'],
          ['screen', 'system']
        ]) {
          const tail = evaluateAudioTail(tones.combined[source], tones[role][source], fps)
          if (!tail.pass) throw new Error(`${extension} ${role}: ${tail.failures.join('; ')}`)
        }
        const shiftedPath = join(evidence, `deliberately-shifted-camera.${extension}`)
        await run(ffmpeg, [
          '-v',
          'error',
          '-y',
          '-copyts',
          '-itsoffset',
          '0.2',
          '-i',
          paths.camera,
          '-map',
          '0:v:0',
          '-c',
          'copy',
          '-avoid_negative_ts',
          'disabled',
          shiftedPath
        ])
        const shiftedProbe = JSON.parse(
          await run(
            ffprobe,
            [
              '-v',
              'error',
              '-select_streams',
              'v:0',
              '-show_frames',
              '-show_entries',
              'frame=best_effort_timestamp_time',
              '-of',
              'json',
              shiftedPath
            ],
            process.env,
            true
          )
        )
        const shiftedPixels = await run(
          ffmpeg,
          [
            '-v',
            'error',
            '-i',
            shiftedPath,
            '-map',
            '0:v:0',
            '-vf',
            'scale=1:1',
            '-pix_fmt',
            'rgb24',
            '-fps_mode',
            'passthrough',
            '-f',
            'rawvideo',
            'pipe:1'
          ],
          process.env,
          true
        )
        const shiftedEvents = videoTransitionTimes(shiftedPixels, {
          channel: 0,
          timestamps: shiftedProbe.frames.map((frame) => Number(frame.best_effort_timestamp_time))
        })
        if (evaluateEventAlignment({ ...events, camera: shiftedEvents }, fps).pass) {
          throw new Error('Encoded artifact timing negative control was not rejected')
        }
        const swappedPath = join(evidence, `deliberately-swapped-camera.${extension}`)
        await run(ffmpeg, [
          '-v',
          'error',
          '-y',
          '-i',
          paths.camera,
          '-i',
          paths.screen,
          '-map',
          '0:v:0',
          '-map',
          '1:a:0',
          '-c',
          'copy',
          '-metadata:s:a:0',
          'title=Microphone',
          '-metadata:s:a:0',
          'handler_name=Microphone',
          swappedPath
        ])
        const swappedBytes = await run(
          ffmpeg,
          [
            '-v',
            'error',
            '-i',
            swappedPath,
            '-map',
            '0:a:0',
            '-ac',
            '1',
            '-ar',
            '48000',
            '-f',
            'f32le',
            'pipe:1'
          ],
          process.env,
          true
        )
        const swappedPcm = new Float32Array(
          swappedBytes.buffer.slice(
            swappedBytes.byteOffset,
            swappedBytes.byteOffset + swappedBytes.byteLength
          )
        )
        const wrongLevels = {
          ...levels,
          camera: {
            microphone: maximumToneAmplitude(swappedPcm, 997),
            system: maximumToneAmplitude(swappedPcm, 317)
          }
        }
        if (
          expectedLevels.microphone > 0 &&
          expectedLevels.system > 0 &&
          evaluateRoleAudioSources(wrongLevels, {
            microphone: levels.camera.microphone,
            system: levels.screen.system
          }).pass
        ) {
          throw new Error('Encoded swapped-audio artifact was not rejected')
        }
        results.push({ profile: { width, fps, offset }, extension, events, audioEvents, verdict })
      }
    }
  )
}
if (process.env.VIDEORC_SOURCE_ISO_RUNTIME_QUICK !== '1') {
  let matched = false
  for (const [name, overrides] of [
    ['live-audio-controls', { VIDEORC_SOURCE_ISO_RUNTIME_AUDIO: 'live-controls' }],
    ['cancel-writers', { VIDEORC_SOURCE_ISO_RUNTIME_CANCEL: 'writers' }],
    ['cancel-precommit', { VIDEORC_SOURCE_ISO_RUNTIME_CANCEL: 'precommit' }],
    ['precommit-iso-failure', { VIDEORC_SOURCE_ISO_RUNTIME_START_FAILURE: '1' }],
    ['bridge-failure', { VIDEORC_SOURCE_ISO_RUNTIME_FAILURE: 'bridge' }],
    ['capture-recovery', { VIDEORC_SOURCE_ISO_RUNTIME_FAILURE: 'capture-recovery' }],
    ['early-eof', { VIDEORC_SOURCE_ISO_RUNTIME_FAILURE: 'early-eof' }],
    ['camera-off', { VIDEORC_SOURCE_ISO_RUNTIME_REMOVE: 'camera' }],
    [
      'remove-stop-race',
      {
        VIDEORC_SOURCE_ISO_RUNTIME_REMOVE: 'camera',
        VIDEORC_SOURCE_ISO_RUNTIME_STOP_AFTER_REMOVE: '1'
      }
    ],
    ['dual-stream-camera-off', { VIDEORC_SOURCE_ISO_RUNTIME_REMOVE: 'camera' }],
    ['screen-off', { VIDEORC_SOURCE_ISO_RUNTIME_REMOVE: 'screen' }],
    [
      'camera-readd',
      { VIDEORC_SOURCE_ISO_RUNTIME_REMOVE: 'camera', VIDEORC_SOURCE_ISO_RUNTIME_READD: '1' }
    ],
    [
      'screen-readd',
      { VIDEORC_SOURCE_ISO_RUNTIME_REMOVE: 'screen', VIDEORC_SOURCE_ISO_RUNTIME_READD: '1' }
    ],
    [
      'window-off',
      { VIDEORC_SOURCE_ISO_RUNTIME_REMOVE: 'screen', VIDEORC_SOURCE_ISO_RUNTIME_WINDOW: '1' }
    ],
    ['hidden-screen', { VIDEORC_SOURCE_ISO_RUNTIME_HIDE: 'screen' }],
    ['hidden-camera', { VIDEORC_SOURCE_ISO_RUNTIME_HIDE: 'camera' }],
    ['idle-hidden-screen', { VIDEORC_SOURCE_ISO_RUNTIME_START_HIDDEN: 'screen' }],
    ['idle-hidden-camera', { VIDEORC_SOURCE_ISO_RUNTIME_START_HIDDEN: 'camera' }],
    [
      'screen-off-negative-limit',
      { VIDEORC_SOURCE_ISO_RUNTIME_REMOVE: 'screen', VIDEORC_SOURCE_ISO_RUNTIME_OFFSET: '-1000' }
    ]
  ]) {
    if (lifecycleCase && name !== lifecycleCase) continue
    matched = true
    const evidence = join(directory, name)
    await cases.run(name, evidence, async () => {
      const receivers = name.startsWith('dual-stream-') ? await startReceivers(evidence) : null
      try {
        await run(
          executable,
          ['recording::tests::source_iso_runtime_artifacts', '--ignored', '--exact', '--nocapture'],
          {
            ...process.env,
            VIDEORC_SOURCE_ISO_RUNTIME_DIR: evidence,
            ...overrides,
            ...(receivers ? { VIDEORC_SOURCE_ISO_RUNTIME_STREAM_PORT: String(receivers.port) } : {})
          }
        )
      } finally {
        if (receivers) await stopReceivers(receivers)
      }
      if (receivers) await verifyStreams(receivers, true)
      const manifest = JSON.parse(readFileSync(join(evidence, 'runtime-take.json'), 'utf8'))
      if (manifest.latency && name.startsWith('cancel-')) latency.push(manifest.latency)
      for (const extension of ['mkv', 'mp4']) {
        const combined = manifest.combinedPath.replace(/\.mkv$/, `.${extension}`)
        const args = [
          'scripts/smoke-separate-source-take.mjs',
          combined,
          '--no-motion',
          '--expectations',
          join(evidence, 'runtime-take.json')
        ]
        if (manifest.failureCase) {
          let rejected
          try {
            await run(process.execPath, args, process.env, true)
          } catch (error) {
            if (error?.name === 'AbortError') throw error
            rejected = error.message
          }
          if (
            !rejected ||
            !/camera/i.test(rejected) ||
            !/missing|no such|not.*exist|duration|short|spread|failed|cannot|could not/i.test(
              rejected
            )
          ) {
            throw new Error(
              `Failed-role whole-take negative control did not reject Camera: ${rejected ?? 'unexpected pass'}`
            )
          }
          writeFileSync(
            join(evidence, `failed-role-verdict-${extension}.json`),
            JSON.stringify({ pass: false, expected: true, reason: rejected }, null, 2)
          )
          args.push('--roles', 'combined,screen')
        }
        await run(process.execPath, args)
        const progress = {}
        for (const [role, file] of Object.entries(takeSiblingPaths(combined))) {
          if (manifest.intervals?.[role] || (manifest.failureCase && role === 'camera')) continue
          progress[role] = await verifyMovingVideo(
            file,
            name === 'remove-stop-race' ? 0.3 : 2.3,
            name === 'remove-stop-race' ? 1.5 : 3.5
          )
        }
        writeFileSync(
          join(evidence, `survivor-progress-${extension}.json`),
          JSON.stringify(progress, null, 2)
        )
        for (const [role, interval] of Object.entries(manifest.intervals ?? {})) {
          const verdict = await verifyRoleAudioBoundary(
            takeSiblingPaths(combined)[role],
            role,
            role === 'camera' ? manifest.offsetMs : 0,
            interval.endSeconds,
            manifest.video.fps
          )
          writeFileSync(
            join(evidence, `${role}-removal-audio-${extension}.json`),
            JSON.stringify(verdict, null, 2)
          )
        }
        for (const interval of manifest.controlIntervals ?? []) {
          const levels = {}
          for (const [role, file] of Object.entries(takeSiblingPaths(combined))) {
            const bytes = await run(
              ffmpeg,
              [
                '-v',
                'error',
                '-ss',
                String(interval.start),
                '-t',
                String(interval.duration),
                '-i',
                file,
                '-map',
                '0:a:0',
                '-af',
                'pan=mono|c0=0.5*c0+0.5*c1',
                '-ar',
                '48000',
                '-f',
                'f32le',
                'pipe:1'
              ],
              process.env,
              true
            )
            const pcm = new Float32Array(
              bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
            )
            if (pcm.length < 10000) throw new Error('Live control verification window is missing')
            levels[role] = {
              microphone: maximumToneAmplitude(pcm, 997),
              system: maximumToneAmplitude(pcm, 317)
            }
          }
          const verdict = evaluateRoleAudioSources(levels, interval)
          if (!verdict.pass) throw new Error(`Live controls: ${verdict.failures.join('; ')}`)
        }
      }
      if (manifest.failureCase) {
        const partials = readdirSync(evidence, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && entry.name.startsWith('.videorc-iso-'))
          .flatMap((entry) =>
            readdirSync(join(evidence, entry.name))
              .filter((name) => name.endsWith('-camera.mkv'))
              .map((name) => join(evidence, entry.name, name))
          )
        if (partials.length !== 1)
          throw new Error('Failed Camera must retain one owned partial artifact')
        let probe
        try {
          probe = JSON.parse(
            await run(
              ffprobe,
              ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', partials[0]],
              process.env,
              true
            )
          )
        } catch (error) {
          if (error?.name === 'AbortError') throw error
          probe = { unreadablePartial: error.message }
        }
        writeFileSync(
          join(evidence, 'failed-camera-partial.json'),
          JSON.stringify({ path: partials[0], state: 'failed', probe }, null, 2)
        )
      }
      results.push({
        scenario: name,
        orchestration: manifest.orchestration,
        intervals: manifest.intervals
      })
    })
  }
  if (!matched) throw new Error(`Unknown lifecycle case: ${lifecycleCase}`)
}
if (process.env.VIDEORC_SOURCE_ISO_RUNTIME_QUICK !== '1' && !lifecycleOnly) {
  await cases.run('process-interruption', join(directory, 'process-interruption'), () =>
    verifyCrashRecovery(join(directory, 'process-interruption'))
  )
  await cases.run('latency', directory, async () => {
    const summary = summarizeRecordCycles(latency)
    const verdict = evaluateRecordLatencyBudget(summary)
    writeFileSync(
      join(directory, 'iso-latency.json'),
      JSON.stringify({ surface: 'backend-session-coordinator', summary, verdict }, null, 2)
    )
    if (!verdict.pass) throw new Error(`ISO coordinator latency: ${verdict.failures.join('; ')}`)
  })
}
writeFileSync(join(directory, 'verdicts.json'), JSON.stringify(results, null, 2))
console.log(
  `separate-source-runtime: ${cases.failures.length ? 'FAIL' : coverage.partial ? 'PARTIAL PASS' : 'PASS'} (${results.length} artifact take verdicts, ${cases.failures.length} failed cases)`
)
// An aggregate must not mistake a deliberately omitted shipping profile for a full pass.
if (cases.failures.length) process.exitCode = 1
else if (skip4K || lifecycleOnly) process.exitCode = 3

function run(command, args, env = process.env, capture = false, timeoutMs) {
  return new Promise((resolveRun, reject) => {
    const ownsBackendGroup = args[0] === 'recording::tests::source_iso_runtime_artifacts'
    const child = spawn(command, args, {
      cwd: root,
      env,
      detached: ownsBackendGroup,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit'
    })
    const signalChild = (signal) => {
      if (ownsBackendGroup) signalOwnedProcessGroup(child.pid, signal)
      else child.kill(signal)
    }
    const output = []
    let stderr = ''
    if (capture) {
      child.stdout.on('data', (chunk) => output.push(chunk))
      child.stderr.on('data', (chunk) => {
        stderr += chunk
      })
    }
    let failure
    let forceKill
    const cancel = (reason, interrupted = false) => {
      clearTimeout(deadline)
      if (!failure || interrupted) {
        failure = new Error(reason)
        if (interrupted) failure.name = 'AbortError'
      }
      signalChild('SIGTERM')
      forceKill ??= setTimeout(() => signalChild('SIGKILL'), 2000)
    }
    const deadline = setTimeout(
      () => cancel(`${command} exceeded its execution deadline`),
      timeoutMs ?? (command === 'cargo' ? 600_000 : 120_000)
    )
    const interrupt = () => cancel(`${command} interrupted`, true)
    process.once('SIGINT', interrupt)
    process.once('SIGTERM', interrupt)
    const cleanup = () => {
      clearTimeout(deadline)
      clearTimeout(forceKill)
      process.off('SIGINT', interrupt)
      process.off('SIGTERM', interrupt)
    }
    child.on('error', (error) => {
      cleanup()
      reject(error)
    })
    child.on('close', async (code, signal) => {
      if (ownsBackendGroup) {
        try {
          await retireOwnedProcessGroup(child.pid)
        } catch (error) {
          failure ??= error
        }
      }
      cleanup()
      if (failure) reject(failure)
      else if (code !== 0)
        reject(
          new Error(
            `${command} failed (${code ?? signal}): ${stderr}\n${command === 'cargo' ? Buffer.concat(output).toString() : ''}`
          )
        )
      else resolveRun(Buffer.concat(output))
    })
  })
}

function signalOwnedProcessGroup(pid, signal) {
  if (!pid) return
  try {
    process.kill(-pid, signal)
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
}

async function retireOwnedProcessGroup(pid) {
  if (!pid) return
  signalOwnedProcessGroup(pid, 'SIGKILL')
  const deadline = Date.now() + 3000
  while (true) {
    try {
      process.kill(-pid, 0)
    } catch (error) {
      if (error.code === 'ESRCH') return
      // Darwin can transiently report EPERM while a killed group's last
      // members are being reaped. This is not cleanup success: only ESRCH
      // proves absence, and the original bounded deadline still applies.
      if (error.code !== 'EPERM') throw error
    }
    if (Date.now() >= deadline) throw new Error(`Owned backend process group ${pid} was not reaped`)
    await new Promise((resolveWait) => setTimeout(resolveWait, 10))
  }
}

async function retireChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'close')
  child.kill('SIGTERM')
  const force = setTimeout(() => child.kill('SIGKILL'), 2000)
  try {
    await exited
  } finally {
    clearTimeout(force)
  }
}

// Manual child transactions also own interruption while no run() child exists.
function ownInterruption(cancel) {
  let error
  const interrupt = () => {
    error ??= Object.assign(new Error('Runtime interrupted'), { name: 'AbortError' })
    cancel()
  }
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', interrupt)
  return {
    get error() {
      return error
    },
    dispose() {
      process.off('SIGINT', interrupt)
      process.off('SIGTERM', interrupt)
    }
  }
}

async function startReceivers(evidence, count = 2) {
  mkdirSync(evidence, { recursive: true })
  const port = 20000 + Math.floor(Math.random() * 20000)
  const receivers = { port, children: [], files: [] }
  receivers.interruption = ownInterruption(() => {
    for (const child of receivers.children) child.kill('SIGKILL')
  })
  try {
    for (let index = 0; index < count; index++) {
      const file = join(evidence, `stream-${index}.flv`)
      const child = spawn(
        ffmpeg,
        [
          '-y',
          '-nostdin',
          '-hide_banner',
          '-loglevel',
          'error',
          '-listen',
          '1',
          '-i',
          `rtmp://127.0.0.1:${port + index}/live/iso-${index}`,
          '-c',
          'copy',
          '-f',
          'flv',
          file
        ],
        { stdio: ['ignore', 'ignore', 'pipe'] }
      )
      let stderr = ''
      child.stderr.on('data', (chunk) => {
        stderr += chunk
      })
      receivers.children.push(child)
      receivers.files.push(file)
      await waitForOwnedTcpListener({
        child,
        port: port + index,
        timeoutMs: 5000,
        diagnostics: () => stderr
      })
    }
    if (receivers.interruption.error) throw receivers.interruption.error
    return receivers
  } catch (error) {
    try {
      await stopReceivers(receivers)
    } finally {
      throw receivers.interruption.error ?? error
    }
  }
}
async function stopReceivers(receivers) {
  let results
  try {
    results = await Promise.allSettled(receivers.children.map(retireChild))
  } finally {
    receivers.interruption.dispose()
  }
  if (receivers.interruption.error) throw receivers.interruption.error
  const failed = results.find((result) => result.status === 'rejected')
  if (failed) throw failed.reason
}
async function verifyStreams(receivers, afterCameraOff = false) {
  for (const [index, file] of receivers.files.entries()) {
    const probe = JSON.parse(
      await run(ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', file], process.env, true)
    )
    const video = probe.streams.find((stream) => stream.codec_type === 'video')
    const expected = index === 0 ? [1920, 1080] : [1080, 1920]
    if (video?.width !== expected[0] || video?.height !== expected[1])
      throw new Error('Dual stream canvas changed')
    const pixels = await run(
      ffmpeg,
      [
        '-v',
        'error',
        '-ss',
        afterCameraOff ? '3' : '1',
        '-i',
        file,
        '-frames:v',
        '1',
        '-vf',
        'scale=32:18',
        '-pix_fmt',
        'rgb24',
        '-f',
        'rawvideo',
        'pipe:1'
      ],
      process.env,
      true
    )
    let red = 0,
      green = 0
    for (let at = 0; at < pixels.length; at += 3) {
      if (pixels[at] > pixels[at + 1] + 40) red++
      if (pixels[at + 1] > pixels[at] + 40) green++
    }
    if (green < 2 || (!afterCameraOff && red < 2) || (afterCameraOff && red > 2))
      throw new Error(`Stream ${index} lost its expected composed source content`)
    await verifyMovingVideo(file, 2.3)
  }
}

async function verifyCrashRecovery(evidence) {
  mkdirSync(evidence, { recursive: true })
  const child = spawn(
    executable,
    ['recording::tests::source_iso_runtime_artifacts', '--ignored', '--exact', '--nocapture'],
    {
      cwd: root,
      detached: true, // Private group owns the backend and pre-receipt muxers.
      env: {
        ...process.env,
        VIDEORC_SOURCE_ISO_RUNTIME_DIR: evidence,
        VIDEORC_SOURCE_ISO_RUNTIME_CRASH: '1'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )
  const killOwnedGroup = () => {
    if (!child.pid) return
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
  }
  const closed = new Promise((resolveClosed) => child.once('close', resolveClosed))
  const interruption = ownInterruption(killOwnedGroup)
  console.log(`Crash fixture owned process group: ${child.pid}`)
  let receipt
  let failure
  try {
    receipt = await new Promise((resolveReady, rejectReady) => {
      let stdout = '',
        stderr = ''
      const deadline = setTimeout(
        () => rejectReady(new Error(`Crash fixture readiness timed out: ${stderr}`)),
        15000
      )
      child.stderr.on('data', (chunk) => {
        stderr += chunk
      })
      child.stdout.on('data', (chunk) => {
        stdout += chunk
        const match = stdout.match(/ISO_CRASH_READY (.+)\n/)
        if (match) {
          clearTimeout(deadline)
          resolveReady(JSON.parse(match[1]))
        }
      })
      child.once('error', (error) => {
        clearTimeout(deadline)
        rejectReady(error)
      })
      child.once('close', () => {
        clearTimeout(deadline)
        rejectReady(new Error(`Crash fixture exited before readiness: ${stderr}`))
      })
    })
    if (receipt.paths?.length !== 3)
      throw new Error('Crash fixture must identify all 3 owned media paths')
    const mediaStartedAt = Date.now()
    let liveFrames
    while (true) {
      if (interruption.error) throw interruption.error
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error('Crash fixture exited before live media readiness')
      const probes = await Promise.allSettled(
        receipt.paths.map(async (file) => {
          try {
            const probe = JSON.parse(
              await run(
                ffprobe,
                [
                  '-v',
                  'error',
                  '-show_frames',
                  '-read_intervals',
                  '%+#100',
                  '-show_entries',
                  'frame=media_type,pts_time',
                  '-of',
                  'json',
                  file
                ],
                process.env,
                true,
                Math.max(1, 2000 - (Date.now() - mediaStartedAt))
              )
            )
            const video = probe.frames.filter((frame) => frame.media_type === 'video').length
            const audio = probe.frames.filter((frame) => frame.media_type === 'audio').length
            return { file, video, audio, decodable: video >= 2 && audio >= 1 }
          } catch (error) {
            if (error?.name === 'AbortError') throw error
            return { file, decodable: false, error: error.message }
          }
        })
      )
      const rejected = probes.filter((probe) => probe.status === 'rejected')
      const aborted = rejected.find((probe) => probe.reason?.name === 'AbortError')
      if (aborted) throw aborted.reason
      if (rejected.length) throw rejected[0].reason
      liveFrames = probes.map((probe) => probe.value)
      if (Date.now() - mediaStartedAt >= 2000)
        throw new Error(
          `ISO crash media did not become decodable within 2s: ${JSON.stringify(liveFrames)}`
        )
      if (liveFrames.every((file) => file.decodable)) break
      await new Promise((resolveWait) => setTimeout(resolveWait, 20))
    }
    writeFileSync(
      join(evidence, 'live-cluster-readiness.json'),
      JSON.stringify({ elapsedMs: Date.now() - mediaStartedAt, files: liveFrames }, null, 2)
    )
    if (interruption.error) throw interruption.error
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error('Crash fixture exited before the deliberate interruption')
    child.kill('SIGKILL')
    await closed
  } catch (error) {
    failure = error
  } finally {
    try {
      killOwnedGroup()
      await retireChild(child)
      if (receipt) {
        for (const pid of receipt.pids) {
          try {
            process.kill(pid, 'SIGKILL')
          } catch (error) {
            if (error.code !== 'ESRCH') throw error
          }
        }
        const deadline = Date.now() + 5000
        for (const pid of receipt.pids) {
          while (true) {
            try {
              process.kill(pid, 0)
            } catch (error) {
              if (error.code === 'ESRCH') break
              throw error
            }
            if (Date.now() >= deadline) throw new Error(`Owned crash child ${pid} was not reaped`)
            await new Promise((resolveWait) => setTimeout(resolveWait, 10))
          }
        }
      }
    } catch (error) {
      failure ??= error
    } finally {
      interruption.dispose()
    }
  }
  if (interruption.error) throw interruption.error
  if (failure) throw failure
  writeFileSync(join(evidence, 'interruption.json'), JSON.stringify(receipt, null, 2))
  await run(
    executable,
    ['recording::tests::source_iso_runtime_artifacts', '--ignored', '--exact', '--nocapture'],
    {
      ...process.env,
      VIDEORC_SOURCE_ISO_RUNTIME_DIR: evidence,
      VIDEORC_SOURCE_ISO_RUNTIME_RECOVER: '1'
    }
  )
}

async function verifyMovingVideo(file, start, requiredEnd = 3.5) {
  const probe = JSON.parse(
    await run(
      ffprobe,
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_frames',
        '-show_entries',
        'frame=best_effort_timestamp_time',
        '-of',
        'json',
        file
      ],
      process.env,
      true
    )
  )
  const pixels = await run(
    ffmpeg,
    [
      '-v',
      'error',
      '-i',
      file,
      '-map',
      '0:v:0',
      '-vf',
      'scale=1:1',
      '-pix_fmt',
      'rgb24',
      '-fps_mode',
      'passthrough',
      '-f',
      'rawvideo',
      'pipe:1'
    ],
    process.env,
    true
  )
  if (pixels.length !== probe.frames.length * 3) throw new Error('Survivor pixels lack actual PTS')
  const frames = probe.frames
    .map((frame, index) => ({
      time: Number(frame.best_effort_timestamp_time),
      value: pixels[index * 3 + 2]
    }))
    .filter((frame) => frame.time >= start)
  const values = new Set(frames.map((frame) => frame.value))
  if (frames.length < 20 || frames.at(-1).time < requiredEnd || values.size < 6)
    throw new Error(`Surviving output froze after role end: ${file}`)
  return {
    postBoundaryFrames: frames.length,
    lastTime: frames.at(-1).time,
    distinctMarkers: values.size
  }
}

async function verifyRoleAudioBoundary(file, role, offsetMs, endSeconds, fps) {
  const probe = JSON.parse(
    await run(
      ffprobe,
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_frames',
        '-show_entries',
        'frame=best_effort_timestamp_time',
        '-of',
        'json',
        file
      ],
      process.env,
      true
    )
  )
  const pixels = await run(
    ffmpeg,
    [
      '-v',
      'error',
      '-i',
      file,
      '-map',
      '0:v:0',
      '-vf',
      'scale=1:1',
      '-pix_fmt',
      'rgb24',
      '-fps_mode',
      'passthrough',
      '-f',
      'rawvideo',
      'pipe:1'
    ],
    process.env,
    true
  )
  const video = probe.frames.map((frame, index) => ({
    time: Number(frame.best_effort_timestamp_time),
    hot: pixels[index * 3 + (role === 'camera' ? 0 : 1)] > 180
  }))
  const audioProbe = JSON.parse(
    await run(
      ffprobe,
      [
        '-v',
        'error',
        '-select_streams',
        'a:0',
        '-show_entries',
        'stream=start_time',
        '-of',
        'json',
        file
      ],
      process.env,
      true
    )
  )
  const bytes = await run(
    ffmpeg,
    [
      '-v',
      'error',
      '-i',
      file,
      '-map',
      '0:a:0',
      '-af',
      'pan=mono|c0=0.5*c0+0.5*c1',
      '-ar',
      '48000',
      '-f',
      'f32le',
      'pipe:1'
    ],
    process.env,
    true
  )
  const pcm = new Float32Array(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  )
  const tones = audioToneWindows(pcm, {
    frequency: role === 'camera' ? 997 : 317,
    startTime: Number(audioProbe.streams[0].start_time) || 0
  })
  const verdict = evaluateSourceEnvelope(video, tones, { fps, offsetMs, endSeconds })
  if (!verdict.pass)
    throw new Error(`${role} committed removal audio: ${verdict.failures.join('; ')}`)
  return { endSeconds, offsetMs, verdict, tones }
}

async function verifyCircularMarkerSampling() {
  const width = 64
  const height = 36
  const pixels = Buffer.alloc(width * height * 3 * 2)
  for (let frame = 0; frame < 2; frame++) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const camera = x >= 40 && y >= 20
        const offset = ((frame * height + y) * width + x) * 3
        pixels[offset] = camera ? 255 : 0
        pixels[offset + 1] = camera ? 0 : 255
        pixels[offset + 2] = camera !== Boolean(frame) ? 6 : 186
      }
    }
  }
  const file = join(directory, 'circular-marker-control.rgb')
  writeFileSync(file, pixels)
  const sample = (filter) =>
    run(
      ffmpeg,
      [
        '-v',
        'error',
        '-f',
        'rawvideo',
        '-pixel_format',
        'rgb24',
        '-video_size',
        `${width}x${height}`,
        '-i',
        file,
        '-vf',
        filter,
        '-frames:v',
        '2',
        '-pix_fmt',
        'rgb24',
        '-f',
        'rawvideo',
        'pipe:1'
      ],
      process.env,
      true
    )
  const whole = await sample('scale=1:1')
  const isolated = await sample(
    combinedSourceMarkerFilter({
      layoutPreset: 'screen-camera',
      cameraTransformMode: 'preset',
      cameraCorner: 'bottom-right',
      cameraSize: 'medium'
    })
  )
  if (whole.length !== 6 || isolated.length !== 6)
    throw new Error('Circular marker control requires exactly two decoded RGB samples')
  for (const [index, expected] of [186, 6].entries()) {
    if (Math.abs(isolated[index * 3 + 2] - expected) > 1)
      throw new Error('Source marker ROI mixed circular screen/camera values')
    if (Math.abs(whole[index * 3 + 2] - expected) < 10)
      throw new Error('Circular marker negative control did not expose whole-frame averaging')
    if (whole[index * 3] < 10 || whole[index * 3 + 1] < 150)
      throw new Error('Whole-frame pulse samples lost camera/screen composition coverage')
  }
  writeFileSync(
    join(directory, 'circular-marker-control.json'),
    JSON.stringify(
      {
        whole: [...whole],
        isolated: [...isolated],
        pass: true
      },
      null,
      2
    )
  )
}

// Original shortest packet rounding is scheduling-dependent, so preserve its
// outcome as diagnostic evidence. Bounded packets must retain the audible tail;
// a separately encoded 76ms truncation must fail with the video left unchanged.
async function verifyPcmShortestPacketBoundary() {
  for (const fps of [30, 60]) {
    for (const bounded of [false, true]) {
      const file = join(directory, `pcm-shortest-${fps}-${bounded ? 'bounded' : 'original'}.mkv`)
      await run(ffmpeg, [
        '-v',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        `color=c=green:size=64x64:rate=${fps}:duration=1.1`,
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=997:sample_rate=48000:samples_per_frame=4096:duration=1.2',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-bf',
        '0',
        '-c:a',
        'pcm_s16le',
        '-ac',
        '2',
        '-af',
        bounded ? 'apad,asetnsamples=n=480:p=0' : 'apad',
        '-shortest',
        file
      ])
      const bytes = await run(
        ffmpeg,
        ['-v', 'error', '-i', file, '-map', '0:a:0', '-ac', '1', '-f', 'f32le', 'pipe:1'],
        process.env,
        true
      )
      const pcm = new Float32Array(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      )
      const audio = audioToneWindows(pcm, { frequency: 997 })
      const video = Array.from({ length: Math.round(1.1 * fps) }, (_, index) => ({
        time: index / fps,
        hot: true
      }))
      const verdict = evaluateSourceEnvelope(video, audio, { fps, endSeconds: 1.1 })
      writeFileSync(
        `${file}.json`,
        JSON.stringify({ fps, bounded, audioEnd: pcm.length / 48000, verdict }, null, 2)
      )
      if (bounded && !verdict.pass) throw new Error(`PCM shortest ${fps}fps fix lost audible tail`)
      if (bounded) {
        const truncated = join(directory, `pcm-shortest-${fps}-truncated.mkv`)
        await run(ffmpeg, [
          '-v',
          'error',
          '-y',
          '-i',
          file,
          '-map',
          '0:v:0',
          '-map',
          '0:a:0',
          '-c:v',
          'copy',
          '-c:a',
          'pcm_s16le',
          '-af',
          'atrim=end=1.024',
          truncated
        ])
        const truncatedBytes = await run(
          ffmpeg,
          ['-v', 'error', '-i', truncated, '-map', '0:a:0', '-ac', '1', '-f', 'f32le', 'pipe:1'],
          process.env,
          true
        )
        const truncatedPcm = new Float32Array(
          truncatedBytes.buffer.slice(
            truncatedBytes.byteOffset,
            truncatedBytes.byteOffset + truncatedBytes.byteLength
          )
        )
        const probe = JSON.parse(
          await run(
            ffprobe,
            [
              '-v',
              'error',
              '-select_streams',
              'v:0',
              '-show_frames',
              '-show_entries',
              'frame=best_effort_timestamp_time',
              '-of',
              'json',
              truncated
            ],
            process.env,
            true
          )
        )
        if (
          probe.frames.length !== video.length ||
          Math.abs(Number(probe.frames.at(-1).best_effort_timestamp_time) + 1 / fps - 1.1) > 0.001
        )
          throw new Error('Encoded negative control changed the video boundary')
        const negative = evaluateSourceEnvelope(
          video,
          audioToneWindows(truncatedPcm, { frequency: 997 }),
          { fps, endSeconds: 1.1 }
        )
        writeFileSync(
          `${truncated}.json`,
          JSON.stringify({ fps, audioEnd: truncatedPcm.length / 48000, verdict: negative }, null, 2)
        )
        if (negative.pass)
          throw new Error(`Encoded ${fps}fps truncated-audio negative unexpectedly passed`)
      }
    }
  }
}

// Codec artifacts must retain sample-accurate edge identity. This control sees
// decoded audio only; the unchanged A/V gate applies its own strict budget.
async function verifyRefinedAacEdges() {
  const control = join(directory, 'aac-edge-control')
  mkdirSync(control, { recursive: true })
  const sampleRate = 48000
  const edges = {
    997: [0.402083333, 0.852083333, 1.102083333, 1.652083333],
    317: [0.347375, 0.847375, 1.147375, 1.647375]
  }
  const pcm = Float32Array.from({ length: sampleRate * 2 }, (_, sample) => {
    const time = sample / sampleRate
    return Object.entries(edges).reduce((sum, [frequency, transitions]) => {
      const active = transitions.filter((edge) => time >= edge).length % 2
      return (
        sum +
        (active
          ? (Number(frequency) === 997 ? 0.25 : 0.1) *
            Math.sin(
              time * Number(frequency) * 2 * Math.PI + (Number(frequency) === 997 ? 0.37 : 1.19)
            )
          : 0)
      )
    }, 0)
  })
  const raw = join(control, 'source.f32le')
  const encoded = join(control, 'encoded.m4a')
  writeFileSync(raw, Buffer.from(pcm.buffer))
  await run(ffmpeg, [
    '-v',
    'error',
    '-y',
    '-f',
    'f32le',
    '-ar',
    String(sampleRate),
    '-ac',
    '1',
    '-i',
    raw,
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    encoded
  ])
  const bytes = await run(
    ffmpeg,
    ['-v', 'error', '-i', encoded, '-ac', '1', '-ar', String(sampleRate), '-f', 'f32le', 'pipe:1'],
    process.env,
    true
  )
  const decoded = new Float32Array(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  )
  const proofs = {}
  for (const frequency of [997, 317]) {
    const refined = refinedToneTransitions(decoded, { frequency })
    proofs[frequency] = refined
    writeFileSync(join(control, 'edges.json'), JSON.stringify(proofs, null, 2))
    if (!refined.pass || refined.events.length !== edges[frequency].length)
      throw new Error(
        `AAC edge control could not measure ${frequency}Hz: ${refined.failures.join('; ')}`
      )
    for (const fps of [30, 60]) {
      const tolerance = 1 / fps + 0.01
      for (const direction of [-1, 1]) {
        const within = edges[frequency].map((edge) => edge + direction * (tolerance - 0.001))
        const outside = edges[frequency].map((edge) => edge + direction * (tolerance + 0.001))
        if (!evaluateAudioVideoEvents(within, refined.events, { fps, endSeconds: 2 }).pass)
          throw new Error(`AAC within-budget edge rejected at${fps}fps`)
        if (evaluateAudioVideoEvents(outside, refined.events, { fps, endSeconds: 2 }).pass)
          throw new Error(`AAC beyond-budget edge accepted at${fps}fps`)
      }
    }
  }
}
