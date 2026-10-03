// probe:ui-glass: real composited glass checks for every Videorc window.
//
// Launches the dev app with isolated user data, puts a stand-in wallpaper
// behind each window (the smoke backdrop; the user's real desktop is never
// captured), REGION-captures the window (`screencapture -R`, the only capture
// that shows macOS vibrancy) and measures a text-free sample rect:
//
//   transmission  colour distance between the red- and blue-backdrop shots:
//                 real glass lets the desktop colour through
//   sharpness     Laplacian variance over the dense-text backdrop: blurred
//                 glass is smooth; a translucent coat over sharp text is not
//                 (the July text leak, as a number)
//   contrast      text tokens against the coat measured over white and black
//   pinned        the dark-always Preview stays dark while main is in light theme
//   followsTheme  Stream Manager, Captions and Notes pages carry the app theme
//   native        the window's NSVisualEffectViews read back as `active`
//                 (window-glass-state), so the glass never follows focus
//
// The run never activates the app: the backdrop and the window under test sit
// on floating levels and are shown inactive, so the user's focus (and their
// keystrokes: a stray D flips the app theme) stays where it is. Every window
// is therefore measured unfocused, the state Chat and Captions live in during
// a stream; the material is `visualEffectState: 'active'` either way.
//
// --surfaces adds the floating glass (plan 072; plan 091 S3) on main and
// chat: the real float utilities (the popup, dialog and tooltip tiers)
// painted over a text-free patch of the window and over app text (sidebar
// rows, Stream Manager filters), scored by scripts/lib/float-glass-checks.mjs
// (a fixed tone against the computed colour whatever is behind, opaque, text
// contrast, no bleed of the text underneath). The old near-opaque popover
// coat is measured beside them as an ungated control. The primitives' use of
// the utilities is pinned by the renderer guard tests.
//
// Plan 091 (the clear glass, VIDEORC_GLASS_STYLE=clear) adds two metrics on
// every window with a page, gated whenever the app reports that style was
// requested:
//
//   neutrality    with the renderer's coats zeroed through CDP, the RGB
//                 distance between the window sample and a patch of the bare
//                 backdrop beside the window, over white, black, red and blue.
//                 A stripped material passes the colour through (<= 8); the
//                 material as AppKit draws it sits hundreds of steps away
//   nativeClear   every behind-window effect view reads back as the
//                 clear-glass class with the Ghostex radius, no wallpaper
//                 tinting and no saturation filter (scripts/lib/glass-neutrality.mjs)
//   parity        ghostexParity (S1): the coats a sample sits under are read
//                 from the page (getComputedStyle), composited over the
//                 bare-backdrop reference in sRGB, and the prediction must
//                 sit within a few RGB steps of the capture over white and
//                 black (scripts/lib/glass-parity.mjs). The OKLCH L of both
//                 is reported beside it for the plan's table
//
// --style=clear|material launches the app with that VIDEORC_GLASS_STYLE.
// --persistence (main only) walks the transitions AppKit rebuilds a material
// through (theme, resize, simple fullscreen, a re-created vibrancy view) and
// re-reads nativeClear after each. The focus cycle and minimize/restore need
// --allow-focus: both activate the app, taking the user's focus for a moment.
// --frost-check records (never gates) whether a bare CSS backdrop-filter
// reaches the screen on these windows, plan 072's S0 question.
//
// Capture validity is separate from glass metrics. A missing/stale owner or
// an obstructed capture invalidates the entire run in both report and gate
// modes; no pixels from that run establish material acceptance or failure.
// Report mode prints every valid metric; --gate fails the run on any check.
//
//   node scripts/ui-glass-probe.mjs [--gate] [--surfaces] [--themes=dark,light]
//     [--roles=main,chat,captions,notes,preview] [--style=clear|material]
//     [--persistence] [--allow-focus] [--frost-check]
//
// Extra app env rides in VIDEORC_UI_GLASS_APP_ENV (JSON), e.g.
// '{"VIDEORC_GLASS":"0"}' to measure the solid palette.

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { launchDevApp } from './lib/app-launcher.mjs'
import {
  belowSheen,
  centredRect,
  evaluateFloatBleed,
  evaluateFloatPatch,
  FLOAT_GLASS_THRESHOLDS,
  growRect
} from './lib/float-glass-checks.mjs'
import {
  backdropReferenceRect,
  nativeClearCheck,
  NEUTRALITY_BACKDROPS,
  neutralityOf
} from './lib/glass-neutrality.mjs'
import { parityOf, parseCssColor } from './lib/glass-parity.mjs'
import {
  captureGlassEvidence,
  finalizeGlassEvidence,
  InvalidGlassEvidenceError
} from './lib/glass-evidence-validity.mjs'
import { createGlassWindowReader } from './lib/glass-window-oracle.mjs'
import {
  colorDistance,
  contrastRatio,
  decodePng,
  laplacianVariance,
  parseHexColor,
  regionMean,
  relativeLuminance
} from './lib/image-stats.mjs'
import { requestSmokeCommand } from './lib/smoke-command-client.mjs'

// Calibrated on macOS 26.5.1 / Electron 39.8.10; the raw populations live in
// docs/acceptance/2026-09-23-real-glass-calibration.md. Transmission: the fake
// frost measured <= 3.9, real glass >= 9.8. Sharpness: real glass <= 0.3 away
// from edges and <= 4.2 within the blur reach of a window edge (the 28pt
// Preview strip), a transparent window without the material (text readable
// behind) >= 11.8.
export const GLASS_THRESHOLDS = Object.freeze({
  minTransmission: 8,
  maxSharpness: 6,
  minPrimaryContrast: 7,
  minSecondaryContrast: 4.5,
  maxPinnedLuminance: 0.12,
  // Plan 091: a stripped material within 8 RGB steps of the bare backdrop
  // (AppKit's dark material measures about 313 over white), at Ghostex's radius.
  maxNeutrality: 8,
  clearBlurRadius: 60,
  // Plan 091 S1: the coats composited over the reference predict the sample
  // within this many RGB steps. The 2026-10-02 population (20 samples, five
  // windows, both themes) tops out at 1.53; 4 keeps 2.6x that and still fails
  // a cover off by 0.016 or more (0.02 moves a dark sample 5 steps over white).
  maxParity: 4
})

