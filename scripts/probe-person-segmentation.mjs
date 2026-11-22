#!/usr/bin/env node
// Plan 258 S0: measure Apple Vision person segmentation on this Mac.
//
//   node scripts/probe-person-segmentation.mjs live --out-dir DIR [--device "MacBook Pro Camera"]
//       [--seconds 20] [--matrix quick|full]
//   node scripts/probe-person-segmentation.mjs clip --out-dir DIR --in clip.mp4 [--sizes 1280x720,1920x1080,3840x2160]
//       [--mattes]   (write each run's mattes as raw gray8 next to its JSON)
//
// Builds scripts/person-segmentation/seg-probe.swift with swiftc, runs a matrix of
// quality level x input size x compute device, writes one JSON per run and a
// summary.md table. The terminal running it needs the Camera permission for
// `live`. Evidence directories must not be under /tmp. Add `--quiet-load N` to
// wait (up to `--quiet-wait` s) for the 1-minute load to drop below N per run.
//
// The browser half (MediaPipe tasks-vision in Chrome or Electron) and the
// scoring tools live next to the Swift probe in scripts/person-segmentation/:
// bench-run.mjs + bench.html, analyze-mattes.mjs, edge-sheet.mjs. Results and
// method: docs/acceptance/2026-11-22-segmentation-spike.md.

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const [command, ...rest] = process.argv.slice(2)
const args = {}
for (let i = 0; i < rest.length; i++) {
  if (!rest[i].startsWith('--')) continue
  const key = rest[i].slice(2)
  const next = rest[i + 1]
  if (next === undefined || next.startsWith('--')) args[key] = true
  else args[key] = rest[++i]
}

if (!['live', 'clip'].includes(command) || !args['out-dir']) {
  console.error('usage: probe-person-segmentation.mjs live|clip --out-dir DIR [...]')
  process.exit(2)
}
const outDir = resolve(args['out-dir'])
if (outDir.startsWith('/tmp') || outDir.startsWith('/private/tmp')) {
  console.error('Keep evidence out of /tmp (a reboot wipes it).')
  process.exit(2)
}
mkdirSync(outDir, { recursive: true })

const source = join(here, 'person-segmentation', 'seg-probe.swift')
const binary = join(outDir, 'seg-probe')
if (!existsSync(binary) || statSync(binary).mtimeMs < statSync(source).mtimeMs) {
  console.log('building seg-probe…')
  execFileSync('swiftc', ['-O', '-o', binary, source], { stdio: 'inherit' })
}

// --quiet-load N: before each run, wait (up to --quiet-wait seconds) until the
// 1-minute load average is below N, so other jobs on the Mac skew less.
import { loadavg } from 'node:os'
function waitQuiet() {
  const limit = Number(args['quiet-load'] ?? 0)
  if (!limit) return
  const until = Date.now() + Number(args['quiet-wait'] ?? 900) * 1000
  while (loadavg()[0] >= limit && Date.now() < until)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000)
}

function run(name, probeArgs) {
  waitQuiet()
  const out = join(outDir, `${name}.json`)
  process.stdout.write(`${name} … `)
  const r = spawnSync(binary, [...probeArgs, '--out', out], { encoding: 'utf8' })
  if (r.status !== 0) {
    console.log(`FAILED: ${r.stderr.trim()}`)
    return { name, error: r.stderr.trim() }
  }
  const json = JSON.parse(readFileSync(out, 'utf8'))
  console.log(
    `p50 ${json.performMs.p50.toFixed(1)} ms, p95 ${json.performMs.p95.toFixed(1)} ms, matte ${json.matte}`
  )
  return { name, ...json }
}

const f = (x) => (typeof x === 'number' ? x.toFixed(1) : 'n/a')
const results = []

