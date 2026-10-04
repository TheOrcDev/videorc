import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type Ref
} from 'react'

import { PauseIcon, PlayIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Slider } from '@/components/ui/slider'
import type { SessionMediaGrantRefusal } from '@/lib/backend'
import { ipcErrorMessage } from '@/lib/ipc-error-message'
import {
  PLAYER_SCRUB_STEP_MS,
  PLAYER_SEEK_STEP_MS,
  clampSeekMs,
  formatMediaTime,
  grantRenewalDelayMs,
  mediaErrorCopy,
  mediaTimeHasHours,
  playerKeyAction,
  sessionMediaRefusalCopy
} from '@/lib/session-player-view'
import { normalizeSkipRanges, skipTargetMs, type SkipRange } from '@/lib/skip-ranges'
import { cn } from '@/lib/utils'

/**
 * The in-app recording player (plan 119, S11). Lazy-load it from its consumer:
 *
 *   const SessionPlayer = lazy(async () => ({
 *     default: (await import('@/components/media/session-player')).SessionPlayer
 *   }))
 *
 * It asks main for a session media grant and plays the recording through the
 * Range-aware `videorc-asset://session-media/` host, so a 2-hour file seeks
 * instantly. Controls are the app's own (play/pause, scrubber, times; Space
 * and the arrow keys when the player has focus): there is no fullscreen, the
 * permission stays denied. `skipRanges` turns it into the virtual preview of
 * a cut: whenever a presented frame falls inside a removed span, playback
 * jumps to the span's end.
 */
export type SessionPlayerProps = {
  sessionId: string
  /** Removed spans to jump over while playing, in any order; overlaps are merged. */
  skipRanges?: readonly SkipRange[]
  /** The playhead in ms, on every timeupdate and after each seek. */
  onTimeUpdate?: (positionMs: number) => void
  /** Set to a new value to seek there; the same value twice seeks once. */
  seekToMs?: number | null
  /** Drive the player from outside its own focus (the Clean cut review's keys). */
  handleRef?: Ref<SessionPlayerHandle>
  className?: string
}

/** What a host may do to the player without owning its focus. */
export type SessionPlayerHandle = {
  togglePlayback: () => void
  seekTo: (ms: number) => void
  seekBy: (deltaMs: number) => void
}

export type SessionPlayerGrantState =
  | { kind: 'loading' }
  | { kind: 'granted'; url: string; expiresAt: number }
  | { kind: 'refused'; error: SessionMediaGrantRefusal }
  | { kind: 'error'; message: string }

