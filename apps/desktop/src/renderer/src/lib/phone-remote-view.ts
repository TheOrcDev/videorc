import { encode } from 'uqr'

import type { RemoteLanDevice, RemoteLanStatus } from '@/lib/backend'

/**
 * Phone remote is off by default; an empty card body reads as a render bug.
 * The line says what turning it on does, never "Off" beside the switch
 * (plan 174 V-6).
 */
export const PHONE_REMOTE_OFF_HINT =
  'Turning this on also turns on Remote control, and pairs phones with a code you scan.'

/** Nothing connected this long after a code is shown ⇒ explain why not. */
export const PAIRING_TROUBLE_HINT_AFTER_MS = 30_000

/**
 * One SVG path for the whole code (a run per dark span) — a few hundred
 * commands instead of a DOM node per module.
 */
export function qrCodePath(text: string): { path: string; size: number } {
  const { data, size } = encode(text, { ecc: 'M', border: 2 })
  let path = ''
  for (let y = 0; y < size; y++) {
    let x = 0
    while (x < size) {
      if (!data[y][x]) {
        x++
        continue
      }
      let run = 1
      while (x + run < size && data[y][x + run]) run++
      path += `M${x} ${y}h${run}v1h-${run}z`
      x += run
    }
  }
  return { path, size }
}

export function pairingSecondsLeft(expiresAt: string | undefined, nowMs: number): number {
  if (!expiresAt) return 0
  const expires = Date.parse(expiresAt)
  if (Number.isNaN(expires)) return 0
  return Math.max(0, Math.ceil((expires - nowMs) / 1000))
}

export function formatCountdown(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`
}

export function deviceActivityLabel(device: RemoteLanDevice, nowMs: number): string {
  if (device.connected) return 'Connected'
  const seen = device.lastSeenAt ? Date.parse(device.lastSeenAt) : Number.NaN
  if (Number.isNaN(seen)) return 'Never connected'
  const minutes = Math.floor(Math.max(0, nowMs - seen) / 60_000)
  if (minutes < 1) return 'Seen just now'
  if (minutes < 60) return `Seen ${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `Seen ${hours} h ago`
  return `Seen ${Math.floor(hours / 24)} d ago`
}

/** The one line under the toggle: what is wrong, or where phones connect. */
export function phoneRemoteSummary(status: RemoteLanStatus): {
  tone: 'ok' | 'warning'
  text: string
} {
  if (status.bindError) return { tone: 'warning', text: status.bindError }
  if (status.addresses.length === 0) {
    return {
      tone: 'warning',
      text: 'No Wi-Fi or Ethernet network found. Connect this computer to the same network as your phone.'
    }
  }
  const connected = status.devices.filter((device) => device.connected).length
  const where = status.port ? `${status.addresses[0]}:${status.port}` : status.addresses[0]
  return {
    tone: 'ok',
    text:
      connected > 0
        ? `${connected} phone${connected === 1 ? '' : 's'} connected · ${where}`
        : `Listening on ${where} · same Wi-Fi only`
  }
}

/** The backend keeps at most this many characters of a phone's name
 * (`MAX_DEVICE_NAME_CHARS` in remote_lan.rs). */
export const PHONE_NAME_MAX_CHARS = 40

/** The name Rename… saves, or null when there is nothing to save (empty or
 * unchanged), so Save stays disabled (plan 174 I-28). */
export function renamedPhoneName(current: string, typed: string): string | null {
  const next = typed.trim().slice(0, PHONE_NAME_MAX_CHARS)
  return next === '' || next === current ? null : next
}

/**
 * Each paired phone's name as the list shows it. Phones pair as
 * "iPhone · Safari", so repeats are numbered in list order ("iPhone · Safari
 * 2") until the streamer renames them (plan 174 I-28).
 */
export function phoneDisplayNames(
  devices: readonly Pick<RemoteLanDevice, 'id' | 'name'>[]
): Map<string, string> {
  const seen = new Map<string, number>()
  const names = new Map<string, string>()
  for (const device of devices) {
    const index = (seen.get(device.name) ?? 0) + 1
    seen.set(device.name, index)
    names.set(device.id, index > 1 ? `${device.name} ${index}` : device.name)
  }
  return names
}
