import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { ProviderOAuthCallbacks } from './provider-oauth-callbacks'
import { testSecurePersistenceCodec } from './secure-persistence-codec.test-helper'

type ProviderOAuthTestOptions = Omit<
  ConstructorParameters<typeof ProviderOAuthCallbacks>[1],
  'codec'
>

function createQueue(
  storePath: string,
  options: ProviderOAuthTestOptions = {}
): ProviderOAuthCallbacks {
  return new ProviderOAuthCallbacks(storePath, {
    codec: testSecurePersistenceCodec,
    ...options
  })
}

describe('ProviderOAuthCallbacks', () => {
  it('durably replays a callback until backend completion is acknowledged', () => {
    const storePath = join(mkdtempSync(join(tmpdir(), 'videorc-provider-oauth-')), 'callbacks.json')
    const queue = createQueue(storePath, { now: () => 1_000 })
    const url = 'videorc://oauth/callback?state=provider-state&code=single-use-code'

    const accepted = queue.accept(url)
    const durableContents = readFileSync(storePath, 'utf8')
    expect(queue.accept(url)).toEqual(accepted)
    expect(createQueue(storePath, { now: () => 1_001 }).pending()).toEqual([accepted])
    if (process.platform !== 'win32') expect(statSync(storePath).mode & 0o777).toBe(0o600)
    expect(JSON.parse(durableContents)).toMatchObject({ version: 2, sealed: expect.any(String) })
    expect(durableContents).not.toContain('single-use-code')
    expect(durableContents).not.toContain('videorc://oauth/callback')

    expect(queue.acknowledge(accepted.id)).toBe(true)
    expect(queue.pending()).toEqual([])
  })

  it('keeps callbacks through a reconnect window and expires them on a bounded TTL', () => {
    let nowMs = 1_000
    const storePath = join(mkdtempSync(join(tmpdir(), 'videorc-provider-oauth-')), 'callbacks.json')
    const queue = createQueue(storePath, { now: () => nowMs, ttlMs: 100 })
    queue.accept('videorc://oauth/callback?state=provider-state&error=access_denied')

    nowMs = 1_099
    expect(queue.pending()).toHaveLength(1)
    nowMs = 1_101
    expect(queue.pending()).toEqual([])
  })

  it('rejects malformed authority, fragments, and missing state/result', () => {
    const storePath = join(mkdtempSync(join(tmpdir(), 'videorc-provider-oauth-')), 'callbacks.json')
    const queue = createQueue(storePath)

    for (const url of [
      'https://attacker.example/callback?state=provider-state&code=x',
      'videorc://oauth/callback?state=provider-state&code=x#fragment',
      'videorc://oauth/callback?code=x',
      'videorc://oauth/callback?state=provider-state'
    ]) {
      expect(() => queue.accept(url)).toThrow()
    }
  })

  it('keeps an acknowledgement pending until its disk removal commits', () => {
    const directory = mkdtempSync(join(tmpdir(), 'videorc-provider-oauth-'))
    const storePath = join(directory, 'callbacks.json')
    const queue = createQueue(storePath)
    const accepted = queue.accept(
      'videorc://oauth/callback?state=provider-state&code=single-use-code'
    )
    const backupDirectory = `${directory}-backup`
    renameSync(directory, backupDirectory)
    writeFileSync(directory, 'blocks callback-store directory recreation')

    expect(() => queue.acknowledge(accepted.id)).toThrow()

    rmSync(directory)
    renameSync(backupDirectory, directory)
    expect(queue.pending()).toEqual([accepted])
    expect(queue.acknowledge(accepted.id)).toBe(true)
    expect(createQueue(storePath).pending()).toEqual([])
  })

  it('does not mutate or evict the live queue when accepting a callback cannot commit', () => {
    const directory = mkdtempSync(join(tmpdir(), 'videorc-provider-oauth-'))
    const storePath = join(directory, 'callbacks.json')
    const queue = createQueue(storePath, { maxCallbacks: 2 })
    const durable = queue.accept(
      'videorc://oauth/callback?state=provider-state-1&code=durable-code'
    )
    const backupDirectory = `${directory}-backup`
    renameSync(directory, backupDirectory)
    writeFileSync(directory, 'blocks callback-store directory recreation')

    expect(() =>
      queue.accept('videorc://oauth/callback?state=provider-state-2&code=uncommitted-code')
    ).toThrow()

    rmSync(directory)
    renameSync(backupDirectory, directory)
    expect(queue.pending()).toEqual([durable])
    expect(createQueue(storePath).pending()).toEqual([durable])
  })

  it('rejects a new callback when every durable queue slot is still unacknowledged', () => {
    const storePath = join(mkdtempSync(join(tmpdir(), 'videorc-provider-oauth-')), 'callbacks.json')
    const queue = createQueue(storePath, { maxCallbacks: 1 })
    const durable = queue.accept(
      'videorc://oauth/callback?state=provider-state-1&code=durable-code'
    )

    expect(() =>
      queue.accept('videorc://oauth/callback?state=provider-state-2&code=second-code')
    ).toThrow('Provider OAuth callback queue is full')
    expect(queue.pending()).toEqual([durable])
    expect(createQueue(storePath).pending()).toEqual([durable])
  })

  it('blocks recovery without replacing a malformed durable store or exposing its contents', () => {
    const storePath = join(mkdtempSync(join(tmpdir(), 'videorc-provider-oauth-')), 'callbacks.json')
    const malformed =
      '{"version":1,"callbacks":[{"url":"videorc://oauth/callback?state=secret-state&code=secret-code"}'
    writeFileSync(storePath, malformed)

    let message = ''
    try {
      createQueue(storePath)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    expect(message).toBe('Provider OAuth callback store could not be read safely.')
    expect(message).not.toContain('secret-code')
    expect(readFileSync(storePath, 'utf8')).toBe(malformed)
  })

  it('blocks recovery when the durable store version is unsupported', () => {
    const storePath = join(mkdtempSync(join(tmpdir(), 'videorc-provider-oauth-')), 'callbacks.json')
    const unsupported = JSON.stringify({ version: 99, callbacks: [] })
    writeFileSync(storePath, unsupported)

    expect(() => createQueue(storePath)).toThrow(
      'Provider OAuth callback store could not be read safely.'
    )
    expect(readFileSync(storePath, 'utf8')).toBe(unsupported)
  })

  it('blocks recovery instead of dropping an invalid durable callback entry', () => {
    const storePath = join(mkdtempSync(join(tmpdir(), 'videorc-provider-oauth-')), 'callbacks.json')
    const invalidEntry = JSON.stringify({
      version: 1,
      callbacks: [
        {
          id: 'not-the-callback-digest',
          url: 'videorc://oauth/callback?state=provider-state&code=single-use-code',
          state: 'provider-state',
          receivedAtMs: 1_000,
          expiresAtMs: 601_000
        }
      ]
    })
    writeFileSync(storePath, invalidEntry)

    expect(() => createQueue(storePath, { now: () => 1_001 })).toThrow(
      'Provider OAuth callback store could not be read safely.'
    )
    expect(readFileSync(storePath, 'utf8')).toBe(invalidEntry)
  })

  it('treats only a missing durable store as an empty queue', () => {
    const missingStorePath = join(
      mkdtempSync(join(tmpdir(), 'videorc-provider-oauth-')),
      'missing-callbacks.json'
    )
    expect(createQueue(missingStorePath).pending()).toEqual([])

    const unreadableStorePath = mkdtempSync(join(tmpdir(), 'videorc-provider-oauth-directory-'))
    expect(() => createQueue(unreadableStorePath)).toThrow(
      'Provider OAuth callback store could not be read safely.'
    )
    expect(statSync(unreadableStorePath).isDirectory()).toBe(true)
  })

  it('atomically migrates a valid plaintext v1 callback store', () => {
    const storePath = join(mkdtempSync(join(tmpdir(), 'videorc-provider-oauth-')), 'callbacks.json')
    const state = 'provider-state'
    const code = 'single-use-code'
    const url = `videorc://oauth/callback?state=${state}&code=${code}`
    const id = createHash('sha256').update(`${state}\n${code}\n`, 'utf8').digest('base64url')
    writeFileSync(
      storePath,
      JSON.stringify({
        version: 1,
        callbacks: [{ id, url, state, receivedAtMs: 1_000, expiresAtMs: 601_000 }]
      })
    )

    const queue = createQueue(storePath, { now: () => 1_001 })
    const migrated = readFileSync(storePath, 'utf8')

    expect(queue.pending()).toHaveLength(1)
    expect(JSON.parse(migrated)).toMatchObject({ version: 2, sealed: expect.any(String) })
    expect(migrated).not.toContain(code)
    expect(migrated).not.toContain(url)
  })

  it('does not replace a plaintext migration source when sealing fails', () => {
    const storePath = join(mkdtempSync(join(tmpdir(), 'videorc-provider-oauth-')), 'callbacks.json')
    const plaintext = JSON.stringify({ version: 1, callbacks: [] })
    writeFileSync(storePath, plaintext)

    expect(
      () =>
        new ProviderOAuthCallbacks(storePath, {
          codec: {
            seal: () => {
              throw new Error('fixture seal failure')
            },
            unseal: () => ''
          }
        })
    ).toThrow('Provider OAuth callback store could not be read safely.')
    expect(readFileSync(storePath, 'utf8')).toBe(plaintext)
  })

  it('expires a callback on disk from the main-owned timer without a pending read', () => {
    let nowMs = 1_000
    const scheduled: Array<() => void> = []
    const storePath = join(mkdtempSync(join(tmpdir(), 'videorc-provider-oauth-')), 'callbacks.json')
    const queue = createQueue(storePath, {
      now: () => nowMs,
      ttlMs: 100,
      schedule: (callback) => {
        scheduled.push(callback)
        return 1
      },
      cancel: () => undefined
    })
    queue.accept('videorc://oauth/callback?state=provider-state&code=single-use-code')

    nowMs = 1_101
    expect(scheduled).not.toHaveLength(0)
    scheduled.at(-1)!()

    expect(createQueue(storePath, { now: () => nowMs }).pending()).toEqual([])
  })
})
