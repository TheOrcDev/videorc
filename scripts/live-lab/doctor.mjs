#!/usr/bin/env node

// Plan 176 L0: is the live lab ready to go live? Prints PASS / WARN / FAIL /
// SKIP per check and exits non-zero on any FAIL. Spends 2 lab quota units
// (one channels.list per role), charged to the lab quota ledger (plan 178
// U8). Never prints more than the last 4 characters of a secret.

import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, readFile, readdir, stat } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:tls'
import { promisify } from 'node:util'

import {
  LAB_USER,
  ROLES,
  configPath,
  inspectPermissions,
  labDir,
  readConfig,
  redact,
  workDir
} from './lib/config.mjs'
import {
  FAIL,
  PASS,
  SKIP,
  WARN,
  check,
  evaluateAutoLogin,
  evaluateBlackHole,
  evaluateChannelIdentity,
  evaluateClient,
  evaluateDiskFree,
  evaluateDisplayAwake,
  evaluateFocus,
  evaluateGhAuth,
  evaluateKillSwitch,
  evaluateLabDisplay,
  evaluateLinuxAutoLogin,
  evaluateLinuxLabAudio,
  evaluateLinuxLabDisplay,
  evaluateLinuxLinger,
  evaluateLinuxNetFaultsClean,
  evaluateLinuxNotifications,
  evaluateLinuxScreenGrant,
  evaluateLinuxScreenLock,
  evaluateLinuxSession,
  evaluateLinuxSleep,
  evaluateLinuxSudo,
  evaluateLinuxUnattendedBoot,
  evaluateNetFaultsClean,
  evaluatePermissions,
  evaluateQuota,
  evaluatePolicyFile,
  evaluateRunLock,
  evaluateScreenLock,
  evaluateSigningIdentities,
  evaluateSleep,
  evaluateStopFile,
  evaluateStreamKeys,
  evaluateTokenAge,
  evaluateTool,
  formatResult,
  LINUX_SLEEP_TARGETS,
  parseXdphPicker,
  summarize
} from './lib/doctor-checks.mjs'
import {
  CHROME_NAMES,
  defaultExec,
  findOnPath,
  hyprctlJson,
  labSessionEnv
} from './lib/linux-desktop.mjs'
import { fetchControlFromUrl, stopFilePath } from './lib/kill-switch.mjs'
import {
  ALLOWED_COMMANDS,
  LINUX_ALLOWED_COMMANDS,
  LINUX_NETFAULT_HELPER,
  PF_CONF,
  createNetFaultRegistry,
  netFaultResidue,
  removeNetFaults,
  residueIsClean,
  sudoRefused,
  sudoRunner
} from './lib/net-fault.mjs'
import { fetchMyChannel, refreshAccessToken } from './lib/oauth.mjs'
import { createQuotaLedger } from './lib/quota-ledger.mjs'
import { LINUX, MACOS, requireLabPlatform } from './lib/platform.mjs'
import { loadPolicy, policyPath, reportsRepoFromKillSwitchUrl } from './lib/policy.mjs'
import { processAlive, readRunLock } from './lib/run-lock.mjs'

const execFileAsync = promisify(execFile)
const PLATFORM = requireLabPlatform(process.platform, 'live:doctor')
const RTMPS_HOST = 'a.rtmps.youtube.com'
const MAIN_REPO = 'TheOrcDev/videorc'
const FOCUS_ASSERTIONS = join(homedir(), 'Library', 'DoNotDisturb', 'DB', 'Assertions.json')

async function run(command, args) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      timeout: 20_000,
      maxBuffer: 16 * 1024 * 1024
    })
    return stdout || stderr
  } catch {
    return ''
  }
}

async function profiler(type) {
  const output = await run('system_profiler', ['-json', type])
  try {
    return JSON.parse(output)
  } catch {
    return null
  }
}

function reachable(host, port, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const socket = connect({ host, port, servername: host, timeout: timeoutMs }, () => {
      const protocol = socket.getProtocol()
      socket.end()
      resolve({ ok: true, detail: `${host}:${port} TLS ok (${protocol})` })
    })
    socket.on('timeout', () => {
      socket.destroy()
      resolve({ ok: false, detail: `${host}:${port} timed out after ${timeoutMs / 1000} s` })
    })
    socket.on('error', (error) =>
      resolve({ ok: false, detail: `${host}:${port} ${error.code ?? error.message}` })
    )
  })
}

