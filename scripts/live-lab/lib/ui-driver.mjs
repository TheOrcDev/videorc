// Plan 178 U6 (plan 176 L2 step 2). Drives the real Go Live dialog over CDP
// (VIDEORC_REMOTE_DEBUG_PORT, apps/desktop/src/main/index.ts). Packaged
// builds honour it only as a packaged test build (VIDEORC_PACKAGED_TEST_HOOKS=1
// at build time, apps/desktop/src/main/packaged-test-hooks.ts).
//
// The page side is one helper (pageHelper below) installed on every document
// with Page.addScriptToEvaluateOnNewDocument. It reads the dialog through its
// stable hooks: data-testid go-live-dialog (data-pending, data-phase),
// go-live-details (#go-live-title, #go-live-description, #go-live-privacy
// radios), go-live-destination rows (data-target-id, data-ready),
// go-live-destination-exclude, go-live-excluded + go-live-include,
// go-live-blockers, go-live-partial-setup, go-live-continue-partial,
// go-live-captions-skip, go-live-confirm and go-live-cancel. A
// MutationObserver pushes a snapshot through the CDP binding
// __videorcLabEmit on every change, so the harness waits on events, never on
// a timer.

export const BINDING = '__videorcLabEmit'
const CDP_TIMEOUT_MS = 15_000

/** Minimal CDP client over a WebSocket (Node's global WebSocket). */
export class CdpClient {
  constructor(socket) {
    this.socket = socket
    this.serial = 0
    this.pending = new Map()
    this.listeners = new Set()
    socket.addEventListener('message', ({ data }) => {
      let message
      try {
        message = JSON.parse(data)
      } catch {
        return
      }
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        clearTimeout(pending.timer)
        if (message.error)
          pending.reject(new Error(`CDP ${pending.method}: ${message.error.message}`))
        else pending.resolve(message.result)
        return
      }
      for (const listener of this.listeners) listener(message.method, message.params)
    })
    socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer)
        pending.reject(new Error(`CDP ${pending.method}: connection closed`))
      }
      this.pending.clear()
    })
  }

  static connect(url, { WebSocketImpl = globalThis.WebSocket, timeoutMs = CDP_TIMEOUT_MS } = {}) {
    return new Promise((resolveConnect, rejectConnect) => {
      const socket = new WebSocketImpl(url)
      const timer = setTimeout(() => {
        socket.close?.()
        rejectConnect(new Error('CDP connection timed out'))
      }, timeoutMs)
      socket.addEventListener(
        'open',
        () => {
          clearTimeout(timer)
          resolveConnect(new CdpClient(socket))
        },
        { once: true }
      )
      socket.addEventListener(
        'error',
        () => {
          clearTimeout(timer)
          rejectConnect(new Error('CDP connection failed'))
        },
        { once: true }
      )
    })
  }

  send(method, params = {}) {
    const id = ++this.serial
    return new Promise((resolveSend, rejectSend) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        rejectSend(new Error(`CDP ${method} timed out`))
      }, CDP_TIMEOUT_MS)
      this.pending.set(id, { resolve: resolveSend, reject: rejectSend, timer, method })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  on(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    })
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
      )
    }
    return result.result?.value
  }

  close() {
    for (const pending of this.pending.values()) clearTimeout(pending.timer)
    this.pending.clear()
    this.socket.close()
  }
}

