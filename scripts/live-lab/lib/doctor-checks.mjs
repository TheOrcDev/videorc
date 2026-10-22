import {
  DIR_MODE,
  FILE_MODE,
  STREAM_KEY_SLOTS,
  fingerprint,
  formatMode,
  sameHandle
} from './config.mjs'
import {
  DN_PIPE,
  PF_ANCHOR,
  PF_CONF,
  cleanupCommandLines,
  netFaultResidue,
  pfConfHooksAnchor,
  residueIsClean
} from './net-fault.mjs'

// Plan 176 L0. Pure verdicts for live:doctor, so each failure mode can be
// tested without a Mac, a network or a Google account.

export const PASS = 'PASS'
export const WARN = 'WARN'
export const FAIL = 'FAIL'
export const SKIP = 'SKIP'

const DAY_MS = 24 * 60 * 60 * 1000
export const TOKEN_WARN_DAYS = 6
export const TOKEN_EXPIRY_DAYS = 7

export function check(name, status, detail) {
  return { name, status, detail }
}

export function evaluatePermissions({ dirMode, fileMode }, path) {
  if (fileMode === null) {
    return check('config', FAIL, `${path} is missing. Run pnpm live:hookup.`)
  }
  const problems = []
  if (fileMode !== FILE_MODE) problems.push(`file is ${formatMode(fileMode)}, must be 0600`)
  if (dirMode !== null && (dirMode & 0o077) !== 0) {
    problems.push(`dir is ${formatMode(dirMode)}, must be ${formatMode(DIR_MODE)}`)
  }
  return problems.length
    ? check(
        'config',
        FAIL,
        `${path}: ${problems.join('; ')}. Fix: chmod 600 the file, 700 the dir.`
      )
    : check('config', PASS, `${path} is 0600 (dir ${formatMode(dirMode)})`)
}

export function evaluateClient(config) {
  return config?.client
    ? check(
        'oauth client',
        PASS,
        `id ${fingerprint(config.client.id)}, secret ${fingerprint(config.client.secret)}`
      )
    : check('oauth client', FAIL, 'Not stored. Run pnpm live:hookup --client-json <path>.')
}

export function evaluateStreamKeys(config) {
  return Object.entries(STREAM_KEY_SLOTS).map(([slot, label]) => {
    const key = config?.streamKeys?.[slot]?.key
    return key
      ? check(`stream key ${slot}`, PASS, `"${label}" ${fingerprint(key)}`)
      : check(
          `stream key ${slot}`,
          FAIL,
          `"${label}" missing. Run pnpm live:hookup --stream-key ${slot} --from-clipboard.`
        )
  })
}

export function evaluateTokenAge(role, authorizedAt, now = new Date()) {
  const name = `${role} token age`
  const at = Date.parse(authorizedAt ?? '')
  if (!Number.isFinite(at)) {
    return check(name, FAIL, `No authorization date. Run pnpm live:hookup --role ${role}.`)
  }
  const days = (now.getTime() - at) / DAY_MS
  const shown = `${days.toFixed(1)} days`
  if (days >= TOKEN_EXPIRY_DAYS) {
    return check(
      name,
      FAIL,
      `${shown}: Testing-mode tokens expire at 7. Run pnpm live:hookup --role ${role}.`
    )
  }
  if (days >= TOKEN_WARN_DAYS) {
    return check(name, WARN, `${shown}: expires within a day. Run pnpm live:hookup --role ${role}.`)
  }
  return check(name, PASS, shown)
}

// The broadcaster must be the lab channel; the viewer must be anyone else.
export function evaluateChannelIdentity(role, channel, { expectedHandle, broadcasterChannelId }) {
  const name = `${role} channel`
  const shown = `${channel.channelTitle ?? '?'} (${channel.channelHandle ?? channel.channelId})`
  const handleMatches =
    Boolean(channel.channelHandle) && sameHandle(channel.channelHandle, expectedHandle)
  if (role === 'broadcaster') {
    return handleMatches
      ? check(name, PASS, shown)
      : check(
          name,
          FAIL,
          `${shown} is not ${expectedHandle}. Run pnpm live:hookup --role broadcaster.`
        )
  }
  return handleMatches || channel.channelId === broadcasterChannelId
    ? check(name, FAIL, `${shown} is the lab channel. The viewer must be another account.`)
    : check(name, PASS, shown)
}

