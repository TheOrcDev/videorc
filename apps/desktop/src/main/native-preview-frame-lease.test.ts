import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'
import {
  NativePreviewFrameLeaseClient,
  NativePreviewFrameLeaseError
} from './native-preview-frame-lease'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function fixture(
  options: { wrongRun?: boolean; ignoreAcquire?: boolean; rejectRelease?: boolean } = {}
) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((resolve) => server.once('listening', resolve))
  cleanups.push(async () => {
    for (const socket of server.clients) socket.terminate()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  const address = server.address()
  if (typeof address === 'string' || !address) throw new Error('Missing test server address')
  const ownership = { held: false, releases: 0, disconnected: false }
  let observedAcquire!: () => void
  const acquired = new Promise<void>((resolve) => {
    observedAcquire = resolve
  })
  let observedDisconnect!: () => void
  const disconnected = new Promise<void>((resolve) => {
    observedDisconnect = resolve
  })
  server.on('connection', (socket) => {
    socket.on('close', () => {
      ownership.held = false
      ownership.disconnected = true
      observedDisconnect()
    })
    socket.on('message', (raw) => {
      const request = JSON.parse(raw.toString())
      if (request.method === 'events.setIncluded') return
      if (request.method === 'preview.surface.frame.acquire') {
        ownership.held = true
        observedAcquire()
        if (options.ignoreAcquire) return
        socket.send(
          JSON.stringify({
            id: request.id,
            ok: true,
            payload: {
              targetFps: 60,
              width: 64,
              height: 36,
              runId: options.wrongRun ? 'retired' : 'run',
              sceneRevision: 7,
              frameSceneRevision: 7,
              framesRendered: 42,
              frameAgeMs: 0,
              metalTargetIosurfaceId: 9,
              metalTargetWidth: 64,
              metalTargetHeight: 36,
              updatedAt: new Date().toISOString()
            }
          })
        )
      } else if (request.method === 'preview.surface.frame.release') {
        ownership.held = options.rejectRelease === true
        ownership.releases += 1
        socket.send(JSON.stringify({ id: request.id, ok: true, payload: !options.rejectRelease }))
      }
    })
  })
  const client = new NativePreviewFrameLeaseClient(
    () => ({ host: '127.0.0.1', port: address.port, token: 'test-only' }),
    undefined,
    500
  )
  return { client, ownership, acquired, disconnected }
}

describe('native preview frame lease', () => {
  it('holds the surface through async presentation and admits no second acquire', async () => {
    const { client, ownership, acquired } = await fixture()
    let finish!: () => void
    const presenting = new Promise<void>((resolve) => {
      finish = resolve
    })
    let entered!: () => void
    const enteredPresent = new Promise<void>((resolve) => {
      entered = resolve
    })
    const result = client.withFrame({ runId: 'run', sceneRevision: 7 }, async () => {
      entered()
      await presenting
      expect(ownership.held).toBe(true)
      return 'presented'
    })
    await acquired
    await enteredPresent
    expect(
      await client.withFrame({ runId: 'run', sceneRevision: 7 }, async () => 'wrong')
    ).toBeNull()
    expect(ownership.held).toBe(true)
    finish()
    expect((await result)?.result).toBe('presented')
    expect(ownership).toMatchObject({ held: false, releases: 1 })
  })

  it('releases when presentation fails', async () => {
    const { client, ownership } = await fixture()
    const failure = new Error('present failed')
    await expect(
      client.withFrame({ runId: 'run', sceneRevision: 7 }, async () => {
        throw failure
      })
    ).rejects.toBe(failure)
    expect(ownership).toMatchObject({ held: false, releases: 1 })
  })

  it('rejects a stale run and releases it without importing', async () => {
    const { client, ownership } = await fixture({ wrongRun: true })
    await expect(
      client.withFrame({ runId: 'run', sceneRevision: 7 }, async () => {
        throw new Error('must not import')
      })
    ).rejects.toMatchObject({
      name: 'NativePreviewFrameLeaseError',
      message: 'Preview frame lease returned a different run or scene.'
    })
    expect(ownership).toMatchObject({ held: false, releases: 1 })
  })

  it('closes a timed-out acquire so an unobserved lease cannot leak', async () => {
    const options = { ignoreAcquire: true }
    const { client, ownership, disconnected } = await fixture(options)
    await expect(
      client.withFrame({ runId: 'run', sceneRevision: 7 }, async () => null)
    ).rejects.toMatchObject({
      name: 'NativePreviewFrameLeaseError',
      message: 'Preview frame lease request timed out.'
    })
    await disconnected
    expect(ownership).toMatchObject({ held: false, disconnected: true })
    options.ignoreAcquire = false
    expect(
      (await client.withFrame({ runId: 'run', sceneRevision: 7 }, async () => 'presented'))?.result
    ).toBe('presented')
    expect(ownership).toMatchObject({ held: false, releases: 1 })
  })

  it('closes the connection when release is not acknowledged', async () => {
    const { client, ownership, disconnected } = await fixture({ rejectRelease: true })
    await expect(
      client.withFrame({ runId: 'run', sceneRevision: 7 }, async () => null)
    ).rejects.toBeInstanceOf(NativePreviewFrameLeaseError)
    await disconnected
    expect(ownership).toMatchObject({ held: false, disconnected: true })
  })

  it('preserves a presenter failure when releasing its frame also fails', async () => {
    const { client, ownership, disconnected } = await fixture({ rejectRelease: true })
    const failure = new Error('native presenter failed')
    await expect(
      client.withFrame({ runId: 'run', sceneRevision: 7 }, async () => {
        throw failure
      })
    ).rejects.toBe(failure)
    await disconnected
    expect(ownership).toMatchObject({ held: false, releases: 1, disconnected: true })
  })

  it('classifies an unavailable admin connection as a lease failure', async () => {
    const client = new NativePreviewFrameLeaseClient(() => null)
    await expect(
      client.withFrame({ runId: 'run', sceneRevision: 7 }, async () => {
        throw new Error('must not present')
      })
    ).rejects.toBeInstanceOf(NativePreviewFrameLeaseError)
  })
})
