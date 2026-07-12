import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import type { OAuthCallbackEnvelope } from '../shared/backend'
import { PROVIDER_OAUTH_CALLBACK_TTL_MS } from '../shared/oauth-callback-policy'
import { type SecurePersistenceCodec, writePrivateFileAtomically } from './secure-persistence-codec'

const LEGACY_STORE_VERSION = 1
const PROTECTED_STORE_VERSION = 2
const PROTECTED_PAYLOAD_VERSION = 1
const PROTECTED_PAYLOAD_KIND = 'videorc-provider-oauth-callbacks'
const DEFAULT_MAX_CALLBACKS = 32
const MAX_DURABLE_CALLBACKS = 128
const MAX_STORE_BYTES = 3 * 1024 * 1024
const EXPIRY_RETRY_MS = 1_000

type PersistedCallback = OAuthCallbackEnvelope & { expiresAtMs: number }
type PersistedPayload = {
  kind: typeof PROTECTED_PAYLOAD_KIND
  version: typeof PROTECTED_PAYLOAD_VERSION
  callbacks: PersistedCallback[]
}

type TimerHandle = unknown
type Dependencies = {
  codec: SecurePersistenceCodec
  now: () => number
  ttlMs: number
  maxCallbacks: number
  schedule: (callback: () => void, delayMs: number) => TimerHandle
  cancel: (handle: TimerHandle) => void
}
type ProviderOAuthDependencies = Partial<Omit<Dependencies, 'codec'>> & Pick<Dependencies, 'codec'>

function providerOAuthStoreReadError(): Error {
  return new Error('Provider OAuth callback store could not be read safely.')
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

function callbackFromUrl(rawUrl: string): { url: string; state: string; id: string } {
  if (rawUrl.length > 16_384) throw new Error('Provider OAuth callback was too large.')
  const url = new URL(rawUrl)
  if (
    url.protocol !== 'videorc:' ||
    url.hostname !== 'oauth' ||
    url.pathname !== '/callback' ||
    url.username ||
    url.password ||
    url.port ||
    url.hash
  ) {
    throw new Error('Invalid provider OAuth callback.')
  }
  const state = url.searchParams.get('state')?.trim()
  const code = url.searchParams.get('code')?.trim()
  const error = url.searchParams.get('error')?.trim()
  if (!state || state.length < 8 || state.length > 2048 || (!code && !error)) {
    throw new Error('Provider OAuth callback was incomplete.')
  }
  if ((code?.length ?? 0) > 8192 || (error?.length ?? 0) > 1024) {
    throw new Error('Provider OAuth callback was too large.')
  }
  const normalized = url.toString()
  const id = createHash('sha256')
    .update(`${state}\n${code ?? ''}\n${error ?? ''}`, 'utf8')
    .digest('base64url')
  return { url: normalized, state, id }
}

function parseCallbacks(value: unknown): PersistedCallback[] {
  if (!Array.isArray(value) || value.length > MAX_DURABLE_CALLBACKS) {
    throw providerOAuthStoreReadError()
  }
  const ids = new Set<string>()
  return value.map((entry) => {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, ['url', 'id', 'state', 'receivedAtMs', 'expiresAtMs'])
    ) {
      throw providerOAuthStoreReadError()
    }
    if (
      typeof entry.url !== 'string' ||
      typeof entry.id !== 'string' ||
      typeof entry.state !== 'string' ||
      typeof entry.receivedAtMs !== 'number' ||
      !Number.isSafeInteger(entry.receivedAtMs) ||
      entry.receivedAtMs < 0 ||
      typeof entry.expiresAtMs !== 'number' ||
      !Number.isSafeInteger(entry.expiresAtMs) ||
      entry.expiresAtMs < entry.receivedAtMs
    ) {
      throw providerOAuthStoreReadError()
    }
    const parsed = callbackFromUrl(entry.url)
    if (parsed.id !== entry.id || parsed.state !== entry.state || ids.has(parsed.id)) {
      throw providerOAuthStoreReadError()
    }
    ids.add(parsed.id)
    return {
      ...parsed,
      receivedAtMs: entry.receivedAtMs,
      expiresAtMs: entry.expiresAtMs
    }
  })
}

function parseLegacyState(value: unknown): PersistedCallback[] {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['version', 'callbacks']) ||
    value.version !== LEGACY_STORE_VERSION
  ) {
    throw providerOAuthStoreReadError()
  }
  return parseCallbacks(value.callbacks)
}

function parseProtectedPayload(value: unknown): PersistedCallback[] {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['kind', 'version', 'callbacks']) ||
    value.kind !== PROTECTED_PAYLOAD_KIND ||
    value.version !== PROTECTED_PAYLOAD_VERSION
  ) {
    throw providerOAuthStoreReadError()
  }
  return parseCallbacks(value.callbacks)
}

