import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { pullClip as defaultPullClip } from './clip-puller.mjs'
import { createAccessTokenSource } from './oauth.mjs'
import { systemClock } from './step-engine.mjs'
import { createViewerBot } from './viewer-bot.mjs'
import { DEFAULT_INTERVAL_MS, createYoutubeObserver } from './youtube-observer.mjs'

// Plan 178 U9 step 1. Wires U8 into a run with destination 'youtube': the
// observer (lab broadcaster token, every 2 min, snapshots to observer.ndjson,
// incidents on the bus and on ctx.observe.incidents()), the viewer bot as
// ctx.viewer, and clip pulls, which run only when the owner's policy says
// clipPull: true AND the broadcaster API confirms the video is the lab
// channel's own; otherwise every pull is recorded as skipped. Every API call
// is charged to the quota ledger before it goes out (U8); quota.json records
// what this run spent.

export const CLIP_INTERVAL_MS = 15 * 60 * 1000
export const DEFAULT_CLIP_SECONDS = 120

/** Pure: does a journal state mean the app says it is On air? */
export function isLiveJournalState(state) {
  return state === 'live' || state === 'both'
}

/**
 * @param {object} options
 * @param {object} options.config       the lab config (client, roles, keys); never logged
 * @param {object} options.policy       the loaded policy (clipPull, quota)
 * @param {object} options.ledger       quota-ledger.mjs ledger
 * @param {string} options.runDir
 * @param {object} options.bus          the run event bus
 * @param {() => boolean|null} options.appOnAir  what the app reports (journal state live/both)
 */
