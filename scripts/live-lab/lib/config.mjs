import { randomBytes } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Plan 176 L0. Every live lab secret (OAuth client secret, stream keys,
// refresh tokens) lives only in this file: dir 0700, file 0600. Nothing the
// lab prints shows more than the last 4 characters of a secret.

export const CONFIG_VERSION = 1
export const CONFIG_FILE = 'config.json'
export const DIR_MODE = 0o700
export const FILE_MODE = 0o600
export const DEFAULT_CHANNEL_HANDLE = '@VideorcApp'

export const STREAM_KEY_SLOTS = Object.freeze({
  horizontal: 'Videorc lab',
  vertical: 'Videorc lab vertical'
})

export const ROLES = Object.freeze(['broadcaster', 'viewer'])

export function labDir(env = process.env) {
  const override = env.VIDEORC_LIVE_LAB_DIR?.trim()
  return override ? override : join(homedir(), '.videorc-live-lab')
}

// Plan 178 U4. The non-secret working folder: run folders, run.lock, the
// STOP file and schedule logs. Separate from labDir() so nothing that holds a
// secret ever sits next to something a report copies out.
export const LAB_USER = 'videorc-lab'

export function workDir(env = process.env) {
  const override = env.VIDEORC_LIVE_LAB_WORK_DIR?.trim()
  return override ? override : join(homedir(), 'videorc-live-lab')
}

export function configPath(dir) {
  return join(dir, CONFIG_FILE)
}

export function emptyConfig() {
  return {
    version: CONFIG_VERSION,
    channel: { handle: DEFAULT_CHANNEL_HANDLE },
    client: null,
    streamKeys: {},
    roles: {},
    labDisplay: null
  }
}

export async function readConfig(dir) {
  let text
  try {
    text = await readFile(configPath(dir), 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null
    }
    throw error
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`${configPath(dir)} is not valid JSON. Rerun live:hookup.`)
  }
  if (parsed?.version !== CONFIG_VERSION) {
    throw new Error(
      `${configPath(dir)} has version ${parsed?.version}, expected ${CONFIG_VERSION}.`
    )
  }
  return { ...emptyConfig(), ...parsed }
}

// Atomic write: a fresh 0600 temp file in the same dir, fsync, rename. The dir
// is created (or tightened) to 0700 first, so the secret never sits in a
// readable file, even for a moment.
export async function writeConfig(dir, config) {
  await mkdir(dir, { recursive: true, mode: DIR_MODE })
  await chmod(dir, DIR_MODE)
  const target = configPath(dir)
  const temp = join(dir, `.${CONFIG_FILE}.${randomBytes(6).toString('hex')}.tmp`)
  const handle = await open(temp, 'wx', FILE_MODE)
  try {
    await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`, 'utf8')
    await handle.sync()
  } catch (error) {
    await handle.close()
    await rm(temp, { force: true })
    throw error
  }
  await handle.close()
  await chmod(temp, FILE_MODE)
  await rename(temp, target)
}

export async function inspectPermissions(dir) {
  const result = { dirMode: null, fileMode: null }
  try {
    result.dirMode = (await stat(dir)).mode & 0o777
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  try {
    result.fileMode = (await stat(configPath(dir))).mode & 0o777
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  return result
}

export function formatMode(mode) {
  return mode === null ? 'missing' : `0${mode.toString(8).padStart(3, '0')}`
}

// Last 4 characters only. Short values (never a real secret) show nothing.
export function fingerprint(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return '(not set)'
  }
  if (value.length < 12) {
    return '****'
  }
  return `****${value.slice(-4)}`
}

export function secretValues(config) {
  if (!config) return []
  const values = [config.client?.secret, config.client?.id]
  for (const slot of Object.values(config.streamKeys ?? {})) {
    values.push(slot?.key)
  }
  for (const role of Object.values(config.roles ?? {})) {
    values.push(role?.refreshToken)
  }
  return values.filter((value) => typeof value === 'string' && value.length >= 12)
}

// Replaces every configured secret (and any extra, like a fresh access token)
// with its fingerprint. Longest first, so a secret that contains another is
// never half-redacted.
export function redact(text, config, extra = []) {
  let output = String(text)
  const values = [...secretValues(config), ...extra.filter((value) => value?.length >= 12)].sort(
    (left, right) => right.length - left.length
  )
  for (const value of values) {
    output = output.split(value).join(fingerprint(value))
  }
  return output
}

const DESKTOP_CLIENT_ID = /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/

export function validateClient({ id, secret }) {
  const clientId = String(id ?? '').trim()
  const clientSecret = String(secret ?? '').trim()
  if (!DESKTOP_CLIENT_ID.test(clientId)) {
    throw new Error('The client id must look like <number>-<id>.apps.googleusercontent.com.')
  }
  if (clientSecret.length < 12 || /\s/.test(clientSecret)) {
    throw new Error('The client secret is missing or malformed.')
  }
  return { id: clientId, secret: clientSecret }
}

// Google's "Download JSON" for an OAuth client. Only a Desktop client works
// for the loopback consent; a Web client file has a `web` key instead.
export function parseClientJson(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('The client file is not valid JSON.')
  }
  if (parsed?.web && !parsed?.installed) {
    throw new Error(
      'This is a Web application client. Create a Desktop app client in the lab project instead.'
    )
  }
  const installed = parsed?.installed
  if (!installed) {
    throw new Error('The client file has no "installed" section (expected a Desktop app client).')
  }
  return validateClient({ id: installed.client_id, secret: installed.client_secret })
}

export function validateStreamKey(value) {
  const key = String(value ?? '').trim()
  if (key.length < 16 || /\s/.test(key)) {
    throw new Error('That does not look like a YouTube stream key (16+ characters, no spaces).')
  }
  return key
}

// Blank input keeps what is stored; anything else replaces it.
export function mergeStreamKeys(existing, entered, now = new Date()) {
  const next = { ...(existing ?? {}) }
  for (const [slot, label] of Object.entries(STREAM_KEY_SLOTS)) {
    const value = entered?.[slot]
    if (typeof value !== 'string' || value.trim() === '') continue
    next[slot] = { label, key: validateStreamKey(value), updatedAt: now.toISOString() }
  }
  return next
}

export function normalizeHandle(value) {
  const trimmed = String(value ?? '')
    .trim()
    .replace(/^(https?:\/\/)?(www\.|m\.)?youtube\.com\//i, '')
  return trimmed.startsWith('@') ? trimmed : `@${trimmed}`
}

export function sameHandle(left, right) {
  return normalizeHandle(left).toLowerCase() === normalizeHandle(right).toLowerCase()
}

export function summarizeConfig(config) {
  const row = (label, value) => `${label.padEnd(15)} ${value}`
  const client = config.client
    ? `id ${fingerprint(config.client.id)}, secret ${fingerprint(config.client.secret)}`
    : '(not set)'
  const lines = [row('channel', config.channel?.handle ?? '(not set)'), row('client', client)]
  for (const [slot, label] of Object.entries(STREAM_KEY_SLOTS)) {
    lines.push(row(`key ${slot}`, `${label}: ${fingerprint(config.streamKeys?.[slot]?.key)}`))
  }
  for (const role of ROLES) {
    const entry = config.roles?.[role]
    const value = entry
      ? `${entry.channelTitle ?? '?'} (${entry.channelHandle ?? entry.channelId ?? '?'}), token ${fingerprint(entry.refreshToken)}, authorized ${entry.authorizedAt}`
      : '(not authorized)'
    lines.push(row(role, value))
  }
  lines.push(row('lab display', config.labDisplay?.name ?? '(auto-detect)'))
  return lines
}
