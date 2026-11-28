/**
 * The UI screenshot baseline shooter (plan 220 S0.1a), reached through
 * `node scripts/capture-ui-pages.mjs --baseline`. It launches the dev app on an
 * isolated profile seeded by `rust-ui-baseline-profile.mjs`, then shoots every
 * window, page, tab and dialog in the looks of `rust-ui-baseline-manifest.mjs`
 * (dark, light, and Increase Contrast over each), logging one line per shot to
 * `<folder>/entries.jsonl` and one per screen it could not open to
 * `<folder>/missing.jsonl`. `buildManifest` turns those into the committed
 * `docs/gpui/baseline-manifest.json`.
 *
 * A run is split in parts so a long sweep fits a foreground call:
 *   idle      the pages and their tabs, the menus and dialogs a page opens
 *   windows   the Stream Manager at its four bands, Captions and Notes
 *   live      the Studio recording, and on air to a local RTMP sink
 *   first-run each step of the setup
 * Every part writes into the same folder; shots never overwrite another's.
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { launchDevApp, stopProcess } from './app-launcher.mjs'
import { requestSmokeCommand } from './smoke-command-client.mjs'
import {
  readUiSettingJs,
  seedUiSettingsJs,
  UI_SETTINGS_READY_JS
} from './rust-ui-baseline-settings.mjs'
import { CdpPage, connectWindow, listTargets, windowRoleOfUrl } from './rust-ui-baseline-cdp.mjs'
import {
  BASELINE_CHAT_ROWS,
  BASELINE_FAKE_STREAM_KEY,
  baselineCaptureConfigPatch,
  baselineFixtureFiles,
  baselineLiveChatStart,
  baselineScenes,
  baselineUiSettings,
  baselineWorkingScene,
  seedBaselineBackend
} from './rust-ui-baseline-profile.mjs'
import {
  BASELINE_LOOKS,
  STREAM_MANAGER_SIZES,
  manifestEntry,
  shotPath
} from './rust-ui-baseline-manifest.mjs'
import { UI_SWEEP_SIZES } from './ui-layout-check.mjs'
import { galleryCloudStatus, galleryHostCameraOff } from './gallery-show-stage-fixtures.mjs'
import { startFakeApiRouter } from './fake-api-router.mjs'
import {
  AI_CAPABILITIES_PATH,
  BUDDY_ACT_PATH,
  startFakeCohostService
} from './fake-cohost-service.mjs'
import { connectBackend, request } from '../smoke-recording-session.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Page JavaScript every step gets: find a control by its name, press it, leave a dialog. */
const PAGE_KIT = `
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const visible = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
const nameOf = (e) => (e.getAttribute('aria-label') || e.textContent || '').trim().replace(/\\s+/g, ' ');
const CONTROLS = 'button,[role=tab],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=option],a,[role=switch],[role=combobox],[data-slot=navigable-row],[data-slot=list-row-button]';
const findAll = (pattern, root = document, selector = CONTROLS) => { const re = new RegExp(pattern); return [...root.querySelectorAll(selector)].filter(visible).filter((e) => re.test(nameOf(e))); };
const press = (e, how) => {
  if (how === 'pointer') {
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) e.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, button: 0, view: window }));
  }
  if (how !== 'pointer-only') e.click();
};
const clickText = async (pattern, { nth = 0, root = document, selector = CONTROLS, timeout = 8000, how = 'click' } = {}) => {
  const end = Date.now() + timeout;
  for (;;) {
    const found = findAll(pattern, root, selector);
    if (found[nth]) { press(found[nth], how); return nameOf(found[nth]); }
    if (Date.now() > end) throw new Error('no visible control named ' + pattern + ' (saw: ' + findAll('.', root, selector).map(nameOf).slice(0, 24).join(' | ') + ')');
    await sleep(100);
  }
};
const rowSwitch = (pattern) => {
  const re = new RegExp(pattern);
  for (const sw of document.querySelectorAll('[role=switch]')) {
    let el = sw;
    for (let i = 0; i < 5 && el; i += 1, el = el.parentElement) { if (el.textContent.length < 260 && re.test((sw.getAttribute('aria-label') ?? '') + ' ' + el.textContent)) return sw; }
  }
  return null;
};
const waitFor = async (check, what, timeout = 10000) => { const end = Date.now() + timeout; for (;;) { const v = await check(); if (v) return v; if (Date.now() > end) throw new Error('timed out waiting for ' + what); await sleep(100); } };
const overlayOpen = () => document.querySelector('[role=dialog],[role=menu],[role=alertdialog],[data-slot=popover-content],[data-slot=command]');
const dismiss = async () => {
  for (let i = 0; i < 4 && overlayOpen(); i += 1) {
    for (const target of [document.activeElement, document.body, document]) target?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
    await sleep(350);
  }
  return !overlayOpen();
};
`

/**
 * The launches a run needs: the signed-out parts together, then `buddy` on
 * its own (it signs the launch in). One group when there is nothing to split.
 */
export function splitSignedInParts(parts) {
  const signedOut = parts.filter((part) => part !== 'buddy')
  if (!parts.includes('buddy') || signedOut.length === 0) return [parts]
  return [signedOut, ['buddy']]
}

/** The screens (and states) a `--screens=` filter keeps. */
function wanted(only, screen) {
  return !only || only.includes(screen)
}

