// Both-theme screenshot sweep for the glass redesign slices.
//
// Launches an isolated instance (fresh profile — proves the dark default),
// captures the requested tabs in dark, flips the theme to light via CDP
// (localStorage + reload, the same mechanism the toggle persists through),
// and captures again. PNGs land in VIDEORC_SMOKE_OUTPUT_DIR (/tmp).
//
// Usage: node scripts/ui-theme-screens.mjs [tab ...]   (default: studio streaming)

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request as httpRequest } from 'node:http'
import { promisify } from 'node:util'

import { launchDevApp } from './lib/app-launcher.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

const execFileAsync = promisify(execFile)

const tabs = process.argv.slice(2).length ? process.argv.slice(2) : ['studio', 'streaming']
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

async function smokeCommandRetry(smoke, command, params = {}) {
  const deadline = Date.now() + 30000
  let last
  while (Date.now() < deadline) {
    try {
      return await smokeCommand(smoke, command, params)
    } catch (e) {
      last = e
      const m = String(e?.message ?? e)
      if (!m.includes('Main window is not ready') && !m.includes('Could not find tab')) throw e
      await sleep(250)
    }
  }
  throw last
}

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

async function cdpCall(host, method, params) {
  const targets = await fetchJson(`http://${host}/json/list`)
  const mainTarget = targets.find(
    (target) => target.type === 'page' && /^https?:\/\/localhost/.test(target.url ?? '')
  )
  if (!mainTarget) throw new Error('Main window CDP target not found.')
  return new Promise((resolveCall, rejectCall) => {
    const ws = new WebSocket(mainTarget.webSocketDebuggerUrl)
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ id: 1, method, params }))
    })
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id === 1) {
        ws.close()
        if (message.error) rejectCall(new Error(message.error.message))
        else resolveCall(message.result)
      }
    })
    ws.addEventListener('error', () => rejectCall(new Error('CDP connect failed')))
  })
}

async function cdpEvaluate(host, expression) {
  const result = await cdpCall(host, 'Runtime.evaluate', { expression, returnByValue: true })
  return result?.result?.value
}

// Compositor-direct screenshot: immune to window occlusion, transparency, and
// the post-reload presentation detach. The truth for "what does the UI render".
async function cdpScreenshot(host, name) {
  const result = await cdpCall(host, 'Page.captureScreenshot', { format: 'png' })
  const file = `/tmp/videorc-ui-${name}.png`
  const { writeFileSync } = await import('node:fs')
  writeFileSync(file, Buffer.from(result.data, 'base64'))
  console.log(`${name} (cdp): ${file}`)
  return file
}

// `screencapture -l` grabs the REAL composited window (vibrancy included) and
// is the PRIMARY capture: capturePage returns blank frames on the transparent
// vibrancy window. Falls back to capture-page when Screen Recording
// permission is missing.
async function compositedShot(smoke, name) {
  try {
    const { windowId, bounds } = await smokeCommand(smoke, 'main-window-id')
    if (windowId) {
      const file = `/tmp/videorc-ui-${name}.png`
      // Region capture (-R): photographs what the window server actually
      // displays. Window-id capture (-l) misses layers that detach from the
      // window backing after an in-place reload on vibrancy windows.
      if (bounds && process.env.VIDEORC_SHOTS_REGION === '1') {
        await execFileAsync('screencapture', [
          '-x',
          `-R${bounds.x},${bounds.y},${bounds.width},${bounds.height}`,
          file
        ])
      } else {
        await execFileAsync('screencapture', ['-o', '-x', `-l${windowId}`, file])
      }
      console.log(`${name}: ${file}`)
      return file
    }
  } catch (error) {
    console.log(`composited capture unavailable (${String(error?.message ?? error)})`)
  }
  const shot = await smokeCommand(smoke, 'capture-page', { name })
  console.log(`${name} (capture-page fallback): ${shot.file}`)
  return shot.file
}

async function captureAll(smoke, host, suffix) {
  for (const tab of tabs) {
    try {
      await smokeCommandRetry(smoke, 'open-tab', { tab })
    } catch {
      /* selector waits can time out while the tab still opens */
    }
    await sleep(1200)
    await cdpScreenshot(host, `${tab}-${suffix}`)
    if (process.env.VIDEORC_SHOTS_WINDOW === '1') {
      await compositedShot(smoke, `${tab}-${suffix}-window`)
    }
  }
}

