// Injected only by the first-run smoke. Keep this function self-contained so
// each new renderer document installs the same observer before app scripts.
export function installFirstRunSourceTrace(window) {
  const prototype = window.WebSocket.prototype
  if (prototype.__firstRunSourceTraceInstalled) return
  const send = prototype.send
  const methods = new Set([
    'preview.camera.start',
    'preview.screen.start',
    'preview.live.start',
    'session.start',
    'scene.load_from_capture_config',
    'scene.layout.apply_preview',
    'scene.layout.apply_live',
    'scene.source.device.switch'
  ])
  prototype.send = function (...args) {
    // Never retain the payload, socket URL, credentials or source identifiers.
    // A failed observer must not alter whether the real send succeeds/throws.
    try {
      const message = typeof args[0] === 'string' ? JSON.parse(args[0]) : null
      if (methods.has(message?.method)) {
        window.__firstRunSourceRequest?.(
          JSON.stringify({
            documentId: window.__firstRunSmoke.documentId,
            at: window.performance.timeOrigin + window.performance.now(),
            method: message.method,
            setup:
              window.document.querySelector('[data-first-run-setup]')?.dataset.firstRunSetup ?? null
          })
        )
      }
    } catch {
      // Diagnostic only. Backend admission and preview-state assertions remain
      // the authority; missing trace evidence cannot turn their failure green.
    }
    return send.apply(this, args)
  }
  prototype.__firstRunSourceTraceInstalled = true
}

export const FIRST_RUN_SOURCE_TRACE_SCRIPT = `(${installFirstRunSourceTrace.toString()})(window);`
