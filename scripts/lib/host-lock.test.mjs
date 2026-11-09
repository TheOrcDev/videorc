import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import {
  acquirePortLock,
  acquireHostSmokeLock,
  withBuildSlot,
  parseDarwinMemory,
  parseLinuxMemory,
  parseAvailableMemory,
  waitForHostMemory,
  liveStreamPids,
  waitWhileVideorcLive
} from './host-lock.mjs'
import { prepareSmokeLaunch } from './app-launcher.mjs'

// Host admission is off on Windows by design (#937): acquirePortLock, the host lock and the
// build slots admit everything there, so the TCP mutual-exclusion cases have nothing to test.
// The Windows contract is pinned below; docs/windows-dev-loop.md names what stays unverified.
const WINDOWS_ADMISSION_OFF =
  process.platform === 'win32' &&
  'host admission is off on Windows by design: acquirePortLock, acquireHostSmokeLock and withBuildSlot admit every caller'
const portTest = (name, fn) => test(name, { skip: WINDOWS_ADMISSION_OFF, timeout: 10000 }, fn)
async function freePort() {
  const server = net.createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await new Promise((done) => server.close(done))
  if ((port >= 47868 && port <= 47872) || port > 65533) return freePort()
  return port
}
function child(code, env = {}) {
  return spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { acquirePortLock, acquireHostSmokeLock, withBuildSlot } from ${JSON.stringify(new URL('./host-lock.mjs', import.meta.url).href)}; ${code}`
    ],
    {
      env: {
        ...process.env,
        VIDEORC_SMOKE_HOST_LOCK_HOLDER: '',
        VIDEORC_SMOKE_BUILD_SLOT_HOLDER: '',
        ...env
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    }
  )
}
async function message(proc) {
  return (await once(proc, 'message'))[0]
}
async function stop(proc) {
  if (proc.exitCode !== null || proc.signalCode !== null) return
  const exited = once(proc, 'exit')
  proc.kill('SIGKILL')
  await exited
}
portTest('acquire, timeout names holder, release, reacquire', async () => {
  const port = await freePort()
  const lock = await acquirePortLock({ port })
  try {
    await assert.rejects(
      acquirePortLock({ port, waitMs: 0 }),
      (error) =>
        error.message.includes(`pid ${process.pid}`) &&
        error.message.includes('VIDEORC_SMOKE_HOST_LOCK_WAIT_MS')
    )
  } finally {
    await lock.release()
  }
  const next = await acquirePortLock({ port, waitMs: 0 })
  await next.release()
})
portTest('child waits for release and reports the holder', async (t) => {
  const port = await freePort()
  const lock = await acquirePortLock({ port })
  t.after(() => lock.release())
  const proc = child(
    `const lock = await acquirePortLock({port:${port},pollMs:10, log: line => process.send(line)}); process.send('acquired'); process.on('message', async () => { await lock.release(); process.disconnect() })`
  )
  t.after(() => stop(proc))
  assert.match(await message(proc), new RegExp(`pid ${process.pid}`))
  const acquired = message(proc)
  await lock.release()
  assert.equal(await acquired, 'acquired')
  proc.send('release')
  await once(proc, 'exit')
})
portTest('SIGKILL releases ownership immediately', async (t) => {
  const port = await freePort()
  const proc = child(
    `await acquirePortLock({port:${port}}); process.send('held'); setInterval(()=>{},1000)`
  )
  t.after(() => stop(proc))
  assert.equal(await message(proc), 'held')
  await stop(proc)
  const lock = await acquirePortLock({ port, waitMs: 0 })
  await lock.release()
})
portTest('host lock is reentrant in process and inherited by children', async (t) => {
  const port = await freePort()
  const proc = child(
    `const a = await acquireHostSmokeLock(); const b = await acquireHostSmokeLock(); process.send(a === b); process.on('message', () => process.disconnect())`,
    { VIDEORC_SMOKE_LOCK_PORT: String(port) }
  )
  t.after(() => stop(proc))
  assert.equal(await message(proc), true)
  const inherited = await acquireHostSmokeLock({
    env: { VIDEORC_SMOKE_HOST_LOCK_HOLDER: String(proc.pid) }
  })
  await inherited.release()
  proc.send('done')
  await once(proc, 'exit')
})
portTest('exactly N slots, nested builds and inherited holders', async (t) => {
  // Reserve arbitrary free ports independently; use a one-port base for each capacity test.
  let base
  for (;;) {
    base = await freePort()
    let a
    try {
      a = await acquirePortLock({ port: base + 1, waitMs: 0 })
      const b = await acquirePortLock({ port: base + 2, waitMs: 0 })
      await a.release()
      await b.release()
      break
    } catch {
      /* Pick another ephemeral range. */
    } finally {
      await a?.release()
    }
  }
  const env = { VIDEORC_SMOKE_LOCK_PORT: String(base), VIDEORC_SMOKE_BUILD_SLOTS: '2' }
  let active = 0
  let peak = 0
  await Promise.all(
    Array.from({ length: 5 }, () =>
      withBuildSlot(
        async () => {
          active++
          peak = Math.max(peak, active)
          await withBuildSlot(async () => {}, { env })
          await delay(20)
          active--
        },
        { env, pollMs: 5, log: () => {} }
      )
    )
  )
  assert.equal(peak, 2)
  const proc = child(
    `await withBuildSlot(async () => { process.send('held'); await new Promise(r => process.on('message',r)) }); process.disconnect()`,
    env
  )
  t.after(() => stop(proc))
  assert.equal(await message(proc), 'held')
  await withBuildSlot(async () => {}, {
    env: { ...env, VIDEORC_SMOKE_BUILD_SLOT_HOLDER: String(proc.pid) }
  })
  proc.send('done')
  await once(proc, 'exit')
})
portTest('release never waits on a peer that probed the lock port', async (t) => {
  const port = await freePort()
  const lock = await acquirePortLock({ port })
  // T3 Code probes every new localhost listener (HTTP GET, TLS hello) and keeps the socket open.
  const peer = net.connect({ host: '127.0.0.1', port })
  t.after(() => peer.destroy())
  peer.on('error', () => {})
  const hungUp = new Promise((done) => peer.once('close', done))
  peer.write('GET / HTTP/1.1\r\nhost: localhost\r\n\r\n')
  await delay(50)
  assert.equal(await Promise.race([lock.release().then(() => true), delay(2000, false)]), true)
  await hungUp
})
test(
  'Windows admits every smoke and build without taking a port',
  { skip: process.platform !== 'win32' && 'pins the Windows-only no-op admission', timeout: 10000 },
  async (t) => {
    // A listener already owns this port, so a real lock could only wait or time out.
    const port = await freePort()
    const owner = net.createServer((socket) => socket.destroy())
    owner.listen({ host: '127.0.0.1', port, exclusive: true })
    await once(owner, 'listening')
    t.after(() => new Promise((done) => owner.close(done)))
    await (await acquirePortLock({ port, waitMs: 0 })).release()
    await (await acquirePortLock({ port: 0, waitMs: 0 })).release()
    const env = { VIDEORC_SMOKE_LOCK_PORT: String(port) }
    const first = await acquireHostSmokeLock({ env })
    const second = await acquireHostSmokeLock({ env })
    await first.release()
    await second.release()
    assert.notEqual(process.env.VIDEORC_SMOKE_HOST_LOCK_HOLDER, String(process.pid))
    const slotEnv = { VIDEORC_SMOKE_LOCK_PORT: String(port - 1), VIDEORC_SMOKE_BUILD_SLOTS: '1' }
    let active = 0
    let peak = 0
    let releaseAll
    const gate = new Promise((done) => (releaseAll = done))
    const builds = Array.from({ length: 3 }, () =>
      withBuildSlot(
        async () => {
          peak = Math.max(peak, ++active)
          await gate
          active--
          return process.env.VIDEORC_SMOKE_BUILD_SLOT_HOLDER
        },
        { env: slotEnv }
      )
    )
    // withBuildSlot calls fn synchronously on Windows, so every build is already inside.
    assert.equal(peak, 3)
    releaseAll()
    for (const holder of await Promise.all(builds)) assert.notEqual(holder, String(process.pid))
  }
)
test('memory parsers and thresholds (swap alone does not block)', () => {
  assert.equal(parseDarwinMemory('1\n', '51', 'total = 8G used = 6.8G free = 1.2G').busy, false)
  assert.equal(parseDarwinMemory('2', '20', '').pressure, 'warning')
  assert.equal(parseDarwinMemory('4', '5', '').pressure, 'critical')
  assert.equal(parseLinuxMemory('MemTotal: 1000 kB\nMemAvailable: 99 kB').busy, true)
  assert.equal(parseAvailableMemory(10, 100).busy, false)
  assert.equal(parseAvailableMemory(9, 100).busy, true)
})
test('memory waits, times out clearly, and CI only logs', async () => {
  const busy = () => ({ busy: true, pressure: 'critical', freePercent: 3, swap: '6G of 8G' })
  const lines = []
  await waitForHostMemory({
    env: { CI: 'true', VIDEORC_SMOKE_MEMORY_WAIT_MS: '0' },
    read: busy,
    log: (line) => lines.push(line)
  })
  assert.match(lines[0], /Host busy: memory pressure critical/)
  await assert.rejects(
    waitForHostMemory({ env: { VIDEORC_SMOKE_MEMORY_WAIT_MS: '0' }, read: busy, log: () => {} }),
    /free 3%, swap 6G of 8G/
  )
  let calls = 0
  await waitForHostMemory({
    env: {},
    pollMs: 1,
    log: () => {},
    read: () => (++calls === 1 ? busy() : { busy: false })
  })
  assert.equal(calls, 2)
})
const FFMPEG = '/Applications/Videorc.app/Contents/Resources/ffmpeg/bin/ffmpeg'
test('a live stream is Videorc ffmpeg pushing FLV to a real ingest, never a loopback smoke sink', () => {
  const ps = [
    // The 2026-11-04 shape: recording MKV plus fifo-wrapped FLV legs to YouTube and Twitch.
    ` 4242 ${FFMPEG} -f mpegts -i /tmp/rec.ts -map 0:v -c:v copy /Users/me/Movies/Videorc/Recordings/a.mkv -f fifo -fifo_format flv -queue_size 512 rtmp://a.rtmp.youtube.com/live2/key -f fifo -fifo_format flv rtmps://ingest.global-contribute.live-video.net/app/key`,
    // Linux tee slave.
    ` 4343 /usr/bin/ffmpeg -i - -f tee [f=matroska]/tmp/a.mkv|[f=flv:onfail=ignore]rtmp://live.twitch.tv/app/key`,
    // A smoke streaming to its own local sink, and the sink itself.
    ` 5000 ${FFMPEG} -f mpegts -i /tmp/x.ts -f fifo -fifo_format flv rtmp://127.0.0.1:19501/live/test`,
    ` 5001 ffmpeg -listen 1 -i rtmp://127.0.0.1:19501/live/test -c copy /tmp/recv.flv`,
    ` 5002 ${FFMPEG} -f flv rtmp://localhost/live/a -f flv rtmp://[::1]:1935/live/b`,
    // A record-only session, an app named after a stream, and junk.
    ` 6000 ${FFMPEG} -f mpegts -i /tmp/rec.ts -c copy /tmp/b.mkv`,
    ` 6001 /Applications/Notes.app/Contents/MacOS/Notes rtmp://a.rtmp.youtube.com/live2 flv`,
    // An agent shell whose script quotes a live command line is not a stream.
    ` 6002 /bin/zsh -c eval 'node -e "${FFMPEG} -f fifo -fifo_format flv rtmp://a.rtmp.youtube.com/live2/k"'`,
    'not a ps line'
  ].join('\n')
  assert.deepEqual(liveStreamPids(ps), [4242, 4343])
  assert.deepEqual(liveStreamPids(''), [])
})
test('heavy work waits while live, says why once per notice window, and has an off switch', async () => {
  const lines = []
  let reads = 0
  await waitWhileVideorcLive({
    env: {},
    platform: 'darwin',
    pollMs: 1,
    noticeMs: 60000,
    log: (line) => lines.push(line),
    read: () => (++reads < 4 ? [4242] : [])
  })
  assert.equal(reads, 4)
  assert.equal(lines.length, 1)
  assert.match(lines[0], /Videorc is live on this machine \(ffmpeg pid 4242\)/)
  assert.match(lines[0], /VIDEORC_BUILD_WHILE_LIVE=1/)
  const never = () => {
    throw new Error('must not scan')
  }
  for (const [env, platform] of [
    [{ VIDEORC_BUILD_WHILE_LIVE: '1' }, 'darwin'],
    [{ CI: 'true' }, 'darwin'],
    [{}, 'win32']
  ]) {
    await waitWhileVideorcLive({ env, platform, read: never })
  }
  // A scan that fails never holds work back.
  await waitWhileVideorcLive({ env: {}, platform: 'darwin', read: never })
})
test('zero knobs disable each feature', async () => {
  await (
    await acquireHostSmokeLock({
      env: { VIDEORC_SMOKE_HOST_LOCK: '0', VIDEORC_SMOKE_LOCK_PORT: 'invalid' }
    })
  ).release()
  assert.equal(
    await withBuildSlot(() => 42, {
      env: { VIDEORC_SMOKE_BUILD_SLOTS: '0', VIDEORC_SMOKE_LOCK_PORT: 'invalid' }
    }),
    42
  )
  await waitForHostMemory({
    env: { VIDEORC_SMOKE_MEMORY_CHECK: '0' },
    read: () => {
      throw new Error('must not read')
    }
  })
})
test('launch preparation orders prebuild, release, host lock, memory for every launch kind', async () => {
  for (const dev of [true, false]) {
    const order = []
    await prepareSmokeLaunch({
      dev,
      env: {},
      buildSlot: async (fn) => {
        order.push('slot')
        await fn()
        order.push('release')
      },
      prebuild: () => order.push('build'),
      hostLock: () => order.push('lock'),
      memory: () => order.push('memory'),
      live: () => order.push('live')
    })
    assert.deepEqual(
      order,
      dev ? ['live', 'slot', 'build', 'release', 'lock', 'memory'] : ['live', 'lock', 'memory']
    )
  }
})

portTest('port zero cannot accidentally disable mutual exclusion', async () => {
  await assert.rejects(acquirePortLock({ port: 0 }), /Invalid VIDEORC_SMOKE_LOCK_PORT/)
})
