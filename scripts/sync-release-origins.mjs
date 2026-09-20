#!/usr/bin/env node
// Copies release objects from one storage origin to another, byte-exact.
//
//   pnpm release:sync:origins -- --pending
//       Replays every dist/release-origin-pending/*.json record: the release an
//       origin missed while it was blocked is copied to it from an origin that
//       has it, then the record is removed.
//
//   pnpm release:sync:origins -- --live --from r2 --to hetzner
//       Copies everything clients can currently be redirected to: the changelog,
//       both platforms' latest manifests and update feeds (public and Windows
//       pilot) and every object those point at. This is the backfill that makes
//       a new origin safe to become primary.
//
//   pnpm release:sync:origins -- --keys a/b.json,c/d.zip --from r2 --to hetzner
//
// Every object is downloaded, hashed, checked against the source's
// videorc-sha256 metadata when present, published with the uploader's own
// conditional PUT, and read back from the destination. Immutable objects are
// never overwritten; stable pointers are replaced only with If-Match.

import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

import {
  clearReleaseOriginPending,
  readReleaseOriginPending,
  resolveReleaseUploadOrigins
} from './lib/release-upload-origins.mjs'
import {
  buildSignedS3Request,
  createReleaseUploadS3Transport,
  publishReleaseUploadArtifact
} from './lib/release-upload-s3.mjs'
import { readRemoteTextObject } from './lib/windows-release-publication.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// Versioned release directories and private candidates never change once
// written. Everything else (latest manifests, update feeds and the flat
// updates/ prefix, the changelog) is a pointer that a later release replaces.
export function isImmutableReleaseObjectKey(objectKey) {
  return (
    /^releases\/(?:macos|windows)\/(?!latest\/|pilot\/)[^/]+\/.+/.test(objectKey) ||
    objectKey.startsWith('candidates/')
  )
}

// Pointers are copied last so a destination never references bytes it lacks.
function orderForCopy(objectKeys) {
  const unique = [...new Set(objectKeys)]
  const isPointerDocument = (key) => /(?:release\.json|\.yml|changelog\.json)$/.test(key)
  return [
    ...unique.filter((key) => isImmutableReleaseObjectKey(key)),
    ...unique.filter((key) => !isImmutableReleaseObjectKey(key) && !isPointerDocument(key)),
    ...unique.filter((key) => !isImmutableReleaseObjectKey(key) && isPointerDocument(key))
  ]
}

function feedFilename(ymlText) {
  return /^path:\s*(\S+)\s*$/m.exec(ymlText)?.[1] ?? null
}

async function resolveLiveObjectKeys({ config }) {
  const keys = []
  const transport = createReleaseUploadS3Transport({ config })
  const read = (objectKey) => readRemoteTextObject({ config, objectKey, transport })
  try {
    if ((await read('changelog/changelog.json')) !== null) keys.push('changelog/changelog.json')

    for (const manifestKey of [
      'releases/macos/latest/release.json',
      'releases/windows/latest/release.json',
      'releases/windows/pilot/release.json'
    ]) {
      const text = await read(manifestKey)
      if (text === null) continue
      const manifest = JSON.parse(text)
      if (typeof manifest.objectKey !== 'string' || typeof manifest.releaseId !== 'string') {
        throw new Error(`${manifestKey} has no objectKey/releaseId`)
      }
      const releaseDir = dirname(manifest.objectKey)
      keys.push(manifest.objectKey, `${manifest.objectKey}.sha256`, `${releaseDir}/release.json`)
      if (manifest.platform === 'windows') {
        keys.push(
          `${manifest.objectKey}.blockmap`,
          `${releaseDir}/FFMPEG-LICENSE.txt`,
          `${releaseDir}/FFMPEG-SOURCE.txt`
        )
      }
      keys.push(manifestKey)
    }

    for (const feedKey of [
      'updates/macos/latest-mac.yml',
      'updates/windows/latest.yml',
      'updates/windows/pilot/latest.yml'
    ]) {
      const text = await read(feedKey)
      if (text === null) continue
      const filename = feedFilename(text)
      if (!filename || filename !== basename(filename)) {
        throw new Error(`${feedKey} does not name one relative update file`)
      }
      const prefix = dirname(feedKey)
      keys.push(`${prefix}/${filename}`, `${prefix}/${filename}.blockmap`, feedKey)
    }
  } finally {
    transport.close()
  }
  return keys
}

async function downloadSourceObject({ config, objectKey, tempDir, transport }) {
  const signed = buildSignedS3Request({ config, method: 'GET', objectKey })
  const response = await transport.request(signed.url, {
    headers: { ...signed.headers, 'accept-encoding': 'identity' },
    method: 'GET'
  })
  if (response.status === 404) {
    response.body?.resume?.()
    return null
  }
  if (!response.ok || !response.body) {
    response.body?.resume?.()
    throw new Error(`could not read source ${objectKey}: HTTP ${response.status}`)
  }
  const path = join(tempDir, createHash('sha256').update(objectKey).digest('hex'))
  const hash = createHash('sha256')
  let sizeBytes = 0
  await pipeline(
    response.body,
    async function* (chunks) {
      for await (const chunk of chunks) {
        hash.update(chunk)
        sizeBytes += chunk.length
        yield chunk
      }
    },
    createWriteStream(path, { mode: 0o600 })
  )
  const sha256 = hash.digest('hex')
  const declared = response.headers.get('x-amz-meta-videorc-sha256')
  if (declared && declared.toLowerCase() !== sha256) {
    throw new Error(`source ${objectKey} does not match its own videorc-sha256 metadata`)
  }
  const contentLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength !== sizeBytes) {
    throw new Error(`source ${objectKey} was truncated (${sizeBytes} of ${contentLength} bytes)`)
  }
  return {
    contentType: response.headers.get('content-type') ?? 'application/octet-stream',
    path,
    sha256,
    sizeBytes
  }
}

