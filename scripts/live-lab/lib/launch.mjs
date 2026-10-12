import { execFile, spawn } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { launchDevApp } from '../../lib/app-launcher.mjs'

// Plan 178 U6 (plan 176 L2 step 1). Starting everything a run owns:
//
// - Videorc through LaunchServices (`open -n -W`, scripts/lib/app-launcher.mjs),
//   so the packaged app keeps its TCC identity, with a lab profile under the
//   work dir, CDP on a free port, the metrics journal on, auto-update off and
//   bounded logs. The launcher reaps only the exact app PID it published.
// - caffeinate -d -i -s, the test card in a Chrome window on the lab display,
//   and (for local-sink scenarios) one `ffmpeg -listen 1` RTMP sink. Each is
//   spawned here and only its own PID is ever signalled.
//
// Secrets: the lab OAuth client reaches the app only through its environment
// and only when the scenario declares usesLabYoutubeClient. LaunchServices
// carries the environment through `open --env NAME=value`, which is visible to
// same-user `ps` for the life of the `open -W` controller; a direct spawn
// would hide it but lose the TCC grants. Stream keys never go through the
// environment: they go into the app's own secrets store (seed.mjs).

const execFileAsync = promisify(execFile)

export const APP_EXECUTABLE_NAME = 'Videorc'
export const DEFAULT_CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
export const BACKEND_LOG_MAX_BYTES = 50 * 1024 * 1024
export const BACKEND_LOG_MAX_FILES = 10
export const DEVTOOLS_LINE = /DevTools listening on (ws:\/\/[^\s]+)/

/** The lab profile. Local-sink runs get their own, so a dry run never touches the real keys. */
export function labProfileDirs(workDir, destination) {
  const root = join(workDir, destination === 'local-sink' ? 'profile-local' : 'profile')
  const appDataDir = join(root, 'app-data')
  return {
    root,
    appDataDir,
    userDataDir: join(root, 'user-data'),
    launchStateDir: join(root, 'launch'),
    // smokeAppEnv derives these from appDataDir (inside its isolation roots).
    databasePath: join(appDataDir, 'videorc.sqlite3'),
    secretsPath: join(appDataDir, 'videorc-secrets.json'),
    recordingsDir: join(appDataDir, 'recordings')
  }
}

// Plan 179: the Linux build under test is an extracted AppImage directory
// (live:install), whose executable is `videorc` (electron-builder.yml
// linux.executableName). The layout, not the host, picks the path, so the
// tests mean the same thing on any machine.
export const LINUX_APP_EXECUTABLE_NAME = 'videorc'

export function isMacAppBundle(appPath) {
  return String(appPath).replace(/\/+$/, '').endsWith('.app')
}

export function appExecutablePath(appPath) {
  return isMacAppBundle(appPath)
    ? join(appPath, 'Contents', 'MacOS', APP_EXECUTABLE_NAME)
    : join(appPath, LINUX_APP_EXECUTABLE_NAME)
}

/**
 * The environment Videorc is launched with (pure). Only these names cross the
 * LaunchServices boundary (app-launcher passes requested names only).
 */
export function buildLaunchEnv({ dirs, config, scenario }) {
  const env = {
    VIDEORC_USER_DATA_DIR: dirs.userDataDir,
    VIDEORC_APP_DATA_DIR: dirs.appDataDir,
    VIDEORC_SMOKE_STATE_DIR: dirs.launchStateDir,
    VIDEORC_SMOKE_PRINT_BACKEND_READY: '1',
    VIDEORC_REMOTE_DEBUG_PORT: '0',
    VIDEORC_METRICS_JOURNAL: '1',
    // apps/desktop/src/main/windows-pilot-update.ts reads exactly this name;
    // without it the updater would swap a candidate for the public release.
    VIDEORC_DISABLE_AUTO_UPDATE: '1',
    VIDEORC_BACKEND_LOG_MAX_BYTES: String(BACKEND_LOG_MAX_BYTES),
    VIDEORC_BACKEND_LOG_MAX_FILES: String(BACKEND_LOG_MAX_FILES)
  }
  if (scenario.usesLabYoutubeClient) {
    if (!config?.client?.id || !config?.client?.secret) {
      throw new Error(
        'This scenario needs the lab OAuth client; run pnpm live:hookup --client first.'
      )
    }
    env.VIDEORC_YOUTUBE_CLIENT_ID = config.client.id
    env.VIDEORC_YOUTUBE_CLIENT_SECRET = config.client.secret
  }
  return env
}

