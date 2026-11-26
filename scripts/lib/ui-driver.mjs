/**
 * Plan 260 S2.5 (from plan 220 S3.0b): one UI driver for both apps. A smoke opens a page,
 * waits for an element, clicks it, types into it, reads it, checks it and
 * takes the window's picture the same way whichever app runs:
 *
 * - Electron (`VIDEORC_APP` unset or `electron`): `eval-js` over the DOM, and
 *   Electron's `open-tab` and `capture-page`.
 * - GPUI (`VIDEORC_APP=gpui`): the GPUI app's `ui-*` commands, which work on
 *   the window's accessibility tree (`crates/videorc-app/src/ui_driver.rs`),
 *   and the same `open-tab` and `capture-page`.
 *
 * Selectors:
 *
 * - `{ name, role?, within?, index? }`: the accessible name a screen reader
 *   says (a button's words, a field's label) and AccessKit's role in kebab-case
 *   (`button`, `text-input`, `switch`, `checkbox`, `text`, `image`, `tab`,
 *   `list-item`, `combobox`, `slider`, `groupbox`). The same in both apps.
 * - a CSS string (`'[data-videorc-session-status]'`): the `data-videorc-*`
 *   hooks today's smokes use. Electron runs it as is; the GPUI app looks it
 *   up in `ui-driver-map.mjs` and refuses an unmapped one by name.
 * - `{ electron, gpui }`: each app's own (an escape hatch; `gpui` is a
 *   `ui-*` selector, `electron` a CSS string).
 *
 *   const ui = createUiDriver(smoke)
 *   await ui.click({ name: 'Go Live…', role: 'button' })
 *   await ui.type({ name: 'Server URL', role: 'text-input' }, 'rtmp://127.0.0.1/live')
 *   await ui.readText({ name: 'Server URL', role: 'text-input' })
 *   await ui.press('Escape')
 *   await ui.capture('studio-dark')
 *
 * Every wait defaults to Electron's `waitFor` (8 s); each command's HTTP
 * request outlives its wait.
 */
import { smokeAppKind } from './app-launcher.mjs'
import { requestSmokeCommand } from './smoke-command-client.mjs'
import { UiDriverSelectorError, gpuiSelectorFor } from './ui-driver-map.mjs'

export const UI_DRIVER_DEFAULT_WAIT_MS = 8000
/** How much longer than its wait a command's request may take. */
const REQUEST_SLACK_MS = 15_000
const GONE_POLL_MS = 100

/**
 * AccessKit's roles (kebab-case, as the GPUI app's \`ui-*\` commands name them)
 * as Electron's DOM spells them, for the name selectors.
 */
export const ELECTRON_ROLE_CSS = Object.freeze({
  button: 'button, [role="button"]',
  'text-input':
    'input:not([type="checkbox"]):not([type="radio"]):not([type="range"]), textarea, [role="textbox"], [contenteditable="true"]',
  switch: '[role="switch"]',
  'check-box': '[role="checkbox"], input[type="checkbox"]',
  'combo-box': '[role="combobox"], select',
  slider: '[role="slider"], input[type="range"]',
  tab: '[role="tab"]',
  'list-item': '[role="option"], [role="listitem"], li',
  image: 'img, [role="img"]',
  group: '[role="group"], fieldset',
  dialog: '[role="dialog"], [role="alertdialog"]',
  label: '*'
})

/** `ui-key`'s key names, as a DOM `KeyboardEvent.key` spells them. */
const DOM_KEY = Object.freeze({ Space: ' ', Return: 'Enter', Esc: 'Escape' })

/**
 * The GPUI `ui-*` selector for a driver selector. Throws by name for a CSS
 * string the map lacks, or a selector of neither form.
 */
