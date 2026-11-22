#!/usr/bin/env node
// Plan 258 S0: run bench.html (MediaPipe selfie segmentation) in Chrome or in
// Electron's renderer, one fresh isolated browser per run, and collect timing
// JSON and raw gray8 mattes.
//
//   node scripts/person-segmentation/bench-run.mjs --browser chrome|electron \
//     --out-dir DIR --tv-dir .../tasks-vision/package --models-dir DIR --clips-dir DIR \
//     --runs "name:clip.mp4:model:GPU:realtime,..." [--seconds 30]

import { spawn, execFileSync } from 'node:child_process'
import {
  createReadStream,
  existsSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
  statSync
} from 'node:fs'
import { createServer } from 'node:http'
import { cpus, loadavg } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const args = {}
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, '')] = argv[i + 1]
const outDir = resolve(args['out-dir'])
mkdirSync(outDir, { recursive: true })
const seconds = Number(args.seconds ?? 30)

const roots = {
  '/tv/': resolve(args['tv-dir']),
  '/models/': resolve(args['models-dir']),
  '/clips/': resolve(args['clips-dir'])
}
const types = {
  '.html': 'text/html',
  '.mjs': 'text/javascript',
  '.js': 'text/javascript',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.tflite': 'application/octet-stream'
}

const waiters = new Map()
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  if (req.method === 'POST') {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      const name = url.searchParams.get('name')
      if (url.pathname === '/upload') {
        const file = join(outDir, `${name}.gray`)
        if (url.searchParams.get('append') === '1') appendFileSync(file, body)
        else writeFileSync(file, body)
      } else if (url.pathname === '/result') {
        writeFileSync(join(outDir, `${name}.json`), body)
        waiters.get(name)?.(JSON.parse(body.toString()))
      }
      res.end('ok')
    })
    return
  }
  let file = null
  if (url.pathname === '/bench.html') file = join(here, 'bench.html')
  for (const [prefix, dir] of Object.entries(roots))
    if (url.pathname.startsWith(prefix))
      file = join(dir, decodeURIComponent(url.pathname.slice(prefix.length)))
  if (!file || !existsSync(file)) {
    res.statusCode = 404
    return res.end()
  }
  const size = statSync(file).size
  const headers = {
    'Content-Type': types[extname(file)] ?? 'application/octet-stream',
    'Accept-Ranges': 'bytes'
  }
  const range = req.headers.range?.match(/bytes=(\d+)-(\d*)/)
  if (range) {
    const start = Number(range[1]),
      end = range[2] ? Number(range[2]) : size - 1
    res.writeHead(206, {
      ...headers,
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': end - start + 1
    })
    createReadStream(file, { start, end }).pipe(res)
  } else {
    res.writeHead(200, { ...headers, 'Content-Length': size })
    createReadStream(file).pipe(res)
  }
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port

const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const electron = resolve(args.electron ?? '')
function launch(url, profile) {
  if (args.browser === 'chrome') {
    return spawn(
      chrome,
      [
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--window-size=1650,962',
        '--autoplay-policy=no-user-gesture-required',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
        url
      ],
      { stdio: 'ignore' }
    )
  }
  return spawn(electron, [join(here, 'bench-electron-main.cjs')], {
    stdio: 'ignore',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '', BENCH_URL: url, BENCH_PROFILE: profile }
  })
}

function cpuBusy() {
  let busy = 0,
    total = 0
  for (const c of cpus()) {
    const t = c.times
    busy += t.user + t.nice + t.sys + t.irq
    total += t.user + t.nice + t.sys + t.irq + t.idle
  }
  return { busy, total }
}

const version =
  args.browser === 'chrome'
    ? execFileSync(chrome, ['--version']).toString().trim()
    : execFileSync(
        electron,
        [
          '-e',
          "console.log('Electron ' + process.versions.electron + ' (Chromium ' + process.versions.chrome + ')')"
        ],
        { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }
      )
        .toString()
        .trim()
console.log(version)

for (const spec of String(args.runs).split(',')) {
  const [name, clip, model, delegate, mode, sync = 'finish', input = 'full'] = spec.split(':')
  const fullName = `${args.browser}-${name}`
  const url = `http://127.0.0.1:${port}/bench.html?clip=/clips/${clip}&model=${model}&delegate=${delegate}&mode=${mode}&sync=${sync}&input=${input}&name=${fullName}&seconds=${seconds}`
  const profile = join(outDir, `profile-${args.browser}`)
  const limit = Number(args['quiet-load'] ?? 0)
  const until = Date.now() + Number(args['quiet-wait'] ?? 900) * 1000
  while (limit && loadavg()[0] >= limit && Date.now() < until)
    await new Promise((r) => setTimeout(r, 5000))
  const load0 = loadavg(),
    c0 = cpuBusy()
  const child = launch(url, profile)
  process.stdout.write(`${fullName} (pid ${child.pid}) … `)
  const result = await Promise.race([
    new Promise((r) => waiters.set(fullName, r)),
    new Promise((r) =>
      setTimeout(() => r({ error: 'timeout' }), (mode === 'step' ? 900 : seconds + 90) * 1000)
    )
  ])
  const c1 = cpuBusy()
  child.kill('SIGTERM')
  await new Promise((r) => setTimeout(r, 1500))
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  const load = {
    loadAvgStart: load0,
    loadAvgEnd: loadavg(),
    systemCpuBusyPct: (100 * (c1.busy - c0.busy)) / (c1.total - c0.total),
    browserVersion: version
  }
  writeFileSync(join(outDir, `${fullName}.load.json`), JSON.stringify(load, null, 1))
  if (result.error) console.log(`FAILED ${result.error}`)
  else
    console.log(
      `call p50 ${result.callMs.p50.toFixed(2)} p95 ${result.callMs.p95.toFixed(2)} ms, matte ${result.matte}, hz ${result.segmentedHz?.toFixed(1) ?? '-'}, missed ${result.missedPresentedFrames}`
    )
}
server.closeAllConnections()
server.close()
process.exit(0)
