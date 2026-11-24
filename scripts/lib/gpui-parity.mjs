/**
 * Plan 260: keeps `docs/gpui/parity.md` (S0.11) honest while screen slices
 * tick it. `parseParity` reads its lines; `checkParity` names every problem:
 * a malformed row, a duplicate or out-of-order ID, a cell that is not one of
 * the list's words, a Counts table that no longer matches the rows, and a
 * Source that names a file Electron no longer has (drift: the line needs a
 * look). `parityStats` counts what is done per area and platform.
 */
import { existsSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'

export const PLATFORMS = Object.freeze(['macos', 'windows', 'linux'])
/** The cell words (`docs/gpui/parity.md`, "How to read it"). */
export const CELLS = Object.freeze(['[ ]', '[x]', 'n/a', 'dev', 'removed'])
/** Cells that are a line on that platform (to do or done). */
const APPLIES = new Set(['[ ]', '[x]'])

const splitRow = (line) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim())

/** `{ controls, windowsOnly, counts, areas }` from the markdown. */
export function parseParity(markdown) {
  const controls = []
  const windowsOnly = []
  const counts = {}
  let area = null
  let section = null
  markdown.split('\n').forEach((line, index) => {
    const lineNumber = index + 1
    const h2 = /^## (.+)$/.exec(line)
    if (h2) area = h2[1].trim()
    const h3 = /^### (.+)$/.exec(line)
    if (h3) section = h3[1].trim()
    if (h2) section = null
    if (/^\| P\d/.test(line)) {
      const cells = splitRow(line)
      controls.push({
        id: cells[0],
        control: cells[1],
        what: cells[2],
        source: cells[3],
        platforms: { macos: cells[4], windows: cells[5], linux: cells[6] },
        width: cells.length,
        area,
        section,
        lineNumber
      })
    } else if (/^\| W\d/.test(line)) {
      const cells = splitRow(line)
      windowsOnly.push({
        id: cells[0],
        text: cells[1],
        windows: cells[2],
        width: cells.length,
        lineNumber
      })
    } else if (/^\| (Controls \(P lines\)|Windows-only lines \(W lines\)) \|/.test(line)) {
      const cells = splitRow(line)
      const number = (value) => (value === '' ? null : Number(value.replace(/,/g, '')))
      counts[cells[0].startsWith('Controls') ? 'controls' : 'windowsOnly'] = {
        lines: number(cells[1]),
        macos: number(cells[2]),
        windows: number(cells[3]),
        linux: number(cells[4]),
        lineNumber
      }
    }
  })
  return { controls, windowsOnly, counts }
}

/** The file paths a Source cell cites (`renderer/x.tsx:12; y.ts:3` → both). */
export function sourcePaths(source) {
  return [
    ...String(source).matchAll(/([A-Za-z0-9_@./-]+\.(?:tsx|ts|mjs|js|rs|json|css|html))(?::\d+)?/g)
  ].map((match) => match[1])
}

/** `PLATFORM_ROOTS` the Source column is relative to, by its leading folder. */
function sourceCandidates(repoRoot, path, siblingDir) {
  const desktop = join(repoRoot, 'apps', 'desktop', 'src')
  const out = []
  if (path.startsWith('renderer/'))
    out.push(join(desktop, 'renderer', 'src', path.slice('renderer/'.length)))
  out.push(join(desktop, path), join(repoRoot, path))
  if (siblingDir && !path.includes('/')) out.push(join(siblingDir, path))
  return out
}

function basenameIndex(repoRoot) {
  const index = new Map()
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else index.set(entry.name, [...(index.get(entry.name) ?? []), path])
    }
  }
  for (const root of [join(repoRoot, 'apps', 'desktop', 'src'), join(repoRoot, 'crates')]) {
    if (existsSync(root)) walk(root)
  }
  return index
}