/** Names of env vars that must never be printed. */
export const SECRET_ENV_NAMES = Object.freeze([
  'VIDEORC_YOUTUBE_CLIENT_ID',
  'VIDEORC_YOUTUBE_CLIENT_SECRET'
])

export function parseDevtoolsLine(line) {
  const match = DEVTOOLS_LINE.exec(String(line ?? ''))
  return match ? match[1] : null
}

/** Chromium's DevToolsActivePort file: line 1 port, line 2 browser path. */
export function parseDevToolsActivePort(text) {
  const [portLine, pathLine] = String(text ?? '').split(/\r?\n/)
  const port = Number(portLine)
  if (!Number.isInteger(port) || port <= 0 || port > 65535 || !pathLine?.startsWith('/devtools/')) {
    return null
  }
  return `ws://127.0.0.1:${port}${pathLine.trim()}`
}

export async function readDevToolsActivePort(userDataDir, read = (path) => readFile(path, 'utf8')) {
  try {
    return parseDevToolsActivePort(await read(join(userDataDir, 'DevToolsActivePort')))
  } catch {
    return null
  }
}

// The app's own LaunchServices ownership publication (written by the app with
// mode 0600 under the launch state dir). Read for the census root only; the
// launcher's stop() is the only thing that ever signals the app.
export async function readPublishedAppPid(
  launchStateDir,
  { list = readdir, read = (path) => readFile(path, 'utf8') } = {}
) {
  let names
  try {
    names = await list(launchStateDir)
  } catch {
    return null
  }
  const candidates = names.filter((name) => name.endsWith('.app-ownership.json')).sort()
  for (const name of candidates.reverse()) {
    try {
      const parsed = JSON.parse(await read(join(launchStateDir, name)))
      if (Number.isSafeInteger(parsed?.appPid) && parsed.appPid > 1) return parsed.appPid
    } catch {
      // Mid-write or stale: try the next one.
    }
  }
  return null
}

/**
 * Launches the packaged app and resolves once the backend is ready. The CDP
 * endpoint comes from the app's stderr ("DevTools listening on ws://...",
 * redirected to a file by LaunchServices), with DevToolsActivePort as the
 * fallback. Lines never reach the console (they carry local tokens).
 *
 * A macOS bundle goes through LaunchServices (TCC identity). A Linux app
 * directory is spawned directly in its own process group, so the app PID is
 * the child the launcher owns (no ownership file exists on Linux) and stop()
 * signals that group only.
 */
export async function launchApp({
  appPath,
  env,
  dirs,
  launcher = launchDevApp,
  timeoutMs = 120_000,
  onLine = () => {}
}) {
  let devtoolsUrl = null
  const bundle = isMacAppBundle(appPath)
  const launched = await launcher({
    env,
    timeoutMs,
    requiredMarkers: ['backend-ready'],
    launchViaMacosLaunchServices: bundle,
    spawnSpec: { command: appExecutablePath(appPath), args: [] },
    onLine(line) {
      devtoolsUrl ??= parseDevtoolsLine(line)
      onLine(line)
    }
  })
  return {
    backend: launched.connections['backend-ready'],
    stop: launched.stop,
    controller: launched.process,
    devtoolsUrl: async () => devtoolsUrl ?? (await readDevToolsActivePort(dirs.userDataDir)),
    appPid: bundle
      ? () => readPublishedAppPid(dirs.launchStateDir)
      : async () => launched.process?.pid ?? null
  }
}

