import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type Ref
} from 'react'

import { Button } from '@/components/ui/button'
import { useReducedMotion } from '@/hooks/use-reduced-motion'
import type { CohostPersona } from '@/lib/backend'
import { BUDDY_PREVIEW_TICK_MS, BuddyPetPlayer } from '@/lib/buddy-pet-player'
import {
  disposeBuddyPreviewPack,
  drawBuddyPreviewFrame,
  loadBuddyPreviewPack,
  type BuddyPreviewPack
} from '@/lib/buddy-pet-preview-pack'
import { BUDDY_STILL_PACK_ID } from '@/lib/buddy-pet-view'
import { cn } from '@/lib/utils'
import { BUDDY_MOTION_DEFAULTS, type BuddyMotionSettings } from '../../../shared/buddy-pet'

/** What the Try buttons and the Stream Manager chips call (plan 168 S-D1). */
export interface BuddyPetPreviewHandle {
  /**
   * Play a reaction now: the pack's frame and its motion, or, when the pack
   * has no such frame, D14's motion-only hop. False when nothing played
   * (not loaded, hidden or offscreen, or reduced motion without the frame).
   */
  react: (reaction: string) => boolean
}

/** The loaded pack, for the rows and chips beside the preview. */
export interface BuddyPetPreviewInfo {
  packId: string
  name: string
  /** Reaction ids in manifest order. */
  reactions: string[]
  gazeCount: number
  frameCount: number
  /** The neutral gaze cell's id. */
  neutral: string
  /** Every gaze cell and where it looks, in manifest order. */
  gazes: { id: string; gaze: readonly [number, number] }[]
  /** The top of the neutral silhouette in its box (0 to 1), where a bubble's tail points (D16). */
  headTop: number
  /** Fallbacks taken while loading (a Still image that would not load). */
  notes: string[]
}

export interface BuddyPetPreviewProps {
  personaId: string
  /** `still` (the persona's state images) or a pack id (a uuid or `bundled:<name>`). */
  packId: string
  /** The drawn size in CSS pixels; the box is square. */
  size: number
  /** Follow the pointer across the window and react to clicks (default true). */
  interactive?: boolean
  /** Overrides the system setting when set. */
  reducedMotion?: boolean
  /** The persona's Motion, Sleep after and Breathing (D10, D13, D15). */
  motion?: BuddyMotionSettings
  /** The persona's state images, for `still`. */
  stillImages?: CohostPersona['images']
  /** Hold one frame while set (page-pet's `pose`), e.g. the state on air. */
  pose?: string | null
  /** Run the on-stream talk cycle (D12) while true: talk frames, else a bob. */
  talking?: boolean
  /** The pet's name for assistive tech. */
  label?: string
  /** Shown until the first frame is drawn, and when the pack cannot load. */
  placeholder?: ReactNode
  className?: string
  onLoad?: (info: BuddyPetPreviewInfo) => void
  onError?: (reason: string) => void
  /**
   * Reads one pack file (`manifest.json`, a sheet) instead of the saved pack
   * under the managed root, e.g. the creator's unsaved build (plan 168 S-F5).
   */
  readFile?: (file: string) => Promise<Uint8Array | null>
  /** Changing it reloads the pack under the same id (a rebuilt creation). */
  reloadKey?: string
  ref?: Ref<BuddyPetPreviewHandle>
}

/** Room around the pet's box so motion is never clipped (page-pet's transform overflows its element). */
const MARGIN_RATIO = 0.25
/** Breathing is slow; between events the canvas redraws at about 15 fps. */
const BREATH_FRAME_MS = 66

function errorReason(error: unknown): string {
  return error instanceof Error ? error.message : 'The Buddy pack could not be loaded.'
}