async function roleChecks(role, config, broadcasterChannelId, ledger) {
  const entry = config?.roles?.[role]
  if (!entry?.refreshToken) {
    return {
      results: [
        check(`${role} channel`, FAIL, `Not authorized. Run pnpm live:hookup --role ${role}.`)
      ],
      channelId: null
    }
  }
  const results = [evaluateTokenAge(role, entry.authorizedAt)]
  if (!config.client) {
    results.unshift(check(`${role} channel`, FAIL, 'No OAuth client stored.'))
    return { results, channelId: null }
  }
  let accessToken
  try {
    ledger.charge('channels.list')
    accessToken = await refreshAccessToken({
      clientId: config.client.id,
      clientSecret: config.client.secret,
      refreshToken: entry.refreshToken
    })
    const channel = await fetchMyChannel({ accessToken })
    results.unshift(
      evaluateChannelIdentity(role, channel, {
        expectedHandle: config.channel?.handle,
        broadcasterChannelId
      })
    )
    // The refresh just worked, so an old token is a project in production
    // (plan 178 D2), not an expired Testing-mode grant. Age is then advice.
    const age = results.find((entry) => entry.name === `${role} token age`)
    if (age?.status === FAIL) {
      age.status = WARN
      age.detail = `${age.detail.split(':')[0]}: the refresh still works (production project). Rerun hookup only if a refresh fails.`
    }
    return { results, channelId: channel.channelId }
  } catch (error) {
    const hint =
      error.code === 'invalid_grant'
        ? ` The refresh token is expired or revoked. Run pnpm live:hookup --role ${role}.`
        : ''
    results.unshift(
      check(`${role} channel`, FAIL, `${redact(error.message, config, [accessToken])}${hint}`)
    )
    return { results, channelId: null }
  }
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function readText(path) {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return ''
  }
}

async function repoAccess(name, needWrite) {
  return {
    name,
    json: await run('gh', ['repo', 'view', name, '--json', 'viewerPermission']),
    needWrite
  }
}

// Plan 178 U3. Runs on the lab machine (the lab user, or a policy file in
// place), or anywhere with --machine. Every check is a pure verdict over
// what a command printed; see doctor-checks.mjs for the broken-on-purpose
// cases.
async function machineChecks(displays) {
  const results = []
  const [autoLogin, screenLock, pmset, df, identities, focus] = await Promise.all([
    run('defaults', ['read', '/Library/Preferences/com.apple.loginwindow', 'autoLoginUser']),
    run('sysadminctl', ['-screenLock', 'status']),
    run('pmset', ['-g']),
    run('df', ['-k', homedir()]),
    run('security', ['find-identity', '-v', '-p', 'codesigning']),
    readText(FOCUS_ASSERTIONS)
  ])
  results.push(evaluateAutoLogin(autoLogin, LAB_USER))
  results.push(evaluateScreenLock(screenLock))
  results.push(evaluateSleep(pmset))
  results.push(evaluateDisplayAwake(displays))
  results.push(evaluateFocus(focus))
  results.push(evaluateDiskFree(df))
  results.push(evaluateSigningIdentities(identities))
  results.push(...(await sharedMachineChecks(netFaultChecks)).results)
  return results
}

// The policy, the network-fault residue, gh, the kill switch, the run lock
// and the STOP file read the same on both platforms; only the fault backend
// differs.
async function sharedMachineChecks(faultChecks) {
  const results = []
  const loaded = await loadPolicy({ path: policyPath() })
  results.push(evaluatePolicyFile(loaded))
  results.push(await faultChecks(loaded.policy))

  const ghStatus = await run('gh', ['auth', 'status'])
  const reports = loaded.policy ? reportsRepoFromKillSwitchUrl(loaded.policy.killSwitchUrl) : null
  const repos = [await repoAccess(MAIN_REPO, false)]
  if (reports) repos.unshift(await repoAccess(reports.name, true))
  results.push(evaluateGhAuth(ghStatus, repos))

  if (loaded.policy) {
    let outcome
    try {
      outcome = await fetchControlFromUrl(loaded.policy.killSwitchUrl)
    } catch (error) {
      outcome = { error: error.message }
    }
    results.push(evaluateKillSwitch(loaded.policy.killSwitchUrl, outcome))
  } else {
    results.push(check('kill switch', SKIP, 'No valid policy, so no kill switch URL to check.'))
  }

  const work = workDir()
  const lock = await readRunLock({ dir: work })
  results.push(evaluateRunLock(lock, lock && !lock.corrupt ? processAlive(lock.pid) : false))
  results.push(evaluateStopFile(stopFilePath(work), await exists(stopFilePath(work))))
  return { results, policy: loaded.policy }
}

