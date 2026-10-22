import { setTimeout as delay } from 'node:timers/promises'

import { QuotaRefused } from './quota-ledger.mjs'
import { createYoutubeClient } from './youtube-api.mjs'

// Plan 178 U8 (plan 176 L4 step 1, plan 166 S7 step 1). What YouTube
// received, read with the broadcaster's token on the lab Google project:
// the broadcast (lifecycle, privacy), its bound stream (streamStatus,
// healthStatus, configuration issues, resolution/fps), the video's
// liveStreamingDetails and the live chat (to see the app's own messages and
// the viewer bot's land). One poll costs 4 units (the first one finds the
// active broadcast, later ones read it by id); every 2 min that is about 120
// units an hour.
//
// Incidents it raises (signatures dedupe GitHub issues, plan 166):
//   stream:noData-while-live  P0  two consecutive polls where YouTube has no
//                                 data while the caller says the app is On
//                                 air (the plan 161 class)
//   studio-ended              P0  the broadcast went `complete` while the app
//                                 is On air; also calls `onStudioEnded`, the
//                                 U4 kill switch hook
//   youtube-health:bad        P1  healthStatus became `bad`
//   youtube-health:ok-sustained P2 `ok` (not `good`) for 3 polls in a row
//   youtube-config:<type>     P2  a configuration issue not seen before
//   observer:quota-refused    P2  the ledger refused a poll; watching stops
//
// Snapshots never carry tokens, stream keys or chat authors' names or
// channel ids (only `isChatOwner`), so they can go into reports as-is.

export const DEFAULT_INTERVAL_MS = 2 * 60 * 1000
export const NO_DATA_POLLS = 2
export const OK_SUSTAINED_POLLS = 3

const LIVE_LIFECYCLES = new Set(['live', 'liveStarting', 'testing', 'testStarting'])
const ENDED_LIFECYCLES = new Set(['complete', 'revoked'])

function summarizeBroadcast(item) {
  if (!item) return null
  return {
    id: item.id,
    channelId: item.snippet?.channelId ?? null,
    liveChatId: item.snippet?.liveChatId ?? null,
    lifeCycleStatus: item.status?.lifeCycleStatus ?? null,
    privacyStatus: item.status?.privacyStatus ?? null,
    boundStreamId: item.contentDetails?.boundStreamId ?? null
  }
}

function summarizeStream(item) {
  if (!item) return null
  const health = item.status?.healthStatus ?? {}
  return {
    id: item.id,
    streamStatus: item.status?.streamStatus ?? null,
    healthStatus: health.status ?? null,
    configurationIssues: (health.configurationIssues ?? []).map((issue) => ({
      type: issue.type ?? 'unknown',
      severity: issue.severity ?? null,
      reason: issue.reason ?? null
    })),
    resolution: item.cdn?.resolution ?? null,
    frameRate: item.cdn?.frameRate ?? null
  }
}

function summarizeVideo(item) {
  const details = item?.liveStreamingDetails
  if (!details) return null
  return {
    actualStartTime: details.actualStartTime ?? null,
    actualEndTime: details.actualEndTime ?? null,
    concurrentViewers:
      details.concurrentViewers === undefined ? null : Number(details.concurrentViewers),
    activeLiveChatId: details.activeLiveChatId ?? null
  }
}

function summarizeChatMessage(item) {
  return {
    id: item.id,
    type: item.snippet?.type ?? null,
    publishedAt: item.snippet?.publishedAt ?? null,
    text: item.snippet?.displayMessage ?? item.snippet?.textMessageDetails?.messageText ?? '',
    isChatOwner: item.authorDetails?.isChatOwner === true
  }
}

/** Pure: does this stream reading count as "YouTube has no data"? */
export function isNoData(stream) {
  if (!stream) return true
  return stream.streamStatus !== 'active' || stream.healthStatus === 'noData'
}

/**
 * Pure incident rules. `state` carries the streaks between polls and is
 * returned updated; `snapshot.appOnAir` is what the app reported at poll time.
 */
