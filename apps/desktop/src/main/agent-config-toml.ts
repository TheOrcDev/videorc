// Plan 209 S22: add or replace Codex's `[mcp_servers.videorc]` table in
// `~/.codex/config.toml` without a TOML library (none ships in the app).
//
// This is not a TOML parser. It scans the file line by line, tracking
// strings (all four kinds, multi-line ones across lines), comments and the
// bracket depth of values, so it knows which lines are table headers and
// which are key/value lines. It then removes every `[mcp_servers.videorc…]`
// section and writes the new table in the first one's place (or at the end).
// Every other byte of the file stays as it was.
//
// Anything it can't place with certainty is refused, and the streamer pastes
// the line instead: `videorc` defined with dotted keys or an inline table,
// `mcp_servers` as an inline table, an array of `videorc` tables, the table
// twice, an unterminated string or bracket, or a line that is none of a
// header, a key/value, a comment or blank.

export type CodexTomlMerge =
  | { ok: true; text: string; changed: boolean }
  | { ok: false; reason: string }

type MultilineString = '"""' | "'''"

interface ScanState {
  multiline: MultilineString | null
  depth: number
}

type ScannedLine =
  | { kind: 'trivia' }
  | { kind: 'continuation' }
  | { kind: 'header'; path: string[]; array: boolean }
  | { kind: 'keyval'; path: string[] }

class TomlScanError extends Error {}

const BARE_KEY = /[A-Za-z0-9_-]/

/** A TOML basic string's escapes, enough to compare key names. */
function unescapeBasic(raw: string): string {
  return raw.replace(/\\(u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|.)/g, (_match, escape: string) => {
    if (escape.length > 1) return String.fromCodePoint(Number.parseInt(escape.slice(1), 16))
    const simple: Record<string, string> = {
      b: '\b',
      t: '\t',
      n: '\n',
      f: '\f',
      r: '\r',
      e: '\u001b',
      '"': '"',
      '\\': '\\'
    }
    return simple[escape] ?? escape
  })
}

/** The end of a one-line string that opens at `start` (on the quote). */
function singleLineStringEnd(line: string, start: number): number {
  const quote = line[start]
  for (let index = start + 1; index < line.length; index += 1) {
    if (quote === '"' && line[index] === '\\') {
      index += 1
      continue
    }
    if (line[index] === quote) return index
  }
  throw new TomlScanError('an unterminated string')
}

/**
 * A dotted key from `start`, up to `terminator` (`=` for a key/value, `]`
 * for a header). Returns the path and the index after the terminator.
 */
function readKeyPath(line: string, start: number, terminator: '=' | ']'): [string[], number] {
  const path: string[] = []
  let index = start
  for (;;) {
    while (line[index] === ' ' || line[index] === '\t') index += 1
    const char = line[index]
    if (char === '"' || char === "'") {
      const end = singleLineStringEnd(line, index)
      const raw = line.slice(index + 1, end)
      path.push(char === '"' ? unescapeBasic(raw) : raw)
      index = end + 1
    } else {
      const from = index
      while (index < line.length && BARE_KEY.test(line[index])) index += 1
      if (index === from) throw new TomlScanError('a key Videorc could not read')
      path.push(line.slice(from, index))
    }
    while (line[index] === ' ' || line[index] === '\t') index += 1
    if (line[index] === '.') {
      index += 1
      continue
    }
    if (line[index] === terminator) return [path, index + 1]
    throw new TomlScanError('a key Videorc could not read')
  }
}

/** Scan a value (or a continuation) from `start`, carrying strings and brackets across lines. */
function scanValue(line: string, start: number, state: ScanState): void {
  let index = start
  while (index < line.length) {
    if (state.multiline) {
      const delimiter = state.multiline
      if (delimiter === '"""' && line[index] === '\\') {
        index += 2
        continue
      }
      if (line.startsWith(delimiter, index)) {
        // Up to two quotes of the content may sit against the closing three.
        let end = index + 3
        while (end < line.length && end < index + 5 && line[end] === delimiter[0]) end += 1
        state.multiline = null
        index = end
        continue
      }
      index += 1
      continue
    }
    const char = line[index]
    if (char === '#') return
    if (line.startsWith('"""', index) || line.startsWith("'''", index)) {
      state.multiline = line.slice(index, index + 3) as MultilineString
      index += 3
      continue
    }
    if (char === '"' || char === "'") {
      index = singleLineStringEnd(line, index) + 1
      continue
    }
    if (char === '[' || char === '{') state.depth += 1
    if (char === ']' || char === '}') {
      state.depth -= 1
      if (state.depth < 0) throw new TomlScanError('an unmatched bracket')
    }
    index += 1
  }
}

