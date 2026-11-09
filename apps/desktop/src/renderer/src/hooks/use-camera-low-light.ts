import { useCallback, useEffect, useRef, useState } from 'react'

import type { CameraLowLightState } from '@/lib/backend'
import { cameraLowLightReadRetryDelayMs } from '@/lib/camera-low-light'
import { toastUserError } from '@/lib/user-error'

/**
 * Reads (no `compensation`) or saves a camera's low-light compensation. The
 * Studio provider owns the backend client and hands this out
 * (`requestCameraLowLight`).
 */
export type CameraLowLightRequest = (params: {
  cameraId: string
  compensation?: boolean
}) => Promise<CameraLowLightState>

/**
 * The selected camera's low-light compensation (issue #1066), for the Sources
 * camera row. It lives with that row, in the lazy Sources chunk, not in the
 * eager Studio provider.
 *
 * The camera is read whenever it, the connection or the client changes. A
 * camera without the control leaves `state.supported` false, which hides the
 * switch. A failed read (a stalled camera, a driver error) is asked again
 * with backoff, and clears the state only once the retries run out. An answer
 * for an older camera or request is dropped.
 */
export function useCameraLowLight({
  cameraId,
  connected,
  request
}: {
  cameraId: string | undefined
  connected: boolean
  request: CameraLowLightRequest
}): {
  state: CameraLowLightState | null
  pending: boolean
  setCompensation: (compensation: boolean) => Promise<void>
} {
  const [state, setState] = useState<CameraLowLightState | null>(null)
  const [pending, setPending] = useState(false)
  const revisionRef = useRef(0)
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  /**
   * Reads the camera's state. An answer for an older camera or request is
   * dropped, and a failed read retries on the backoff schedule.
   */
  const read = useCallback(
    (id: string, revision: number, failures = 0) => {
      request({ cameraId: id })
        .then((answer) => {
          if (revision === revisionRef.current) setState(answer)
        })
        .catch(() => {
          if (revision !== revisionRef.current) return
          const delay = cameraLowLightReadRetryDelayMs(failures + 1)
          if (delay === null) {
            setState(null)
            return
          }
          retryTimer.current = setTimeout(() => {
            retryTimer.current = null
            if (revision === revisionRef.current) read(id, revision, failures + 1)
          }, delay)
        })
    },
    [request]
  )

  useEffect(() => {
    const revision = ++revisionRef.current
    if (!connected || !cameraId) {
      setState(null)
      return
    }
    read(cameraId, revision)
    return () => {
      if (retryTimer.current) clearTimeout(retryTimer.current)
      retryTimer.current = null
    }
  }, [cameraId, connected, read])

  /**
   * Saves the selected camera's choice. A failure toasts and reads the saved
   * state back, and `pending` holds the switch disabled while the save runs.
   */
  const setCompensation = useCallback(
    async (compensation: boolean) => {
      if (!cameraId) return
      const revision = ++revisionRef.current
      setPending(true)
      try {
        const answer = await request({ cameraId, compensation })
        if (revision === revisionRef.current) setState(answer)
      } catch (error) {
        toastUserError(error, {
          action: compensation ? 'turn on' : 'turn off',
          object: 'low-light compensation'
        })
        // The save may have landed before the failure: show what is stored.
        read(cameraId, revision)
      } finally {
        setPending(false)
      }
    },
    [cameraId, request, read]
  )

  return { state, pending, setCompensation }
}
