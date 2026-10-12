#!/usr/bin/env node

// Plan 176 L0: store the live lab's secrets and authorize its two YouTube
// accounts. Secrets are read with hidden input, from the clipboard or from
// Google's client JSON, and written only to ~/.videorc-live-lab/config.json
// (0600). Output shows the last 4 characters of a secret, never more.

import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'

import {
  ROLES,
  STREAM_KEY_SLOTS,
  configPath,
  emptyConfig,
  fingerprint,
  labDir,
  mergeStreamKeys,
  normalizeHandle,
  parseClientJson,
  readConfig,
  redact,
  sameHandle,
  summarizeConfig,
  validateClient,
  writeConfig
} from './lib/config.mjs'
import { validateWebhookUrl } from './lib/discord.mjs'
import {
  buildAuthUrl,
  createPkcePair,
  createState,
  exchangeCode,
  fetchMyChannel,
  startLoopback
} from './lib/oauth.mjs'
import {
  clearClipboard,
  promptHidden,
  promptVisible,
  readClipboard,
  requireTerminal
} from './lib/prompt.mjs'

const USAGE = `Usage: pnpm live:hookup [options]

With no options: client (if missing), both stream keys, then consent for
the broadcaster and the viewer. Needs a terminal for the hidden prompts.

  --keys-only                 Hidden prompts for both stream keys. Blank keeps the stored key.
  --stream-key <slot> --from-clipboard
                              Store one key (horizontal | vertical) from the clipboard,
                              then clear the clipboard. Works from Claude Code's ! prompt.
  --client-json <path>        Import a Desktop OAuth client from Google's "Download JSON".
  --client                    Type the client id and (hidden) secret.
  --role <broadcaster|viewer> Run Google consent for one role.
  --handle <@handle>          The lab channel (default @VideorcApp).
  --lab-display <name>        The virtual display Videorc captures: as macOS names it, or the
                              Hyprland output on Linux (e.g. videorc-lab).
  --discord-webhook           Store the P0 Discord webhook URL from the clipboard, then clear
                              the clipboard (live:publish pings it on a P0 incident).
  --show                      Print what is stored (fingerprints only).
`

const ROLE_HINT = {
  broadcaster:
    'sign in with the Google account that owns the lab channel (pick the channel if asked)',
  viewer: 'sign in with your personal Google account (the viewer, not the channel account)'
}

