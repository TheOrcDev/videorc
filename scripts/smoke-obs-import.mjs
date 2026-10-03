// OBS import smoke (plan O6): boot the dev app against a FIXTURE OBS root and
// prove the import surface end-to-end over the real IPC — discovery finds the
// fixture, the setup payload carries the collection WITHOUT the stream key,
// and the key arrives only through the dedicated apply-time channel.
//
// Run: pnpm smoke:obs-import

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { launchDevApp } from './lib/app-launcher.mjs'
import { isRetryableSmokeCommandError, requestSmokeCommand } from './lib/smoke-command-client.mjs'

const repoRoot = resolve(import.meta.dirname, '..')
const fixtures = join(repoRoot, 'apps/desktop/src/main/obs-fixtures')

export async function runObsImportSmoke({
  launchApp = launchDevApp,
  requestCommand = requestSmokeCommand,
  timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 120000),
  operationTimeoutMs = 15000,
  evidenceDirectory = process.env.VIDEORC_SMOKE_OUTPUT_DIR,
  log = console.log
} = {}) {
  if (evidenceDirectory) mkdirSync(evidenceDirectory, { recursive: true })
  const runDirectory = mkdtempSync(join(evidenceDirectory ?? tmpdir(), 'videorc-obs-smoke-'))
  const obsRoot = join(runDirectory, 'obs-root')
  // Copy only the scrubbed fixtures; retain their recording-folder behavior.
  mkdirSync(join(obsRoot, 'basic', 'scenes'), { recursive: true })
  mkdirSync(join(obsRoot, 'basic', 'profiles', 'Fixture Profile'), { recursive: true })
  writeFileSync(
    join(obsRoot, 'basic', 'scenes', 'Fixture Collection.json'),
    readFileSync(join(fixtures, 'collection.json'))
  )
  for (const name of ['basic.ini', 'service.json']) {
    writeFileSync(
      join(obsRoot, 'basic', 'profiles', 'Fixture Profile', name),
      readFileSync(join(fixtures, name))
    )
  }
  writeFileSync(
    join(obsRoot, 'global.ini'),
    '[Basic]\nSceneCollection=Fixture Collection\nProfile=Fixture Profile\n'
  )

  let launched
  let operationFailure
  try {
    log('[obs-import] launch start')
    try {
      launched = await launchApp({
        requiredMarkers: ['backend-ready', 'preview-motion-ready'],
        timeoutMs,
        env: {
          VIDEORC_SMOKE_PRINT_BACKEND_READY: '1',
          VIDEORC_SMOKE_COMMAND_SERVER: '1',
          VIDEORC_SMOKE_PREVIEW_MOTION: '1',
          VIDEORC_SMOKE_STATE_DIR: runDirectory,
          VIDEORC_SMOKE_OUTPUT_DIR: runDirectory,
          VIDEORC_OBS_ROOT: obsRoot
        }
      })
    } catch (error) {
      throw namedOperationFailure('launch', error)
    }
    log('[obs-import] launch complete')
    const smoke = launched.connections['preview-motion-ready']
    const evaluate = async (operation, code) => {
      log(`[obs-import] ${operation} start`)
      try {
        // Both readiness markers have arrived. Setup reads also register
        // capabilities, so never replay an ambiguous timeout or disconnect.
        const response = await requestCommand(
          smoke,
          'eval-js',
          { code },
          {
            timeoutMs: Math.min(operationTimeoutMs, timeoutMs)
          }
        )
        log(`[obs-import] ${operation} complete`)
        return response?.result ?? response
      } catch (error) {
        log(`[obs-import] ${operation} failed`)
        throw namedOperationFailure(operation, error)
      }
    }

    const discovery = await evaluate('obsDiscover', 'return await window.videorc.obsDiscover()')
    assertLike(discovery, 'obsDiscover discovery', (value) => value?.available === true)
    assertLike(
      discovery,
      'obsDiscover current collection',
      (value) => value?.currentCollection === 'Fixture Collection'
    )

    const setup = await evaluate(
      'obsRead',
      "return await window.videorc.obsRead('Fixture Collection', 'Fixture Profile')"
    )
    assertLike(setup, 'obsRead canvas', (value) => value?.canvasWidth === 3840 && value?.fps === 24)
    assertLike(
      setup,
      'obsRead scenes',
      (value) => Array.isArray(value?.scenes) && value.scenes.length > 1
    )
    assertLike(setup, 'obsRead service without key', (value) => value?.service?.hasKey === true)
    if (JSON.stringify(setup).includes('fixture-not-a-real-key')) {
      throw new Error('OBS import smoke: obsRead leaked a stream key into the setup payload.')
    }

    const key = await evaluate(
      'obsReadStreamKey',
      "return await window.videorc.obsReadStreamKey('Fixture Profile')"
    )
    if (key !== 'fixture-not-a-real-key') {
      throw new Error(
        'OBS import smoke: obsReadStreamKey did not return the fixture key at apply time.'
      )
    }
  } catch (error) {
    operationFailure = error
    throw error
  } finally {
    if (launched) {
      log('[obs-import] owned teardown start')
      try {
        await launched.stop()
      } catch {
        log(`[obs-import] owned teardown failed; fixture/profile retained: ${runDirectory}`)
        const teardownFailure = new Error(
          'OBS import smoke: owned teardown failed; fixture/profile retained.'
        )
        throw new AggregateError(
          operationFailure ? [operationFailure, teardownFailure] : [teardownFailure],
          'OBS import smoke: owned teardown failed.'
        )
      }
      log('[obs-import] owned teardown complete')
      if (!operationFailure && !evidenceDirectory) {
        await rm(runDirectory, { recursive: true, force: true })
        log('[obs-import] fixture/profile cleanup complete')
      }
    }
    if (operationFailure || evidenceDirectory) {
      log(`[obs-import] fixture/profile evidence retained: ${runDirectory}`)
    }
  }
  log(
    'OBS import smoke OK - fixture root discovered, setup read (key stripped), apply-time key channel verified.'
  )
}

if (isObsSmokeEntry(process.argv[1])) {
  await runObsImportSmoke()
}

export function isObsSmokeEntry(entryPath) {
  if (!entryPath) return false
  try {
    return realpathSync(resolve(entryPath)) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
}

function assertLike(value, label, predicate) {
  if (!predicate(value)) {
    throw new Error(`OBS import smoke: unexpected ${label}.`)
  }
}

function namedOperationFailure(operation, error) {
  const message = String(error?.message ?? error)
  const kind = /timed? out|timeout/i.test(message)
    ? 'timed out'
    : /invalid JSON/i.test(message)
      ? 'returned malformed response'
      : isRetryableSmokeCommandError(error)
        ? 'transport failed'
        : 'failed'
  // Native parser/IPC errors may carry payload values. Only the operation and
  // bounded failure classification cross the diagnostic boundary.
  return new Error(`OBS import smoke: ${operation} ${kind}.`)
}
