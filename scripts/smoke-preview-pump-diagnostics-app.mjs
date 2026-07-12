#!/usr/bin/env node
// Preview pump diagnostics smoke: main-process present skips must surface why
// preview is waiting instead of silently starving the UI.

import { request as httpRequest } from 'node:http'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { launchDevApp } from './lib/app-launcher.mjs'

const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 120000)
const outputDirectory = join(tmpdir(), `videorc-preview-pump-diagnostics-${Date.now()}`)
mkdirSync(outputDirectory, { recursive: true })

const launched = await launchDevApp({
  requiredMarkers: ['backend-ready', 'preview-motion-ready'],
  timeoutMs,
  env: {
    VIDEORC_SMOKE_OUTPUT_DIR: outputDirectory,
    VIDEORC_SMOKE_PRINT_BACKEND_READY: '1',
    VIDEORC_SMOKE_COMMAND_SERVER: '1',
    VIDEORC_SMOKE_PREVIEW_MOTION: '1',
    VIDEORC_NATIVE_PREVIEW_SURFACE: '1'
  }
})

try {
  const smoke = launched.connections['preview-motion-ready']
  await smokeCommand(smoke, 'open-tab', {
    tab: 'studio',
    waitFor: '[data-videorc-preview-card]'
  })
  await smokeCommand(smoke, 'preview-window-open')
  await waitForSurfaceLive(smoke)

  const sceneRevision = 7878
  const frameSceneRevision = 7877
  const status = await smokeCommand(smoke, 'exercise-main-present-scene-mismatch', {
    sceneRevision,
    frameSceneRevision
  })

  if ((status.nativePreviewMainSceneMismatchCount ?? 0) < 2) {
    throw new Error(`Mismatch count was not recorded: ${JSON.stringify(status)}`)
  }
  if ((status.nativePreviewMainSceneMismatchAgeMs ?? 0) < 250) {
    throw new Error(
      `Mismatch age was not recorded past the message budget: ${JSON.stringify(status)}`
    )
  }
  if (status.nativePreviewMainLastSkippedSceneRevision !== sceneRevision) {
    throw new Error(
      `Last skipped scene revision ${status.nativePreviewMainLastSkippedSceneRevision} did not match ${sceneRevision}.`
    )
  }
  if (status.nativePreviewMainLastSkippedFrameSceneRevision !== frameSceneRevision) {
    throw new Error(
      `Last skipped frame scene revision ${status.nativePreviewMainLastSkippedFrameSceneRevision} did not match ${frameSceneRevision}.`
    )
  }
  if (!String(status.message ?? '').includes(`render scene revision ${sceneRevision}`)) {
    throw new Error(`Mismatch wait message was not surfaced: ${JSON.stringify(status)}`)
  }

  console.log(
    `Preview pump diagnostics smoke OK - mismatch ${frameSceneRevision}->${sceneRevision} reported after ${status.nativePreviewMainSceneMismatchAgeMs}ms.`
  )
} finally {
  await launched.stop()
}

async function waitForSurfaceLive(smoke) {
  let last = null
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    last = await smokeCommand(smoke, 'native-preview-surface-status')
    if (last.state === 'live' && last.bounds?.width > 0 && last.bounds?.height > 0) {
      return last
    }
    await sleep(100)
  }
  throw new Error(
    `Timed out waiting for live preview surface. Last status: ${JSON.stringify(last)}`
  )
}

function smokeCommand(smoke, command, params = {}) {
  const body = JSON.stringify({ command, params })
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: smoke.host,
        port: smoke.port,
        path: '/command',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          authorization: `Bearer ${smoke.capability}`
        },
        timeout: timeoutMs
      },
      (res) => {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          data += chunk
        })
        res.on('end', () => {
          try {
            const payload = JSON.parse(data)
            if (res.statusCode !== 200 || payload.error) {
              reject(
                new Error(
                  `Smoke command ${command} failed (${res.statusCode}): ${payload.error ?? data}`
                )
              )
              return
            }
            resolve(payload.result ?? payload)
          } catch (error) {
            reject(error)
          }
        })
      }
    )
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
