import { forwardRef, memo, useEffect, useMemo, useRef, useState, type HTMLAttributes } from 'react'

import { cn } from '@/lib/utils'

/**
 * Vendored from ElevenLabs UI (ui.elevenlabs.io, registry item `bar-visualizer`)
 * and adapted for Videorc:
 * - bars render in `currentColor` so the parent's text token drives the tone
 *   (chrome when live, muted when idle, warning when silent) — no hardcoded
 *   palette, per the videorc-design "color is information" rule;
 * - the container ships unstyled (no bg/radius/padding) — content sits
 *   directly on the glass panel;
 * - `useBarAnimator` no longer runs a rAF loop for single-frame sequences
 *   (the `speaking`/undefined states used by the mixer), keeping idle CPU at
 *   baseline; multi-frame state animations still animate.
 * The caller owns the MediaStream lifecycle (see use-mic-stream).
 */

export interface AudioAnalyserOptions {
  fftSize?: number
  smoothingTimeConstant?: number
  minDecibels?: number
  maxDecibels?: number
}

function createAudioAnalyser(
  mediaStream: MediaStream,
  options: AudioAnalyserOptions = {}
): { analyser: AnalyserNode; audioContext: AudioContext; cleanup: () => void } {
  const audioContext = new AudioContext()
  const source = audioContext.createMediaStreamSource(mediaStream)
  const analyser = audioContext.createAnalyser()

  if (options.fftSize) analyser.fftSize = options.fftSize
  if (options.smoothingTimeConstant !== undefined) {
    analyser.smoothingTimeConstant = options.smoothingTimeConstant
  }
  if (options.minDecibels !== undefined) analyser.minDecibels = options.minDecibels
  if (options.maxDecibels !== undefined) analyser.maxDecibels = options.maxDecibels

  source.connect(analyser)

  const cleanup = (): void => {
    source.disconnect()
    void audioContext.close().catch(() => undefined)
  }

  return { analyser, audioContext, cleanup }
}

export interface MultiBandVolumeOptions {
  bands?: number
  loPass?: number
  hiPass?: number
  updateInterval?: number
  analyserOptions?: AudioAnalyserOptions
}

const multibandDefaults: Required<Omit<MultiBandVolumeOptions, 'analyserOptions'>> & {
  analyserOptions: AudioAnalyserOptions
} = {
  bands: 5,
  loPass: 100,
  hiPass: 600,
  updateInterval: 32,
  analyserOptions: { fftSize: 2048 }
}

function normalizeDb(value: number): number {
  if (value === -Infinity) return 0
  const minDb = -100
  const maxDb = -10
  const db = 1 - (Math.max(minDb, Math.min(maxDb, value)) * -1) / 100
  return Math.sqrt(db)
}

/** Track volume across multiple frequency bands of a MediaStream (0-1 each). */
export function useMultibandVolume(
  mediaStream?: MediaStream | null,
  options: MultiBandVolumeOptions = {}
): number[] {
  const { bands, loPass, hiPass, updateInterval, analyserOptions } = {
    ...multibandDefaults,
    ...options
  }
  const fftSize = analyserOptions.fftSize
  const smoothing = analyserOptions.smoothingTimeConstant

  const [frequencyBands, setFrequencyBands] = useState<number[]>(() => new Array(bands).fill(0))
  const bandsRef = useRef<number[]>(new Array(bands).fill(0))

  useEffect(() => {
    if (!mediaStream) {
      const emptyBands = new Array(bands).fill(0)
      setFrequencyBands(emptyBands)
      bandsRef.current = emptyBands
      return
    }

    const { analyser, cleanup } = createAudioAnalyser(mediaStream, {
      fftSize,
      smoothingTimeConstant: smoothing
    })

    const dataArray = new Float32Array(analyser.frequencyBinCount)
    const sliceStart = loPass
    const sliceEnd = hiPass
    const chunkSize = Math.ceil((sliceEnd - sliceStart) / bands)

    let frameId = 0
    let lastUpdate = 0

    const updateVolume = (timestamp: number): void => {
      if (timestamp - lastUpdate >= updateInterval) {
        analyser.getFloatFrequencyData(dataArray)

        const chunks = new Array<number>(bands)
        for (let i = 0; i < bands; i++) {
          let sum = 0
          let count = 0
          const startIdx = sliceStart + i * chunkSize
          const endIdx = Math.min(sliceStart + (i + 1) * chunkSize, sliceEnd)
          for (let j = startIdx; j < endIdx; j++) {
            sum += normalizeDb(dataArray[j])
            count++
          }
          chunks[i] = count > 0 ? sum / count : 0
        }

        // Only commit React state when a band moved visibly.
        const changed = chunks.some((chunk, i) => Math.abs(chunk - bandsRef.current[i]) > 0.01)
        if (changed) {
          bandsRef.current = chunks
          setFrequencyBands(chunks)
        }
        lastUpdate = timestamp
      }
      frameId = requestAnimationFrame(updateVolume)
    }

    frameId = requestAnimationFrame(updateVolume)

    return () => {
      cleanup()
      cancelAnimationFrame(frameId)
    }
  }, [mediaStream, bands, loPass, hiPass, updateInterval, fftSize, smoothing])

  return frequencyBands
}

