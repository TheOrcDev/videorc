/** One timeout envelope shared by the detached Comments window and Studio. */
export const COMMENTS_SEND_TIMING_CONTRACT = Object.freeze({
  backendRequestMs: 12_000,
  reconciliationMs: 2_000,
  rendererIpcMarginMs: 6_000
})

export const COMMENTS_COMMAND_RELAY_TIMEOUT_MS = Object.values(
  COMMENTS_SEND_TIMING_CONTRACT
).reduce((total, durationMs) => total + durationMs, 0)

/** Highlight work starts before the backend request: a bounded avatar fetch
 * and PNG rasterization precede the live-control queue and execution windows.
 * Keep this separate from chat-send timing so either contract can change
 * without making the other command report a false outer IPC timeout. */
export const COMMENTS_HIGHLIGHT_TIMING_CONTRACT = Object.freeze({
  avatarFetchMs: 4_000,
  backendQueueMaxAgeMs: 5_000,
  backendExecutionMaxMs: 10_000,
  reconciliationMs: 2_000,
  rendererIpcMarginMs: 6_000
})

export const COMMENTS_HIGHLIGHT_RELAY_TIMEOUT_MS = Object.values(
  COMMENTS_HIGHLIGHT_TIMING_CONTRACT
).reduce((total, durationMs) => total + durationMs, 0)
