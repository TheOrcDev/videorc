import { findAcceleratorOwner } from '../../../shared/accelerator'
import type { GlobalShortcutAction } from '../../../shared/global-shortcuts'
import type { GlobalShortcutsConfig } from '@/lib/backend'
import { globalShortcutLabel } from '@/lib/global-shortcuts'

/**
 * A recorder's refusal when another action already has the keys: "Already
 * used by Record / stop recording.", or by a saved scene's name. Settings →
 * Shortcuts and a scene's Set key… (plan 210 S5) say it the same way.
 */
export function globalShortcutTakenReason(input: {
  config: GlobalShortcutsConfig
  accelerator: string
  action: GlobalShortcutAction
  platform: string | undefined
  scenes: readonly { id: string; name: string }[]
}): string | null {
  const owner = findAcceleratorOwner(input.config, input.accelerator, input.action, input.platform)
  if (!owner) return null
  const label = owner.startsWith('scene:')
    ? (input.scenes.find((scene) => scene.id === owner.slice(6))?.name ??
      globalShortcutLabel(owner))
    : globalShortcutLabel(owner)
  return `Already used by ${label}.`
}
