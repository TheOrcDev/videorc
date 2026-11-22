import { execFile } from 'node:child_process'
import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'

import { decodeMarkers } from './card-markers.mjs'

// Plan 179. The Linux lab's desktop: a Hyprland session (Omarchy on ogre)
// with a headless output as the lab display, xdg-desktop-portal-hyprland for
// the ScreenCast grant, and two PipeWire/Pulse devices for the audio:
//
//   videorc_lab_speech   a null sink. The harness plays scripted speech into
//                        it, and the card's Chrome plays its sync click into
//                        it (PULSE_SINK), so nothing reaches the speakers.
//   videorc_lab_mic      a remap source over videorc_lab_speech.monitor. It is
//                        a real source (no `.monitor` suffix), so Videorc
//                        lists it as a microphone (linux_pulse_audio.rs drops
//                        monitors). Linux Videorc has no system-audio capture,
//                        so the click and the speech both arrive on this mic.
//
// Videorc captures screens on Linux only through the ScreenCast portal (no
// x11grab, no output enumeration: linux_portal_capture.rs), which is why the
// lab display is a compositor output and not an Xvfb server. The harness may
// run from SSH or a systemd user unit, where the graphical session's
// variables are missing; labSessionEnv() finds them.

const execFileAsync = promisify(execFile)

export const LAB_SPEECH_SINK = 'videorc_lab_speech'
export const LAB_MIC_SOURCE = 'videorc_lab_mic'
export const LAB_MIC_DESCRIPTION = 'Videorc-Lab-Mic'
export const DEFAULT_LAB_OUTPUT = 'videorc-lab'
// Written by the harness for the length of a session; the lab share picker
// (config/live-lab/linux/videorc-lab-share-picker) answers the portal with
// the output named in it, and defers to the normal picker when it is absent.
// Always under the home's default work dir, whatever VIDEORC_LIVE_LAB_WORK_DIR
// says: the picker runs in xdph's environment, not the harness's, and the two
// must agree on one path.
export const PORTAL_PICK_FILE = 'portal-pick'

export function portalPickPath(home = homedir()) {
  return join(home, 'videorc-live-lab', PORTAL_PICK_FILE)
}

export const SESSION_VARS = Object.freeze([
  'WAYLAND_DISPLAY',
  'HYPRLAND_INSTANCE_SIGNATURE',
  'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS',
  'XDG_CURRENT_DESKTOP',
  'XDG_SESSION_TYPE',
  'DISPLAY'
])

export async function defaultExec(command, args, options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      timeout: 15_000,
      maxBuffer: 16 * 1024 * 1024,
      ...options
    })
    return { code: 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }
  } catch (error) {
    return {
      code: typeof error.code === 'number' ? error.code : 127,
      stdout: String(error.stdout ?? ''),
      stderr: String(error.stderr ?? error.message ?? '')
    }
  }
}

/** `systemctl --user show-environment` lines into an object (pure). */
export function parseEnvironmentBlock(text) {
  const env = {}
  for (const line of String(text ?? '').split('\n')) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim())
    if (match) env[match[1]] = match[2]
  }
  return env
}

/**
 * The graphical session's variables, for a harness started from SSH or a
 * systemd user unit. Order: what this process already has, then the user
 * manager's environment (uwsm imports the Hyprland session into it), then
 * the conventional /run/user/<uid> paths. Only SESSION_VARS are returned.
 */
