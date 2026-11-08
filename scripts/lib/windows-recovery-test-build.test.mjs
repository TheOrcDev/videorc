import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import { describe, it } from 'node:test'

import { runWindowsRecoveryTestBuild } from './windows-recovery-test-build.mjs'

function fixture() {
  const productionExecutable = resolve('fixture/production/Videorc.exe')
  const testDirectory = resolve('fixture/separate-test')
  const calls = []
  const options = {
    repoRoot: resolve('.'),
    productionExecutable,
    testDirectory,
    viteCli: 'vite-cli',
    builderCli: 'builder-cli',
    env: { PATH: 'tools' },
    run: (args, config) => calls.push({ args, ...config }),
    readIdentity: (path) => ({ [path]: path === productionExecutable ? 'original' : 'test' }),
    readFlags: (path) => ({ packagedTestHooks: path !== productionExecutable })
  }
  return { options, calls }
}

describe('Windows recovery test package isolation', () => {
  it('checks production hardening, builds only a separate test directory and probes that executable', () => {
    const { options, calls } = fixture()
    const result = runWindowsRecoveryTestBuild(options)
    assert.equal(result.evidenceKind, 'packaged-test-build')
    assert.deepEqual(calls[0].args.slice(1), ['--app', options.productionExecutable])
    assert.equal(calls[1].env.VIDEORC_PACKAGED_TEST_HOOKS, '1')
    assert.equal(calls[2].env.CSC_IDENTITY_AUTO_DISCOVERY, 'false')
    assert.ok(calls[2].args.includes(`--config.directories.output=${options.testDirectory}`))
    assert.ok(calls[2].args.includes('dir'))
    assert.ok(!calls[2].args.includes('nsis'))
    assert.ok(calls[3].args.includes('--allow-test-hooks'))
    assert.equal(
      calls[4].env.VIDEORC_PERF_APP_EXECUTABLE,
      join(options.testDirectory, 'win-unpacked', 'Videorc.exe')
    )
    assert.deepEqual(options.env, { PATH: 'tools' })
  })

  for (const output of ['fixture/production', 'fixture/production/nested', 'fixture']) {
    it(`rejects an overlapping output ${output} before any command`, () => {
      const { options, calls } = fixture()
      assert.throws(
        () => runWindowsRecoveryTestBuild({ ...options, testDirectory: resolve(output) }),
        /outside the production/
      )
      assert.equal(calls.length, 0)
    })
  }

  it('does not run a smoke or build when the production hardening check fails', () => {
    const { options } = fixture()
    let count = 0
    assert.throws(
      () =>
        runWindowsRecoveryTestBuild({
          ...options,
          run() {
            count++
            throw new Error('bad fuse')
          }
        }),
      /bad fuse/
    )
    assert.equal(count, 1)
  })

  it('refuses a test-enabled original installer', () => {
    const { options, calls } = fixture()
    assert.throws(
      () =>
        runWindowsRecoveryTestBuild({ ...options, readFlags: () => ({ packagedTestHooks: true }) }),
      /installer under test/
    )
    assert.equal(calls.length, 1)
  })

  it('refuses a second package with missing test hooks before running the smoke', () => {
    const { options, calls } = fixture()
    assert.throws(
      () =>
        runWindowsRecoveryTestBuild({
          ...options,
          readFlags: () => ({ packagedTestHooks: false })
        }),
      /separate packaged test build/
    )
    assert.equal(calls.length, 4)
  })

  it('fails when the test build changes the original even if the probe would pass', () => {
    const { options } = fixture()
    let originalReads = 0
    assert.throws(
      () =>
        runWindowsRecoveryTestBuild({
          ...options,
          readIdentity(path) {
            return {
              hash: path === options.productionExecutable ? String(++originalReads) : 'test'
            }
          }
        }),
      /production package changed/
    )
  })

  it('preserves a failed smoke result while still checking the original bytes', () => {
    const { options } = fixture()
    let originalReads = 0
    assert.throws(
      () =>
        runWindowsRecoveryTestBuild({
          ...options,
          readIdentity(path) {
            if (path === options.productionExecutable) originalReads++
            return { hash: path }
          },
          run(args) {
            if (args[0].endsWith('smoke-windows-main-window-recovery.mjs'))
              throw new Error('recovery failed')
          }
        }),
      /recovery failed/
    )
    assert.equal(originalReads, 2)
  })
})
