#!/usr/bin/env node
// Plan 203 S7. Real macOS dev app, isolated profile, CDP observations only.
// No permission buttons are pressed. Cold TCC prompts need the owner's S0 pass.
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { get } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { launchDevApp, repoRoot } from './lib/app-launcher.mjs'
import { evaluateFirstRunSmokeStep, FIRST_RUN_SMOKE_LIMITS } from './lib/first-run-smoke-gate.mjs'

if (process.platform !== 'darwin')
  throw new Error('First-run app smoke requires macOS; Windows acceptance is owner-owed.')
if (!existsSync(join(repoRoot, 'target/debug/videorc-backend'))) {
  throw new Error('Build target/debug/videorc-backend before running this smoke.')
}
// The existing debug backend is required. Do not rebuild Rust for this UI smoke.
process.env.VIDEORC_SMOKE_SKIP_PREBUILD = '1'
const outputRoot = resolve(process.env.VIDEORC_SMOKE_OUTPUT_DIR ?? tmpdir())
mkdirSync(outputRoot, { recursive: true })
const output = mkdtempSync(join(outputRoot, 'videorc-first-run-'))
const report = { limits: FIRST_RUN_SMOKE_LIMITS, output, steps: [] }
const save = () =>
  writeFileSync(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
let cdp
let launched
let devtoolsUrl

function fetchTargets(host) {
  return new Promise((resolveTargets, reject) => {
    const req = get(`http://${host}/json/list`, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => {
        body += chunk
      })
      response.on('error', reject)
      response.on('end', () => {
        try {
          resolveTargets(JSON.parse(body))
        } catch (error) {
          reject(error)
        }
      })
    })
    req.setTimeout(5000, () => req.destroy(new Error('CDP target discovery timed out')))
    req.on('error', reject)
  })
}

async function connect(url) {
  const ws = new WebSocket(url)
  await new Promise((resolveOpen, reject) => {
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error('CDP connect timed out'))
    }, 5000)
    ws.addEventListener(
      'open',
      () => {
        clearTimeout(timer)
        resolveOpen()
      },
      { once: true }
    )
    ws.addEventListener(
      'error',
      () => {
        clearTimeout(timer)
        reject(new Error('CDP connect failed'))
      },
      { once: true }
    )
  })
  let nextId = 0
  const pending = new Map()
  const listeners = new Set()
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id) {
      const request = pending.get(message.id)
      if (!request) return
      pending.delete(message.id)
      clearTimeout(request.timer)
      if (message.error) request.reject(new Error(message.error.message))
      else request.resolve(message.result)
    } else for (const listener of listeners) listener(message)
  })
  ws.addEventListener('close', () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(new Error('CDP closed'))
    }
    pending.clear()
  })
  return {
    listeners,
    close: () => ws.close(),
    call: (method, params = {}) =>
      new Promise((resolveCall, reject) => {
        const id = ++nextId
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`CDP ${method} timed out`))
        }, 10000)
        pending.set(id, { resolve: resolveCall, reject, timer })
        ws.send(JSON.stringify({ id, method, params }))
      })
  }
}

