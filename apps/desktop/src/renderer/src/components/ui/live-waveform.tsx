import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  type HTMLAttributes
} from 'react'

import { resampleMicVisualLevelsInto } from '@/lib/mic-visual-frame'
import { cn } from '@/lib/utils'

export type LiveWaveformHandle = {
  /** Paint one shared analyser snapshot without scheduling a React render. */
  paint: (levels: ArrayLike<number>, start?: number, length?: number) => void
}

/**
 * Imperative waveform painter. Microphone acquisition, WebAudio analysis,
 * history, and animation timing all belong to StudioMicVisualProvider; this
 * component paints immutable snapshots directly onto its canvas.
 */
export type LiveWaveformProps = HTMLAttributes<HTMLDivElement> & {
  /** Low-frequency lifecycle truth; analyser levels arrive through the ref. */
  active?: boolean
  /** Show an honest preparation shape before the first analyser frame. */
  processing?: boolean
  barWidth?: number
  barHeight?: number
  barGap?: number
  barRadius?: number
  fadeEdges?: boolean
  fadeWidth?: number
  height?: string | number
  mode?: 'scrolling' | 'static'
}

export const LiveWaveform = forwardRef<LiveWaveformHandle, LiveWaveformProps>(
  (
    {
      active = false,
      processing = false,
      barWidth = 3,
      barGap = 1,
      barRadius = 1.5,
      fadeEdges = true,
      fadeWidth = 24,
      barHeight: baseBarHeight = 4,
      height = 64,
      mode = 'static',
      className,
      ...props
    },
    forwardedRef
  ): React.JSX.Element => {
    const canvasRef = useRef<HTMLCanvasElement>(null)
    const containerRef = useRef<HTMLDivElement>(null)
    const levelsRef = useRef<ArrayLike<number>>([])
    const levelsStartRef = useRef(0)
    const levelsLengthRef = useRef(0)
    const resampledLevelsRef = useRef<number[]>([])
    const gradientCacheRef = useRef<{
      width: number
      fadeWidth: number
      gradient: CanvasGradient
    } | null>(null)
    const heightStyle = typeof height === 'number' ? `${height}px` : height

    const draw = useCallback((): void => {
      const canvas = canvasRef.current
      const container = containerRef.current
      const context = canvas?.getContext('2d')
      if (!canvas || !container || !context) return

      const rect = container.getBoundingClientRect()
      context.clearRect(0, 0, rect.width, rect.height)
      const step = barWidth + barGap
      const barCount = Math.max(1, Math.floor(rect.width / step))
      const levels = levelsRef.current
      let values: ArrayLike<number> = []
      let valuesStart = 0
      let valuesLength = 0
      if (active) {
        if (mode === 'static') {
          resampledLevelsRef.current.length = barCount
          values = resampleMicVisualLevelsInto(levels, resampledLevelsRef.current)
          valuesLength = values.length
        } else {
          values = levels
          valuesStart = levelsStartRef.current
          valuesLength = levelsLengthRef.current
        }
      } else if (processing) {
        values = preparationLevels(barCount)
        valuesLength = values.length
      }

      if (valuesLength === 0 || values.length === 0) return

      const color = getComputedStyle(canvas).color || '#888'
      const centerY = rect.height / 2
      const drawBar = (x: number, value: number): void => {
        const normalized = Math.max(0, Math.min(1, value))
        const drawnHeight = Math.max(baseBarHeight, normalized * rect.height * 0.8)
        const y = centerY - drawnHeight / 2
        context.fillStyle = color
        context.globalAlpha = 0.4 + normalized * 0.6
        if (barRadius > 0) {
          context.beginPath()
          context.roundRect(x, y, barWidth, drawnHeight, barRadius)
          context.fill()
        } else {
          context.fillRect(x, y, barWidth, drawnHeight)
        }
      }

      if (mode === 'static') {
        const visibleCount = Math.min(barCount, valuesLength)
        for (let index = 0; index < visibleCount; index += 1) {
          drawBar(index * step, values[index])
        }
      } else {
        const visibleCount = Math.min(barCount, valuesLength)
        const firstLogicalIndex = valuesLength - visibleCount
        for (let index = 0; index < visibleCount; index += 1) {
          const sourceIndex = (valuesStart + firstLogicalIndex + index) % values.length
          drawBar(rect.width - (visibleCount - index) * step, values[sourceIndex])
        }
      }

      if (fadeEdges && fadeWidth > 0 && rect.width > 0) {
        let cached = gradientCacheRef.current
        if (!cached || cached.width !== rect.width || cached.fadeWidth !== fadeWidth) {
          const gradient = context.createLinearGradient(0, 0, rect.width, 0)
          const fadePercent = Math.min(0.3, fadeWidth / rect.width)
          gradient.addColorStop(0, 'rgba(255,255,255,1)')
          gradient.addColorStop(fadePercent, 'rgba(255,255,255,0)')
          gradient.addColorStop(1 - fadePercent, 'rgba(255,255,255,0)')
          gradient.addColorStop(1, 'rgba(255,255,255,1)')
          cached = { width: rect.width, fadeWidth, gradient }
          gradientCacheRef.current = cached
        }
        context.globalCompositeOperation = 'destination-out'
        context.fillStyle = cached.gradient
        context.fillRect(0, 0, rect.width, rect.height)
        context.globalCompositeOperation = 'source-over'
      }
      context.globalAlpha = 1
    }, [active, barGap, barRadius, barWidth, baseBarHeight, fadeEdges, fadeWidth, mode, processing])
    const drawRef = useRef(draw)
    drawRef.current = draw

    useImperativeHandle(
      forwardedRef,
      () => ({
        paint: (levels, start = 0, length = levels.length) => {
          levelsRef.current = levels
          levelsStartRef.current = levels.length > 0 ? start % levels.length : 0
          levelsLengthRef.current = Math.max(0, Math.min(length, levels.length))
          drawRef.current()
        }
      }),
      []
    )

    useEffect(() => {
      const canvas = canvasRef.current
      const container = containerRef.current
      if (!canvas || !container) return

      const resize = (): void => {
        const rect = container.getBoundingClientRect()
        const dpr = window.devicePixelRatio || 1
        canvas.width = Math.max(1, Math.round(rect.width * dpr))
        canvas.height = Math.max(1, Math.round(rect.height * dpr))
        canvas.style.width = `${rect.width}px`
        canvas.style.height = `${rect.height}px`
        canvas.getContext('2d')?.setTransform(dpr, 0, 0, dpr, 0, 0)
        gradientCacheRef.current = null
        drawRef.current()
      }

      const resizeObserver = new ResizeObserver(resize)
      resizeObserver.observe(container)
      resize()
      return () => resizeObserver.disconnect()
    }, [])

    useEffect(() => draw(), [draw])

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
)

LiveWaveform.displayName = 'LiveWaveform'

function preparationLevels(barCount: number): number[] {
  const center = Math.max(1, (barCount - 1) / 2)
  return new Array<number>(barCount).fill(0).map((_, index) => {
    const distance = Math.abs(index - center) / center
    return 0.12 + (1 - distance) * 0.18
  })
}
