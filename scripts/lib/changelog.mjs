import { readdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

export const CHANGELOG_SCHEMA_VERSION = 1

const ALLOWED_CHANNELS = ['beta', 'stable']
const ALLOWED_FRONTMATTER_KEYS = ['version', 'date', 'channel', 'title', 'summary', 'highlights']
const VERSION_PATTERN = /^\d+\.\d+\.\d+(-[a-z]+\.\d+)?$/
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const MAX_HIGHLIGHTS = 6

export function parseChangelogEntry(markdown, { filename }) {
  const errors = []
  const { frontmatter, body, fenceError } = splitFrontmatter(markdown)
  if (fenceError) {
    throw new ChangelogEntryError(filename, [fenceError])
  }

  const { fields, highlights, parseErrors } = parseFrontmatterFields(frontmatter)
  errors.push(...parseErrors)

  const version = fields.get('version') ?? ''
  const expectedVersion = basename(filename, '.md')
  if (!VERSION_PATTERN.test(version)) {
    errors.push(`version must look like 0.9.2-beta.1 or 1.0.0, got "${version}"`)
  } else if (version !== expectedVersion) {
    errors.push(`version "${version}" must match the filename "${expectedVersion}"`)
  }

  const date = fields.get('date') ?? ''
  if (!DATE_PATTERN.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    errors.push(`date must be a valid YYYY-MM-DD, got "${date}"`)
  }

  const channel = fields.get('channel') ?? ''
  if (!ALLOWED_CHANNELS.includes(channel)) {
    errors.push(`channel must be one of ${ALLOWED_CHANNELS.join(', ')}, got "${channel}"`)
  }

  const title = fields.get('title') ?? ''
  if (!title) {
    errors.push('title must be a non-empty string')
  }

  const summary = fields.get('summary') ?? ''
  if (!summary) {
    errors.push('summary must be a non-empty string')
  }

  if (highlights.length < 1 || highlights.length > MAX_HIGHLIGHTS) {
    errors.push(`highlights must contain 1-${MAX_HIGHLIGHTS} bullets, got ${highlights.length}`)
  }
  if (highlights.some((item) => item.length === 0)) {
    errors.push('highlights must not contain empty bullets')
  }

  const trimmedBody = body.trim()
  if (!trimmedBody) {
    errors.push('body must not be empty')
  }

  if (errors.length > 0) {
    throw new ChangelogEntryError(filename, errors)
  }

  return { version, date, channel, title, summary, highlights, body: trimmedBody }
}

export async function loadChangelogEntries(directory) {
  const files = (await readdir(directory))
    .filter((name) => name.endsWith('.md') && name !== 'README.md')
    .sort()

  if (files.length === 0) {
    throw new Error(`No changelog entries found in ${directory}`)
  }

  const entries = []
  const failures = []
  for (const file of files) {
    const markdown = await readFile(join(directory, file), 'utf8')
    try {
      entries.push(parseChangelogEntry(markdown, { filename: file }))
    } catch (error) {
      failures.push(error instanceof ChangelogEntryError ? error.message : String(error))
    }
  }

  if (failures.length > 0) {
    throw new Error(`Invalid changelog entries:\n${failures.join('\n')}`)
  }

  return sortEntriesNewestFirst(entries)
}

export function buildChangelogJson(entries, { generatedAt }) {
  return {
    schemaVersion: CHANGELOG_SCHEMA_VERSION,
    generatedAt,
    entries: sortEntriesNewestFirst(entries)
  }
}

export function findChangelogEntry(entries, releaseId) {
  return entries.find((entry) => entry.version === releaseId) ?? null
}

// package.json carries the bare version (0.9.2) while entries carry the full
// releaseId (0.9.2-beta.1); a bare version matches its own pre-releases too.
export function findChangelogEntryForPackageVersion(entries, packageVersion) {
  return (
    entries.find(
      (entry) =>
        entry.version === packageVersion || entry.version.startsWith(`${packageVersion}-`)
    ) ?? null
  )
}

export function requireChangelogEntryForRelease(entries, releaseId, { skip = false } = {}) {
  const entry = findChangelogEntry(entries, releaseId)
  if (!entry && !skip) {
    throw new Error(
      `No changelog entry for release ${releaseId}. Write the user-facing entry at ` +
        `changelog/${releaseId}.md (see changelog/README.md), or set ` +
        'VIDEORC_RELEASE_SKIP_CHANGELOG=1 to ship without one.'
    )
  }
  return { entry, skipped: !entry }
}

export function sortEntriesNewestFirst(entries) {
  return [...entries].sort((left, right) => {
    if (left.date !== right.date) {
      return left.date < right.date ? 1 : -1
    }
    return compareVersions(right.version, left.version)
  })
}

export function compareVersions(left, right) {
  const parsedLeft = parseVersion(left)
  const parsedRight = parseVersion(right)
  for (let index = 0; index < 3; index += 1) {
    if (parsedLeft.numbers[index] !== parsedRight.numbers[index]) {
      return parsedLeft.numbers[index] - parsedRight.numbers[index]
    }
  }
  // A release without a pre-release tag (1.0.0) is newer than one with (1.0.0-beta.2).
  if (parsedLeft.preReleaseNumber === null && parsedRight.preReleaseNumber === null) return 0
  if (parsedLeft.preReleaseNumber === null) return 1
  if (parsedRight.preReleaseNumber === null) return -1
  return parsedLeft.preReleaseNumber - parsedRight.preReleaseNumber
}

class ChangelogEntryError extends Error {
  constructor(filename, errors) {
    super(`${filename}: ${errors.join('; ')}`)
    this.name = 'ChangelogEntryError'
  }
}

function parseVersion(version) {
  const [core, preRelease] = version.split('-')
  const numbers = core.split('.').map(Number)
  const preReleaseNumber = preRelease ? Number(preRelease.split('.')[1]) : null
  return { numbers, preReleaseNumber }
}

function splitFrontmatter(markdown) {
  const lines = markdown.split('\n')
  if (lines[0]?.trim() !== '---') {
    return { fenceError: 'entry must start with a --- frontmatter fence' }
  }
  const closingIndex = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (closingIndex === -1) {
    return { fenceError: 'frontmatter fence is never closed' }
  }
  return {
    frontmatter: lines.slice(1, closingIndex),
    body: lines.slice(closingIndex + 1).join('\n')
  }
}

// Deliberately a strict YAML subset: scalar `key: value` lines plus a
// `highlights:` block of `- item` bullets. Anything else is a hard error so
// entries cannot silently carry fields the renderers ignore.
function parseFrontmatterFields(lines) {
  const fields = new Map()
  const highlights = []
  const parseErrors = []
  let inHighlights = false

  for (const rawLine of lines) {
    const line = rawLine.trimEnd()
    if (!line.trim()) continue

    const bulletMatch = /^\s*-\s+(.*)$/.exec(line)
    if (bulletMatch) {
      if (!inHighlights) {
        parseErrors.push(`unexpected list item outside highlights: "${line.trim()}"`)
        continue
      }
      highlights.push(stripQuotes(bulletMatch[1].trim()))
      continue
    }

    const keyMatch = /^([a-z]+):\s*(.*)$/.exec(line)
    if (!keyMatch) {
      parseErrors.push(`unparseable frontmatter line: "${line.trim()}"`)
      continue
    }

    const [, key, value] = keyMatch
    if (!ALLOWED_FRONTMATTER_KEYS.includes(key)) {
      parseErrors.push(`unknown frontmatter key "${key}"`)
      continue
    }

    if (key === 'highlights') {
      if (value.trim()) {
        parseErrors.push('highlights must be a block list of "- item" lines')
      }
      inHighlights = true
      continue
    }

    inHighlights = false
    if (fields.has(key)) {
      parseErrors.push(`duplicate frontmatter key "${key}"`)
      continue
    }
    fields.set(key, stripQuotes(value.trim()))
  }

  return { fields, highlights, parseErrors }
}

function stripQuotes(value) {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1)
  }
  return value
}
