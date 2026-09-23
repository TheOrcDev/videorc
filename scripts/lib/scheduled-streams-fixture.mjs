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
  function handleX({ request, url, body, bytes, send, response }) {
    const { method } = request
    const path = url.pathname
    const sourcePath = path.match(/^\/2\/users\/([^/]+)\/sources(?:\/([^/]+))?$/)
    const schedulePath = path.match(/^\/2\/broadcasts\/scheduled(?:\/([^/]+))?(\/live)?$/)
    const statePath = path.match(/^\/2\/users\/([^/]+)\/broadcasts\/([^/]+)\/state$/)
    const broadcastPath = path.match(/^\/2\/broadcasts\/([^/]+)$/)
    if (path === '/2/region') {
      send({ region: 'fixture-region' })
      return
    }
    if (sourcePath && !sourcePath[2]) {
      if (method === 'POST') {
        const id = `x-source-${++xCounter}`
        const source = {
          id,
          name: body?.name ?? '',
          rtmp_region: 'fixture-region',
          rtmps_url: ingestUrl,
          rtmp_stream_key: 'scheduled-smoke-x',
          is_stream_active: false
        }
        xSources.set(id, source)
        send({ source })
        return
      }
      send({ sources: [...xSources.values()] })
      return
    }
    if (sourcePath && sourcePath[2]) {
      const source = xSources.get(sourcePath[2])
      if (!source) {
        send({ title: 'Not Found' }, 404)
        return
      }
      if (method === 'DELETE') {
        xSources.delete(sourcePath[2])
        send({})
        return
      }
      send({ source: { ...source, is_stream_active: controls.xSourceActive } })
      return
    }
    if (schedulePath && !schedulePath[1]) {
      if (method === 'POST') {
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
        send({ title: 'Not Found' }, 404)
        return
      }
      if (schedulePath[2]) {
        if (!schedule.manual_publish) {
          send({ title: 'manual publish required' }, 400)
          return
        }
        if (!controls.xSourceActive) {
          send({ title: 'source is not receiving video' }, 400)
          return
        }
        schedule.state = 'Running'
        send({ data: schedule })
        return
      }
      if (method === 'PUT') {
        if (!body?.scheduled_end_ms || !body?.scheduled_broadcast_id) {
          send({ title: 'scheduled_end_ms and scheduled_broadcast_id are required' }, 400)
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
    if (statePath) {
      const schedule = xSchedules.get(statePath[2])
      if (schedule && body?.state === 'END') schedule.state = 'Ended'
      send({ broadcast: { id: statePath[2], state: body?.state === 'END' ? 'ENDED' : 'RUNNING' } })
      return
    }
    if (broadcastPath && method === 'GET') {
      const schedule = xSchedules.get(broadcastPath[1])
      if (!schedule) {
        send({ title: 'Not Found' }, 404)
        return
      }
      send({
        broadcast: {
          id: broadcastPath[1],
          media_key: `28_${broadcastPath[1]}`,
          state: schedule.state === 'Running' ? 'RUNNING' : 'NOT_STARTED',
          total_watching: '3'
        },
        share_url: `https://x.com/i/broadcasts/${broadcastPath[1]}`
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