async function evaluate(expression) {
  const result = await cdp.call('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  })
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
  return result.result?.value
}

// Installed BEFORE reload, so mount and moving timestamps share the renderer's
// monotonic clock and no polling/launch delay is subtracted from the measurement.
// Count only the final draw to the default canvas framebuffer, excluding
// offscreen shader passes. Retain contexts to prove disposal on leave.
const instrument = `(() => {
  const evidence = window.__firstRunSmoke = {
    documentId: crypto.randomUUID(), mountedAt: null, movingAt: null, setupEver: false,
    workspaceBeforeSetup: false, whatsNewOverSetup: false, draws: [], contexts: []
  };
  const draw = WebGL2RenderingContext.prototype.drawArrays;
  WebGL2RenderingContext.prototype.drawArrays = function(...args) {
    if (this.canvas.closest('[data-first-run-backdrop-canvas]') && this.getParameter(this.DRAW_FRAMEBUFFER_BINDING) === null) {
      evidence.draws.push(performance.now());
      if (!evidence.contexts.includes(this)) evidence.contexts.push(this);
    }
    return draw.apply(this, args);
  };
  const observe = () => {
    const setup = document.querySelector('[data-first-run-setup]');
    if (setup) {
      evidence.setupEver = true;
      evidence.mountedAt ??= performance.now();
      if (document.querySelector('[data-first-run-backdrop="moving"]')) evidence.movingAt ??= performance.now();
      if (Array.from(document.querySelectorAll('[role="dialog"]')).some(el => /What's new in Videorc/.test(el.textContent))) evidence.whatsNewOverSetup = true;
    } else if (!evidence.setupEver && document.querySelector('aside')) evidence.workspaceBeforeSetup = true;
  };
  new MutationObserver(observe).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-first-run-backdrop', 'data-first-run-setup'] });
  observe();
})();`

const stateExpression = `(() => {
  const setup = document.querySelector('[data-first-run-setup]');
  const backdrop = document.querySelector('[data-first-run-backdrop]');
  const e = window.__firstRunSmoke;
  const recordRaw = localStorage.getItem('videorc.firstRun');
  return {
    setup: setup?.dataset.firstRunSetup ?? null, mode: setup?.dataset.firstRunMode ?? null,
    cardStep: document.querySelector('[data-slot="first-run-card"]')?.dataset.firstRunStep ?? null,
    rows: Array.from(document.querySelectorAll('[data-slot="system-access-row"]')).map(row => row.dataset.state),
    loading: !!document.querySelector('[data-first-run-rows="loading"]'),
    primaryCount: document.querySelectorAll('[data-first-run-primary]').length,
    primary: document.querySelector('[data-first-run-primary]')?.textContent.trim() ?? null,
    microphoneProof: !!document.querySelector('[data-first-run-microphone-proof]'),
    sidebar: !!document.querySelector('aside'),
    backdrop: backdrop?.dataset.firstRunBackdrop ?? null,
    reason: backdrop?.dataset.firstRunBackdropReason ?? null,
    look: backdrop?.dataset.firstRunBackdropLook ?? null,
    canvasCount: document.querySelectorAll('[data-first-run-backdrop-canvas] canvas').length,
    recordRaw, record: recordRaw ? JSON.parse(recordRaw) : null,
    whatsNew: Array.from(document.querySelectorAll('[role="dialog"]')).some(el => /What's new in Videorc/.test(el.textContent)),
    settingsGeneral: !!document.querySelector('[data-videorc-tab-trigger="settings"][aria-current="page"]') && !!document.querySelector('[data-videorc-settings-tab="general"][data-state="active"]'),
    documentId: e?.documentId, setupEver: e?.setupEver, workspaceBeforeSetup: e?.workspaceBeforeSetup,
    whatsNewOverSetup: e?.whatsNewOverSetup,
    mountToMovingMs: !e || e.movingAt === null || e.mountedAt === null ? null : e.movingAt - e.mountedAt,
    retainedContextsLost: !!e?.contexts.length && e.contexts.every(gl => gl.isContextLost())
  };
})()`
const state = () => evaluate(stateExpression)

async function waitFor(label, predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      last = await state()
    } catch (error) {
      // Navigation can destroy the old execution context before the new one exists.
      if (!/context|navigation/i.test(error.message)) throw error
      await delay(50)
      continue
    }
    if (predicate(last)) return last
    await delay(50)
  }
  throw new Error(`${label} timed out: ${JSON.stringify(last)}`)
}

async function check(step, observation) {
  const result = evaluateFirstRunSmokeStep(step, observation)
  report.steps.push({ step, ...result, observation })
  save()
  console.log(`${result.pass ? 'PASS' : 'FAIL'} ${step}: ${JSON.stringify(observation)}`)
  if (!result.pass) throw new Error(`${step}: ${result.failures.join('; ')}`)
}

