/**
 * The baseline manifest (plan 220 S0.1a, step 5): names, entries and the
 * committed `docs/gpui/baseline-manifest.json`. The PNGs live outside the
 * repository (`~/videorc-gpui-baseline/<date>/`); the manifest is what the
 * Rust app's shooter (`scripts/rust-ui-baseline.mjs`, S3.0b) reads: it shoots
 * every entry of a screen from the Rust app, at the entry's size, in the
 * entry's look, and writes the pair beside the baseline.
 *
 * An entry is `{screen, state, theme, contrast, width, height, path, bytes,
 * sha256, appCommit}`. `contrast` is `'more'` for Increase Contrast and
 * `'normal'` otherwise; `path` is relative to the baseline folder and is
 * `<screen>/<state>-<width>x<height>-<theme>[-contrast].png`. A screen the run
 * could not open is a `missing` entry with its reason.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** The screen ids Phase 3 slices reference (plan 220 S0.1a's step 5, updated for plan 260 S0.10). */
export const BASELINE_SCREEN_IDS = Object.freeze([
  'shell',
  'toasts',
  'account-menu',
  'health',
  'studio',
  'studio-retro',
  'stream-manager',
  'scene',
  'sources',
  'livestream-setup',
  'livestream-upcoming',
  'livestream-discord',
  'go-live',
  'output',
  'library',
  'library-player',
  'assets',
  'sounds',
  'captions',
  'captions-reader',
  'notes',
  'avatar-profile',
  'avatar-greetings',
  'buddy-overview',
  'buddy-chat',
  'buddy-community',
  'buddy-voice',
  'buddy-reports',
  'buddy-clean-cut',
  'buddy-pet-creator',
  'buddy-onboarding',
  'settings-general',
  'settings-permissions',
  'settings-shortcuts',
  'settings-remote',
  'settings-about',
  'palette',
  'first-run'
])

export const BASELINE_THEMES = Object.freeze(['dark', 'light'])

/** The looks: dark, light, and Increase Contrast over each. */
export const BASELINE_LOOKS = Object.freeze([
  Object.freeze({ theme: 'dark', contrast: 'normal' }),
  Object.freeze({ theme: 'light', contrast: 'normal' }),
  Object.freeze({ theme: 'dark', contrast: 'more' }),
  Object.freeze({ theme: 'light', contrast: 'more' })
])

/** The Stream Manager's four width bands (plan 220's S0.1a step 3). */
export const STREAM_MANAGER_SIZES = Object.freeze([
  Object.freeze({ width: 420, height: 640 }),
  Object.freeze({ width: 700, height: 640 }),
  Object.freeze({ width: 900, height: 640 }),
  Object.freeze({ width: 1100, height: 700 })
])

/** How the shots were taken, for whoever compares against them. */
export const BASELINE_NOTES = Object.freeze([
  'Pages and page tabs are shot at 960x660, 1100x720 and 1280x800; menus, dialogs, the palette, toasts, Retro LCD, Chat in Studio, the live states and first run at 1280x800; the Stream Manager at 420x640, 700x640, 900x640 and 1100x700; Captions and Notes at their default frames. Sizes are CSS pixels: the PNGs are 2x.',
  'Increase Contrast (prefers-contrast: more, by CDP media emulation) is shot over both themes. Every shot is Page.captureScreenshot of the window page, so the native window frame and traffic lights are not in it.',
  'The profile is the test pattern with the camera and the microphone off, the Demo scene working, and three saved scenes: Talking head and Side by side need a camera, so they read "Resolve sources". The clips ring is off. Destinations hold fake keys; the on-air shot streams only to a local RTMP sink.',
  'Not fixed between runs: Library session names, dates and thumbnails (two real 3 s test-pattern recordings), the Schedule dialog clock, the recording and on-air timers, and any host notice the app raises.',
  'Buddy "unlocked" is the signed-in run: the dev-only mock session served by a local fake (no real account), so Buddy library rows read "not available right now". "Locked" is the signed-out run.',
  'First run is shot with prefers-reduced-motion so the backdrop holds still, from a profile that holds only the first-run record.',
  'Plan 260 S0.10: the app is the dev build (electron-vite dev renderer) of main, whose app code is unchanged since 0.37.1; appCommit is that tree plus the shooter. The backend is the release profile for the idle, windows, live and first-run parts, and the debug profile for the signed-in buddy part (the mock account is debug-only). The Library player is the Markers dialog (row menu, Markers).'
])

const SAFE_ID = /^[a-z0-9][a-z0-9-]*$/

/** `idle-1280x800-dark-contrast.png` */
export function shotFileName({ state, width, height, theme, contrast }) {
  if (!SAFE_ID.test(state)) throw new Error(`Not a state id: ${state}`)
  if (!BASELINE_THEMES.includes(theme)) throw new Error(`Not a theme: ${theme}`)
  if (contrast !== 'normal' && contrast !== 'more') throw new Error(`Not a contrast: ${contrast}`)
  if (!Number.isInteger(width) || !Number.isInteger(height)) {
    throw new Error(`Not a size: ${width}x${height}`)
  }
  return `${state}-${width}x${height}-${theme}${contrast === 'more' ? '-contrast' : ''}.png`
}

