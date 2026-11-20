import type { ReactElement } from 'react'

import { SceneGlyphIcon } from '@/components/scene/app-icon'
import { StatusDot } from '@/components/status-dot'
import { ShortcutKeys } from '@/components/ui/shortcut-keys'
import type { SceneHudPhase } from '@/lib/scene-hud-timeline'
import { cn } from '@/lib/utils'
import { sceneHudLine, type SceneHudPresentation } from '../../../shared/scene-hud'

/**
 * The key HUD's chip (plan 231 D20): one compact pill on the toast family's
 * popup glass, with the scene's icon, its name and its key. A refusal keeps
 * the scene's icon and key, says why in words ("Figma isn't open"), and
 * carries its tone on a dot, never on the words. Opacity is the only thing
 * that changes: it appears at once and fades without moving.
 */
export function SceneHudChip({
  presentation,
  phase,
  fadeMs
}: {
  presentation: SceneHudPresentation
  phase: SceneHudPhase
  fadeMs: number
}): ReactElement {
  const icons = new Map<string, string | null>(
    presentation.icon.kind === 'app'
      ? [[presentation.icon.bundleId, presentation.iconDataUrl ?? null]]
      : []
  )
  return (
    <div
      className={cn(
        'glass-float flex h-10 max-w-105 min-w-0 items-center gap-2.5 rounded-full border px-3.5 text-foreground',
        'transition-opacity ease-out motion-reduce:transition-none',
        phase === 'shown' ? 'opacity-100 duration-0' : 'opacity-0'
      )}
      data-phase={phase}
      data-refusal={presentation.refusal ? 'true' : undefined}
      data-testid="scene-hud-chip"
      role="status"
      style={phase === 'fading' ? { transitionDuration: `${fadeMs}ms` } : undefined}
    >
      {presentation.refusal ? <StatusDot tone="warn" /> : null}
      <SceneGlyphIcon className="size-5" glyph={presentation.icon} icons={icons} />
      <span className="min-w-0 truncate text-sm font-medium">{sceneHudLine(presentation)}</span>
      {presentation.key ? (
        <ShortcutKeys accelerator={presentation.key} platform={presentation.platform} />
      ) : null}
    </div>
  )
}
