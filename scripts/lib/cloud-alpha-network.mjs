import { createServer, connect } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'

/** Ordered TCP delay, not CDP's HTTP throttling (which does not shape WebRTC UDP). */
export async function startAlphaTcpProxy(targetPort, jitterMs = 0) {
  if (
    !Number.isInteger(targetPort) ||
    targetPort < 1 ||
    targetPort > 65535 ||
    jitterMs < 0 ||
    jitterMs > 100
  )
    throw new Error('Invalid loopback TCP experiment')
  const sockets = new Set(),
    tasks = new Set()
  const stats = {
    bytes: 0,
    connections: 0,
    queuePeakBytes: 0,
    overflow: 0,
    forwarded: 0,
    delayMsSum: 0,
    maxDelayMs: 0
  }
  let closed = false,
    seed = 1
  const server = createServer((incoming) => {
    if (closed || sockets.size >= 128) {
      incoming.destroy()
      return
    }
    const outgoing = connect({ host: '127.0.0.1', port: targetPort })
    sockets.add(incoming)
    sockets.add(outgoing)
    stats.connections++
    for (const socket of [incoming, outgoing]) {
      socket.on('error', () => {
        incoming.destroy()
        outgoing.destroy()
      })
      socket.on('close', () => {
        sockets.delete(socket)
        incoming.destroy()
        outgoing.destroy()
      })
    }
    const pipe = (from, to) => {
      const queue = []
      let bytes = 0,
        pumping = false,
        tail = 0
      const pump = async () => {
        if (pumping) return
        pumping = true
        try {
          while (queue.length && !closed && !to.destroyed) {
            const item = queue[0]
            if (item.due > performance.now()) await sleep(item.due - performance.now())
            if (closed || to.destroyed) break
            if (!to.write(item.chunk))
              await new Promise((resolve) => {
                const done = () => {
                  to.off('drain', done)
                  to.off('close', done)
                  resolve()
                }
                to.once('drain', done)
                to.once('close', done)
              })
            const delay = performance.now() - item.at
            stats.bytes += item.chunk.length
            stats.forwarded++
            stats.delayMsSum += delay
            stats.maxDelayMs = Math.max(stats.maxDelayMs, delay)
            bytes -= item.chunk.length
            queue.shift()
            if (bytes < 512 * 1024) from.resume()
          }
        } finally {
          pumping = false
          if (closed || to.destroyed) queue.length = 0
        }
      }
      from.on('data', (chunk) => {
        const at = performance.now()
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
        tail = Math.max(tail, at + (jitterMs ? seed % (jitterMs + 1) : 0))
        bytes += chunk.length
        stats.queuePeakBytes = Math.max(stats.queuePeakBytes, bytes)
        if (bytes > 2 * 1024 * 1024) {
          stats.overflow++
          incoming.destroy()
          outgoing.destroy()
          return
        }
        queue.push({ chunk, at, due: tail })
        if (bytes > 1024 * 1024) from.pause()
        const task = pump()
        tasks.add(task)
        void task.finally(() => tasks.delete(task))
      })
    }
    pipe(incoming, outgoing)
    pipe(outgoing, incoming)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    port: server.address().port,
    stats,
    async close() {
      closed = true
      sockets.forEach((s) => s.destroy())
      await new Promise((r) => server.close(r))
      await Promise.allSettled(tasks)
    }
  }
}

/** Test-only bootstrap. Preserve credentials; change only loopback ICE TCP ports.
 * Acquisition verifies the selected remote candidate really uses the proxy. */
export function installAlphaIceProxy({ targetPort, proxyPort }) {
  const proto = RTCPeerConnection.prototype
  const description = proto.setRemoteDescription,
    candidate = proto.addIceCandidate
  const rewrite = (line) => {
    const prefix = line.startsWith('a=') ? 'a=' : ''
    const parts = line.slice(prefix.length).trim().split(/\s+/)
    if (!parts[0]?.startsWith('candidate:')) return line
    if (parts[2]?.toLowerCase() !== 'tcp') return null
    if (Number(parts[5]) !== targetPort) return null
    if (!['127.0.0.1', '::1'].includes(parts[4]))
      throw new Error('Alpha ICE candidate must be loopback')
    parts[5] = String(proxyPort)
    return prefix + parts.join(' ')
  }
  proto.setRemoteDescription = function (value) {
    return description.call(this, {
      type: value.type,
      sdp: value.sdp
        ?.split(/\r?\n/)
        .map(rewrite)
        .filter((line) => line !== null)
        .join('\r\n')
    })
  }
  proto.addIceCandidate = function (value) {
    if (!value?.candidate) return candidate.call(this, value)
    const changed = rewrite(value.candidate)
    return changed === null
      ? Promise.resolve()
      : candidate.call(this, {
          candidate: changed,
          sdpMid: value.sdpMid,
          sdpMLineIndex: value.sdpMLineIndex,
          usernameFragment: value.usernameFragment
        })
  }
}
