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
  waitForHostMemory
} from './host-lock.mjs'
import { prepareSmokeLaunch } from './app-launcher.mjs'

const portTest = (name, fn) =>
  test(name, { skip: process.platform === 'win32', timeout: 10000 }, fn)
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
      memory: () => order.push('memory')
    })
    assert.deepEqual(
      order,
      dev ? ['slot', 'build', 'release', 'lock', 'memory'] : ['lock', 'memory']
    )
  }
})

portTest('port zero cannot accidentally disable mutual exclusion', async () => {
  await assert.rejects(acquirePortLock({ port: 0 }), /Invalid VIDEORC_SMOKE_LOCK_PORT/)
})
