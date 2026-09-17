import { describe, expect, it } from 'vitest'

import {
  INITIAL_ACCOUNT_READY_REFRESH_STATE,
  reduceAccountReadyRefresh
} from './account-ready-refresh'

describe('account refresh on app ready', () => {
  it('refreshes once per backend connection while signed in', () => {
    const client = {}
    const first = reduceAccountReadyRefresh(INITIAL_ACCOUNT_READY_REFRESH_STATE, {
      type: 'connected',
      client,
      signedIn: true
    })
    expect(first.refresh).toBe(true)

    // The refreshed snapshot re-runs the effect for the same connection: no loop.
    const again = reduceAccountReadyRefresh(first.state, {
      type: 'connected',
      client,
      signedIn: true
    })
    expect(again.refresh).toBe(false)
    expect(again.state).toBe(first.state)
  })

  it('does not refresh a signed-out snapshot, but does once sign-in lands', () => {
    const client = {}
    const signedOut = reduceAccountReadyRefresh(INITIAL_ACCOUNT_READY_REFRESH_STATE, {
      type: 'connected',
      client,
      signedIn: false
    })
    expect(signedOut.refresh).toBe(false)
    expect(signedOut.state).toBe(INITIAL_ACCOUNT_READY_REFRESH_STATE)

    const signedIn = reduceAccountReadyRefresh(signedOut.state, {
      type: 'connected',
      client,
      signedIn: true
    })
    expect(signedIn.refresh).toBe(true)
  })

  it('refreshes again on a new connection, and after an explicit disconnect', () => {
    const firstClient = {}
    const secondClient = {}
    const first = reduceAccountReadyRefresh(INITIAL_ACCOUNT_READY_REFRESH_STATE, {
      type: 'connected',
      client: firstClient,
      signedIn: true
    })
    const reconnect = reduceAccountReadyRefresh(first.state, {
      type: 'connected',
      client: secondClient,
      signedIn: true
    })
    expect(reconnect.refresh).toBe(true)

    const disconnected = reduceAccountReadyRefresh(reconnect.state, { type: 'disconnected' })
    expect(disconnected.refresh).toBe(false)
    expect(disconnected.state).toBe(INITIAL_ACCOUNT_READY_REFRESH_STATE)
    expect(
      reduceAccountReadyRefresh(disconnected.state, {
        type: 'connected',
        client: secondClient,
        signedIn: true
      }).refresh
    ).toBe(true)
  })

  it('keeps the idle state identity stable across no-op disconnects', () => {
    const idle = reduceAccountReadyRefresh(INITIAL_ACCOUNT_READY_REFRESH_STATE, {
      type: 'disconnected'
    })
    expect(idle.state).toBe(INITIAL_ACCOUNT_READY_REFRESH_STATE)
  })
})