function scanLine(line: string, state: ScanState): ScannedLine {
  if (state.multiline || state.depth > 0) {
    scanValue(line, 0, state)
    return { kind: 'continuation' }
  }
  const start = line.search(/\S/)
  if (start === -1 || line[start] === '#') return { kind: 'trivia' }
  if (line[start] === '[') {
    const array = line[start + 1] === '['
    const [path, after] = readKeyPath(line, start + (array ? 2 : 1), ']')
    let rest = after
    if (array) {
      if (line[rest] !== ']') throw new TomlScanError('an array header Videorc could not read')
      rest += 1
    }
    const tail = line.slice(rest).trim()
    if (tail !== '' && !tail.startsWith('#')) {
      throw new TomlScanError('a header Videorc could not read')
    }
    return { kind: 'header', path, array }
  }
  const [path, after] = readKeyPath(line, start, '=')
  scanValue(line, after, state)
  return { kind: 'keyval', path }
}

const startsWith = (path: string[], prefix: string[]): boolean =>
  prefix.every((part, index) => path[index] === part)

const sameLines = (left: string[], right: string[]): boolean =>
  left.length === right.length && left.every((line, index) => line.trim() === right[index].trim())

/**
 * Put `table` (the `[mcp_servers.<server>]` lines) into `existing`, replacing
 * any earlier `<server>` table and its sub-tables. `existing` null is a file
 * that isn't there yet.
 */
export function mergeCodexToml(
  existing: string | null,
  table: string[],
  server: string
): CodexTomlMerge {
  const ours = ['mcp_servers', server]
  if (existing === null || existing.trim() === '') {
    return { ok: true, text: `${table.join('\n')}\n`, changed: true }
  }
  const bom = existing.startsWith('﻿') ? '﻿' : ''
  const body = bom ? existing.slice(1) : existing
  const eol = body.includes('\r\n') ? '\r\n' : '\n'
  const lines = body.split(/\r?\n/)

  const state: ScanState = { multiline: null, depth: 0 }
  const scanned: ScannedLine[] = []
  try {
    for (const line of lines) scanned.push(scanLine(line, state))
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof TomlScanError ? error.message : 'a line Videorc could not read'
    }
  }
  if (state.multiline || state.depth !== 0) {
    return { ok: false, reason: 'an unterminated string or bracket' }
  }

  // Our sections: from each `[mcp_servers.<server>…]` header to its last
  // key/value line. Blank lines and comments after that stay: they usually
  // belong to the next table.
  const sections: Array<{ start: number; end: number }> = []
  let current: string[] = []
  let open: { start: number; end: number } | null = null
  let exactHeaders = 0
  for (const [index, line] of scanned.entries()) {
    if (line.kind === 'header') {
      if (open) sections.push(open)
      open = null
      current = line.path
      if (startsWith(line.path, ours)) {
        if (line.array) return { ok: false, reason: `an array of ${server} tables` }
        if (line.path.length === ours.length) exactHeaders += 1
        open = { start: index, end: index }
      }
      continue
    }
    if (line.kind === 'trivia') continue
    if (open) {
      open.end = index
      continue
    }
    if (line.kind === 'keyval') {
      const full = [...current, ...line.path]
      if (full.length === 1 && full[0] === 'mcp_servers') {
        return { ok: false, reason: 'mcp_servers written as an inline table' }
      }
      if (startsWith(full, ours)) {
        return { ok: false, reason: `${server} written with dotted keys or an inline table` }
      }
    }
  }
  if (open) sections.push(open)
  if (exactHeaders > 1) return { ok: false, reason: `the ${server} table twice` }

  if (
    sections.length === 1 &&
    sameLines(lines.slice(sections[0].start, sections[0].end + 1), table)
  ) {
    return { ok: true, text: existing, changed: false }
  }

  let out: string[]
  if (sections.length > 0) {
    out = []
    let cursor = 0
    for (const [order, section] of sections.entries()) {
      out.push(...lines.slice(cursor, section.start))
      if (order === 0) out.push(...table)
      cursor = section.end + 1
    }
    out.push(...lines.slice(cursor))
  } else {
    out = [...lines]
    // `split` leaves one empty string after a final newline.
    if (out[out.length - 1] === '') out.pop()
    if (out.length > 0 && out[out.length - 1].trim() !== '') out.push('')
    out.push(...table, '')
  }
  return { ok: true, text: `${bom}${out.join(eol)}`, changed: true }
}