function displays(profilerJson) {
  return (profilerJson?.SPDisplaysDataType ?? []).flatMap((gpu) => gpu.spdisplays_ndrvs ?? [])
}

const VIRTUAL_DISPLAY = /betterdisplay|betterdummy|dummy|virtual|lab/i

// The lab display is the named one (live:hookup --lab-display), else the one
// external display whose name says it is virtual. It must be online and must
// not be the main display (the menu bar and notifications live there).
export function evaluateLabDisplay(profilerJson, configuredName) {
  const all = displays(profilerJson)
  const external = all.filter((entry) => entry.spdisplays_connection_type !== 'spdisplays_internal')
  const candidates = configuredName
    ? all.filter((entry) => entry._name === configuredName)
    : external.filter((entry) => VIRTUAL_DISPLAY.test(entry._name ?? ''))
  if (candidates.length === 0) {
    const seen = all.map((entry) => `"${entry._name}"`).join(', ') || 'none'
    const hint = configuredName
      ? `No display named "${configuredName}".`
      : 'No virtual display found. Install BetterDisplay and create a virtual screen, or set one with pnpm live:hookup --lab-display "<name>".'
    return check('lab display', FAIL, `${hint} Displays seen: ${seen}.`)
  }
  if (candidates.length > 1) {
    return check(
      'lab display',
      FAIL,
      `Several candidates (${candidates.map((entry) => `"${entry._name}"`).join(', ')}). Pick one with --lab-display.`
    )
  }
  const [display] = candidates
  if (display.spdisplays_online && display.spdisplays_online !== 'spdisplays_yes') {
    return check('lab display', FAIL, `"${display._name}" is asleep or offline.`)
  }
  if (display.spdisplays_main === 'spdisplays_yes') {
    return check(
      'lab display',
      FAIL,
      `"${display._name}" is the main display. Make another display main.`
    )
  }
  return check(
    'lab display',
    PASS,
    `"${display._name}" ${display._spdisplays_resolution ?? ''}`.trim()
  )
}

export function evaluateBlackHole(profilerJson) {
  const devices = (profilerJson?.SPAudioDataType ?? []).flatMap((entry) => entry._items ?? [])
  const blackHole = devices.find((device) => /blackhole/i.test(device._name ?? ''))
  if (!blackHole) {
    return check(
      'blackhole',
      FAIL,
      'No BlackHole device. brew install blackhole-2ch, then restart Core Audio.'
    )
  }
  return blackHole.coreaudio_device_input
    ? check(
        'blackhole',
        PASS,
        `"${blackHole._name}", ${blackHole.coreaudio_device_input} input channels`
      )
    : check('blackhole', FAIL, `"${blackHole._name}" has no input channels.`)
}

export function evaluateTool(name, versionOutput, installHint) {
  const firstLine = String(versionOutput ?? '')
    .split('\n')[0]
    .trim()
  return firstLine
    ? check(name, PASS, firstLine.slice(0, 80))
    : check(name, FAIL, `Not found. ${installHint}`)
}

// Plan 178 U8: today's lab quota from the ledger (`ledger.today()`), or the
// error reading it. Warn from 75% of the cap, fail when nothing is left.
export const QUOTA_WARN_RATIO = 0.75

export function evaluateQuota(today, error = null) {
  if (error) return check('lab quota today', FAIL, error.message ?? String(error))
  const detail = `${today.units} of ${today.max} units spent (Pacific day ${today.day})`
  if (today.remaining <= 0) {
    return check('lab quota today', FAIL, `${detail}. Wait for midnight Pacific.`)
  }
  if (today.units >= today.max * QUOTA_WARN_RATIO) {
    return check('lab quota today', WARN, `${detail}. Plan runs around what is left.`)
  }
  return check('lab quota today', PASS, detail)
}

// ---------------------------------------------------------------------------
// Plan 178 U3: the lab machine section. Each check is a pure function over the
// text or JSON a command printed, so "fails clearly when broken on purpose"
// is tested here and only re-checked by eye on the lab Mac.