export async function labSessionEnv({
  env = process.env,
  exec = defaultExec,
  uid = process.getuid?.() ?? null,
  listDir = (path) => readdir(path)
} = {}) {
  const result = {}
  for (const name of SESSION_VARS) if (env[name]) result[name] = env[name]
  const missing = SESSION_VARS.some((name) => !result[name])
  if (missing) {
    const shown = await exec('systemctl', ['--user', 'show-environment'])
    if (shown.code === 0) {
      const manager = parseEnvironmentBlock(shown.stdout)
      for (const name of SESSION_VARS)
        if (!result[name] && manager[name]) result[name] = manager[name]
    }
  }
  if (!result.XDG_RUNTIME_DIR && uid !== null) result.XDG_RUNTIME_DIR = `/run/user/${uid}`
  const runtime = result.XDG_RUNTIME_DIR
  if (runtime && !result.DBUS_SESSION_BUS_ADDRESS) {
    result.DBUS_SESSION_BUS_ADDRESS = `unix:path=${runtime}/bus`
  }
  if (runtime && (!result.WAYLAND_DISPLAY || !result.HYPRLAND_INSTANCE_SIGNATURE)) {
    const names = await listDir(runtime).catch(() => [])
    if (!result.WAYLAND_DISPLAY) {
      const sockets = names.filter((name) => /^wayland-\d+$/.test(name)).sort()
      if (sockets.length === 1) result.WAYLAND_DISPLAY = sockets[0]
    }
    if (!result.HYPRLAND_INSTANCE_SIGNATURE && names.includes('hypr')) {
      const instances = (await listDir(join(runtime, 'hypr')).catch(() => [])).filter(
        (name) => !name.startsWith('.')
      )
      if (instances.length === 1) result.HYPRLAND_INSTANCE_SIGNATURE = instances[0]
    }
  }
  return result
}

export function sessionProblems(sessionEnv) {
  const problems = []
  if (!sessionEnv.WAYLAND_DISPLAY) problems.push('no Wayland session (WAYLAND_DISPLAY)')
  if (!sessionEnv.HYPRLAND_INSTANCE_SIGNATURE) {
    problems.push('no Hyprland instance (HYPRLAND_INSTANCE_SIGNATURE)')
  }
  if (!sessionEnv.DBUS_SESSION_BUS_ADDRESS) problems.push('no session bus')
  return problems
}

/** `hyprctl -j <args>` parsed, or throws with hyprctl's own words. */
export async function hyprctlJson(args, { sessionEnv, exec = defaultExec } = {}) {
  const result = await exec('hyprctl', ['-j', ...args], {
    env: { ...process.env, ...sessionEnv }
  })
  if (result.code !== 0) {
    throw new Error(`hyprctl ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`)
  }
  try {
    return JSON.parse(result.stdout)
  } catch {
    throw new Error(
      `hyprctl ${args.join(' ')} printed no JSON: ${result.stdout.trim().slice(0, 120)}`
    )
  }
}

