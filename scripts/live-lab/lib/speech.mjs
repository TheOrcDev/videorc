import { spawn } from 'node:child_process'
import { appendFile, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { LAB_SPEECH_SINK, parsePulseDevices } from './linux-desktop.mjs'
import { isLinux } from './platform.mjs'

// Plan 178 U7 (plan 176 L3 step 2). Scripted speech for the live lab:
// `say -o` renders a phrase to an AIFF file once, then the harness plays it
// into the BlackHole virtual device, which Videorc uses as its microphone.
// Each play is logged with its timestamp so caption and voice-command
// latency can be measured against the app's journal.
//
// Playback uses ffmpeg's AudioToolbox output (`-f audiotoolbox
// -audio_device_index N`): ffmpeg is already a lab dependency (measure-av-
// sync, recording-analyzer), `afplay` cannot pick a device, and changing the
// system output with SwitchAudioSource would also move the card's click.

export const DEFAULT_DEVICE = 'BlackHole 2ch'
// Plan 179: on Linux `espeak-ng -w` renders a WAV and ffmpeg's PulseAudio
// output plays it into the lab speech sink, whose remap source is the lab
// mic (linux-desktop.mjs). The sink is named, so no index lookup is needed.
export const LINUX_DEFAULT_DEVICE = LAB_SPEECH_SINK

export function defaultSpeechDevice(platform = process.platform) {
  return isLinux(platform) ? LINUX_DEFAULT_DEVICE : DEFAULT_DEVICE
}

/** File extension of a rendered phrase: AIFF from say, WAV from espeak-ng. */
export function speechFileExtension(platform = process.platform) {
  return isLinux(platform) ? 'wav' : 'aiff'
}
export const PHRASES_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'phrases.json')

export const PULSE_INTERVAL_MS = 10_000
export const PULSE_GUARD_MS = 1_000

/**
 * Milliseconds to wait before playing a phrase of `durationMs` so it starts
 * and ends at least `guardMs` away from the card's 10 s sync pulses. The
 * stream mixes the mic in, and measure-av-sync pairs any onset within 500 ms
 * of a flash, so speech near a pulse would corrupt the sync measurement.
 * Throws when the phrase cannot fit between two pulses.
 */
export function speechStartDelay(
  nowMs,
  durationMs,
  { interval = PULSE_INTERVAL_MS, guardMs = PULSE_GUARD_MS } = {}
) {
  if (durationMs + guardMs * 2 > interval) {
    throw new Error(`a ${durationMs} ms phrase cannot fit between ${interval} ms sync pulses`)
  }
  const phase = nowMs % interval
  const latestStart = interval - guardMs - durationMs
  if (phase >= guardMs && phase <= latestStart) return 0
  return phase < guardMs ? guardMs - phase : interval - phase + guardMs
}

/** Runs a command; resolves { code, stdout, stderr }. Never rejects on exit code. */
export function defaultRunner(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('error', rejectRun)
    child.on('close', (code) => resolveRun({ code, stdout, stderr }))
  })
}

export async function loadPhrases(path = PHRASES_PATH) {
  const phrases = JSON.parse(await readFile(path, 'utf8'))
  if (phrases.schemaVersion !== 1)
    throw new Error(`unsupported phrases schema ${phrases.schemaVersion}`)
  return phrases
}

/**
 * Renders `text` to `outPath` (AIFF) with macOS `say`. `voice` and `rate`
 * (words per minute) are optional; the default system voice is fine.
 */
export async function renderPhrase(
  text,
  outPath,
  { runner = defaultRunner, voice, rate, platform = process.platform } = {}
) {
  if (typeof text !== 'string' || text.trim() === '') throw new Error('phrase text is empty')
  if (isLinux(platform)) {
    const args = ['-w', outPath, '-v', voice ?? 'en-us']
    if (Number.isFinite(rate)) args.push('-s', String(rate))
    args.push('--', text)
    const result = await runner('espeak-ng', args)
    if (result.code !== 0) {
      throw new Error(
        `espeak-ng exited ${result.code}: ${String(result.stderr).trim().slice(0, 200)}`
      )
    }
    return { file: outPath, text }
  }
  const args = ['-o', outPath]
  if (voice) args.push('-v', voice)
  if (Number.isFinite(rate)) args.push('-r', String(rate))
  args.push('--', text)
  const result = await runner('say', args)
  if (result.code !== 0) {
    throw new Error(`say exited ${result.code}: ${String(result.stderr).trim().slice(0, 200)}`)
  }
  return { file: outPath, text }
}

