import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  LINUX_PULSE_MICROPHONE_PREFIX,
  LINUX_ROOM_SINK,
  LINUX_ROOM_SOURCE,
  linuxPulseMicrophoneId,
  linuxRoomMicrophoneId,
  linuxRoomToneArgs
} from './room-linux-microphone.mjs'

test('a Pulse source id is the backend prefix and the hex of the source name', () => {
  // `linux_pulse_microphone_id` in the backend: prefix + hex(name).
  assert.equal(
    linuxPulseMicrophoneId('videorc_room_host_mic'),
    `${LINUX_PULSE_MICROPHONE_PREFIX}766964656f72635f726f6f6d5f686f73745f6d6963`
  )
  assert.equal(linuxRoomMicrophoneId(), linuxPulseMicrophoneId(LINUX_ROOM_SOURCE))
})

test('the room microphone is a plain source: not a monitor, no default alias', () => {
  // The backend's room refuses `.monitor` sources and `default`.
  assert.ok(!LINUX_ROOM_SOURCE.endsWith('.monitor'))
  assert.notEqual(LINUX_ROOM_SOURCE, 'default')
  assert.ok(!LINUX_ROOM_SOURCE.startsWith('@') && !LINUX_ROOM_SOURCE.startsWith('-'))
})

test("the host's tone loops in real time into the null sink", () => {
  const args = linuxRoomToneArgs('/tmp/host.wav')
  assert.ok(args.includes('-re'))
  assert.equal(args[args.indexOf('-stream_loop') + 1], '-1')
  assert.equal(args[args.indexOf('-i') + 1], '/tmp/host.wav')
  assert.equal(args[args.indexOf('-device') + 1], LINUX_ROOM_SINK)
  assert.equal(args[args.indexOf('-f') + 1], 'pulse')
})