// sRGB of the text tokens in styles.css: --foreground / --muted-foreground
// (dark oklch 0.97 / 0.71, light oklch 0.17 / 0.47).
const TEXT = {
  dark: { primary: parseHexColor('#F5F5F6'), secondary: parseHexColor('#A1A1A6') },
  light: { primary: parseHexColor('#101012'), secondary: parseHexColor('#5B5B5E') }
}

// Sample rects in window points, chosen text-free in every layout the plan
// ships: the middle of a toolbar row, the empty foot of the sidebar, the empty
// top of a list or textarea. Functions of the window size.
const SAMPLES = {
  main: [
    {
      name: 'content-toolbar',
      rect: (w) => ({ x: w.width * 0.45, y: 8, width: w.width * 0.15, height: 18 })
    },
    { name: 'sidebar-foot', rect: (w) => ({ x: 20, y: w.height - 108, width: 150, height: 40 }) }
  ],
  chat: [
    {
      name: 'list-foot',
      rect: (w) => ({ x: 24, y: w.height - 260, width: w.width - 48, height: 120 })
    }
  ],
  captions: [{ name: 'body', rect: (w) => ({ x: 40, y: 52, width: w.width - 80, height: 40 }) }],
  notes: [
    {
      name: 'textarea',
      rect: (w) => ({ x: w.width * 0.4, y: 150, width: w.width * 0.5, height: 120 })
    }
  ],
  preview: [
    { name: 'strip', rect: (w) => ({ x: w.width * 0.55, y: 6, width: w.width * 0.4, height: 14 }) }
  ]
}

const OPEN_COMMAND = {
  chat: 'comments-window-open',
  captions: 'captions-window-open',
  notes: 'notes-window-open',
  preview: 'preview-window-open'
}
const SET_BOUNDS_COMMAND = {
  main: 'main-window-set-bounds',
  chat: 'comments-window-set-bounds',
  captions: 'captions-window-set-bounds',
  notes: 'notes-window-set-bounds',
  preview: 'preview-window-set-bounds'
}
const PINNED_DARK_ROLES = new Set(['preview'])

// Floating glass (--surfaces): the roles with a renderer page to paint on, the
// backdrops each patch is shot over, and the pre-072 popover coat (the
// control). A patch is a hover-card-sized sample inside the role's first
// text-free window sample; the surface overhangs it by the blur reach.
const SURFACE_ROLES = new Set(['main', 'chat'])
const BACKDROPS = ['red', 'blue', 'white', 'black', 'text']
const SURFACE_OVERHANG = 30
// App text each role's bleed check hides: the sidebar rows (the selected
// row's primary text among them) and the Stream Manager filter labels, the
// white text a 97% coat still leaked on the owner's hover card.
const TEXT_ROWS = {
  main: 'aside a, aside button',
  chat: '[data-slot="chat-filters"] button'
}
const OLD_POPOVER_COAT = {
  dark: 'oklch(0.16 0.004 286 / 92%)',
  light: 'oklch(0.99 0 0 / 92%)'
}

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const option = (name, fallback) =>
  argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
const gate = flag('gate')
const surfaces = flag('surfaces')
const persistence = flag('persistence')
const allowFocus = flag('allow-focus')
const frostCheck = flag('frost-check')
const themes = option('themes', 'dark,light').split(',')
const roles = option('roles', 'main,chat,captions,notes,preview').split(',')
const style = option('style', null)
if (style !== null && style !== 'clear' && style !== 'material') {
  throw new Error(`--style must be clear or material, not ${style}.`)
}
const extraAppEnv = {
  ...(process.env.VIDEORC_UI_GLASS_APP_ENV ? JSON.parse(process.env.VIDEORC_UI_GLASS_APP_ENV) : {}),
  ...(style ? { VIDEORC_GLASS_STYLE: style } : {})
}
const outputRoot = process.env.VIDEORC_UI_GLASS_OUTPUT_DIR ?? tmpdir()
mkdirSync(outputRoot, { recursive: true })
// Never overwrite a previous run's report or raw shots, including invalid ones.
const outputDir = mkdtempSync(join(outputRoot, 'videorc-ui-glass-'))
let glassWindowReader
let glassValidity

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: 'GET' }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => (text += chunk))
      res.on('end', () => {
        try {
          resolve(JSON.parse(text))
        } catch (error) {
          reject(error)
        }
      })
    })
    req.on('error', reject)
    req.end()
  })
}

async function cdpEvaluate(webSocketUrl, expression) {
  const socket = new WebSocket(webSocketUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve)
    socket.addEventListener('error', () => reject(new Error('CDP connect failed')))
  })
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP evaluate timed out')), 10_000)
      socket.addEventListener('message', (event) => {
        const message = JSON.parse(event.data)
        if (message.id !== 1) return
        clearTimeout(timer)
        if (message.error) reject(new Error(message.error.message))
        else resolve(message.result?.result?.value)
      })
      socket.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression, returnByValue: true }
        })
      )
    })
  } finally {
    socket.close()
  }
}

function targetMatcher(role) {
  if (role === 'main') return (url) => /^https?:\/\/localhost:\d+\/(index\.html)?(\?.*)?$/.test(url)
  if (role === 'chat') return (url) => /\/comments\.html/.test(url)
  if (role === 'captions') return (url) => /\/captions\.html/.test(url)
  if (role === 'notes')
    return (url) => /\/notes\.html/.test(url) || /Videorc%20Notes|Notes%20for%20this/.test(url)
  return () => false
}

async function pageTarget(devtoolsHost, role) {
  const targets = await fetchJson(`http://${devtoolsHost}/json/list`)
  const matches = targetMatcher(role)
  return targets.find((target) => target.type === 'page' && matches(target.url ?? '')) ?? null
}

// The page's theme class, or null for a window without a renderer page (Preview).
async function pageDarkClass(devtoolsHost, role) {
  const target = await pageTarget(devtoolsHost, role)
  return target
    ? await cdpEvaluate(
        target.webSocketDebuggerUrl,
        `document.documentElement.classList.contains('dark')`
      )
    : null
}

