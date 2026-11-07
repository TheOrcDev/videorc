#!/usr/bin/env node
// pnpm release:web:check     PASS only when www.videorc.com serves the GitHub
//                            build of videorc-web main.
// pnpm release:web:redeploy  Rebuild production from that GitHub build, so a
//                            changed production env var takes effect, then
//                            run the check. `-- --dry-run` names the build
//                            and stops.
//
// Never `vercel deploy --prod` (or `vercel --prod`) from a local videorc-web
// checkout: it ships whatever that checkout holds. See
// scripts/lib/web-production-deploy.mjs for the incident that made this rule.

import { execFile, spawn } from 'node:child_process'
import { parseArgs, promisify } from 'node:util'

import {
  deploymentCommitSha,
  evaluateWebProduction,
  formatWebProductionReport,
  pickRedeploySource,
  resolveBuildOrigin,
  shortSha,
  WEB_PRODUCTION
} from './lib/web-production-deploy.mjs'

const run = promisify(execFile)

async function readJson(command, args) {
  const { stdout } = await run(command, args, { maxBuffer: 64 * 1024 * 1024 })
  return JSON.parse(stdout)
}

function vercelApi(path) {
  return readJson('vercel', ['api', path, '--scope', WEB_PRODUCTION.vercelScope, '--raw'])
}

async function mainSha() {
  const { stdout } = await run('gh', [
    'api',
    `repos/${WEB_PRODUCTION.repo}/commits/${WEB_PRODUCTION.branch}`,
    '--jq',
    '.sha'
  ])
  const sha = stdout.trim()
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`GitHub returned no ${WEB_PRODUCTION.branch} sha for ${WEB_PRODUCTION.repo}.`)
  }
  return sha
}

async function mainCommitsMissingFrom(productionSha, sha) {
  if (!productionSha || productionSha === sha) {
    return productionSha ? 0 : null
  }
  try {
    const { stdout } = await run('gh', [
      'api',
      `repos/${WEB_PRODUCTION.repo}/compare/${productionSha}...${sha}`,
      '--jq',
      '.ahead_by'
    ])
    const aheadBy = Number(stdout.trim())
    return Number.isInteger(aheadBy) ? aheadBy : null
  } catch {
    return null
  }
}

async function checkProduction() {
  const sha = await mainSha()
  const production = await vercelApi(`/v13/deployments/${WEB_PRODUCTION.host}`)
  const buildOrigin = await resolveBuildOrigin(production, (id) =>
    vercelApi(`/v13/deployments/${id}`)
  )
  const aheadBy = await mainCommitsMissingFrom(deploymentCommitSha(production), sha)
  return evaluateWebProduction({ production, buildOrigin, mainSha: sha, aheadBy })
}

function redeploy(deploymentId) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'vercel',
      [
        'redeploy',
        deploymentId,
        '--environment',
        'production',
        '--scope',
        WEB_PRODUCTION.vercelScope
      ],
      { stdio: 'inherit' }
    )
    child.on('error', reject)
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`vercel redeploy exited with ${code}`))
    )
  })
}

async function main() {
  const { positionals, values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    allowPositionals: true,
    options: { 'dry-run': { type: 'boolean', default: false } }
  })
  const command = positionals[0]

  if (command === 'check') {
    const result = await checkProduction()
    console.log(formatWebProductionReport(result))
    process.exit(result.ok ? 0 : 1)
  }

  if (command !== 'redeploy') {
    console.error('usage: release-web-production.mjs check | redeploy [--dry-run]')
    process.exit(2)
  }

  const sha = await mainSha()
  const { deployments } = await vercelApi(
    `/v6/deployments?projectId=${WEB_PRODUCTION.vercelProject}&target=production&limit=100`
  )
  const source = pickRedeploySource(deployments, sha)
  if (!source) {
    console.error(
      [
        'web-production-redeploy: FAIL',
        `problem: no READY GitHub build of ${WEB_PRODUCTION.repo} ${WEB_PRODUCTION.branch} ${shortSha(sha)} among the last ${deployments?.length ?? 0} production deployments`,
        "fix: wait for (or fix) Vercel's git deployment of main, then rerun. Never deploy a local checkout."
      ].join('\n')
    )
    process.exit(1)
  }

  const before = await vercelApi(`/v13/deployments/${WEB_PRODUCTION.host}`)
  console.log(`web-production-redeploy: source ${source.uid} (git ${shortSha(sha)})`)
  console.log(
    `web-production-redeploy: replacing ${before?.id ?? 'none'} (${shortSha(deploymentCommitSha(before))})`
  )
  if (values['dry-run']) {
    console.log(
      `web-production-redeploy: dry run, would run vercel redeploy ${source.uid} --environment production --scope ${WEB_PRODUCTION.vercelScope}`
    )
    return
  }

  await redeploy(source.uid)

  const result = await checkProduction()
  if (result.ok && result.productionId === before?.id) {
    result.ok = false
    result.problems.push(
      `${WEB_PRODUCTION.host} still serves ${before.id}; the redeploy did not take the alias, so new env values are not live`
    )
  }
  console.log(formatWebProductionReport(result))
  process.exit(result.ok ? 0 : 1)
}

main().catch((error) => {
  console.error(`web-production: FAIL (${error instanceof Error ? error.message : String(error)})`)
  process.exit(1)
})
