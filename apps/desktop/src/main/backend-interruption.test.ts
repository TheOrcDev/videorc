import { describe, expect, it, vi } from 'vitest'

import type { BackendConnection } from '../shared/backend'
import {
  acquireBackendInterruptionLease,
  type BackendInterruptionHttpResponse,
  type BackendInterruptionTransport
} from './backend-interruption'

const connection: BackendConnection = {
  host: '127.0.0.1',
  port: 43123,
  token: 'secret-token',
  pid: 123,
  parentPid: 12
}
const options = {
  ownerId: 'owner-123',
  action: 'permission-restart' as const,
  reason: 'permission granted'
}
const grant = (consumed = false): BackendInterruptionHttpResponse => ({
  statusCode: 201,
  body: JSON.stringify({
    leaseId: 'lease-123',
    expiresInMs: consumed ? 30_000 : 5_000,
    consumed
  })
})

describe('backend interruption lease transport', () => {
  it('recovers the same idempotent acquire after the committed response is lost', async () => {
    const transport = vi
      .fn<BackendInterruptionTransport>()
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce(grant())

    const lease = await acquireBackendInterruptionLease(connection, options, transport)
    expect(lease?.id).toBe('lease-123')
    expect(transport).toHaveBeenCalledTimes(2)
    expect(transport.mock.calls[0]).toEqual(transport.mock.calls[1])
    expect(transport).toHaveBeenCalledWith(
      connection,
      'POST',
      '/interruption/lease?token=secret-token&ownerId=owner-123&action=permission-restart&reason=permission+granted'
    )
  })

  it('consumes, renews, and releases the exact lease', async () => {
    const transport = vi
      .fn<BackendInterruptionTransport>()
      .mockResolvedValueOnce(grant())
      .mockResolvedValueOnce({ ...grant(true), statusCode: 200 })
      .mockResolvedValueOnce({ ...grant(true), statusCode: 200 })
      .mockResolvedValueOnce({ statusCode: 204, body: '' })

    const lease = await acquireBackendInterruptionLease(connection, options, transport)
    await lease?.consume()
    expect(lease?.consumed).toBe(true)
    expect(lease?.expiresInMs).toBe(30_000)
    await lease?.renew()
    await lease?.release()

    expect(transport).toHaveBeenNthCalledWith(
      2,
      connection,
      'POST',
      '/interruption/lease/lease-123/consume?token=secret-token'
    )
    expect(transport).toHaveBeenNthCalledWith(
      3,
      connection,
      'PUT',
      '/interruption/lease/lease-123?token=secret-token'
    )
    expect(transport).toHaveBeenNthCalledWith(
      4,
      connection,
      'DELETE',
      '/interruption/lease/lease-123?token=secret-token'
    )
  })

  it('retries an idempotent release when the first response is lost', async () => {
    const transport = vi
      .fn<BackendInterruptionTransport>()
      .mockResolvedValueOnce(grant())
      .mockRejectedValueOnce(new Error('release response lost'))
      .mockResolvedValueOnce({ statusCode: 204, body: '' })
    const lease = await acquireBackendInterruptionLease(connection, options, transport)

    await lease?.release()
    expect(transport).toHaveBeenCalledTimes(3)
    expect(transport.mock.calls[1]).toEqual(transport.mock.calls[2])
  })

  it('returns a blocked result when session startup or capture wins', async () => {
    const transport = vi
      .fn<BackendInterruptionTransport>()
      .mockResolvedValue({ statusCode: 409, body: '{"code":"capture-not-idle"}' })

    await expect(
      acquireBackendInterruptionLease(connection, options, transport)
    ).resolves.toBeNull()
    expect(transport).toHaveBeenCalledOnce()
  })

  it.each([
    { statusCode: 201, body: '{}' },
    {
      statusCode: 201,
      body: '{"leaseId":"bad/id","expiresInMs":5000,"consumed":false}'
    },
    { statusCode: 500, body: '' }
  ])('fails closed after bounded retries on an invalid response: %o', async (response) => {
    const transport = vi.fn<BackendInterruptionTransport>().mockResolvedValue(response)

    await expect(acquireBackendInterruptionLease(connection, options, transport)).rejects.toThrow()
    expect(transport).toHaveBeenCalledTimes(2)
  })
})
