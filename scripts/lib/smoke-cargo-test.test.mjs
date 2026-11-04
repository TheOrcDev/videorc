import assert from 'node:assert/strict'
import test from 'node:test'
import { DEV_BACKEND_PREBUILD_TIMEOUT_MS } from './app-launcher.mjs'
import { runSmokeCargoTest } from './smoke-cargo-test.mjs'

function harness() {
  const calls = []
  let inSlot = false
  return {
    calls,
    options: {
      log: () => {},
      buildSlot: async (fn, options) => {
        calls.push({ slot: options })
        inSlot = true
        try {
          return await fn()
        } finally {
          inSlot = false
        }
      },
      run: async (args, options) => {
        calls.push({ args, ...options, inSlot })
        return Buffer.from('cargo output')
      }
    }
  }
}

test('precompiles the same target/env in a slot, then runs with a separate 600s budget', async () => {
  const { calls, options } = harness()
  const args = [
    'test',
    '-p',
    'videorc-backend',
    '--bin',
    'videorc-backend',
    '--features',
    'fixture',
    '--profile',
    'release',
    '--target',
    'aarch64-apple-darwin',
    'fixture::test',
    '--',
    '--exact',
    '--nocapture'
  ]
  const original = [...args]
  const env = { CARGO_TARGET_DIR: '/owned/target', VIDEORC_FIXTURE_DIR: '/owned/fixture' }
  await runSmokeCargoTest(args, { ...options, cwd: '/owned', env })
  assert.deepEqual(calls[0].slot, { env, log: options.log })
  assert.deepEqual(calls[1], {
    args: [...args.slice(0, args.indexOf('--')), '--no-run', ...args.slice(args.indexOf('--'))],
    cwd: '/owned',
    env,
    capture: false,
    timeoutMs: DEV_BACKEND_PREBUILD_TIMEOUT_MS,
    inSlot: true
  })
  assert.deepEqual(calls[2], {
    args,
    cwd: '/owned',
    env,
    capture: false,
    timeoutMs: 600_000,
    inSlot: false
  })
  assert.equal(calls[1].env, calls[2].env)
  assert.deepEqual(args, original)
})

test('uses the prebuild override without changing the execution budget, even with SKIP_PREBUILD', async () => {
  const { calls, options } = harness()
  await runSmokeCargoTest(['test', '-p', 'videorc-backend'], {
    ...options,
    env: { VIDEORC_SMOKE_PREBUILD_TIMEOUT_MS: '3600000', VIDEORC_SMOKE_SKIP_PREBUILD: '1' }
  })
  assert.deepEqual(calls[1].args, ['test', '-p', 'videorc-backend', '--no-run'])
  assert.equal(calls[1].inSlot, true)
  assert.equal(calls[1].timeoutMs, 3_600_000)
  assert.equal(calls[2].timeoutMs, 600_000)
})

test('an existing --no-run invocation builds once in a slot and returns Cargo JSON unchanged', async () => {
  const { calls, options } = harness()
  const args = ['test', '-p', 'videorc-backend', '--no-run', '--message-format=json']
  const output = Buffer.from('{"reason":"compiler-artifact","executable":"/owned/test"}\n')
  const run = options.run
  const result = await runSmokeCargoTest(args, {
    ...options,
    env: {},
    capture: true,
    run: async (...params) => {
      await run(...params)
      return output
    }
  })
  assert.equal(result, output)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[1].args, args)
  assert.equal(calls[1].capture, true)
  assert.equal(calls[1].inSlot, true)
  assert.equal(calls[1].timeoutMs, DEV_BACKEND_PREBUILD_TIMEOUT_MS)
})

test('invalid prebuild overrides fall back to the dev prebuild budget', async () => {
  for (const value of ['invalid', '0', '-1', 'Infinity', '']) {
    const { calls, options } = harness()
    await runSmokeCargoTest(['test'], {
      ...options,
      env: { VIDEORC_SMOKE_PREBUILD_TIMEOUT_MS: value }
    })
    assert.equal(calls[1].timeoutMs, DEV_BACKEND_PREBUILD_TIMEOUT_MS)
  }
})

test('a failed precompile or slot acquisition prevents test execution', async () => {
  for (const stage of ['buildSlot', 'run']) {
    const { calls, options } = harness()
    const failure = new Error(`${stage} failed`)
    await assert.rejects(
      runSmokeCargoTest(['test'], {
        ...options,
        env: {},
        [stage]: async () => {
          throw failure
        }
      }),
      (error) => error === failure
    )
    assert.equal(calls.filter((call) => call.args).length, 0)
  }
})