// A Hyprland configured in Lua (hyprland.lua, Omarchy since Hyprland 0.56)
// reads `hyprctl dispatch <x>` as Lua: `focusmonitor eDP-1` comes back as a
// syntax error in `return hl.dispatch(focusmonitor eDP-1)`. Nothing ran, so
// the same dispatch is sent again in the Lua form.
const LUA_DISPATCH_REFUSAL = /hl\.dispatch\(/

function luaString(value) {
  if ([...value].some((char) => char < ' ')) return null
  return `"${value.replace(/[\\"]/g, '\\$&')}"`
}

/**
 * The Lua form of the legacy dispatches the harness sends (pure), or null for
 * any other. `fullscreen` keeps the legacy toggle, like Omarchy's Super+F.
 */
export function luaDispatch(args) {
  const [dispatcher, argument = ''] = args
  if (dispatcher === 'focusmonitor') {
    const monitor = luaString(argument)
    return monitor && `hl.dsp.focus({ monitor = ${monitor} })`
  }
  if (dispatcher === 'focuswindow') {
    const window = luaString(argument)
    return window && `hl.dsp.focus({ window = ${window} })`
  }
  if (dispatcher === 'fullscreen') {
    const mode = { 0: 'fullscreen', 1: 'maximized' }[argument]
    return mode ? `hl.dsp.window.fullscreen({ mode = "${mode}" })` : null
  }
  if (dispatcher === 'movetoworkspacesilent') {
    const comma = argument.indexOf(',')
    const workspace = luaString(comma === -1 ? argument : argument.slice(0, comma))
    if (!workspace) return null
    if (comma === -1) return `hl.dsp.window.move({ workspace = ${workspace}, follow = false })`
    const window = luaString(argument.slice(comma + 1))
    return (
      window &&
      `hl.dsp.window.move({ workspace = ${workspace}, window = ${window}, follow = false })`
    )
  }
  return null
}

export async function hyprctlDispatch(args, { sessionEnv, exec = defaultExec } = {}) {
  const send = async (dispatchArgs) => {
    const result = await exec('hyprctl', ['dispatch', ...dispatchArgs], {
      env: { ...process.env, ...sessionEnv }
    })
    const said = `${result.stdout}${result.stderr}`.trim()
    return {
      ok: result.code === 0 && (!said || said === 'ok'),
      said: said || `exit ${result.code}`
    }
  }
  let sent = await send(args)
  if (sent.ok) return
  const lua = LUA_DISPATCH_REFUSAL.test(sent.said) ? luaDispatch(args) : null
  if (lua) {
    sent = await send([lua])
    if (sent.ok) return
    throw new Error(`hyprctl dispatch '${lua}': ${sent.said}`)
  }
  throw new Error(`hyprctl dispatch ${args.join(' ')}: ${sent.said}`)
}

const HEADLESS_OUTPUT = /^headless-\d+$|videorc|lab/i

/**
 * The lab output among `hyprctl -j monitors all` (pure). The named one when
 * configured, else the single headless/lab-named output. Returns
 * { output } or { problem, seen }.
 */
export function pickLabOutput(monitors, configuredName) {
  const all = Array.isArray(monitors) ? monitors : []
  const seen = all.map((entry) => `"${entry.name}"`).join(', ') || 'none'
  const candidates = configuredName
    ? all.filter((entry) => entry.name === configuredName)
    : all.filter((entry) => HEADLESS_OUTPUT.test(entry.name ?? ''))
  if (candidates.length === 0) {
    return {
      problem: configuredName
        ? `No Hyprland output named "${configuredName}".`
        : 'No headless output. Create one: hyprctl output create headless videorc-lab (and a monitor rule, see docs/live-lab-machine.md), then pnpm live:hookup --lab-display videorc-lab.',
      seen
    }
  }
  if (candidates.length > 1) {
    return {
      problem: `Several candidates (${candidates.map((entry) => `"${entry.name}"`).join(', ')}). Pick one with --lab-display.`,
      seen
    }
  }
  return { output: candidates[0], seen }
}

/** Bounds of the lab output in the shape launch.mjs uses on macOS. */
export function outputBounds(output) {
  return {
    name: output.name,
    x: Math.round(output.x ?? 0),
    y: Math.round(output.y ?? 0),
    width: Math.round(output.width ?? 0),
    height: Math.round(output.height ?? 0),
    isMain: false,
    id: output.id,
    focused: Boolean(output.focused),
    activeWorkspaceId: output.activeWorkspace?.id ?? null
  }
}

export async function linuxLabOutputBounds(name, { sessionEnv, exec = defaultExec } = {}) {
  const picked = pickLabOutput(await hyprctlJson(['monitors', 'all'], { sessionEnv, exec }), name)
  if (!picked.output) throw new Error(`${picked.problem} Outputs seen: ${picked.seen}.`)
  const { output } = picked
  if (output.disabled) throw new Error(`The lab output "${output.name}" is disabled.`)
  if (output.dpmsStatus === false) throw new Error(`The lab output "${output.name}" is off (DPMS).`)
  return outputBounds(output)
}

/** The client (window) that `pid` owns, from `hyprctl -j clients` (pure). */
export function clientForPid(clients, pid) {
  return (Array.isArray(clients) ? clients : []).find((entry) => entry.pid === pid) ?? null
}

/**
 * Puts the card's Chrome window on the lab output, fullscreen. Chrome is
 * spawned while the lab output has focus (focusLabOutput), so it maps there;
 * this waits for the window, moves it there if it mapped elsewhere, makes it
 * fullscreen if it is not, and gives focus back to the output that had it.
 * Returns what it saw; the caller refuses anything short of both.
 */
export async function placeCardWindow({
  pid,
  bounds,
  previousOutput,
  sessionEnv,
  exec = defaultExec,
  wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms)),
  deadlineMs = 20_000,
  intervalMs = 250
}) {
  let client = null
  for (let waited = 0; waited <= deadlineMs; waited += intervalMs) {
    client = clientForPid(await hyprctlJson(['clients'], { sessionEnv, exec }).catch(() => []), pid)
    if (client) break
    await wait(intervalMs)
  }
  if (!client)
    throw new Error(`The card window (pid ${pid}) did not appear within ${deadlineMs / 1000} s.`)
  if (client.monitor !== bounds.id && bounds.activeWorkspaceId !== null) {
    await hyprctlDispatch(['movetoworkspacesilent', `${bounds.activeWorkspaceId},pid:${pid}`], {
      sessionEnv,
      exec
    })
    client = clientForPid(await hyprctlJson(['clients'], { sessionEnv, exec }), pid) ?? client
  }
  if (!client.fullscreen) {
    // `fullscreen` toggles the focused window, so it is only sent when the
    // window is not fullscreen yet, and only after focusing that window.
    await hyprctlDispatch(['focuswindow', `pid:${pid}`], { sessionEnv, exec })
    await hyprctlDispatch(['fullscreen', '0'], { sessionEnv, exec })
    client = clientForPid(await hyprctlJson(['clients'], { sessionEnv, exec }), pid) ?? client
  }
  if (previousOutput && previousOutput !== bounds.name) {
    await hyprctlDispatch(['focusmonitor', previousOutput], { sessionEnv, exec }).catch(() => {})
  }
  return {
    onLabOutput: client.monitor === bounds.id,
    fullscreen: Boolean(client.fullscreen),
    size: client.size ?? null
  }
}

