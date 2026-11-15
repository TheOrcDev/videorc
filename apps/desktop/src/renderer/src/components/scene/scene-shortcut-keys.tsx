import { useSyncExternalStore, type ReactElement } from 'react'

import { ShortcutKeys } from '@/components/ui/shortcut-keys'
import type { GlobalShortcutsConfig } from '@/lib/backend'
import { globalShortcutConflictReason } from '@/lib/global-shortcut-owner'
import { globalShortcutRegistration } from '@/lib/global-shortcuts'
import { sceneShortcutBindings } from '@/lib/scene-shortcuts'

/** Both keys, with the same registration result and words as Settings → Shortcuts. */
export function SceneShortcutKeys({
  sceneId,
  position,
  config,
  platform
}: {
  sceneId: string
  position: number
  config: GlobalShortcutsConfig | undefined
  platform: string | undefined
}): ReactElement | null {
  const registered = useSyncExternalStore(
    globalShortcutRegistration.subscribe,
    globalShortcutRegistration.getSnapshot
  )
  const bindings = sceneShortcutBindings(sceneId, position, config ?? {}, platform)
  if (!bindings.length) return null
  return (
    <span className="flex flex-wrap items-center gap-1" data-slot="scene-shortcut-keys">
      {bindings.map(({ action, accelerator }) => {
        const conflict = globalShortcutConflictReason(
          accelerator,
          platform,
          registered[action] === false
        )
        return conflict ? (
          <span key={action} className="text-xs text-muted-foreground">
            {conflict}
          </span>
        ) : (
          <ShortcutKeys key={action} accelerator={accelerator} platform={platform} />
        )
      })}
    </span>
  )
}
