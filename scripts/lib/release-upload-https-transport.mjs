import { createHash, X509Certificate } from 'node:crypto'
import { Agent, request as httpsRequest } from 'node:https'
import { checkServerIdentity as checkTlsServerIdentity } from 'node:tls'

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000

export class ReleaseUploadHttpsTransportError extends Error {
  constructor(code, message, options) {
    super(message, options)
    this.name = 'ReleaseUploadHttpsTransportError'
    this.code = code
  }
}

export function createReleaseUploadHttpsTransport({
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  tlsPolicy
}) {
  assertTlsPolicy(tlsPolicy)
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw transportError(
      'tls-request-timeout',
      'Release upload HTTPS request timeout must be a positive integer.'
    )
  }
  const agent = new Agent(buildReleaseUploadHttpsAgentOptions(tlsPolicy))
  let closed = false

  return {
    async request(url, { body = null, headers = {}, method }) {
      if (closed) {
        throw transportError('tls-transport-closed', 'Release upload HTTPS transport is closed.')
      }
      const target = new URL(url)
      if (target.protocol !== 'https:') {
        throw transportError(
          'tls-required',
          'Release upload transport refuses every protocol except HTTPS.'
        )
      }
      return await requestOnce({
        agent,
        body,
        headers,
        method,
        requestTimeoutMs,
        target
      })
    },
    close() {
      if (closed) return
      closed = true
      agent.destroy()
    }
  }
}

export function buildReleaseUploadHttpsAgentOptions(tlsPolicy) {
  assertTlsPolicy(tlsPolicy)
  return {
    checkServerIdentity: buildReleaseUploadTlsCheckServerIdentity(tlsPolicy),
    keepAlive: false,
    // A fresh full handshake makes the certificate policy run for every signed
    // request rather than accepting a cached TLS session without a new peer cert.
    maxCachedSessions: 0,
    rejectUnauthorized: true
  }
}

export function buildReleaseUploadTlsCheckServerIdentity(tlsPolicy) {
  assertTlsPolicy(tlsPolicy)
  return (hostname, certificate) => {
    const hostnameError = checkTlsServerIdentity(hostname, certificate)
    if (hostnameError) return hostnameError
    try {
      assertReleaseUploadTlsPeer({ certificate, tlsPolicy })
      return undefined
    } catch (error) {
      return error
    }
  }
}

export function assertReleaseUploadTlsPeer(
  { certificate, tlsPolicy },
  { spkiSha256FromCertificate = certificateSpkiSha256 } = {}
) {
  assertTlsPolicy(tlsPolicy)
  if (!certificate || typeof certificate !== 'object') {
    throw transportError('tls-peer-certificate', 'Release upload peer certificate is missing.')
  }

  const allowedIssuerOrganizations = tlsPolicy.allowedIssuerOrganizations
  const issuerOrganization = safeCertificateText(certificate?.issuer?.O)
  if (
    allowedIssuerOrganizations.length > 0 &&
    !allowedIssuerOrganizations.includes(issuerOrganization)
  ) {
    throw transportError(
      'tls-issuer-rejected',
      `Release upload TLS issuer organization is not allowed: ${issuerOrganization || '(missing)'}.`
    )
  }

  const allowedSpkiSha256 = tlsPolicy.allowedSpkiSha256
  let spkiSha256 = null
  if (allowedSpkiSha256.length > 0) {
    try {
      spkiSha256 = spkiSha256FromCertificate(certificate)
    } catch (cause) {
      throw transportError(
        'tls-spki-unavailable',
        'Release upload peer SPKI could not be derived from its certificate.',
        cause
      )
    }
    if (!allowedSpkiSha256.includes(spkiSha256)) {
      throw transportError(
        'tls-spki-rejected',
        'Release upload peer certificate SPKI SHA-256 is not allowed.'
      )
    }
  }

  return { issuerOrganization, spkiSha256 }
}

async function requestOnce({ agent, body, headers, method, requestTimeoutMs, target }) {
  return await new Promise((resolvePromise, rejectPromise) => {
    let settled = false
    const settleError = (cause) => {
      if (settled) return
      settled = true
      rejectPromise(
        cause instanceof ReleaseUploadHttpsTransportError
          ? cause
          : transportError(
              cause?.code?.startsWith('ERR_TLS_')
                ? 'tls-verification-failed'
                : 'https-request-failed',
              `Release upload HTTPS ${method} failed before a response was accepted.`,
              cause
            )
      )
    }
    const request = httpsRequest(
      target,
      {
        agent,
        headers,
        method
      },
      (response) => {
        if (settled) {
          response.destroy()
          return
        }
        settled = true
        const status = response.statusCode ?? 0
        resolvePromise({
          body: response,
          headers: new IncomingHeaderView(response.headers),
          ok: status >= 200 && status < 300,
          status
        })
      }
    )
    request.once('error', settleError)
    request.setTimeout(requestTimeoutMs, () => {
      request.destroy(
        transportError(
          'https-request-timeout',
          `Release upload HTTPS ${method} exceeded ${requestTimeoutMs}ms.`
        )
      )
    })

    if (body === null || body === undefined) {
      request.end()
      return
    }
    if (typeof body.pipe === 'function') {
      body.once('error', (cause) => request.destroy(cause))
      body.pipe(request)
      return
    }
    request.end(body)
  })
}

class IncomingHeaderView {
  constructor(headers) {
    this.headers = new Map()
    for (const [name, value] of Object.entries(headers)) {
      if (value === undefined) continue
      this.headers.set(name.toLowerCase(), Array.isArray(value) ? value.join(', ') : String(value))
    }
  }

  get(name) {
    return this.headers.get(String(name).toLowerCase()) ?? null
  }
}

function certificateSpkiSha256(certificate) {
  if (!Buffer.isBuffer(certificate?.raw) || certificate.raw.length === 0) {
    throw new Error('peer certificate does not expose DER bytes')
  }
  const x509 = new X509Certificate(certificate.raw)
  const spki = x509.publicKey.export({ format: 'der', type: 'spki' })
  return createHash('sha256').update(spki).digest('hex')
}

function assertTlsPolicy(tlsPolicy) {
  const issuers = tlsPolicy?.allowedIssuerOrganizations
  const spki = tlsPolicy?.allowedSpkiSha256
  if (
    !Array.isArray(issuers) ||
    !Array.isArray(spki) ||
    (issuers.length === 0 && spki.length === 0)
  ) {
    throw transportError(
      'tls-policy-missing',
      'Release upload HTTPS transport requires an issuer or SPKI allowlist.'
    )
  }
}

function safeCertificateText(value) {
  return typeof value === 'string' && !/[\0\r\n]/.test(value) ? value.trim() : ''
}

function transportError(code, message, cause) {
  return new ReleaseUploadHttpsTransportError(
    code,
    message,
    cause === undefined ? undefined : { cause }
  )
}
