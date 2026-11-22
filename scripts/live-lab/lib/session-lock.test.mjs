import assert from 'node:assert/strict'
import test from 'node:test'

import { renderMarkerFrame } from './card-markers.mjs'
import { cardUpStep } from './common-steps.mjs'
import { FAIL, PASS, WARN, evaluateLinuxSessionLock } from './doctor-checks.mjs'
import {
  checkLabPicture,
  judgeLabPicture,
  judgeSessionLock,
  labPictureProblem,
  monitorsShowLock,
  parseHyprlandLocked,
  parseLockedHint,
  parsePpm,
  readSessionLock,
  runningCommands
} from './linux-desktop.mjs'

// Plan 257 S0: the Linux lab tells a locked session and checks the picture.
// Host-independent: every command and frame is a fake.

// What ogre printed under omarchy-shell's lock on 2026-11-21 (Hyprland 0.56.2):
// the compositor knows, logind does not (omarchy-shell never sets LockedHint).
const OGRE_LOCKED = {
  locked: '{\n    "locked": true\n}\n',
  monitors: [
    { name: 'eDP-1', solitaryBlockedBy: ['LOCK', 'WINDOWED', 'CANDIDATE'] },
    { name: 'videorc-lab', solitaryBlockedBy: ['LOCK', 'WINDOWED', 'CANDIDATE'] }
  ],
  lockedHint: 'no\n',
  running: ['Hyprland', 'quickshell', 'mako']
}
const OGRE_UNLOCKED = {
  locked: '{\n    "locked": false\n}\n',
  monitors: [
    { name: 'eDP-1', solitaryBlockedBy: ['WINDOWED', 'CANDIDATE'] },
    { name: 'videorc-lab', solitaryBlockedBy: ['WINDOWED', 'CANDIDATE'] }
  ],
  lockedHint: 'no\n',
  running: ['Hyprland', 'quickshell', 'mako']
}

function fakeExec(state, calls = []) {
  return async (command, args) => {
    calls.push([command, ...args].join(' '))
    const line = [command, ...args].join(' ')
    if (line === 'hyprctl -j locked') {
      return state.locked === undefined
        ? { code: 0, stdout: 'unknown request\n', stderr: '' }
        : { code: 0, stdout: state.locked, stderr: '' }
    }
    if (line === 'hyprctl -j monitors') {
      return { code: 0, stdout: JSON.stringify(state.monitors ?? []), stderr: '' }
    }
    if (line.startsWith('loginctl show-user')) return { code: 0, stdout: '2\n', stderr: '' }
    if (line === 'loginctl show-session 2 -p LockedHint --value') {
      return { code: 0, stdout: state.lockedHint ?? '', stderr: '' }
    }
    return { code: 127, stdout: '', stderr: `no fake for ${line}` }
  }
}

function readLockFor(state) {
  return readSessionLock({
    sessionEnv: {},
    exec: fakeExec(state),
    user: 'orcdev',
    running: async () => new Set(state.running ?? [])
  })
}

function ppm(width, height, pixels) {
  const header = Buffer.from(`P6\n# grim\n${width} ${height}\n255\n`, 'ascii')
  return Buffer.concat([header, Buffer.from(pixels)])
}

function fill(width, height, rgbAt) {
  const pixels = new Uint8Array(width * height * 3)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      pixels.set(rgbAt(x, y), (y * width + x) * 3)
    }
  }
  return pixels
}

// 16:9 like the lab output, small enough to stay fast.
const W = 640
const H = 360
const CARD = ppm(W, H, renderMarkerFrame({ width: W, height: H, sceneId: 0, stepIndex: 0 }))
const BLACK = ppm(W, H, new Uint8Array(W * H * 3))
// The Omarchy lock: a purple-to-pink blur with a password box in the middle.
const LOCK_SCREEN = ppm(
  W,
  H,
  fill(W, H, (x, y) => {
    const inBox = x > 256 && x < 384 && y > 168 && y < 192
    return inBox ? [58, 40, 60] : [120 + Math.round((x / W) * 100), 60, 150 - Math.round(y / 4)]
  })
)

