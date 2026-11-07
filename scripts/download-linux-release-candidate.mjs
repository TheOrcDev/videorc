import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { assertPrivateLinuxCandidateS3Config } from './lib/linux-release-candidate.mjs'
import { downloadLinuxCandidate } from './lib/linux-release-download.mjs'
import { resolveReleaseUploadOrigins } from './lib/release-upload-origins.mjs'
import { buildSignedS3Request } from './lib/release-upload-s3.mjs'

async function main() {
  const { values } = parseArgs({
    options: {
      'release-id': { type: 'string' },
      'source-commit': { type: 'string' },
      sha256: { type: 'string' },
      'output-parent': { type: 'string' }
    }
  })
  if (!values['output-parent']) throw new Error('--output-parent is required.')
  const { origins, primaryName } = resolveReleaseUploadOrigins()
  const origin = origins.find((item) => item.name === primaryName)
  if (!origin) throw new Error('No primary candidate storage origin is configured.')
  const config = assertPrivateLinuxCandidateS3Config(origin.config)
  const result = await downloadLinuxCandidate({
    coordinates: {
      releaseId: values['release-id'],
      sourceCommit: values['source-commit'],
      appImageSha256: values.sha256
    },
    parentDirectory: resolve(values['output-parent']),
    getObject: async (objectKey) => {
      const signed = buildSignedS3Request({ config, method: 'GET', objectKey })
      return fetch(signed.url, {
        headers: { ...signed.headers, 'accept-encoding': 'identity' },
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(10 * 60_000)
      })
    }
  })
  console.log(`Linux candidate download verified: ${result.plan.candidateIdentity}`)
  console.log(`Private local directory: ${result.directory}`)
  console.log('Candidate code was not executed. Remove storage authority before launching it.')
}

main().catch((error) => {
  console.error(`Linux candidate download failed: ${error.message}`)
  process.exitCode = 1
})
