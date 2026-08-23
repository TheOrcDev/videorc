// F-014 gate: a dead backend must never leave the app a zombie that reports
// Ready. Kills the backend mid-run and asserts the Session badge flips to
// "Backend offline", the supervisor restarts the process, and the badge heals
// back to Ready with a working socket.
//
// Live-feedback batch 3 (B1): the crash must also leave durable evidence —
// userData/backend-crashes.json gains a record naming the signal with the
// dying generation's stderr tail, and userData/logs/backend.log exists — so a
// support bundle exported AFTER the restart can still explain the crash.
//
// Run: pnpm smoke:backend-resilience

import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { launchDevApp, stopProcess } from './lib/app-launcher.mjs'

const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 120000)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Pin the Electron userData dir so the crash evidence can be read back here.
const userDataDir = mkdtempSync(join(tmpdir(), 'videorc-smoke-resilience-user-data-'))
const crashLogPath = join(userDataDir, 'backend-crashes.json')
const backendLogPath = join(userDataDir, 'logs', 'backend.log')

const launched = await launchDevApp({
  requiredMarkers: ['backend-ready', 'preview-motion-ready'],
  timeoutMs,
  env: {
    VIDEORC_SMOKE_PRINT_BACKEND_READY: '1',
    VIDEORC_SMOKE_COMMAND_SERVER: '1',
    VIDEORC_SMOKE_PREVIEW_MOTION: '1',
    VIDEORC_USER_DATA_DIR: userDataDir
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
  console.log('Backend resilience: supervisor restarted, badge healed to Ready.')

  const record = await waitForCrashRecord(backend.pid)
  console.log(
    `Backend resilience: crash record persisted (generation ${record.generation}, signal ${record.signal}, attempt ${record.attempt}, ${record.stderrTail.length} stderr lines).`
  )
  if (!existsSync(backendLogPath) || statSync(backendLogPath).size === 0) {
    throw new Error(`Expected a non-empty backend log at ${backendLogPath}.`)
  }
  const backendLog = readFileSync(backendLogPath, 'utf8')
  if (!backendLog.includes('Recorded backend crash evidence')) {
    throw new Error(`backend.log does not mention the crash record:\n${backendLog.slice(-2000)}`)
  }
  console.log(`Backend resilience: backend.log kept ${backendLog.split('\n').length} lines.`)

  const runtimeInfo = await sendSmokeCommand(smoke, 'eval-js', {
    code: 'return await window.videorc.getRuntimeInfo()'
  })
  const exported = runtimeInfo?.result?.backendCrashes
  if (!Array.isArray(exported) || exported[0]?.at !== record.at) {
    throw new Error(
      `runtimeInfo.backendCrashes does not lead with the persisted record: ${JSON.stringify(exported)?.slice(0, 500)}`
    )
  }
  console.log(
    'Backend resilience smoke OK — offline surfaced, supervisor restarted, badge healed to Ready, crash evidence persisted and exported via runtimeInfo.'
  )
} finally {
  await stopProcess(launched.process, { timeoutMs: 15000 })
}

// The supervisor-restarted backend inherits the app's stdio pipes, which keeps
// this script's event loop alive after the assertions pass — exit explicitly
// (same pattern as preview-lifecycle-probe.mjs).
process.exit(0)

async function waitForCrashRecord(killedPid, budgetMs = 15_000) {
  const deadline = Date.now() + budgetMs
  let last = null
  while (Date.now() < deadline) {
    try {
      const parsed = JSON.parse(readFileSync(crashLogPath, 'utf8'))
      const records = Array.isArray(parsed?.records) ? parsed.records : []
      last = records
      const record = records.find((entry) => entry?.intentional === false)
      if (record) {
        // Packaged: the supervisor's child IS the backend → signal SIGKILL.
        // Dev: the child is `cargo run`, which exits 101 and prints the
        // backend's "(signal: 9, SIGKILL: kill)" line — captured in the tail.
        const namesKill =
          record.signal === 'SIGKILL' ||
          (Array.isArray(record.stderrTail) &&
            record.stderrTail.some((line) => /SIGKILL|signal: 9\b/.test(line)))
        if (!namesKill) {
          throw new Error(
            `Crash record for the killed backend (pid ${killedPid}) must name SIGKILL (signal or stderr tail), saw ${JSON.stringify(record)}`
          )
        }
        if (!Array.isArray(record.stderrTail) || record.stderrTail.length === 0) {
          throw new Error(`Crash record carries no stderr tail: ${JSON.stringify(record)}`)
        }
        if (!Number.isInteger(record.attempt) || record.attempt < 1) {
          throw new Error(`Crash record has no restart attempt: ${JSON.stringify(record)}`)
        }
        return record
      }
    } catch (error) {
      if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) {
        throw error
      }
      last = `read error: ${error.message}`
    }
    await sleep(300)
  }
  throw new Error(
    `Timed out waiting for a crash record in ${crashLogPath}; last saw ${JSON.stringify(last)}.`
  )
}

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
