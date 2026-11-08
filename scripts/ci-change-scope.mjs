#!/usr/bin/env node
import { appendFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

import {
  classifyChangeScope,
  isBlankGitSha,
  scopeToActionOutputs
} from './lib/ci-change-scope.mjs'

function git(args, { cwd, allowFailure = false } = {}) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (error) {
    if (allowFailure) return ''
    throw error
  }
}

function changedFiles({ range, cwd }) {
  const output = git(['diff', '--name-only', '--no-renames', '-z', range], { cwd })
  return output.split('\0').filter(Boolean)
}

function readJsonAt(ref, path, cwd) {
  const raw = git(['show', `${ref}:${path}`], { cwd, allowFailure: true }).trim()
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export function classifyRepositoryChangeScope({
  env = process.env,
  cwd = process.cwd(),
  gitChangedFiles = changedFiles,
  readJson = readJsonAt
} = {}) {
  const eventName = String(env.GITHUB_EVENT_NAME ?? '').trim()
  const base = String(env.CI_BASE_SHA ?? '').trim()
  const head = String(env.CI_HEAD_SHA ?? env.GITHUB_SHA ?? '').trim()
  if (isBlankGitSha(base) || isBlankGitSha(head)) {
    return classifyChangeScope({ eventName: 'workflow_dispatch', files: [] })
  }

  // Push uses two-dot so a merge commit cannot hide a deleted code path.
  // Pull requests use three-dot against the target merge-base.
  const range = eventName === 'push' ? `${base}..${head}` : `${base}...${head}`
  const files = gitChangedFiles({ range, cwd })
  const packageJsonTouched = files.includes('apps/desktop/package.json')
  return classifyChangeScope({
    eventName,
    files,
    packageJsonBefore: packageJsonTouched ? readJson(base, 'apps/desktop/package.json', cwd) : null,
    packageJsonAfter: packageJsonTouched ? readJson(head, 'apps/desktop/package.json', cwd) : null
  })
}

export async function main({
  env = process.env,
  cwd = process.cwd(),
  output = console,
  classify = classifyRepositoryChangeScope
} = {}) {
  const scope = classify({ env, cwd })
  const actionOutputs = scopeToActionOutputs(scope)
  output.log(
    `ci-change-scope: ${scope.kind} (windows_heavy=${actionOutputs.windows_heavy} linux_heavy=${actionOutputs.linux_heavy} macos_rust=${actionOutputs.macos_rust} js=${actionOutputs.js})`
  )
  if (env.GITHUB_OUTPUT) {
    await appendFile(
      env.GITHUB_OUTPUT,
      Object.entries(actionOutputs)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n') + '\n'
    )
  }
  return scope
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`ci-change-scope: ${error.message}`)
    process.exitCode = 1
  })
}
