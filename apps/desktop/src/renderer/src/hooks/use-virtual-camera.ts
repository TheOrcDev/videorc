import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

import type { BackendClient } from '@/backendClient'
import type {
  CompositorFramePipelineStatus,
  VirtualCameraAction,
  VirtualCameraActionResult,
  VirtualCameraStatus
} from '@/lib/backend'
import { OFFLINE_LOCK_REASON } from '@/lib/lock-reason'
import { toast } from '@/lib/toast'
import { toastUserError, userErrorMessage } from '@/lib/user-error'

/** A failed switch from ⌘K: its own id, so it never replaces the stop toast. */
const VIDEORC_CAMERA_SWITCH_TOAST_ID = 'virtual-camera-switch'
/** Outside a Studio (a test, a window without one) the camera can't change. */
const NOT_IN_THIS_STUDIO = "Videorc Camera isn't available in this Studio."
const NOT_ON_THIS_COMPUTER = "Videorc Camera isn't available on this computer."

// Videorc Camera (plan 214 E): the backend's status (A4) as the Studio holds
// it, the switch, and main's actions. Its own small context, so the status
// reaches only the surfaces that show the camera (Output, ⌘K, Health) and a
// test can render any of them without a Studio. Without a provider the
// camera is unknown, and every surface hides it.

export interface VirtualCameraControls {
  /** The backend's status; null until it answers, or on a backend without it. */
  status: VirtualCameraStatus | null
  /** The Studio's link to Videorc is up. */
  connected: boolean
  platform: string | undefined
  /** `os.release()`: the Darwin version on macOS, which names the approval path. */
  osRelease: string | undefined
  /**
   * The switch: `virtualCamera.set`. No toast when it works: the row is the
   * confirmation. A caller with no row in view (⌘K) asks for the error toast.
   */
  setOn: (on: boolean, options?: { toastFailure?: boolean }) => Promise<VirtualCameraActionResult>
  /** One action in main: System Settings, removal, setup, the module load. */
  runAction: (action: VirtualCameraAction) => Promise<VirtualCameraActionResult>
  /** Health's counters, read from the compositor's status on demand. */
  readFramePipeline: () => Promise<CompositorFramePipelineStatus | null>
}

const UNKNOWN: VirtualCameraControls = Object.freeze({
  status: null,
  connected: false,
  platform: undefined,
  osRelease: undefined,
  setOn: async () => ({ ok: false, message: NOT_IN_THIS_STUDIO }),
  runAction: async () => ({ ok: false, message: NOT_IN_THIS_STUDIO }),
  readFramePipeline: async () => null
})

export const VirtualCameraContext = createContext<VirtualCameraControls>(UNKNOWN)

/** The camera as the Studio holds it, or the unknown camera outside one. */
export function useVirtualCamera(): VirtualCameraControls {
  return useContext(VirtualCameraContext)
}

export function useVirtualCameraController(
  client: BackendClient | null,
  connectionState: string,
  runtime: { platform?: string; osRelease?: string } | null
): VirtualCameraControls {
  const [status, setStatus] = useState<VirtualCameraStatus | null>(null)
  const statusRef = useRef<VirtualCameraStatus | null>(null)
  const revision = useRef(0)
  const platform = runtime?.platform
  const osRelease = runtime?.osRelease
  const platformRef = useRef({ platform, osRelease })
  platformRef.current = { platform, osRelease }
  const connected = Boolean(client) && connectionState === 'connected'

  // Every status goes through here: the one stop toast (E1) is decided from
  // the status before and after, never from the streamer's own switch. The
  // words load with the first status, out of the eager Studio bundle; the
  // steps keep their order (one module promise, callbacks in turn).
  const commit = useCallback((next: VirtualCameraStatus) => {
    const previous = statusRef.current
    statusRef.current = next
    setStatus(next)
    void import('@/lib/virtual-camera-view').then((view) => {
      const step = view.virtualCameraToastStep(previous, next, platformRef.current)
      if (step.kind === 'show') {
        toast.warning(step.title, {
          id: view.VIDEORC_CAMERA_TOAST_ID,
          description: step.description,
          // It mirrors a state still true: it stays until the camera is back.
          duration: Number.POSITIVE_INFINITY
        })
      } else if (step.kind === 'dismiss') {
        toast.dismiss(view.VIDEORC_CAMERA_TOAST_ID)
      }
    })
  }, [])

  useEffect(() => {
    if (!client || connectionState !== 'connected') return
    let active = true
    const read = () => {
      const expected = ++revision.current
      void client
        .requestTyped('virtualCamera.status')
        .then((value) => {
          if (active && expected === revision.current) commit(value)
        })
        // A backend without the camera answers nothing; the camera stays hidden.
        .catch((error) => console.warn('[virtual-camera] status failed', error))
    }
    const off = client.on('virtualCamera.changed', (value) => {
      ++revision.current
      if (active) commit(value)
    })
    read()
    return () => {
      active = false
      off()
    }
  }, [client, connectionState, commit])

  const setOn = useCallback(
    async (
      on: boolean,
      options?: { toastFailure?: boolean }
    ): Promise<VirtualCameraActionResult> => {
      if (!client || connectionState !== 'connected') {
        return { ok: false, message: OFFLINE_LOCK_REASON }
      }
      const expected = ++revision.current
      try {
        const next = await client.requestTyped('virtualCamera.set', { on })
        if (expected === revision.current) commit(next)
        return { ok: true }
      } catch (error) {
        const context = { action: on ? 'turn on' : 'turn off', object: 'Videorc Camera' }
        const copy = options?.toastFailure
          ? toastUserError(error, context, { id: VIDEORC_CAMERA_SWITCH_TOAST_ID })
          : userErrorMessage(error, context)
        console.warn(`[virtual-camera] ${copy.title}:`, copy.raw || error)
        return { ok: false, message: copy.text }
      }
    },
    [client, connectionState, commit]
  )

  const runAction = useCallback(
    async (action: VirtualCameraAction): Promise<VirtualCameraActionResult> => {
      const run = window.videorc?.virtualCameraAction
      if (!run) return { ok: false, message: NOT_ON_THIS_COMPUTER }
      try {
        return await run(action)
      } catch (error) {
        console.warn('[virtual-camera] action failed', action, error)
        return { ok: false, message: "Couldn't do that. Try again in a moment." }
      }
    },
    []
  )

  const readFramePipeline = useCallback(async () => {
    if (!client || connectionState !== 'connected') return null
    try {
      return (await client.requestTyped('compositor.status')).framePipeline ?? null
    } catch {
      return null
    }
  }, [client, connectionState])

  return useMemo(
    () => ({ status, connected, platform, osRelease, setOn, runAction, readFramePipeline }),
    [status, connected, platform, osRelease, setOn, runAction, readFramePipeline]
  )
}
