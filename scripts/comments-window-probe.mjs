#!/usr/bin/env node
// Comments window probe — headless verification of the detached comments window.
// Opens / moves / toggle-closes / toggle-reopens via the smoke command server
// and asserts the window's reported state + frame persistence. Real-machine
// bound (Electron + a display); mirrors scripts/preview-window-probe.mjs, but
// the comments window is a plain window with no native surface to track.
//
//   node scripts/comments-window-probe.mjs
//
// Exits 0 when all assertions pass, 1 otherwise.

import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { launchDevApp, stopProcess } from './lib/app-launcher.mjs'

const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 180000)
const outputDirectory = join(tmpdir(), `videorc-comments-window-probe-${Date.now()}`)
mkdirSync(outputDirectory, { recursive: true })

let launched
let smoke
const failures = []
let exitCode = 0
try {
  exitCode = await main()
} catch (error) {
  console.error(`comments window probe failed: ${error?.message ?? error}`)
  exitCode = 2
} finally {
  if (launched) await stopProcess(launched.process)
}
process.exit(exitCode)

async function main() {
  console.log('Launching dev app for comments window probe…')
  launched = await launchDevApp({
    timeoutMs,
    requiredMarkers: ['backend-ready', 'preview-motion-ready'],
    env: {
      VIDEORC_SMOKE_OUTPUT_DIR: outputDirectory,
      VIDEORC_COMMENTS_WINDOW: '1',
      VIDEORC_DISABLE_AUTO_PREVIEW: '1',
      VIDEORC_SMOKE_COMMAND_SERVER: '1'
    },
    onLine: (line) => console.log(line)
  })
  // The smoke command server announces itself under the preview-motion-ready marker.
  smoke = launched.connections['preview-motion-ready']

  const opened = await smokeCommand('comments-window-open')
  assertProbe(opened.open === true, 'open: comments window reports open', JSON.stringify(opened))
  assertProbe(
    opened.protected === true,
    'protection: comments window reports content protection enabled',
    JSON.stringify(opened)
  )

  await smokeCommand('comments-window-push-snapshot', { snapshot: fixtureSnapshot() })
  const reader = await waitFor(
    () => smokeCommand('comments-window-reader-state'),
    (s) =>
      s.open &&
      s.messageCount === 2 &&
      s.text.includes('Probe Viewer') &&
      s.text.includes('Saved transcript hello'),
    8000
  )
  assertProbe(
    reader.ok,
    'reader: pushed saved transcript renders in the detached window',
    JSON.stringify(reader.last)
  )

  await smokeCommand('comments-window-set-bounds', { x: 200, y: 140, width: 420, height: 640 })
  const placed = await waitFor(
    () => smokeCommand('comments-window-state'),
    (s) =>
      s.open &&
      s.bounds &&
      Math.abs(s.bounds.width - 420) <= 6 &&
      Math.abs(s.bounds.height - 640) <= 6,
    8000
  )
  assertProbe(placed.ok, 'bounds: window reports the requested size', JSON.stringify(placed.last))

  const closed = await smokeCommand('comments-window-toggle')
  assertProbe(
    closed.open === false,
    'toggle close: comments window reports closed',
    JSON.stringify(closed)
  )

  const reopened = await smokeCommand('comments-window-toggle')
  assertProbe(
    reopened.open === true,
    'toggle reopen: comments window reports open',
    JSON.stringify(reopened)
  )
  const restored = await waitFor(
    () => smokeCommand('comments-window-state'),
    (s) => s.open && s.bounds && Math.abs(s.bounds.width - 420) <= 6,
    8000
  )
  assertProbe(restored.ok, 'reopen: persisted frame restored', JSON.stringify(restored.last))

  console.log('\n=== Comments window probe summary ===')
  if (failures.length === 0) {
    console.log(
      'PASS — open, content protection, seeded transcript rendering, toggle, and frame persistence.'
    )
    return 0
  }
  for (const failure of failures) console.log(`FAIL: ${failure}`)
  return 1
}

async function waitFor(fetchState, predicate, timeoutMsLocal) {
  const deadline = Date.now() + timeoutMsLocal
  let last = null
  do {
    last = await fetchState()
    if (predicate(last)) return { ok: true, last }
    await sleep(250)
  } while (Date.now() < deadline)
  return { ok: false, last }
}

async function smokeCommand(command, params = {}) {
  const response = await fetch(`http://${smoke.host}:${smoke.port}/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command, params })
  })
  const payload = await response.json()
  if (!response.ok || !payload.ok) {
    throw new Error(payload?.error ?? `${command} smoke command failed`)
  }
  return payload.result
}

function assertProbe(condition, label, detail) {
  if (condition) {
    console.log(`OK   ${label}`)
  } else {
    console.log(`FAIL ${label} — ${detail}`)
    failures.push(`${label} — ${detail}`)
  }
}

function fixtureSnapshot() {
  return {
    sessionId: 'comments-window-probe-session',
    providers: [],
    messages: [
      {
        id: 'youtube:probe-1',
        providerMessageId: 'probe-1',
        platform: 'youtube',
        sessionId: 'comments-window-probe-session',
        authorName: 'Probe Viewer',
        authorBadges: [],
        authorRoles: [],
        publishedAt: '2026-07-02T00:00:01Z',
        receivedAt: '2026-07-02T00:00:02Z',
        messageText: 'Saved transcript hello',
        fragments: [{ type: 'text', text: 'Saved transcript hello' }],
        eventType: 'message',
        isDeleted: false
      },
      {
        id: 'twitch:probe-2',
        providerMessageId: 'probe-2',
        platform: 'twitch',
        sessionId: 'comments-window-probe-session',
        authorName: 'Second Viewer',
        authorBadges: [],
        authorRoles: [],
        publishedAt: '2026-07-02T00:00:03Z',
        receivedAt: '2026-07-02T00:00:04Z',
        messageText: 'Another saved comment',
        fragments: [{ type: 'text', text: 'Another saved comment' }],
        eventType: 'message',
        isDeleted: false
      }
    ],
    unreadCount: 2,
    updatedAt: '2026-07-02T00:00:05Z'
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
