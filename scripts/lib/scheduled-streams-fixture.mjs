import { createServer } from 'node:http'

// Loopback-only provider fixture. Never accepts a production channel or token.
export async function startScheduledStreamsFixture({
  ingestUrl = 'rtmp://127.0.0.1:12945/live'
} = {}) {
  const events = new Map()
  const streams = new Map()
  const calls = []
  const controls = {
    failThumbnail: false,
    loseCreateResponse: false,
    rejectCreate: false,
    loseStreamResponse: false
  }
  let eventCounter = 0
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== 'Bearer local-fixture-only') {
      response.writeHead(401).end('{}')
      return
    }
    const url = new URL(request.url, 'http://127.0.0.1')
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
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    events,
    streams,
    calls,
    controls,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(resolve)
      })
  }
}