/** The main Studio renderer among CDP targets: a page loading index.html (packaged) or the dev server root. */
export function pickMainTarget(targets) {
  const pages = (targets ?? []).filter(
    (target) => target?.type === 'page' && target.webSocketDebuggerUrl
  )
  return (
    pages.find((target) =>
      /^file:\/\/.*\/renderer\/index\.html(?:[?#].*)?$/.test(target.url ?? '')
    ) ??
    pages.find((target) =>
      /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/(?:index\.html)?(?:[?#].*)?$/.test(
        target.url ?? ''
      )
    ) ??
    null
  )
}

export function httpBaseFromDevtools(devtoolsUrl) {
  const url = new URL(devtoolsUrl)
  return `http://${url.host}`
}

// ---------------------------------------------------------------------------
// Page helper (runs inside the renderer; self-contained)
// ---------------------------------------------------------------------------

/* eslint-disable no-undef */
export function pageHelper(bindingName) {
  if (window.__videorcLab) return 'present'
  const q = (selector, root = document) => root.querySelector(selector)
  const qa = (selector, root = document) => Array.from(root.querySelectorAll(selector))
  const text = (element) => (element?.textContent ?? '').replace(/\s+/g, ' ').trim()
  const dialogEl = () => q('[data-testid="go-live-dialog"]')

  function dialogState() {
    const dialog = dialogEl()
    if (!dialog) return { open: false }
    const confirm = q('[data-testid="go-live-confirm"]', dialog)
    const partial = q('[data-testid="go-live-continue-partial"]', dialog)
    const title = q('#go-live-title', dialog)
    const description = q('#go-live-description', dialog)
    const checked = qa('#go-live-privacy [role="radio"]', dialog).find(
      (radio) => radio.getAttribute('aria-checked') === 'true'
    )
    return {
      open: true,
      pending: dialog.getAttribute('data-pending') === 'true',
      phase: dialog.getAttribute('data-phase') || null,
      details: Boolean(q('[data-testid="go-live-details"]', dialog)),
      title: title ? title.value : null,
      description: description ? description.value : null,
      privacy: checked ? text(checked).toLowerCase() : null,
      destinations: qa('[data-testid="go-live-destination"]', dialog).map((row) => ({
        targetId: row.getAttribute('data-target-id'),
        ready: row.getAttribute('data-ready') === 'true',
        canExclude: Boolean(q('[data-testid="go-live-destination-exclude"]', row))
      })),
      excluded: qa('[data-testid="go-live-excluded"]', dialog).map((row) =>
        row.getAttribute('data-target-id')
      ),
      blockers: qa('[data-testid="go-live-blockers"] li', dialog).map(text).slice(0, 10),
      partialSetup: Boolean(q('[data-testid="go-live-partial-setup"]', dialog)),
      captionsBlocked: Boolean(q('[data-testid="go-live-captions-skip"]', dialog)),
      confirm: confirm ? { disabled: confirm.disabled, label: text(confirm).slice(0, 80) } : null,
      continuePartial: partial ? { disabled: partial.disabled } : null
    }
  }

  function toasts() {
    return qa('[data-sonner-toast]')
      .map((toast) => ({
        type: toast.getAttribute('data-type') || null,
        text: text(toast).slice(0, 300)
      }))
      .slice(-5)
  }

  function setValue(element, value) {
    const proto =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  }

  function click(element) {
    if (!element || element.disabled) return false
    element.click()
    return true
  }

  const api = {
    dialogState,
    toasts,
    snapshot: () => ({ dialog: dialogState(), toasts: toasts() }),
    fill({ title, description, privacy }) {
      const dialog = dialogEl()
      if (!dialog) return { ok: false, reason: 'dialog not open' }
      if (title !== undefined) {
        const input = q('#go-live-title', dialog)
        if (!input) return { ok: false, reason: 'no title field' }
        setValue(input, title)
      }
      if (description !== undefined) {
        const input = q('#go-live-description', dialog)
        if (!input) return { ok: false, reason: 'no description field' }
        setValue(input, description)
      }
      if (privacy !== undefined) {
        const radio = qa('#go-live-privacy [role="radio"]', dialog).find(
          (element) => text(element).toLowerCase() === privacy
        )
        if (!radio) return { ok: false, reason: `no privacy option ${privacy}` }
        if (radio.getAttribute('aria-checked') !== 'true') click(radio)
      }
      return { ok: true }
    },
    exclude(targetId) {
      const row = qa('[data-testid="go-live-destination"]').find(
        (element) => element.getAttribute('data-target-id') === targetId
      )
      return click(row && q('[data-testid="go-live-destination-exclude"]', row))
    },
    include(targetId) {
      const row = qa('[data-testid="go-live-excluded"]').find(
        (element) => element.getAttribute('data-target-id') === targetId
      )
      return click(row && q('[data-testid="go-live-include"]', row))
    },
    confirm: () => click(q('[data-testid="go-live-confirm"]')),
    continuePartial: () => click(q('[data-testid="go-live-continue-partial"]')),
    skipCaptions: () => click(q('[data-testid="go-live-captions-skip"]')),
    cancel: () => click(q('[data-testid="go-live-cancel"]')),
    // Launch-time dialogs (what's new, permissions) cover the Studio; Escape
    // closes a Radix dialog without choosing anything.
    dismissOtherDialogs() {
      let closed = 0
      for (const overlay of qa('[data-slot="dialog-overlay"][data-state="open"]')) {
        if (dialogEl()) break
        overlay.ownerDocument.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
        )
        closed += 1
      }
      return closed
    }
  }
  window.__videorcLab = api
  let timer = null
  const emit = () => {
    timer = null
    try {
      window[bindingName]?.(JSON.stringify(api.snapshot()))
    } catch {
      // The binding is gone during a reload.
    }
  }
  const start = () => {
    new MutationObserver(() => {
      if (timer === null) timer = setTimeout(emit, 50)
    }).observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true
    })
    emit()
  }
  if (document.documentElement) start()
  else document.addEventListener('readystatechange', start, { once: true })
  return 'installed'
}
/* eslint-enable no-undef */

