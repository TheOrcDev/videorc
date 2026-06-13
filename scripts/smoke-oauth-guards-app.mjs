import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { connectBackend, request } from './smoke-recording-session.mjs'

const repoRoot = resolve(import.meta.dirname, '..')
const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 90000)
const stateRoot = process.env.VIDEORC_SMOKE_STATE_DIR
  ? resolve(process.env.VIDEORC_SMOKE_STATE_DIR)
  : mkdtempSync(join(tmpdir(), 'videorc-oauth-guards-'))

let appProcess
let stopping = false

try {
  const connection = await launchAndReadConnection()
  const ws = await connectBackend(connection, timeoutMs)
  try {
    const credentials = await request(ws, timeoutMs, 'platformAccounts.oauth.providerCredentials')
    assertProviderCredentials(credentials)

    const refreshedAccounts = await request(ws, timeoutMs, 'platformAccounts.refresh')
    if (!Array.isArray(refreshedAccounts)) {
      throw new Error(`Platform account refresh should return validation results: ${JSON.stringify(refreshedAccounts)}`)
    }

    await request(ws, timeoutMs, 'streamTargets.metadata.update', {
      title: 'Smoke Go Live',
      description: 'Local preflight smoke for OAuth/native guards.',
      defaultPrivacy: 'unlisted',
      targetOverrides: [],
      updatedAt: new Date().toISOString()
    })
    const preflight = await request(ws, timeoutMs, 'streamTargets.confirmation.validate', {
      streaming: preflightStreamingFixture()
    })
    assertPreflight(preflight)

    const secretPreflight = await request(ws, timeoutMs, 'streamTargets.confirmation.validate', {
      streaming: preflightSecretRefFixture()
    })
    assertSecretRefPreflight(secretPreflight)

    const capability = await request(ws, timeoutMs, 'streamTargets.x.capability', {})
    assertXCapability(capability)

    const prepare = await requestRaw(ws, timeoutMs, 'streamTargets.x.prepare', {})
    if (prepare.ok || prepare.error?.code !== 'x-native-live-unavailable') {
      throw new Error(`X native prepare should stay unavailable, got ${JSON.stringify(prepare)}`)
    }

    console.log(
      'OAuth guard smoke OK - credential readiness, refresh alias, preflight blockers, secret-ref preflight, and X native guard verified.'
    )
  } finally {
    ws.close()
  }
} finally {
  await stopApp()
}

function assertProviderCredentials(credentials) {
  if (!Array.isArray(credentials)) {
    throw new Error(`Provider credentials response was not an array: ${JSON.stringify(credentials)}`)
  }
  const byPlatform = new Map(credentials.map((credential) => [credential.platform, credential]))

  const youtube = requireCredential(byPlatform, 'youtube')
  // YouTube bundles a Google Desktop OAuth client, which ships a
  // non-confidential client secret alongside PKCE (Google requires it at the
  // token endpoint for installed apps), so the secret is expected present.
  if (!youtube.ready || !youtube.pkce || !youtube.clientIdPresent || !youtube.clientSecretPresent) {
    throw new Error(`YouTube PKCE readiness mismatch: ${JSON.stringify(youtube)}`)
  }

  const twitch = requireCredential(byPlatform, 'twitch')
  if (twitch.ready || twitch.pkce || !twitch.clientIdPresent || twitch.clientSecretPresent) {
    throw new Error(`Twitch secret gate mismatch: ${JSON.stringify(twitch)}`)
  }
  if (!String(twitch.message).toLowerCase().includes('client secret')) {
    throw new Error(`Twitch missing-secret message was not explicit: ${JSON.stringify(twitch)}`)
  }

  const x = requireCredential(byPlatform, 'x')
  if (!x.ready || !x.pkce || !x.clientIdPresent || x.clientSecretPresent) {
    throw new Error(`X PKCE readiness mismatch: ${JSON.stringify(x)}`)
  }
}

function requireCredential(byPlatform, platform) {
  const credential = byPlatform.get(platform)
  if (!credential) {
    throw new Error(`Missing credential status for ${platform}.`)
  }
  if (credential.clientIdSource !== 'environment') {
    throw new Error(`${platform} should use the smoke environment client ID, got ${credential.clientIdSource}.`)
  }
  return credential
}

