import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'

import type { AccountCallbackEnvelope } from '../shared/backend'
import {
  ACCOUNT_SIGN_IN_CALLBACK_TTL_MS,
  ACCOUNT_SIGN_IN_CODE_CLOCK_SKEW_MS,
  ACCOUNT_SIGN_IN_CODE_EXPIRY_PARAM,
  ACCOUNT_SIGN_IN_CODE_TTL_MS,
  ACCOUNT_SIGN_IN_CODE_VERSION
} from '../shared/oauth-callback-policy'
import { type SecurePersistenceCodec, writePrivateFileAtomically } from './secure-persistence-codec'

const LEGACY_STORE_VERSION = 1
const PROTECTED_STORE_VERSION = 2
const LEGACY_PROTECTED_PAYLOAD_VERSION = 2
const PROTECTED_PAYLOAD_VERSION = 3
const PROTECTED_PAYLOAD_KIND = 'videorc-account-sign-in-transactions'
const DEFAULT_TRANSACTION_TTL_MS = 10 * 60 * 1000
const PRODUCTION_AUTHORIZE_ORIGIN = 'https://www.videorc.com'
const LOOPBACK_AUTHORIZE_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
const MAX_DURABLE_ENTRIES = 128
const MAX_STORE_BYTES = 3 * 1024 * 1024
const EXPIRY_RETRY_MS = 1_000

type AccountSignInTransaction = {
  state: string
  verifier: string
  intentGeneration: number
  createdAtMs: number
  expiresAtMs: number
}

type AccountSignInState = {
  transactions: AccountSignInTransaction[]
  callbacks: PersistedAccountCallback[]
}

type PersistedAccountCallback = AccountCallbackEnvelope & {
  expiresAtMs: number
}

type PersistedPayload = AccountSignInState & {
  kind: typeof PROTECTED_PAYLOAD_KIND
  version: typeof PROTECTED_PAYLOAD_VERSION
}

type TimerHandle = unknown
type AccountSignInDependencies = {
  codec: SecurePersistenceCodec
  now: () => number
  random: (bytes: number) => Buffer
  transactionTtlMs: number
  callbackTtlMs: number
  maxCallbacks: number
  allowLoopbackAuthorizeOrigin: boolean
  schedule: (callback: () => void, delayMs: number) => TimerHandle
  cancel: (handle: TimerHandle) => void
}
type AccountSignInOptions = Partial<Omit<AccountSignInDependencies, 'codec'>> &
  Pick<AccountSignInDependencies, 'codec'>

function emptyState(): AccountSignInState {
  return { transactions: [], callbacks: [] }
}

