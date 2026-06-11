// Renderer hot-path call counters.
//
// Wraps localStorage writes and WebSocket traffic in the live main window via
// CDP and reports rates after a window — pinpointing which glue path pushes
// bytes through Blink's buffer partition when source-level grep finds no
// direct allocators.
//
// Usage: node scripts/perf-renderer-counters.mjs

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request as httpRequest } from 'node:http'

import { launchDevApp } from './lib/app-launcher.mjs'

const timeoutMs = Number(process.env.VIDEORC_PROBE_TIMEOUT_MS ?? 180000)
const windowSeconds = Number(process.env.VIDEORC_COUNTER_WINDOW_SECONDS ?? 60)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function fetchJson(url) {
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
      this.pending.set(id, { resolve: resolveSend, reject: rejectSend })
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

const INSTRUMENT = `(() => {
  if (window.__videorcCounters) return 'already-instrumented'
  const counts = {
    localStorageSet: 0, localStorageBytes: 0,
    wsIn: 0, wsInBytes: 0, wsOut: 0, wsOutBytes: 0,
    jsonStringify: 0, jsonStringifyBytes: 0
  }
  window.__videorcCounters = counts
  const origSetItem = Storage.prototype.setItem
  Storage.prototype.setItem = function (key, value) {
    counts.localStorageSet += 1
    counts.localStorageBytes += String(value).length
    return origSetItem.call(this, key, value)
  }
  const origSend = WebSocket.prototype.send
  WebSocket.prototype.send = function (data) {
    counts.wsOut += 1
    counts.wsOutBytes += typeof data === 'string' ? data.length : (data.byteLength ?? 0)
    return origSend.call(this, data)
  }
  window.addEventListener('message', () => {}, true)
  const origStringify = JSON.stringify
  JSON.stringify = function (...args) {
    const result = origStringify.apply(this, args)
    counts.jsonStringify += 1
    counts.jsonStringifyBytes += typeof result === 'string' ? result.length : 0
    return result
  }
  return 'instrumented'
})()`

const userDataDir = mkdtempSync(join(tmpdir(), 'videorc-counter-userdata-'))
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
    const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(line)
    if (match) devtoolsUrl = match[1]
  }
})

try {
  if (!devtoolsUrl) throw new Error('No DevTools endpoint observed.')
  const { host } = new URL(devtoolsUrl.replace('ws://', 'http://'))
  await sleep(10000)
  const targets = await fetchJson(`http://${host}/json/list`)
  const mainTarget = targets.find(
    (target) => target.type === 'page' && /^https?:\/\/localhost/.test(target.url ?? '')
  )
  if (!mainTarget) throw new Error('Main window target not found.')

  const cdp = await CdpClient.connect(mainTarget.webSocketDebuggerUrl)
  try {
    const setup = await cdp.send('Runtime.evaluate', { expression: INSTRUMENT })
    console.log('instrumentation:', setup.result?.value)
    console.log(`counting for ${windowSeconds}s...`)
    await sleep(windowSeconds * 1000)
    const read = await cdp.send('Runtime.evaluate', {
      expression: 'JSON.stringify(window.__videorcCounters)',
      returnByValue: true
    })
    const counts = JSON.parse(read.result.value)
    console.log('\n=== renderer hot-path rates ===')
    for (const [key, value] of Object.entries(counts)) {
      const perSecond = value / windowSeconds
      const display = key.endsWith('Bytes')
        ? `${(perSecond / 1024).toFixed(1)}KB/s`
        : `${perSecond.toFixed(1)}/s`
      console.log(`  ${key.padEnd(20)} ${display}`)
    }
  } finally {
    cdp.close()
  }
} finally {
  await launched.stop()
}
