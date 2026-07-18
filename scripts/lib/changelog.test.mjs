import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  buildChangelogJson,
  compareVersions,
  findChangelogEntry,
  findChangelogEntryForPackageVersion,
  loadChangelogEntries,
  mergeChangelogDocuments,
  parseChangelogEntry,
  requireChangelogEntryForRelease,
  sortEntriesNewestFirst
} from './changelog.mjs'

function validEntryMarkdown(overrides = {}) {
  const version = overrides.version ?? '0.9.2-beta.1'
  const date = overrides.date ?? '2026-07-01'
  const channel = overrides.channel ?? 'beta'
  const platformLines = Object.hasOwn(overrides, 'platforms')
    ? ['platforms:', ...overrides.platforms.map((platform) => `  - ${platform}`)]
    : []
  return [
    '---',
    `version: ${version}`,
    `date: ${date}`,
    `channel: ${channel}`,
    ...platformLines,
    'title: Camera and microphone fixed in the installed app',
    'summary: The 0.9.1 capture bug is fixed and delivered through the in-app updater.',
    'highlights:',
    '  - Camera and mic now work in the installed app.',
    '  - First release delivered through the in-app updater.',
    '---',
    '',
    'Body text for users.'
  ].join('\n')
}

describe('parseChangelogEntry', () => {
  it('parses a valid entry into structured fields', () => {
    const entry = parseChangelogEntry(validEntryMarkdown(), { filename: '0.9.2-beta.1.md' })

    assert.deepEqual(entry, {
      version: '0.9.2-beta.1',
      date: '2026-07-01',
      channel: 'beta',
      platforms: ['macos'],
      title: 'Camera and microphone fixed in the installed app',
      summary: 'The 0.9.1 capture bug is fixed and delivered through the in-app updater.',
      highlights: [
        'Camera and mic now work in the installed app.',
        'First release delivered through the in-app updater.'
      ],
      body: 'Body text for users.'
    })
  })

  it('parses an explicit Windows Alpha entry', () => {
    const entry = parseChangelogEntry(
      validEntryMarkdown({
        version: '0.10.0-alpha.1',
        channel: 'alpha',
        platforms: ['windows']
      }),
      { filename: '0.10.0-alpha.1.md' }
    )

    assert.equal(entry.channel, 'alpha')
    assert.deepEqual(entry.platforms, ['windows'])
  })

  it('rejects a version that does not match the filename', () => {
    assert.throws(
      () => parseChangelogEntry(validEntryMarkdown(), { filename: '0.9.1-beta.1.md' }),
      /must match the filename "0\.9\.1-beta\.1"/
    )
  })

  it('rejects malformed versions, dates, and channels', () => {
    assert.throws(
      () => parseChangelogEntry(validEntryMarkdown({ version: 'v0.9' }), { filename: 'v0.9.md' }),
      /version must look like/
    )
    assert.throws(
      () =>
        parseChangelogEntry(validEntryMarkdown({ date: '2026-13-99' }), {
          filename: '0.9.2-beta.1.md'
        }),
      /date must be a valid YYYY-MM-DD/
    )
    assert.throws(
      () =>
        parseChangelogEntry(validEntryMarkdown({ channel: 'nightly' }), {
          filename: '0.9.2-beta.1.md'
        }),
      /channel must be one of alpha, beta, stable/
    )
    assert.throws(
      () =>
        parseChangelogEntry(validEntryMarkdown({ channel: 'alpha' }), {
          filename: '0.9.2-beta.1.md'
        }),
      /channel "alpha" must match version "0\.9\.2-beta\.1" \(expected "beta"\)/
    )
  })

  it('rejects empty, unsupported, and duplicate platform lists', () => {
    assert.throws(
      () =>
        parseChangelogEntry(validEntryMarkdown({ platforms: [] }), {
          filename: '0.9.2-beta.1.md'
        }),
      /platforms must contain at least one of macos, windows/
    )
    assert.throws(
      () =>
        parseChangelogEntry(validEntryMarkdown({ platforms: ['linux'] }), {
          filename: '0.9.2-beta.1.md'
        }),
      /platforms must contain only macos, windows/
    )
    assert.throws(
      () =>
        parseChangelogEntry(validEntryMarkdown({ platforms: ['windows', 'windows'] }), {
          filename: '0.9.2-beta.1.md'
        }),
      /platforms must not contain duplicates/
    )
  })

  it('rejects unknown frontmatter keys and missing fences fail-closed', () => {
    const withUnknownKey = validEntryMarkdown().replace(
      'channel: beta',
      'channel: beta\ninternal: secret gate name'
    )
    assert.throws(
      () => parseChangelogEntry(withUnknownKey, { filename: '0.9.2-beta.1.md' }),
      /unknown frontmatter key "internal"/
    )
    assert.throws(
      () => parseChangelogEntry('# no frontmatter', { filename: '0.9.2-beta.1.md' }),
      /must start with a --- frontmatter fence/
    )
  })

  it('rejects empty highlights and empty bodies', () => {
    const withoutHighlights = validEntryMarkdown()
      .split('\n')
      .filter((line) => !line.includes('- ') && !line.startsWith('highlights'))
      .join('\n')
    assert.throws(
      () => parseChangelogEntry(withoutHighlights, { filename: '0.9.2-beta.1.md' }),
      /highlights must contain 1-6 bullets/
    )

    const withoutBody = validEntryMarkdown().replace('Body text for users.', '')
    assert.throws(
      () => parseChangelogEntry(withoutBody, { filename: '0.9.2-beta.1.md' }),
      /body must not be empty/
    )
  })
})

