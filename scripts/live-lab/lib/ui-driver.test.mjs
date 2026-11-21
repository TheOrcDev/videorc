import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { createFakeClock } from './harness-test-fakes.mjs'
import { createEventBus, createWaitFor } from './step-engine.mjs'
import {
  BINDING,
  classifyGoLiveOutcome,
  createUiDriver,
  httpBaseFromDevtools,
  pageHelperSource,
  pickMainTarget,
  privacyConfirmDecision
} from './ui-driver.mjs'

test('the main Studio renderer is picked among CDP targets', () => {
  const targets = [
    {
      type: 'page',
      url: 'file:///Applications/Videorc.app/Contents/Resources/app.asar/out/renderer/notes.html',
      webSocketDebuggerUrl: 'ws://a'
    },
    {
      type: 'service_worker',
      url: 'file:///x/renderer/index.html',
      webSocketDebuggerUrl: 'ws://b'
    },
    {
      type: 'page',
      url: 'file:///Applications/Videorc.app/Contents/Resources/app.asar/out/renderer/index.html',
      webSocketDebuggerUrl: 'ws://main'
    },
    { type: 'page', url: 'data:text/html,preview', webSocketDebuggerUrl: 'ws://c' }
  ]
  assert.equal(pickMainTarget(targets).webSocketDebuggerUrl, 'ws://main')
  assert.equal(
    pickMainTarget([
      { type: 'page', url: 'http://localhost:5173/', webSocketDebuggerUrl: 'ws://dev' }
    ]).webSocketDebuggerUrl,
    'ws://dev'
  )
  assert.equal(pickMainTarget(targets.filter((t) => t.webSocketDebuggerUrl !== 'ws://main')), null)
  assert.equal(
    httpBaseFromDevtools('ws://127.0.0.1:9333/devtools/browser/x'),
    'http://127.0.0.1:9333'
  )
})

test('the page helper source is valid, self-contained JavaScript', () => {
  const source = pageHelperSource()
  assert.doesNotThrow(() => new Function(source))
  assert.ok(source.includes(JSON.stringify(BINDING)))
  for (const hook of [
    'go-live-dialog',
    'go-live-details',
    'go-live-destination',
    'go-live-destination-exclude',
    'go-live-excluded',
    'go-live-include',
    'go-live-confirm',
    'go-live-cancel',
    'go-live-continue-partial',
    'go-live-captions-skip',
    'go-live-blockers',
    'go-live-partial-setup',
    '#go-live-title',
    '#go-live-description',
    '#go-live-privacy'
  ]) {
    assert.ok(source.includes(hook), hook)
  }
})

test('Go Live outcomes: live, blocked, partial setup, failed, undecided', () => {
  const live = { sessionState: 'streaming', sessionActive: true }
  assert.deepEqual(classifyGoLiveOutcome({ dialog: { open: false }, remoteState: live }), {
    outcome: 'live'
  })
  assert.equal(
    classifyGoLiveOutcome({ dialog: { open: true, pending: false }, remoteState: live }),
    null
  )
  assert.deepEqual(
    classifyGoLiveOutcome({
      dialog: { open: true, pending: false, blockers: ['Set up a destination'] },
      remoteState: { sessionState: 'idle' }
    }),
    { outcome: 'blocked', reason: 'Set up a destination' }
  )
  assert.equal(
    classifyGoLiveOutcome({
      dialog: { open: true, pending: true, blockers: ['x'] },
      remoteState: {}
    }),
    null
  )
  assert.equal(
    classifyGoLiveOutcome({ dialog: { open: true, pending: false, partialSetup: true } }).outcome,
    'partial-setup'
  )
  assert.deepEqual(
    classifyGoLiveOutcome({
      dialog: { open: false },
      toasts: [{ type: 'error', text: 'RTMP refused' }],
      remoteState: { sessionState: 'idle' },
      confirmed: true
    }),
    { outcome: 'failed', reason: 'RTMP refused' }
  )
  assert.equal(
    classifyGoLiveOutcome({ dialog: { open: false }, remoteState: { sessionState: 'failed' } })
      .outcome,
    'failed'
  )
  assert.equal(
    classifyGoLiveOutcome({
      dialog: { open: false },
      remoteState: { sessionState: 'starting' },
      confirmed: true
    }),
    null
  )
})

