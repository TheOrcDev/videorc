#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import {
  assessLinuxBetaAcceptance,
  linuxBetaAcceptanceTemplate,
  verifyLinuxBetaEvidenceFiles
} from './lib/linux-beta-acceptance.mjs'

try {
  const args = process.argv.slice(2)
  const template = args[0] === '--template'
  if (template ? args.length !== 2 : args.length !== 3)
    throw new Error(
      'Usage: node scripts/validate-linux-beta-acceptance.mjs <release.json> <record.json> <private-evidence-root> | --template <release.json>'
    )
  const manifest = JSON.parse(await readFile(args[template ? 1 : 0], 'utf8'))
  if (template) {
    console.log(JSON.stringify(linuxBetaAcceptanceTemplate(manifest), null, 2))
  } else {
    const record = JSON.parse(await readFile(args[1], 'utf8'))
    const result = assessLinuxBetaAcceptance(record, manifest)
    if (!result.ok) throw new Error(result.failures.join('\n'))
    const evidence = await verifyLinuxBetaEvidenceFiles(record, args[2])
    console.log(
      JSON.stringify({
        status: 'pass',
        releaseId: manifest.releaseId,
        sha256: manifest.sha256,
        ...evidence
      })
    )
  }
} catch (error) {
  console.error(`linux-beta-acceptance: FAIL\n${error.message}`)
  process.exitCode = 1
}
