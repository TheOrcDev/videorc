import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { AccountSignInTransactions } from './account-sign-in-transactions'
import { testSecurePersistenceCodec } from './secure-persistence-codec.test-helper'

type AccountSignInTestOptions = Omit<
  ConstructorParameters<typeof AccountSignInTransactions>[1],
  'codec'
>

type TestAccountSignInTransactions = Omit<AccountSignInTransactions, 'begin'> & {
  begin: (authorizeUrl: string, intentGeneration?: number) => string
}

function createTransactions(
  storePath: string,
  options: AccountSignInTestOptions = {}
): TestAccountSignInTransactions {
  const transactions = new AccountSignInTransactions(storePath, {
    codec: testSecurePersistenceCodec,
    ...options
  })
  const begin = transactions.begin.bind(transactions)
  return Object.assign(transactions, {
    begin: (authorizeUrl: string, intentGeneration = 1) => begin(authorizeUrl, intentGeneration)
  })
}

function deterministicRandom(values: string[]): (bytes: number) => Buffer {
  return () => {
    const value = values.shift()
    if (!value) {
      throw new Error('No deterministic random value remained.')
    }
    return Buffer.alloc(32, value)
  }
}

function fakeAuthorizationCode(expiresAtMs: number, fill = 'c'): string {
  return [
    'v3',
    String(expiresAtMs),
    Buffer.alloc(12, 'n').toString('base64url'),
    Buffer.alloc(64, fill).toString('base64url'),
    Buffer.alloc(16, 't').toString('base64url')
  ].join('.')
}

function accountCallbackUrl(state: string, expiresAtMs = 181_000, fill = 'c'): string {
  return `videorc://account/callback?${new URLSearchParams({
    state,
    code: fakeAuthorizationCode(expiresAtMs, fill),
    code_expires_at_ms: String(expiresAtMs)
  }).toString()}`
}