export function SessionPlayer({
  sessionId,
  skipRanges,
  onTimeUpdate,
  seekToMs = null,
  handleRef,
  className
}: SessionPlayerProps): ReactElement {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [grant, setGrant] = useState<SessionPlayerGrantState>({ kind: 'loading' })
  const [grantAttempt, setGrantAttempt] = useState(0)
  const [mediaError, setMediaError] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [positionMs, setPositionMs] = useState(0)
  const [durationMs, setDurationMs] = useState(0)
  const [scrubMs, setScrubMs] = useState<number | null>(null)

  // The frame loop lives outside render, so it reads the ranges through a ref.
  const ranges = useMemo(
    () => normalizeSkipRanges(skipRanges, durationMs > 0 ? durationMs : undefined),
    [skipRanges, durationMs]
  )
  const rangesRef = useRef(ranges)
  useEffect(() => {
    rangesRef.current = ranges
  }, [ranges])

  const grantedUrlRef = useRef<string | null>(null)
  const resumeRef = useRef<{ atMs: number; playing: boolean } | null>(null)
  const pendingSeekRef = useRef<number | null>(null)
  const autoRetriedRef = useRef(false)
  const frameHandleRef = useRef<number | null>(null)

  // Grant lifecycle: request on mount, renew a minute before expiry, drop on
  // unmount. A renewal normally keeps the URL; a replaced file yields a new
  // one, and the position and play state carry over the reload.
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    grantedUrlRef.current = null
    resumeRef.current = null
    pendingSeekRef.current = null
    setGrant({ kind: 'loading' })
    setMediaError(null)
    setPlaying(false)
    setPositionMs(0)
    setDurationMs(0)
    setScrubMs(null)
    const requestGrant = window.videorc?.grantSessionMedia
    if (!requestGrant) {
      setGrant({ kind: 'error', message: 'Playback is not available in this window.' })
      return
    }
    const request = async (): Promise<void> => {
      try {
        const result = await requestGrant(sessionId)
        if (cancelled) return
        if ('error' in result) {
          grantedUrlRef.current = null
          setGrant({ kind: 'refused', error: result.error })
          return
        }
        const video = videoRef.current
        if (video && grantedUrlRef.current && grantedUrlRef.current !== result.url) {
          resumeRef.current = {
            atMs: video.currentTime * 1000,
            playing: !video.paused && !video.ended
          }
        }
        grantedUrlRef.current = result.url
        setGrant({ kind: 'granted', url: result.url, expiresAt: result.expiresAt })
        timer = setTimeout(() => void request(), grantRenewalDelayMs(result.expiresAt, Date.now()))
      } catch (error) {
        if (cancelled) return
        grantedUrlRef.current = null
        setGrant({ kind: 'error', message: ipcErrorMessage(error) })
      }
    }
    void request()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [sessionId, grantAttempt])

  const stopFrameLoop = useCallback(() => {
    const video = videoRef.current
    if (
      video &&
      frameHandleRef.current !== null &&
      typeof video.cancelVideoFrameCallback === 'function'
    ) {
      video.cancelVideoFrameCallback(frameHandleRef.current)
    }
    frameHandleRef.current = null
  }, [])

  // Unmount: no frame callback outlives the element.
  useEffect(() => stopFrameLoop, [stopFrameLoop])

  const applySkip = useCallback((video: HTMLVideoElement, mediaTimeMs: number): void => {
    const target = skipTargetMs(rangesRef.current, mediaTimeMs)
    if (target === null) return
    const limit = Number.isFinite(video.duration) ? video.duration * 1000 : Number.POSITIVE_INFINITY
    video.currentTime = Math.min(target, limit) / 1000
  }, [])

  const startFrameLoop = useCallback(() => {
    const video = videoRef.current
    if (!video || typeof video.requestVideoFrameCallback !== 'function') return
    stopFrameLoop()
    const tick = (_now: DOMHighResTimeStamp, metadata: VideoFrameCallbackMetadata): void => {
      frameHandleRef.current = null
      if (video.paused || video.ended) return
      applySkip(video, metadata.mediaTime * 1000)
      frameHandleRef.current = video.requestVideoFrameCallback(tick)
    }
    frameHandleRef.current = video.requestVideoFrameCallback(tick)
  }, [applySkip, stopFrameLoop])

  const seekTo = useCallback((ms: number): void => {
    const video = videoRef.current
    if (!video) return
    const target = clampSeekMs(
      ms,
      Number.isFinite(video.duration) ? video.duration * 1000 : Number.NaN
    )
    if (video.readyState >= video.HAVE_METADATA) {
      video.currentTime = target / 1000
      setPositionMs(target)
    } else {
      pendingSeekRef.current = target
    }
  }, [])

  useEffect(() => {
    if (seekToMs === null || seekToMs === undefined) return
    seekTo(seekToMs)
  }, [seekToMs, seekTo])

  const ready = grant.kind === 'granted' && mediaError === null && durationMs > 0

  const togglePlayback = useCallback((): void => {
    const video = videoRef.current
    if (!video || !ready) return
    if (video.paused || video.ended) {
      void video.play().catch(() => undefined)
    } else {
      video.pause()
    }
  }, [ready])

  useImperativeHandle(
    handleRef,
    () => ({
      togglePlayback,
      seekTo,
      seekBy: (deltaMs: number) => {
        const video = videoRef.current
        seekTo((video ? video.currentTime * 1000 : 0) + deltaMs)
      }
    }),
    [seekTo, togglePlayback]
  )

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const target = event.target instanceof HTMLElement ? event.target : null
    const action = playerKeyAction(
      event.key,
      target ? { tagName: target.tagName, role: target.getAttribute('role') } : null
    )
    if (!action) return
    event.preventDefault()
    if (action === 'toggle') {
      togglePlayback()
      return
    }
    const video = videoRef.current
    const currentMs = video ? video.currentTime * 1000 : 0
    seekTo(currentMs + (action === 'seek-back' ? -PLAYER_SEEK_STEP_MS : PLAYER_SEEK_STEP_MS))
  }

  const readPosition = (): number => {
    const video = videoRef.current
    return video ? video.currentTime * 1000 : 0
  }

  const handleLoadedMetadata = (): void => {
    const video = videoRef.current
    if (!video) return
    autoRetriedRef.current = false
    setMediaError(null)
    const duration = Number.isFinite(video.duration) ? video.duration * 1000 : 0
    setDurationMs(duration)
    const resume = resumeRef.current
    resumeRef.current = null
    const pending = pendingSeekRef.current
    pendingSeekRef.current = null
    const target = pending ?? resume?.atMs ?? null
    if (target !== null) {
      video.currentTime = clampSeekMs(target, duration) / 1000
    }
    if (resume?.playing) {
      void video.play().catch(() => undefined)
    }
  }

  const handleTimeUpdate = (): void => {
    const video = videoRef.current
    if (!video) return
    const ms = video.currentTime * 1000
    setPositionMs(ms)
    onTimeUpdate?.(ms)
    // Browsers without requestVideoFrameCallback skip on the coarser clock.
    if (!video.paused && typeof video.requestVideoFrameCallback !== 'function') {
      applySkip(video, ms)
    }
  }

  const handleSeeked = (): void => {
    const ms = readPosition()
    setPositionMs(ms)
    onTimeUpdate?.(ms)
  }

  const handleError = (): void => {
    const code = videoRef.current?.error?.code ?? null
    // An expired grant or a replaced file answers 404/409, which the element
    // reports as a network or source error: one silent re-grant fixes both.
    if (!autoRetriedRef.current && (code === 2 || code === 4)) {
      autoRetriedRef.current = true
      setGrantAttempt((attempt) => attempt + 1)
      return
    }
    setMediaError(mediaErrorCopy(code))
  }

  const retry = (): void => {
    autoRetriedRef.current = false
    setGrantAttempt((attempt) => attempt + 1)
  }

  return (
    <div
      data-slot="session-player"
      role="group"
      aria-label="Recording player"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      className={cn(
        'flex min-w-0 flex-col gap-2 rounded-row outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
        className
      )}
    >
      <div className="relative overflow-hidden rounded-row border border-border bg-video-ground">
        <video
          ref={videoRef}
          data-slot="session-player-video"
          className="block aspect-video w-full"
          preload="metadata"
          playsInline
          disablePictureInPicture
          src={grant.kind === 'granted' ? grant.url : undefined}
          onLoadedMetadata={handleLoadedMetadata}
          onDurationChange={() => {
            const video = videoRef.current
            if (video && Number.isFinite(video.duration)) setDurationMs(video.duration * 1000)
          }}
          onTimeUpdate={handleTimeUpdate}
          onSeeked={handleSeeked}
          onPlay={() => {
            setPlaying(true)
            startFrameLoop()
          }}
          onPause={() => {
            setPlaying(false)
            stopFrameLoop()
          }}
          onEnded={() => {
            setPlaying(false)
            stopFrameLoop()
          }}
          onError={handleError}
        />
        <SessionPlayerStatus grant={grant} mediaError={mediaError} onRetry={retry} />
      </div>
      <SessionPlayerControls
        playing={playing}
        positionMs={scrubMs ?? positionMs}
        durationMs={durationMs}
        disabled={!ready}
        onToggle={togglePlayback}
        onScrub={(ms) => {
          setScrubMs(ms)
          seekTo(ms)
        }}
        onScrubCommit={(ms) => {
          seekTo(ms)
          setScrubMs(null)
        }}
      />
    </div>
  )
}

