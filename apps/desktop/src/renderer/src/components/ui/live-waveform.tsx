'use client'

import { useCallback, useEffect, useImperativeHandle, useRef } from 'react'
import type { ComponentProps, Ref } from 'react'

import { useFrameSource } from '@/hooks/use-frame-source'
import { useReducedMotion } from '@/hooks/use-reduced-motion'
import { useVisibility } from '@/hooks/use-visibility'
import { resampleLevels } from '@/lib/audio/bands'
import { clamp } from '@/lib/audio/decibels'
import { createFrameTask } from '@/lib/audio/frame-loop'
import type { FrameSource, VisualFrame } from '@/lib/audio/types'
import { cn } from '@/lib/utils'

const COLOR_REFRESH_FRAMES = 30
const REDUCED_MOTION_INTERVAL_MS = 250
const IDLE_ALPHA = 0.35

const noop = () => {
  // Nothing to wake before the painter starts.
}

/**
 * Calls `onChange` when the page theme may have changed the canvas colour: a
 * class, style or data-theme change on the root element, or the system colour
 * scheme. A sleeping painter would otherwise keep the old colour.
 */
const observeTheme = (onChange: () => void) => {
  const stops: (() => void)[] = []
  if (typeof MutationObserver !== 'undefined') {
    const observer = new MutationObserver(onChange)
    observer.observe(document.documentElement, {
      attributeFilter: ['class', 'style', 'data-theme'],
      attributes: true
    })
    stops.push(() => {
      observer.disconnect()
    })
  }
  if (typeof window.matchMedia === 'function') {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    media.addEventListener('change', onChange)
    stops.push(() => {
      media.removeEventListener('change', onChange)
    })
  }
  return () => {
    for (const stop of stops) {
      stop()
    }
  }
}

export interface LiveWaveformActions {
  /** Paint a frame directly. */
  paint: (frame: VisualFrame) => void
  /** Clear the canvas and forget the last frame. */
  clear: () => void
}

export interface LiveWaveformProps extends ComponentProps<'div'> {
  source?: FrameSource<VisualFrame> | null
  /** `scrolling` shows the level history; `static` shows the current frame. Default `static`. */
  mode?: 'scrolling' | 'static'
  /** Default `bars`. `line` draws the waveform trace. */
  variant?: 'bars' | 'line' | 'mirror'
  /** Bar width in pixels. Default 3. */
  barWidth?: number
  /** Gap between bars in pixels. Default 1. */
  barGap?: number
  /** Bar corner radius in pixels. Default 1.5. */
  barRadius?: number
  /** Smallest bar height in pixels. Default 4. */
  minBarHeight?: number
  /** Line width for the `line` variant. Default 1.5. */
  lineWidth?: number
  /** Fade the left and right edges. Default true. */
  fadeEdges?: boolean
  /** Width of the fade in pixels. Default 24. */
  fadeWidth?: number
  /** When false, shows an idle dotted line. Default true. */
  active?: boolean
  /** Visual gain. Default 1. */
  sensitivity?: number
  actionsRef?: Ref<LiveWaveformActions>
}

interface Size {
  width: number
  height: number
  ratio: number
}

interface DrawOptions {
  mode: 'scrolling' | 'static'
  variant: 'bars' | 'line' | 'mirror'
  barWidth: number
  barGap: number
  barRadius: number
  minBarHeight: number
  lineWidth: number
  fadeEdges: boolean
  fadeWidth: number
  active: boolean
  sensitivity: number
}

const drawBar = (
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
) => {
  if (typeof context.roundRect === 'function') {
    context.beginPath()
    context.roundRect(x, y, width, height, Math.min(radius, width / 2, height / 2))
    context.fill()
  } else {
    context.fillRect(x, y, width, height)
  }
}

const historyLevels = (frame: VisualFrame, count: number) => {
  const available = Math.min(frame.historyLength, count)
  const out = new Float32Array(available)
  const size = frame.history.length
  const first = frame.historyStart + frame.historyLength - available
  for (let index = 0; index < available; index += 1) {
    out[index] = frame.history[(first + index) % size] ?? 0
  }
  return out
}

