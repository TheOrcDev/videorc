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
if (selected.case === 'iso') {
  // Plan 249 S22: real desktop + GuestRoom guests + program page + the real
  // durable web ISO runtime over local LiveKit; never paid egress.
  const { isoAcquisitionConfig } = await import('./lib/cloud-parity-iso-contract.mjs')
  const { acquireIsoEvidence, analyzeIsoEvidenceFile } = await import('./lib/cloud-parity-iso.mjs')
  const config = isoAcquisitionConfig(process.env)
  let file = process.env.VIDEORC_ISO_EVIDENCE
  if (config.mode !== 'analyze')
    ({ evidenceFile: file } = await acquireIsoEvidence({
      desktopRoot: fileURLToPath(new URL('../', import.meta.url)),
      webRoot: process.env.VIDEORC_PARITY_WEB_ROOT,
      config
    }))
  if (config.mode !== 'acquire') {
    const result = await analyzeIsoEvidenceFile(file, config)
    console.log(JSON.stringify(result, null, 2))
    if (result.status !== 'passed') process.exitCode = 1
  } else console.log(`ISO artifacts acquired (not qualified): ${file}`)
  process.exit(process.exitCode ?? 0)
}
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
if (selected.case === 'camera-bridge') {
  const { cameraBridgeConfig, analyzeCameraBridgeEvidence } =
    await import('./lib/cloud-parity-camera-bridge-contract.mjs')
  const config = cameraBridgeConfig(process.env)
  if (config.mode === 'analyze-recording') {
    // Offline: a finalized recording the operator already holds. A managed
    // egress recording needs VIDEORC_MANAGED_RECORDING_AUTHORIZED=1; nothing
    // here downloads or contacts a service.
    const { analyzeCompositedRecording, readGeometryFile } =
      await import('./lib/cloud-parity-camera-bridge-recording.mjs')
    const geometry = readGeometryFile(process.env.VIDEORC_CAMERA_BRIDGE_GEOMETRY)
    const result = await analyzeCompositedRecording({
      file: process.env.VIDEORC_CAMERA_BRIDGE_RECORDING,
      geometry,
      scale: Number(process.env.VIDEORC_CAMERA_BRIDGE_RECORDING_SCALE ?? 1),
      ground: geometry.ground,
      ffmpeg: process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg',
      ffprobe: process.env.VIDEORC_SMOKE_FFPROBE_PATH ?? 'ffprobe',
      managed: process.env.VIDEORC_CAMERA_BRIDGE_MANAGED === '1',
      authorized: process.env.VIDEORC_MANAGED_RECORDING_AUTHORIZED === '1'
    })
    console.log(JSON.stringify({ ...result, productionQualified: false }, null, 2))
    process.exit(result.status === 'passed' ? 0 : 1)
  }
  let evidenceFile = process.env.VIDEORC_CAMERA_BRIDGE_EVIDENCE
  if (config.mode !== 'analyze') {
    const { acquireCameraBridgeEvidence } =
      await import('./lib/cloud-parity-camera-bridge-acquire.mjs')
    const acquired = await acquireCameraBridgeEvidence({
      desktopRoot: fileURLToPath(new URL('../', import.meta.url)),
      webRoot: process.env.VIDEORC_PARITY_WEB_ROOT,
      config
    })
    evidenceFile = acquired.evidenceFile
    console.log(`Camera bridge artifacts acquired (not qualified): ${evidenceFile}`)
  }
  if (config.mode !== 'acquire') {
    if (!evidenceFile)
      throw new Error('VIDEORC_CAMERA_BRIDGE_EVIDENCE names the evidence to analyze')
    const { writeFileSync } = await import('node:fs')
    const result = await analyzeCameraBridgeEvidence(evidenceFile, config.baselineEvidence)
    writeFileSync(`${evidenceFile}.qualification.json`, JSON.stringify(result, null, 2) + '\n')
    console.log(JSON.stringify(result, null, 2))
    if (result.status !== 'passed') process.exitCode = 1
  }
  process.exit(process.exitCode ?? 0)
}
if (selected.case === 'camera') {
  // S13b: local LiveKit with the debug fixture camera. Never qualifies production.
  const { cameraCaseConfig } = await import('./lib/cloud-parity-camera-contract.mjs')
  const { acquireCameraCase, analyzeCameraCase } = await import('./lib/cloud-parity-camera.mjs')
  const config = cameraCaseConfig(process.env)
  let evidenceFile = process.env.VIDEORC_CAMERA_EVIDENCE
  if (config.mode !== 'analyze') {
    const acquired = await acquireCameraCase({
      desktopRoot: fileURLToPath(new URL('../', import.meta.url)),
      webRoot: process.env.VIDEORC_PARITY_WEB_ROOT,
      config
    })
    evidenceFile = acquired.evidenceFile
    console.log(`Processed camera artifacts acquired (not qualified): ${evidenceFile}`)
  }
  if (config.mode !== 'acquire') {
    if (!evidenceFile) throw new Error('VIDEORC_CAMERA_EVIDENCE names the evidence to analyze')
    const { writeFileSync } = await import('node:fs')
    const result = await analyzeCameraCase(evidenceFile)
    writeFileSync(`${evidenceFile}.qualification.json`, JSON.stringify(result, null, 2) + '\n')
    console.log(JSON.stringify(result, null, 2))
    if (result.status !== 'passed') process.exitCode = 1
  }
  process.exit(process.exitCode ?? 0)
}
if (selected.case === 'virtual-camera') {
  // S23: the room's Program preview on Videorc Camera, read from outside the
  // app. Local LiveKit and a registered camera. Never qualifies production.
  const { virtualCameraCaseConfig } = await import('./lib/cloud-parity-virtual-camera-contract.mjs')
  const { acquireVirtualCameraCase, analyzeVirtualCameraCase } =
    await import('./lib/cloud-parity-virtual-camera.mjs')
  const config = virtualCameraCaseConfig(process.env)
  let evidenceFile = process.env.VIDEORC_VIRTUAL_CAMERA_EVIDENCE
  if (config.mode !== 'analyze') {
    const acquired = await acquireVirtualCameraCase({
      desktopRoot: fileURLToPath(new URL('../', import.meta.url)),
      webRoot: process.env.VIDEORC_PARITY_WEB_ROOT,
      config
    })
    evidenceFile = acquired.evidenceFile
    console.log(`Room program camera evidence acquired (not qualified): ${evidenceFile}`)
  }
  if (config.mode !== 'acquire') {
    if (!evidenceFile)
      throw new Error('VIDEORC_VIRTUAL_CAMERA_EVIDENCE names the evidence to analyze')
    const { writeFileSync } = await import('node:fs')
    const result = await analyzeVirtualCameraCase(evidenceFile)
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
    'outputs',
    'markers',
    'baseline',
    'controls',
    'privacy',
    'soundboard',
    'audio-routing',
    'avatar',
    'scenes',
    'sources',
    'lifecycle',
    'services',
    'archive',
    'clips',
    'replay-ring',
    'avatar-animation',
    'views',
    'graphics',
    'alpha-spike',
    'handoff',
    'reporting'
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
        : selected.case === 'reporting'
          ? (await import('./lib/cloud-parity-reporting.mjs')).runReporting
          : runBaseline
const { output } = await run({
  desktopRoot: fileURLToPath(new URL('../', import.meta.url)),
  webRoot,
  captions: selected.case === 'captions',
  outputs: selected.case === 'outputs',
  markers: selected.case === 'markers',
  controls: selected.case === 'controls',
  privacy: selected.case === 'privacy',
  soundboard: selected.case === 'soundboard',
  audioRouting: selected.case === 'audio-routing',
  avatar: selected.case === 'avatar',
  scenes: selected.case === 'scenes',
  sources: selected.case === 'sources',
  archive: selected.case === 'archive',
  clips: selected.case === 'clips',
  replayRing: ['replay-ring', 'archive', 'clips'].includes(selected.case),
  avatarAnimation: selected.case === 'avatar-animation',
  views: selected.case === 'views',
  graphics: selected.case === 'graphics',
  handoff: selected.case === 'handoff'
})
console.log(
  `Local real-page ${selected.case} passed: ${output}. Managed/device acceptance remains not-run.`
)