// ---------------------------------------------------------------------------
// Owned helper processes
// ---------------------------------------------------------------------------

function waitForExit(child, ms) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolveExit) => {
    const timer = setTimeout(() => resolveExit(false), ms)
    child.once('exit', () => {
      clearTimeout(timer)
      resolveExit(true)
    })
  })
}

/** SIGTERM then SIGKILL, to this exact child only. */
export async function stopOwnedChild(child, { graceMs = 3000 } = {}) {
  if (!child?.pid) return { pid: null, state: 'not-started' }
  if (child.exitCode !== null || child.signalCode !== null)
    return { pid: child.pid, state: 'exited' }
  child.kill('SIGTERM')
  if (await waitForExit(child, graceMs)) return { pid: child.pid, state: 'terminated' }
  child.kill('SIGKILL')
  await waitForExit(child, graceMs)
  return {
    pid: child.pid,
    state: child.exitCode !== null || child.signalCode !== null ? 'killed' : 'leaked'
  }
}

export function owned(child, label) {
  return {
    label,
    child,
    pid: child?.pid ?? null,
    stop: (options) => stopOwnedChild(child, options)
  }
}

/** `-w <pid>` ends caffeinate with the harness even if teardown never runs. */
export function caffeinateArgs(harnessPid = process.pid) {
  return ['-d', '-i', '-s', '-w', String(harnessPid)]
}

export function startCaffeinate({ spawnFn = spawn, harnessPid = process.pid } = {}) {
  const child = spawnFn('/usr/bin/caffeinate', caffeinateArgs(harnessPid), { stdio: 'ignore' })
  return owned(child, 'caffeinate')
}

// Plan 179: the Linux twin of caffeinate. A block-mode logind inhibitor for
// sleep, idle (hypridle honours it) and the lid switch, held by a
// `tail --pid` that ends with the harness even if teardown never runs.
export function sleepInhibitorArgs(harnessPid = process.pid) {
  return [
    '--what=sleep:idle:handle-lid-switch',
    '--who=videorc-live-lab',
    '--why=Videorc live lab run',
    '--mode=block',
    'tail',
    `--pid=${harnessPid}`,
    '-f',
    '/dev/null'
  ]
}

/**
 * True when the inhibitor still runs after `ms`. polkit allows block-mode
 * inhibitors only to the seat's active session by default, so from SSH or a
 * user unit `systemd-inhibit` may exit at once; the run then relies on the
 * masked sleep targets and on hypridle being off (both doctor checks).
 */
export function inhibitorHeld(helper, ms = 500) {
  const child = helper?.child
  if (!child) return Promise.resolve(false)
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(false)
  return new Promise((resolveHeld) => {
    const timer = setTimeout(() => {
      child.off?.('exit', onExit)
      resolveHeld(true)
    }, ms)
    const onExit = () => {
      clearTimeout(timer)
      resolveHeld(false)
    }
    child.once('exit', onExit)
  })
}

export function startSleepInhibitor({ spawnFn = spawn, harnessPid = process.pid, env } = {}) {
  const child = spawnFn('systemd-inhibit', sleepInhibitorArgs(harnessPid), {
    stdio: 'ignore',
    ...(env ? { env: { ...process.env, ...env } } : {})
  })
  return owned(child, 'systemd-inhibit')
}

// NSScreen frames are bottom-left based; Chrome's --window-position is in
// top-left global coordinates. JXA needs no permission to read them.
const SCREENS_JXA = `ObjC.import('AppKit');
const screens = $.NSScreen.screens;
const out = [];
for (let i = 0; i < screens.count; i++) {
  const s = screens.objectAtIndex(i);
  const f = s.frame;
  out.push({ name: ObjC.unwrap(s.localizedName), x: f.origin.x, y: f.origin.y, width: f.size.width, height: f.size.height });
}
JSON.stringify(out);`