export async function runBaseline({
  out,
  appCommit,
  only = null,
  looks = BASELINE_LOOKS,
  parts = ['idle', 'windows', 'live', 'first-run'],
  sizes = UI_SWEEP_SIZES,
  log = (line) => console.log(line)
}) {
  // The Buddy part signs the whole launch in (the mock Developer
  // entitlement, below). Every other part is shot signed out on Basic, as
  // the GPUI gallery runs, so Buddy gets a launch of its own: otherwise
  // Captions, Library, the account menu and Community came out unlocked.
  const split = splitSignedInParts(parts)
  if (split.length > 1) {
    const failures = []
    for (const group of split) {
      log(`-- launch: ${group.join(', ')}`)
      const run = await runBaseline({ out, appCommit, only, looks, parts: group, sizes, log })
      failures.push(...run.failures)
    }
    return { failures }
  }
  mkdirSync(out, { recursive: true })
  const entriesFile = join(out, 'entries.jsonl')
  const missingFile = join(out, 'missing.jsonl')
  const failuresFile = join(out, 'failures.jsonl')
  const base = mkdtempSync(join(tmpdir(), 'videorc-baseline-'))
  const stateDir = join(base, 'state')
  const userDir = join(base, 'user')
  mkdirSync(stateDir, { recursive: true })
  mkdirSync(userDir, { recursive: true })
  const fixtures = baselineFixtureFiles(join(stateDir, 'fixtures'))

  // The Buddy run is signed in: the dev-only mock account (a Developer
  // entitlement) and the local fakes the Buddy smokes use, never the real API.
  const signedIn = parts.includes('buddy')
  // The mock account and the fake API origin are debug-build only
  // (account.rs, videorc_api.rs): a release backend ignores both, so the
  // signed-in run would shoot a signed-out app, or reach the real service.
  if (signedIn && process.env.VIDEORC_DEV_BACKEND_PROFILE === 'release') {
    throw new Error(
      'The buddy part needs the debug backend: unset VIDEORC_DEV_BACKEND_PROFILE for it.'
    )
  }
  const fakes = signedIn ? await startSignedInFakes(stateDir) : null

  let devtoolsUrl = null
  const launched = await launchDevApp({
    timeoutMs: 240_000,
    requiredMarkers: ['backend-ready', 'preview-motion-ready'],
    env: {
      VIDEORC_SMOKE_COMMAND_SERVER: '1',
      VIDEORC_DISABLE_AUTO_PREVIEW: '1',
      VIDEORC_SMOKE_DISABLE_NATIVE_MICROPHONE: '1',
      // The dev launcher keeps first-run closed; its own run opens it.
      VIDEORC_SMOKE_SKIP_FIRST_RUN: parts.includes('first-run') ? '0' : '1',
      VIDEORC_REMOTE_DEBUG_PORT: '0',
      VIDEORC_SMOKE_STATE_DIR: stateDir,
      VIDEORC_SMOKE_OUTPUT_DIR: join(base, 'scratch'),
      VIDEORC_USER_DATA_DIR: userDir,
      VIDEORC_DATABASE_PATH: join(userDir, 'videorc.sqlite3'),
      // Signed out, a debug backend grants the Developer tier; force Basic,
      // as the GPUI gallery does (VIDEORC_PREMIUM_FEATURES is downgrade-only).
      ...(fakes
        ? { VIDEORC_MOCK_ACCOUNT: 'baseline', VIDEORC_API_BASE_URL: fakes.origin }
        : { VIDEORC_PREMIUM_FEATURES: 'basic' })
    },
    onLine: (line) => {
      const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(line)
      if (match) devtoolsUrl = match[1]
      if (line.startsWith('[smoke:')) console.error(line)
    }
  })
  mkdirSync(join(base, 'scratch'), { recursive: true })
  const smokeConnection = launched.connections['preview-motion-ready']
  const smoke = (command, params = {}, options) =>
    requestSmokeCommand(smokeConnection, command, params, { timeoutMs: 60_000, ...options })
  let socket = null
  const rpc = (method, params) => request(socket, 60_000, method, params)
  const devtoolsHost = () => new URL(devtoolsUrl.replace('ws://', 'http://')).host

  const failures = []
  const pendingShots = []
  const note = (file, record) => appendFileSync(file, `${JSON.stringify(record)}\n`)
  const missing = (screen, state, reason) => {
    log(`MISSING ${screen}/${state}: ${reason}`)
    note(missingFile, { screen, state, reason })
  }
  const failed = (what, error) => {
    const reason = String(error?.message ?? error)
    failures.push({ what, reason })
    log(`FAILED ${what}: ${reason}`)
    note(failuresFile, { what, reason })
    // What the window showed when the step gave up, beside the logs.
    pendingShots.push(
      Promise.resolve(main?.screenshot())
        .then((bytes) => {
          if (!bytes) return
          mkdirSync(join(out, 'failures'), { recursive: true })
          writeFileSync(join(out, 'failures', `${what.replace(/[^a-z0-9]+/gi, '-')}.png`), bytes)
        })
        .catch(() => {})
    )
  }

  /** Writes one shot (and its aliases) and logs the entry. */
  const record = (bytes, shot, aliases = []) => {
    for (const target of [shot, ...aliases.map((alias) => ({ ...shot, ...alias }))]) {
      const file = join(out, shotPath(target))
      mkdirSync(join(file, '..'), { recursive: true })
      writeFileSync(file, bytes)
      const entry = manifestEntry(out, target, appCommit)
      note(entriesFile, entry)
      log(`ok   ${entry.path}`)
    }
  }

  let main = null
  const ctx = {
    smoke,
    rpc,
    look: BASELINE_LOOKS[0],
    size: sizes[0],
    js: (code, options) => main.evaluate(`(async () => { ${PAGE_KIT}\n${code}\n})()`, options),
    click: (pattern, options = {}) =>
      ctx.js(`return await clickText(${JSON.stringify(pattern)}, ${JSON.stringify(options)})`),
    dismiss: () => ctx.js('return await dismiss()'),
    clearToasts: () =>
      ctx.js(
        `const { toast } = await import('/src/lib/toast.ts'); toast.dismiss(); try { await waitFor(() => !document.querySelector('[data-sonner-toast]'), 'toasts to clear', 4000); } catch {} return true`
      ),
    async open(tab, waitFor) {
      for (let attempt = 0; ; attempt += 1) {
        try {
          await smoke('open-tab', waitFor ? { tab, waitFor } : { tab }, { timeoutMs: 45_000 })
          break
        } catch (error) {
          if (attempt >= 2) throw error
          await sleep(500)
        }
      }
      await sleep(900)
    },
    /** A main-window shot in the current look and size. */
    async shoot(
      screen,
      state,
      { aliases = [], settle = 400, size = ctx.size, keepToasts = false } = {}
    ) {
      // The host's own toasts (a busy Mac's "computer is overloaded") never belong in a baseline.
      if (!keepToasts) await ctx.clearToasts()
      await main.settled(settle)
      const bytes = await main.screenshot()
      record(bytes, { screen, state, ...ctx.look, width: size.width, height: size.height }, aliases)
    }
  }

  const setMainLook = async (look) => {
    ctx.look = look
    await main.evaluate(
      `localStorage.setItem('videorc.theme', '${look.theme}'); window.dispatchEvent(new StorageEvent('storage', { key: 'videorc.theme', newValue: '${look.theme}' })); new Promise((r) => setTimeout(r, 700))`
    )
    const applied = await main.evaluate(
      `document.documentElement.classList.contains('${look.theme}')`
    )
    if (!applied) throw new Error(`The app did not switch to the ${look.theme} theme.`)
    await main.emulate({ contrast: look.contrast })
    await main.settled(300)
  }

  try {
    await sleep(3000)
    socket = await connectBackend(launched.connections['backend-ready'], 60_000)
    const target = (await listTargets(devtoolsHost())).find(
      (page) => windowRoleOfUrl(page.url) === 'main'
    )
    if (!target) throw new Error('The main window has no CDP page.')
    main = await CdpPage.connect(target)

    // The profile: the UI settings, the saved scenes, the sources and the
    // destinations (keys through the backend), then the backend's rows.
    await seedProfile({
      main,
      rpc,
      smoke,
      fixtures,
      stateDir,
      log,
      // A run that opens first-run (or is signed in) reports only what it shoots.
      missing: parts.includes('first-run') ? () => {} : missing
    })

    for (const part of parts) {
      log(`-- part ${part}`)
      for (const look of looks) {
        log(`-- ${look.theme} ${look.contrast}`)
        try {
          await setMainLook(look)
        } catch (error) {
          failed(`${part} look ${look.theme}/${look.contrast}`, error)
          continue
        }
        if (part === 'idle') await shootIdle({ ctx, main, only, sizes, failed, missing })
        if (part === 'windows') {
          await shootWindows({ ctx, main, only, devtoolsHost, failed, missing, record, look })
        }
        if (part === 'live') await shootLive({ ctx, main, only, failed, base })
        if (part === 'first-run') await shootFirstRun({ ctx, main, only, failed })
        if (part === 'buddy') await shootBuddy({ ctx, only, sizes, failed, missing })
      }
    }
  } finally {
    await Promise.all(pendingShots)
    main?.close()
    try {
      socket?.close()
    } catch {
      /* the app is going away */
    }
    await stopProcess(launched.process)
    await fakes?.close()
  }
  return { failures }
}