describe('AccountSignInTransactions', () => {
  it('binds authorization to state and an S256 verifier without exposing the verifier', () => {
    const storePath = join(mkdtempSync(join(tmpdir(), 'videorc-account-auth-')), 'state.json')
    const transactions = createTransactions(storePath, {
      now: () => 1_000,
      random: deterministicRandom(['s', 'v'])
    })

    const authorization = new URL(
      transactions.begin('https://www.videorc.com/desktop/authorize/v2')
    )

    expect(authorization.searchParams.get('state')).toHaveLength(43)
    expect(authorization.searchParams.get('code_challenge')).toHaveLength(43)
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorization.searchParams.has('verifier')).toBe(false)
  })

  it('rejects an account callback that was not initiated by this desktop', () => {
    const storePath = join(mkdtempSync(join(tmpdir(), 'videorc-account-auth-')), 'state.json')
    const transactions = createTransactions(storePath, {
      now: () => 1_000,
      random: deterministicRandom(['s', 'v'])
    })
    transactions.begin('https://www.videorc.com/desktop/authorize/v2')

    expect(() =>
      transactions.accept(accountCallbackUrl(Buffer.alloc(32, 'x').toString('base64url')))
    ).toThrow(/active sign-in/)
  })

  it('rejects callback credentials, ports, and fragments', () => {
    const storePath = join(mkdtempSync(join(tmpdir(), 'videorc-account-auth-')), 'state.json')
    const transactions = createTransactions(storePath, {
      now: () => 1_000,
      random: deterministicRandom(['s', 'v'])
    })
    const authorization = new URL(
      transactions.begin('https://www.videorc.com/desktop/authorize/v2')
    )
    const state = authorization.searchParams.get('state')!
    const query = new URL(accountCallbackUrl(state)).searchParams.toString()

    for (const callback of [
      `videorc://user:password@account/callback?${query}`,
      `videorc://account:123/callback?${query}`,
      `videorc://account/callback?${query}#fragment`
    ]) {
      expect(() => transactions.accept(callback)).toThrow('Invalid desktop account callback')
    }
  })

  it('requires a bounded deep-link expiry that matches the authenticated code segment', () => {
    const storePath = join(mkdtempSync(join(tmpdir(), 'videorc-account-auth-')), 'state.json')
    const transactions = createTransactions(storePath, {
      now: () => 1_000,
      random: deterministicRandom(['s', 'v'])
    })
    const state = new URL(
      transactions.begin('https://www.videorc.com/desktop/authorize/v2')
    ).searchParams.get('state')!
    const mismatched = new URL(accountCallbackUrl(state, 181_000))
    mismatched.searchParams.set('code_expires_at_ms', '180999')

    expect(() => transactions.accept(mismatched.toString())).toThrow(/expiry did not match/)
    expect(() => transactions.accept(accountCallbackUrl(state, 999))).toThrow(/expired or too far/)
    expect(() => transactions.accept(accountCallbackUrl(state, 186_001))).toThrow(
      /expired or too far/
    )
    expect(transactions.pending()).toEqual([])
  })

  it('fails closed without replacing a persisted transaction with unsafe timestamps', () => {
    const storePath = join(mkdtempSync(join(tmpdir(), 'videorc-account-auth-')), 'state.json')
    const state = Buffer.alloc(32, 's').toString('base64url')
    const invalid = JSON.stringify({
      version: 1,
      transactions: [
        {
          state,
          verifier: Buffer.alloc(32, 'v').toString('base64url'),
          createdAtMs: Number.MAX_SAFE_INTEGER + 1,
          expiresAtMs: Number.MAX_SAFE_INTEGER + 1
        }
      ],
      callbacks: []
    })
    writeFileSync(storePath, invalid)

    expect(() => createTransactions(storePath, { now: () => 1_000 })).toThrow(
      'Desktop account sign-in store could not be read safely.'
    )
    expect(readFileSync(storePath, 'utf8')).toBe(invalid)
  })

  it('retains and replays a valid callback until explicit acknowledgement', () => {
    const storeDirectory = mkdtempSync(join(tmpdir(), 'videorc-account-auth-'))
    const storePath = join(storeDirectory, 'state.json')
    const transactions = createTransactions(storePath, {
      now: () => 1_000,
      random: deterministicRandom(['s', 'v'])
    })
    const authorization = new URL(
      transactions.begin('https://www.videorc.com/desktop/authorize/v2')
    )
    const state = authorization.searchParams.get('state')!
    const rawCallback = accountCallbackUrl(state)

    const accepted = transactions.accept(rawCallback)
    const duplicate = transactions.accept(rawCallback)
    const restored = createTransactions(storePath, { now: () => 1_000 })
    const durableContents = readFileSync(storePath, 'utf8')

    if (process.platform !== 'win32') {
      expect(statSync(storePath).mode & 0o777).toBe(0o600)
    }
    expect(readdirSync(storeDirectory).filter((name) => name.endsWith('.tmp'))).toEqual([])
    expect(duplicate.id).toBe(accepted.id)
    expect(new URL(accepted.url).searchParams.get('verifier')).toHaveLength(43)
    expect(JSON.parse(durableContents)).toMatchObject({ version: 2, sealed: expect.any(String) })
    expect(durableContents).not.toContain(Buffer.alloc(32, 'v').toString('base64url'))
    expect(durableContents).not.toContain(fakeAuthorizationCode(181_000))
    expect(durableContents).not.toContain('videorc://account/callback')
    expect(restored.pending()).toEqual([accepted])
    expect(restored.acknowledge(accepted.id)).toBe(true)
    expect(restored.pending()).toEqual([])
    expect(() => restored.accept(rawCallback)).toThrow(/active sign-in/)
  })

  it('keeps one code per state, rejects a different code, and retires the whole state on ACK', () => {
    const storePath = join(mkdtempSync(join(tmpdir(), 'videorc-account-auth-')), 'state.json')
    const transactions = createTransactions(storePath, {
      now: () => 1_000,
      random: deterministicRandom(['s', 'v'])
    })
    const authorization = new URL(
      transactions.begin('https://www.videorc.com/desktop/authorize/v2')
    )
    const state = authorization.searchParams.get('state')!
    const codeA = accountCallbackUrl(state, 181_000, 'a')
    const codeB = accountCallbackUrl(state, 181_000, 'b')

    const accepted = transactions.accept(codeA)
    expect(transactions.accept(codeA)).toEqual(accepted)
    expect(() => transactions.accept(codeB)).toThrow(/different pending code/)
    expect(transactions.pending()).toEqual([accepted])
    expect(transactions.acknowledge(accepted.id)).toBe(true)

    const restored = createTransactions(storePath, { now: () => 1_001 })
    expect(restored.pending()).toEqual([])
    expect(() => restored.accept(codeA)).toThrow(/active sign-in/)
    expect(() => restored.accept(codeB)).toThrow(/active sign-in/)
  })

  it('rejects durable bytes containing two callbacks for one state', () => {
    const storePath = join(mkdtempSync(join(tmpdir(), 'videorc-account-auth-')), 'state.json')
    const state = Buffer.alloc(32, 's').toString('base64url')
    const verifier = Buffer.alloc(32, 'v').toString('base64url')
    const callbackA = new URL(accountCallbackUrl(state, 181_000, 'a'))
    const callbackB = new URL(accountCallbackUrl(state, 181_000, 'b'))
    callbackA.searchParams.set('verifier', verifier)
    callbackB.searchParams.set('verifier', verifier)
    const invalid = JSON.stringify({
      version: 1,
      transactions: [{ state, verifier, createdAtMs: 1_000, expiresAtMs: 121_000 }],
      callbacks: [callbackA, callbackB].map((url) => ({
        id: createHash('sha256')
          .update(
            [state, url.searchParams.get('code'), url.searchParams.get('code_expires_at_ms')].join(
              '\n'
            )
          )
          .digest('base64url'),
        url: url.toString(),
        state,
        receivedAtMs: 1_000,
        expiresAtMs: 121_000
      }))
    })
    writeFileSync(storePath, invalid)

    expect(() => createTransactions(storePath, { now: () => 1_001 })).toThrow(
      'Desktop account sign-in store could not be read safely.'
    )
    expect(readFileSync(storePath, 'utf8')).toBe(invalid)
  })

  it('pins production authorization to the Videorc origin and rejects credentials', () => {
    const storePath = join(mkdtempSync(join(tmpdir(), 'videorc-account-auth-')), 'state.json')
    const transactions = createTransactions(storePath, {
      now: () => 1_000,
      random: deterministicRandom(['s', 'v'])
    })

    expect(() => transactions.begin('https://attacker.example/desktop/authorize/v2')).toThrow(
      /origin or path/
    )
    expect(() => transactions.begin('https://www.videorc.com/desktop/authorize')).toThrow(
      /origin or path/
    )
    expect(() =>
      transactions.begin('https://user:password@www.videorc.com/desktop/authorize/v2')
    ).toThrow(/origin or path/)
    expect(() => transactions.begin('http://localhost:3000/desktop/authorize/v2')).toThrow(
      /origin or path/
    )
  })

  it('allows an explicit loopback development origin without allowing remote HTTP', () => {
    const storePath = join(mkdtempSync(join(tmpdir(), 'videorc-account-auth-')), 'state.json')
    const transactions = createTransactions(storePath, {
      now: () => 1_000,
      random: deterministicRandom(['s', 'v']),
      allowLoopbackAuthorizeOrigin: true
    })

    expect(transactions.begin('http://localhost:3000/desktop/authorize/v2')).toContain(
      'http://localhost:3000/desktop/authorize/v2'
    )
    expect(() => transactions.begin('http://attacker.example/desktop/authorize/v2')).toThrow(
      /origin or path/
    )
  })

  it('preserves a full retry reserve after a nonzero handoff delay', () => {
    let nowMs = 1_000
    const storePath = join(mkdtempSync(join(tmpdir(), 'videorc-account-auth-')), 'state.json')
    const transactions = createTransactions(storePath, {
      now: () => nowMs,
      random: deterministicRandom(['s', 'v']),
      transactionTtlMs: 61_000
    })
    const authorization = new URL(
      transactions.begin('https://www.videorc.com/desktop/authorize/v2')
    )
    const state = authorization.searchParams.get('state')!
    nowMs = 61_000
    const accepted = transactions.accept(accountCallbackUrl(state, 181_000))

    expect(accepted).toMatchObject({
      receivedAtMs: 61_000,
      expiresAtMs: 181_000
    })
    nowMs = 180_999
    expect(transactions.pending()).toEqual([accepted])
    nowMs = 181_001
    expect(transactions.pending()).toEqual([])
    expect(() => transactions.accept(accountCallbackUrl(state, 181_000))).toThrow(/active sign-in/)
  })

  it('retires an early callback transaction with its callback instead of accepting a replay', () => {
    let nowMs = 1_000
    const storePath = join(mkdtempSync(join(tmpdir(), 'videorc-account-auth-')), 'state.json')
    const transactions = createTransactions(storePath, {
      now: () => nowMs,
      random: deterministicRandom(['s', 'v']),
      transactionTtlMs: 10_000,
      callbackTtlMs: 100
    })
    const authorization = new URL(
      transactions.begin('https://www.videorc.com/desktop/authorize/v2')
    )
    const state = authorization.searchParams.get('state')!
    const rawCallback = accountCallbackUrl(state)

    nowMs = 1_001
    transactions.accept(rawCallback)
    nowMs = 1_102

    expect(transactions.pending()).toEqual([])
    expect(() => transactions.accept(rawCallback)).toThrow(/active sign-in/)
    expect(createTransactions(storePath, { now: () => nowMs }).pending()).toEqual([])
  })

  it('makes a newer backend generation supersede every older transaction and callback', () => {
    const storePath = join(mkdtempSync(join(tmpdir(), 'videorc-account-auth-')), 'state.json')
    const transactions = createTransactions(storePath, {
      now: () => 1_000,
      random: deterministicRandom(['a', 'v', 'b', 'w'])
    })
    const stateA = new URL(
      transactions.begin('https://www.videorc.com/desktop/authorize/v2', 1)
    ).searchParams.get('state')!
    const callbackA = accountCallbackUrl(stateA)
    expect(transactions.accept(callbackA).intentGeneration).toBe(1)

    const stateB = new URL(
      transactions.begin('https://www.videorc.com/desktop/authorize/v2', 2)
    ).searchParams.get('state')!
    expect(transactions.pending()).toEqual([])
    expect(() => transactions.accept(callbackA)).toThrow(/active sign-in/)

    const callbackB = transactions.accept(accountCallbackUrl(stateB))
    expect(callbackB.intentGeneration).toBe(2)
    expect(createTransactions(storePath, { now: () => 1_001 }).pending()).toEqual([callbackB])
  })

  it('retires every pending callback durably for explicit sign-out', () => {
    const storePath = join(mkdtempSync(join(tmpdir(), 'videorc-account-auth-')), 'state.json')
    const transactions = createTransactions(storePath, {
      now: () => 1_000,
      random: deterministicRandom(['a', 'v'])
    })
    const state = new URL(
      transactions.begin('https://www.videorc.com/desktop/authorize/v2', 7)
    ).searchParams.get('state')!
    transactions.accept(accountCallbackUrl(state))

    expect(transactions.retireAll()).toBe(true)
    expect(transactions.pending()).toEqual([])
    expect(transactions.retireAll()).toBe(false)
    expect(createTransactions(storePath, { now: () => 1_001 }).pending()).toEqual([])
  })

  it('atomically retires a valid plaintext v1 store that has no backend generation', () => {
    const storePath = join(mkdtempSync(join(tmpdir(), 'videorc-account-auth-')), 'state.json')
    const state = Buffer.alloc(32, 's').toString('base64url')
    const verifier = Buffer.alloc(32, 'v').toString('base64url')
    writeFileSync(
      storePath,
      JSON.stringify({
        version: 1,
        transactions: [{ state, verifier, createdAtMs: 1_000, expiresAtMs: 601_000 }],
        callbacks: []
      })
    )

    const transactions = createTransactions(storePath, { now: () => 1_001 })
    const migrated = readFileSync(storePath, 'utf8')

    expect(transactions.pending()).toEqual([])
    expect(() => transactions.accept(accountCallbackUrl(state))).toThrow(/active sign-in/)
    expect(JSON.parse(migrated)).toMatchObject({ version: 2, sealed: expect.any(String) })
    expect(migrated).not.toContain(verifier)
    expect(
      JSON.parse(testSecurePersistenceCodec.unseal(JSON.parse(migrated).sealed))
    ).toMatchObject({
      version: 3,
      transactions: [],
      callbacks: []
    })
  })

  it('retires protected v2 callbacks during generation-aware migration', () => {
    const storePath = join(mkdtempSync(join(tmpdir(), 'videorc-account-auth-')), 'state.json')
    const state = Buffer.alloc(32, 's').toString('base64url')
    const verifier = Buffer.alloc(32, 'v').toString('base64url')
    const callbackUrl = new URL(accountCallbackUrl(state))
    callbackUrl.searchParams.set('verifier', verifier)
    const callback = {
      id: createHash('sha256')
        .update(
          [
            state,
            callbackUrl.searchParams.get('code'),
            callbackUrl.searchParams.get('code_expires_at_ms')
          ].join('\n')
        )
        .digest('base64url'),
      url: callbackUrl.toString(),
      state,
      receivedAtMs: 1_000,
      expiresAtMs: 121_000
    }
    const sealed = testSecurePersistenceCodec.seal(
      JSON.stringify({
        kind: 'videorc-account-sign-in-transactions',
        version: 2,
        transactions: [{ state, verifier, createdAtMs: 1_000, expiresAtMs: 121_000 }],
        callbacks: [callback]
      })
    )
    writeFileSync(storePath, JSON.stringify({ version: 2, sealed }))

    const transactions = createTransactions(storePath, { now: () => 1_001 })
    expect(transactions.pending()).toEqual([])
    expect(() => transactions.accept(accountCallbackUrl(state))).toThrow(/active sign-in/)
    const migrated = JSON.parse(readFileSync(storePath, 'utf8')) as { sealed: string }
    expect(JSON.parse(testSecurePersistenceCodec.unseal(migrated.sealed))).toMatchObject({
      version: 3,
      transactions: [],
      callbacks: []
    })
  })

  it('does not overwrite a plaintext migration source when sealing fails', () => {
    const storePath = join(mkdtempSync(join(tmpdir(), 'videorc-account-auth-')), 'state.json')
    const plaintext = JSON.stringify({ version: 1, transactions: [], callbacks: [] })
    writeFileSync(storePath, plaintext)

    expect(
      () =>
        new AccountSignInTransactions(storePath, {
          codec: {
            seal: () => {
              throw new Error('fixture seal failure')
            },
            unseal: () => ''
          }
        })
    ).toThrow('Desktop account sign-in store could not be read safely.')
    expect(readFileSync(storePath, 'utf8')).toBe(plaintext)
  })

  it('treats only a missing store as empty and preserves unreadable or malformed input', () => {
    const directory = mkdtempSync(join(tmpdir(), 'videorc-account-auth-'))
    const malformedPath = join(directory, 'malformed.json')
    const malformed = '{"version":1,"transactions":[{"verifier":"raw-secret"}'
    writeFileSync(malformedPath, malformed)

    let message = ''
    try {
      createTransactions(malformedPath)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toBe('Desktop account sign-in store could not be read safely.')
    expect(message).not.toContain('raw-secret')
    expect(readFileSync(malformedPath, 'utf8')).toBe(malformed)

    expect(createTransactions(join(directory, 'missing.json')).pending()).toEqual([])
    const unreadablePath = mkdtempSync(join(tmpdir(), 'videorc-account-auth-directory-'))
    expect(() => createTransactions(unreadablePath)).toThrow(
      'Desktop account sign-in store could not be read safely.'
    )
    expect(statSync(unreadablePath).isDirectory()).toBe(true)
  })

  it('does not publish a transaction in memory when begin cannot commit', () => {
    const directory = mkdtempSync(join(tmpdir(), 'videorc-account-auth-'))
    const storePath = join(directory, 'state.json')
    const transactions = createTransactions(storePath, {
      now: () => 1_000,
      random: deterministicRandom(['s', 'v'])
    })
    const failedState = Buffer.alloc(32, 's').toString('base64url')
    const backupDirectory = `${directory}-backup`
    renameSync(directory, backupDirectory)
    writeFileSync(directory, 'blocks account-store directory recreation')

    expect(() => transactions.begin('https://www.videorc.com/desktop/authorize/v2')).toThrow()

    rmSync(directory)
    renameSync(backupDirectory, directory)
    expect(() => transactions.accept(accountCallbackUrl(failedState))).toThrow(/active sign-in/)
  })

  it('keeps live transaction and callback state behind the durable commit edge', () => {
    const directory = mkdtempSync(join(tmpdir(), 'videorc-account-auth-'))
    const storePath = join(directory, 'state.json')
    const transactions = createTransactions(storePath, {
      now: () => 1_000,
      random: deterministicRandom(['s', 'v'])
    })
    const authorization = new URL(
      transactions.begin('https://www.videorc.com/desktop/authorize/v2')
    )
    const state = authorization.searchParams.get('state')!
    const rawCallback = accountCallbackUrl(state)
    const backupDirectory = `${directory}-backup`
    renameSync(directory, backupDirectory)
    writeFileSync(directory, 'blocks account-store directory recreation')

    expect(() => transactions.accept(rawCallback)).toThrow()

    rmSync(directory)
    renameSync(backupDirectory, directory)
    expect(transactions.pending()).toEqual([])
    const accepted = transactions.accept(rawCallback)

    renameSync(directory, backupDirectory)
    writeFileSync(directory, 'blocks account-store directory recreation')
    expect(() => transactions.acknowledge(accepted.id)).toThrow()

    rmSync(directory)
    renameSync(backupDirectory, directory)
    expect(transactions.pending()).toEqual([accepted])
  })

  it('expires a callback on disk from the main-owned timer without a pending read', () => {
    let nowMs = 1_000
    const scheduled: Array<() => void> = []
    const storePath = join(mkdtempSync(join(tmpdir(), 'videorc-account-auth-')), 'state.json')
    const transactions = createTransactions(storePath, {
      now: () => nowMs,
      random: deterministicRandom(['s', 'v']),
      callbackTtlMs: 100,
      schedule: (callback) => {
        scheduled.push(callback)
        return 1
      },
      cancel: () => undefined
    })
    const authorization = new URL(
      transactions.begin('https://www.videorc.com/desktop/authorize/v2')
    )
    const state = authorization.searchParams.get('state')!
    transactions.accept(accountCallbackUrl(state))

    nowMs = 1_101
    expect(scheduled).not.toHaveLength(0)
    scheduled.at(-1)!()

    expect(createTransactions(storePath, { now: () => nowMs }).pending()).toEqual([])
  })
})