async function seedCommentsRail(connection, smoke) {
  const ws = await connectBackend(connection, timeoutMs)
  const sessionId = `ui-theme-comments-${Date.now()}`
  const targets = {
    youtube: 'ui-theme-youtube',
    twitch: 'ui-theme-twitch',
    x: 'ui-theme-x'
  }
  await request(ws, timeoutMs, 'liveChat.start', {
    sessionId,
    platforms: Object.keys(targets),
    destinations: Object.entries(targets).map(([platform, targetId]) => ({ platform, targetId })),
    // Keep all three connectors live through both theme captures. One message
    // per platform per second is enough visual variety without flooding the rail.
    fakes: Object.entries(targets).map(([platform, targetId]) => ({
      platform,
      targetId,
      count: 120,
      intervalMs: 1000,
      send: platform === 'x' ? undefined : 'sent'
    }))
  })

  const deadline = Date.now() + 20_000
  let snapshot
  let seeded = false
  do {
    snapshot = await request(ws, timeoutMs, 'liveChat.status', {})
    const platforms = new Set(snapshot.messages.map((message) => message.platform))
    if (['youtube', 'twitch', 'x'].every((platform) => platforms.has(platform))) {
      console.log(
        `seeded Comments rail: ${snapshot.messages.length} messages across YouTube, Twitch, and X`
      )
      seeded = true
      break
    }
    await sleep(250)
  } while (Date.now() < deadline)

  if (!seeded) {
    ws.close()
    throw new Error(`Timed out seeding three-platform Comments rail: ${JSON.stringify(snapshot)}`)
  }

  // Prove renderer reconciliation, not only backend delivery: the terminal
  // websocket event must reach main's Comments cache without opening the
  // detached window or relying on the original RPC response.
  const operationId = randomUUID()
  const operation = await request(ws, timeoutMs, 'liveChat.send', {
    operationId,
    sessionId,
    text: 'Theme sweep host reply'
  })
  const relayDeadline = Date.now() + 10_000
  let relayedView
  do {
    relayedView = await smokeCommand(smoke, 'comments-window-set-view-mode', {
      mode: { kind: 'live' }
    })
    if (
      relayedView?.latestSendOperation?.id === operationId &&
      relayedView.latestSendOperation.phase === operation.phase
    ) {
      break
    }
    await sleep(100)
  } while (Date.now() < relayDeadline)
  if (
    relayedView?.latestSendOperation?.id !== operationId ||
    relayedView.latestSendOperation.phase !== operation.phase
  ) {
    ws.close()
    throw new Error(
      `Comments sendOperation event did not reconcile through the renderer: ${JSON.stringify(relayedView)}`
    )
  }
  console.log(`reconciled Comments send operation: ${operationId} (${operation.phase})`)
  return ws
}

async function commentsRailState(host) {
  return cdpEvaluate(
    host,
    `(() => {
      const rail = Array.from(document.querySelectorAll('aside'))
        .find((candidate) => candidate.textContent?.includes('Comments'));
      const messageIds = rail
        ? Array.from(rail.querySelectorAll('[data-message-id]'))
            .map((row) => row.getAttribute('data-message-id'))
            .filter(Boolean)
        : [];
      return {
        found: Boolean(rail),
        text: rail?.textContent ?? '',
        messageIds,
        platforms: ['youtube', 'twitch', 'x'].filter((platform) =>
          messageIds.some((id) => id.includes(':' + platform + ':'))
        )
      };
    })()`
  )
}

async function captureCommentsRail(smoke, host, suffix) {
  try {
    await smokeCommandRetry(smoke, 'open-tab', { tab: 'studio' })
  } catch {
    /* selector waits can time out while the tab still opens */
  }
  const deadline = Date.now() + 15_000
  let state
  do {
    state = await commentsRailState(host)
    if (
      state.found &&
      ['youtube', 'twitch', 'x'].every((platform) => state.platforms.includes(platform))
    ) {
      break
    }
    await sleep(250)
  } while (Date.now() < deadline)
  if (
    !state?.found ||
    !['youtube', 'twitch', 'x'].every((platform) => state.platforms.includes(platform))
  ) {
    throw new Error(`Three-platform Comments rail did not render: ${JSON.stringify(state)}`)
  }
  await sleep(500)
  await cdpScreenshot(host, `comments-rail-${suffix}`)
  if (process.env.VIDEORC_SHOTS_WINDOW === '1') {
    await compositedShot(smoke, `comments-rail-${suffix}-window`)
  }
}