async function main() {
  const { values } = parseArgs({
    options: {
      'keys-only': { type: 'boolean' },
      'stream-key': { type: 'string' },
      'from-clipboard': { type: 'boolean' },
      'client-json': { type: 'string' },
      client: { type: 'boolean' },
      role: { type: 'string' },
      handle: { type: 'string' },
      'lab-display': { type: 'string' },
      'discord-webhook': { type: 'boolean' },
      show: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' }
    },
    strict: true
  })
  if (values.help) {
    console.log(USAGE)
    return
  }
  if (values['from-clipboard'] && !values['stream-key']) {
    throw new Error('--from-clipboard needs --stream-key horizontal or --stream-key vertical.')
  }

  const dir = labDir()
  let config = (await readConfig(dir)) ?? emptyConfig()
  const save = async (next, message) => {
    config = next
    await writeConfig(dir, config)
    console.log(message)
  }

  const explicit =
    values['keys-only'] ||
    values['stream-key'] ||
    values['client-json'] ||
    values.client ||
    values.role ||
    values.handle ||
    values['lab-display'] ||
    values['discord-webhook'] ||
    values.show

  if (values.handle) {
    const handle = normalizeHandle(values.handle)
    await save({ ...config, channel: { handle } }, `Lab channel set to ${handle}.`)
  }

  if (values['lab-display']) {
    const name = values['lab-display'].trim()
    await save({ ...config, labDisplay: { name } }, `Lab display set to "${name}".`)
  }

  if (values['discord-webhook']) {
    const value = await readClipboard()
    if (!value) throw new Error('The clipboard is empty. Copy the Discord webhook URL first.')
    const webhookUrl = validateWebhookUrl(value)
    await save(
      { ...config, discord: { webhookUrl, updatedAt: new Date().toISOString() } },
      `Discord webhook stored ${fingerprint(webhookUrl)}.`
    )
    await clearClipboard()
    console.log('Clipboard cleared.')
  }

  if (values['client-json']) {
    const path = values['client-json']
    const client = parseClientJson(await readFile(path, 'utf8'))
    await save(
      { ...config, client: { ...client, importedAt: new Date().toISOString() } },
      `Client stored: id ${fingerprint(client.id)}, secret ${fingerprint(client.secret)}.\nImported from ${path}. Delete that file now; the lab no longer needs it.`
    )
  } else if (values.client || (!explicit && !config.client)) {
    requireTerminal('Entering the OAuth client')
    console.log('Lab Google project > Google Auth Platform > Clients > your Desktop client.')
    const id = await promptVisible('Client id: ')
    const secret = await promptHidden('Client secret (hidden): ')
    const client = validateClient({ id, secret })
    await save(
      { ...config, client: { ...client, importedAt: new Date().toISOString() } },
      `Client stored: id ${fingerprint(client.id)}, secret ${fingerprint(client.secret)}.`
    )
  }

  if (values['stream-key']) {
    const slot = values['stream-key']
    if (!STREAM_KEY_SLOTS[slot]) {
      throw new Error(`--stream-key must be one of: ${Object.keys(STREAM_KEY_SLOTS).join(', ')}.`)
    }
    if (!values['from-clipboard']) {
      requireTerminal('Entering a stream key')
    }
    const value = values['from-clipboard']
      ? await readClipboard()
      : await promptHidden(`"${STREAM_KEY_SLOTS[slot]}" stream key (hidden): `)
    if (!value) {
      throw new Error(
        values['from-clipboard']
          ? 'The clipboard is empty. Copy the key in YouTube Studio first.'
          : 'Nothing entered.'
      )
    }
    const streamKeys = mergeStreamKeys(config.streamKeys, { [slot]: value })
    await save(
      { ...config, streamKeys },
      `Stored "${STREAM_KEY_SLOTS[slot]}" key ${fingerprint(streamKeys[slot].key)}.`
    )
    if (values['from-clipboard']) {
      await clearClipboard()
      console.log('Clipboard cleared.')
    }
  } else if (values['keys-only'] || !explicit) {
    requireTerminal('Entering stream keys')
    console.log(
      'YouTube Studio > Create > Go live > Stream > Stream key. Blank keeps the stored key.'
    )
    const entered = {}
    for (const [slot, label] of Object.entries(STREAM_KEY_SLOTS)) {
      const current = config.streamKeys?.[slot]?.key
      entered[slot] = await promptHidden(
        `"${label}" key${current ? ` (stored ${fingerprint(current)})` : ''} (hidden): `
      )
    }
    const streamKeys = mergeStreamKeys(config.streamKeys, entered)
    await save(
      { ...config, streamKeys },
      Object.entries(STREAM_KEY_SLOTS)
        .map(([slot, label]) => `"${label}": ${fingerprint(streamKeys[slot]?.key)}`)
        .join('\n')
    )
  }

  const roles = values.role ? [values.role] : explicit ? [] : ROLES
  for (const role of roles) {
    if (!ROLES.includes(role)) {
      throw new Error(`--role must be one of: ${ROLES.join(', ')}.`)
    }
    const entry = await authorize(role, config)
    await save(
      { ...config, roles: { ...config.roles, [role]: entry } },
      `${role}: ${entry.channelTitle} (${entry.channelHandle ?? entry.channelId}), refresh token ${fingerprint(entry.refreshToken)}. Testing-mode tokens last 7 days; live:doctor warns on day 6.`
    )
  }

  if (values.show || !explicit) {
    console.log(`\n${configPath(dir)}`)
    for (const line of summarizeConfig(config)) console.log(`  ${line}`)
  }
}

async function authorize(role, config) {
  if (!config.client) {
    throw new Error('No OAuth client stored. Run live:hookup --client-json <path> first.')
  }
  const { verifier, challenge } = createPkcePair()
  const state = createState()
  const loopback = await startLoopback({ state })
  const url = buildAuthUrl({
    clientId: config.client.id,
    redirectUri: loopback.redirectUri,
    challenge,
    state
  })
  console.log(`\n${role}: opening Google consent. In the browser, ${ROLE_HINT[role]}.`)
  console.log(`If no browser opens, visit:\n${url}\n`)
  spawn('open', [url], { stdio: 'ignore', detached: true })
    .on('error', () => {})
    .unref()

  const code = await loopback.code
  const tokens = await exchangeCode({
    clientId: config.client.id,
    clientSecret: config.client.secret,
    code,
    verifier,
    redirectUri: loopback.redirectUri
  })
  let channel
  try {
    channel = await fetchMyChannel({ accessToken: tokens.accessToken })
  } catch (error) {
    if (role === 'viewer' && /no YouTube channel/.test(error.message)) {
      throw new Error(
        'The viewer account has no YouTube channel, so it cannot chat. Create one at youtube.com/create_channel, then rerun --role viewer.'
      )
    }
    throw error
  }

  if (role === 'broadcaster' && !sameHandle(channel.channelHandle ?? '', config.channel.handle)) {
    throw new Error(
      `Signed in as "${channel.channelTitle}" (${channel.channelHandle ?? channel.channelId}), expected ${config.channel.handle}. Rerun and pick the lab channel; nothing was saved.`
    )
  }
  if (role === 'viewer') {
    const broadcaster = config.roles?.broadcaster
    if (
      channel.channelId === broadcaster?.channelId ||
      sameHandle(channel.channelHandle ?? '', config.channel.handle)
    ) {
      throw new Error(
        'The viewer signed in as the lab channel. Rerun --role viewer with your personal account; nothing was saved.'
      )
    }
  }
  return {
    refreshToken: tokens.refreshToken,
    scope: tokens.scope,
    ...channel,
    authorizedAt: new Date().toISOString()
  }
}

main().catch(async (error) => {
  const config = await readConfig(labDir()).catch(() => null)
  console.error(`live:hookup failed: ${redact(error.message, config)}`)
  process.exitCode = 1
})
