import { CodeIcon, ImageBrokenIcon } from '@/components/icons'
import { useState, type ReactElement } from 'react'

import type { Banner } from '@/lib/backend'
import { cn } from '@/lib/utils'
import { bannerAssetUrl } from '../../../shared/banner-assets'

/**
 * A neutral checkerboard behind a banner, so its transparency shows (plan 186).
 * Monochrome, from the foreground token: white over the dark glass, black
 * over porcelain, so it reads the same way in both themes and is never a
 * colour.
 */
const CHECKERBOARD =
  'bg-[image:repeating-conic-gradient(color-mix(in_oklch,var(--foreground)_9%,transparent)_0_25%,transparent_0_50%)] bg-size-[16px_16px]'

/**
 * A banner's picture: its thumbnail contained (a wide strip stays a strip,
 * never cropped) over the checkerboard. The caller sets the box: the Assets
 * tile is the output's own 16:9 shape, a Scene row a small square.
 */
export function BannerThumbnail({
  banner,
  className
}: {
  banner: Pick<Banner, 'thumbnailFile'> & Partial<Pick<Banner, 'kind' | 'updatedAt'>>
  className?: string
}): ReactElement {
  // An HTML overlay's picture (plan 231) is saved a second after it first
  // shows, under the same file name: the row's `updatedAt` says when to look
  // again, and until then the tile shows what it is instead of a broken image.
  const html = banner.kind === 'html'
  const picture = html
    ? `${banner.thumbnailFile}?v=${encodeURIComponent(banner.updatedAt ?? '')}`
    : banner.thumbnailFile
  // A load failure belongs to the file it happened on: a new thumbnail tries again.
  const [failedFile, setFailedFile] = useState<string | null>(null)
  const failed = failedFile === picture
  return (
    <div
      className={cn('relative overflow-hidden bg-foreground/[0.04]', CHECKERBOARD, className)}
      data-banner-thumbnail=""
    >
      {failed ? (
        // A failed load is not proof the file is gone (the F4 honesty rule),
        // so the picture says nothing more than that it didn't draw.
        <div
          className="flex size-full items-center justify-center text-muted-foreground"
          data-banner-thumbnail-fallback={html ? 'html' : 'image'}
        >
          {html ? (
            <CodeIcon aria-hidden className="size-6" weight="duotone" />
          ) : (
            <ImageBrokenIcon aria-hidden className="size-6" weight="duotone" />
          )}
        </div>
      ) : (
        <img
          alt=""
          className="size-full object-contain p-2"
          decoding="async"
          draggable={false}
          src={
            html
              ? `${bannerAssetUrl(banner.thumbnailFile)}?v=${encodeURIComponent(banner.updatedAt ?? '')}`
              : bannerAssetUrl(banner.thumbnailFile)
          }
          onError={() => setFailedFile(picture)}
        />
      )}
    </div>
  )
}
