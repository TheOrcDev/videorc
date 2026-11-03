// Plan 214 B3: Videorc Camera's system extension, activated from Electron
// main. macOS looks the extension up in the requesting process's bundle, so
// the request has to come from the app itself; the native addon makes the
// OSSystemExtensionRequest and reports every step back here. This module is
// the one place main keeps the extension's state. It never touches the
// camera switch itself: that setting and the RPC that receives this state
// belong to the backend (plan 214 A4, see `onState`).
//
// Turning the camera off never deactivates (D12: the extension draws the
// "off" still). Deactivation exists for Health, "Remove Videorc Camera".

import identifiers from '../../camera-extension/identifiers.json'

/** `dev.theorcdev.videorc.camera`, from the one identifiers file. */
export const CAMERA_EXTENSION_IDENTIFIER: string = identifiers.extensionBundleId

/** A lab aid until A4 lands: activate at launch without the switch. */
export const CAMERA_EXTENSION_ACTIVATE_AT_LAUNCH_ENV = 'VIDEORC_CAMERA_EXTENSION_ACTIVATE_AT_LAUNCH'

export type CameraExtensionAction = 'activate' | 'deactivate'

export type CameraExtensionUpdateKind =
  | 'needs-approval'
  | 'replacing'
  | 'completed'
  | 'will-complete-after-reboot'
  | 'failed'

/** One step of a request, as the addon reports it. */
export interface CameraExtensionUpdate {
  kind: CameraExtensionUpdateKind
  action: CameraExtensionAction
  identifier: string
  code?: number | null
  codeName?: string | null
  reason?: string | null
  detail?: string | null
  existingVersion?: string | null
  newVersion?: string | null
}

export type CameraExtensionPhase =
  /** No request has been made in this launch. */
  | 'idle'
  /** This build or platform cannot host the extension; `reason` says why. */
  | 'unavailable'
  | 'activating'
  /** macOS is waiting for the person to allow it in System Settings. */
  | 'needs-approval'
  /** An update is replacing an older installed copy. */
  | 'replacing'
  | 'active'
  /** Activated, but live only after the next restart. */
  | 'reboot-required'
  | 'deactivating'
  | 'removed'
  | 'failed'

export interface CameraExtensionState {
  phase: CameraExtensionPhase
  /** The request that produced this phase. */
  action: CameraExtensionAction | null
  /** Plain copy for `failed` and `unavailable`. */
  reason: string | null
  code: number | null
  codeName: string | null
  /** The system's own words, for diagnostics. */
  detail: string | null
  existingVersion: string | null
  newVersion: string | null
  updatedAt: number
}

export interface CameraExtensionBinding {
  activateCameraExtension(
    identifier: string,
    callback: (update: CameraExtensionUpdate) => void
  ): void
  deactivateCameraExtension(
    identifier: string,
    callback: (update: CameraExtensionUpdate) => void
  ): void
}

export type CameraExtensionAvailability = { available: true } | { available: false; reason: string }