// Plan 178 U13 (plan 166 S9): a network fault must never outlive its run.
// Reads the lab anchor and the pipe back with the allowed sudo commands; a
// leftover is a FAIL, and when the read-back works the doctor flushes it
// with the same commands and says so (WARN).
async function readNetFaultState() {
  const [rules, list] = await Promise.all([
    sudoRunner(ALLOWED_COMMANDS.pfShowAnchorRules),
    sudoRunner(ALLOWED_COMMANDS.dnList)
  ])
  if (sudoRefused(rules) || sudoRefused(list)) return null
  return { pfRules: rules.stdout, dnctlList: list.stdout }
}

async function netFaultChecks(policy) {
  const networkFaults = policy?.faults?.network ?? null
  const first = await readNetFaultState()
  if (!first) return evaluateNetFaultsClean(null, null, { networkFaults })
  const pfConf = await readText(PF_CONF)
  const verdict = evaluateNetFaultsClean(first.pfRules, first.dnctlList, { networkFaults, pfConf })
  if (residueIsClean(netFaultResidue(first))) return verdict
  try {
    await removeNetFaults({ runner: sudoRunner, registry: createNetFaultRegistry() })
  } catch (error) {
    return check(
      'network faults',
      FAIL,
      `${verdict.detail} (doctor cleanup failed: ${error.message})`
    )
  }
  const again = await readNetFaultState()
  if (!again) return verdict
  return evaluateNetFaultsClean(again.pfRules, again.dnctlList, {
    networkFaults,
    pfConf,
    cleaned: true
  })
}

// ---------------------------------------------------------------------------
// Plan 179: the Linux lab (Hyprland session, portal capture, Pulse devices).

const LINUX_INSTALL =
  'sudo pacman -S <pkg> (Arch/Omarchy) or sudo apt install <pkg> (Debian/Ubuntu)'
const AUTOLOGIN_FILES = [
  '/etc/sddm.conf',
  '/etc/sddm.conf.d',
  '/etc/greetd/config.toml',
  '/etc/systemd/system/getty@tty1.service.d'
]

function installHint(pkg) {
  return `Install it: ${LINUX_INSTALL.replaceAll('<pkg>', pkg)}.`
}

// Same as run() but keeps stdout on a non-zero exit (systemctl is-enabled
// exits 1 for masked units, sudo -l prints its refusal on stderr).
async function runText(command, args, options = {}) {
  const result = await defaultExec(command, args, options)
  return `${result.stdout}${result.stderr}`
}

// Names of running processes, from /proc/<pid>/comm. Read-only inspection;
// nothing here ever signals a process.
async function runningCommands() {
  const names = new Set()
  let entries = []
  try {
    entries = await readdir('/proc')
  } catch {
    return names
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    const comm = (await readText(`/proc/${entry}/comm`)).trim()
    if (comm) names.add(comm)
  }
  return names
}

async function autoLoginFiles() {
  const files = {}
  for (const path of AUTOLOGIN_FILES) {
    const info = await stat(path).catch(() => null)
    if (!info) continue
    if (info.isDirectory()) {
      for (const name of (await readdir(path).catch(() => [])).sort()) {
        if (name.endsWith('.conf')) files[join(path, name)] = await readText(join(path, name))
      }
    } else {
      files[path] = await readText(path)
    }
  }
  return files
}

async function sharePickerState(sessionEnv) {
  const xdphConf = await readText(join(homedir(), '.config', 'hypr', 'xdph.conf'))
  const configured = parseXdphPicker(xdphConf)
  let picker = null
  if (configured) {
    const path = configured.replace(/^~(?=\/)/, homedir())
    const executable = await access(path, constants.X_OK).then(
      () => true,
      () => false
    )
    picker = { path, executable, isLabPicker: (await readText(path)).includes('portal-pick') }
  }
  const fallback = Boolean(
    await findOnPath(['hyprland-share-picker'], { env: { ...process.env, ...sessionEnv } })
  )
  return { xdphConf: xdphConf || null, picker, fallback }
}