export function evaluateSnapshot(snapshot, state = initialRuleState()) {
  const next = {
    noDataStreak: state.noDataStreak,
    noDataRaised: state.noDataRaised,
    okStreak: state.okStreak,
    okRaised: state.okRaised,
    lastHealth: state.lastHealth,
    seenIssues: new Set(state.seenIssues),
    studioEndedRaised: state.studioEndedRaised
  }
  const incidents = []
  const at = snapshot.at
  const raise = (type, severity, detail) =>
    incidents.push({ type, signature: type, severity, at, detail })

  // A failed stream read is unknown, not noData: it neither counts nor resets.
  const streamKnown = !snapshot.errors.some((error) =>
    ['liveStreams.list', 'liveBroadcasts.list'].includes(error.call)
  )

  if (streamKnown) {
    if (snapshot.appOnAir === true && isNoData(snapshot.stream)) {
      next.noDataStreak += 1
      if (next.noDataStreak >= NO_DATA_POLLS && !next.noDataRaised) {
        next.noDataRaised = true
        raise(
          'stream:noData-while-live',
          'P0',
          `App reports On air, YouTube stream is ${snapshot.stream?.streamStatus ?? 'missing'} / ${snapshot.stream?.healthStatus ?? 'no health'} for ${next.noDataStreak} polls.`
        )
      }
    } else {
      next.noDataStreak = 0
      next.noDataRaised = false
    }

    const health = snapshot.stream?.healthStatus ?? null
    if (health === 'bad' && next.lastHealth !== 'bad') {
      raise('youtube-health:bad', 'P1', 'YouTube stream health is bad.')
    }
    if (health === 'ok') {
      next.okStreak += 1
      if (next.okStreak >= OK_SUSTAINED_POLLS && !next.okRaised) {
        next.okRaised = true
        raise(
          'youtube-health:ok-sustained',
          'P2',
          `YouTube stream health has been ok (not good) for ${next.okStreak} polls.`
        )
      }
    } else {
      next.okStreak = 0
      next.okRaised = false
    }
    if (snapshot.stream) next.lastHealth = health

    for (const issue of snapshot.stream?.configurationIssues ?? []) {
      if (next.seenIssues.has(issue.type)) continue
      next.seenIssues.add(issue.type)
      raise(
        `youtube-config:${issue.type}`,
        'P2',
        `New YouTube configuration issue ${issue.type} (${issue.severity ?? 'no severity'}).`
      )
    }
  }

  const lifecycle = snapshot.broadcast?.lifeCycleStatus
  if (snapshot.appOnAir === true && ENDED_LIFECYCLES.has(lifecycle) && !next.studioEndedRaised) {
    next.studioEndedRaised = true
    raise(
      'studio-ended',
      'P0',
      `The broadcast is ${lifecycle} on YouTube while the app reports On air.`
    )
  }

  return { incidents, state: next }
}

export function initialRuleState() {
  return {
    noDataStreak: 0,
    noDataRaised: false,
    okStreak: 0,
    okRaised: false,
    lastHealth: null,
    seenIssues: new Set(),
    studioEndedRaised: false
  }
}

/**
 * @param {object} options
 * @param {(role: string) => Promise<string>} options.getToken  `getAccessToken` from oauth.mjs
 * @param {object} options.ledger  from quota-ledger.mjs
 * @param {typeof fetch} [options.fetch]
 * @param {string} [options.apiBase]
 * @param {() => Date} [options.now]
 * @param {() => boolean | Promise<boolean>} [options.appOnAir]  what the app reports
 * @param {(snapshot: object) => void} [options.onStudioEnded]  U4 kill switch hook
 * @param {string} [options.broadcastId]  pin a broadcast (otherwise the active one is found)
 */
