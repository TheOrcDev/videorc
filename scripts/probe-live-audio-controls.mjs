#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { successfulLiveCommandReplies } from './lib/live-audio-control-protocol.mjs'

const ffmpegPath = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
const productionStatsPeriodSeconds = 2
const productionReplyTimeoutMs = 5000
const legacyReplyTimeoutMs = 2000
const acknowledgementCadenceJitterMs = 150
// FFmpeg can have roughly one second of -re audio already buffered when it
// acknowledges the graph command. Sample after that queued audio drains.
const artifactApplicationSettleSeconds = 1
const liveCommands = [
  { label: '+6 dB', command: 'Cvolume@videorc_live_mic -1 volume 6dB\n' },
  { label: 'mute', command: 'Cvolume@videorc_live_mic -1 volume 0\n' },
  { label: 'unmute', command: 'Cvolume@videorc_live_mic -1 volume 1\n' }
]
const audibleMaxVolumeDb = -40
const mutedMaxVolumeDb = -80
const gainDeltaDb = 6
const amplitudeToleranceDb = 0.75
const artifactAnalysisWindowSeconds = artifactApplicationSettleSeconds + 0.75
// Allow a full production reply deadline for startup and for every command,
// then retain enough audio to inspect the final unmuted state. Hosted Windows
// runners can otherwise exhaust a fixed 16s source before scheduling command 3.
const probeDurationSeconds = Math.ceil(
  ((liveCommands.length + 1) * productionReplyTimeoutMs) / 1000 +
    artifactAnalysisWindowSeconds
)
const processTimeoutMs = 30000
const outputDirectory = await mkdtemp(join(tmpdir(), 'videorc-live-audio-controls-'))
const artifacts = [
  join(outputDirectory, 'recording-output.wav'),
  join(outputDirectory, 'stream-output.wav')
]

try {
  console.log(`live-audio-controls probe: ffmpeg=${ffmpegPath}`)
  assert.ok(
    productionReplyTimeoutMs > productionStatsPeriodSeconds * 2 * 1000,
    'live command timeout must include two production stats periods plus scheduling headroom'
  )
  assert.ok(
    legacyReplyTimeoutMs <= productionStatsPeriodSeconds * 1000,
    'the regression probe must retain the unsafe legacy 2s deadline as a caught boundary'
  )
  const { stderr, acknowledgements } = await runLiveAudioControlProbe()
  const acknowledgementLatencyMs = acknowledgements.map(({ latencyMs }) => latencyMs)
  const successfulReplies = successfulLiveCommandReplies(stderr)
  assert.equal(
    successfulReplies.length,
    artifacts.length * liveCommands.length,
    `expected ${artifacts.length * liveCommands.length} successful live volume command replies, got ${successfulReplies.length}:\n${stderr.slice(-2000)}`
  )
  assert.equal(
    acknowledgementLatencyMs.length,
    liveCommands.length,
    `expected one complete acknowledgement timing for each live command, got ${acknowledgementLatencyMs.length}`
  )
  for (const [index, latencyMs] of acknowledgementLatencyMs.entries()) {
    assert.ok(
      latencyMs < productionReplyTimeoutMs,
      `live command ${liveCommands[index].label} acknowledgement took ${latencyMs}ms, exceeding the ${productionReplyTimeoutMs}ms production deadline`
    )
  }
  assert.ok(
    acknowledgementLatencyMs.some(
      (latencyMs) =>
        latencyMs >= productionStatsPeriodSeconds * 1000 - acknowledgementCadenceJitterMs
    ),
    `expected a command written just after progress=continue to wait for the next ${productionStatsPeriodSeconds}s poll; observed ${acknowledgementLatencyMs.join(',')}ms`
  )

  const preWindow = windowBefore(acknowledgements[0].appliedAtSeconds)
  const gainWindow = windowBetween(
    acknowledgements[0].appliedAtSeconds,
    acknowledgements[1].appliedAtSeconds
  )
  const mutedWindow = windowBetween(
    acknowledgements[1].appliedAtSeconds,
    acknowledgements[2].appliedAtSeconds
  )
  const restoredWindow = {
    startSeconds: acknowledgements[2].appliedAtSeconds + artifactApplicationSettleSeconds,
    durationSeconds: 0.75
  }
  console.log(
    `live-audio-controls probe: acknowledgements=${acknowledgementLatencyMs.join(',')}ms ` +
      `applied-at=${acknowledgements.map(({ appliedAtSeconds }) => appliedAtSeconds.toFixed(3)).join(',')}s`
  )
  console.log(
    `live-audio-controls probe: analysis-windows=${[
      preWindow,
      gainWindow,
      mutedWindow,
      restoredWindow
    ]
      .map(
        ({ startSeconds, durationSeconds }) =>
          `${startSeconds.toFixed(3)}+${durationSeconds.toFixed(3)}s`
      )
      .join(',')}`
  )

  const analyses = await Promise.all(
    artifacts.map(async (artifactPath) => ({
      artifactPath,
      preMaxVolumeDb: await detectMaxVolume(
        artifactPath,
        preWindow.startSeconds,
        preWindow.durationSeconds
      ),
      gainMaxVolumeDb: await detectMaxVolume(
        artifactPath,
        gainWindow.startSeconds,
        gainWindow.durationSeconds
      ),
      mutedMaxVolumeDb: await detectMaxVolume(
        artifactPath,
        mutedWindow.startSeconds,
        mutedWindow.durationSeconds
      ),
      restoredMaxVolumeDb: await detectMaxVolume(
        artifactPath,
        restoredWindow.startSeconds,
        restoredWindow.durationSeconds
      )
    }))
  )

  for (const analysis of analyses) {
    assert.ok(
      Number.isFinite(analysis.preMaxVolumeDb) && analysis.preMaxVolumeDb > audibleMaxVolumeDb,
      `${analysis.artifactPath} was not audible before the command: ${formatDb(analysis.preMaxVolumeDb)}`
    )
    assert.ok(
      Math.abs(analysis.gainMaxVolumeDb - (analysis.preMaxVolumeDb + gainDeltaDb)) <=
        amplitudeToleranceDb,
      `${analysis.artifactPath} did not apply +${gainDeltaDb} dB live gain: pre=${formatDb(analysis.preMaxVolumeDb)} gain=${formatDb(analysis.gainMaxVolumeDb)}`
    )
    assert.ok(
      analysis.mutedMaxVolumeDb <= mutedMaxVolumeDb,
      `${analysis.artifactPath} was not muted after the command: ${formatDb(analysis.mutedMaxVolumeDb)}`
    )
    assert.ok(
      Math.abs(analysis.restoredMaxVolumeDb - analysis.preMaxVolumeDb) <= amplitudeToleranceDb,
      `${analysis.artifactPath} did not restore audible gain after unmute: pre=${formatDb(analysis.preMaxVolumeDb)} restored=${formatDb(analysis.restoredMaxVolumeDb)}`
    )
    console.log(
      `live-audio-controls probe: ${analysis.artifactPath.split(/[\\/]/).at(-1)} ` +
        `pre=${formatDb(analysis.preMaxVolumeDb)} gain=${formatDb(analysis.gainMaxVolumeDb)} ` +
        `muted=${formatDb(analysis.mutedMaxVolumeDb)} restored=${formatDb(analysis.restoredMaxVolumeDb)}`
    )
  }

  console.log(
    `live-audio-controls probe: acknowledgements=${acknowledgementLatencyMs.join(',')}ms ` +
      `deadline=${productionReplyTimeoutMs}ms stats-period=${productionStatsPeriodSeconds}s`
  )
  console.log('live-audio-controls probe: PASS')
} finally {
  await rm(outputDirectory, { recursive: true, force: true })
}