async function linuxHostChecks(config) {
  const sessionEnv = await labSessionEnv()
  const results = [evaluateLinuxSession(sessionEnv)]
  let monitors = null
  let monitorsError = null
  try {
    monitors = await hyprctlJson(['monitors', 'all'], { sessionEnv })
  } catch (error) {
    monitorsError = error
  }
  const pulseEnv = { env: { ...process.env, ...sessionEnv } }
  const [sinks, sources, ytDlp, ffmpeg, espeak, chrome, rtmps, picker] = await Promise.all([
    runText('ffmpeg', ['-hide_banner', '-sinks', 'pulse'], pulseEnv),
    runText('ffmpeg', ['-hide_banner', '-sources', 'pulse'], pulseEnv),
    run('yt-dlp', ['--version']),
    run('ffmpeg', ['-hide_banner', '-version']),
    run('espeak-ng', ['--version']),
    findOnPath(CHROME_NAMES),
    reachable(RTMPS_HOST, 443),
    sharePickerState(sessionEnv)
  ])
  results.push(evaluateLinuxLabDisplay(monitors, config?.labDisplay?.name, monitorsError))
  results.push(evaluateLinuxScreenGrant(picker))
  results.push(evaluateLinuxLabAudio(sinks, sources))
  results.push(evaluateTool('yt-dlp', ytDlp && `yt-dlp ${ytDlp}`, installHint('yt-dlp')))
  results.push(evaluateTool('ffmpeg', ffmpeg, installHint('ffmpeg')))
  results.push(evaluateTool('espeak-ng', espeak, installHint('espeak-ng')))
  results.push(
    evaluateTool('chrome', chrome, `${installHint('chromium')} (or google-chrome from Google).`)
  )
  results.push(check('rtmps ingest', rtmps.ok ? PASS : FAIL, rtmps.detail))
  return { results, sessionEnv }
}

async function linuxMachineChecks(sessionEnv) {
  const user = userInfo().username
  const execEnv = { env: { ...process.env, ...sessionEnv } }
  const [sleepTargets, linger, lsblk, sudoList, groups, df, files, running] = await Promise.all([
    runText('systemctl', ['is-enabled', ...LINUX_SLEEP_TARGETS]),
    runText('loginctl', ['show-user', user, '-p', 'Linger']),
    runText('lsblk', ['-n', '-o', 'TYPE']),
    runText('sudo', ['-n', '-l']),
    runText('id', ['-Gn']),
    run('df', ['-k', homedir()]),
    autoLoginFiles(),
    runningCommands()
  ])
  const daemon = ['mako', 'dunst', 'swaync'].find((name) => running.has(name)) ?? null
  const notifications = daemon
    ? await runText(
        { mako: 'makoctl', dunst: 'dunstctl', swaync: 'swaync-client' }[daemon],
        { mako: ['mode'], dunst: ['is-paused'], swaync: ['-D'] }[daemon],
        execEnv
      )
    : ''
  const results = [
    evaluateLinuxAutoLogin(files, user),
    evaluateLinuxLinger(linger, user),
    evaluateLinuxUnattendedBoot(lsblk),
    evaluateLinuxScreenLock({
      hypridle: running.has('hypridle'),
      hyprlock: running.has('hyprlock')
    }),
    evaluateLinuxSleep(sleepTargets),
    evaluateLinuxNotifications({ daemon, output: notifications }),
    evaluateDiskFree(df),
    evaluateLinuxSudo(sudoList, groups, user),
    check(
      'signing identity',
      SKIP,
      'macOS only: Linux builds are unsigned AppImages (live:install checks their hash).'
    )
  ]
  results.push(...(await sharedMachineChecks(linuxNetFaultChecks)).results)
  return results
}

async function linuxHelperState() {
  const info = await stat(LINUX_NETFAULT_HELPER).catch(() => null)
  if (!info) return { present: false, rootOwned: false, writable: false }
  const writable = await access(LINUX_NETFAULT_HELPER, constants.W_OK).then(
    () => true,
    () => false
  )
  return { present: true, rootOwned: info.uid === 0, writable }
}

