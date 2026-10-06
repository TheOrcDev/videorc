import type { SmokeAppQuitGuard } from './smoke-app-quit-guard'

export const PREVIEW_LIFECYCLE_EVIDENCE_PREFIX = '[smoke] preview-lifecycle-evidence '
export const MAIN_WINDOW_NOT_READY = 'Main window is not ready for preview motion smoke.'

const COMMANDS = [
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
] as const

const RENDERER_GONE_REASONS = [
  'clean-exit',
  'abnormal-exit',
  'killed',
  'crashed',
  'oom',
  'launch-failed',
  'integrity-failure'
] as const

type CommandCategory = (typeof COMMANDS)[number] | 'other-command'
type RendererGoneReason = (typeof RENDERER_GONE_REASONS)[number] | 'unknown'

export type MainOwnerDisposition =
  'absent' | 'window-destroyed' | 'contents-destroyed' | 'ready' | 'unknown'

export type MainOwnerEventKind =
  | 'created'
  | 'close'
  | 'closed-before-cleanup'
  | 'closed-after-cleanup'
  | 'contents-destroyed'
  | 'renderer-gone'
  | 'before-quit-prevented'
  | 'before-quit-allowed'
  | 'quit-allowed'

export interface MainOwnerEvent {
  event: MainOwnerEventKind
  atMs: number
  callbackOwnerIsCurrent: boolean | null
  disposition: MainOwnerDisposition
  quitPrevented: boolean
  appIsQuitting: boolean
  rendererGoneReason?: RendererGoneReason
}

export interface MainCommandFailure {
  command: CommandCategory
  disposition: MainOwnerDisposition
  firstAtMs: number
  lastAtMs: number
  attempts: number
}

export interface MainLifecycleEvidenceSnapshot {
  events: MainOwnerEvent[]
  omittedEvents: number
  failedCommand: MainCommandFailure | null
}

interface MainWindowOwner {
  isDestroyed(): boolean
  on(event: 'close' | 'closed', listener: () => void): unknown
  webContents: {
    isDestroyed(): boolean
    on(event: 'destroyed' | 'render-process-gone', listener: (...args: unknown[]) => void): unknown
  }
}

interface QuitEvent {
  preventDefault(): void
}

interface BeforeQuitApp {
  on(event: 'before-quit', listener: (event: QuitEvent) => void): unknown
}

interface MainLifecycleEvidenceOptions {
  enabled: boolean
  currentMainWindow: () => MainWindowOwner | null
  appIsQuitting: () => boolean
  quitGuard: SmokeAppQuitGuard
  emit: (line: string) => void
  now?: () => number
}

/**
 * Probe-only evidence from the actual callbacks. Object identity is compared
 * transiently and never retained. Readiness refusals retain the first command
 * and disposition separately from the owner ring; attempts counts all later
 * refusals, so retries cannot evict owner evidence or replace the first cause.
 * Diagnostics must never change callback, quit, or readiness behavior.
 */
export class PreviewLifecycleSmokeEvidence {
  private readonly evidence: MainLifecycleEvidenceSnapshot | null

  constructor(private readonly options: MainLifecycleEvidenceOptions) {
    this.evidence = options.enabled ? { events: [], omittedEvents: 0, failedCommand: null } : null
  }

  bindMainWindow(owner: MainWindowOwner, onClosed: () => void): void {
    if (!this.evidence) {
      owner.on('closed', onClosed)
      return
    }
    owner.on('closed', () => {
      this.record('closed-before-cleanup', owner)
      try {
        onClosed()
      } finally {
        this.record('closed-after-cleanup', owner)
      }
    })
    this.observe(() => owner.on('close', () => this.record('close', owner)))
    this.observe(() =>
      owner.webContents.on('destroyed', () => this.record('contents-destroyed', owner))
    )
    this.observe(() =>
      owner.webContents.on('render-process-gone', (_event, details) => {
        this.observe(() => {
          const reason = (details as { reason?: unknown } | undefined)?.reason
          this.record(
            'renderer-gone',
            owner,
            RENDERER_GONE_REASONS.find((candidate) => candidate === reason) ?? 'unknown'
          )
        })
      })
    )
    this.record('created', owner)
  }

