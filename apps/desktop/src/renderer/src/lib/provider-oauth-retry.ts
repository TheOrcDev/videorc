import { PROVIDER_OAUTH_CALLBACK_TTL_MS } from '../../../shared/oauth-callback-policy'

const FAST_RETRY_COUNT = 6
const RETRY_DEADLINE_MS = PROVIDER_OAUTH_CALLBACK_TTL_MS
const COOLDOWN_RETRY_MS = 20_000
const FAST_RETRY_TOTAL_MS = 500 + 1_000 + 2_000 + 4_000 + 8_000 + 10_000
const MAX_RETRY_COUNT =
  FAST_RETRY_COUNT + Math.ceil((RETRY_DEADLINE_MS - FAST_RETRY_TOTAL_MS) / COOLDOWN_RETRY_MS)

export function providerOAuthRetryDelayMs(
  receivedAtMs: number,
  retriesScheduled: number,
  nowMs: number
): number | null {
  const ageMs = Math.max(0, nowMs - receivedAtMs)
  if (retriesScheduled >= MAX_RETRY_COUNT || ageMs >= RETRY_DEADLINE_MS) {
    return null
  }
  const delayMs =
    retriesScheduled < FAST_RETRY_COUNT
      ? Math.min(10_000, 500 * 2 ** Math.min(retriesScheduled, 5))
      : COOLDOWN_RETRY_MS
  return Math.min(delayMs, RETRY_DEADLINE_MS - ageMs)
}

export const PROVIDER_OAUTH_RETRY_POLICY = Object.freeze({
  fastRetryCount: FAST_RETRY_COUNT,
  maxRetryCount: MAX_RETRY_COUNT,
  retryDeadlineMs: RETRY_DEADLINE_MS,
  cooldownRetryMs: COOLDOWN_RETRY_MS
})
