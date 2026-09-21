import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const EM_DASH = '—'

// App copy never uses an em dash (owner rule, 2026-09-21). The gate covers what
// ships to a user: string literals, template literals and JSX text in the
// desktop app, backend strings, and the phone remote page. Comments and tests
// are exempt.
const SCANNED = [
  { prefix: 'apps/desktop/src/', extensions: ['.ts', '.tsx'], language: 'ts' },
  { prefix: 'crates/videorc-backend/src/', extensions: ['.rs'], language: 'rust' },
  { prefix: 'crates/videorc-backend/remote_web/', extensions: ['.js'], language: 'ts' },
  { prefix: 'crates/videorc-backend/remote_web/', extensions: ['.html', '.css'], language: 'text' }
]

const TEST_FILE = /(\.test\.[cm]?[jt]sx?|\/tests\/|\/__fixtures__\/)/

export function emDashLanguageFor(path) {
  if (TEST_FILE.test(path)) {
    return null
  }
  const scope = SCANNED.find(
    (entry) =>
      path.startsWith(entry.prefix) &&
      entry.extensions.some((extension) => path.endsWith(extension))
  )
  return scope?.language ?? null
}

// A `#[cfg(test)]` (or `#[cfg(all(test, ...))]`) inline module. rustfmt closes
// a top-level module with a `}` in column 0, so the module ends at the first
// line that starts with one. Test modules can sit mid-file with production code
// after them (compositor.rs), so each one is cut out, not everything after the
// first.
const RUST_TEST_MODULE =
  /^#\[cfg\((?:test|all\(test,[^\n]*\))\)\]\n(?:#\[[^\n]*\]\n)*(?:pub(?:\([a-z]+\))?\s+)?mod\s+\w+\s*\{[\s\S]*?^\}/gm

/** Unit tests in a Rust file are exempt. Blanked, not removed, so line numbers hold. */
function withoutRustTestModules(source) {
  return source.replace(RUST_TEST_MODULE, (module) => module.replace(/[^\n]/g, ''))
}

/**
 * Index of the last character of a Rust raw string (`r"…"`, `r#"…"#`, `br"…"`)
 * that starts at `index`, or null. A backslash is literal in a raw string, so
 * `r"\\?\UNC\"` ends at its last quote; read as an escape, that quote would
 * leave the rest of the file flipped inside out.
 */
function rustRawStringEnd(text, index) {
  const before = text[index - 1] === 'b' ? text[index - 2] : text[index - 1]
  if (before !== undefined && /\w/.test(before)) {
    return null
  }
  let cursor = index + 1
  while (text[cursor] === '#') {
    cursor += 1
  }
  if (text[cursor] !== '"') {
    return null
  }
  const closing = `"${'#'.repeat(cursor - index - 1)}`
  const end = text.indexOf(closing, cursor + 1)
  return end === -1 ? text.length - 1 : end + closing.length - 1
}

/**
 * Line numbers (1-based) of em dashes outside comments.
 *
 * A small comment-aware scanner, not a parser. Quotes only matter so that a
 * `//` inside a string (a URL) is not taken for a comment, and a `://` outside
 * one is a URL in JSX text, never a comment. In TS a quote state resets at the
 * end of the line, which keeps an apostrophe in JSX text from hiding the rest
 * of the file; Rust strings may span lines and `'` is a lifetime or char there,
 * so only `"` opens one.
 */
export function findEmDashLines(source, language) {
  if (language === 'text') {
    return source.split('\n').flatMap((line, index) => (line.includes(EM_DASH) ? [index + 1] : []))
  }

  const text = language === 'rust' ? withoutRustTestModules(source) : source
  const quotes = language === 'rust' ? ['"'] : ['"', "'", '`']
  const lines = new Set()
  let line = 1
  let quote = null
  let blockComment = false
  let lineComment = false

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    const next = text[index + 1]

    if (char === '\n') {
      line += 1
      lineComment = false
      if (language !== 'rust' && quote !== '`') {
        quote = null
      }
      continue
    }
    if (lineComment) {
      continue
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false
        index += 1
      }
      continue
    }
    if (quote) {
      if (char === '\\') {
        index += 1
        if (text[index] === '\n') {
          line += 1
        }
      } else if (char === quote) {
        quote = null
      } else if (char === EM_DASH) {
        lines.add(line)
      }
      continue
    }
    if (language === 'rust' && char === 'r') {
      const end = rustRawStringEnd(text, index)
      if (end !== null) {
        for (; index <= end; index += 1) {
          if (text[index] === '\n') {
            line += 1
          } else if (text[index] === EM_DASH) {
            lines.add(line)
          }
        }
        index = end
        continue
      }
    }
    if (language === 'rust' && char === "'") {
      // A `'"'` or `'\\"'` char literal must not open a string.
      const close = next === '\\' ? index + 3 : index + 2
      if (text[close] === "'") {
        index = close
      }
      continue
    }
    if (char === '/' && next === '/' && text[index - 1] !== ':') {
      lineComment = true
      index += 1
    } else if (char === '/' && next === '*') {
      blockComment = true
      index += 1
    } else if (quotes.includes(char)) {
      quote = char
    } else if (char === EM_DASH) {
      lines.add(line)
    }
  }

  return [...lines].sort((a, b) => a - b)
}

export async function checkEmDashes(root) {
  const { stdout } = await execFileAsync('git', ['ls-files', '-z'], {
    cwd: root,
    maxBuffer: 64 * 1024 * 1024
  })
  const failures = []
  let scanned = 0
  for (const path of stdout.split('\0')) {
    const language = path ? emDashLanguageFor(path) : null
    if (!language) {
      continue
    }
    let source
    try {
      source = await readFile(join(root, path), 'utf8')
    } catch {
      continue
    }
    scanned += 1
    if (!source.includes(EM_DASH)) {
      continue
    }
    for (const line of findEmDashLines(source, language)) {
      failures.push(`${path}:${line}`)
    }
  }
  return { failures, scanned }
}