// ---------------------------------------------------------------------------
// The profile
// ---------------------------------------------------------------------------

async function seedProfile({ main, rpc, smoke, fixtures, stateDir, log, missing }) {
  mkdirSync(join(stateDir, 'recordings'), { recursive: true })
  const backend = await seedBaselineBackend({
    rpc,
    smoke,
    fixtures,
    recordingsDir: join(stateDir, 'recordings'),
    log
  })
  for (const { name, reason } of backend.failed) missing('profile', name, reason)

  const version =
    (await main.evaluate(readUiSettingJs('videorc.whatsNewLastSeenVersion'), {
      timeoutMs: 60_000
    })) ?? ''
  const sinkPort = 13_990
  const patch = baselineCaptureConfigPatch({ sinkPort })
  const seed = `
    const settings = await ${UI_SETTINGS_READY_JS};
    const key = 'videorc.captureConfig';
    const current = JSON.parse(settings.getItem(key) ?? '{}') ?? {};
    const patch = ${JSON.stringify(patch)};
    const keys = ${JSON.stringify(backend.keys)};
    const merged = { ...current, ...patch, sources: { ...(current.sources ?? {}), ...patch.sources } };
    delete merged.baselineSink;
    delete merged.sources.cameraId; delete merged.sources.cameraName; delete merged.sources.microphoneId; delete merged.sources.microphoneName;
    const now = ${JSON.stringify('2026-11-01T12:00:00.000Z')};
    const streaming = merged.streaming ?? { enabled: false, mode: 'single', targets: [] };
    streaming.enabled = true;
    streaming.targets = (streaming.targets ?? []).map((t) => {
      if (!(t.id in keys)) return t;
      const fake = { ...t, enabled: true, streamKey: '', streamKeyPresent: true, streamKeySecretRef: keys[t.id], updatedAt: now };
      if (t.id === 'custom') { fake.serverUrl = patch.baselineSink.serverUrl; fake.urlMode = 'server-and-key'; fake.authMode = 'manual-rtmp'; }
      return fake;
    });
    merged.streaming = streaming;
    merged.layout = { ...merged.layout, layoutPreset: 'screen-only' };
    merged.lastHorizontalPreset = 'screen-only';
    settings.setItem(key, JSON.stringify(merged));
    const working = JSON.parse(settings.getItem('videorc.working-scene.v1') ?? 'null');
    const layout = merged.layout;
    const visual = working?.visual ?? { layout, sources: merged.sources, background: null };
    visual.sources = { ...visual.sources, ...patch.sources };
    delete visual.sources.cameraId; delete visual.sources.cameraName;
    return { scenes: visual };
  `
  const { scenes: visual } = await main.evaluate(`(async () => { ${seed} })()`, {
    timeoutMs: 60_000
  })
  const entries = {
    ...baselineUiSettings({ whatsNewVersion: version || '0.0.0' }),
    'videorc.scene-presets.v1': JSON.stringify(baselineScenes(visual)),
    'videorc.working-scene.v1': JSON.stringify(baselineWorkingScene(visual))
  }
  await main.evaluate(seedUiSettingsJs(entries), { timeoutMs: 60_000 })
  await main.evaluate('location.reload(); true')
  await sleep(6000)
  // The three-platform chat rows: few and quick, so every look sees the same ones.
  try {
    await rpc('liveChat.start', baselineLiveChatStart())
    await waitForChat(rpc)
  } catch (error) {
    missing('stream-manager', 'chat-rows', String(error?.message ?? error))
  }
}

async function waitForChat(rpc) {
  const deadline = Date.now() + 25_000
  for (;;) {
    const snapshot = await rpc('liveChat.status', {})
    const platforms = new Set(snapshot.messages.map((message) => message.platform))
    if (
      ['youtube', 'twitch', 'x'].every((platform) => platforms.has(platform)) &&
      snapshot.messages.length >= 3 * BASELINE_CHAT_ROWS
    ) {
      return
    }
    if (Date.now() > deadline) throw new Error('The fake chat rows did not arrive.')
    await sleep(250)
  }
}

// ---------------------------------------------------------------------------
// Idle: pages, tabs, menus and dialogs
// ---------------------------------------------------------------------------

