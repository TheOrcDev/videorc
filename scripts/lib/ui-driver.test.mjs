import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  ELECTRON_ROLE_CSS,
  createUiDriver,
  electronSelector,
  gpuiElementText,
  gpuiSelector
} from './ui-driver.mjs'
import {
  UI_DRIVER_MAP,
  UiDriverSelectorError,
  gpuiSelectorFor,
  selectorHooks
} from './ui-driver-map.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const rendererRoot = join(repoRoot, 'apps', 'desktop', 'src', 'renderer', 'src')
// The GPUI app (plan 260 S2.1). Until it exists, the checks that read its
// source skip and say why; the map is empty until then anyway.
const gpuiRoot = join(repoRoot, 'apps', 'videorc', 'src')
const gpuiMissing = existsSync(join(gpuiRoot, 'smoke'))
  ? false
  : "the GPUI app's smoke server (apps/videorc/src/smoke) does not exist yet (plan 260 S2.5)"
const SMOKE = { host: '127.0.0.1', port: 4321, capability: 'x'.repeat(43) }

function files(directory, extensions) {
  const out = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) out.push(...files(path, extensions))
    else if (extensions.some((extension) => entry.name.endsWith(extension))) out.push(path)
  }
  return out
}

function readAll(directory, extensions) {
  return files(directory, extensions).map((path) => ({ path, text: readFileSync(path, 'utf8') }))
}

/** A fake smoke client: records each request and answers from `answers`. */
function fakeRequest(answers = {}) {
  const calls = []
  const request = async (smoke, command, params, options) => {
    calls.push({ smoke, command, params, options })
    const answer = answers[command]
    if (typeof answer === 'function') return answer(params, calls)
    return answer ?? {}
  }
  return { calls, request }
}

test('every mapped Electron selector still exists in the renderer', (t) => {
  if (!existsSync(rendererRoot)) {
    t.skip('the Electron renderer is absent')
    return
  }
  const sources = readAll(rendererRoot, ['.tsx', '.ts']).filter(
    ({ path }) => !/\.test\.tsx?$/.test(path)
  )
  const missing = []
  for (const { electron } of UI_DRIVER_MAP) {
    const hooks = selectorHooks(electron)
    assert.ok(hooks.length > 0, `${electron} names no data-videorc hook`)
    for (const { attribute, value } of hooks) {
      const pattern =
        value === null
          ? new RegExp(`${attribute}(?=[\\s=/>{])`)
          : new RegExp(`${attribute}=(?:"${value}"|\\{['"\`]${value}['"\`]\\})`)
      if (!sources.some(({ text }) => pattern.test(text)))
        missing.push(`${electron} (${attribute})`)
    }
  }
  assert.deepEqual(missing, [], 'Mapped Electron selectors the renderer no longer renders')
})

test(
  'every mapped GPUI element still exists in the GPUI app, with a role both apps know',
  {
    skip: UI_DRIVER_MAP.length === 0 ? false : gpuiMissing
  },
  () => {
    const gpui = UI_DRIVER_MAP.length === 0 ? [] : readAll(gpuiRoot, ['.rs'])
    for (const { electron, gpui: target } of UI_DRIVER_MAP) {
      assert.ok(
        target.label || target.id || target.role,
        `${electron}: the GPUI selector names nothing`
      )
      if (target.role !== undefined) {
        assert.ok(target.role in ELECTRON_ROLE_CSS, `${electron}: role ${target.role}`)
      }
      for (const words of [target.label, target.id].filter((value) => value !== undefined)) {
        const quoted = JSON.stringify(words)
        assert.ok(
          gpui.some(({ text }) => text.includes(quoted)),
          `${electron}: the GPUI app never says ${quoted}`
        )
      }
    }
  }
)

test('the map refuses an unmapped CSS selector by name', () => {
  assert.equal(UI_DRIVER_MAP.length, 0, 'rows come with the screen slices')
  assert.throws(() => gpuiSelectorFor('[data-videorc-nope]'), UiDriverSelectorError)
  assert.throws(() => gpuiSelector('[data-videorc-nope]'), /ui-driver-map\.mjs/)
  assert.deepEqual(selectorHooks('[data-videorc-dock-slot="studio"] [data-videorc-x]'), [
    { attribute: 'data-videorc-dock-slot', value: 'studio' },
    { attribute: 'data-videorc-x', value: null }
  ])
})

