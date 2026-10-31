import { createHash } from 'node:crypto'
import { assertLinuxBetaPublicationPlan } from './linux-beta-publication.mjs'
import {
  buildSignedS3Request,
  createReleaseUploadS3Transport,
  releaseUploadOriginCapabilities
} from './release-upload-s3.mjs'

const pointerLimit = 2 * 1024 * 1024
const strongEtag = (value) => typeof value === 'string' && /^"[\x21\x23-\x7e]+"$/.test(value)
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const failure = (code, message) => Object.assign(new Error(message), { code })
function requireState(ok, code, message) {
  if (!ok) throw failure(code, message)
}

function dispose(body) {
  try {
    if (typeof body?.destroy === 'function') body.destroy()
    else Promise.resolve(body?.cancel?.()).catch(() => {})
  } catch {
    // Cleanup cannot change whether a publication write was confirmed.
  }
}

async function inspectBody(response, { maxBytes, retain, timeoutMs }) {
  let reader, iterator
  try {
    const length = response.headers.get('content-length')
    const size = Number(length)
    requireState(
      /^[1-9][0-9]*$/.test(length ?? '') && Number.isSafeInteger(size) && size <= maxBytes,
      'beta-storage-size',
      'Beta object requires a bounded, nonempty Content-Length.'
    )
    requireState(
      !response.headers.get('content-range') &&
        [null, 'identity'].includes(response.headers.get('content-encoding')),
      'beta-storage-encoding',
      'Partial or encoded Beta responses are refused.'
    )
    reader = response.body?.getReader?.()
    iterator = reader ? { next: () => reader.read() } : response.body?.[Symbol.asyncIterator]?.()
    requireState(iterator?.next, 'beta-storage-body', 'Beta object body is unreadable.')
    const hash = createHash('sha256'),
      chunks = []
    let received = 0
    const deadline = Date.now() + timeoutMs
    while (true) {
      const remaining = deadline - Date.now()
      requireState(remaining > 0, 'beta-storage-timeout', 'Beta object body timed out.')
      let timer, part
      try {
        part = await Promise.race([
          iterator.next(),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(failure('beta-storage-timeout', 'Beta object body timed out.')),
              remaining
            )
          })
        ])
      } finally {
        clearTimeout(timer)
      }
      if (part.done) break
      requireState(
        part.value instanceof Uint8Array,
        'beta-storage-body',
        'Beta object returned non-byte data.'
      )
      received += part.value.byteLength
      requireState(
        received <= size,
        'beta-storage-size',
        'Beta object exceeds its declared length.'
      )
      hash.update(part.value)
      if (retain) chunks.push(Buffer.from(part.value))
    }
    requireState(received === size, 'beta-storage-size', 'Beta object was truncated.')
    return {
      sha256: hash.digest('hex'),
      sizeBytes: received,
      ...(retain ? { body: Buffer.concat(chunks) } : {})
    }
  } finally {
    if (reader) {
      Promise.resolve(reader.cancel()).catch(() => {})
      reader.releaseLock()
    } else {
      dispose(response.body)
      try {
        Promise.resolve(iterator?.return?.()).catch(() => {})
      } catch {
        /* Best effort. */
      }
    }
  }
}

