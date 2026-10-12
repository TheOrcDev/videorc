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
  LINUX_NETFAULT_HELPER,
  LINUX_NFT_TABLE,
  LINUX_QDISC_HANDLE,
  PF_ANCHOR,
  PF_CONF,
  cleanupCommandLines,
  linuxCleanupCommandLines,
  linuxNetFaultResidue,
  netFaultResidue,
  pfConfHooksAnchor,
  residueIsClean
} from './net-fault.mjs'
import {
  LAB_MIC_DESCRIPTION,
  LAB_MIC_SOURCE,
  LAB_SPEECH_SINK,
  outputBounds,
  parsePulseDevices,
  pickLabOutput,
  sessionProblems
} from './linux-desktop.mjs'

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

// Plan 179: the Linux twin of evaluateNetFaultsClean. `statusText` is the
// helper's `status` read-back (null when sudo refused it), `helper` the stat
// of LINUX_NETFAULT_HELPER: { present, rootOwned, writable } (null when not
// inspected). A helper the lab user could change is a FAIL whatever the
// policy says: sudoers would run any code put there as root.
export function evaluateLinuxNetFaultsClean(
  statusText,
  { networkFaults = null, cleaned = false, helper = null } = {}
) {
  const name = 'network faults'
  if (helper?.present && (!helper.rootOwned || helper.writable)) {
    return check(
      name,
      FAIL,
      `${LINUX_NETFAULT_HELPER} is ${helper.writable ? 'writable by the lab user' : 'not owned by root'}; reinstall it: sudo install -o root -g root -m 0755 config/live-lab/linux/videorc-lab-netfault ${LINUX_NETFAULT_HELPER}`
    )
  }
  if (statusText === null) {
    if (!networkFaults) {
      return check(name, SKIP, 'faults.network is off and the sudoers file is not installed.')
    }
    return check(
      name,
      FAIL,
      helper && !helper.present
        ? `faults.network is on but ${LINUX_NETFAULT_HELPER} is missing. Install config/live-lab/linux/videorc-lab-netfault and its sudoers file (owner step).`
        : 'faults.network is on but sudo refused the read-back. Install config/live-lab/linux/sudoers.live-lab.example (owner step).'
    )
  }
  const residue = linuxNetFaultResidue(statusText)
  if (!residueIsClean(residue)) {
    const parts = []
    if (residue.rules.length) parts.push(`nft table ${LINUX_NFT_TABLE} present`)
    if (residue.pipes.length) {
      parts.push(`qdisc ${LINUX_QDISC_HANDLE} on ${residue.pipes.length} interface(s)`)
    }
    return check(
      name,
      FAIL,
      `${parts.join(', ')}: a fault outlived its run. Run: ${linuxCleanupCommandLines().join(' && ')}`
    )
  }
  if (cleaned) {
    return check(
      name,
      WARN,
      'a leftover fault was flushed by this doctor run. The previous run leaked; read its log.'
    )
  }
  return check(name, PASS, `nft table ${LINUX_NFT_TABLE} absent, no ${LINUX_QDISC_HANDLE} qdisc`)
}

// ---------------------------------------------------------------------------
// Plan 179: the Linux lab. Same rules as the macOS checks above (pure
// verdicts over what a command printed), different evidence: Hyprland's
// monitors instead of system_profiler, Pulse devices instead of Core Audio,
// systemd and the display manager instead of pmset and loginwindow.

const LINUX_FIX_DOC = 'see docs/live-lab-machine.md (Linux)'

// labSessionEnv()'s answer: the Wayland/Hyprland/D-Bus variables the app,
// Chrome and the portal need.
export function evaluateLinuxSession(sessionEnv) {
  const problems = sessionProblems(sessionEnv ?? {})
  if (problems.length) {
    return check(
      'desktop session',
      FAIL,
      `${problems.join(', ')}. The Linux lab needs a logged-in Hyprland session (auto-login) for the portal and the lab output; ${LINUX_FIX_DOC}.`
    )
  }
  return check(
    'desktop session',
    PASS,
    `Hyprland on ${sessionEnv.WAYLAND_DISPLAY} (${sessionEnv.XDG_CURRENT_DESKTOP ?? 'desktop unknown'})`
  )
}

