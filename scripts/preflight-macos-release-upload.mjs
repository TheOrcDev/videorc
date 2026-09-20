#!/usr/bin/env node

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  assertNoReleaseOriginPending,
  probeReleaseUploadOrigin,
  resolveReleaseUploadOrigins
} from './lib/release-upload-origins.mjs'
import { releaseUploadOriginCapabilities } from './lib/release-upload-s3.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

try {
  const { origins, primaryName } = resolveReleaseUploadOrigins()
  await assertNoReleaseOriginPending(repoRoot)
  const lines = []
  let primaryReachable = false
  for (const { config, name } of origins) {
    const role = name === primaryName ? 'primary' : 'mirror'
    const capabilities = releaseUploadOriginCapabilities(config)
    const probe = await probeReleaseUploadOrigin({ config })
    if (name === primaryName) primaryReachable = probe.reachable
    lines.push(`[ok] origin ${name} (${role}): S3 access key (present)`)
    lines.push(`[ok] origin ${name} (${role}): S3 bucket (present), region (present)`)
    lines.push(
      `[ok] origin ${name} (${role}): S3 endpoint (${config.endpointUrl ? 'configured' : 'default AWS endpoint'}), force path style (${config.forcePathStyle ? 'enabled' : 'disabled'})`
    )
    lines.push(
      `[ok] origin ${name} (${role}): checksum headers (${capabilities.checksumHeaders ? 'yes' : 'no'}), If-Match ETag form (${capabilities.ifMatchEtagForm})`
    )
    lines.push(
      probe.reachable
        ? `[ok] origin ${name} (${role}): reachable with a trusted TLS issuer`
        : `[warn] origin ${name} (${role}): UNREACHABLE (${probe.reason})`
    )
  }
  if (!primaryReachable) {
    console.error(
      `macos-release-upload-preflight: FAIL (the primary origin ${primaryName} is unreachable; see the upload's VIDEORC_RELEASE_ALLOW_MIRROR_ONLY escape)`
    )
    for (const line of lines) console.error(line)
    process.exit(1)
  }
  console.log('macos-release-upload-preflight: PASS')
  for (const line of lines) console.log(line)
} catch (error) {
  console.error(`macos-release-upload-preflight: FAIL (${error?.message ?? 'unexpected error'})`)
  process.exit(1)
}