export const MIN_DISK_FREE_GB = 100

// `defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser`
export function evaluateAutoLogin(output, expectedUser) {
  const user = String(output ?? '')
    .split('\n')[0]
    .trim()
  if (!user || /does not exist/i.test(user)) {
    return check(
      'auto-login',
      FAIL,
      `Auto-login is off. System Settings > Users & Groups > Automatic login: ${expectedUser}.`
    )
  }
  return user === expectedUser
    ? check('auto-login', PASS, user)
    : check('auto-login', FAIL, `Auto-login user is "${user}", must be ${expectedUser}.`)
}

// `sysadminctl -screenLock status` (prints to stderr)
export function evaluateScreenLock(output) {
  // sysadminctl logs with a "<date> sysadminctl[pid:tid] " prefix; keep the
  // sentence only.
  const line = String(output ?? '')
    .split('\n')
    .map((entry) => entry.trim())
    .map((entry) => /screenLock.*/i.exec(entry)?.[0])
    .find(Boolean)
  if (!line) {
    return check(
      'screen lock',
      FAIL,
      'Could not read the screen lock state (sysadminctl -screenLock status).'
    )
  }
  return /screenLock is off/i.test(line)
    ? check('screen lock', PASS, 'off')
    : check(
        'screen lock',
        FAIL,
        `${line}. Turn it off: sysadminctl -screenLock off -password - (as the lab user).`
      )
}

function pmsetValue(output, key) {
  const match = new RegExp(`^\\s*${key}\\s+(\\d+)`, 'm').exec(String(output ?? ''))
  return match ? Number(match[1]) : null
}

// `pmset -g` (the active profile). Both the display and the system must never
// sleep: ScreenCaptureKit sees no display when the screen is off.
export function evaluateSleep(output) {
  const displaySleep = pmsetValue(output, 'displaysleep')
  const systemSleep = pmsetValue(output, 'sleep')
  if (displaySleep === null || systemSleep === null) {
    return check('sleep', FAIL, 'Could not read pmset -g (no displaysleep / sleep lines).')
  }
  const problems = []
  if (displaySleep !== 0) problems.push(`displaysleep is ${displaySleep} min`)
  if (systemSleep !== 0) problems.push(`sleep is ${systemSleep} min`)
  return problems.length
    ? check('sleep', FAIL, `${problems.join(', ')}. Fix: sudo pmset -a displaysleep 0 sleep 0.`)
    : check('sleep', PASS, 'display never, system never')
}

// `system_profiler -json SPDisplaysDataType`: at least one display online.
export function evaluateDisplayAwake(profilerJson) {
  const all = displays(profilerJson)
  if (all.length === 0) {
    return check('display awake', FAIL, 'No display attached. Plug in the HDMI dummy.')
  }
  const awake = all.filter(
    (entry) => !entry.spdisplays_online || entry.spdisplays_online === 'spdisplays_yes'
  )
  if (awake.length === 0) {
    return check(
      'display awake',
      FAIL,
      `Every display is asleep or offline (${all.map((entry) => `"${entry._name}"`).join(', ')}).`
    )
  }
  return check('display awake', PASS, awake.map((entry) => `"${entry._name}"`).join(', '))
}

// ~/Library/DoNotDisturb/DB/Assertions.json: a Focus is on while
// storeAssertionRecords is non-empty.
export function evaluateFocus(assertionsText) {
  let parsed
  try {
    parsed = JSON.parse(String(assertionsText ?? ''))
  } catch {
    return check(
      'focus',
      FAIL,
      'Focus is off (no Assertions.json). Turn on Do Not Disturb "until turned off".'
    )
  }
  const records = (parsed?.data ?? []).flatMap((entry) => entry?.storeAssertionRecords ?? [])
  if (records.length === 0) {
    return check('focus', FAIL, 'Focus is off. Turn on Do Not Disturb "until turned off".')
  }
  const mode = records[0]?.assertionDetails?.assertionDetailsModeIdentifier ?? 'a Focus mode'
  return check('focus', PASS, `${mode} on`)
}