function accountSignInStoreReadError(): Error {
  return new Error('Desktop account sign-in store could not be read safely.')
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(record: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(record).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function boundedString(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === 'string' && value.length >= minimum && value.length <= maximum
}

function safeTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function safeIntentGeneration(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function sha256Base64Url(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url')
}

function callbackKey(url: URL): string {
  return sha256Base64Url(
    [
      url.searchParams.get('state') ?? '',
      url.searchParams.get('code') ?? '',
      url.searchParams.get(ACCOUNT_SIGN_IN_CODE_EXPIRY_PARAM) ?? ''
    ].join('\n')
  )
}

function parseCodeExpiresAtMs(code: string): number {
  const segments = code.split('.')
  const expirySegment = segments[1] ?? ''
  const expiresAtMs = Number(expirySegment)
  const base64Url = /^[A-Za-z0-9_-]+$/
  if (
    segments.length !== 5 ||
    segments[0] !== ACCOUNT_SIGN_IN_CODE_VERSION ||
    !/^\d{1,16}$/.test(expirySegment) ||
    !Number.isSafeInteger(expiresAtMs) ||
    expiresAtMs < 0 ||
    String(expiresAtMs) !== expirySegment ||
    segments[2]?.length !== 16 ||
    !base64Url.test(segments[2]) ||
    !boundedString(segments[3], 1, 8_192) ||
    !base64Url.test(segments[3]) ||
    segments[4]?.length !== 22 ||
    !base64Url.test(segments[4])
  ) {
    throw new Error('Desktop account callback contained an invalid authorization code.')
  }
  return expiresAtMs
}

type PersistedStateFormat = 'legacy' | 'protected-v2' | 'protected-v3'

function parsePersistedState(value: unknown, format: PersistedStateFormat): AccountSignInState {
  const protectedPayload = format !== 'legacy'
  const hasIntentGeneration = format === 'protected-v3'
  const expectedKeys = protectedPayload
    ? ['kind', 'version', 'transactions', 'callbacks']
    : ['version', 'transactions', 'callbacks']
  const expectedVersion =
    format === 'legacy'
      ? LEGACY_STORE_VERSION
      : format === 'protected-v2'
        ? LEGACY_PROTECTED_PAYLOAD_VERSION
        : PROTECTED_PAYLOAD_VERSION
  if (
    !isRecord(value) ||
    !hasExactKeys(value, expectedKeys) ||
    value.version !== expectedVersion ||
    (protectedPayload && value.kind !== PROTECTED_PAYLOAD_KIND) ||
    !Array.isArray(value.transactions) ||
    value.transactions.length > MAX_DURABLE_ENTRIES ||
    !Array.isArray(value.callbacks) ||
    value.callbacks.length > MAX_DURABLE_ENTRIES
  ) {
    throw accountSignInStoreReadError()
  }

  const states = new Set<string>()
  const transactions = value.transactions.map((entry) => {
    const transactionKeys = hasIntentGeneration
      ? ['state', 'verifier', 'intentGeneration', 'createdAtMs', 'expiresAtMs']
      : ['state', 'verifier', 'createdAtMs', 'expiresAtMs']
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, transactionKeys) ||
      !boundedString(entry.state, 32, 128) ||
      !boundedString(entry.verifier, 32, 128) ||
      (hasIntentGeneration && !safeIntentGeneration(entry.intentGeneration)) ||
      !safeTimestamp(entry.createdAtMs) ||
      !safeTimestamp(entry.expiresAtMs) ||
      entry.expiresAtMs < entry.createdAtMs ||
      states.has(entry.state)
    ) {
      throw accountSignInStoreReadError()
    }
    states.add(entry.state)
    return {
      state: entry.state,
      verifier: entry.verifier,
      intentGeneration: hasIntentGeneration ? (entry.intentGeneration as number) : 0,
      createdAtMs: entry.createdAtMs,
      expiresAtMs: entry.expiresAtMs
    }
  })
  const transactionByState = new Map(
    transactions.map((transaction) => [transaction.state, transaction])
  )
  const callbackIds = new Set<string>()
  const callbackStates = new Set<string>()
  const callbacks = value.callbacks.map((entry) => {
    const callbackKeys = hasIntentGeneration
      ? ['id', 'url', 'state', 'intentGeneration', 'receivedAtMs', 'expiresAtMs']
      : ['id', 'url', 'state', 'receivedAtMs', 'expiresAtMs']
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, callbackKeys) ||
      !boundedString(entry.id, 16, 128) ||
      !boundedString(entry.url, 1, 16_384) ||
      !boundedString(entry.state, 32, 128) ||
      (hasIntentGeneration && !safeIntentGeneration(entry.intentGeneration)) ||
      !safeTimestamp(entry.receivedAtMs) ||
      !safeTimestamp(entry.expiresAtMs) ||
      entry.expiresAtMs < entry.receivedAtMs ||
      callbackIds.has(entry.id) ||
      callbackStates.has(entry.state)
    ) {
      throw accountSignInStoreReadError()
    }
    let parsed: { url: URL; codeExpiresAtMs: number }
    try {
      parsed = parseAccountCallbackUrl(entry.url, true)
    } catch {
      throw accountSignInStoreReadError()
    }
    const transaction = transactionByState.get(entry.state)
    if (
      !transaction ||
      parsed.url.searchParams.get('state') !== entry.state ||
      parsed.url.searchParams.get('verifier') !== transaction.verifier ||
      (hasIntentGeneration && entry.intentGeneration !== transaction.intentGeneration) ||
      callbackKey(parsed.url) !== entry.id ||
      transaction.expiresAtMs < entry.expiresAtMs ||
      parsed.codeExpiresAtMs < entry.expiresAtMs ||
      parsed.codeExpiresAtMs >
        entry.receivedAtMs + ACCOUNT_SIGN_IN_CODE_TTL_MS + ACCOUNT_SIGN_IN_CODE_CLOCK_SKEW_MS
    ) {
      throw accountSignInStoreReadError()
    }
    callbackIds.add(entry.id)
    callbackStates.add(entry.state)
    return {
      id: entry.id,
      url: parsed.url.toString(),
      state: entry.state,
      intentGeneration: hasIntentGeneration ? (entry.intentGeneration as number) : 0,
      receivedAtMs: entry.receivedAtMs,
      expiresAtMs: entry.expiresAtMs
    }
  })
  // Legacy callbacks cannot be assigned a backend-owned generation safely.
  // Retire them during migration rather than reopening an old sign-in intent.
  return hasIntentGeneration ? { transactions, callbacks } : emptyState()
}

