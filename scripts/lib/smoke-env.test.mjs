import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

function envAfterImport(module) {
  const output = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `await import(${JSON.stringify(new URL(module, import.meta.url).href)}); console.log(JSON.stringify([process.env.T3CODE_THREAD_ID ?? null, process.env.ELECTRON_RUN_AS_NODE ?? null]))`
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, T3CODE_THREAD_ID: 'thread-1', ELECTRON_RUN_AS_NODE: '1' }
    }
  )
  return JSON.parse(output.trim().split('\n').at(-1))
}

test('importing the app launcher drops the T3 Code variables before any smoke spawns', () => {
  assert.deepEqual(envAfterImport('./smoke-env.mjs'), [null, null])
  assert.deepEqual(envAfterImport('./app-launcher.mjs'), [null, null])
})