// A fake renderer: the dialog state lives here and every helper call is
// interpreted, then a 'ui' snapshot is emitted through the binding.
function fakePage({
  destinations = [{ targetId: 'youtube', ready: true, canExclude: false }],
  excluded = [],
  privacyStep = null
} = {}) {
  const listeners = new Set()
  const dialog = {
    open: false,
    pending: false,
    details: true,
    title: '',
    description: '',
    privacy: 'private',
    destinations,
    excluded,
    blockers: [],
    partialSetup: false,
    captionsBlocked: false,
    confirm: { disabled: false, label: 'Go live' },
    privacyConfirm: null
  }
  const sent = []
  const calls = []
  const emit = () => {
    for (const listener of listeners) {
      listener('Runtime.bindingCalled', {
        name: BINDING,
        payload: JSON.stringify({ dialog: { ...dialog }, toasts: [] })
      })
    }
  }
  const cdp = {
    sent,
    calls,
    dialog,
    emit,
    on: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
    async send(method, params) {
      sent.push(method)
      if (method === 'Page.reload')
        queueMicrotask(() => {
          for (const listener of listeners) listener('Page.loadEventFired', {})
        })
      return params ?? {}
    },
    async evaluate(expression) {
      const match = /window\.__videorcLab\.(\w+)\((.*)\)\) : null$/.exec(expression)
      if (!match) return 'installed'
      const [, name, rawArgs] = match
      const args = rawArgs ? JSON.parse(rawArgs) : undefined
      calls.push({ name, args })
      let result = null
      if (name === 'snapshot') return { dialog: { ...dialog }, toasts: [] }
      if (name === 'fill') {
        Object.assign(dialog, args)
        result = { ok: true }
      } else if (name === 'exclude') {
        dialog.destinations = dialog.destinations.filter((row) => row.targetId !== args)
        dialog.excluded = [...dialog.excluded, args]
        result = true
      } else if (name === 'include') {
        dialog.excluded = dialog.excluded.filter((id) => id !== args)
        dialog.destinations = [
          ...dialog.destinations,
          { targetId: args, ready: true, canExclude: false }
        ]
        result = true
      } else if (name === 'confirm') {
        result = !dialog.confirm.disabled
        // The app: a non-Public YouTube Go Live asks first (#1316), else starts.
        if (result && privacyStep) dialog.privacyConfirm = privacyStep
        else if (result) dialog.pending = true
      } else if (name === 'confirmPrivacy') {
        result = Boolean(dialog.privacyConfirm && !dialog.privacyConfirm.confirm.disabled)
        if (result) {
          dialog.privacyConfirm = null
          dialog.pending = true
        }
      } else if (name === 'dismissOtherDialogs') {
        result = 0
      }
      queueMicrotask(emit)
      return result
    }
  }
  return cdp
}

function driver(cdp) {
  const bus = createEventBus()
  const clock = createFakeClock()
  const ui = createUiDriver({ cdp, bus, waitFor: createWaitFor({ bus, clock }) })
  return { ui, bus, clock }
}

test('install wires the binding, the per-document helper and the load event', async () => {
  const cdp = fakePage()
  const { ui } = driver(cdp)
  await ui.install()
  assert.deepEqual(cdp.sent, [
    'Runtime.enable',
    'Page.enable',
    'Runtime.addBinding',
    'Page.addScriptToEvaluateOnNewDocument'
  ])
  await ui.reload()
  assert.ok(cdp.sent.includes('Page.reload'))
})