export interface CameraExtensionController {
  readonly identifier: string
  availability(): CameraExtensionAvailability
  state(): CameraExtensionState
  /**
   * Submits an activation request. Resolves at the first update that leaves
   * the request waiting on the person or finishes it (`needs-approval`,
   * `completed`, `will-complete-after-reboot`, `failed`); a later approval
   * still updates `state()` and reaches `onState`. A second call while one
   * is pending joins it.
   */
  activate(): Promise<CameraExtensionState>
  deactivate(): Promise<CameraExtensionState>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

const UPDATE_KINDS: readonly CameraExtensionUpdateKind[] = [
  'needs-approval',
  'replacing',
  'completed',
  'will-complete-after-reboot',
  'failed'
]

/** Reads the addon's camera exports; null when it predates them. */
export function cameraExtensionBindingFromModule(
  moduleValue: unknown
): CameraExtensionBinding | null {
  const candidate =
    isRecord(moduleValue) && isRecord(moduleValue.default) ? moduleValue.default : moduleValue
  if (
    !isRecord(candidate) ||
    typeof candidate.activateCameraExtension !== 'function' ||
    typeof candidate.deactivateCameraExtension !== 'function'
  ) {
    return null
  }
  const activate = candidate.activateCameraExtension as (
    identifier: string,
    callback: (update: unknown) => void
  ) => void
  const deactivate = candidate.deactivateCameraExtension as (
    identifier: string,
    callback: (update: unknown) => void
  ) => void
  const forward =
    (callback: (update: CameraExtensionUpdate) => void) =>
    (raw: unknown): void => {
      const update = normalizeUpdate(raw)
      if (update) callback(update)
    }
  return {
    activateCameraExtension: (identifier, callback) => activate(identifier, forward(callback)),
    deactivateCameraExtension: (identifier, callback) => deactivate(identifier, forward(callback))
  }
}

/** Pure. A defensive read of one addon update; null for anything malformed. */
export function normalizeUpdate(raw: unknown): CameraExtensionUpdate | null {
  if (!isRecord(raw)) return null
  const kind = raw.kind
  const action = raw.action
  if (
    typeof kind !== 'string' ||
    !UPDATE_KINDS.includes(kind as CameraExtensionUpdateKind) ||
    (action !== 'activate' && action !== 'deactivate') ||
    typeof raw.identifier !== 'string'
  ) {
    return null
  }
  const text = (value: unknown): string | null => (typeof value === 'string' ? value : null)
  return {
    kind: kind as CameraExtensionUpdateKind,
    action,
    identifier: raw.identifier,
    code: typeof raw.code === 'number' ? raw.code : null,
    codeName: text(raw.codeName),
    reason: text(raw.reason),
    detail: text(raw.detail),
    existingVersion: text(raw.existingVersion),
    newVersion: text(raw.newVersion)
  }
}

/** Pure. Why this process cannot host the extension, or that it can. */
export function cameraExtensionAvailability(options: {
  platform: string
  isPackaged: boolean
  binding: CameraExtensionBinding | null
}): CameraExtensionAvailability {
  if (options.platform !== 'darwin') {
    return { available: false, reason: "Videorc Camera's extension exists on macOS only." }
  }
  if (!options.isPackaged) {
    return {
      available: false,
      reason:
        'The dev app carries no Videorc Camera extension. Use a Developer ID signed packaged build in the Applications folder.'
    }
  }
  if (!options.binding) {
    return {
      available: false,
      reason:
        'The native addon has no activateCameraExtension export. Rebuild it with pnpm build:native-preview-addon.'
    }
  }
  return { available: true }
}

/**
 * Pure. Apple asks for the activation "as early as possible" so an update
 * replaces the old extension at launch: on when the saved switch is on
 * (plan 214 A4 supplies it) or when the lab aid is set.
 */
export function shouldActivateCameraExtensionAtLaunch(options: {
  availability: CameraExtensionAvailability
  switchOn: boolean
  env?: NodeJS.ProcessEnv
}): boolean {
  if (!options.availability.available) return false
  if (options.switchOn) return true
  return (options.env ?? process.env)[CAMERA_EXTENSION_ACTIVATE_AT_LAUNCH_ENV]?.trim() === '1'
}

/** Pure. The next state for one addon update. */
export function applyCameraExtensionUpdate(
  update: CameraExtensionUpdate,
  now: number
): CameraExtensionState {
  const base: CameraExtensionState = {
    phase: 'idle',
    action: update.action,
    reason: null,
    code: null,
    codeName: null,
    detail: null,
    existingVersion: null,
    newVersion: null,
    updatedAt: now
  }
  switch (update.kind) {
    case 'needs-approval':
      return { ...base, phase: 'needs-approval' }
    case 'replacing':
      return {
        ...base,
        phase: 'replacing',
        existingVersion: update.existingVersion ?? null,
        newVersion: update.newVersion ?? null
      }
    case 'completed':
      return { ...base, phase: update.action === 'activate' ? 'active' : 'removed' }
    case 'will-complete-after-reboot':
      return { ...base, phase: 'reboot-required' }
    case 'failed':
      return {
        ...base,
        phase: 'failed',
        reason: update.reason ?? 'macOS reported an error installing Videorc Camera.',
        code: update.code ?? null,
        codeName: update.codeName ?? null,
        detail: update.detail ?? null
      }
  }
}

/** Pure. The updates that settle an `activate()` or `deactivate()` promise. */
export function updateSettlesRequest(kind: CameraExtensionUpdateKind): boolean {
  return kind !== 'replacing'
}

export function createCameraExtensionController(options: {
  platform: string
  isPackaged: boolean
  binding: CameraExtensionBinding | null
  identifier?: string
  now?: () => number
  log?: (line: string) => void
  /**
   * Every state change. Plan 214 A4 wires this to the backend's
   * `virtual_camera` RPC so the Output page can show the approval path.
   */
  onState?: (state: CameraExtensionState) => void
}): CameraExtensionController {
  const identifier = options.identifier ?? CAMERA_EXTENSION_IDENTIFIER
  const now = options.now ?? Date.now
  const log = options.log ?? (() => {})
  const availability = cameraExtensionAvailability(options)
  let generation = 0
  let state: CameraExtensionState = {
    phase: availability.available ? 'idle' : 'unavailable',
    action: null,
    reason: availability.available ? null : availability.reason,
    code: null,
    codeName: null,
    detail: null,
    existingVersion: null,
    newVersion: null,
    updatedAt: now()
  }
  let pending: { action: CameraExtensionAction; promise: Promise<CameraExtensionState> } | null =
    null

  const setState = (next: CameraExtensionState): CameraExtensionState => {
    state = next
    log(
      `Videorc Camera extension: ${next.phase}${next.reason ? ` (${next.reason})` : ''}${next.codeName ? ` [${next.codeName}]` : ''}`
    )
    options.onState?.(next)
    return next
  }

  const request = (action: CameraExtensionAction): Promise<CameraExtensionState> => {
    if (!availability.available || !options.binding) {
      return Promise.resolve(
        setState({
          ...state,
          phase: 'unavailable',
          action,
          reason: availability.available ? null : availability.reason,
          updatedAt: now()
        })
      )
    }
    if (pending?.action === action) {
      return pending.promise
    }
    const binding = options.binding
    const thisGeneration = ++generation
    const promise = new Promise<CameraExtensionState>((resolve) => {
      let settled = false
      const settle = (next: CameraExtensionState): void => {
        if (settled) return
        settled = true
        pending = null
        resolve(next)
      }
      setState({
        phase: action === 'activate' ? 'activating' : 'deactivating',
        action,
        reason: null,
        code: null,
        codeName: null,
        detail: null,
        existingVersion: null,
        newVersion: null,
        updatedAt: now()
      })
      try {
        const submit =
          action === 'activate'
            ? binding.activateCameraExtension.bind(binding)
            : binding.deactivateCameraExtension.bind(binding)
        submit(identifier, (update) => {
          // A newer request owns the state; an older one's late words are dropped.
          if (thisGeneration !== generation) return
          const next = setState(applyCameraExtensionUpdate(update, now()))
          if (updateSettlesRequest(update.kind)) settle(next)
        })
      } catch (error) {
        settle(
          setState({
            phase: 'failed',
            action,
            reason: `Videorc Camera could not be ${action === 'activate' ? 'activated' : 'removed'}: ${error instanceof Error ? error.message : String(error)}`,
            code: null,
            codeName: 'addon',
            detail: null,
            existingVersion: null,
            newVersion: null,
            updatedAt: now()
          })
        )
      }
    })
    pending = { action, promise }
    return promise
  }

  return {
    identifier,
    availability: () => availability,
    state: () => state,
    activate: () => request('activate'),
    deactivate: () => request('deactivate')
  }
}
