import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import {
  FAIL,
  PASS,
  WARN,
  evaluateLinuxAutoLogin,
  evaluateLinuxLabAudio,
  evaluateLinuxLabDisplay,
  evaluateLinuxLinger,
  evaluateLinuxNotifications,
  evaluateLinuxScreenGrant,
  evaluateLinuxScreenLock,
  evaluateLinuxSession,
  evaluateLinuxSleep,
  evaluateLinuxSudo,
  evaluateLinuxUnattendedBoot,
  parseXdphPicker
} from './doctor-checks.mjs'
import {
  appExecutablePath,
  launchApp,
  linuxCardBrowserArgs,
  sleepInhibitorArgs,
  startSleepInhibitor
} from './launch.mjs'
import {
  LAB_MIC_SOURCE,
  LAB_SPEECH_SINK,
  PORTAL_PICK_FILE,
  clientForPid,
  labSessionEnv,
  parseEnvironmentBlock,
  parsePulseDevices,
  pickLabOutput,
  placeCardWindow
} from './linux-desktop.mjs'
import { labPlatform, requireLabPlatform } from './platform.mjs'
import { clipboardCommands } from './prompt.mjs'
import { portalRestoreTokensPath, preparePortalGrant } from './session.mjs'
import { assertPulseSink, defaultSpeechDevice, playPhrase, renderPhrase } from './speech.mjs'

// Plan 179: the Linux lab's run path and doctor, host-independent (the
// platform is always passed in, the commands are always fakes).

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const LINUX_CONFIG = join(HERE, '..', '..', '..', 'config', 'live-lab', 'linux')
const LINUX = 'linux'

const MONITORS = [
  {
    id: 0,
    name: 'eDP-1',
    width: 2560,
    height: 1600,
    x: 0,
    y: 0,
    focused: true,
    dpmsStatus: true,
    disabled: false,
    activeWorkspace: { id: 1, name: '1' }
  },
  {
    id: 1,
    name: 'videorc-lab',
    width: 1920,
    height: 1080,
    x: 20000,
    y: 0,
    focused: false,
    dpmsStatus: true,
    disabled: false,
    activeWorkspace: { id: 9, name: '9' }
  }
]

const SINKS = `Auto-detected sinks for pulse:
* alsa_output.pci-0000_00_1f.3.analog-stereo [Built-in Audio Analog Stereo] (none)
  ${LAB_SPEECH_SINK} [Videorc-Lab-Speech] (none)
`
const SOURCES = `Auto-detected sources for pulse:
  alsa_output.pci-0000_00_1f.3.analog-stereo.monitor [Monitor of Built-in Audio Analog Stereo] (none)
* alsa_input.pci-0000_00_1f.3.analog-stereo [Built-in Audio Analog Stereo] (none)
  ${LAB_SPEECH_SINK}.monitor [Monitor of Videorc-Lab-Speech] (none)
  ${LAB_MIC_SOURCE} [Videorc-Lab-Mic] (none)
`

test('platform: macOS and Linux run the lab, nothing else does', () => {
  assert.equal(labPlatform('darwin'), 'macos')
  assert.equal(labPlatform('linux'), 'linux')
  assert.equal(labPlatform('win32'), null)
  assert.throws(
    () => requireLabPlatform('win32', 'live:doctor'),
    /live:doctor runs on macOS or Linux/
  )
})

