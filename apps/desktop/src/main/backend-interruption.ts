import { randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'

import type { BackendConnection } from '../shared/backend'

const REQUEST_TIMEOUT_MS = 1_000
const MAX_RESPONSE_BYTES = 4_096
const MAX_LEASE_ID_LENGTH = 128
const REQUEST_ATTEMPTS = 2

type InterruptionHttpMethod = 'POST' | 'PUT' | 'DELETE'

export type BackendInterruptionHttpResponse = {
  statusCode: number
  body: string
}

export type BackendInterruptionTransport = (
  connection: BackendConnection,
  method: InterruptionHttpMethod,
  path: string
) => Promise<BackendInterruptionHttpResponse>

export type BackendInterruptionAcquireOptions = {
  action: 'permission-restart' | 'update-install'
  reason: string
  /** Stable across acquire retries. Exposed for deterministic contract tests. */
  ownerId?: string
}

export type BackendInterruptionLease = {
  id: string
  readonly expiresInMs: number
  readonly consumed: boolean
  consume: () => Promise<void>
  renew: () => Promise<void>
  release: () => Promise<void>
}

function defaultInterruptionTransport(
  connection: BackendConnection,
  method: InterruptionHttpMethod,
  path: string
): Promise<BackendInterruptionHttpResponse> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: connection.host,
        port: connection.port,
        method,
        path
      },
      (response) => {
        const chunks: Buffer[] = []
        let size = 0
        response.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > MAX_RESPONSE_BYTES) {
            request.destroy(new Error('Backend interruption response exceeded 4096 bytes.'))
            return
          }
          chunks.push(chunk)
        })
        response.on('end', () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8')
          })
        })
      }
    )
    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error('Backend interruption request timed out.'))
    })
    request.on('error', reject)
    request.end()
  })
}

function interruptionPath(
  connection: BackendConnection,
  ownerId: string,
  options: BackendInterruptionAcquireOptions
): string {
  const query = new URLSearchParams({
    token: connection.token,
    ownerId,
    action: options.action,
    reason: options.reason.slice(0, 256)
  })
  return `/interruption/lease?${query.toString()}`
}

function leasePath(connection: BackendConnection, leaseId: string, suffix = ''): string {
  const query = new URLSearchParams({ token: connection.token })
  return `/interruption/lease/${encodeURIComponent(leaseId)}${suffix}?${query.toString()}`
}

type ParsedLeaseGrant = {
  id: string
  expiresInMs: number
  consumed: boolean
}

function parseLeaseGrant(body: string): ParsedLeaseGrant {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new Error('Backend returned malformed interruption lease JSON.')
  }
  const grant = parsed as Partial<{
    leaseId: unknown
    expiresInMs: unknown
    consumed: unknown
  }> | null
  const id = grant?.leaseId
  const expiresInMs = grant?.expiresInMs
  const consumed = grant?.consumed
  if (
    typeof id !== 'string' ||
    id.length === 0 ||
    id.length > MAX_LEASE_ID_LENGTH ||
    !/^[a-zA-Z0-9-]+$/.test(id)
  ) {
    throw new Error('Backend returned an invalid interruption lease id.')
  }
  if (
    typeof expiresInMs !== 'number' ||
    !Number.isSafeInteger(expiresInMs) ||
    expiresInMs < 100 ||
    expiresInMs > 120_000 ||
    typeof consumed !== 'boolean'
  ) {
    throw new Error('Backend returned invalid interruption lease timing metadata.')
  }
  return { id, expiresInMs, consumed }
}

async function retryInterruptionRequest<T>(request: () => Promise<T>): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < REQUEST_ATTEMPTS; attempt += 1) {
    try {
      return await request()
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

/**
 * Acquires a recoverable backend-authoritative interruption lease. The same
 * owner/action path is retried after a timeout or malformed response, so the
 * backend returns the already-committed lease instead of orphaning it.
 */
export async function acquireBackendInterruptionLease(
  connection: BackendConnection,
  options: BackendInterruptionAcquireOptions,
  transport: BackendInterruptionTransport = defaultInterruptionTransport
): Promise<BackendInterruptionLease | null> {
  const ownerId = options.ownerId ?? randomUUID()
  const path = interruptionPath(connection, ownerId, options)
  // Any committed lease whose response remains lost after these bounded
  // retries is reclaimed by the backend TTL. The caller stays fail-closed.
  const grant = await retryInterruptionRequest(async () => {
    const response = await transport(connection, 'POST', path)
    if (response.statusCode === 409) {
      return null
    }
    if (response.statusCode !== 201) {
      throw new Error(`Backend interruption admission failed with HTTP ${response.statusCode}.`)
    }
    return parseLeaseGrant(response.body)
  })
  if (!grant) {
    return null
  }

  let expiresInMs = grant.expiresInMs
  let consumed = grant.consumed
  const id = grant.id
  const updateFromGrant = (next: ParsedLeaseGrant): void => {
    if (next.id !== id) {
      throw new Error('Backend changed interruption lease identity during the operation.')
    }
    expiresInMs = next.expiresInMs
    consumed = next.consumed
  }
  const mutateLease = async (method: 'POST' | 'PUT', suffix: string): Promise<void> => {
    const next = await retryInterruptionRequest(async () => {
      const response = await transport(connection, method, leasePath(connection, id, suffix))
      if (response.statusCode !== 200) {
        throw new Error(
          `Backend interruption lease mutation failed with HTTP ${response.statusCode}.`
        )
      }
      return parseLeaseGrant(response.body)
    })
    updateFromGrant(next)
  }

  return {
    id,
    get expiresInMs() {
      return expiresInMs
    },
    get consumed() {
      return consumed
    },
    consume: () => mutateLease('POST', '/consume'),
    renew: () => mutateLease('PUT', ''),
    release: async () => {
      await retryInterruptionRequest(async () => {
        const response = await transport(connection, 'DELETE', leasePath(connection, id))
        // 404 also proves the lease is no longer active (expired/history aged
        // out), which is the only safety property release needs.
        if (response.statusCode !== 204 && response.statusCode !== 404) {
          throw new Error(`Backend interruption release failed with HTTP ${response.statusCode}.`)
        }
      })
    }
  }
}
