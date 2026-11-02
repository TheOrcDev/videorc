import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { RECORD_LATENCY_BUDGETS, percentileNearestRank } from './record-latency-gate.mjs'
import { incidentPacketTail } from './windows-incident-packet-tail.mjs'

export function ownedPcmReaderClosed(row, kind, code) {
  if (!row.keepAudioAlive || kind !== 'audio' || row.cancelled) return false
  if (['EPIPE', 'ECONNRESET'].includes(code)) return true
  return (
    code === 'ERR_STREAM_DESTROYED' &&
    Number.isFinite(row.videoEofMs) &&
    Number.isFinite(row.audioPipeClosedAtMs) &&
    row.audioPipeClosedAtMs >= row.videoEofMs
  )
}

export function ownedPcmEofVerdict(row) {
  const failures = []
  if (
    [
      'writtenVideoFrames',
      'writtenAudioFrames',
      'fpsInputFrames',
      'fpsOutputFrames',
      'encodedVideoFrames'
    ].some((key) => !Number.isSafeInteger(row[key]) || row[key] <= 0)
  )
    failures.push('Measured frame/sample counts are required')
  if (
    row.cancelled ||
    row.error ||
    row.videoProducerError ||
    row.audioProducerError ||
    row.timeout ||
    row.unsafeCleanup
  )
    failures.push('Owned producer/process failed')
  if (row.exitCode !== 0 || !row.childReaped || !row.inputsClosed)
    failures.push('FFmpeg did not exit cleanly within its owned deadline')
  if (
    row.writtenVideoFrames !== 120 ||
    (row.keepAudioAlive ? row.writtenAudioFrames < 144000 : row.writtenAudioFrames !== 144000)
  )
    failures.push('Finite source frame/sample count mismatch')
  if (row.fpsInputFrames !== 120 || row.fpsOutputFrames !== row.encodedVideoFrames)
    failures.push('Filter/encoder frame accounting mismatch')
  if (Math.abs(row.encodedVideoFrames - 120) > 2)
    failures.push('Four-second live video timeline changed by more than two frames')
  if (!(Number.isFinite(row.firstOutputMs) && row.firstOutputMs >= 0 && row.firstOutputMs <= 1500))
    failures.push('First media output exceeded 1500ms')
  if (!(Number.isFinite(row.stopMs) && row.stopMs >= 0 && row.stopMs <= 1500))
    failures.push('Video EOF to process exit exceeded the 1500ms diagnostic deadline')
  if (
    !(
      Number.isFinite(row.videoEofMs) &&
      Number.isFinite(row.captureStoppedMs) &&
      row.videoEofMs - row.captureStoppedMs >= 500
    )
  )
    failures.push('Early microphone EOF was not exercised')
  if (
    row.keepAudioAlive &&
    (!Number.isFinite(row.audioPipeClosedAtMs) || row.audioPipeClosedAtMs < row.videoEofMs)
  )
    failures.push('PCM reader closed before video EOF')
  if (row.keepAudioAlive && row.audioEofMs !== null)
    failures.push('PCM pipe ended before the FFmpeg owner')
  if (!(row.packetTail?.videoEndSeconds >= 3.9))
    failures.push('Microphone EOF truncated the continuing video')
  if (
    !Number.isFinite(row.packetTail?.tailMismatchMs) ||
    row.packetTail.tailMismatchMs > 100 ||
    !row.packetTail?.pass
  )
    failures.push(row.packetTail?.reason ?? 'Packet tail unavailable')
  if (!(Number.isFinite(row.startSkewMs) && row.startSkewMs <= 100))
    failures.push('A/V start skew exceeded 100ms')
  return { pass: failures.length === 0, failures }
}

export function ownedPcmEofAggregate(rows, expectedPasses) {
  const failures = []
  const groups = []
  for (const delayMs of [0, 600]) {
    const candidates = rows.filter(
      (row) => row.keepAudioAlive && row.initialAudioDelayMs === delayMs
    )
    if (
      candidates.length !== expectedPasses ||
      candidates.some((row) => !ownedPcmEofVerdict(row).pass)
    )
      failures.push(`Delayed-start ${delayMs}ms candidate evidence incomplete or failed`)
    const firstOutputP95Ms = percentileNearestRank(
      candidates.map((row) => row.firstOutputMs).filter(Number.isFinite),
      0.95
    )
    const stopP95Ms = percentileNearestRank(
      candidates.map((row) => row.stopMs).filter(Number.isFinite),
      0.95
    )
    if (
      !Number.isFinite(firstOutputP95Ms) ||
      firstOutputP95Ms > RECORD_LATENCY_BUDGETS.coldStartClickToRecordingMs
    )
      failures.push(
        `Delayed-start ${delayMs}ms first-output p95 exceeds ${RECORD_LATENCY_BUDGETS.coldStartClickToRecordingMs}ms`
      )
    if (!Number.isFinite(stopP95Ms) || stopP95Ms > RECORD_LATENCY_BUDGETS.stopClickToIdleP95Ms)
      failures.push(
        `Delayed-start ${delayMs}ms EOF-to-exit p95 exceeds ${RECORD_LATENCY_BUDGETS.stopClickToIdleP95Ms}ms`
      )
    groups.push({ delayMs, count: candidates.length, firstOutputP95Ms, stopP95Ms })
  }
  return {
    pass: failures.length === 0,
    failures,
    groups,
    qualification:
      'FFmpeg lifecycle component only; application click-to-idle qualification remains separate'
  }
}