export function pageHelperSource(bindingName = BINDING) {
  return `(${pageHelper.toString()})(${JSON.stringify(bindingName)})`
}

// ---------------------------------------------------------------------------
// Harness side
// ---------------------------------------------------------------------------

export function isLiveState(state) {
  return Boolean(state?.sessionActive) && ['streaming', 'recording'].includes(state?.sessionState)
}

/**
 * Classifies the Go Live outcome from the latest dialog snapshot and remote
 * state (pure). Returns null while it is still undecided.
 */
export function classifyGoLiveOutcome({ dialog, toasts = [], remoteState, confirmed }) {
  if (isLiveState(remoteState) && !dialog?.open) return { outcome: 'live' }
  if (remoteState?.sessionState === 'failed') {
    return { outcome: 'failed', reason: toasts.at(-1)?.text ?? 'session failed' }
  }
  if (dialog?.open && !dialog.pending) {
    if (dialog.partialSetup)
      return { outcome: 'partial-setup', reason: 'some destinations could not be set up' }
    if (dialog.captionsBlocked) return { outcome: 'blocked', reason: 'captions cannot start' }
    if (dialog.blockers?.length) return { outcome: 'blocked', reason: dialog.blockers.join(' / ') }
  }
  if (confirmed && !dialog?.open && remoteState?.sessionState === 'idle') {
    const error = toasts.find((toast) => toast.type === 'error')
    if (error) return { outcome: 'failed', reason: error.text }
  }
  return null
}

/**
 * The Go Live driver. `cdp` is a CdpClient connected to the main renderer;
 * `bus` receives 'ui' snapshots; `waitFor` is the session-level event wait.
 */
