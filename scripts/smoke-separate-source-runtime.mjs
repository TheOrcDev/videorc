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
  maximumToneAmplitude,
  toneWindowTransitions,
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
const quickOffset = Number(process.env.VIDEORC_SOURCE_ISO_RUNTIME_OFFSET ?? 0)
if (quick && (!Number.isInteger(quickOffset) || Math.abs(quickOffset) > 1000))
  throw new Error('Quick runtime offset must be an integer between -1000 and 1000ms')
const quickWidth = Number(process.env.VIDEORC_SOURCE_ISO_RUNTIME_WIDTH ?? 1920)
const quickVariant = process.env.VIDEORC_SOURCE_ISO_RUNTIME_VARIANT ?? 'normal'
if (
  quick &&
  (![1920, 3840].includes(quickWidth) || !['normal', 'shared-stream'].includes(quickVariant))
)
  throw new Error('Quick runtime requires 1920/3840 width and normal/shared-stream variant')
const skip4K = process.env.VIDEORC_SOURCE_ISO_RUNTIME_SKIP_4K === '1'
const allProfiles = quick
  ? [[quickWidth, 30, quickOffset, quickVariant]]
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
      [1920, 60, 0, 'native-latency', { VIDEORC_SOURCE_ISO_RUNTIME_CAPTURE_LATENCY_MS: '72' }]
    ]
const profiles = allProfiles.filter(([width]) => !skip4K || width < 3840)
if (profiles.length === 0) throw new Error('Runtime selection omitted every requested profile')
const coverage = {
  partial: quick || skip4K,
  quick,
  omittedProfiles: skip4K ? ['3840x2160-30-0-normal'] : []
}
writeFileSync(join(directory, 'coverage.json'), JSON.stringify(coverage, null, 2))
if (skip4K)
  console.log('PARTIAL runtime: 4K explicitly omitted; full matrix acceptance remains pending')
console.log(`Production separate-source evidence: ${directory}`)
if (quick)
  console.log(
    `PARTIAL quick runtime: ${quickWidth}x${(quickWidth * 9) / 16}@30 ${quickVariant}, offset ${quickOffset}ms; full matrix not run`
  )
const results = []
const latency = []
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
await verifyPcmShortestPacketBoundary()
for (const [width, fps, offset, variant = 'normal', overrides = {}] of profiles) {
  const evidence = join(directory, `${width}x${(width * 9) / 16}-${fps}-${offset}-${variant}`)
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
    await run(process.execPath, ['scripts/smoke-separate-source-take.mjs', combined, '--no-motion'])
    const paths = takeSiblingPaths(combined)
    const events = {}
    const audioEvents = {}
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
        value: pixels[index * 3 + 2],
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
      audioEvents[role] = Object.fromEntries(
        Object.entries(tones[role]).map(([source, windows]) => [
          source,
          toneWindowTransitions(windows)
        ])
      )
      levels[role] = {
        microphone: maximumToneAmplitude(pcm, 997),
        system: maximumToneAmplitude(pcm, 317)
      }
    }
    writeFileSync(
      join(evidence, `decoded-events-${extension}.json`),
      JSON.stringify({ events, audioEvents, markers, levels, tones }, null, 2)
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
        if (!endWindow || endWindow.time < stopBoundarySeconds - 0.05 || endWindow.amplitude < 0.04)
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
        endSeconds: stopBoundarySeconds + Math.min(0, offsetMs / 1000)
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
if (process.env.VIDEORC_SOURCE_ISO_RUNTIME_QUICK !== '1') {
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
    ['hidden-screen', { VIDEORC_SOURCE_ISO_RUNTIME_HIDE: '1' }],
    [
      'screen-off-negative-limit',
      { VIDEORC_SOURCE_ISO_RUNTIME_REMOVE: 'screen', VIDEORC_SOURCE_ISO_RUNTIME_OFFSET: '-1000' }
    ]
  ]) {
    const evidence = join(directory, name)
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
  }
}
if (process.env.VIDEORC_SOURCE_ISO_RUNTIME_QUICK !== '1') {
  await verifyCrashRecovery(join(directory, 'process-interruption'))
  const summary = summarizeRecordCycles(latency)
  const verdict = evaluateRecordLatencyBudget(summary)
  writeFileSync(
    join(directory, 'iso-latency.json'),
    JSON.stringify({ surface: 'backend-session-coordinator', summary, verdict }, null, 2)
  )
  if (!verdict.pass) throw new Error(`ISO coordinator latency: ${verdict.failures.join('; ')}`)
}
writeFileSync(join(directory, 'verdicts.json'), JSON.stringify(results, null, 2))
console.log(
  `separate-source-runtime: ${coverage.partial ? 'PARTIAL PASS' : 'PASS'} (${results.length} artifact take verdicts)`
)
// An aggregate must not mistake a deliberately omitted shipping profile for a full pass.
if (skip4K) process.exitCode = 3

function run(command, args, env = process.env, capture = false) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit'
    })
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
    const cancel = (reason) => {
      failure = new Error(reason)
      child.kill('SIGTERM')
      forceKill ??= setTimeout(() => child.kill('SIGKILL'), 2000)
    }
    const deadline = setTimeout(
      () => cancel(`${command} exceeded its execution deadline`),
      command === 'cargo' ? 600_000 : 120_000
    )
    const interrupt = () => cancel(`${command} interrupted`)
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
    child.on('close', (code, signal) => {
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

async function startReceivers(evidence, count = 2) {
  mkdirSync(evidence, { recursive: true })
  const port = 20000 + Math.floor(Math.random() * 20000)
  const receivers = { port, children: [], files: [] }
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
    return receivers
  } catch (error) {
    await stopReceivers(receivers)
    throw error
  }
}
async function stopReceivers(receivers) {
  await Promise.all(receivers.children.map(retireChild))
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
      env: {
        ...process.env,
        VIDEORC_SOURCE_ISO_RUNTIME_DIR: evidence,
        VIDEORC_SOURCE_ISO_RUNTIME_CRASH: '1'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )
  let receipt
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
    const exited = once(child, 'close')
    child.kill('SIGKILL')
    await exited
  } finally {
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
  }
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
