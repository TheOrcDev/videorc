import { createHash, randomUUID } from 'node:crypto'
import { LINUX_BETA_PUBLICATION_JOURNAL_KEY } from './linux-beta-publication-journal.mjs'
import { canonicalJson } from './release-state.mjs'
import {
  buildSignedS3Request,
  createReleaseUploadS3Transport,
  getReleaseUploadS3Config,
  releaseUploadOriginCapabilities
} from './release-upload-s3.mjs'

const maxBytes = 8 * 1024 * 1024
const strongEtag = (value) => typeof value === 'string' && /^"[\x21\x23-\x7e]+"$/.test(value)
const digest = (body) => createHash('sha256').update(body).digest('hex')
const failure = (code, message) => Object.assign(new Error(message), { code })
function requireState(ok, code, message) {
  if (!ok) throw failure(code, message)
}

// No fallback to public download/upload or release-controller credentials.
// Provision a separate private destination and least-privilege credential;
// IAM, durability and consistency remain protected provisioning obligations.
export function linuxBetaJournalS3Config(env = process.env) {
  return getReleaseUploadS3Config(
    Object.fromEntries(
      Object.entries(env)
        .filter(([key]) => key.startsWith('VIDEORC_LINUX_BETA_JOURNAL_S3_'))
        .map(([key, value]) => [
          key.replace('VIDEORC_LINUX_BETA_JOURNAL_S3_', 'VIDEORC_RELEASE_UPLOAD_S3_'),
          value
        ])
    )
  )
}

function dispose(body) {
  try {
    if (typeof body?.destroy === 'function') body.destroy()
    else Promise.resolve(body?.cancel?.()).catch(() => {})
  } catch {
    /* Cleanup must not mask the original bounded operation. */
  }
}