// `df -k <dir>`: the Available column of the last line, in 1 K blocks.
export function evaluateDiskFree(dfOutput, minGb = MIN_DISK_FREE_GB) {
  const lines = String(dfOutput ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const columns = lines.length > 1 ? lines[lines.length - 1].split(/\s+/) : []
  const availableKb = Number(columns[3])
  if (!Number.isFinite(availableKb)) {
    return check('disk free', FAIL, 'Could not read df -k.')
  }
  const gb = availableKb / (1024 * 1024)
  const shown = `${gb.toFixed(0)} GB free`
  return gb >= minGb
    ? check('disk free', PASS, shown)
    : check('disk free', FAIL, `${shown}, need ${minGb} GB. Prune ~/videorc-live-lab/runs.`)
}

// `security find-identity -v -p codesigning`: the lab user's keychains must
// hold no Developer ID (the signing key never sits on the lab machine).
export function evaluateSigningIdentities(output) {
  const lines = String(output ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^\d+\)\s/.test(line))
  const developerId = lines.filter((line) => /Developer ID/i.test(line))
  if (developerId.length) {
    return check(
      'signing identity',
      FAIL,
      `${developerId.length} Developer ID identit${developerId.length === 1 ? 'y' : 'ies'} in the keychain. Delete it; candidates are signed in CI.`
    )
  }
  return lines.length
    ? check(
        'signing identity',
        WARN,
        `${lines.length} non-Developer-ID identit${lines.length === 1 ? 'y' : 'ies'} in the keychain.`
      )
    : check('signing identity', PASS, 'no code-signing identity in the keychain')
}

// loadPolicy()'s answer.
export function evaluatePolicyFile({ policy, problems, path }) {
  if (!policy) {
    return check('policy', FAIL, `${path}: ${problems.join('; ')}`)
  }
  const bits = [
    policy.enabled ? 'enabled' : 'DISABLED',
    `${policy.visibility.default}${policy.visibility.allowPublic ? ' (public allowed)' : ''}`,
    `${policy.onDemand.maxRunsPerDay} runs/day`,
    `${policy.onDemand.maxRunMinutes} min max`,
    `${policy.quota.labProjectMaxUnitsPerDay} lab units/day`,
    `schedule ${policy.schedule.enabled ? 'on' : 'off'}`,
    `clip pull ${policy.clipPull ? 'on' : 'off'}`
  ]
  return check('policy', policy.enabled ? PASS : WARN, `${path}: ${bits.join(', ')}`)
}

