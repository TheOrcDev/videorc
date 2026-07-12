import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  assertRequiredPlatform,
  commandNeedsShell,
  createRunEnvironment,
  parseRunWithEnvArgs
} from './run-with-env.mjs'

test('run-with-env parses platform, path, assignments, and command arguments', () => {
  assert.deepEqual(
    parseRunWithEnvArgs([
      '--platform=darwin',
      '--prepend-path=/opt/tool/bin',
      'FEATURE=1',
      'TOKEN=a=b',
      '--',
      'node',
      'script.mjs',
      '--gate'
    ]),
    {
      command: 'node',
      commandArgs: ['script.mjs', '--gate'],
      environment: { FEATURE: '1', TOKEN: 'a=b' },
      prependPath: ['/opt/tool/bin'],
      requiredPlatform: 'darwin'
    }
  )
})

test('run-with-env rejects malformed setup arguments', () => {
  assert.throws(() => parseRunWithEnvArgs(['FEATURE=1', 'node']), /requires `--`/)
  assert.throws(() => parseRunWithEnvArgs(['not-an-assignment', '--', 'node']), /Invalid/)
  assert.throws(() => parseRunWithEnvArgs(['1FEATURE=x', '--', 'node']), /variable name/)
  assert.throws(() => parseRunWithEnvArgs(['FEATURE=1', '--']), /requires a command/)
})

test('run-with-env fails clearly when a platform-specific alias is used elsewhere', () => {
  assert.doesNotThrow(() => assertRequiredPlatform('darwin', 'darwin'))
  assert.throws(() => assertRequiredPlatform('darwin', 'win32'), /requires darwin.*win32/)
})

test('run-with-env prepends PATH without shell interpolation', () => {
  const posix = createRunEnvironment(
    { environment: { FEATURE: '1' }, prependPath: ['/tool/bin'] },
    { baseEnvironment: { PATH: '/usr/bin' }, platform: 'darwin', pathDelimiter: ':' }
  )
  assert.deepEqual(posix, { FEATURE: '1', PATH: '/tool/bin:/usr/bin' })

  const windows = createRunEnvironment(
    { prependPath: ['C:\\tool\\bin'] },
    { baseEnvironment: { Path: 'C:\\Windows' }, platform: 'win32', pathDelimiter: ';' }
  )
  assert.deepEqual(windows, { Path: 'C:\\tool\\bin;C:\\Windows' })
})

test('run-with-env uses a shell only for Windows command shims', () => {
  assert.equal(commandNeedsShell('pnpm', 'win32'), true)
  assert.equal(commandNeedsShell('tool.cmd', 'win32'), true)
  assert.equal(commandNeedsShell('node', 'win32'), false)
  assert.equal(commandNeedsShell('pnpm', 'darwin'), false)
})

test('run-with-env CLI passes configured values to the child', () => {
  const runner = fileURLToPath(new URL('../run-with-env.mjs', import.meta.url))
  const result = spawnSync(
    process.execPath,
    [
      runner,
      'VIDEORC_RUN_WITH_ENV_TEST=value=with-equals',
      '--',
      process.execPath,
      '-e',
      'process.stdout.write(process.env.VIDEORC_RUN_WITH_ENV_TEST ?? "missing")'
    ],
    { encoding: 'utf8' }
  )

  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, 'value=with-equals')
})

test('package aliases use parseable portable environment syntax', () => {
  const packageJson = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
  )
  const posixAssignment = /(^|&& |\| )([A-Z][A-Z0-9_]+)=/
  const runnerPrefix = 'node scripts/run-with-env.mjs '

  for (const [name, command] of Object.entries(packageJson.scripts)) {
    assert.doesNotMatch(command, posixAssignment, `${name} still uses POSIX-only env syntax`)
    if (!command.startsWith(runnerPrefix)) continue
    assert.doesNotThrow(
      () => parseRunWithEnvArgs(command.slice(runnerPrefix.length).split(/\s+/)),
      `${name} must be accepted by run-with-env`
    )
  }
})

test('macOS-only package aliases declare their platform before spawning', () => {
  const packageJson = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
  )
  const macOnlyAliases = [
    'dev:zerocopy',
    'check:windows',
    'baseline:real-source:raw-yuv',
    'baseline:real-source:videotoolbox-output',
    'baseline:real-source:videotoolbox-mpegts-output',
    'baseline:real-source:motion-mpegts-output',
    'baseline:real-source:4k30',
    'baseline:real-source:4k30:av-sync',
    'baseline:real-source:4k30:endurance',
    'baseline:real-source:av-sync-mpegts-output',
    'baseline:stream:caption-burn-av-sync',
    'baseline:stream:av-sync:endurance',
    'baseline:real-source:camera-mpegts-output',
    'baseline:real-source:camera-mpegts-output:no-preview',
    'smoke:live-layout-switch-recording:devices',
    'smoke:preview-interaction-stress:devices',
    'smoke:recording-studio:devices',
    'smoke:screen-recording-real',
    'smoke:notes-window-invisible',
    'probe:recording-native-preview:videotoolbox',
    'probe:recording-native-preview:videotoolbox-output',
    'probe:recording-native-preview:videotoolbox-mpegts-output',
    'smoke:packaged:native-preview',
    'smoke:packaged:native-preview:performance'
  ]

  for (const name of macOnlyAliases) {
    assert.match(packageJson.scripts[name], /run-with-env\.mjs --platform=darwin /, name)
  }
})
