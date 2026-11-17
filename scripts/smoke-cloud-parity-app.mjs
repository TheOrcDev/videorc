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
if (selected.case === 'microphone') {
  const { microphoneAcquisitionConfig } = await import('./lib/cloud-parity-microphone-contract.mjs')
  const { acquireMicrophone, analyzeMicrophone } = await import('./lib/cloud-parity-microphone.mjs')
  const config = microphoneAcquisitionConfig(process.env)
  let file = process.env.VIDEORC_PCM_EVIDENCE
  if (config.mode !== 'analyze')
    file = await acquireMicrophone({
      desktopRoot: fileURLToPath(new URL('../', import.meta.url)),
      webRoot: process.env.VIDEORC_PARITY_WEB_ROOT,
      config
    })
  console.log(`Microphone evidence (unqualified): ${file}`)
  if (config.mode !== 'acquire') {
    const result = await analyzeMicrophone(file)
    const { writeFileSync } = await import('node:fs')
    writeFileSync(`${file}.qualification.json`, JSON.stringify(result, null, 2) + '\n')
    console.log(JSON.stringify(result, null, 2))
    if (result.status !== 'passed') process.exitCode = 1
  }
  process.exit(process.exitCode ?? 0)
}
if (selected.case === 'microphone-bridge') {
  const { pcmAcquisitionConfig } = await import('./lib/cloud-parity-pcm-acquisition-contract.mjs')
  const config = pcmAcquisitionConfig(process.env)
  let evidenceFile = process.env.VIDEORC_PCM_EVIDENCE
  if (config.mode !== 'analyze') {
    const { acquirePcmEvidence } = await import('./lib/cloud-parity-pcm-acquire.mjs')
    const acquired = await acquirePcmEvidence({
      desktopRoot: fileURLToPath(new URL('../', import.meta.url)),
      webRoot: process.env.VIDEORC_PARITY_WEB_ROOT,
      config
    })
    evidenceFile = acquired.evidenceFile
    console.log(`PCM artifacts acquired (not qualified): ${evidenceFile}`)
  }
  if (config.mode !== 'acquire') {
    const { analyzePcmEvidence } = await import('./lib/cloud-parity-pcm.mjs')
    const { writeFileSync } = await import('node:fs')
    const result = await analyzePcmEvidence(evidenceFile)
    writeFileSync(`${evidenceFile}.qualification.json`, JSON.stringify(result, null, 2) + '\n')
    console.log(JSON.stringify(result, null, 2))
    if (result.status !== 'passed') process.exitCode = 1
  }
  process.exit(process.exitCode ?? 0)
}
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
    'captions',
    'baseline',
    'controls',
    'privacy',
    'soundboard',
    'avatar',
    'scenes',
    'lifecycle',
    'services',
    'archive',
    'replay-ring',
    'avatar-animation',
    'views',
    'graphics',
    'alpha-spike',
    'handoff'
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
if (selected.case === 'handoff') {
  // Plan 249 S24: the focused race/retention/D9 tests first (web and Rust).
  const { HANDOFF_RUST_FILTERS, HANDOFF_WEB_TESTS } = await import('./lib/cloud-parity-handoff.mjs')
  const { execFileSync } = await import('node:child_process')
  execFileSync(process.execPath, ['--import', 'tsx', '--test', ...HANDOFF_WEB_TESTS], {
    cwd: webRoot,
    stdio: 'inherit'
  })
  for (const filter of HANDOFF_RUST_FILTERS)
    execFileSync('cargo', ['test', '-p', 'videorc-backend', filter], {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      stdio: 'inherit'
    })
}
const { runBaseline } = await import('./lib/cloud-parity-baseline.mjs')
const run =
  selected.case === 'alpha-spike'
    ? (await import('./lib/cloud-parity-alpha.mjs')).runAlphaSpike
    : selected.case === 'lifecycle'
      ? (await import('./lib/cloud-parity-lifecycle.mjs')).runLifecycle
      : selected.case === 'services'
        ? (await import('./lib/cloud-parity-services.mjs')).runServices
        : runBaseline
const { output } = await run({
  desktopRoot: fileURLToPath(new URL('../', import.meta.url)),
  webRoot,
  captions: selected.case === 'captions',
  controls: selected.case === 'controls',
  privacy: selected.case === 'privacy',
  soundboard: selected.case === 'soundboard',
  avatar: selected.case === 'avatar',
  scenes: selected.case === 'scenes',
  archive: selected.case === 'archive',
  replayRing: ['replay-ring', 'archive'].includes(selected.case),
  avatarAnimation: selected.case === 'avatar-animation',
  views: selected.case === 'views',
  graphics: selected.case === 'graphics',
  handoff: selected.case === 'handoff'
})
console.log(
  `Local real-page ${selected.case} passed: ${output}. Managed/device acceptance remains not-run.`
)