/** Focuses the lab output and returns the name of the output that had focus. */
export async function focusLabOutput(bounds, { sessionEnv, exec = defaultExec } = {}) {
  const monitors = await hyprctlJson(['monitors'], { sessionEnv, exec })
  const previous = (Array.isArray(monitors) ? monitors : []).find((entry) => entry.focused)
  if (!previous || previous.name !== bounds.name) {
    await hyprctlDispatch(['focusmonitor', bounds.name], { sessionEnv, exec })
  }
  return previous?.name ?? null
}

/**
 * `ffmpeg -hide_banner -sources pulse` / `-sinks pulse` (pure). Lines are
 * `  name [description] (none)`, a default one starts with `*`. The rules for
 * sources match parse_pulse_sources in linux_pulse_audio.rs exactly, so the
 * doctor sees the microphones Videorc will list.
 */
export function parsePulseDevices(text, { dropMonitors = true } = {}) {
  const devices = []
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.replace(/\s+$/, '')
    let rest
    let isDefault = false
    if (line.trimStart().startsWith('*')) {
      isDefault = true
      rest = line.trimStart().slice(1).trimStart()
    } else if (line.startsWith(' ')) {
      rest = line.trimStart()
    } else continue
    const split = rest.indexOf(' [')
    if (split === -1) continue
    const name = rest.slice(0, split).trim()
    const tail = rest.slice(split + 2)
    const end = tail.lastIndexOf('] (')
    const description =
      end === -1 ? (tail.endsWith(']') ? tail.slice(0, -1) : null) : tail.slice(0, end)
    if (description === null) continue
    if (!name || /\s/.test(name) || (dropMonitors && name.endsWith('.monitor'))) continue
    devices.push({ name, description: description.trim(), isDefault })
  }
  return devices
}

