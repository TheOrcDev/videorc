// Is the ⌘K palette keyboard-drivable? Opens it, then checks: is the input
// focused, does ArrowDown move the selected row, does typing filter, does
// Enter activate the selection (change the tab) and close. Each step prints
// what actually happened so a broken link in the chain is obvious.
//
// Usage: node scripts/ui-palette-keyboard-probe.mjs

import { execFileSync } from 'node:child_process'
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

  async evalJson(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true })
    if (result.exceptionDetails) {
      return { __error: result.exceptionDetails.text }
    }
    return result.result.value
  }

  async key(key, code, vk) {
    for (const type of ['rawKeyDown', 'keyUp']) {
      await this.send('Input.dispatchKeyEvent', {
        type: type === 'rawKeyDown' ? 'rawKeyDown' : 'keyUp',
        key,
        code,
        windowsVirtualKeyCode: vk,
        nativeVirtualKeyCode: vk
      })
    }
  }

  close() {
    try {
      this.ws.close()
    } catch {
      /* ignore */
    }
  }
}

const SELECTED = `(() => {
  const active = document.activeElement
  const sel = document.querySelector('[cmdk-item][aria-selected="true"]')
  return JSON.stringify({
    activeTag: active?.tagName?.toLowerCase() ?? null,
    activeIsCmdkInput: active?.hasAttribute?.('cmdk-input') ?? false,
    selectedItem: sel?.textContent?.trim() ?? null,
    itemCount: document.querySelectorAll('[cmdk-item]').length,
    paletteOpen: Boolean(document.querySelector('[cmdk-root]')),
    activeTab: document.querySelector('[data-videorc-active-tab]')?.getAttribute('data-videorc-active-tab') ?? null
  })
})()`

const userDataDir = mkdtempSync(join(tmpdir(), 'videorc-palettekb-userdata-'))
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

  // Open with a real synthesized ⌘K (modifiers bit 4 = Meta).
  for (const type of ['rawKeyDown', 'keyUp']) {
    await cdp.send('Input.dispatchKeyEvent', {
      type,
      modifiers: 4,
      key: 'k',
      code: 'KeyK',
      windowsVirtualKeyCode: 75,
      nativeVirtualKeyCode: 75
    })
  }
  await sleep(800)
  console.log('opened: ', await cdp.evalJson(SELECTED))

  await cdp.key('ArrowDown', 'ArrowDown', 40)
  await sleep(250)
  console.log('after ArrowDown #1:', await cdp.evalJson(SELECTED))

  await cdp.key('ArrowDown', 'ArrowDown', 40)
  await sleep(250)
  console.log('after ArrowDown #2:', await cdp.evalJson(SELECTED))

  // Screenshot the selection so its visibility on the glass can be judged.
  try {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    execFileSync('sh', [
      '-c',
      `echo '${shot.data}' | base64 -d > /tmp/videorc-palette-selection.png`
    ])
    console.log('shot: /tmp/videorc-palette-selection.png')
  } catch (error) {
    console.log('shot failed:', String(error?.message ?? error))
  }

  // Type to filter.
  for (const ch of ['l', 'i', 'b']) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', text: ch })
  }
  await sleep(300)
  console.log('after typing "lib":', await cdp.evalJson(SELECTED))

  await cdp.key('Enter', 'Enter', 13)
  await sleep(500)
  console.log('after Enter:    ', await cdp.evalJson(SELECTED))

  cdp.close()
} finally {
  await launched.stop()
}