/** What covers the video ground while there is nothing to play: loading, a refusal, or a failure. */
export function SessionPlayerStatus({
  grant,
  mediaError,
  onRetry
}: {
  grant: SessionPlayerGrantState
  mediaError: string | null
  onRetry: () => void
}): ReactElement | null {
  if (grant.kind === 'granted' && mediaError === null) {
    return null
  }
  if (grant.kind === 'loading') {
    return (
      <div
        data-slot="session-player-status"
        className="absolute inset-0 flex items-center justify-center"
      >
        <span className="text-xs text-video-ground-muted">Loading recording</span>
      </div>
    )
  }
  const copy =
    grant.kind === 'refused'
      ? sessionMediaRefusalCopy(grant.error)
      : {
          title: 'Playback failed',
          description: grant.kind === 'error' ? grant.message : (mediaError ?? '')
        }
  const retryable = grant.kind !== 'refused'
  return (
    <div
      data-slot="session-player-status"
      className="absolute inset-0 flex items-center justify-center p-4"
    >
      <Empty className="gap-3 p-0">
        <EmptyHeader className="gap-1">
          <EmptyTitle className="text-sm text-video-ground-foreground">{copy.title}</EmptyTitle>
          <EmptyDescription className="text-xs text-video-ground-muted">
            {copy.description}
          </EmptyDescription>
        </EmptyHeader>
        {retryable ? (
          <Button type="button" variant="secondary" size="sm" onClick={onRetry}>
            Try again
          </Button>
        ) : null}
      </Empty>
    </div>
  )
}