/** A sidebar page and the shots it takes. */
const PAGES = [
  {
    tab: 'studio',
    screen: 'studio',
    state: 'idle',
    aliases: [{ screen: 'shell', state: 'default' }]
  },
  { tab: 'sources', screen: 'sources', state: 'default' },
  { tab: 'layout', screen: 'scene', state: 'default' },
  { tab: 'assets', screen: 'assets', state: 'default' },
  { tab: 'sounds', screen: 'sounds', state: 'default' },
  { tab: 'streaming', screen: 'livestream-setup', state: 'default' },
  { tab: 'recording', screen: 'output', state: 'default' },
  { tab: 'captions', screen: 'captions', state: 'default' },
  { tab: 'library', screen: 'library', state: 'default' }
]

const SETTINGS_TABS = [
  ['General', 'settings-general'],
  ['Permissions', 'settings-permissions'],
  ['Shortcuts', 'settings-shortcuts'],
  ['Remote', 'settings-remote'],
  ['About', 'settings-about']
]

const BUDDY_TABS = [
  ['Overview', 'buddy-overview'],
  ['Chat', 'buddy-chat'],
  ['Community', 'buddy-community'],
  ['Voice', 'buddy-voice'],
  ['Reports', 'buddy-reports'],
  ['Clean cut', 'buddy-clean-cut']
]

const AVATAR_TABS = [
  ['Profile', 'avatar-profile'],
  ['Greetings', 'avatar-greetings']
]

/** Avatar → Profile's scrolled states and their `scrollTop` (CSS px); the
 * GPUI gallery's `avatar-profile-2` / `-3` scroll by the same amounts. */
const AVATAR_PROFILE_SCROLLS = [
  ['scroll-2', 600],
  ['scroll-3', 1200]
]

async function shootIdle({ ctx, only, sizes, failed, missing }) {
  const tryStep = async (screen, state, work) => {
    if (!wanted(only, screen)) return
    try {
      await work()
    } catch (error) {
      failed(
        `${screen}/${state} at ${ctx.size.width}x${ctx.size.height} ${ctx.look.theme}/${ctx.look.contrast}`,
        error
      )
      await ctx.dismiss().catch(() => {})
    }
  }
  for (const size of sizes) {
    ctx.size = size
    await ctx.smoke('resize-window', size)
    await sleep(1200)
    const one = size.width === 1280

    for (const page of PAGES) {
      await tryStep(page.screen, page.state, async () => {
        await ctx.dismiss()
        await ctx.open(page.tab)
        await ctx.shoot(page.screen, page.state, { aliases: page.aliases })
      })
    }
    await tryStep('livestream-upcoming', 'default', async () => {
      await ctx.open('streaming')
      await ctx.click('^Upcoming$', { selector: '[role=tab]', how: 'click' })
      await sleep(700)
      await ctx.shoot('livestream-upcoming', 'default')
      await ctx.click('^Setup$', { selector: '[role=tab]' })
    })
    // A destination's card open (the seeded, signed-out Twitch): its Stream
    // quality control. The GPUI gallery's destinations-stream-quality.
    await tryStep('livestream-setup', 'stream-quality', async () => {
      await ctx.open('streaming')
      await ctx.click('^Twitch$', { selector: '[aria-expanded]', how: 'click' })
      await sleep(700)
      await ctx.shoot('livestream-setup', 'stream-quality')
      await ctx.click('^Twitch$', { selector: '[aria-expanded]', how: 'click' })
    })
    for (const [label, screen] of SETTINGS_TABS) {
      await tryStep(screen, 'default', async () => {
        await ctx.open('settings')
        await ctx.js(
          `const el = (await (async () => { for (let i = 0; i < 50; i += 1) { const e = [...document.querySelectorAll('[data-videorc-settings-tab]')].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); if (e) return e; await sleep(100); } throw new Error('no settings tab'); })());
           el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })); el.click(); await sleep(600); return true`
        )
        await ctx.shoot(screen, 'default')
      })
    }
    await tryStep('livestream-discord', 'default', async () => {
      await ctx.open('streaming')
      await ctx.click('^Discord$', { selector: '[role=tab]', how: 'click' })
      await sleep(700)
      await ctx.shoot('livestream-discord', 'default')
      await ctx.click('^Setup$', { selector: '[role=tab]' })
    })
    for (const [label, screen] of AVATAR_TABS) {
      await tryStep(screen, 'default', async () => {
        await ctx.open('avatar')
        await ctx.click(`^${label}$`, { selector: '[role=tab]', how: 'click', timeout: 30_000 })
        await sleep(800)
        await ctx.shoot(screen, 'default')
      })
    }
    // Avatar → Profile below the fold (the GPUI gallery's avatar-profile-2
    // and -3): the page-tabs scroller at the same `scrollTop` the gallery
    // scrolls the GPUI page to. 1280x800 only, the gallery's size.
    if (ctx.size.width === 1280 && ctx.size.height === 800) {
      for (const [state, top] of AVATAR_PROFILE_SCROLLS) {
        await tryStep('avatar-profile', state, async () => {
          await ctx.open('avatar')
          await ctx.click('^Profile$', { selector: '[role=tab]', how: 'click', timeout: 30_000 })
          await sleep(800)
          await ctx.js(
            `const scroller = await waitFor(() => document.querySelector('[data-slot=page-tabs-scroll]'), 'the page-tabs scroller');
             scroller.scrollTop = ${top};
             await sleep(600);
             return scroller.scrollTop`
          )
          await ctx.shoot('avatar-profile', state)
          await ctx.js(
            `const scroller = document.querySelector('[data-slot=page-tabs-scroll]');
             if (scroller) scroller.scrollTop = 0;
             return true`
          )
        })
      }
    }
    for (const [label, screen] of BUDDY_TABS) {
      await tryStep(screen, 'locked', async () => {
        await ctx.open('ai')
        await ctx.click(`^${label}$`, { selector: '[role=tab]', timeout: 30_000 })
        await sleep(800)
        await ctx.shoot(screen, 'locked')
      })
    }
    await tryStep('health', 'default', async () => {
      await ctx.dismiss()
      await ctx.js(
        `(await waitFor0()).click(); await sleep(600); return true; async function waitFor0() { for (let i = 0; i < 300; i += 1) { const e = document.querySelector('[data-slot="status-bar-state"]'); if (e) return e; await sleep(100); } throw new Error('no status bar state'); }`
      )
      await ctx.shoot('health', 'default')
    })

    if (!one) continue
    await shootIdleStates({ ctx, tryStep, only, missing })
  }
}

