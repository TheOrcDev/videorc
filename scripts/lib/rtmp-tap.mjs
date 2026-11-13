import { connect as netConnect, createServer as createNetServer } from 'node:net'

/**
 * A transparent TCP tap in front of a local RTMP receiver (plan 224 S-G1,
 * the `legs.end` check; the runner harness's `rtmp-tap.py`). It forwards
 * every byte both ways and records, per connection, when the publisher sent
 * `FCUnpublish` and `deleteStream` (the AMF0 command strings FFmpeg's RTMP
 * client sends from `rtmp_close` before it closes the socket: the clean end
 * that makes a platform end the broadcast) and how the connection closed. A
 * publisher that is killed closes without them.
 *
 * `events` is the log: `{ atMs, kind: 'open'|'marker'|'close', conn, name?,
 * by?, bytes? }`. `close.by` is `client` (the publisher sent EOF), `reset`
 * (the publisher's socket broke) or `upstream` (the receiver closed first).
 */
export const RTMP_END_MARKERS = Object.freeze(['FCUnpublish', 'deleteStream'])

const NEEDLES = RTMP_END_MARKERS.map((name) => ({
  name,
  bytes: Buffer.concat([Buffer.from([0x02]), uint16(name.length), Buffer.from(name, 'latin1')])
}))
const OVERLAP = Math.max(...NEEDLES.map((needle) => needle.bytes.length))

function uint16(value) {
  const buffer = Buffer.alloc(2)
  buffer.writeUInt16BE(value)
  return buffer
}

/** The end markers found in a byte stream, in order, each once (pure; `tail` carries the overlap). */
export function scanRtmpEndMarkers(chunk, state = { tail: Buffer.alloc(0), seen: new Set() }) {
  const window = Buffer.concat([state.tail, chunk])
  const found = []
  for (const needle of NEEDLES) {
    if (state.seen.has(needle.name)) continue
    if (window.indexOf(needle.bytes) !== -1) {
      state.seen.add(needle.name)
      found.push(needle.name)
    }
  }
  state.tail = window.subarray(Math.max(0, window.length - OVERLAP))
  return found
}

/**
 * Per-connection facts from a tap's events (pure): when it opened, which
 * markers the publisher sent, when and how it closed.
 */
export function tapConnections(events) {
  const connections = new Map()
  for (const event of events) {
    if (event.kind === 'open') {
      connections.set(event.conn, {
        conn: event.conn,
        openedAtMs: event.atMs,
        markers: [],
        closedAtMs: null,
        closedBy: null,
        bytes: 0
      })
      continue
    }
    const connection = connections.get(event.conn)
    if (!connection) continue
    if (event.kind === 'marker') connection.markers.push(event.name)
    if (event.kind === 'close') {
      connection.closedAtMs = event.atMs
      connection.closedBy = event.by
      connection.bytes = event.bytes ?? 0
    }
  }
  return [...connections.values()]
}

/**
 * The `legs.end` verdict for one tap (pure): the connection open when the
 * intent went out ended with both markers, closed by the publisher within
 * `maxCloseMs`, and a later connection (Go Live again) opened after it.
 */
export function evaluateTapAfterLegsEnd(events, { sentAtMs, maxCloseMs = 3500 }) {
  const connections = tapConnections(events)
  const open = connections.filter((connection) => connection.openedAtMs <= sentAtMs)
  const ended = open.at(-1) ?? null
  const back = connections.find((connection) => connection.openedAtMs > sentAtMs) ?? null
  const problems = []
  if (!ended) problems.push('no connection was open when legs.end went out')
  else {
    for (const marker of RTMP_END_MARKERS) {
      if (!ended.markers.includes(marker)) problems.push(`the publisher sent no ${marker}`)
    }
    if (ended.closedAtMs === null) problems.push('the connection never closed')
    else if (ended.closedBy !== 'client')
      problems.push(`closed by ${ended.closedBy}, not the publisher`)
    else if (ended.closedAtMs - sentAtMs > maxCloseMs) {
      problems.push(`closed ${ended.closedAtMs - sentAtMs} ms after legs.end, over ${maxCloseMs}`)
    }
  }
  return {
    ok: problems.length === 0,
    problems,
    ended: ended
      ? {
          conn: ended.conn,
          markers: ended.markers,
          closedBy: ended.closedBy,
          closeAfterMs: ended.closedAtMs === null ? null : ended.closedAtMs - sentAtMs
        }
      : null,
    backConnected: back !== null
  }
}

/**
 * Starts a tap on `listenPort` forwarding to `127.0.0.1:targetPort`. Every
 * connection is piped as it comes; nothing is buffered beyond the marker
 * overlap. `close()` ends the listener and every open pipe.
 */
export function startRtmpTap({ listenPort, targetPort, onEvent = null }) {
  const events = []
  const sockets = new Set()
  let counter = 0
  const record = (event) => {
    events.push(event)
    onEvent?.(event)
  }
  const server = createNetServer((client) => {
    counter += 1
    const conn = counter
    record({ atMs: Date.now(), kind: 'open', conn })
    const scan = { tail: Buffer.alloc(0), seen: new Set() }
    let bytes = 0
    let closed = false
    let clientEnded = false
    const upstream = netConnect({ host: '127.0.0.1', port: targetPort })
    sockets.add(client)
    sockets.add(upstream)
    // Who ended the connection: the publisher's EOF wins whatever closes
    // after it (a receiver that hangs up once it read the end is still a
    // clean, publisher-initiated end).
    const finish = (by) => {
      if (closed) return
      closed = true
      const how = clientEnded ? 'client' : by
      record({ atMs: Date.now(), kind: 'close', conn, by: how, bytes })
      if (how === 'client') {
        client.end()
        upstream.end()
      } else {
        client.destroy()
        upstream.destroy()
      }
      sockets.delete(client)
      sockets.delete(upstream)
    }
    client.on('data', (chunk) => {
      bytes += chunk.length
      for (const name of scanRtmpEndMarkers(chunk, scan)) {
        record({ atMs: Date.now(), kind: 'marker', conn, name })
      }
      if (!upstream.write(chunk)) client.pause()
    })
    upstream.on('drain', () => client.resume())
    upstream.on('data', (chunk) => {
      if (!client.write(chunk)) upstream.pause()
    })
    client.on('drain', () => upstream.resume())
    client.on('end', () => {
      // The publisher said EOF: let the receiver see it, then close.
      clientEnded = true
      upstream.end()
      setTimeout(() => finish('client'), 200).unref()
    })
    client.on('error', () => finish('reset'))
    client.on('close', () => finish('reset'))
    upstream.on('end', () => finish('upstream'))
    upstream.on('error', () => finish('upstream-refused'))
    upstream.on('close', () => finish('upstream'))
  })
  return new Promise((resolveStart, rejectStart) => {
    server.once('error', rejectStart)
    server.listen(listenPort, '127.0.0.1', () => {
      server.off('error', rejectStart)
      resolveStart({
        events,
        port: listenPort,
        targetPort,
        close: () =>
          new Promise((resolveClose) => {
            for (const socket of sockets) socket.destroy()
            server.close(() => resolveClose())
          })
      })
    })
  })
}
