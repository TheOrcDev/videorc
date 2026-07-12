#!/usr/bin/env node
// Preview click/focus smoke: clicking or focusing the detached preview must not
// stop presentation, close surfaces, or strand scene updates.

import { request as httpRequest } from 'node:http'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { launchDevApp } from './lib/app-launcher.mjs'

const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 120000)
const outputDirectory = join(tmpdir(), `videorc-preview-click-focus-${Date.now()}`)
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

  const result = await smokeCommand(smoke, 'exercise-preview-click-focus')
  if (!result.previewWindowOpen) {
    throw new Error(`Preview window closed during click/focus exercise: ${JSON.stringify(result)}`)
  }
  if (!result.previewClicked) {
    throw new Error(`Preview window click was not delivered: ${JSON.stringify(result)}`)
  }
  if (!Array.isArray(result.steps) || result.steps.length < 7) {
    throw new Error(`Click/focus exercise did not report every step: ${JSON.stringify(result)}`)
  }
  for (const step of result.steps) {
    if (step.previewWindowOpen !== true || step.state !== 'live') {
      throw new Error(`Preview did not stay live during ${step.label}: ${JSON.stringify(result)}`)
    }
    if ((step.afterFrames ?? 0) <= (step.beforeFrames ?? 0)) {
      throw new Error(`Frames did not advance during ${step.label}: ${JSON.stringify(result)}`)
    }
  }

  console.log(
    `Preview click/focus smoke OK - ${result.steps.length} focus/click/move clusters advanced frames to ${result.status?.framesRendered ?? 'n/a'}.`
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
