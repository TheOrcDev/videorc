import { createServer } from 'node:http'

// A loopback stand-in for the YouTube Data API v3 (plan 094, S4). The debug
// backend points every YouTube client at it through
// `VIDEORC_YOUTUBE_API_BASE_URL`: OAuth token exchange, channels, broadcast
// prepare/bind/transition, liveStreams, liveChat list and insert, videos and
// the thumbnail upload, and the chat message delete (plan 140: 204, 50 units).
// It records every request, `controls.quotaExhausted` flips every Data API
// route to Google's 403 `quotaExceeded` envelope on command, and
// `controls.deleteFailure` scripts the delete. Never accepts anything but its
// own fixture token.

export const FAKE_YOUTUBE_ACCESS_TOKEN = 'smoke-youtube-token'
export const FAKE_YOUTUBE_REFRESH_TOKEN = 'smoke-youtube-refresh'
export const FAKE_YOUTUBE_CHANNEL_ID = 'UCquota-smoke'
export const FAKE_YOUTUBE_SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl'

/** Google's envelope for an exhausted daily quota, as the owner saw it. */
export function quotaExceededBody() {
  return {
    error: {
      code: 403,
      message:
        'The request cannot be completed because you have exceeded your <a href="/youtube/v3/getting-started#quota">quota</a>.',
      errors: [
        {
          message:
            'The request cannot be completed because you have exceeded your <a href="/youtube/v3/getting-started#quota">quota</a>.',
          domain: 'youtube.quota',
          reason: 'quotaExceeded'
        }
      ]
    }
  }
}

/** Pure: whether a path spends YouTube Data API quota (OAuth routes do not). */
export function isDataApiPath(pathname) {
  return pathname.startsWith('/youtube/') || pathname.startsWith('/upload/')
}

