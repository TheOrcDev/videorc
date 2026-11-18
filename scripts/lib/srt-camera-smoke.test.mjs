import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  SRT_SMOKE_RESERVED_PORTS,
  classifyCameraPicture,
  classifyTint,
  libsrtCandidates,
  pairingAccepted,
  pairingLeft,
  otherLocalAddress,
  countLines,
  newSenderDecoding,
  sameSenderDecoding,
  senderPictureOnOutput,
  steadyFeed,
  srtCallerUrl
} from './srt-camera-smoke.mjs'

test('the smoke never uses port 9000 or 9100', () => {
  assert.deepEqual(SRT_SMOKE_RESERVED_PORTS, [9000, 9100])
})

test('the caller URL carries the passphrase, escaped', () => {
  assert.equal(srtCallerUrl(45678, 'a-b_c'), 'srt://127.0.0.1:45678?mode=caller&passphrase=a-b_c')
  assert.equal(srtCallerUrl(1, 'a b'), 'srt://127.0.0.1:1?mode=caller&passphrase=a%20b')
})

test('the staged libsrt comes before Homebrew', () => {
  const [staged, homebrew] = libsrtCandidates('/repo')
  assert.equal(staged, '/repo/vendor/libsrt/current/lib/libsrt.dylib')
  assert.equal(homebrew, '/opt/homebrew/opt/srt/lib/libsrt.dylib')
})

test('the still and the picture are told apart', () => {
  assert.equal(classifyCameraPicture({ meanLuma: 30, chroma: 3 }), 'still')
  assert.equal(classifyCameraPicture({ meanLuma: 120, chroma: 90 }), 'picture')
  assert.equal(classifyCameraPicture({ meanLuma: 40, chroma: 40 }), 'picture')
  assert.equal(classifyCameraPicture({ meanLuma: 50, chroma: 20 }), 'unknown')
})

test('the tint tells a red picture from a neutral one', () => {
  assert.equal(classifyTint({ meanR: 127, meanG: 32, meanB: 32 }), 'red')
  assert.equal(classifyTint({ meanR: 127, meanG: 129, meanB: 126 }), 'neutral')
  assert.equal(classifyTint({ meanR: 20, meanG: 20, meanB: 20 }), 'neutral')
})

test("a new sender's picture is back only once the output shows its own tint", () => {
  const decoding = { signal: 'receiving', senderSession: 4, framesDecoded: 12 }
  const red = { meanLuma: 60, chroma: 95, meanR: 127, meanG: 32, meanB: 32 }
  const neutral = { meanLuma: 128, chroma: 90, meanR: 127, meanG: 129, meanB: 126 }
  const still = { meanLuma: 30, chroma: 3, meanR: 30, meanG: 30, meanB: 30 }
  assert.equal(senderPictureOnOutput(decoding, 3, red, 'red'), true)
  assert.equal(
    senderPictureOnOutput(decoding, 3, neutral, 'red'),
    false,
    'the output still shows the last sender'
  )
  assert.equal(
    senderPictureOnOutput(decoding, 3, still, 'neutral'),
    false,
    'the still is no picture'
  )
  assert.equal(senderPictureOnOutput(decoding, 3, null, 'red'), false, 'no sample yet')
  assert.equal(
    senderPictureOnOutput({ ...decoding, senderSession: 3 }, 3, red, 'red'),
    false,
    'the old session still decoding'
  )
})

test('a pairing check counts only once the camera accepted it, and left only once it is gone', () => {
  const waiting = { listening: true, signal: 'waiting', detail: 'Waiting' }
  assert.equal(pairingAccepted({ ...waiting, senderConnected: false }), false)
  assert.equal(pairingAccepted({ ...waiting, senderConnected: true }), true)
  assert.equal(
    pairingAccepted({ ...waiting, signal: 'receiving', senderConnected: true }),
    false,
    'a pairing check sends no frame'
  )
  assert.equal(pairingLeft({ ...waiting, senderConnected: true }), false)
  assert.equal(pairingLeft({ ...waiting, senderConnected: false }), true)
  assert.equal(pairingLeft({ ...waiting }), false, 'a status without the field proves nothing')
})

test('a caller can dial another local address', () => {
  assert.equal(
    srtCallerUrl(45678, 'p', '192.168.1.20'),
    'srt://192.168.1.20:45678?mode=caller&passphrase=p'
  )
})

test('the second address is a real local IPv4 address, never loopback or a link-local link', () => {
  const interfaces = {
    lo0: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    en9: [{ family: 'IPv4', address: '169.254.10.2', internal: false }],
    en0: [
      { family: 'IPv6', address: 'fe80::1', internal: false },
      { family: 'IPv4', address: '192.168.1.20', internal: false }
    ]
  }
  assert.equal(otherLocalAddress(interfaces), '192.168.1.20')
  assert.equal(otherLocalAddress({ lo0: interfaces.lo0, en9: interfaces.en9 }), null)
})

test('resource counts skip the header line', () => {
  assert.equal(countLines('USER PID TT\nsomeone 1 x\nsomeone 1 y\n'), 2)
  assert.equal(countLines(''), 0)
})

test('a clean feed decodes at the source rate the whole stretch; a damaged one does not', () => {
  const at = (fps, signal = 'receiving') => ({ signal, fps })
  assert.equal(steadyFeed([at(25), at(24), at(26)], 25), true)
  // A damaged feed: bursts at key frames and holds in between.
  assert.equal(steadyFeed([at(25), at(76), at(25)], 25), false)
  assert.equal(steadyFeed([at(25), at(undefined, 'holding'), at(25)], 25), false)
  assert.equal(steadyFeed([], 25), false)
})

test('a new sender counts only with frames of its own, never the last picture still looking live', () => {
  const status = (senderSession, framesDecoded, signal = 'receiving') => ({
    signal,
    senderSession,
    framesDecoded
  })
  // Right after a sender change the old picture still looks live: the new
  // session has no frames yet.
  assert.equal(newSenderDecoding(status(3, 0), 2), false)
  assert.equal(newSenderDecoding(status(2, 400), 2), false, 'the old sender is not the new one')
  assert.equal(newSenderDecoding(status(3, 5), 2), true)
  assert.equal(newSenderDecoding(status(3, 5, 'holding'), 2), false)
})

test('the same sender is back only with new frames in its own session', () => {
  const before = { signal: 'holding', senderSession: 4, framesDecoded: 100 }
  assert.equal(
    sameSenderDecoding({ signal: 'receiving', senderSession: 4, framesDecoded: 101 }, before),
    false
  )
  assert.equal(
    sameSenderDecoding({ signal: 'receiving', senderSession: 4, framesDecoded: 110 }, before),
    true
  )
  assert.equal(
    sameSenderDecoding({ signal: 'receiving', senderSession: 5, framesDecoded: 110 }, before),
    false,
    'a reconnect is not the stalled sender coming back'
  )
})
