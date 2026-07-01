import {
  ArrowsClockwise,
  CheckCircle,
  Eye,
  ImageSquare,
  Trash,
  UploadSimple,
  Warning,
  X
} from '@phosphor-icons/react'
import { useMemo, useState, type ComponentProps, type ReactElement } from 'react'
import { toast } from 'sonner'

import { Gallery } from '@/components/page'
import { PanelSection } from '@/components/panel-section'
import { PowerSlider } from '@/components/power-slider'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import {
  BACKGROUND_STYLE_FIELDS,
  applySlot,
  canApplySlot,
  clearActiveSlot,
  createImportedAsset,
  defaultBackgroundStyle,
  importIntoSlot,
  markSlotStatus,
  removeSlotAsset,
  renameAsset,
  setAssetStyle,
  slotAsset,
  slotDisplayStatus,
  slotName,
  type BackgroundAsset,
  type BackgroundAssetRegistry,
  type BackgroundAssetSlot,
  type BackgroundAssetSlotStatus,
  type BackgroundFit,
  type BackgroundStyle
} from '@/lib/background-assets'
import { useBackgroundAssets } from '@/hooks/use-background-assets'
import { cn } from '@/lib/utils'

type BadgeVariant = NonNullable<ComponentProps<typeof Badge>['variant']>

const STATUS_BADGE: Record<BackgroundAssetSlotStatus, { label: string; variant: BadgeVariant }> = {
  empty: { label: 'Empty', variant: 'outline' },
  ready: { label: 'Ready', variant: 'secondary' },
  active: { label: 'Active', variant: 'success' },
  'missing-file': { label: 'File missing', variant: 'warning' },
  unsupported: { label: 'Unsupported', variant: 'destructive' }
}

const FIT_OPTIONS: { value: BackgroundFit; label: string }[] = [
  { value: 'fill', label: 'Fill' },
  { value: 'fit', label: 'Fit' },
  { value: 'stretch', label: 'Stretch' }
]

function imageUrl(path: string): string {
  if (
    /^(blob|data|file|https?):/.test(path) ||
    path.startsWith('/assets/') ||
    path.startsWith('/src/') ||
    path.startsWith('./') ||
    path.startsWith('../') ||
    (!path.startsWith('/') && !/^[A-Za-z]:/.test(path))
  ) {
    return path
  }
  const normalized = path.replace(/\\/g, '/')
  const prefix = /^[A-Za-z]:/.test(normalized) ? 'file:///' : 'file://'
  return `${prefix}${encodeURI(normalized)}`
}

// assetPath/thumbnailPath are optional on the model (placeholders have neither);
// imported assets always carry both, so prefer the thumbnail and fall back.
function imageSrcOf(asset: BackgroundAsset): string | undefined {
  return asset.thumbnailPath ?? asset.assetPath
}

function firstEmptySlotId(registry: BackgroundAssetRegistry): string | null {
  return registry.slots.find((slot) => slot.status === 'empty')?.id ?? null
}

