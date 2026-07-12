// Transparent-backed vibrancy: translucency proof + reload-wedge hunt.
//
// With backgroundColor '#00000000' the window can actually show the material
// (the matrix probe proved opaque backing hides it completely) — but that
// exact backing wedged frame production on location.reload() when last tried.
// This probe shoots composited captures before a reload, after it, and after
// each candidate heal lever, so the wedge and its cure are decided by
// evidence instead of memory.
//
// Usage: node scripts/ui-vibrancy-reload-probe.mjs

import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request as httpRequest } from 'node:http'

import { launchDevApp } from './lib/app-launcher.mjs'

const timeoutMs = Number(process.env.VIDEORC_PROBE_TIMEOUT_MS ?? 180000)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const LEVERS = ['invalidate', 'background-jiggle', 'resize-jiggle', 'hide-show', 'revibrancy']

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

async function connectMainPage(devtoolsUrl) {
  const { host } = new URL(devtoolsUrl.replace('ws://', 'http://'))
  const targets = await fetchJsonHttp(`http://${host}/json/list`)
  const mainTarget = targets.find(
    (target) => target.type === 'page' && /^https?:\/\/localhost/.test(target.url ?? '')
  )
  if (!mainTarget) throw new Error('main window target not found')
  return CdpClient.connect(mainTarget.webSocketDebuggerUrl)
}

const userDataDir = mkdtempSync(join(tmpdir(), 'videorc-vibreload-userdata-'))
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
  let cdp = await connectMainPage(devtoolsUrl)

  // Skip onboarding WITHOUT reloading: the pristine pre-reload state is the
  // thing under test. The window relaunches the app shell when storage is set
  // before the app reads it — so set keys, then do the ONE reload that is the
  // experiment itself, capturing before and after.
  await cdp.send('Runtime.evaluate', {
    expression: `localStorage.setItem('videorc.onboardingComplete', 'creator-ux-v1'); localStorage.setItem('videorc.theme', 'dark')`
  })

  const { windowId } = await smokeCommand(smoke, 'main-window-id')
  if (!windowId) throw new Error('no CGWindowID for the main window')
  const shoot = (name) => {
    const file = `/tmp/videorc-vibreload-${name}.png`
    execFileSync('screencapture', ['-x', '-o', `-l${windowId}`, file])
    console.log(`shot: ${file}`)
  }

  shoot('0-before-reload')

  await cdp.send('Runtime.evaluate', { expression: 'location.reload()' })
  await sleep(6000)
  shoot('1-after-reload')

  // CDP target died with the navigation? Reconnect for completeness.
  cdp.close()
  cdp = await connectMainPage(devtoolsUrl).catch(() => null)

  for (const [index, lever] of LEVERS.entries()) {
    await smokeCommand(smoke, 'heal-main-window', { lever })
    await sleep(1500)
    shoot(`${index + 2}-after-${lever}`)
  }

  cdp?.close()
} finally {
  await launched.stop()
}
