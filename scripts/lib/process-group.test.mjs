import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { spawnProcessGroup } from './process-group.mjs'

async function assertGone(pid) {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      assert.equal(error.code, 'ESRCH')
      return
    }
    await delay(20)
  }
  assert.fail(`owned PID ${pid} survived cleanup`)
}

for (const ignoresTerm of [false, true]) {
  test(
    `timeout stops fake cargo and its grandchild (ignores TERM: ${ignoresTerm})`,
    {
      skip: process.platform === 'win32'
    },
    async (t) => {
      // Startup on a busy host must not consume the timeout under test. Keep
      // real child processes, but advance the clock only after both are ready.
      t.mock.timers.enable({ apis: ['setTimeout'] })
      const grandchildSource = `
      ${ignoresTerm ? "process.on('SIGTERM', () => {})" : ''}
      console.log(process.pid)
      setInterval(() => {}, 1000)
    `
      const source = `
      const { spawn } = require('node:child_process')
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildSource)}], {
        stdio: ['ignore', 'pipe', 'ignore']
      })
      child.stdout.pipe(process.stdout)
      setInterval(() => {}, 1000)
    `
      const { child, result } = spawnProcessGroup(process.execPath, ['-e', source], {
        stdio: ['ignore', 'pipe', 'ignore'],
        timeoutMs: 1000,
        graceMs: 100
      })
      const lines = createInterface({ input: child.stdout })
      const ready = once(lines, 'line', { signal: AbortSignal.timeout(10_000) })
      let output = ''
      child.stdout.on('data', (chunk) => {
        output += chunk
      })
      t.after(() => {
        lines.close()
        // Also reap the deliberately surviving descendant during red verification.
        for (const pid of [-child.pid, Number(output.trim())]) {
          if (!pid) continue
          try {
            process.kill(pid, 'SIGKILL')
          } catch (error) {
            if (error.code !== 'ESRCH') throw error
          }
        }
      })
      await ready
      const grandchildPid = Number(output.trim())
      assert.ok(grandchildPid > 0, 'grandchild reported readiness and PID')
      const leaderExit = once(child, 'exit', { signal: AbortSignal.timeout(5000) })
      t.mock.timers.tick(1000)
      await leaderExit
      // The group leader is gone before escalation. A TERM-resistant child
      // still needs the group-wide KILL; cancelling it on leader exit leaks.
      t.mock.timers.tick(100)
      t.mock.timers.reset()
      const outcome = await result
      assert.equal(outcome.timedOut, true)
      await assertGone(child.pid)
      await assertGone(grandchildPid)
    }
  )
}

test('spawn failure removes parent signal listeners', async () => {
  const before = ['SIGINT', 'SIGTERM'].map((name) => process.listenerCount(name))
  const { result } = spawnProcessGroup('/nonexistent-videorc-test-executable', [])
  assert.equal((await result).error.code, 'ENOENT')
  assert.deepEqual(
    ['SIGINT', 'SIGTERM'].map((name) => process.listenerCount(name)),
    before
  )
})

for (const name of ['SIGINT', 'SIGTERM']) {
  test(
    `forwards parent ${name} and removes listeners on exit`,
    { skip: process.platform === 'win32' },
    async () => {
      const before = ['SIGINT', 'SIGTERM'].map((signal) => process.listenerCount(signal))
      const { child, result } = spawnProcessGroup(
        process.execPath,
        ['-e', 'console.log("ready"); setInterval(() => {}, 1000)'],
        {
          stdio: ['ignore', 'pipe', 'ignore'],
          timeoutMs: 30_000,
          graceMs: 50
        }
      )
      await new Promise((resolve, reject) => {
        child.stdout.once('data', resolve)
        child.once('error', reject)
      })
      process.emit(name)
      const outcome = await result
      assert.equal(outcome.interrupted, true)
      assert.equal(outcome.timedOut, false)
      assert.equal(outcome.signal, name)
      await assertGone(child.pid)
      assert.deepEqual(
        ['SIGINT', 'SIGTERM'].map((signal) => process.listenerCount(signal)),
        before
      )
    }
  )
}