/** Dialogs, menus, the palette and other states, at 1280x800 only. */
async function shootIdleStates({ ctx, tryStep, only, missing }) {
  await tryStep('palette', 'open', async () => {
    await ctx.open('studio')
    await ctx.js(
      `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true })); await sleep(900); return true`
    )
    // Let go of ⌘ before the shot: a held ⌘ shows the sidebar's shortcut
    // chips, which the GPUI gallery's palette (opened without a key) hasn't.
    await ctx.js(
      `document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Meta', metaKey: false, bubbles: true })); await sleep(300); return true`
    )
    await ctx.shoot('palette', 'open')
    await ctx.dismiss()
    await ctx.js(
      `document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Meta', metaKey: false, bubbles: true })); window.dispatchEvent(new Event('blur')); await sleep(300); return true`
    )
  })
  await tryStep('account-menu', 'open', async () => {
    await ctx.open('studio')
    await ctx.click('^Sign in$', { selector: '[data-slot=dropdown-menu-trigger]', how: 'pointer' })
    await sleep(700)
    await ctx.shoot('account-menu', 'open')
    await ctx.dismiss()
  })
  await tryStep('scene', 'item-selected', async () => {
    await ctx.open('layout')
    await ctx.click('^Select Test pattern', { selector: '[data-slot=toggle-group-item]' })
    await sleep(600)
    await ctx.shoot('scene', 'item-selected')
  })
  await tryStep('scene', 'new-scene', async () => {
    await ctx.open('layout')
    await ctx.click('^Add scene', { nth: 0 })
    await sleep(800)
    await ctx.shoot('scene', 'new-scene')
    await ctx.dismiss()
  })
  await tryStep('go-live', 'dialog', async () => {
    await ctx.open('studio')
    await ctx.click('^Go Live')
    await ctx.js(
      `await waitFor(() => document.querySelector('[data-testid=go-live-dialog]'), 'the Go Live dialog'); await sleep(500); return true`
    )
    await ctx.shoot('go-live', 'dialog')
    await ctx.dismiss()
  })
  await tryStep('toasts', 'info', async () => {
    await ctx.open('studio')
    for (const type of ['success', 'info', 'warning', 'error']) {
      await ctx.js(
        `const { toast } = await import('/src/lib/toast.ts'); toast.dismiss?.(); await sleep(300); toast.${type}('A ${type} toast', { description: 'What happened, in one sentence.' }); await sleep(700); return true`
      )
      await ctx.shoot('toasts', type, { keepToasts: true })
    }
  })
  await tryStep('studio', 'chat-in-studio', async () => {
    await setGeneralSwitch(ctx, 'Chat in Studio', true)
    await ctx.open('studio')
    await sleep(1200)
    await ctx.shoot('studio', 'chat-in-studio')
    await setGeneralSwitch(ctx, 'Chat in Studio', false)
  })
  // Plan 220 S3.1f: the Studio scrolled to its foot, where the Soundboard
  // (under Scenes) and the Takeover section (last in the inspector) show the
  // profile's two takeovers and its sounds.
  await tryStep('studio', 'sections', async () => {
    await ctx.dismiss()
    await ctx.open('studio')
    const scrollStudio = (to) =>
      ctx.js(
        `const board = await waitFor(() => document.querySelector('[data-videorc-soundboard]'), 'the Soundboard');
         let scroller = board.parentElement;
         while (scroller && !(scroller.scrollHeight > scroller.clientHeight && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement;
         if (!scroller) throw new Error('no Studio scroller');
         scroller.scrollTop = ${to};
         await sleep(600);
         return scroller.scrollTop`
      )
    await scrollStudio('scroller.scrollHeight')
    await ctx.shoot('studio', 'sections')
    await scrollStudio('0')
  })
  // Plan 220 S3.1b: the vertical leg monitor, last in the preview column:
  // YouTube Vertical (a vertical destination) on beside a horizontal scene
  // arms a dual-orientation stream; the Studio scrolled to its foot. The
  // profile goes back as it was after the shot.
  await tryStep('studio', 'vertical-leg', async () => {
    await ctx.dismiss()
    await setVerticalLeg(ctx, true)
    await ctx.open('studio')
    await ctx.js(
      `const leg = await waitFor(() => document.querySelector('[data-slot=vertical-stream-layout]'), 'the Vertical stream section');
       let scroller = leg.parentElement;
       while (scroller && !(scroller.scrollHeight > scroller.clientHeight && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement;
       if (scroller) scroller.scrollTop = scroller.scrollHeight;
       await sleep(600);
       return true`
    )
    await ctx.shoot('studio', 'vertical-leg')
    await setVerticalLeg(ctx, false)
  })
  // Plan 260 C4: Show stage gallery baselines (synthetic room; no LiveKit).
  // open / screens / host-camera-off match the gallery's `scroll: { dy: 420 }`
  // so Layout / Screens / People sit under the Program well on both sides.
  for (const [state, kind, scrollDy] of [
    ['closed', 'closed', 0],
    ['open', 'open', 420],
    ['screens', 'screens', 420],
    ['host-camera-off', 'host-camera-off', 420]
  ]) {
    await tryStep('show-stage', state, async () => {
      await ctx.dismiss()
      await seedShowStage(ctx, kind)
      await ctx.open('studio')
      await sleep(800)
      if (scrollDy > 0) {
        await ctx.js(
          `const well = await waitFor(
             () => document.querySelector('[data-testid=show-stage-well],[data-testid=show-stage-root],[data-testid=preview-replaced-by-show-stage]'),
             'the Show stage'
           );
           let scroller = well.parentElement;
           while (scroller && !(scroller.scrollHeight > scroller.clientHeight && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) {
             scroller = scroller.parentElement;
           }
           if (!scroller) throw new Error('no Show stage scroller');
           scroller.scrollTop = ${scrollDy};
           await sleep(600);
           return scroller.scrollTop`
        )
      }
      await ctx.shoot('show-stage', state)
      await seedShowStage(ctx, null)
    })
  }
  // Plan 260 C4: Guests ⌘7 with the same entitled/max CloudStatus as Show
  // stage open (no LiveKit), so the gallery can pair against Electron.
  await tryStep('guests', 'default', async () => {
    await ctx.dismiss()
    await seedShowStage(ctx, 'open')
    await ctx.open('guests')
    await sleep(800)
    await ctx.shoot('guests', 'default')
    await seedShowStage(ctx, null)
  })
  await tryStep('assets', 'kebab-menu', async () => {
    await ctx.open('assets')
    await ctx.click('^Actions for ', {
      selector: '[data-slot=dropdown-menu-trigger]',
      how: 'pointer'
    })
    await sleep(700)
    await ctx.shoot('assets', 'kebab-menu')
    await ctx.dismiss()
  })
  await tryStep('library', 'kebab-menu', async () => {
    await ctx.open('library')
    await ctx.js(
      `const row = await waitFor(() => document.querySelector('main [role=grid] [role=rowgroup]:not(:first-child) [role=row]'), 'a library session'); const buttons = [...row.querySelectorAll('button')]; buttons.at(-1).dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })); buttons.at(-1).click(); await sleep(800); return true`
    )
    await ctx.shoot('library', 'kebab-menu')
    await ctx.dismiss()
  })
  // The in-app player lives in the Library's Markers dialog (session-player.tsx):
  // row ⋯ menu → Markers.
  await tryStep('library-player', 'default', async () => {
    await ctx.open('library')
    await ctx.js(
      `const row = await waitFor(() => document.querySelector('main [role=grid] [role=rowgroup]:not(:first-child) [role=row]'), 'a library session'); const buttons = [...row.querySelectorAll('button')]; buttons.at(-1).dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })); buttons.at(-1).click(); await sleep(800); return true`
    )
    await ctx.click('^Markers$', { selector: '[role=menuitem]' })
    await sleep(2000)
    await ctx.shoot('library-player', 'default')
    await ctx.dismiss()
  })
  await tryStep('livestream-upcoming', 'schedule', async () => {
    await ctx.open('streaming')
    await ctx.click('^Upcoming$', { selector: '[role=tab]' })
    await sleep(600)
    await ctx.click('Schedule')
    await sleep(900)
    await ctx.shoot('livestream-upcoming', 'schedule')
    await ctx.dismiss()
    await ctx.click('^Setup$', { selector: '[role=tab]' })
  })
  await tryStep('settings-remote', 'connect-agent', async () => {
    await openSettingsTab(ctx, 'Remote')
    await ctx.js(
      `const sw = await waitFor(() => rowSwitch('AI agents'), 'the agents switch'); if (sw.getAttribute('aria-checked') !== 'true') { sw.click(); await sleep(1200); } return true`
    )
    try {
      await ctx.click('Connect an agent')
      await sleep(900)
      await ctx.shoot('settings-remote', 'connect-agent')
      await ctx.dismiss()
    } finally {
      await ctx.js(
        `const sw = rowSwitch('AI agents'); if (sw && sw.getAttribute('aria-checked') === 'true') { sw.click(); await sleep(800); } return true`
      )
    }
  })
  await tryStep('settings-general', 'obs-import', async () => {
    await openSettingsTab(ctx, 'General')
    await ctx.click('^Import from OBS')
    await sleep(900)
    await ctx.shoot('settings-general', 'obs-import')
    await ctx.dismiss()
  })
  await tryStep('shell', 'whats-new', async () => {
    await openSettingsTab(ctx, 'About')
    await ctx.click('What.s new')
    await sleep(900)
    await ctx.shoot('shell', 'whats-new')
    await ctx.dismiss()
  })
}

