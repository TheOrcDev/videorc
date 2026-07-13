import { runAcceptanceGate } from './linux-acceptance-gate.mjs'

const code = await runAcceptanceGate(process.argv)
if (code !== 0 && code !== undefined) {
  process.exit(code)
}