async function bounded(promise, ms) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Owned operation exceeded ${ms}ms`)), ms)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

// Runner-owned loopback sockets work on Windows without inherited POSIX FDs.
// Listening/connection callbacks are readiness; timers only pace media samples.
export function runOwnedPcmEof(options) {
  return runLiveInputEof({ ...options, audioSource: 'pcm' })
}

export function runIndependentToneEof(options) {
  return runLiveInputEof({ ...options, audioSource: 'tone' })
}

export function independentToneEofVerdict(row) {
  const failures = []
  if (row.audioSource !== 'tone') failures.push('Independent tone evidence required')
  if (
    row.cancelled ||
    row.error ||
    row.videoProducerError ||
    row.timeout ||
    row.unsafeCleanup ||
    row.exitCode !== 0 ||
    !row.childReaped ||
    !row.inputsClosed
  )
    failures.push('Owned tone probe did not finish and clean up normally')
  if (
    row.writtenVideoFrames !== 120 ||
    row.fpsInputFrames !== 120 ||
    !Number.isSafeInteger(row.encodedVideoFrames) ||
    Math.abs(row.encodedVideoFrames - 120) > 2 ||
    row.fpsOutputFrames !== row.encodedVideoFrames
  )
    failures.push('Live video frame accounting changed')
  for (const [key, limit] of [
    ['firstOutputMs', 1500],
    ['stopMs', 1500],
    ['startSkewMs', 100]
  ]) {
    if (!Number.isFinite(row[key]) || row[key] < 0 || row[key] > limit)
      failures.push(`${key} missing or exceeds ${limit}ms`)
  }
  if (
    !Number.isFinite(row.packetTail?.videoEndSeconds) ||
    row.packetTail.videoEndSeconds < 3.9 ||
    !Number.isFinite(row.packetTail?.tailMismatchMs) ||
    row.packetTail.tailMismatchMs > 100 ||
    !row.packetTail?.pass
  )
    failures.push(row.packetTail?.reason ?? 'Complete video and <=100ms packet tail required')
  return { pass: failures.length === 0, failures }
}

export function independentToneEofAggregate(rows, expectedPasses) {
  const candidates = rows.filter((row) => row.paceTone === true)
  const failures = []
  if (
    candidates.length !== expectedPasses ||
    candidates.some((row) => !independentToneEofVerdict(row).pass)
  )
    failures.push('Independent paced-tone evidence incomplete or failed')
  const firstOutputP95Ms = percentileNearestRank(
    candidates.map((row) => row.firstOutputMs).filter(Number.isFinite),
    0.95
  )
  const stopP95Ms = percentileNearestRank(
    candidates.map((row) => row.stopMs).filter(Number.isFinite),
    0.95
  )
  if (
    !Number.isFinite(firstOutputP95Ms) ||
    firstOutputP95Ms > RECORD_LATENCY_BUDGETS.coldStartClickToRecordingMs
  )
    failures.push('Tone first-output p95 exceeds the unchanged startup budget')
  if (!Number.isFinite(stopP95Ms) || stopP95Ms > RECORD_LATENCY_BUDGETS.stopClickToIdleP95Ms)
    failures.push('Tone EOF-to-exit p95 exceeds the unchanged stop budget')
  return {
    pass: failures.length === 0,
    failures,
    firstOutputP95Ms,
    stopP95Ms,
    qualification:
      'Independent FFmpeg tone component only; app and physical acceptance remain separate'
  }
}

async function runLiveInputEof({
  ffmpeg,
  ffprobe,
  output,
  queuedAudioMs = 0,
  initialAudioDelayMs = 0,
  keepAudioAlive = false,
  audioSource,
  paceTone = true
}) {
  const row = {
    audioSource,
    ...(audioSource === 'tone' ? { paceTone } : {}),
    queuedAudioMs,
    initialAudioDelayMs,
    keepAudioAlive,
    transport: 'owned-loopback-tcp',
    writtenVideoFrames: 0,
    writtenAudioFrames: 0,
    firstOutputMs: null,
    audioEofMs: null,
    videoEofMs: null,
    childReaped: false,
    inputProbe:
      audioSource === 'tone'
        ? 'Production raw-video input with independent lavfi tone; default format probing'
        : 'Production raw-video and SessionPCM arguments; default format probing'
  }
  const abort = new AbortController()
  const servers = [],
    serverClosed = [],
    sockets = [],
    producers = []
  let child,
    closed,
    stderr = '',
    startedAt = 0,
    exitedAt = 0
  const elapsed = () => performance.now() - startedAt
  const cancel = () => {
    row.cancelled = true
    abort.abort()
    for (const socket of sockets) socket.destroy()
    child?.kill('SIGKILL')
  }
  process.once('SIGINT', cancel)
  process.once('SIGTERM', cancel)
  async function input(kind) {
    const server = createServer((socket) => {
      sockets.push(socket)
      if (kind === 'audio')
        socket.once('close', () => {
          row.audioPipeClosedAtMs = elapsed()
        })
      socket.on('error', () => {})
      server.close()
      const producer = (async () => {
        row[`${kind}ConnectedMs`] = elapsed()
        const start = performance.now()
        if (kind === 'audio' && initialAudioDelayMs > 0)
          await delay(initialAudioDelayMs, undefined, { signal: abort.signal })
        const count = kind === 'video' ? 120 : keepAudioAlive ? 6000 : 300
        const period = kind === 'video' ? 1000 / 30 : 10
        const chunk =
          kind === 'video' ? Buffer.alloc(1280 * 720 * 1.5, 128) : Buffer.alloc(480 * 2 * 4)
        if (kind === 'video') chunk.fill(80, 0, 1280 * 720)
        else
          for (let i = 0; i < 480; i++) {
            const value = 0.2 * Math.sin((i * 2 * Math.PI * 800) / 48000)
            chunk.writeFloatLE(value, i * 8)
            chunk.writeFloatLE(value, i * 8 + 4)
          }
        for (let i = 0; i < count; i++) {
          if (kind === 'audio' && keepAudioAlive && i >= 300) chunk.fill(0)
          const wait =
            kind === 'audio' && i * period < queuedAudioMs
              ? 0
              : start + i * period - performance.now()
          if (wait > 0) await delay(wait, undefined, { signal: abort.signal })
          if (abort.signal.aborted) throw new Error('Owned probe cancelled')
          if (kind === 'audio' && keepAudioAlive && i === 300) row.captureStoppedMs = elapsed()
          await new Promise((resolve, reject) =>
            socket.write(chunk, (error) => (error ? reject(error) : resolve()))
          )
          if (kind === 'video') {
            row.writtenVideoFrames++
            if (i === 0) row.firstVideoWrittenMs = elapsed()
          } else row.writtenAudioFrames += 480
        }
        row[kind === 'video' ? 'videoEofMs' : 'audioEofMs'] = elapsed()
        if (kind === 'audio') row.captureStoppedMs = row.audioEofMs
        socket.end()
      })().catch((error) => {
        if (ownedPcmReaderClosed(row, kind, error.code)) row.audioSinkClosed = error.code
        else if (!(keepAudioAlive && kind === 'audio' && abort.signal.aborted))
          row[`${kind}ProducerError`] = error.message
      })
      producers.push(producer)
    })
    servers.push(server)
    serverClosed.push(new Promise((resolve) => server.once('close', resolve)))
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    return `tcp://127.0.0.1:${server.address().port}`
  }
  try {
    const video = await input('video')
    const audioArgs =
      audioSource === 'tone'
        ? [
            ...(paceTone ? ['-readrate', '1'] : []),
            '-f',
            'lavfi',
            '-i',
            'sine=frequency=880:sample_rate=48000'
          ]
        : [
            '-f',
            'f32le',
            '-ar',
            '48000',
            '-ac',
            '2',
            '-thread_queue_size',
            '1024',
            '-i',
            await input('audio')
          ]
    const name =
      audioSource === 'tone'
        ? `independent-tone-paced${paceTone}`
        : `stop-order-alive${keepAudioAlive}-delay${initialAudioDelayMs}`
    const media = join(output, `${name}.flv`)
    row.argv = [
      '-hide_banner',
      '-loglevel',
      'debug',
      '-n',
      '-progress',
      'pipe:1',
      '-stats_period',
      '0.1',
      '-thread_queue_size',
      '16',
      '-use_wallclock_as_timestamps',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'yuv420p',
      '-video_size',
      '1280x720',
      '-framerate',
      '30',
      '-i',
      video,
      ...audioArgs,
      '-vf',
      'setpts=PTS-STARTPTS,fps=30',
      '-c:v',
      'libopenh264',
      '-rc_mode',
      'bitrate',
      '-allow_skip_frames',
      '1',
      '-b:v',
      '6000k',
      '-maxrate',
      '6000k',
      '-bufsize',
      '12000k',
      '-g',
      '60',
      '-fps_mode',
      'vfr',
      '-af',
      audioSource === 'tone'
        ? 'aresample=async=1:first_pts=0'
        : 'aresample=async=1:first_pts=0,apad',
      '-ar',
      '48000',
      '-ac',
      '2',
      '-c:a',
      'aac',
      '-b:a',
      '160k',
      '-shortest',
      '-f',
      'flv',
      media
    ]
    startedAt = performance.now()
    child = spawn(ffmpeg, row.argv, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    closed = new Promise((resolve) => {
      child.once('error', (error) => {
        row.error = error.message
      })
      child.once('close', (code) => {
        row.exitCode = code
        row.childReaped = true
        exitedAt = performance.now()
        resolve()
      })
    })
    let progress = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      progress += chunk
      const lines = progress.split(/\r?\n/)
      progress = lines.pop().slice(-1024)
      for (const line of lines)
        if (
          /^out_time_us=\d+$/.test(line) &&
          Number(line.split('=')[1]) > 0 &&
          row.firstOutputMs === null
        )
          row.firstOutputMs = elapsed()
    })
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-2 * 1024 * 1024)
    })
    try {
      await bounded(closed, 12000)
    } catch (error) {
      row.timeout = true
      throw error
    }
    row.wallMs = exitedAt - startedAt
    row.stopMs = row.videoEofMs === null ? null : row.wallMs - row.videoEofMs
    row.overflowHeartbeats = (stderr.match(/overflow heardbeat/g) ?? []).length
    const matches = [...stderr.matchAll(/(\d+) frames in, (\d+) frames out;/g)]
    const counts = matches.at(-1)
    row.fpsInputFrames = counts ? Number(counts[1]) : null
    row.fpsOutputFrames = counts ? Number(counts[2]) : null
    const probeArgs = [
      '-v',
      'error',
      '-show_entries',
      'packet=codec_type,pts_time,duration_time',
      '-of',
      'json',
      media
    ]
    const probe = spawnSync(ffprobe, probeArgs, {
      encoding: 'utf8',
      timeout: 10000,
      killSignal: 'SIGKILL',
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true
    })
    row.probe = {
      executable: ffprobe,
      argv: probeArgs,
      exitCode: probe.status,
      signal: probe.signal,
      error: probe.error?.message ?? null,
      stderr: (probe.stderr ?? '').slice(-64000)
    }
    if (probe.status !== 0 || probe.error) throw new Error('Bounded EOF artifact probe failed')
    const packets = JSON.parse(probe.stdout).packets
    row.encodedVideoFrames = packets.filter((packet) => packet.codec_type === 'video').length
    row.packetTail = incidentPacketTail(packets)
    const starts = ['video', 'audio'].map((kind) =>
      Math.min(
        ...packets
          .filter((packet) => packet.codec_type === kind)
          .map((packet) => Number(packet.pts_time))
      )
    )
    row.startSkewMs = Math.abs(starts[0] - starts[1]) * 1000
  } catch (error) {
    row.error = error.message
  } finally {
    process.removeListener('SIGINT', cancel)
    process.removeListener('SIGTERM', cancel)
    abort.abort()
    if (child && !row.childReaped) {
      child.kill('SIGKILL')
      try {
        await bounded(closed, 2000)
      } catch {
        row.unsafeCleanup = true
      }
    }
    for (const socket of sockets) socket.destroy()
    for (const server of servers) if (server.listening) server.close()
    try {
      await bounded(Promise.allSettled(producers), 1000)
    } catch {
      row.unsafeCleanup = true
    }
    try {
      await bounded(Promise.all(serverClosed), 1000)
      row.inputsClosed = true
    } catch {
      row.unsafeCleanup = true
    }
    writeFileSync(
      join(
        output,
        audioSource === 'tone'
          ? `independent-tone-paced${paceTone}.stderr.log`
          : `stop-order-alive${keepAudioAlive}-delay${initialAudioDelayMs}.stderr.log`
      ),
      stderr
    )
  }
  row.verdict = audioSource === 'tone' ? independentToneEofVerdict(row) : ownedPcmEofVerdict(row)
  return row
}
