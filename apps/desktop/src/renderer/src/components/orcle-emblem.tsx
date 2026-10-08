import type { ReactElement } from 'react'

import emblem64Url from '@/assets/orcle/orcle-emblem-64.webp'
import emblem112Url from '@/assets/orcle/orcle-emblem-112.webp'
import { cn } from '@/lib/utils'

/**
 * Golem's emblem (plan 149): the cybernetic orc eye in full colour, shown
 * large in two places, the Golem tab header and the Golem Live consent
 * dialog. Icon slots show the same image through `OrcleIcon`.
 *
 * Each size ships its 2× file and lets the browser scale it down on 1×
 * displays. One file serves both themes: its black keyline holds on
 * porcelain and its chrome holds on black, so it is never tinted.
 */
const SIZES = {
  md: { src: emblem64Url, className: 'h-8' },
  lg: { src: emblem112Url, className: 'h-14' }
} as const

export type OrcleEmblemSize = keyof typeof SIZES

export function OrcleEmblem({
  size = 'md',
  alt = '',
  className
}: {
  size?: OrcleEmblemSize
  /** Empty (decorative) by default: the text beside it names Golem. */
  alt?: string
  className?: string
}): ReactElement {
  const { src, className: sizeClassName } = SIZES[size]
  return (
    <img
      alt={alt}
      aria-hidden={alt === '' ? true : undefined}
      className={cn('w-auto shrink-0 select-none', sizeClassName, className)}
      data-slot="orcle-emblem"
      decoding="async"
      draggable={false}
      src={src}
    />
  )
}
