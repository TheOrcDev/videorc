#!/usr/bin/env node
// Live background probe (plan 190 S1, plan 194 S1). Runs the WebGL2 runners
// in the desktop app's Electron, hidden, and:
//
//   --mode cost      times every background (first look, or --all-looks) at
//                    1080p, 1080×1920, 4K and the guard's half size; prints a
//                    table and writes output/live-background-cost-<host>.json,
//                    with the host's load average sampled through the run
//   --mode golden    writes the golden grids the Metal and D3D11 ports are
//                    tested against (crates/videorc-backend/tests/fixtures/
//                    live-background-golden.json). Entries already in the
//                    fixture are kept byte-identical; a re-render that differs
//                    from one is a failure unless --rewrite-goldens says so
//   --mode frames    writes one PNG per look (--size WxH, --phase-offset n,
//                    --level full|half)
//                    into --out <dir>, for by-eye checks
//   --mode posters   writes every look's poster (1672×941, at most 250 KB)
//                    and thumbnail (384×216, at most 20 KB) WebP into the
//                    desktop's bundled backgrounds, prints each file's size
//                    and encoding, and fails on a file over its limit
//
// --ids a,b limits every mode to those backgrounds; --render <file> swaps in
// another render JSON (timing a variant of a look).
//
// Usage: pnpm probe:live-background-cost [-- --mode cost|golden|frames|posters] [--all-looks] [--ids ...]
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { hostname, loadavg, platform, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '..', '..')
const GOLDEN_FIXTURE = join(
  repoRoot,
  'crates/videorc-backend/tests/fixtures/live-background-golden.json'
)

function parseArgs(argv) {
  const options = {
    mode: 'cost',
    allLooks: false,
    frames: 240,
    ids: [],
    rewriteGoldens: false,
    size: null,
    phaseOffset: 0,
    level: 'full',
    out: null
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    // `pnpm probe:live-background-cost -- --mode …` passes the `--` through.
    if (arg === '--') continue
    if (arg === '--mode') options.mode = argv[++index]
    else if (arg.startsWith('--mode=')) options.mode = arg.slice('--mode='.length)
    else if (arg === '--all-looks') options.allLooks = true
    else if (arg === '--frames') options.frames = Number(argv[++index])
    else if (arg === '--ids') options.ids = argv[++index].split(',').filter(Boolean)
    else if (arg === '--rewrite-goldens') options.rewriteGoldens = true
    else if (arg === '--size') options.size = argv[++index].split('x').map(Number)
    else if (arg === '--phase-offset') options.phaseOffset = Number(argv[++index])
    else if (arg === '--level') options.level = argv[++index]
    else if (arg === '--render') options.render = resolve(argv[++index])
    else if (arg === '--out') options.out = resolve(argv[++index])
    else throw new Error(`unknown argument ${arg}`)
  }
  if (!['cost', 'golden', 'frames', 'posters'].includes(options.mode)) {
    throw new Error(`unknown --mode ${options.mode}`)
  }
  if (options.mode === 'frames' && !options.out) throw new Error('--mode frames needs --out <dir>')
  return options
}

/** The host's 1-minute load average sampled every 2 s while the child runs. */
function loadSampler() {
  const samples = [loadavg()[0]]
  const timer = setInterval(() => samples.push(loadavg()[0]), 2000)
  return {
    stop() {
      clearInterval(timer)
      samples.push(loadavg()[0])
      return {
        start: samples[0],
        end: samples[samples.length - 1],
        min: Math.min(...samples),
        max: Math.max(...samples)
      }
    }
  }
}

function runElectron(options) {
  const electronPath = createRequire(join(repoRoot, 'apps', 'desktop', 'package.json'))('electron')
  const resultDir = mkdtempSync(join(tmpdir(), 'videorc-live-probe-result-'))
  const resultPath = join(resultDir, 'result.json')
  return new Promise((resolveRun, rejectRun) => {
    const load = loadSampler()
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
        load.stop()
        rejectRun(new Error('live background probe timed out'))
      },
      30 * 60 * 1000
    )
    child.once('exit', (code) => {
      clearTimeout(timer)
      const loadSummary = load.stop()
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
      else resolveRun({ ...result, load: loadSummary })
    })
  })
}

function formatMs(value) {
  return `${value.toFixed(2)} ms`
}

/**
 * The fixture with the new grids merged in: entries it already has stay
 * byte-identical (a shipped background's golden must never move: plan 194
 * STOP condition), new ones are appended in render order.
 */
