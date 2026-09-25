#!/usr/bin/env node

import {
  isHttpsReleaseUploadEndpoint,
  linuxReleaseUploadEndpoint,
  missingLinuxReleaseUploadEnv
} from './lib/linux-release-preflight.mjs'

const missing = missingLinuxReleaseUploadEnv(process.env)
if (missing.length > 0) {
  console.error(`linux-release-secrets: FAIL (missing ${missing.join(', ')})`)
  process.exit(1)
}

const endpoint = linuxReleaseUploadEndpoint(process.env) ?? ''
if (!isHttpsReleaseUploadEndpoint(endpoint)) {
  console.error('linux-release-secrets: FAIL (upload endpoint must be HTTPS)')
  process.exit(1)
}

console.log('linux-release-secrets: PASS')
console.log('[ok] candidate upload credentials (present)')
console.log('[ok] upload endpoint (https)')
