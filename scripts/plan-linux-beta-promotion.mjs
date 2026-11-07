import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  buildLinuxBetaPublicPromotionPlan,
  linuxPromotionGitReader
} from './lib/linux-beta-promotion.mjs'

try {
  const { values } = parseArgs({
    options: Object.fromEntries(
      [
        'candidate-dir',
        'release-id',
        'source-commit',
        'sha256',
        'trusted-main-commit',
        'acceptance-record-url',
        'evidence-root',
        'output'
      ].map((key) => [key, { type: 'string' }])
    )
  })
  for (const key of ['candidate-dir', 'evidence-root', 'output'])
    if (!values[key]) throw new Error(`--${key} is required.`)
  const plan = await buildLinuxBetaPublicPromotionPlan({
    candidateDirectory: resolve(values['candidate-dir']),
    coordinates: {
      releaseId: values['release-id'],
      sourceCommit: values['source-commit'],
      appImageSha256: values.sha256
    },
    trustedMainCommit: values['trusted-main-commit'],
    acceptanceRecordUrl: values['acceptance-record-url'],
    evidenceRoot: resolve(values['evidence-root']),
    git: linuxPromotionGitReader(resolve(import.meta.dirname, '..'))
  })
  await writeFile(resolve(values.output), `${JSON.stringify(plan, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600
  })
  console.log(`Linux Beta public promotion plan prepared: ${plan.candidateIdentity}`)
  console.log('Read-only plan. Protected finalization and production verification remain required.')
} catch (error) {
  console.error(`Linux Beta promotion planning failed: ${error.message}`)
  process.exitCode = 1
}