function preflightStreamingFixture() {
  const now = new Date().toISOString()
  return {
    enabled: true,
    mode: 'multi',
    defaultOutputPreset: 'stream-1080p60',
    defaultBitrateKbps: 6000,
    selectedTargetId: 'youtube',
    enabledTargetIds: ['youtube', 'x'],
    targets: [
      {
        id: 'youtube',
        platform: 'youtube',
        label: 'YouTube',
        enabled: true,
        serverUrl: 'rtmp://a.rtmp.youtube.com/live2',
        urlMode: 'server-and-key',
        streamKey: '',
        streamKeyPresent: false,
        authMode: 'manual-rtmp',
        createdAt: now,
        updatedAt: now
      },
      {
        id: 'x',
        platform: 'x',
        label: 'X / Twitter',
        enabled: true,
        serverUrl: '',
        urlMode: 'server-and-key',
        streamKey: '',
        streamKeyPresent: false,
        authMode: 'oauth',
        createdAt: now,
        updatedAt: now
      }
    ]
  }
}

function assertPreflight(preflight) {
  if (preflight?.valid !== false || !Array.isArray(preflight.destinations) || !Array.isArray(preflight.issues)) {
    throw new Error(`Go Live preflight should return invalid destinations/issues: ${JSON.stringify(preflight)}`)
  }

  const youtube = preflight.destinations.find((destination) => destination.platform === 'youtube')
  if (!youtube || youtube.ready || youtube.authMode !== 'manual-rtmp') {
    throw new Error(`Manual YouTube preflight should be blocked: ${JSON.stringify(preflight)}`)
  }
  if (!youtube.message.includes('server URL and stream key')) {
    throw new Error(`Manual YouTube preflight should explain missing RTMP credentials: ${JSON.stringify(youtube)}`)
  }

  const x = preflight.destinations.find((destination) => destination.platform === 'x')
  if (!x || x.ready || x.authMode !== 'oauth') {
    throw new Error(`OAuth X preflight should be blocked: ${JSON.stringify(preflight)}`)
  }
  if (!x.message.includes('connected account')) {
    throw new Error(`OAuth X preflight should explain missing connected account: ${JSON.stringify(x)}`)
  }

  const hasManualIssue = preflight.issues.some((issue) => issue.platform === 'youtube' && issue.severity === 'error')
  const hasOauthIssue = preflight.issues.some((issue) => issue.platform === 'x' && issue.severity === 'error')
  if (!hasManualIssue || !hasOauthIssue) {
    throw new Error(`Go Live preflight should include per-destination errors: ${JSON.stringify(preflight)}`)
  }
}

function preflightSecretRefFixture() {
  const now = new Date().toISOString()
  return {
    enabled: true,
    mode: 'multi',
    defaultOutputPreset: 'stream-1080p60',
    defaultBitrateKbps: 6000,
    selectedTargetId: 'youtube',
    enabledTargetIds: ['youtube', 'custom'],
    targets: [
      {
        id: 'youtube',
        platform: 'youtube',
        label: 'YouTube',
        enabled: true,
        serverUrl: 'rtmp://a.rtmp.youtube.com/live2',
        urlMode: 'server-and-key',
        streamKey: '',
        streamKeySecretRef: 'stream-target:youtube:manual-stream-key',
        streamKeyPresent: true,
        authMode: 'manual-rtmp',
        createdAt: now,
        updatedAt: now
      },
      {
        id: 'custom',
        platform: 'custom',
        label: 'Custom RTMP',
        enabled: true,
        serverUrl: '',
        urlMode: 'full-url',
        streamKey: '',
        streamKeySecretRef: 'stream-target:custom:manual-stream-key',
        streamKeyPresent: true,
        authMode: 'manual-rtmp',
        createdAt: now,
        updatedAt: now
      }
    ]
  }
}

function assertSecretRefPreflight(preflight) {
  if (preflight?.valid !== true || !Array.isArray(preflight.destinations) || !Array.isArray(preflight.issues)) {
    throw new Error(`Secret-ref Go Live preflight should be valid: ${JSON.stringify(preflight)}`)
  }
  if (preflight.issues.length !== 0) {
    throw new Error(`Secret-ref Go Live preflight should not report issues: ${JSON.stringify(preflight)}`)
  }

  const youtube = preflight.destinations.find((destination) => destination.platform === 'youtube')
  if (!youtube || !youtube.ready || youtube.authMode !== 'manual-rtmp') {
    throw new Error(`Manual YouTube secret-ref preflight should be ready: ${JSON.stringify(preflight)}`)
  }

  const custom = preflight.destinations.find((destination) => destination.platform === 'custom')
  if (!custom || !custom.ready || custom.authMode !== 'manual-rtmp') {
    throw new Error(`Custom full-url secret-ref preflight should be ready: ${JSON.stringify(preflight)}`)
  }
}