// `gh auth status` plus `gh repo view <repo> --json viewerPermission` for the
// reports repo (write: control.json, reports) and the main repo (issues).
export function evaluateGhAuth(statusOutput, repoAccess) {
  const status = String(statusOutput ?? '')
  const login = /Logged in to github\.com (?:account|as) ([^\s(]+)/i.exec(status)
  if (!login) {
    return check(
      'gh auth',
      FAIL,
      'gh is not logged in. Run gh auth login (as the lab user, a token scoped to the lab repos).'
    )
  }
  const scopes = /Token scopes:\s*(.+)/i.exec(status)?.[1]
  if (scopes && !/'repo'/.test(scopes) && !/\brepo\b/.test(scopes.replace(/'/g, ''))) {
    return check(
      'gh auth',
      FAIL,
      `Logged in as ${login[1]} but the token lacks the repo scope (${scopes.trim()}).`
    )
  }
  const problems = []
  for (const { name, json, needWrite } of repoAccess) {
    let permission = null
    try {
      permission = JSON.parse(String(json ?? ''))?.viewerPermission ?? null
    } catch {
      permission = null
    }
    if (!permission) {
      problems.push(`${name} not reachable`)
    } else if (needWrite && !['WRITE', 'MAINTAIN', 'ADMIN'].includes(permission)) {
      problems.push(`${name} is ${permission}, need WRITE`)
    }
  }
  return problems.length
    ? check('gh auth', FAIL, `Logged in as ${login[1]}; ${problems.join('; ')}.`)
    : check(
        'gh auth',
        PASS,
        `${login[1]}; ${repoAccess.map((entry) => `${entry.name} ${entry.needWrite ? 'write' : 'read'}`).join(', ')}`
      )
}

// fetchControlFromUrl()'s answer, or the error it threw.
export function evaluateKillSwitch(url, outcome) {
  if (outcome?.error) {
    return check('kill switch', FAIL, `${url} unreachable: ${outcome.error}`)
  }
  return outcome?.enabled
    ? check('kill switch', PASS, `${url} says enabled: true`)
    : check(
        'kill switch',
        WARN,
        `${url} says enabled: false. Runs are refused until the owner flips it.`
      )
}

// readRunLock()'s answer plus whether the holder's PID is alive.
export function evaluateRunLock(lock, alive) {
  if (lock === null) return check('run lock', PASS, 'free')
  if (lock.corrupt) {
    return check(
      'run lock',
      FAIL,
      `${lock.path} unreadable (${lock.reason}). Remove it by hand after checking nothing is live.`
    )
  }
  return alive
    ? check('run lock', WARN, `held by ${lock.runId} (pid ${lock.pid}, since ${lock.startedAt})`)
    : check(
        'run lock',
        WARN,
        `stale: ${lock.runId} (pid ${lock.pid} is dead). The next run clears it.`
      )
}

export function evaluateStopFile(path, present) {
  return present
    ? check('stop file', WARN, `${path} present. Every run is refused until it is removed.`)
    : check('stop file', PASS, 'absent')
}

// Plan 178 U13: between runs the lab's pf anchor must hold no rule and its
// dummynet pipe must not exist. `pfRules` and `dnctlList` are the read-backs
// (`pfctl -a <anchor> -s rules`, `dnctl list`), null when sudo refused them.
// `networkFaults` is the policy flag, `pfConf` the text of /etc/pf.conf (the
// anchor must be hooked there for a fault to bite), `cleaned` says the doctor
// already flushed a leftover this run.
export function evaluateNetFaultsClean(
  pfRules,
  dnctlList,
  { networkFaults = null, pfConf = null, cleaned = false } = {}
) {
  const name = 'network faults'
  if (pfRules === null || dnctlList === null) {
    return networkFaults
      ? check(
          name,
          FAIL,
          'faults.network is on but sudo refused the read-back. Install config/live-lab/sudoers.live-lab.example (owner step).'
        )
      : check(name, SKIP, 'faults.network is off and the sudoers file is not installed.')
  }
  const residue = netFaultResidue({ pfRules, dnctlList })
  if (!residueIsClean(residue)) {
    const parts = []
    if (residue.rules.length) parts.push(`${residue.rules.length} rule(s) in anchor ${PF_ANCHOR}`)
    if (residue.pipes.length) parts.push(`pipe ${DN_PIPE} still configured`)
    return check(
      name,
      FAIL,
      `${parts.join(', ')}: a fault outlived its run. Run: ${cleanupCommandLines().join(' && ')}`
    )
  }
  if (networkFaults && pfConf !== null) {
    const hooks = pfConfHooksAnchor(pfConf)
    const missing = [
      hooks.dummynetAnchor ? null : `dummynet-anchor "${PF_ANCHOR}"`,
      hooks.anchor ? null : `anchor "${PF_ANCHOR}"`
    ].filter(Boolean)
    if (missing.length) {
      return check(
        name,
        FAIL,
        `${PF_CONF} lacks ${missing.join(' and ')}; faults would load into an anchor pf never consults. See config/live-lab/pf.anchor.example.`
      )
    }
  }
  if (cleaned) {
    return check(
      name,
      WARN,
      'a leftover fault was flushed by this doctor run. The previous run leaked; read its log.'
    )
  }
  const detail = `anchor ${PF_ANCHOR} empty, pipe ${DN_PIPE} absent${
    networkFaults ? `, ${PF_CONF} hooks the anchor` : ''
  }`
  return check(name, PASS, detail)
}

export function summarize(results) {
  const counts = { [PASS]: 0, [WARN]: 0, [FAIL]: 0, [SKIP]: 0 }
  for (const result of results) counts[result.status] += 1
  return { counts, ok: counts[FAIL] === 0 }
}

export function formatResult({ name, status, detail }) {
  return `${status.padEnd(4)}  ${name.padEnd(22)} ${detail}`
}