async function applyTheme(devtoolsHost, theme) {
  const main = await pageTarget(devtoolsHost, 'main')
  if (!main) throw new Error('Main window CDP target not found.')
  await cdpEvaluate(
    main.webSocketDebuggerUrl,
    `localStorage.setItem('videorc.onboardingComplete', 'creator-ux-v1'); localStorage.setItem('videorc.theme', ${JSON.stringify(theme)}); location.reload(); true`
  )
  await sleep(7000)
}

// A shot taken after the theme changed under the run would be scored against
// the wrong text tokens; fail loudly instead.
async function assertTheme(devtoolsHost, theme) {
  const main = await pageTarget(devtoolsHost, 'main')
  const dark = main
    ? await cdpEvaluate(
        main.webSocketDebuggerUrl,
        `document.documentElement.classList.contains('dark')`
      )
    : null
  if (dark !== (theme === 'dark')) {
    throw new Error(
      `Main window theme is not ${theme} (dark class: ${dark}); was the D key pressed in the app?`
    )
  }
}

function capture(bounds, name) {
  const file = join(outputDir, `${name}.png`)
  execFileSync(
    'screencapture',
    ['-x', `-R${bounds.x},${bounds.y},${bounds.width},${bounds.height}`, file],
    { timeout: 10_000 }
  )
  return file
}

function measure(file, bounds, role) {
  const image = decodePng(readFileSync(file))
  const scale = image.width / bounds.width
  return SAMPLES[role].map((sample) => {
    const points = sample.rect(bounds)
    const rect = {
      x: points.x * scale,
      y: points.y * scale,
      width: points.width * scale,
      height: points.height * scale
    }
    return {
      name: sample.name,
      mean: regionMean(image, rect),
      sharpness: laplacianVariance(image, rect)
    }
  })
}

async function shoot(smoke, theme, role, variant, prefix = '') {
  await requestSmokeCommand(
    smoke,
    'open-backdrop-window',
    { variant, raise: false },
    { timeoutMs: 20_000 }
  )
  const raised = await requestSmokeCommand(smoke, 'raise-window', { role, focus: false })
  await sleep(700)
  return captureGlassEvidence({
    role,
    raised,
    capture,
    name: `${prefix}${theme}-${role}-${variant}`,
    readWindows: () => glassWindowReader(),
    recordValidity: (diagnostic) => glassValidity.samples.push(diagnostic)
  })
}

// Windows open asynchronously (the preview through its supervisor): wait for
// each role instead of failing on the first raise, asking once more midway.
async function waitForWindow(smoke, role) {
  const deadline = Date.now() + 20_000
  let reopened = false
  for (;;) {
    try {
      return await requestSmokeCommand(smoke, 'raise-window', { role, focus: false })
    } catch (error) {
      if (!/No open window/.test(String(error?.message)) || Date.now() > deadline) throw error
      if (!reopened && OPEN_COMMAND[role] && Date.now() > deadline - 12_000) {
        reopened = true
        await requestSmokeCommand(smoke, OPEN_COMMAND[role], {}, { timeoutMs: 20_000 })
      }
      await sleep(500)
    }
  }
}

async function placeOnPrimaryDisplay(smoke, role, index) {
  const { bounds, primaryWorkArea } = await waitForWindow(smoke, role)
  const width = Math.min(bounds.width, primaryWorkArea.width - 80)
  const height = Math.min(bounds.height, primaryWorkArea.height - 80)
  // focus: false shows the placed window inactive; the plain set-bounds path
  // calls show(), which activates the app and takes the user's focus.
  await requestSmokeCommand(smoke, SET_BOUNDS_COMMAND[role], {
    x: primaryWorkArea.x + 40 + index * 12,
    y: primaryWorkArea.y + 30 + index * 12,
    width,
    height,
    focus: false
  })
}

// ghostexParity (plan 091 S1): the elements whose coats a sample sits under,
// body first. main's toolbar sample sits on body + main (the content coat),
// its sidebar sample on body + aside (the sidebar coat); the single-pane
// windows paint the content coat on their WindowFrame. The preview has no
// page (its coats come from window-palette.ts) and is not scored.
const COAT_STACKS = {
  main: { 'content-toolbar': ['body', 'main'], 'sidebar-foot': ['body', 'aside'] },
  chat: { 'list-foot': ['body', '[data-slot="window-frame"]'] },
  captions: { body: ['body', '[data-slot="window-frame"]'] },
  notes: { textarea: ['body', '[data-slot="window-frame"]'] }
}

// The computed background of each coat element, as Chromium resolved the
// tokens (`oklch(L C H / A)`), per sample: the read-back that proves the
// derived coats survived the CSS pipeline, and the input to the parity
// prediction. Null for a role without a page.
async function readCoats(devtoolsHost, role) {
  const stacks = COAT_STACKS[role]
  const target = stacks ? await pageTarget(devtoolsHost, role) : null
  if (!target) return null
  const selectors = [...new Set(Object.values(stacks).flat())]
  const computed = await cdpEvaluate(
    target.webSocketDebuggerUrl,
    `(() => Object.fromEntries(${JSON.stringify(selectors)}.map((selector) => {
      const el = document.querySelector(selector);
      return [selector, el ? getComputedStyle(el).backgroundColor : null];
    })))()`
  )
  const coats = {}
  for (const [sample, stack] of Object.entries(stacks)) {
    if (stack.some((selector) => computed[selector] === null)) continue
    coats[sample] = stack.map((selector) => parseCssColor(computed[selector]))
  }
  return { computed, coats }
}

// Plan 091: zero (or restore) the window coats in the role's page, so a shot
// shows the native material alone. An injected `!important` rule on the
// token hosts beats styles.css whatever the theme class; a reload drops it.
async function setCoats(devtoolsHost, role, zero) {
  const target = await pageTarget(devtoolsHost, role)
  if (!target) return false
  await cdpEvaluate(
    target.webSocketDebuggerUrl,
    `(() => {
      document.getElementById('ui-glass-probe-neutral')?.remove();
      if (${zero ? 'true' : 'false'}) {
        const style = document.createElement('style');
        style.id = 'ui-glass-probe-neutral';
        style.textContent = ':root, :root.dark, .dark { --glass-window: transparent !important; --glass-content: transparent !important; --glass-sidebar: transparent !important; }';
        document.head.appendChild(style);
      }
      return true;
    })()`
  )
  return true
}

