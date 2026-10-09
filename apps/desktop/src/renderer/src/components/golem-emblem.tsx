import type { ReactElement } from 'react'

import emblem64Url from '@/assets/golem/golem-emblem-64.webp'
import emblem112Url from '@/assets/golem/golem-emblem-112.webp'
import { cn } from '@/lib/utils'

/**
 * Golem's emblem (plans 149 and 164): the owner's stone golem in full colour, shown
 * large in two places, the Golem tab header and the Golem Live consent
 * dialog. Icon slots show the same image through `GolemIcon`.
 *
 * Each size ships its 2× file and lets the browser scale it down on 1×
 * displays. One file serves both themes: the warm stone reads on porcelain
 * and on black, so it is never tinted.
 */
const SIZES = {
  md: { src: emblem64Url, className: 'h-8' },
  lg: { src: emblem112Url, className: 'h-14' }
} as const

export type GolemEmblemSize = keyof typeof SIZES

export function GolemEmblem({
  size = 'md',
  alt = '',
  className
}: {
  size?: GolemEmblemSize
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
      data-slot="golem-emblem"
      decoding="async"
      draggable={false}
      src={src}
    />
  )
}
