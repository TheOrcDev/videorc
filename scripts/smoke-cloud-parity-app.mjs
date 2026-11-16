/** Plan 249 acceptance entrypoint. Heavy/live; do not invoke for schema tests.
 * New cases fail explicitly until their owning slice supplies an implementation.
 */
import { fileURLToPath } from 'node:url'
import {
  readParityJson,
  validateParityRegistry,
  parseParityArgs
} from './lib/cloud-parity-contract.mjs'

const plan = readParityJson('plan')
validateParityRegistry(plan, readParityJson('inventory'))
const selected = parseParityArgs(process.argv.slice(2), plan)
if (selected.case === 'library') {
  const { runLibrary } = await import('./lib/cloud-parity-library.mjs')
  const { output } = await runLibrary()
  console.log(
    `Local library fixture passed: ${output}. Managed/runtime acceptance remains not-run.`
  )
  process.exit(0)
}
if (
  ![
    'baseline',
    'controls',
    'privacy',
    'soundboard',
    'avatar',
    'lifecycle',
    'services',
    'replay-ring'
  ].includes(selected.case)
) {
  throw new Error(
    `${selected.id} case '${selected.case}' is not implemented. Deferred acceptance is not a pass.`
  )
}
const webRoot = process.env.VIDEORC_PARITY_WEB_ROOT
if (!webRoot)
  throw new Error(
    'Set VIDEORC_PARITY_WEB_ROOT to an installed, clean web fixture checkout. Never use a deployed URL.'
  )
const { runBaseline } = await import('./lib/cloud-parity-baseline.mjs')
const run =
  selected.case === 'lifecycle'
    ? (await import('./lib/cloud-parity-lifecycle.mjs')).runLifecycle
    : selected.case === 'services'
      ? (await import('./lib/cloud-parity-services.mjs')).runServices
      : runBaseline
const { output } = await run({
  desktopRoot: fileURLToPath(new URL('../', import.meta.url)),
  webRoot,
  controls: selected.case === 'controls',
  privacy: selected.case === 'privacy',
  soundboard: selected.case === 'soundboard',
  avatar: selected.case === 'avatar',
  replayRing: selected.case === 'replay-ring'
})
console.log(
  `Local real-page ${selected.case} passed: ${output}. Managed/device acceptance remains not-run.`
)
