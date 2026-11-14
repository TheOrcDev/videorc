import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from 'node:fs'
import { rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { devAppSpawnOptions, stopProcess } from './lib/app-launcher.mjs'
import { compileCaptureModule } from './lib/compile-capture-module.mjs'
import { removeProfileDir } from './lib/profile-dir-removal.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

const require = createRequire(import.meta.url)

const tempDir = join(tmpdir(), `videorc-streaming-secrets-${Date.now()}`)
const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 60_000)

try {
  const tempModule = await compileCaptureModule(tempDir)

  const {
    defaultCaptureConfig,
    normalizeStreamingSettings,
    patchStreamTargetForEdit,
    persistableCaptureConfig
  } = require(tempModule)
  const normalized = normalizeStreamingSettings({
    enabled: true,
    mode: 'single',
    enabledTargetIds: ['youtube'],
    targets: [
      {
        id: 'youtube',
        platform: 'youtube',
        label: 'YouTube',
        enabled: true,
        serverUrl: 'rtmp://a.rtmp.youtube.com/live2',
        urlMode: 'server-and-key',
        streamKey: '',
        streamKeySecretRef: 'secret://youtube-stream-key',
        streamKeyPresent: true,
        authMode: 'oauth',
        accountId: 'youtube-account',
        accountLabel: 'Videorc',
        platformBroadcastId: 'broadcast-123',
        platformStreamId: 'stream-123',
        createdAt: '2026-06-03T00:00:00.000Z',
        updatedAt: '2026-06-03T00:00:00.000Z'
      }
    ]
  })

  const youtube = normalized.targets.find((target) => target.platform === 'youtube')
  assert.ok(youtube)
  assert.equal(youtube.authMode, 'oauth')
  assert.equal(youtube.streamKey, '')
  assert.equal(youtube.streamKeySecretRef, 'secret://youtube-stream-key')
  assert.equal(youtube.streamKeyPresent, true)
  assert.equal(youtube.accountId, 'youtube-account')
  assert.equal(youtube.platformBroadcastId, 'broadcast-123')
  assert.equal(youtube.platformStreamId, 'stream-123')

  const twitch = normalized.targets.find((target) => target.platform === 'twitch')
  assert.ok(twitch)
  assert.equal(twitch.streamKeyPresent, false)
  assert.equal(twitch.streamKeySecretRef, undefined)

  const persisted = persistableCaptureConfig({
    ...defaultCaptureConfig,
    rtmpPreset: 'youtube',
    streamKey: 'raw-oauth-key',
    streaming: {
      ...defaultCaptureConfig.streaming,
      targets: defaultCaptureConfig.streaming.targets.map((target) =>
        target.platform === 'youtube'
          ? {
              ...target,
              enabled: true,
              authMode: 'oauth',
              streamKey: 'raw-oauth-key',
              streamKeySecretRef: 'secret://youtube-stream-key',
              streamKeyPresent: true
            }
          : target.platform === 'twitch'
            ? {
                ...target,
                enabled: true,
                authMode: 'manual-rtmp',
                streamKey: 'manual-key',
                streamKeyPresent: true
              }
            : target
      )
    }
  })
  const persistedYoutube = persisted.streaming.targets.find(
    (target) => target.platform === 'youtube'
  )
  const persistedTwitch = persisted.streaming.targets.find((target) => target.platform === 'twitch')
  assert.equal(persisted.streamKey, '')
  assert.equal(persistedYoutube.authMode, 'oauth')
  assert.equal(persistedYoutube.streamKey, '')
  assert.equal(persistedYoutube.streamKeySecretRef, 'secret://youtube-stream-key')
  assert.equal(persistedYoutube.streamKeyPresent, true)
  assert.equal(persistedTwitch.streamKey, 'manual-key')

  const persistedManualSecret = persistableCaptureConfig({
    ...defaultCaptureConfig,
    rtmpPreset: 'twitch',
    streamKey: 'raw-manual-key',
    streaming: {
      ...defaultCaptureConfig.streaming,
      targets: defaultCaptureConfig.streaming.targets.map((target) =>
        target.platform === 'twitch'
          ? {
              ...target,
              enabled: true,
              authMode: 'manual-rtmp',
              streamKey: 'raw-manual-key',
              streamKeySecretRef: 'stream-target:twitch:manual-stream-key',
              streamKeyPresent: true
            }
          : target
      )
    }
  })
  const persistedManualTwitch = persistedManualSecret.streaming.targets.find(
    (target) => target.platform === 'twitch'
  )
  assert.equal(persistedManualSecret.streamKey, '')
  assert.equal(persistedManualTwitch.streamKey, '')
  assert.equal(persistedManualTwitch.streamKeySecretRef, 'stream-target:twitch:manual-stream-key')
  assert.equal(persistedManualTwitch.streamKeyPresent, true)

  // Kick (plan 063) is a manual-key destination too: once its key has a
  // secret ref, the raw key never reaches the persisted config.
  const persistedKick = persistableCaptureConfig({
    ...defaultCaptureConfig,
    rtmpPreset: 'kick',
    streamKey: 'raw-kick-key',
    streaming: {
      ...defaultCaptureConfig.streaming,
      targets: defaultCaptureConfig.streaming.targets.map((target) =>
        target.platform === 'kick'
          ? {
              ...target,
              enabled: true,
              authMode: 'manual-rtmp',
              streamKey: 'raw-kick-key',
              streamKeySecretRef: 'stream-target:kick:manual-stream-key',
              streamKeyPresent: true
            }
          : target
      )
    }
  })
  const persistedManualKick = persistedKick.streaming.targets.find(
    (target) => target.platform === 'kick'
  )
  assert.ok(persistedManualKick, 'the built-in Kick card must exist')
  assert.equal(persistedKick.streamKey, '')
  assert.equal(persistedManualKick.streamKey, '')
  assert.equal(persistedManualKick.streamKeySecretRef, 'stream-target:kick:manual-stream-key')

  const persistedManualDraft = persistableCaptureConfig({
    ...defaultCaptureConfig,
    rtmpPreset: 'twitch',
    streamKey: 'manual-key',
    streaming: {
      ...defaultCaptureConfig.streaming,
      targets: defaultCaptureConfig.streaming.targets.map((target) =>
        target.platform === 'twitch'
          ? {
              ...target,
              enabled: true,
              authMode: 'manual-rtmp',
              streamKey: 'manual-key',
              streamKeyPresent: true
            }
          : target
      )
    }
  })
  const persistedManualDraftTwitch = persistedManualDraft.streaming.targets.find(
    (target) => target.platform === 'twitch'
  )
  assert.equal(persistedManualDraft.streamKey, 'manual-key')
  assert.equal(persistedManualDraftTwitch.streamKey, 'manual-key')

  const persistedFullUrlSecret = persistableCaptureConfig({
    ...defaultCaptureConfig,
    rtmpPreset: 'custom',
    rtmpServerUrl: 'rtmp://example.test/live/full-url-secret',
    streamKey: '',
    streaming: {
      ...defaultCaptureConfig.streaming,
      targets: defaultCaptureConfig.streaming.targets.map((target) =>
        target.platform === 'custom'
          ? {
              ...target,
              enabled: true,
              urlMode: 'full-url',
              authMode: 'manual-rtmp',
              serverUrl: 'rtmp://example.test/live/full-url-secret',
              streamKey: '',
              streamKeySecretRef: 'stream-target:custom:manual-stream-key',
              streamKeyPresent: true
            }
          : target
      )
    }
  })
  const persistedFullUrlCustom = persistedFullUrlSecret.streaming.targets.find(
    (target) => target.platform === 'custom'
  )
  assert.equal(persistedFullUrlSecret.rtmpServerUrl, '')
  assert.equal(persistedFullUrlCustom.serverUrl, '')
  assert.equal(persistedFullUrlCustom.streamKey, '')
  assert.equal(persistedFullUrlCustom.streamKeySecretRef, 'stream-target:custom:manual-stream-key')
  assert.equal(persistedFullUrlCustom.streamKeyPresent, true)

  const manualYouTube = {
    ...defaultCaptureConfig.streaming.targets.find((target) => target.platform === 'youtube'),
    authMode: 'manual-rtmp',
    streamKey: '',
    streamKeySecretRef: 'stream-target:youtube:manual-stream-key',
    streamKeyPresent: true,
    platformBroadcastId: 'old-broadcast',
    platformStreamId: 'old-stream',
    status: { state: 'ready', message: 'Old manual key.' }
  }
  const oauthYouTube = patchStreamTargetForEdit(
    manualYouTube,
    { authMode: 'oauth' },
    '2026-06-03T00:00:00.000Z'
  )
  assert.equal(oauthYouTube.authMode, 'oauth')
  assert.equal(oauthYouTube.streamKey, '')
  assert.equal(oauthYouTube.streamKeySecretRef, undefined)
  assert.equal(oauthYouTube.streamKeyPresent, false)
  assert.equal(oauthYouTube.platformBroadcastId, undefined)
  assert.equal(oauthYouTube.platformStreamId, undefined)

  const customFullUrl = patchStreamTargetForEdit(
    {
      ...defaultCaptureConfig.streaming.targets.find((target) => target.platform === 'custom'),
      urlMode: 'server-and-key',
      serverUrl: 'rtmp://example.test/live',
      streamKeySecretRef: 'stream-target:custom:manual-stream-key',
      streamKeyPresent: true
    },
    { urlMode: 'full-url' },
    '2026-06-03T00:00:00.000Z'
  )
  assert.equal(customFullUrl.urlMode, 'full-url')
  assert.equal(customFullUrl.serverUrl, '')
  assert.equal(customFullUrl.streamKeySecretRef, undefined)
  assert.equal(customFullUrl.streamKeyPresent, false)

  // Facebook (plan 206): a saved key persists as a secret ref, never raw, and
  // reloads on the Facebook card. A saved sign-in can't exist yet: it reloads
  // as a stream key, without the key a sign-in would have fetched.
  const persistedFacebook = persistableCaptureConfig({
    ...defaultCaptureConfig,
    streaming: {
      ...defaultCaptureConfig.streaming,
      enabled: true,
      enabledTargetIds: ['facebook'],
      targets: defaultCaptureConfig.streaming.targets.map((target) =>
        target.platform === 'facebook'
          ? {
              ...target,
              enabled: true,
              streamKey: 'raw-facebook-key',
              streamKeySecretRef: 'stream-target:facebook:manual-stream-key',
              streamKeyPresent: true
            }
          : target
      )
    }
  })
  assert.ok(!JSON.stringify(persistedFacebook).includes('raw-facebook-key'))
  const reloadedFacebook = normalizeStreamingSettings(persistedFacebook.streaming).targets.find(
    (target) => target.id === 'facebook'
  )
  assert.equal(reloadedFacebook.platform, 'facebook')
  assert.equal(reloadedFacebook.authMode, 'manual-rtmp')
  assert.equal(reloadedFacebook.streamKey, '')
  assert.equal(reloadedFacebook.streamKeyPresent, true)
  assert.equal(reloadedFacebook.streamKeySecretRef, 'stream-target:facebook:manual-stream-key')
  const signedInFacebook = normalizeStreamingSettings({
    ...persistedFacebook.streaming,
    targets: persistedFacebook.streaming.targets.map((target) =>
      target.id === 'facebook' ? { ...target, authMode: 'oauth' } : target
    )
  }).targets.find((target) => target.id === 'facebook')
  assert.equal(signedInFacebook.authMode, 'manual-rtmp')
  assert.equal(signedInFacebook.streamKeyPresent, false)

  await proveSessionStartStoresNoStreamKey()

  console.log(
    'Streaming secret smoke OK - available YouTube OAuth and manual secret refs persist without raw keys; ' +
      'the backend scrubs an old remembered capture once and a session start writes no key to its profile.'
  )
} finally {
  await rm(tempDir, { recursive: true, force: true })
}