describe('version + date ordering', () => {
  it('orders alpha below beta below stable, then by pre-release number', () => {
    assert.ok(compareVersions('1.0.0', '1.0.0-beta.2') > 0)
    assert.ok(compareVersions('1.0.0-beta.1', '1.0.0-alpha.9') > 0)
    assert.ok(compareVersions('1.0.0-alpha.9', '1.0.0-beta.1') < 0)
    assert.ok(compareVersions('1.0.0-alpha.1', '1.0.0-alpha.2') < 0)
    assert.ok(compareVersions('1.0.0-beta.1', '1.0.0-beta.2') < 0)
    assert.ok(compareVersions('0.10.0-beta.1', '0.9.2-beta.1') > 0)
    assert.equal(compareVersions('0.9.2-beta.1', '0.9.2-beta.1'), 0)
  })

  it('sorts entries newest-first by date, then version', () => {
    const entries = [
      { version: '0.9.0-beta.1', date: '2026-06-22' },
      { version: '0.9.2-alpha.1', date: '2026-07-01' },
      { version: '0.9.2-beta.1', date: '2026-07-01' },
      { version: '0.9.2', date: '2026-07-01' }
    ]
    assert.deepEqual(
      sortEntriesNewestFirst(entries).map((entry) => entry.version),
      ['0.9.2', '0.9.2-beta.1', '0.9.2-alpha.1', '0.9.0-beta.1']
    )
  })
})

describe('release gate lookups', () => {
  const entries = [
    { version: '0.9.2-beta.1', date: '2026-07-01', platforms: ['macos', 'windows'] },
    { version: '0.9.1-beta.1', date: '2026-07-01', platforms: ['macos'] },
    { version: '1.0.0', date: '2026-08-01', platforms: ['macos'] }
  ]

  it('finds an entry by exact releaseId', () => {
    assert.equal(findChangelogEntry(entries, '0.9.2-beta.1')?.version, '0.9.2-beta.1')
    assert.equal(findChangelogEntry(entries, '0.9.3-beta.1'), null)
  })

  it('matches a bare package version to its own pre-releases only', () => {
    assert.equal(findChangelogEntryForPackageVersion(entries, '0.9.2')?.version, '0.9.2-beta.1')
    assert.equal(findChangelogEntryForPackageVersion(entries, '1.0.0')?.version, '1.0.0')
    assert.equal(findChangelogEntryForPackageVersion(entries, '0.9'), null)
    assert.equal(findChangelogEntryForPackageVersion(entries, '0.9.3'), null)
  })

  it('fails closed on a missing entry unless skip is set', () => {
    assert.throws(
      () => requireChangelogEntryForRelease(entries, '0.9.3-beta.1'),
      /No changelog entry for release 0\.9\.3-beta\.1.*VIDEORC_RELEASE_SKIP_CHANGELOG/s
    )
    assert.deepEqual(requireChangelogEntryForRelease(entries, '0.9.3-beta.1', { skip: true }), {
      entry: null,
      skipped: true
    })
    assert.equal(
      requireChangelogEntryForRelease(entries, '0.9.2-beta.1').entry.version,
      '0.9.2-beta.1'
    )
  })

  it('requires an explicit Windows platform for Windows release gates', () => {
    assert.equal(
      requireChangelogEntryForRelease(entries, '0.9.2-beta.1', {
        requiredPlatform: 'windows'
      }).entry.version,
      '0.9.2-beta.1'
    )
    assert.throws(
      () =>
        requireChangelogEntryForRelease(entries, '0.9.1-beta.1', {
          requiredPlatform: 'windows'
        }),
      /must explicitly include platform "windows"/
    )
  })
})