export function gpuiSelector(selector) {
  if (typeof selector === 'string') return gpuiSelectorFor(selector)
  if (!selector || typeof selector !== 'object') {
    throw new Error(`Not a UI driver selector: ${JSON.stringify(selector)}`)
  }
  if ('gpui' in selector || 'electron' in selector) {
    if (!selector.gpui) throw new UiDriverSelectorError(selector.electron)
    return { ...selector.gpui }
  }
  const out = {}
  if (selector.name !== undefined) out.label = selector.name
  for (const key of ['role', 'id', 'value', 'index']) {
    if (selector[key] !== undefined) out[key] = selector[key]
  }
  if (selector.within !== undefined) out.within = gpuiSelector(selector.within)
  if (out.label === undefined && out.id === undefined && out.role === undefined) {
    throw new Error(`A UI driver selector names a name, role or id: ${JSON.stringify(selector)}`)
  }
  return out
}

/**
 * The Electron page's spec for a driver selector: `{ css }` or `{ name,
 * role, within, index }`.
 */
export function electronSelector(selector) {
  if (typeof selector === 'string') return { css: selector, index: 0 }
  if (!selector || typeof selector !== 'object') {
    throw new Error(`Not a UI driver selector: ${JSON.stringify(selector)}`)
  }
  if ('gpui' in selector || 'electron' in selector) {
    if (typeof selector.electron !== 'string') {
      throw new Error(`This selector has no Electron CSS: ${JSON.stringify(selector)}`)
    }
    return { css: selector.electron, index: 0 }
  }
  if (selector.role !== undefined && !(selector.role in ELECTRON_ROLE_CSS)) {
    throw new Error(`The Electron driver has no DOM role for ${JSON.stringify(selector.role)}.`)
  }
  if (selector.id !== undefined) {
    throw new Error(
      `A GPUI element id (${JSON.stringify(selector.id)}) means nothing to Electron; use { electron, gpui }.`
    )
  }
  return {
    name: selector.name ?? null,
    role: selector.role ?? null,
    index: selector.index ?? 0,
    within: selector.within === undefined ? null : electronSelector(selector.within)
  }
}

/**
 * Page JavaScript (inside an `eval-js` async body): `__ui.find(spec)` (the
 * element or null), `__ui.wait(spec, ms)` (the element, or a throw that
 * quotes the page) and `__ui.describe(element)`.
 */
const ELECTRON_HELPERS = `
const __ui = (() => {
  const roles = ${JSON.stringify(ELECTRON_ROLE_CSS)};
  const norm = (text) => String(text ?? '').replace(/\\s+/g, ' ').trim();
  const visible = (el) => el.getClientRects().length > 0 && !el.closest('[aria-hidden="true"], [inert]');
  const nameOf = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria) return norm(aria);
    const by = el.getAttribute('aria-labelledby');
    if (by) return norm(by.split(/\\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' '));
    if (el.labels && el.labels.length) return norm([...el.labels].map((label) => label.textContent).join(' '));
    const text = norm(el.innerText ?? el.textContent);
    if (text) return text;
    return norm(el.getAttribute('title') ?? el.getAttribute('placeholder') ?? '');
  };
  const all = (spec, root = document) => {
    let scope = root;
    if (spec.within) {
      scope = find(spec.within, root);
      if (!scope) return [];
    }
    if (spec.css) return [...scope.querySelectorAll(spec.css)].filter(visible);
    const css = spec.role ? roles[spec.role] : '*';
    let found = [...scope.querySelectorAll(css)].filter((el) => el !== scope && visible(el));
    if (spec.name !== null) found = found.filter((el) => nameOf(el) === spec.name);
    // A name on plain text: the innermost element that says it.
    if (!spec.role || spec.role === 'text') found = found.filter((el) => !found.some((other) => other !== el && el.contains(other)));
    return found;
  };
  const find = (spec, root) => all(spec, root)[spec.index ?? 0] ?? null;
  const describe = (el) => {
    const ariaChecked = el.getAttribute('aria-checked');
    const ariaPressed = el.getAttribute('aria-pressed');
    return {
      label: nameOf(el),
      value: typeof el.value === 'string' && el.tagName !== 'BUTTON' ? el.value : null,
      checked: ariaChecked !== null ? ariaChecked === 'true'
        : el.type === 'checkbox' || el.type === 'radio' ? el.checked
        : ariaPressed !== null ? ariaPressed === 'true'
        : null,
      enabled: !(el.disabled || el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('data-disabled')),
      focused: document.activeElement === el,
      text: norm(el.innerText ?? el.textContent)
    };
  };
  const wait = async (spec, ms) => {
    const deadline = performance.now() + ms;
    for (;;) {
      const el = find(spec);
      if (el) return el;
      if (performance.now() >= deadline) {
        const shown = norm(document.querySelector('main')?.innerText ?? document.body.innerText).slice(0, 240);
        throw new Error('Timed out waiting for ' + JSON.stringify(spec) + ' (the page shows: ' + JSON.stringify(shown) + ')');
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  return { find, all, wait, describe, norm };
})();
`

