import { useId, type ReactElement } from 'react'

import { backgroundAssetDisplayUrl } from '@/lib/background-library'
import type { CameraBackgroundChoice } from '@/lib/camera-background-view'
import { cn } from '@/lib/utils'

// Plan 258 S5: the pictures on the Background tiles (mockup §1, §2). Each is
// what the camera looks like on stream with that pick: a small room with a
// person in front, the room blurred for a blur, the picture or the screen
// colour behind them. They are on-stream pixels, so like the Hide screen
// still they don't follow the app theme (the colours are allowlisted as
// content in renderer-style-guards.test.ts).

export type CameraBackgroundArtKind =
  | { kind: 'room' }
  | { kind: 'blur'; strength: 'slight' | 'strong' }
  | { kind: 'picture'; src: string }
  | { kind: 'screen'; color: 'green' | 'blue' }

/** The picture a tile shows: what the camera looks like on stream with that pick. */
export function choiceArt(
  choice: Pick<CameraBackgroundChoice, 'id' | 'picture'>
): CameraBackgroundArtKind {
  switch (choice.id) {
    case 'off':
      return { kind: 'room' }
    case 'slight-blur':
      return { kind: 'blur', strength: 'slight' }
    case 'strong-blur':
      return { kind: 'blur', strength: 'strong' }
    case 'green':
    case 'blue':
      return { kind: 'screen', color: choice.id }
    default:
      return choice.picture ? { kind: 'picture', src: choice.picture } : { kind: 'room' }
  }
}

const SCREEN_FILL = { green: '#1fae4b', blue: '#2456d6' } as const

function Room(): ReactElement {
  return (
    <g>
      <rect fill="#5f574c" height="90" width="160" />
      <rect fill="#4a3a2a" height="62" width="44" x="8" y="10" />
      <rect fill="#c0503c" height="16" width="6" x="11" y="14" />
      <rect fill="#3c7ab0" height="14" width="5" x="18" y="16" />
      <rect fill="#d9b24a" height="17" width="7" x="24" y="13" />
      <rect fill="#5aa06a" height="15" width="5" x="32" y="15" />
      <rect fill="#e8e0d0" height="16" width="9" x="38" y="14" />
      <rect fill="#7a5bb0" height="15" width="8" x="11" y="36" />
      <rect fill="#d06a3a" height="13" width="6" x="20" y="38" />
      <rect fill="#2e8a8a" height="16" width="10" x="27" y="35" />
      <rect fill="#b04a6a" height="14" width="8" x="38" y="37" />
      <rect fill="#bcd3e6" height="30" width="40" x="110" y="8" />
      <rect fill="#5f574c" height="30" width="2" x="129" y="8" />
      <rect fill="#5f574c" height="2" width="40" x="110" y="22" />
      <rect fill="#8a5a3a" height="22" width="18" x="122" y="54" />
      <circle cx="131" cy="48" fill="#3f8a4a" r="11" />
      <circle cx="124" cy="52" fill="#4f9a55" r="7" />
      <rect fill="#2c2621" height="14" width="160" y="76" />
    </g>
  )
}

function Person(): ReactElement {
  return (
    <g>
      <path d="M44 90 C46 72 60 64 80 64 C100 64 114 72 116 90 Z" fill="#2f3b52" />
      <rect fill="#d9a07c" height="13" rx="5" width="14" x="73" y="54" />
      <ellipse cx="80" cy="40" fill="#e2ab86" rx="15" ry="18" />
      <path
        d="M64 38 C63 22 74 17 82 18 C93 19 98 27 96 38 C93 30 86 27 78 28 C71 29 67 33 64 38 Z"
        fill="#3a2a20"
      />
    </g>
  )
}

/** One tile's picture, filling its box (16:10 in the tiles, 16:9 in the trigger). */
export function CameraBackgroundArt({
  art,
  className
}: {
  art: CameraBackgroundArtKind
  className?: string
}): ReactElement {
  // A plain id: React's ids carry characters a url(#…) reference can't hold.
  const filterId = `camera-bg-blur-${useId().replace(/[^\w-]/g, '')}`
  const box = cn('absolute inset-0 size-full', className)
  if (art.kind === 'picture') {
    // The picture itself, with the person drawn over it.
    return (
      <span aria-hidden className={box}>
        <img
          alt=""
          className="absolute inset-0 size-full object-cover"
          draggable={false}
          src={backgroundAssetDisplayUrl(art.src)}
        />
        <svg
          className="absolute inset-0 size-full"
          preserveAspectRatio="xMidYMax slice"
          viewBox="0 0 160 90"
        >
          <Person />
        </svg>
      </span>
    )
  }
  return (
    <svg aria-hidden className={box} preserveAspectRatio="xMidYMid slice" viewBox="0 0 160 90">
      {art.kind === 'blur' ? (
        <defs>
          <filter height="110%" id={filterId} width="110%" x="-5%" y="-5%">
            <feGaussianBlur stdDeviation={art.strength === 'strong' ? 6 : 2.2} />
          </filter>
        </defs>
      ) : null}
      {art.kind === 'screen' ? (
        <rect fill={SCREEN_FILL[art.color]} height="90" width="160" />
      ) : art.kind === 'blur' ? (
        <g filter={`url(#${filterId})`}>
          <Room />
        </g>
      ) : (
        <Room />
      )}
      <Person />
    </svg>
  )
}