// The float tiers the gate measures (plan 091 D6): the utility each paints
// and the real primitives that carry it.
const SURFACE_TIERS = {
  float: 'glass-float',
  dialog: 'glass-float-dialog',
  tooltip: 'glass-float-tooltip'
}

// Paints a probe surface over `rect` (window points) in the role's page and
// returns its computed background colour: `float`, `dialog` and `tooltip`
// are the real utilities (the popup, dialog and tooltip tiers), `control`
// the old popover coat, `leak` the popup tier at a 97% coat (the
// translucency that let white tab labels read through the hover card before
// the coat went opaque), `frost` a bare CSS backdrop-filter with no coat at
// all (plan 072 S0's question).
async function showSurface(devtoolsHost, role, bounds, rect, kind, theme) {
  const target = await pageTarget(devtoolsHost, role)
  if (!target) throw new Error(`No CDP target for ${role}; cannot paint a floating surface.`)
  const spec = JSON.stringify({
    rect,
    boundsWidth: bounds.width,
    kind,
    utility: SURFACE_TIERS[kind] ?? SURFACE_TIERS.float,
    coat: OLD_POPOVER_COAT[theme]
  })
  return cdpEvaluate(
    target.webSocketDebuggerUrl,
    `(() => {
      const spec = ${spec};
      document.getElementById('ui-glass-probe-surface')?.remove();
      const scale = innerWidth / spec.boundsWidth;
      const el = document.createElement('div');
      el.id = 'ui-glass-probe-surface';
      el.className =
        spec.kind === 'control' ? 'rounded-lg border'
        : spec.kind === 'frost' ? 'rounded-lg'
        : 'rounded-lg border ' + spec.utility;
      Object.assign(el.style, {
        position: 'fixed', zIndex: '2147483647', pointerEvents: 'none',
        left: spec.rect.x * scale + 'px', top: spec.rect.y * scale + 'px',
        width: spec.rect.width * scale + 'px', height: spec.rect.height * scale + 'px'
      });
      if (spec.kind === 'control') el.style.backgroundColor = spec.coat;
      if (spec.kind === 'leak') {
        el.style.backgroundColor = 'color-mix(in oklch, var(--glass-float) 97%, transparent)';
      }
      if (spec.kind === 'frost') {
        el.style.backgroundColor = 'transparent';
        el.style.backdropFilter = 'blur(24px)';
        el.style.webkitBackdropFilter = 'blur(24px)';
      }
      document.body.appendChild(el);
      return getComputedStyle(el).backgroundColor;
    })()`
  )
}

async function hideSurface(devtoolsHost, role) {
  const target = await pageTarget(devtoolsHost, role)
  if (!target) return
  await cdpEvaluate(
    target.webSocketDebuggerUrl,
    `(() => { document.getElementById('ui-glass-probe-surface')?.remove(); return true })()`
  )
}

// The union of the role's first rows with text (TEXT_ROWS), in window points:
// the app text a floating surface must hide. Null when the page has none.
async function appTextRect(devtoolsHost, role, bounds) {
  const target = await pageTarget(devtoolsHost, role)
  const found = await cdpEvaluate(
    target.webSocketDebuggerUrl,
    `(() => {
      const rows = Array.from(document.querySelectorAll(${JSON.stringify(TEXT_ROWS[role])}))
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 30 && r.height > 12 && r.top > 30 && (el.textContent || '').trim().length > 2;
        })
        .slice(0, 3)
        .map((el) => el.getBoundingClientRect());
      if (!rows.length) return null;
      const x = Math.min(...rows.map((r) => r.left));
      const y = Math.min(...rows.map((r) => r.top));
      return {
        x, y,
        width: Math.max(...rows.map((r) => r.right)) - x,
        height: Math.max(...rows.map((r) => r.bottom)) - y,
        innerWidth
      };
    })()`
  )
  if (!found) return null
  const scale = bounds.width / found.innerWidth
  return {
    x: found.x * scale,
    y: found.y * scale,
    width: found.width * scale,
    height: found.height * scale
  }
}

function regionAt(file, bounds, rect) {
  const image = decodePng(readFileSync(file))
  const scale = image.width / bounds.width
  const pixels = {
    x: rect.x * scale,
    y: rect.y * scale,
    width: rect.width * scale,
    height: rect.height * scale
  }
  return { mean: regionMean(image, pixels), sharpness: laplacianVariance(image, pixels) }
}