test('fill, destinations and confirm drive the dialog and wait on its snapshots', async () => {
  const cdp = fakePage({
    destinations: [
      { targetId: 'youtube', ready: true, canExclude: false },
      { targetId: 'twitch', ready: false, canExclude: true }
    ],
    excluded: ['youtube-vertical']
  })
  const { ui, bus } = driver(cdp)
  await ui.install()
  cdp.dialog.open = true
  const opened = await ui.waitForDialogOpen({ deadlineMs: 1000 })
  assert.equal(opened.open, true)

  await assert.rejects(
    ui.fillGoLive({ title: 'My stream', titlePrefix: 'Automated test' }),
    /must start with "Automated test"/
  )
  const filled = await ui.fillGoLive({
    title: 'Automated test: dry r1',
    description: 'd',
    privacy: 'unlisted',
    titlePrefix: 'Automated test',
    deadlineMs: 1000
  })
  assert.equal(filled.title, 'Automated test: dry r1')
  assert.equal(filled.privacy, 'unlisted')

  const ready = await ui.ensureDestinations(['youtube', 'youtube-vertical'], { deadlineMs: 1000 })
  assert.deepEqual(ready.destinations.map((row) => row.targetId).sort(), [
    'youtube',
    'youtube-vertical'
  ])
  assert.deepEqual(
    cdp.calls.filter((call) => ['include', 'exclude'].includes(call.name)),
    [
      { name: 'include', args: 'youtube-vertical' },
      { name: 'exclude', args: 'twitch' }
    ]
  )

  assert.deepEqual(await ui.confirmGoLive({ privacy: 'public' }), { privacyConfirm: null })
  assert.equal(cdp.dialog.pending, true)
  const outcome = ui.readGoLiveOutcome({ deadlineMs: 1000 })
  cdp.dialog.open = false
  bus.emit('remote.state', { sessionState: 'streaming', sessionActive: true })
  cdp.emit()
  assert.deepEqual(await outcome, { outcome: 'live' })
})

test('an unexpected ready destination is a refusal to confirm', async () => {
  const cdp = fakePage({
    destinations: [
      { targetId: 'youtube', ready: true, canExclude: false },
      { targetId: 'kick', ready: true, canExclude: false }
    ]
  })
  const { ui } = driver(cdp)
  await ui.install()
  cdp.dialog.open = true
  await assert.rejects(
    ui.ensureDestinations(['youtube']),
    /Unexpected destination "kick" in Go Live; refusing to confirm/
  )
  assert.equal(
    cdp.calls.some((call) => call.name === 'confirm'),
    false
  )
})

test('a disabled Go live button is an error, and the outcome wait has a deadline', async () => {
  const cdp = fakePage()
  const { ui, clock } = driver(cdp)
  await ui.install()
  cdp.dialog.open = true
  cdp.dialog.confirm = { disabled: true, label: 'Go live' }
  await assert.rejects(ui.confirmGoLive(), /missing or disabled/)
  const outcome = assert.rejects(
    ui.readGoLiveOutcome({ deadlineMs: 5000 }),
    /Go Live outcome did not happen within 5 s/
  )
  await clock.advance(5000)
  await outcome
})

const UNLISTED_STEP = {
  title: 'Go live unlisted?',
  description: 'Videorc lab is Unlisted.',
  confirm: { disabled: false, label: 'Go live unlisted' }
}

test('the privacy step is answered only for the privacy the run asked for', () => {
  assert.deepEqual(privacyConfirmDecision(UNLISTED_STEP, 'unlisted'), { answer: true })
  assert.deepEqual(
    privacyConfirmDecision({ ...UNLISTED_STEP, title: 'Go live private?' }, 'private'),
    { answer: true }
  )
  assert.match(privacyConfirmDecision(UNLISTED_STEP, 'private').reason, /not "Go live private\?"/)
  assert.match(privacyConfirmDecision(UNLISTED_STEP, 'public').reason, /asked for public/)
  assert.match(privacyConfirmDecision(UNLISTED_STEP, null).reason, /asked for no privacy/)
  assert.match(
    privacyConfirmDecision({ ...UNLISTED_STEP, title: 'Go live unlisted and private?' }, 'unlisted')
      .reason,
    /not "Go live unlisted\?"/
  )
  assert.match(
    privacyConfirmDecision(
      { ...UNLISTED_STEP, confirm: { disabled: true, label: 'x' } },
      'unlisted'
    ).reason,
    /disabled/
  )
  assert.equal(privacyConfirmDecision(null, 'unlisted').answer, false)
})

