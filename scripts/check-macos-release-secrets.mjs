#!/usr/bin/env node

import { spawnSync } from 'node:child_process'

import {
  evaluateMacosReleaseGithubSecrets,
  formatMacosReleaseGithubSecretsReport
} from './lib/github-release-secrets.mjs'

const repo = process.env.VIDEORC_RELEASE_GITHUB_REPO ?? 'TheOrcDev/videorc'

const command = spawnSync('gh', ['secret', 'list', '--repo', repo, '--json', 'name'], {
  encoding: 'utf8'
})

if (command.error) {
  console.error(`macos-release-github-secrets: FAIL (${command.error.message})`)
  process.exit(1)
}

if (command.status !== 0) {
  const message = command.stderr.trim() || `gh exited with status ${command.status}`
  console.error(`macos-release-github-secrets: FAIL (${message})`)
  process.exit(1)
}

let secrets
try {
  secrets = JSON.parse(command.stdout)
} catch {
  console.error('macos-release-github-secrets: FAIL (could not parse gh secret list JSON)')
  process.exit(1)
}

const presentSecretNames = Array.isArray(secrets)
  ? secrets.map((secret) => secret?.name).filter(Boolean)
  : []
const result = evaluateMacosReleaseGithubSecrets({ presentSecretNames })
console.log(formatMacosReleaseGithubSecretsReport(result, { repo }))
process.exit(result.ok ? 0 : 1)
