import { describe, expect, it } from 'vitest'

import { PROVIDER_OAUTH_RETRY_POLICY, providerOAuthRetryDelayMs } from './provider-oauth-retry'

describe('provider OAuth retry policy', () => {
  it('continues with bounded cooldown retries while the websocket can remain healthy', () => {
    const receivedAtMs = 1_000
    expect(providerOAuthRetryDelayMs(receivedAtMs, 0, receivedAtMs)).toBe(500)
    expect(
      providerOAuthRetryDelayMs(
        receivedAtMs,
        PROVIDER_OAUTH_RETRY_POLICY.fastRetryCount,
        receivedAtMs + 30_000
      )
    ).toBe(PROVIDER_OAUTH_RETRY_POLICY.cooldownRetryMs)
  })

  it('keeps scheduling through the full durable-envelope deadline', () => {
    const receivedAtMs = 10_000
    let nowMs = receivedAtMs
    for (let attempt = 0; attempt < PROVIDER_OAUTH_RETRY_POLICY.maxRetryCount; attempt += 1) {
      const delayMs = providerOAuthRetryDelayMs(receivedAtMs, attempt, nowMs)
      expect(delayMs).not.toBeNull()
      nowMs += delayMs!
    }
    expect(nowMs).toBe(receivedAtMs + PROVIDER_OAUTH_RETRY_POLICY.retryDeadlineMs)
    expect(
      providerOAuthRetryDelayMs(receivedAtMs, PROVIDER_OAUTH_RETRY_POLICY.maxRetryCount, nowMs)
    ).toBeNull()
    expect(
      providerOAuthRetryDelayMs(
        receivedAtMs,
        1,
        receivedAtMs + PROVIDER_OAUTH_RETRY_POLICY.retryDeadlineMs
      )
    ).toBeNull()
  })
})