/** The first executable named in `names` on PATH, or null. */
export async function findOnPath(names, { env = process.env, statFn = stat } = {}) {
  for (const dir of String(env.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)) {
    for (const name of names) {
      const candidate = join(dir, name)
      try {
        const entry = await statFn(candidate)
        if (entry.isFile() && (entry.mode & 0o111) !== 0) return candidate
      } catch {
        // Not here.
      }
    }
  }
  return null
}

export const CHROME_NAMES = Object.freeze([
  'google-chrome-stable',
  'google-chrome',
  'chromium',
  'chromium-browser'
])

// ---------------------------------------------------------------------------
// Plan 257 S0. A locked session draws its lock screen on every output, the
// lab output included, so a run under a lock streams the lock screen as if it
// were the test card. The lock is read from the compositor and logind, not
// from a process name: ogre's locker is omarchy-shell (quickshell holding
// ext-session-lock), which also draws the bar and so runs all the time.

// Lockers whose only job is the lock: one running means a lock is held. Used
// only when neither Hyprland nor logind can say.
export const LOCKER_COMMANDS = Object.freeze(['hyprlock', 'swaylock', 'gtklock', 'waylock'])
// Shells that hold the lock among other jobs (omarchy-shell is quickshell):
// they only name the locker of a lock Hyprland or logind reported.
const SHELL_LOCKERS = Object.freeze({ quickshell: 'omarchy-shell (quickshell)', qs: 'quickshell' })

/** `hyprctl -j locked` (Hyprland 0.56+): true, false, or null when unknown (pure). */
export function parseHyprlandLocked(text) {
  const body = String(text ?? '').trim()
  try {
    const parsed = JSON.parse(body)
    if (typeof parsed === 'boolean') return parsed
    return typeof parsed?.locked === 'boolean' ? parsed.locked : null
  } catch {
    return null
  }
}

/**
 * The lock as `hyprctl -j monitors` shows it (pure): an ext-session-lock puts
 * LOCK in a monitor's solitaryBlockedBy. Hyprland stops at the first reason on
 * a monitor with no workspace yet, so only monitors without WORKSPACE there
 * can say "unlocked". Same rule as Omarchy's omarchy-hyprland-session-locked.
 */
export function monitorsShowLock(monitors) {
  const all = Array.isArray(monitors) ? monitors : []
  const blockers = (entry) =>
    Array.isArray(entry?.solitaryBlockedBy) ? entry.solitaryBlockedBy : null
  if (all.some((entry) => blockers(entry)?.includes('LOCK'))) return true
  if (all.some((entry) => blockers(entry) && !blockers(entry).includes('WORKSPACE'))) return false
  return null
}

/** `loginctl show-session <id> -p LockedHint --value`: true, false or null (pure). */
export function parseLockedHint(text) {
  const value = String(text ?? '')
    .trim()
    .replace(/^LockedHint=/, '')
  return value === 'yes' ? true : value === 'no' ? false : null
}

/**
 * Combines the lock signals (pure). `hyprland` (the `locked` request),
 * `monitors` (solitaryBlockedBy) and `logind` (LockedHint) are true, false or
 * null; `running` is a Set of process names. Any signal saying locked wins:
 * omarchy-shell never sets LockedHint, so logind says "no" under its lock.
 * Returns { locked: true | false | null, sources, locker, detail }.
 */