function parseAccountCallbackUrl(
  rawUrl: string,
  requireVerifier = false
): { url: URL; codeExpiresAtMs: number } {
  if (rawUrl.length > 16_384) throw new Error('Desktop account callback was too large.')
  const url = new URL(rawUrl)
  if (
    url.protocol !== 'videorc:' ||
    url.hostname !== 'account' ||
    url.pathname !== '/callback' ||
    url.username ||
    url.password ||
    url.port ||
    url.hash
  ) {
    throw new Error('Invalid desktop account callback.')
  }
  const state = url.searchParams.get('state')?.trim()
  const code = url.searchParams.get('code')?.trim()
  const verifier = url.searchParams.get('verifier')?.trim()
  const codeExpiresAt = url.searchParams.get(ACCOUNT_SIGN_IN_CODE_EXPIRY_PARAM)?.trim()
  const expectedKeys = requireVerifier
    ? ['code', ACCOUNT_SIGN_IN_CODE_EXPIRY_PARAM, 'state', 'verifier']
    : ['code', ACCOUNT_SIGN_IN_CODE_EXPIRY_PARAM, 'state']
  const actualKeys = [...url.searchParams.keys()].sort()
  if (
    !boundedString(state, 32, 128) ||
    !boundedString(code, 32, 8192) ||
    (requireVerifier && !boundedString(verifier, 32, 128)) ||
    actualKeys.length !== expectedKeys.length ||
    !actualKeys.every((key, index) => key === expectedKeys[index])
  ) {
    throw new Error('Desktop account callback was incomplete.')
  }
  const codeExpiresAtMs = parseCodeExpiresAtMs(code)
  if (codeExpiresAt !== String(codeExpiresAtMs)) {
    throw new Error('Desktop account callback expiry did not match its authorization code.')
  }
  return { url, codeExpiresAtMs }
}

export class AccountSignInTransactions {
  private state: AccountSignInState
  private readonly dependencies: AccountSignInDependencies
  private expiryTimer: TimerHandle | null = null