async function openSettingsTab(ctx, label) {
  await ctx.open('settings')
  await ctx.js(
    `const el = (await (async () => { for (let i = 0; i < 50; i += 1) { const e = [...document.querySelectorAll('[data-videorc-settings-tab]')].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); if (e) return e; await sleep(100); } throw new Error('no settings tab'); })());
     el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })); el.click(); await sleep(600); return true`
  )
}

/** A General-tab switch, found by its row's name, turned on or off. */
async function setGeneralSwitch(ctx, name, on) {
  await openSettingsTab(ctx, 'General')
  await ctx.js(
    `const sw = await waitFor(() => rowSwitch(${JSON.stringify(name)}), 'the ${name} switch'); if ((sw.getAttribute('aria-checked') === 'true') !== ${on}) { sw.click(); await sleep(700); } return true`
  )
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

async function shootWindows({ ctx, only, devtoolsHost, failed, record, look }) {
  const windowShot = async (role, openCommand, closeCommand, screen, boundsCommand, bands) => {
    if (!wanted(only, screen)) return
    let page = null
    try {
      await ctx.smoke(openCommand)
      page = await connectWindow(devtoolsHost(), role)
      await page.emulate({ contrast: look.contrast, colorScheme: look.theme })
      for (const band of bands) {
        if (band.width) {
          await ctx.smoke(boundsCommand, { width: band.width, height: band.height, x: 120, y: 60 })
          await sleep(1000)
        }
        const size = await page.evaluate(`({ width: innerWidth, height: innerHeight })`)
        await page.settled(600)
        const bytes = await page.screenshot()
        record(bytes, {
          screen,
          state: band.state ?? 'default',
          ...look,
          width: band.width ?? size.width,
          height: band.height ?? size.height
        })
      }
    } catch (error) {
      failed(`${screen} ${look.theme}/${look.contrast}`, error)
    } finally {
      page?.close()
      await ctx.smoke(closeCommand).catch(() => {})
      await sleep(500)
    }
  }
  await windowShot(
    'stream-manager',
    'comments-window-open',
    'comments-window-close',
    'stream-manager',
    'comments-window-set-bounds',
    STREAM_MANAGER_SIZES.map((band) => ({ ...band, state: `band-${band.width}` }))
  )
  await windowShot(
    'captions',
    'captions-window-open',
    'captions-window-close',
    'captions-reader',
    null,
    [{}]
  )
  await windowShot('notes', 'notes-window-open', 'notes-window-close', 'notes', null, [{}])
}

// ---------------------------------------------------------------------------
// Live, first run
// ---------------------------------------------------------------------------

const SINK_PORT = 13_990

/** A local RTMP sink: ffmpeg listens once and writes what arrives; never a real channel. */
function startSink(base) {
  const child = spawn(
    process.env.VIDEORC_FFMPEG_PATH ?? 'ffmpeg',
    [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-listen',
      '1',
      '-i',
      `rtmp://127.0.0.1:${SINK_PORT}/live/${BASELINE_FAKE_STREAM_KEY}`,
      '-c',
      'copy',
      '-f',
      'flv',
      join(base, 'sink.flv')
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  )
  let log = ''
  child.stderr.on('data', (text) => {
    log = (log + text).slice(-4000)
  })
  return { child, log: () => log }
}

async function stopSink(sink) {
  if (sink.child.exitCode === null && sink.child.signalCode === null) {
    sink.child.kill('SIGTERM')
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        sink.child.kill('SIGKILL')
        resolve()
      }, 4000)
      sink.child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
}

/** Plan 260 C4: synthetic talk-show CloudStatus for Show stage baselines. */
async function seedShowStage(ctx, kind) {
  if (kind == null) {
    await ctx.js(
      `if (!window.__videorcSmokeSeedShowStage) throw new Error('gallery Show stage seed missing');
       return window.__videorcSmokeSeedShowStage(null)`
    )
    return
  }
  const status = galleryCloudStatus(kind)
  const cameraOff = galleryHostCameraOff(kind)
  await ctx.js(
    `if (!window.__videorcSmokeSeedShowStage) throw new Error('gallery Show stage seed missing');
     return window.__videorcSmokeSeedShowStage(${JSON.stringify(status)}, ${JSON.stringify({ cameraOff })})`
  )
}

/** S3.1b: YouTube Vertical on (and the saved mode streaming) arms the
 * vertical leg; off puts the profile back. Saved, then the renderer reloads. */
async function setVerticalLeg(ctx, on) {
  await ctx
    .js(
      `const settings = await ${UI_SETTINGS_READY_JS};
      const key = 'videorc.captureConfig';
      const config = JSON.parse(settings.getItem(key));
      config.streamEnabled = ${on};
      config.streaming.enabled = true;
      config.streaming.targets = config.streaming.targets.map((t) =>
        t.id === 'youtube-vertical' ? { ...t, enabled: ${on} } : t);
      config.streaming.enabledTargetIds = config.streaming.targets.filter((t) => t.enabled).map((t) => t.id);
      settings.setItem(key, JSON.stringify(config));
      await settings.flush();
      location.reload();
      return true`,
      { timeoutMs: 60_000 }
    )
    .catch(() => {})
  await sleep(6000)
}

let liveTargetsReady = false

/** Only the local sink may be on: the seeded YouTube and Twitch targets are switched off. */
async function useLocalSinkOnly(main) {
  if (liveTargetsReady) return
  await main
    .evaluate(
      `(async () => {
      const settings = await ${UI_SETTINGS_READY_JS};
      const key = 'videorc.captureConfig';
      const config = JSON.parse(settings.getItem(key));
      config.streaming.targets = config.streaming.targets.map((t) => t.id === 'custom'
        ? { ...t, enabled: true, serverUrl: ${JSON.stringify(`rtmp://127.0.0.1:${SINK_PORT}/live`)} }
        : { ...t, enabled: false });
      settings.setItem(key, JSON.stringify(config));
      await settings.flush();
      location.reload();
    })()`,
      { timeoutMs: 60_000 }
    )
    .catch(() => {})
  await sleep(6000)
  liveTargetsReady = true
}

async function shootLive({ ctx, main, only, failed, base }) {
  const tryStep = async (screen, state, work) => {
    if (!wanted(only, screen)) return
    try {
      await work()
    } catch (error) {
      failed(`${screen}/${state} ${ctx.look.theme}/${ctx.look.contrast}`, error)
      await ctx.dismiss().catch(() => {})
    }
  }
  ctx.size = { width: 1280, height: 800 }
  await ctx.smoke('resize-window', ctx.size)
  await sleep(1000)
  await useLocalSinkOnly(main)
  await tryStep('studio', 'recording', async () => {
    await ctx.open('studio')
    await ctx.click('^Record', { selector: 'button' })
    await ctx.js(
      `await waitFor(() => findAll('Stop recording').length > 0, 'the recording to start', 30000); await sleep(2500); return true`,
      { timeoutMs: 50_000 }
    )
    await ctx.shoot('studio', 'recording')
    await ctx.click('Stop recording')
    await ctx.js(
      `await waitFor(() => findAll('^Record').length > 0 && findAll('Stop recording').length === 0, 'the recording to stop', 30000); await sleep(2500); return true`,
      { timeoutMs: 50_000 }
    )
  })
  await tryStep('studio', 'on-air', async () => {
    await ctx.open('studio')
    const sink = startSink(base)
    try {
      await sleep(800)
      await ctx.click('^Go Live')
      await ctx.js(`const dialog = await waitFor(() => document.querySelector('[data-testid=go-live-dialog]'), 'the Go Live dialog');
        const title = dialog.querySelector('input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(title, 'Baseline livestream'); title.dispatchEvent(new Event('input', { bubbles: true })); await sleep(900); return true`)
      const seen = await ctx.js(
        `const b = await waitFor(() => document.querySelector('[data-testid=go-live-confirm]'), 'the confirm button'); return { confirm: nameOf(b), destinations: document.querySelectorAll('[data-testid=go-live-destination]').length, excluded: document.querySelectorAll('[data-testid=go-live-excluded]').length, text: [...document.querySelectorAll('[data-testid=go-live-destination]')].map((d) => nameOf(d).slice(0, 40)) }`
      )
      if (seen.destinations !== 1 || /\bon [2-9]\b/.test(seen.confirm)) {
        throw new Error(
          `Refusing to go live: the dialog lists ${seen.destinations} destinations (${JSON.stringify(seen.text)}), confirm "${seen.confirm}"; only the local sink may be on.`
        )
      }
      await ctx.js(
        `document.querySelector('[data-testid=go-live-confirm]').click(); await waitFor(() => findAll('End livestream').length > 0, 'the stream to start (saw: ' + findAll('.').map(nameOf).slice(0, 30).join(' | ') + ')', 45000); await sleep(4000); return true`,
        { timeoutMs: 70_000 }
      )
      await ctx.shoot('studio', 'on-air')
      await ctx.click('End livestream')
      await ctx.js(
        `await waitFor(() => document.querySelector('[role=alertdialog],[role=dialog]'), 'the End livestream dialog'); await sleep(700); return true`
      )
      await ctx.shoot('go-live', 'end-livestream')
      await ctx.js(
        `const dialog = document.querySelector('[role=alertdialog],[role=dialog]'); const end = findAll('End livestream', dialog).at(-1) ?? findAll('.', dialog).at(-1); end.click(); await waitFor(() => !document.querySelector('[role=alertdialog],[role=dialog]') && findAll('End livestream').length === 0, 'the stream to end', 60000); await sleep(3000); return true`,
        { timeoutMs: 90_000 }
      )
    } finally {
      await stopSink(sink)
    }
  })
}

