#!/usr/bin/env node

import { copyFileSync, mkdirSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  nativePreviewAddonArtifact,
  nativePreviewAddonUniversalPlan
} from './lib/native-preview-addon-build.mjs'

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const release = process.argv.includes('--release')
const universal = process.argv.includes('--universal')
const profile = release ? 'release' : 'debug'
if (universal && !release) {
  throw new Error('Universal native preview addons must use --release.')
}

if (universal) {
  const plan = nativePreviewAddonUniversalPlan({
    platform: process.platform,
    profile,
    workspaceRoot
  })
  if (!plan) {
    console.log(`Native preview addon is not built on ${process.platform}.`)
    process.exit(0)
  }
  for (const target of plan.targets) {
    run('cargo', [
      'build',
      '-p',
      'videorc-native-preview-addon',
      '--release',
      '--target',
      target.rustTarget
    ])
  }
  mkdirSync(dirname(plan.destination), { recursive: true })
  run('lipo', ['-create', ...plan.targets.map((target) => target.source), '-output', plan.destination])
  const bytes = statSync(plan.destination).size
  console.log(`Universal native preview addon ready: ${plan.destination} (${bytes} bytes).`)
  process.exit(0)
}

const artifact = nativePreviewAddonArtifact({
  platform: process.platform,
  profile,
  workspaceRoot
})

if (!artifact) {
  console.log(`Native preview addon is not built on ${process.platform}.`)
  process.exit(0)
}

run('cargo', ['build', '-p', 'videorc-native-preview-addon', ...(release ? ['--release'] : [])])

copyFileSync(artifact.source, artifact.destination)
const bytes = statSync(artifact.destination).size
console.log(`Native preview addon ready: ${artifact.destination} (${bytes} bytes).`)

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: workspaceRoot,
    encoding: 'utf8',
    stdio: 'inherit'
  })
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}
