// Plan 260 S0.8 runner: a local livekit-server, headless Chrome pages as the
// guests, the Chromium baseline and the program page, and the Rust host.
//
//   node run.mjs --name hold --guests 1 --watch --program --seconds 1800 \
//     --screen-at 120 --screen-for 60 --overlay-at 60
//   node run.mjs --name full --guests 9 --seconds 300
//
// Writes everything under $S08_OUT/<name>/. Stops only the processes it
// started. Refuses to run while the owner is on air.
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(path.join(os.homedir(), 'projects/videorc-wt-260-l2/package.json'))
const { chromium } = require('playwright-core')

const argv = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : fallback
}
const flag = (name) => argv.includes(`--${name}`)
const name = opt('name', 'run')
const guests = Number(opt('guests', '1'))
const seconds = Number(opt('seconds', '60'))
const out = path.join(process.env.S08_OUT ?? path.join(os.homedir(), 'cloud-test/reports/2026-11-23-plan-260/S0.8'), name)
fs.mkdirSync(out, { recursive: true })

if (fs.existsSync(path.join(os.homedir(), 'Library/Application Support/Videorc/on-air.json'))) {
  console.error('the owner is on air; not running')
  process.exit(2)
}

const here = path.dirname(new URL(import.meta.url).pathname)
const bin = path.join(os.homedir(), 'projects/.targets/260-l2-spike-room/release/spike-room')
const lkDist = path.join(os.homedir(), 'projects/videorc-wt-260-l2/apps/desktop/node_modules/livekit-client/dist/livekit-client.esm.mjs')
const KEY = 's08key'
const SECRET = 's08-spike-secret-0123456789abcdef0123456789'
const ROOM = `s08-${name}`
const PORT = 17880
const children = []
const withTimeout = (promise, ms, fallback) => Promise.race([promise, new Promise((r) => setTimeout(() => r(fallback), ms))])
process.on('exit', () => { for (const child of children) if (child.exitCode === null) child.kill('SIGTERM') })
setTimeout(() => { console.error('watchdog: run took too long'); process.exit(3) }, (seconds + 300) * 1000).unref()
const log = (line) => { console.log(line); fs.appendFileSync(path.join(out, 'runner.log'), `${new Date().toISOString()} ${line}\n`) }

function start(label, cmd, args, env = {}) {
  const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  const file = fs.createWriteStream(path.join(out, `${label}.log`))
  child.stdout.pipe(file)
  child.stderr.pipe(file)
  children.push(child)
  log(`started ${label} pid ${child.pid}`)
  return child
}

const config = path.join(out, 'livekit.yaml')
fs.writeFileSync(config, `port: ${PORT}
bind_addresses: ["127.0.0.1"]
rtc:
  tcp_port: 17881
  port_range_start: 51000
  port_range_end: 51400
  use_external_ip: false
  node_ip: 127.0.0.1
keys:
  ${KEY}: ${SECRET}
logging:
  level: info
`)
start('livekit-server', 'livekit-server', ['--config', config])

const page = fs.readFileSync(path.join(here, 'web/guest.html'))
const lk = fs.readFileSync(lkDist)
const http = createServer((req, res) => {
  if (req.url.startsWith('/lk.mjs')) { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(lk) }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end(page)
}).listen(17890, '127.0.0.1')

const tokenFor = (identity) => execFileSync(bin, ['token', identity, ROOM], { env: { ...process.env, SPIKE_API_KEY: KEY, SPIKE_API_SECRET: SECRET } }).toString().trim()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await sleep(1500)

const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding']
})
const pages = []
async function open(role, idx, identity) {
  const context = await browser.newContext({ viewport: { width: 1650, height: 962 } })
  const p = await context.newPage()
  const url = `http://127.0.0.1:17890/?role=${role}&idx=${idx}&url=ws://127.0.0.1:${PORT}&token=${encodeURIComponent(tokenFor(identity))}`
  await p.goto(url)
  pages.push({ role, idx, identity, page: p })
}
for (let i = 0; i < guests; i++) await open('guest', i, `guest:${i}`)
if (flag('program')) await open('program', 0, `program:${ROOM}`)
await sleep(2000)

const hostToken = tokenFor(`host:${ROOM}`)
fs.writeFileSync(path.join(out, '.token-fingerprint'), `${hostToken.length} chars; the token itself is never written\n`)
const host = start('host', bin, ['host', '--url', `ws://127.0.0.1:${PORT}`, '--room', ROOM, '--seconds', String(seconds),
  '--screen-at', opt('screen-at', '0'), '--screen-for', opt('screen-for', '30'), '--overlay-at', opt('overlay-at', '0'),
  '--stage-every', opt('stage-every', '15'), '--out', out],
  { SPIKE_ROOM_TOKEN: hostToken, SPIKE_API_KEY: KEY, SPIKE_API_SECRET: SECRET, RUST_LOG: 'debug' })
// Chromium's own WebRTC watching guest 0 at the same time: the Electron-like baseline.
if (flag('watch')) await open('watch', 0, `watch:${ROOM}`)

const cpu = fs.createWriteStream(path.join(out, 'host-cpu.csv'))
cpu.write('t_s,cpu_percent,rss_mb\n')
const t0 = Date.now()
const sampler = setInterval(() => {
  try {
    const [pcpu, rss] = execFileSync('ps', ['-o', '%cpu=,rss=', '-p', String(host.pid)]).toString().trim().split(/\s+/)
    cpu.write(`${((Date.now() - t0) / 1000).toFixed(0)},${pcpu},${(Number(rss) / 1024).toFixed(1)}\n`)
  } catch {}
}, 2000)
let shot = 0
const shots = setInterval(async () => {
  for (const p of pages.slice(0, 2)) await withTimeout(p.page.screenshot({ path: path.join(os.homedir(), `.local/share/ghostex/i/s08-${name}-${p.role}${p.idx}-${shot}.png`) }).catch(() => {}), 10_000)
  shot++
}, Math.max(60_000, (seconds * 1000) / 4))

await new Promise((resolve) => host.on('exit', resolve))
clearInterval(sampler); clearInterval(shots)
log(`host exited ${host.exitCode}`)
const states = []
for (const p of pages) states.push({ identity: p.identity, ...(await withTimeout(p.page.evaluate(() => window.__state).catch((e) => ({ error: String(e) })), 10_000, { error: 'evaluate timed out' })) })
for (const s of states) if (Array.isArray(s.delays)) {
  const d = s.delays.slice(60).sort((a, b) => a - b)
  s.delaySummary = { n: d.length, p50: d[Math.floor(d.length / 2)], p95: d[Math.floor(d.length * 0.95)], max: d[d.length - 1] }
  delete s.delays
}
fs.writeFileSync(path.join(out, 'pages.json'), JSON.stringify(states, null, 1))
await withTimeout(browser.close(), 15_000)
http.close()

// Check 8: the host's token appears in nothing written.
const hits = []
for (const file of fs.readdirSync(out)) {
  const text = fs.readFileSync(path.join(out, file), 'utf8')
  if (text.includes(hostToken)) hits.push(file)
  if (text.includes(hostToken.split('.')[2])) hits.push(`${file} (signature)`)
}
fs.writeFileSync(path.join(out, 'token-check.json'), JSON.stringify({ filesChecked: fs.readdirSync(out).length, hits }, null, 1))
log(`token hits: ${JSON.stringify(hits)}`)
for (const child of children) if (child.exitCode === null) child.kill('SIGTERM')
log('done')
process.exit(0)