const levelsFor = (frame: VisualFrame, count: number, options: DrawOptions): Float32Array => {
  if (options.mode === 'scrolling') {
    if (options.variant !== 'mirror') {
      return historyLevels(frame, count)
    }
    const half = historyLevels(frame, Math.ceil(count / 2))
    const out = new Float32Array(count)
    const center = Math.floor(count / 2)
    for (let offset = 0; offset < half.length; offset += 1) {
      const value = half[half.length - 1 - offset] ?? 0
      out[center + offset] = value
      out[center - offset] = value
    }
    return out
  }
  if (options.variant !== 'mirror') {
    return resampleLevels(frame.bands, 0, frame.bands.length, new Float32Array(count))
  }
  const half = resampleLevels(
    frame.bands,
    0,
    frame.bands.length,
    new Float32Array(Math.ceil(count / 2))
  )
  const out = new Float32Array(count)
  const center = (count - 1) / 2
  for (let index = 0; index < count; index += 1) {
    out[index] = half[Math.min(half.length - 1, Math.floor(Math.abs(index - center)))] ?? 0
  }
  return out
}

const drawIdle = (context: CanvasRenderingContext2D, size: Size, options: DrawOptions) => {
  const step = (options.barWidth + options.barGap) * 2
  const y = size.height / 2 - 0.5
  context.globalAlpha = IDLE_ALPHA
  for (let x = 0; x < size.width; x += step) {
    context.fillRect(x, y, options.barWidth, 1)
  }
  context.globalAlpha = 1
}

const drawLine = (
  context: CanvasRenderingContext2D,
  size: Size,
  frame: VisualFrame,
  options: DrawOptions
) => {
  const middle = size.height / 2
  context.lineWidth = options.lineWidth
  context.lineJoin = 'round'
  context.beginPath()

  if (options.mode === 'static' && frame.timeDomain && frame.timeDomain.length > 1) {
    const samples = frame.timeDomain
    for (let index = 0; index < samples.length; index += 1) {
      const x = (index / (samples.length - 1)) * size.width
      const value = clamp((samples[index] ?? 0) * options.sensitivity, -1, 1)
      const y = middle - value * (middle - options.lineWidth)
      if (index === 0) {
        context.moveTo(x, y)
      } else {
        context.lineTo(x, y)
      }
    }
    context.stroke()
    return
  }

  const count = Math.max(2, Math.floor(size.width / (options.barWidth + options.barGap)))
  const levels = levelsFor(frame, count, { ...options, variant: 'bars' })
  const offset = count - levels.length
  for (let index = 0; index < levels.length; index += 1) {
    const x = ((offset + index) / (count - 1)) * size.width
    const value = clamp((levels[index] ?? 0) * options.sensitivity, 0, 1)
    const y = middle - value * (middle - options.lineWidth)
    if (index === 0) {
      context.moveTo(x, y)
    } else {
      context.lineTo(x, y)
    }
  }
  for (let index = levels.length - 1; index >= 0; index -= 1) {
    const x = ((offset + index) / (count - 1)) * size.width
    const value = clamp((levels[index] ?? 0) * options.sensitivity, 0, 1)
    context.lineTo(x, middle + value * (middle - options.lineWidth))
  }
  context.closePath()
  context.globalAlpha = 0.25
  context.fill()
  context.globalAlpha = 1
  context.stroke()
}

const drawBars = (
  context: CanvasRenderingContext2D,
  size: Size,
  frame: VisualFrame,
  options: DrawOptions
) => {
  const pitch = options.barWidth + options.barGap
  const count = Math.max(1, Math.floor((size.width + options.barGap) / pitch))
  const levels = levelsFor(frame, count, options)
  const offset = count - levels.length
  const used = count * pitch - options.barGap
  const left = (size.width - used) / 2

  for (let index = 0; index < levels.length; index += 1) {
    const value = clamp((levels[index] ?? 0) * options.sensitivity, 0, 1)
    const height = Math.max(options.minBarHeight, value * size.height)
    const x = left + (offset + index) * pitch
    const y = (size.height - height) / 2
    context.globalAlpha = 0.4 + 0.6 * value
    drawBar(context, x, y, options.barWidth, height, options.barRadius)
  }
  context.globalAlpha = 1
}

const fade = (context: CanvasRenderingContext2D, size: Size, width: number) => {
  const edge = Math.min(width, size.width / 2)
  context.globalCompositeOperation = 'destination-out'
  const leftGradient = context.createLinearGradient(0, 0, edge, 0)
  leftGradient.addColorStop(0, 'rgba(0, 0, 0, 1)')
  leftGradient.addColorStop(1, 'rgba(0, 0, 0, 0)')
  context.fillStyle = leftGradient
  context.fillRect(0, 0, edge, size.height)
  const rightGradient = context.createLinearGradient(size.width - edge, 0, size.width, 0)
  rightGradient.addColorStop(0, 'rgba(0, 0, 0, 0)')
  rightGradient.addColorStop(1, 'rgba(0, 0, 0, 1)')
  context.fillStyle = rightGradient
  context.fillRect(size.width - edge, 0, edge, size.height)
  context.globalCompositeOperation = 'source-over'
}