/** Parses ffmpeg's AudioToolbox device list (`[N]   Name, UID`). */
export function parseAudioToolboxDevices(stderr) {
  const devices = []
  for (const line of String(stderr).split(/\r?\n/)) {
    const match = /\]\s*\[(\d+)\]\s+(.+)$/.exec(line)
    if (!match) continue
    const rest = match[2].trim()
    const comma = rest.lastIndexOf(', ')
    devices.push({
      index: Number(match[1]),
      name: comma === -1 ? rest : rest.slice(0, comma).trim(),
      uid: comma === -1 ? null : rest.slice(comma + 2).trim()
    })
  }
  return devices
}

/**
 * The AudioToolbox index of an output device by its macOS name. Lists with
 * an impossible index so ffmpeg prints the devices and exits without playing.
 */
export async function findAudioDeviceIndex(
  name,
  { runner = defaultRunner, ffmpegPath = 'ffmpeg' } = {}
) {
  const result = await runner(ffmpegPath, [
    '-hide_banner',
    '-nostdin',
    '-f',
    'lavfi',
    '-i',
    'anullsrc=r=48000:cl=stereo',
    '-t',
    '0.01',
    '-f',
    'audiotoolbox',
    '-list_devices',
    'true',
    '-audio_device_index',
    '2147483647',
    '-'
  ])
  const devices = parseAudioToolboxDevices(result.stderr)
  const device = devices.find((entry) => entry.name === name)
  if (!device) {
    const known = devices.map((entry) => entry.name).join(', ') || 'none'
    throw new Error(
      `audio device "${name}" not found (ffmpeg sees: ${known}). Install it with brew install blackhole-2ch.`
    )
  }
  return device.index
}

/**
 * Plan 179: throws unless ffmpeg's PulseAudio output lists `sink` (the lab
 * speech sink), with the fix in the message.
 */
export async function assertPulseSink(
  sink = LINUX_DEFAULT_DEVICE,
  { runner = defaultRunner, ffmpegPath = 'ffmpeg' } = {}
) {
  const result = await runner(ffmpegPath, ['-hide_banner', '-sinks', 'pulse'])
  const sinks = parsePulseDevices(`${result.stdout}\n${result.stderr}`, { dropMonitors: false })
  if (!sinks.some((entry) => entry.name === sink)) {
    const known = sinks.map((entry) => entry.name).join(', ') || 'none'
    throw new Error(
      `PulseAudio sink "${sink}" not found (ffmpeg sees: ${known}). Load it from config/live-lab/linux/pipewire-pulse.videorc-lab.conf.`
    )
  }
  return sink
}

/**
 * Plays a rendered phrase into `device` in real time and logs
 * `{ phraseId, text, playedAt, endedAt, device }`. `playedAt` is taken just
 * before ffmpeg starts; audio follows within ffmpeg's startup (under ~150 ms
 * on the lab Mac), which the latency budget absorbs. The log record holds no
 * file path (run folders live under the home dir).
 *
 * `log` is a function or an NDJSON file path. `deviceIndex` skips the lookup.
 */
export async function playPhrase({
  file,
  device = DEFAULT_DEVICE,
  phraseId = null,
  text = null,
  deviceIndex,
  runner = defaultRunner,
  ffmpegPath = 'ffmpeg',
  now = () => new Date(),
  log,
  platform = process.platform
}) {
  if (typeof file !== 'string' || file === '') throw new Error('playPhrase needs a rendered file')
  const linux = isLinux(platform)
  const index =
    linux || Number.isInteger(deviceIndex)
      ? deviceIndex
      : await findAudioDeviceIndex(device, { runner, ffmpegPath })
  const output = linux
    ? ['-f', 'pulse', '-device', device, 'videorc-lab-speech']
    : ['-f', 'audiotoolbox', '-audio_device_index', String(index), '-']
  const playedAt = now().toISOString()
  const result = await runner(ffmpegPath, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-re',
    '-i',
    file,
    '-ar',
    '48000',
    '-ac',
    '2',
    ...output
  ])
  if (result.code !== 0) {
    throw new Error(
      `ffmpeg playback exited ${result.code}: ${String(result.stderr).trim().slice(0, 200)}`
    )
  }
  const record = { phraseId, text, playedAt, endedAt: now().toISOString(), device }
  if (typeof log === 'function') await log(record)
  else if (typeof log === 'string') await appendFile(log, `${JSON.stringify(record)}\n`)
  return record
}