test('session env: this process first, then the user manager, then /run/user', async () => {
  assert.deepEqual(parseEnvironmentBlock('A=1\nWAYLAND_DISPLAY=wayland-1\nnot a line\n'), {
    A: '1',
    WAYLAND_DISPLAY: 'wayland-1'
  })
  const exec = async () => ({
    code: 0,
    stdout:
      'WAYLAND_DISPLAY=wayland-1\nHYPRLAND_INSTANCE_SIGNATURE=abc_123\nXDG_CURRENT_DESKTOP=Hyprland\nSECRET=nope\n',
    stderr: ''
  })
  const fromManager = await labSessionEnv({ env: {}, exec, uid: 1001, listDir: async () => [] })
  assert.equal(fromManager.WAYLAND_DISPLAY, 'wayland-1')
  assert.equal(fromManager.HYPRLAND_INSTANCE_SIGNATURE, 'abc_123')
  assert.equal(fromManager.XDG_RUNTIME_DIR, '/run/user/1001')
  assert.equal(fromManager.DBUS_SESSION_BUS_ADDRESS, 'unix:path=/run/user/1001/bus')
  assert.equal(fromManager.SECRET, undefined)

  // SSH with no user manager answer: the runtime dir's sockets decide.
  const fromRuntime = await labSessionEnv({
    env: { XDG_RUNTIME_DIR: '/run/user/1001' },
    exec: async () => ({ code: 1, stdout: '', stderr: 'Failed to connect to bus' }),
    listDir: async (path) =>
      path.endsWith('/hypr') ? ['abc_123', '.lock'] : ['bus', 'wayland-1', 'wayland-1.lock', 'hypr']
  })
  assert.equal(fromRuntime.WAYLAND_DISPLAY, 'wayland-1')
  assert.equal(fromRuntime.HYPRLAND_INSTANCE_SIGNATURE, 'abc_123')
  assert.equal(evaluateLinuxSession(fromRuntime).status, PASS)
  assert.equal(evaluateLinuxSession({}).status, FAIL)
})

test('lab output: named, else the single headless one; off, small or focused are flagged', () => {
  assert.equal(pickLabOutput(MONITORS).output.name, 'videorc-lab')
  assert.equal(pickLabOutput(MONITORS, 'eDP-1').output.name, 'eDP-1')
  assert.match(pickLabOutput(MONITORS, 'HEADLESS-2').problem, /No Hyprland output named/)
  assert.match(pickLabOutput([MONITORS[0]]).problem, /hyprctl output create headless/)
  assert.match(
    pickLabOutput([...MONITORS, { ...MONITORS[1], id: 2, name: 'HEADLESS-3' }]).problem,
    /Several candidates/
  )

  assert.equal(evaluateLinuxLabDisplay(MONITORS).status, PASS)
  assert.equal(evaluateLinuxLabDisplay(MONITORS, 'gone').status, FAIL)
  assert.equal(evaluateLinuxLabDisplay(null, null, new Error('hyprctl: no instance')).status, FAIL)
  const off = [MONITORS[0], { ...MONITORS[1], dpmsStatus: false }]
  assert.match(evaluateLinuxLabDisplay(off).detail, /DPMS/)
  const small = [MONITORS[0], { ...MONITORS[1], width: 640, height: 360 }]
  assert.equal(evaluateLinuxLabDisplay(small).status, FAIL)
  const focused = [
    { ...MONITORS[0], focused: false },
    { ...MONITORS[1], focused: true }
  ]
  assert.equal(evaluateLinuxLabDisplay(focused).status, WARN)
})

test('pulse parsing matches the backend: monitors and spaced names never count as mics', () => {
  const sources = parsePulseDevices(SOURCES)
  assert.deepEqual(
    sources.map((entry) => entry.name),
    ['alsa_input.pci-0000_00_1f.3.analog-stereo', LAB_MIC_SOURCE]
  )
  assert.equal(sources[0].isDefault, true)
  assert.equal(sources[1].description, 'Videorc-Lab-Mic')
  const sinks = parsePulseDevices(SINKS, { dropMonitors: false })
  assert.deepEqual(
    sinks.map((entry) => entry.name),
    ['alsa_output.pci-0000_00_1f.3.analog-stereo', LAB_SPEECH_SINK]
  )
})