// Plan 179: the Linux twin of netFaultChecks. The helper's own read-back;
// sudo is never called when the helper is not installed.
async function linuxNetFaultChecks(policy) {
  const networkFaults = policy?.faults?.network ?? null
  const helper = await linuxHelperState()
  const readStatus = async () => {
    if (!helper.present) return null
    const result = await sudoRunner(LINUX_ALLOWED_COMMANDS.status)
    return sudoRefused(result) || result.code !== 0 ? null : result.stdout
  }
  const first = await readStatus()
  const verdict = evaluateLinuxNetFaultsClean(first, { networkFaults, helper })
  if (first === null || verdict.status !== FAIL || !/outlived its run/.test(verdict.detail)) {
    return verdict
  }
  try {
    await removeNetFaults({
      runner: sudoRunner,
      registry: createNetFaultRegistry(),
      platform: process.platform
    })
  } catch (error) {
    return check(
      'network faults',
      FAIL,
      `${verdict.detail} (doctor cleanup failed: ${error.message})`
    )
  }
  const again = await readStatus()
  if (again === null) return verdict
  return evaluateLinuxNetFaultsClean(again, { networkFaults, helper, cleaned: true })
}

async function isLabMachine(argv) {
  if (argv.includes('--machine')) return true
  if (argv.includes('--no-machine')) return false
  if (userInfo().username === LAB_USER) return true
  return exists(policyPath())
}

async function main() {
  const dir = labDir()
  const results = []
  results.push(evaluatePermissions(await inspectPermissions(dir), configPath(dir)))

  let config = null
  try {
    config = await readConfig(dir)
  } catch (error) {
    results.push(check('config', FAIL, error.message))
  }

  results.push(evaluateClient(config))
  results.push(...evaluateStreamKeys(config))

  const ledger = createQuotaLedger({ dir })
  let broadcasterChannelId = null
  for (const role of ROLES) {
    const outcome = await roleChecks(role, config, broadcasterChannelId, ledger)
    if (role === 'broadcaster') broadcasterChannelId = outcome.channelId
    results.push(...outcome.results)
  }

  let displays = null
  let sessionEnv = null
  if (PLATFORM === LINUX) {
    const host = await linuxHostChecks(config)
    sessionEnv = host.sessionEnv
    results.push(...host.results)
  } else {
    const [macDisplays, audio, ytDlp, ffmpeg, rtmps] = await Promise.all([
      profiler('SPDisplaysDataType'),
      profiler('SPAudioDataType'),
      run('yt-dlp', ['--version']),
      run('ffmpeg', ['-hide_banner', '-version']),
      reachable(RTMPS_HOST, 443)
    ])
    displays = macDisplays
    results.push(evaluateLabDisplay(displays, config?.labDisplay?.name))
    results.push(evaluateBlackHole(audio))
    results.push(evaluateTool('yt-dlp', ytDlp && `yt-dlp ${ytDlp}`, 'brew install yt-dlp'))
    results.push(evaluateTool('ffmpeg', ffmpeg, 'brew install ffmpeg'))
    results.push(check('rtmps ingest', rtmps.ok ? PASS : FAIL, rtmps.detail))
  }

  try {
    results.push(evaluateQuota(ledger.today()))
  } catch (error) {
    results.push(evaluateQuota(null, error))
  }
  results.push(
    check(
      'build under test',
      SKIP,
      'Version + TCC test recording arrive with the harness launch (plan 176 L2).'
    )
  )
  if (await isLabMachine(process.argv.slice(2))) {
    results.push(
      ...(PLATFORM === MACOS ? await machineChecks(displays) : await linuxMachineChecks(sessionEnv))
    )
  } else {
    results.push(
      check(
        'machine',
        SKIP,
        'Not the lab machine (no policy file). Pass --machine to run its checks.'
      )
    )
  }

  for (const result of results) {
    console.log(formatResult({ ...result, detail: redact(result.detail, config) }))
  }
  const { counts, ok } = summarize(results)
  console.log(
    `\n${ok ? 'Lab ready' : 'Lab NOT ready'}: ${counts.PASS} pass, ${counts.WARN} warn, ${counts.FAIL} fail, ${counts.SKIP} skip.`
  )
  if (!ok) process.exitCode = 1
}

main().catch((error) => {
  console.error(`live:doctor failed: ${error.message}`)
  process.exitCode = 1
})
