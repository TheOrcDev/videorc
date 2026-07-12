import { ACCOUNT_SIGN_IN_CALLBACK_TTL_MS } from '../../../shared/oauth-callback-policy'

const FAST_RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000, 10_000] as const
const COOLDOWN_RETRY_MS = 10_000
const FAST_RETRY_TOTAL_MS = FAST_RETRY_DELAYS_MS.reduce((total, delay) => total + delay, 0)
const MAX_RETRY_COUNT =
  FAST_RETRY_DELAYS_MS.length +
  Math.ceil((ACCOUNT_SIGN_IN_CALLBACK_TTL_MS - FAST_RETRY_TOTAL_MS) / COOLDOWN_RETRY_MS)

export function accountCallbackRetryDelayMs(
  receivedAtMs: number,
  expiresAtMs: number,
  retriesScheduled: number,
  nowMs: number
): number | null {
  const authoritativeDeadlineMs = Math.min(
    expiresAtMs,
    receivedAtMs + ACCOUNT_SIGN_IN_CALLBACK_TTL_MS
  )
  if (
    !Number.isSafeInteger(authoritativeDeadlineMs) ||
    authoritativeDeadlineMs <= receivedAtMs ||
    retriesScheduled >= MAX_RETRY_COUNT ||
    nowMs >= authoritativeDeadlineMs
  ) {
    return null
  }
  const delayMs = FAST_RETRY_DELAYS_MS[retriesScheduled] ?? COOLDOWN_RETRY_MS
  return Math.min(delayMs, authoritativeDeadlineMs - nowMs)
}

export const ACCOUNT_CALLBACK_RETRY_POLICY = Object.freeze({
  fastRetryDelaysMs: FAST_RETRY_DELAYS_MS,
  maxRetryCount: MAX_RETRY_COUNT,
  retryDeadlineMs: ACCOUNT_SIGN_IN_CALLBACK_TTL_MS,
  cooldownRetryMs: COOLDOWN_RETRY_MS
})
