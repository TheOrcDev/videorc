#!/usr/bin/env node
// Release storage compatibility probe.
//
// The release uploader is not a plain S3 client: it depends on conditional
// PUTs, S3 checksum headers, user metadata round trips and presigned ranged
// GETs. This probe proves, against a real bucket, which of those an
// S3-compatible origin honours before any release is pointed at it.
//
//   pnpm probe:release-storage-compat -- --origin r2
//   pnpm probe:release-storage-compat -- --origin hetzner
//
// `r2` reads the uploader's normal VIDEORC_RELEASE_UPLOAD_S3_* /
// VIDEORC_DOWNLOAD_S3_* environment. Any other origin name reads
// VIDEORC_RELEASE_UPLOAD_<ORIGIN>_S3_*. Everything is written under
// compat-probe/<timestamp>/ and deleted afterwards. No secret is ever printed.

import { createHash, createHmac, randomBytes } from 'node:crypto'
import { connect as tlsConnect } from 'node:tls'

import {
  buildSignedS3Request,
  createReleaseUploadS3Transport,
  getReleaseUploadS3Config,
  sha256Base64FromHex
} from './lib/release-upload-s3.mjs'

const ORIGIN_ENV_SUFFIXES = [
  'ACCESS_KEY_ID',
  'SECRET_ACCESS_KEY',
  'SESSION_TOKEN',
  'BUCKET',
  'REGION',
  'ENDPOINT_URL',
  'FORCE_PATH_STYLE',
  'TLS_ALLOWED_ISSUER_ORGANIZATIONS',
  'TLS_ALLOWED_SPKI_SHA256'
]

function parseOrigin(argv) {
  const index = argv.indexOf('--origin')
  const origin = index === -1 ? null : argv[index + 1]
  if (!origin || !/^[a-z0-9]+$/.test(origin)) {
    throw new Error('Usage: probe-release-storage-compat --origin <r2|hetzner|...>')
  }
  return origin
}

