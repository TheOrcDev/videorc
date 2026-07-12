// Vibrancy material × token-alpha matrix, shot composited (screencapture -l).
//
// macOS materials differ wildly in how much desktop they let through —
// under-window reads near-solid in dark mode while hud/popover frost visibly.
// This probe swaps the live window's material via the set-vibrancy smoke
// command, overrides the --background alpha via CDP, and captures the REAL
// composited result for each cell so the default can be picked by eye.
//
// Usage: node scripts/ui-vibrancy-matrix.mjs

import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request as httpRequest } from 'node:http'

import { launchDevApp } from './lib/app-launcher.mjs'

const timeoutMs = Number(process.env.VIDEORC_PROBE_TIMEOUT_MS ?? 180000)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const MATERIALS = ['under-window', 'hud', 'popover', 'menu', 'fullscreen-ui']
const ALPHAS = ['65%', '55%', '45%']

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

const userDataDir = mkdtempSync(join(tmpdir(), 'videorc-vibrancy-userdata-'))
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

  // Past onboarding, settled on the studio tab, dark theme.
  await cdp.send('Runtime.evaluate', {
    expression: `localStorage.setItem('videorc.onboardingComplete', 'creator-ux-v1'); localStorage.setItem('videorc.theme', 'dark'); location.reload()`
  })
  await sleep(6000)

  // A loud striped backdrop behind the window: without it, dark glass over a
  // dark desktop is indistinguishable from solid in every capture.
  await smokeCommand(smoke, 'open-backdrop-window')
  await sleep(1200)

  const { windowId } = await smokeCommand(smoke, 'main-window-id')
  if (!windowId) throw new Error('no CGWindowID for the main window')

  for (const material of MATERIALS) {
    await smokeCommand(smoke, 'set-vibrancy', { material })
    for (const alpha of ALPHAS) {
      await cdp.send('Runtime.evaluate', {
        expression: `document.documentElement.style.setProperty('--background', 'oklch(0.21 0.006 286 / ${alpha})')`
      })
      await sleep(400)
      const file = `/tmp/videorc-vib-${material}-${alpha.replace('%', '')}.png`
      execFileSync('screencapture', ['-x', '-o', `-l${windowId}`, file])
      console.log(`shot: ${file}`)
    }
  }
  cdp.close()
} finally {
  await launched.stop()
}