export function topLeftBounds(screens, name) {
  const main = screens[0]
  const target = screens.find((screen) => screen.name === name)
  if (!main || !target) return null
  return {
    name: target.name,
    x: Math.round(target.x),
    y: Math.round(main.height - (target.y + target.height)),
    width: Math.round(target.width),
    height: Math.round(target.height),
    isMain: target === main
  }
}

export async function labDisplayBounds(name, { exec = execFileAsync } = {}) {
  if (typeof name !== 'string' || !name.trim()) {
    throw new Error('No lab display is configured (pnpm live:hookup --lab-display "<name>").')
  }
  const { stdout } = await exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', SCREENS_JXA], {
    timeout: 15_000
  })
  const bounds = topLeftBounds(JSON.parse(stdout), name)
  if (!bounds) throw new Error(`The lab display "${name}" is not connected.`)
  if (bounds.isMain)
    throw new Error(`The lab display "${name}" is the main display; make another display main.`)
  return bounds
}

export function cardBrowserArgs({ url, bounds, profileDir }) {
  return [
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-session-crashed-bubble',
    '--disable-features=Translate,MediaRouter',
    '--autoplay-policy=no-user-gesture-required',
    '--force-device-scale-factor=1',
    `--window-position=${bounds.x},${bounds.y}`,
    `--window-size=${bounds.width},${bounds.height}`,
    '--start-fullscreen',
    `--app=${url}`
  ]
}

// Plan 179: Chrome on the Linux lab. Wayland ignores --window-position, so
// the window lands on the lab output because that output has focus when it
// maps (linux-desktop.mjs focusLabOutput / placeCardWindow). The page's
// audio goes to the lab speech sink through PULSE_SINK in its environment.
export function linuxCardBrowserArgs({ url, profileDir }) {
  return [
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-session-crashed-bubble',
    '--disable-features=Translate,MediaRouter',
    '--autoplay-policy=no-user-gesture-required',
    '--force-device-scale-factor=1',
    '--ozone-platform-hint=auto',
    '--password-store=basic',
    '--start-fullscreen',
    `--app=${url}`
  ]
}

/** Opens the card fullscreen on the lab display in a Chrome instance this run owns. */
export function startCardBrowser({
  url,
  bounds,
  profileDir,
  chromePath = DEFAULT_CHROME_PATH,
  spawnFn = spawn,
  args = null,
  env = null
}) {
  const child = spawnFn(chromePath, args ?? cardBrowserArgs({ url, bounds, profileDir }), {
    stdio: 'ignore',
    ...(env ? { env: { ...process.env, ...env } } : {})
  })
  return owned(child, 'card-browser')
}

export function localSinkArgs({ port, streamKey, outputPath }) {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-listen',
    '1',
    '-i',
    `rtmp://127.0.0.1:${port}/live/${streamKey}`,
    '-c',
    'copy',
    '-f',
    'flv',
    outputPath
  ]
}

/**
 * One loopback RTMP listener (the smoke:multistream pattern). Returns the
 * server URL the destination is seeded with; nothing leaves the machine.
 */
export function startLocalSink({
  port,
  streamKey,
  outputPath,
  ffmpegPath = 'ffmpeg',
  spawnFn = spawn
}) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error('sink port must be 1024-65535')
  const child = spawnFn(ffmpegPath, localSinkArgs({ port, streamKey, outputPath }), {
    stdio: ['ignore', 'ignore', 'pipe']
  })
  return {
    ...owned(child, 'rtmp-sink'),
    serverUrl: `rtmp://127.0.0.1:${port}/live`,
    streamKey,
    outputPath,
    port
  }
}

/** True for a loopback RTMP URL (the only kind a local-sink scenario may stream to). */
export function isLoopbackRtmp(url) {
  try {
    const parsed = new URL(url)
    return (
      parsed.protocol === 'rtmp:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
    )
  } catch {
    return false
  }
}