// A named origin is mapped onto the uploader's own variable names so the probe
// exercises the exact config parser, signer and TLS-pinned transport.
function originEnvironment(origin, env) {
  if (origin === 'r2') return env
  const mapped = {}
  for (const suffix of ORIGIN_ENV_SUFFIXES) {
    const value = env[`VIDEORC_RELEASE_UPLOAD_${origin.toUpperCase()}_S3_${suffix}`]
    if (value) mapped[`VIDEORC_RELEASE_UPLOAD_S3_${suffix}`] = value
  }
  return mapped
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function readBody(response) {
  const chunks = []
  for await (const chunk of response.body) chunks.push(chunk)
  return Buffer.concat(chunks)
}

function s3ErrorCode(bodyText) {
  return /<Code>([^<]+)<\/Code>/.exec(bodyText)?.[1] ?? null
}

async function signedRequest({ config, transport, method, objectKey, body = null, headers = {} }) {
  const signed = buildSignedS3Request({
    additionalHeaders: headers,
    config,
    method,
    objectKey,
    ...(body ? { payloadSha256: sha256Hex(body) } : {})
  })
  const response = await transport.request(signed.url, {
    body,
    headers: {
      ...signed.headers,
      ...(body ? { 'Content-Length': String(body.length) } : {})
    },
    method
  })
  const responseBody = await readBody(response)
  return {
    body: responseBody,
    errorCode: response.ok ? null : s3ErrorCode(responseBody.toString('utf8')),
    headers: response.headers,
    status: response.status
  }
}

// Same presign scheme videorc-web hands to desktop clients: query-signed GET,
// UNSIGNED-PAYLOAD, `host` as the only signed header.
function presignGetUrl({ config, objectKey, contentDisposition = null, ttlSeconds = 300 }) {
  const now = new Date()
  const amzDate = now.toISOString().replace(/[-:]|\.\d{3}/g, '')
  const dateStamp = amzDate.slice(0, 8)
  const scope = `${dateStamp}/${config.region}/s3/aws4_request`
  const url = new URL(config.endpointUrl)
  const encodedKey = objectKey.split('/').map(encodeURIComponent).join('/')
  url.pathname = `/${config.bucket}/${encodedKey}`
  const params = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${config.accessKeyId}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(ttlSeconds)],
    ['X-Amz-SignedHeaders', 'host']
  ]
  if (contentDisposition) params.push(['response-content-disposition', contentDisposition])
  const encode = (value) =>
    encodeURIComponent(value).replace(
      /[!'()*]/g,
      (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
    )
  const canonicalQuery = params
    .map(([name, value]) => [encode(name), encode(value)])
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join('&')
  const canonicalRequest = [
    'GET',
    url.pathname,
    canonicalQuery,
    `host:${url.host}\n`,
    'host',
    'UNSIGNED-PAYLOAD'
  ].join('\n')
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n')
  const hmac = (key, value) => createHmac('sha256', key).update(value).digest()
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${config.secretAccessKey}`, dateStamp), config.region), 's3'),
    'aws4_request'
  )
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex')
  return `${url.origin}${url.pathname}?${canonicalQuery}&X-Amz-Signature=${signature}`
}

function describeTlsPeer(endpointUrl) {
  const { hostname } = new URL(endpointUrl)
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ host: hostname, port: 443, servername: hostname }, () => {
      const certificate = socket.getPeerX509Certificate()
      const issuerOrganization = /(?:^|\n)O=([^\n]+)/.exec(certificate.issuer)?.[1] ?? null
      const spkiSha256 = createHash('sha256')
        .update(certificate.publicKey.export({ format: 'der', type: 'spki' }))
        .digest('hex')
      socket.end()
      resolve({ authorized: socket.authorized, issuerOrganization, spkiSha256 })
    })
    socket.setTimeout(15_000, () => socket.destroy(new Error('TLS probe timed out')))
    socket.once('error', reject)
  })
}

async function main() {
  const origin = parseOrigin(process.argv.slice(2))
  const config = getReleaseUploadS3Config(originEnvironment(origin, process.env))
  if (!config.endpointUrl) throw new Error('The probe needs an explicit S3 endpoint URL.')
  const transport = createReleaseUploadS3Transport({ config })
  const prefix = `compat-probe/${new Date().toISOString().replace(/[:.]/g, '-')}`
  const results = []
  const created = new Set()
  const record = (id, name, pass, detail) => {
    results.push({ id, name, pass, detail })
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${id} ${name} — ${detail}`)
  }
  const attempt = async (id, name, run) => {
    try {
      await run()
    } catch (error) {
      record(id, name, false, `threw ${error?.code ?? error?.name}: ${error?.message}`)
    }
  }

  console.log(`release-storage-compat: origin=${origin} host=${new URL(config.endpointUrl).host}`)
  console.log(`release-storage-compat: bucket=${config.bucket} region=${config.region}`)

  const bodyA = randomBytes(256 * 1024)
  const bodyB = randomBytes(256 * 1024)
  const immutableKey = `${prefix}/immutable.bin`
  const pointerKey = `${prefix}/pointer.bin`
  const put = (objectKey, body, headers = {}) =>
    signedRequest({
      body,
      config,
      headers: { ...headers, 'x-amz-meta-videorc-sha256': sha256Hex(body) },
      method: 'PUT',
      objectKey,
      transport
    })
  const head = (objectKey) =>
    signedRequest({
      config,
      headers: { 'x-amz-checksum-mode': 'ENABLED' },
      method: 'HEAD',
      objectKey,
      transport
    })

  try {
    await attempt('1a', 'If-None-Match:* creates a missing object', async () => {
      const response = await put(immutableKey, bodyA, { 'if-none-match': '*' })
      if (response.status >= 200 && response.status < 300) created.add(immutableKey)
      record(
        '1a',
        'If-None-Match:* creates a missing object',
        response.status === 200,
        `status ${response.status}${response.errorCode ? ` ${response.errorCode}` : ''}`
      )
    })
    await attempt('1b', 'If-None-Match:* refuses an existing object', async () => {
      const response = await put(immutableKey, bodyB, { 'if-none-match': '*' })
      const after = await head(immutableKey)
      const unchanged = after.headers.get('x-amz-meta-videorc-sha256') === sha256Hex(bodyA)
      record(
        '1b',
        'If-None-Match:* refuses an existing object',
        response.status === 412 && unchanged,
        `status ${response.status}${response.errorCode ? ` ${response.errorCode}` : ''}, stored bytes ${unchanged ? 'unchanged' : 'OVERWRITTEN'}`
      )
    })

    let pointerEtag = null
    let staleEtag = null
    await attempt('2a', 'If-Match:<etag> replaces a pointer', async () => {
      const first = await put(pointerKey, bodyA, { 'if-none-match': '*' })
      if (first.status >= 200 && first.status < 300) created.add(pointerKey)
      pointerEtag = first.headers.get('etag') ?? (await head(pointerKey)).headers.get('etag')
      if (!pointerEtag) throw new Error('no ETag returned for the pointer object')
      // Some gateways compare If-Match against the bare hex digest and answer
      // 412 for the quoted entity tag S3 returns. Record which form is honoured.
      let form = 'quoted'
      let response = await put(pointerKey, bodyB, { 'if-match': pointerEtag })
      const bareEtag = pointerEtag.replace(/^"|"$/g, '')
      if (response.status === 412 && bareEtag !== pointerEtag) {
        form = 'unquoted'
        response = await put(pointerKey, bodyB, { 'if-match': bareEtag })
      }
      const after = await head(pointerKey)
      const replaced = after.headers.get('x-amz-meta-videorc-sha256') === sha256Hex(bodyB)
      staleEtag = form === 'quoted' ? pointerEtag : bareEtag
      record(
        '2a',
        'If-Match:<etag> replaces a pointer',
        response.status === 200 && replaced && form === 'quoted',
        `status ${response.status}${response.errorCode ? ` ${response.errorCode}` : ''}, bytes ${replaced ? 'replaced' : 'NOT replaced'}, etag form honoured: ${response.status === 200 ? form : 'none'}`
      )
    })
    await attempt('2b', 'If-Match:<stale etag> is refused', async () => {
      if (!staleEtag) throw new Error('2a did not produce an ETag')
      const before = (await head(pointerKey)).headers.get('x-amz-meta-videorc-sha256')
      const response = await put(pointerKey, randomBytes(1024), { 'if-match': staleEtag })
      const after = (await head(pointerKey)).headers.get('x-amz-meta-videorc-sha256')
      const stale = before === sha256Hex(bodyB)
      record(
        '2b',
        'If-Match:<stale etag> is refused',
        stale && response.status === 412 && after === before,
        stale
          ? `status ${response.status}${response.errorCode ? ` ${response.errorCode}` : ''}, stored bytes ${after === before ? 'unchanged' : 'OVERWRITTEN'}`
          : 'not evaluated: 2a never replaced the pointer, so the etag is not stale'
      )
    })

    await attempt('3a', 'x-amz-checksum-sha256 round trips on HEAD', async () => {
      const response = await head(immutableKey)
      const expected = sha256Base64FromHex(sha256Hex(bodyA))
      const actual = response.headers.get('x-amz-checksum-sha256')
      record(
        '3a',
        'x-amz-checksum-sha256 round trips on HEAD',
        actual === expected,
        actual === null
          ? `status ${response.status}, header absent`
          : `status ${response.status}, header ${actual === expected ? 'matches' : 'DIFFERS'}`
      )
    })
    await attempt('3b', 'a body that does not match its signed hash is rejected', async () => {
      const objectKey = `${prefix}/corrupt.bin`
      const signed = buildSignedS3Request({
        additionalHeaders: { 'if-none-match': '*' },
        config,
        method: 'PUT',
        objectKey,
        payloadSha256: sha256Hex(bodyA)
      })
      const response = await transport.request(signed.url, {
        body: bodyB,
        headers: { ...signed.headers, 'Content-Length': String(bodyB.length) },
        method: 'PUT'
      })
      const text = (await readBody(response)).toString('utf8')
      if (response.ok) created.add(objectKey)
      // Only an integrity rejection counts. An auth, precondition or endpoint
      // error is also a 4xx and would prove nothing about the body check.
      const code = s3ErrorCode(text)
      const integrityRejection = ['XAmzContentSHA256Mismatch', 'BadDigest', 'InvalidDigest']
      record(
        '3b',
        'a body that does not match its signed hash is rejected',
        response.status === 400 && integrityRejection.includes(code),
        `status ${response.status} ${code ?? ''}`.trim()
      )
    })

    await attempt('4', 'x-amz-meta-videorc-sha256 survives HEAD', async () => {
      const response = await head(immutableKey)
      const actual = response.headers.get('x-amz-meta-videorc-sha256')
      record(
        '4',
        'x-amz-meta-videorc-sha256 survives HEAD',
        actual === sha256Hex(bodyA),
        `status ${response.status}, metadata ${actual === null ? 'absent' : actual === sha256Hex(bodyA) ? 'matches' : 'DIFFERS'}`
      )
    })

    await attempt('5a', 'presigned GET returns the exact bytes', async () => {
      const response = await fetch(presignGetUrl({ config, objectKey: immutableKey }))
      const bytes = Buffer.from(await response.arrayBuffer())
      record(
        '5a',
        'presigned GET returns the exact bytes',
        response.status === 200 && sha256Hex(bytes) === sha256Hex(bodyA),
        `status ${response.status}, ${bytes.length} bytes`
      )
    })
    await attempt('5b', 'presigned GET honours Range', async () => {
      const response = await fetch(presignGetUrl({ config, objectKey: immutableKey }), {
        headers: { Range: 'bytes=1000-1999' }
      })
      const bytes = Buffer.from(await response.arrayBuffer())
      const exact = bytes.equals(bodyA.subarray(1000, 2000))
      record(
        '5b',
        'presigned GET honours Range',
        response.status === 206 && exact,
        `status ${response.status}, content-range ${response.headers.get('content-range') ?? 'absent'}`
      )
    })
    await attempt('5c', 'presigned GET honours response-content-disposition', async () => {
      const disposition = 'attachment; filename="Videorc-probe.dmg"'
      const response = await fetch(
        presignGetUrl({ config, contentDisposition: disposition, objectKey: immutableKey }),
        { headers: { Range: 'bytes=0-0' } }
      )
      await response.arrayBuffer()
      const actual = response.headers.get('content-disposition')
      record(
        '5c',
        'presigned GET honours response-content-disposition',
        actual === disposition,
        `status ${response.status}, header ${actual ?? 'absent'}`
      )
    })

    await attempt('6', 'TLS peer', async () => {
      const peer = await describeTlsPeer(config.endpointUrl)
      record(
        '6',
        'TLS peer',
        peer.authorized,
        `issuer O="${peer.issuerOrganization}", leaf SPKI SHA-256 ${peer.spkiSha256}`
      )
    })
  } finally {
    await attempt('7', 'DELETE removes the scratch objects', async () => {
      const leftovers = []
      for (const objectKey of created) {
        const response = await signedRequest({ config, method: 'DELETE', objectKey, transport })
        const after = await head(objectKey)
        if (response.status !== 204 || after.status !== 404) {
          leftovers.push(`${objectKey} (delete ${response.status}, head ${after.status})`)
        }
      }
      record(
        '7',
        'DELETE removes the scratch objects',
        leftovers.length === 0,
        leftovers.length === 0
          ? `${created.size} objects removed`
          : `left behind: ${leftovers.join(', ')}`
      )
    })
    transport.close()
  }

  const failed = results.filter((result) => !result.pass)
  console.log(
    `release-storage-compat: ${origin} ${failed.length === 0 ? 'PASS' : `FAIL (${failed.map((result) => result.id).join(', ')})`}`
  )
  process.exitCode = failed.length === 0 ? 0 : 1
}

main().catch((error) => {
  console.error(`release-storage-compat: ${error?.code ?? error?.name}: ${error?.message}`)
  process.exitCode = 2
})