// The protected coordinator supplies distinct candidate-read and public-origin
// credentials. No environment fallback, CLI, immutable upload, journal unlock,
// acceptance override or retry is exposed here. A plan alone grants no release
// authority: the coordinator still verifies source/provenance/payload/acceptance,
// and its durable journal owns every pointer write and ambiguous outcome.
export function createLinuxBetaPublicationS3Storage({
  plan: input,
  candidate,
  origins,
  requestTimeoutMs = 30_000,
  bodyTimeoutMs = 120_000
}) {
  const plan = structuredClone(input)
  assertLinuxBetaPublicationPlan(plan)
  requireState(
    Number.isSafeInteger(requestTimeoutMs) && requestTimeoutMs > 0 && requestTimeoutMs <= 120_000,
    'beta-storage-timeout',
    'Invalid Beta request timeout.'
  )
  requireState(
    Number.isSafeInteger(bodyTimeoutMs) && bodyTimeoutMs > 0 && bodyTimeoutMs <= 120_000,
    'beta-storage-timeout',
    'Invalid Beta object body timeout.'
  )
  requireState(
    Array.isArray(origins) &&
      origins.length > 0 &&
      origins.every((origin) => typeof origin.name === 'string' && origin.name.length > 0) &&
      new Set(origins.map((origin) => origin.name)).size === origins.length,
    'beta-storage-origins',
    'Distinct configured Beta origins are required.'
  )
  const immutable = new Map(plan.immutable.map((item) => [item.objectKey, item]))
  const pointers = new Map(plan.pointers.map((item) => [item.objectKey, item]))
  const candidates = new Map(
    plan.pointers.filter((item) => item.sourceObjectKey).map((item) => [item.sourceObjectKey, item])
  )
  const transports = new Set()
  function destination(value) {
    const config = structuredClone(value.config)
    const transport = value.transport ?? createReleaseUploadS3Transport({ config })
    transports.add(transport)
    return { config, transport }
  }
  let candidateDestination, publicDestinations
  try {
    candidateDestination = destination(candidate)
    publicDestinations = new Map(origins.map((origin) => [origin.name, destination(origin)]))
  } catch (error) {
    for (const transport of transports) transport.close?.()
    throw error
  }
  let closed = false
  function close() {
    if (closed) return
    closed = true
    for (const transport of transports) transport.close?.()
  }
  function publicDestination(name) {
    const value = publicDestinations.get(name)
    requireState(value, 'beta-storage-origin', 'Unconfigured Beta origin refused.')
    return value
  }
  function descriptor(entries, key) {
    const value = entries.get(key)
    requireState(value, 'beta-storage-key', 'Object is outside this exact Beta plan.')
    return value
  }
  async function request(destination, method, objectKey, body, additionalHeaders = {}) {
    requireState(!closed, 'beta-storage-closed', 'Beta storage transport is closed.')
    const signed = buildSignedS3Request({
      config: destination.config,
      method,
      objectKey,
      additionalHeaders: { 'cache-control': 'no-store', ...additionalHeaders },
      ...(body ? { payloadSha256: sha256(body) } : {})
    })
    let timer,
      timedOut = false
    try {
      const pending = Promise.resolve()
        .then(() =>
          destination.transport.request(signed.url, {
            method,
            headers: {
              ...signed.headers,
              'accept-encoding': 'identity',
              ...(body
                ? {
                    'Content-Length': String(body.length),
                    'Content-Type': objectKey.endsWith('.yml')
                      ? 'text/yaml; charset=utf-8'
                      : 'application/json'
                  }
                : {})
            },
            ...(body ? { body } : {})
          })
        )
        .then((response) => {
          if (timedOut) dispose(response.body)
          return response
        })
      return await Promise.race([
        pending,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true
            // Abort owned sockets, including incomplete headers. No timeout
            // can leave this adapter usable for a speculative retry.
            close()
            reject(failure('beta-storage-timeout', 'Beta request timed out.'))
          }, requestTimeoutMs)
        })
      ])
    } catch {
      throw failure(
        method === 'PUT' ? 'beta-storage-write-unknown' : 'beta-storage-read',
        method === 'PUT'
          ? 'Beta pointer PUT outcome is unknown; reconcile its journal intent.'
          : 'Beta object GET failed.'
      )
    } finally {
      clearTimeout(timer)
    }
  }
  async function read(destination, key, { maxBytes, retain, missing = false, etag = false }) {
    const response = await request(destination, 'GET', key)
    try {
      if (missing && response.status === 404) return null
      requireState(
        response.status === 200,
        'beta-storage-read',
        `Beta object GET failed: HTTP ${response.status}.`
      )
      const tag = response.headers.get('etag')
      requireState(
        !etag || strongEtag(tag),
        'beta-storage-etag',
        'Beta pointer requires a strong quoted ETag.'
      )
      const result = await inspectBody(response, { maxBytes, retain, timeoutMs: bodyTimeoutMs })
      return { ...result, ...(etag ? { etag: tag } : {}) }
    } catch (error) {
      if (error?.code?.startsWith('beta-storage-')) throw error
      throw failure('beta-storage-read', 'Beta object body could not be read.')
    } finally {
      dispose(response.body)
    }
  }
  return {
    async readCandidate(key, { maxBytes }) {
      const item = descriptor(candidates, key)
      requireState(
        maxBytes === item.sizeBytes && maxBytes <= pointerLimit,
        'beta-storage-size',
        'Candidate pointer limit differs from this plan.'
      )
      const result = await read(candidateDestination, key, { maxBytes, retain: true })
      requireState(
        result.sha256 === item.sha256 && result.sizeBytes === item.sizeBytes,
        'beta-storage-identity',
        'Candidate pointer bytes differ from this plan.'
      )
      return result.body
    },
    async inspectImmutable(origin, key, { maxBytes }) {
      const item = descriptor(immutable, key)
      requireState(
        maxBytes === item.sizeBytes,
        'beta-storage-size',
        'Immutable read limit differs from this plan.'
      )
      // Hash the actual GET stream; neither HEAD nor stored hash metadata is proof.
      return read(publicDestination(origin), key, { maxBytes, retain: false, missing: true })
    },
    async readPointer(origin, key) {
      descriptor(pointers, key)
      const result = await read(publicDestination(origin), key, {
        maxBytes: pointerLimit,
        retain: true,
        missing: true,
        etag: true
      })
      return result === null ? null : { body: result.body, etag: result.etag }
    },
    async putPointer(origin, key, bytes, condition) {
      const item = descriptor(pointers, key)
      const body = Buffer.from(bytes)
      requireState(
        body.length === item.sizeBytes &&
          body.length <= pointerLimit &&
          sha256(body) === item.sha256,
        'beta-storage-identity',
        'Only the exact planned Beta pointer bytes can be written.'
      )
      requireState(
        condition &&
          ((condition.ifMatch === null && condition.ifNoneMatch === '*') ||
            (strongEtag(condition.ifMatch) && condition.ifNoneMatch === null)),
        'beta-storage-condition',
        'Beta pointer requires exactly one explicit create or compare-and-swap condition.'
      )
      const destination = publicDestination(origin)
      const headers =
        condition.ifMatch === null
          ? { 'if-none-match': '*' }
          : {
              'if-match':
                releaseUploadOriginCapabilities(destination.config).ifMatchEtagForm === 'unquoted'
                  ? condition.ifMatch.slice(1, -1)
                  : condition.ifMatch
            }
      const response = await request(destination, 'PUT', key, body, headers)
      const etag = response.headers.get('etag')
      dispose(response.body)
      requireState(
        ![409, 412].includes(response.status),
        'beta-storage-conflict',
        'Beta pointer changed; retain the journal intent for reconciliation.'
      )
      requireState(
        response.status === 200 && strongEtag(etag),
        'beta-storage-write-unknown',
        'Beta pointer PUT was not confirmed with a strong ETag; reconcile its journal intent.'
      )
      // The transaction core performs exact GET readback before verified/complete.
      return { etag }
    },
    close
  }
}