export function createUiDriver({ cdp, bus, waitFor }) {
  let installed = false

  async function install() {
    if (installed) return
    await cdp.send('Runtime.enable')
    await cdp.send('Page.enable')
    cdp.on((method, params) => {
      if (method === 'Runtime.bindingCalled' && params?.name === BINDING) {
        try {
          bus.emit('ui', JSON.parse(params.payload))
        } catch {
          // A malformed snapshot is ignored; the next mutation sends another.
        }
      }
      if (method === 'Page.loadEventFired') bus.emit('ui.load', {})
    })
    await cdp.send('Runtime.addBinding', { name: BINDING })
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: pageHelperSource() })
    await cdp.evaluate(pageHelperSource())
    installed = true
  }

  const call = (expression) => cdp.evaluate(`window.__videorcLab ? (${expression}) : null`)
  const snapshot = async () =>
    (await call('window.__videorcLab.snapshot()')) ?? { dialog: { open: false }, toasts: [] }
  const lastUi = () => bus.last('ui') ?? { dialog: { open: false }, toasts: [] }

  async function waitForDialog(predicate, { deadlineMs, label }) {
    const current = await snapshot()
    bus.emit('ui', current)
    return waitFor(
      () => {
        const ui = lastUi()
        return predicate(ui.dialog, ui) ? ui.dialog : null
      },
      { deadlineMs, label }
    )
  }

  return {
    install,
    evaluate: (expression) => cdp.evaluate(expression),
    snapshot,

    /** Reloads the renderer and resolves when the new document has the helper. */
    async reload({ deadlineMs = 60_000 } = {}) {
      const loaded = waitFor((type) => type === 'ui.load', { deadlineMs, label: 'renderer reload' })
      await cdp.send('Page.reload', { ignoreCache: true })
      await loaded
      return true
    },

    async dismissOtherDialogs() {
      return (await call('window.__videorcLab.dismissOtherDialogs()')) ?? 0
    },

    waitForDialogOpen: ({ deadlineMs = 30_000 } = {}) =>
      waitForDialog((dialog) => dialog?.open && !dialog.pending && dialog.confirm, {
        deadlineMs,
        label: 'Go Live dialog open'
      }),

    /** Fills the stream details. The title must start with the policy prefix. */
    async fillGoLive({ title, description, privacy, titlePrefix, deadlineMs = 15_000 }) {
      if (typeof titlePrefix !== 'string' || !titlePrefix)
        throw new Error('titlePrefix is required')
      if (typeof title !== 'string' || !title.startsWith(titlePrefix)) {
        throw new Error(`The title must start with "${titlePrefix}".`)
      }
      const result = await call(
        `window.__videorcLab.fill(${JSON.stringify({ title, description, privacy })})`
      )
      if (!result?.ok)
        throw new Error(`Could not fill the Go Live details: ${result?.reason ?? 'no helper'}`)
      return waitForDialog(
        (dialog) =>
          dialog?.open &&
          dialog.title === title &&
          (description === undefined || dialog.description === description) &&
          (privacy === undefined || dialog.privacy === privacy),
        { deadlineMs, label: 'Go Live details filled' }
      )
    },

    /**
     * Makes the dialog's destinations exactly `expectedIds`: adds back a
     * left-out expected one, leaves out an unexpected one that can be left
     * out, and refuses to go on when an unexpected destination is ready (the
     * harness never streams anywhere it did not seed).
     */
    async ensureDestinations(expectedIds, { deadlineMs = 15_000 } = {}) {
      const wanted = [...expectedIds].sort()
      const { dialog } = await snapshot()
      if (!dialog?.open) throw new Error('The Go Live dialog is not open.')
      for (const targetId of dialog.excluded ?? []) {
        if (wanted.includes(targetId))
          await call(`window.__videorcLab.include(${JSON.stringify(targetId)})`)
      }
      for (const row of dialog.destinations ?? []) {
        if (wanted.includes(row.targetId)) continue
        if (row.ready || !row.canExclude) {
          throw new Error(
            `Unexpected destination "${row.targetId}" in Go Live; refusing to confirm.`
          )
        }
        await call(`window.__videorcLab.exclude(${JSON.stringify(row.targetId)})`)
      }
      return waitForDialog(
        (state) =>
          state?.open &&
          JSON.stringify((state.destinations ?? []).map((row) => row.targetId).sort()) ===
            JSON.stringify(wanted),
        { deadlineMs, label: `Go Live destinations [${wanted.join(', ')}]` }
      )
    },

    async confirmGoLive() {
      const clicked = await call('window.__videorcLab.confirm()')
      if (!clicked) throw new Error('The Go Live button is missing or disabled.')
      return true
    },

    /** Waits until the Go Live either went live or visibly did not. */
    readGoLiveOutcome({ deadlineMs = 90_000 } = {}) {
      return waitFor(
        () => {
          const ui = lastUi()
          return classifyGoLiveOutcome({
            dialog: ui.dialog,
            toasts: ui.toasts,
            remoteState: bus.last('remote.state'),
            confirmed: true
          })
        },
        { deadlineMs, label: 'Go Live outcome' }
      )
    },

    async cancelGoLive() {
      return Boolean(await call('window.__videorcLab.cancel()'))
    }
  }
}