test('Go live answers "Go live unlisted?" (#1316) and reports it', async () => {
  const cdp = fakePage({ privacyStep: UNLISTED_STEP })
  const { ui, bus } = driver(cdp)
  await ui.install()
  cdp.dialog.open = true
  assert.deepEqual(await ui.confirmGoLive({ privacy: 'unlisted', deadlineMs: 1000 }), {
    privacyConfirm: { title: 'Go live unlisted?', answered: 'Go live unlisted' }
  })
  assert.deepEqual(
    cdp.calls.filter((call) => call.name.startsWith('confirm')).map((call) => call.name),
    ['confirm', 'confirmPrivacy']
  )
  const outcome = ui.readGoLiveOutcome({ deadlineMs: 1000 })
  cdp.dialog.open = false
  bus.emit('remote.state', { sessionState: 'streaming', sessionActive: true })
  cdp.emit()
  assert.deepEqual(await outcome, { outcome: 'live' })
})

test('a privacy step naming another privacy is refused, never clicked', async () => {
  const cdp = fakePage({ privacyStep: { ...UNLISTED_STEP, title: 'Go live private?' } })
  const { ui } = driver(cdp)
  await ui.install()
  cdp.dialog.open = true
  await assert.rejects(
    ui.confirmGoLive({ privacy: 'unlisted', deadlineMs: 1000 }),
    /Refusing the Go Live privacy step: it asks "Go live private\?"/
  )
  assert.equal(
    cdp.calls.some((call) => call.name === 'confirmPrivacy'),
    false
  )
})

// The real page helper over a DOM (happy-dom, the desktop app's test DOM).
async function helperOver(html) {
  const require = createRequire(new URL('../../../apps/desktop/package.json', import.meta.url))
  const { Window } = await import(pathToFileURL(require.resolve('happy-dom')).href)
  const window = new Window()
  window.document.body.innerHTML = html
  const globals = [
    'window',
    'document',
    'MutationObserver',
    'Event',
    'KeyboardEvent',
    'HTMLInputElement',
    'HTMLTextAreaElement'
  ]
  const run = new Function(...globals, `return ${pageHelperSource()}`)
  assert.equal(
    run(...globals.map((name) => (name === 'window' ? window : window[name]))),
    'installed'
  )
  return { api: window.__videorcLab, window }
}

const GO_LIVE_DOM = (state) => `
  <div data-testid="go-live-dialog" ${state} data-pending="false">
    <section data-testid="go-live-details">
      <input id="go-live-title" value="Automated test: x" />
    </section>
    <button data-testid="go-live-confirm">Go live</button>
  </div>`

test('a closed Base UI popup still in the DOM reads as closed', async () => {
  const { api, window } = await helperOver(GO_LIVE_DOM('data-closed=""'))
  assert.deepEqual(api.dialogState(), { open: false })
  assert.equal(api.confirm(), false)
  await window.happyDOM.close()
})

test('the open dialog reads its privacy step and the helper answers it', async () => {
  const { api, window } = await helperOver(`
    ${GO_LIVE_DOM('data-open=""')}
    <div data-testid="go-live-privacy-dialog" data-closed=""><h2>Go live private?</h2>
      <button data-testid="go-live-privacy-confirm">Go live private</button></div>
    <div data-testid="go-live-privacy-dialog" data-open="">
      <h2 data-slot="alert-dialog-title">Go live unlisted?</h2>
      <p data-slot="alert-dialog-description">Videorc lab is Unlisted.</p>
      <button data-testid="go-live-privacy-cancel">Change privacy</button>
      <button data-testid="go-live-privacy-confirm">Go live unlisted</button>
    </div>`)
  const state = api.dialogState()
  assert.equal(state.open, true)
  assert.equal(state.pending, false)
  assert.deepEqual(state.privacyConfirm, {
    title: 'Go live unlisted?',
    description: 'Videorc lab is Unlisted.',
    confirm: { disabled: false, label: 'Go live unlisted' }
  })
  let clicked = null
  window.document
    .querySelectorAll('[data-testid="go-live-privacy-confirm"]')
    .forEach((button) => button.addEventListener('click', () => (clicked = button.textContent)))
  assert.equal(api.confirmPrivacy(), true)
  assert.equal(clicked, 'Go live unlisted')
  await window.happyDOM.close()
})
