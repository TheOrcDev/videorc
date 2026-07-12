import { describe, expect, it } from 'vitest'

import {
  ACCOUNT_CALLBACK_RETRY_POLICY,
  accountCallbackRetryDelayMs
} from './account-callback-retry'

describe('account callback retry policy', () => {
  it('uses fast retries followed by bounded cooldown retries', () => {
    const receivedAtMs = 1_000
    const expiresAtMs = receivedAtMs + ACCOUNT_CALLBACK_RETRY_POLICY.retryDeadlineMs
    expect(accountCallbackRetryDelayMs(receivedAtMs, expiresAtMs, 0, receivedAtMs)).toBe(500)
    expect(
      accountCallbackRetryDelayMs(
        receivedAtMs,
        expiresAtMs,
        ACCOUNT_CALLBACK_RETRY_POLICY.fastRetryDelaysMs.length,
        receivedAtMs + 30_000
      )
    ).toBe(ACCOUNT_CALLBACK_RETRY_POLICY.cooldownRetryMs)
  })

  it('keeps scheduling through the full durable callback TTL', () => {
    const receivedAtMs = 10_000
    const expiresAtMs = receivedAtMs + ACCOUNT_CALLBACK_RETRY_POLICY.retryDeadlineMs
    let nowMs = receivedAtMs
    for (let attempt = 0; attempt < ACCOUNT_CALLBACK_RETRY_POLICY.maxRetryCount; attempt += 1) {
      const delayMs = accountCallbackRetryDelayMs(receivedAtMs, expiresAtMs, attempt, nowMs)
      expect(delayMs).not.toBeNull()
      nowMs += delayMs!
    }
    expect(nowMs).toBe(receivedAtMs + ACCOUNT_CALLBACK_RETRY_POLICY.retryDeadlineMs)
    expect(
      accountCallbackRetryDelayMs(
        receivedAtMs,
        expiresAtMs,
        ACCOUNT_CALLBACK_RETRY_POLICY.maxRetryCount,
        nowMs
      )
    ).toBeNull()
  })

  it('never schedules beyond an earlier server-authenticated code deadline', () => {
    const receivedAtMs = 10_000
    const expiresAtMs = receivedAtMs + 25_000
    let nowMs = receivedAtMs
    let attempt = 0

    while (true) {
      const delayMs = accountCallbackRetryDelayMs(receivedAtMs, expiresAtMs, attempt, nowMs)
      if (delayMs === null) break
      nowMs += delayMs
      attempt += 1
    }

    expect(nowMs).toBe(expiresAtMs)
    expect(accountCallbackRetryDelayMs(receivedAtMs, expiresAtMs, attempt, nowMs)).toBeNull()
  })
})