export const LiveWaveform = ({
  source,
  mode = 'static',
  variant = 'bars',
  barWidth = 3,
  barGap = 1,
  barRadius = 1.5,
  minBarHeight = 4,
  lineWidth = 1.5,
  fadeEdges = true,
  fadeWidth = 24,
  active = true,
  sensitivity = 1,
  actionsRef,
  className,
  ref,
  ...props
}: LiveWaveformProps) => {
  const reducedMotion = useReducedMotion()
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  // Wakes the painter when there is something new to draw. A drawn canvas
  // sleeps until then.
  const wakeRef = useRef<() => void>(noop)
  const visibleRef = useVisibility(canvasRef, (visible) => {
    if (visible) {
      wakeRef.current()
    }
  })
  const frameRef = useRef<VisualFrame | null>(null)
  const dirtyRef = useRef(true)

  const paint = useCallback((frame: VisualFrame) => {
    frameRef.current = frame
    dirtyRef.current = true
    wakeRef.current()
  }, [])

  useFrameSource(source, paint)

  useImperativeHandle(
    actionsRef,
    () => ({
      clear: () => {
        frameRef.current = null
        dirtyRef.current = true
        wakeRef.current()
      },
      paint
    }),
    [paint]
  )

  useEffect(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!(canvas && context)) {
      return
    }
    const options: DrawOptions = {
      active,
      barGap,
      barRadius,
      barWidth,
      fadeEdges,
      fadeWidth,
      lineWidth,
      minBarHeight,
      mode,
      sensitivity,
      variant
    }
    const size: Size = { height: 0, ratio: 1, width: 0 }
    let color = ''
    let framesSinceColor = COLOR_REFRESH_FRAMES
    let lastPaintMs = 0
    let wakeTask = noop
    dirtyRef.current = true

    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      size.ratio = window.devicePixelRatio || 1
      size.width = rect.width
      size.height = rect.height
      canvas.width = Math.max(1, Math.round(rect.width * size.ratio))
      canvas.height = Math.max(1, Math.round(rect.height * size.ratio))
      framesSinceColor = COLOR_REFRESH_FRAMES
      dirtyRef.current = true
      wakeTask()
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)

    const tick = (nowMs: number): boolean => {
      framesSinceColor += 1
      if (framesSinceColor >= COLOR_REFRESH_FRAMES) {
        framesSinceColor = 0
        const next = getComputedStyle(canvas).color
        if (next !== color) {
          color = next
          dirtyRef.current = true
        }
      }
      // Nothing new to draw, no size yet, or off screen: sleep. It stays dirty
      // while hidden, and a frame, a resize, the theme or coming back into
      // view wakes it.
      if (!dirtyRef.current || size.width === 0 || !visibleRef.current) {
        return false
      }
      if (reducedMotion && nowMs - lastPaintMs < REDUCED_MOTION_INTERVAL_MS) {
        return true
      }
      lastPaintMs = nowMs
      dirtyRef.current = false

      context.setTransform(size.ratio, 0, 0, size.ratio, 0, 0)
      context.clearRect(0, 0, size.width, size.height)
      context.fillStyle = color
      context.strokeStyle = color

      const frame = frameRef.current
      if (!(options.active && frame)) {
        drawIdle(context, size, options)
        return false
      }
      if (options.variant === 'line') {
        drawLine(context, size, frame, options)
      } else {
        drawBars(context, size, frame, options)
      }
      if (options.fadeEdges) {
        fade(context, size, options.fadeWidth)
      }
      return false
    }

    const task = createFrameTask(tick)
    wakeTask = task.wake
    wakeRef.current = task.wake
    const stopObservingTheme = observeTheme(() => {
      framesSinceColor = COLOR_REFRESH_FRAMES
      task.wake()
    })
    return () => {
      wakeRef.current = noop
      task.stop()
      observer.disconnect()
      stopObservingTheme()
    }
  }, [
    active,
    barGap,
    barRadius,
    barWidth,
    fadeEdges,
    fadeWidth,
    lineWidth,
    minBarHeight,
    mode,
    reducedMotion,
    sensitivity,
    variant,
    visibleRef
  ])

  return (
    <div
      aria-label="Live waveform"
      className={cn('relative h-16 w-full [--waveform:currentColor]', className)}
      data-active={active ? '' : undefined}
      data-mode={mode}
      data-slot="live-waveform"
      data-variant={variant}
      ref={ref}
      role="img"
      {...props}
    >
      <canvas
        className="absolute inset-0 size-full text-(--waveform)"
        data-slot="live-waveform-canvas"
        ref={canvasRef}
      />
    </div>
  )
}