// Floating glass on one role: each tier painted over the patch, shot over
// every backdrop and scored against its own computed colour (tone), its
// spread (opaque) and the text tokens; the old popover coat rides along as
// an ungated control; then the bleed of the role's app text through the
// popup tier.
async function measureSurfaces(smoke, devtoolsHost, theme, role, bounds) {
  const results = []
  const patch = centredRect(SAMPLES[role][0].rect(bounds), 160, 18)
  const surfaceRect = growRect(patch, SURFACE_OVERHANG, bounds)
  const text = TEXT[theme]
  const scored = {}
  for (const kind of ['float', 'dialog', 'tooltip', 'control']) {
    const computed = await showSurface(devtoolsHost, role, bounds, surfaceRect, kind, theme)
    await sleep(300)
    const surfaceMeans = {}
    for (const variant of BACKDROPS) {
      const { raised, file } = await shoot(smoke, theme, role, variant, `${kind}-`)
      surfaceMeans[variant] = regionAt(file, raised.bounds, patch).mean
    }
    scored[kind] = {
      computed,
      ...evaluateFloatPatch({ surfaceMeans, text, expected: parseCssColor(computed) })
    }
  }
  for (const kind of ['float', 'dialog', 'tooltip']) {
    results.push({
      theme,
      role,
      sample: `${kind}-patch`,
      metrics: {
        utility: SURFACE_TIERS[kind],
        computed: scored[kind].computed,
        ...scored[kind].metrics,
        ...(kind === 'float' ? { controlTone: scored.control.metrics.tone } : {})
      },
      checks: scored[kind].checks,
      pass: scored[kind].pass
    })
  }

  const textRect = await appTextRect(devtoolsHost, role, bounds)
  if (textRect) {
    await hideSurface(devtoolsHost, role)
    const under = await shoot(smoke, theme, role, 'photo', 'bleed-under-')
    const surfaceRect = growRect(textRect, SURFACE_OVERHANG, bounds)
    const sample = belowSheen(textRect, surfaceRect)
    await showSurface(devtoolsHost, role, bounds, surfaceRect, 'float', theme)
    const through = await shoot(smoke, theme, role, 'photo', 'bleed-through-')
    await showSurface(devtoolsHost, role, bounds, surfaceRect, 'leak', theme)
    const leak = await shoot(smoke, theme, role, 'photo', 'bleed-leak-')
    const bleed = evaluateFloatBleed({
      sharpnessUnder: regionAt(under.file, under.raised.bounds, sample).sharpness,
      sharpnessThrough: regionAt(through.file, through.raised.bounds, sample).sharpness
    })
    const leakSharpness = regionAt(leak.file, leak.raised.bounds, sample).sharpness
    results.push({
      theme,
      role,
      sample: 'float-bleed',
      ...bleed,
      metrics: { ...bleed.metrics, leakSharpnessThrough: round(leakSharpness) }
    })
  } else {
    results.push({
      theme,
      role,
      sample: 'float-bleed',
      metrics: {},
      checks: { textPresent: false },
      pass: false
    })
  }
  await hideSurface(devtoolsHost, role)
  return results
}

function round(value, digits = 2) {
  return Number(value.toFixed(digits))
}

function imageMean(file) {
  const image = decodePng(readFileSync(file))
  return regionMean(image, { x: 0, y: 0, width: image.width, height: image.height })
}

// One backdrop shot of the window with a reference patch of the bare
// backdrop beside it, captured in the same pass (plan 091).
async function shootWithReference(smoke, theme, role, variant, prefix = '') {
  const shot = await shoot(smoke, theme, role, variant, prefix)
  const reference = backdropReferenceRect(shot.raised.bounds, shot.raised.primaryWorkArea)
  if (!reference) {
    throw new InvalidGlassEvidenceError({
      role,
      phase: 'reference',
      status: 'INVALID',
      reason: 'controlled-reference-region-missing',
      ownerCategory: 'controlled-backdrop',
      intersection: null,
      timestamp: Date.now()
    })
  }
  const referenceShot = await captureGlassEvidence({
    role,
    raised: shot.raised,
    capture,
    name: `${prefix}${theme}-${role}-${variant}-reference`,
    readWindows: () => glassWindowReader(),
    referenceRect: reference,
    expectedOwnership: shot.ownership,
    recordValidity: (diagnostic) => glassValidity.samples.push(diagnostic)
  })
  return { ...shot, referenceMean: imageMean(referenceShot.file) }
}

function requireReference(shot, role, variant) {
  if (!shot.referenceMean) {
    throw new Error(
      `No bare backdrop beside the ${role} window for a ${variant} reference; shrink the window.`
    )
  }
  return shot.referenceMean
}

// neutrality (plan 091): the role's samples with the coats zeroed, against
// the backdrop reference, per backdrop. Null for a window without a page.
async function measureNeutrality(smoke, devtoolsHost, theme, role) {
  if (!(await setCoats(devtoolsHost, role, true))) return null
  await sleep(500)
  const samples = {}
  const references = {}
  try {
    for (const variant of NEUTRALITY_BACKDROPS) {
      const shot = await shootWithReference(smoke, theme, role, variant, 'neutral-')
      samples[variant] = measure(shot.file, shot.raised.bounds, role).map((sample) => sample.mean)
      references[variant] = requireReference(shot, role, variant)
    }
  } finally {
    await setCoats(devtoolsHost, role, false)
  }
  return SAMPLES[role].map((_sample, index) =>
    neutralityOf(
      Object.fromEntries(NEUTRALITY_BACKDROPS.map((variant) => [variant, samples[variant][index]])),
      references
    )
  )
}

// Plan 072's S0 question, re-asked under the clear glass and recorded only:
// does a bare CSS backdrop-filter over the sidebar rows reach the screen?
async function measureFrostBleed(smoke, devtoolsHost, theme, bounds) {
  const textRect = await appTextRect(devtoolsHost, 'main', bounds)
  if (!textRect) return null
  await hideSurface(devtoolsHost, 'main')
  const under = await shoot(smoke, theme, 'main', 'photo', 'frost-under-')
  const surfaceRect = growRect(textRect, SURFACE_OVERHANG, bounds)
  const sample = belowSheen(textRect, surfaceRect)
  await showSurface(devtoolsHost, 'main', bounds, surfaceRect, 'frost', theme)
  await sleep(500)
  const through = await shoot(smoke, theme, 'main', 'photo', 'frost-through-')
  await hideSurface(devtoolsHost, 'main')
  const sharpnessUnder = regionAt(under.file, under.raised.bounds, sample).sharpness
  const sharpnessThrough = regionAt(through.file, through.raised.bounds, sample).sharpness
  return {
    theme,
    role: 'main',
    sample: 'frost-bleed',
    metrics: {
      sharpnessUnder: round(sharpnessUnder),
      sharpnessThrough: round(sharpnessThrough),
      // Plan 072's bleed gate for floats is <= 0.5; a frost that reached the
      // screen would blur the rows to near that, as Chromium's own capture does.
      reachesScreen: sharpnessThrough <= 0.5
    },
    checks: {},
    pass: true
  }
}

