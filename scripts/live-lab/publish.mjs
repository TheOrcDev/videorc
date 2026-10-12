#!/usr/bin/env node
// Plan 178 U10 step 2. Publish finished live-lab runs from the lab machine.
//
//   pnpm live:publish [--run <runDir>] [--since <iso>] [--dry-run]
//        [--issues-repo <owner/name>]
//
// For each run folder with a verdict.json and no complete published.json:
// guard (U9 redact.mjs + publish-guard, fail closed) -> reports repo (from
// the policy's killSwitchUrl) under runs/<runId>/ -> one issue per incident
// signature in TheOrcDev/videorc (label live-lab) -> Discord on P0 -> report
// link in the VOD description (lab project, 51 units) -> published.json.
// Boot doctor FAILs (U11) become `doctor:<check>` issues. The schedule's
// report slot runs `publish.mjs --since <iso>`. --dry-run prints every action
// and makes no network call. Exit 0 when everything published, 1 otherwise.

import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { labDir, readConfig, workDir } from './lib/config.mjs'
import { postDiscord, webhookUrlFrom } from './lib/discord.mjs'
import { ISSUES_REPO } from './lib/issues.mjs'
import { createAccessTokenSource } from './lib/oauth.mjs'
import { loadPolicy } from './lib/policy.mjs'
import { createPublishContext, publishAll } from './lib/publish.mjs'
import { loadRedactor } from './lib/publish-guard.mjs'
import { DEFAULT_MAX_UNITS_PER_DAY, createQuotaLedger } from './lib/quota-ledger.mjs'
import { createYoutubeClient } from './lib/youtube-api.mjs'

const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+$/

/** `gh` with stdin for bodies and API payloads. Resolves { code, stdout, stderr }. */
function gh(args, { input } = {}) {
  return new Promise((done) => {
    let stdout = ''
    let stderr = ''
    const child = spawn('gh', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('error', (error) => done({ code: null, stdout, stderr: `gh: ${error.message}` }))
    child.on('close', (code) => done({ code, stdout, stderr }))
    child.stdin.on('error', () => {})
    child.stdin.end(input ?? '')
  })
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    options: {
      run: { type: 'string' },
      since: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'issues-repo': { type: 'string', default: ISSUES_REPO }
    },
    strict: true,
    allowPositionals: false
  })
  if (!REPO_RE.test(values['issues-repo'])) throw new Error('--issues-repo must be owner/name')
  if (values.since !== undefined && !Number.isFinite(Date.parse(values.since))) {
    throw new Error('--since must be an ISO time')
  }
  const dryRun = values['dry-run']
  let redactor = await loadRedactor()
  if (!redactor) {
    console.error(
      'live:publish: REDACTION_UNAVAILABLE (scripts/live-lab/lib/redact.mjs is missing); nothing is published without it'
    )
    if (!dryRun) return 1
    // A dry run sends nothing, so it may preview with the local guard alone.
    console.error('live:publish: dry run continues with the local guard only')
    redactor = { assertPublishable: () => {}, findSensitive: () => [] }
  }
  const { policy, problems } = await loadPolicy()
  const lab = labDir()
  const config = await readConfig(lab).catch(() => null)
  let webhookUrl = null
  try {
    webhookUrl = webhookUrlFrom(config)
  } catch (error) {
    console.error(`live:publish: Discord webhook ignored: ${error.message}`)
  }
  const youtube = async () => {
    if (!config) throw new Error('no lab config (run pnpm live:hookup)')
    const cap = policy?.quota.labProjectMaxUnitsPerDay
    const ledger = createQuotaLedger({
      dir: lab,
      maxUnitsPerDay: cap > 0 ? cap : DEFAULT_MAX_UNITS_PER_DAY
    })
    const client = createYoutubeClient({ getToken: createAccessTokenSource({ config }), ledger })
    return { client, ledger, channelId: config.roles?.broadcaster?.channelId ?? null }
  }
  const ctx = createPublishContext({
    gh: dryRun
      ? () => {
          throw new Error('dry run: no gh calls')
        }
      : gh,
    redactor,
    policy,
    policyProblems: problems,
    issuesRepo: values['issues-repo'],
    webhookUrl,
    postDiscord: dryRun ? null : postDiscord,
    youtube: dryRun ? null : youtube,
    dryRun
  })
  return publishAll(ctx, {
    workDir: workDir(),
    run: values.run ? resolve(values.run) : null,
    since: values.since ?? null
  })
}

try {
  process.exitCode = await main()
} catch (error) {
  console.error(`live:publish failed: ${error.message}`)
  process.exitCode = 1
}
