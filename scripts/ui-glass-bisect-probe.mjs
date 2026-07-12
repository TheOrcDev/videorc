// Which layer makes the glass opaque? Three cells over the loud backdrop:
//   1. default config (vibrancy + transparent)        — shot + renderer alpha
//   2. same, plus CDP Emulation background override   — shot + renderer alpha
//   3. transparent-only launch (no vibrancy)          — shot + renderer alpha
// Renderer alpha < 255 with an opaque screen = the window/material side.
// Renderer alpha = 255 = Chromium never engaged transparency; if the CDP
// override fixes the shot, the fix belongs at the WebContents level.
//
// Usage: node scripts/ui-glass-bisect-probe.mjs

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

async function runCell(name, extraEnv, withOverride, pageCss) {
  console.log(`\n=== cell: ${name} ===`)
  const userDataDir = mkdtempSync(join(tmpdir(), `videorc-bisect-`))
  let devtoolsUrl = null
  const launched = await launchDevApp({
    requiredMarkers: ['backend-ready', 'preview-motion-ready'],
    timeoutMs,
    env: {
      VIDEORC_SMOKE_PREVIEW_MOTION: '1',
      VIDEORC_USER_DATA_DIR: userDataDir,
      VIDEORC_DATABASE_PATH: join(userDataDir, 'videorc.sqlite3'),
      VIDEORC_REMOTE_DEBUG_PORT: '0',
      ...extraEnv
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
    if (withOverride) {
      await cdp.send('Emulation.setDefaultBackgroundColorOverride', {
        color: { r: 0, g: 0, b: 0, a: 0 }
      })
      await sleep(800)
    }
    if (pageCss) {
      await cdp.send('Runtime.evaluate', { expression: pageCss })
      await sleep(800)
    }
    await smokeCommand(smoke, 'open-backdrop-window')
    await sleep(1200)
    // REGION capture, not window capture: `screencapture -l` exports the
    // window's own layer WITH its alpha (nothing behind it), which cannot
    // show whether the desktop bleeds. -R shoots the real screen pixels.
    const { bounds } = await smokeCommand(smoke, 'main-window-id')
    const file = `/tmp/videorc-bisect-${name}.png`
    execFileSync('screencapture', [
      '-x',
      `-R${bounds.x},${bounds.y},${bounds.width},${bounds.height}`,
      file
    ])
    const alpha = await smokeCommand(smoke, 'capture-page-alpha')
    console.log(`shot: ${file}`)
    console.log(`renderer alpha:`, JSON.stringify(alpha))
    cdp.close()
  } catch (error) {
    console.log(`cell ${name} failed: ${String(error?.message ?? error)}`)
  } finally {
    await launched.stop()
  }
}

const LIGHT_FLIP = `localStorage.setItem('videorc.theme', 'light'); document.documentElement.classList.remove('dark'); document.documentElement.classList.add('light'); window.videorc?.setNativeTheme?.('light')`

const CELLS = {
  default: () => runCell('default', {}, false),
  'cdp-override': () => runCell('cdp-override', {}, true),
  'transparent-only': () =>
    runCell('transparent-only', { VIDEORC_GLASS_TEST: 'transparent-only' }, false),
  // Does CSS backdrop-filter blur the WINDOW backdrop (the desktop) in a
  // transparent window, or only web content? Decides whether pure-CSS glass
  // can replace the opaque vibrancy material. (Answer: it cannot, and it
  // kills the alpha pass-through.)
  'transparent-blur': () =>
    runCell(
      'transparent-blur',
      { VIDEORC_GLASS_TEST: 'transparent-only' },
      false,
      `document.body.style.backdropFilter = 'blur(40px) saturate(1.4)'`
    ),
  light: () => runCell('light', {}, false, LIGHT_FLIP),
  // Chromium paints an opaque canvas when the ROOT element's color-scheme is
  // light, even in a transparent window — next-themes sets that inline style
  // by default. This cell strips it after the theme flip.
  'light-noscheme': () =>
    runCell(
      'light-noscheme',
      {},
      false,
      `${LIGHT_FLIP}; document.documentElement.style.colorScheme = 'normal'`
    ),
  // The user-path reproduction: next-themes puts color-scheme:light inline on
  // html when the app runs in light theme. Expect opaque (alpha 255).
  'light-scheme-inline': () =>
    runCell(
      'light-scheme-inline',
      {},
      false,
      `${LIGHT_FLIP}; document.documentElement.style.colorScheme = 'light'`
    )
}

const requested = process.argv.slice(2)
const names = requested.length ? requested : Object.keys(CELLS)
for (const name of names) {
  if (!CELLS[name]) {
    console.log(`unknown cell: ${name} (available: ${Object.keys(CELLS).join(', ')})`)
    continue
  }
  await CELLS[name]()
}
