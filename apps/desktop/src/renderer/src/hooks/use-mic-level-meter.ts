import { useCallback, useEffect, useRef, useState } from 'react'

import {
  INITIAL_METER_BALLISTICS,
  advanceMeterBallistics,
  amplitudeToDb,
  dbToMeterLevel,
  matchMicrophoneDeviceId,
  samplesRmsAndPeak,
  type MeterBallisticsState
} from '@/lib/mic-meter'

const PEAK_DB_LABEL_INTERVAL_MS = 250

export type MicLevelMeter = {
  /** Attach the meter fill element; its width is driven imperatively at rAF rate. */
  fillRef: (element: HTMLSpanElement | null) => void
  /** Attach the peak-hold marker element; its left offset is driven imperatively. */
  peakRef: (element: HTMLSpanElement | null) => void
  /** True while the WebAudio analyser is metering the selected device. */
  active: boolean
  /** Peak dBFS for the text label, throttled to ~4Hz of React state. */
  peakDb: number | null
}

/**
 * Real-time mic meter (2026-07-10 report: the mixer bar moved once a second
 * and barely at all). The VISUAL runs on a renderer-side WebAudio analyser at
 * display rate, writing element styles directly — React state, the 1 Hz
 * telemetry commit throttle, and the backend diagnostics tick are all
 * bypassed. The backend's `micLiveLevel` stays the capture/health authority
 * and the mixer's fallback when the analyser cannot run (permission denied,
 * exclusive-mode device): shared-mode capture means this analyser coexists
 * with the backend's CoreAudio/dshow session capture.
 */
export function useMicLevelMeter(input: {
  /** Backend name of the selected microphone; matched to WebAudio by label. */
  deviceName: string | undefined
  enabled: boolean
  /** Backend mute is applied at capture gain; the analyser sees pre-mute signal. */
  muted: boolean
}): MicLevelMeter {
  const { deviceName, enabled, muted } = input
  const [active, setActive] = useState(false)
  const [peakDb, setPeakDb] = useState<number | null>(null)
  const fillElementRef = useRef<HTMLSpanElement | null>(null)
  const peakElementRef = useRef<HTMLSpanElement | null>(null)
  const mutedRef = useRef(muted)
  mutedRef.current = muted

  const fillRef = useCallback((element: HTMLSpanElement | null) => {
    fillElementRef.current = element
  }, [])
  const peakRef = useCallback((element: HTMLSpanElement | null) => {
    peakElementRef.current = element
  }, [])

  useEffect(() => {
    if (!enabled) {
      setActive(false)
      setPeakDb(null)
      return
    }

    let disposed = false
    let frame = 0
    let stream: MediaStream | null = null
    let context: AudioContext | null = null

    const stopStream = (): void => {
      stream?.getTracks().forEach((track) => track.stop())
      stream = null
    }

    const start = async (): Promise<void> => {
      const media = navigator.mediaDevices
      if (!media?.getUserMedia) {
        return
      }
      const inputs = (await media.enumerateDevices().catch(() => []))
        .filter((device) => device.kind === 'audioinput')
        .map((device) => ({ deviceId: device.deviceId, label: device.label }))
      const deviceId = matchMicrophoneDeviceId(deviceName, inputs)
      stream = await media.getUserMedia({
        audio: deviceId ? { deviceId: { exact: deviceId } } : true,
        video: false
      })
      if (disposed) {
        stopStream()
        return
      }
      context = new AudioContext()
      const analyser = context.createAnalyser()
      // 2048 samples ≈ 43 ms at 48 kHz: a meaningful RMS window that still
      // refreshes completely between display frames.
      analyser.fftSize = 2048
      context.createMediaStreamSource(stream).connect(analyser)
      const samples = new Float32Array(analyser.fftSize)
      let ballistics: MeterBallisticsState = INITIAL_METER_BALLISTICS
      let lastFrameAt = performance.now()
      let lastLabelAt = 0
      setActive(true)

      const tick = (): void => {
        if (disposed) {
          return
        }
        const now = performance.now()
        const elapsedMs = Math.min(100, now - lastFrameAt)
        lastFrameAt = now
        analyser.getFloatTimeDomainData(samples)
        const { rms, peak } = samplesRmsAndPeak(samples)
        const target = mutedRef.current ? 0 : dbToMeterLevel(amplitudeToDb(rms))
        ballistics = advanceMeterBallistics(ballistics, target, elapsedMs, now)
        const fill = fillElementRef.current
        if (fill) {
          fill.style.width = `${(ballistics.level * 100).toFixed(1)}%`
        }
        const marker = peakElementRef.current
        if (marker) {
          marker.style.left = `calc(${(ballistics.peakLevel * 100).toFixed(1)}% - 2px)`
          marker.style.opacity = mutedRef.current || ballistics.peakLevel <= 0.001 ? '0' : '1'
        }
        if (now - lastLabelAt >= PEAK_DB_LABEL_INTERVAL_MS) {
          lastLabelAt = now
          setPeakDb(mutedRef.current ? null : amplitudeToDb(peak))
        }
        frame = requestAnimationFrame(tick)
      }
      frame = requestAnimationFrame(tick)
    }

    void start().catch(() => {
      // Permission denied or the device is exclusively held: the mixer falls
      // back to the backend-sampled meter. A passive meter must never toast.
      if (!disposed) {
        setActive(false)
      }
    })

    return () => {
      disposed = true
      cancelAnimationFrame(frame)
      stopStream()
      void context?.close().catch(() => undefined)
      setActive(false)
      setPeakDb(null)
    }
  }, [deviceName, enabled])

  return { fillRef, peakRef, active, peakDb }
}