function runLiveAudioControlProbe() {
  const ffmpeg = spawn(
    ffmpegPath,
    [
      '-hide_banner',
      '-loglevel',
      'warning',
      '-stats',
      '-stats_period',
      String(productionStatsPeriodSeconds),
      '-progress',
      'pipe:2',
      '-y',
      '-re',
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=1000:sample_rate=48000:duration=${probeDurationSeconds}`,
      '-map',
      '0:a:0',
      '-filter:a',
      'volume@videorc_live_mic=1',
      '-c:a',
      'pcm_s16le',
      artifacts[0],
      '-map',
      '0:a:0',
      '-filter:a',
      'volume@videorc_live_mic=1',
      '-c:a',
      'pcm_s16le',
      artifacts[1]
    ],
    { stdio: ['pipe', 'ignore', 'pipe'] }
  )

  return new Promise((resolveProbe, rejectProbe) => {
    let stderr = ''
    const commandTimers = []
    let commandsSent = 0
    let processError = null
    let timedOut = false
    let successfulRepliesSeen = 0
    const commandSentAt = []
    const acknowledgements = []
    let processStartedAt = 0
    let progressLineBuffer = ''
    let commandScheduled = false

    const scheduleNextCommand = () => {
      if (commandScheduled || commandsSent >= liveCommands.length) return
      commandScheduled = true
      const commandIndex = commandsSent
      commandTimers.push(
        setTimeout(() => {
          commandScheduled = false
          const liveCommand = liveCommands[commandIndex]
          commandSentAt[commandIndex] = Date.now()
          commandsSent += 1
          ffmpeg.stdin.write(liveCommand.command, (error) => {
            if (error) {
              processError ??= error
            }
          })
        }, 0)
      )
    }

    const processProtocolLine = (line) => {
      const successfulReplies = successfulLiveCommandReplies(line)
      for (const _reply of successfulReplies) {
        successfulRepliesSeen += 1
        if (successfulRepliesSeen % artifacts.length !== 0) continue
        const commandIndex = successfulRepliesSeen / artifacts.length - 1
        const sentAt = commandSentAt[commandIndex]
        if (sentAt !== undefined && acknowledgements[commandIndex] === undefined) {
          acknowledgements[commandIndex] = {
            latencyMs: Date.now() - sentAt,
            appliedAtSeconds: (Date.now() - processStartedAt) / 1000
          }
        }
      }

      if (
        line.trim() === 'progress=continue' &&
        successfulRepliesSeen >= commandsSent * artifacts.length
      ) {
        // Write just after FFmpeg's production report/poll boundary. The reply
        // must then survive a full 2s stats period, exposing the old 2s
        // deadline as a zero-headroom race while proving the 5s contract.
        scheduleNextCommand()
      }
    }

    ffmpeg.stderr.setEncoding('utf8')
    ffmpeg.stderr.on('data', (chunk) => {
      stderr += chunk
      progressLineBuffer += chunk
      const lines = progressLineBuffer.split(/[\r\n]/)
      progressLineBuffer = lines.pop() ?? ''
      for (const line of lines) {
        processProtocolLine(line)
      }
    })
    ffmpeg.once('spawn', () => {
      processStartedAt = Date.now()
    })
    ffmpeg.stdin.on('error', (error) => {
      processError ??= error
    })
    ffmpeg.on('error', (error) => {
      processError ??= error
    })

    const timeout = setTimeout(() => {
      timedOut = true
      ffmpeg.kill()
    }, processTimeoutMs)

    ffmpeg.on('close', (code, signal) => {
      clearTimeout(timeout)
      for (const commandTimer of commandTimers) {
        clearTimeout(commandTimer)
      }
      if (timedOut) {
        rejectProbe(new Error(`live FFmpeg probe timed out after ${processTimeoutMs}ms`))
        return
      }
      if (processError) {
        rejectProbe(processError)
        return
      }
      if (commandsSent !== liveCommands.length) {
        rejectProbe(
          new Error(
            `FFmpeg exited after ${commandsSent}/${liveCommands.length} live volume commands:\n${stderr.slice(-2000)}`
          )
        )
        return
      }
      if (code !== 0) {
        rejectProbe(
          new Error(
            `live FFmpeg probe exited with code=${code} signal=${signal}:\n${stderr.slice(-2000)}`
          )
        )
        return
      }
      if (progressLineBuffer) {
        processProtocolLine(progressLineBuffer)
      }
      resolveProbe({ stderr, acknowledgements })
    })
  })
}

function windowBefore(appliedAtSeconds) {
  const durationSeconds = 0.75
  return {
    startSeconds: Math.max(0.1, appliedAtSeconds - durationSeconds - 0.3),
    durationSeconds
  }
}

function windowBetween(appliedAtSeconds, nextAppliedAtSeconds) {
  const startSeconds = appliedAtSeconds + artifactApplicationSettleSeconds
  const durationSeconds = Math.min(0.75, nextAppliedAtSeconds - startSeconds - 0.3)
  assert.ok(
    durationSeconds >= 0.35,
    `acknowledgements were too close for artifact analysis: ${appliedAtSeconds}s -> ${nextAppliedAtSeconds}s`
  )
  return { startSeconds, durationSeconds }
}

async function detectMaxVolume(filePath, startSeconds, durationSeconds) {
  const stderr = await runFfmpeg([
    '-hide_banner',
    '-loglevel',
    'info',
    '-nostats',
    '-nostdin',
    '-ss',
    String(startSeconds),
    '-t',
    String(durationSeconds),
    '-i',
    filePath,
    '-map',
    '0:a:0',
    '-af',
    'volumedetect',
    '-f',
    'null',
    '-'
  ])
  const match = stderr.match(/max_volume:\s*(-?inf|-?\d+(?:\.\d+)?)\s*dB/i)
  if (!match) {
    throw new Error(
      `volumedetect did not report max_volume for ${filePath}:\n${stderr.slice(-1000)}`
    )
  }
  return match[1].toLowerCase() === '-inf' ? Number.NEGATIVE_INFINITY : Number(match[1])
}

function runFfmpeg(args) {
  return new Promise((resolveRun, rejectRun) => {
    const ffmpeg = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''

    ffmpeg.stderr.setEncoding('utf8')
    ffmpeg.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    ffmpeg.on('error', rejectRun)
    ffmpeg.on('close', (code, signal) => {
      if (code === 0) {
        resolveRun(stderr)
        return
      }
      rejectRun(
        new Error(
          `FFmpeg analysis exited with code=${code} signal=${signal}:\n${stderr.slice(-1000)}`
        )
      )
    })
  })
}

function formatDb(value) {
  return `${Number.isFinite(value) ? value.toFixed(1) : '-inf'} dB`
}
