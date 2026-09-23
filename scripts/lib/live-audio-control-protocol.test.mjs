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

test('separate progress pipe cannot split an acknowledgement even with interleaved partial reads', async () => {
  const { liveAudioProtocolStreams } = await import('./live-audio-control-protocol.mjs')
  const events = []
  const streams = liveAudioProtocolStreams({
    reply: () => events.push('reply'),
    progress: () => events.push('progress')
  })
  streams.push('stderr', 'Command reply for stream -1: re')
  streams.push('stdout', 'out_time_us=2000000\nprogress=cont')
  streams.push('stderr', 't:0 r')
  streams.push('stdout', 'inue\n')
  streams.push('stderr', 'es:\nCommand reply for stream -1: ret:0 res:')
  streams.finish()
  assert.deepEqual(events, ['progress', 'reply', 'reply'])
})

test('wrong-pipe or corrupted protocol records do not become successful replies', async () => {
  const { liveAudioProtocolStreams } = await import('./live-audio-control-protocol.mjs')
  const events = []
  const streams = liveAudioProtocolStreams({
    reply: () => events.push('reply'),
    progress: () => events.push('progress')
  })
  streams.push('stdout', 'ret:0 res:\n')
  streams.push('stderr', 'progress=continue\net:0 res:\nret:-1 res:failed\n')
  streams.finish()
  assert.deepEqual(events, [])
})