async function screenshot(name) {
  const { data } = await cdp.call('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(output, `${name}.png`), Buffer.from(data, 'base64'))
}

async function reloadWith(keys) {
  const previousDocument = (await state()).documentId
  if (keys)
    await evaluate(
      `localStorage.clear(); for (const [key, value] of Object.entries(${JSON.stringify(keys)})) localStorage.setItem(key, value)`
    )
  await cdp.call('Page.reload', { ignoreCache: true })
  // Do not accidentally accept the previous document's state.
  await waitFor(
    'new document instrument',
    (s) =>
      s.documentId &&
      s.documentId !== previousDocument &&
      (s.cardStep === 'permissions' || s.sidebar)
  )
}

async function click(selector) {
  await evaluate(
    `(() => { const button = document.querySelector(${JSON.stringify(selector)}); if (!button || button.disabled) throw new Error('Missing or disabled control: ' + ${JSON.stringify(selector)}); button.click(); })()`
  )
}

async function motionSample() {
  const frames = []
  const listener = (message) => {
    if (message.method !== 'Page.screencastFrame') return
    frames.push(message.params)
    void cdp
      .call('Page.screencastFrameAck', { sessionId: message.params.sessionId })
      .catch(() => {})
  }
  cdp.listeners.add(listener)
  // Start after loading rows and transitions settle. The frame stream includes
  // card/meter changes too; actual backdrop draws are measured separately.
  await cdp.call('Page.startScreencast', {
    format: 'png',
    maxWidth: 960,
    maxHeight: 720,
    everyNthFrame: 1
  })
  await evaluate(
    'window.__firstRunSmoke.draws = []; window.__firstRunSmoke.sampleAt = performance.now()'
  )
  await delay(2100)
  const sample = await evaluate(
    `({ durationMs: performance.now() - window.__firstRunSmoke.sampleAt, drawCount: window.__firstRunSmoke.draws.length })`
  )
  await cdp.call('Page.stopScreencast')
  cdp.listeners.delete(listener)
  const hash = (frame) =>
    frame ? createHash('sha256').update(Buffer.from(frame.data, 'base64')).digest('hex') : null
  for (const [name, frame] of [
    ['motion-first', frames[0]],
    ['motion-last', frames.at(-1)]
  ]) {
    if (frame) writeFileSync(join(output, `${name}.png`), Buffer.from(frame.data, 'base64'))
  }
  return {
    ...(await state()),
    ...sample,
    drawFps: sample.drawCount / (sample.durationMs / 1000),
    frameCount: frames.length,
    firstHash: hash(frames[0]),
    lastHash: hash(frames.at(-1)),
    firstLastDiffer: frames.length > 1 && hash(frames[0]) !== hash(frames.at(-1))
  }
}

try {
  console.log(`First-run smoke output: ${output}`)
  launched = await launchDevApp({
    timeoutMs: 180000,
    env: {
      VIDEORC_SMOKE_OUTPUT_DIR: output,
      VIDEORC_SMOKE_STATE_DIR: output,
      VIDEORC_APP_DATA_DIR: join(output, 'app-data'),
      VIDEORC_USER_DATA_DIR: join(output, 'user-data'),
      VIDEORC_DEV_BACKEND_PROFILE: 'debug',
      VIDEORC_SMOKE_SKIP_FIRST_RUN: '0',
      VIDEORC_REMOTE_DEBUG_PORT: '0'
    },
    onLine: (line) => {
      appendFileSync(join(output, 'app.log'), `${line}\n`)
      const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(line)
      if (match) devtoolsUrl = match[1]
    }
  })
  if (!devtoolsUrl) throw new Error('Missing DevTools listening handshake')
  const { host } = new URL(devtoolsUrl)
  const targets = await fetchTargets(host)
  const target = targets.find(
    (item) => item.type === 'page' && /^https?:\/\/localhost/.test(item.url ?? '')
  )
  if (!target) throw new Error('Main window CDP target not found')
  cdp = await connect(target.webSocketDebuggerUrl)
  await cdp.call('Page.enable')
  await cdp.call('Page.bringToFront')
  await cdp.call('Page.addScriptToEvaluateOnNewDocument', { source: instrument })
  await evaluate(instrument)
  // The untouched profile proves first launch too; only the following reload
  // is used for timing because CDP attached after this document mounted.
  await check(
    'fresh',
    await waitFor('initial fresh setup', (s) => s.setup === 'open' && s.rows.length === 4)
  )
  await reloadWith({})
  await check(
    'fresh',
    await waitFor('fresh rows', (s) => s.setup === 'open' && s.rows.length === 4)
  )
  await check(
    'moving',
    await waitFor('moving backdrop', (s) => ['moving', 'still'].includes(s.backdrop), 5000)
  )
  await screenshot('fresh')
  await check('motion', await motionSample())

  await cdp.call('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
  })
  await check(
    'reduced-motion',
    await waitFor('reduced motion still', (s) => s.backdrop === 'still')
  )
  await screenshot('reduced-motion')
  await cdp.call('Emulation.setEmulatedMedia', { features: [] })
  await check(
    'moving',
    await waitFor(
      'motion restored',
      (s) => ['moving', 'still'].includes(s.backdrop) && s.reason !== 'reduced-motion'
    )
  )

  const pressedPrimary = (await state()).primary
  await click('[data-first-run-primary]')
  const finished = await waitFor('workspace after primary', (s) => s.setup === null && s.sidebar)
  await check('finish', { ...finished, pressedPrimary })
  const beforeRecordRaw = finished.recordRaw
  await reloadWith()
  await check('reload', { ...(await state()), beforeRecordRaw })

  await reloadWith({ 'videorc.whatsNewLastSeenVersion': '999.0.0' })
  await check('existing-install', await state())

  const resumeRecord = JSON.stringify({
    version: 1,
    status: 'in-progress',
    step: 'permissions',
    updatedAt: new Date().toISOString()
  })
  await reloadWith({ 'videorc.firstRun': resumeRecord })
  await check('resume', await waitFor('resumed rows', (s) => s.rows.length === 4))

  await click('[data-first-run-primary]')
  await waitFor('workspace for Settings', (s) => s.sidebar && !s.setup)
  await click('[data-videorc-tab-trigger="settings"]')
  await waitFor('Settings General', (s) => s.settingsGeneral)
  const replayRecord = (await state()).recordRaw
  await evaluate(
    `(() => { const button = Array.from(document.querySelectorAll('button')).find(el => el.textContent.trim() === 'Run setup again…'); if (!button || button.disabled) throw new Error('Run setup again… unavailable'); button.click(); })()`
  )
  await check('replay-open', {
    ...(await waitFor('replay rows', (s) => s.mode === 'replay' && s.rows.length === 4)),
    beforeRecordRaw: replayRecord
  })
  await screenshot('replay')
  await click('[data-first-run-primary]')
  await check('replay-return', {
    ...(await waitFor('return to Settings', (s) => !s.setup && s.settingsGeneral)),
    beforeRecordRaw: replayRecord
  })

  // An old What's New key alone migrates, so use an in-progress record with
  // the old version to exercise the startup ordering without migration hiding setup.
  await reloadWith({ 'videorc.firstRun': resumeRecord, 'videorc.whatsNewLastSeenVersion': '0.0.1' })
  await waitFor('old-version setup', (s) => s.setup === 'open' && s.rows.length === 4)
  const watchStart = Date.now()
  await delay(FIRST_RUN_SMOKE_LIMITS.whatsNewWatchMs + 100)
  await check('whats-new', {
    ...(await state()),
    seededWhatsNew: '0.0.1',
    watchMs: Date.now() - watchStart
  })
  await screenshot('whats-new-held')
  report.pass = true
  console.log('PASS first-run smoke: all steps passed')
} catch (error) {
  report.pass = false
  report.error = error.stack ?? String(error)
  if (cdp) {
    try {
      report.failureState = await state()
      await screenshot('failure')
    } catch {
      /* App may have exited. */
    }
  }
  console.error(`FAIL first-run smoke: ${error.message}`)
  process.exitCode = 1
} finally {
  cdp?.close()
  if (launched) await launched.stop()
  save()
  console.log(`Report: ${join(output, 'report.json')}`)
}
