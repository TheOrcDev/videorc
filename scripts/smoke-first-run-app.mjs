#!/usr/bin/env node
// Plans 203 S7, 207 S8 and 212. Real macOS/Linux dev app, isolated profile.
// No permission buttons are pressed. Cold TCC prompts need the owner's S0 pass.
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { get } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { connectBackend, request } from './smoke-recording-session.mjs'
import { launchDevApp, repoRoot } from './lib/app-launcher.mjs'
import { ownedProcessLedgerPaths } from './lib/process-census.mjs'
import { stopFirstRunApp } from './lib/first-run-smoke-stop.mjs'
import { FIRST_RUN_SOURCE_TRACE_SCRIPT } from './lib/first-run-source-trace.mjs'
import { requestSmokeCommand, waitForRendererHook } from './lib/smoke-command-client.mjs'
import {
  evaluateFirstRunSmokeStep,
  FIRST_RUN_SMOKE_LIMITS,
  FIRST_RUN_SOURCE_START_PATTERNS,
  firstRunPermissionsReady,
  firstRunSourceStartLines
} from './lib/first-run-smoke-gate.mjs'

if (!['darwin', 'linux'].includes(process.platform))
  throw new Error('First-run app smoke requires macOS or Linux; Windows acceptance is owner-owed.')