/** Play/pause, the playhead, the scrubber and the duration, on one 28 px row. */
export function SessionPlayerControls({
  playing,
  positionMs,
  durationMs,
  disabled,
  onToggle,
  onScrub,
  onScrubCommit
}: {
  playing: boolean
  positionMs: number
  durationMs: number
  disabled: boolean
  onToggle: () => void
  onScrub: (ms: number) => void
  onScrubCommit: (ms: number) => void
}): ReactElement {
  const withHours = mediaTimeHasHours(durationMs)
  const timeWidth = withHours ? 'min-w-[7ch]' : 'min-w-[5ch]'
  const max = Math.max(durationMs, PLAYER_SCRUB_STEP_MS)
  return (
    <div data-slot="session-player-controls" className="flex h-control items-center gap-2">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={playing ? 'Pause' : 'Play'}
        title={playing ? 'Pause (Space)' : 'Play (Space)'}
        disabled={disabled}
        onClick={onToggle}
      >
        {playing ? <PauseIcon weight="fill" /> : <PlayIcon weight="fill" />}
      </Button>
      <span
        data-slot="session-player-time"
        className={cn('text-right text-xs text-muted-foreground tabular-nums', timeWidth)}
      >
        {formatMediaTime(positionMs, withHours)}
      </span>
      <Slider
        aria-label="Playhead"
        className="flex-1"
        min={0}
        max={max}
        step={PLAYER_SCRUB_STEP_MS}
        value={[Math.min(Math.max(0, positionMs), max)]}
        disabled={disabled}
        onValueChange={(values) => onScrub(values[0] ?? 0)}
        onValueCommit={(values) => onScrubCommit(values[0] ?? 0)}
      />
      <span
        data-slot="session-player-duration"
        className={cn('text-xs text-muted-foreground tabular-nums', timeWidth)}
      >
        {formatMediaTime(durationMs, withHours)}
      </span>
    </div>
  )
}
