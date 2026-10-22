import { ENGINE_CONNECTION_CLOSED, ENGINE_NOT_CONNECTED, ENGINE_UNREACHABLE } from '@/backendClient'
import type { WsStatus } from '@/lib/capture'

// Backend transport error classification (plan 024 S1).
//
// A first-ever camera/mic grant intentionally restarts the capture backend
// (media-access.ts), so the WebSocket drops for ~1s: closed → connecting →
// connected. Every auto-firing renderer request that lands in that window
// rejects with one of the transient strings BackendClient mints, and each used
// to paint its own unkeyed red toast — a stack of "Backend WebSocket is not
// connected." for a state the Session badge already narrates. These pure
// helpers decide when a transport error is that expected-transient noise vs a
// real failure worth a toast.

/** The exact strings `BackendClient` mints for a down/absent transport. */
const TRANSIENT_BACKEND_ERRORS = new Set([
  ENGINE_NOT_CONNECTED,
  ENGINE_CONNECTION_CLOSED,
  ENGINE_UNREACHABLE
])

export function isTransientBackendError(message: string): boolean {
  return TRANSIENT_BACKEND_ERRORS.has(message.trim())
}

/**
 * Whether an error message should surface a toast at all.
 *
 * A transient transport error while the socket is NOT connected is suppressed
 * outright — the "Connecting…" / "Videorc is reconnecting…" badge covers that window, so
 * a red card is redundant noise (and stacks). Everything else toasts: genuine
 * RPC errors at any status, and a transient error during a CONNECTED-state blip
 * (surfaced once via a keyed id by the caller).
 */
export function shouldToastBackendError(message: string, wsStatus: WsStatus): boolean {
  if (isTransientBackendError(message) && wsStatus !== 'connected') {
    return false
  }
  return true
}