// ---------------------------------------------------------------------------
// First run
// ---------------------------------------------------------------------------

const FIRST_RUN_STEPS = ['permissions', 'goal', 'look', 'sound', 'destinations']

async function shootFirstRun({ ctx, main, only, failed }) {
  if (!wanted(only, 'first-run')) return
  ctx.size = { width: 1280, height: 800 }
  await ctx.smoke('resize-window', ctx.size)
  const reload = async () => {
    await main.evaluate('location.reload(); true').catch(() => {})
    await sleep(5000)
  }
  const seedRecord = async (record) => {
    await main.evaluate(seedUiSettingsJs({ 'videorc.firstRun': JSON.stringify(record) }), {
      timeoutMs: 60_000
    })
    await reload()
  }
  try {
    // The backdrop's moving picture is the one thing that never holds still.
    await main.emulate({ contrast: ctx.look.contrast, reducedMotion: true })
    for (const step of FIRST_RUN_STEPS) {
      try {
        await seedRecord({
          version: 2,
          status: 'in-progress',
          step,
          goal: 'stream',
          updatedAt: '2026-11-01T12:00:00.000Z'
        })
        await ctx.js(
          `await waitFor(() => document.querySelector('[data-first-run-setup]'), 'the first-run setup', 30000); await sleep(1500); return true`,
          { timeoutMs: 50_000 }
        )
        await ctx.shoot('first-run', step)
      } catch (error) {
        failed(`first-run/${step} ${ctx.look.theme}/${ctx.look.contrast}`, error)
      }
    }
  } finally {
    await seedRecord({
      version: 2,
      status: 'done',
      step: 'permissions',
      goal: 'stream',
      updatedAt: '2026-11-01T12:00:00.000Z'
    }).catch(() => {})
    await main.emulate({ contrast: ctx.look.contrast })
  }
}

