import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import {
  appExecutablePath,
  buildLaunchEnv,
  caffeinateArgs,
  cardBrowserArgs,
  isLoopbackRtmp,
  labDisplayBounds,
  labProfileDirs,
  launchApp,
  localSinkArgs,
  parseDevToolsActivePort,
  parseDevtoolsLine,
  readPublishedAppPid,
  startLocalSink,
  stopOwnedChild,
  topLeftBounds
} from './launch.mjs'

const CONFIG = {
  client: { id: '123456-abcdef.apps.googleusercontent.com', secret: 'GOCSPX-super-secret-value' },
  streamKeys: { horizontal: { key: 'abcd-efgh-ijkl-mnop-qrst' } },
  labDisplay: { name: 'Lab Dummy' }
}

test('lab profiles live under the work dir; local-sink runs get their own', () => {
  const youtube = labProfileDirs('/work', 'youtube')
  const local = labProfileDirs('/work', 'local-sink')
  assert.equal(youtube.root, '/work/profile')
  assert.equal(local.root, '/work/profile-local')
  assert.equal(youtube.secretsPath, '/work/profile/app-data/videorc-secrets.json')
  assert.equal(youtube.userDataDir, '/work/profile/user-data')
  assert.equal(
    appExecutablePath('/Applications/Videorc.app'),
    '/Applications/Videorc.app/Contents/MacOS/Videorc'
  )
})

test('the launch env turns on CDP, the journal and bounded logs, and turns auto-update off', () => {
  const dirs = labProfileDirs('/work', 'local-sink')
  const env = buildLaunchEnv({ dirs, config: CONFIG, scenario: { usesLabYoutubeClient: false } })
  assert.equal(env.VIDEORC_REMOTE_DEBUG_PORT, '0')
  assert.equal(env.VIDEORC_METRICS_JOURNAL, '1')
  assert.equal(env.VIDEORC_DISABLE_AUTO_UPDATE, '1')
  assert.equal(env.VIDEORC_BACKEND_LOG_MAX_BYTES, String(50 * 1024 * 1024))
  assert.equal(env.VIDEORC_BACKEND_LOG_MAX_FILES, '10')
  assert.equal(env.VIDEORC_USER_DATA_DIR, dirs.userDataDir)
  assert.equal(env.VIDEORC_APP_DATA_DIR, dirs.appDataDir)
  const text = JSON.stringify(env)
  assert.ok(
    !text.includes(CONFIG.client.secret) && !text.includes(CONFIG.client.id),
    'no client unless asked'
  )
  assert.ok(
    !text.includes(CONFIG.streamKeys.horizontal.key),
    'stream keys never go through the env'
  )
})

test('the lab OAuth client is passed only for scenarios that declare it', () => {
  const dirs = labProfileDirs('/work', 'youtube')
  const env = buildLaunchEnv({ dirs, config: CONFIG, scenario: { usesLabYoutubeClient: true } })
  assert.equal(env.VIDEORC_YOUTUBE_CLIENT_ID, CONFIG.client.id)
  assert.equal(env.VIDEORC_YOUTUBE_CLIENT_SECRET, CONFIG.client.secret)
  assert.throws(
    () =>
      buildLaunchEnv({
        dirs,
        config: { ...CONFIG, client: null },
        scenario: { usesLabYoutubeClient: true }
      }),
    /lab OAuth client/
  )
})

test('the CDP endpoint is read from stderr or DevToolsActivePort', () => {
  assert.equal(
    parseDevtoolsLine('DevTools listening on ws://127.0.0.1:53111/devtools/browser/0b7c-uuid'),
    'ws://127.0.0.1:53111/devtools/browser/0b7c-uuid'
  )
  assert.equal(parseDevtoolsLine('[smoke] backend-ready {}'), null)
  assert.equal(
    parseDevToolsActivePort('53111\n/devtools/browser/0b7c-uuid\n'),
    'ws://127.0.0.1:53111/devtools/browser/0b7c-uuid'
  )
  assert.equal(parseDevToolsActivePort('nope'), null)
})

test('launchApp uses LaunchServices with the packaged executable and keeps the CDP url', async () => {
  let options = null
  const dirs = labProfileDirs('/work', 'local-sink')
  const launched = await launchApp({
    appPath: '/Applications/Videorc.app',
    env: { VIDEORC_REMOTE_DEBUG_PORT: '0' },
    dirs,
    launcher: async (received) => {
      options = received
      received.onLine('DevTools listening on ws://127.0.0.1:9333/devtools/browser/x')
      return {
        connections: { 'backend-ready': { host: '127.0.0.1', port: 1, token: 't', pid: 77 } },
        stop: async () => ({ state: 'terminated' }),
        process: {}
      }
    }
  })
  assert.equal(options.launchViaMacosLaunchServices, true)
  assert.deepEqual(options.requiredMarkers, ['backend-ready'])
  assert.deepEqual(options.spawnSpec, {
    command: '/Applications/Videorc.app/Contents/MacOS/Videorc',
    args: []
  })
  assert.equal(await launched.devtoolsUrl(), 'ws://127.0.0.1:9333/devtools/browser/x')
  assert.equal(launched.backend.pid, 77)
})