// `hyprctl -j monitors all` (or the error reading it): the lab output must
// exist, be enabled and powered, and should not hold focus (new windows and
// notifications go to the focused output).
export function evaluateLinuxLabDisplay(monitors, configuredName, error = null) {
  if (error) {
    return check(
      'lab display',
      FAIL,
      `Could not read Hyprland's outputs: ${error.message ?? error}`
    )
  }
  const picked = pickLabOutput(monitors, configuredName)
  if (!picked.output) {
    return check('lab display', FAIL, `${picked.problem} Outputs seen: ${picked.seen}.`)
  }
  const output = picked.output
  if (output.disabled) {
    return check(
      'lab display',
      FAIL,
      `"${output.name}" is disabled. Enable it in the monitor rule.`
    )
  }
  if (output.dpmsStatus === false) {
    return check(
      'lab display',
      FAIL,
      `"${output.name}" is off (DPMS). hyprctl dispatch dpms on ${output.name}`
    )
  }
  const bounds = outputBounds(output)
  const shown = `"${output.name}" ${bounds.width}x${bounds.height}`
  if (bounds.width < 1280 || bounds.height < 720) {
    return check('lab display', FAIL, `${shown} is too small; set 1920x1080 in its monitor rule.`)
  }
  const enabled = (Array.isArray(monitors) ? monitors : []).filter((entry) => !entry.disabled)
  if (bounds.focused && enabled.length > 1) {
    return check(
      'lab display',
      WARN,
      `${shown} has focus; notifications and new windows land there. Focus another output.`
    )
  }
  return check('lab display', PASS, shown)
}

// The ScreenCast grant. Every Linux run deletes the lab profile's portal
// restore token (session.mjs preparePortalGrant), so the only grant a run
// gets is the lab share picker's. `xdphConf` is ~/.config/hypr/xdph.conf (or
// null), `picker` the configured binary: { path, executable, isLabPicker }
// (null when not inspected), `fallback` whether hyprland-share-picker is on
// PATH (what the lab picker hands every other app to).
export function parseXdphPicker(xdphConf) {
  return /^\s*custom_picker_binary\s*=\s*(\S+)/m.exec(String(xdphConf ?? ''))?.[1] ?? null
}

export function evaluateLinuxScreenGrant({ xdphConf, picker, fallback }) {
  const name = 'screen grant'
  const fix = `Install config/live-lab/linux/videorc-lab-share-picker and point xdph at it (config/live-lab/linux/xdph.conf.example); ${LINUX_FIX_DOC}.`
  const configured = parseXdphPicker(xdphConf)
  if (!configured) {
    return check(
      name,
      FAIL,
      `xdg-desktop-portal-hyprland has no custom_picker_binary, so a run would wait on the share dialog. ${fix}`
    )
  }
  if (!picker?.executable) {
    return check(
      name,
      FAIL,
      `custom_picker_binary ${configured} is missing or not executable. ${fix}`
    )
  }
  if (!picker.isLabPicker) {
    return check(
      name,
      FAIL,
      `custom_picker_binary ${configured} is not the lab share picker (it never reads portal-pick). ${fix}`
    )
  }
  if (!fallback) {
    return check(
      name,
      WARN,
      `${configured} is the lab picker, but hyprland-share-picker is not on PATH: other apps get no picker. Install xdg-desktop-portal-hyprland's picker.`
    )
  }
  return check(name, PASS, `lab share picker ${configured}; no restore token is ever reused`)
}

