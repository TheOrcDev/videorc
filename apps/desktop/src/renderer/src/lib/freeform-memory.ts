import type { CameraTransform, LayoutSettings, SceneSource } from '@/lib/backend'
import { layoutPresetOrientation, type LayoutOrientation } from '@/lib/capture'

// Freeform memory (plan 174, C-4). Choosing a preset scene leaves Freeform
// and clears its per-source overrides, so one stray click used to lose an
// arrangement for good: choosing Freeform again re-seeded it from the preset.
// The overrides a preset replaces are remembered per orientation, and
// Freeform starts from them the next time. The full undo is S3.9.

export type FreeformOverrides = LayoutSettings['sourceTransformOverrides']
export type FreeformMemory = Partial<Record<LayoutOrientation, FreeformOverrides>>

type FreeformLayout = Pick<
  LayoutSettings,
  'arrangementMode' | 'layoutPreset' | 'sourceTransformOverrides'
>

/** Remembers a Freeform layout's overrides under its orientation; any other layout changes nothing. */
export function rememberFreeform(memory: FreeformMemory, layout: FreeformLayout): FreeformMemory {
  if (layout.arrangementMode !== 'freeform') return memory
  const overrides = layout.sourceTransformOverrides
  if (Object.keys(overrides).length === 0) return memory
  return { ...memory, [layoutPresetOrientation(layout.layoutPreset)]: { ...overrides } }
}

function transformOf(source: Pick<SceneSource, 'transform'>): CameraTransform {
  const { x, y, width, height } = source.transform
  return { x, y, width, height }
}

/**
 * The overrides Freeform starts from: the remembered placement of every
 * source the scene still has, and where the scene draws it now for a source
 * with no memory (so nothing visibly moves).
 */
export function freeformEntryOverrides(
  memory: FreeformMemory,
  orientation: LayoutOrientation,
  sources: readonly Pick<SceneSource, 'id' | 'transform'>[]
): FreeformOverrides {
  const remembered = memory[orientation] ?? {}
  return Object.fromEntries(
    sources.map((source) => [source.id, remembered[source.id] ?? transformOf(source)])
  )
}

// One memory per window for the app's lifetime: the provider notes a Freeform
// layout as a preset replaces it, and the Scene page reads it back.
let windowMemory: FreeformMemory = {}

/** Called as a preset scene replaces `layout` (requestCameraPresetTransaction). */
export function noteLayoutLeavingFreeform(layout: FreeformLayout): void {
  windowMemory = rememberFreeform(windowMemory, layout)
}

export function rememberedFreeform(): FreeformMemory {
  return windowMemory
}
