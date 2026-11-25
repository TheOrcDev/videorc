// Plan 260 Phase 3 (L6): what the GPUI app's native preview probes share.
// They drive the app the way a person does (⌘P as the `TogglePreview` action
// the menu dispatches, the Preview window's close button) and read the preview
// through the GPUI smoke server: `preview-window-state` (L1's `Preview::phase()`, `closed`,
// `floatingOpen`), `native-preview-surface-status` (the element's live
// `presentedFrameId`) and `preview-retry` (`Preview::retry`).
//
// VIDEORC_GPUI_APP_BINARY runs a prebuilt app (the compile sentinel's
// `~/cloud-test/gpui-builds/latest`) instead of building one.

import { dirname, join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'

import { launchDevApp } from './app-launcher.mjs'
import { requestSmokeCommand } from './smoke-command-client.mjs'
import { createUiDriver } from './ui-driver.mjs'

/** ⌘P (Window → Preview): `secondary-p`, Control off macOS. */
export const TOGGLE_PREVIEW_MODIFIERS = process.platform === 'darwin' ? ['meta'] : ['control']

/**
 * The prebuilt app's spawn spec, or undefined to build and run the dev
 * binary. Pure for its test.
 */
export function gpuiPrebuiltSpawnSpec(env = process.env) {
  const binary = env.VIDEORC_GPUI_APP_BINARY
  if (!binary) return undefined
  return { command: binary, args: [], cwd: dirname(binary) }
}

/** Launches the GPUI app on an isolated profile under `stateDir`. */
export async function launchGpuiApp({ stateDir, timeoutMs, verbose = false, env = {} }) {
  const logs = []
  const spawnSpec = gpuiPrebuiltSpawnSpec()
  const app = await launchDevApp({
    env: {
      VIDEORC_APP: 'gpui',
      VIDEORC_SMOKE_COMMAND_SERVER: '1',
      VIDEORC_SMOKE_STATE_DIR: stateDir,
      VIDEORC_SMOKE_OUTPUT_DIR: stateDir,
      VIDEORC_USER_DATA_DIR: join(stateDir, 'profile'),
      ...env
    },
    timeoutMs,
    requiredMarkers: ['preview-motion-ready', 'backend-ready'],
    ...(spawnSpec ? { spawnSpec, skipPrebuild: true } : {}),
    onLine: (line) => {
      logs.push(stripVTControlCharacters(line))
      if (verbose) console.log(line)
    }
  })
  const smoke = app.connections['preview-motion-ready']
  const command = (name, params = {}) => requestSmokeCommand(smoke, name, params, { timeoutMs })
  const ui = createUiDriver(smoke, { app: 'gpui' })
  return { app, smoke, command, ui, logs }
}

export const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/**
 * The test pattern on (`enable-synthetic-source`), once the app's UI settings
 * have loaded: a fresh profile refuses the write until then
 * (`ui-settings-not-hydrated`), as Electron's first-run placeholder does.
 */
export async function enableTestPattern(command, { budgetMs = 30000 } = {}) {
  const until = Date.now() + budgetMs
  while (true) {
    try {
      return await command('enable-synthetic-source', { settleMs: 500 })
    } catch (error) {
      const message = error?.message ?? String(error)
      if (!/not-hydrated|not ready|no snapshot yet/i.test(message) || Date.now() > until)
        throw error
      await sleep(250)
    }
  }
}

/**
 * Waits once for the main window's accessibility tree: the first UI request
 * only turns accessibility on, and a key pressed with no selector makes one
 * attempt (no wait), so ⌘P before the tree exists finds nothing to press.
 */
export async function warmUiTree(ui, { timeoutMs = 20000 } = {}) {
  await ui.waitFor({ role: 'button' }, { timeoutMs })
}

/**
 * Polls `read` every `everyMs` until `holds(value)`, recording every distinct
 * `label(value)` it saw on the way (the phases a retry passes through).
 * Throws with the last value and the trail when the budget runs out.
 */
export async function waitUntil(what, read, holds, { budgetMs, everyMs = 50, label } = {}) {
  const until = Date.now() + budgetMs
  const trail = []
  let last
  while (true) {
    last = await read()
    const seen = label ? label(last) : undefined
    if (seen !== undefined && trail.at(-1) !== seen) trail.push(seen)
    if (holds(last)) return { value: last, trail }
    if (Date.now() > until) {
      throw new Error(
        `${what} within ${budgetMs} ms; last ${JSON.stringify(last)}; seen [${trail.join(' → ')}]`
      )
    }
    await sleep(everyMs)
  }
}

/**
 * How far the preview's `presentedFrameId` moved over `ms`: frames the layer
 * showed. Null ids (no native surface) count as zero.
 */
export async function presentedAdvance(command, ms) {
  const first = await command('native-preview-surface-status')
  await sleep(ms)
  const last = await command('native-preview-surface-status')
  const id = (status) =>
    typeof status?.presentedFrameId === 'number' ? status.presentedFrameId : 0
  return { advance: id(last) - id(first), first, last }
}

/** The log lines after `mark` that match `pattern`. */
export function logLinesSince(logs, mark, pattern) {
  return logs.slice(mark).filter((line) => pattern.test(line))
}

/** A preview state's one-line summary for the probe's log. */
export function describePreview(state) {
  if (!state) return 'no state'
  const where = state.closed ? 'closed' : state.mode
  const floating = state.floatingOpen ? ', window open' : ''
  return `${where}${floating}, ${state.phase}`
}
