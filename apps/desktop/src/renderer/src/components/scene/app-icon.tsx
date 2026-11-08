import { CameraIcon, DisplayIcon, SceneIcon } from '@/components/icons'
import type { ReactElement } from 'react'

import type { SceneGlyph } from '@/lib/scene-list'
import { cn } from '@/lib/utils'

/**
 * An app's own icon (plan 210 S5), or the generic glyph while main has none.
 * macOS draws the icon's rounded tile and margin into the image, so it is
 * never masked or framed, like the app icon in About.
 */
export function AppIconImage({
  icon,
  className
}: {
  /** The icon's data URL, from `useAppIcons`; null or undefined draws the glyph. */
  icon: string | null | undefined
  /** Size only (`size-5` in a row, `size-6` on a card, `size-10` as a picture). */
  className?: string
}): ReactElement {
  return icon ? (
    <img alt="" className={cn('size-5 shrink-0', className)} draggable={false} src={icon} />
  ) : (
    <SceneIcon
      aria-hidden
      className={cn('size-4 shrink-0 text-muted-foreground', className)}
      data-testid="app-icon-glyph"
      weight="duotone"
    />
  )
}

/** A scene row's or card's icon: the app's, or a glyph for what it shows. */
export function SceneGlyphIcon({
  glyph,
  icons,
  className
}: {
  glyph: SceneGlyph
  icons: ReadonlyMap<string, string | null>
  className?: string
}): ReactElement {
  if (glyph.kind === 'app')
    return <AppIconImage className={className} icon={icons.get(glyph.bundleId)} />
  const Glyph =
    glyph.kind === 'display' ? DisplayIcon : glyph.kind === 'camera' ? CameraIcon : SceneIcon
  return <Glyph aria-hidden className={cn('size-4 shrink-0 text-muted-foreground', className)} />
}