test('doctor: lab audio needs the sink and the remap source, neither as default', () => {
  assert.equal(evaluateLinuxLabAudio(SINKS, SOURCES).status, PASS)
  // Only the monitor of the speech sink: Videorc would not list it.
  const monitorOnly = SOURCES.replace(`  ${LAB_MIC_SOURCE} [Videorc-Lab-Mic] (none)\n`, '')
  assert.match(evaluateLinuxLabAudio(SINKS, monitorOnly).detail, /a monitor never counts/)
  assert.match(evaluateLinuxLabAudio('', '').detail, /pipewire-pulse\.videorc-lab\.conf/)
  const defaultMic = SOURCES.replace('* alsa_input', '  alsa_input').replace(
    `  ${LAB_MIC_SOURCE} [`,
    `* ${LAB_MIC_SOURCE} [`
  )
  assert.match(evaluateLinuxLabAudio(SINKS, defaultMic).detail, /set-default-source/)
  const defaultSink = SINKS.replace('* alsa_output', '  alsa_output').replace(
    `  ${LAB_SPEECH_SINK} [`,
    `* ${LAB_SPEECH_SINK} [`
  )
  assert.match(evaluateLinuxLabAudio(defaultSink, SOURCES).detail, /set-default-sink/)
})

test('doctor: screen grant needs the lab share picker configured in xdph', () => {
  const xdphConf =
    'screencopy {\n  custom_picker_binary = /home/videorc-lab/.local/bin/videorc-lab-share-picker\n}\n'
  assert.equal(parseXdphPicker(xdphConf), '/home/videorc-lab/.local/bin/videorc-lab-share-picker')
  const good = { executable: true, isLabPicker: true }
  assert.equal(evaluateLinuxScreenGrant({ xdphConf, picker: good, fallback: true }).status, PASS)
  assert.equal(evaluateLinuxScreenGrant({ xdphConf, picker: good, fallback: false }).status, WARN)
  assert.equal(
    evaluateLinuxScreenGrant({ xdphConf: null, picker: null, fallback: true }).status,
    FAIL
  )
  assert.match(
    evaluateLinuxScreenGrant({ xdphConf, picker: { executable: false }, fallback: true }).detail,
    /missing or not executable/
  )
  assert.match(
    evaluateLinuxScreenGrant({
      xdphConf,
      picker: { executable: true, isLabPicker: false },
      fallback: true
    }).detail,
    /not the lab share picker/
  )
})

