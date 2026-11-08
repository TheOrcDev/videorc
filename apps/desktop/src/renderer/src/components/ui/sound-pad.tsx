'use client'

import { cva } from 'class-variance-authority'
import type { VariantProps } from 'class-variance-authority'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState
} from 'react'
import type { ComponentProps, CSSProperties, KeyboardEvent, PointerEvent } from 'react'

import { Kbd } from '@/components/ui/kbd'
import { useFrameSource } from '@/hooks/use-frame-source'
import { clamp } from '@/lib/audio/decibels'
import type { FrameSource } from '@/lib/audio/types'
import { cn } from '@/lib/utils'

export type SoundPadMode = 'one-shot' | 'toggle' | 'hold' | 'loop'

interface PadHandlers {
  press: () => void
  release: () => void
}

interface SoundPadGridContextValue {
  hotkeys: boolean
  register: (hotkey: string, handlers: PadHandlers) => () => void
}

const SoundPadGridContext = createContext<SoundPadGridContextValue | null>(null)

interface SoundPadContextValue {
  hotkey?: string
  playing: boolean
}

const SoundPadContext = createContext<SoundPadContextValue>({ playing: false })

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName))

const moveFocus = (event: KeyboardEvent<HTMLDivElement>) => {
  // data-sound-pad, not data-slot: a trigger rendering the pad replaces its slot.
  const pads = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-sound-pad]')]
  const index = pads.indexOf(event.target as HTMLElement)
  if (index === -1) {
    return
  }
  const perRow = Math.max(1, pads.filter((pad) => pad.offsetTop === pads[0]?.offsetTop).length)
  const moves: Record<string, number> = {
    ArrowDown: perRow,
    ArrowLeft: -1,
    ArrowRight: 1,
    ArrowUp: -perRow
  }
  const offset = moves[event.key]
  if (offset === undefined) {
    return
  }
  const next = pads[clamp(index + offset, 0, pads.length - 1)]
  if (next) {
    event.preventDefault()
    next.focus()
  }
}

export interface SoundPadGridProps extends ComponentProps<'div'> {
  /**
   * The most columns. The grid drops columns to keep pads at least
   * `--pad-min-width` wide (default 5.5rem). Default 4.
   */
  columns?: number
  /** Listen for pad hotkeys. Default false. */
  hotkeys?: boolean
  /** `global` listens on the whole page, never while typing. Default `focus`. */
  hotkeyScope?: 'focus' | 'global'
}

export const SoundPadGrid = ({
  columns = 4,
  hotkeys = false,
  hotkeyScope = 'focus',
  className,
  style,
  onKeyDown,
  onKeyUp,
  ...props
}: SoundPadGridProps) => {
  const padsRef = useRef(new Map<string, PadHandlers>())
  const heldRef = useRef(new Set<string>())

  const register = useCallback((hotkey: string, handlers: PadHandlers) => {
    const key = hotkey.toLowerCase()
    padsRef.current.set(key, handlers)
    return () => {
      if (padsRef.current.get(key) === handlers) {
        padsRef.current.delete(key)
        // A pad going away (disabled, loading, unmounted) mid-hold won't see
        // its keyup, so release it now.
        if (heldRef.current.delete(key)) {
          handlers.release()
        }
      }
    }
  }, [])

  const handleDown = useCallback(
    (key: string, repeat: boolean, target: EventTarget | null) => {
      if (!hotkeys || repeat || isTyping(target)) {
        return false
      }
      const pad = padsRef.current.get(key.toLowerCase())
      if (!pad) {
        return false
      }
      heldRef.current.add(key.toLowerCase())
      pad.press()
      return true
    },
    [hotkeys]
  )

  const handleUp = useCallback((key: string) => {
    const normalized = key.toLowerCase()
    if (!heldRef.current.has(normalized)) {
      return
    }
    heldRef.current.delete(normalized)
    padsRef.current.get(normalized)?.release()
  }, [])

  useEffect(() => {
    if (!hotkeys || hotkeyScope !== 'global') {
      return
    }
    const down = (event: globalThis.KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return
      }
      if (handleDown(event.key, event.repeat, event.target)) {
        event.preventDefault()
      }
    }
    const up = (event: globalThis.KeyboardEvent) => {
      handleUp(event.key)
    }
    const held = heldRef.current
    const pads = padsRef.current
    // Keyups never arrive once the window loses focus or this subscription
    // ends, so release what is held then.
    const releaseHeld = () => {
      for (const key of held) {
        pads.get(key)?.release()
      }
      held.clear()
    }
    document.addEventListener('keydown', down)
    document.addEventListener('keyup', up)
    window.addEventListener('blur', releaseHeld)
    return () => {
      document.removeEventListener('keydown', down)
      document.removeEventListener('keyup', up)
      window.removeEventListener('blur', releaseHeld)
      releaseHeld()
    }
  }, [handleDown, handleUp, hotkeyScope, hotkeys])

  const contextValue = useMemo(() => ({ hotkeys, register }), [hotkeys, register])

  return (
    <SoundPadGridContext.Provider value={contextValue}>
      <div
        className={cn(
          'grid grid-cols-(--pad-columns) gap-(--pad-gap) [--pad-gap:0.5rem]',
          className
        )}
        data-slot="sound-pad-grid"
        onKeyDown={(event) => {
          onKeyDown?.(event)
          if (event.defaultPrevented) {
            return
          }
          const hotkeyPressed =
            hotkeyScope === 'focus' &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.altKey &&
            handleDown(event.key, event.repeat, event.target)
          if (hotkeyPressed) {
            event.preventDefault()
            return
          }
          moveFocus(event)
        }}
        onKeyUp={(event) => {
          onKeyUp?.(event)
          if (hotkeyScope === 'focus') {
            handleUp(event.key)
          }
        }}
        role="group"
        style={
          {
            // Up to `columns` tracks, never narrower than --pad-min-width.
            '--pad-columns': `repeat(auto-fill, minmax(max(var(--pad-min-width, 5.5rem), calc((100% - ${columns - 1} * var(--pad-gap)) / ${columns})), 1fr))`,
            ...style
          } as CSSProperties
        }
        {...props}
      />
    </SoundPadGridContext.Provider>
  )
}

