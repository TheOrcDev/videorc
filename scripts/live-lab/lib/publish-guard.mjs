import { readFile, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { inflateSync } from 'node:zlib'

import { SENSITIVE_PATTERNS } from './card-state.mjs'

// Plan 178 U10. The last check before anything leaves the lab: a run folder
// file copied back to a dev machine, a file pushed to the reports repo, an
// issue body, a Discord message, a VOD description. Two checks always run
// and both must pass (fail closed):
//   1. U9's redaction module (`redact.mjs`: assertPublishable / findSensitive),
//      loaded lazily so this file works on a branch where U9 has not landed;
//      when it cannot be loaded, publishing is refused (REDACTION_UNAVAILABLE).
//   2. This module's own strict pattern list (keys, tokens, emails, home
//      paths, stream URLs, private keys, webhooks).
// Refusals name the file and the pattern, never the matched text.

export const MAX_PUBLISH_FILE_BYTES = 25 * 1024 * 1024
export const TEXT_EXTENSIONS = Object.freeze(['.md', '.json', '.txt'])
export const IMAGE_EXTENSIONS = Object.freeze(['.png'])

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

// From card-state.mjs: emails, home paths (including `~/`), stream URLs,
// token prefixes (ya29., 1//0, ghp_, sk-, AIza, Bearer, JWTs) and YouTube
// stream key shapes. Its 'opaque secret' and 'secret word' patterns are for
// short card labels and would refuse every report (URLs, prose), so they are
// replaced here by a narrower opaque-token shape and credential assignments.
const CARD_PATTERNS = Object.freeze([
  'email',
  'home path',
  'stream url',
  'token prefix',
  'stream key'
])

export const GUARD_PATTERNS = Object.freeze([
  ...SENSITIVE_PATTERNS.filter(({ name }) => CARD_PATTERNS.includes(name)),
  {
    // 32+ characters mixing upper case, lower case and digits: an API key or
    // token. Git shas (lower-case hex) and run ids do not match.
    name: 'opaque token',
    pattern:
      /(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{32,}/
  },
  { name: 'google client secret', pattern: /\bGOCSPX-[A-Za-z0-9_-]{8,}/ },
  { name: 'google client id', pattern: /\b\d{6,}-[a-z0-9]{16,}\.apps\.googleusercontent\.com\b/i },
  { name: 'private key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'webhook url', pattern: /\bdiscord(?:app)?\.com\/api\/webhooks\//i },
  { name: 'aws key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'slack token', pattern: /\bxox[abeoprs]-[A-Za-z0-9-]{8,}/ },
  {
    name: 'credential query',
    pattern: /[?&](?:key|token|access_token|refresh_token|sig)=[^&\s]{6,}/i
  },
  {
    name: 'credential assignment',
    pattern:
      /\b(?:api[_-]?key|client[_-]?secret|secret|token|password|passwd|stream[_-]?key|refresh[_-]?token|webhook[_-]?url)["']?\s*[:=]\s*["']?[A-Za-z0-9_\-./+=]{12,}/i
  },
  { name: 'authorization header', pattern: /\bauthorization\s*:\s*\S+/i }
])

export class PublishRefused extends Error {
  constructor(code, problems) {
    const list = problems.map((problem) => `${problem.file}: ${problem.pattern}`)
    super(`${code}: ${list.join('; ') || 'refused'}`.slice(0, 2000))
    this.name = 'PublishRefused'
    this.code = code
    this.problems = problems
  }
}

/** Pure: every local pattern that hits `text`, as [{ pattern, index }]. */
export function findLocalSensitive(text) {
  const hits = []
  if (typeof text !== 'string' || text.length === 0) return hits
  for (const { name, pattern } of GUARD_PATTERNS) {
    const match = new RegExp(pattern.source, pattern.flags.replace('g', '')).exec(text)
    if (match) hits.push({ pattern: name, index: match.index })
  }
  return hits
}

/** Pure: `text` with every local hit replaced by [redacted]. For progress lines only. */
export function sanitizeLine(text) {
  let output = String(text ?? '')
  for (const { pattern } of GUARD_PATTERNS) {
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
    output = output.replace(new RegExp(pattern.source, flags), '[redacted]')
  }
  return output
}

/** Pure: the text chunks (tEXt, zTXt, iTXt) of a PNG, decoded, or throws for a non-PNG. */
export function pngTextChunks(buffer) {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('not a PNG')
  }
  const texts = []
  let offset = 8
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('latin1', offset + 4, offset + 8)
    const start = offset + 8
    const end = start + length
    if (end + 4 > buffer.length) throw new Error('truncated PNG chunk')
    const data = buffer.subarray(start, end)
    if (type === 'tEXt') {
      texts.push(data.toString('latin1'))
    } else if (type === 'zTXt') {
      const nul = data.indexOf(0)
      texts.push(data.toString('latin1', 0, Math.max(0, nul)))
      texts.push(inflateSync(data.subarray(nul + 2)).toString('latin1'))
    } else if (type === 'iTXt') {
      const nul = data.indexOf(0)
      const compressed = data[nul + 1] === 1
      let cursor = nul + 3
      cursor = data.indexOf(0, cursor) + 1
      cursor = data.indexOf(0, cursor) + 1
      const body = data.subarray(cursor)
      texts.push(data.toString('latin1', 0, Math.max(0, nul)))
      texts.push((compressed ? inflateSync(body) : body).toString('utf8'))
    }
    if (type === 'IEND') break
    offset = end + 4
  }
  return texts
}

/**
 * The local check for one file: an allowed type, under the size cap, and no
 * local pattern in its text (for PNGs, in its text chunks). Returns a list of
 * { file, pattern } problems (empty when the file may leave).
 */
export async function checkFileLocally(path, { label = basename(path) } = {}) {
  const extension = extname(path).toLowerCase()
  const isText = TEXT_EXTENSIONS.includes(extension)
  const isImage = IMAGE_EXTENSIONS.includes(extension)
  if (!isText && !isImage) return [{ file: label, pattern: 'file type not allowed' }]
  let info
  try {
    info = await stat(path)
  } catch {
    return [{ file: label, pattern: 'missing' }]
  }
  if (!info.isFile()) return [{ file: label, pattern: 'not a regular file' }]
  if (info.size > MAX_PUBLISH_FILE_BYTES) return [{ file: label, pattern: 'file too large' }]
  const buffer = await readFile(path)
  let texts
  if (isText) {
    if (buffer.includes(0)) return [{ file: label, pattern: 'binary data in a text file' }]
    texts = [buffer.toString('utf8')]
  } else {
    try {
      texts = pngTextChunks(buffer)
    } catch (error) {
      return [{ file: label, pattern: `bad image (${error.message})` }]
    }
  }
  const problems = []
  const seen = new Set()
  for (const text of texts) {
    for (const hit of findLocalSensitive(text)) {
      if (seen.has(hit.pattern)) continue
      seen.add(hit.pattern)
      problems.push({ file: label, pattern: hit.pattern })
    }
  }
  return problems
}

/**
 * U9's redaction module, loaded lazily. Resolves { assertPublishable,
 * findSensitive } or null when the module is not there (or does not export
 * assertPublishable). Any other import error is thrown.
 */
export async function loadRedactor({ importer = (spec) => import(spec) } = {}) {
  let module
  try {
    module = await importer('./redact.mjs')
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') return null
    throw error
  }
  if (typeof module?.assertPublishable !== 'function') return null
  return {
    assertPublishable: module.assertPublishable,
    findSensitive: typeof module.findSensitive === 'function' ? module.findSensitive : null
  }
}

function requireRedactor(redactor) {
  if (!redactor || typeof redactor.assertPublishable !== 'function') {
    throw new PublishRefused('REDACTION_UNAVAILABLE', [
      { file: 'scripts/live-lab/lib/redact.mjs', pattern: 'U9 redaction module not available' }
    ])
  }
}

/**
 * Both checks on every file. Throws PublishRefused (REDACTION_FAILED) listing
 * every local problem and U9's refusal; resolves when all files may leave.
 * `labels` maps a path to the name shown in a refusal (defaults to basename).
 */
export async function guardFiles(paths, { redactor, labels = new Map() } = {}) {
  requireRedactor(redactor)
  const problems = []
  for (const path of paths) {
    problems.push(...(await checkFileLocally(path, { label: labels.get(path) ?? basename(path) })))
  }
  try {
    await redactor.assertPublishable([...paths])
  } catch (error) {
    problems.push({
      file: 'redact.mjs',
      pattern: `assertPublishable refused (${error?.code ?? 'error'})`
    })
  }
  if (problems.length > 0) throw new PublishRefused('REDACTION_FAILED', problems)
}

/**
 * Both checks on a text that leaves the lab without being a file (an issue
 * body, a Discord message, a VOD description). Uses U9's findSensitive when
 * it exports one; otherwise U9's assertPublishable on a temp copy, through
 * `writeTemp(text) -> { path, cleanup }`.
 */
export async function guardText(text, label, { redactor, writeTemp = null } = {}) {
  requireRedactor(redactor)
  const problems = findLocalSensitive(text).map((hit) => ({ file: label, pattern: hit.pattern }))
  if (redactor.findSensitive) {
    const hits = redactor.findSensitive(text) ?? []
    for (const hit of hits) problems.push({ file: label, pattern: `redact.mjs ${hit.pattern}` })
  } else if (writeTemp) {
    const temp = await writeTemp(text)
    try {
      await redactor.assertPublishable([temp.path])
    } catch (error) {
      problems.push({
        file: label,
        pattern: `assertPublishable refused (${error?.code ?? 'error'})`
      })
    } finally {
      await temp.cleanup()
    }
  } else {
    problems.push({ file: label, pattern: 'no U9 text check available' })
  }
  if (problems.length > 0) throw new PublishRefused('REDACTION_FAILED', problems)
  return text
}
