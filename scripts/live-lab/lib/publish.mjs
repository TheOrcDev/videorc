import { createHash, randomBytes } from 'node:crypto'
import { chmod, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'

import { buildP0Message, p0Incidents } from './discord.mjs'
import {
  ISSUES_REPO,
  doctorCommentBody,
  doctorIssueBody,
  doctorSignature,
  ensureLabel,
  fileSignature,
  incidentCommentBody,
  incidentIssueBody,
  isValidSignature,
  issueTitle,
  listOpenLabIssues,
  parseDoctorFails,
  safeEvidence
} from './issues.mjs'
import { reportsRepoFromKillSwitchUrl } from './policy.mjs'
import { PublishRefused, guardFiles, guardText } from './publish-guard.mjs'
import { QuotaRefused } from './quota-ledger.mjs'

// Plan 178 U10 step 2 (plan 166 S8 step 3). `pnpm live:publish` takes every
// finished run folder (verdict.json, no complete published.json) and, in
// this order, stopping at the first step that fails:
//   1. guard: U9's assertPublishable AND publish-guard's own patterns on every
//      file to publish (fail closed: nothing of the run leaves otherwise)
//   2. push report.md, verdict.json, charts/*.png, frames/*.png to the reports
//      repo behind the policy's killSwitchUrl, under runs/<runId>/, with the
//      contents API (`gh api ... --method PUT`, base64, sha for updates)
//   3. one issue per incident signature in TheOrcDev/videorc (comment on the
//      open `live-lab` issue with that signature, else open one)
//   4. Discord ping when any incident is P0
//   5. the report link in the YouTube VOD description (lab project,
//      videos.list 1 + videos.update 50 units; skipped when the ledger says no)
//   6. published.json (0600) with what was done
// published.json is written after every step with `complete: false`, so a
// publish that dies half way resumes without opening a second issue.
// Boot doctor FAILs (U11, <work dir>/doctor/boot-*.txt) become one issue per
// `doctor:<check>` signature each, with a sidecar marking the file done.
// --dry-run prints every action and makes no network call and no write.

export const PUBLISHED_FILE = 'published.json'
export const PUBLISH_SCHEMA = 1
export const VOD_QUOTA_UNITS = 51
const RUN_ID_RE = /^\d{4}-\d{2}-\d{2}-[a-z0-9-]+-[0-9a-f]{6}$/
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/
const DOCTOR_FILE_RE = /^boot-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.txt$/
const MAX_DESCRIPTION_BYTES = 5000

/** Atomic 0600 JSON write (temp file in the same dir, fsync, rename). */
export async function writePrivateJson(path, value) {
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`
  const handle = await open(temp, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await handle.sync()
  } catch (error) {
    await handle.close()
    await rm(temp, { force: true })
    throw error
  }
  await handle.close()
  await chmod(temp, 0o600)
  await rename(temp, path)
}

async function readJsonOrNull(path) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  return JSON.parse(text)
}

function sinceMs(since) {
  if (since === null || since === undefined) return null
  const ms = Date.parse(since)
  if (!Number.isFinite(ms)) throw new Error(`--since is not an ISO time: ${since}`)
  return ms
}

/** Pure: the time a verdict counts from for --since (end, else start). */
export function verdictTime(verdict) {
  const ms = Date.parse(verdict?.endedAt ?? verdict?.startedAt ?? '')
  return Number.isFinite(ms) ? ms : null
}

/**
 * Run folders to publish: a verdict.json, and no published.json or one with
 * `complete: false`. With `since`, only verdicts that ended (or started) at
 * or after it. Resolves { runs: [{ runDir, runId, verdict, previous }], warnings }.
 */
export async function findRunsToPublish({ runsDir, since = null, only = null }) {
  const cutoff = sinceMs(since)
  const warnings = []
  let names
  if (only) {
    names = [basename(only)]
    runsDir = dirname(only)
  } else {
    try {
      names = (await readdir(runsDir)).sort()
    } catch (error) {
      if (error.code === 'ENOENT') return { runs: [], warnings }
      throw error
    }
  }
  const runs = []
  for (const name of names) {
    if (!RUN_ID_RE.test(name)) {
      if (only) warnings.push(`${name}: not a run folder name`)
      continue
    }
    const runDir = join(runsDir, name)
    let verdict
    try {
      verdict = await readJsonOrNull(join(runDir, 'verdict.json'))
    } catch {
      warnings.push(`${name}: verdict.json is not valid JSON`)
      continue
    }
    if (!verdict) {
      if (only) warnings.push(`${name}: no verdict.json yet`)
      continue
    }
    if (verdict.schema !== 1 || verdict.runId !== name) {
      warnings.push(`${name}: verdict.json is not schema 1 for this run`)
      continue
    }
    let previous = null
    try {
      previous = await readJsonOrNull(join(runDir, PUBLISHED_FILE))
    } catch {
      warnings.push(`${name}: published.json is unreadable; publishing again`)
    }
    if (previous?.complete === true) continue
    if (cutoff !== null && !only) {
      const at = verdictTime(verdict)
      if (at === null || at < cutoff) continue
    }
    runs.push({ runDir, runId: name, verdict, previous })
  }
  return { runs, warnings }
}

/** The files of a run that are published: [{ path, rel }]. Other files never leave. */
export async function collectRunFiles(runDir) {
  const files = []
  for (const rel of ['report.md', 'verdict.json']) {
    try {
      if ((await stat(join(runDir, rel))).isFile()) files.push({ path: join(runDir, rel), rel })
    } catch {
      // report.md is optional for an early refusal; verdict.json was read already.
    }
  }
  for (const dir of ['charts', 'frames']) {
    let names = []
    try {
      names = await readdir(join(runDir, dir), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of names.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isFile() && extname(entry.name).toLowerCase() === '.png') {
        files.push({ path: join(runDir, dir, entry.name), rel: `${dir}/${entry.name}` })
      }
    }
  }
  return files
}

function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/')
}

/** Pure: the GitHub blob URL of a published run file. */
export function reportFileUrl(target, runId, rel) {
  return `https://github.com/${target.owner}/${target.repo}/blob/${encodeURIComponent(target.ref)}/runs/${runId}/${encodePath(rel)}`
}

/** Pure: git's blob sha1 of `content`, as the contents API reports it. */
export function gitBlobSha(content) {
  return createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex')
}

/**
 * Creates or updates one file in the reports repo through the contents API.
 * Resolves { path, sha, action: 'created' | 'updated' | 'unchanged' }.
 */
export async function pushFile({ gh, target, repoPath, content, message }) {
  const api = `repos/${target.owner}/${target.repo}/contents/${encodePath(repoPath)}`
  const lookup = await gh(['api', `${api}?ref=${encodeURIComponent(target.ref)}`, '--jq', '.sha'])
  let existing = null
  if (lookup.code === 0) {
    existing = String(lookup.stdout ?? '').trim() || null
  } else if (!/\b404\b|Not Found/i.test(`${lookup.stderr ?? ''}${lookup.stdout ?? ''}`)) {
    throw new Error(`gh api contents lookup failed for ${repoPath} (exit ${lookup.code})`)
  }
  const sha = gitBlobSha(content)
  if (existing === sha) return { path: repoPath, sha, action: 'unchanged' }
  const body = {
    message,
    content: content.toString('base64'),
    branch: target.ref,
    ...(existing ? { sha: existing } : {})
  }
  const put = await gh(['api', '--method', 'PUT', api, '--input', '-'], {
    input: JSON.stringify(body)
  })
  if (put.code !== 0) {
    throw new Error(`gh api contents PUT failed for ${repoPath} (exit ${put.code})`)
  }
  return { path: repoPath, sha, action: existing ? 'updated' : 'created' }
}

/**
 * Adds `Automated test report: <url>` to the VOD's description. Resolves
 * { status: 'updated' | 'skipped', reason? }. Never throws for quota: a
 * refused charge is a skip.
 */
export async function updateVodDescription({ youtube, ledger, channelId, videoId, reportUrl }) {
  if (!VIDEO_ID_RE.test(String(videoId ?? ''))) return { status: 'skipped', reason: 'bad video id' }
  if (ledger && !ledger.canSpend(VOD_QUOTA_UNITS)) {
    return { status: 'skipped', reason: 'lab quota would be exceeded' }
  }
  const line = `Automated test report: ${reportUrl}`
  try {
    const listed = await youtube.call({
      role: 'broadcaster',
      method: 'videos.list',
      resource: 'videos',
      query: { part: 'snippet', id: videoId }
    })
    const item = listed?.items?.[0]
    if (!item?.snippet) return { status: 'skipped', reason: 'video not found' }
    if (channelId && item.snippet.channelId !== channelId) {
      return { status: 'skipped', reason: 'video is not on the lab channel' }
    }
    const current = String(item.snippet.description ?? '')
    if (current.includes(reportUrl)) return { status: 'skipped', reason: 'already linked' }
    const description = current.trim() ? `${current.trimEnd()}\n\n${line}` : line
    if (Buffer.byteLength(description, 'utf8') > MAX_DESCRIPTION_BYTES) {
      return { status: 'skipped', reason: 'description would be too long' }
    }
    const snippet = { title: item.snippet.title, description, categoryId: item.snippet.categoryId }
    for (const key of ['tags', 'defaultLanguage', 'defaultAudioLanguage']) {
      if (item.snippet[key] !== undefined) snippet[key] = item.snippet[key]
    }
    await youtube.call({
      role: 'broadcaster',
      method: 'videos.update',
      httpMethod: 'PUT',
      resource: 'videos',
      query: { part: 'snippet' },
      body: { id: videoId, snippet }
    })
    return { status: 'updated' }
  } catch (error) {
    if (error instanceof QuotaRefused || error?.code === 'QUOTA_REFUSED') {
      return { status: 'skipped', reason: 'lab quota refused' }
    }
    throw error
  }
}

function freshState(runId) {
  return {
    schema: PUBLISH_SCHEMA,
    runId,
    complete: false,
    startedAt: null,
    publishedAt: null,
    reportsRepo: null,
    files: [],
    issues: {},
    discord: null,
    vod: null,
    warnings: []
  }
}

function indent(text) {
  return String(text)
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n')
}

/**
 * The shared context of one publish invocation: `gh`, the redactor, the
 * issues repo, the policy's reports repo, a lazy open-issue list and label,
 * Discord, YouTube. Built by publish.mjs (or a test).
 */
export function createPublishContext({
  gh,
  redactor,
  policy = null,
  policyProblems = [],
  issuesRepo = ISSUES_REPO,
  webhookUrl = null,
  postDiscord = null,
  youtube = null,
  now = () => new Date(),
  dryRun = false,
  print = (line) => console.log(line),
  printErr = (line) => console.error(line),
  writeJson = writePrivateJson
}) {
  let issues = null
  let labelReady = null
  const target = policy ? reportsRepoFromKillSwitchUrl(policy.killSwitchUrl) : null
  return {
    gh,
    redactor,
    issuesRepo,
    target,
    targetProblem: target
      ? null
      : policy
        ? 'the policy killSwitchUrl is not a raw.githubusercontent.com URL, so there is no reports repo'
        : `no valid policy (${policyProblems.join('; ') || 'missing'})`,
    webhookUrl,
    postDiscord,
    youtube,
    now,
    dryRun,
    print,
    printErr,
    writeJson,
    async openIssues() {
      if (issues === null) issues = await listOpenLabIssues({ gh, repo: issuesRepo })
      return issues
    },
    async labelOk() {
      if (labelReady === null) labelReady = await ensureLabel({ gh, repo: issuesRepo })
      return labelReady
    }
  }
}

async function guardedIssueTexts(ctx, signature, texts) {
  const out = {}
  for (const [key, text] of Object.entries(texts)) {
    out[key] = await guardText(text, `issue ${key} for ${signature}`, { redactor: ctx.redactor })
  }
  return out
}

/**
 * Publishes one run. Resolves { runId, status: 'published' | 'refused' |
 * 'failed' | 'dry-run', reason?, state }.
 */
export async function publishRun(ctx, { runDir, runId, verdict, previous }) {
  const { print } = ctx
  const state =
    previous && previous.complete === false
      ? { ...freshState(runId), ...previous }
      : freshState(runId)
  state.startedAt ??= ctx.now().toISOString()
  const prefix = ctx.dryRun ? `[dry-run] ${runId}:` : `${runId}:`
  const save = async () => {
    if (!ctx.dryRun) await ctx.writeJson(join(runDir, PUBLISHED_FILE), state)
  }

  // 1. Guard every file that would leave.
  const files = await collectRunFiles(runDir)
  try {
    await guardFiles(
      files.map((file) => file.path),
      { redactor: ctx.redactor, labels: new Map(files.map((file) => [file.path, file.rel])) }
    )
  } catch (error) {
    if (error instanceof PublishRefused) {
      ctx.printErr(`${prefix} ${error.code}: nothing of this run was published (${error.message})`)
      return { runId, status: 'refused', reason: error.message, state }
    }
    throw error
  }
  print(`${prefix} guard passed on ${files.length} file(s)`)

  const published = new Set(state.files.map((file) => `${file.path}@${file.sha}`))
  const links = {
    report: null,
    file: () => null
  }
  try {
    // 2. Reports repo.
    if (!ctx.target && !ctx.dryRun) throw new Error(`no reports repo: ${ctx.targetProblem}`)
    if (!ctx.target)
      print(`${prefix} a real publish would stop here: no reports repo (${ctx.targetProblem})`)
    // A dry run without a policy still shows the rest, with placeholder links.
    const target = ctx.target ?? {
      owner: 'reports-owner',
      repo: 'reports-repo',
      ref: 'main',
      name: 'reports-owner/reports-repo'
    }
    state.reportsRepo = `${target.name}@${target.ref}`
    const pushedRels = new Set()
    for (const file of files) {
      const repoPath = `runs/${runId}/${file.rel}`
      if (ctx.dryRun) {
        print(`${prefix} would push ${repoPath} to ${target.name}@${target.ref}`)
        pushedRels.add(file.rel)
        continue
      }
      const content = await readFile(file.path)
      const sha = gitBlobSha(content)
      if (published.has(`${repoPath}@${sha}`)) {
        pushedRels.add(file.rel)
        continue
      }
      const result = await pushFile({
        gh: ctx.gh,
        target,
        repoPath,
        content,
        message: `live-lab: ${runId} ${file.rel}`
      })
      state.files = state.files.filter((entry) => entry.path !== repoPath)
      state.files.push({ path: repoPath, sha: result.sha, action: result.action })
      pushedRels.add(file.rel)
      await save()
    }
    links.report = pushedRels.has('report.md')
      ? reportFileUrl(target, runId, 'report.md')
      : pushedRels.has('verdict.json')
        ? reportFileUrl(target, runId, 'verdict.json')
        : null
    links.file = (name) => (pushedRels.has(name) ? reportFileUrl(target, runId, name) : null)
    if (!ctx.dryRun) print(`${prefix} pushed ${files.length} file(s) to ${target.name}`)

    // 3. Issues, one per signature.
    const run = { ...verdict, runId }
    const incidents = Array.isArray(verdict.incidents) ? verdict.incidents : []
    for (const incident of incidents) {
      const signature = incident?.signature
      if (!isValidSignature(signature)) {
        state.warnings.push('skipped an incident with an invalid signature')
        print(`${prefix} skipped an incident with an invalid signature`)
        continue
      }
      if (state.issues[signature]) continue
      const cleaned = { ...incident, evidence: safeEvidence(incident.evidence) }
      const texts = await guardedIssueTexts(ctx, signature, {
        title: issueTitle(signature, cleaned.summary),
        body: incidentIssueBody({ incident: cleaned, run, links }),
        comment: incidentCommentBody({ incident: cleaned, run, links })
      })
      if (ctx.dryRun) {
        print(
          `${prefix} would look for an open live-lab issue with signature ${signature} in ${ctx.issuesRepo}; if found comment:\n${indent(texts.comment)}\n  else open "${texts.title}":\n${indent(texts.body)}`
        )
        continue
      }
      const result = await fileSignature({
        gh: ctx.gh,
        repo: ctx.issuesRepo,
        issues: await ctx.openIssues(),
        signature,
        ...texts,
        labelReady: () => ctx.labelOk()
      })
      state.issues[signature] = result
      print(`${prefix} ${result.action} issue #${result.number ?? '?'} for ${signature}`)
      await save()
    }

    // 4. Discord on P0.
    if (p0Incidents(verdict).length > 0 && !state.discord?.sent) {
      const issueLinks = new Map(
        Object.entries(state.issues)
          .filter(([, value]) => value?.url)
          .map(([signature, value]) => [signature, value.url])
      )
      const content = await guardText(
        buildP0Message(verdict, { reportUrl: links.report, issueLinks }),
        'discord message',
        { redactor: ctx.redactor }
      )
      if (ctx.dryRun) {
        print(
          `${prefix} would post to Discord${ctx.webhookUrl ? '' : ' (no webhook configured: it would be skipped)'}:\n${indent(content)}`
        )
      } else if (!ctx.webhookUrl || !ctx.postDiscord) {
        state.discord = { sent: false, reason: 'no webhook configured' }
        state.warnings.push('P0 not sent to Discord: no webhook configured')
        print(`${prefix} P0 not sent to Discord: no webhook configured`)
        await save()
      } else {
        await ctx.postDiscord({ webhookUrl: ctx.webhookUrl, content })
        state.discord = { sent: true, at: ctx.now().toISOString() }
        print(`${prefix} posted the P0 to Discord`)
        await save()
      }
    }

    // 5. VOD description.
    const videoId = verdict.vod?.videoId
    if (videoId && links.report && state.vod?.status !== 'updated') {
      await guardText(`Automated test report: ${links.report}`, 'vod description line', {
        redactor: ctx.redactor
      })
      if (ctx.dryRun) {
        print(
          `${prefix} would add the report link to the description of VOD ${videoId} (videos.list 1 + videos.update 50 lab units)`
        )
      } else if (!ctx.youtube) {
        state.vod = { status: 'skipped', reason: 'no lab YouTube client' }
        await save()
      } else {
        const { client, ledger, channelId } = await ctx.youtube()
        state.vod = {
          videoId,
          ...(await updateVodDescription({
            youtube: client,
            ledger,
            channelId,
            videoId,
            reportUrl: links.report
          }))
        }
        print(
          `${prefix} VOD description ${state.vod.status}${state.vod.reason ? ` (${state.vod.reason})` : ''}`
        )
        await save()
      }
    }
  } catch (error) {
    if (error instanceof PublishRefused) {
      ctx.printErr(`${prefix} ${error.code}: stopped (${error.message})`)
      await save()
      return { runId, status: 'refused', reason: error.message, state }
    }
    state.warnings = [...new Set([...state.warnings, `stopped: ${error.message}`])].slice(-20)
    await save()
    ctx.printErr(`${prefix} publish stopped: ${error.message}`)
    return { runId, status: 'failed', reason: error.message, state }
  }

  if (ctx.dryRun) {
    print(`${prefix} would write ${PUBLISHED_FILE} (0600)`)
    return { runId, status: 'dry-run', state }
  }
  state.complete = true
  state.publishedAt = ctx.now().toISOString()
  state.warnings = state.warnings.filter((warning) => !warning.startsWith('stopped: '))
  await save()
  print(`${prefix} published`)
  return { runId, status: 'published', state }
}

/** Pure: the ISO time of a boot doctor file name, or null. */
export function doctorFileTime(name) {
  const match = DOCTOR_FILE_RE.exec(name)
  if (!match) return null
  const [, day, hh, mm, ss, ms] = match
  return Date.parse(`${day}T${hh}:${mm}:${ss}.${ms}Z`)
}

export function doctorSidecar(path) {
  return path.replace(/\.txt$/, '.published.json')
}

/**
 * Boot doctor files not yet published: [{ path, name }], oldest first.
 */
export async function findDoctorFiles({ doctorDir, since = null }) {
  const cutoff = sinceMs(since)
  let names
  try {
    names = (await readdir(doctorDir)).sort()
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const files = []
  for (const name of names) {
    const at = doctorFileTime(name)
    if (at === null) continue
    if (cutoff !== null && at < cutoff) continue
    const path = join(doctorDir, name)
    if ((await readJsonOrNull(doctorSidecar(path)).catch(() => null))?.complete === true) continue
    files.push({ path, name })
  }
  return files
}

/** Publishes the FAILs of one boot doctor file as `doctor:<check>` issues. */
export async function publishDoctorFile(ctx, { path, name }) {
  const prefix = ctx.dryRun ? `[dry-run] ${name}:` : `${name}:`
  const fails = parseDoctorFails(await readFile(path, 'utf8'))
  const sidecar = (await readJsonOrNull(doctorSidecar(path)).catch(() => null)) ?? {
    schema: PUBLISH_SCHEMA,
    file: name,
    complete: false,
    issues: {}
  }
  const save = async () => {
    if (!ctx.dryRun) await ctx.writeJson(doctorSidecar(path), sidecar)
  }
  try {
    for (const fail of fails) {
      const signature = doctorSignature(fail.check)
      if (sidecar.issues[signature]) continue
      let detail = fail.detail || null
      if (detail) {
        try {
          await guardText(detail, `doctor detail for ${signature}`, { redactor: ctx.redactor })
        } catch (error) {
          if (!(error instanceof PublishRefused)) throw error
          detail = null
        }
      }
      const texts = await guardedIssueTexts(ctx, signature, {
        title: issueTitle(signature, detail ?? 'FAIL after boot'),
        body: doctorIssueBody({ signature, check: fail.check, detail, file: name }),
        comment: doctorCommentBody({ check: fail.check, detail, file: name })
      })
      if (ctx.dryRun) {
        ctx.print(
          `${prefix} would comment on or open "${texts.title}" in ${ctx.issuesRepo}:\n${indent(texts.body)}`
        )
        continue
      }
      const issues = await ctx.openIssues()
      const result = await fileSignature({
        gh: ctx.gh,
        repo: ctx.issuesRepo,
        issues,
        signature,
        ...texts,
        labelReady: () => ctx.labelOk()
      })
      sidecar.issues[signature] = result
      ctx.print(`${prefix} ${result.action} issue #${result.number ?? '?'} for ${signature}`)
      await save()
    }
  } catch (error) {
    await save()
    ctx.printErr(`${prefix} publish stopped: ${error.message}`)
    return { name, status: 'failed', reason: error.message }
  }
  if (ctx.dryRun) {
    if (fails.length === 0) ctx.print(`${prefix} no FAIL lines`)
    return { name, status: 'dry-run', fails: fails.length }
  }
  sidecar.complete = true
  sidecar.publishedAt = ctx.now().toISOString()
  await save()
  ctx.print(`${prefix} ${fails.length} FAIL(s) published`)
  return { name, status: 'published', fails: fails.length }
}

/**
 * Everything one `live:publish` does. Resolves the exit code: 0 when every
 * run and doctor file published (or would, in a dry run), 1 otherwise.
 */
export async function publishAll(ctx, { workDir, run = null, since = null }) {
  const { runs, warnings } = await findRunsToPublish({
    runsDir: join(workDir, 'runs'),
    since,
    only: run
  })
  for (const warning of warnings) ctx.printErr(`live:publish: ${warning}`)
  let failed = run !== null && runs.length === 0 && warnings.length > 0
  for (const entry of runs) {
    const result = await publishRun(ctx, entry)
    if (result.status === 'refused' || result.status === 'failed') failed = true
  }
  if (run === null) {
    for (const file of await findDoctorFiles({ doctorDir: join(workDir, 'doctor'), since })) {
      const result = await publishDoctorFile(ctx, file)
      if (result.status === 'failed') failed = true
    }
  }
  if (runs.length === 0) ctx.print('live:publish: no run waiting to be published')
  return failed ? 1 : 0
}