// Plan 091 persistence matrix on the main window: nativeClear (and the red
// neutrality distance, coats zeroed) after every transition AppKit may
// rebuild the material through. Every step runs without activating the app
// except the focus cycle, which needs --allow-focus.
async function runPersistence(smoke, devtoolsHost, theme) {
  const rows = []
  const check = async (step, { capture: shoot_ = true, extra = {} } = {}) => {
    const state = await requestSmokeCommand(smoke, 'window-glass-state', { role: 'main' })
    const native = nativeClearCheck(state.effectViews, {
      blurRadius: GLASS_THRESHOLDS.clearBlurRadius
    })
    let neutralityRed = null
    if (shoot_) {
      const shot = await shootWithReference(smoke, theme, 'main', 'red', `persist-${step}-`)
      // A resize or a simple-fullscreen exit can leave no bare backdrop beside
      // the window: fail with the reference error, not a null dereference.
      const reference = requireReference(shot, 'main', 'red')
      neutralityRed = round(
        colorDistance(measure(shot.file, shot.raised.bounds, 'main')[0].mean, reference)
      )
    }
    const focus = await requestSmokeCommand(smoke, 'focused-window')
    rows.push({
      step,
      style: state.applied?.style ?? null,
      clear: native.clear,
      blurRadius: native.blurRadius,
      chameleonVisible: native.chameleonVisible,
      saturatePresent: native.saturatePresent,
      neutralityRed,
      mainFocused: focus.mainFocused,
      pass:
        native.pass && (neutralityRed === null || neutralityRed <= GLASS_THRESHOLDS.maxNeutrality),
      failures: native.failures,
      ...extra
    })
  }
  const other = theme === 'dark' ? 'light' : 'dark'
  await setCoats(devtoolsHost, 'main', true)
  await sleep(400)
  await check('baseline')

  if (allowFocus) {
    await requestSmokeCommand(smoke, 'raise-window', { role: 'main', focus: true })
    await sleep(700)
    await requestSmokeCommand(smoke, 'main-window-blur')
    await sleep(700)
    await requestSmokeCommand(smoke, 'raise-window', { role: 'main', focus: false })
    await check('focus-cycle')
  } else {
    rows.push({
      step: 'focus-cycle',
      skipped: 'needs --allow-focus (takes the user focus for ~1 s)'
    })
  }

  await applyTheme(devtoolsHost, other)
  await setCoats(devtoolsHost, 'main', true)
  await sleep(400)
  await check(`theme-${other}`)
  await applyTheme(devtoolsHost, theme)
  await setCoats(devtoolsHost, 'main', true)
  await sleep(400)
  await check(`theme-${theme}`)

  // resize-window and move-window only setSize/setPosition; main-window-set-bounds
  // also calls show(), which asks AppKit to activate the app.
  const { bounds } = await requestSmokeCommand(smoke, 'raise-window', {
    role: 'main',
    focus: false
  })
  const restoreBounds = async () => {
    await requestSmokeCommand(smoke, 'resize-window', {
      width: bounds.width,
      height: bounds.height
    })
    await requestSmokeCommand(smoke, 'move-window', { x: bounds.x, y: bounds.y })
    await requestSmokeCommand(smoke, 'raise-window', { role: 'main', focus: false })
    await sleep(700)
  }
  await requestSmokeCommand(smoke, 'resize-window', {
    width: bounds.width - 60,
    height: bounds.height - 40
  })
  await sleep(700)
  await check('resize-smaller')
  await restoreBounds()
  await check('resize-restored')

  await requestSmokeCommand(smoke, 'main-window-simple-fullscreen', { enabled: true })
  await sleep(1500)
  await check('simple-fullscreen-in', { capture: false })
  await requestSmokeCommand(smoke, 'main-window-simple-fullscreen', { enabled: false })
  await sleep(1500)
  await restoreBounds()
  await check('simple-fullscreen-out')

  // deminiaturize: activates the app whatever the caller asks, so this pair
  // takes the user's focus too (measured 2026-10-02: mainFocused flips true).
  if (allowFocus) {
    await requestSmokeCommand(smoke, 'minimize-window')
    await sleep(1200)
    await check('minimized', { capture: false })
    await requestSmokeCommand(smoke, 'restore-window', { focus: false })
    await sleep(1200)
    await requestSmokeCommand(smoke, 'raise-window', { role: 'main', focus: false })
    await sleep(500)
    await check('restored')
  } else {
    rows.push({
      step: 'minimize-restore',
      skipped: 'needs --allow-focus (deminiaturize activates the app)'
    })
  }

  await requestSmokeCommand(smoke, 'set-vibrancy', { role: 'main', material: null })
  await sleep(400)
  const recreated = await requestSmokeCommand(smoke, 'set-vibrancy', {
    role: 'main',
    material: 'under-window'
  })
  await sleep(800)
  await check('set-vibrancy-recreate', { extra: { restyle: recreated.style ?? null } })
  const healed = await requestSmokeCommand(smoke, 'heal-main-window', { lever: 'revibrancy' })
  await sleep(800)
  await check('revibrancy', { extra: { restyle: healed.style ?? null } })

  await setCoats(devtoolsHost, 'main', false)
  return { rows, layerTrees: { before: recreated.before ?? null, after: recreated.after ?? null } }
}

