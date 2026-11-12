import type { FrontApp, FrontAppChanged } from '../shared/front-app'

export interface FrontAppBinding {
  frontmostApp(): FrontApp | null
  frontWindowForPid(pid: number): { windowId: string; width: number; height: number } | null
  /** Plan 230 Q14: optional so an older addon build still loads. */
  activateApp?(pid: number, bundleId: string): boolean
  selfBundleId(): string | null
  startFrontAppObserver(callback: (app: FrontApp) => void): void
  stopFrontAppObserver(): void
}

/** Injected clock and timers keep lifecycle and dedupe independently testable. */
export function createFrontAppMonitor(options: {
  platform: string
  binding: FrontAppBinding | null
  send: (event: FrontAppChanged) => void
  now?: () => number
  every?: (callback: () => void, ms: number) => () => void
  /** Plan 230: a refused or failed activation is logged, never silent. */
  warn?: (message: string) => void
}): {
  start(): void
  stop(): void
  setWatch(enabled: boolean): void
  selfBundleIds(): string[]
  lastOtherApp(): FrontApp | null
  activateApp(pid: number, bundleId: string): boolean
} {
  const binding = options.platform === 'darwin' ? options.binding : null
  const every =
    options.every ??
    ((callback, ms) => {
      const timer = setInterval(callback, ms)
      timer.unref()
      return () => clearInterval(timer)
    })
  let generation = 0
  let watchEnabled = false
  let running = false
  let last: FrontAppChanged | undefined
  let cancelWatch: (() => void) | undefined
  // Plan 230 Q14: the app the streamer used last that is not Videorc, so a
  // tap back to the Monitor screen can hand the focus to it.
  let lastOther: FrontApp | null = null
  let selfId: string | null | undefined
  const noteOther = (app: FrontApp): void => {
    selfId ??= binding?.selfBundleId() ?? null
    if (app.bundleId && app.bundleId !== selfId) lastOther = app
  }
  const publish = (app: FrontApp): void => {
    if (!running || !binding) return
    const frontWindowId = binding.frontWindowForPid(app.pid)?.windowId
    if (
      last &&
      last.pid === app.pid &&
      last.bundleId === app.bundleId &&
      last.name === app.name &&
      last.frontWindowId === frontWindowId
    )
      return
    last = { ...app, ...(frontWindowId ? { frontWindowId } : {}), at: (options.now ?? Date.now)() }
    options.send(last)
  }
  const updateWatch = (): void => {
    cancelWatch?.()
    cancelWatch = undefined
    if (watchEnabled && running && binding) {
      cancelWatch = every(() => {
        if (!watchEnabled || !running) return
        const app = binding.frontmostApp()
        if (app) publish(app)
      }, 500)
    }
  }
  return {
    start() {
      if (!binding || running) return
      running = true
      try {
        const currentGeneration = ++generation
        binding.startFrontAppObserver((app) => {
          if (generation !== currentGeneration) return
          noteOther(app)
          publish(app)
        })
        const app = binding.frontmostApp()
        if (app) {
          noteOther(app)
          publish(app)
        }
        updateWatch()
      } catch (error) {
        running = false
        binding.stopFrontAppObserver()
        throw error
      }
    },
    stop() {
      generation++
      cancelWatch?.()
      cancelWatch = undefined
      if (running) binding?.stopFrontAppObserver()
      running = false
      watchEnabled = false
      last = undefined
      lastOther = null
    },
    setWatch(enabled) {
      watchEnabled = enabled
      updateWatch()
    },
    selfBundleIds() {
      const id = binding?.selfBundleId()
      return id ? [id] : []
    },
    lastOtherApp() {
      return lastOther
    },
    activateApp(pid, bundleId) {
      try {
        return binding?.activateApp?.(pid, bundleId) ?? false
      } catch (error) {
        options.warn?.(
          `[front-app] activate ${bundleId} failed: ${error instanceof Error ? error.message : String(error)}`
        )
        return false
      }
    }
  }
}

export function frontAppSenderIsMain(senderId: number, mainId: number | undefined): boolean {
  return mainId !== undefined && senderId === mainId
}