test('doctor: Linux machine checks fail clearly when broken on purpose', () => {
  assert.equal(evaluateLinuxSleep('masked\nmasked\nmasked\nmasked\n').status, PASS)
  const awake = evaluateLinuxSleep('masked\nstatic\nmasked\nmasked\n')
  assert.equal(awake.status, FAIL)
  assert.match(awake.detail, /suspend\.target not masked.*sudo systemctl mask/)
  assert.equal(evaluateLinuxSleep('').status, FAIL)

  assert.equal(evaluateLinuxScreenLock({ hypridle: false, hyprlock: false }).status, PASS)
  assert.match(evaluateLinuxScreenLock({ hypridle: true, hyprlock: false }).detail, /hypridle/)
  assert.match(evaluateLinuxScreenLock({ hypridle: true, hyprlock: true }).detail, /locked/)

  assert.equal(
    evaluateLinuxNotifications({ daemon: 'mako', output: 'default\ndo-not-disturb\n' }).status,
    PASS
  )
  assert.match(
    evaluateLinuxNotifications({ daemon: 'mako', output: 'default\n' }).detail,
    /makoctl mode -a do-not-disturb/
  )
  assert.equal(evaluateLinuxNotifications({ daemon: 'dunst', output: 'true\n' }).status, PASS)
  assert.equal(evaluateLinuxNotifications({ daemon: 'swaync', output: 'false\n' }).status, FAIL)
  assert.equal(evaluateLinuxNotifications({ daemon: null, output: '' }).status, WARN)

  const sddm = {
    '/etc/sddm.conf.d/autologin.conf': '[Autologin]\nUser=videorc-lab\nSession=hyprland-uwsm\n'
  }
  assert.equal(evaluateLinuxAutoLogin(sddm, 'videorc-lab').status, PASS)
  assert.match(evaluateLinuxAutoLogin(sddm, 'orcdev').detail, /must be orcdev/)
  const greetd = {
    '/etc/greetd/config.toml':
      '[default_session]\nuser = "greeter"\n[initial_session]\ncommand = "Hyprland"\nuser = "videorc-lab"\n'
  }
  assert.equal(evaluateLinuxAutoLogin(greetd, 'videorc-lab').status, PASS)
  const getty = {
    '/etc/systemd/system/getty@tty1.service.d/autologin.conf':
      'ExecStart=-/sbin/agetty -o "-p -f -- \\\\u" --noclear --autologin videorc-lab %I $TERM\n'
  }
  assert.equal(evaluateLinuxAutoLogin(getty, 'videorc-lab').status, PASS)
  assert.equal(
    evaluateLinuxAutoLogin({ '/etc/sddm.conf': '[Theme]\nCurrent=breeze\n' }, 'videorc-lab').status,
    FAIL
  )

  assert.equal(evaluateLinuxLinger('Linger=yes\n', 'videorc-lab').status, PASS)
  assert.match(
    evaluateLinuxLinger('Linger=no\n', 'videorc-lab').detail,
    /enable-linger videorc-lab/
  )

  assert.equal(evaluateLinuxUnattendedBoot('disk\npart\npart\n').status, PASS)
  assert.equal(evaluateLinuxUnattendedBoot('disk\npart\ncrypt\n').status, WARN)

  const nopasswdAll =
    'User orcdev may run the following commands on ogre:\n    (ALL) NOPASSWD: ALL\n'
  assert.equal(evaluateLinuxSudo(nopasswdAll, 'orcdev wheel', 'orcdev').status, FAIL)
  assert.equal(evaluateLinuxSudo('    (ALL : ALL) NOPASSWD: ALL\n', '', 'x').status, FAIL)
  const onlyFaults =
    '    (root) NOPASSWD: /usr/local/sbin/videorc-lab-netfault loss, /usr/local/sbin/videorc-lab-netfault clear\n'
  assert.equal(evaluateLinuxSudo(onlyFaults, 'videorc-lab', 'videorc-lab').status, PASS)
  assert.equal(
    evaluateLinuxSudo('sudo: a password is required\n', 'orcdev wheel', 'orcdev').status,
    WARN
  )
})

test('launch: a Linux app dir spawns videorc directly and its child is the app pid', async () => {
  assert.equal(
    appExecutablePath('/home/lab/.local/share/videorc-lab/Videorc'),
    '/home/lab/.local/share/videorc-lab/Videorc/videorc'
  )
  assert.equal(
    appExecutablePath('/Applications/Videorc.app'),
    '/Applications/Videorc.app/Contents/MacOS/Videorc'
  )
  const seen = []
  const launched = await launchApp({
    appPath: '/home/lab/app/Videorc',
    env: { WAYLAND_DISPLAY: 'wayland-1', VIDEORC_REMOTE_DEBUG_PORT: '0' },
    dirs: { userDataDir: '/nowhere', launchStateDir: '/nowhere' },
    launcher: async (options) => {
      seen.push(options)
      options.onLine('DevTools listening on ws://127.0.0.1:9333/devtools/browser/abc')
      return {
        connections: { 'backend-ready': { port: 1 } },
        process: { pid: 4242 },
        stop: async () => {}
      }
    }
  })
  assert.equal(seen[0].launchViaMacosLaunchServices, false)
  assert.deepEqual(seen[0].spawnSpec, { command: '/home/lab/app/Videorc/videorc', args: [] })
  assert.equal(await launched.appPid(), 4242)
  assert.equal(await launched.devtoolsUrl(), 'ws://127.0.0.1:9333/devtools/browser/abc')
})

