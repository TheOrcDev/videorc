import { execFile } from 'node:child_process'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { LAB_USER } from './config.mjs'
import { LINUX, requireLabPlatform } from './platform.mjs'
import { REPO_ROOT } from './schedule-table.mjs'

// Plan 178 U11. Installs the launchd agent that ticks the schedule. The
// template in config/live-lab/ is written for the lab user (`videorc-lab`,
// repo at ~/videorc, Homebrew node); rendering swaps in the real home, repo
// and node paths so the installed file always points at this checkout.
// launchctl is reached only through the injected runner, so tests never
// touch the real launchd.
//
// Plan 179. On Linux the same commands install a systemd user timer instead:
// config/live-lab/linux/videorc-live-lab.{service,timer}, rendered the same
// way into ~/.config/systemd/user/. systemctl, systemd-analyze and loginctl
// are reached only through the same runner.

export const AGENT_LABEL = 'com.videorc.live-lab'
export const TEMPLATE_PATH = join(REPO_ROOT, 'config', 'live-lab', `${AGENT_LABEL}.plist`)
const TEMPLATE_HOME = '/Users/videorc-lab'
const TEMPLATE_REPO = `${TEMPLATE_HOME}/videorc`
const TEMPLATE_NODE = '/opt/homebrew/bin/node'
const TEMPLATE_WORK = `${TEMPLATE_HOME}/videorc-live-lab`

export const SYSTEMD_UNIT = 'videorc-live-lab'
export const SYSTEMD_SERVICE = `${SYSTEMD_UNIT}.service`
export const SYSTEMD_TIMER = `${SYSTEMD_UNIT}.timer`
const LINUX_TEMPLATE_DIR = join(REPO_ROOT, 'config', 'live-lab', 'linux')
export const SERVICE_TEMPLATE_PATH = join(LINUX_TEMPLATE_DIR, SYSTEMD_SERVICE)
export const TIMER_TEMPLATE_PATH = join(LINUX_TEMPLATE_DIR, SYSTEMD_TIMER)
const LINUX_TEMPLATE_HOME = '/home/videorc-lab'
const LINUX_TEMPLATE_REPO = `${LINUX_TEMPLATE_HOME}/videorc`
const LINUX_TEMPLATE_NODE = '/usr/bin/node'
const LINUX_TEMPLATE_WORK = `${LINUX_TEMPLATE_HOME}/videorc-live-lab`
export const SYSTEMCTL = '/usr/bin/systemctl'
export const SYSTEMD_ANALYZE = '/usr/bin/systemd-analyze'
export const LOGINCTL = '/usr/bin/loginctl'
// Stopping a tick that is mid-run waits up to the unit's TimeoutStopSec (90 s).
const STOP_TIMEOUT_MS = 120_000

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

export function systemdUserDir(home) {
  return join(home, '.config', 'systemd', 'user')
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

// systemd expands % specifiers and $ variables in unit values, splits on
// whitespace and reads quotes and backslashes; none of those has one safe
// spelling in every setting the units use, so such a path is refused.
const SYSTEMD_UNSAFE = /[\s%$"'`\\]/

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** `nodeDir` first, then the template's PATH entries without a repeat. */
function pathWithNodeDir(list, nodeDir) {
  return [nodeDir, ...list.split(':').filter((entry) => entry && entry !== nodeDir)].join(':')
}

/**
 * Pure: a config/live-lab/linux/ unit template with this machine's home,
 * repo checkout and node binary, and node's folder first in PATH. The
 * placeholders are swapped in one pass, the work dir before the repo path it
 * starts with and each only as a whole path, so a swapped-in path is never
 * swapped again.
 */
export function renderSystemdUnit(template, { home, repoRoot = REPO_ROOT, nodePath }) {
  for (const [name, value] of Object.entries({ home, repoRoot, nodePath })) {
    if (typeof value !== 'string' || !value.startsWith('/')) {
      throw new Error(`renderSystemdUnit needs an absolute ${name}`)
    }
    if (SYSTEMD_UNSAFE.test(value)) {
      throw new Error(
        `renderSystemdUnit refuses ${name} ${JSON.stringify(value)}: systemd reads whitespace, quotes, %, $ and backslashes in unit values as syntax`
      )
    }
  }
  if (!/^\[Unit\]$/m.test(template) || !template.includes(SYSTEMD_UNIT)) {
    throw new Error(`the template is not a ${SYSTEMD_UNIT} systemd unit`)
  }
  const whole = '(?=[/\\s]|$)'
  const placeholders = new RegExp(
    [LINUX_TEMPLATE_WORK, LINUX_TEMPLATE_REPO, LINUX_TEMPLATE_NODE, LINUX_TEMPLATE_HOME]
      .map((path) => `(${escapeRegExp(path)})${whole}`)
      .join('|'),
    'gm'
  )
  const rendered = template
    .replace(placeholders, (_match, work, repo, node) => {
      if (work) return `${home}/videorc-live-lab`
      if (repo) return repoRoot
      if (node) return nodePath
      return home
    })
    .replace(
      /^Environment=PATH=(.*)$/m,
      (_line, list) => `Environment=PATH=${pathWithNodeDir(list, dirname(nodePath))}`
    )
  const legit = [home, repoRoot, nodePath].some((value) => value.startsWith(LINUX_TEMPLATE_HOME))
  if (!legit && rendered.includes(LINUX_TEMPLATE_HOME)) {
    throw new Error('rendering left a template path behind')
  }
  return rendered
}

function defaultRunner(command, args, { timeout = 30_000 } = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout }, (error, stdout, stderr) => {
      resolve({
        code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? error?.message ?? '')
      })
    })
  })
}

