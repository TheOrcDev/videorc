import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'

import { SENSITIVE_PATTERNS } from './card-state.mjs'

// Plan 178 U9 (plan 166 S8, plan 176 L5 step 4). The redaction pass every
// report goes through before it leaves the run folder. It reuses the test
// card's allowlist patterns (card-state.mjs: emails, home paths, stream URLs,
// token prefixes, stream-key shapes, opaque secrets) and adds the shapes U8
// and the lab config introduced: Google OAuth client ids and secrets, Google
// refresh tokens, the harness's own bearer tokens and discovery files.
//
// redactText replaces every hit with [redacted:<pattern>]; findSensitive
// lists hits (pattern name and index, never the text); assertPublishable
// reads text files and throws REDACTION_FAILED naming file and pattern.
// Publishing (U10) always calls it first and fails closed.

// Pattern names double as the replacement label, so none of them may itself
// match a pattern (the "secret word" screen catches token/secret/password).
export const EXTRA_PATTERNS = Object.freeze([
  {
    name: 'google-client-id',
    pattern: /\b[0-9]{6,}-[a-z0-9]{10,}\.apps\.googleusercontent\.com\b/i
  },
  { name: 'google-client-credential', pattern: /\bGOCSPX-[A-Za-z0-9_-]{8,}/ },
  { name: 'google-refresh-credential', pattern: /\b1\/\/[0-9A-Za-z_-]{20,}/ },
  {
    name: 'youtube-stream-key',
    pattern: /\b[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}\b/i
  },
  { name: 'lab-config-path', pattern: /\.videorc-live-lab\/config\.json/ },
  // The card screen only flags the prefix; a report must lose the whole path.
  { name: 'home-dir', pattern: /(?:\/Users\/|\/home\/|~\/)[^\s"'`)\]]*/ },
  { name: 'remote-credential', pattern: /"token"\s*:\s*"[^"]{8,}"/ },
  { name: 'ws-credential-url', pattern: /[?&]token=[^\s&"']+/ }
])

const CARD_LABELS = Object.freeze({
  email: 'email',
  'home path': 'home-path',
  'stream url': 'stream-url',
  'token prefix': 'credential-prefix',
  'stream key': 'stream-key',
  'opaque secret': 'opaque-string',
  'secret word': 'sensitive-word'
})

export const REDACTION_PATTERNS = Object.freeze([
  ...EXTRA_PATTERNS,
  ...SENSITIVE_PATTERNS.map(({ name, pattern }) => ({
    name: CARD_LABELS[name] ?? name.replace(/[^a-z0-9]+/gi, '-'),
    pattern
  }))
])

const TEXT_EXTENSIONS = new Set([
  '.md',
  '.json',
  '.ndjson',
  '.csv',
  '.txt',
  '.log',
  '.svg',
  '.html',
  '.yml',
  '.yaml',
  '.mjs',
  '.js',
  '.ts'
])

export class RedactionFailed extends Error {
  constructor(hits) {
    super(`REDACTION_FAILED: ${hits.map((hit) => `${hit.file}: ${hit.pattern}`).join('; ')}`)
    this.name = 'RedactionFailed'
    this.code = 'REDACTION_FAILED'
    this.hits = hits
  }
}

function globalOf(pattern) {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
  return new RegExp(pattern.source, flags)
}

// The opaque-string pattern counts `/` as a secret character, so the path of
// every report or issue link (github.com/TheOrcDev/videorc-...) would match
// it and no issue could ever be filed. Only for that pattern, the path of an
// https link on these hosts is ignored. The query string and fragment are
// never ignored, and every other pattern still scans the whole link.
export const LINK_HOSTS = Object.freeze([
  'github.com',
  'raw.githubusercontent.com',
  'www.youtube.com',
  'youtube.com',
  'youtu.be',
  'www.videorc.com',
  'videorc.com'
])
const OPAQUE_PATTERN_NAME = 'opaque-string'
const LINK_RE = /https:\/\/([A-Za-z0-9.-]+)(\/[A-Za-z0-9._~%/-]*)?/g

/** [start, end) spans of allowlisted link paths in `text`. */
function allowlistedLinkPaths(text) {
  const spans = []
  for (const match of text.matchAll(LINK_RE)) {
    if (!LINK_HOSTS.includes(match[1].toLowerCase())) continue
    spans.push([match.index, match.index + match[0].length])
  }
  return spans
}

function insideSpan(spans, start, end) {
  return spans.some(([from, to]) => start >= from && end <= to)
}

/** Every hit in `text`: { pattern, index }. Never the matched text. */
export function findSensitive(text, patterns = REDACTION_PATTERNS) {
  const hits = []
  if (typeof text !== 'string' || text.length === 0) return hits
  const links = allowlistedLinkPaths(text)
  for (const { name, pattern } of patterns) {
    const re = globalOf(pattern)
    let match
    while ((match = re.exec(text)) !== null) {
      const end = match.index + match[0].length
      if (!(name === OPAQUE_PATTERN_NAME && insideSpan(links, match.index, end))) {
        hits.push({ pattern: name, index: match.index })
      }
      if (match[0].length === 0) re.lastIndex += 1
    }
  }
  return hits.sort((a, b) => a.index - b.index)
}

/** `text` with every hit replaced by [redacted:<pattern>]. Idempotent. */
export function redactText(text, patterns = REDACTION_PATTERNS) {
  let output = String(text ?? '')
  for (const { name, pattern } of patterns) {
    if (name !== OPAQUE_PATTERN_NAME) {
      output = output.replace(globalOf(pattern), `[redacted:${name}]`)
      continue
    }
    const links = allowlistedLinkPaths(output)
    output = output.replace(globalOf(pattern), (match, ...rest) => {
      const index = rest.at(-2)
      return insideSpan(links, index, index + match.length) ? match : `[redacted:${name}]`
    })
  }
  return output
}

/** Walks a JSON-able value and redacts every string in it (keys included). */
export function redactValue(value, patterns = REDACTION_PATTERNS) {
  if (typeof value === 'string') return redactText(value, patterns)
  if (Array.isArray(value)) return value.map((item) => redactValue(item, patterns))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      out[redactText(key, patterns)] = redactValue(item, patterns)
    }
    return out
  }
  return value
}

export function isTextFile(path) {
  return TEXT_EXTENSIONS.has(extname(String(path)).toLowerCase())
}

/**
 * Throws RedactionFailed (code REDACTION_FAILED) when any text file in
 * `paths` still holds a hit. Binary files (png, media, dumps) are skipped.
 * `read` is injectable for tests.
 */
export async function assertPublishable(
  paths,
  { patterns = REDACTION_PATTERNS, read = (path) => readFile(path, 'utf8') } = {}
) {
  const hits = []
  for (const path of paths) {
    if (!isTextFile(path)) continue
    const text = await read(path)
    const seen = new Set()
    for (const hit of findSensitive(text, patterns)) {
      if (seen.has(hit.pattern)) continue
      seen.add(hit.pattern)
      hits.push({ file: String(path), pattern: hit.pattern })
    }
  }
  if (hits.length > 0) throw new RedactionFailed(hits)
}
