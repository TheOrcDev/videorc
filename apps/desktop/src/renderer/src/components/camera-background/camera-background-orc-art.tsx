import { useId, type ReactElement } from 'react'

import orcUrl from '@/assets/camera-background/orc.webp?no-inline'
import orcRoomUrl from '@/assets/camera-background/orc-room.webp?no-inline'
import type { CameraBackgroundArtKind } from '@/components/camera-background/camera-background-art'
import { backgroundAssetDisplayUrl } from '@/lib/background-library'
import { cn } from '@/lib/utils'

// The pictures on the Background tiles in the popover and on the Scene page:
// the Orc (orc.pictures, Videorc category) in front of what the pick puts
// behind the camera. One cutout of the Orc over one layer: his own studio,
// sharp for Off and blurred for a blur (the room only; the Orc stays sharp,
// like the real effect), the picture itself, or the screen colour. These are
// on-stream pixels, so they don't follow the app theme (the screen colours are
// allowlisted as content in renderer-style-guards.test.ts). Only the picker's
// lazy chunk loads this module and its two pictures, never the launch bundle.

/** The blur in the picture's own units (160 wide), Slight and Strong. */
const BLUR_DEVIATION = { slight: 2.2, strong: 5.5 } as const

const SCREEN_FILL = { green: '#1fae4b', blue: '#2456d6' } as const

/** One tile's picture with the Orc, filling its box (16:10 tiles, 16:9 viewer). */
export function CameraBackgroundOrcArt({
  art,
  className
}: {
  art: CameraBackgroundArtKind
  className?: string
}): ReactElement {
  // A plain id: React's ids carry characters a url(#…) reference can't hold.
  const filterId = `camera-bg-orc-blur-${useId().replace(/[^\w-]/g, '')}`
  const box = cn('absolute inset-0 size-full', className)
  const layer = { height: 100, preserveAspectRatio: 'xMidYMid slice', width: 160 } as const
  return (
    <svg
      aria-hidden
      className={box}
      data-videorc-camera-background-art={art.kind}
      preserveAspectRatio="xMidYMid slice"
      viewBox="0 0 160 100"
    >
      {art.kind === 'blur' ? (
        <defs>
          {/* Blur, then make the room opaque again, so its edges keep their
              own colours instead of fading to the tile's ground. */}
          <filter
            colorInterpolationFilters="sRGB"
            height="120%"
            id={filterId}
            width="120%"
            x="-10%"
            y="-10%"
          >
            <feGaussianBlur stdDeviation={BLUR_DEVIATION[art.strength]} />
            <feComponentTransfer>
              <feFuncA intercept="1" slope="0" type="linear" />
            </feComponentTransfer>
          </filter>
        </defs>
      ) : null}
      {art.kind === 'screen' ? (
        <rect fill={SCREEN_FILL[art.color]} height="100" width="160" />
      ) : art.kind === 'picture' ? (
        <image href={backgroundAssetDisplayUrl(art.src)} {...layer} />
      ) : (
        <image
          filter={art.kind === 'blur' ? `url(#${filterId})` : undefined}
          href={orcRoomUrl}
          {...layer}
        />
      )}
      <image href={orcUrl} {...layer} />
    </svg>
  )
}