/** Published REST estimates only; OAuth is excluded and streaming is unknown. */
export function youtubeAttemptCost(method, path) {
  if (!isDataApiPath(path)) return null
  const resource = path.replace(/^\/(upload\/)?youtube\/v3\//, '')
  const reads = {
    'liveChat/messages': 'liveChatMessages.list',
    videos: 'videos.list',
    channels: 'channels.list',
    liveBroadcasts: 'liveBroadcasts.list',
    liveStreams: 'liveStreams.list'
  }
  const writes = {
    'POST liveChat/messages': 'liveChatMessages.insert',
    'POST liveBroadcasts': 'liveBroadcasts.insert',
    'PUT liveBroadcasts': 'liveBroadcasts.update',
    'DELETE liveBroadcasts': 'liveBroadcasts.delete',
    'DELETE liveChat/messages': 'liveChatMessages.delete',
    'POST liveBroadcasts/bind': 'liveBroadcasts.bind',
    'POST liveBroadcasts/transition': 'liveBroadcasts.transition',
    'POST liveStreams': 'liveStreams.insert',
    'POST thumbnails/set': 'thumbnails.set'
  }
  const endpoint = method === 'GET' ? reads[resource] : writes[`${method} ${resource}`]
  return endpoint
    ? { endpoint, units: method === 'GET' ? 1 : 50 }
    : { endpoint: 'unknown', units: null }
}

export function summarizeYouTubeAttempts(requests) {
  const endpoints = {}
  let units = 0
  let calls = 0
  let unknown = 0
  for (const request of requests) {
    const cost = youtubeAttemptCost(request.method, request.path)
    if (!cost) continue
    calls += 1
    if (cost.units === null) {
      unknown += 1
      continue
    }
    units += cost.units
    const row = (endpoints[cost.endpoint] ??= { calls: 0, units: 0, outcomes: {} })
    row.calls += 1
    row.units += cost.units
    const outcome = String(request.status ?? 'pending')
    row.outcomes[outcome] = (row.outcomes[outcome] ?? 0) + 1
  }
  return { calls, estimatedUnits: units, unknown, endpoints }
}

/**
 * Pure: one `liveChatMessages.list` page. The page token is the index of the
 * first unseen message, so a reader that keeps its token resumes exactly
 * where it stopped (G4).
 */
export function chatPage(messages, pageToken, pollingIntervalMillis = 1000) {
  const start = Math.min(Math.max(0, Number(pageToken ?? 0) || 0), messages.length)
  return {
    kind: 'youtube#liveChatMessageListResponse',
    pollingIntervalMillis,
    nextPageToken: String(messages.length),
    items: messages.slice(start)
  }
}

export async function startFakeYouTubeApi({
  ingestUrl = 'rtmp://127.0.0.1:1935/live',
  streamKey = 'smoke-yt-key',
  accessToken = FAKE_YOUTUBE_ACCESS_TOKEN,
  subscriberCount = 1234,
  concurrentViewers = 7
} = {}) {
  const requests = []
  // `deleteFailure` scripts every `liveChatMessages.delete`: null answers 204;
  // 'forbidden' is a 403 insufficientPermissions (missing scope), 'not-found'
  // a 404, 'quota' the 403 quotaExceeded envelope.
  const controls = { quotaExhausted: false, deleteFailure: null }
  const broadcasts = new Map()
  const streams = new Map()
  const chat = { messages: [], sent: [], deleted: [] }
  let counter = 0
  let autoChat = null

  const postChat = (text, authorName = 'quota_fan') => {
    counter += 1
    const message = {
      kind: 'youtube#liveChatMessage',
      id: `smoke-chat-${counter}`,
      snippet: {
        type: 'textMessageEvent',
        liveChatId: 'smoke-live-chat',
        publishedAt: new Date().toISOString(),
        hasDisplayContent: true,
        displayMessage: text,
        textMessageDetails: { messageText: text }
      },
      authorDetails: {
        channelId: `UC-${authorName}`,
        displayName: authorName,
        isVerified: false,
        isChatOwner: false,
        isChatSponsor: false,
        isChatModerator: false
      }
    }
    chat.messages.push(message)
    return message
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const bytes = Buffer.concat(chunks)
    let body = null
    try {
      body = JSON.parse(bytes.toString())
    } catch {
      /* form, image or empty */
    }
    const record = {
      method: request.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      at: Date.now(),
      quotaExhausted: controls.quotaExhausted,
      dataApi: isDataApiPath(url.pathname)
    }
    requests.push(record)
    const send = (value, status = 200) => {
      record.status = status
      const text = JSON.stringify(value)
      response
        .writeHead(status, {
          'content-type': 'application/json; charset=UTF-8',
          'content-length': Buffer.byteLength(text)
        })
        .end(text)
    }

    if (url.pathname === '/token') {
      send({
        access_token: accessToken,
        refresh_token: FAKE_YOUTUBE_REFRESH_TOKEN,
        expires_in: 3600,
        scope: FAKE_YOUTUBE_SCOPE,
        token_type: 'Bearer'
      })
      return
    }
    if (url.pathname === '/revoke') {
      send({})
      return
    }
    if (request.headers.authorization !== `Bearer ${accessToken}`) {
      send(
        {
          error: {
            code: 401,
            message: 'Invalid Credentials',
            errors: [{ domain: 'global', reason: 'authError', message: 'Invalid Credentials' }]
          }
        },
        401
      )
      return
    }
    if (controls.quotaExhausted && isDataApiPath(url.pathname)) {
      send(quotaExceededBody(), 403)
      return
    }

    switch (url.pathname) {
      case '/youtube/v3/channels': {
        send({
          kind: 'youtube#channelListResponse',
          items: [
            {
              kind: 'youtube#channel',
              id: FAKE_YOUTUBE_CHANNEL_ID,
              snippet: {
                title: 'Quota smoke channel',
                customUrl: '@quotasmoke',
                thumbnails: { default: { url: 'http://127.0.0.1/avatar.png' } }
              },
              statistics: { subscriberCount: String(subscriberCount), hiddenSubscriberCount: false }
            }
          ]
        })
        return
      }
      case '/youtube/v3/liveBroadcasts': {
        if (request.method === 'POST') {
          const id = `smoke-broadcast-${broadcasts.size + 1}`
          const broadcast = {
            kind: 'youtube#liveBroadcast',
            id,
            snippet: {
              ...(body?.snippet ?? {}),
              liveChatId: 'smoke-live-chat',
              channelId: FAKE_YOUTUBE_CHANNEL_ID
            },
            status: { ...(body?.status ?? {}), lifeCycleStatus: 'ready' },
            contentDetails: { ...(body?.contentDetails ?? {}) }
          }
          broadcasts.set(id, broadcast)
          send(broadcast)
          return
        }
        if (request.method === 'GET') {
          const id = url.searchParams.get('id')
          send({
            kind: 'youtube#liveBroadcastListResponse',
            items: id ? [broadcasts.get(id)].filter(Boolean) : [...broadcasts.values()]
          })
          return
        }
        if (request.method === 'DELETE') {
          broadcasts.delete(url.searchParams.get('id'))
          response.writeHead(204).end()
          return
        }
        break
      }
      case '/youtube/v3/liveBroadcasts/bind': {
        const broadcast = broadcasts.get(url.searchParams.get('id'))
        if (!broadcast) {
          send(notFound('liveBroadcastNotFound'), 404)
          return
        }
        broadcast.contentDetails.boundStreamId = url.searchParams.get('streamId')
        send(broadcast)
        return
      }
      case '/youtube/v3/liveBroadcasts/transition': {
        const broadcast = broadcasts.get(url.searchParams.get('id'))
        if (!broadcast) {
          send(notFound('liveBroadcastNotFound'), 404)
          return
        }
        broadcast.status.lifeCycleStatus = url.searchParams.get('broadcastStatus')
        send(broadcast)
        return
      }
      case '/youtube/v3/liveStreams': {
        if (request.method === 'POST') {
          const id = `smoke-stream-${streams.size + 1}`
          const stream = {
            kind: 'youtube#liveStream',
            id,
            snippet: { ...(body?.snippet ?? {}), channelId: FAKE_YOUTUBE_CHANNEL_ID },
            cdn: {
              ...(body?.cdn ?? {}),
              ingestionInfo: {
                ingestionAddress: ingestUrl,
                backupIngestionAddress: ingestUrl,
                streamName: streamKey
              }
            },
            status: { streamStatus: 'active', healthStatus: { status: 'good' } }
          }
          streams.set(id, stream)
          send(stream)
          return
        }
        if (request.method === 'GET') {
          const id = url.searchParams.get('id')
          send({
            kind: 'youtube#liveStreamListResponse',
            items: id ? [streams.get(id)].filter(Boolean) : [...streams.values()]
          })
          return
        }
        break
      }
      case '/youtube/v3/liveChat/messages':
      case '/youtube/v3/liveChat/messages/stream': {
        if (request.method === 'DELETE' && url.pathname === '/youtube/v3/liveChat/messages') {
          // Plan 140: `liveChatMessages.delete` answers 204 with no body. The
          // message stays in the list so page tokens (indexes) never shift.
          const id = url.searchParams.get('id') ?? ''
          const failure = deleteFailureResponse(controls.deleteFailure)
          if (failure) {
            send(failure.body, failure.status)
            return
          }
          if (!id || !chat.messages.some((message) => message.id === id)) {
            send(notFound('liveChatMessageNotFound'), 404)
            return
          }
          chat.deleted.push(id)
          record.status = 204
          response.writeHead(204).end()
          return
        }
        if (request.method === 'POST') {
          const text = body?.snippet?.textMessageDetails?.messageText ?? ''
          const sent = postChat(text, 'videorc_streamer')
          chat.sent.push(sent)
          send(sent)
          return
        }
        send(chatPage(chat.messages, url.searchParams.get('pageToken')))
        return
      }
      case '/youtube/v3/videos': {
        send({
          kind: 'youtube#videoListResponse',
          items: [
            {
              id: url.searchParams.get('id'),
              liveStreamingDetails: { concurrentViewers: String(concurrentViewers) }
            }
          ]
        })
        return
      }
      case '/upload/youtube/v3/thumbnails/set': {
        send({ kind: 'youtube#thumbnailSetResponse', items: [{}] })
        return
      }
      default:
        break
    }
    send(notFound('notFound'), 404)
  })

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListen)
      resolveListen()
    })
  })
  const { port } = server.address()
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    controls,
    chat,
    broadcasts,
    streams,
    postChat,
    /** Post a chat line every `intervalMs` until `stopAutoChat()`. */
    startAutoChat(intervalMs = 1500) {
      this.stopAutoChat()
      let index = 0
      autoChat = setInterval(() => {
        index += 1
        postChat(`smoke message ${index}`)
      }, intervalMs)
    },
    stopAutoChat() {
      if (autoChat) clearInterval(autoChat)
      autoChat = null
    },
    /** Data API requests recorded since `since` (ms), OAuth routes excluded. */
    dataApiRequestsSince(since) {
      return requests.filter((entry) => entry.dataApi && entry.at >= since)
    },
    close() {
      this.stopAutoChat()
      return new Promise((resolveClose) => {
        server.closeAllConnections?.()
        server.close(() => resolveClose())
      })
    }
  }
}

/** Pure: the scripted answer for a `liveChatMessages.delete`, or null for 204. */
export function deleteFailureResponse(mode) {
  switch (mode) {
    case 'forbidden':
      return {
        status: 403,
        body: {
          error: {
            code: 403,
            message: 'Request had insufficient authentication scopes.',
            errors: [
              {
                domain: 'global',
                reason: 'insufficientPermissions',
                message: 'Insufficient Permission'
              }
            ]
          }
        }
      }
    case 'not-found':
      return { status: 404, body: notFound('liveChatMessageNotFound') }
    case 'quota':
      return { status: 403, body: quotaExceededBody() }
    default:
      return null
  }
}

function notFound(reason) {
  return {
    error: {
      code: 404,
      message: reason,
      errors: [{ domain: 'youtube.liveBroadcast', reason, message: reason }]
    }
  }
}