// `ffmpeg -hide_banner -sinks pulse` and `-sources pulse`: the speech sink
// and the lab mic must exist, and the mic must not be the system default
// (a default mic is what other apps on the box would open).
export function evaluateLinuxLabAudio(sinksText, sourcesText) {
  const sinks = parsePulseDevices(sinksText, { dropMonitors: false })
  const sources = parsePulseDevices(sourcesText)
  const sink = sinks.find((entry) => entry.name === LAB_SPEECH_SINK)
  const mic = sources.find((entry) => entry.name === LAB_MIC_SOURCE)
  const fix = `Load the lab devices: config/live-lab/linux/pipewire-pulse.videorc-lab.conf; ${LINUX_FIX_DOC}.`
  if (!sink && !mic) {
    return check(
      'lab audio',
      FAIL,
      `No ${LAB_SPEECH_SINK} sink and no ${LAB_MIC_SOURCE} source. ${fix}`
    )
  }
  if (!sink) return check('lab audio', FAIL, `No ${LAB_SPEECH_SINK} sink. ${fix}`)
  if (!mic) {
    return check(
      'lab audio',
      FAIL,
      `No ${LAB_MIC_SOURCE} source (a monitor never counts: Videorc hides monitors). ${fix}`
    )
  }
  const defaultSink = sinks.find((entry) => entry.isDefault)
  if (mic.isDefault || defaultSink?.name === LAB_SPEECH_SINK) {
    return check(
      'lab audio',
      FAIL,
      `${mic.isDefault ? LAB_MIC_SOURCE : LAB_SPEECH_SINK} is the system default; other apps would use it. Set a real device as default (pactl set-default-${mic.isDefault ? 'source' : 'sink'} <name>).`
    )
  }
  return check(
    'lab audio',
    PASS,
    `speech sink ${LAB_SPEECH_SINK}, mic "${mic.description || LAB_MIC_DESCRIPTION}" (${LAB_MIC_SOURCE})`
  )
}

// `systemctl is-enabled sleep.target suspend.target hibernate.target
// hybrid-sleep.target`: one word per line, all must be `masked` (that also
// stops a lid close from suspending: logind starts suspend.target).
export const LINUX_SLEEP_TARGETS = Object.freeze([
  'sleep.target',
  'suspend.target',
  'hibernate.target',
  'hybrid-sleep.target'
])