describe('loadChangelogEntries + buildChangelogJson', () => {
  it('loads a directory, skips README.md, and emits the JSON document', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'videorc-changelog-'))
    await writeFile(join(directory, 'README.md'), '# not an entry')
    await writeFile(join(directory, '0.9.2-beta.1.md'), validEntryMarkdown())
    await writeFile(
      join(directory, '0.9.1-beta.1.md'),
      validEntryMarkdown({ version: '0.9.1-beta.1', date: '2026-07-01' })
    )

    const entries = await loadChangelogEntries(directory)
    const document = buildChangelogJson(entries, { generatedAt: '2026-07-02T00:00:00.000Z' })

    assert.equal(document.schemaVersion, 1)
    assert.equal(document.generatedAt, '2026-07-02T00:00:00.000Z')
    assert.deepEqual(
      document.entries.map((entry) => entry.version),
      ['0.9.2-beta.1', '0.9.1-beta.1']
    )
    assert.deepEqual(
      document.entries.map((entry) => entry.platforms),
      [['macos'], ['macos']]
    )
  })

  it('aggregates failures across files instead of stopping at the first', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'videorc-changelog-'))
    await writeFile(join(directory, '0.9.1-beta.1.md'), '# no frontmatter')
    await writeFile(join(directory, '0.9.2-beta.1.md'), validEntryMarkdown({ channel: 'nightly' }))

    await assert.rejects(loadChangelogEntries(directory), (error) => {
      assert.match(error.message, /0\.9\.1-beta\.1\.md/)
      assert.match(error.message, /0\.9\.2-beta\.1\.md/)
      return true
    })
  })
})

describe('mergeChangelogDocuments', () => {
  const generatedAt = '2026-07-18T12:00:00.000Z'
  const localWindows = parseChangelogEntry(
    validEntryMarkdown({
      channel: 'alpha',
      date: '2026-07-18',
      platforms: ['windows'],
      version: '0.10.0-alpha.1'
    }),
    { filename: '0.10.0-alpha.1.md' }
  )
  const remoteMac = parseChangelogEntry(validEntryMarkdown(), {
    filename: '0.9.2-beta.1.md'
  })

  it('preserves remote-only releases while adding trusted local entries', () => {
    const document = mergeChangelogDocuments({
      generatedAt,
      localEntries: [localWindows],
      remoteDocument: buildChangelogJson([remoteMac], {
        generatedAt: '2026-07-17T00:00:00.000Z'
      })
    })

    assert.deepEqual(
      document.entries.map((entry) => entry.version),
      ['0.10.0-alpha.1', '0.9.2-beta.1']
    )
  })

  it('normalizes legacy macOS entries and rejects conflicting published content', () => {
    const legacyRemote = {
      schemaVersion: 1,
      generatedAt: '2026-07-17T00:00:00.000Z',
      entries: [{ ...remoteMac, platforms: undefined }]
    }
    delete legacyRemote.entries[0].platforms
    assert.deepEqual(
      mergeChangelogDocuments({
        generatedAt,
        localEntries: [],
        remoteDocument: legacyRemote
      }).entries[0].platforms,
      ['macos']
    )

    assert.throws(
      () =>
        mergeChangelogDocuments({
          generatedAt,
          localEntries: [{ ...remoteMac, summary: 'Changed after publication.' }],
          remoteDocument: buildChangelogJson([remoteMac], {
            generatedAt: '2026-07-17T00:00:00.000Z'
          })
        }),
      /conflicts with the trusted repository entry/
    )
  })
})
