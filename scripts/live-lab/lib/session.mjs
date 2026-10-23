import { randomBytes } from 'node:crypto'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'

import { ownedProcessLedgerPaths } from '../../lib/process-census.mjs'
import {
  connectRemote,
  remoteRequest,
  waitForRemoteDescribe
} from '../../lib/remote-control-client.mjs'
import { request as backendRequest } from '../../smoke-recording-session.mjs'
import { createAppObserver, journalDirCandidates } from './app-observer.mjs'
import { startCardServer } from './card-server.mjs'
import {
  labDisplayBounds,
  labProfileDirs,
  launchApp,
  buildLaunchEnv,
  inhibitorHeld,
  isMacAppBundle,
  linuxCardBrowserArgs,
  startCaffeinate,
  startCardBrowser,
  startLocalSink,
  startSleepInhibitor
} from './launch.mjs'
import {
  CHROME_NAMES,
  LAB_SPEECH_SINK,
  findOnPath,
  focusLabOutput,
  labSessionEnv,
  linuxLabOutputBounds,
  placeCardWindow,
  portalPickPath,
  sessionProblems
} from './linux-desktop.mjs'
import { isLinux } from './platform.mjs'
import { createQuotaLedger } from './quota-ledger.mjs'
import { seedProfile } from './seed.mjs'
import { createSpeechRig } from './speech-rig.mjs'
import { createWaitFor, systemClock } from './step-engine.mjs'
import { collectArtifacts, teardown } from './teardown.mjs'
import { CdpClient, createUiDriver, httpBaseFromDevtools, pickMainTarget } from './ui-driver.mjs'
import { createYoutubeSide, isLiveJournalState } from './youtube-side.mjs'

// Plan 178 U6. The real session behind ctx: owned helpers (caffeinate, card
// server and browser, local sink), the app (LaunchServices, lab profile), the
// renderer socket, CDP, the profile seed, remote control and the app
// observer. startSession cleans up whatever it started when it fails part
// way; otherwise the harness calls session.teardown() in finally.

const RPC_TIMEOUT_MS = 30_000
const READY_DEADLINE_MS = 30_000

// Plan 179: Linux Videorc captures the screen only through the ScreenCast
// portal, and a restore token is opaque: one saved from a hand pick could
// point at the real desktop. So every Linux run starts with no token, and the
// only grant it can get is the lab share picker's, which names the lab output
// written to portalPickPath() (config/live-lab/linux/videorc-lab-share-picker).
export function portalRestoreTokensPath(appDataDir) {
  return join(appDataDir, 'linux-portal', 'restore-tokens.json')
}

export async function preparePortalGrant({ appDataDir, outputName, pickPath = portalPickPath() }) {
  if (!/^[A-Za-z0-9_.-]+$/.test(String(outputName ?? ''))) {
    throw new Error(`The lab output name "${outputName}" is not one the share picker accepts.`)
  }
  await rm(portalRestoreTokensPath(appDataDir), { force: true })
  await mkdir(dirname(pickPath), { recursive: true })
  await writeFile(pickPath, `${outputName}\n`, { mode: 0o600 })
  return {
    label: 'portal-pick',
    pid: null,
    path: pickPath,
    stop: async () => {
      await rm(pickPath, { force: true })
      return { state: 'removed' }
    }
  }
}

export async function freeLoopbackPort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer()
    server.once('error', rejectPort)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolvePort(port))
    })
  })
}

/**
 * The owned-process ledgers of a packaged app (workspace root = <app>/Contents
 * for a macOS bundle, the app directory on Linux). The whole ledger folder is
 * read too, so a different workspace key never hides a ledger.
 */
export async function ledgerPathsFor(dirs, appPath) {
  const paths = ownedProcessLedgerPaths({
    appDataDir: dirs.appDataDir,
    userDataDir: dirs.userDataDir,
    workspaceRoot: isMacAppBundle(appPath) ? join(appPath, 'Contents') : appPath
  })
  try {
    for (const name of await readdir(join(dirs.userDataDir, 'owned-processes'))) {
      const path = join(dirs.userDataDir, 'owned-processes', name)
      if (name.endsWith('.json') && !paths.includes(path)) paths.push(path)
    }
  } catch {
    // No ledger dir yet.
  }
  return paths
}