test('launch: the Linux inhibitor and card browser', () => {
  assert.deepEqual(sleepInhibitorArgs(99), [
    '--what=sleep:idle:handle-lid-switch',
    '--who=videorc-live-lab',
    '--why=Videorc live lab run',
    '--mode=block',
    'tail',
    '--pid=99',
    '-f',
    '/dev/null'
  ])
  const spawned = []
  const helper = startSleepInhibitor({
    harnessPid: 7,
    env: { WAYLAND_DISPLAY: 'wayland-1' },
    spawnFn: (command, args, options) => {
      spawned.push({ command, args, options })
      return { pid: 55, exitCode: null, signalCode: null }
    }
  })
  assert.equal(helper.label, 'systemd-inhibit')
  assert.equal(spawned[0].command, 'systemd-inhibit')
  assert.equal(spawned[0].options.env.WAYLAND_DISPLAY, 'wayland-1')

  const args = linuxCardBrowserArgs({ url: 'http://127.0.0.1:5000/', profileDir: '/w/card' })
  assert.ok(args.includes('--autoplay-policy=no-user-gesture-required'))
  assert.ok(args.includes('--start-fullscreen'))
  assert.equal(args.at(-1), '--app=http://127.0.0.1:5000/')
  assert.ok(!args.some((arg) => arg.startsWith('--window-position')), 'Wayland ignores positions')
})

test('card window: waits for the pid, moves it to the lab output, gives focus back', async () => {
  const calls = []
  let polls = 0
  const exec = async (command, args) => {
    calls.push(args.join(' '))
    if (args[0] === '-j' && args[1] === 'clients') {
      polls += 1
      if (polls === 1) return { code: 0, stdout: '[]', stderr: '' }
      const monitor = calls.some((line) => line.startsWith('dispatch movetoworkspacesilent'))
        ? 1
        : 0
      return {
        code: 0,
        stdout: JSON.stringify([{ pid: 77, monitor, fullscreen: 2, size: [1920, 1080] }]),
        stderr: ''
      }
    }
    return { code: 0, stdout: 'ok', stderr: '' }
  }
  const placed = await placeCardWindow({
    pid: 77,
    bounds: { id: 1, name: 'videorc-lab', activeWorkspaceId: 9 },
    previousOutput: 'eDP-1',
    sessionEnv: {},
    exec,
    wait: async () => {}
  })
  assert.deepEqual(placed, { onLabOutput: true, fullscreen: true, size: [1920, 1080] })
  assert.ok(calls.includes('dispatch movetoworkspacesilent 9,pid:77'))
  assert.equal(calls.at(-1), 'dispatch focusmonitor eDP-1')
  assert.equal(clientForPid([{ pid: 1 }], 2), null)
})