if (command === 'live') {
  const device = args.device ?? 'MacBook Pro Camera'
  const seconds = String(args.seconds ?? 20)
  const full = (args.matrix ?? 'full') === 'full'
  const base = ['live', '--device', device, '--fps', String(args.fps ?? 30), '--seconds', seconds]
  const sizes = String(args.sizes ?? '1280x720,1920x1080').split(',')
  for (const size of sizes)
    for (const q of ['fast', 'balanced', 'accurate'])
      results.push(run(`live-${size}-${q}-auto`, [...base, '--size', size, '--quality', q]))
  if (full) {
    const big = sizes.at(-1)
    for (const q of ['fast', 'balanced']) {
      for (const c of ['ane', 'gpu', 'cpu'])
        results.push(
          run(`live-${big}-${q}-${c}`, [...base, '--size', big, '--quality', q, '--compute', c])
        )
      results.push(
        run(`live-${big}-${q}-auto-scale512`, [
          ...base,
          '--size',
          big,
          '--quality',
          q,
          '--scale-long',
          '512'
        ])
      )
      results.push(
        run(`live-${big}-${q}-auto-16h`, [
          ...base,
          '--size',
          big,
          '--quality',
          q,
          '--format',
          '16h'
        ])
      )
    }
  }
  const rows = results
    .filter((r) => !r.error)
    .map(
      (r) =>
        `| ${r.name} | ${r.matte} | ${f(r.performMs.p50)} | ${f(r.performMs.p95)} | ${f(r.matteHz)} | ${f(r.captureToDeliveryMs?.p50)} | ${f(r.deliveryToMatteMs?.p95)} | ${f(r.matteAgeAtFrameMs?.p95)} | ${f(r.coldFirstPerformMs)} | ${f(r.load.processCpuPctOfOneCore)} | ${f(r.load.systemCpuBusyPct)} | ${r.load.loadAvgStart.map((x) => x.toFixed(1)).join('/')} |`
    )
  writeFileSync(
    join(outDir, 'summary.md'),
    [
      `# Live Vision segmentation, ${device}, ${new Date().toISOString()}`,
      '',
      '| Run | Matte | Perform p50 ms | p95 ms | Matte Hz | Camera→delivery p50 ms | Delivery→matte p95 ms | Matte age at frame p95 ms | Cold first ms | Probe CPU % (1 core) | System CPU busy % | Load 1/5/15 |',
      '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
      ...rows,
      ...results.filter((r) => r.error).map((r) => `| ${r.name} | FAILED: ${r.error} |`),
      ''
    ].join('\n')
  )
}

if (command === 'clip') {
  if (!args.in) {
    console.error('--in required')
    process.exit(2)
  }
  const sizes = String(args.sizes ?? '1920x1080').split(',')
  const qualities = String(args.qualities ?? 'fast,balanced,accurate').split(',')
  const computes = String(args.computes ?? 'auto').split(',')
  for (const size of sizes)
    for (const q of qualities)
      for (const c of computes) {
        const name = `clip-${args.label ? `${args.label}-` : ''}${size}-${q}-${c}${args['scale-long'] ? `-scale${args['scale-long']}` : ''}${args.pace ? `-${args.pace}` : ''}`
        const extra = []
        if (args.mattes) extra.push('--mattes', join(outDir, `${name}.gray`))
        if (args['scale-long']) extra.push('--scale-long', String(args['scale-long']))
        if (args.pace) extra.push('--pace', String(args.pace))
        if (args['mattes-max-w']) extra.push('--mattes-max-w', String(args['mattes-max-w']))
        if (args['keep-frames']) extra.push('--keep-frames', String(args['keep-frames']))
        results.push(
          run(name, [
            'clip',
            '--in',
            args.in,
            '--size',
            size,
            '--quality',
            q,
            '--compute',
            c,
            ...extra
          ])
        )
      }
  const rows = results
    .filter((r) => !r.error)
    .map(
      (r) =>
        `| ${r.name} | ${r.matte} | ${f(r.performMs.p50)} | ${f(r.performMs.p95)} | ${f(r.performMs.p99)} | ${f(r.downscaleMs.p95)} | ${f(r.coldFirstMs)} | ${f(r.load.processCpuPctOfOneCore)} | ${f(r.load.systemCpuBusyPct)} | ${r.load.loadAvgStart.map((x) => x.toFixed(1)).join('/')} |`
    )
  writeFileSync(
    join(outDir, `summary-clip-${Date.now()}.md`),
    [
      `# Clip Vision segmentation, ${args.in}, ${new Date().toISOString()}`,
      '',
      '| Run | Matte | Perform p50 ms | p95 ms | p99 ms | Downscale p95 ms | Cold first ms | Probe CPU % (1 core) | System CPU busy % | Load 1/5/15 |',
      '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
      ...rows,
      ...results.filter((r) => r.error).map((r) => `| ${r.name} | FAILED: ${r.error} |`),
      ''
    ].join('\n')
  )
}
