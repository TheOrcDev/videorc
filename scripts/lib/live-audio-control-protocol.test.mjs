import assert from 'node:assert/strict'
import test from 'node:test'

import { successfulLiveCommandReplies } from './live-audio-control-protocol.mjs'

test('counts successful FFmpeg command replies by their stable suffix', () => {
  assert.equal(
    successfulLiveCommandReplies(
      'Command reply for stream -1: ret:0 res:\nCommand reply for stream -1: ret:0 res:\n'
    ).length,
    2
  )
})

test('survives stats output interleaved into the command reply prefix', () => {
  assert.equal(
    successfulLiveCommandReplies(
      'Command reply forbitrate=733.6kbits/s\r\nprogress=continue\r\n stream -1: ret:0 res:\n'
    ).length,
    1
  )
})
