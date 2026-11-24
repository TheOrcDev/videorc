// The ⌘K blank-screen bug, instrumented. Opens the palette with a synthesized
// Meta+K while recording every renderer exception and console error, then
// reports whether the React root survived and whether frames still paint.
// An uncaught render error in React 19 unmounts the entire root — an empty
// transparent window with a live DOM is exactly that signature.
//
// Usage: node scripts/ui-palette-wedge-probe.mjs

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request as httpRequest } from 'node:http'

import { launchDevApp } from './lib/app-launcher.mjs'
import { seedUiSettingsJs } from './lib/renderer-profile-seed.mjs'

const timeoutMs = Number(process.env.VIDEORC_PROBE_TIMEOUT_MS ?? 180000)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
    this.events = []
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (message.error) reject(new Error(message.error.message))
        else resolve(message.result)
        return
      }
      if (message.method === 'Runtime.exceptionThrown') {
        const detail = message.params.exceptionDetails
        this.events.push(
          `EXCEPTION: ${detail.text} ${detail.exception?.description ?? ''}`.slice(0, 1200)
        )
      }
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
        const text = message.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' ')
        this.events.push(`CONSOLE.ERROR: ${text}`.slice(0, 1200))
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

const PAGE_STATE = `JSON.stringify({
  rootChildren: document.getElementById('root')?.childElementCount ?? -1,
  bodyChildren: document.body.childElementCount,
  dialogs: document.querySelectorAll('[role="dialog"]').length,
  cmdk: document.querySelectorAll('[cmdk-root]').length
})`

const RAF_ALIVE = `new Promise((resolve) => {
  const timer = setTimeout(() => resolve('wedged: no frame in 1500ms'), 1500)
  requestAnimationFrame(() => { clearTimeout(timer); resolve('painting') })
})`

const userDataDir = mkdtempSync(join(tmpdir(), 'videorc-palette-userdata-'))
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
  await cdp.send('Runtime.enable')

  // The seed waits for the window's UI settings store (plan 220 S1.4b.2), then the reload.
  const seeded = await cdp.send('Runtime.evaluate', {
    expression: seedUiSettingsJs(
      { 'videorc.onboardingComplete': 'creator-ux-v1', 'videorc.theme': 'dark' },
      { readyTimeoutMs: 8000 }
    ),
    awaitPromise: true,
    returnByValue: true
  })
  if (seeded.exceptionDetails) {
    throw new Error(
      `UI settings seed: ${seeded.exceptionDetails.exception?.description ?? seeded.exceptionDetails.text}`
    )
  }
  await cdp.send('Runtime.evaluate', { expression: 'location.reload()' })
  await sleep(6000)
  cdp.events.length = 0

  const before = await cdp.send('Runtime.evaluate', { expression: PAGE_STATE, returnByValue: true })
  console.log('before:', before.result.value)

  for (const type of ['keyDown', 'keyUp']) {
    await cdp.send('Input.dispatchKeyEvent', {
      type,
      modifiers: 4,
      key: 'k',
      code: 'KeyK',
      windowsVirtualKeyCode: 75,
      nativeVirtualKeyCode: 75
    })
  }
  await sleep(2500)

  const after = await cdp.send('Runtime.evaluate', { expression: PAGE_STATE, returnByValue: true })
  console.log('after ⌘K:', after.result.value)
  const paint = await cdp.send('Runtime.evaluate', {
    expression: RAF_ALIVE,
    awaitPromise: true,
    returnByValue: true
  })
  console.log('paint:', paint.result.value)

  console.log(`\n=== renderer errors during open (${cdp.events.length}) ===`)
  for (const event of cdp.events.slice(0, 12)) console.log(event)

  cdp.close()
} finally {
  await launched.stop()
}
