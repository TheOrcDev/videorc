import assert from 'node:assert/strict'
import { connect as netConnect, createServer as createNetServer } from 'node:net'
import { describe, it } from 'node:test'

import {
  RTMP_END_MARKERS,
  evaluateTapAfterLegsEnd,
  scanRtmpEndMarkers,
  startRtmpTap,
  tapConnections
} from './rtmp-tap.mjs'

function amf0String(name) {
  const buffer = Buffer.alloc(3 + name.length)
  buffer[0] = 0x02
  buffer.writeUInt16BE(name.length, 1)
  buffer.write(name, 3, 'latin1')
  return buffer
}

describe('rtmp tap: the publisher’s clean end', () => {
  it('finds each AMF0 end marker once, across chunk boundaries', () => {
    const state = { tail: Buffer.alloc(0), seen: new Set() }
    const unpublish = amf0String('FCUnpublish')
    assert.deepEqual(scanRtmpEndMarkers(Buffer.from('video bytes'), state), [])
    // Split the marker over two chunks.
    assert.deepEqual(scanRtmpEndMarkers(unpublish.subarray(0, 5), state), [])
    assert.deepEqual(scanRtmpEndMarkers(unpublish.subarray(5), state), ['FCUnpublish'])
    assert.deepEqual(scanRtmpEndMarkers(unpublish, state), [], 'each marker once')
    assert.deepEqual(scanRtmpEndMarkers(amf0String('deleteStream'), state), ['deleteStream'])
    // A bare string without the AMF0 type and length is not a marker.
    const fresh = { tail: Buffer.alloc(0), seen: new Set() }
    assert.deepEqual(scanRtmpEndMarkers(Buffer.from('FCUnpublish deleteStream'), fresh), [])
    assert.deepEqual(RTMP_END_MARKERS, ['FCUnpublish', 'deleteStream'])
  })

  it('reads a clean legs.end and names a killed publisher', () => {
    const events = [
      { atMs: 1000, kind: 'open', conn: 1 },
      { atMs: 5000, kind: 'marker', conn: 1, name: 'FCUnpublish' },
      { atMs: 5001, kind: 'marker', conn: 1, name: 'deleteStream' },
      { atMs: 5200, kind: 'close', conn: 1, by: 'client', bytes: 123456 },
      { atMs: 9000, kind: 'open', conn: 2 }
    ]
    const connections = tapConnections(events)
    assert.equal(connections.length, 2)
    assert.deepEqual(connections[0].markers, ['FCUnpublish', 'deleteStream'])
    const clean = evaluateTapAfterLegsEnd(events, { sentAtMs: 4900 })
    assert.equal(clean.ok, true, clean.problems.join('; '))
    assert.equal(clean.ended.closeAfterMs, 300)
    assert.equal(clean.backConnected, true)
    const killed = evaluateTapAfterLegsEnd(
      [
        { atMs: 1000, kind: 'open', conn: 1 },
        { atMs: 5200, kind: 'close', conn: 1, by: 'reset', bytes: 10 }
      ],
      { sentAtMs: 4900 }
    )
    assert.equal(killed.ok, false)
    assert.ok(killed.problems.some((problem) => problem.includes('FCUnpublish')))
    assert.ok(killed.problems.some((problem) => problem.includes('closed by reset')))
    assert.equal(killed.backConnected, false)
    const slow = evaluateTapAfterLegsEnd(
      [
        { atMs: 1000, kind: 'open', conn: 1 },
        { atMs: 5000, kind: 'marker', conn: 1, name: 'FCUnpublish' },
        { atMs: 5001, kind: 'marker', conn: 1, name: 'deleteStream' },
        { atMs: 9000, kind: 'close', conn: 1, by: 'client', bytes: 1 }
      ],
      { sentAtMs: 4900 }
    )
    assert.equal(slow.ok, false)
    assert.ok(slow.problems[0].includes('over 3500'))
    assert.equal(evaluateTapAfterLegsEnd([], { sentAtMs: 1 }).ok, false)
  })

  it('forwards bytes both ways and logs the markers and the close on the wire', async () => {
    const received = []
    const upstream = createNetServer((socket) => {
      socket.on('data', (chunk) => {
        received.push(chunk)
        socket.write('ack')
      })
      // A receiver hangs up once it read the publisher's EOF, as FFmpeg does.
      socket.on('end', () => socket.end())
    })
    await new Promise((resolveListen) => upstream.listen(0, '127.0.0.1', resolveListen))
    const targetPort = upstream.address().port
    const free = createNetServer()
    await new Promise((resolveListen) => free.listen(0, '127.0.0.1', resolveListen))
    const listenPort = free.address().port
    await new Promise((resolveClose) => free.close(resolveClose))
    const tap = await startRtmpTap({ listenPort, targetPort })
    try {
      const client = netConnect({ host: '127.0.0.1', port: listenPort })
      client.on('error', () => {})
      await new Promise((resolveConnect) => client.once('connect', resolveConnect))
      const answered = new Promise((resolveData) => client.once('data', resolveData))
      client.write(Buffer.concat([Buffer.from('frames'), amf0String('FCUnpublish')]))
      assert.equal((await answered).toString(), 'ack')
      client.write(amf0String('deleteStream'))
      client.end()
      await new Promise((resolveClose) => client.once('close', resolveClose))
      const deadline = Date.now() + 3000
      while (!tap.events.some((event) => event.kind === 'close') && Date.now() < deadline) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 20))
      }
      const [connection] = tapConnections(tap.events)
      assert.deepEqual(connection.markers, ['FCUnpublish', 'deleteStream'])
      assert.equal(connection.closedBy, 'client')
      assert.ok(connection.bytes > 0)
      assert.ok(Buffer.concat(received).includes('frames'))
    } finally {
      await tap.close()
      await new Promise((resolveClose) => upstream.close(resolveClose))
    }
  })
})