test('portal grant: no restore token survives, the pick file names the lab output only', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'videorc-portal-'))
  try {
    const appDataDir = join(dir, 'app-data')
    const tokens = portalRestoreTokensPath(appDataDir)
    await mkdir(dirname(tokens), { recursive: true })
    await writeFile(tokens, '{"tokens":{"screen:portal:monitor":"old-hand-pick"}}')
    const helper = await preparePortalGrant({ workDir: dir, appDataDir, outputName: 'videorc-lab' })
    await assert.rejects(stat(tokens), { code: 'ENOENT' })
    const pick = join(dir, PORTAL_PICK_FILE)
    assert.equal(await readFile(pick, 'utf8'), 'videorc-lab\n')
    assert.equal((await stat(pick)).mode & 0o777, 0o600)
    await helper.stop()
    await assert.rejects(stat(pick), { code: 'ENOENT' })
    await assert.rejects(
      preparePortalGrant({ workDir: dir, appDataDir, outputName: 'eDP-1; rm -rf ~' }),
      /not one the share picker accepts/
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('share picker script: the lab output during a run, the normal picker otherwise', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'videorc-picker-'))
  try {
    await writeFile(
      join(dir, 'hyprland-share-picker'),
      '#!/bin/sh\necho "[SELECTION]/screen:eDP-1"\n'
    )
    await chmod(join(dir, 'hyprland-share-picker'), 0o755)
    const pick = async () =>
      (
        await execFileAsync('/bin/sh', [join(LINUX_CONFIG, 'videorc-lab-share-picker')], {
          env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir, VIDEORC_LIVE_LAB_WORK_DIR: dir }
        })
      ).stdout.trim()
    assert.equal(await pick(), '[SELECTION]/screen:eDP-1')
    await writeFile(join(dir, PORTAL_PICK_FILE), 'videorc-lab\n')
    assert.equal(await pick(), '[SELECTION]r/screen:videorc-lab')
    // A name the picker cannot vouch for falls back to the human picker.
    await writeFile(join(dir, PORTAL_PICK_FILE), 'eDP-1 window:0x1\n')
    assert.equal(await pick(), '[SELECTION]/screen:eDP-1')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('speech on Linux: espeak-ng renders a WAV, ffmpeg plays it into the lab sink', async () => {
  assert.equal(defaultSpeechDevice(LINUX), LAB_SPEECH_SINK)
  const calls = []
  const runner = async (command, args) => {
    calls.push({ command, args })
    if (args.includes('-sinks')) return { code: 0, stdout: SINKS, stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }
  await renderPhrase('-v Buddy, clip that', '/r/s/clip.wav', { runner, platform: LINUX })
  assert.deepEqual(calls[0], {
    command: 'espeak-ng',
    args: ['-w', '/r/s/clip.wav', '-v', 'en-us', '--', '-v Buddy, clip that']
  })
  assert.equal(await assertPulseSink(LAB_SPEECH_SINK, { runner }), LAB_SPEECH_SINK)
  await assert.rejects(assertPulseSink('nope', { runner }), /pipewire-pulse\.videorc-lab\.conf/)
  const record = await playPhrase({
    platform: LINUX,
    file: '/r/s/clip.wav',
    device: LAB_SPEECH_SINK,
    phraseId: 'clip',
    text: 'clip that',
    runner,
    now: () => new Date('2026-10-12T12:00:00Z'),
    log: () => {}
  })
  assert.equal(record.device, LAB_SPEECH_SINK)
  const played = calls.at(-1)
  assert.equal(played.command, 'ffmpeg')
  assert.deepEqual(played.args.slice(-5), [
    '-f',
    'pulse',
    '-device',
    LAB_SPEECH_SINK,
    'videorc-lab-speech'
  ])
  assert.ok(!played.args.includes('audiotoolbox'))
})

test('clipboard: pbpaste on macOS, wl-clipboard on Wayland, xclip otherwise', () => {
  assert.deepEqual(clipboardCommands('darwin').read, ['pbpaste', []])
  assert.deepEqual(clipboardCommands(LINUX, { WAYLAND_DISPLAY: 'wayland-1' }), {
    read: ['wl-paste', ['--no-newline']],
    clear: ['wl-copy', ['--clear']]
  })
  assert.equal(clipboardCommands(LINUX, {}).read[0], 'xclip')
})

test('config examples: the mic and sink names match the code', async () => {
  const pulse = await readFile(join(LINUX_CONFIG, 'pipewire-pulse.videorc-lab.conf'), 'utf8')
  assert.match(pulse, new RegExp(`module-null-sink sink_name=${LAB_SPEECH_SINK}\\b`))
  assert.match(
    pulse,
    new RegExp(
      `module-remap-source master=${LAB_SPEECH_SINK}\\.monitor source_name=${LAB_MIC_SOURCE}\\b`
    )
  )
  const hypr = await readFile(join(LINUX_CONFIG, 'hyprland.videorc-lab.conf'), 'utf8')
  assert.match(hypr, /^monitor = videorc-lab, 1920x1080@30, 20000x0, 1$/m)
  assert.match(hypr, /^exec-once = hyprctl output create headless videorc-lab$/m)
  const xdph = await readFile(join(LINUX_CONFIG, 'xdph.conf.example'), 'utf8')
  assert.equal(parseXdphPicker(xdph), '/home/videorc-lab/.local/bin/videorc-lab-share-picker')
})