test('the published app PID is read from the ownership file for the census', async () => {
  const pid = await readPublishedAppPid('/state', {
    list: async () => ['launch-services-1.stdout.log', 'launch-services-1.app-ownership.json'],
    read: async () => JSON.stringify({ schemaVersion: 1, appPid: 4321, token: 'x' })
  })
  assert.equal(pid, 4321)
  assert.equal(
    await readPublishedAppPid('/missing', {
      list: async () => {
        throw new Error('ENOENT')
      }
    }),
    null
  )
})

test('display bounds convert NSScreen frames to top-left coordinates and refuse the main display', async () => {
  const screens = [
    { name: 'Built-in', x: 0, y: 0, width: 1512, height: 982 },
    { name: 'Lab Dummy', x: 1512, y: -98, width: 1920, height: 1080 }
  ]
  assert.deepEqual(topLeftBounds(screens, 'Lab Dummy'), {
    name: 'Lab Dummy',
    x: 1512,
    y: 0,
    width: 1920,
    height: 1080,
    isMain: false
  })
  const exec = async () => ({ stdout: JSON.stringify(screens) })
  assert.equal((await labDisplayBounds('Lab Dummy', { exec })).x, 1512)
  await assert.rejects(labDisplayBounds('Built-in', { exec }), /main display/)
  await assert.rejects(labDisplayBounds('Gone', { exec }), /not connected/)
  await assert.rejects(labDisplayBounds(undefined, { exec }), /No lab display/)
})

test('helper argv: caffeinate follows the harness, Chrome opens the card fullscreen, the sink is loopback', () => {
  assert.deepEqual(caffeinateArgs(99), ['-d', '-i', '-s', '-w', '99'])
  const args = cardBrowserArgs({
    url: 'http://127.0.0.1:4000/',
    bounds: { x: 1512, y: 0, width: 1920, height: 1080 },
    profileDir: '/work/card-browser'
  })
  for (const flag of [
    '--autoplay-policy=no-user-gesture-required',
    '--force-device-scale-factor=1',
    '--window-position=1512,0',
    '--start-fullscreen',
    '--app=http://127.0.0.1:4000/'
  ]) {
    assert.ok(args.includes(flag), flag)
  }
  assert.deepEqual(
    localSinkArgs({ port: 19350, streamKey: 'dryabc', outputPath: '/run/sink.flv' }).slice(-7),
    ['-i', 'rtmp://127.0.0.1:19350/live/dryabc', '-c', 'copy', '-f', 'flv', '/run/sink.flv']
  )
  assert.equal(isLoopbackRtmp('rtmp://127.0.0.1:19350/live'), true)
  assert.equal(isLoopbackRtmp('rtmps://a.rtmps.youtube.com:443/live2'), false)
  assert.equal(isLoopbackRtmp('rtmp://10.0.0.2/live'), false)
})

function fakeChild({ exitsOn = 'SIGTERM' } = {}) {
  const child = new EventEmitter()
  child.pid = 555
  child.exitCode = null
  child.signalCode = null
  child.signals = []
  child.stderr = new EventEmitter()
  child.kill = (signal) => {
    child.signals.push(signal)
    if (signal === exitsOn || signal === 'SIGKILL') {
      child.signalCode = signal
      queueMicrotask(() => child.emit('exit', null, signal))
    }
  }
  return child
}

test('owned helpers are stopped by their own PID only, escalating to SIGKILL', async () => {
  const polite = fakeChild()
  assert.deepEqual(await stopOwnedChild(polite), { pid: 555, state: 'terminated' })
  const stubborn = fakeChild({ exitsOn: 'never' })
  assert.deepEqual(await stopOwnedChild(stubborn, { graceMs: 5 }), { pid: 555, state: 'killed' })
  assert.deepEqual(stubborn.signals, ['SIGTERM', 'SIGKILL'])
  const sink = startLocalSink({
    port: 19350,
    streamKey: 'dryabc',
    outputPath: '/run/sink.flv',
    spawnFn: () => fakeChild()
  })
  assert.equal(sink.serverUrl, 'rtmp://127.0.0.1:19350/live')
  assert.throws(
    () =>
      startLocalSink({ port: 80, streamKey: 'x', outputPath: '/x', spawnFn: () => fakeChild() }),
    /port/
  )
})