function mergeGoldens(existing, rendered, renderer, options) {
  const key = (frame) => `${frame.id}/${frame.look}@${frame.phase}`
  const current = new Map((existing?.frames ?? []).map((frame) => [key(frame), frame]))
  const moved = []
  const added = []
  for (const frame of rendered) {
    const held = current.get(key(frame))
    if (!held) {
      added.push(frame)
      current.set(key(frame), frame)
    } else if (held.rgb !== frame.rgb) {
      moved.push(key(frame))
      if (options.rewriteGoldens) current.set(key(frame), frame)
    }
  }
  if (moved.length > 0 && !options.rewriteGoldens) {
    throw new Error(
      `${moved.length} golden grid(s) already in the fixture rendered differently (${moved.join(', ')}); ` +
        'a shipped background moved. Pass --rewrite-goldens only for a deliberate change.'
    )
  }
  return {
    fixture: {
      _generated:
        'By scripts/live-backgrounds/cost-probe.mjs --mode golden (the GLSL in WebGL2). Do not edit.',
      renderer: existing?.renderer ?? renderer,
      size: [640, 360],
      grid: [64, 36],
      frames: [...current.values()]
    },
    added,
    moved,
    unchanged: rendered.length - added.length - moved.length
  }
}

const options = parseArgs(process.argv.slice(2))
const result = await runElectron(options)
console.log(`GPU: ${result.renderer} (${result.vendor})`)
console.log(
  `load average (1 min) during the run: start ${result.load.start.toFixed(1)}, min ${result.load.min.toFixed(1)}, max ${result.load.max.toFixed(1)}, end ${result.load.end.toFixed(1)}`
)

if (options.mode === 'cost') {
  const rows = result.cases.map((entry) => ({
    background: `${entry.id} (${entry.look})`,
    output: `${entry.output[0]}x${entry.output[1]}${entry.level === 'half' ? ' half' : ''}`,
    renders: `${entry.view[0]}x${entry.view[1]}`,
    'live median': formatMs(entry.liveMedianMs),
    'live p95': formatMs(entry.liveP95Ms),
    'timer median': entry.medianMs === null ? 'n/a' : formatMs(entry.medianMs),
    'timer p95': entry.p95Ms === null ? 'n/a' : formatMs(entry.p95Ms),
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
  mkdirSync(join(GOLDEN_FIXTURE, '..'), { recursive: true })
  const existing = existsSync(GOLDEN_FIXTURE)
    ? JSON.parse(readFileSync(GOLDEN_FIXTURE, 'utf8'))
    : null
  const merged = mergeGoldens(existing, result.golden, result.renderer, options)
  writeFileSync(GOLDEN_FIXTURE, `${JSON.stringify(merged.fixture, null, 2)}\n`)
  console.log(
    `wrote ${merged.fixture.frames.length} golden grids to ${GOLDEN_FIXTURE} (${merged.added.length} new, ${merged.unchanged} unchanged, ${merged.moved.length} rewritten)`
  )
}

if (options.mode === 'frames') {
  mkdirSync(options.out, { recursive: true })
  for (const entry of result.frames) {
    const file = join(options.out, `${entry.id}-${entry.look}@${entry.phase}-${entry.level}.png`)
    writeFileSync(file, Buffer.from(entry.png, 'base64'))
    console.log(`wrote ${file}`)
  }
}

if (options.mode === 'posters') {
  const backgrounds = join(repoRoot, 'apps/desktop/src/renderer/src/assets/backgrounds')
  const thumbs = join(backgrounds, 'live-thumbs')
  mkdirSync(thumbs, { recursive: true })
  const rows = []
  const over = []
  for (const entry of result.posters) {
    const name = `live-${entry.id}-${entry.look}`
    const files = [
      ['poster', join(backgrounds, `${name}.webp`), entry.poster],
      ['thumb', join(thumbs, `${name}.webp`), entry.thumb]
    ]
    const row = { file: `${name}.webp` }
    for (const [kind, file, encoded] of files) {
      const bytes = Buffer.from(encoded.data, 'base64')
      writeFileSync(file, bytes)
      row[`${kind} KB`] = (bytes.length / 1000).toFixed(1)
      row[kind] = encoded.encoding
      if (bytes.length > encoded.limitBytes) over.push(`${file} (${bytes.length} bytes)`)
    }
    rows.push(row)
  }
  console.table(rows)
  console.log(`wrote ${result.posters.length} posters and thumbnails`)
  if (over.length > 0) {
    console.error(`over the size limit (poster 250 KB, thumbnail 20 KB):\n${over.join('\n')}`)
    process.exitCode = 1
  }
}
