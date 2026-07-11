import { useCallback, useEffect, useRef, useState } from 'react'

import {
  INITIAL_METER_BALLISTICS,
  advanceMeterBallistics,
  amplitudeToDb,
  dbToMeterLevel,
  samplesRmsAndPeak,
  type MeterBallisticsState
} from '@/lib/mic-meter'

const PEAK_DB_LABEL_INTERVAL_MS = 250

export type MicLevelMeter = {
  /** Attach the meter fill element; its width is driven imperatively at rAF rate. */
  fillRef: (element: HTMLSpanElement | null) => void
  /** Attach the peak-hold marker element; its left offset is driven imperatively. */
  peakRef: (element: HTMLSpanElement | null) => void
  /** True while the WebAudio analyser is metering the stream. */
  active: boolean
  /** Peak dBFS for the text label, throttled to ~4Hz of React state. */
  peakDb: number | null
}

/**
 * Real-time mic meter ballistics (2026-07-10 report: the mixer bar moved once
 * a second and barely at all). The VISUAL runs on a renderer-side WebAudio
 * analyser at display rate, writing element styles directly — React state,
 * the 1 Hz telemetry commit throttle, and the backend diagnostics tick are
 * all bypassed. Since the Studio audio rework (plan S2) the stream itself
 * comes from use-mic-stream — one shared acquisition point for every mic
 * visual — and this hook only analyses it. The backend's `micLiveLevel`
 * stays the capture/health authority and the mixer's fallback whenever the
 * stream cannot open (permission denied, exclusive-mode device).
 */
export function useMicLevelMeter(input: {
  /** Shared visual-only stream from use-mic-stream; null renders inactive. */
  stream: MediaStream | null
  /** Backend mute is applied at capture gain; the analyser sees pre-mute signal. */
  muted: boolean
}): MicLevelMeter {
  const { stream, muted } = input
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
    if (!stream) {
      setActive(false)
      setPeakDb(null)
      return
    }

    let disposed = false
    let frame = 0
    const context = new AudioContext()
    const analyser = context.createAnalyser()
    // 2048 samples ≈ 43 ms at 48 kHz: a meaningful RMS window that still
    // refreshes completely between display frames.
    analyser.fftSize = 2048
    const source = context.createMediaStreamSource(stream)
    source.connect(analyser)
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

    return () => {
      // The stream belongs to use-mic-stream — only the analyser is ours.
      disposed = true
      cancelAnimationFrame(frame)
      source.disconnect()
      void context.close().catch(() => undefined)
      setActive(false)
      setPeakDb(null)
    }
  }, [stream])

  return { fillRef, peakRef, active, peakDb }
}