test('selectors translate to each app', () => {
  assert.deepEqual(gpuiSelector({ name: 'Record', role: 'button' }), {
    label: 'Record',
    role: 'button'
  })
  assert.deepEqual(
    gpuiSelector({ role: 'text-input', index: 1, within: { name: 'Go live', role: 'group' } }),
    { role: 'text-input', index: 1, within: { label: 'Go live', role: 'group' } }
  )
  assert.deepEqual(gpuiSelector({ gpui: { id: 'record' }, electron: '#record' }), {
    id: 'record'
  })
  assert.throws(() => gpuiSelector({ index: 2 }), /names a name, role or id/)
  assert.throws(() => gpuiSelector({ electron: '#x' }), UiDriverSelectorError)

  assert.deepEqual(electronSelector('[data-videorc-preview-card]'), {
    css: '[data-videorc-preview-card]',
    index: 0
  })
  assert.deepEqual(electronSelector({ name: 'Record', role: 'button' }), {
    name: 'Record',
    role: 'button',
    index: 0,
    within: null
  })
  assert.throws(() => electronSelector({ id: 'record' }), /means nothing to Electron/)
  assert.throws(() => electronSelector({ name: 'x', role: 'tree' }), /no DOM role/)
})

test('the GPUI driver speaks the ui-* commands, each request outliving its wait', async () => {
  const fake = fakeRequest({
    'ui-find': (params) => ({
      count: 1,
      element:
        params.label === 'Stream key'
          ? { role: 'text-input', label: 'Stream key', value: 'live-key', password: true }
          : {
              role: 'group',
              label: 'Go live',
              children: [
                { role: 'label', label: 'Server URL', children: [] },
                { role: 'label', label: 'hidden', visible: false, children: [] }
              ]
            }
    }),
    'ui-click': { clicked: true },
    'ui-type': { typed: 3 },
    'ui-key': { pressed: 'Escape' },
    'capture-page': { file: '/tmp/videorc-ui-shot.png' },
    'ui-appearance': { theme: 'light' },
    'ui-toast': { shown: true, toasts: ['A error toast'] },
    'open-tab': { tab: 'studio' }
  })
  const ui = createUiDriver(SMOKE, { app: 'gpui', request: fake.request })

  await ui.click({ name: 'Record', role: 'button' }, { timeoutMs: 2000 })
  assert.deepEqual(fake.calls.at(-1).command, 'ui-click')
  assert.deepEqual(fake.calls.at(-1).params, { label: 'Record', role: 'button', timeoutMs: 2000 })
  assert.ok(fake.calls.at(-1).options.timeoutMs > 2000, 'the request outlives the wait')
  assert.equal(fake.calls.at(-1).smoke, SMOKE)

  await ui.click(
    {
      electron: '[data-videorc-session-status]',
      gpui: { label: 'Session status', role: 'label' }
    },
    { via: 'action' }
  )
  assert.deepEqual(fake.calls.at(-1).params, {
    label: 'Session status',
    role: 'label',
    timeoutMs: 8000,
    via: 'action'
  })

  await ui.type({ name: 'Server URL', role: 'text-input' }, 'rtmp://127.0.0.1/live')
  assert.deepEqual(fake.calls.at(-1).params, {
    label: 'Server URL',
    role: 'text-input',
    text: 'rtmp://127.0.0.1/live',
    clear: true,
    timeoutMs: 8000
  })

  assert.equal(await ui.readText({ name: 'Stream key', role: 'text-input' }), 'live-key')
  assert.equal(fake.calls.at(-1).params.reveal, true, 'readText reveals a password field')
  assert.equal(await ui.readText({ name: 'Go live', role: 'group' }), 'Go live Server URL')

  await ui.press('Escape')
  assert.deepEqual(fake.calls.at(-1).params, { key: 'Escape', modifiers: [] })
  await ui.press('a', { modifiers: ['meta'], selector: { name: 'Server URL' } })
  assert.deepEqual(fake.calls.at(-1).params, {
    key: 'a',
    modifiers: ['meta'],
    label: 'Server URL',
    timeoutMs: 8000
  })

  assert.deepEqual(await ui.capture('studio-dark'), { file: '/tmp/videorc-ui-shot.png' })
  assert.deepEqual(fake.calls.at(-1).params, { name: 'studio-dark' })
  await ui.setAppearance({ theme: 'light', increaseContrast: true })
  assert.deepEqual(fake.calls.at(-1).params, { theme: 'light', increaseContrast: true })
  await ui.openTab('studio', { waitFor: { name: 'Record', role: 'button' } })
  assert.deepEqual(
    fake.calls.slice(-2).map((call) => call.command),
    ['open-tab', 'ui-find']
  )
  // S3.0f: a toast through the session's toast path.
  assert.deepEqual(
    await ui.toast('error', 'A error toast', { description: 'What happened, in one sentence.' }),
    { shown: true, toasts: ['A error toast'] }
  )
  assert.deepEqual(fake.calls.at(-1).params, {
    kind: 'error',
    title: 'A error toast',
    description: 'What happened, in one sentence.'
  })
})

