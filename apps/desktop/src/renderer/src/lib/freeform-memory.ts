import type {
  CameraTransform,
  LayoutSettings,
  SceneSource,
  SceneSourceKind,
  SourceTransformOverride
} from '@/lib/backend'
import { layoutPresetOrientation, normalizeSourceCrop, type LayoutOrientation } from '@/lib/capture'

// Freeform memory (plan 174, C-4). Choosing a preset scene leaves Freeform
// and clears its per-source overrides, so one stray click used to lose an
// arrangement for good: choosing Freeform again re-seeded it from the preset.
// The overrides a preset replaces are remembered per orientation, and
// Freeform starts from them the next time. The undo below (S3.9, D15) takes
// the whole last layout change back.

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

/** Only the screen side crops (plan 213 G2): the camera frames itself with
 * zoom and pan, and the test pattern is drawn at the canvas size. */
export function sourceCroppable(kind: SceneSourceKind): boolean {
  return kind === 'screen' || kind === 'window'
}

/** A source as Freeform saves it: its box, and the screen's crop with it. */
export function sourceOverrideOf(
  source: Pick<SceneSource, 'kind' | 'transform'>
): SourceTransformOverride {
  const box = transformOf(source)
  return sourceCroppable(source.kind) ? { ...box, ...normalizeSourceCrop(source.transform) } : box
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

/**
 * The layout patch that enters Freeform (plan 174, C-4): the arrangement a
 * preset last replaced in this orientation, and where the scene draws every
 * other source now, so nothing visibly moves. The Scene page's Freeform
 * button, its "Make freeform" hint and an agent's move off a preset (plan
 * 209 D22) all send this one patch.
 */
export function freeformEntryPatch(
  orientation: LayoutOrientation,
  sources: readonly Pick<SceneSource, 'id' | 'transform'>[]
): Pick<LayoutSettings, 'arrangementMode' | 'sourceTransformOverrides'> {
  return {
    arrangementMode: 'freeform',
    sourceTransformOverrides: freeformEntryOverrides(rememberedFreeform(), orientation, sources)
  }
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

// Layout undo (plan 174 S3.9, D15): a single level. The slot holds the
// committed layout the last layout change replaced, with the saved scene it
// belonged to, so one ⌘Z on the Scene page asks for it back. Undo itself is a
// layout change, so after it the slot holds the undone layout: ⌘Z again
// brings it back. There is no deeper history.

/** A committed layout a single ⌘Z returns to. */
export interface LayoutUndoEntry {
  layout: LayoutSettings
  savedSceneId: string | null
  origin: 'builtin' | 'saved'
}

/** Two layouts the compositor would draw the same. */
export function sameLayout(a: LayoutSettings, b: LayoutSettings): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * The undo slot after `next` commits over `previous`. A commit that leaves
 * the layout as it was (a background change, a reconnect's reconciliation)
 * is not a layout change, so the slot keeps what it held.
 */
export function layoutUndoAfterCommit(
  slot: LayoutUndoEntry | null,
  previous: LayoutUndoEntry | null,
  next: LayoutSettings
): LayoutUndoEntry | null {
  if (!previous || sameLayout(previous.layout, next)) return slot
  return previous
}

let undoSlot: LayoutUndoEntry | null = null

/** Called as a layout commit lands, with the committed layout it replaced. */
export function noteLayoutCommitted(previous: LayoutUndoEntry | null, next: LayoutSettings): void {
  undoSlot = layoutUndoAfterCommit(undoSlot, previous, next)
}

/** The layout ⌘Z would return to, or null when there is nothing to undo. */
export function peekLayoutUndo(): LayoutUndoEntry | null {
  return undoSlot
}

/** Takes the entry for an undo in flight; the slot is empty until that commit lands. */
export function takeLayoutUndo(): LayoutUndoEntry | null {
  const entry = undoSlot
  undoSlot = null
  return entry
}

/** Puts an entry back after its undo was refused, unless a newer change filled the slot. */
export function restoreLayoutUndo(entry: LayoutUndoEntry | null): void {
  if (entry && undoSlot === null) undoSlot = entry
}
