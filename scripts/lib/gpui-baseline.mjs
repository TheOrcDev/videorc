/**
 * Plan 260 (from plan 220 S3.0b): the per-screen diff checker. It pairs the
 * GPUI app's shots of a screen with the Electron baseline that S0.10 archived
 * (`docs/gpui/baseline-manifest.json`, the PNGs in `~/videorc-gpui-baseline/`):
 * for every manifest entry of the screen it writes, under `<out>/<screen>/`,
 *
 *   <stem>.electron.png   the baseline
 *   <stem>.gpui.png       the GPUI app's shot
 *   <stem>.pair.png       the two side by side, and where they differ (red)
 *
 * and `report.json`: per entry the pixel report (information, never a gate:
 * the gate is the eye on every pair), and every entry with no GPUI shot, or
 * whose baseline is missing or changed, with the reason. Nothing is skipped
 * silently.
 *
 * A GPUI shot is found as `<shots>/<screen>/<stem>.png` or `<shots>/<stem>.png`,
 * where `<stem>` is the baseline's name (`idle-1280x800-dark-contrast`).
 * Shooting the GPUI app is the screen slices' part (the UI driver, S2.5); this
 * module only reads files, so it runs before the app exists.
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { pairOf, shotStem } from './gpui-compare.mjs'

/** `~/x` → `/Users/me/x`. */
export function expandHome(path) {
  return String(path).replace(/^~(?=$|\/)/, homedir())
}

/** The manifest, checked for the fields the checker reads. */
export function readManifest(file) {
  const manifest = JSON.parse(readFileSync(file, 'utf8'))
  if (!Array.isArray(manifest.entries) || typeof manifest.folder !== 'string') {
    throw new Error(`${file} is not a baseline manifest (no entries or folder).`)
  }
  return manifest
}

/** Screen ids with their entry counts, in manifest order. */
export function screensOf(manifest) {
  const counts = new Map()
  for (const entry of manifest.entries)
    counts.set(entry.screen, (counts.get(entry.screen) ?? 0) + 1)
  return [...counts].map(([screen, entries]) => ({ screen, entries }))
}

/** The entries of one screen, each with its stem. Throws naming the known screens. */
export function entriesOf(manifest, screen) {
  const entries = manifest.entries
    .filter((entry) => entry.screen === screen)
    .map((entry) => ({ ...entry, stem: shotStem(entry) }))
  if (entries.length === 0) {
    const known = screensOf(manifest).map((row) => row.screen)
    throw new Error(`No baseline screen "${screen}". Known: ${known.join(', ')}.`)
  }
  return entries
}

function findShot(shotsDir, screen, stem) {
  for (const candidate of [join(shotsDir, screen, `${stem}.png`), join(shotsDir, `${stem}.png`)]) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Pairs every entry of `screen` and writes the pictures and `report.json`
 * under `<outDir>/<screen>/`. Returns the report.
 */
export function compareScreen({ manifest, screen, baselineDir, shotsDir, outDir, slice }) {
  const baselineRoot = expandHome(baselineDir ?? manifest.folder)
  const target = join(outDir, screen)
  mkdirSync(target, { recursive: true })
  const paired = []
  const unpaired = []
  for (const entry of entriesOf(manifest, screen)) {
    const baselineFile = join(baselineRoot, entry.path)
    if (!existsSync(baselineFile)) {
      unpaired.push({ stem: entry.stem, reason: `baseline missing: ${baselineFile}` })
      continue
    }
    const baselineBytes = readFileSync(baselineFile)
    const sha256 = createHash('sha256').update(baselineBytes).digest('hex')
    if (entry.sha256 && sha256 !== entry.sha256) {
      unpaired.push({
        stem: entry.stem,
        reason: `baseline changed since the manifest: ${baselineFile}`
      })
      continue
    }
    const shot = findShot(shotsDir, screen, entry.stem)
    if (!shot) {
      unpaired.push({ stem: entry.stem, reason: 'no GPUI shot' })
      continue
    }
    const { report, png } = pairOf(baselineBytes, readFileSync(shot))
    copyFileSync(baselineFile, join(target, `${entry.stem}.electron.png`))
    copyFileSync(shot, join(target, `${entry.stem}.gpui.png`))
    writeFileSync(join(target, `${entry.stem}.pair.png`), png)
    paired.push({ stem: entry.stem, ...report })
  }
  const report = {
    screen,
    slice: slice ?? 'adhoc',
    baseline: {
      folder: baselineRoot,
      appCommit: manifest.appCommit ?? null,
      date: manifest.date ?? null
    },
    shots: shotsDir,
    paired,
    unpaired
  }
  writeFileSync(join(target, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  return report
}
