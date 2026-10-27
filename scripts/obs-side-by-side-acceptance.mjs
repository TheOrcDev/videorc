#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { launchAvSyncStimulus, stopAvSyncStimulus } from './lib/av-sync-stimulus.mjs'
import {
  launchScreenMotionStimulus,
  stopScreenMotionStimulus
} from './lib/screen-motion-stimulus.mjs'
import { buildObsSideBySideManifest } from './lib/obs-side-by-side-manifest.mjs'

const DEFAULT_OBS_APP = '/Applications/OBS.app'
const DEFAULT_OBS_PROFILE = 'Untitled'
const DEFAULT_OBS_COLLECTION = 'Untitled'
const DEFAULT_OBS_SCENE = 'Long'
const DEFAULT_OBS_BASIC_INI =
  '/Users/orcdev/Library/Application Support/obs-studio/basic/profiles/Untitled/basic.ini'
const DEFAULT_OBS_SCENE_JSON =
  '/Users/orcdev/Library/Application Support/obs-studio/basic/scenes/Untitled.json'

const options = parseArgs(process.argv.slice(2))

if (options.help) {
  printHelp()
  process.exit(0)
}

const printOnly = readBoolean(options['print-only'], false)
const launchObs = readBoolean(options['launch-obs'], !printOnly)
const launchVideorc = readBoolean(options['launch-videorc'], !printOnly)
const stimulusKind = String(options.stimulus ?? 'motion')
const durationMs = readNumber(options['duration-ms'], 0)
const obsApp = String(options['obs-app'] ?? DEFAULT_OBS_APP)
const obsProfile = String(options['obs-profile'] ?? DEFAULT_OBS_PROFILE)
const obsCollection = String(options['obs-collection'] ?? DEFAULT_OBS_COLLECTION)
const obsScene = String(options['obs-scene'] ?? DEFAULT_OBS_SCENE)
const obsBasicIni = String(options['obs-basic-ini'] ?? DEFAULT_OBS_BASIC_INI)
const obsSceneJson = String(options['obs-scene-json'] ?? DEFAULT_OBS_SCENE_JSON)
const outputDirectory = resolve(
  String(options['output-dir'] ?? join(tmpdir(), `videorc-obs-side-by-side-${Date.now()}`))
)
const videorcOutput = {
  width: readNumber(options['videorc-width'] ?? process.env.VIDEORC_BASELINE_WIDTH, 1920),
  height: readNumber(options['videorc-height'] ?? process.env.VIDEORC_BASELINE_HEIGHT, 1080),
  fps: readNumber(options['videorc-fps'] ?? process.env.VIDEORC_BASELINE_FPS, 30),
  bitrateKbps: readNumber(
    options['videorc-bitrate-kbps'] ?? process.env.VIDEORC_BASELINE_BITRATE_KBPS,
    6000
  )
}

if (!['none', 'motion', 'av-sync'].includes(stimulusKind)) {
  throw new Error(`Unknown --stimulus=${stimulusKind}. Expected none, motion, or av-sync.`)
}

mkdirSync(outputDirectory, { recursive: true })
const obsVideo = readObsVideoConfig(obsBasicIni)
const obsSceneSummary = readObsSceneSummary(obsSceneJson, obsScene)
const manifestPath = join(outputDirectory, 'obs-side-by-side-manifest.json')
writeFileSync(
  manifestPath,
  `${JSON.stringify(
    buildObsSideBySideManifest({
      commit: gitCommit(),
      command: ['node', 'scripts/obs-side-by-side-acceptance.mjs', ...process.argv.slice(2)],
      outputDirectory,
      stimulus: stimulusKind,
      launchObs,
      launchVideorc,
      videorcOutput,
      obsApp,
      obsAppDetected: existsSync(obsApp),
      obsProfile,
      obsCollection,
      obsScene,
      obsVideo,
      obsSceneSummary
    }),
    null,
    2
  )}\n`
)

const children = []
let stimulus
let keepAlive
let stopping = false

process.once('SIGINT', () => void stop(130))
process.once('SIGTERM', () => void stop(143))

printRunbook({
  launchObs,
  launchVideorc,
  obsCollection,
  obsProfile,
  obsScene,
  obsSceneSummary,
  obsVideo,
  outputDirectory,
  stimulusKind,
  manifestPath,
  videorcOutput
})

if (printOnly) {
  process.exit(0)
}

