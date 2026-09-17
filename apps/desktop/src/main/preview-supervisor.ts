import type {
  NativePreviewHostKind,
  PreviewLifecycleBacking,
  PreviewLifecycleState,
  PreviewLifecycleTransport,
  PreviewPermissionStatus,
  PreviewSupervisorState
} from '../shared/backend'
import { isNativePreviewCapability } from '../shared/native-preview-capability'

export interface PreviewSupervisorOptions {
  now?: () => string
  platform?: NodeJS.Platform
}

export interface PreviewSurfaceLiveEvent {
  generation: number
  transport: PreviewLifecycleTransport
  backing: PreviewLifecycleBacking
  nativePreviewHostKind?: NativePreviewHostKind
}

export interface PreviewPermissionEvent {
  generation: number
  permissionStatus: Exclude<PreviewPermissionStatus, 'ok'>
  message?: string
}

export interface PreviewFailureEvent {
  generation: number
  message: string
}

export class PreviewSupervisorModel {
  private state: PreviewSupervisorState
  private readonly now: () => string
  private readonly platform: NodeJS.Platform

  constructor(options: PreviewSupervisorOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString())
    this.platform = options.platform ?? process.platform
    this.state = this.closedState(0)
  }

  snapshot(): PreviewSupervisorState {
    return { ...this.state }
  }

  openWindow(): PreviewSupervisorState {
    if (
      this.state.lifecycleState === 'opening-window' ||
      this.state.lifecycleState === 'open-no-surface' ||
      this.state.lifecycleState === 'starting-surface' ||
      this.state.lifecycleState === 'surface-live' ||
      this.state.lifecycleState === 'surface-fallback' ||
      this.state.lifecycleState === 'permission-required'
    ) {
      return this.snapshot()
    }

    return this.transition({
      lifecycleState: 'opening-window',
      generation: this.state.generation + 1,
      windowOpen: false,
      windowVisible: false,
      surfaceRequested: false,
      surfaceActive: false,
      transport: 'none',
      backing: 'none',
      nativePreviewHostKind: undefined,
      permissionStatus: 'ok',
      fallbackReason: undefined,
      lastError: undefined
    })
  }

  windowOpened(visible = true): PreviewSupervisorState {
    if (this.state.lifecycleState !== 'opening-window') {
      return this.snapshot()
    }

    return this.transition({
      lifecycleState: 'open-no-surface',
      windowOpen: true,
      windowVisible: visible
    })
  }

  setWindowVisible(visible: boolean): PreviewSupervisorState {
    if (!this.state.windowOpen || this.state.lifecycleState === 'closed') {
      return this.snapshot()
    }

    return this.transition({ windowVisible: visible })
  }

  requestSurface(): PreviewSupervisorState {
    if (!this.state.windowOpen || this.state.lifecycleState === 'closing') {
      return this.snapshot()
    }

    if (this.state.lifecycleState === 'permission-required') {
      return this.snapshot()
    }

    return this.transition({
      lifecycleState: 'starting-surface',
      surfaceRequested: true,
      surfaceActive: false,
      transport: 'none',
      backing: 'none',
      nativePreviewHostKind: undefined,
      permissionStatus: 'ok',
      fallbackReason: undefined,
      lastError: undefined
    })
  }

  surfaceLive(event: PreviewSurfaceLiveEvent): PreviewSupervisorState {
    if (!this.acceptsSurfaceEvent(event.generation)) {
      return this.snapshot()
    }

    if (
      event.transport === 'none' ||
      event.transport === 'unknown' ||
      event.backing === 'unknown' ||
      !isNativePreviewCapability(
        {
          transport: event.transport,
          backing: event.backing,
          nativePreviewHostKind: event.nativePreviewHostKind
        },
        this.platform
      )
    ) {
      return this.transition({
        lifecycleState: 'surface-fallback',
        surfaceRequested: true,
        surfaceActive: false,
        transport: 'electron-proof-surface',
        backing: 'electron-browser-window',
        nativePreviewHostKind: 'proof-surface',
        permissionStatus: 'ok',
        fallbackReason: `Preview transport ${event.transport}/${event.backing} is not native on ${this.platform}.`,
        lastError: undefined
      })
    }

    return this.transition({
      lifecycleState: 'surface-live',
      surfaceRequested: true,
      surfaceActive: true,
      transport: event.transport,
      backing: event.backing,
      nativePreviewHostKind: event.nativePreviewHostKind,
      permissionStatus: 'ok',
      fallbackReason: undefined,
      lastError: undefined
    })
  }

  surfaceFallback(generation: number, reason: string): PreviewSupervisorState {
    if (!this.acceptsSurfaceEvent(generation)) {
      return this.snapshot()
    }

    return this.transition({
      lifecycleState: 'surface-fallback',
      surfaceRequested: true,
      surfaceActive: false,
      transport: 'electron-proof-surface',
      backing: 'electron-browser-window',
      nativePreviewHostKind: 'proof-surface',
      permissionStatus: 'ok',
      fallbackReason: reason,
      lastError: undefined
    })
  }

  permissionRequired(event: PreviewPermissionEvent): PreviewSupervisorState {
    if (!this.acceptsPreviewEvent(event.generation)) {
      return this.snapshot()
    }

    return this.transition({
      lifecycleState: 'permission-required',
      surfaceRequested: false,
      surfaceActive: false,
      transport: 'none',
      backing: 'none',
      nativePreviewHostKind: undefined,
      permissionStatus: event.permissionStatus,
      fallbackReason: undefined,
      lastError: event.message
    })
  }

  surfaceFailed(event: PreviewFailureEvent): PreviewSupervisorState {
    if (!this.acceptsSurfaceEvent(event.generation)) {
      return this.snapshot()
    }

    return this.transition({
      lifecycleState: 'failed',
      surfaceRequested: false,
      surfaceActive: false,
      transport: 'none',
      backing: 'none',
      nativePreviewHostKind: undefined,
      lastError: event.message
    })
  }

  closeWindow(): PreviewSupervisorState {
    if (this.state.lifecycleState === 'closed') {
      return this.snapshot()
    }

    if (this.state.lifecycleState === 'closing') {
      return this.snapshot()
    }

    return this.transition({
      lifecycleState: 'closing',
      windowVisible: false,
      surfaceRequested: false,
      surfaceActive: false,
      transport: 'none',
      backing: 'none',
      nativePreviewHostKind: undefined
    })
  }

  finishClose(generation: number): PreviewSupervisorState {
    if (generation !== this.state.generation || this.state.lifecycleState !== 'closing') {
      return this.snapshot()
    }

    this.state = this.closedState(generation)
    return this.snapshot()
  }

  private acceptsSurfaceEvent(generation: number): boolean {
    return (
      generation === this.state.generation &&
      this.state.surfaceRequested &&
      this.state.lifecycleState !== 'closing' &&
      this.state.lifecycleState !== 'closed' &&
      this.state.lifecycleState !== 'permission-required'
    )
  }

  private acceptsPreviewEvent(generation: number): boolean {
    return (
      generation === this.state.generation &&
      this.state.windowOpen &&
      this.state.lifecycleState !== 'closing' &&
      this.state.lifecycleState !== 'closed' &&
      this.state.lifecycleState !== 'permission-required'
    )
  }

  private transition(
    patch: Omit<Partial<PreviewSupervisorState>, 'updatedAt'>
  ): PreviewSupervisorState {
    this.state = {
      ...this.state,
      ...patch,
      updatedAt: this.now()
    }
    return this.snapshot()
  }

  private closedState(generation: number): PreviewSupervisorState {
    return {
      lifecycleState: 'closed',
      generation,
      windowOpen: false,
      windowVisible: false,
      surfaceRequested: false,
      surfaceActive: false,
      transport: 'none',
      backing: 'none',
      nativePreviewHostKind: undefined,
      permissionStatus: 'ok',
      updatedAt: this.now()
    }
  }
}

export function isPreviewTerminalState(state: PreviewLifecycleState): boolean {
  return state === 'closed' || state === 'failed' || state === 'permission-required'
}

export type PreviewWindowTargetAction = 'none' | 'open' | 'close'

/** Resolve a toggle or explicit target into an idempotent window action. */
export function previewWindowTargetAction(
  currentOpen: boolean,
  expectedOpen?: boolean
): PreviewWindowTargetAction {
  const targetOpen = expectedOpen ?? !currentOpen
  if (targetOpen === currentOpen) {
    return 'none'
  }
  return targetOpen ? 'open' : 'close'
}
