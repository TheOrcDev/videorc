import {
  DIR_MODE,
  FILE_MODE,
  STREAM_KEY_SLOTS,
  fingerprint,
  formatMode,
  sameHandle
} from './config.mjs'

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

export function summarize(results) {
  const counts = { [PASS]: 0, [WARN]: 0, [FAIL]: 0, [SKIP]: 0 }
  for (const result of results) counts[result.status] += 1
  return { counts, ok: counts[FAIL] === 0 }
}

export function formatResult({ name, status, detail }) {
  return `${status.padEnd(4)}  ${name.padEnd(22)} ${detail}`
}
