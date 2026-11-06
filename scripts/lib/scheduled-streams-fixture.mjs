import { createServer } from 'node:http'

// Loopback-only provider fixture. Never accepts a production channel or token.
export async function startScheduledStreamsFixture({
  ingestUrl = 'rtmp://127.0.0.1:12945/live'
} = {}) {
  const events = new Map()
  const streams = new Map()
  // X Livestream Scheduling API: one dedicated source per schedule.
  const xSources = new Map()
  const xSchedules = new Map()
  const calls = []
  const controls = {
    failThumbnail: false,
    loseCreateResponse: false,
    rejectCreate: false,
    loseStreamResponse: false,
    /** The X fixture source reports RTMP as flowing. */
    xSourceActive: false,
    loseXCreateResponse: false
  }
  let eventCounter = 0
  let xCounter = 0
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    const signedForX =
      url.pathname.startsWith('/2/') &&
      /^OAuth .*oauth_signature="/.test(request.headers.authorization ?? '')
    if (!signedForX && request.headers.authorization !== 'Bearer local-fixture-only') {
      response.writeHead(401).end('{}')
      return
    }
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const bytes = Buffer.concat(chunks)
    let body = null
    try {
      body = JSON.parse(bytes.toString())
    } catch {
      /* image or empty request */
    }
    calls.push({
      method: request.method,
      path: url.pathname,
      id: url.searchParams.get('id'),
      body,
      byteLength: bytes.length
    })
    const send = (value, status = 200) => {
      response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))
    }
    if (signedForX) {
      handleX({ request, url, body, bytes, send, response })
      return
    }
    if (url.pathname === '/youtube/v3/liveBroadcasts') {
      if (request.method === 'POST') {
        if (controls.rejectCreate) {
          send({ error: { errors: [{ reason: 'invalidScheduledStartTime' }] } }, 400)
          return
        }
        const id = `fixture-event-${++eventCounter}`
        const event = {
          ...body,
          id,
          snippet: { ...body.snippet, channelId: 'scheduled-smoke-channel' },
          status: { ...body.status, lifeCycleStatus: 'ready' }
        }
        events.set(id, event)
        if (controls.loseCreateResponse) {
          controls.loseCreateResponse = false
          response.destroy()
          return
        }
        send(event)
        return
      }
      const id = url.searchParams.get('id')
      if (request.method === 'GET') {
        send({
          items: id
            ? [events.get(id)].filter(Boolean)
            : [...events.values()].filter((event) => event.status.lifeCycleStatus === 'ready')
        })
        return
      }
      if (request.method === 'DELETE') {
        events.delete(id)
        response.writeHead(204).end()
        return
      }
      if (request.method === 'PUT') {
        const event = events.get(body.id)
        event.snippet = { ...event.snippet, ...body.snippet }
        event.status = { ...event.status, ...body.status }
        send(event)
        return
      }
    }
    if (url.pathname === '/upload/youtube/v3/thumbnails/set') {
      if (controls.failThumbnail) {
        send({ error: { errors: [{ reason: 'forbidden' }] } }, 403)
        return
      }
      const event = events.get(url.searchParams.get('videoId'))
      if (!event) {
        send({}, 404)
        return
      }
      event.thumbnailBytes = bytes.length
      send({ items: [{}] })
      return
    }
    if (url.pathname === '/youtube/v3/liveStreams') {
      if (request.method === 'POST') {
        const id = `fixture-stream-${streams.size + 1}`
        const stream = {
          id,
          snippet: { ...body.snippet, channelId: 'scheduled-smoke-channel' },
          cdn: {
            ...body.cdn,
            ingestionInfo: { ingestionAddress: ingestUrl, streamName: 'scheduled-smoke' }
          },
          status: { streamStatus: 'inactive' }
        }
        streams.set(id, stream)
        if (controls.loseStreamResponse) {
          controls.loseStreamResponse = false
          response.destroy()
          return
        }
        send(stream)
        return
      }
      send({
        items: url.searchParams.has('id')
          ? [streams.get(url.searchParams.get('id'))].filter(Boolean)
          : [...streams.values()]
      })
      return
    }
    if (url.pathname === '/youtube/v3/liveBroadcasts/bind') {
      const event = events.get(url.searchParams.get('id'))
      event.contentDetails.boundStreamId = url.searchParams.get('streamId')
      send(event)
      return
    }
    if (url.pathname === '/youtube/v3/liveBroadcasts/transition') {
      const event = events.get(url.searchParams.get('id'))
      event.status.lifeCycleStatus = url.searchParams.get('broadcastStatus')
      send(event)
      return
    }
    send({}, 404)
  })
  // The /2/sources + /2/broadcasts routes (X migration guide, 2026-11-05):
  // `data` envelopes, problem-JSON errors, 19-digit source ids, and the
  // stream key only in the create response and the stream_key route.
  const isSourceId = (id) => /^\d+$/.test(id ?? '')
  const problem = (send, status, detail) =>
    send(
      {
        type:
          status === 400
            ? 'https://api.x.com/2/problems/invalid-request'
            : status === 404
              ? 'https://api.x.com/2/problems/resource-not-found'
              : status === 409
                ? 'https://api.x.com/2/problems/conflict'
                : 'about:blank',
        title: 'Problem',
        detail,
        status
      },
      status
    )
  const publicSource = (source) => {
    // eslint-disable-next-line no-unused-vars
    const { stream_key, ...rest } = source
    return rest
  }
  function handleX({ request, url, body, bytes, send, response }) {
    const { method } = request
    const path = url.pathname
    const sourcePath = path.match(/^\/2\/sources(?:\/([^/]+))?(\/stream_key)?$/)
    const schedulePath = path.match(/^\/2\/broadcasts\/scheduled(?:\/([^/]+))?(\/live)?$/)
    const statePath = path.match(/^\/2\/broadcasts\/([^/]+)\/state$/)
    const broadcastPath = path.match(/^\/2\/broadcasts\/([^/]+)$/)
    if (path === '/2/region') {
      send({ region: 'us-east-1' })
      return
    }
    if (sourcePath && !sourcePath[1]) {
      if (method === 'POST') {
        const keys = Object.keys(body ?? {})
        if (keys.length !== 2 || !keys.includes('name') || !keys.includes('region')) {
          problem(send, 400, 'POST /2/sources accepts only name and region.')
          return
        }
        const id = String(9123456789012345000n + BigInt(++xCounter))
        const source = {
          id,
          name: body.name,
          region: 'us-east-1',
          rtmp_url: ingestUrl,
          rtmps_url: ingestUrl,
          stream_key: 'scheduled-smoke-x',
          is_stream_active: false,
          created_at_ms: String(Date.now())
        }
        xSources.set(id, source)
        send({ data: source }, 201)
        return
      }
      const data = [...xSources.values()].map(publicSource)
      send({ data, meta: { result_count: data.length } })
      return
    }
    if (sourcePath && sourcePath[1]) {
      if (!isSourceId(sourcePath[1])) {
        problem(send, 400, 'The `id` value is not a source id.')
        return
      }
      const source = xSources.get(sourcePath[1])
      if (!source) {
        problem(send, 404, 'Source not found.')
        return
      }
      if (sourcePath[2]) {
        send({ data: { id: source.id, stream_key: source.stream_key } })
        return
      }
      if (method === 'DELETE') {
        xSources.delete(sourcePath[1])
        send({ data: { deleted: true } })
        return
      }
      send({ data: { ...publicSource(source), is_stream_active: controls.xSourceActive } })
      return
    }
    if (schedulePath && !schedulePath[1]) {
      if (method === 'POST') {
        if (!isSourceId(body?.source_id)) {
          problem(send, 400, 'The `source_id` value is not a source id.')
          return
        }
        const broadcastId = `xsched${++xCounter}`
        const schedule = {
          ...body,
          broadcast_id: broadcastId,
          scheduled_broadcast_id: String(2075599796786561024n + BigInt(xCounter)),
          state: 'Created'
        }
        xSchedules.set(broadcastId, schedule)
        if (controls.loseXCreateResponse) {
          controls.loseXCreateResponse = false
          response.destroy()
          return
        }
        send({ data: schedule }, 201)
        return
      }
      send({ data: [...xSchedules.values()] })
      return
    }
    if (schedulePath && schedulePath[1]) {
      const schedule = xSchedules.get(schedulePath[1])
      if (!schedule) {
        problem(send, 404, 'Scheduled broadcast not found.')
        return
      }
      if (schedulePath[2]) {
        if (!schedule.manual_publish) {
          problem(send, 400, 'manual publish required')
          return
        }
        if (!controls.xSourceActive) {
          problem(send, 400, 'source is not receiving video')
          return
        }
        schedule.state = 'Running'
        send({ data: schedule })
        return
      }
      if (method === 'PUT') {
        if (!body?.scheduled_end_ms || !body?.scheduled_broadcast_id) {
          problem(send, 400, 'scheduled_end_ms and scheduled_broadcast_id are required')
          return
        }
        if (!isSourceId(body.source_id)) {
          problem(send, 400, 'The `source_id` value is not a source id.')
          return
        }
        // Full replacement: nothing survives that the body did not carry.
        const replaced = {
          ...body,
          broadcast_id: schedule.broadcast_id,
          scheduled_broadcast_id: schedule.scheduled_broadcast_id,
          state: schedule.state
        }
        xSchedules.set(schedulePath[1], replaced)
        send({ data: replaced })
        return
      }
      if (method === 'DELETE') {
        xSchedules.delete(schedulePath[1])
        send({ data: { deleted: true } })
        return
      }
      send({ data: schedule })
      return
    }
    if (path === '/2/broadcasts' && method === 'POST') {
      // Instant Go Live (never used by the scheduling smoke, which asserts
      // it is not called): strict body, 201, RUNNING.
      const allowed = ['source_id', 'title', 'locale', 'chat_option', 'should_not_tweet']
      const unknown = Object.keys(body ?? {}).filter((key) => !allowed.includes(key))
      if (unknown.length > 0) {
        problem(send, 400, `unknown field: ${unknown.join(', ')}`)
        return
      }
      if (!isSourceId(body?.source_id)) {
        problem(send, 400, 'The `source_id` value is not a source id.')
        return
      }
      const id = `xlive${++xCounter}`
      send(
        {
          data: {
            id,
            broadcast_id: id,
            state: 'RUNNING',
            share_url: `https://x.com/i/broadcasts/${id}`,
            media_key: `28_${String(2116610227978326016n + BigInt(xCounter))}`
          }
        },
        201
      )
      return
    }
    if (statePath) {
      if (body?.state !== 'END' || Object.keys(body).length !== 1) {
        problem(send, 400, 'Send exactly {"state":"END"}.')
        return
      }
      const schedule = xSchedules.get(statePath[1])
      if (schedule) schedule.state = 'Ended'
      send({ data: { id: statePath[1], state: 'ENDED' } })
      return
    }
    if (broadcastPath && method === 'GET') {
      const schedule = xSchedules.get(broadcastPath[1])
      if (!schedule) {
        problem(send, 404, 'Broadcast not found.')
        return
      }
      send({
        data: {
          id: broadcastPath[1],
          broadcast_id: broadcastPath[1],
          media_key: `28_${String(2116610227978326016n + BigInt(xCounter))}`,
          state: schedule.state === 'Running' ? 'RUNNING' : 'NOT_STARTED',
          share_url: `https://x.com/i/broadcasts/${broadcastPath[1]}`,
          total_watching: '3'
        }
      })
      return
    }
    if (path === '/2/media/upload' && method === 'POST') {
      if (controls.failThumbnail) {
        send({ title: 'media rejected' }, 400)
        return
      }
      const text = bytes.toString('latin1')
      if (!text.includes('name="media_category"') || !text.includes('tweet_image')) {
        send({ title: 'media_category required' }, 400)
        return
      }
      send({ data: { id: `${++xCounter}00`, media_key: `3_${xCounter}00` } })
      return
    }
    send({}, 404)
  }
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    events,
    streams,
    xSources,
    xSchedules,
    calls,
    controls,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(resolve)
      })
  }
}
