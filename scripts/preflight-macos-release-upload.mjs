#!/usr/bin/env node

import { getReleaseUploadS3Config, ReleaseUploadConfigError } from './lib/release-upload-s3.mjs'

try {
  const config = getReleaseUploadS3Config()
  console.log('macos-release-upload-preflight: PASS')
  console.log(`[ok] env: S3 access key (${config.accessKeyId ? 'present' : 'missing'})`)
  console.log(`[ok] env: S3 bucket (${config.bucket ? 'present' : 'missing'})`)
  console.log(`[ok] env: S3 region (${config.region ? 'present' : 'missing'})`)
  console.log(`[ok] env: S3 secret access key (${config.secretAccessKey ? 'present' : 'missing'})`)
  console.log(
    `[ok] env: S3 endpoint (${config.endpointUrl ? 'configured' : 'default AWS endpoint'})`
  )
  console.log(`[ok] env: S3 force path style (${config.forcePathStyle ? 'enabled' : 'disabled'})`)
  console.log(`[ok] env: S3 session token (${config.sessionToken ? 'present' : 'not configured'})`)
} catch (error) {
  if (error instanceof ReleaseUploadConfigError) {
    console.error(`macos-release-upload-preflight: FAIL (${error.message})`)
    process.exit(1)
  }

  console.error(`macos-release-upload-preflight: FAIL (${error?.message ?? 'unexpected error'})`)
  process.exit(1)
}