/** The text an element reads as: a field's value, else its words and its children's. */
export function gpuiElementText(element) {
  if (!element) return null
  if (typeof element.value === 'string') return element.value
  const words = []
  const walk = (node) => {
    if (node.visible !== false && node.label) words.push(node.label)
    for (const child of node.children ?? []) walk(child)
  }
  walk(element)
  return words.join(' ')
}

/**
 * The driver over one app's smoke command server. `app` defaults to
 * `VIDEORC_APP`; `request` is `requestSmokeCommand` (a test passes a fake).
 */
export function createUiDriver(
  smoke,
  {
    app = smokeAppKind(),
    request = requestSmokeCommand,
    defaultTimeoutMs = UI_DRIVER_DEFAULT_WAIT_MS
  } = {}
) {
  if (app !== 'gpui' && app !== 'electron') throw new Error(`Not a smoke app: ${app}`)
  const gpui = app === 'gpui'
  const send = (command, params, waitMs = 0) =>
    request(smoke, command, params, { timeoutMs: waitMs + REQUEST_SLACK_MS })
  const page = async (code, params = {}, waitMs = 0) => {
    const answer = await send(
      'eval-js',
      { ...params, code: `${ELECTRON_HELPERS}\n${code}` },
      waitMs
    )
    return answer?.result
  }
  const waitMs = (options) => options?.timeoutMs ?? defaultTimeoutMs

  /** Waits for a visible match; answers its description (GPUI: the tree node). */
  async function waitFor(selector, options = {}) {
    const ms = waitMs(options)
    if (gpui) {
      const answer = await send('ui-find', { ...gpuiSelector(selector), timeoutMs: ms }, ms)
      return answer.element
    }
    return page(
      'return __ui.describe(await __ui.wait(params.spec, params.ms))',
      { spec: electronSelector(selector), ms },
      ms
    )
  }

  /** Waits until nothing matches (a dialog closed). */
  async function waitForGone(selector, options = {}) {
    const ms = waitMs(options)
    if (gpui) {
      const deadline = Date.now() + ms
      const target = gpuiSelector(selector)
      for (;;) {
        try {
          await send('ui-find', { ...target, timeoutMs: 0 })
        } catch (error) {
          if (/Timed out waiting/.test(String(error?.message ?? error))) return
          throw error
        }
        if (Date.now() >= deadline) {
          throw new Error(`Timed out waiting for ${JSON.stringify(selector)} to go away.`)
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, GONE_POLL_MS))
      }
    }
    await page(
      `const deadline = performance.now() + params.ms;
       while (__ui.find(params.spec)) {
         if (performance.now() >= deadline) throw new Error('Timed out waiting for ' + JSON.stringify(params.spec) + ' to go away.');
         await sleep(50);
       }
       return true`,
      { spec: electronSelector(selector), ms },
      ms
    )
  }

  /** Clicks the element: GPUI with the pointer (`via: 'action'` for its default action). */
  async function click(selector, options = {}) {
    const ms = waitMs(options)
    if (gpui) {
      const params = { ...gpuiSelector(selector), timeoutMs: ms }
      if (options.via) params.via = options.via
      if (options.modifiers) params.modifiers = options.modifiers
      return send('ui-click', params, ms)
    }
    return page(
      `const el = await __ui.wait(params.spec, params.ms);
       const deadline = performance.now() + params.ms;
       while (!__ui.describe(el).enabled) {
         if (performance.now() >= deadline) throw new Error('Timed out waiting: ' + JSON.stringify(params.spec) + ' is disabled');
         await sleep(50);
       }
       el.click();
       return { clicked: true, element: __ui.describe(el) }`,
      { spec: electronSelector(selector), ms },
      ms
    )
  }

  /**
   * Absolute pointer click in window points (GPUI: `ui-click {x,y}`; Electron:
   * `elementFromPoint` then click). Used for the Scene stage where sources are
   * painted, not separate accessibility nodes.
   */
  async function clickAt(x, y, options = {}) {
    const ms = waitMs(options)
    if (gpui) {
      const params = { x, y, timeoutMs: ms }
      if (options.modifiers) params.modifiers = options.modifiers
      if (options.window) params.window = options.window
      return send('ui-click', params, ms)
    }
    return page(
      `const el = document.elementFromPoint(params.x, params.y);
       if (!el) throw new Error('Nothing at (' + params.x + ', ' + params.y + ')');
       el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: params.x, clientY: params.y }));
       return { clicked: true, x: params.x, y: params.y }`,
      { x, y },
      ms
    )
  }

  /**
   * Pointer drag from (fromX, fromY) to (toX, toY) in window points (GPUI:
   * `ui-drag`; Electron: mouse events on the document). `steps` is how many
   * move samples between press and release (default 8).
   */
  async function drag(fromX, fromY, toX, toY, options = {}) {
    const ms = waitMs(options)
    const steps = options.steps ?? 8
    if (gpui) {
      const params = { fromX, fromY, toX, toY, steps, timeoutMs: ms }
      if (options.modifiers) params.modifiers = options.modifiers
      return send('ui-drag', params, ms)
    }
    return page(
      `const has = (name) => (params.modifiers ?? []).map((m) => m.toLowerCase()).some((m) => name.includes(m));
       const mods = {
         shiftKey: has(['shift']),
         ctrlKey: has(['control', 'ctrl']),
         altKey: has(['alt', 'option']),
         metaKey: has(['meta', 'command', 'cmd'])
       };
       const fire = (type, x, y, buttons) =>
         document.elementFromPoint(x, y)?.dispatchEvent(new MouseEvent(type, {
           bubbles: true, cancelable: true, clientX: x, clientY: y, buttons, ...mods
         }));
       fire('mousemove', params.fromX, params.fromY, 0);
       fire('mousedown', params.fromX, params.fromY, 1);
       for (let hop = 1; hop <= params.steps; hop += 1) {
         const t = hop / params.steps;
         fire(
           'mousemove',
           params.fromX + (params.toX - params.fromX) * t,
           params.fromY + (params.toY - params.fromY) * t,
           1
         );
       }
       fire('mouseup', params.toX, params.toY, 0);
       return { dragged: true, fromX: params.fromX, fromY: params.fromY, toX: params.toX, toY: params.toY, steps: params.steps }`,
      { fromX, fromY, toX, toY, steps, modifiers: options.modifiers ?? [] },
      ms
    )
  }

  /**
   * Focuses a row or field (GPUI: pointer click through the window's dispatch;
   * Electron: `el.focus()`). Then `press` without a selector sends keys to it.
   */
  async function focus(selector, options = {}) {
    const ms = waitMs(options)
    if (gpui) {
      return send('ui-focus', { ...gpuiSelector(selector), timeoutMs: ms }, ms)
    }
    return page(
      `const el = await __ui.wait(params.spec, params.ms);
       el.focus();
       return { focused: true, element: __ui.describe(el) }`,
      { spec: electronSelector(selector), ms },
      ms
    )
  }

  /**
   * A mouse wheel over the element (or the window's centre without one):
   * positive `dy` reveals what is below, as a DOM `deltaY`. GPUI only
   * (`ui-scroll`); an Electron smoke scrolls its page with eval-js.
   */
  async function scroll(selector, { dx = 0, dy = 0, ...options } = {}) {
    if (!gpui)
      throw new Error("scroll() is the GPUI driver's; scroll an Electron page with eval-js.")
    const ms = waitMs(options)
    const params = { dx, dy, timeoutMs: ms }
    if (selector !== undefined && selector !== null) Object.assign(params, gpuiSelector(selector))
    return send('ui-scroll', params, ms)
  }

  /** Types `text` into a text field (emptied first unless `clear: false`). */
  async function type(selector, text, options = {}) {
    const ms = waitMs(options)
    const clear = options.clear ?? true
    if (gpui) {
      return send('ui-type', { ...gpuiSelector(selector), text, clear, timeoutMs: ms }, ms)
    }
    return page(
      `const el = await __ui.wait(params.spec, params.ms);
       el.focus();
       const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
       const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
       setter.call(el, (params.clear ? '' : el.value) + params.text);
       el.dispatchEvent(new Event('input', { bubbles: true }));
       el.dispatchEvent(new Event('change', { bubbles: true }));
       return { typed: params.text.length, element: __ui.describe(el) }`,
      { spec: electronSelector(selector), ms, text, clear },
      ms
    )
  }

  /** A field's value, or the words an element shows. GPUI reveals a password field's value. */
  async function readText(selector, options = {}) {
    const ms = waitMs(options)
    if (gpui) {
      const answer = await send(
        'ui-find',
        { ...gpuiSelector(selector), timeoutMs: ms, reveal: true },
        ms
      )
      return gpuiElementText(answer.element)
    }
    return page(
      `const d = __ui.describe(await __ui.wait(params.spec, params.ms));
       return d.value ?? d.text`,
      { spec: electronSelector(selector), ms },
      ms
    )
  }

  /** Whether a switch, checkbox or toggle is on. */
  async function isChecked(selector, options = {}) {
    const element = await waitFor(selector, options)
    return element?.checked === true
  }

  /**
   * One key (`Escape`, `Enter`, `Tab`, `Space`, an arrow, a character) with
   * `modifiers` held, into `selector`'s element or whatever has the focus.
   */
  async function press(key, options = {}) {
    const modifiers = options.modifiers ?? []
    if (gpui) {
      const params = { key, modifiers }
      let ms = 0
      if (options.selector !== undefined) {
        ms = waitMs(options)
        Object.assign(params, gpuiSelector(options.selector), { timeoutMs: ms })
      }
      return send('ui-key', params, ms)
    }
    const ms = options.selector === undefined ? 0 : waitMs(options)
    return page(
      `const el = params.spec ? await __ui.wait(params.spec, params.ms) : (document.activeElement ?? document.body);
       if (params.spec) el.focus();
       const has = (name) => params.modifiers.map((m) => m.toLowerCase()).some((m) => name.includes(m));
       const init = { key: params.key, bubbles: true, cancelable: true,
         shiftKey: has(['shift']), ctrlKey: has(['control', 'ctrl']), altKey: has(['alt', 'option']),
         metaKey: has(['meta', 'command', 'cmd']) };
       el.dispatchEvent(new KeyboardEvent('keydown', init));
       el.dispatchEvent(new KeyboardEvent('keyup', init));
       return { pressed: params.key }`,
      {
        spec: options.selector === undefined ? null : electronSelector(options.selector),
        ms,
        key: DOM_KEY[key] ?? key,
        modifiers
      },
      ms
    )
  }

  /** Opens a page by its tab id, then waits for `waitFor` when given. */
  async function openTab(tab, options = {}) {
    const ms = waitMs(options)
    if (gpui) {
      const opened = await send('open-tab', { tab }, ms)
      if (options.waitFor !== undefined) await waitFor(options.waitFor, { timeoutMs: ms })
      return opened
    }
    const params = { tab }
    if (options.waitFor !== undefined) {
      const spec = electronSelector(options.waitFor)
      if (!spec.css) {
        // open-tab waits for CSS; a name waits here.
        const opened = await send('open-tab', params, ms)
        await waitFor(options.waitFor, { timeoutMs: ms })
        return opened
      }
      params.waitFor = spec.css
    }
    return send('open-tab', params, Math.max(ms, 45_000))
  }

  /** The window's own picture: `{ file }` in VIDEORC_SMOKE_OUTPUT_DIR. */
  async function capture(name, options = {}) {
    const params = { name }
    if (gpui && options.window) params.window = options.window
    return send('capture-page', params, 30_000)
  }

  /**
   * Forces the look a screenshot needs. GPUI: `ui-appearance` (theme,
   * Increase Contrast, Reduce Motion; `null` gives a part back). Electron: the
   * theme through its storage key, as `capture-ui-pages.mjs` does; Increase
   * Contrast and Reduce Motion need CDP media emulation (S0.1a's path).
   */
  async function setAppearance(appearance = {}) {
    if (gpui) return send('ui-appearance', appearance)
    const { theme, ...rest } = appearance
    const forced = Object.entries(rest).filter(([, value]) => value !== undefined)
    if (forced.length > 0) {
      throw new Error(
        `The Electron driver forces only the theme; ${forced.map(([key]) => key).join(', ')} need${forced.length === 1 ? 's' : ''} CDP media emulation (S0.1a's path).`
      )
    }
    if (theme === undefined || theme === null) return { theme: null }
    if (theme !== 'dark' && theme !== 'light') throw new Error(`A theme is dark or light: ${theme}`)
    const applied = await page(
      `localStorage.setItem('videorc.theme', params.theme);
       window.dispatchEvent(new StorageEvent('storage', { key: 'videorc.theme', newValue: params.theme }));
       await sleep(700);
       return document.documentElement.classList.contains(params.theme)`,
      { theme }
    )
    if (applied !== true) throw new Error(`The app did not switch to the ${theme} theme.`)
    return { theme }
  }

  /**
   * Raises a toast in the main window, replacing the last one this driver
   * raised (plan 220 S3.0f). GPUI: `ui-toast`, through the session's toast
   * path (the core's `lib/toast.ts`: its duration, an error's Copy).
   * Electron: `lib/toast.ts` itself, after dismissing every toast, as S0.1a's
   * baseline did.
   */
  async function toast(kind, title, options = {}) {
    if (gpui) {
      const params = { kind, title }
      if (options.description !== undefined) params.description = options.description
      if (options.durationMs !== undefined) params.durationMs = options.durationMs
      return send('ui-toast', params)
    }
    return page(
      `const { toast } = await import('/src/lib/toast.ts');
       toast.dismiss?.();
       await sleep(300);
       const show = params.kind === 'message' ? toast.message : toast[params.kind];
       const options = {};
       if (params.description !== null) options.description = params.description;
       if (params.durationMs !== null) options.duration = params.durationMs;
       show(params.title, options);
       return { shown: true }`,
      {
        kind,
        title,
        description: options.description ?? null,
        durationMs: options.durationMs ?? null
      }
    )
  }

  /** The window's accessibility tree (the GPUI app only). */
  async function tree(options = {}) {
    if (!gpui)
      throw new Error('Electron has no accessibility tree command; read the DOM with eval-js.')
    const params = {}
    if (options.window) params.window = options.window
    if (options.within !== undefined) params.within = gpuiSelector(options.within)
    if (options.depth !== undefined) params.depth = options.depth
    return send('ui-tree', params)
  }

  return {
    app,
    waitFor,
    waitForGone,
    click,
    clickAt,
    drag,
    focus,
    type,
    readText,
    isChecked,
    press,
    scroll,
    openTab,
    capture,
    setAppearance,
    toast,
    tree
  }
}