if (!existsSync(join(repoRoot, 'target/debug/videorc-backend'))) {
  throw new Error('Build target/debug/videorc-backend before running this smoke.')
}
// The existing debug backend is required. Do not rebuild Rust for this UI smoke.
process.env.VIDEORC_SMOKE_SKIP_PREBUILD = '1'
// Electron must run as the app even when the caller is a Node-based harness.
delete process.env.ELECTRON_RUN_AS_NODE
const outputRoot = resolve(process.env.VIDEORC_SMOKE_OUTPUT_DIR ?? tmpdir())
mkdirSync(outputRoot, { recursive: true })
const output = mkdtempSync(join(outputRoot, 'videorc-first-run-'))
const report = {
  platform: process.platform,
  appMode: 'vite-development',
  screenshotSource: process.platform === 'linux' ? 'electron-content' : 'surface',
  limits: FIRST_RUN_SMOKE_LIMITS,
  output,
  steps: [],
  teardowns: [],
  sourceRequests: [],
  reloads: [],
  rendererErrors: []
}
const save = () =>
  writeFileSync(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
let cdp
let launched
let devtoolsUrl
let browserCdp
let backend
let appLines = []
let guard
let profileName
const themeShots = { dark: new Map(), light: new Map() }
const allSteps = ['permissions', 'goal', 'look', 'sound', 'destinations']

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
        const timeoutError = new Error(`CDP ${method} timed out`)
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(timeoutError)
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
    workspaceBeforeSetup: false, whatsNewOverSetup: false, draws: [], pictureDraws: [], contexts: [], toasts: [], closedAt: null,
    tones: [], flipMark: null, animationFrames: 0, windowVisible: null
  };
  ${FIRST_RUN_SOURCE_TRACE_SCRIPT}
  const countFrame = () => { evidence.animationFrames++; requestAnimationFrame(countFrame); };
  requestAnimationFrame(countFrame);
  window.videorc?.onWindowVisible?.(visible => { evidence.windowVisible = visible; });
  const draw = WebGL2RenderingContext.prototype.drawArrays;
  WebGL2RenderingContext.prototype.drawArrays = function(...args) {
    const backdrop = this.canvas.closest('[data-first-run-backdrop-canvas]');
    const picture = this.canvas.closest('[data-first-run-look-picture]');
    if ((backdrop || picture) && this.getParameter(this.DRAW_FRAMEBUFFER_BINDING) === null) {
      (backdrop ? evidence.draws : evidence.pictureDraws).push(performance.now());
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
      const tone = document.querySelector('[data-first-run-backdrop]')?.dataset.firstRunBackdropTone;
      if (tone && tone !== evidence.tones.at(-1)?.tone) evidence.tones.push({ tone, at: performance.now() });
      if (Array.from(document.querySelectorAll('[role="dialog"]')).some(el => /What's new in Videorc/.test(el.textContent))) evidence.whatsNewOverSetup = true;
    } else if (!evidence.setupEver && document.querySelector('aside')) evidence.workspaceBeforeSetup = true;
    else if (evidence.setupEver && evidence.closedAt === null) {
      evidence.closedAt = performance.timeOrigin + performance.now();
      window.__firstRunSetupClosed?.(String(evidence.closedAt));
    }
    for (const toast of document.querySelectorAll('[data-sonner-toast]')) {
      if (!evidence.toasts.includes(toast.textContent)) evidence.toasts.push(toast.textContent);
    }
  };
  new MutationObserver(observe).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-first-run-backdrop', 'data-first-run-backdrop-tone', 'data-first-run-setup'] });
  observe();
})();`

const stateExpression = `(() => {
  const setup = document.querySelector('[data-first-run-setup]');
  const backdrop = document.querySelector('[data-first-run-backdrop]');
  const picture = backdrop?.querySelector('[data-first-run-backdrop-picture]');
  const poster = picture?.querySelector('img');
  // Null for a moment while a reload swaps the document.
  const root = document.documentElement?.classList;
  const e = window.__firstRunSmoke;
  const recordRaw = localStorage.getItem('videorc.firstRun');
  const configRaw = localStorage.getItem('videorc.captureConfig');
  const registryRaw = localStorage.getItem('videorc.backgroundAssets');
  const look = document.querySelector('[data-first-run-look-layout]');
  return {
    documentVisibility: document.visibilityState, documentFocused: document.hasFocus(),
    animationFrames: e?.animationFrames, windowVisible: e?.windowVisible,
    animationTimelineMs: document.timeline.currentTime,
    animations: document.getAnimations().slice(0, 8).map(animation => ({
      state: animation.playState, currentTime: animation.currentTime, startTime: animation.startTime
    })),
    backdropDraws: e?.draws.length ?? 0,
    backdropSize: (() => { const r = document.querySelector('[data-first-run-backdrop-canvas] canvas')?.getBoundingClientRect(); return r ? { width: r.width, height: r.height } : null })(),
    setup: setup?.dataset.firstRunSetup ?? null, mode: setup?.dataset.firstRunMode ?? null,
    cardStep: document.querySelector('[data-slot="first-run-card"]')?.dataset.firstRunStep ?? null,
    position: document.querySelector('[data-slot="first-run-card"]')?.dataset.firstRunStepPosition,
    goalOptions: Array.from(document.querySelectorAll('[data-first-run-goal]')).map(el => el.dataset.firstRunGoal),
    layout: look?.dataset.firstRunLookLayout,
    background: look?.dataset.firstRunLookBackground,
    picture: document.querySelector('[data-first-run-look-picture]')?.dataset.firstRunLookPicture,
    layoutOptions: Array.from(document.querySelectorAll('[data-first-run-look-option]')).map(el => ({ preset: el.dataset.firstRunLookOption, disabled: !!el.querySelector('button')?.disabled, reason: el.querySelector('[data-slot="disabled-reason-text"]')?.textContent ?? null })),
    layoutReason: look?.textContent,
    soundBlocked: !!document.querySelector('[data-first-run-sound-blocked]'),
    soundMicrophoneRow: !!document.querySelector('[data-first-run-sound-row="microphone"]'),
    soundSystemAudioRow: !!document.querySelector('[data-first-run-sound-row="system-audio"]'),
    soundMeter: !!document.querySelector('[aria-label="Microphone level"]'),
    destinationRows: Array.from(document.querySelectorAll('[data-first-run-destination]')).map(el => ({ platform: el.dataset.firstRunDestination, state: el.dataset.state, signIn: Array.from(el.querySelectorAll('button')).some(b => /Sign in…|Authorize X Live…/.test(b.textContent)), unavailable: el.textContent.includes("isn't available in this build"), text: el.textContent })),
    streamKeyAction: document.querySelector('[data-first-run-stream-key] button')?.textContent.trim(),
    livestreamSetup: !!document.querySelector('[data-videorc-tab-trigger="streaming"][aria-current="page"]') && Array.from(document.querySelectorAll('[role="tablist"][aria-label="Livestream view"] [role="tab"]')).some(el => el.textContent.trim() === 'Setup' && el.hasAttribute('data-active')),
    theme: document.documentElement?.classList.contains('dark') ? 'dark' : 'light',
    studioDiagnostics: window.__videorcSmokeScenePresets?.state().diagnostics,
    configRaw, config: configRaw ? JSON.parse(configRaw) : null,
    registryRaw, registry: registryRaw ? JSON.parse(registryRaw) : null,
    toasts: e?.toasts ?? [], closedAt: e?.closedAt,
    rows: Array.from(document.querySelectorAll('[data-slot="system-access-row"]')).map(row => row.dataset.state),
    linuxAccess: !!document.querySelector('[data-first-run-linux-access]'),
    linuxAccessTitle: document.querySelector('[data-first-run-linux-access] [data-slot="empty-title"]')?.textContent,
    linuxAccessDescription: document.querySelector('[data-first-run-linux-access] [data-slot="empty-description"]')?.textContent,
    loading: !!document.querySelector('[data-first-run-rows="loading"]'),
    primaryCount: document.querySelectorAll('[data-first-run-primary]').length,
    primary: document.querySelector('[data-first-run-primary]')?.textContent.trim() ?? null,
    microphoneProof: !!document.querySelector('[data-first-run-microphone-proof]'),
    sidebar: !!document.querySelector('aside'),
    backdrop: backdrop?.dataset.firstRunBackdrop ?? null,
    reason: backdrop?.dataset.firstRunBackdropReason ?? null,
    look: backdrop?.dataset.firstRunBackdropLook ?? null,
    theme: root?.contains('light') ? 'light' : root?.contains('dark') ? 'dark' : null,
    tone: backdrop?.dataset.firstRunBackdropTone ?? null,
    pictureFilter: picture ? getComputedStyle(picture).filter : null,
    posterFilter: poster ? getComputedStyle(poster).filter : null,
    moreContrast: matchMedia('(prefers-contrast: more)').matches,
    toneHistory: e?.tones.map(t => t.tone) ?? [],
    canvasCount: document.querySelectorAll('[data-first-run-backdrop-canvas] canvas').length,
    recordRaw, record: recordRaw ? JSON.parse(recordRaw) : null,
    whatsNew: Array.from(document.querySelectorAll('[role="dialog"]')).some(el => /What's new in Videorc/.test(el.textContent)),
    settingsGeneral: !!document.querySelector('[data-videorc-tab-trigger="settings"][aria-current="page"]') && !!document.querySelector('[data-videorc-settings-tab="general"][data-active]'),
    documentId: e?.documentId, setupEver: e?.setupEver, workspaceBeforeSetup: e?.workspaceBeforeSetup,
    whatsNewOverSetup: e?.whatsNewOverSetup,
    mountToMovingMs: !e || e.movingAt === null || e.mountedAt === null ? null : e.movingAt - e.mountedAt,
    retainedContextsLost: !!e?.contexts.length && e.contexts.every(gl => gl.isContextLost())
  };
})()`
const state = async () => ({ ...(await evaluate(stateExpression)), platform: process.platform })

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
  report.steps.push({ profile: profileName, step, ...result, observation })
  save()
  console.log(
    `${result.pass ? 'PASS' : 'FAIL'} ${profileName}/${step}${result.skipped?.length ? '; skipped: ' + result.skipped.join('; skipped: ') : ''}`
  )
  if (!result.pass) throw new Error(`${step}: ${result.failures.join('; ')}`)
}

async function screenshot(name) {
  const path = join(output, `${name}.png`)
  if (process.platform === 'linux') {
    // CDP's platform-view screenshot can hang on Wayland. Electron captures
    // the real web contents without needing an X11 view or a portal grant.
    const captured = await requestSmokeCommand(
      launched.connections['preview-motion-ready'],
      'capture-page',
      { name },
      { timeoutMs: 10000 }
    )
    if (!captured?.file || statSync(captured.file).size === 0)
      throw new Error('Electron returned an empty first-run screenshot.')
    copyFileSync(captured.file, path)
    return path
  }
  const { data } = await cdp.call('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true
  })
  writeFileSync(path, Buffer.from(data, 'base64'))
  return path
}

async function reloadWith(keys) {
  const previousDocument = (await state()).documentId
  const reload = { profile: profileName, previousDocument, requestedAt: Date.now() }
  report.reloads.push(reload)
  save()
  if (keys)
    await evaluate(
      `localStorage.clear(); for (const [key, value] of Object.entries(${JSON.stringify(keys)})) localStorage.setItem(key, value)`
    )
  await cdp.call('Page.reload', { ignoreCache: true })
  // Do not accidentally accept the previous document's state.
  const next = await waitFor(
    'new document instrument',
    (s) => s.documentId && s.documentId !== previousDocument && (s.setup === 'open' || s.sidebar)
  )
  Object.assign(reload, {
    nextDocument: next.documentId,
    observedAt: Date.now(),
    setup: next.setup
  })
  save()
}

async function click(selector) {
  await evaluate(
    `(() => { const button = document.querySelector(${JSON.stringify(selector)}); if (!button || button.disabled) throw new Error('Missing or disabled control: ' + ${JSON.stringify(selector)}); button.click(); })()`
  )
}

// Media features stay emulated until the next call replaces them all.
async function emulate(features = {}) {
  await cdp.call('Emulation.setEmulatedMedia', {
    features: Object.entries(features).map(([name, value]) => ({ name, value }))
  })
}

// Two frames: React has rendered the media or theme change and it is painted.
const settled = async () => {
  await evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))')
  return state()
}

// The app's own theme key, as Settings → Appearance writes it; next-themes
// follows a storage event, as when another window changes it.
async function setTheme(theme) {
  await evaluate(
    `localStorage.setItem('videorc.theme', ${JSON.stringify(theme)}); window.dispatchEvent(new StorageEvent('storage', { key: 'videorc.theme', newValue: ${JSON.stringify(theme)} }))`
  )
}

// Plan 208 S5: how long the backdrop takes to turn after a theme change,
// measured on the renderer's clock from just before the change is asked for.
async function toneFlip(change, tone) {
  const mark = await evaluate('window.__firstRunSmoke.flipMark = performance.now()')
  await change()
  await waitFor(`tone ${tone}`, (s) => s.tone === tone, 2000)
  const at = await evaluate(
    `window.__firstRunSmoke.tones.find(t => t.at >= window.__firstRunSmoke.flipMark && t.tone === ${JSON.stringify(tone)})?.at ?? null`
  )
  return { ...(await settled()), toneFlipMs: at === null ? null : at - mark }
}

async function motionSample(prefix = '') {
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
    [`${prefix}motion-first`, frames[0]],
    [`${prefix}motion-last`, frames.at(-1)]
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

async function previewSnapshot() {
  const [camera, screen] = await Promise.all([
    request(backend, 5000, 'preview.camera.status'),
    request(backend, 5000, 'preview.screen.status')
  ])
  const summarize = (status) => ({
    state: status.state,
    id: status.cameraId ?? status.sourceId ?? null,
    framesCaptured: status.framesCaptured,
    targetFps: status.targetFps
  })
  return { camera: summarize(camera), screen: summarize(screen) }
}

const previewQuiet = (snapshot) =>
  Object.values(snapshot).every(
    (status) => !['starting', 'live'].includes(status.state) && status.framesCaptured === 0
  )
const samePreviewSources = (before, after) =>
  ['camera', 'screen'].every(
    (kind) =>
      !['starting', 'live'].includes(after[kind].state) ||
      (before[kind].id !== null &&
        before[kind].id === after[kind].id &&
        before[kind].state === after[kind].state)
  )

async function beginGuard(startMs = Date.now(), allowExistingSources = true) {
  const previewAtOpen = await previewSnapshot()
  guard = {
    startMs,
    documentAtOpen: (await state()).documentId,
    previewAtOpen,
    allowExistingSources,
    previewIdleAtOpen: previewQuiet(previewAtOpen),
    closedAt: null
  }
}

async function finishGuard() {
  // The renderer binding records removal of the setup root, including its
  // leaving fade. Scan backend emission timestamps, not delayed pipe arrivals.
  await waitFor('setup close witness', (s) => s.closedAt !== null)
  const endMs = guard.closedAt ?? (await state()).closedAt
  const lines = appLines
    .filter(({ at }) => at >= guard.startMs && at <= endMs)
    .map(({ line }) => line)
  await check('no-device-starts', {
    ...guard,
    endMs,
    closedObserved: Number.isFinite(endMs),
    backendReady: true,
    patterns: FIRST_RUN_SOURCE_START_PATTERNS,
    matches: firstRunSourceStartLines(lines)
  })
  guard = null
}

async function leave(selector) {
  guard.previewBeforeLeave = await previewSnapshot()
  guard.previewIdleBeforeLeave = previewQuiet(guard.previewBeforeLeave)
  guard.previewIdentityUnchanged = samePreviewSources(guard.previewAtOpen, guard.previewBeforeLeave)
  await click(selector)
  await waitFor('workspace after setup', (s) => s.setup === null && s.sidebar)
  await finishGuard()
}

async function stopApp() {
  backend?.close()
  backend = null
  cdp?.close()
  cdp = null
  browserCdp?.close()
  browserCdp = null
  const app = launched
  launched = null
  if (app) {
    const profile = join(output, profileName)
    const teardown = await stopFirstRunApp(
      app,
      ownedProcessLedgerPaths({
        appDataDir: join(profile, 'app-data'),
        userDataDir: join(profile, 'user-data'),
        workspaceRoot: repoRoot
      })
    )
    report.teardowns.push({ profile: profileName, ...teardown })
    save()
    if (!teardown.pass)
      throw new Error(`First-run teardown failed: ${teardown.failures.join('; ')}`)
  }
}

async function startApp(name) {
  await stopApp()
  profileName = name
  const profile = join(output, name)
  mkdirSync(profile, { recursive: true })
  appLines = []
  devtoolsUrl = null
  const startMs = Date.now()
  launched = await launchDevApp({
    timeoutMs: 180000,
    requiredMarkers: ['backend-ready', 'preview-motion-ready'],
    env: {
      VIDEORC_SMOKE_OUTPUT_DIR: profile,
      VIDEORC_SMOKE_STATE_DIR: profile,
      VIDEORC_APP_DATA_DIR: join(profile, 'app-data'),
      VIDEORC_USER_DATA_DIR: join(profile, 'user-data'),
      VIDEORC_DEV_BACKEND_PROFILE: 'debug',
      VIDEORC_SMOKE_SKIP_FIRST_RUN: '0',
      VIDEORC_SMOKE_COMMAND_SERVER: '1',
      VIDEORC_REMOTE_DEBUG_PORT: '0',
      RUST_LOG: 'videorc_backend=info'
    },
    onLine: (raw) => {
      // ANSI color surrounds the timestamp in tracing's development output.
      const line = raw.replace(/\x1b\[[0-9;]*m/g, '')
      const emitted = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z/.exec(line)
      const subMillisecond = emitted
        ? Number('0.' + (emitted[0].split('.')[1].slice(3, -1) || '0'))
        : 0
      appLines.push({ line, at: emitted ? Date.parse(emitted[0]) + subMillisecond : Date.now() })
      appendFileSync(join(profile, 'app.log'), `${line}\n`)
      const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(line)
      if (match) devtoolsUrl = match[1]
    }
  })
  if (!devtoolsUrl) throw new Error('Missing DevTools listening handshake')
  // Backend READY can precede Vite transforming the Studio module on a cold
  // launch. Wait for the real renderer within the original launch deadline,
  // before attaching observations. The reload below still measures mount to
  // first moving frame against the unchanged three-second budget.
  await waitForRendererHook(
    launched.connections['preview-motion-ready'],
    '__videorcSmokeSetReplayBuffer',
    { timeoutMs: Math.max(1, 180000 - (Date.now() - startMs)) }
  )
  const { host } = new URL(devtoolsUrl)
  const targets = await fetchTargets(host)
  const target = targets.find(
    (item) => item.type === 'page' && /^https?:\/\/localhost/.test(item.url ?? '')
  )
  if (!target) throw new Error('Main window CDP target not found')
  cdp = await connect(target.webSocketDebuggerUrl)
  browserCdp = await connect(devtoolsUrl)
  backend = await connectBackend(launched.connections['backend-ready'], 10000)
  cdp.listeners.add((message) => {
    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails
      report.rendererErrors.push({
        profile: name,
        text: details.exception?.description ?? details.text,
        url: details.url,
        line: details.lineNumber
      })
      save()
    }
    if (
      message.method === 'Runtime.bindingCalled' &&
      message.params.name === '__firstRunSourceRequest'
    ) {
      report.sourceRequests.push({ profile: name, ...JSON.parse(message.params.payload) })
      save()
    }
    if (
      message.method === 'Runtime.bindingCalled' &&
      message.params.name === '__firstRunSetupClosed' &&
      guard
    ) {
      guard.closedAt = Number(message.params.payload)
    }
  })
  await cdp.call('Runtime.enable')
  await cdp.call('Runtime.addBinding', { name: '__firstRunSetupClosed' })
  await cdp.call('Runtime.addBinding', { name: '__firstRunSourceRequest' })
  await cdp.call('Page.enable')
  // CDP activates a target but does not necessarily show its Electron window
  // on Wayland. Exercise the foreground first-run UI through the owned window.
  await requestSmokeCommand(
    launched.connections['preview-motion-ready'],
    'main-window-focus',
    {},
    { timeoutMs: 10000 }
  )
  await cdp.call('Page.bringToFront')
  await cdp.call('Page.addScriptToEvaluateOnNewDocument', { source: instrument })
  await evaluate(instrument)
  await check(
    'fresh',
    await waitFor('initial fresh setup', (s) => s.setup === 'open' && firstRunPermissionsReady(s))
  )
  report.windowState = await requestSmokeCommand(
    launched.connections['preview-motion-ready'],
    'main-window-state',
    {},
    { timeoutMs: 10000 }
  )
  save()
  await beginGuard(startMs, false)
  report.hostGrants = await evaluate('window.videorc.getMediaAccessStatus()')
}

async function shotStep(theme) {
  // The maintained step cross-fade is 150 ms; capture the settled card.
  await delay(200)
  const s = await state()
  const path = await screenshot(`${theme}-${s.cardStep}`)
  themeShots[theme].set(s.cardStep, path)
}

async function advance(step) {
  await click('[data-first-run-primary]')
  return waitFor(step, (s) => s.cardStep === step && s.setup === 'open')
}

async function chooseLook(background = 'silk') {
  const initial = await waitFor(
    'look options',
    (s) => s.cardStep === 'look' && s.layoutOptions.length >= 4
  )
  const available = initial.layoutOptions.filter((option) => !option.disabled)
  const selected =
    available.find((option) => ['camera-only', 'screen-only'].includes(option.preset)) ??
    available[0]
  if (selected) await click(`[data-first-run-look-option="${selected.preset}"] button`)
  await click(`[data-first-run-look-background-option="${background}"] button`)
  await waitFor(
    'live picture',
    (s) => s.background === background && ['moving', 'still'].includes(s.picture)
  )
  let committed
  const deadline = Date.now() + 10000
  do {
    const [scene, compositor] = await Promise.all([
      request(backend, 5000, 'scene.get'),
      request(backend, 5000, 'compositor.status')
    ])
    committed = {
      committedLayout: compositor.sceneLayout?.layoutPreset,
      committedBackground: scene.background?.live?.id
    }
    if (
      committed.committedBackground === background &&
      committed.committedLayout === (await state()).layout
    )
      break
    await delay(100)
  } while (Date.now() < deadline)
  const observation = { ...(await state()), ...committed, layoutClicked: selected?.preset ?? null }
  await check('look', observation)
  return { layout: observation.layout, background }
}

async function lookMotionSample() {
  const gpuProcesses = async () =>
    (await browserCdp.call('SystemInfo.getProcessInfo')).processInfo.filter((p) => p.type === 'GPU')
  const before = await gpuProcesses()
  await evaluate(
    'window.__firstRunSmoke.draws = []; window.__firstRunSmoke.pictureDraws = []; window.__firstRunSmoke.sampleAt = performance.now()'
  )
  await delay(FIRST_RUN_SMOKE_LIMITS.lookSampleAtLeastMs + 50)
  const sample = await evaluate(
    `({ durationMs: performance.now() - window.__firstRunSmoke.sampleAt, backdropDrawCount: window.__firstRunSmoke.draws.length, pictureDrawCount: window.__firstRunSmoke.pictureDraws.length })`
  )
  const after = await gpuProcesses()
  const cpuDelta = after.reduce(
    (total, p) => total + p.cpuTime - (before.find((b) => b.id === p.id)?.cpuTime ?? p.cpuTime),
    0
  )
  return {
    ...(await state()),
    ...sample,
    backdropDrawFps: sample.backdropDrawCount / (sample.durationMs / 1000),
    pictureDrawFps: sample.pictureDrawCount / (sample.durationMs / 1000),
    gpuCpuPercent:
      before.length && after.length ? (cpuDelta / (sample.durationMs / 1000)) * 100 : null,
    gpuProcessIds: after.map((p) => p.id)
  }
}

async function soundCheck() {
  const s = await waitFor(
    'sound rows',
    (s) => s.cardStep === 'sound' && (s.soundMeter || s.soundBlocked)
  )
  const microphoneGrant = (await evaluate('window.videorc.getMediaAccessStatus()')).microphone
  let gainKeyPressed = false
  if (!s.soundBlocked) {
    await evaluate(
      `(() => { const el = document.querySelector('input[aria-label="Microphone gain"], [role="slider"][aria-label="Microphone gain"]'); if (!el) throw new Error('Missing Gain slider'); el.focus(); })()`
    )
    const key = s.config.audio.microphoneGainDb >= 24 ? 'ArrowLeft' : 'ArrowRight'
    await cdp.call('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key,
      code: key,
      windowsVirtualKeyCode: key === 'ArrowLeft' ? 37 : 39
    })
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key })
    await waitFor(
      'Gain persisted',
      (next) => next.config.audio.microphoneGainDb !== s.config.audio.microphoneGainDb
    )
    gainKeyPressed = true
  }
  await check('sound', {
    ...(await state()),
    systemAudioDeviceStatus: (await request(backend, 5000, 'devices.list')).devices.find(
      (device) => device.kind === 'system-audio'
    )?.status,
    microphoneGrant,
    gainBefore: s.config.audio.microphoneGainDb,
    gainKeyPressed
  })
}

async function committedLook() {
  const [scene, compositor] = await Promise.all([
    request(backend, 5000, 'scene.get'),
    request(backend, 5000, 'compositor.status')
  ])
  return {
    committedLayout: compositor.sceneLayout?.layoutPreset,
    committedBackground: scene.background?.live?.id
  }
}

async function settledConfig() {
  // Reload first normalizes persisted defaults, then reconciles discovered
  // sources and the idle scene. Establish the byte baseline only after that
  // work is acknowledged and storage has stayed unchanged for a full cycle.
  let signature
  let unchangedSince = Date.now()
  return waitFor('settled captureConfig', (s) => {
    const next = s.configRaw + s.registryRaw
    if (signature !== next) {
      signature = next
      unchangedSince = Date.now()
    }
    const d = s.studioDiagnostics
    return (
      d?.wsStatus === 'connected' &&
      d.hasScene &&
      !d.visualTransactionPending &&
      !d.sourceDeviceSwitchPending &&
      Date.now() - unchangedSince >= 750
    )
  })
}

async function replay() {
  await click('[data-videorc-tab-trigger="settings"]')
  await waitFor('Settings General', (s) => s.settingsGeneral)
  const before = await settledConfig()
  await beginGuard()
  await evaluate(
    `(() => { const button = Array.from(document.querySelectorAll('button')).find(el => el.textContent.trim() === 'Run setup again…'); if (!button || button.disabled) throw new Error('Run setup again… unavailable'); button.click(); })()`
  )
  await check('replay-open', {
    ...(await waitFor(
      'replay permissions',
      (s) => s.mode === 'replay' && firstRunPermissionsReady(s)
    )),
    beforeRecordRaw: before.recordRaw
  })
  const visitedSteps = ['permissions']
  await screenshot('replay-permissions')
  await advance('goal')
  visitedSteps.push('goal')
  // Picking Both only shapes replay's in-memory step list; do not touch look,
  // audio or account controls. The persisted goal remains Recordings.
  await click('[data-first-run-goal="both"]')
  await waitFor('replay look', (s) => s.cardStep === 'look')
  visitedSteps.push('look')
  await advance('sound')
  visitedSteps.push('sound')
  await advance('destinations')
  visitedSteps.push('destinations')
  await shotStep('dark')
  await check('destinations', await state())
  const pressedPrimary = (await state()).primary
  await leave('[data-first-run-primary]')
  await check('replay-return', {
    ...(await waitFor('return to Settings', (s) => !s.setup && s.settingsGeneral)),
    beforeRecordRaw: before.recordRaw,
    beforeConfigRaw: before.configRaw,
    visitedSteps,
    pressedPrimary
  })
}

try {
  console.log(`First-run smoke output: ${output}`)
  await startApp('recordings')
  // CDP attaches after the untouched first mount; reload to measure mount to
  // first frame on a shared renderer clock, as plan 203 did.
  await reloadWith({ 'videorc.theme': 'dark' })
  await check('fresh', await waitFor('fresh rows', (s) => firstRunPermissionsReady(s)))
  await check(
    'moving',
    await waitFor('moving backdrop', (s) => ['moving', 'still'].includes(s.backdrop), 5000)
  )
  await shotStep('dark')
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

  // Plan 208 S5 (D3): light turns the Polished chrome around. Dark, as opened,
  // draws it as it is; more contrast deepens the shader's Dim.
  await check('tone', await settled())
  await emulate({ 'prefers-contrast': 'more' })
  await check('tone', await settled())
  await screenshot('dark-more-contrast')
  // Follow the system, as macOS's Auto appearance does, and turn it to light
  // while Welcome is open: the chrome turns at once, with no reload.
  await emulate({ 'prefers-color-scheme': 'dark' })
  await setTheme('system')
  await check('tone', await settled())
  await check('tone', await toneFlip(() => emulate({ 'prefers-color-scheme': 'light' }), 'inverse'))
  await screenshot('light-moving')
  await check('motion', await motionSample('light-'))
  await emulate({ 'prefers-color-scheme': 'light', 'prefers-contrast': 'more' })
  await check('tone', await settled())
  await screenshot('light-more-contrast')
  // The still is the poster, inverted with the canvas's picture.
  await emulate({ 'prefers-color-scheme': 'light', 'prefers-reduced-motion': 'reduce' })
  const lightStill = await waitFor('light reduced motion still', (s) => s.backdrop === 'still')
  await check('reduced-motion', lightStill)
  await check('tone', await settled())
  await screenshot('light-still')
  await emulate({ 'prefers-color-scheme': 'light' })
  await check(
    'moving',
    await waitFor(
      'light motion restored',
      (s) => ['moving', 'still'].includes(s.backdrop) && s.reason !== 'reduced-motion'
    )
  )
  await check('tone', await toneFlip(() => emulate({ 'prefers-color-scheme': 'dark' }), 'normal'))
  await setTheme('dark')
  await emulate()
  await check('goal', await advance('goal'))
  await shotStep('dark')
  await click('[data-first-run-goal="record"]')
  await check('record-look', await waitFor('Recordings look', (s) => s.cardStep === 'look'))
  const chosen = await chooseLook()
  await shotStep('dark')
  const rates = await lookMotionSample()
  await check('look-motion', rates)
  console.log(
    `Two-player cost: backdrop ${rates.backdropDrawFps.toFixed(2)} fps; picture ${rates.pictureDrawFps.toFixed(2)} fps; GPU CPU ${rates.gpuCpuPercent?.toFixed(2)}%`
  )
  await advance('sound')
  await soundCheck()
  await shotStep('dark')
  const beforeResume = await state()
  await reloadWith()
  await check('resume', {
    ...(await waitFor('sound resume', (s) => s.cardStep === 'sound' && s.configRaw)),
    expectedStep: 'sound',
    beforeConfig: beforeResume.config,
    beforeBackground: beforeResume.registry.live.activeId
  })
  await waitFor('resumed backdrop frame', (s) => s.backdrop === 'moving')
  const pressedPrimary = (await state()).primary
  await leave('[data-first-run-primary]')
  await check('finish', { ...(await state()), pressedPrimary })
  const watchStart = Date.now()
  await delay(FIRST_RUN_SMOKE_LIMITS.clipsWatchMs + 100)
  await check('workspace-look', {
    ...(await state()),
    ...(await committedLook()),
    chosenLayout: chosen.layout,
    chosenBackground: chosen.background,
    watchMs: Date.now() - watchStart,
    refusedStarts: appLines
      .filter(({ line }) => line.includes('Session start refused'))
      .map(({ line }) => line)
  })
  await screenshot('studio-chosen-look')
  const finishedRecord = (await state()).recordRaw
  await reloadWith()
  await check('reload', { ...(await state()), beforeRecordRaw: finishedRecord })
  await replay()
  await check('theme-walk', {
    ...(await state()),
    expectedTheme: 'dark',
    visitedSteps: allSteps,
    screenshots: allSteps.map((step) => themeShots.dark.get(step))
  })

  await reloadWith({ 'videorc.whatsNewLastSeenVersion': '999.0.0' })
  // An existing install shows the workspace before runtime info arrives.
  // Finalization then persists its migration record; the sidebar alone is
  // not that handshake. Still validate the record after the bounded wait.
  await check(
    'existing-install',
    await waitFor('existing-install migration', (s) => s.recordRaw !== null)
  )
  const resumeRecord = JSON.stringify({
    version: 1,
    status: 'in-progress',
    step: 'permissions',
    updatedAt: new Date().toISOString()
  })
  await beginGuard()
  await reloadWith({ 'videorc.firstRun': resumeRecord })
  await check('resume', await waitFor('legacy resumed rows', (s) => firstRunPermissionsReady(s)))
  await waitFor('legacy resumed motion', (s) => s.backdrop === 'moving')
  await leave('[data-first-run-skip]')
  await check('finish', { ...(await state()), pressedPrimary: 'Skip setup' })
  // An old What's New marker alone migrates; pair it with an in-progress
  // record to test startup ordering instead of hiding setup by migration.
  await beginGuard()
  await reloadWith({ 'videorc.firstRun': resumeRecord, 'videorc.whatsNewLastSeenVersion': '0.0.1' })
  await waitFor('old-version setup', (s) => firstRunPermissionsReady(s))
  const whatsNewStart = Date.now()
  await delay(FIRST_RUN_SMOKE_LIMITS.whatsNewWatchMs + 100)
  await check('whats-new', {
    ...(await state()),
    seededWhatsNew: '0.0.1',
    watchMs: Date.now() - whatsNewStart
  })
  await screenshot('whats-new-held')
  await leave('[data-first-run-skip]')

  await startApp('livestreams')
  await reloadWith({ 'videorc.theme': 'light' })
  await waitFor('light permissions', (s) => firstRunPermissionsReady(s) && s.theme === 'light')
  // Plan 208 S5: opened in light, the first frame is already turned, never dark first.
  await check(
    'moving',
    await waitFor('light moving backdrop', (s) => ['moving', 'still'].includes(s.backdrop), 5000)
  )
  const lightOpen = await settled()
  await check('tone', { ...lightOpen, tonesSeen: lightOpen.toneHistory })
  await screenshot('light-fresh')
  await shotStep('light')
  await check('goal', await advance('goal'))
  await shotStep('light')
  await click('[data-first-run-goal="stream"]')
  await waitFor('Livestreams look', (s) => s.cardStep === 'look' && s.position === '3/5')
  await chooseLook('side-rays')
  await shotStep('light')
  await advance('sound')
  await soundCheck()
  await shotStep('light')
  await advance('destinations')
  await shotStep('light')
  await check('destinations', await state())
  await check('theme-walk', {
    ...(await state()),
    expectedTheme: 'light',
    visitedSteps: allSteps,
    screenshots: allSteps.map((step) => themeShots.light.get(step))
  })
  await leave('[data-first-run-stream-key] button')
  await check('livestream', await waitFor('Livestream Setup', (s) => s.livestreamSetup))
  await screenshot('livestream-setup')

  await startApp('skip-look')
  await advance('goal')
  await click('[data-first-run-goal="both"]')
  await waitFor('skip profile look', (s) => s.cardStep === 'look')
  await chooseLook('silk')
  const beforeSkip = await state()
  await leave('[data-first-run-skip]')
  await check('skip-look', {
    ...(await state()),
    beforeConfigRaw: beforeSkip.configRaw,
    beforeRegistryRaw: beforeSkip.registryRaw
  })
  report.pass = true
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
  try {
    await stopApp()
  } catch (error) {
    report.pass = false
    report.teardownError = error.stack ?? String(error)
    console.error(`FAIL first-run smoke teardown: ${error.message}`)
    process.exitCode = 1
  }
  save()
  if (report.pass) console.log('PASS first-run smoke: all steps passed')
  console.log(`Report: ${join(output, 'report.json')}`)
}