// ---------------------------------------------------------------------------
// The signed-in Buddy run
// ---------------------------------------------------------------------------

async function startSignedInFakes(stateDir) {
  const token = `baseline-${randomUUID()}`
  const appData = join(stateDir, 'app-data')
  mkdirSync(appData, { recursive: true })
  writeFileSync(
    join(appData, 'videorc-secrets.json'),
    JSON.stringify({ 'account:videorc:session': token }, null, 2),
    { mode: 0o600 }
  )
  const cohost = await startFakeCohostService({ smokeSessionToken: token, buddyAct: true })
  const flags = createServer((request, response) => {
    request.resume()
    // The session check (`/api/auth/get-session`) and the service flags.
    const body = request.url?.startsWith('/api/auth/get-session')
      ? JSON.stringify({
          user: { name: 'Baseline Streamer', email: 'baseline@example.test', image: null },
          session: { token }
        })
      : JSON.stringify({ orcle: { voiceCommands: true, remove: true } })
    response.writeHead(200, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body)
    })
    response.end(body)
  })
  await new Promise((resolve) => flags.listen(0, '127.0.0.1', resolve))
  const router = await startFakeApiRouter({
    routes: [
      { prefix: BUDDY_ACT_PATH, origin: cohost.httpOrigin },
      { prefix: AI_CAPABILITIES_PATH, origin: cohost.httpOrigin },
      { prefix: '/api/desktop/service-flags', origin: `http://127.0.0.1:${flags.address().port}` },
      { prefix: '/api/auth/get-session', origin: `http://127.0.0.1:${flags.address().port}` }
    ],
    fallback: cohost.httpOrigin
  })
  return {
    origin: router.httpOrigin,
    close: async () => {
      await router.close()
      await cohost.close()
      await new Promise((resolve) => flags.close(() => resolve()))
    }
  }
}

async function shootBuddy({ ctx, only, sizes, failed }) {
  const tryStep = async (screen, state, work) => {
    if (!wanted(only, screen)) return
    try {
      await work()
    } catch (error) {
      failed(
        `${screen}/${state} at ${ctx.size.width}x${ctx.size.height} ${ctx.look.theme}/${ctx.look.contrast}`,
        error
      )
      await ctx.dismiss().catch(() => {})
    }
  }
  for (const size of sizes) {
    ctx.size = size
    await ctx.smoke('resize-window', size)
    await sleep(1200)
    for (const [label, screen] of BUDDY_TABS) {
      await tryStep(screen, 'unlocked', async () => {
        await ctx.dismiss()
        await ctx.open('ai')
        await ctx.click(`^${label}$`, { selector: '[role=tab]', timeout: 30_000 })
        await sleep(1200)
        await ctx.shoot(screen, 'unlocked')
      })
    }
    if (size.width !== 1280) continue
    await tryStep('account-menu', 'signed-in', async () => {
      await ctx.open('studio')
      await ctx.click('Baseline Streamer', {
        selector: '[data-slot=dropdown-menu-trigger]',
        how: 'pointer'
      })
      await sleep(700)
      await ctx.shoot('account-menu', 'signed-in')
      await ctx.dismiss()
    })
    // Plan 239 moved avatar creation to the Avatar page (⌘7, or ⌘8 with Guests): onboarding is
    // "New avatar…" on Profile, and the Alive creator replaces Profile.
    await tryStep('buddy-pet-creator', 'default', async () => {
      await ctx.open('avatar')
      await ctx.click('^Profile$', { selector: '[role=tab]', how: 'click' })
      await sleep(600)
      await ctx.js(
        `const { openBuddyPetCreator } = await import('/src/lib/buddy-pet-creator-nav.ts'); openBuddyPetCreator({ reference: 'persona-idle' }); await sleep(1500); return true`
      )
      await ctx.shoot('buddy-pet-creator', 'default')
      await ctx.js(
        `const { closeBuddyPetCreator } = await import('/src/lib/buddy-pet-creator-nav.ts'); closeBuddyPetCreator(); await sleep(600); return true`
      )
    })
    await tryStep('buddy-onboarding', 'default', async () => {
      await ctx.open('avatar')
      await ctx.click('^Profile$', { selector: '[role=tab]', how: 'click' })
      await sleep(600)
      await ctx.click('^New avatar')
      await sleep(1500)
      await ctx.shoot('buddy-onboarding', 'default')
      await ctx.dismiss()
    })
  }
}