export type AgentState = 'connecting' | 'initializing' | 'listening' | 'speaking' | 'thinking'

function generateConnectingSequenceBar(columns: number): number[][] {
  const seq: number[][] = []
  for (let x = 0; x < columns; x++) {
    seq.push([x, columns - 1 - x])
  }
  return seq
}

function generateListeningSequenceBar(columns: number): number[][] {
  const center = Math.floor(columns / 2)
  return [[center], [-1]]
}

/** Highlighted bar indices for the current state; animates only multi-frame sequences. */
export function useBarAnimator(
  state: AgentState | undefined,
  columns: number,
  interval: number
): number[] {
  const indexRef = useRef(0)
  const [currentFrame, setCurrentFrame] = useState<number[]>([])

  const sequence = useMemo(() => {
    if (state === 'thinking' || state === 'listening') {
      return generateListeningSequenceBar(columns)
    }
    if (state === 'connecting' || state === 'initializing') {
      return generateConnectingSequenceBar(columns)
    }
    if (state === undefined || state === 'speaking') {
      return [new Array(columns).fill(0).map((_, idx) => idx)]
    }
    return [[]]
  }, [state, columns])

  useEffect(() => {
    indexRef.current = 0
    setCurrentFrame(sequence[0] ?? [])
    // Single-frame sequences (speaking/idle) need no animation loop — keeping
    // a rAF alive for them would burn idle CPU for a static highlight.
    if (sequence.length <= 1) {
      return
    }

    let frameId = 0
    let startTime = performance.now()

    const animate = (time: number): void => {
      if (time - startTime >= interval) {
        indexRef.current = (indexRef.current + 1) % sequence.length
        setCurrentFrame(sequence[indexRef.current] ?? [])
        startTime = time
      }
      frameId = requestAnimationFrame(animate)
    }

    frameId = requestAnimationFrame(animate)
    return () => cancelAnimationFrame(frameId)
  }, [interval, sequence])

  return currentFrame
}

export interface BarVisualizerProps extends HTMLAttributes<HTMLDivElement> {
  /** Voice/meter state driving highlight animation; `speaking` lights every bar. */
  state?: AgentState
  /** Number of bars to display. */
  barCount?: number
  /** Audio source; the caller owns its lifecycle. */
  mediaStream?: MediaStream | null
  /**
   * Explicit band levels (0-1). Overrides stream analysis — the honest way to
   * render coarse fallback readings (backend 1 Hz level) without fake data.
   */
  levels?: number[]
  /** Band update interval in ms; slower saves renderer CPU. Default 48. */
  updateInterval?: number
  /** Min/max bar height as a percentage of the container. */
  minHeight?: number
  maxHeight?: number
  /** Align bars from center instead of bottom. */
  centerAlign?: boolean
}

const BarVisualizerComponent = forwardRef<HTMLDivElement, BarVisualizerProps>(
  (
    {
      state,
      barCount = 15,
      mediaStream,
      levels,
      updateInterval = 48,
      minHeight = 20,
      maxHeight = 100,
      centerAlign = false,
      className,
      ...props
    },
    ref
  ) => {
    const streamBands = useMultibandVolume(levels ? null : mediaStream, {
      bands: barCount,
      loPass: 100,
      hiPass: 200,
      updateInterval
    })
    const volumeBands = levels ?? streamBands

    const highlightedIndices = useBarAnimator(
      state,
      barCount,
      state === 'connecting'
        ? 2000 / barCount
        : state === 'thinking'
          ? 150
          : state === 'listening'
            ? 500
            : 1000
    )

    return (
      <div
        ref={ref}
        className={cn(
          'relative flex h-16 w-full justify-center gap-1 overflow-hidden',
          centerAlign ? 'items-center' : 'items-end',
          className
        )}
        data-state={state}
        {...props}
      >
        {volumeBands.map((volume, index) => (
          <Bar
            key={index}
            heightPct={Math.min(maxHeight, Math.max(minHeight, volume * 100 + 5))}
            isHighlighted={highlightedIndices?.includes(index) ?? false}
          />
        ))}
      </div>
    )
  }
)

// Bars paint in currentColor: the parent's text token is the single tone knob.
// Height changes are NOT CSS-transitioned: band updates arrive faster than any
// transition would finish, so a height transition perpetually restarts and
// burns style/layout work — the analyser's own 0.8 smoothing already smooths
// the motion. Only the highlight opacity transitions.
const Bar = memo<{ heightPct: number; isHighlighted: boolean }>(({ heightPct, isHighlighted }) => (
  <div
    className={cn(
      'min-w-1 max-w-2 flex-1 rounded-full bg-current transition-opacity duration-150',
      isHighlighted ? 'opacity-90' : 'opacity-30'
    )}
    data-highlighted={isHighlighted}
    style={{ height: `${heightPct}%` }}
  />
))

Bar.displayName = 'Bar'
BarVisualizerComponent.displayName = 'BarVisualizerComponent'

const BarVisualizer = memo(BarVisualizerComponent)
BarVisualizer.displayName = 'BarVisualizer'

export { BarVisualizer }
