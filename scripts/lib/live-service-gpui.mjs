/** Typed GPUI operations shared by the loopback live-service smokes.
 * No renderer JavaScript is interpreted or sent to GPUI.
 */
import { createUiDriver } from './ui-driver.mjs'
import { requestSmokeCommand } from './smoke-command-client.mjs'

export function treeNodes(value) {
  if (!value || typeof value !== 'object') return []
  if (Array.isArray(value)) return value.flatMap(treeNodes)
  return [
    value,
    ...Object.values(value)
      .filter((v) => v && typeof v === 'object')
      .flatMap(treeNodes)
  ]
}

export function createLiveServiceGpui(
  getSmoke,
  { timeoutMs = 30000, request = requestSmokeCommand, afterAction } = {}
) {
  const observedRequest = async (...args) => {
    const result = await request(...args)
    if (
      afterAction &&
      /^(ui-(click|focus|type|key|scroll|appearance)|open-tab|select-layout-preset|studio-capture-configure|studio-stop|scheduled-mutate)$/.test(
        args[1]
      )
    ) {
      await afterAction(args[1])
    }
    return result
  }
  const send = async (name, params = {}) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      try {
        return await observedRequest(getSmoke(), name, params, { timeoutMs })
      } catch (error) {
        if (!String(error.message).includes('The scene is changing.') || Date.now() >= deadline)
          throw error
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
  }
  const ui = () => {
    const driver = createUiDriver(getSmoke(), { app: 'gpui', request: observedRequest })
    const wrapped = { ...driver }
    for (const method of ['click', 'focus', 'type']) {
      wrapped[method] = async (...args) => {
        for (let attempt = 0; ; attempt++) {
          try {
            return await driver[method](...args)
          } catch (error) {
            // The native driver refuses before dispatch when the target is
            // outside its viewport. Only that refusal is safe to retry.
            const outside =
              /outside the window \(.*?, (-?[\d.]+) in [\d.]+×([\d.]+)\); scroll it into view first/.exec(
                error.message
              )
            if (!outside || attempt >= 12) throw error
            await driver.scroll(null, {
              dy: Math.max(-150, Math.min(150, (Number(outside[1]) - Number(outside[2]) / 2) / 2))
            })
          }
        }
      }
    }
    return wrapped
  }
  const nodes = async () => treeNodes(await ui().tree())
  const find = async (selector) => {
    try {
      return await ui().waitFor(selector, { timeoutMs: 250 })
    } catch (error) {
      if (!/timed out|nothing matches|not found/i.test(error.message)) throw error
      return null
    }
  }
  const options = async () => {
    if (!(await find({ id: 'select-content' }))) return []
    const popup = await ui().tree({ within: { id: 'select-content' } })
    return treeNodes(popup)
      .filter((node) => /^\d+$/.test(String(node.id ?? '')))
      .map((row) => {
        const words = treeNodes(row)
          .map((node) => node.label)
          .filter(Boolean)
        return [...new Set(words)].join(' ')
      })
      .filter(Boolean)
  }
  return {
    send,
    ui,
    nodes,
    find,
    exists: async (selector) => Boolean(await find(selector)),
    enabled: async (selector) => (await find(selector))?.enabled === true,
    textIncludes: async (text) =>
      (await nodes()).some((node) =>
        [node.label, node.value, node.text].some((v) => typeof v === 'string' && v.includes(text))
      ),
    clickEnabled: async (selector) => {
      if ((await find(selector))?.enabled !== true) return false
      await ui().click(selector)
      return true
    },
    openSelect: async (selector) => {
      await ui().click(selector)
      await ui().press('ArrowDown')
      return true
    },
    options,
    pickFirst: async () => {
      const [name] = await options()
      if (!name) throw new Error('The select exposes no options.')
      return ui().click({ name, within: { id: 'select-content' } })
    },
    configure: (config) => send('studio-capture-configure', { config }),
    layout: (layout) => send('select-layout-preset', { preset: layout.layoutPreset }),
    state: () => send('studio-state'),
    ready: async () => {
      const s = await send('studio-state')
      return (
        s.bootstrapped && s.connection?.state === 'connected' && !s.startPending && !s.stopPending
      )
    },
    sceneReady: async () => {
      const s = await send('studio-scenes-state')
      return s.loaded && !s.readOnly && !s.error && !s.pendingSceneId
    },
    goLive: (action) => send('studio-go-live', { action }),
    confirmationOpen: async () => (await send('studio-go-live', { action: 'state' })).open,
    stop: () => send('studio-stop'),
    scheduledState: () => send('scheduled-state'),
    mutate: (action, params) => send('scheduled-mutate', { action, params }),
    // These tabs currently expose empty labels; IDs are scoped to this
    // named tab list in its declared Setup/Upcoming/Discord order.
    openSetup: async () => {
      await send('open-tab', { tab: 'streaming' })
      await ui().click({ id: '0', role: 'tab', within: { id: 'destinations-views/tabs' } })
      return true
    },
    openUpcoming: async () => {
      await send('open-tab', { tab: 'streaming' })
      await ui().click({ id: '1', role: 'tab', within: { id: 'destinations-views/tabs' } })
      return !(await send('scheduled-state')).loading
    }
  }
}
