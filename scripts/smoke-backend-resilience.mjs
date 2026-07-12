// F-014 gate: a dead backend must never leave the app a zombie that reports
// Ready. Kills the backend mid-run and asserts the Session badge flips to
// "Backend offline", the supervisor restarts the process, and the badge heals
// back to Ready with a working socket.
//
// Run: pnpm smoke:backend-resilience

import { request as httpRequest } from 'node:http'

import { launchDevApp, stopProcess } from './lib/app-launcher.mjs'

const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 120000)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const launched = await launchDevApp({
  requiredMarkers: ['backend-ready', 'preview-motion-ready'],
  timeoutMs,
  env: {
    VIDEORC_SMOKE_PRINT_BACKEND_READY: '1',
    VIDEORC_SMOKE_COMMAND_SERVER: '1',
    VIDEORC_SMOKE_PREVIEW_MOTION: '1'
  }
})

try {
  const smoke = launched.connections['preview-motion-ready']
  const backend = launched.connections['backend-ready']
  if (!backend?.pid) {
    throw new Error('backend-ready marker did not include the backend pid.')
  }

  await smokeCommand(smoke, 'open-tab', { tab: 'studio' })
  await waitForBadge(smoke, 'Ready', 'initial Ready badge')
  console.log(`Backend resilience: initial badge Ready (backend pid ${backend.pid}).`)

  process.kill(backend.pid, 'SIGKILL')
  console.log('Backend resilience: sent SIGKILL to the backend.')

  await waitForBadge(smoke, 'Backend offline', 'offline badge after backend death')
  console.log('Backend resilience: Session badge reports Backend offline.')

  await waitForBadge(smoke, 'Ready', 'Ready badge after supervisor restart', 60_000)
  console.log(
    'Backend resilience smoke OK — offline surfaced, supervisor restarted, badge healed to Ready.'
  )
} finally {
  await stopProcess(launched.child, { timeoutMs: 15000 })
}

// The supervisor-restarted backend inherits the app's stdio pipes, which keeps
// this script's event loop alive after the assertions pass — exit explicitly
// (same pattern as preview-lifecycle-probe.mjs).
process.exit(0)

async function waitForBadge(smoke, expected, label, budgetMs = 30_000) {
  const deadline = Date.now() + budgetMs
  let last = null
  while (Date.now() < deadline) {
    try {
      // The badge carries a dedicated data hook (studio-tab.tsx). The old
      // probe grepped main divs for a "Status" text prefix — that prefix died
      // with the 0.9.7 session-panel declutter, so the smoke saw null forever.
      const result = await sendSmokeCommand(smoke, 'eval-js', {
        code: `
          const badge = document.querySelector('[data-videorc-session-status]');
          return badge ? badge.textContent.trim() : null;
        `
      })
      last = result?.result ?? null
      if (last === expected) {
        return
      }
    } catch (error) {
      last = `command error: ${error.message}`
    }
    await sleep(400)
  }
  throw new Error(`Timed out waiting for ${label}: expected "${expected}", last saw "${last}".`)
}

function sendSmokeCommand(smoke, command, params = {}) {
  const body = JSON.stringify({ command, params })
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: smoke.host,
        port: smoke.port,
        path: '/command',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Authorization: `Bearer ${smoke.capability}`
        }
      },
      (res) => {
        res.setEncoding('utf8')
        let text = ''
        res.on('data', (chunk) => (text += chunk))
        res.on('end', () => {
          try {
            const payload = JSON.parse(text)
            if (res.statusCode !== 200) {
              reject(new Error(payload.error ?? `HTTP ${res.statusCode}`))
            } else {
              resolve(payload.result ?? payload)
            }
          } catch {
            reject(new Error(`Bad smoke response (${res.statusCode}): ${text.slice(0, 300)}`))
          }
        })
      }
    )
    req.on('error', reject)
    req.setTimeout(15000, () => req.destroy(new Error('smoke command timeout')))
    req.end(body)
  })
}

async function smokeCommand(smoke, command, params = {}) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      return await sendSmokeCommand(smoke, command, params)
    } catch (error) {
      lastError = error
      await sleep(250)
    }
  }
  throw lastError ?? new Error(`Timed out waiting for smoke command ${command}.`)
}