function connectBackendSocket(connection, timeoutMs = RPC_TIMEOUT_MS) {
  // Like smoke-recording-session's connectBackend, without the tokened URL in errors.
  return new Promise((resolveSocket, rejectSocket) => {
    const socket = new WebSocket(
      `ws://${connection.host}:${connection.port}/ws?token=${encodeURIComponent(connection.token)}`
    )
    const timer = setTimeout(() => {
      socket.close()
      rejectSocket(new Error('Timed out connecting to the backend renderer socket.'))
    }, timeoutMs)
    socket.addEventListener(
      'open',
      () => {
        clearTimeout(timer)
        resolveSocket(socket)
      },
      { once: true }
    )
    socket.addEventListener(
      'error',
      () => {
        clearTimeout(timer)
        rejectSocket(new Error('Could not connect to the backend renderer socket.'))
      },
      { once: true }
    )
  })
}

// Readiness probes during launch (CDP endpoint, renderer target). Bounded,
// short-interval polls of something with no event source, like the launcher's.
async function until(probe, { deadlineMs, label, intervalMs = 250 }) {
  const deadline = Date.now() + deadlineMs
  for (;;) {
    const value = await probe().catch(() => null)
    if (value) return value
    if (Date.now() > deadline)
      throw new Error(`${label} not ready within ${Math.round(deadlineMs / 1000)} s`)
    await new Promise((resolveWait) => setTimeout(resolveWait, intervalMs))
  }
}

/** ctx.remote over the remote-control socket. */
export function createRemote({ socket, bus }) {
  socket.on('message', (raw) => {
    let message
    try {
      message = JSON.parse(String(raw))
    } catch {
      return
    }
    if (message.event === 'remote.state' || message.event === 'remote.ack')
      bus.emit(message.event, message.payload)
  })
  return {
    state: () => bus.last('remote.state') ?? null,
    async describe({ deadlineMs = READY_DEADLINE_MS } = {}) {
      const payload = await waitForRemoteDescribe(socket, { timeoutMs: deadlineMs })
      bus.emit('remote.state', payload.state)
      return payload.describe
    },
    /** Sends one intent; when accepted, waits for its remote.ack. */
    async intent(kind, fields = {}, { deadlineMs = READY_DEADLINE_MS } = {}) {
      // Acks can race the response, so listen before sending.
      const acks = []
      let wanted = null
      let settle = null
      const off = bus.on((type, payload) => {
        if (type !== 'remote.ack') return
        if (wanted === null) acks.push(payload)
        else if (payload?.intentId === wanted) settle?.(payload)
      })
      try {
        const response = await remoteRequest(
          socket,
          'remote.intent',
          { kind, ...fields },
          { timeoutMs: deadlineMs }
        )
        const payload = response?.payload ?? {}
        if (!payload.accepted) {
          return {
            accepted: false,
            ok: false,
            message: payload.message ?? response?.error?.message ?? null
          }
        }
        wanted = payload.intentId
        const ack =
          acks.find((entry) => entry?.intentId === wanted) ??
          (await new Promise((resolveAck, rejectAck) => {
            const timer = setTimeout(
              () =>
                rejectAck(
                  new Error(`${kind}: no remote.ack within ${Math.round(deadlineMs / 1000)} s`)
                ),
              deadlineMs
            )
            settle = (entry) => {
              clearTimeout(timer)
              resolveAck(entry)
            }
          }))
        return {
          accepted: true,
          ok: ack.ok === true,
          message: ack.message ?? null,
          intentId: wanted
        }
      } finally {
        off()
      }
    }
  }
}

/**
 * Returns startSession for harness.executeRun. `install` is the U5 install
 * record (appPath, version), `config` the lab config (keys, client, display).
 */
