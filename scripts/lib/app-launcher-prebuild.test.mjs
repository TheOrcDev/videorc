import assert from 'node:assert/strict'
import test from 'node:test'
import { runDevBackendPrebuild } from './app-launcher.mjs'

const spec = (source, timeoutMs = 30_000) => ({
  command: process.execPath,
  args: ['-e', source],
  timeoutMs
})

test('async prebuild is a no-op without a spec', async () => {
  assert.equal(await runDevBackendPrebuild(null), null)
})

test('async prebuild reports the last 20 output lines and success', async () => {
  const lines = []
  const failure = await runDevBackendPrebuild(
    spec("for (let i = 0; i < 30; i++) console.log('output-' + i)"),
    { onLine: (line) => lines.push(line) }
  )
  assert.equal(failure, null)
  assert.match(lines[0], /\[smoke:prebuild\].*timeout 30s/)
  assert.deepEqual(
    lines.slice(1, -1),
    Array.from({ length: 20 }, (_, i) => `[smoke:prebuild] output-${i + 10}`)
  )
  assert.match(lines.at(-1), /backend built in \d+s/)
})

test('async prebuild preserves nonzero failures and stderr tails', async () => {
  const failure = await runDevBackendPrebuild(
    spec("console.error('build failed'); process.exitCode = 101")
  )
  assert.match(failure, /Backend prebuild failed .*exited 101/)
  assert.match(failure, /Last cargo output:\nbuild failed/)
})

test('async prebuild reports a timeout even after escalation to SIGKILL', async () => {
  const failure = await runDevBackendPrebuild(
    spec("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)", 1000)
  )
  assert.match(failure, /Backend still compiling after 1s/)
})