try {
  if (stimulusKind === 'motion') {
    stimulus = await launchScreenMotionStimulus()
    console.log(`\nMotion stimulus launched: ${stimulus.htmlPath}`)
  } else if (stimulusKind === 'av-sync') {
    stimulus = await launchAvSyncStimulus()
    console.log(`\nA/V sync stimulus launched: ${stimulus.htmlPath}`)
  }

  if (launchObs) {
    launchObsApp({ obsApp, obsProfile, obsCollection, obsScene })
  }

  if (launchVideorc) {
    children.push(
      spawn('pnpm', ['--filter', '@videorc/desktop', 'dev'], {
        env: {
          ...process.env,
          VIDEORC_SMOKE_SKIP_FIRST_RUN: process.env.VIDEORC_SMOKE_SKIP_FIRST_RUN ?? '1'
        },
        detached: true,
        stdio: 'inherit'
      })
    )
  }

  console.log('\nHarness is running. Press Ctrl-C after the side-by-side pass is complete.')
  keepAlive = setInterval(() => {}, 60_000)
  if (durationMs > 0) {
    console.log(`Auto-stop in ${Math.round(durationMs / 1000)}s.`)
    setTimeout(() => void stop(0), durationMs)
  }

  await new Promise(() => {})
} catch (error) {
  console.error(`\nOBS side-by-side harness failed: ${error.message}`)
  await stop(1)
}

async function stop(code) {
  if (stopping) return
  stopping = true
  if (keepAlive) clearInterval(keepAlive)

  if (stimulusKind === 'motion') {
    await stopScreenMotionStimulus(stimulus)
  } else if (stimulusKind === 'av-sync') {
    await stopAvSyncStimulus(stimulus)
  }

  for (const child of children) {
    if (!child.pid) continue
    signal(child.pid, 'SIGTERM')
  }
  await sleep(900)
  for (const child of children) {
    if (!child.pid) continue
    signal(child.pid, 'SIGKILL')
  }

  process.exit(code)
}

function launchObsApp({ obsApp, obsProfile, obsCollection, obsScene }) {
  if (!existsSync(obsApp)) {
    throw new Error(`OBS app not found at ${obsApp}`)
  }

  const child = spawn(
    '/usr/bin/open',
    [
      '-n',
      obsApp,
      '--args',
      '--multi',
      '--profile',
      obsProfile,
      '--collection',
      obsCollection,
      '--scene',
      obsScene
    ],
    { stdio: 'inherit' }
  )
  children.push(child)
}

function printRunbook({
  launchObs,
  launchVideorc,
  obsCollection,
  obsProfile,
  obsScene,
  obsSceneSummary,
  obsVideo,
  outputDirectory,
  stimulusKind,
  manifestPath,
  videorcOutput
}) {
  console.log('# Videorc OBS side-by-side acceptance')
  console.log('')
  console.log(`Stimulus: ${stimulusKind}`)
  console.log(
    `Videorc requested output: ${videorcOutput.width}x${videorcOutput.height} ` +
      `${videorcOutput.fps}fps @ ${videorcOutput.bitrateKbps}kbps`
  )
  console.log(
    `Launch OBS: ${launchObs ? 'yes' : 'no'} (${obsCollection} / ${obsProfile} / ${obsScene})`
  )
  console.log(`Launch Videorc dev app: ${launchVideorc ? 'yes' : 'no'}`)
  console.log(`Evidence output: ${outputDirectory}`)
  console.log(`Comparable-settings manifest: ${manifestPath}`)
  if (obsVideo) {
    console.log(
      `Detected OBS video profile: base ${obsVideo.BaseCX}x${obsVideo.BaseCY}, output ` +
        `${obsVideo.OutputCX}x${obsVideo.OutputCY}, fps ${obsVideo.FPSCommon || obsVideo.FPSInt || 'unknown'}, ` +
        `scale ${obsVideo.ScaleType || 'unknown'}, color ${obsVideo.ColorSpace || 'unknown'} ${obsVideo.ColorRange || 'unknown'}`
    )
  }
  if (obsSceneSummary) {
    console.log(`Detected OBS scene "${obsSceneSummary.name}" visible sources:`)
    for (const source of obsSceneSummary.visibleSources) {
      console.log(`- ${source.name} (${source.id})`)
    }
    if (obsSceneSummary.visibleSources.length === 0) {
      console.log('- none')
    }
    if (!obsSceneSummary.hasScreenSource) {
      console.log('WARNING: selected OBS scene has no visible screen/window source.')
      console.log('Use --obs-scene=Long or another screen+camera scene for motion/scroll parity.')
    }
  }
  console.log('')
  console.log('Before judging parity:')
  console.log('- Match OBS and Videorc output resolution/FPS for this pass.')
  console.log('- Use the same screen/window, camera, and microphone in both apps.')
  console.log('- Apply the measured Videorc microphone sync offset before mouth/voice judgment.')
  console.log(
    '- Make sure Videorc reports OBS-native/CAMetalLayer preview, zero image polls, and no CPU compositor fallback.'
  )
  console.log('')
  console.log('Manual pass checklist:')
  console.log('- Preview text sharpness matches OBS at the same preview size.')
  console.log('- Fast hand motion and cursor movement stay current, with no rubber-banding.')
  console.log('- Fast page scrolling is as smooth as OBS.')
  console.log('- Camera crop, mirror, edge detail, and color are not visibly worse than OBS.')
  console.log(
    '- Moving/resizing the camera overlay while recording does not cause visible recording stutter.'
  )
  console.log('- Two-minute OBS and Videorc recordings play back equally smooth.')
  console.log(
    '- First two seconds of the Videorc recording match the rest of the file in resolution/layout.'
  )
  console.log('- Mouth/voice sync and audio continuity hold for the full clip.')
}

