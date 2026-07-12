// Is the glass actually transparent? Three region captures decide:
//   A) window present, tokens at their shipped alpha
//   B) window present, --background dropped to 30% (backdrop should ghost through)
//   C) window hidden (the bare backdrop)
// If B shows C's features through the UI, transparency is real and any
// remaining "looks solid" is the backdrop/material, not the window stack.
//
// Usage: node scripts/ui-vibrancy-proof.mjs

import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request as httpRequest } from 'node:http'

import { launchDevApp } from './lib/app-launcher.mjs'

const timeoutMs = Number(process.env.VIDEORC_PROBE_TIMEOUT_MS ?? 180000)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function smokeCommand(smoke, command, params = {}) {
  const body = JSON.stringify({ command, params })
  return new Promise((resolveCmd, rejectCmd) => {
    const req = httpRequest(
      {
        hostname: smoke.host,
        port: smoke.port,
        path: '/command',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Authorization: `Bearer ${smoke.capability}` }
      },
      (res) => {
        res.setEncoding('utf8')
        let text = ''
        res.on('data', (c) => (text += c))
        res.on('end', () => {
          try {
            const payload = JSON.parse(text)
            if (payload.error) rejectCmd(new Error(`${command} -> ${payload.error}`))
            else resolveCmd(payload.result ?? payload)
          } catch {
            rejectCmd(new Error(`${command} -> invalid JSON: ${text.slice(0, 200)}`))
          }
        })
      }
    )
    req.on('error', rejectCmd)
    req.write(body)
    req.end()
  })
}

function fetchJsonHttp(url) {
  return new Promise((resolveFetch, rejectFetch) => {
    const req = httpRequest(url, { method: 'GET' }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (text += c))
      res.on('end', () => {
        try {
          resolveFetch(JSON.parse(text))
        } catch (e) {
          rejectFetch(e)
        }
      })
    })
    req.on('error', rejectFetch)
    req.end()
  })
}

class CdpClient {
  constructor(ws) {
    this.ws = ws
    this.serial = 0
    this.pending = new Map()
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (message.error) reject(new Error(message.error.message))
        else resolve(message.result)
      }
    })
  }

  static connect(url) {
    return new Promise((resolveConnect, rejectConnect) => {
      const ws = new WebSocket(url)
      ws.addEventListener('open', () => resolveConnect(new CdpClient(ws)))
      ws.addEventListener('error', () => rejectConnect(new Error(`CDP connect failed: ${url}`)))
    })
  }

  send(method, params = {}) {
    const id = ++this.serial
    return new Promise((resolveSend, rejectSend) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        rejectSend(new Error(`CDP ${method} timed out`))
      }, 10000)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolveSend(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          rejectSend(error)
        }
      })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  close() {
    try {
      this.ws.close()
    } catch {
      /* ignore */
    }
  }
}

const userDataDir = mkdtempSync(join(tmpdir(), 'videorc-vibproof-userdata-'))
let devtoolsUrl = null
const launched = await launchDevApp({
  requiredMarkers: ['backend-ready', 'preview-motion-ready'],
  timeoutMs,
  env: {
    VIDEORC_SMOKE_PREVIEW_MOTION: '1',
    VIDEORC_USER_DATA_DIR: userDataDir,
    VIDEORC_DATABASE_PATH: join(userDataDir, 'videorc.sqlite3'),
    VIDEORC_REMOTE_DEBUG_PORT: '0'
  },
  onLine: (line) => {
    const devtools = /DevTools listening on (ws:\/\/[^\s]+)/.exec(line)
    if (devtools) devtoolsUrl = devtools[1]
  }
})

const smoke = launched.connections['preview-motion-ready']

try {
  if (!devtoolsUrl) throw new Error('no DevTools endpoint observed')
  await sleep(8000)
  const { host } = new URL(devtoolsUrl.replace('ws://', 'http://'))
  const targets = await fetchJsonHttp(`http://${host}/json/list`)
  const mainTarget = targets.find(
    (target) => target.type === 'page' && /^https?:\/\/localhost/.test(target.url ?? '')
  )
  if (!mainTarget) throw new Error('main window target not found')
  const cdp = await CdpClient.connect(mainTarget.webSocketDebuggerUrl)

  await cdp.send('Runtime.evaluate', {
    expression: `localStorage.setItem('videorc.onboardingComplete', 'creator-ux-v1'); localStorage.setItem('videorc.theme', 'dark'); location.reload()`
  })
  await sleep(6000)

  const { bounds } = await smokeCommand(smoke, 'main-window-id')
  const rect = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`
  const shoot = (name) => {
    const file = `/tmp/videorc-vibproof-${name}.png`
    execFileSync('screencapture', ['-x', `-R${rect}`, file])
    console.log(`shot: ${file}`)
  }

  shoot('a-alpha75')

  await cdp.send('Runtime.evaluate', {
    expression: `document.documentElement.style.setProperty('--background', 'oklch(0.21 0.006 286 / 30%)')`
  })
  await sleep(400)
  shoot('b-alpha30')

  await smokeCommand(smoke, 'heal-main-window', { lever: 'hide' })
  await sleep(800)
  shoot('c-backdrop')
  await smokeCommand(smoke, 'heal-main-window', { lever: 'show' })

  cdp.close()
} finally {
  await launched.stop()
}