export function judgeSessionLock({ hyprland = null, monitors = null, logind = null, running }) {
  const names = running instanceof Set ? running : new Set(running ?? [])
  const signals = { hyprland, monitors, logind }
  const said = Object.entries(signals).filter(([, value]) => value !== null)
  const lockedBy = said.filter(([, value]) => value === true).map(([name]) => name)
  const locker =
    LOCKER_COMMANDS.find((name) => names.has(name)) ??
    Object.entries(SHELL_LOCKERS).find(([name]) => names.has(name))?.[1] ??
    null
  const sources = said.map(([name, value]) => `${name}=${value ? 'locked' : 'unlocked'}`)
  if (lockedBy.length) {
    return {
      locked: true,
      sources,
      locker,
      detail: `The session is locked (${lockedBy.join(', ')}${locker ? `; locker: ${locker}` : ''}).`
    }
  }
  if (said.length) {
    return { locked: false, sources, locker, detail: `unlocked (${sources.join(', ')})` }
  }
  const dedicated = LOCKER_COMMANDS.find((name) => names.has(name))
  if (dedicated) {
    return {
      locked: true,
      sources: [`process=${dedicated}`],
      locker: dedicated,
      detail: `The session is likely locked: ${dedicated} runs, and neither Hyprland nor logind could say.`
    }
  }
  return {
    locked: null,
    sources: [],
    locker,
    detail:
      'Could not read the session lock (no hyprctl locked, no LOCK blocker, no logind LockedHint).'
  }
}

/** Names of running processes, from /proc/<pid>/comm. Read-only. */
export async function runningCommands({
  listDir = (path) => readdir(path),
  readComm = (pid) => readFile(`/proc/${pid}/comm`, 'utf8')
} = {}) {
  const names = new Set()
  const entries = await listDir('/proc').catch(() => [])
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    const comm = String(await readComm(entry).catch(() => '')).trim()
    if (comm) names.add(comm)
  }
  return names
}

/** The graphical session's id for `user`: `loginctl show-user -p Display`. */
async function displaySessionId(user, exec) {
  const shown = await exec('loginctl', ['show-user', user, '-p', 'Display', '--value'])
  const id = shown.code === 0 ? shown.stdout.trim() : ''
  return /^[A-Za-z0-9_-]+$/.test(id) ? id : null
}

/** Reads every lock signal and judges them (judgeSessionLock). */
export async function readSessionLock({
  sessionEnv,
  exec = defaultExec,
  user = userInfo().username,
  running = runningCommands
} = {}) {
  const env = { env: { ...process.env, ...sessionEnv } }
  const hyprlandRead = exec('hyprctl', ['-j', 'locked'], env).then((result) =>
    result.code === 0 ? parseHyprlandLocked(result.stdout) : null
  )
  const monitorsRead = hyprctlJson(['monitors'], { sessionEnv, exec }).then(
    monitorsShowLock,
    () => null
  )
  const logindRead = displaySessionId(user, exec).then(async (id) => {
    if (!id) return null
    const shown = await exec('loginctl', ['show-session', id, '-p', 'LockedHint', '--value'])
    return shown.code === 0 ? parseLockedHint(shown.stdout) : null
  })
  const [hyprland, monitors, logind, names] = await Promise.all([
    hyprlandRead,
    monitorsRead,
    logindRead,
    running()
  ])
  return judgeSessionLock({ hyprland, monitors, logind, running: names })
}

/** A binary PPM (P6, maxval 255) into { width, height, channels: 3, pixels } (pure). */
export function parsePpm(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer ?? [])
  const fields = []
  let index = 0
  while (fields.length < 4 && index < bytes.length) {
    const char = bytes[index]
    if (char === 0x23) {
      while (index < bytes.length && bytes[index] !== 0x0a) index += 1
    } else if (char === 0x20 || char === 0x09 || char === 0x0a || char === 0x0d) {
      index += 1
    } else {
      let token = ''
      while (index < bytes.length && bytes[index] > 0x20)
        token += String.fromCharCode(bytes[index++])
      fields.push(token)
    }
  }
  const [magic, width, height, maxval] = [
    fields[0],
    Number(fields[1]),
    Number(fields[2]),
    Number(fields[3])
  ]
  if (magic !== 'P6') throw new Error(`not a binary PPM (magic ${magic ?? 'none'})`)
  if (!(width > 0 && height > 0) || maxval !== 255) {
    throw new Error(`unsupported PPM header ${fields.join(' ')}`)
  }
  const pixels = bytes.subarray(index + 1, index + 1 + width * height * 3)
  if (pixels.length < width * height * 3) {
    throw new Error(`PPM holds ${pixels.length} pixel bytes, expected ${width * height * 3}`)
  }
  return { width, height, channels: 3, pixels }
}