function assertLabUser(username, labUser, forceUser) {
  if (username !== labUser && !forceUser) {
    throw new AgentRefusal(
      `the schedule agent installs for the lab user ${labUser} only (you are ${username}; labUser in the policy names that account); --force-user exists for tests with a temporary HOME`
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
 * Installs the schedule for this platform: the launchd agent on macOS, the
 * systemd user timer on Linux. Refuses for any user but `labUser` unless
 * `forceUser`, and while a run holds the run lock unless `force`.
 */
export async function installAgent({
  platform = process.platform,
  labUser = LAB_USER,
  username,
  forceUser = false,
  force = false,
  lockHolder = null,
  ...options
}) {
  const lab = requireLabPlatform(platform, 'The schedule agent')
  assertLabUser(username, labUser, forceUser)
  assertNoLiveRun(lockHolder, force)
  return lab === LINUX ? installSystemdTimer({ username, ...options }) : installLaunchAgent(options)
}

/** Removes this platform's schedule agent, with the same refusals as installAgent. */
export async function uninstallAgent({
  platform = process.platform,
  labUser = LAB_USER,
  username,
  forceUser = false,
  force = false,
  lockHolder = null,
  ...options
}) {
  const lab = requireLabPlatform(platform, 'The schedule agent')
  assertLabUser(username, labUser, forceUser)
  assertNoLiveRun(lockHolder, force)
  return lab === LINUX
    ? uninstallSystemdTimer({ username, ...options })
    : uninstallLaunchAgent(options)
}

/**
 * macOS: renders the template into ~/Library/LaunchAgents and (re)bootstraps
 * it in the GUI domain.
 */
async function installLaunchAgent({
  home,
  uid,
  repoRoot = REPO_ROOT,
  nodePath = process.execPath,
  templatePath = TEMPLATE_PATH,
  runner = defaultRunner,
  log = () => {}
}) {
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

/** macOS: boots the agent out of the GUI domain and removes the installed plist. */
async function uninstallLaunchAgent({ home, uid, runner = defaultRunner, log = () => {} }) {
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

function output(result) {
  return [result.stdout, result.stderr]
    .map((text) => String(text ?? '').trim())
    .filter(Boolean)
    .join('\n')
}

/** The first line a systemd command printed, e.g. `enabled` or `active`. */
function answer(result) {
  return output(result).split('\n')[0] || `exit ${result.code}`
}

// `sudo -u` and `su` give the lab user no user bus, so every systemctl --user
// call fails; say how to get a real session instead of only relaying it.
const NO_USER_BUS = /XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS|Failed to connect to bus/

function busHint(text, username) {
  return NO_USER_BUS.test(text)
    ? `. systemctl --user needs ${username}'s own login session: SSH in as ${username}, or use \`sudo machinectl shell ${username}@\` (sudo -u and su leave no user bus)`
    : ''
}

function failure(what, result, username) {
  const text = output(result) || `exit ${result.code}`
  return new Error(`${what} failed: ${text}${busHint(text, username)}`)
}

async function systemctlUser(runner, args, username) {
  const result = await runner(SYSTEMCTL, ['--user', ...args])
  if (result.code !== 0) throw failure(`systemctl --user ${args.join(' ')}`, result, username)
  return result
}

/**
 * Linux: without linger the user manager, and so the timer, lives only while
 * the lab user is logged in. Warns (never refuses): the owner turns it on.
 */
async function checkLinger({ runner, username, log }) {
  const result = await runner(LOGINCTL, ['show-user', username, '-p', 'Linger'])
  const linger = /^Linger=(yes|no)$/m.exec(result.stdout ?? '')?.[1] ?? null
  if (linger === 'yes') {
    log(`Linger is on for ${username}: the timer runs from boot with nobody logged in.`)
    return linger
  }
  const why =
    linger === 'no'
      ? `linger is off for ${username}`
      : `could not read linger for ${username} (${answer(result)})`
  log(
    `WARNING: ${why}, so ${SYSTEMD_TIMER} runs only while ${username} is logged in and the post-boot tick waits for a login. The owner turns it on with: sudo loginctl enable-linger ${username}`
  )
  return linger
}

/**
 * Linux: renders both units into ~/.config/systemd/user, verifies them with
 * systemd-analyze before they replace anything, reloads the user manager and
 * enables the timer now. Units that fail verification never land, and the
 * ones already installed stay as they were.
 */
async function installSystemdTimer({
  home,
  username,
  repoRoot = REPO_ROOT,
  nodePath = process.execPath,
  serviceTemplatePath = SERVICE_TEMPLATE_PATH,
  timerTemplatePath = TIMER_TEMPLATE_PATH,
  runner = defaultRunner,
  log = () => {}
}) {
  const values = { home, repoRoot, nodePath }
  const rendered = {
    service: renderSystemdUnit(await readFile(serviceTemplatePath, 'utf8'), values),
    timer: renderSystemdUnit(await readFile(timerTemplatePath, 'utf8'), values)
  }
  const unitDir = systemdUserDir(home)
  const paths = { service: join(unitDir, SYSTEMD_SERVICE), timer: join(unitDir, SYSTEMD_TIMER) }
  await mkdir(unitDir, { recursive: true })
  // systemd opens the append: log files itself and does not create their folder.
  await mkdir(agentLogsDir(home), { recursive: true })
  // Staged under their real names (systemd-analyze judges a unit by its name)
  // in a hidden folder beside the targets, so each rename is atomic and the
  // user manager never loads a staging copy.
  const staging = join(unitDir, `.${SYSTEMD_UNIT}.${process.pid}.tmp`)
  const staged = { service: join(staging, SYSTEMD_SERVICE), timer: join(staging, SYSTEMD_TIMER) }
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  try {
    for (const kind of ['service', 'timer']) {
      await writeFile(staged[kind], rendered[kind], { mode: 0o644 })
      await chmod(staged[kind], 0o644)
    }
    const verify = await runner(SYSTEMD_ANALYZE, ['--user', 'verify', staged.service, staged.timer])
    if (verify.code !== 0) {
      throw failure('systemd-analyze --user verify of the rendered units', verify, username)
    }
    await rename(staged.service, paths.service)
    await rename(staged.timer, paths.timer)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  log(`Wrote ${paths.service} and ${paths.timer}.`)
  await systemctlUser(runner, ['daemon-reload'], username)
  await systemctlUser(runner, ['enable', '--now', SYSTEMD_TIMER], username)
  const enabled = answer(await runner(SYSTEMCTL, ['--user', 'is-enabled', SYSTEMD_TIMER]))
  const active = answer(await runner(SYSTEMCTL, ['--user', 'is-active', SYSTEMD_TIMER]))
  log(
    `${SYSTEMD_TIMER}: is-enabled ${enabled}, is-active ${active}; it ticks 60 s after boot and every 300 s.`
  )
  if (enabled !== 'enabled' || active !== 'active') {
    log(
      `WARNING: ${SYSTEMD_TIMER} should be enabled and active; see systemctl --user status ${SYSTEMD_TIMER}`
    )
  }
  const linger = await checkLinger({ runner, username, log })
  return { paths, rendered, enabled, active, linger }
}

/**
 * Linux: disables and stops the timer, stops a tick in progress (the run-lock
 * guard has already passed), removes both units and reloads the user manager.
 */
async function uninstallSystemdTimer({ home, username, runner = defaultRunner, log = () => {} }) {
  const disable = await runner(SYSTEMCTL, ['--user', 'disable', '--now', SYSTEMD_TIMER])
  if (disable.code !== 0 && NO_USER_BUS.test(output(disable))) {
    throw failure(`systemctl --user disable --now ${SYSTEMD_TIMER}`, disable, username)
  }
  log(
    disable.code === 0
      ? `Disabled and stopped ${SYSTEMD_TIMER}.`
      : `${SYSTEMD_TIMER} was not installed (${answer(disable)}).`
  )
  const stop = await runner(SYSTEMCTL, ['--user', 'stop', SYSTEMD_SERVICE], {
    timeout: STOP_TIMEOUT_MS
  })
  log(
    stop.code === 0
      ? `Stopped ${SYSTEMD_SERVICE} (a tick in progress gets SIGTERM and 90 s to end its run).`
      : `Could not stop ${SYSTEMD_SERVICE} (${answer(stop)}).`
  )
  const unitDir = systemdUserDir(home)
  const paths = { service: join(unitDir, SYSTEMD_SERVICE), timer: join(unitDir, SYSTEMD_TIMER) }
  await rm(paths.timer, { force: true })
  await rm(paths.service, { force: true })
  log(`Removed ${paths.timer} and ${paths.service}.`)
  await systemctlUser(runner, ['daemon-reload'], username)
  log('Reloaded the user manager.')
  return { paths, wasLoaded: disable.code === 0 }
}
