import { describe, expect, it } from 'vitest'

import {
  checkLinuxUpdateNotice,
  compareReleaseVersions,
  evaluateLinuxChangelog,
  isNewerRelease,
  LINUX_UPDATE_NOTICE_URL,
  LINUX_UPDATE_NOTICE_URL_ENV,
  linuxUpdateNoticeSource,
  linuxUpdateNoticeStatus,
  linuxUpdateNoticeUrl,
  parseReleaseVersion
} from './linux-update-notice'

function compare(a: string, b: string): number {
  const left = parseReleaseVersion(a)
  const right = parseReleaseVersion(b)
  if (!left || !right) throw new Error(`unparsable ${a} or ${b}`)
  return compareReleaseVersions(left, right)
}

function entry(version: string, platforms: string[] = ['windows', 'linux']) {
  return { version, platforms, channel: 'alpha', title: 't', summary: 's', highlights: ['h'] }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

describe('release version precedence', () => {
  it('orders cores numerically, not as strings', () => {
    expect(compare('0.10.0', '0.9.150')).toBeGreaterThan(0)
    expect(compare('0.9.119', '0.13.0')).toBeLessThan(0)
    expect(compare('1.0.0', '0.99.99')).toBeGreaterThan(0)
  })

  it('orders -alpha.N numerically and below the release', () => {
    expect(compare('0.14.0-alpha.10', '0.14.0-alpha.2')).toBeGreaterThan(0)
    expect(compare('0.14.0-alpha.1', '0.14.0')).toBeLessThan(0)
    expect(compare('0.14.0-alpha.1', '0.14.0-beta.1')).toBeLessThan(0)
    expect(compare('0.14.0-alpha', '0.14.0-alpha.1')).toBeLessThan(0)
    expect(compare('0.14.0-alpha.1', '0.14.0-alpha.1')).toBe(0)
  })

  it('refuses anything that is not a release version', () => {
    for (const bad of ['', 'latest', '0.14', 'v0.14.0', '0.14.0-', '0.14.0-alpha..1']) {
      expect(parseReleaseVersion(bad)).toBeNull()
    }
  })

  it('compares only the core against a build that reports no pre-release', () => {
    // The 0.14.0-alpha.1 AppImage reports 0.14.0.
    expect(isNewerRelease('0.15.0-alpha.1', '0.14.0')).toBe(true)
    expect(isNewerRelease('0.14.1-alpha.1', '0.14.0')).toBe(true)
    expect(isNewerRelease('0.14.0-alpha.1', '0.14.0')).toBe(false)
    expect(isNewerRelease('0.14.0-alpha.2', '0.14.0')).toBe(false)
    expect(isNewerRelease('0.13.0-alpha.1', '0.14.0')).toBe(false)
  })

  it('compares the full version against a build that reports its pre-release', () => {
    expect(isNewerRelease('0.14.0-alpha.2', '0.14.0-alpha.1')).toBe(true)
    expect(isNewerRelease('0.14.0-alpha.1', '0.14.0-alpha.1')).toBe(false)
    expect(isNewerRelease('garbage', '0.14.0')).toBe(false)
  })
})

describe('evaluateLinuxChangelog', () => {
  it('reports the newest published Linux release newer than the running build', () => {
    expect(
      evaluateLinuxChangelog(
        {
          entries: [
            entry('0.16.0-beta.1', ['macos']),
            entry('0.15.0-alpha.1'),
            entry('0.15.1-alpha.1', ['linux']),
            entry('0.14.0-alpha.1')
          ]
        },
        '0.14.0'
      )
    ).toEqual({ kind: 'newer', version: '0.15.1-alpha.1' })
  })

  it('is current only when the running Linux line is listed and nothing is newer', () => {
    expect(
      evaluateLinuxChangelog(
        { entries: [entry('0.14.0-beta.1', ['macos']), entry('0.14.0-alpha.1')] },
        '0.14.0'
      )
    ).toEqual({ kind: 'current' })
  })

  it('never claims "latest" when the changelog lists no Linux release for this line', () => {
    // Today: Linux entries are withheld, only macOS and Windows are public.
    expect(
      evaluateLinuxChangelog(
        { entries: [entry('0.14.0-beta.1', ['macos']), entry('0.9.91-alpha.1', ['windows'])] },
        '0.14.0'
      )
    ).toEqual({ kind: 'unknown' })
    expect(evaluateLinuxChangelog({ entries: [] }, '0.14.0')).toEqual({ kind: 'unknown' })
  })

  it('never notices a macOS-only or Windows-only release', () => {
    expect(
      evaluateLinuxChangelog(
        { entries: [entry('0.20.0-beta.1', ['macos']), entry('0.20.0-alpha.1', ['windows'])] },
        '0.14.0'
      )
    ).toEqual({ kind: 'unknown' })
  })

  it('skips malformed entries and answers', () => {
    expect(
      evaluateLinuxChangelog(
        {
          entries: [
            null,
            'x',
            { version: 15, platforms: ['linux'] },
            { version: '0.99.0-alpha.1', platforms: 'linux' },
            entry('not-a-version'),
            entry('0.15.0-alpha.1')
          ]
        },
        '0.14.0'
      )
    ).toEqual({ kind: 'newer', version: '0.15.0-alpha.1' })
    expect(evaluateLinuxChangelog(null, '0.14.0')).toEqual({ kind: 'unknown' })
    expect(evaluateLinuxChangelog({ entries: 'nope' }, '0.14.0')).toEqual({ kind: 'unknown' })
    expect(evaluateLinuxChangelog({ entries: [entry('0.15.0-alpha.1')] }, 'dev')).toEqual({
      kind: 'unknown'
    })
  })
})

describe('linuxUpdateNoticeUrl', () => {
  it('asks only for the running line on, keeping its own entries', () => {
    expect(linuxUpdateNoticeUrl(LINUX_UPDATE_NOTICE_URL, '0.14.0')).toBe(
      'https://www.videorc.com/api/changelog?since=0.14.0-alpha.0'
    )
    expect(linuxUpdateNoticeUrl('http://127.0.0.1:4100/api/changelog', '0.14.0-alpha.3')).toBe(
      'http://127.0.0.1:4100/api/changelog?since=0.14.0-alpha.0'
    )
  })
})

describe('linuxUpdateNoticeSource', () => {
  it('always asks videorc.com from a packaged build, whatever the environment says', () => {
    expect(
      linuxUpdateNoticeSource({ [LINUX_UPDATE_NOTICE_URL_ENV]: 'http://evil.test/' }, true)
    ).toBe(LINUX_UPDATE_NOTICE_URL)
  })

  it('checks a dev build only against an explicit local endpoint', () => {
    expect(linuxUpdateNoticeSource({}, false)).toBeNull()
    expect(linuxUpdateNoticeSource({ [LINUX_UPDATE_NOTICE_URL_ENV]: ' ' }, false)).toBeNull()
    expect(
      linuxUpdateNoticeSource(
        { [LINUX_UPDATE_NOTICE_URL_ENV]: 'http://127.0.0.1:4100/api/changelog' },
        false
      )
    ).toBe('http://127.0.0.1:4100/api/changelog')
  })
})

describe('checkLinuxUpdateNotice', () => {
  const sourceUrl = 'http://127.0.0.1:4100/api/changelog'

  it('reads a newer release from the endpoint', async () => {
    const requested: string[] = []
    const check = await checkLinuxUpdateNotice({
      sourceUrl,
      runningVersion: '0.14.0',
      fetchImpl: async (url) => {
        requested.push(url)
        return jsonResponse({ entries: [entry('0.15.0-alpha.1'), entry('0.14.0-alpha.1')] })
      }
    })
    expect(check).toEqual({ kind: 'newer', version: '0.15.0-alpha.1' })
    expect(requested).toEqual([`${sourceUrl}?since=0.14.0-alpha.0`])
  })

  it('stays quiet on 401, 404, 500, offline, a timeout and a non-JSON body', async () => {
    for (const status of [401, 404, 500]) {
      await expect(
        checkLinuxUpdateNotice({
          sourceUrl,
          runningVersion: '0.14.0',
          fetchImpl: async () => jsonResponse({ entries: [entry('0.15.0-alpha.1')] }, status)
        })
      ).resolves.toEqual({ kind: 'unknown' })
    }
    await expect(
      checkLinuxUpdateNotice({
        sourceUrl,
        runningVersion: '0.14.0',
        fetchImpl: async () => {
          throw new TypeError('fetch failed: getaddrinfo ENOTFOUND www.videorc.com')
        }
      })
    ).resolves.toEqual({ kind: 'unknown' })
    await expect(
      checkLinuxUpdateNotice({
        sourceUrl,
        runningVersion: '0.14.0',
        timeoutMs: 5,
        fetchImpl: (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(init.signal.reason))
          })
      })
    ).resolves.toEqual({ kind: 'unknown' })
    await expect(
      checkLinuxUpdateNotice({
        sourceUrl,
        runningVersion: '0.14.0',
        fetchImpl: async () => new Response('<!DOCTYPE html>', { status: 200 })
      })
    ).resolves.toEqual({ kind: 'unknown' })
  })
})

describe('linuxUpdateNoticeStatus', () => {
  it('maps each outcome to the Settings status', () => {
    expect(linuxUpdateNoticeStatus({ kind: 'newer', version: '0.15.0-alpha.1' }, '0.14.0')).toEqual(
      { phase: 'download-available', version: '0.15.0-alpha.1' }
    )
    expect(linuxUpdateNoticeStatus({ kind: 'current' }, '0.14.0')).toEqual({
      phase: 'not-available',
      currentVersion: '0.14.0'
    })
    expect(linuxUpdateNoticeStatus({ kind: 'unknown' }, '0.14.0')).toEqual({
      phase: 'unsupported',
      reason: 'linux-version-unknown'
    })
  })
})