/** `studio/idle-1280x800-dark.png`, the path under the baseline folder. */
export function shotPath(shot) {
  if (!SAFE_ID.test(shot.screen)) throw new Error(`Not a screen id: ${shot.screen}`)
  return `${shot.screen}/${shotFileName(shot)}`
}

export function sha256OfFile(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** One entry for a shot written to `<folder>/<path>`. */
export function manifestEntry(folder, shot, appCommit) {
  const path = shotPath(shot)
  const file = join(folder, path)
  return {
    screen: shot.screen,
    state: shot.state,
    theme: shot.theme,
    contrast: shot.contrast,
    width: shot.width,
    height: shot.height,
    path,
    bytes: statSync(file).size,
    sha256: sha256OfFile(file),
    appCommit
  }
}

const entryKey = (entry) =>
  [entry.screen, entry.state, entry.theme, entry.contrast, entry.width, entry.height].join('|')

/**
 * The manifest from the shots a run logged (`entries`, one per shot, the last
 * one for a key wins) and the screens it could not open (`missing`, one per
 * screen and state, the last wins; a screen with a shot is never missing).
 * Every screen id with neither is listed as missing, "not attempted".
 */
export function buildManifest({ entries, missing, appCommit, date, host }) {
  const byKey = new Map()
  for (const entry of entries) byKey.set(entryKey(entry), entry)
  const shots = [...byKey.values()].sort((a, b) => a.path.localeCompare(b.path))
  const shotStates = new Set(shots.map((entry) => `${entry.screen}/${entry.state}`))
  const shotScreens = new Set(shots.map((entry) => entry.screen))
  const missingByKey = new Map()
  for (const item of missing) {
    if (shotStates.has(`${item.screen}/${item.state}`)) continue
    missingByKey.set(`${item.screen}/${item.state}`, item)
  }
  const listed = [...missingByKey.values()].sort((a, b) =>
    `${a.screen}/${a.state}`.localeCompare(`${b.screen}/${b.state}`)
  )
  for (const screen of BASELINE_SCREEN_IDS) {
    if (!shotScreens.has(screen) && !listed.some((item) => item.screen === screen)) {
      listed.push({ screen, state: '*', reason: 'not attempted' })
    }
  }
  return {
    version: 1,
    plan: 'plans/260-gpui-rewrite.md S0.10',
    app: 'Electron app of this repository (apps/desktop), dev build, isolated profile',
    appCommit,
    date,
    host,
    folder: `~/videorc-gpui-baseline/${date}/`,
    screens: [...BASELINE_SCREEN_IDS],
    looks: BASELINE_LOOKS.map((look) => ({ ...look })),
    notes: BASELINE_NOTES,
    entries: shots,
    missing: listed
  }
}

/**
 * What is wrong with a manifest against the folder it points at: a file that
 * is gone, a size or SHA-256 that changed, a screen with neither an entry nor
 * a missing line, and a screen shot in fewer looks than the others.
 */
export function manifestProblems(manifest, folder) {
  const problems = []
  for (const entry of manifest.entries) {
    let bytes
    try {
      bytes = statSync(join(folder, entry.path)).size
    } catch {
      problems.push(`${entry.path}: the file is gone`)
      continue
    }
    if (bytes !== entry.bytes)
      problems.push(`${entry.path}: ${bytes} bytes, manifest says ${entry.bytes}`)
    if (sha256OfFile(join(folder, entry.path)) !== entry.sha256) {
      problems.push(`${entry.path}: SHA-256 differs from the manifest`)
    }
  }
  const shot = new Set(manifest.entries.map((entry) => entry.screen))
  const missing = new Set(manifest.missing.map((item) => item.screen))
  for (const screen of manifest.screens) {
    if (!shot.has(screen) && !missing.has(screen)) {
      problems.push(`${screen}: neither an entry nor a missing line`)
    }
  }
  const lookKeys = (entries) => new Set(entries.map((entry) => `${entry.theme}/${entry.contrast}`))
  for (const screen of shot) {
    const looks = lookKeys(manifest.entries.filter((entry) => entry.screen === screen))
    if (looks.size < BASELINE_LOOKS.length) {
      const absent = BASELINE_LOOKS.map((look) => `${look.theme}/${look.contrast}`).filter(
        (key) => !looks.has(key)
      )
      problems.push(`${screen}: no entry in ${absent.join(', ')}`)
    }
  }
  return problems
}

const readLines = (file) =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : []

/** The manifest from the logs a baseline run left in `folder`. */
export function manifestFromFolder(folder, { appCommit, date, host }) {
  return buildManifest({
    entries: readLines(join(folder, 'entries.jsonl')),
    missing: readLines(join(folder, 'missing.jsonl')),
    appCommit,
    date,
    host
  })
}