function gitCommit() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}

function readObsSceneSummary(filePath, sceneName) {
  if (!existsSync(filePath)) return null
  const collection = JSON.parse(readFileSync(filePath, 'utf8'))
  const sources = Array.isArray(collection.sources) ? collection.sources : []
  const sourceByUuid = new Map(sources.map((source) => [source.uuid, source]))
  const scene = sources.find((source) => source.id === 'scene' && source.name === sceneName)
  if (!scene) return null

  const items = Array.isArray(scene.settings?.items) ? scene.settings.items : []
  const visibleSources = items
    .filter((item) => item.visible !== false)
    .map((item) => {
      const source = sourceByUuid.get(item.source_uuid)
      return {
        name: item.name ?? source?.name ?? 'unknown',
        id: source?.id ?? 'unknown'
      }
    })

  return {
    name: scene.name,
    visibleSources,
    hasScreenSource: visibleSources.some((source) => source.id === 'screen_capture')
  }
}

function readObsVideoConfig(filePath) {
  if (!existsSync(filePath)) return null
  const text = readFileSync(filePath, 'utf8')
  const video = {}
  let section = ''
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    const sectionMatch = /^\[([^\]]+)\]$/.exec(line)
    if (sectionMatch) {
      section = sectionMatch[1]
      continue
    }
    if (section !== 'Video') continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    video[line.slice(0, eq)] = line.slice(eq + 1)
  }
  return Object.keys(video).length > 0 ? video : null
}

function parseArgs(args) {
  const parsed = {}
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--') {
      continue
    }
    if (arg === '-h' || arg === '--help') {
      parsed.help = true
      continue
    }
    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected positional argument: ${arg}`)
    }
    const eq = arg.indexOf('=')
    if (eq !== -1) {
      parsed[arg.slice(2, eq)] = arg.slice(eq + 1)
      continue
    }
    const name = arg.slice(2)
    const next = args[i + 1]
    if (next && !next.startsWith('--')) {
      parsed[name] = next
      i += 1
    } else {
      parsed[name] = 'true'
    }
  }
  return parsed
}

function readBoolean(value, fallback) {
  if (value === undefined) return fallback
  const normalized = String(value).toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  throw new Error(`Invalid boolean value: ${value}`)
}

function readNumber(value, fallback) {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid non-negative number: ${value}`)
  }
  return parsed
}

function signal(pid, sig) {
  try {
    process.kill(-pid, sig)
  } catch {
    try {
      process.kill(pid, sig)
    } catch {
      // Already gone.
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function printHelp() {
  console.log(`Usage:
  node scripts/obs-side-by-side-acceptance.mjs [options]

Options:
  --print-only                 Print the runbook without launching apps.
  --stimulus=motion|av-sync|none
  --launch-obs=true|false      Default true unless --print-only is set.
  --launch-videorc=true|false  Default true unless --print-only is set.
  --duration-ms=N              Auto-stop stimulus/Videorc after N ms.
  --obs-scene=NAME             Default "${DEFAULT_OBS_SCENE}".
  --obs-profile=NAME           Default "${DEFAULT_OBS_PROFILE}".
  --obs-collection=NAME        Default "${DEFAULT_OBS_COLLECTION}".
  --obs-app=PATH               Default "${DEFAULT_OBS_APP}".
  --obs-basic-ini=PATH         OBS profile ini used for settings summary.
  --obs-scene-json=PATH        OBS scene collection used for visible-source summary.
  --output-dir=PATH            Directory for the comparable-settings manifest.
  --videorc-width=N            Requested Videorc output width in the manifest.
  --videorc-height=N           Requested Videorc output height in the manifest.
  --videorc-fps=N              Requested Videorc output FPS in the manifest.
  --videorc-bitrate-kbps=N     Requested Videorc bitrate in the manifest.
`)
}
