#!/usr/bin/env node

// Long-recording companion to the idle capture-decay soak. It deliberately
// delegates to the maintained single-generation session-decay smoke so final
// accounting plus ffprobe/ffmpeg artifact analysis — not file size — remains
// the authoritative verdict. `--release-gate` locks every duration, profile,
// sampling, and surface threshold; use the investigation/endurance package
// commands when intentionally overriding them.

import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

import { LONG_RECORDING_RELEASE_ENV, longRecordingGateConfig } from './lib/capture-decay-soak.mjs'

const config = longRecordingGateConfig({ env: process.env, argv: process.argv.slice(2) })
if (config.releaseGate) {
  assertReleaseChildEnvironment(config.childEnvironment)
}
const scriptPath = resolve(import.meta.dirname, 'smoke-recording-session-decay.mjs')
const child = spawn(process.execPath, [scriptPath], {
  env: config.childEnvironment,
  stdio: 'inherit'
})

console.log(
  `[capture-decay-long-recording] running one ${(config.recordingMs / 60_000).toFixed(2)}m analyzed recording${config.endurance ? ' (endurance)' : ''}`
)

const signalHandlers = new Map(
  ['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) => [signal, () => child.kill(signal)])
)
for (const [signal, handler] of signalHandlers) process.on(signal, handler)

process.exitCode = await new Promise((resolveExit, reject) => {
  child.once('error', reject)
  child.once('exit', (code, signal) => {
    if (code !== null) resolveExit(code)
    else if (signal === 'SIGINT') resolveExit(130)
    else if (signal === 'SIGTERM') resolveExit(143)
    else resolveExit(1)
  })
})

for (const [signal, handler] of signalHandlers) process.off(signal, handler)

function assertReleaseChildEnvironment(environment) {
  for (const [name, expected] of Object.entries(LONG_RECORDING_RELEASE_ENV)) {
    if (environment[name] !== expected) {
      throw new Error(
        `long-recording release child environment lost ${name}=${expected} (received ${environment[name] ?? 'unset'})`
      )
    }
  }
}