function assertXCapability(capability) {
  if (
    capability?.platform !== 'x' ||
    capability.state !== 'partner-api-required' ||
    capability.nativeAvailable !== false ||
    capability.manualRtmpAvailable !== true ||
    capability.oauthConnected !== false
  ) {
    throw new Error(`X native capability guard mismatch: ${JSON.stringify(capability)}`)
  }
  if (!String(capability.message).includes('partner/API path')) {
    throw new Error(`X capability message should explain the partner/API path: ${JSON.stringify(capability)}`)
  }
  if (!String(capability.docsUrl).startsWith('https://help.x.com/')) {
    throw new Error(`X capability should include Producer docs URL: ${JSON.stringify(capability)}`)
  }
  if (!String(capability.apiOverviewUrl).startsWith('https://docs.x.com/')) {
    throw new Error(`X capability should include X API overview URL: ${JSON.stringify(capability)}`)
  }
}

function requestRaw(ws, timeoutMs, method, params) {
  const id = `smoke-${Date.now()}-${Math.random().toString(16).slice(2)}`
  return new Promise((resolveRequest, rejectRequest) => {
    const timer = setTimeout(() => {
      ws.removeEventListener('message', onMessage)
      rejectRequest(new Error(`Timed out waiting for ${method}.`))
    }, timeoutMs)

    const onMessage = (event) => {
      let message
      try {
        message = JSON.parse(event.data)
      } catch (error) {
        clearTimeout(timer)
        ws.removeEventListener('message', onMessage)
        rejectRequest(error)
        return
      }
      if (message.id !== id) {
        return
      }

      clearTimeout(timer)
      ws.removeEventListener('message', onMessage)
      resolveRequest(message)
    }

    ws.addEventListener('message', onMessage)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

function launchAndReadConnection() {
  return new Promise((resolveConnection, rejectConnection) => {
    const timer = setTimeout(() => {
      rejectConnection(new Error(`Timed out waiting for dev backend READY after ${timeoutMs}ms.`))
    }, timeoutMs)

    appProcess = spawn('pnpm', ['dev'], {
      cwd: repoRoot,
      detached: true,
      env: {
        ...process.env,
        VIDEORC_SMOKE_PRINT_BACKEND_READY: '1',
        VIDEORC_USER_DATA_DIR: process.env.VIDEORC_USER_DATA_DIR ?? join(stateRoot, 'user-data'),
        VIDEORC_DATABASE_PATH:
          process.env.VIDEORC_DATABASE_PATH ?? join(stateRoot, 'videorc.sqlite'),
        VIDEORC_SECRETS_PATH:
          process.env.VIDEORC_SECRETS_PATH ?? join(stateRoot, 'videorc-secrets.json'),
        VIDEORC_YOUTUBE_CLIENT_ID: 'smoke-youtube-client-id',
        VIDEORC_TWITCH_CLIENT_ID: 'smoke-twitch-client-id',
        VIDEORC_X_CLIENT_ID: 'smoke-x-client-id',
        VIDEORC_TWITCH_CLIENT_SECRET: ''
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })

    appProcess.stdout.setEncoding('utf8')
    appProcess.stderr.setEncoding('utf8')
    appProcess.stdout.on('data', (text) => handleAppOutput(text, resolveConnection, timer))
    appProcess.stderr.on('data', (text) => handleAppOutput(text, resolveConnection, timer))
    appProcess.on('error', (error) => {
      clearTimeout(timer)
      rejectConnection(error)
    })
    appProcess.on('exit', (code, signal) => {
      clearTimeout(timer)
      rejectConnection(new Error(`Dev app exited before OAuth guard smoke completed: code=${code} signal=${signal}`))
    })
  })
}

function handleAppOutput(text, resolveConnection, timer) {
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() && !stopping) {
      console.log(line)
    }

    const marker = '[smoke] backend-ready '
    const index = line.indexOf(marker)
    if (index === -1) {
      continue
    }

    clearTimeout(timer)
    resolveConnection(JSON.parse(line.slice(index + marker.length)))
  }
}

function stopApp() {
  return new Promise((resolveStop) => {
    if (!appProcess?.pid || appProcess.killed) {
      resolveStop()
      return
    }

    const timer = setTimeout(() => {
      killApp('SIGKILL')
      resolveStop()
    }, 5000)

    stopping = true
    appProcess.once('exit', () => {
      clearTimeout(timer)
      resolveStop()
    })
    killApp('SIGTERM')
  })
}

function killApp(signal) {
  if (!appProcess?.pid) {
    return
  }

  try {
    process.kill(-appProcess.pid, signal)
  } catch {
    appProcess.kill(signal)
  }
}
