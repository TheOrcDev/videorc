import { describe, expect, it, vi } from 'vitest'

import { parseGolemDeepLink, runGolemDeepLink } from './golem-deep-link'

const AVATAR = '7c9e6679-7425-40de-944b-e07fc1ee9a51'

describe('parseGolemDeepLink (plan 170 D18)', () => {
  it('routes videorc://golem and videorc://golem/library, with an optional alive id', () => {
    for (const url of [
      'videorc://golem',
      'videorc://golem/',
      'videorc://golem/library',
      'videorc://golem/library/'
    ]) {
      expect(parseGolemDeepLink(url)).toEqual({ alive: null })
    }
    expect(parseGolemDeepLink(`videorc://golem?alive=${AVATAR}`)).toEqual({ alive: AVATAR })
    expect(parseGolemDeepLink('videorc://golem/library?alive=official:orc')).toEqual({
      alive: 'official:orc'
    })
    // An alive that is not a library id is dropped; the tab still opens.
    for (const alive of ['official:dragon', AVATAR.toUpperCase(), '../x', '']) {
      expect(parseGolemDeepLink(`videorc://golem?alive=${encodeURIComponent(alive)}`)).toEqual({
        alive: null
      })
    }
  })

  it('ignores every other host, path and scheme', () => {
    for (const url of [
      'videorc://account/callback?code=x',
      'videorc://oauth/callback',
      'videorc://golem/settings',
      'videorc://golem/library/extra',
      'videorc://golems',
      'https://golem/library',
      'videorc://user@golem',
      'videorc://golem:8080',
      'not a url'
    ]) {
      expect(parseGolemDeepLink(url)).toBeNull()
    }
  })
})

describe('runGolemDeepLink', () => {
  function deps(states: Array<Record<string, unknown>>) {
    const shown: boolean[] = []
    const calls: Array<[string, Record<string, unknown>]> = []
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      calls.push([method, params])
      if (method === 'cohost.library.get') return states.length > 1 ? states.shift() : states[0]
      return { accepted: true }
    })
    return {
      shown,
      calls,
      deps: {
        showGolemTab: (openCreator: boolean) => shown.push(openCreator),
        request: request as never,
        sleep: async () => undefined,
        log: vi.fn()
      }
    }
  }

  it('opens the Golem tab and syncs at once', async () => {
    const run = deps([])
    expect(await runGolemDeepLink({ alive: null }, run.deps)).toBe('synced')
    expect(run.shown).toEqual([false])
    expect(run.calls).toEqual([['cohost.library.sync', { reason: 'deep-link' }]])
  })

  it('uses the alive avatar after the sync, then opens the creator once it is worn', async () => {
    const run = deps([
      { activeAvatarId: 'official:golem', busy: { kind: 'sync' } },
      { activeAvatarId: 'official:golem', busy: { kind: 'use', avatarId: AVATAR } },
      { activeAvatarId: AVATAR, busy: null }
    ])
    expect(await runGolemDeepLink({ alive: AVATAR }, run.deps, { pollMs: 1 })).toBe('opened')
    expect(run.calls.slice(0, 2)).toEqual([
      ['cohost.library.sync', { reason: 'deep-link' }],
      ['cohost.library.use', { avatarId: AVATAR }]
    ])
    expect(run.shown).toEqual([false, true])
  })

  it('never opens the creator when the use fails or takes too long', async () => {
    const failed = deps([
      { activeAvatarId: null, busy: { kind: 'use', avatarId: AVATAR } },
      { activeAvatarId: null, busy: null, error: { code: 'network', message: 'offline' } }
    ])
    expect(await runGolemDeepLink({ alive: AVATAR }, failed.deps, { pollMs: 1 })).toBe('failed')
    expect(failed.shown).toEqual([false])
    const slow = deps([{ activeAvatarId: null, busy: { kind: 'sync' } }])
    expect(await runGolemDeepLink({ alive: AVATAR }, slow.deps, { pollMs: 1, timeoutMs: 5 })).toBe(
      'failed'
    )
    expect(slow.shown).toEqual([false])
  })
})