const soundPadVariants = cva(
  'group/sound-pad focus-visible:ring-ring/40 relative flex flex-col items-start justify-between gap-2 overflow-hidden rounded-xl p-3 text-left transition-[background-color,box-shadow,transform] outline-none select-none [--pad-accent:var(--primary)] focus-visible:ring-3 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 data-loading:opacity-60 data-playing:ring-2 data-playing:ring-(--pad-accent)',
  {
    defaultVariants: { size: 'default', variant: 'default' },
    variants: {
      size: {
        default: 'min-h-24',
        lg: 'min-h-32 p-4',
        sm: 'min-h-16 p-2'
      },
      variant: {
        default:
          'bg-[color-mix(in_oklch,var(--pad-accent)_14%,var(--muted))] hover:bg-[color-mix(in_oklch,var(--pad-accent)_22%,var(--muted))]',
        ghost: 'hover:bg-muted',
        outline: 'hover:bg-muted border bg-transparent'
      }
    }
  }
)

export interface SoundPadProps
  extends Omit<ComponentProps<'button'>, 'onToggle'>, VariantProps<typeof soundPadVariants> {
  onTrigger?: () => void
  onStop?: () => void
  playing?: boolean
  /** How presses map to trigger and stop. Default `one-shot`. */
  mode?: SoundPadMode
  /** Active when the grid enables hotkeys. */
  hotkey?: string
  /** The sound is not ready yet. */
  loading?: boolean
  /** A CSS colour for the pad. */
  accent?: string
}

export const SoundPad = ({
  onTrigger,
  onStop,
  playing = false,
  mode = 'one-shot',
  hotkey,
  loading = false,
  accent,
  variant = 'default',
  size = 'default',
  disabled,
  className,
  style,
  onPointerDown,
  onPointerUp,
  onPointerLeave,
  onClick,
  onKeyDown,
  onKeyUp,
  children,
  ...props
}: SoundPadProps) => {
  const grid = useContext(SoundPadGridContext)
  const [pressed, setPressed] = useState(false)
  const inactive = disabled || loading

  const press = () => {
    setPressed(true)
    if ((mode === 'toggle' || mode === 'loop') && playing) {
      onStop?.()
      return
    }
    onTrigger?.()
  }

  const release = () => {
    setPressed(false)
    if (mode === 'hold') {
      onStop?.()
    }
  }

  // The grid calls these from its own key listeners, so they read the
  // latest props without re-registering on every render.
  const pressFromHotkey = useEffectEvent(press)
  const releaseFromHotkey = useEffectEvent(release)

  useEffect(() => {
    if (!(grid && hotkey) || inactive) {
      return
    }
    return grid.register(hotkey, {
      press: () => {
        pressFromHotkey()
      },
      release: () => {
        releaseFromHotkey()
      }
    })
  }, [grid, hotkey, inactive])

  const holding = mode === 'hold'
  const contextValue = useMemo(() => ({ hotkey, playing }), [hotkey, playing])

  return (
    <SoundPadContext.Provider value={contextValue}>
      <button
        aria-keyshortcuts={hotkey}
        aria-pressed={mode === 'toggle' || mode === 'loop' ? playing : undefined}
        className={cn(soundPadVariants({ size, variant }), className)}
        data-loading={loading ? '' : undefined}
        data-mode={mode}
        data-playing={playing ? '' : undefined}
        data-pressed={pressed ? '' : undefined}
        data-slot="sound-pad"
        data-sound-pad=""
        disabled={inactive}
        onClick={(event) => {
          onClick?.(event)
          if (!holding && event.detail === 0) {
            press()
            setPressed(false)
          }
        }}
        onKeyDown={(event) => {
          onKeyDown?.(event)
          if (holding && (event.key === ' ' || event.key === 'Enter') && !event.repeat) {
            event.preventDefault()
            press()
          }
        }}
        onKeyUp={(event) => {
          onKeyUp?.(event)
          if (holding && (event.key === ' ' || event.key === 'Enter')) {
            release()
          }
        }}
        onPointerDown={(event: PointerEvent<HTMLButtonElement>) => {
          onPointerDown?.(event)
          if (event.button === 0) {
            press()
          }
        }}
        onPointerLeave={(event) => {
          onPointerLeave?.(event)
          if (pressed) {
            release()
          }
        }}
        onPointerUp={(event) => {
          onPointerUp?.(event)
          release()
        }}
        style={
          {
            '--pad-accent': accent,
            ...style
          } as CSSProperties
        }
        type="button"
        {...props}
      >
        {children}
      </button>
    </SoundPadContext.Provider>
  )
}

