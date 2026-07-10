import { describe, expect, it } from 'vitest'

import {
  loadValidatedPlatformAccountBootstrap,
  loadValidatedPlatformAccountsOnIsolatedClient,
  StudioBootstrapGuard
} from './studio-bootstrap'

describe('StudioBootstrapGuard', () => {
  it('prevents a delayed snapshot from overwriting a newer live event in the same domain', () => {
    const guard = new StudioBootstrapGuard()
    const snapshot = guard.snapshot()

    guard.mark('recording')

    expect(guard.isCurrent(snapshot, 'recording')).toBe(false)
    expect(guard.isCurrent(snapshot, 'devices')).toBe(true)
  })
})

describe('loadValidatedPlatformAccountBootstrap', () => {
  it('validates before fetching the account rows that bootstrap commits', async () => {
    const calls: string[] = []
    let status = 'connected'
    const request = async <TPayload>(method: string): Promise<TPayload> => {
      calls.push(method)
      if (method === 'platformAccounts.validate') {
        status = 'needs-reconnect'
        return [{ accountId: 'account-1', status }] as TPayload
      }
      if (method === 'platformAccounts.list') {
        return [{ id: 'account-1', status }] as TPayload
      }
      return [] as TPayload
    }

    const result = await loadValidatedPlatformAccountBootstrap<
      { id: string; status: string },
      { accountId: string; status: string },
      never
    >(request)

    expect(calls[0]).toBe('platformAccounts.validate')
    expect(result.accounts).toEqual([{ id: 'account-1', status: 'needs-reconnect' }])
    expect(result.validations).toEqual([{ accountId: 'account-1', status: 'needs-reconnect' }])
  })

  it('keeps deferred provider validation on a disposable command-only client', async () => {
    let releaseValidation!: () => void
    const validationMayFinish = new Promise<void>((resolve) => {
      releaseValidation = resolve
    })
    const calls: string[] = []
    let closed = false
    const client = {
      connect: async () => undefined,
      request: async <TPayload>(method: string): Promise<TPayload> => {
        calls.push(method)
        if (method === 'platformAccounts.validate') {
          await validationMayFinish
        }
        return [] as TPayload
      },
      close: () => {
        closed = true
      }
    }

    const optionalLoad = loadValidatedPlatformAccountsOnIsolatedClient(client)
    await Promise.resolve()
    await Promise.resolve()

    expect(await Promise.resolve('devices-ready')).toBe('devices-ready')
    expect(calls).toEqual(['events.setIncluded', 'platformAccounts.validate'])
    expect(closed).toBe(false)

    releaseValidation()
    await optionalLoad
    expect(closed).toBe(true)
  })
})
