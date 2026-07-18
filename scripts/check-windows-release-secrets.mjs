#!/usr/bin/env node

import {
  missingWindowsReleaseSigningEnv,
  WINDOWS_RELEASE_SIGNING_ENV
} from './lib/windows-release-preflight.mjs'

const missing = missingWindowsReleaseSigningEnv(process.env)
if (missing.length > 0) {
  console.error(`windows-release-secrets: FAIL (missing ${missing.join(', ')})`)
  process.exit(1)
}

console.log('windows-release-secrets: PASS')
for (const name of WINDOWS_RELEASE_SIGNING_ENV) {
  console.log(`[ok] ${name} (present)`)
}