export function createSessionStarter({
  config,
  install,
  workDir,
  labDir = null,
  ledger = null,
  clock = systemClock,
  launcher,
  chromePath,
  ffmpegPath = process.env.VIDEORC_LIVE_LAB_FFMPEG ?? 'ffmpeg',
  // Plan 178 U9: the YouTube side (U8 observer, viewer bot, clip pulls) and
  // the speech rig (U7), both injectable for tests.
  youtubeSide = createYoutubeSide,
  speechRig = createSpeechRig,
  platform = process.platform,
  sessionEnvFor = labSessionEnv
}) {
  const linux = isLinux(platform)
  return async function startSession({ runInfo, scenario, policy, runDir, bus, signal, log }) {
    const dirs = labProfileDirs(workDir, scenario.destination)
    for (const dir of [dirs.appDataDir, dirs.userDataDir, dirs.launchStateDir])
      await mkdir(dir, { recursive: true })
    const sessionWait = createWaitFor({ bus, clock, signal, defaultDeadlineMs: READY_DEADLINE_MS })
    const teardownWait = createWaitFor({ bus, clock, defaultDeadlineMs: READY_DEADLINE_MS })
    const parts = { helpers: [] }
    const startedAtMs = clock.now()

    const tearDown = () =>
      teardown({
        remote: parts.remote ?? null,
        waitFor: teardownWait,
        observer: {
          async stop() {
            // The YouTube side stops first so its last poll can still see the
            // broadcast end; it must never outlive the app observer.
            if (parts.youtube) parts.youtubeSummary = await parts.youtube.stop()
            parts.observer?.stop()
          }
        },
        quitApp: parts.app?.stop,
        ledgerPaths: parts.app ? () => ledgerPathsFor(dirs, install.appPath) : [],
        rootPid: parts.appPid ?? undefined,
        helpers: [parts.browser, parts.sink, parts.caffeinate, parts.portalPick],
        collect: () =>
          collectArtifacts({
            runDir,
            userDataDir: dirs.userDataDir,
            launchStateDir: dirs.launchStateDir,
            startedAtMs
          }),
        closeCard: async () => {
          parts.cdp?.close()
          parts.remoteSocket?.close()
          parts.backendSocket?.close()
          await parts.card?.close()
        },
        clock,
        log
      })

    try {
      const sessionEnv = linux ? await sessionEnvFor() : null
      if (linux) {
        const problems = sessionProblems(sessionEnv)
        if (problems.length) {
          throw new Error(
            `No Hyprland session to run in (${problems.join(', ')}); the lab user must be logged in (auto-login).`
          )
        }
      }
      parts.caffeinate = linux ? startSleepInhibitor({ env: sessionEnv }) : startCaffeinate()
      if (linux && !(await inhibitorHeld(parts.caffeinate))) {
        log(
          'systemd-inhibit exited at once (polkit refuses block inhibitors outside the active seat session); relying on the masked sleep targets and on hypridle being off.'
        )
      }
      parts.card = await startCardServer({
        runInfo: {
          runId: runInfo.runId,
          scenario: runInfo.scenario,
          appVersion: install.version,
          startedAt: runInfo.startedAt
        },
        onDropped: (fields) => log(`Card dropped fields: ${fields.join(', ')}`)
      })
      if (linux) {
        const bounds = await linuxLabOutputBounds(config?.labDisplay?.name, { sessionEnv })
        parts.portalPick = await preparePortalGrant({
          appDataDir: dirs.appDataDir,
          outputName: bounds.name
        })
        log(`Portal grant: no restore token; the lab share picker answers with "${bounds.name}".`)
        const browserPath = chromePath ?? (await findOnPath(CHROME_NAMES))
        if (!browserPath) {
          throw new Error(`No Chrome or Chromium on PATH (${CHROME_NAMES.join(', ')}).`)
        }
        const previousOutput = await focusLabOutput(bounds, { sessionEnv })
        parts.browser = startCardBrowser({
          url: parts.card.url,
          bounds,
          profileDir: join(workDir, 'card-browser'),
          chromePath: browserPath,
          args: linuxCardBrowserArgs({
            url: parts.card.url,
            profileDir: join(workDir, 'card-browser')
          }),
          env: { ...sessionEnv, PULSE_SINK: LAB_SPEECH_SINK }
        })
        const placed = await placeCardWindow({
          pid: parts.browser.pid,
          bounds,
          previousOutput,
          sessionEnv
        })
        if (!placed.onLabOutput || !placed.fullscreen) {
          throw new Error(
            `The test card window is ${placed.onLabOutput ? 'not fullscreen on' : 'not on'} the lab output "${bounds.name}".`
          )
        }
        log(
          `Test card fullscreen on the lab output ${bounds.name} (${bounds.width}x${bounds.height}).`
        )
      } else {
        const bounds = await labDisplayBounds(config?.labDisplay?.name)
        parts.browser = startCardBrowser({
          url: parts.card.url,
          bounds,
          profileDir: join(workDir, 'card-browser'),
          chromePath
        })
        log(`Test card on the lab display (${bounds.width}x${bounds.height}).`)
      }

      if (scenario.destination === 'local-sink') {
        parts.sink = startLocalSink({
          port: await freeLoopbackPort(),
          streamKey: `dry${randomBytes(6).toString('hex')}`,
          outputPath: join(runDir, 'sink.flv'),
          ffmpegPath
        })
        log(`Local RTMP sink on 127.0.0.1:${parts.sink.port} (nothing leaves this machine).`)
      }

      const env = { ...(sessionEnv ?? {}), ...buildLaunchEnv({ dirs, config, scenario }) }
      parts.app = await launchApp({ appPath: install.appPath, env, dirs, launcher })
      parts.appPid = (await parts.app.appPid()) ?? undefined
      log(`Videorc launched from ${install.appPath}.`)

      parts.backendSocket = await connectBackendSocket(parts.app.backend)
      const rpc = (method, params) =>
        backendRequest(parts.backendSocket, RPC_TIMEOUT_MS, method, params)

      const devtoolsUrl = await until(() => parts.app.devtoolsUrl(), {
        deadlineMs: READY_DEADLINE_MS,
        label: 'CDP endpoint'
      })
      const target = await until(
        async () =>
          pickMainTarget(
            await (await fetch(`${httpBaseFromDevtools(devtoolsUrl)}/json/list`)).json()
          ),
        { deadlineMs: READY_DEADLINE_MS, label: 'Studio renderer target' }
      )
      parts.cdp = await CdpClient.connect(target.webSocketDebuggerUrl)
      const ui = createUiDriver({ cdp: parts.cdp, bus, waitFor: sessionWait })
      await ui.install()

      parts.seed = await seedProfile({
        rpc,
        evaluate: (expression) => ui.evaluate(expression),
        reloadAndWait: () => ui.reload(),
        scenario,
        config,
        sink: parts.sink ?? null,
        titlePrefix: policy.titlePrefix,
        platform,
        log
      })

      parts.remoteSocket = await connectRemote(
        parts.seed.remote.host,
        parts.seed.remote.port,
        parts.seed.remote.token,
        {
          timeoutMs: READY_DEADLINE_MS
        }
      )
      parts.remote = createRemote({ socket: parts.remoteSocket, bus })
      parts.describe = await parts.remote.describe()
      await ui.dismissOtherDialogs()

      parts.observer = createAppObserver({
        bus,
        card: parts.card,
        runDir,
        journalDirs: journalDirCandidates(dirs),
        ledgerPaths: () => ledgerPathsFor(dirs, install.appPath),
        rootPid: async () => parts.appPid ?? (await parts.app.appPid()),
        clock,
        log
      })
      parts.backendSocket.addEventListener('message', (event) => {
        try {
          parts.observer.onBackendMessage(JSON.parse(event.data))
        } catch {
          // Not JSON: ignore.
        }
      })
      await parts.observer.start()

      const observe = parts.observer
      if (scenario.destination === 'youtube') {
        const quotaLedger =
          ledger ??
          createQuotaLedger({
            dir: labDir ?? workDir,
            maxUnitsPerDay: policy.quota?.labProjectMaxUnitsPerDay ?? undefined
          })
        parts.youtube = youtubeSide({
          config,
          policy,
          ledger: quotaLedger,
          runDir,
          bus,
          clock,
          log,
          appOnAir: () => {
            const latest = observe.latestJournal()
            return latest ? isLiveJournalState(latest.state) : null
          }
        })
        // ctx.observe.incidents() is the one place steps and verdicts read
        // YouTube-side incidents (U13's faults scenario depends on it).
        observe.incidents = () => parts.youtube.observer.incidents()
        await parts.youtube.start()
      }
      parts.speech = speechRig({ runDir, ffmpegPath, log, platform })

      const ledgerPaths = await ledgerPathsFor(dirs, install.appPath)
      return {
        ctx: {
          remote: parts.remote,
          ui,
          observe,
          card: parts.card,
          sink: parts.sink ?? null,
          observer: parts.youtube?.observer ?? null,
          viewer: parts.youtube?.viewer ?? null,
          speech: parts.speech,
          rpc,
          profile: { recordingsDir: dirs.recordingsDir },
          quitApp: () => parts.app.stop(),
          describe: parts.describe,
          healthEvents: () => observe.healthEventsFlat(),
          ledger: { ledgerPaths },
          ownedPids: () => ({
            app: parts.appPid ?? null,
            backend: parts.app.backend?.pid ?? null,
            browser: parts.browser?.pid ?? null,
            caffeinate: parts.caffeinate?.pid ?? null,
            sink: parts.sink?.pid ?? null,
            ledger: (observe.lastCensus()?.aliveRecords ?? []).map((record) => record.pid)
          })
        },
        teardown: tearDown,
        summary: () => ({
          appVersion: observe.latestJournal()?.appVersion ?? null,
          seed: { devices: parts.seed.devices, targetIds: parts.seed.targetIds },
          journalLines: observe.journalLines().length,
          healthEvents: observe.healthEvents().length,
          featureEvents: observe.featureEvents().length,
          cardPulse: Boolean(parts.card.lastPulse()),
          youtube: parts.youtubeSummary ?? null
        })
      }
    } catch (error) {
      log(`Session start failed: ${error.message}. Cleaning up what started.`)
      await tearDown().catch(() => {})
      throw error
    }
  }
}
