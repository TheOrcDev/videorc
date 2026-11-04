import type { ArrangementMode, LayoutPreset, LayoutSettings } from '@/lib/backend'

// Plan 216 A4: one "Switching…" label. A switch is pending toward a layout,
// not a preset: entering Freeform keeps the preset id it left, so a label
// keyed by preset lit the old preset's button too. The target carries both.

/** The layout a switch is applying: its preset and whether it lands in Freeform. */
export type LayoutSwitchTarget = {
  layoutPreset: LayoutPreset
  arrangementMode: ArrangementMode
}

export function layoutSwitchTarget(
  layout: Pick<LayoutSettings, 'layoutPreset' | 'arrangementMode'>
): LayoutSwitchTarget {
  return { layoutPreset: layout.layoutPreset, arrangementMode: layout.arrangementMode }
}

/** "Switching…" on a preset's control only when the switch lands on that preset, in preset mode. */
export function presetSwitching(pending: LayoutSwitchTarget | null, preset: LayoutPreset): boolean {
  return (
    pending !== null && pending.arrangementMode !== 'freeform' && pending.layoutPreset === preset
  )
}

/** "Switching…" on the Freeform toggle only when the switch lands in Freeform. */
export function freeformSwitching(pending: LayoutSwitchTarget | null): boolean {
  return pending?.arrangementMode === 'freeform'
}

/** The one id the smokes read as `pendingLayout`: the preset, or "freeform". */
export function pendingLayoutEvidence(
  pending: LayoutSwitchTarget | null
): LayoutPreset | 'freeform' | null {
  if (!pending) return null
  return pending.arrangementMode === 'freeform' ? 'freeform' : pending.layoutPreset
}