test('session lock: each signal parses, unknown stays null', () => {
  assert.equal(parseHyprlandLocked('{"locked": true}'), true)
  assert.equal(parseHyprlandLocked('{"locked": false}'), false)
  assert.equal(parseHyprlandLocked('true\n'), true)
  assert.equal(parseHyprlandLocked('unknown request\n'), null)
  assert.equal(parseHyprlandLocked(''), null)

  assert.equal(monitorsShowLock(OGRE_LOCKED.monitors), true)
  assert.equal(monitorsShowLock(OGRE_UNLOCKED.monitors), false)
  // A monitor with no workspace stops at WORKSPACE before it reaches LOCK.
  assert.equal(monitorsShowLock([{ name: 'x', solitaryBlockedBy: ['WORKSPACE'] }]), null)
  assert.equal(monitorsShowLock([{ name: 'old-hyprland' }]), null)
  assert.equal(monitorsShowLock(null), null)

  assert.equal(parseLockedHint('yes\n'), true)
  assert.equal(parseLockedHint('LockedHint=no'), false)
  assert.equal(parseLockedHint(''), null)
})

test('session lock: omarchy-shell lock reads as locked though logind says no', async () => {
  const lock = await readLockFor(OGRE_LOCKED)
  assert.equal(lock.locked, true)
  assert.equal(lock.locker, 'omarchy-shell (quickshell)')
  assert.deepEqual(lock.sources, ['hyprland=locked', 'monitors=locked', 'logind=unlocked'])
  assert.match(lock.detail, /^The session is locked \(hyprland, monitors; locker: omarchy-shell/)

  const doctor = evaluateLinuxSessionLock(lock)
  assert.equal(doctor.status, FAIL)
  assert.equal(doctor.name, 'session lock')
  assert.match(doctor.detail, /refuses to run under it \(plan 257 D12\)\. Unlock it at the console/)
})

test('session lock: unlocked passes, quickshell alone is not a lock', async () => {
  const lock = await readLockFor(OGRE_UNLOCKED)
  assert.equal(lock.locked, false)
  assert.equal(evaluateLinuxSessionLock(lock).status, PASS)
  assert.match(evaluateLinuxSessionLock(lock).detail, /unlocked \(hyprland=unlocked/)
})

test('session lock: logind alone (another compositor) and an old Hyprland', async () => {
  const swayLocked = await readLockFor({
    locked: undefined,
    monitors: [],
    lockedHint: 'yes\n',
    running: ['swaylock']
  })
  assert.equal(swayLocked.locked, true)
  assert.equal(swayLocked.locker, 'swaylock')
  assert.match(swayLocked.detail, /\(logind; locker: swaylock\)/)

  // No protocol answers at all: a dedicated locker running means locked...
  const hyprlockOnly = judgeSessionLock({ running: new Set(['hyprlock']) })
  assert.equal(hyprlockOnly.locked, true)
  assert.match(hyprlockOnly.detail, /likely locked: hyprlock runs/)
  // ...a shell that also draws the bar does not, and nothing is unknown.
  const unknown = judgeSessionLock({ running: new Set(['quickshell']) })
  assert.equal(unknown.locked, null)
  assert.equal(evaluateLinuxSessionLock(unknown).status, WARN)
  assert.match(evaluateLinuxSessionLock(unknown).detail, /card-up/)
  assert.equal(evaluateLinuxSessionLock(null).status, WARN)

  // A protocol "unlocked" wins over a locker process left behind.
  assert.equal(judgeSessionLock({ hyprland: false, running: ['hyprlock'] }).locked, false)
})

test('session lock: running commands come from /proc/<pid>/comm only', async () => {
  const names = await runningCommands({
    listDir: async () => ['1', '42', 'self', 'sys'],
    readComm: async (pid) => ({ 1: 'systemd\n', 42: 'quickshell\n' })[pid]
  })
  assert.deepEqual([...names], ['systemd', 'quickshell'])
})

test('lab picture: PPM parsing tolerates comments and refuses other formats', () => {
  const frame = parsePpm(ppm(2, 1, [255, 0, 0, 0, 0, 255]))
  assert.deepEqual([frame.width, frame.height, frame.channels], [2, 1, 3])
  assert.deepEqual([...frame.pixels], [255, 0, 0, 0, 0, 255])
  assert.throws(() => parsePpm(Buffer.from('P3\n1 1\n255\n0 0 0\n')), /not a binary PPM/)
  assert.throws(() => parsePpm(Buffer.from('P6\n2 2\n255\n\0\0\0')), /expected 12/)
  assert.throws(() => parsePpm(Buffer.from('P6\n1 1\n65535\n\0\0\0\0\0\0')), /unsupported/)
})

test('lab picture: the card decodes, a black output and a lock screen do not', () => {
  const card = judgeLabPicture(parsePpm(CARD))
  assert.equal(card.shows, 'card')
  assert.equal(card.sceneId, 0)
  assert.equal(card.step, 0)

  const black = judgeLabPicture(parsePpm(BLACK))
  assert.equal(black.shows, 'black')
  assert.equal(black.maxLuma, 0)

  const lockScreen = judgeLabPicture(parsePpm(LOCK_SCREEN))
  assert.equal(lockScreen.shows, 'not-card')
  assert.ok(lockScreen.errors.length > 0)
})

test('lab picture: locked, unlocked and black cases name their cause', async () => {
  const lockedState = await readLockFor(OGRE_LOCKED)
  const unlockedState = await readLockFor(OGRE_UNLOCKED)
  const picture = (frame, lock) =>
    checkLabPicture({
      outputName: 'videorc-lab',
      sessionEnv: {},
      grab: async () => frame,
      readLock: async () => lock
    })

  // Unlocked, the card on the output: no problem, and no lock read needed.
  const card = await picture(CARD, null)
  assert.equal(card.shows, 'card')
  assert.equal(card.lock, undefined)
  assert.equal(labPictureProblem(card), null)

  // Locked: the lock screen streams instead of the card.
  const locked = await picture(LOCK_SCREEN, lockedState)
  assert.equal(locked.shows, 'not-card')
  assert.match(
    labPictureProblem(locked),
    /^the lab output "videorc-lab" shows the lock screen, not the test card: The session is locked .*plan 257 D12/
  )

  // Locked with the output asleep: black, and still blamed on the lock.
  const lockedDark = await picture(BLACK, lockedState)
  assert.match(labPictureProblem(lockedDark), /"videorc-lab" is black: The session is locked/)

  // Unlocked but black: the output is off or nothing draws on it.
  const black = await picture(BLACK, unlockedState)
  assert.match(labPictureProblem(black), /is black \(brightest pixel luma 0\).*DPMS/)

  // Unlocked but something else covers the output.
  const other = await picture(LOCK_SCREEN, unlockedState)
  assert.match(labPictureProblem(other), /does not show the test card \(markers: /)

  // grim failing is a failure too, never a silent pass.
  const broken = await checkLabPicture({
    outputName: 'videorc-lab',
    grab: async () => {
      throw new Error('grim: compositor does not support wlr-screencopy')
    },
    readLock: async () => unlockedState
  })
  assert.match(labPictureProblem(broken), /could not grab .*wlr-screencopy/)
})

test('card-up fails on a picture that is not the card, passes on the card', async () => {
  const step = cardUpStep()
  const ctxFor = (labPicture) => ({
    card: { lastPulse: () => ({ audioState: 'running', visible: true }) },
    waitFor: async (predicate) => predicate(),
    labPicture
  })
  const lockedState = await readLockFor(OGRE_LOCKED)

  const onCard = await step.run(
    ctxFor(() =>
      checkLabPicture({ outputName: 'videorc-lab', grab: async () => CARD, readLock: null })
    )
  )
  assert.equal(onCard.picture.shows, 'card')
  assert.equal(step.expect(onCard), true)

  const underLock = await step.run(
    ctxFor(() =>
      checkLabPicture({
        outputName: 'videorc-lab',
        grab: async () => LOCK_SCREEN,
        readLock: async () => lockedState
      })
    )
  )
  assert.match(step.expect(underLock), /shows the lock screen/)

  // macOS (no labPicture): the pulse alone, unchanged.
  const mac = await step.run(ctxFor(null))
  assert.deepEqual(mac, { audioState: 'running', visible: true })
  assert.equal(step.expect(mac), true)
})
