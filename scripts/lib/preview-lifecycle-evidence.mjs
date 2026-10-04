import { requestSmokeCommandWithRetry } from './smoke-command-client.mjs'

export const PREVIEW_LIFECYCLE_EVIDENCE_PREFIX = '[smoke] preview-lifecycle-evidence '
const MAX_EVIDENCE_BYTES = 16384
const commands = new Set([
  'preview-window-toggle',
  'preview-window-set-mode',
  'preview-window-state',
  'preview-window-close',
  'preview-window-os-close',
  'dispatch-preview-shortcut',
  'apply-native-preview-host-commands',
  'backend-debug-rpc',
  'preview-window-report-permission-required',
  'preview-lifecycle-attempt-app-quit',
  'preview-lifecycle-allow-app-quit',
  'app-quit'
])
const actions = new Set([
  'initial-close',
  'quit-attempt',
  'quit-check',
  'toggle-open',
  'dock',
  'undock',
  'stale-destroy',
  'permission-required',
  'toggle-close',
  'os-close-open',
  'os-close',
  'shortcut-open',
  'shortcut-close',
  'final-open',
  'final-close'
])
const events = new Set([
  'created',
  'close',
  'closed-before-cleanup',
  'closed-after-cleanup',
  'contents-destroyed',
  'renderer-gone',
  'before-quit-prevented',
  'before-quit-allowed',
  'quit-allowed'
])
const dispositions = new Set([
  'absent',
  'window-destroyed',
  'contents-destroyed',
  'ready',
  'unknown'
])
const rendererGoneReasons = new Set([
  'clean-exit',
  'abnormal-exit',
  'killed',
  'crashed',
  'oom',
  'launch-failed',
  'integrity-failure'
])
const category = (value, allowed, fallback) => (allowed.has(value) ? value : fallback)
const count = (value) => Number.isSafeInteger(value) && value >= 0
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

function mainProjection(value) {
  if (
    !object(value) ||
    !Array.isArray(value.events) ||
    value.events.length > 32 ||
    !count(value.omittedEvents)
  )
    return null
  const projected = []
  for (const event of value.events) {
    if (
      !object(event) ||
      !events.has(event.event) ||
      !count(event.atMs) ||
      !(
        event.callbackOwnerIsCurrent === null || typeof event.callbackOwnerIsCurrent === 'boolean'
      ) ||
      !dispositions.has(event.disposition) ||
      typeof event.quitPrevented !== 'boolean' ||
      typeof event.appIsQuitting !== 'boolean'
    )
      return null
    projected.push({
      event: event.event,
      atMs: event.atMs,
      callbackOwnerIsCurrent: event.callbackOwnerIsCurrent,
      disposition: event.disposition,
      quitPrevented: event.quitPrevented,
      appIsQuitting: event.appIsQuitting,
      ...(event.event === 'renderer-gone'
        ? { rendererGoneReason: category(event.rendererGoneReason, rendererGoneReasons, 'unknown') }
        : {})
    })
  }
  let failedCommand = null
  if (value.failedCommand !== null) {
    const failure = value.failedCommand
    if (
      !object(failure) ||
      !dispositions.has(failure.disposition) ||
      !count(failure.firstAtMs) ||
      !count(failure.lastAtMs) ||
      failure.lastAtMs < failure.firstAtMs ||
      !count(failure.attempts) ||
      failure.attempts < 1
    )
      return null
    failedCommand = {
      command: category(failure.command, commands, 'other-command'),
      disposition: failure.disposition,
      firstAtMs: failure.firstAtMs,
      lastAtMs: failure.lastAtMs,
      attempts: failure.attempts
    }
  }
  return { events: projected, omittedEvents: value.omittedEvents, failedCommand }
}

/**
 * Reduced evidence only: first failed request captures its action before the
 * await, independently of later context/teardown and the main owner ring.
 * The maintained client owns all retry/error decisions. No params, arbitrary
 * errors, readiness capabilities, window identity, or raw payloads are kept.
 */
export function createPreviewLifecycleEvidence({ request = requestSmokeCommandWithRetry } = {}) {
  let context = { cycle: null, action: 'other-action' }
  let failedRequest = null
  let main = null
  return {
    setContext(value) {
      try {
        context = {
          cycle: count(value?.cycle) && value.cycle > 0 ? value.cycle : null,
          action: category(value?.action, actions, 'other-action')
        }
      } catch {
        context = { cycle: null, action: 'other-action' }
      }
    },
    observeLine(line) {
      try {
        if (
          typeof line !== 'string' ||
          !line.startsWith(PREVIEW_LIFECYCLE_EVIDENCE_PREFIX) ||
          line.length > MAX_EVIDENCE_BYTES ||
          Buffer.byteLength(line, 'utf8') > MAX_EVIDENCE_BYTES
        )
          return
        const projected = mainProjection(
          JSON.parse(line.slice(PREVIEW_LIFECYCLE_EVIDENCE_PREFIX.length))
        )
        if (projected) main = projected
      } catch {
        // Malformed/oversized evidence cannot replace the last validated view.
      }
    },
    async request(smoke, command, params = {}, options) {
      const requestContext = { ...context, command: category(command, commands, 'other-command') }
      try {
        return await request(smoke, command, params, options)
      } catch (error) {
        try {
          let errorKind = 'request-failed'
          try {
            if (error?.message === 'Main window is not ready for preview motion smoke.')
              errorKind = 'main-not-ready'
          } catch {
            // An arbitrary rejection getter cannot erase known request context.
          }
          failedRequest ??= {
            ...requestContext,
            errorKind
          }
        } catch {
          // Diagnostic failure must preserve the exact original rejection.
        }
        throw error
      }
    },
    snapshot() {
      return {
        failedRequest: failedRequest ? { ...failedRequest } : null,
        main: main
          ? {
              events: main.events.map((event) => ({ ...event })),
              omittedEvents: main.omittedEvents,
              failedCommand: main.failedCommand ? { ...main.failedCommand } : null
            }
          : null
      }
    }
  }
}