export function createYoutubeSide({
  config,
  policy,
  ledger,
  runDir,
  bus,
  appOnAir,
  log = () => {},
  clock = systemClock,
  getToken = createAccessTokenSource({ config }),
  createObserver = createYoutubeObserver,
  createViewer = createViewerBot,
  pull = defaultPullClip,
  fetch: fetchImpl,
  apiBase,
  intervalMs = DEFAULT_INTERVAL_MS,
  clipIntervalMs = CLIP_INTERVAL_MS,
  clipSeconds = DEFAULT_CLIP_SECONDS,
  ffmpegPath = process.env.VIDEORC_LIVE_LAB_FFMPEG ?? 'ffmpeg',
  ytDlpPath = process.env.VIDEORC_LIVE_LAB_YTDLP ?? 'yt-dlp',
  append = appendFile,
  write = writeFile
}) {
  if (!ledger) throw new Error('createYoutubeSide needs the quota ledger')
  const hooks = { onStudioEnded: null }
  const snapshots = []
  const incidents = []
  const clipResults = []
  const abort = new AbortController()
  const clipPull = policy?.clipPull === true
  let watching = null
  let clipTimer = null
  let pulling = false
  const quotaStart = ledger.today()
  const now = () => new Date(clock.now())

  const observerApi = createObserver({
    getToken,
    ledger,
    fetch: fetchImpl,
    apiBase,
    now,
    appOnAir,
    onStudioEnded: (snapshot) => {
      log('Observer: the broadcast ended on YouTube while the app reports On air (Studio end).')
      hooks.onStudioEnded?.(snapshot)
    }
  })
  const viewer = createViewer({ getToken, ledger, fetch: fetchImpl, apiBase, now })

  const latest = () => snapshots.at(-1) ?? null
  const videoId = () => latest()?.broadcast?.id ?? observerApi.broadcastId ?? null
  const watchUrl = () => (videoId() ? `https://www.youtube.com/watch?v=${videoId()}` : null)

  async function recordSnapshot(snapshot) {
    snapshots.push(snapshot)
    if (snapshots.length > 5000) snapshots.splice(0, snapshots.length - 5000)
    await append(join(runDir, 'observer.ndjson'), `${JSON.stringify(snapshot)}\n`).catch(() => {})
    bus.emit('observer', snapshot)
  }

  function recordIncident(incident) {
    incidents.push(incident)
    log(`Observer incident ${incident.severity} ${incident.signature}: ${incident.detail}`)
    bus.emit('incident', incident)
  }

  async function pullClipNow({ seconds = clipSeconds, reason = 'scheduled' } = {}) {
    if (pulling) return { status: 'skipped', reason: 'pull-in-progress' }
    pulling = true
    try {
      const url = watchUrl()
      let result
      if (!clipPull) {
        result = { status: 'skipped', reason: 'clip-pull-disabled', videoId: videoId() }
      } else if (!url) {
        result = { status: 'skipped', reason: 'no-broadcast-yet' }
      } else {
        result = await pull({
          url,
          seconds,
          outDir: join(runDir, 'clips'),
          clipPull,
          isOwnVideo: (id) => observerApi.isOwnVideo(id),
          ffmpegPath,
          ytDlpPath,
          now
        })
      }
      const record = {
        at: now().toISOString(),
        trigger: reason,
        status: result.status,
        reason: result.reason ?? null,
        videoId: result.videoId ?? null,
        analysis: result.analysisPath ? result.analysisPath.split('/').pop() : null,
        clipKept: result.kept === true,
        incidents: (result.incidents ?? []).map((incident) => incident.signature)
      }
      clipResults.push(record)
      await mkdir(join(runDir, 'clips'), { recursive: true }).catch(() => {})
      await append(join(runDir, 'clips', 'pulls.ndjson'), `${JSON.stringify(record)}\n`).catch(
        () => {}
      )
      for (const incident of result.incidents ?? []) {
        recordIncident({ ...incident, at: record.at })
      }
      bus.emit('clip', record)
      return result
    } finally {
      pulling = false
    }
  }

  const observer = {
    attach({ onStudioEnded } = {}) {
      if (typeof onStudioEnded === 'function') hooks.onStudioEnded = onStudioEnded
    },
    incidents: () => [...incidents],
    snapshots: () => [...snapshots],
    latest,
    videoId,
    watchUrl,
    liveChatId: () => latest()?.broadcast?.liveChatId ?? latest()?.video?.activeLiveChatId ?? null,
    clipPull,
    clipResults: () => [...clipResults],
    pullClip: pullClipNow,
    /** One extra poll now (charged), recorded like the scheduled ones. */
    async poll() {
      const snapshot = await observerApi.poll()
      await recordSnapshot(snapshot)
      for (const incident of snapshot.incidents ?? []) recordIncident(incident)
      return snapshot
    },
    quota: () => {
      const today = ledger.today()
      return {
        day: today.day,
        labUnitsStart: quotaStart.day === today.day ? quotaStart.units : 0,
        labUnitsNow: today.units,
        labUnits: today.units - (quotaStart.day === today.day ? quotaStart.units : 0)
      }
    }
  }

  async function start() {
    watching = observerApi
      .watch({
        intervalMs,
        signal: abort.signal,
        onSnapshot: (snapshot) => {
          recordSnapshot(snapshot).catch(() => {})
        },
        onIncident: recordIncident
      })
      .catch((error) => {
        log(`Observer stopped: ${error.message}`)
        return { polls: 0, incidents: [], stoppedBy: 'error' }
      })
    if (clipPull) {
      clipTimer = clock.setInterval(() => {
        if (appOnAir() === true) pullClipNow({ reason: 'scheduled' }).catch(() => {})
      }, clipIntervalMs)
    }
    log(
      `YouTube observer on (every ${Math.round(intervalMs / 1000)} s); clip pulls ${
        clipPull ? `every ${Math.round(clipIntervalMs / 60000)} min` : 'off (policy clipPull)'
      }.`
    )
  }

  async function stop() {
    if (clipTimer !== null) clock.clearInterval(clipTimer)
    clipTimer = null
    abort.abort()
    const watched = watching ? await watching : null
    const quota = observer.quota()
    const summary = {
      polls: watched?.polls ?? 0,
      stoppedBy: watched?.stoppedBy ?? 'never-started',
      incidents: incidents.map((incident) => incident.signature),
      videoId: videoId(),
      clipPull,
      clipPulls: clipResults.length,
      quota
    }
    await write(
      join(runDir, 'quota.json'),
      `${JSON.stringify({ schema: 1, ...quota, bundledUnits: 0, calls: ledger.today().calls }, null, 2)}\n`
    ).catch(() => {})
    return summary
  }

  return { observer, viewer, start, stop }
}