// The backend half (2026-11-14). A session start reads each destination's key
// from the secret store into its own request; from 2026-10-23 it then saved that
// request as `last_capture_session` in plain SQLite. This drives the real debug
// backend on an isolated profile (never the owner's): a database an older build
// left with a key in that row is scrubbed at open, and `session.start` with a
// key stored through `streamTargets.manualKey.store` plus a raw legacy key
// leaves no byte of either anywhere in the profile but the secret store. Live
// captions with no microphone refuse the start after it has written its rows
// and before any capture or encoder process spawns: no device, no network.
async function proveSessionStartStoresNoStreamKey() {
  const backendBinaryName = process.platform === 'win32' ? 'videorc-backend.exe' : 'videorc-backend'
  // Where `cargo build` (run by pnpm smoke:streaming-secrets from the repo
  // root) put it: CARGO_TARGET_DIR when set, relative to that root.
  const targetDir = resolve(process.cwd(), process.env.CARGO_TARGET_DIR || 'target')
  const backendBinary = join(targetDir, 'debug', backendBinaryName)
  if (!existsSync(backendBinary)) {
    throw new Error(`${backendBinary} is missing; pnpm smoke:streaming-secrets builds it first.`)
  }
  const stateRoot = mkdtempSync(join(tmpdir(), 'videorc-streaming-secrets-backend-'))
  const appDataDir = join(stateRoot, 'app-data')
  mkdirSync(appDataDir, { recursive: true })
  const databasePath = join(appDataDir, 'videorc.sqlite3')
  const secretsPath = join(appDataDir, 'videorc-secrets.json')
  writeFileSync(secretsPath, '{}\n')
  chmodSync(secretsPath, 0o600)
  const run = randomUUID().replaceAll('-', '')
  const oldRowKey = `smoke-old-row-key-${run}`
  const storedKey = `smoke-stored-key-${run}`
  const typedKey = `smoke-typed-key-${run}`
  const keys = [oldRowKey, storedKey, typedKey]
  const { DatabaseSync } = await import('node:sqlite')

  // What a build from 2026-10-23 left: the start's own request, key hydrated.
  const seed = new DatabaseSync(databasePath)
  seed.exec(
    'CREATE TABLE app_settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL)'
  )
  seed.prepare('INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)').run(
    'last_capture_session',
    JSON.stringify(
      goLiveParams({
        secretRef: 'stream-target:custom:manual-stream-key',
        streamKey: oldRowKey,
        legacyKey: ''
      })
    ),
    new Date().toISOString()
  )
  seed.close()

  let backendProcess
  let backend
  let backendStdout = ''
  let backendOutput = ''
  try {
    backendProcess = spawn(
      backendBinary,
      [],
      devAppSpawnOptions({
        env: {
          ...process.env,
          // Nothing here may reach a real service.
          VIDEORC_API_BASE_URL: 'http://127.0.0.1:9',
          VIDEORC_DISABLE_AUTO_PREVIEW: '1',
          VIDEORC_DISABLE_BACKEND_REAP: '1',
          VIDEORC_ENABLE_SMOKE_RPC: '1',
          VIDEORC_USAGE_STATS: '0',
          VIDEORC_APP_DATA_DIR: appDataDir,
          VIDEORC_USER_DATA_DIR: join(stateRoot, 'user-data'),
          VIDEORC_DATABASE_PATH: databasePath,
          VIDEORC_SECRETS_PATH: secretsPath,
          VIDEORC_RECORDINGS_DIR: join(appDataDir, 'recordings'),
          VIDEORC_SMOKE_STATE_DIR: stateRoot
        }
      })
    )
    backendProcess.stdout.setEncoding('utf8')
    backendProcess.stderr.setEncoding('utf8')
    backendProcess.stdout.on('data', (chunk) => {
      backendStdout += chunk
      backendOutput += chunk
    })
    backendProcess.stderr.on('data', (chunk) => (backendOutput += chunk))
    const ready = await waitForReady(
      backendProcess,
      () => backendStdout,
      () => backendOutput
    )
    assert.ok(
      typeof ready.adminToken === 'string' && ready.adminToken.length >= 32,
      'the debug backend READY carries its smoke admin credential'
    )
    backend = await connectBackend(
      { ...ready, token: ready.adminToken, adminToken: undefined },
      timeoutMs
    )

    const readRows = () => {
      const database = new DatabaseSync(databasePath, { readOnly: true })
      try {
        const remembered = database
          .prepare('SELECT value_json FROM app_settings WHERE key = ?')
          .get('last_capture_session')?.value_json
        const outputs = database
          .prepare('SELECT output_json FROM sessions')
          .all()
          .map((row) => row.output_json)
        return { remembered, outputs }
      } finally {
        database.close()
      }
    }

    const scrubbed = readRows().remembered
    assert.ok(scrubbed, 'the old remembered capture survives its scrub')
    assert.ok(!scrubbed.includes(oldRowKey), 'the old row lost its key at open')
    assert.ok(scrubbed.includes('stream-target:custom:manual-stream-key'))

    const stored = await request(backend, timeoutMs, 'streamTargets.manualKey.store', {
      targetId: 'custom',
      streamKey: storedKey
    })
    assert.equal(stored.streamKeyPresent, true)
    assert.ok(stored.streamKeySecretRef, 'the key went to the secret store')
    await assert.rejects(
      request(
        backend,
        timeoutMs,
        'session.start',
        goLiveParams({ secretRef: stored.streamKeySecretRef, streamKey: '', legacyKey: typedKey })
      ),
      /Live captions require/,
      'the start runs past its database writes and stops before any process spawns'
    )

    const { remembered, outputs } = readRows()
    assert.ok(remembered?.includes(stored.streamKeySecretRef), 'the start remembered its capture')
    assert.equal(outputs.length, 1, 'the start wrote its Library row')
    for (const key of [storedKey, typedKey]) {
      assert.ok(!remembered.includes(key), `${key} in last_capture_session`)
      assert.ok(!outputs[0].includes(key), `${key} in sessions.output_json`)
    }

    // Every file of the profile but the secret store, the database's log
    // included, and everything the backend printed.
    for (const file of profileFiles(stateRoot).filter((path) => path !== secretsPath)) {
      const bytes = readFileSync(file)
      for (const key of keys) {
        assert.ok(!bytes.includes(key), `${key} is on disk in ${file}`)
      }
    }
    for (const key of keys) {
      assert.ok(!backendOutput.includes(key), `${key} in the backend's output`)
    }
  } finally {
    backend?.close()
    if (backendProcess) {
      await stopProcess(backendProcess).catch(() => {})
    }
    await removeProfileDir(stateRoot, { label: 'streaming-secrets smoke' })
  }
}

