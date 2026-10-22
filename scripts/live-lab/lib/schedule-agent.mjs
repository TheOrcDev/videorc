import { execFile } from 'node:child_process'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { LAB_USER } from './config.mjs'
import { REPO_ROOT } from './schedule-table.mjs'

// Plan 178 U11. Installs the launchd agent that ticks the schedule. The
// template in config/live-lab/ is written for the lab user (`videorc-lab`,
// repo at ~/videorc, Homebrew node); rendering swaps in the real home, repo
// and node paths so the installed file always points at this checkout.
// launchctl is reached only through the injected runner, so tests never
// touch the real launchd.

export const AGENT_LABEL = 'com.videorc.live-lab'
export const TEMPLATE_PATH = join(REPO_ROOT, 'config', 'live-lab', `${AGENT_LABEL}.plist`)
const TEMPLATE_HOME = '/Users/videorc-lab'
const TEMPLATE_REPO = `${TEMPLATE_HOME}/videorc`
const TEMPLATE_NODE = '/opt/homebrew/bin/node'
const TEMPLATE_WORK = `${TEMPLATE_HOME}/videorc-live-lab`

export class AgentRefusal extends Error {
  constructor(message) {
    super(message)
    this.name = 'AgentRefusal'
  }
}

function xmlEscape(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function agentPlistPath(home) {
  return join(home, 'Library', 'LaunchAgents', `${AGENT_LABEL}.plist`)
}

export function agentLogsDir(home) {
  return join(home, 'videorc-live-lab', 'logs')
}

/** Pure: the template with this machine's home, repo checkout and node binary. */
export function renderAgentPlist(template, { home, repoRoot = REPO_ROOT, nodePath }) {
  for (const [name, value] of Object.entries({ home, repoRoot, nodePath })) {
    if (typeof value !== 'string' || !value.startsWith('/')) {
      throw new Error(`renderAgentPlist needs an absolute ${name}`)
    }
  }
  if (!template.includes(`<string>${AGENT_LABEL}</string>`)) {
    throw new Error(`the template does not carry the ${AGENT_LABEL} label`)
  }
  // The work dir first: the repo path is a prefix of it (~/videorc vs
  // ~/videorc-live-lab), so the repo is only matched as a whole path.
  const rendered = template
    .split(TEMPLATE_WORK)
    .join(xmlEscape(`${home}/videorc-live-lab`))
    .replace(new RegExp(`${TEMPLATE_REPO}(?=[/<])`, 'g'), () => xmlEscape(repoRoot))
    .split(TEMPLATE_NODE)
    .join(xmlEscape(nodePath))
    .split(TEMPLATE_HOME)
    .join(xmlEscape(home))
  if (
    home !== TEMPLATE_HOME &&
    !repoRoot.startsWith(TEMPLATE_HOME) &&
    !nodePath.startsWith(TEMPLATE_HOME) &&
    rendered.includes(TEMPLATE_HOME)
  ) {
    throw new Error('rendering left a template path behind')
  }
  return rendered
}

function defaultRunner(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 30_000 }, (error, stdout, stderr) => {
      resolve({
        code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? error?.message ?? '')
      })
    })
  })
}

function assertLabUser(username, forceUser) {
  if (username !== LAB_USER && !forceUser) {
    throw new AgentRefusal(
      `the schedule agent installs for the lab user ${LAB_USER} only (you are ${username}); --force-user exists for tests with a temporary HOME`
    )
  }
}

function assertNoLiveRun(lockHolder, force) {
  if (lockHolder && !force) {
    throw new AgentRefusal(
      `a run holds the run lock (${lockHolder}); replacing or removing the agent would kill it. Wait for it to end, or pass --force.`
    )
  }
}

/**
 * Renders the template into ~/Library/LaunchAgents and (re)bootstraps it in
 * the GUI domain. Refuses for any user but the lab user unless `forceUser`,
 * and while a run holds the run lock unless `force`.
 */
export async function installAgent({
  home,
  uid,
  username,
  forceUser = false,
  force = false,
  lockHolder = null,
  repoRoot = REPO_ROOT,
  nodePath = process.execPath,
  templatePath = TEMPLATE_PATH,
  runner = defaultRunner,
  log = () => {}
}) {
  assertLabUser(username, forceUser)
  assertNoLiveRun(lockHolder, force)
  const template = await readFile(templatePath, 'utf8')
  const rendered = renderAgentPlist(template, { home, repoRoot, nodePath })
  const target = agentPlistPath(home)
  await mkdir(join(home, 'Library', 'LaunchAgents'), { recursive: true })
  // launchd opens StandardOutPath itself and does not create its folder.
  await mkdir(agentLogsDir(home), { recursive: true })
  const temp = `${target}.${process.pid}.tmp`
  await writeFile(temp, rendered, { mode: 0o644 })
  await chmod(temp, 0o644)
  const lint = await runner('/usr/bin/plutil', ['-lint', temp])
  if (lint.code !== 0) {
    await rm(temp, { force: true })
    throw new Error(`plutil rejected the rendered plist: ${lint.stdout || lint.stderr}`.trim())
  }
  await rename(temp, target)
  log(`Wrote ${target}.`)
  const domain = `gui/${uid}`
  const bootout = await runner('/bin/launchctl', ['bootout', `${domain}/${AGENT_LABEL}`])
  if (bootout.code === 0) log('Unloaded the previous agent.')
  const bootstrap = await runner('/bin/launchctl', ['bootstrap', domain, target])
  if (bootstrap.code !== 0) {
    throw new Error(
      `launchctl bootstrap ${domain} failed: ${(bootstrap.stderr || bootstrap.stdout).trim()}`
    )
  }
  log(`Loaded ${AGENT_LABEL} in ${domain}; it ticks every 300 s and once now.`)
  return { path: target, domain, rendered }
}

/** Boots the agent out of the GUI domain and removes the installed plist. */
export async function uninstallAgent({
  home,
  uid,
  username,
  forceUser = false,
  force = false,
  lockHolder = null,
  runner = defaultRunner,
  log = () => {}
}) {
  assertLabUser(username, forceUser)
  assertNoLiveRun(lockHolder, force)
  const domain = `gui/${uid}`
  const bootout = await runner('/bin/launchctl', ['bootout', `${domain}/${AGENT_LABEL}`])
  log(
    bootout.code === 0
      ? `Unloaded ${AGENT_LABEL} from ${domain}.`
      : `${AGENT_LABEL} was not loaded in ${domain}.`
  )
  const target = agentPlistPath(home)
  await rm(target, { force: true })
  log(`Removed ${target}.`)
  return { path: target, domain, wasLoaded: bootout.code === 0 }
}
