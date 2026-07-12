#!/usr/bin/env node

import { spawn } from 'node:child_process'

import {
  assertRequiredPlatform,
  commandNeedsShell,
  createRunEnvironment,
  parseRunWithEnvArgs
} from './lib/run-with-env.mjs'

try {
  const config = parseRunWithEnvArgs(process.argv.slice(2))
  assertRequiredPlatform(config.requiredPlatform)
  const child = spawn(config.command, config.commandArgs, {
    env: createRunEnvironment(config),
    shell: commandNeedsShell(config.command),
    stdio: 'inherit'
  })

  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code !== null) {
        resolve(code)
      } else {
        console.error(`run-with-env: command terminated by ${signal ?? 'an unknown signal'}`)
        resolve(1)
      }
    })
  })
} catch (error) {
  console.error(`run-with-env: ${error?.message ?? error}`)
  process.exitCode = 1
}
