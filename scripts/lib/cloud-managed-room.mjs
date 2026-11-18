import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { WebSocketServer } from 'ws'
import { setTimeout as sleep } from 'node:timers/promises'
import { repoRoot } from './app-launcher.mjs'
import { waitFor } from './cloud-managed-smoke.mjs'
import { managedWire as w } from './fake-cloud-web-managed.mjs'

/** A real local LiveKit participant: receives actual host byte streams and can
 * publish a canvas and a tone as a guest. No mocked streamBytes assertions.
 */
export async function managedRoomListener(h) {
  const bundle = readFileSync(
    join(repoRoot, 'apps/desktop/node_modules/livekit-client/dist/livekit-client.esm.mjs')
  )
  const server = createServer((req, res) => {
    if (req.url === '/client.mjs') {
      res.writeHead(200, { 'content-type': 'text/javascript' })
      res.end(bundle)
    } else {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<!doctype html><title>Managed room listener</title>')
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  let browser
  try {
    browser = await chromium.launch({
      executablePath:
        process.env.VIDEORC_SMOKE_CHROME ??
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      headless: true,
      args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream']
    })
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    await page.evaluate(async (topics) => {
      const LK = await import('/client.mjs')
      window.LK = LK
      window.received = []
      window.disconnects = []
      window.peers = new Map()
      window.joinPeer = async ({
        url,
        token,
        identity,
        publish,
        tone = 659,
        color = '#c02020'
      }) => {
        const room = new LK.Room({ adaptiveStream: false, dynacast: false })
        room.on(LK.RoomEvent.Disconnected, (reason) =>
          window.disconnects.push({ identity, reason, atMs: Date.now() })
        )
        for (const topic of topics) {
          room.registerByteStreamHandler(topic, async (reader, sender) => {
            const chunks = await reader.readAll({ signal: AbortSignal.timeout(10000) })
            const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
            let offset = 0
            for (const chunk of chunks) {
              bytes.set(chunk, offset)
              offset += chunk.length
            }
            window.received.push({
              atMs: Date.now(),
              // Every room in this page registers the handlers: a stream to the
              // whole room arrives once per room. The listener counts its own.
              receiver: identity,
              topic,
              sender: sender.identity,
              attributes: reader.info.attributes ?? {},
              mimeType: reader.info.mimeType,
              length: bytes.length,
              head: Array.from(bytes.slice(0, 3)),
              body: topic.endsWith('.clear') ? new TextDecoder().decode(bytes) : undefined
            })
          })
        }
        await room.connect(url, token)
        const peer = { room, tracks: [] }
        window.peers.set(identity, peer)
        if (publish) {
          const canvas = document.createElement('canvas')
          canvas.width = 640
          canvas.height = 360
          const ctx = canvas.getContext('2d')
          ctx.fillStyle = color
          ctx.fillRect(0, 0, 640, 360)
          peer.interval = setInterval(() => {
            ctx.fillStyle = color
            ctx.fillRect(0, 0, 640, 360)
            ctx.fillStyle = '#fff'
            ctx.fillRect(Date.now() % 600, 10, 10, 10)
          }, 33)
          const video = canvas.captureStream(30).getVideoTracks()[0]
          const audio = new AudioContext()
          await audio.resume()
          const osc = audio.createOscillator(),
            dest = audio.createMediaStreamDestination()
          osc.frequency.value = tone
          osc.connect(dest)
          osc.start()
          peer.audio = audio
          await room.localParticipant.publishTrack(video, { source: LK.Track.Source.Camera })
          await room.localParticipant.publishTrack(dest.stream.getAudioTracks()[0], {
            source: LK.Track.Source.Microphone
          })
          peer.tracks = [video, ...dest.stream.getTracks()]
        }
        return room.localParticipant.identity
      }
    }, Object.values(w.overlay.topics))
    const joinPeer = async (identity, publish = false, extra = {}) => {
      const token = h.web.tokenFor(h.showId, identity)
      return page.evaluate((params) => window.joinPeer(params), {
        url: h.livekit.url,
        token,
        identity,
        publish,
        ...extra
      })
    }
    const listenerIdentity = `EG_${randomBytes(8).toString('hex')}`
    await joinPeer(listenerIdentity)
    return {
      page,
      joinPeer,
      joinHost: (grants) =>
        page.evaluate((params) => window.joinPeer(params), {
          url: grants.url,
          token: grants.token,
          identity: grants.identity,
          publish: true,
          tone: 880,
          color: '#20b080'
        }),
      hostWasReplaced: () =>
        page.evaluate(
          (identity) =>
            window.disconnects.some(
              (e) =>
                e.identity === identity &&
                e.reason === window.LK.DisconnectReason.DUPLICATE_IDENTITY
            ),
          `host:${h.showId}`
        ),
      records: () =>
        page.evaluate(
          (id) => window.received.filter((record) => record.receiver === id),
          listenerIdentity
        ),
      async screen(identity, on) {
        await page.evaluate(
          async ({ identity, on }) => {
            const p = window.peers.get(identity)
            if (on) {
              const canvas = document.createElement('canvas')
              canvas.width = 640
              canvas.height = 360
              const ctx = canvas.getContext('2d')
              // A canvas that never changes yields no frames, and LiveKit
              // never publishes a track with no media: redraw it, as the
              // camera does.
              const draw = () => {
                ctx.fillStyle = '#00c080'
                ctx.fillRect(0, 0, 640, 360)
                ctx.fillStyle = '#fff'
                ctx.fillRect(Date.now() % 600, 20, 10, 10)
              }
              draw()
              p.screenInterval = setInterval(draw, 100)
              const track = canvas.captureStream(10).getVideoTracks()[0]
              p.screen = track
              p.tracks.push(track)
              await p.room.localParticipant.publishTrack(track, {
                source: window.LK.Track.Source.ScreenShare
              })
            } else if (p.screen) {
              clearInterval(p.screenInterval)
              await p.room.localParticipant.unpublishTrack(p.screen)
              p.screen.stop()
              p.screen = null
            }
          },
          { identity, on }
        )
      },

      async leave(identity) {
        await page.evaluate(async (identity) => {
          const p = window.peers.get(identity)
          clearInterval(p?.interval)
          clearInterval(p?.screenInterval)
          p?.tracks.forEach((t) => t.stop())
          await p?.audio?.close()
          await p?.room.disconnect()
          window.peers.delete(identity)
        }, identity)
      },
      async close() {
        await browser.close()
        await new Promise((resolve) => server.close(resolve))
      }
    }
  } catch (e) {
    await browser?.close()
    server.close()
    throw e
  }
}

export function checkOverlay(record, { slot, ttl, sender }) {
  assert.equal(record.topic, w.overlay.topics.set)
  assert.equal(record.sender, sender)
  const attrs = {
    v: w.overlay.version,
    slot,
    o: 'h',
    x: '0.000000',
    y: '0.000000',
    w: '1.000000',
    h: '1.000000',
    ...(ttl ? { ttl: String(ttl) } : {})
  }
  assert.deepEqual(record.attributes, attrs)
  assert.ok(w.overlay.mimeTypes.includes(record.mimeType))
  assert.ok(record.length <= w.overlay.maxBytes)
}

/** Isolated node control sentinel for the regression that managed overlay events
 * must not be emitted by a node show. It implements hello/intent/ping only;
 * this does not replace the existing real-node talk-show smoke.
 */
export async function nodeTalkSentinel(h) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => server.once('listening', resolve))
  const show = h.web.shows.get(h.showId),
    state = h.web.snapshot(h.showId).state
  const old = show.controlKind
  show.controlKind = undefined
  const original = h.web.snapshot(h.showId)
  const control = {
    url: `ws://127.0.0.1:${server.address().port}`,
    token: randomBytes(32).toString('base64url')
  }
  const connections = new Set()
  server.on('connection', (ws) => {
    connections.add(ws)
    ws.on('close', () => connections.delete(ws))
    ws.on('message', (bytes) => {
      const frame = JSON.parse(bytes.toString())
      if (frame.t === 'hello') ws.send(JSON.stringify({ t: 'welcome', state }))
      else if (frame.t === 'ping') ws.send(JSON.stringify({ t: 'pong' }))
      else if (frame.t === 'intent') {
        ws.send(JSON.stringify({ t: 'ack', id: frame.id, ok: true }))
        ws.send(JSON.stringify({ t: 'state', state }))
      }
    })
  })
  h.web.hooks.legacyControl(h.showId, control)
  return {
    original,
    async close() {
      show.controlKind = old
      delete show.controlOverride
      show.show.nodeId = w.control.managedNodeId
      for (const ws of connections) ws.terminate()
      await new Promise((resolve) => server.close(resolve))
    }
  }
}
export async function hostReconnect(h) {
  // Uses the production room reconnect: kill/relaunch, token refresh and Resume.
  const at = Date.now()
  await h.kill()
  await h.launch()
  // The relaunched app finds the show through its launch check; Resume
  // before that answers 'no show to resume'.
  await h.status((s) => s.show?.id === h.showId, 'the relaunched app holds the show', 45000)
  await h.rpc('cloud.room.resume')
  await h.status((s) => s.room?.client === 'connected', 'host reconnected')
  await waitFor(() => h.calls('roomToken', at).length, 'fresh host token')
}

/** The host's room connection drops and comes back, in the same app, as a
 * host's network does: the tap in front of the desktop's room address closes
 * for 3 s, and the client's own reconnect brings the room back (the renderer
 * reports connected: the backend's overlay replay trigger, wire 6.3). */
export async function hostRoomDrop(h) {
  await h.cutHostRoom()
  await sleep(3000)
  await h.forwardHostRoom()
  await h.status((s) => s.room?.client === 'connected', 'host back in the room', 60000)
}
