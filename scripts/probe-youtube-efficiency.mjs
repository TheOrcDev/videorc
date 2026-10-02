import { readFile } from 'node:fs/promises'
import { assessYouTubeTrial } from './lib/youtube-efficiency-probe.mjs'

// Offline preparation only until the owner has current quota headroom. Never
// accepts credentials, opens Google connections, or prints input fields.
const [mode, path, ...extra] = process.argv.slice(2)
if (mode !== '--preflight' || !path || extra.length) {
  console.log(
    JSON.stringify(
      {
        measurementStatus: 'blocked',
        blocker: 'live-protocol-and-billing-trial-pending',
        usage: 'pnpm probe:youtube-efficiency --preflight <metrics.json>'
      },
      null,
      2
    )
  )
  process.exitCode = 2
} else {
  try {
    const bytes = await readFile(path)
    if (bytes.length > 16_384) throw new Error('oversize')
    const result = assessYouTubeTrial(JSON.parse(bytes.toString('utf8')))
    console.log(JSON.stringify(result, null, 2))
    process.exitCode = result.eligible ? 0 : 2
  } catch {
    console.log(
      JSON.stringify({ measurementStatus: 'not-performed', blockers: ['invalid-preflight-file'] })
    )
    process.exitCode = 2
  }
}
