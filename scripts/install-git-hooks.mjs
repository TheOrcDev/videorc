#!/usr/bin/env node
// Plan 242 S20: points git at .githooks (the pre-push check) when `pnpm
// install` runs in a git checkout. Never fails the install: in CI, outside a
// work tree, or when core.hooksPath already points elsewhere, it does nothing.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
}

try {
  if (process.env.CI) process.exit(0)
  const root = git(['rev-parse', '--show-toplevel'])
  if (!existsSync(join(root, '.githooks/pre-push'))) process.exit(0)
  let current = ''
  try {
    current = git(['config', '--get', 'core.hooksPath'])
  } catch {
    // Unset.
  }
  if (current && current !== '.githooks') {
    console.log(`install-git-hooks: core.hooksPath is ${current}; leaving it alone.`)
    process.exit(0)
  }
  if (!current) git(['config', 'core.hooksPath', '.githooks'])
} catch {
  // Not a git checkout (an export, a tarball): nothing to install.
}
