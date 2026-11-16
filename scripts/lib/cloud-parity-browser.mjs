import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { requireLoopback } from './cloud-parity-contract.mjs'

/** Bundle the real GuestRoom and its hooks from a read-only web checkout.
 * Only fixture API responses and device inputs are synthetic. No Next build,
 * migration, web source edit, fake LiveKit client or unrestricted guest token.
 */
export async function startParityPages(webRoot, guests, media = null, fixtureAssets = new Map()) {
  const webRequire = createRequire(join(webRoot, 'package.json'))
  const tsxRequire = createRequire(webRequire.resolve('tsx'))
  const { build } = tsxRequire('esbuild')
  const bundle = await build({
    stdin: {
      contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {GuestRoom} from './components/guest/guest-room'; createRoot(document.getElementById('root')).render(React.createElement(GuestRoom,{slug:location.pathname.split('/').pop()}));`,
      resolveDir: webRoot,
      loader: 'tsx'
    },
    absWorkingDir: webRoot,
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    jsx: 'automatic',
    alias: { '@': webRoot },
    logLevel: 'silent'
  })
  const { startServer } = await import(
    pathToFileURL(join(webRoot, 'tests/browser/cloud-program/server.mjs'))
  )
  const program = await startServer()
  program.state.realLiveKit = true
  requireLoopback(program.origin)
  // Load the real server relay/validator with injected local SFU calls. The
  // fixture admission/token boundary is synthetic; route authorization has
  // focused web tests and still needs managed acceptance.
  let mediaContract
  if (media) {
    const code = await build({
      stdin: {
        contents: `export {relayMediaCapability} from './lib/cloud/room-media-relay'; export {parseConsumerCapability} from './lib/cloud/program/room-media-v2';`,
        resolveDir: webRoot,
        loader: 'ts'
      },
      absWorkingDir: webRoot,
      bundle: true,
      write: false,
      format: 'cjs',
      platform: 'node',
      packages: 'external',
      alias: { '@': webRoot },
      logLevel: 'silent'
    })
    const module = { exports: {} }
    new Function('require', 'module', 'exports', code.outputFiles[0].text)(
      webRequire,
      module,
      module.exports
    )
    mediaContract = module.exports
  }
  const readBody = async (req, limit) => {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      assert.ok(size <= limit)
      chunks.push(chunk)
    }
    return Buffer.concat(chunks)
  }
  const relayCapability = async (value, identity, show) => {
    assert.equal(show, media.show)
    const capability = mediaContract.parseConsumerCapability(value)
    assert.ok(capability)
    return mediaContract.relayMediaCapability(media.relay, show, identity, capability, Date.now())
  }
  const privacyObservations = []
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1')
      const send = (type, body) => {
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
        res.end(body)
      }
      if (fixtureAssets.has(url.pathname))
        return send('text/javascript', fixtureAssets.get(url.pathname))
      if (url.pathname === '/guest.mjs')
        return send('text/javascript', bundle.outputFiles[0].contents)
      if (url.pathname.startsWith('/guest/'))
        return send(
          'text/html',
          '<!doctype html><meta charset="utf-8"><title>Real guest component parity fixture</title><style>video{position:relative!important;width:320px!important;height:180px!important;object-fit:contain}audio{display:none}</style><div id="root"></div><script type="module" src="/guest.mjs"></script>'
        )
      const match = /^\/api\/guest\/([^/]+)(.*)$/.exec(url.pathname)
      if (match) {
        const guest = guests.get(match[1])
        if (!guest) {
          res.writeHead(404)
          res.end()
          return
        }
        if (match[2] === '/media' && req.method === 'POST') {
          if (!media) return send('application/json', JSON.stringify({ fixtureReceived: true }))
          const body = JSON.parse(await readBody(req, 1024))
          const result = await relayCapability(body.capability, guest.identity, body.show)
          return send('application/json', JSON.stringify({ capability: result }))
        }
        if (match[2] === '/privacy' && req.method === 'POST') {
          let text = ''
          for await (const chunk of req) {
            text += chunk
            assert.ok(text.length <= 1024)
          }
          const body = JSON.parse(text)
          assert.equal(body.guestId, guest.identity)
          privacyObservations.push({ receiver: match[1], receivedAt: Date.now(), ...body.privacy })
          // Fixture transport receipt only. Production authentication and relay
          // run in focused web tests; never forge a host confirmation here.
          return send('application/json', JSON.stringify({ fixtureReceived: true }))
        }
        const body = match[2].startsWith('/join/')
          ? {
              state: 'let-in',
              guestId: guest.identity,
              screenShareAllowed: false,
              muted: false,
              room: { url: guest.url, token: guest.token }
            }
          : { state: 'open', show: { title: 'Parity fixture', platforms: [], recording: false } }
        return send('application/json', JSON.stringify(body))
      }
      // Serve the exact program document, CSP and emitted assets. The origin
      // stays loopback; credentials never leave this fixture server.
      const target = new URL(req.url, program.origin)
      assert.equal(target.origin, program.origin)
      let body
      if (media && req.method === 'POST' && url.pathname === program.wire.PROGRAM_BEACON_PATH) {
        body = await readBody(req, 4096)
        const beacon = JSON.parse(body)
        assert.equal(req.headers.authorization, 'Bearer vcp1.dGVzdA.dGVzdA')
        if (beacon.joined && beacon.capability)
          await relayCapability(beacon.capability, 'EG_parity_baseline', beacon.show)
      }
      const response = await fetch(target, {
        method: req.method,
        headers: {
          'content-type': req.headers['content-type'] ?? 'application/json',
          authorization: req.headers.authorization ?? ''
        },
        ...(req.method === 'POST' ? { body: body ?? req, duplex: 'half' } : {}),
        signal: AbortSignal.timeout(10000),
        redirect: 'error'
      })
      res.writeHead(
        response.status,
        Object.fromEntries(
          [...response.headers].filter(
            ([key]) => !['content-encoding', 'content-length', 'transfer-encoding'].includes(key)
          )
        )
      )
      res.end(Buffer.from(await response.arrayBuffer()))
    } catch {
      res.writeHead(500)
      res.end('Parity fixture request failed')
    }
  })
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
  } catch (error) {
    await program.close()
    throw error
  }
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    wire: program.wire,
    privacyObservations,
    programBeacons: program.beacons,
    async close() {
      const result = new Promise((resolve) => server.close(resolve))
      server.closeAllConnections()
      await result
      await program.close()
    }
  }
}

/** Browser-only input generator, installed before the real guest component. */
export function installGuestFixture({ color, hz, peak, slug }) {
  sessionStorage.setItem(`vrc-guest-request:${slug}`, 'parity-admitted')
  sessionStorage.setItem('vrc-guest-name', slug)
  const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    const tracks = []
    if (constraints.video) {
      const canvas = document.createElement('canvas')
      canvas.width = 320
      canvas.height = 180
      const ctx = canvas.getContext('2d')
      let frame = 0
      const draw = () => {
        ctx.fillStyle = `rgb(${color.join(',')})`
        ctx.fillRect(0, 0, 320, 180)
        ctx.fillStyle = 'white'
        ctx.fillRect(8 + ((frame++ * 4) % 288), 8, 16, 16)
      }
      draw()
      const timer = setInterval(draw, 1000 / 30)
      const track = canvas.captureStream(30).getVideoTracks()[0]
      const stop = track.stop.bind(track)
      track.stop = () => {
        clearInterval(timer)
        stop()
      }
      tracks.push(track)
    }
    if (constraints.audio) {
      const context = new AudioContext({ sampleRate: 48000 })
      const oscillator = context.createOscillator(),
        gain = context.createGain(),
        destination = context.createMediaStreamDestination()
      oscillator.frequency.value = hz
      gain.gain.value = peak
      oscillator.connect(gain).connect(destination)
      oscillator.start()
      await context.resume()
      const track = destination.stream.getAudioTracks()[0],
        stop = track.stop.bind(track)
      track.stop = () => {
        oscillator.stop()
        void context.close()
        stop()
      }
      tracks.push(track)
    }
    return tracks.length ? new MediaStream(tracks) : original(constraints)
  }
}

/** Observe the real final Web Audio connection without replacing the limiter.
 * Guest return observes only audio elements actually attached by GuestRoom,
 * respecting mute/volume. No direct participant subscription in the recorder.
 */
export function installProgramAudioTap() {
  const connect = AudioNode.prototype.connect
  const taps = []
  AudioNode.prototype.connect = function (destination, ...ports) {
    const result = connect.call(this, destination, ...ports)
    if (destination instanceof AudioDestinationNode) {
      const tap = this.context.createMediaStreamDestination()
      connect.call(this, tap, ports[0] ?? 0, 0)
      taps.push({ node: this, tap })
    }
    return result
  }
  window.__parityProgramTaps = taps
}

export async function recordPageAudio(page, kind, seconds) {
  assert.ok(['program', 'guest'].includes(kind))
  assert.ok(Number.isFinite(seconds) && seconds >= 1 && seconds <= 10)
  return page.evaluate(
    async ({ kind, seconds }) => {
      let stream, context, recorder, deadline
      const nodes = []
      try {
        if (kind === 'program') {
          const taps = window.__parityProgramTaps ?? []
          if (taps.length !== 1)
            throw new Error(`Expected one final program output, saw ${taps.length}`)
          stream = taps[0].tap.stream
        } else {
          context = new AudioContext({ sampleRate: 48000 })
          const output = context.createMediaStreamDestination()
          const elements = [...document.querySelectorAll('audio')].filter(
            (element) => element.srcObject && !element.paused
          )
          if (!elements.length) throw new Error('No playing guest return elements')
          for (const element of elements) {
            const node = context.createMediaStreamSource(element.srcObject),
              gain = context.createGain()
            gain.gain.value = element.muted ? 0 : element.volume
            node.connect(gain).connect(output)
            nodes.push(node, gain)
          }
          stream = output.stream
          await context.resume()
        }
        recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' })
        const chunks = []
        recorder.ondataavailable = (event) => chunks.push(event.data)
        const stopped = new Promise((resolve, reject) => {
          recorder.onstop = resolve
          recorder.onerror = () => reject(new Error('Audio artifact recording failed'))
        })
        recorder.start()
        await new Promise((resolve) => setTimeout(resolve, seconds * 1000))
        recorder.stop()
        await Promise.race([
          stopped,
          new Promise((_, reject) => {
            deadline = setTimeout(() => reject(new Error('Audio recorder did not finalize')), 5000)
          })
        ])
        const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer())
        // Bounded (<10 s) audio only, never camera pixels or credentials in JSON.
        let binary = ''
        for (const byte of bytes) binary += String.fromCharCode(byte)
        return btoa(binary)
      } finally {
        clearTimeout(deadline)
        if (recorder && recorder.state !== 'inactive') recorder.stop()
        nodes.forEach((node) => node.disconnect())
        if (context) await context.close()
      }
    },
    { kind, seconds }
  )
}