// A frame whose brightest sampled pixel stays under this is black: the output
// is off (DPMS) or nothing is drawn. The card always has white markers.
export const BLACK_MAX_LUMA = 24

function maxLuma({ width, height, channels, pixels }) {
  let max = 0
  for (let y = 0; y < height; y += 4) {
    for (let x = 0; x < width; x += 4) {
      const offset = (y * width + x) * channels
      const value = 0.299 * pixels[offset] + 0.587 * pixels[offset + 1] + 0.114 * pixels[offset + 2]
      if (value > max) max = value
    }
  }
  return Math.round(max)
}

/**
 * What one frame of the lab output shows (pure): 'card' when the card's
 * markers decode, 'black' when the frame is black, else 'not-card' (a lock
 * screen, a desktop, another window). The card fills the lab output, so the
 * whole frame is the card rect.
 */
export function judgeLabPicture(frame, { spec } = {}) {
  const decoded = decodeMarkers(frame.pixels, frame.width, frame.height, {
    channels: frame.channels,
    ...(spec ? { spec } : {})
  })
  const brightest = maxLuma(frame)
  const shows = decoded.ok ? 'card' : brightest < BLACK_MAX_LUMA ? 'black' : 'not-card'
  return {
    shows,
    width: frame.width,
    height: frame.height,
    meanLuma: decoded.meanLuma,
    maxLuma: brightest,
    sceneId: decoded.sceneId,
    step: decoded.step,
    errors: decoded.ok ? [] : decoded.errors.slice(0, 3)
  }
}

/** One frame of `outputName` from grim, as PPM bytes. */
export async function grabOutputPpm(outputName, { sessionEnv, timeoutMs = 15_000 } = {}) {
  const { stdout } = await execFileAsync('grim', ['-t', 'ppm', '-o', outputName, '-'], {
    env: { ...process.env, ...sessionEnv },
    encoding: 'buffer',
    timeout: timeoutMs,
    maxBuffer: 128 * 1024 * 1024
  })
  return stdout
}

/**
 * Grabs one frame of the lab output and says what it shows; when it is not
 * the card, also reads the session lock so the failure names the cause.
 * Returns judgeLabPicture's answer plus { lock } (or { shows: 'unreadable' }).
 */
export async function checkLabPicture({
  outputName,
  sessionEnv,
  grab = grabOutputPpm,
  readLock = () => readSessionLock({ sessionEnv })
}) {
  let picture
  try {
    picture = judgeLabPicture(parsePpm(await grab(outputName, { sessionEnv })))
  } catch (error) {
    picture = { shows: 'unreadable', error: error.message }
  }
  if (picture.shows === 'card') return { ...picture, output: outputName }
  const lock = await readLock().catch((error) => ({ locked: null, detail: error.message }))
  return { ...picture, output: outputName, lock: { locked: lock.locked, detail: lock.detail } }
}

/** Why a lab picture is not the card, in words for a step failure (pure). */
export function labPictureProblem(picture) {
  if (!picture || picture.shows === 'card') return null
  const where = `the lab output "${picture.output}"`
  if (picture.lock?.locked === true) {
    const seen = picture.shows === 'black' ? 'is black' : 'shows the lock screen, not the test card'
    return `${where} ${seen}: ${picture.lock.detail} The lab refuses to run under a lock (plan 257 D12); unlock at the console.`
  }
  if (picture.shows === 'black') {
    return `${where} is black (brightest pixel luma ${picture.maxLuma}): the output is off (DPMS) or nothing is drawn on it.`
  }
  if (picture.shows === 'unreadable') return `could not grab ${where}: ${picture.error}`
  return `${where} does not show the test card (markers: ${picture.errors.join('; ') || 'none decoded'}).`
}