test('the GPUI driver waits for an element to go and reads a checked state', async () => {
  let looks = 0
  const fake = fakeRequest({
    'ui-find': (params) => {
      if (params.label === 'Keep on top') {
        return { count: 1, element: { role: 'switch', label: 'Keep on top', checked: true } }
      }
      looks += 1
      if (looks < 3) return { count: 1, element: { role: 'group', label: 'Go live' } }
      throw new Error('Timed out waiting for label "Go live" in the main window (it shows: "").')
    }
  })
  const ui = createUiDriver(SMOKE, { app: 'gpui', request: fake.request })
  await ui.waitForGone({ name: 'Go live' }, { timeoutMs: 5000 })
  assert.equal(looks, 3)
  assert.ok(fake.calls.every((call) => call.params.timeoutMs === 0))
  assert.equal(await ui.isChecked({ name: 'Keep on top', role: 'switch' }), true)

  const broken = createUiDriver(SMOKE, {
    app: 'gpui',
    request: fakeRequest({
      'ui-find': () => {
        throw new Error('Main window is not ready for preview motion smoke.')
      }
    }).request
  })
  await assert.rejects(broken.waitForGone({ name: 'x' }), /not ready/, 'a real error is not "gone"')
})

test('the Electron driver drives the DOM through eval-js', async () => {
  const fake = fakeRequest({
    'eval-js': () => ({ result: { clicked: true } }),
    'open-tab': { activeTab: 'studio' }
  })
  const ui = createUiDriver(SMOKE, { app: 'electron', request: fake.request })
  await ui.click({ name: 'Record', role: 'button' }, { timeoutMs: 3000 })
  const call = fake.calls.at(-1)
  assert.equal(call.command, 'eval-js')
  assert.match(call.params.code, /__ui\.wait\(params\.spec, params\.ms\)/)
  assert.deepEqual(call.params.spec, { name: 'Record', role: 'button', index: 0, within: null })
  assert.equal(call.params.ms, 3000)
  assert.ok(call.options.timeoutMs > 3000)

  await ui.openTab('studio', { waitFor: '[data-videorc-preview-card]' })
  assert.deepEqual(fake.calls.at(-1).params, {
    tab: 'studio',
    waitFor: '[data-videorc-preview-card]'
  })
  await ui.press('Space')
  assert.equal(fake.calls.at(-1).params.key, ' ', 'a DOM key name')
  await assert.rejects(ui.setAppearance({ increaseContrast: true }), /CDP media emulation/)
  await assert.rejects(ui.tree(), /no accessibility tree/)
  await ui.toast('info', 'A info toast', { description: 'What happened, in one sentence.' })
  assert.match(fake.calls.at(-1).params.code, /import\('\/src\/lib\/toast\.ts'\)/)
  assert.equal(fake.calls.at(-1).params.kind, 'info')
  assert.throws(() => createUiDriver(SMOKE, { app: 'qt' }), /Not a smoke app/)
})

test('a GPUI element reads as its value or its visible words', () => {
  assert.equal(gpuiElementText({ value: '', label: 'Server URL' }), '')
  assert.equal(gpuiElementText({ label: 'Ready' }), 'Ready')
  assert.equal(gpuiElementText(null), null)
})

test(
  'every command the GPUI driver sends is a GPUI app smoke command',
  { skip: gpuiMissing },
  () => {
    // S2.5 lands the GPUI app's smoke server; its command names live there.
    const server = readAll(join(gpuiRoot, 'smoke'), ['.rs'])
      .map(({ text }) => text)
      .join('\n')
    const source = readFileSync(join(repoRoot, 'scripts', 'lib', 'ui-driver.mjs'), 'utf8')
    const sent = new Set([...source.matchAll(/send\(\s*'([a-z-]+)'/g)].map((match) => match[1]))
    for (const command of sent) {
      if (command.startsWith('ui-')) assert.ok(server.includes(JSON.stringify(command)), command)
    }
    assert.ok(sent.has('ui-find') && sent.has('ui-click') && sent.has('ui-type'))
  }
)
