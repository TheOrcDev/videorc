import { spawnSync } from 'node:child_process'

// Is the graphical session locked? A portal capture of a locked session
// records the lock screen, so a window behind it never reaches the take, even
// though the compositor keeps giving that window frame callbacks while the
// display is on (ogre, Hyprland 0.56 with a quickshell lock, 2026-11-07).
// logind's LockedHint stayed "no" there, so Hyprland is asked directly.

/**
 * Hyprland lists LOCK among a monitor's solitaryBlockedBy reasons while a
 * session lock is held. Returns null when the output does not carry the field.
 */
export function hyprlandSessionLocked(monitors) {
  if (!Array.isArray(monitors)) return null
  const reasons = monitors.map((monitor) => monitor?.solitaryBlockedBy)
  if (reasons.length === 0 || !reasons.every(Array.isArray)) return null
  return reasons.some((list) => list.includes('LOCK'))
}

/** logind's LockedHint (`yes`/`no`), set by desktops such as GNOME. */
export function logindLockedHint(text) {
  const value = String(text ?? '').trim()
  if (value === 'yes') return true
  if (value === 'no') return false
  return null
}

/**
 * Probes the session lock: Hyprland's monitors when HYPRLAND_INSTANCE_SIGNATURE
 * is set, then logind's LockedHint for XDG_SESSION_ID. `locked` is true when
 * any probe says so, false when one answered and none did, null when none
 * could answer. Never throws.
 */
export function probeLinuxSessionLock({ env = process.env, run = runQuiet } = {}) {
  const answers = []
  if (env.HYPRLAND_INSTANCE_SIGNATURE) {
    const output = run('hyprctl', ['-j', 'monitors', 'all'], env)
    let locked = null
    try {
      locked = output === null ? null : hyprlandSessionLocked(JSON.parse(output))
    } catch {
      locked = null
    }
    answers.push({ via: 'hyprland', locked })
  }
  if (env.XDG_SESSION_ID) {
    const output = run(
      'loginctl',
      ['show-session', env.XDG_SESSION_ID, '-p', 'LockedHint', '--value'],
      env
    )
    answers.push({ via: 'logind', locked: logindLockedHint(output) })
  }
  const known = answers.filter((answer) => answer.locked !== null)
  const locked = known.length === 0 ? null : known.some((answer) => answer.locked)
  return { locked, probes: answers }
}

function runQuiet(command, args, env) {
  const result = spawnSync(command, args, { env, encoding: 'utf8', timeout: 5000 })
  return result.status === 0 ? result.stdout : null
}
