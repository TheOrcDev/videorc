import { useEffect, useState, useSyncExternalStore, type RefObject } from 'react'

import {
  ROOM_PROGRAM_CAMERA_HEIGHT,
  ROOM_PROGRAM_CAMERA_WIDTH
} from '../../../shared/room-program-camera'
import {
  RoomProgramCameraProducer,
  RoomProgramCameraStore,
  type RoomProgramCameraState
} from '@/lib/room-program-camera'

// Plan 249 S23 (D10): the room program on Videorc Camera. Lazy (the Show
// stage and the room host import it), so the eager bundle carries nothing.

/** The one opt-in per Studio window; its uploads live in main. */
export const roomProgramCamera = new RoomProgramCameraStore(() =>
  typeof window !== 'undefined' && window.videorc ? window.videorc : null
)

export function useRoomProgramCamera(): RoomProgramCameraState {
  return useSyncExternalStore(roomProgramCamera.subscribe, roomProgramCamera.snapshot)
}

/** Whether this run offers it at all (an unpackaged, opted-in development run). */
export function useRoomProgramCameraAvailable(): boolean {
  const [available, setAvailable] = useState(false)
  useEffect(() => {
    let cancelled = false
    void window.videorc
      ?.roomProgramCameraAvailable?.()
      .then((value) => {
        if (!cancelled) setAvailable(value === true)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])
  return available
}

/** Send the Program preview's frames while the opt-in has an open upload. */
export function useRoomProgramCameraProducer(
  container: RefObject<HTMLElement | null>,
  generation: number | null
): void {
  useEffect(() => {
    const api = window.videorc
    if (generation === null || !api?.sendRoomProgramCameraFrame) return
    const canvas = document.createElement('canvas')
    canvas.width = ROOM_PROGRAM_CAMERA_WIDTH
    canvas.height = ROOM_PROGRAM_CAMERA_HEIGHT
    // CPU-backed: one readback per frame, no GPU round trip per pixel read.
    const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true })
    const producer = new RoomProgramCameraProducer(generation, {
      container: () => container.current,
      context: () => context,
      send: (frame) => api.sendRoomProgramCameraFrame(frame),
      onClosed: (closed) => void roomProgramCamera.reopen(closed).catch(() => {})
    })
    producer.start()
    if (import.meta.env.DEV) {
      const smokeWindow = window as Window & {
        __videorcRoomProgramCameraStats?: () => typeof producer.stats
      }
      smokeWindow.__videorcRoomProgramCameraStats = () => ({ ...producer.stats })
    }
    return () => producer.stop()
  }, [container, generation])
}