/** A stream-only Go Live to one Custom destination on the test pattern. */
function goLiveParams({ secretRef, streamKey, legacyKey }) {
  const now = '2026-11-14T00:00:00.000Z'
  const serverUrl = 'rtmp://127.0.0.1:9/live'
  return {
    sources: { testPattern: true },
    layout: {
      layoutPreset: 'screen-only',
      cameraTransformMode: 'preset',
      cameraTransform: null,
      cameraCorner: 'bottom-right',
      cameraSize: 'medium',
      cameraShape: 'rectangle',
      cameraMargin: 32,
      cameraFit: 'fill',
      cameraMirror: false,
      cameraZoom: 100,
      cameraOffsetX: 0,
      cameraOffsetY: 0,
      sideBySideSplit: '70-30',
      sideBySideCameraSide: 'right'
    },
    output: {
      recordEnabled: false,
      streamEnabled: true,
      video: { preset: 'tutorial-1080p30', width: 1920, height: 1080, fps: 30, bitrateKbps: 6000 },
      // The renderer's legacy one-destination copy: raw when moving a key to
      // the secret store failed.
      rtmp: { preset: 'custom', serverUrl, streamKey: legacyKey }
    },
    streaming: {
      enabled: true,
      mode: 'single',
      targets: [
        {
          id: 'custom',
          platform: 'custom',
          label: 'Custom RTMP',
          enabled: true,
          serverUrl,
          urlMode: 'server-and-key',
          streamKey,
          streamKeySecretRef: secretRef,
          streamKeyPresent: true,
          authMode: 'manual-rtmp',
          createdAt: now,
          updatedAt: now
        }
      ],
      defaultOutputPreset: 'tutorial-1080p30',
      defaultBitrateKbps: 6000,
      enabledTargetIds: ['custom']
    },
    captions: { enabled: true }
  }
}

function profileFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return profileFiles(path)
    return entry.isFile() ? [path] : []
  })
}

/**
 * The lines of `text` that a newline has ended. A chunk can end inside a
 * line, so the last piece waits for the rest of it.
 */
function completeLines(text) {
  return text
    .split('\n')
    .slice(0, -1)
    .map((line) => line.replace(/\r$/, ''))
}

/**
 * The backend's READY payload, parsed from stdout alone (stderr can carry
 * any text) once its line has ended. `output` is everything it printed, for
 * the failure message.
 */
function waitForReady(child, stdout, output) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Backend did not print READY in time.\n${output().slice(-4_000)}`)),
      timeoutMs
    )
    const onData = () => {
      const line = completeLines(stdout()).find((candidate) => candidate.startsWith('READY '))
      if (!line) return
      clearTimeout(timer)
      child.stdout.off('data', onData)
      try {
        resolve(JSON.parse(line.slice('READY '.length)))
      } catch {
        reject(new Error('Backend printed an invalid READY payload.'))
      }
    }
    child.stdout.on('data', onData)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      reject(
        new Error(
          `Backend exited before READY (code=${code}, signal=${signal}).\n${output().slice(-4_000)}`
        )
      )
    })
  })
}