export function evaluateLinuxSleep(output) {
  const states = String(output ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  if (states.length !== LINUX_SLEEP_TARGETS.length) {
    return check('sleep', FAIL, 'Could not read the sleep targets (systemctl is-enabled).')
  }
  const awake = LINUX_SLEEP_TARGETS.filter((_, index) => states[index] !== 'masked')
  return awake.length
    ? check(
        'sleep',
        FAIL,
        `${awake.join(', ')} not masked. Fix: sudo systemctl mask ${LINUX_SLEEP_TARGETS.join(' ')}`
      )
    : check('sleep', PASS, 'sleep, suspend and hibernate masked')
}

// Whether hypridle / hyprlock run in the lab session ({ hypridle, hyprlock }
// booleans). A locked session draws the lock screen on every output,
// including the lab output; hypridle locks and powers outputs off between
// runs (runs themselves hold a systemd idle inhibitor).
export function evaluateLinuxScreenLock({ hypridle, hyprlock }) {
  if (hyprlock) {
    return check(
      'screen lock',
      FAIL,
      'The session is locked (hyprlock runs). Unlock it at the console.'
    )
  }
  if (hypridle) {
    return check(
      'screen lock',
      FAIL,
      'hypridle runs and would lock the session or turn the outputs off between runs. Stop it for the lab user (Omarchy: remove it from autostart).'
    )
  }
  return check('screen lock', PASS, 'no idle locker running')
}

// Which notification daemon runs and whether it is in Do Not Disturb:
// { daemon: 'mako' | 'dunst' | 'swaync' | null, output }. mako: `makoctl
// mode` lists do-not-disturb; dunst: `dunstctl is-paused` says true;
// swaync: `swaync-client -D` says true.
export function evaluateLinuxNotifications({ daemon, output }) {
  const text = String(output ?? '').trim()
  if (!daemon) {
    return check(
      'focus',
      WARN,
      'No known notification daemon (mako, dunst, swaync) found; check nothing can draw on the lab output.'
    )
  }
  const quiet = daemon === 'mako' ? /\bdo-not-disturb\b/.test(text) : /^true$/m.test(text)
  if (quiet) return check('focus', PASS, `${daemon}: do not disturb`)
  const fix = {
    mako: 'makoctl mode -a do-not-disturb',
    dunst: 'dunstctl set-paused true',
    swaync: 'swaync-client -dn'
  }[daemon]
  return check('focus', FAIL, `${daemon} shows notifications. Turn on do not disturb: ${fix}`)
}

// The display manager's auto-login: `files` maps a path to its text (SDDM
// conf, greetd config, getty override). PASS when one of them logs `user`
// in without a password.
export function evaluateLinuxAutoLogin(files, user) {
  const found = []
  for (const [path, text] of Object.entries(files ?? {})) {
    const body = String(text ?? '')
    if (/sddm/.test(path)) {
      const block = /^\s*\[Autologin\]([\s\S]*?)(?=^\s*\[|(?![\s\S]))/m.exec(body)?.[1] ?? ''
      const named = /^\s*User\s*=\s*(\S+)/m.exec(block)?.[1]
      if (named) found.push({ path, user: named })
    } else if (/greetd/.test(path)) {
      const block = /^\s*\[initial_session\]([\s\S]*?)(?=^\s*\[|(?![\s\S]))/m.exec(body)?.[1] ?? ''
      const named = /^\s*user\s*=\s*"?([^"\s]+)"?/m.exec(block)?.[1]
      if (named) found.push({ path, user: named })
    } else {
      const named = /--autologin\s+(\S+)/.exec(body)?.[1]
      if (named) found.push({ path, user: named })
    }
  }
  if (found.length === 0) {
    return check(
      'auto-login',
      FAIL,
      `Nothing logs ${user} in at boot (no SDDM [Autologin], greetd initial_session or getty --autologin). ${LINUX_FIX_DOC}.`
    )
  }
  const mine = found.find((entry) => entry.user === user)
  return mine
    ? check('auto-login', PASS, `${user} (${mine.path})`)
    : check(
        'auto-login',
        FAIL,
        `Auto-login user is "${found[0].user}" (${found[0].path}), must be ${user}.`
      )
}

// `loginctl show-user <user> -p Linger`: with linger the user manager (and
// the schedule timer) starts at boot and survives a logout.
export function evaluateLinuxLinger(output, user) {
  const value = /^Linger=(yes|no)$/m.exec(String(output ?? ''))?.[1]
  if (value === 'yes') return check('linger', PASS, `${user}: yes`)
  return check(
    'linger',
    WARN,
    `${value ? 'off' : 'unknown'}: the schedule timer stops when the session ends. Fix: sudo loginctl enable-linger ${user}`
  )
}

// `lsblk -n -o TYPE`: a LUKS volume means every boot waits for the
// passphrase at the console, so a reboot (weekly, or after a power cut)
// ends unattended operation until someone types it.
export function evaluateLinuxUnattendedBoot(lsblkTypes) {
  const encrypted = String(lsblkTypes ?? '')
    .split('\n')
    .some((line) => line.trim() === 'crypt')
  return encrypted
    ? check(
        'unattended boot',
        WARN,
        'The disk is LUKS-encrypted: a reboot waits for the passphrase at the console. Skip the weekly reboot timer, or unlock with a TPM (systemd-cryptenroll --tpm2-device=auto).'
      )
    : check('unattended boot', PASS, 'no passphrase at boot')
}

// `sudo -n -l` (stdout+stderr) and `id -Gn`. The policy is only the owner's
// if the lab user cannot become root: passwordless sudo for anything beyond
// the fault helper is a FAIL; an admin group with a password is a WARN.
export function evaluateLinuxSudo(sudoList, groups, user) {
  const text = String(sudoList ?? '')
  const lines = text.split('\n').map((line) => line.trim())
  const unrestricted = lines.some((line) =>
    /^\((?:ALL|root)(?:\s*:\s*\S+)?\)\s+NOPASSWD:\s*ALL\s*$/i.test(line)
  )
  if (unrestricted) {
    return check(
      'lab user rights',
      FAIL,
      `${user} has passwordless sudo for everything, so anything running as it can rewrite the policy. Remove it from the NOPASSWD rule; only config/live-lab/linux/sudoers.live-lab.example may stay.`
    )
  }
  const admin = String(groups ?? '')
    .split(/\s+/)
    .filter((group) => ['wheel', 'sudo', 'admin'].includes(group))
  if (admin.length) {
    return check(
      'lab user rights',
      WARN,
      `${user} is in ${admin.join(', ')} (sudo with a password). Nothing unattended can use it, but a dedicated non-admin lab account is the safe setup.`
    )
  }
  return check('lab user rights', PASS, `${user} cannot become root`)
}

export function summarize(results) {
  const counts = { [PASS]: 0, [WARN]: 0, [FAIL]: 0, [SKIP]: 0 }
  for (const result of results) counts[result.status] += 1
  return { counts, ok: counts[FAIL] === 0 }
}

export function formatResult({ name, status, detail }) {
  return `${status.padEnd(4)}  ${name.padEnd(22)} ${detail}`
}
