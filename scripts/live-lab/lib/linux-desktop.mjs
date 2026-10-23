import { execFile } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'

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

export async function hyprctlDispatch(args, { sessionEnv, exec = defaultExec } = {}) {
  const result = await exec('hyprctl', ['dispatch', ...args], {
    env: { ...process.env, ...sessionEnv }
  })
  const said = `${result.stdout}${result.stderr}`.trim()
  if (result.code !== 0 || (said && said !== 'ok')) {
    throw new Error(`hyprctl dispatch ${args.join(' ')}: ${said || `exit ${result.code}`}`)
  }
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
