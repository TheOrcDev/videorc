import { useTheme } from 'next-themes'
import { useEffect, useRef, useState, useSyncExternalStore, type ReactElement } from 'react'

import liquidChromeGold from '@/assets/backgrounds/live-liquid-chrome-gold.webp?no-inline'
import liquidChromeMercury from '@/assets/backgrounds/live-liquid-chrome-mercury.webp?no-inline'
import liquidChromePolished from '@/assets/backgrounds/live-liquid-chrome-polished.webp?no-inline'
import { useDocumentVisible } from '@/hooks/use-document-visible'
import { useReducedMotion } from '@/hooks/use-reduced-motion'
import {
  WELCOME_BACKDROP,
  backdropStartStillReason,
  startBackdropPlayer,
  welcomeBackdropDim,
  type BackdropPlayerHandle,
  type BackdropStillReason,
  type WelcomeBackdropLook
} from '@/lib/live-background-player'

const POSTERS: Record<WelcomeBackdropLook, string> = {
  polished: liquidChromePolished,
  gold: liquidChromeGold,
  mercury: liquidChromeMercury
}

const MORE_CONTRAST_QUERY = '(prefers-contrast: more)'

function subscribeMoreContrast(onChange: () => void): () => void {
  const media = window.matchMedia?.(MORE_CONTRAST_QUERY)
  media?.addEventListener('change', onChange)
  return () => media?.removeEventListener('change', onChange)
}

function usePrefersMoreContrast(): boolean {
  return useSyncExternalStore(
    subscribeMoreContrast,
    () => Boolean(window.matchMedia?.(MORE_CONTRAST_QUERY).matches),
    () => false
  )
}

type BackdropState =
  | { mode: 'starting' }
  | { mode: 'moving' }
  | { mode: 'still'; reason: BackdropStillReason }

/**
 * First-run setup's backdrop (plan 203 S4, owner call D1): Videorc's Liquid
 * Chrome live background, edge to edge behind the setup card. The look's
 * poster paints at once; the moving canvas fades in over it on its first
 * frame, and the motion continues from the poster without a jump. Whenever
 * it can't move cheaply (reduced motion, no or a software GPU, a lost
 * context, the budget guard) the poster stays. Decoration only: hidden from
 * assistive tech, no pointer events, and nothing allocated once it unmounts.
 */
export function WelcomeBackdrop({
  hardwareAccelerationDisabled = false,
  look = WELCOME_BACKDROP.look
}: {
  /** Electron's GPU fallback is on: the poster, no WebGL. */
  hardwareAccelerationDisabled?: boolean
  look?: WelcomeBackdropLook
}): ReactElement {
  const { resolvedTheme } = useTheme()
  const reducedMotion = useReducedMotion()
  const moreContrast = usePrefersMoreContrast()
  const visible = useDocumentVisible()
  const dim = welcomeBackdropDim({ dark: resolvedTheme !== 'light', moreContrast })
  const startStill = backdropStartStillReason({ reducedMotion, hardwareAccelerationDisabled })

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const playerRef = useRef<BackdropPlayerHandle | null>(null)
  const dimRef = useRef(dim)
  dimRef.current = dim
  const [state, setState] = useState<BackdropState>({ mode: 'starting' })

  // One player per look while motion is allowed. The main window keeps
  // running animation frames while hidden (backgroundThrottling is off), so
  // visibility pauses it below.
  useEffect(() => {
    const canvas = canvasRef.current
    if (startStill || !canvas) return
    setState({ mode: 'starting' })
    const player = startBackdropPlayer({
      canvas,
      look,
      dim: dimRef.current,
      onFirstFrame: () => setState({ mode: 'moving' }),
      onStill: (reason, detail) => {
        console.info(
          `[first-run] Liquid Chrome backdrop shows its poster: ${reason}${detail ? ` (${detail})` : ''}`
        )
        setState({ mode: 'still', reason })
      }
    })
    playerRef.current = player
    return () => {
      player.dispose()
      playerRef.current = null
    }
  }, [look, startStill])

  useEffect(() => {
    playerRef.current?.setDim(dim)
  }, [dim])

  useEffect(() => {
    playerRef.current?.setRunning(visible)
  }, [visible])

  const shown: BackdropState = startStill ? { mode: 'still', reason: startStill } : state
  const moving = shown.mode === 'moving'

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 overflow-hidden bg-glass-solid"
      data-first-run-backdrop={moving ? 'moving' : shown.mode === 'still' ? 'still' : 'starting'}
      data-first-run-backdrop-look={look}
      data-first-run-backdrop-reason={shown.mode === 'still' ? shown.reason : undefined}
    >
      <img
        alt=""
        className="absolute inset-0 size-full object-cover"
        draggable={false}
        // The shader's Dim, matched on the still so a fallback reads the same.
        style={{ filter: dim > 0 ? `brightness(${1 - dim})` : undefined }}
        src={POSTERS[look]}
      />
      {startStill || shown.mode === 'still' ? null : (
        <canvas
          ref={canvasRef}
          className="absolute inset-0 size-full opacity-0 transition-opacity duration-150 ease-out data-[drawn=true]:opacity-100 motion-reduce:transition-none"
          data-drawn={moving}
        />
      )}
    </div>
  )
}
