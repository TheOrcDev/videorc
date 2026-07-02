import { describe, expect, it } from 'vitest'

import {
  fetchChangelogEntries,
  formatChangelogVersion,
  parseChangelogEntries,
  resolveWhatsNewAction
} from './whats-new'

const entry = (version: string): Record<string, unknown> => ({
  version,
  date: '2026-07-01',
  channel: 'beta',
  title: `Title ${version}`,
  summary: `Summary ${version}.`,
  highlights: [`Highlight ${version}.`],
  body: 'ignored by the app'
})

describe('resolveWhatsNewAction', () => {
  it('stays idle without a version (runtime info not loaded yet)', () => {
    expect(resolveWhatsNewAction({ version: undefined, lastSeen: null })).toBe('idle')
  })

  it('initializes silently on the first run with the feature', () => {
    expect(resolveWhatsNewAction({ version: '0.9.2', lastSeen: null })).toBe('initialize')
  })

  it('checks the API only when the version changed since last seen', () => {
    expect(resolveWhatsNewAction({ version: '0.9.2', lastSeen: '0.9.1' })).toBe('check')
    expect(resolveWhatsNewAction({ version: '0.9.2', lastSeen: '0.9.2' })).toBe('idle')
  })
})

describe('parseChangelogEntries', () => {
  it('keeps valid entries, drops malformed ones, and strips unknown fields', () => {
    const parsed = parseChangelogEntries({
      entries: [
        entry('0.9.2-beta.1'),
        { ...entry('0.9.1-beta.1'), highlights: [] },
        { version: '', title: 'nope' },
        'garbage'
      ]
    })

    expect(parsed.map((item) => item.version)).toEqual(['0.9.2-beta.1'])
    expect(parsed[0]).not.toHaveProperty('body')
  })

  it('returns [] for non-document payloads', () => {
    expect(parseChangelogEntries(null)).toEqual([])
    expect(parseChangelogEntries({ entries: 'nope' })).toEqual([])
  })
})

describe('fetchChangelogEntries', () => {
  it('passes since through and parses the payload', async () => {
    let requestedUrl: string | null = null
    const entries = await fetchChangelogEntries({
      since: '0.9.1',
      fetchImpl: (async (input: RequestInfo | URL) => {
        requestedUrl = String(input)
        return new Response(JSON.stringify({ entries: [entry('0.9.2-beta.1')] }), { status: 200 })
      }) as typeof fetch
    })

    expect(entries?.map((item) => item.version)).toEqual(['0.9.2-beta.1'])
    expect(requestedUrl).toContain('/api/changelog?since=0.9.1')
  })

  it('returns null (retry later) on HTTP errors and network failures', async () => {
    expect(
      await fetchChangelogEntries({
        fetchImpl: (async () => new Response('nope', { status: 503 })) as typeof fetch
      })
    ).toBeNull()
    expect(
      await fetchChangelogEntries({
        fetchImpl: (async () => {
          throw new Error('offline')
        }) as typeof fetch
      })
    ).toBeNull()
  })

  it('distinguishes a good empty answer from a failure', async () => {
    expect(
      await fetchChangelogEntries({
        fetchImpl: (async () =>
          new Response(JSON.stringify({ entries: [] }), { status: 200 })) as typeof fetch
      })
    ).toEqual([])
  })
})

describe('formatChangelogVersion', () => {
  it('formats releaseIds for the dialog title', () => {
    expect(formatChangelogVersion('0.9.2-beta.1')).toBe('0.9.2 Beta 1')
    expect(formatChangelogVersion('1.0.0')).toBe('1.0.0')
  })
})
