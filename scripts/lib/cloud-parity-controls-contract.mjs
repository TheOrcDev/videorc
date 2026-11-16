import assert from 'node:assert/strict'
import { MEDIA } from './cloud-parity-media.mjs'

export const CONTROL_LANES = ['tile', 'mixer', 'hotkey', 'deck', 'phone', 'agent']
/** A successful command alone cannot prove mute. Read decoded program PCM. */
export function assertControlAudio(captures, muted) {
  const program = captures.find((capture) => capture.name === 'program')
  assert.ok(program, 'A decoded program audio capture is required')
  assert.equal(program.settledAfterMs, 1000, 'A bounded one-second settlement window is required')
  assert.ok(Number.isFinite(program.settledTones?.host), 'Host tone measurement is required')
  assert.ok(
    muted
      ? program.settledTones.host < MEDIA.analysis.absentDbfs
      : program.settledTones.host > MEDIA.analysis.audibleDbfs,
    muted ? 'The host microphone still reaches the program' : 'The host microphone did not return'
  )
  for (const guest of ['guest1', 'guest2'])
    assert.ok(
      program.settledTones[guest] > MEDIA.analysis.audibleDbfs,
      `${guest} must remain audible during host mute`
    )
}
export function assertIndependentStop(status, stopped) {
  assert.equal(status.room?.phase, 'open', 'Stop must keep the room open')
  assert.equal(status.recording?.active, stopped !== 'recording')
  assert.equal(status.room?.live, stopped !== 'live')
}