async function copyObjects({ expected = new Map(), from, objectKeys, to }) {
  const tempDir = await mkdtemp(join(tmpdir(), 'videorc-origin-sync-'))
  const sourceTransport = createReleaseUploadS3Transport({ config: from.config })
  const destinationTransport = createReleaseUploadS3Transport({ config: to.config })
  const summary = { copied: 0, missing: 0, unchanged: 0 }
  try {
    for (const objectKey of orderForCopy(objectKeys)) {
      const source = await downloadSourceObject({
        config: from.config,
        objectKey,
        tempDir,
        transport: sourceTransport
      })
      if (source === null) {
        summary.missing += 1
        console.log(`release-sync-origins: absent on ${from.name}, skipped ${objectKey}`)
        continue
      }
      const immutable = isImmutableReleaseObjectKey(objectKey)
      const expectedSha256 = expected.get(objectKey)
      if (expectedSha256 && expectedSha256 !== source.sha256) {
        if (immutable) {
          throw new Error(
            `${from.name} holds different bytes for immutable ${objectKey} than the release that was published`
          )
        }
        console.warn(
          `release-sync-origins: WARNING pointer ${objectKey} moved on since the pending record; copying the current ${from.name} value`
        )
      }
      const result = await publishReleaseUploadArtifact({
        artifact: { ...source, immutable, label: 'origin-sync', objectKey },
        config: to.config,
        transport: destinationTransport
      })
      await rm(source.path, { force: true })
      if (result.action === 'uploaded') summary.copied += 1
      else summary.unchanged += 1
      console.log(
        `release-sync-origins: [${from.name} -> ${to.name}] ${result.action} ${source.sizeBytes} bytes ${objectKey}`
      )
    }
  } finally {
    sourceTransport.close()
    destinationTransport.close()
    await rm(tempDir, { force: true, recursive: true })
  }
  return summary
}

function parseArguments(argv) {
  const value = (flag) => {
    const index = argv.indexOf(flag)
    return index === -1 ? null : (argv[index + 1] ?? null)
  }
  return {
    from: value('--from'),
    keys: value('--keys')
      ?.split(',')
      .map((key) => key.trim())
      .filter(Boolean),
    live: argv.includes('--live'),
    pending: argv.includes('--pending'),
    to: value('--to')
  }
}

function requireOrigin(origins, name, flag) {
  const origin = origins.find((candidate) => candidate.name === name)
  if (!origin) {
    throw new Error(
      `${flag} must name a configured origin (${origins.map((candidate) => candidate.name).join(', ')})`
    )
  }
  return origin
}

async function main() {
  const args = parseArguments(process.argv.slice(2))
  const { origins } = resolveReleaseUploadOrigins()

  if (args.pending) {
    const pending = await readReleaseOriginPending(repoRoot)
    if (pending.length === 0) {
      console.log('release-sync-origins: nothing pending')
      return
    }
    for (const { document, path } of pending) {
      const to = requireOrigin(origins, document.origin, 'pending origin')
      const from = origins.find((candidate) => candidate.name !== to.name)
      if (!from) throw new Error('a pending replay needs a second configured origin to copy from')
      console.log(
        `release-sync-origins: replaying ${document.platform} ${document.releaseId} onto ${to.name}`
      )
      const summary = await copyObjects({
        expected: new Map(document.artifacts.map((entry) => [entry.objectKey, entry.sha256])),
        from,
        objectKeys: document.artifacts.map((entry) => entry.objectKey),
        to
      })
      if (summary.missing > 0) {
        throw new Error(`${summary.missing} published objects are absent on ${from.name}`)
      }
      await clearReleaseOriginPending(path)
      console.log(`release-sync-origins: cleared ${path}`)
    }
    console.log('release-sync-origins: PASS')
    return
  }

  if (!args.from || !args.to || args.from === args.to) {
    throw new Error('Usage: --pending | (--live | --keys a,b) --from <origin> --to <origin>')
  }
  const from = requireOrigin(origins, args.from, '--from')
  const to = requireOrigin(origins, args.to, '--to')
  const objectKeys = args.live ? await resolveLiveObjectKeys({ config: from.config }) : args.keys
  if (!objectKeys?.length) throw new Error('Nothing to copy: pass --live or --keys.')
  const summary = await copyObjects({ from, objectKeys, to })
  console.log(
    `release-sync-origins: PASS (${summary.copied} copied, ${summary.unchanged} already identical, ${summary.missing} absent on ${from.name})`
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`release-sync-origins: FAIL (${error?.message ?? 'unexpected error'})`)
    process.exit(1)
  })
}