export class ProviderOAuthCallbacks {
  private callbacks: PersistedCallback[]
  private readonly dependencies: Dependencies
  private expiryTimer: TimerHandle | null = null

  constructor(
    private readonly storePath: string,
    dependencies: ProviderOAuthDependencies
  ) {
    this.dependencies = {
      codec: dependencies.codec,
      now: dependencies.now ?? Date.now,
      ttlMs: dependencies.ttlMs ?? PROVIDER_OAUTH_CALLBACK_TTL_MS,
      maxCallbacks: dependencies.maxCallbacks ?? DEFAULT_MAX_CALLBACKS,
      schedule: dependencies.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs)),
      cancel:
        dependencies.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
    }
    this.callbacks = this.load()
    this.purgeExpired()
  }

  accept(rawUrl: string): OAuthCallbackEnvelope {
    this.purgeExpired()
    const parsed = callbackFromUrl(rawUrl)
    const existing = this.callbacks.find((callback) => callback.id === parsed.id)
    if (existing) return this.publicCallback(existing)
    if (this.callbacks.length >= this.dependencies.maxCallbacks) {
      throw new Error('Provider OAuth callback queue is full. Complete or retry a pending sign-in.')
    }

    const receivedAtMs = this.dependencies.now()
    const callback: PersistedCallback = {
      ...parsed,
      receivedAtMs,
      expiresAtMs: receivedAtMs + this.dependencies.ttlMs
    }
    const next = [...this.callbacks, callback]
    this.persist(next)
    this.callbacks = next
    this.scheduleExpiry()
    return this.publicCallback(callback)
  }

  pending(): OAuthCallbackEnvelope[] {
    this.purgeExpired()
    return this.callbacks.map((callback) => this.publicCallback(callback))
  }

  acknowledge(callbackId: string): boolean {
    const next = this.callbacks.filter((callback) => callback.id !== callbackId)
    if (next.length === this.callbacks.length) return false
    this.persist(next)
    this.callbacks = next
    this.scheduleExpiry()
    return true
  }

  dispose(): void {
    if (this.expiryTimer !== null) {
      this.dependencies.cancel(this.expiryTimer)
      this.expiryTimer = null
    }
  }

  private publicCallback(callback: PersistedCallback): OAuthCallbackEnvelope {
    return {
      id: callback.id,
      url: callback.url,
      state: callback.state,
      receivedAtMs: callback.receivedAtMs
    }
  }

  private purgeExpired(): void {
    const nowMs = this.dependencies.now()
    const next = this.callbacks.filter((callback) => callback.expiresAtMs >= nowMs)
    if (next.length !== this.callbacks.length) {
      this.persist(next)
      this.callbacks = next
    }
    this.scheduleExpiry()
  }

  private scheduleExpiry(delayOverrideMs?: number): void {
    if (this.expiryTimer !== null) {
      this.dependencies.cancel(this.expiryTimer)
      this.expiryTimer = null
    }
    const nextExpiry = this.callbacks.reduce<number | null>(
      (minimum, callback) =>
        minimum === null ? callback.expiresAtMs : Math.min(minimum, callback.expiresAtMs),
      null
    )
    if (nextExpiry === null) return
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

  private load(): PersistedCallback[] {
    let raw: Buffer
    try {
      raw = readFileSync(this.storePath)
    } catch (error) {
      if (isMissingFileError(error)) return []
      throw providerOAuthStoreReadError()
    }
    if (!raw.length || raw.length > MAX_STORE_BYTES) throw providerOAuthStoreReadError()

    try {
      const value = JSON.parse(raw.toString('utf8')) as unknown
      if (isRecord(value) && value.version === LEGACY_STORE_VERSION) {
        const callbacks = parseLegacyState(value)
        this.persist(callbacks)
        return callbacks
      }
      if (
        !isRecord(value) ||
        !hasExactKeys(value, ['version', 'sealed']) ||
        value.version !== PROTECTED_STORE_VERSION ||
        typeof value.sealed !== 'string'
      ) {
        throw providerOAuthStoreReadError()
      }
      return parseProtectedPayload(JSON.parse(this.dependencies.codec.unseal(value.sealed)))
    } catch {
      throw providerOAuthStoreReadError()
    }
  }

  private persist(callbacks: PersistedCallback[]): void {
    const payload: PersistedPayload = {
      kind: PROTECTED_PAYLOAD_KIND,
      version: PROTECTED_PAYLOAD_VERSION,
      callbacks
    }
    const sealed = this.dependencies.codec.seal(JSON.stringify(payload))
    writePrivateFileAtomically(
      this.storePath,
      JSON.stringify({ version: PROTECTED_STORE_VERSION, sealed })
    )
  }
}
