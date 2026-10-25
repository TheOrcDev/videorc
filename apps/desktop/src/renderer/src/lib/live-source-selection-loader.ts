import type { RecordingState, SessionSourceKind } from '@/lib/backend'
import type { LiveSourceSelectionController } from './live-source-selection'

type Controller = LiveSourceSelectionController
type Module = typeof import('./live-source-selection')

/** Loading never admits a source action. Once available, the controller's own
 * synchronous fence still governs every picker and every same-turn click. */
export class LazyLiveSourceSelectionController {
  private controller: Controller | null = null
  private loading: Promise<Controller | null> | null = null
  private epoch = 0
  private disposed = false
  private sessionId: string | null | undefined
  private sessionState: RecordingState = 'idle'
  private replayOnly = false

  constructor(
    private readonly options: ConstructorParameters<Module['LiveSourceSelectionController']>[0],
    private readonly load: () => Promise<Module> = () => import('./live-source-selection')
  ) {}

  private ensure(): Promise<Controller | null> {
    if (this.disposed) return Promise.resolve(null)
    if (this.controller) return Promise.resolve(this.controller)
    if (this.loading) return this.loading
    const epoch = this.epoch
    const loading = this.load()
      .then((module) => {
        if (this.disposed || epoch !== this.epoch) return null
        const controller = new module.LiveSourceSelectionController(this.options)
        controller.setSession(this.sessionId, this.sessionState, this.replayOnly)
        this.controller = controller
        return controller
      })
      .finally(() => {
        if (this.loading === loading) this.loading = null
      })
    this.loading = loading
    return loading
  }

  setSession(
    sessionId: string | null | undefined,
    state: RecordingState,
    replayOnly = false
  ): void {
    const effectiveState = replayOnly ? 'idle' : state
    const identity = ['recording', 'streaming', 'starting'].includes(effectiveState)
      ? (sessionId ?? null)
      : null
    const changed =
      identity !== this.sessionId ||
      effectiveState !== this.sessionState ||
      replayOnly !== this.replayOnly
    this.disposed = false
    this.sessionId = identity
    this.sessionState = effectiveState
    this.replayOnly = replayOnly
    if (this.controller) this.controller.setSession(identity, effectiveState, replayOnly)
    else if (changed)
      this.options.changed({ snapshot: null, pending: null, checking: false, error: null })
  }

  reason(kind: SessionSourceKind): string | null {
    if (this.controller) return this.controller.reason(kind)
    if (this.sessionState === 'idle' || this.sessionState === 'failed') return null
    return 'Loading source controls…'
  }

  async refresh(): Promise<void> {
    const epoch = this.epoch
    try {
      await (await this.ensure())?.refresh()
    } catch {
      if (
        !this.disposed &&
        epoch === this.epoch &&
        this.sessionState !== 'idle' &&
        this.sessionState !== 'failed'
      )
        this.options.changed({
          snapshot: null,
          pending: null,
          checking: true,
          error: "Source controls couldn't load. Check again."
        })
    }
  }

  async retryStatus(): Promise<void> {
    const epoch = this.epoch
    try {
      await (await this.ensure())?.retryStatus()
    } catch {
      if (
        !this.disposed &&
        epoch === this.epoch &&
        this.sessionState !== 'idle' &&
        this.sessionState !== 'failed'
      )
        this.options.changed({
          snapshot: null,
          pending: null,
          checking: true,
          error: "Source controls couldn't load. Check again."
        })
    }
  }

  select(...args: Parameters<Controller['select']>): Promise<void> {
    if (!this.controller || this.disposed)
      return Promise.reject(new Error('Source controls are still loading.'))
    return this.controller.select(...args)
  }

  dispose(): void {
    this.disposed = true
    this.epoch += 1
    this.controller?.dispose()
    this.controller = null
    this.loading = null
    this.sessionId = null
    this.sessionState = 'idle'
    this.replayOnly = false
  }
}
