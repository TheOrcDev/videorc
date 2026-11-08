import assert from 'node:assert/strict'
import test from 'node:test'

import {
  hyprlandSessionLocked,
  logindLockedHint,
  probeLinuxSessionLock
} from './linux-session-lock.mjs'

// `hyprctl -j monitors all` on ogre, quickshell lock held (trimmed).
const lockedMonitors = [
  { name: 'eDP-1', solitaryBlockedBy: ['LOCK', 'WINDOWED', 'CANDIDATE'] },
  { name: 'videorc-lab', solitaryBlockedBy: ['LOCK', 'WINDOWED', 'CANDIDATE'] }
]
const unlockedMonitors = [{ name: 'eDP-1', solitaryBlockedBy: ['WINDOWED', 'CANDIDATE'] }]

test('Hyprland reports a held session lock in solitaryBlockedBy', () => {
  assert.equal(hyprlandSessionLocked(lockedMonitors), true)
  assert.equal(hyprlandSessionLocked(unlockedMonitors), false)
  // An older Hyprland without the field, or no monitors, cannot answer.
  assert.equal(hyprlandSessionLocked([{ name: 'eDP-1' }]), null)
  assert.equal(hyprlandSessionLocked([]), null)
  assert.equal(hyprlandSessionLocked({ error: 'no instance' }), null)
})

test('logind LockedHint parses yes and no only', () => {
  assert.equal(logindLockedHint('yes\n'), true)
  assert.equal(logindLockedHint('no'), false)
  assert.equal(logindLockedHint(''), null)
  assert.equal(logindLockedHint(null), null)
})

test('any probe reporting a lock means locked', () => {
  const calls = []
  const run = (command, args) => {
    calls.push([command, ...args].join(' '))
    return command === 'hyprctl' ? JSON.stringify(lockedMonitors) : 'no\n'
  }
  const result = probeLinuxSessionLock({
    env: { HYPRLAND_INSTANCE_SIGNATURE: 'sig', XDG_SESSION_ID: '3' },
    run
  })
  // ogre: logind said "no" while the quickshell lock was held.
  assert.equal(result.locked, true)
  assert.deepEqual(result.probes, [
    { via: 'hyprland', locked: true },
    { via: 'logind', locked: false }
  ])
  assert.deepEqual(calls, [
    'hyprctl -j monitors all',
    'loginctl show-session 3 -p LockedHint --value'
  ])
})

test('the probe answers unlocked, or unknown, without throwing', () => {
  const unlocked = probeLinuxSessionLock({
    env: { HYPRLAND_INSTANCE_SIGNATURE: 'sig' },
    run: () => JSON.stringify(unlockedMonitors)
  })
  assert.equal(unlocked.locked, false)
  const broken = probeLinuxSessionLock({
    env: { HYPRLAND_INSTANCE_SIGNATURE: 'sig', XDG_SESSION_ID: '3' },
    run: (command) => (command === 'hyprctl' ? 'not json' : null)
  })
  assert.equal(broken.locked, null)
  assert.deepEqual(probeLinuxSessionLock({ env: {}, run: () => 'yes' }), {
    locked: null,
    probes: []
  })
})
