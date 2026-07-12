import { useEffect, useRef, type HTMLAttributes } from 'react'

import { cn } from '@/lib/utils'

/**
 * Vendored from ElevenLabs UI (ui.elevenlabs.io, registry item `live-waveform`)
 * and adapted for Videorc:
 * - the component no longer acquires a microphone itself. Upstream it called
 *   getUserMedia for the OS-default mic; in Videorc the backend-selected
 *   device is the only truth, so the caller passes a `mediaStream` (from
 *   use-mic-stream) and owns its lifecycle. The stream's tracks are never
 *   stopped here.
 * - bars paint in `currentColor` (upstream default) so the parent text token
 *   drives the tone; no hardcoded palette.
 * - the canvas rAF loop exits when idle with nothing left to draw instead of
 *   spinning forever; state changes restart it via effect deps.
 */

export type LiveWaveformProps = HTMLAttributes<HTMLDivElement> & {
  /** Analyze and render this stream; null/undefined renders the idle line. */
  mediaStream?: MediaStream | null
  /** Show the animated "waiting" wave while a stream is being prepared. */
  processing?: boolean
  barWidth?: number
  barHeight?: number
  barGap?: number
  barRadius?: number
  fadeEdges?: boolean
  fadeWidth?: number
  height?: string | number
  sensitivity?: number
  smoothingTimeConstant?: number
  fftSize?: number
  historySize?: number
  updateRate?: number
  mode?: 'scrolling' | 'static'
}