async function readBytes(response, timeoutMs) {
  const body = response.body
  let reader, iterator
  try {
    const length = response.headers.get('content-length')
    requireState(
      /^(0|[1-9][0-9]*)$/.test(length ?? '') && Number(length) > 0 && Number(length) <= maxBytes,
      'journal-size',
      'Journal GET requires a bounded, nonempty Content-Length.'
    )
    requireState(
      !response.headers.get('content-range') &&
        [null, 'identity'].includes(response.headers.get('content-encoding')),
      'journal-encoding',
      'Partial or encoded journal responses are refused.'
    )
    reader = body?.getReader?.()
    iterator = reader ? { next: () => reader.read() } : body?.[Symbol.asyncIterator]?.()
    requireState(iterator?.next, 'journal-body', 'Journal body is unreadable.')
    const chunks = []
    let size = 0
    const deadline = Date.now() + timeoutMs
    while (true) {
      let timer
      let part
      const remaining = deadline - Date.now()
      requireState(remaining > 0, 'journal-timeout', 'Journal body timed out.')
      try {
        part = await Promise.race([
          iterator.next(),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(failure('journal-timeout', 'Journal body timed out.')),
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
        'journal-body',
        'Journal body returned non-byte data.'
      )
      size += part.value.byteLength
      requireState(size <= Number(length), 'journal-size', 'Journal response exceeds its length.')
      chunks.push(Buffer.from(part.value))
    }
    requireState(size === Number(length), 'journal-size', 'Journal response was truncated.')
    return Buffer.concat(chunks)
  } finally {
    if (reader) {
      // Cancel through the lock owner, not the locked ReadableStream. Do not
      // wait for an untrusted stream's cancellation callback to finish.
      Promise.resolve(reader.cancel()).catch(() => {})
      reader.releaseLock()
    } else {
      dispose(body)
      Promise.resolve(iterator?.return?.()).catch(() => {})
    }
  }
}

// This adapter never retries or adopts an ambiguous PUT, even if a later GET
// might contain the desired value. The journal/coordinator owns reconciliation.
// Only the fixed journal key is exposed. Explicit probes use fresh private keys
// and cannot initialize, acknowledge, unlock or overwrite the real journal.
export function createLinuxBetaJournalS3Store({
  config: providedConfig,
  prefix = 'videorc-linux-beta-publication/v1',
  transport: providedTransport,
  bodyTimeoutMs = 30_000
}) {
  requireState(
    /^videorc-linux-beta-publication\/(v1|staging-[a-z0-9-]{1,64})$/.test(prefix),
    'journal-prefix',
    'The journal requires its reserved private prefix.'
  )
  requireState(
    Number.isSafeInteger(bodyTimeoutMs) && bodyTimeoutMs > 0 && bodyTimeoutMs <= 30_000,
    'journal-timeout',
    'Invalid journal body timeout.'
  )
  const config = structuredClone(providedConfig)
  const transport = providedTransport ?? createReleaseUploadS3Transport({ config })
  let closed = false
  async function request(method, key, body, additionalHeaders = {}) {
    requireState(!closed, 'journal-closed', 'Journal transport is closed.')
    const signed = buildSignedS3Request({
      config,
      method,
      objectKey: `${prefix}/${key}`,
      additionalHeaders: { 'cache-control': 'no-store', ...additionalHeaders },
      ...(body ? { payloadSha256: digest(body) } : {})
    })
    try {
      return await transport.request(signed.url, {
        method,
        headers: {
          ...signed.headers,
          ...(body
            ? { 'Content-Length': String(body.length), 'Content-Type': 'application/json' }
            : {})
        },
        ...(body ? { body } : {})
      })
    } catch {
      throw failure(
        method === 'PUT' ? 'journal-write-unknown' : 'journal-read',
        method === 'PUT'
          ? 'Journal PUT outcome is unknown. Reconcile before continuing.'
          : 'Journal GET failed.'
      )
    }
  }
  async function readAt(key) {
    const response = await request('GET', key)
    try {
      if (response.status === 404) return null
      requireState(
        response.status === 200,
        'journal-read',
        `Journal GET failed: HTTP ${response.status}.`
      )
      const etag = response.headers.get('etag')
      requireState(strongEtag(etag), 'journal-etag', 'Journal GET requires a strong quoted ETag.')
      const bytes = await readBytes(response, bodyTimeoutMs)
      let value
      try {
        value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      } catch {
        throw failure('journal-json', 'Journal GET did not return valid UTF-8 JSON.')
      }
      requireState(
        value && typeof value === 'object' && !Array.isArray(value),
        'journal-json',
        'Journal must be a JSON object.'
      )
      return { value, etag, bodySha256: digest(bytes) }
    } finally {
      dispose(response.body)
    }
  }
  async function writeAt(key, value, priorEtag) {
    requireState(
      priorEtag === null || strongEtag(priorEtag),
      'journal-etag',
      'Journal writes require null or a strong prior ETag.'
    )
    requireState(
      value && typeof value === 'object' && !Array.isArray(value),
      'journal-json',
      'Journal must be a JSON object.'
    )
    const body = Buffer.from(canonicalJson(value))
    requireState(body.length <= maxBytes, 'journal-size', 'Journal write exceeds its bounded size.')
    const condition =
      priorEtag === null
        ? { 'if-none-match': '*' }
        : {
            'if-match':
              releaseUploadOriginCapabilities(config).ifMatchEtagForm === 'unquoted'
                ? priorEtag.slice(1, -1)
                : priorEtag
          }
    const response = await request('PUT', key, body, condition)
    const etag = response.headers.get('etag')
    dispose(response.body)
    if ([409, 412].includes(response.status))
      throw failure('journal-conflict', 'Journal changed; reread before applying.')
    requireState(
      response.status === 200 && strongEtag(etag),
      'journal-write-unknown',
      'Journal PUT was not confirmed with a strong ETag. Reconcile before continuing.'
    )
    let actual
    try {
      actual = await readAt(key)
    } catch {
      throw failure(
        'journal-write-unknown',
        'Journal PUT readback failed. Reconcile before continuing.'
      )
    }
    requireState(
      actual &&
        actual.etag === etag &&
        actual.bodySha256 === digest(body) &&
        canonicalJson(actual.value) === body.toString('utf8'),
      'journal-write-unknown',
      'Journal PUT readback changed. Reconcile before continuing.'
    )
    return { value: actual.value, etag: actual.etag }
  }
  function assertKey(key) {
    requireState(
      key === LINUX_BETA_PUBLICATION_JOURNAL_KEY,
      'journal-key',
      'Only the Linux Beta publication journal key is allowed.'
    )
  }
  return {
    async read(key) {
      assertKey(key)
      const entry = await readAt(key)
      return entry === null ? null : { value: entry.value, etag: entry.etag }
    },
    write(key, value, priorEtag) {
      assertKey(key)
      return writeAt(key, value, priorEtag)
    },
    async probe() {
      const key = `probes/${randomUUID()}.json`
      const first = await writeAt(key, { probe: 1 }, null)
      async function expectConflict(value, etag) {
        try {
          await writeAt(key, value, etag)
        } catch (error) {
          if (error.code === 'journal-conflict') return
          throw error
        }
        throw failure('journal-condition-unsupported', 'Storage ignored a journal write condition.')
      }
      await expectConflict({ probe: 2 }, null)
      const second = await writeAt(key, { probe: 2 }, first.etag)
      await expectConflict({ probe: 3 }, first.etag)
      const attempts = await Promise.allSettled([
        writeAt(key, { probe: 3, contender: 'a' }, second.etag),
        writeAt(key, { probe: 3, contender: 'b' }, second.etag)
      ])
      requireState(
        attempts.filter((entry) => entry.status === 'fulfilled').length === 1 &&
          attempts.filter(
            (entry) => entry.status === 'rejected' && entry.reason.code === 'journal-conflict'
          ).length === 1,
        'journal-condition-unsupported',
        'Concurrent conditional journal writes did not produce exactly one winner.'
      )
      const winner = attempts.find((entry) => entry.status === 'fulfilled').value
      const final = await readAt(key)
      requireState(
        final?.etag === winner.etag && canonicalJson(final?.value) === canonicalJson(winner.value),
        'journal-condition-unsupported',
        'Journal probe did not retain its winning write.'
      )
      return {
        objectKey: `${prefix}/${key}`,
        conditionalCreate: true,
        conditionalUpdate: true,
        concurrentWrite: true,
        etag: final.etag
      }
    },
    close() {
      if (!closed) {
        closed = true
        transport.close()
      }
    }
  }
}