  bindBeforeQuit(
    app: BeforeQuitApp,
    callbacks: { onPrevented: () => void; onAllowed: (event: QuitEvent) => void }
  ): void {
    app.on('before-quit', (event) => {
      if (this.options.quitGuard.shouldPreventQuit()) {
        event.preventDefault()
        callbacks.onPrevented()
        this.record('before-quit-prevented')
        return
      }
      try {
        callbacks.onAllowed(event)
      } finally {
        this.record('before-quit-allowed')
      }
    })
  }

  allowQuit(): void {
    this.options.quitGuard.allowQuit()
    this.record('quit-allowed')
  }

  requireMainWindow(mainWindow: MainWindowOwner | null, command: string): asserts mainWindow {
    if (!mainWindow || mainWindow.webContents.isDestroyed()) {
      this.observe(() => {
        if (!this.evidence) return
        const atMs = this.timestamp()
        const previous = this.evidence.failedCommand
        this.evidence.failedCommand = previous
          ? {
              ...previous,
              lastAtMs: atMs,
              attempts: Math.min(Number.MAX_SAFE_INTEGER, previous.attempts + 1)
            }
          : {
              command: COMMANDS.find((candidate) => candidate === command) ?? 'other-command',
              disposition: this.disposition(mainWindow),
              firstAtMs: atMs,
              lastAtMs: atMs,
              attempts: 1
            }
        this.emit()
      })
      throw new Error(MAIN_WINDOW_NOT_READY)
    }
  }

  snapshot(): MainLifecycleEvidenceSnapshot {
    return this.evidence
      ? {
          events: this.evidence.events.map((event) => ({ ...event })),
          omittedEvents: this.evidence.omittedEvents,
          failedCommand: this.evidence.failedCommand ? { ...this.evidence.failedCommand } : null
        }
      : { events: [], omittedEvents: 0, failedCommand: null }
  }

  private observe(callback: () => unknown): void {
    if (!this.evidence) return
    try {
      callback()
    } catch {
      // An observer, clock, or sink failure cannot change the observed action.
    }
  }

  private timestamp(): number {
    const atMs = (this.options.now ?? Date.now)()
    if (!Number.isSafeInteger(atMs) || atMs < 0) throw new Error('Invalid evidence clock.')
    return atMs
  }

  private disposition(owner: MainWindowOwner | null): MainOwnerDisposition {
    if (!owner) return 'absent'
    if (owner.isDestroyed()) return 'window-destroyed'
    if (owner.webContents.isDestroyed()) return 'contents-destroyed'
    return 'ready'
  }

  private record(
    event: MainOwnerEventKind,
    owner?: MainWindowOwner,
    rendererGoneReason?: RendererGoneReason
  ): void {
    this.observe(() => {
      if (!this.evidence) return
      const current = this.options.currentMainWindow()
      this.evidence.events.push({
        event,
        atMs: this.timestamp(),
        callbackOwnerIsCurrent: owner ? current === owner : null,
        disposition: this.disposition(current),
        quitPrevented: this.options.quitGuard.shouldPreventQuit(),
        appIsQuitting: this.options.appIsQuitting(),
        ...(rendererGoneReason ? { rendererGoneReason } : {})
      })
      if (this.evidence.events.length > 32) {
        this.evidence.events.shift()
        this.evidence.omittedEvents = Math.min(
          Number.MAX_SAFE_INTEGER,
          this.evidence.omittedEvents + 1
        )
      }
      this.emit()
    })
  }

  private emit(): void {
    this.options.emit(PREVIEW_LIFECYCLE_EVIDENCE_PREFIX + JSON.stringify(this.snapshot()))
  }
}