let devtoolsUrl = null
let commentsBackendSocket = null
const userDataDir = mkdtempSync(join(tmpdir(), 'videorc-ui-shots-'))
const launched = await launchDevApp({
  requiredMarkers: ['backend-ready', 'preview-motion-ready'],
  timeoutMs,
  env: {
    VIDEORC_SMOKE_PREVIEW_MOTION: '1',
    VIDEORC_USER_DATA_DIR: userDataDir,
    VIDEORC_DATABASE_PATH: join(userDataDir, 'videorc.sqlite3'),
    VIDEORC_REMOTE_DEBUG_PORT: '0',
    VIDEORC_SMOKE_OUTPUT_DIR: '/tmp'
  },
  onLine: (line) => {
    const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(line)
    if (match) devtoolsUrl = match[1]
  }
})

const smoke = launched.connections['preview-motion-ready']

try {
  await sleep(6000)
  const { host } = new URL(devtoolsUrl.replace('ws://', 'http://'))

  const defaultThemeClass = await cdpEvaluate(host, 'document.documentElement.className')
  console.log(`fresh-profile root class: "${defaultThemeClass}"`)

  const paintDiag = async (label) => {
    const diag = await cdpEvaluate(
      host,
      `JSON.stringify({
        rootChildren: document.getElementById('root')?.childElementCount ?? null,
        styleSheets: document.styleSheets.length,
        rootOpacity: getComputedStyle(document.getElementById('root') ?? document.body).opacity,
        bodyBg: getComputedStyle(document.body).backgroundColor,
        hit: (e => (e ? e.tagName + '.' + String(e.className).slice(0, 60) : null))(document.elementFromPoint(300, 300)),
        text: document.body.innerText.slice(0, 80)
      })`
    )
    console.log(`paint diag (${label}):`, diag)
  }
  if (process.env.VIDEORC_SHOTS_DEBUG === '1') {
    await paintDiag('pre-reload')
  }

  // Dismiss onboarding for clean captures (fresh profiles always show it).
  // The radix Dialog unmounts on Escape/Skip; mutating localStorage alone is
  // not enough, but a reload after setting the flag never shows it again.
  if (process.env.VIDEORC_SHOTS_NO_RELOAD !== '1') {
    await cdpEvaluate(
      host,
      `localStorage.setItem('videorc.onboardingComplete', 'creator-ux-v1'); location.reload(); 'ok'`
    )
    await sleep(5000)
    if (process.env.VIDEORC_SHOTS_DEBUG === '1') {
      await paintDiag('post-reload')
    }
  }

  commentsBackendSocket = await seedCommentsRail(launched.connections['backend-ready'], smoke)

  // Optional: open the command palette (synthetic ⌘K on document — the shell
  // listens there) and capture it before the tab sweep.
  if (process.env.VIDEORC_SHOTS_PALETTE === '1') {
    await cdpEvaluate(
      host,
      `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true })); 'ok'`
    )
    await sleep(800)
    await cdpScreenshot(host, 'palette-dark')
    if (process.env.VIDEORC_SHOTS_WINDOW === '1') await compositedShot(smoke, 'palette-dark-window')
    await cdpEvaluate(
      host,
      `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true })); 'ok'`
    )
    await sleep(400)
  }

  await captureAll(smoke, host, 'dark')
  await captureCommentsRail(smoke, host, 'dark')

  console.log('flipping to light...')
  await cdpEvaluate(host, `localStorage.setItem('videorc.theme', 'light'); location.reload(); 'ok'`)
  await sleep(6000)
  const lightThemeClass = await cdpEvaluate(host, 'document.documentElement.className')
  console.log(`light root class: "${lightThemeClass}"`)
  await captureAll(smoke, host, 'light')
  await captureCommentsRail(smoke, host, 'light')
} finally {
  commentsBackendSocket?.close()
  await launched.stop()
}
