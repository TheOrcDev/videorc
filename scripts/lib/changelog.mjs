import { readdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

export const CHANGELOG_SCHEMA_VERSION = 1

const ALLOWED_CHANNELS = ['alpha', 'beta', 'stable']
const ALLOWED_PLATFORMS = ['macos', 'windows']
const ALLOWED_FRONTMATTER_KEYS = [
  'version',
  'date',
  'channel',
  'platforms',
  'title',
  'summary',
  'highlights'
]
const LIST_FRONTMATTER_KEYS = new Set(['platforms', 'highlights'])
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-(?:alpha|beta)\.\d+)?$/
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const MAX_HIGHLIGHTS = 6
const PUBLISHED_ENTRY_KEYS = new Set([
  'version',
  'date',
  'channel',
  'platforms',
  'title',
  'summary',
  'highlights',
  'body'
])

export function parseChangelogEntry(markdown, { filename }) {
  const errors = []
  const { frontmatter, body, fenceError } = splitFrontmatter(markdown)
  if (fenceError) {
    throw new ChangelogEntryError(filename, [fenceError])
  }

  const { fields, lists, parseErrors } = parseFrontmatterFields(frontmatter)
  errors.push(...parseErrors)
  const highlights = lists.get('highlights') ?? []

  const version = fields.get('version') ?? ''
  const expectedVersion = basename(filename, '.md')
  if (!VERSION_PATTERN.test(version)) {
    errors.push(`version must look like 0.10.0-alpha.1, 0.9.2-beta.1, or 1.0.0, got "${version}"`)
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
  } else if (VERSION_PATTERN.test(version)) {
    const expectedChannel = channelForVersion(version)
    if (channel !== expectedChannel) {
      errors.push(
        `channel "${channel}" must match version "${version}" (expected "${expectedChannel}")`
      )
    }
  }

  const explicitPlatforms = lists.get('platforms')
  // Schema v1 entries predate platform metadata and were all macOS releases.
  // Preserve them while ensuring every parsed/published entry carries a list.
  const platforms = explicitPlatforms ?? ['macos']
  if (explicitPlatforms && explicitPlatforms.length === 0) {
    errors.push('platforms must contain at least one of macos, windows')
  }
  const unsupportedPlatforms = platforms.filter((platform) => !ALLOWED_PLATFORMS.includes(platform))
  if (unsupportedPlatforms.length > 0) {
    errors.push(
      `platforms must contain only ${ALLOWED_PLATFORMS.join(', ')}, got "${unsupportedPlatforms.join(', ')}"`
    )
  }
  if (new Set(platforms).size !== platforms.length) {
    errors.push('platforms must not contain duplicates')
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

  return { version, date, channel, platforms, title, summary, highlights, body: trimmedBody }
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

export function mergeChangelogDocuments({ localEntries, remoteDocument = null, generatedAt }) {
  const merged = new Map()
  const remoteEntries = remoteDocument ? validatePublishedChangelogDocument(remoteDocument) : []

  for (const entry of remoteEntries) {
    if (merged.has(entry.version)) {
      throw new Error(`Published changelog contains duplicate version ${entry.version}.`)
    }
    merged.set(entry.version, entry)
  }

  for (const rawEntry of localEntries) {
    const entry = normalizePublishedChangelogEntry(rawEntry)
    const published = merged.get(entry.version)
    if (published && JSON.stringify(published) !== JSON.stringify(entry)) {
      throw new Error(
        `Published changelog entry ${entry.version} conflicts with the trusted repository entry.`
      )
    }
    merged.set(entry.version, entry)
  }

  return buildChangelogJson([...merged.values()], { generatedAt })
}

export function findChangelogEntry(entries, releaseId) {
  return entries.find((entry) => entry.version === releaseId) ?? null
}

// package.json carries the bare version (0.9.2) while entries carry the full
// releaseId (0.9.2-beta.1); a bare version matches its own pre-releases too.
export function findChangelogEntryForPackageVersion(entries, packageVersion) {
  return (
    entries.find(
      (entry) => entry.version === packageVersion || entry.version.startsWith(`${packageVersion}-`)
    ) ?? null
  )
}

export function requireChangelogEntryForRelease(
  entries,
  releaseId,
  { requiredPlatform = null, skip = false } = {}
) {
  const entry = findChangelogEntry(entries, releaseId)
  if (!entry && !skip) {
    throw new Error(
      `No changelog entry for release ${releaseId}. Write the user-facing entry at ` +
        `changelog/${releaseId}.md (see changelog/README.md), or set ` +
        'VIDEORC_RELEASE_SKIP_CHANGELOG=1 to ship without one.'
    )
  }
  if (entry && requiredPlatform && !entry.platforms?.includes(requiredPlatform)) {
    throw new Error(
      `Changelog entry ${releaseId} must explicitly include platform "${requiredPlatform}". ` +
        `Add it to the platforms list in changelog/${releaseId}.md.`
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
  if (parsedLeft.preRelease === null && parsedRight.preRelease === null) return 0
  if (parsedLeft.preRelease === null) return 1
  if (parsedRight.preRelease === null) return -1
  if (parsedLeft.preRelease.tag !== parsedRight.preRelease.tag) {
    return preReleaseRank(parsedLeft.preRelease.tag) - preReleaseRank(parsedRight.preRelease.tag)
  }
  return parsedLeft.preRelease.number - parsedRight.preRelease.number
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
  const [tag, number] = preRelease?.split('.') ?? []
  return {
    numbers,
    preRelease: preRelease ? { number: Number(number), tag } : null
  }
}

function preReleaseRank(tag) {
  return tag === 'alpha' ? 0 : 1
}

function channelForVersion(version) {
  const [, preRelease] = version.split('-')
  return preRelease?.split('.')[0] ?? 'stable'
}

function validatePublishedChangelogDocument(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('Published changelog must be a JSON object.')
  }
  const keys = Object.keys(document).sort()
  if (keys.join(',') !== 'entries,generatedAt,schemaVersion') {
    throw new Error('Published changelog contains missing or unsupported top-level fields.')
  }
  if (document.schemaVersion !== CHANGELOG_SCHEMA_VERSION) {
    throw new Error(`Published changelog schemaVersion must be ${CHANGELOG_SCHEMA_VERSION}.`)
  }
  if (typeof document.generatedAt !== 'string' || Number.isNaN(Date.parse(document.generatedAt))) {
    throw new Error('Published changelog generatedAt must be an ISO date-time string.')
  }
  if (!Array.isArray(document.entries)) {
    throw new Error('Published changelog entries must be an array.')
  }
  return document.entries.map(normalizePublishedChangelogEntry)
}

function normalizePublishedChangelogEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error('Published changelog entries must be objects.')
  }
  const keys = Object.keys(entry)
  const unknown = keys.filter((key) => !PUBLISHED_ENTRY_KEYS.has(key))
  if (unknown.length > 0) {
    throw new Error(`Published changelog entry contains unsupported field "${unknown[0]}".`)
  }
  for (const field of ['version', 'date', 'channel', 'title', 'summary', 'body']) {
    if (typeof entry[field] !== 'string' || !entry[field].trim()) {
      throw new Error(`Published changelog entry ${field} must be a non-empty string.`)
    }
  }
  if (!VERSION_PATTERN.test(entry.version)) {
    throw new Error(`Published changelog entry has invalid version "${entry.version}".`)
  }
  if (!DATE_PATTERN.test(entry.date) || Number.isNaN(Date.parse(`${entry.date}T00:00:00Z`))) {
    throw new Error(`Published changelog entry ${entry.version} has an invalid date.`)
  }
  if (entry.channel !== channelForVersion(entry.version)) {
    throw new Error(`Published changelog entry ${entry.version} has a mismatched channel.`)
  }
  const platforms = entry.platforms ?? ['macos']
  if (
    !Array.isArray(platforms) ||
    platforms.length === 0 ||
    platforms.some((platform) => !ALLOWED_PLATFORMS.includes(platform)) ||
    new Set(platforms).size !== platforms.length
  ) {
    throw new Error(`Published changelog entry ${entry.version} has invalid platforms.`)
  }
  if (
    !Array.isArray(entry.highlights) ||
    entry.highlights.length < 1 ||
    entry.highlights.length > MAX_HIGHLIGHTS ||
    entry.highlights.some((highlight) => typeof highlight !== 'string' || !highlight.trim())
  ) {
    throw new Error(`Published changelog entry ${entry.version} has invalid highlights.`)
  }

  return {
    version: entry.version,
    date: entry.date,
    channel: entry.channel,
    platforms: [...platforms],
    title: entry.title,
    summary: entry.summary,
    highlights: [...entry.highlights],
    body: entry.body
  }
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

// Deliberately a strict YAML subset: scalar `key: value` lines plus
// `platforms:` and `highlights:` blocks of `- item` bullets. Anything else is
// a hard error so entries cannot silently carry fields the renderers ignore.
function parseFrontmatterFields(lines) {
  const fields = new Map()
  const lists = new Map()
  const parseErrors = []
  const seenKeys = new Set()
  let activeListKey = null

  for (const rawLine of lines) {
    const line = rawLine.trimEnd()
    if (!line.trim()) continue

    const bulletMatch = /^\s*-\s+(.*)$/.exec(line)
    if (bulletMatch) {
      if (!activeListKey) {
        parseErrors.push(`unexpected list item outside a list field: "${line.trim()}"`)
        continue
      }
      lists.get(activeListKey).push(stripQuotes(bulletMatch[1].trim()))
      continue
    }

    const keyMatch = /^([a-z]+):\s*(.*)$/.exec(line)
    if (!keyMatch) {
      parseErrors.push(`unparseable frontmatter line: "${line.trim()}"`)
      continue
    }

    const [, key, value] = keyMatch
    activeListKey = null
    if (!ALLOWED_FRONTMATTER_KEYS.includes(key)) {
      parseErrors.push(`unknown frontmatter key "${key}"`)
      continue
    }

    if (seenKeys.has(key)) {
      parseErrors.push(`duplicate frontmatter key "${key}"`)
      continue
    }
    seenKeys.add(key)

    if (LIST_FRONTMATTER_KEYS.has(key)) {
      if (value.trim()) {
        parseErrors.push(`${key} must be a block list of "- item" lines`)
      }
      lists.set(key, [])
      activeListKey = key
      continue
    }

    fields.set(key, stripQuotes(value.trim()))
  }

  return { fields, lists, parseErrors }
}

function stripQuotes(value) {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1)
  }
  return value
}