/** Every problem in the list, as `{ line, id?, problem }`; empty when it holds. */
export function checkParity(parsed, { repoRoot, checkSources = true } = {}) {
  const problems = []
  const add = (lineNumber, id, problem) => problems.push({ line: lineNumber, id, problem })
  let last = 0
  const seen = new Set()
  for (const row of parsed.controls) {
    if (row.width !== 7) add(row.lineNumber, row.id, `has ${row.width} cells, not 7`)
    const number = Number(/^P(\d+)$/.exec(row.id)?.[1] ?? NaN)
    if (!Number.isInteger(number)) add(row.lineNumber, row.id, 'is not a P<number> id')
    else if (seen.has(row.id)) add(row.lineNumber, row.id, 'is a duplicate id')
    else if (number <= last)
      add(row.lineNumber, row.id, `comes after P${String(last).padStart(3, '0')}`)
    seen.add(row.id)
    if (Number.isInteger(number) && number > last) last = number
    for (const platform of PLATFORMS) {
      const cell = row.platforms[platform]
      if (!CELLS.includes(cell))
        add(
          row.lineNumber,
          row.id,
          `${platform} cell ${JSON.stringify(cell)} is not one of ${CELLS.join(', ')}`
        )
    }
  }
  const wSeen = new Set()
  for (const row of parsed.windowsOnly) {
    if (row.width !== 3) add(row.lineNumber, row.id, `has ${row.width} cells, not 3`)
    if (wSeen.has(row.id)) add(row.lineNumber, row.id, 'is a duplicate id')
    wSeen.add(row.id)
    if (!CELLS.includes(row.windows))
      add(
        row.lineNumber,
        row.id,
        `windows cell ${JSON.stringify(row.windows)} is not one of ${CELLS.join(', ')}`
      )
  }
  const expected = {
    controls: {
      lines: parsed.controls.length,
      ...Object.fromEntries(
        PLATFORMS.map((p) => [
          p,
          parsed.controls.filter((row) => APPLIES.has(row.platforms[p])).length
        ])
      )
    },
    windowsOnly: {
      lines: parsed.windowsOnly.length,
      macos: null,
      windows: parsed.windowsOnly.filter((row) => APPLIES.has(row.windows)).length,
      linux: null
    }
  }
  for (const [kind, want] of Object.entries(expected)) {
    const have = parsed.counts[kind]
    if (!have) {
      add(
        null,
        null,
        `the Counts table has no ${kind === 'controls' ? 'Controls' : 'Windows-only lines'} row`
      )
      continue
    }
    for (const key of ['lines', ...PLATFORMS]) {
      if (have[key] !== want[key]) {
        add(
          have.lineNumber,
          null,
          `Counts ${kind} ${key} says ${have[key]}, the rows say ${want[key]}`
        )
      }
    }
  }
  if (checkSources && repoRoot) {
    const index = basenameIndex(repoRoot)
    for (const row of parsed.controls) {
      const paths = sourcePaths(row.source)
      if (paths.length === 0) {
        add(row.lineNumber, row.id, 'names no source file')
        continue
      }
      let sibling = null
      for (const path of paths) {
        const found =
          sourceCandidates(repoRoot, path, sibling).find((candidate) => existsSync(candidate)) ??
          (!path.includes('/') && index.get(basename(path))?.length === 1
            ? index.get(basename(path))[0]
            : null)
        if (!found) add(row.lineNumber, row.id, `source ${path} no longer exists`)
        else sibling = join(found, '..')
      }
    }
  }
  return problems
}

/** Done and applicable lines per area and platform, plus the totals. */
export function parityStats(parsed) {
  const areas = new Map()
  const bump = (area, platform, cell) => {
    const row =
      areas.get(area) ?? Object.fromEntries(PLATFORMS.map((p) => [p, { done: 0, lines: 0 }]))
    if (APPLIES.has(cell)) row[platform].lines += 1
    if (cell === '[x]') row[platform].done += 1
    areas.set(area, row)
  }
  for (const row of parsed.controls) for (const p of PLATFORMS) bump(row.area, p, row.platforms[p])
  for (const row of parsed.windowsOnly) bump('Windows-only lines', 'windows', row.windows)
  const total = Object.fromEntries(PLATFORMS.map((p) => [p, { done: 0, lines: 0 }]))
  for (const row of areas.values()) {
    for (const p of PLATFORMS) {
      total[p].done += row[p].done
      total[p].lines += row[p].lines
    }
  }
  return { areas: [...areas].map(([area, platforms]) => ({ area, ...platforms })), total }
}