  constructor(
    private readonly storePath: string,
    dependencies: AccountSignInOptions
  ) {
    this.dependencies = {
      codec: dependencies.codec,
      now: dependencies.now ?? Date.now,
      random: dependencies.random ?? randomBytes,
      transactionTtlMs: dependencies.transactionTtlMs ?? DEFAULT_TRANSACTION_TTL_MS,
      callbackTtlMs: dependencies.callbackTtlMs ?? ACCOUNT_SIGN_IN_CALLBACK_TTL_MS,
      maxCallbacks: dependencies.maxCallbacks ?? MAX_DURABLE_ENTRIES,
      allowLoopbackAuthorizeOrigin: dependencies.allowLoopbackAuthorizeOrigin ?? false,
      schedule: dependencies.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs)),
      cancel:
        dependencies.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
    }
    if (
      !Number.isSafeInteger(this.dependencies.maxCallbacks) ||
      this.dependencies.maxCallbacks < 1 ||
      this.dependencies.maxCallbacks > MAX_DURABLE_ENTRIES
    ) {
      throw new Error('Desktop account callback capacity was invalid.')
    }
    this.state = this.load()
    this.purgeExpired()
  }

  begin(authorizeUrl: string, intentGeneration: number): string {
    const url = new URL(authorizeUrl)
    const productionOrigin = url.origin === PRODUCTION_AUTHORIZE_ORIGIN
    const developmentLoopbackOrigin =
      this.dependencies.allowLoopbackAuthorizeOrigin &&
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      LOOPBACK_AUTHORIZE_HOSTS.has(url.hostname)
    if (
      url.username ||
      url.password ||
      url.pathname !== '/desktop/authorize/v2' ||
      (!productionOrigin && !developmentLoopbackOrigin)
    ) {
      throw new Error('Desktop account authorization URL has an unexpected origin or path.')
    }
    if (!safeIntentGeneration(intentGeneration)) {
      throw new Error('Desktop account sign-in intent generation was invalid.')
    }

    this.purgeExpired()
    const nowMs = this.dependencies.now()
    const state = this.dependencies.random(32).toString('base64url')
    const verifier = this.dependencies.random(32).toString('base64url')
    const transaction: AccountSignInTransaction = {
      state,
      verifier,
      intentGeneration,
      createdAtMs: nowMs,
      expiresAtMs: nowMs + this.dependencies.transactionTtlMs
    }
    // A newer browser authorization is the sole current product-account
    // intent. Backend generation makes already-delivered older envelopes stale;
    // replacing the durable store prevents them from being delivered again.
    const next: AccountSignInState = {
      transactions: [transaction],
      callbacks: []
    }
    this.persist(next)
    this.state = next
    this.scheduleExpiry()

    url.searchParams.set('state', state)
    url.searchParams.set('code_challenge', sha256Base64Url(verifier))
    url.searchParams.set('code_challenge_method', 'S256')
    return url.toString()
  }

  accept(rawUrl: string): AccountCallbackEnvelope {
    this.purgeExpired()
    const { url, codeExpiresAtMs } = parseAccountCallbackUrl(rawUrl)
    const state = url.searchParams.get('state')!
    const transaction = this.state.transactions.find((candidate) => candidate.state === state)
    if (!transaction || transaction.expiresAtMs < this.dependencies.now()) {
      throw new Error('Desktop account callback did not match an active sign-in.')
    }

    const receivedAtMs = this.dependencies.now()
    if (
      codeExpiresAtMs < receivedAtMs ||
      codeExpiresAtMs >
        receivedAtMs + ACCOUNT_SIGN_IN_CODE_TTL_MS + ACCOUNT_SIGN_IN_CODE_CLOCK_SKEW_MS
    ) {
      throw new Error('Desktop account callback authorization code was expired or too far ahead.')
    }
    const key = callbackKey(url)
    const existingForState = this.state.callbacks.find((callback) => callback.state === state)
    if (existingForState) {
      if (existingForState.id === key) return this.publicCallback(existingForState)
      throw new Error('Desktop account callback state already has a different pending code.')
    }

    const callbackExpiresAtMs = Math.min(
      receivedAtMs + this.dependencies.callbackTtlMs,
      codeExpiresAtMs
    )
    url.searchParams.set('verifier', transaction.verifier)
    const callback: PersistedAccountCallback = {
      id: key,
      url: url.toString(),
      state,
      intentGeneration: transaction.intentGeneration,
      receivedAtMs,
      expiresAtMs: callbackExpiresAtMs
    }
    const nextCallbacks = [...this.state.callbacks, callback]
    if (nextCallbacks.length > this.dependencies.maxCallbacks) {
      throw new Error(
        'Too many desktop account callbacks are pending. Complete an existing sign-in first.'
      )
    }
    const next: AccountSignInState = {
      transactions: this.state.transactions.map((candidate) =>
        candidate.state === state ? { ...candidate, expiresAtMs: callbackExpiresAtMs } : candidate
      ),
      callbacks: nextCallbacks
    }
    this.persist(next)
    this.state = next
    this.scheduleExpiry()
    return this.publicCallback(callback)
  }

  pending(): AccountCallbackEnvelope[] {
    this.purgeExpired()
    return this.state.callbacks.map((callback) => this.publicCallback(callback))
  }

  acknowledge(callbackId: string): boolean {
    const callback = this.state.callbacks.find((candidate) => candidate.id === callbackId)
    if (!callback) return false
    const next: AccountSignInState = {
      callbacks: this.state.callbacks.filter((candidate) => candidate.state !== callback.state),
      transactions: this.state.transactions.filter(
        (transaction) => transaction.state !== callback.state
      )
    }
    this.persist(next)
    this.state = next
    this.scheduleExpiry()
    return true
  }

  retireAll(): boolean {
    if (!this.state.transactions.length && !this.state.callbacks.length) return false
    const next = emptyState()
    this.persist(next)
    this.state = next
    this.scheduleExpiry()
    return true
  }

  dispose(): void {
    if (this.expiryTimer !== null) {
      this.dependencies.cancel(this.expiryTimer)
      this.expiryTimer = null
    }
  }

  private purgeExpired(): void {
    const nowMs = this.dependencies.now()
    const nextCallbacks = this.state.callbacks.filter((callback) => callback.expiresAtMs >= nowMs)
    const callbackStates = new Set(nextCallbacks.map((callback) => callback.state))
    const nextTransactions = this.state.transactions.filter(
      (transaction) => transaction.expiresAtMs >= nowMs || callbackStates.has(transaction.state)
    )
    const activeStates = new Set(nextTransactions.map((transaction) => transaction.state))
    const activeCallbacks = nextCallbacks.filter((callback) => activeStates.has(callback.state))
    if (
      nextTransactions.length !== this.state.transactions.length ||
      activeCallbacks.length !== this.state.callbacks.length
    ) {
      const next = { transactions: nextTransactions, callbacks: activeCallbacks }
      this.persist(next)
      this.state = next
    }
    this.scheduleExpiry()
  }

  private scheduleExpiry(delayOverrideMs?: number): void {
    if (this.expiryTimer !== null) {
      this.dependencies.cancel(this.expiryTimer)
      this.expiryTimer = null
    }
    const expiries = [
      ...this.state.transactions.map((transaction) => transaction.expiresAtMs),
      ...this.state.callbacks.map((callback) => callback.expiresAtMs)
    ]
    if (!expiries.length) return
    const nextExpiry = Math.min(...expiries)
    const delayMs =
      delayOverrideMs ??
      Math.max(0, Math.min(2_147_483_647, nextExpiry - this.dependencies.now() + 1))
    const handle = this.dependencies.schedule(() => {
      this.expiryTimer = null
      try {
        this.purgeExpired()
      } catch {
        this.scheduleExpiry(EXPIRY_RETRY_MS)
      }
    }, delayMs)
    this.expiryTimer = handle
    if (typeof handle === 'object' && handle !== null && 'unref' in handle) {
      const unref = (handle as { unref?: unknown }).unref
      if (typeof unref === 'function') unref.call(handle)
    }
  }

  private publicCallback(callback: PersistedAccountCallback): AccountCallbackEnvelope {
    return {
      id: callback.id,
      url: callback.url,
      state: callback.state,
      intentGeneration: callback.intentGeneration,
      receivedAtMs: callback.receivedAtMs,
      expiresAtMs: callback.expiresAtMs
    }
  }

  private load(): AccountSignInState {
    let raw: Buffer
    try {
      raw = readFileSync(this.storePath)
    } catch (error) {
      if (isMissingFileError(error)) return emptyState()
      throw accountSignInStoreReadError()
    }
    if (!raw.length || raw.length > MAX_STORE_BYTES) throw accountSignInStoreReadError()

    try {
      const value = JSON.parse(raw.toString('utf8')) as unknown
      if (isRecord(value) && value.version === LEGACY_STORE_VERSION) {
        const state = parsePersistedState(value, 'legacy')
        this.persist(state)
        return state
      }
      if (
        !isRecord(value) ||
        !hasExactKeys(value, ['version', 'sealed']) ||
        value.version !== PROTECTED_STORE_VERSION ||
        typeof value.sealed !== 'string'
      ) {
        throw accountSignInStoreReadError()
      }
      const payload = JSON.parse(this.dependencies.codec.unseal(value.sealed)) as unknown
      if (
        isRecord(payload) &&
        payload.kind === PROTECTED_PAYLOAD_KIND &&
        payload.version === LEGACY_PROTECTED_PAYLOAD_VERSION
      ) {
        const state = parsePersistedState(payload, 'protected-v2')
        this.persist(state)
        return state
      }
      return parsePersistedState(payload, 'protected-v3')
    } catch {
      throw accountSignInStoreReadError()
    }
  }

  private persist(state: AccountSignInState): void {
    const payload: PersistedPayload = {
      kind: PROTECTED_PAYLOAD_KIND,
      version: PROTECTED_PAYLOAD_VERSION,
      transactions: state.transactions,
      callbacks: state.callbacks
    }
    const sealed = this.dependencies.codec.seal(JSON.stringify(payload))
    writePrivateFileAtomically(
      this.storePath,
      JSON.stringify({ version: PROTECTED_STORE_VERSION, sealed })
    )
  }
}