export const SoundPadIcon = ({ className, ...props }: ComponentProps<'span'>) => (
  <span
    aria-hidden
    className={cn("relative text-(--pad-accent) [&_svg:not([class*='size-'])]:size-5", className)}
    data-slot="sound-pad-icon"
    {...props}
  />
)

export const SoundPadLabel = ({ className, ...props }: ComponentProps<'span'>) => (
  <span
    className={cn(
      'relative mt-auto line-clamp-2 text-sm font-medium group-has-data-[variant=ring]/sound-pad:pe-6',
      className
    )}
    data-slot="sound-pad-label"
    {...props}
  />
)

export const SoundPadShortcut = ({ className, children, ...props }: ComponentProps<'kbd'>) => {
  const { hotkey } = useContext(SoundPadContext)
  if (!(children || hotkey)) {
    return null
  }
  return (
    <Kbd
      className={cn('absolute top-2 right-2 uppercase', className)}
      data-slot="sound-pad-shortcut"
      {...props}
    >
      {children ?? hotkey}
    </Kbd>
  )
}

export interface SoundPadProgressProps extends ComponentProps<'div'> {
  /** 0..1, for declarative use. */
  value?: number
  /** A smooth progress source with no React renders. */
  source?: FrameSource<number> | null
  /** Default `bar`. */
  variant?: 'bar' | 'fill' | 'ring'
}

export const SoundPadProgress = ({
  value,
  source,
  variant = 'bar',
  className,
  style,
  ...props
}: SoundPadProgressProps) => {
  const elementRef = useRef<HTMLDivElement>(null)
  const { playing } = useContext(SoundPadContext)

  useFrameSource(source, (next) => {
    elementRef.current?.style.setProperty('--pad-progress', clamp(next, 0, 1).toFixed(4))
  })

  // A declarative value, or 0 once playback stops. While a source plays it
  // stays undefined, so React leaves the source's per-frame writes alone.
  let progress: string | undefined
  if (value !== undefined) {
    progress = clamp(value, 0, 1).toFixed(4)
  } else if (!playing) {
    progress = '0'
  }
  const progressStyle = {
    '--pad-progress': progress,
    ...style
  } as CSSProperties

  if (variant === 'ring') {
    return (
      <div
        aria-hidden
        className={cn(
          'pointer-events-none absolute right-2 bottom-2 size-5 [--pad-progress:0]',
          className
        )}
        data-slot="sound-pad-progress"
        data-variant={variant}
        ref={elementRef}
        style={progressStyle}
        {...props}
      >
        <div className="size-full rounded-full bg-[conic-gradient(var(--pad-accent)_calc(var(--pad-progress)*360deg),color-mix(in_oklch,var(--pad-accent)_20%,transparent)_0)] [mask:radial-gradient(farthest-side,transparent_calc(100%-3px),black_calc(100%-3px))]" />
      </div>
    )
  }

  return (
    <div
      aria-hidden
      className={cn(
        'pointer-events-none absolute inset-x-0 bottom-0 [--pad-progress:0]',
        variant === 'fill' ? 'top-0' : 'h-1',
        className
      )}
      data-slot="sound-pad-progress"
      data-variant={variant}
      ref={elementRef}
      style={progressStyle}
      {...props}
    >
      <div
        className={cn(
          'size-full origin-left scale-x-(--pad-progress) bg-(--pad-accent)',
          variant === 'fill' && 'opacity-20'
        )}
      />
    </div>
  )
}

export { soundPadVariants }