export const LiveWaveform = ({
  mediaStream,
  processing = false,
  barWidth = 3,
  barGap = 1,
  barRadius = 1.5,
  fadeEdges = true,
  fadeWidth = 24,
  barHeight: baseBarHeight = 4,
  height = 64,
  sensitivity = 1,
  smoothingTimeConstant = 0.8,
  fftSize = 256,
  historySize = 60,
  updateRate = 30,
  mode = 'static',
  className,
  ...props
}: LiveWaveformProps): React.JSX.Element => {
  const active = Boolean(mediaStream)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const historyRef = useRef<number[]>([])
  const analyserRef = useRef<AnalyserNode | null>(null)
  const animationLastUpdateRef = useRef(0)
  const lastActiveDataRef = useRef<number[]>([])
  const transitionProgressRef = useRef(0)
  const staticBarsRef = useRef<number[]>([])
  const needsRedrawRef = useRef(true)
  const gradientCacheRef = useRef<CanvasGradient | null>(null)
  const lastWidthRef = useRef(0)

  const heightStyle = typeof height === 'number' ? `${height}px` : height

  // Handle canvas resizing (HiDPI aware).
  useEffect(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return

    const resizeObserver = new ResizeObserver(() => {
      const rect = container.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1

      canvas.width = rect.width * dpr
      canvas.height = rect.height * dpr
      canvas.style.width = `${rect.width}px`
      canvas.style.height = `${rect.height}px`

      const ctx = canvas.getContext('2d')
      if (ctx) {
        ctx.scale(dpr, dpr)
      }

      gradientCacheRef.current = null
      lastWidthRef.current = rect.width
      needsRedrawRef.current = true
    })

    resizeObserver.observe(container)
    return () => resizeObserver.disconnect()
  }, [])

  // Processing wave / fade-to-idle animations.
  useEffect(() => {
    if (processing && !active) {
      let time = 0
      let frameId = 0
      transitionProgressRef.current = 0

      const animateProcessing = (): void => {
        time += 0.03
        transitionProgressRef.current = Math.min(1, transitionProgressRef.current + 0.02)

        const processingData: number[] = []
        const barCount = Math.floor(
          (containerRef.current?.getBoundingClientRect().width || 200) / (barWidth + barGap)
        )
        const halfCount = Math.max(1, Math.floor(barCount / 2))

        for (let i = 0; i < barCount; i++) {
          const normalizedPosition = (i - halfCount) / halfCount
          const centerWeight = 1 - Math.abs(normalizedPosition) * 0.4

          const wave1 = Math.sin(time * 1.5 + normalizedPosition * 3) * 0.25
          const wave2 = Math.sin(time * 0.8 - normalizedPosition * 2) * 0.2
          const wave3 = Math.cos(time * 2 + normalizedPosition) * 0.15
          const processingValue = (0.2 + wave1 + wave2 + wave3) * centerWeight

          let finalValue = processingValue
          if (lastActiveDataRef.current.length > 0 && transitionProgressRef.current < 1) {
            const lastDataIndex = Math.min(i, lastActiveDataRef.current.length - 1)
            const lastValue = lastActiveDataRef.current[lastDataIndex] || 0
            finalValue =
              lastValue * (1 - transitionProgressRef.current) +
              processingValue * transitionProgressRef.current
          }

          processingData.push(Math.max(0.05, Math.min(1, finalValue)))
        }

        if (mode === 'static') {
          staticBarsRef.current = processingData
        } else {
          historyRef.current = processingData
        }

        needsRedrawRef.current = true
        frameId = requestAnimationFrame(animateProcessing)
      }

      animateProcessing()
      return () => cancelAnimationFrame(frameId)
    }

    if (!active && !processing) {
      const hasData =
        mode === 'static' ? staticBarsRef.current.length > 0 : historyRef.current.length > 0
      if (!hasData) {
        return
      }
      let frameId = 0
      let fadeProgress = 0
      const fadeToIdle = (): void => {
        fadeProgress += 0.03
        if (fadeProgress < 1) {
          if (mode === 'static') {
            staticBarsRef.current = staticBarsRef.current.map((value) => value * (1 - fadeProgress))
          } else {
            historyRef.current = historyRef.current.map((value) => value * (1 - fadeProgress))
          }
          needsRedrawRef.current = true
          frameId = requestAnimationFrame(fadeToIdle)
        } else {
          staticBarsRef.current = []
          historyRef.current = []
          needsRedrawRef.current = true
        }
      }
      fadeToIdle()
      return () => cancelAnimationFrame(frameId)
    }

    return undefined
  }, [processing, active, barWidth, barGap, mode])

  // Analyser over the CALLER's stream — never acquires or stops tracks here.
  useEffect(() => {
    if (!mediaStream) {
      analyserRef.current = null
      return
    }

    const audioContext = new AudioContext()
    const analyser = audioContext.createAnalyser()
    analyser.fftSize = fftSize
    analyser.smoothingTimeConstant = smoothingTimeConstant
    const source = audioContext.createMediaStreamSource(mediaStream)
    source.connect(analyser)
    analyserRef.current = analyser
    historyRef.current = []

    return () => {
      analyserRef.current = null
      source.disconnect()
      void audioContext.close().catch(() => undefined)
    }
  }, [mediaStream, fftSize, smoothingTimeConstant])

  // Draw loop: runs while there is signal, a processing wave, or a pending
  // redraw; otherwise it exits (effect deps restart it on state changes).
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let rafId = 0

    const animate = (currentTime: number): void => {
      const rect = canvas.getBoundingClientRect()

      if (active && currentTime - animationLastUpdateRef.current > updateRate) {
        animationLastUpdateRef.current = currentTime

        const analyser = analyserRef.current
        if (analyser) {
          const dataArray = new Uint8Array(analyser.frequencyBinCount)
          analyser.getByteFrequencyData(dataArray)
          const startFreq = Math.floor(dataArray.length * 0.05)
          const endFreq = Math.floor(dataArray.length * 0.4)
          const relevantData = dataArray.slice(startFreq, endFreq)

          if (mode === 'static') {
            const barCount = Math.floor(rect.width / (barWidth + barGap))
            const halfCount = Math.floor(barCount / 2)
            const newBars: number[] = []

            // Mirror the data for symmetric display.
            for (let i = halfCount - 1; i >= 0; i--) {
              const dataIndex = Math.floor((i / halfCount) * relevantData.length)
              newBars.push(
                Math.max(0.05, Math.min(1, (relevantData[dataIndex] / 255) * sensitivity))
              )
            }
            for (let i = 0; i < halfCount; i++) {
              const dataIndex = Math.floor((i / halfCount) * relevantData.length)
              newBars.push(
                Math.max(0.05, Math.min(1, (relevantData[dataIndex] / 255) * sensitivity))
              )
            }

            staticBarsRef.current = newBars
            lastActiveDataRef.current = newBars
          } else {
            let sum = 0
            for (let i = 0; i < relevantData.length; i++) {
              sum += relevantData[i]
            }
            const average = (sum / relevantData.length / 255) * sensitivity
            historyRef.current.push(Math.min(1, Math.max(0.05, average)))
            lastActiveDataRef.current = [...historyRef.current]
            if (historyRef.current.length > historySize) {
              historyRef.current.shift()
            }
          }
          needsRedrawRef.current = true
        }
      }

      if (!needsRedrawRef.current && !active && !processing) {
        // Idle with a settled canvas: stop scheduling frames entirely.
        rafId = 0
        return
      }

      needsRedrawRef.current = active || processing
      ctx.clearRect(0, 0, rect.width, rect.height)

      const computedBarColor = getComputedStyle(canvas).color || '#888'
      const step = barWidth + barGap
      const barCount = Math.floor(rect.width / step)
      const centerY = rect.height / 2

      const drawBar = (x: number, value: number): void => {
        const barHeight = Math.max(baseBarHeight, value * rect.height * 0.8)
        const y = centerY - barHeight / 2
        ctx.fillStyle = computedBarColor
        ctx.globalAlpha = 0.4 + value * 0.6
        if (barRadius > 0) {
          ctx.beginPath()
          ctx.roundRect(x, y, barWidth, barHeight, barRadius)
          ctx.fill()
        } else {
          ctx.fillRect(x, y, barWidth, barHeight)
        }
      }

      if (mode === 'static') {
        const dataToRender = staticBarsRef.current
        for (let i = 0; i < barCount && i < dataToRender.length; i++) {
          drawBar(i * step, dataToRender[i] || 0.1)
        }
      } else {
        for (let i = 0; i < barCount && i < historyRef.current.length; i++) {
          const dataIndex = historyRef.current.length - 1 - i
          drawBar(rect.width - (i + 1) * step, historyRef.current[dataIndex] || 0.1)
        }
      }

      // Fade the strip's edges out via destination-out gradient.
      if (fadeEdges && fadeWidth > 0 && rect.width > 0) {
        if (!gradientCacheRef.current || lastWidthRef.current !== rect.width) {
          const gradient = ctx.createLinearGradient(0, 0, rect.width, 0)
          const fadePercent = Math.min(0.3, fadeWidth / rect.width)
          gradient.addColorStop(0, 'rgba(255,255,255,1)')
          gradient.addColorStop(fadePercent, 'rgba(255,255,255,0)')
          gradient.addColorStop(1 - fadePercent, 'rgba(255,255,255,0)')
          gradient.addColorStop(1, 'rgba(255,255,255,1)')
          gradientCacheRef.current = gradient
          lastWidthRef.current = rect.width
        }

        ctx.globalCompositeOperation = 'destination-out'
        ctx.fillStyle = gradientCacheRef.current
        ctx.fillRect(0, 0, rect.width, rect.height)
        ctx.globalCompositeOperation = 'source-over'
      }

      ctx.globalAlpha = 1
      rafId = requestAnimationFrame(animate)
    }

    rafId = requestAnimationFrame(animate)

    return () => {
      if (rafId) {
        cancelAnimationFrame(rafId)
      }
    }
  }, [
    active,
    processing,
    sensitivity,
    updateRate,
    historySize,
    barWidth,
    baseBarHeight,
    barGap,
    barRadius,
    fadeEdges,
    fadeWidth,
    mode
  ])

  return (
    <div
      ref={containerRef}
      aria-label={
        active
          ? 'Live audio waveform'
          : processing
            ? 'Preparing audio preview'
            : 'Audio waveform idle'
      }
      className={cn('relative w-full', className)}
      role="img"
      style={{ height: heightStyle }}
      {...props}
    >
      {!active && !processing ? (
        <div className="absolute top-1/2 right-0 left-0 -translate-y-1/2 border-t-2 border-dotted border-muted-foreground/20" />
      ) : null}
      <canvas ref={canvasRef} aria-hidden="true" className="block h-full w-full" />
    </div>
  )
}