export function AssetsTab(): ReactElement {
  const { registry, setRegistry } = useBackgroundAssets()
  const [selectedSlotId, setSelectedSlotId] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)

  const selectedSlot = useMemo(
    () => registry.slots.find((slot) => slot.id === selectedSlotId) ?? null,
    [registry.slots, selectedSlotId]
  )

  const markMissing = (slotId: string): void => {
    setRegistry((current) => markSlotStatus(current, slotId, 'missing-file'))
  }

  const importInto = async (explicitSlotId: string | null): Promise<void> => {
    if (!window.videorc?.importBackgroundImage) {
      toast.error('Image import is unavailable outside Electron.')
      return
    }
    const target = explicitSlotId ?? firstEmptySlotId(registry)
    if (!target) {
      toast.error('All preset slots are full — select a slot to replace it.')
      return
    }

    try {
      setImporting(true)
      const result = await window.videorc.importBackgroundImage()
      if (!result) {
        return
      }
      const now = new Date().toISOString()
      const asset = createImportedAsset({
        id: result.id,
        name: result.name,
        assetPath: result.assetPath,
        thumbnailPath: result.thumbnailPath,
        createdAt: now,
        updatedAt: now
      })
      setRegistry((current) => importIntoSlot(current, target, asset))
      setSelectedSlotId(target)
      toast.success(`Imported ${asset.name}.`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not import the background.')
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Assets</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Reusable background presets for your scenes. Click a ready preset to apply it, replace
          slots with imported images, and tune defaults before Scene adds any per-scene overrides.
        </p>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex flex-col gap-4">
          <PanelSection
            title="Background presets"
            icon={ImageSquare}
            description={`${registry.slots.length} curated slots`}
            action={
              <Button
                disabled={importing}
                size="sm"
                variant="outline"
                onClick={() => importInto(null)}
              >
                <UploadSimple data-icon="inline-start" />
                Import
              </Button>
            }
          >
            <Gallery className="gap-3">
              {registry.slots.map((slot) => (
                <PresetTile
                  key={slot.id}
                  slot={slot}
                  registry={registry}
                  selected={slot.id === selectedSlotId}
                  onSelect={() => {
                    setSelectedSlotId(slot.id)
                    setRegistry((current) => applySlot(current, slot.id))
                  }}
                  onMissing={() => markMissing(slot.id)}
                />
              ))}
            </Gallery>
          </PanelSection>

          <CurrentSceneBackground
            registry={registry}
            onMissing={markMissing}
            onClear={() => setRegistry(clearActiveSlot)}
          />
        </div>

        <BackgroundInspector
          slot={selectedSlot}
          registry={registry}
          importing={importing}
          onImport={importInto}
          onMissing={markMissing}
          onApply={() => selectedSlot && setRegistry((r) => applySlot(r, selectedSlot.id))}
          onRename={(assetId, name) => setRegistry((r) => renameAsset(r, assetId, name))}
          onStyle={(assetId, patch) => setRegistry((r) => setAssetStyle(r, assetId, patch))}
          onRemove={(slotId) => {
            setRegistry((r) => removeSlotAsset(r, slotId))
          }}
        />
      </div>
    </div>
  )
}

function PresetTile({
  slot,
  registry,
  selected,
  onSelect,
  onMissing
}: {
  slot: BackgroundAssetSlot
  registry: BackgroundAssetRegistry
  selected: boolean
  onSelect: () => void
  onMissing: () => void
}): ReactElement {
  const asset = slotAsset(slot, registry)
  const status = slotDisplayStatus(slot, registry)
  const name = slotName(slot, registry)
  const active = status === 'active'
  const imageSrc = asset ? imageSrcOf(asset) : undefined

  return (
    <button
      type="button"
      aria-pressed={selected}
      title={name}
      onClick={onSelect}
      className={cn(
        'group relative flex aspect-[16/9] items-end overflow-hidden rounded-row border text-left transition-colors',
        selected
          ? 'border-primary ring-1 ring-primary/60'
          : 'border-border hover:border-foreground/30'
      )}
    >
      {imageSrc && status !== 'missing-file' ? (
        <img
          alt=""
          className="absolute inset-0 size-full object-cover"
          src={imageUrl(imageSrc)}
          onError={onMissing}
        />
      ) : (
        <span className="absolute inset-0 grid place-items-center bg-muted/30">
          {status === 'missing-file' ? (
            <Warning className="size-6 text-warning" weight="duotone" />
          ) : (
            <ImageSquare className="size-6 text-muted-foreground/40" weight="duotone" />
          )}
        </span>
      )}
      {active ? (
        <CheckCircle weight="fill" className="absolute right-1.5 top-1.5 size-4 text-success" />
      ) : null}
      <span className="relative z-10 w-full truncate bg-gradient-to-t from-background/95 via-background/70 to-transparent px-2 pb-1.5 pt-5 text-xs font-medium">
        {name}
      </span>
    </button>
  )
}

function BackgroundInspector({
  slot,
  registry,
  importing,
  onImport,
  onMissing,
  onApply,
  onRename,
  onStyle,
  onRemove
}: {
  slot: BackgroundAssetSlot | null
  registry: BackgroundAssetRegistry
  importing: boolean
  onImport: (slotId: string | null) => void
  onMissing: (slotId: string) => void
  onApply: () => void
  onRename: (assetId: string, name: string) => void
  onStyle: (assetId: string, patch: Partial<BackgroundStyle>) => void
  onRemove: (slotId: string) => void
}): ReactElement {
  if (!slot) {
    return (
      <PanelSection title="Inspector" icon={ImageSquare}>
        <Empty className="py-10">
          <EmptyMedia variant="icon">
            <ImageSquare weight="duotone" />
          </EmptyMedia>
          <EmptyTitle>No background selected</EmptyTitle>
          <EmptyDescription>Select a preset slot to inspect it.</EmptyDescription>
        </Empty>
      </PanelSection>
    )
  }

  const asset = slotAsset(slot, registry)
  const status = slotDisplayStatus(slot, registry)
  const badge = STATUS_BADGE[status]

  if (!asset) {
    return (
      <PanelSection
        title="Inspector"
        icon={ImageSquare}
        action={<Badge variant={badge.variant}>{badge.label}</Badge>}
      >
        <Empty className="py-10">
          <EmptyMedia variant="icon">
            <UploadSimple weight="duotone" />
          </EmptyMedia>
          <EmptyTitle>{slot.defaultLabel}</EmptyTitle>
          <EmptyDescription>Import a PNG, JPG, or WebP image into this slot.</EmptyDescription>
          <Button className="mt-2" disabled={importing} size="sm" onClick={() => onImport(slot.id)}>
            <UploadSimple data-icon="inline-start" />
            Import background
          </Button>
        </Empty>
      </PanelSection>
    )
  }

  const style = asset.styleDefaults
  const defaults = defaultBackgroundStyle()
  const missing = status === 'missing-file'

  return (
    <PanelSection
      title="Inspector"
      icon={ImageSquare}
      action={<Badge variant={badge.variant}>{badge.label}</Badge>}
    >
      <div className="grid aspect-[16/9] place-items-center overflow-hidden rounded-row border bg-muted/30">
        {missing || !asset.assetPath ? (
          <div className="flex flex-col items-center gap-1 text-center text-xs text-warning">
            <Warning className="size-7" weight="duotone" />
            Managed file is missing
          </div>
        ) : (
          <img
            alt=""
            className="size-full object-cover"
            src={imageUrl(imageSrcOf(asset) ?? asset.assetPath)}
            onError={() => onMissing(slot.id)}
          />
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="asset-name">Name</Label>
        <Input
          key={asset.id}
          id="asset-name"
          className="h-8"
          defaultValue={asset.name}
          onBlur={(event) => onRename(asset.id, event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.currentTarget.blur()
            }
          }}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label>Fit</Label>
        <ToggleGroup
          className="w-full"
          type="single"
          value={style.fit}
          variant="outline"
          onValueChange={(value) => value && onStyle(asset.id, { fit: value as BackgroundFit })}
        >
          {FIT_OPTIONS.map((option) => (
            <ToggleGroupItem key={option.value} className="flex-1" value={option.value}>
              {option.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      <div className="flex flex-col gap-3">
        {BACKGROUND_STYLE_FIELDS.map((config) => (
          <PowerSlider
            key={config.key}
            label={config.label}
            value={style[config.key]}
            min={config.min}
            max={config.max}
            suffix={config.suffix}
            bipolar={config.bipolar}
            numericInput
            defaultValue={defaults[config.key]}
            onChange={(next) =>
              onStyle(asset.id, { [config.key]: next } as Partial<BackgroundStyle>)
            }
          />
        ))}
      </div>

      <Button
        className="w-full"
        disabled={!canApplySlot(slot) || status === 'active'}
        onClick={onApply}
      >
        {status === 'active' ? 'Applied to scene' : 'Apply to scene'}
      </Button>

      <div className="flex flex-wrap gap-2">
        <Button disabled={importing} size="sm" variant="outline" onClick={() => onImport(slot.id)}>
          <ArrowsClockwise data-icon="inline-start" />
          Replace
        </Button>
        <Button
          disabled={asset.kind !== 'imported' || !asset.assetPath}
          size="sm"
          variant="outline"
          onClick={() => {
            if (asset.assetPath) {
              void window.videorc?.revealPath?.(asset.assetPath)
            }
          }}
        >
          <Eye data-icon="inline-start" />
          Reveal
        </Button>
        <Button size="sm" variant="outline" onClick={() => onRemove(slot.id)}>
          <Trash data-icon="inline-start" />
          Remove
        </Button>
      </div>
    </PanelSection>
  )
}

function CurrentSceneBackground({
  registry,
  onMissing,
  onClear
}: {
  registry: BackgroundAssetRegistry
  onMissing: (slotId: string) => void
  onClear: () => void
}): ReactElement {
  const activeSlot = registry.slots.find((slot) => slot.id === registry.activeSlotId) ?? null
  const asset = activeSlot ? slotAsset(activeSlot, registry) : null
  const sceneSrc = asset ? imageSrcOf(asset) : undefined
  const missing = activeSlot ? slotDisplayStatus(activeSlot, registry) === 'missing-file' : false

  return (
    <PanelSection
      title="Current scene background"
      icon={ImageSquare}
      action={
        activeSlot ? (
          <Button size="sm" variant="outline" onClick={onClear}>
            <X data-icon="inline-start" />
            Remove from scene
          </Button>
        ) : undefined
      }
    >
      <div className="flex items-center gap-3">
        <div className="grid aspect-[16/9] w-28 shrink-0 place-items-center overflow-hidden rounded-row border bg-muted/30">
          {activeSlot && sceneSrc && !missing ? (
            <img
              alt=""
              className="size-full object-cover"
              src={imageUrl(sceneSrc)}
              onError={() => onMissing(activeSlot.id)}
            />
          ) : (
            <ImageSquare className="size-5 text-muted-foreground/40" weight="duotone" />
          )}
        </div>
        <div className="min-w-0 text-sm">
          {activeSlot && asset && !missing ? (
            <>
              <p className="truncate font-medium">{slotName(activeSlot, registry)}</p>
              <p className="text-xs text-muted-foreground">
                Applied to the active scene — the Visibility style sets how much shows behind the
                recording (0% keeps the recording full-size).
              </p>
            </>
          ) : missing ? (
            <p className="text-xs text-warning">
              The selected background file is missing. Recording continues without a digital
              background.
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              No digital background. The recording fills the full canvas.
            </p>
          )}
        </div>
      </div>
    </PanelSection>
  )
}
