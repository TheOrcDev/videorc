import { spawnSync } from 'node:child_process'

/**
 * Plan 260 S1.8 (rooms on Linux): the backend-host talk-show smoke's host
 * microphone. macOS names the synthetic CoreAudio device; Linux has no such
 * device, so the smoke gives the backend a real PulseAudio source instead: a
 * null sink with a remapped (non-monitor) source on top, which the host's
 * tone wav is played into. The backend lists and opens it the way it opens a
 * USB microphone (`linux_pulse_audio`: FFmpeg `-f pulse`).
 *
 * Both modules are loaded on the user's PipeWire-pulse server and unloaded
 * again by `unloadLinuxRoomMicrophone`; nothing else on the server is touched.
 */

export const LINUX_ROOM_SINK = 'videorc_room_tone'
export const LINUX_ROOM_SOURCE = 'videorc_room_host_mic'
export const LINUX_PULSE_MICROPHONE_PREFIX = 'microphone:linux-pulse:'

/** The device id the backend uses for a Pulse source (`linux_pulse_microphone_id`). */
export function linuxPulseMicrophoneId(sourceName) {
  return `${LINUX_PULSE_MICROPHONE_PREFIX}${Buffer.from(sourceName, 'utf8').toString('hex')}`
}

export function linuxRoomMicrophoneId() {
  return linuxPulseMicrophoneId(LINUX_ROOM_SOURCE)
}

function pactl(args, env) {
  const result = spawnSync('pactl', args, { encoding: 'utf8', env })
  if (result.status !== 0) {
    throw new Error(
      `pactl ${args.join(' ')} failed (${result.status ?? result.error?.message}): ${String(result.stderr ?? '').trim()}`
    )
  }
  return String(result.stdout).trim()
}

/**
 * Loads the null sink and the remapped source. Returns the module ids to
 * unload. Throws when `pactl` cannot reach a Pulse server, so the smoke says
 * so instead of timing out at a missing microphone.
 */
export function loadLinuxRoomMicrophone({ env = process.env } = {}) {
  // A leftover pair from a killed run would make the second load fail by name.
  unloadLinuxRoomMicrophone({ env })
  const sink = pactl(
    [
      'load-module',
      'module-null-sink',
      `sink_name=${LINUX_ROOM_SINK}`,
      'channels=2',
      'rate=48000',
      `sink_properties=device.description=Videorc_room_tone`
    ],
    env
  )
  let source
  try {
    source = pactl(
      [
        'load-module',
        'module-remap-source',
        `source_name=${LINUX_ROOM_SOURCE}`,
        `master=${LINUX_ROOM_SINK}.monitor`,
        `source_properties=device.description=Videorc_room_host_microphone`
      ],
      env
    )
  } catch (error) {
    pactl(['unload-module', sink], env)
    throw error
  }
  return { sink, source }
}

/** Unloads this smoke's two modules by name, whichever run loaded them. */
export function unloadLinuxRoomMicrophone({ env = process.env } = {}) {
  const listing = spawnSync('pactl', ['list', 'short', 'modules'], { encoding: 'utf8', env })
  if (listing.status !== 0) return
  const ids = []
  for (const line of String(listing.stdout).split('\n')) {
    const [id, name, args = ''] = line.split('\t')
    if (
      (name === 'module-remap-source' && args.includes(`source_name=${LINUX_ROOM_SOURCE}`)) ||
      (name === 'module-null-sink' && args.includes(`sink_name=${LINUX_ROOM_SINK}`))
    ) {
      ids.push(id)
    }
  }
  // The source sits on the sink's monitor, so it goes first.
  for (const id of ids.reverse()) spawnSync('pactl', ['unload-module', id], { env })
}

/** FFmpeg arguments that loop the host's tone wav into the null sink at real time. */
export function linuxRoomToneArgs(wavPath) {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-re',
    '-stream_loop',
    '-1',
    '-i',
    wavPath,
    '-f',
    'pulse',
    '-device',
    LINUX_ROOM_SINK,
    'videorc-room-host-tone'
  ]
}
