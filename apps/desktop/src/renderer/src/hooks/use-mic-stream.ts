import { useEffect, useState } from 'react'

import type { MediaAccessStatus } from '@/lib/backend'
import { createMicStreamController, microphoneStreamAcquisitionEnabled } from '@/lib/mic-stream'

export type MicStreamStatus = 'idle' | 'acquiring' | 'active' | 'unavailable'

export type MicStream = {
  /** The open visual-only stream, or null while unavailable/acquiring. */
  stream: MediaStream | null
  /** True while a stream is open. */
  active: boolean
  /** Honest lifecycle state — 'unavailable' means permission/in-use, not an error. */
  status: MicStreamStatus
}

/**
 * One shared acquisition point for every mic visual (mixer meter, bar
 * visualizer, picker preview): opens the backend-named device through
 * createMicStreamController and guarantees teardown on disable/unmount.
 * Failures resolve to an inactive meter, never a toast — the backend's 1 Hz
 * micLiveLevel remains the fallback authority for callers.
 */
export function useMicStream(input: {
  /** Backend name of the selected microphone; matched to WebAudio by label. */
  deviceName: string | undefined
  /** Exact OS access status; only `granted` may start a Chromium stream. */
  permissionStatus: MediaAccessStatus | undefined
  enabled: boolean
}): MicStream {
  const { deviceName, enabled, permissionStatus } = input
  const acquisitionEnabled = microphoneStreamAcquisitionEnabled(enabled, permissionStatus)
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [status, setStatus] = useState<MicStreamStatus>('idle')

  useEffect(() => {
    if (!acquisitionEnabled) {
      setStream(null)
      setStatus('idle')
      return
    }
    let disposed = false
    setStatus('acquiring')
    const controller = createMicStreamController<MediaStream>(navigator.mediaDevices)
    void controller.open(deviceName).then((opened) => {
      if (disposed) {
        return
      }
      setStream(opened)
      setStatus(opened ? 'active' : 'unavailable')
    })
    return () => {
      disposed = true
      controller.close()
      setStream(null)
    }
  }, [acquisitionEnabled, deviceName])

  return { stream, active: stream !== null, status }
}