function evaluate(theme, role, shots, glassState, pageDark, neutrality, parity = {}) {
  const results = []
  const byName = (variant) => shots[variant]
  const styleRequested = glassState?.styleRequested ?? 'material'
  const native = nativeClearCheck(glassState?.effectViews, {
    blurRadius: GLASS_THRESHOLDS.clearBlurRadius
  })
  for (const [index, sample] of SAMPLES[role].entries()) {
    const at = (variant) => byName(variant)[index]
    const coats = parity.coats?.[sample.name] ?? null
    const ghostex =
      coats && parity.references?.white && parity.references?.black
        ? parityOf({
            sampleMeans: { white: at('white').mean, black: at('black').mean },
            referenceMeans: { white: parity.references.white, black: parity.references.black },
            coats
          })
        : null
    const transmission = colorDistance(at('red').mean, at('blue').mean)
    const sharpness = at('text').sharpness
    const text = TEXT[PINNED_DARK_ROLES.has(role) ? 'dark' : theme]
    const backgrounds = [at('white').mean, at('black').mean]
    const primaryContrast = Math.min(...backgrounds.map((bg) => contrastRatio(text.primary, bg)))
    const secondaryContrast = Math.min(
      ...backgrounds.map((bg) => contrastRatio(text.secondary, bg))
    )
    const whiteLuminance = relativeLuminance(at('white').mean)
    const checks = {
      transmission: transmission >= GLASS_THRESHOLDS.minTransmission,
      sharpness: sharpness <= GLASS_THRESHOLDS.maxSharpness,
      primaryContrast: primaryContrast >= GLASS_THRESHOLDS.minPrimaryContrast,
      secondaryContrast: secondaryContrast >= GLASS_THRESHOLDS.minSecondaryContrast
    }
    if (theme === 'light' && PINNED_DARK_ROLES.has(role)) {
      checks.pinnedDark = whiteLuminance <= GLASS_THRESHOLDS.maxPinnedLuminance
    }
    if (role !== 'main' && !PINNED_DARK_ROLES.has(role)) {
      checks.followsTheme = pageDark === (theme === 'dark')
    }
    const effectViews = glassState?.effectViews ?? []
    checks.native = effectViews.length > 0 && effectViews.every((view) => view.state === 'active')
    const neutral = neutrality?.[index] ?? null
    // Plan 091: gated on the style the app was asked for, so a strip that
    // failed to apply (the app then keeps the material) fails the run.
    if (styleRequested === 'clear') {
      checks.nativeClear = native.pass
      if (neutral) checks.neutrality = neutral.max <= GLASS_THRESHOLDS.maxNeutrality
      if (ghostex) checks.parity = ghostex.max <= GLASS_THRESHOLDS.maxParity
    }
    results.push({
      theme,
      role,
      sample: sample.name,
      metrics: {
        glass: glassState?.applied?.mode?.kind ?? 'unknown',
        style: glassState?.applied?.style ?? null,
        transmission: round(transmission),
        sharpness: round(sharpness),
        primaryContrast: round(primaryContrast),
        secondaryContrast: round(secondaryContrast),
        whiteLuminance: round(whiteLuminance, 4),
        ...(neutral
          ? {
              neutrality: round(neutral.max),
              neutralityBy: Object.fromEntries(
                Object.entries(neutral.byBackdrop).map(([variant, value]) => [
                  variant,
                  round(value)
                ])
              )
            }
          : {}),
        ...(ghostex
          ? {
              parity: round(ghostex.max),
              parityBy: {
                white: round(ghostex.byBackdrop.white),
                black: round(ghostex.byBackdrop.black)
              },
              cover: round(ghostex.cover, 4),
              lightness: Object.fromEntries(
                Object.entries(ghostex.lightness).map(([variant, value]) => [
                  variant,
                  { measured: round(value.measured, 3), expected: round(value.expected, 3) }
                ])
              )
            }
          : {}),
        nativeClear: native.pass,
        blurRadius: native.blurRadius
      },
      checks,
      pass: Object.values(checks).every(Boolean)
    })
  }
  return results
}

// Instantaneous WindowServer CPU (top samples; ps reports a decaying average
// that would still carry the capture burst). Read-only: never signalled.
function sampleWindowServerCpu(samples = 12) {
  const rows = execFileSync('ps', ['-Ao', 'pid=,comm='], { encoding: 'utf8' }).split('\n')
  const pid = rows
    .map((line) => line.trim().split(/\s+/))
    .find(([, command]) => /(^|\/)WindowServer$/.test(command ?? ''))?.[0]
  if (!pid) return null
  const output = execFileSync(
    'top',
    ['-l', String(samples + 1), '-s', '1', '-pid', pid, '-stats', 'pid,cpu'],
    { encoding: 'utf8' }
  )
  const readings = output
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter(([rowPid]) => rowPid === pid)
    .map(([, cpu]) => Number(cpu))
    .slice(1)
  if (!readings.length) return null
  return round(readings.reduce((sum, value) => sum + value, 0) / readings.length, 1)
}

function writeContactSheet(files) {
  try {
    const sheet = join(outputDir, 'contact-sheet.png')
    const argsList = ['montage', ...files.flatMap(({ file, label }) => ['-label', label, file])]
    argsList.push('-tile', '3x', '-geometry', '640x420+10+10', '-background', '#e9e9ec', sheet)
    execFileSync('magick', argsList, { stdio: 'ignore' })
    return sheet
  } catch {
    return null
  }
}