export function createYoutubeObserver({
  getToken,
  ledger,
  fetch: fetchImpl = fetch,
  apiBase,
  now = () => new Date(),
  appOnAir = () => null,
  onStudioEnded = null,
  broadcastId = null,
  role = 'broadcaster',
  sleep = (ms, signal) => delay(ms, undefined, { signal })
}) {
  const client = createYoutubeClient({ getToken, ledger, fetch: fetchImpl, apiBase })
  const call = (method, httpMethod, resource, query) =>
    client.call({ role, method, httpMethod, resource, query })

  let pinnedBroadcastId = broadcastId
  let chatPageToken = null
  let chatId = null
  let myChannelId = null
  let ruleState = initialRuleState()

  async function findBroadcast() {
    if (pinnedBroadcastId) {
      const page = await call('liveBroadcasts.list', 'GET', 'liveBroadcasts', {
        part: 'id,snippet,status,contentDetails',
        id: pinnedBroadcastId
      })
      return page?.items?.[0] ?? null
    }
    // broadcastType=all: the default (event) hides persistent "Stream now"
    // broadcasts, which are what manual RTMP keys with Auto-start create.
    const page = await call('liveBroadcasts.list', 'GET', 'liveBroadcasts', {
      part: 'id,snippet,status,contentDetails',
      broadcastStatus: 'active',
      broadcastType: 'all',
      maxResults: 5
    })
    const live = (page?.items ?? []).find((item) =>
      LIVE_LIFECYCLES.has(item.status?.lifeCycleStatus)
    )
    if (live) pinnedBroadcastId = live.id
    return live ?? null
  }

  async function findStream(broadcast) {
    const boundId = broadcast?.boundStreamId
    const page = await call(
      'liveStreams.list',
      'GET',
      'liveStreams',
      boundId
        ? { part: 'id,snippet,cdn,status', id: boundId }
        : { part: 'id,snippet,cdn,status', mine: 'true', maxResults: 5 }
    )
    const items = page?.items ?? []
    return items.find((item) => item.status?.streamStatus === 'active') ?? items[0] ?? null
  }

  async function poll() {
    const at = now().toISOString()
    const errors = []
    const guard = async (name, work) => {
      try {
        return await work()
      } catch (error) {
        if (error instanceof QuotaRefused) throw error
        errors.push({ call: name, message: error.message, status: error.status ?? null })
        return null
      }
    }
    const onAir = await Promise.resolve(appOnAir())

    const broadcast = summarizeBroadcast(await guard('liveBroadcasts.list', findBroadcast))
    const stream = summarizeStream(await guard('liveStreams.list', () => findStream(broadcast)))
    const video = broadcast
      ? summarizeVideo(
          (
            await guard('videos.list', () =>
              call('videos.list', 'GET', 'videos', {
                part: 'liveStreamingDetails',
                id: broadcast.id
              })
            )
          )?.items?.[0]
        )
      : null

    let chat = null
    const liveChatId = broadcast?.liveChatId ?? video?.activeLiveChatId ?? null
    if (liveChatId) {
      if (liveChatId !== chatId) {
        chatId = liveChatId
        chatPageToken = null
      }
      const page = await guard('liveChatMessages.list', () =>
        call('liveChatMessages.list', 'GET', 'liveChat/messages', {
          liveChatId,
          part: 'id,snippet,authorDetails',
          maxResults: 200,
          pageToken: chatPageToken
        })
      )
      if (page) {
        chatPageToken = page.nextPageToken ?? chatPageToken
        chat = {
          liveChatId,
          newMessages: (page.items ?? []).map(summarizeChatMessage),
          pollingIntervalMillis: page.pollingIntervalMillis ?? null
        }
      }
    }

    const snapshot = {
      at,
      appOnAir: onAir === null || onAir === undefined ? null : Boolean(onAir),
      broadcast,
      stream,
      video,
      chat,
      errors,
      quota: ledger.today()
    }
    const evaluated = evaluateSnapshot(snapshot, ruleState)
    ruleState = evaluated.state
    snapshot.incidents = evaluated.incidents
    if (onStudioEnded && evaluated.incidents.some((incident) => incident.type === 'studio-ended')) {
      onStudioEnded(snapshot)
    }
    return snapshot
  }

  /**
   * Polls every `intervalMs` until `signal` aborts (or the ledger refuses a
   * poll). Resolves with a summary; never throws for a failed API call.
   */
  async function watch({
    intervalMs = DEFAULT_INTERVAL_MS,
    onSnapshot = () => {},
    onIncident = () => {},
    signal
  } = {}) {
    let polls = 0
    const incidents = []
    const emit = (incident) => {
      incidents.push(incident)
      onIncident(incident)
    }
    while (!signal?.aborted) {
      let snapshot
      try {
        snapshot = await poll()
      } catch (error) {
        if (error instanceof QuotaRefused) {
          emit({
            type: 'observer:quota-refused',
            signature: 'observer:quota-refused',
            severity: 'P2',
            at: now().toISOString(),
            detail: error.message
          })
          return { polls, incidents, stoppedBy: 'quota' }
        }
        throw error
      }
      polls += 1
      onSnapshot(snapshot)
      for (const incident of snapshot.incidents) emit(incident)
      try {
        await sleep(intervalMs, signal)
      } catch (error) {
        if (error?.name === 'AbortError') break
        throw error
      }
    }
    return { polls, incidents, stoppedBy: 'signal' }
  }

  /**
   * Is `videoId` a broadcast of the broadcaster's own channel? liveBroadcasts
   * only lists the caller's own broadcasts, and the channel id is checked on
   * top. Costs 2 units the first time, 1 after. The clip puller requires it.
   */
  async function isOwnVideo(videoId) {
    if (!videoId) return false
    if (!myChannelId) {
      const channels = await call('channels.list', 'GET', 'channels', { part: 'id', mine: 'true' })
      myChannelId = channels?.items?.[0]?.id ?? null
      if (!myChannelId) return false
    }
    const page = await call('liveBroadcasts.list', 'GET', 'liveBroadcasts', {
      part: 'id,snippet',
      id: videoId
    })
    const item = page?.items?.[0]
    return Boolean(item && item.id === videoId && item.snippet?.channelId === myChannelId)
  }

  return {
    poll,
    watch,
    isOwnVideo,
    get broadcastId() {
      return pinnedBroadcastId
    }
  }
}