/**
 * The living Buddy in the app (plan 168 S-D1): a canvas that plays a pet
 * pack (or the Still flat pack) with page-pet's behaviour
 * (`lib/buddy-pet-player.ts`) and the shared motion model. It loads its
 * frames through main (`readBuddyPetFile`), runs its frame loop only while
 * the page is visible and the box is on screen, and stops it on unmount.
 * Load it lazily (`buddy-pet-preview-lazy.tsx`); it never belongs in the
 * eager bundle.
 */
export function BuddyPetPreview({
  personaId,
  packId,
  size,
  interactive = true,
  reducedMotion,
  motion = BUDDY_MOTION_DEFAULTS,
  stillImages,
  pose = null,
  talking = false,
  label,
  placeholder,
  className,
  onLoad,
  onError,
  readFile,
  reloadKey = '',
  ref
}: BuddyPetPreviewProps): ReactElement {
  const systemReduced = useReducedMotion()
  const reduced = reducedMotion ?? systemReduced
  const wrapperRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const playerRef = useRef<BuddyPetPlayer | null>(null)
  const kickRef = useRef<(() => void) | null>(null)
  const pendingReactionRef = useRef<string | null>(null)
  const activeRef = useRef(false)
  const [pack, setPack] = useState<BuddyPreviewPack | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [drawn, setDrawn] = useState(false)
  const [pageVisible, setPageVisible] = useState(
    () => typeof document === 'undefined' || document.visibilityState !== 'hidden'
  )
  const [onscreen, setOnscreen] = useState(true)
  const dpr = typeof window === 'undefined' ? 1 : Math.max(1, window.devicePixelRatio || 1)
  const margin = Math.ceil(size * MARGIN_RATIO)
  const pixelSize = Math.ceil(size * dpr)
  const stillKey = packId === BUDDY_STILL_PACK_ID ? JSON.stringify(stillImages ?? {}) : ''
  const active = pack !== null && pageVisible && onscreen
  activeRef.current = active

  const latest = useRef({
    onLoad,
    onError,
    motion,
    reduced,
    pose,
    talking,
    size,
    stillImages,
    readFile
  })
  latest.current = {
    onLoad,
    onError,
    motion,
    reduced,
    pose,
    talking,
    size,
    stillImages,
    readFile
  }

  // The pack: loaded once per persona, pack, Still images and pixel size.
  useEffect(() => {
    const controller = new AbortController()
    // The pack on screen keeps playing until its replacement is ready.
    const readOverride = latest.current.readFile
    const request = {
      personaId,
      packId,
      stillImages: latest.current.stillImages,
      pixelSize,
      signal: controller.signal
    }
    ;(readOverride
      ? loadBuddyPreviewPack(request, {
          readPackFile: (_persona, _pack, file) => readOverride(file)
        })
      : loadBuddyPreviewPack(request)
    ).then(
      (loaded) => {
        if (controller.signal.aborted) {
          disposeBuddyPreviewPack(loaded)
          return
        }
        setError(null)
        setPack(loaded)
        latest.current.onLoad?.({
          packId: loaded.packId,
          name: loaded.name,
          reactions: loaded.reactions,
          gazeCount: loaded.gazeCount,
          frameCount: loaded.frames.length,
          neutral: loaded.neutral,
          gazes: loaded.frames.flatMap((frame) =>
            frame.kind === 'gaze' && frame.gaze ? [{ id: frame.id, gaze: frame.gaze }] : []
          ),
          headTop: loaded.headTop,
          notes: loaded.notes
        })
      },
      (failure: unknown) => {
        if (controller.signal.aborted) return
        const reason = errorReason(failure)
        setPack(null)
        setDrawn(false)
        setError(reason)
        latest.current.onError?.(reason)
      }
    )
    return () => controller.abort()
  }, [personaId, packId, stillKey, pixelSize, reloadKey])

  // A replaced or unmounted pack releases its bitmaps.
  useEffect(() => () => disposeBuddyPreviewPack(pack), [pack])

  // One player per pack; settings follow without restarting it.
  useEffect(() => {
    if (!pack) {
      playerRef.current = null
      return
    }
    const {
      motion: settings,
      reduced: reducedNow,
      pose: held,
      talking: talkingNow,
      size: drawnSize
    } = latest.current
    const player = new BuddyPetPlayer({
      pack,
      size: drawnSize,
      motion: settings,
      reducedMotion: reducedNow,
      now: performance.now()
    })
    if (held) player.pose(held, performance.now())
    if (talkingNow) player.setTalking(true, performance.now())
    playerRef.current = player
    return () => {
      player.stop()
      if (playerRef.current === player) playerRef.current = null
    }
  }, [pack])

  useEffect(() => {
    playerRef.current?.setMotionSettings(motion)
    kickRef.current?.()
  }, [pack, motion])
  useEffect(() => {
    playerRef.current?.setSize(size)
  }, [pack, size])
  useEffect(() => {
    if (playerRef.current?.setReducedMotion(reduced)) kickRef.current?.()
  }, [pack, reduced])
  useEffect(() => {
    if (playerRef.current?.pose(pose, performance.now())) kickRef.current?.()
  }, [pack, pose])
  useEffect(() => {
    playerRef.current?.setTalking(talking, performance.now())
    kickRef.current?.()
  }, [pack, talking])

  // Visible and on screen, like page-pet's `active`.
  useEffect(() => {
    const onVisibility = (): void => setPageVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', onVisibility)
    const wrapper = wrapperRef.current
    let observer: IntersectionObserver | null = null
    if (wrapper && typeof IntersectionObserver !== 'undefined') {
      observer = new IntersectionObserver(([entry]) => {
        if (entry) setOnscreen(entry.isIntersecting)
      })
      observer.observe(wrapper)
    }
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      observer?.disconnect()
    }
  }, [])

  // The frame loop: every frame while something moves, about 15 fps while it
  // only breathes, the 160 ms idle tick otherwise. Stopped (and the motion
  // reset) whenever the pet is hidden, offscreen or unmounted.
  useEffect(() => {
    const player = playerRef.current
    const canvas = canvasRef.current
    if (!active || !player || !pack || !canvas) return
    const context = canvas.getContext('2d')
    let raf = 0
    let timer: ReturnType<typeof setTimeout> | null = null
    let lastTick = -Infinity
    let lastDrawn = ''
    let firstDraw = true
    const frame = (): void => {
      raf = 0
      const now = performance.now()
      if (now - lastTick >= BUDDY_PREVIEW_TICK_MS) {
        player.tick(now)
        lastTick = now
      }
      const transform = player.advance(now)
      const current = player.frame
      const key = `${current.id}|${transform.translateX}|${transform.translateY}|${transform.rotationDeg}|${transform.skewXDeg}|${transform.scaleX}`
      if (context && key !== lastDrawn) {
        drawBuddyPreviewFrame(context, canvas, pack.cells.get(current.id), transform, {
          size: latest.current.size,
          margin,
          dpr
        })
        lastDrawn = key
        if (wrapperRef.current) wrapperRef.current.dataset.frame = current.id
        if (firstDraw) {
          firstDraw = false
          setDrawn(true)
        }
      }
      schedule(now)
    }
    const schedule = (now: number): void => {
      const cadence = player.cadence(now)
      if (cadence === 'frame') {
        raf = requestAnimationFrame(frame)
        return
      }
      timer = setTimeout(
        () => {
          timer = null
          raf = requestAnimationFrame(frame)
        },
        cadence === 'breath' ? BREATH_FRAME_MS : BUDDY_PREVIEW_TICK_MS
      )
    }
    const kick = (): void => {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      if (!raf) raf = requestAnimationFrame(frame)
    }
    kickRef.current = kick
    raf = requestAnimationFrame(frame)
    return () => {
      if (raf) cancelAnimationFrame(raf)
      raf = 0
      if (timer !== null) clearTimeout(timer)
      timer = null
      if (kickRef.current === kick) kickRef.current = null
      player.stop()
    }
  }, [active, pack, margin, dpr])

  // page-pet's window-wide tracking: the pet looks at the pointer anywhere
  // in this window, and back ahead when it leaves.
  useEffect(() => {
    if (!active || !interactive || reduced) return
    const fine =
      typeof window.matchMedia === 'function' ? window.matchMedia('(any-pointer: fine)') : null
    const onMove = (event: PointerEvent): void => {
      const player = playerRef.current
      const wrapper = wrapperRef.current
      if (!player || !wrapper || event.pointerType === 'touch' || fine?.matches === false) return
      player.track(event.clientX, event.clientY, wrapper.getBoundingClientRect(), performance.now())
      kickRef.current?.()
    }
    const onLeave = (): void => {
      if (playerRef.current?.center()) kickRef.current?.()
    }
    window.addEventListener('pointermove', onMove)
    document.documentElement.addEventListener('pointerleave', onLeave)
    return () => {
      window.removeEventListener('pointermove', onMove)
      document.documentElement.removeEventListener('pointerleave', onLeave)
    }
  }, [active, interactive, reduced])

  /** The pack's frame and motion, or a motion-only hop when it has no frame. */
  const playNow = (player: BuddyPetPlayer, reaction: string): boolean => {
    const now = performance.now()
    const played = player.hasReaction(reaction)
      ? player.react(reaction, now)
      : player.hop(reaction, now)
    if (played) kickRef.current?.()
    return played
  }

  useImperativeHandle(
    ref,
    () => ({
      react: (reaction: string): boolean => {
        const player = playerRef.current
        if (!player) return false
        if (!activeRef.current) {
          // Off screen (a Try button far below it): bring the pet into view
          // and play the reaction as soon as it is visible again.
          pendingReactionRef.current = reaction
          wrapperRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
          return true
        }
        return playNow(player, reaction)
      }
    }),
    []
  )

  // A reaction asked for while the pet was off screen plays once it is back.
  useEffect(() => {
    const pending = pendingReactionRef.current
    const player = playerRef.current
    if (!active || !pending || !player) return
    pendingReactionRef.current = null
    playNow(player, pending)
  }, [active])

  const name = label?.trim() || pack?.name || 'Buddy'
  const status = error ? 'error' : pack ? 'ready' : 'loading'
  const showCanvas = drawn && pack !== null
  return (
    <div
      ref={wrapperRef}
      className={cn('relative shrink-0', className)}
      data-pack={packId}
      data-status={status}
      data-testid="buddy-pet-preview"
      style={{ width: size, height: size }}
      title={error ?? undefined}
    >
      {!showCanvas ? (
        <div aria-hidden className="absolute inset-0 flex items-center justify-center">
          {placeholder}
        </div>
      ) : null}
      <canvas
        ref={canvasRef}
        aria-hidden
        className="pointer-events-none absolute"
        height={Math.ceil((size + margin * 2) * dpr)}
        style={{
          left: -margin,
          top: -margin,
          width: size + margin * 2,
          height: size + margin * 2,
          visibility: showCanvas ? 'visible' : 'hidden'
        }}
        width={Math.ceil((size + margin * 2) * dpr)}
      />
      {interactive ? (
        <Button
          aria-label={`${name}: click to react`}
          className="absolute inset-0 size-auto rounded-row p-0 hover:bg-transparent dark:hover:bg-transparent"
          disabled={!pack}
          type="button"
          variant="ghost"
          onClick={() => {
            const player = playerRef.current
            if (!player || !activeRef.current) return
            if (player.click(performance.now())) kickRef.current?.()
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && playerRef.current?.center()) kickRef.current?.()
          }}
        />
      ) : null}
    </div>
  )
}

export default BuddyPetPreview