async function main() {
  const userDataDir = mkdtempSync(join(tmpdir(), 'videorc-ui-glass-profile-'))
  let devtoolsUrl = null
  const launched = await launchDevApp({
    requiredMarkers: ['backend-ready', 'preview-motion-ready'],
    timeoutMs: Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 540_000),
    env: {
      VIDEORC_SMOKE_PREVIEW_MOTION: '1',
      VIDEORC_SMOKE_GLASS_PROBE_NOTES_VISIBLE: '1',
      VIDEORC_USER_DATA_DIR: userDataDir,
      VIDEORC_DATABASE_PATH: join(userDataDir, 'videorc.sqlite3'),
      VIDEORC_REMOTE_DEBUG_PORT: '0',
      ...extraAppEnv
    },
    onLine: (line) => {
      const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(line)
      if (match) devtoolsUrl = match[1]
    }
  })
  const smoke = launched.connections['preview-motion-ready']
  let report = {
    thresholds: GLASS_THRESHOLDS,
    floatThresholds: surfaces ? FLOAT_GLASS_THRESHOLDS : undefined,
    extraAppEnv,
    style,
    styleRequested: null,
    results: [],
    effectViews: {},
    coats: {},
    persistence: null,
    layerTrees: null,
    windowServerCpu: null,
    validity: { status: 'VALID', samples: [] }
  }
  glassValidity = report.validity
  const looks = []
  try {
    if (!devtoolsUrl) throw new Error('No DevTools endpoint observed (VIDEORC_REMOTE_DEBUG_PORT).')
    glassWindowReader = createGlassWindowReader(outputDir)
    const devtoolsHost = new URL(devtoolsUrl.replace('ws://', 'http://')).host
    await sleep(6000)
    for (const role of roles) {
      if (OPEN_COMMAND[role]) {
        await requestSmokeCommand(smoke, OPEN_COMMAND[role], {}, { timeoutMs: 20_000 })
      }
    }
    await sleep(2500)
    for (const [index, role] of roles.entries()) {
      await placeOnPrimaryDisplay(smoke, role, index)
    }

    for (const theme of themes) {
      await applyTheme(devtoolsHost, theme)
      for (const role of roles) {
        await assertTheme(devtoolsHost, theme)
        const shots = {}
        const files = {}
        let bounds = null
        const references = {}
        for (const variant of BACKDROPS) {
          const { raised, file, referenceMean } = await shootWithReference(
            smoke,
            theme,
            role,
            variant
          )
          shots[variant] = measure(file, raised.bounds, role)
          files[variant] = file
          bounds = raised.bounds
          references[variant] = referenceMean
        }
        await assertTheme(devtoolsHost, theme)
        const look = await shoot(smoke, theme, role, 'photo')
        looks.push({ file: look.file, label: `${theme} · ${role}` })
        const glassState = await requestSmokeCommand(smoke, 'window-glass-state', { role })
        report.effectViews[`${theme}-${role}`] = glassState.effectViews ?? null
        report.styleRequested = glassState.styleRequested ?? null
        const pageDark = await pageDarkClass(devtoolsHost, role)
        const coatsRead = await readCoats(devtoolsHost, role)
        if (coatsRead) report.coats[`${theme}-${role}`] = coatsRead.computed
        const neutrality = await measureNeutrality(smoke, devtoolsHost, theme, role)
        await assertTheme(devtoolsHost, theme)
        report.results.push(
          ...evaluate(theme, role, shots, glassState, pageDark, neutrality, {
            references,
            coats: coatsRead?.coats ?? null
          })
        )
        if (frostCheck && role === 'main') {
          const frost = await measureFrostBleed(smoke, devtoolsHost, theme, bounds)
          if (frost) report.results.push(frost)
        }
        if (surfaces && SURFACE_ROLES.has(role)) {
          report.results.push(...(await measureSurfaces(smoke, devtoolsHost, theme, role, bounds)))
          await showSurface(
            devtoolsHost,
            role,
            bounds,
            growRect(centredRect(SAMPLES[role][0].rect(bounds), 160, 18), 60, bounds),
            'float',
            theme
          )
          const surfaceLook = await shoot(smoke, theme, role, 'photo', 'float-look-')
          looks.push({ file: surfaceLook.file, label: `${theme} · ${role} · glass-float` })
          await hideSurface(devtoolsHost, role)
        }
      }
    }
    if (persistence && roles.includes('main')) {
      const theme = themes[themes.length - 1]
      await assertTheme(devtoolsHost, theme)
      const walked = await runPersistence(smoke, devtoolsHost, theme)
      report.persistence = walked.rows
      report.layerTrees = walked.layerTrees
    }
    await requestSmokeCommand(smoke, 'close-backdrop-window')
    // Let the capture burst settle before measuring the steady state.
    await sleep(20_000)
    report.windowServerCpu = sampleWindowServerCpu()
  } catch (error) {
    report.validity.status = 'INVALID'
    const diagnostic =
      error instanceof InvalidGlassEvidenceError
        ? error.diagnostic
        : {
            role: 'probe',
            phase: 'run',
            status: 'INVALID',
            reason: 'probe-incomplete',
            ownerCategory: 'unknown',
            intersection: null,
            timestamp: Date.now()
          }
    if (!report.validity.samples.includes(diagnostic)) report.validity.samples.push(diagnostic)
  } finally {
    try {
      await launched.stop()
    } catch {
      report.validity.status = 'INVALID'
      report.validity.samples.push({
        role: 'probe',
        phase: 'teardown',
        status: 'INVALID',
        reason: 'owned-teardown-failed',
        ownerCategory: 'unknown',
        intersection: null,
        timestamp: Date.now()
      })
    }
  }

  const persistenceGated = (report.styleRequested ?? style) === 'clear'
  const outcome = finalizeGlassEvidence(report, { gate, persistenceGated })
  report = outcome.report
  report.contactSheet = writeContactSheet(looks)
  report.outputDir = outputDir
  writeFileSync(join(outputDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)

  for (const result of report.results) {
    const failed = Object.entries(result.checks)
      .filter(([, ok]) => !ok)
      .map(([name]) => name)
    console.log(
      `${result.status} ${result.theme.padEnd(5)} ${result.role.padEnd(8)} ${result.sample.padEnd(15)} ${outcome.status === 'INVALID' ? '(unscored evidence)' : JSON.stringify(result.metrics)}${failed.length ? ` failed=${failed.join(',')}` : ''}`
    )
  }
  let persistenceFailures = 0
  for (const row of report.persistence ?? []) {
    if (row.skipped) {
      console.log(`SKIP  persistence ${row.step.padEnd(22)} ${row.skipped}`)
      continue
    }
    if (!row.pass) persistenceFailures += 1
    console.log(
      `${row.status ?? (row.pass ? 'PASS' : 'FAIL')} persistence ${row.step.padEnd(22)} ${outcome.status === 'INVALID' ? '(unscored evidence)' : JSON.stringify(row)}`
    )
  }
  console.log(`WindowServer CPU (idle, preview presenting): ${report.windowServerCpu ?? 'n/a'}%`)
  console.log(`report: ${join(outputDir, 'report.json')}`)
  if (report.contactSheet) console.log(`contact sheet: ${report.contactSheet}`)
  if (outcome.status === 'INVALID') {
    for (const diagnostic of report.validity.samples.filter(
      (sample) => sample.status === 'INVALID'
    )) {
      console.error(`INVALID capture: ${JSON.stringify(diagnostic)}`)
    }
    console.error(
      'probe:ui-glass INVALID: no material or contrast verdict. If a system dialog overlaps the probe, the operator must dismiss it before a fresh run.'
    )
    process.exitCode = 1
    return
  }
  // The persistence rows gate only a clear-glass run: under the material
  // style they report what the walk did to a plain view.
  if (outcome.exitCode) {
    console.error(
      `probe:ui-glass FAILED: ${outcome.failures} sample(s) outside the glass thresholds` +
        (persistenceGated && persistenceFailures
          ? `, ${persistenceFailures} persistence step(s) lost the clear glass.`
          : '.')
    )
    process.exit(1)
  }
  console.log(gate ? 'probe:ui-glass PASSED' : 'probe:ui-glass report complete (report mode).')
}

main().catch((error) => {
  console.error(`probe:ui-glass error: ${error?.stack ?? error}`)
  process.exit(1)
})
