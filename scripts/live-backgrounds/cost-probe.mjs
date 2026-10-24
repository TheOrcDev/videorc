#!/usr/bin/env node
// Live background probe (plan 190 S1). Runs the shared WebGL2 runner in the
// desktop app's Electron, hidden, and:
//
//   --mode cost      times every background (first look, or --all-looks) at
//                    1080p, 1080×1920, 4K and the guard's half size; prints a
//                    table and writes output/live-background-cost-<host>.json
//   --mode golden    writes the golden grids the Metal and D3D11 ports are
//                    tested against (crates/videorc-backend/tests/fixtures/
//                    live-background-golden.json)
//   --mode posters   writes every look's poster (1672×941) and thumbnail
//                    (384×216) WebP into the desktop's bundled backgrounds
//
// Usage: pnpm probe:live-background-cost [-- --mode cost|golden|posters] [--all-looks]
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { hostname, platform, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '..', '..')

function parseArgs(argv) {
  const options = { mode: 'cost', allLooks: false, frames: 240 }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--mode') options.mode = argv[++index]
    else if (arg.startsWith('--mode=')) options.mode = arg.slice('--mode='.length)
    else if (arg === '--all-looks') options.allLooks = true
    else if (arg === '--frames') options.frames = Number(argv[++index])
  }
  if (!['cost', 'golden', 'posters'].includes(options.mode)) {
    throw new Error(`unknown --mode ${options.mode}`)
  }
  return options
}

function runElectron(options) {
  const electronPath = createRequire(join(repoRoot, 'apps', 'desktop', 'package.json'))('electron')
  const resultDir = mkdtempSync(join(tmpdir(), 'videorc-live-probe-result-'))
  const resultPath = join(resultDir, 'result.json')
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(electronPath, [join(import.meta.dirname, 'probe-main.cjs')], {
      env: {
        ...process.env,
        ELECTRON_ENABLE_LOGGING: '0',
        VIDEORC_LIVE_PROBE_ARGS: JSON.stringify(options),
        VIDEORC_LIVE_PROBE_OUT: resultPath
      },
      stdio: ['ignore', 'ignore', 'inherit']
    })
    const timer = setTimeout(
      () => {
        child.kill('SIGKILL')
        rejectRun(new Error('live background probe timed out'))
      },
      30 * 60 * 1000
    )
    child.once('exit', (code) => {
      clearTimeout(timer)
      let result
      try {
        result = JSON.parse(readFileSync(resultPath, 'utf8'))
      } catch (error) {
        rejectRun(new Error(`live background probe wrote no result (exit ${code}): ${error}`))
        return
      } finally {
        rmSync(resultDir, { recursive: true, force: true })
      }
      if (result.error) rejectRun(new Error(result.error))
      else resolveRun(result)
    })
  })
}

function formatMs(value) {
  return `${value.toFixed(2)} ms`
}

const options = parseArgs(process.argv.slice(2))
const result = await runElectron(options)
console.log(`GPU: ${result.renderer} (${result.vendor})`)

if (options.mode === 'cost') {
  const rows = result.cases.map((entry) => ({
    background: `${entry.id} (${entry.look})`,
    output: `${entry.output[0]}x${entry.output[1]}${entry.level === 'half' ? ' half' : ''}`,
    renders: `${entry.view[0]}x${entry.view[1]}`,
    'GPU median': entry.medianMs === null ? 'n/a' : formatMs(entry.medianMs),
    'GPU p95': entry.p95Ms === null ? 'n/a' : formatMs(entry.p95Ms),
    'batch mean': formatMs(entry.batchMeanMs),
    scratchMB: (entry.scratchBytes / 1048576).toFixed(1)
  }))
  console.table(rows)
  const outDir = join(repoRoot, 'output')
  mkdirSync(outDir, { recursive: true })
  const file = join(outDir, `live-background-cost-${platform()}-${hostname().split('.')[0]}.json`)
  writeFileSync(
    file,
    `${JSON.stringify({ measuredAt: new Date().toISOString(), ...result }, null, 2)}\n`
  )
  console.log(`wrote ${file}`)
}

if (options.mode === 'golden') {
  const file = join(repoRoot, 'crates/videorc-backend/tests/fixtures/live-background-golden.json')
  mkdirSync(join(file, '..'), { recursive: true })
  const fixture = {
    _generated:
      'By scripts/live-backgrounds/cost-probe.mjs --mode golden (the GLSL in WebGL2). Do not edit.',
    renderer: result.renderer,
    size: [640, 360],
    grid: [64, 36],
    frames: result.golden
  }
  writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`)
  console.log(`wrote ${result.golden.length} golden grids to ${file}`)
}

if (options.mode === 'posters') {
  const backgrounds = join(repoRoot, 'apps/desktop/src/renderer/src/assets/backgrounds')
  const thumbs = join(backgrounds, 'live-thumbs')
  mkdirSync(thumbs, { recursive: true })
  for (const entry of result.posters) {
    const name = `live-${entry.id}-${entry.look}`
    writeFileSync(join(backgrounds, `${name}.webp`), Buffer.from(entry.poster, 'base64'))
    writeFileSync(join(thumbs, `${name}.webp`), Buffer.from(entry.thumb, 'base64'))
  }
  console.log(`wrote ${result.posters.length} posters and thumbnails`)
}
