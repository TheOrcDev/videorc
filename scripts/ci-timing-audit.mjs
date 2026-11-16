#!/usr/bin/env node
// Plan 242 S0: pull the last N runs of each CI workflow and split every job
// into waiting, setup and running time at p50 and p95.
//
//   pnpm ci:audit                 # last 150 runs of ci.yml, windows.yml, linux.yml
//   pnpm ci:audit -- --runs 50 --json out.json
//
// Needs GH_TOKEN / GITHUB_TOKEN, or a logged-in `gh`.
import { execFileSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

import {
  blacksmithMonthlyCost,
  bucketJob,
  monthlyMinutesByOs,
  percentile,
  runWallSeconds,
  summarizeJobs
} from './lib/ci-timing-audit.mjs'

const WORKFLOWS = ['ci.yml', 'windows.yml', 'linux.yml']

function token(env) {
  if (env.GH_TOKEN || env.GITHUB_TOKEN) return env.GH_TOKEN || env.GITHUB_TOKEN
  return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim()
}

function repository(env) {
  if (env.GITHUB_REPOSITORY) return env.GITHUB_REPOSITORY
  return execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], {
    encoding: 'utf8'
  }).trim()
}

async function api(path, auth) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${auth}`,
      'X-GitHub-Api-Version': '2022-11-28'
    }
  })
  if (!response.ok) throw new Error(`GitHub GET ${path} failed (${response.status})`)
  return response.json()
}

async function listRuns(repo, workflow, count, auth) {
  const runs = []
  for (let page = 1; runs.length < count && page <= 20; page++) {
    const body = await api(
      `/repos/${repo}/actions/workflows/${workflow}/runs?status=completed&per_page=100&page=${page}`,
      auth
    )
    if (!body.workflow_runs?.length) break
    runs.push(...body.workflow_runs)
  }
  return runs.slice(0, count)
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++
        results[index] = await fn(items[index])
      }
    })
  )
  return results
}

function fmt(secondsValue) {
  if (secondsValue === null || secondsValue === undefined) return '-'
  if (secondsValue < 90) return `${Math.round(secondsValue)}s`
  return `${(secondsValue / 60).toFixed(1)}m`
}

export async function main({ argv = process.argv, env = process.env, output = console } = {}) {
  const runsIndex = argv.indexOf('--runs')
  const count = runsIndex >= 0 ? Number(argv[runsIndex + 1]) : 150
  const jsonIndex = argv.indexOf('--json')
  const jsonPath = jsonIndex >= 0 ? argv[jsonIndex + 1] : null
  const auth = token(env)
  const repo = repository(env)

  const entries = []
  const walls = []
  let oldest = Infinity
  let newest = -Infinity
  for (const workflow of WORKFLOWS) {
    const runs = await listRuns(repo, workflow, count, auth)
    const jobLists = await mapLimit(runs, 8, (run) =>
      api(`/repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`, auth).then((b) => b.jobs ?? [])
    )
    runs.forEach((run, index) => {
      const created = Date.parse(run.created_at)
      oldest = Math.min(oldest, created)
      newest = Math.max(newest, created)
      const jobs = jobLists[index]
      for (const job of jobs) entries.push({ workflow, bucket: bucketJob(job) })
      // "Full" runs are the ones where a heavy job really ran (> 10 min).
      const heavy = jobs.some((job) => {
        const bucket = bucketJob(job)
        return bucket && bucket.total > 600
      })
      walls.push({
        workflow,
        event: run.event,
        heavy,
        wall: runWallSeconds(run, jobs),
        conclusion: run.conclusion
      })
    })
  }

  const windowDays = (newest - oldest) / 86_400_000
  const summary = summarizeJobs(entries)
  const minutes = monthlyMinutesByOs(
    entries.map((entry) => entry.bucket),
    windowDays
  )

  output.log(`Sampled ${entries.length} job records over ${windowDays.toFixed(1)} days (${repo}).`)
  output.log('')
  output.log('job | n | waiting p50/p95 | setup p50/p95 | running p50/p95 | total p50/p95')
  for (const row of summary) {
    output.log(
      `${row.key} | ${row.count} | ${fmt(row.waiting.p50)}/${fmt(row.waiting.p95)} | ${fmt(row.setup.p50)}/${fmt(row.setup.p95)} | ${fmt(row.running.p50)}/${fmt(row.running.p95)} | ${fmt(row.total.p50)}/${fmt(row.total.p95)}`
    )
  }
  output.log('')
  for (const workflow of WORKFLOWS) {
    for (const event of ['pull_request', 'push']) {
      const sample = walls
        .filter((w) => w.workflow === workflow && w.event === event && w.heavy)
        .map((w) => w.wall)
      if (sample.length === 0) continue
      output.log(
        `${workflow} ${event} full runs: n=${sample.length} wall p50 ${fmt(percentile(sample, 50))}, p95 ${fmt(percentile(sample, 95))}`
      )
    }
  }
  output.log('')
  output.log(
    `Runner minutes per 30 days: linux ${minutes.linux}, windows ${minutes.windows}, macos ${minutes.macos}.`
  )
  output.log(
    `GitHub-hosted cost: $0 (public repository). Same minutes on Blacksmith: about $${blacksmithMonthlyCost(minutes)}/month at list price.`
  )

  if (jsonPath) {
    await writeFile(
      jsonPath,
      `${JSON.stringify({ repo, windowDays, summary, walls, minutes }, null, 2)}\n`
    )
  }
  return { summary, walls, minutes, windowDays }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`ci-timing-audit: ${error.message}`)
    process.exitCode = 1
  })
}
