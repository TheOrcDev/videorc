import { LAYOUT_PRESET_VALUES, type LayoutPreset, type LayoutSettings } from './backend'

export const BUILTIN_LAYOUTS: readonly { id: LayoutPreset; label: string }[] = [
  { id: 'screen-camera', label: 'Screen + Cam' },
  { id: 'screen-only', label: 'Screen' },
  { id: 'camera-only', label: 'Camera' },
  { id: 'side-by-side', label: 'Side by side' },
  { id: 'vertical-camera-top', label: 'Camera top' },
  { id: 'vertical-camera-bottom', label: 'Camera bottom' },
  { id: 'vertical-split', label: 'Split' },
  { id: 'vertical-screen-camera', label: 'Vertical Screen + Cam' },
  { id: 'vertical-screen-only', label: 'Vertical Screen' },
  { id: 'vertical-camera-only', label: 'Vertical Camera' }
]
export type CameraFraming = Pick<LayoutSettings, 'cameraZoom' | 'cameraOffsetX' | 'cameraOffsetY'>
export type LayoutFramingMemory = { version: 1; layouts: Record<LayoutPreset, CameraFraming> }
const DEFAULT_FRAMING: CameraFraming = { cameraZoom: 100, cameraOffsetX: 0, cameraOffsetY: 0 }
function framing(raw: unknown): CameraFraming {
  const candidate = (raw && typeof raw === 'object' ? raw : {}) as Partial<CameraFraming>
  const clamp = (value: unknown, fallback: number, min: number, max: number): number =>
    typeof value === 'number' && Number.isFinite(value)
      ? Math.max(min, Math.min(max, value))
      : fallback
  return {
    cameraZoom: clamp(candidate.cameraZoom, 100, 100, 200),
    cameraOffsetX: clamp(candidate.cameraOffsetX, 0, -100, 100),
    cameraOffsetY: clamp(candidate.cameraOffsetY, 0, -100, 100)
  }
}
export function normalizeLayoutFramingMemory(
  raw: unknown,
  current?: LayoutSettings
): LayoutFramingMemory {
  const data = (raw && typeof raw === 'object' ? raw : {}) as Partial<LayoutFramingMemory>
  return {
    version: 1,
    layouts: Object.fromEntries(
      LAYOUT_PRESET_VALUES.map((id) => [
        id,
        framing(
          data.version === 1
            ? data.layouts?.[id]
            : current?.layoutPreset === id
              ? current
              : DEFAULT_FRAMING
        )
      ])
    ) as Record<LayoutPreset, CameraFraming>
  }
}
export function rememberLayoutFraming(
  memory: LayoutFramingMemory,
  layout: LayoutSettings
): LayoutFramingMemory {
  return { version: 1, layouts: { ...memory.layouts, [layout.layoutPreset]: framing(layout) } }
}
export function recalledLayoutFraming(
  memory: LayoutFramingMemory,
  current: LayoutPreset,
  target: LayoutPreset
): Partial<CameraFraming> {
  return current === target ? {} : { ...memory.layouts[target] }
}
