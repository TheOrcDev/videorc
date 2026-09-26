import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

import { smokeAppEnv, stopProcess } from './lib/app-launcher.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

const repoRoot = resolve(import.meta.dirname, '..')
const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 90000)

let appProcess
let stopping = false

try {
  const connection = await launchAndReadConnection()
  const ws = await connectBackend(connection, timeoutMs)
  try {
    const callbackPromise = waitForOAuthCallback(ws)
    const started = await request(ws, timeoutMs, 'platformAccounts.oauth.start', {
      platform: 'youtube',
      authorizationUrl: 'https://auth.example.test/oauth',
      clientId: 'smoke-client',
      scopes: ['videos.write', 'account.read', 'videos.write'],
      extraParams: { prompt: 'consent' }
    })

    if (!started.state || !started.authUrl || !started.redirectUri) {
      throw new Error(`OAuth start did not return a usable payload: ${JSON.stringify(started)}`)
    }
    // The redirect must be a loopback callback; the backend prefers its FIXED
    // OAuth ports (17995/27995/37995, registrable with exact-match providers
    // like X) and only falls back to the dynamic main port when all are busy.
    if (!/^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/.test(started.redirectUri)) {
      throw new Error(`OAuth redirect URI was not a loopback callback: ${started.redirectUri}`)
    }
    if (
      !started.authUrl.includes(`state=${started.state}`) ||
      !started.authUrl.includes('scope=account.read%20videos.write')
    ) {
      throw new Error(`OAuth auth URL is missing state or normalized scope: ${started.authUrl}`)
    }

    const callbackUrl = `${started.redirectUri}?state=${encodeURIComponent(started.state)}&code=smoke-code`
    const response = await fetch(callbackUrl)
    const body = await response.text()
    // The branded callback page (oauth_callback_page.rs): success tone and
    // the "now connected" title.
    if (
      !response.ok ||
      !body.includes('data-tone="good"') ||
      !body.includes('now connected to Videorc')
    ) {
      throw new Error(`OAuth callback route failed: ${response.status} ${body}`)
    }

    const callback = await callbackPromise
    if (callback.status !== 'success' || callback.platform !== 'youtube' || !callback.codePresent) {
      throw new Error(`OAuth callback event was not successful: ${JSON.stringify(callback)}`)
    }

    const reused = await request(ws, timeoutMs, 'platformAccounts.oauth.complete', {
      state: started.state,
      code: 'second-code'
    })
    if (reused.status !== 'unknown-state') {
      throw new Error(
        `OAuth state should be single-use after loopback callback: ${JSON.stringify(reused)}`
      )
    }

    const appProtocol = await request(ws, timeoutMs, 'platformAccounts.oauth.startProvider', {
      platform: 'x',
      redirectUri: 'videorc://oauth/callback'
    })
    if (appProtocol.redirectUri !== 'videorc://oauth/callback') {
      throw new Error(
        `Provider OAuth did not preserve app-protocol redirect URI: ${JSON.stringify(appProtocol)}`
      )
    }
    if (
      !appProtocol.authUrl.includes('redirect_uri=videorc%3A%2F%2Foauth%2Fcallback') ||
      !appProtocol.authUrl.includes(`state=${appProtocol.state}`)
    ) {
      throw new Error(`Provider OAuth app-protocol auth URL was not usable: ${appProtocol.authUrl}`)
    }

    const failedCallbackPromise = waitForOAuthCallback(ws)
    const failedCallback = await request(ws, timeoutMs, 'platformAccounts.oauth.complete', {
      state: appProtocol.state,
      error: 'access_denied',
      errorDescription: 'Smoke provider cancellation.'
    })
    const failedEvent = await failedCallbackPromise
    if (
      failedCallback.status !== 'failed' ||
      failedEvent.status !== 'failed' ||
      failedEvent.platform !== 'x'
    ) {
      throw new Error(
        `Provider OAuth app-protocol cancellation was not reported as failed: ${JSON.stringify({
          failedCallback,
          failedEvent
        })}`
      )
    }

    console.log(
      `OAuth smoke OK - loopback and app-protocol callbacks completed for ${callback.platform}.`
    )
  } finally {
    ws.close()
  }
} finally {
  await stopApp()
}

function waitForOAuthCallback(ws) {
  return new Promise((resolveCallback, rejectCallback) => {
    const timer = setTimeout(() => {
      ws.removeEventListener('message', onMessage)
      rejectCallback(new Error('Timed out waiting for OAuth callback event.'))
    }, timeoutMs)

    const onMessage = (event) => {
      let message
      try {
        message = JSON.parse(event.data)
      } catch {
        return
      }
      if (message.event !== 'platformAccounts.oauth.callback') {
        return
      }

      clearTimeout(timer)
      ws.removeEventListener('message', onMessage)
      resolveCallback(message.payload)
    }

    ws.addEventListener('message', onMessage)
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
      env: smokeAppEnv({
        VIDEORC_X_CLIENT_ID: 'smoke-x-client-id',
        VIDEORC_SMOKE_PRINT_BACKEND_READY: '1'
      }),
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
      rejectConnection(
        new Error(`Dev app exited before OAuth smoke completed: code=${code} signal=${signal}`)
      )
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

async function stopApp() {
  if (!appProcess?.pid || appProcess.killed) {
    return
  }
  stopping = true
  await stopProcess(appProcess)
}
